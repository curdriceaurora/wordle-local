const nodeCrypto = require("node:crypto");

// Admin auth gate. Read by every `/api/admin/*` middleware to verify
// the `x-admin-key` header. Two-key dual-accept rotation per #204:
// during a rotation window the server accepts EITHER the current
// `adminKey` OR the configured `adminKeyPrevious`, until
// `adminKeyRotationExpiresAt` passes. After that, only the current
// key works. See `docs/security/admin-key-rotation.md` for the
// operator runbook.
//
// Timing safety: every key compare goes through
// `crypto.timingSafeEqual` with a length pre-check. The
// length-mismatch fast-path is OK because the cost of a hash
// comparison after that point is constant in key length — no oracle
// leak about which byte differs.

function readAdminKeyHeader(req) {
  const headerValue = req?.headers?.["x-admin-key"];
  if (typeof headerValue === "string") {
    return headerValue;
  }
  if (Array.isArray(headerValue) && headerValue.length > 0) {
    return String(headerValue[0]);
  }
  return "";
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return nodeCrypto.timingSafeEqual(leftBuffer, rightBuffer);
}

// Structured admin-auth check. Returns an object describing why the
// request was accepted (or rejected) so the middleware can:
//   - log when the rotation window's "previous" key was used (so
//     operators can verify the rotation actually retires the old key)
//   - keep the boolean `isAuthorizedRequest()` shape for back-compat
//
// `config.now` is injectable for deterministic tests. Defaults to
// `Date.now()`.
function checkAdminAuth(req, config) {
  const adminKey = String(config?.adminKey || "");
  const requireAdminKey = config?.requireAdminKey === true;

  if (!adminKey) {
    // No admin key configured. Auth is bypassed when
    // requireAdminKey is also off; rejected otherwise.
    return {
      ok: !requireAdminKey,
      mode: !requireAdminKey ? "no-key-required" : "rejected"
    };
  }

  const headerValue = readAdminKeyHeader(req);

  if (timingSafeEqualString(headerValue, adminKey)) {
    return { ok: true, mode: "current" };
  }

  // Dual-accept rotation window (#204). Both `adminKeyPrevious`
  // (the value being retired) AND `adminKeyRotationExpiresAt` (when
  // it stops working) must be present; we don't accept an
  // unbounded "previous" key.
  const previous = String(config?.adminKeyPrevious || "");
  const expiresAtRaw = config?.adminKeyRotationExpiresAt;
  if (previous && expiresAtRaw !== null && expiresAtRaw !== undefined) {
    const exp = typeof expiresAtRaw === "string" ? Date.parse(expiresAtRaw) : Number(expiresAtRaw);
    if (Number.isFinite(exp)) {
      const now = typeof config?.now === "function" ? config.now() : Date.now();
      if (now < exp && timingSafeEqualString(headerValue, previous)) {
        return {
          ok: true,
          mode: "previous",
          expiresAt: exp,
          msRemaining: exp - now
        };
      }
    }
  }

  return { ok: false, mode: "rejected" };
}

function isAuthorizedRequest(req, config) {
  return checkAdminAuth(req, config).ok;
}

function requireAdmin(config) {
  return (req, res, next) => {
    const result = checkAdminAuth(req, config);
    if (result.ok) {
      if (result.mode === "previous") {
        // Structured log event — never log the secret value. The
        // log carries enough context to drive an alert when the
        // previous-key path is being exercised in production
        // (operator should see this only during a rotation window).
        // #204 acceptance criterion: structured log on token
        // acceptance, no secret value.
        const logger = config?.logger;
        if (logger && typeof logger.info === "function") {
          logger.info("admin.auth.previous_key_used", {
            msRemaining: result.msRemaining,
            expiresAt: new Date(result.expiresAt).toISOString(),
            requestId: req?.id || null,
            method: req?.method,
            path: req?.path
          });
        }
      }
      next();
      return;
    }
    res.status(401).json({ error: "Admin key required." });
  };
}

module.exports = {
  isAuthorizedRequest,
  checkAdminAuth,
  requireAdmin
};

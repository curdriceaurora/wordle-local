"use strict";

// Request-ID middleware (B3 / #122). Assigns or accepts a per-request
// correlation ID, exposes it on `req.id`, echoes it as the
// `X-Request-ID` response header, and threads it through an
// AsyncLocalStorage store so the logger picks it up automatically on
// every log line emitted during the request lifecycle.
//
// Header behavior
// ---------------
// - If the inbound request carries `X-Request-ID` (case-insensitive
//   via Express's header normalization), the middleware validates and
//   reuses it. This lets upstream gateways/proxies stamp a trace ID
//   that survives end-to-end.
// - If absent OR invalid, the middleware mints a fresh UUID v4 via
//   `node:crypto.randomUUID`.
//
// Validation
// ----------
// An incoming ID is accepted only if it matches `ID_REGEX`:
//   - 8..128 chars
//   - charset: [A-Za-z0-9._:-]  (urlsafe + ULID-friendly + colon for
//     OpenTelemetry-style traceparent fragments)
// Anything else is silently replaced with a fresh UUID. Rejection is
// silent on purpose: the response still carries a usable ID even when
// a misconfigured client sends garbage, and the log line tells us why
// via the `requestIdSource` field on the response-finish hook (kept
// out of the hot path to avoid log noise for the common case).
//
// Why not just trust the header
// -----------------------------
// Without validation, a hostile client could inject newlines or escape
// sequences into the header value, which then land in our JSON log
// lines verbatim (logger.js JSON-stringifies field values, so newlines
// become `\n` and are safe — but downstream log shippers may not
// handle exotic Unicode escapes gracefully). Restricting the charset
// is cheap insurance.
//
// JSON error envelope decoration
// ------------------------------
// The middleware wraps `res.json` once so that any 4xx/5xx response
// whose body looks like an error envelope (`{ error: "..." }`)
// automatically gains a `requestId` field. This is how the admin UI
// surfaces the ID in error toasts without every route handler having
// to remember to include it (B3 acceptance criterion #4). Successful
// responses (2xx/3xx) are untouched.

const { randomUUID } = require("node:crypto");

const { requestContext } = require("./request-context");

const ID_REGEX = /^[A-Za-z0-9._:-]{8,128}$/;

function isValidExternalId(value) {
  return typeof value === "string" && ID_REGEX.test(value);
}

function mintRequestId() {
  return randomUUID();
}

// Decorate 4xx/5xx error envelopes with `requestId`. Called once at
// middleware-install time per request via a closure over `req`.
function installErrorEnvelopeDecorator(req, res) {
  const originalJson = res.json.bind(res);
  res.json = function decoratedJson(body) {
    const status = res.statusCode;
    if (
      status >= 400 &&
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      // Only decorate envelopes that already look like an error shape
      // (have `error` field). Don't blindly stamp every JSON response
      // — successful payloads with status>=400 (rare but possible via
      // explicit res.status().json()) should still get the requestId,
      // but pure-data payloads shouldn't grow a phantom field.
      typeof body.error === "string" &&
      !("requestId" in body)
    ) {
      return originalJson({ ...body, requestId: req.id });
    }
    return originalJson(body);
  };
}

function createRequestIdMiddleware(options = {}) {
  const headerName = options.headerName || "X-Request-ID";
  const headerLower = headerName.toLowerCase();
  return function requestIdMiddleware(req, res, next) {
    const incoming = req.headers[headerLower];
    const id = isValidExternalId(incoming) ? incoming : mintRequestId();
    req.id = id;
    res.setHeader(headerName, id);
    installErrorEnvelopeDecorator(req, res);
    requestContext.run({ requestId: id }, () => next());
  };
}

module.exports = {
  createRequestIdMiddleware,
  isValidExternalId,
  mintRequestId,
  // Exposed for tests.
  ID_REGEX
};

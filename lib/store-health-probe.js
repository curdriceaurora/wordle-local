"use strict";

// Lightweight read probe used by every store's `healthCheck()`
// method (B7 follow-up / #205). The probe answers the question
// "could this store still serve a snapshot RIGHT NOW from disk?"
// without going through the cached in-memory `getSnapshot()` —
// because the operator-facing failure mode the probe is designed
// to catch is "on-disk state diverged from cache" (file removed,
// permission revoked, truncated mid-write, partial restore).
//
// Probe shape: read the file as UTF-8, parse as JSON. Both ops are
// the minimum useful coverage — they catch every failure mode an
// upstream operator would care about EXCEPT schema-invalid-but-
// parseable content. That last category is caught at the next real
// `load()` call (which every request that uses the store performs)
// — covering it here would mean shipping the per-store schema
// validator into the health probe, which is heavier than the issue
// asks for and adds maintenance debt.
//
// ENOENT semantics depend on `expectExists` (Codex P2 on PR #216):
//
//   - `expectExists: false` (default) — ENOENT = healthy. Fresh
//     deployments before any store has been written to disk should
//     not 503 /readyz. The store itself handles ENOENT via the
//     documented bootstrap-on-ENOENT pattern in `lib/locks.md`.
//
//   - `expectExists: true` — ENOENT = unhealthy. A store that has
//     already loaded successfully (`this.state` populated) but then
//     finds its file missing has diverged from disk; that's exactly
//     the failure mode the probe exists to catch. Each store's
//     `healthCheck()` passes `expectExists: this.state !== null` so
//     the probe distinguishes pre-bootstrap from after-load.
//
// 2s timeout is per the #205 acceptance criterion. AbortController
// cancels the underlying `fsp.readFile()` when the timeout wins,
// so a genuinely-stuck disk doesn't accumulate hung threadpool I/O
// across repeated readiness probes (Copilot on PR #216 caught the
// uncancelled readFile + uncleared timer). The 2s budget is a
// safety net; healthy probes are sub-10ms in practice.
//
// Error messages are sanitized before surfacing through /readyz
// (Copilot on PR #216): fs error messages typically include the
// full file path, which would leak filesystem layout to any
// unauthenticated caller of the health endpoint. We strip to
// `err.code` + a generic shape descriptor.

const fsp = require("node:fs/promises");

const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 2000;
const ERROR_MESSAGE_MAX_LEN = 200;

// Build a non-path-leaking error string from an arbitrary error.
// fs errors (with `.code`) become `<CODE>: read failed` etc. —
// no path, no node-internal stack. JSON parse errors carry only
// position info, no path, so they pass through truncated to 200
// chars. Everything else gets truncated similarly as a safety net.
function sanitizeProbeError(err) {
  if (!err) return "unknown error";
  if (typeof err.code === "string" && err.code.length > 0) {
    return `${err.code}: store read/parse failed`;
  }
  if (err.name === "SyntaxError") {
    const msg = String(err.message || "JSON parse failed").slice(0, ERROR_MESSAGE_MAX_LEN);
    return msg;
  }
  const msg = String(err.message || err);
  return msg.slice(0, ERROR_MESSAGE_MAX_LEN);
}

async function probeStoreFile(filePath, options = {}) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { ok: false, error: "store filePath is empty or not a string" };
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
  const expectExists = options.expectExists === true;

  // AbortController so a slow/stuck disk doesn't leak threadpool I/O
  // across repeated probes (Copilot on PR #216). The readFile branch
  // honors `signal`; when the timeout wins, we abort the read so it
  // resolves promptly with an AbortError instead of continuing in
  // the background.
  const controller = new AbortController();
  let timeoutHandle = null;
  let settled = false;
  function clearTimer() {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }

  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      resolve({
        ok: false,
        error: `health probe timeout (>${timeoutMs}ms)`
      });
    }, timeoutMs);
    if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();
  });

  const probePromise = (async () => {
    try {
      const raw = await fsp.readFile(filePath, { encoding: "utf8", signal: controller.signal });
      JSON.parse(raw);
      return { ok: true };
    } catch (err) {
      if (err && err.code === "ENOENT") {
        if (expectExists) {
          // Codex P2 on PR #216: store had cached state but the
          // file is now gone — operator-visible failure mode.
          return { ok: false, error: "ENOENT: store file removed after load" };
        }
        // Pre-bootstrap state — the store hasn't been written to
        // disk yet. First mutation will create the file via the
        // bootstrap-on-ENOENT path. Healthy.
        return { ok: true, note: "file not yet created (pre-bootstrap)" };
      }
      // AbortError when the timeout signaled us — the timeout
      // branch will resolve with its own message. Return an
      // arbitrary "lost the race" result; Promise.race won't pick
      // it because timeoutPromise resolves first.
      if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) {
        return { ok: false, error: "probe aborted" };
      }
      return { ok: false, error: sanitizeProbeError(err) };
    }
  })().then((result) => {
    // Read branch settled first — clear the timer so it doesn't
    // fire later (timer is unref'd but still scheduled work).
    if (!settled) {
      settled = true;
      clearTimer();
    }
    return result;
  });

  return Promise.race([probePromise, timeoutPromise]);
}

module.exports = {
  probeStoreFile,
  sanitizeProbeError,
  DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
  ERROR_MESSAGE_MAX_LEN
};

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
// ENOENT is treated as healthy: a store's file may not exist yet
// if no caller has triggered the bootstrap-on-first-write path
// (e.g., a fresh deployment with no leaderboard rows). The store
// itself handles that state gracefully via the documented
// bootstrap-on-ENOENT pattern in `lib/locks.md`. A probe that
// returned 503 from `/readyz` for a fresh deployment would be
// noise, not signal.
//
// 2s timeout is per the #205 acceptance criterion. Bounded by
// `Promise.race` against a setTimeout — the underlying fsp.readFile
// + JSON.parse on these small JSON files (<1 MiB typically) is
// sub-10ms in practice; the 2s budget is a safety net against a
// genuinely-stuck disk, not a normal-path cap.

const fsp = require("node:fs/promises");

const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 2000;

async function probeStoreFile(filePath, options = {}) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { ok: false, error: "store filePath is empty or not a string" };
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
  return Promise.race([
    (async () => {
      try {
        const raw = await fsp.readFile(filePath, "utf8");
        JSON.parse(raw);
        return { ok: true };
      } catch (err) {
        if (err && err.code === "ENOENT") {
          // Pre-bootstrap state — the store hasn't been written to
          // disk yet. The first mutation will create the file via
          // the bootstrap-on-ENOENT path. Treating this as healthy
          // because a fresh deployment is a healthy deployment.
          return { ok: true, note: "file not yet created (pre-bootstrap)" };
        }
        return {
          ok: false,
          error: err && err.message ? err.message : String(err)
        };
      }
    })(),
    new Promise((resolve) => {
      const t = setTimeout(
        () =>
          resolve({
            ok: false,
            error: `health probe timeout (>${timeoutMs}ms)`
          }),
        timeoutMs
      );
      // Unref so the timer doesn't keep the event loop alive past
      // the probe's promise settling. Without this, a fast-resolving
      // probe still leaves a 2s timer pending.
      if (typeof t.unref === "function") t.unref();
    })
  ]);
}

module.exports = {
  probeStoreFile,
  DEFAULT_HEALTH_PROBE_TIMEOUT_MS
};

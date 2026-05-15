"use strict";

// Liveness + readiness endpoints (B7 / #126).
//
// /healthz — liveness. Returns 200 as long as the process is up and
// the event loop is responsive enough to handle the request. Use this
// from a supervisor (Docker `HEALTHCHECK`, Kubernetes `livenessProbe`,
// systemd, etc.) to detect genuine hung processes. We deliberately do
// NOT consult any of the data-mutation refs here: a healthy process
// during a long restore window is still alive, and restarting it
// would defeat the very point of the restore exclusion.
//
// /readyz — readiness. Returns 200 only when the process is in a
// state to serve regular traffic — i.e., not shutting down, not in
// the middle of a backup data-mutation swap, not restoring, AND
// every wired store passes a lightweight read+parse probe of its
// on-disk file. Returns 503 with structured detail otherwise. Use
// this from a load balancer or reverse proxy to withhold traffic
// during the drain windows so in-flight requests can complete
// cleanly.
//
// Per-store deep health (#205, B7 follow-up): when the host passes
// a `stores: [{ name, store }]` dep, each `store.healthCheck()` is
// invoked with a 2 s timeout. Any failure adds the store name to
// the response `reasons` array and forces 503. The probe lives in
// `lib/store-health-probe.js` and exercises fs.readFile + JSON.parse
// — catches "in-memory cache diverged from disk" failure modes
// (file removed, permission stripped, truncated) without going
// through the store's cached snapshot.

const express = require("express");

const DEFAULT_STORE_HEALTH_TIMEOUT_MS = 2000;

function createHealthRouter(deps) {
  const router = express.Router();
  const {
    // Promise barriers — must implement `.value` (boolean) and the
    // route reads `.value` only. We never call `.waitForRelease()`
    // from the health route; that would be a self-deadlock if the
    // probe fires during the held window.
    restoreInProgressRef,
    dataMutationLockRef,
    // Lambda returning the current shutdownInFlight flag from
    // server.js. Modelled as a function so the route always sees the
    // CURRENT value (the underlying variable is mutated in-place by
    // gracefulShutdown rather than via a ref).
    getShutdownInFlight,
    // Optional version string the operator can use to confirm which
    // build is responding. Falls back to "unknown" when not supplied.
    appVersion = "unknown",
    // Optional named store list for the /readyz deep-health probe
    // (#205). Each entry: { name: string, store: { healthCheck() } }
    // — the store must expose `healthCheck()` returning a Promise
    // for `{ ok: boolean, error?: string }`. Pass null/[] to skip
    // deep probes entirely.
    stores = null,
    // Per-store timeout for the deep-health probe. Defaults to
    // 2000 ms per #205 acceptance. Validated below — non-finite /
    // non-positive values fall back to the default rather than
    // letting setTimeout(NaN) / setTimeout(0) cause /readyz to
    // report stores unhealthy when they're fine (Copilot on PR #216).
    storeHealthTimeoutMs: rawStoreHealthTimeoutMs = DEFAULT_STORE_HEALTH_TIMEOUT_MS
  } = deps;

  const storeHealthTimeoutMs =
    Number.isFinite(rawStoreHealthTimeoutMs) && rawStoreHealthTimeoutMs > 0
      ? rawStoreHealthTimeoutMs
      : DEFAULT_STORE_HEALTH_TIMEOUT_MS;

  if (!restoreInProgressRef || typeof restoreInProgressRef.value !== "boolean") {
    throw new TypeError("createHealthRouter: restoreInProgressRef.value (boolean) is required.");
  }
  if (!dataMutationLockRef || typeof dataMutationLockRef.value !== "boolean") {
    throw new TypeError("createHealthRouter: dataMutationLockRef.value (boolean) is required.");
  }
  if (typeof getShutdownInFlight !== "function") {
    throw new TypeError("createHealthRouter: getShutdownInFlight() function is required.");
  }
  if (stores !== null && stores !== undefined && !Array.isArray(stores)) {
    throw new TypeError("createHealthRouter: stores must be an array of { name, store } entries.");
  }
  if (Array.isArray(stores)) {
    for (const entry of stores) {
      if (!entry || typeof entry.name !== "string" || !entry.name) {
        throw new TypeError("createHealthRouter: every stores[] entry needs a non-empty `name`.");
      }
      if (!entry.store || typeof entry.store.healthCheck !== "function") {
        throw new TypeError(
          `createHealthRouter: stores[].store.healthCheck() must be a function (failing entry: ${entry.name}).`
        );
      }
    }
  }

  // Probe a single store with the per-probe timeout. Never throws —
  // any rejection becomes an unhealthy result. The timeout is a
  // belt-and-suspenders cap on top of probeStoreFile's own internal
  // timeout; if a store's healthCheck() is a custom impl that
  // doesn't honor a timeout, this race still bounds the wait.
  //
  // Returned shape: { name, ok, error?, note? }. We spread the
  // store's result FIRST so our `name` field wins — Copilot on
  // PR #216 caught: a store that returns a `name` field in its
  // healthCheck result would override the route-level name and
  // mis-tag `store_unhealthy:<name>` in /readyz reasons.
  async function probeOne(entry) {
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => entry.store.healthCheck()),
        new Promise((resolve) => {
          const t = setTimeout(
            () =>
              resolve({
                ok: false,
                error: `store healthCheck timeout (>${storeHealthTimeoutMs}ms)`
              }),
            storeHealthTimeoutMs
          );
          if (typeof t.unref === "function") t.unref();
        })
      ]);
      if (result && typeof result === "object" && typeof result.ok === "boolean") {
        // Spread BEFORE name so name wins regardless of result shape.
        return { ...result, name: entry.name };
      }
      // Defensive: a store that returns a non-conforming shape
      // shouldn't crash the route — surface as unhealthy with an
      // explicit reason.
      return {
        name: entry.name,
        ok: false,
        error: "healthCheck() returned non-conforming shape"
      };
    } catch (err) {
      // Sanitize the surfaced error so /readyz (mounted before auth)
      // doesn't leak fs paths / internal stack traces to callers.
      // Copilot on PR #216. The probe helper already sanitizes;
      // this guard covers the case where a store's custom
      // healthCheck() throws an unsanitized fs error directly.
      const code = err && typeof err.code === "string" ? `${err.code}: ` : "";
      const raw = err && err.message ? String(err.message) : String(err);
      return {
        name: entry.name,
        ok: false,
        error: `${code}store healthCheck failed`.slice(0, 200) || raw.slice(0, 200)
      };
    }
  }

  router.get("/healthz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ status: "ok", version: appVersion });
  });

  router.get("/readyz", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const reasons = [];
    if (getShutdownInFlight()) reasons.push("shutting_down");
    if (restoreInProgressRef.value) reasons.push("restore_in_progress");
    if (dataMutationLockRef.value) reasons.push("data_mutation_locked");

    // Deep-health probes run only when the surface-level state is
    // clear — no point probing stores if we're already 503ing on
    // shutdown/restore/lock. Keeps the happy-path /readyz latency
    // bounded by the surface check (sub-1ms) when traffic is
    // already being diverted.
    let storeResults = [];
    if (reasons.length === 0 && Array.isArray(stores) && stores.length > 0) {
      storeResults = await Promise.all(stores.map(probeOne));
      for (const r of storeResults) {
        if (!r.ok) reasons.push(`store_unhealthy:${r.name}`);
      }
    }

    if (reasons.length === 0) {
      return res.status(200).json({
        status: "ready",
        version: appVersion,
        // Empty stores array when no deep probes ran (surface-only
        // mode); populated with the per-store results when they did.
        stores: storeResults
      });
    }
    return res.status(503).json({
      status: "not_ready",
      version: appVersion,
      reasons,
      stores: storeResults
    });
  });

  return router;
}

module.exports = createHealthRouter;
module.exports.DEFAULT_STORE_HEALTH_TIMEOUT_MS = DEFAULT_STORE_HEALTH_TIMEOUT_MS;

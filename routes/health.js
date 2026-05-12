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
// the middle of a backup data-mutation swap, and not restoring.
// Returns 503 with structured detail otherwise. Use this from a
// load balancer or reverse proxy to withhold traffic during the
// drain windows so in-flight requests can complete cleanly.
//
// Out of scope (per #126): per-store deep health (would be a
// follow-up — currently a store with a corrupt file on disk would
// still return 200 from /readyz because the bytes-on-disk state
// isn't probed here).

const express = require("express");

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
    appVersion = "unknown"
  } = deps;

  if (!restoreInProgressRef || typeof restoreInProgressRef.value !== "boolean") {
    throw new TypeError("createHealthRouter: restoreInProgressRef.value (boolean) is required.");
  }
  if (!dataMutationLockRef || typeof dataMutationLockRef.value !== "boolean") {
    throw new TypeError("createHealthRouter: dataMutationLockRef.value (boolean) is required.");
  }
  if (typeof getShutdownInFlight !== "function") {
    throw new TypeError("createHealthRouter: getShutdownInFlight() function is required.");
  }

  router.get("/healthz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ status: "ok", version: appVersion });
  });

  router.get("/readyz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const reasons = [];
    if (getShutdownInFlight()) reasons.push("shutting_down");
    if (restoreInProgressRef.value) reasons.push("restore_in_progress");
    if (dataMutationLockRef.value) reasons.push("data_mutation_locked");
    if (reasons.length === 0) {
      return res.status(200).json({ status: "ready", version: appVersion });
    }
    return res.status(503).json({
      status: "not_ready",
      version: appVersion,
      reasons
    });
  });

  return router;
}

module.exports = createHealthRouter;

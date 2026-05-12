"use strict";

const express = require("express");
const request = require("supertest");

const createHealthRouter = require("../routes/health.js");

// B7 / #126: /healthz (liveness) and /readyz (readiness) probes.
//
// Liveness should ALWAYS return 200 as long as the event loop is
// responsive — no consultation of data-mutation refs. Readiness
// returns 200 only when none of (restoreInProgressRef,
// dataMutationLockRef, shutdownInFlight) is held.

function buildApp(refs) {
  const app = express();
  app.use(
    createHealthRouter({
      restoreInProgressRef: refs.restore,
      dataMutationLockRef: refs.dataLock,
      getShutdownInFlight: () => refs.shutdownInFlight,
      appVersion: refs.version || "test-1.0.0"
    })
  );
  return app;
}

function makeRefs(initial = {}) {
  return {
    restore: { value: initial.restore === true },
    dataLock: { value: initial.dataLock === true },
    shutdownInFlight: initial.shutdownInFlight === true,
    version: initial.version
  };
}

describe("createHealthRouter — constructor validation", () => {
  test("throws when restoreInProgressRef is not a ref shape", () => {
    expect(() =>
      createHealthRouter({
        dataMutationLockRef: { value: false },
        getShutdownInFlight: () => false
      })
    ).toThrow(/restoreInProgressRef/);
  });

  test("throws when dataMutationLockRef is not a ref shape", () => {
    expect(() =>
      createHealthRouter({
        restoreInProgressRef: { value: false },
        getShutdownInFlight: () => false
      })
    ).toThrow(/dataMutationLockRef/);
  });

  test("throws when getShutdownInFlight is not a function", () => {
    expect(() =>
      createHealthRouter({
        restoreInProgressRef: { value: false },
        dataMutationLockRef: { value: false },
        getShutdownInFlight: false
      })
    ).toThrow(/getShutdownInFlight/);
  });
});

describe("/healthz", () => {
  test("returns 200 even during restore", async () => {
    const refs = makeRefs({ restore: true });
    const res = await request(buildApp(refs)).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: "test-1.0.0" });
  });

  test("returns 200 even during graceful shutdown", async () => {
    const refs = makeRefs({ shutdownInFlight: true });
    const res = await request(buildApp(refs)).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  test("returns 200 even during data-mutation lock", async () => {
    const refs = makeRefs({ dataLock: true });
    const res = await request(buildApp(refs)).get("/healthz");
    expect(res.status).toBe(200);
  });

  test("sets Cache-Control: no-store", async () => {
    const refs = makeRefs();
    const res = await request(buildApp(refs)).get("/healthz");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("falls back to 'unknown' version when not supplied to factory", async () => {
    // Bypass buildApp's default "test-1.0.0" fallback to exercise the
    // route-internal default.
    const app = express();
    app.use(
      createHealthRouter({
        restoreInProgressRef: { value: false },
        dataMutationLockRef: { value: false },
        getShutdownInFlight: () => false
      })
    );
    const res = await request(app).get("/healthz");
    expect(res.body.version).toBe("unknown");
  });
});

describe("/readyz", () => {
  test("returns 200 when no refs are held", async () => {
    const refs = makeRefs();
    const res = await request(buildApp(refs)).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ready", version: "test-1.0.0" });
  });

  test("returns 503 with reason `shutting_down` during shutdown", async () => {
    const refs = makeRefs({ shutdownInFlight: true });
    const res = await request(buildApp(refs)).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.reasons).toContain("shutting_down");
  });

  test("returns 503 with reason `restore_in_progress` during restore", async () => {
    const refs = makeRefs({ restore: true });
    const res = await request(buildApp(refs)).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.reasons).toContain("restore_in_progress");
  });

  test("returns 503 with reason `data_mutation_locked` during backup swap", async () => {
    const refs = makeRefs({ dataLock: true });
    const res = await request(buildApp(refs)).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.reasons).toContain("data_mutation_locked");
  });

  test("returns 503 with all reasons when multiple refs held", async () => {
    const refs = makeRefs({ restore: true, dataLock: true, shutdownInFlight: true });
    const res = await request(buildApp(refs)).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.reasons.sort()).toEqual([
      "data_mutation_locked",
      "restore_in_progress",
      "shutting_down"
    ]);
  });

  test("getShutdownInFlight is consulted ON each request (not snapshotted at mount time)", async () => {
    let inFlight = false;
    const app = express();
    app.use(
      createHealthRouter({
        restoreInProgressRef: { value: false },
        dataMutationLockRef: { value: false },
        getShutdownInFlight: () => inFlight
      })
    );
    const ready = await request(app).get("/readyz");
    expect(ready.status).toBe(200);
    inFlight = true;
    const notReady = await request(app).get("/readyz");
    expect(notReady.status).toBe(503);
    expect(notReady.body.reasons).toEqual(["shutting_down"]);
  });

  test("sets Cache-Control: no-store", async () => {
    const refs = makeRefs();
    const res = await request(buildApp(refs)).get("/readyz");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

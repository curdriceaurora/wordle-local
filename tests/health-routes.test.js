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

// B7 follow-up / #205: per-store deep-health aggregation in /readyz.
// /readyz invokes each `stores[].store.healthCheck()` with a 2s
// timeout when the surface-level state is clear. Any failure adds
// the store name to `reasons` and forces 503.
describe("/readyz — per-store deep-health (#205)", () => {
  function buildAppWithStores({ stores, refs = makeRefs(), storeHealthTimeoutMs }) {
    const app = express();
    app.use(
      createHealthRouter({
        restoreInProgressRef: refs.restore,
        dataMutationLockRef: refs.dataLock,
        getShutdownInFlight: () => refs.shutdownInFlight,
        appVersion: refs.version || "test-1.0.0",
        stores,
        storeHealthTimeoutMs
      })
    );
    return app;
  }

  test("constructor validates stores shape", () => {
    expect(() =>
      createHealthRouter({
        restoreInProgressRef: { value: false },
        dataMutationLockRef: { value: false },
        getShutdownInFlight: () => false,
        stores: "not-an-array"
      })
    ).toThrow(/stores must be an array/);

    expect(() =>
      createHealthRouter({
        restoreInProgressRef: { value: false },
        dataMutationLockRef: { value: false },
        getShutdownInFlight: () => false,
        stores: [{ name: "", store: { healthCheck: () => Promise.resolve({ ok: true }) } }]
      })
    ).toThrow(/non-empty `name`/);

    expect(() =>
      createHealthRouter({
        restoreInProgressRef: { value: false },
        dataMutationLockRef: { value: false },
        getShutdownInFlight: () => false,
        stores: [{ name: "foo", store: { not_healthCheck: () => {} } }]
      })
    ).toThrow(/healthCheck\(\) must be a function/);
  });

  test("returns 200 when every store is healthy", async () => {
    const stores = [
      { name: "leaderboard", store: { healthCheck: async () => ({ ok: true }) } },
      { name: "classes", store: { healthCheck: async () => ({ ok: true }) } },
      { name: "schedule", store: { healthCheck: async () => ({ ok: true }) } }
    ];
    const res = await request(buildAppWithStores({ stores })).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.stores).toHaveLength(3);
    expect(res.body.stores.every((s) => s.ok === true)).toBe(true);
    expect(res.body.stores.map((s) => s.name).sort()).toEqual([
      "classes",
      "leaderboard",
      "schedule"
    ]);
  });

  test("returns 503 with store name in reasons when ANY store is unhealthy", async () => {
    const stores = [
      { name: "leaderboard", store: { healthCheck: async () => ({ ok: true }) } },
      {
        name: "classes",
        store: {
          healthCheck: async () => ({ ok: false, error: "ENOENT: file disappeared" })
        }
      },
      { name: "schedule", store: { healthCheck: async () => ({ ok: true }) } }
    ];
    const res = await request(buildAppWithStores({ stores })).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.reasons).toContain("store_unhealthy:classes");
    expect(res.body.reasons).not.toContain("store_unhealthy:leaderboard");
    // The failing store's error message surfaces in the per-store
    // breakdown so the operator can drill in.
    const classesEntry = res.body.stores.find((s) => s.name === "classes");
    expect(classesEntry).toBeTruthy();
    expect(classesEntry.ok).toBe(false);
    expect(classesEntry.error).toMatch(/ENOENT/);
  });

  test("multiple unhealthy stores all appear in reasons", async () => {
    const stores = [
      { name: "a", store: { healthCheck: async () => ({ ok: false, error: "err-a" }) } },
      { name: "b", store: { healthCheck: async () => ({ ok: true }) } },
      { name: "c", store: { healthCheck: async () => ({ ok: false, error: "err-c" }) } }
    ];
    const res = await request(buildAppWithStores({ stores })).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.reasons.sort()).toEqual([
      "store_unhealthy:a",
      "store_unhealthy:c"
    ]);
  });

  test("a hanging healthCheck() is bounded by the per-store timeout", async () => {
    // healthCheck never resolves — would hang the request indefinitely
    // without the timeout. We set a 50 ms timeout for the test so the
    // race fires in well under a second.
    const stores = [
      {
        name: "hung-store",
        store: { healthCheck: () => new Promise(() => {}) }
      }
    ];
    const before = Date.now();
    const res = await request(
      buildAppWithStores({ stores, storeHealthTimeoutMs: 50 })
    ).get("/readyz");
    const elapsed = Date.now() - before;
    expect(elapsed).toBeLessThan(500); // generous slack on top of 50 ms cap
    expect(res.status).toBe(503);
    expect(res.body.reasons).toContain("store_unhealthy:hung-store");
    const entry = res.body.stores.find((s) => s.name === "hung-store");
    expect(entry.error).toMatch(/timeout/);
  });

  test("a healthCheck() that throws synchronously becomes an unhealthy result, not a 500", async () => {
    const stores = [
      {
        name: "throwing-store",
        store: {
          healthCheck: () => {
            throw new Error("synchronous boom");
          }
        }
      }
    ];
    const res = await request(buildAppWithStores({ stores })).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.reasons).toContain("store_unhealthy:throwing-store");
    const entry = res.body.stores.find((s) => s.name === "throwing-store");
    expect(entry.error).toMatch(/synchronous boom/);
  });

  test("a healthCheck() returning non-conforming shape is treated as unhealthy", async () => {
    const stores = [
      { name: "weird-store", store: { healthCheck: async () => null } },
      { name: "missing-ok", store: { healthCheck: async () => ({}) } }
    ];
    const res = await request(buildAppWithStores({ stores })).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.reasons).toContain("store_unhealthy:weird-store");
    expect(res.body.reasons).toContain("store_unhealthy:missing-ok");
  });

  test("surface-level state short-circuits BEFORE store probes (skips deep-health)", async () => {
    // Don't run deep probes when we'll 503 anyway. Saves the 2s/store
    // worst-case latency when traffic is already being diverted.
    let probeCalled = false;
    const stores = [
      {
        name: "would-probe",
        store: {
          healthCheck: async () => {
            probeCalled = true;
            return { ok: true };
          }
        }
      }
    ];
    const res = await request(
      buildAppWithStores({ stores, refs: makeRefs({ shutdownInFlight: true }) })
    ).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.reasons).toContain("shutting_down");
    expect(probeCalled).toBe(false);
    // When surface checks short-circuit, the stores array in the
    // response is empty (deep probes didn't run).
    expect(res.body.stores).toEqual([]);
  });

  test("stores=null (or omitted) means no deep-health is performed; 200 with surface check only", async () => {
    const res = await request(buildAppWithStores({ stores: null })).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.stores).toEqual([]);
  });

  test("DEFAULT_STORE_HEALTH_TIMEOUT_MS is 2000", () => {
    expect(createHealthRouter.DEFAULT_STORE_HEALTH_TIMEOUT_MS).toBe(2000);
  });
});

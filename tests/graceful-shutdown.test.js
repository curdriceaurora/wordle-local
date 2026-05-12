"use strict";

// B1 / #120: graceful-shutdown drain procedure tests. The
// `gracefulShutdown` function runs a documented drain sequence; the
// test surface focuses on behavior we can pin reliably:
//   - server.close() is called exactly once
//   - inflight request counter blocks the drain until requests
//     complete
//   - webhook service drain hook is invoked
//   - per-step timeout caps the total runtime when something hangs
//
// We don't try to mutate stores' private writeQueue fields here —
// that path is exercised indirectly through real route writes in
// the broader test suite.

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  Object.keys(process.env).forEach((key) => {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  });
  Object.entries(ORIGINAL_ENV).forEach(([key, value]) => {
    process.env[key] = value;
  });
}

function loadApp() {
  delete require.cache[require.resolve("../server")];
  return require("../server");
}

afterEach(() => {
  resetEnv();
});

describe("gracefulShutdown", () => {
  test("returns within budget when no work is in flight", async () => {
    process.env.RATE_LIMIT_MAX = "10000";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";
    const serverModule = loadApp();
    const closeCalls = [];
    const stubHttpServer = { close: () => { closeCalls.push(Date.now()); } };
    const elapsed = await serverModule.gracefulShutdown(stubHttpServer, "TEST");
    expect(closeCalls).toHaveLength(1);
    expect(typeof elapsed).toBe("number");
    expect(elapsed).toBeLessThan(5000);
  });

  test("invokes webhookService.shutdown and waitForDrain", async () => {
    process.env.RATE_LIMIT_MAX = "10000";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";
    const serverModule = loadApp();
    const { webhookService } = serverModule;
    const shutdownSpy = jest.spyOn(webhookService, "shutdown");
    const drainSpy = jest.spyOn(webhookService, "waitForDrain");
    await serverModule.gracefulShutdown({ close: () => {} }, "TEST");
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledTimes(1);
    shutdownSpy.mockRestore();
    drainSpy.mockRestore();
  });

  test("blocks HTTP-drain step until inflight counter clears", async () => {
    process.env.RATE_LIMIT_MAX = "10000";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";
    const serverModule = loadApp();
    const { inflightRequestsRef } = serverModule;
    inflightRequestsRef.value = 1; // simulate one in-flight request
    let shutdownResolved = false;
    const promise = serverModule
      .gracefulShutdown({ close: () => {} }, "TEST")
      .then(() => { shutdownResolved = true; });
    // Yield a tick — shutdown should be parked in step 2's
    // waitForRef loop.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(shutdownResolved).toBe(false);
    // Drain the counter; shutdown should now proceed.
    inflightRequestsRef.value = 0;
    await promise;
    expect(shutdownResolved).toBe(true);
  });

  test("respects HTTP-drain timeout when inflight counter never clears", async () => {
    process.env.RATE_LIMIT_MAX = "10000";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";
    const serverModule = loadApp();
    const { inflightRequestsRef } = serverModule;
    inflightRequestsRef.value = 1; // stuck request
    const start = Date.now();
    const elapsed = await serverModule.gracefulShutdown(
      { close: () => {} },
      "TEST"
    );
    const wallElapsed = Date.now() - start;
    // HTTP drain has a 10s timeout; total should be bounded.
    expect(wallElapsed).toBeLessThan(15000);
    expect(elapsed).toBeLessThan(15000);
    // Cleanup: clear the counter so the next test doesn't inherit it.
    inflightRequestsRef.value = 0;
  }, 20000);

  test("webhookService.waitForDrain resolves true when no work in flight", async () => {
    const serverModule = loadApp();
    const { webhookService } = serverModule;
    const drained = await webhookService.waitForDrain(500);
    expect(drained).toBe(true);
  });

  test("webhookService.waitForDrain resolves false on timeout", async () => {
    const serverModule = loadApp();
    const { webhookService } = serverModule;
    webhookService.activeCount = 5; // simulate stuck deliveries
    const drained = await webhookService.waitForDrain(150);
    expect(drained).toBe(false);
    webhookService.activeCount = 0;
  });
});

"use strict";

// Concurrency-stress tests for lib/webhook-service.js.
//
// What we test here:
//   1. Parallel emit() — many concurrent admin triggers + system
//      events. Without the per-delivery enqueue ordering, the underlying
//      WebhookDeliveryStore's commitQueue could lose enqueues. We verify
//      every emit lands a delivery row.
//   2. Duplicate-scheduleDelivery / re-entry guard. The `executeOnce`
//      method explicitly skips deliveries whose status is no longer
//      "queued" (close a duplicate-timer race). We simulate by firing
//      two scheduleDelivery() for the same id and asserting attempts
//      bumps exactly once.
//   3. Parallel emit + concurrent subscription mutation (create/remove
//      racing with emit). The contract is: emit() snapshots the
//      enabled-set ONCE via findEnabledForEvent; subscription mutates
//      that land AFTER the snapshot don't affect THAT emit. We
//      verify the post-state is consistent and no row is left half-
//      enqueued / half-removed.
//
// Setup notes:
//   - We inject a stub fetchImpl so executeOnce never hits the network.
//     The stub returns 200 with a small body and tracks per-delivery
//     call counts.
//   - We enable allowPrivateNetworks at construction so the
//     IP-allowlist check accepts 127.0.0.1 (the test sink URL).
//     Without it, assertOutboundUrlAllowed would reject the local
//     host and every executeOnce would fail with a non-retriable
//     WebhookSendError before the test could exercise the
//     scheduleDelivery duplicate-guard.
//   - claimDirectDataWriteSlot is a no-op (no backup integration
//     needed in tests).

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { WebhookService } = require("../lib/webhook-service");
const { WebhookStore } = require("../lib/webhook-store");
const { WebhookDeliveryStore } = require("../lib/webhook-delivery-store");

const { runConcurrencyScenario } = require("./helpers/concurrency-fixture");

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-webhook-svc-concurrency-"));
  return {
    dir,
    subsPath: path.join(dir, "webhooks.json"),
    deliveriesPath: path.join(dir, "webhook-deliveries.json")
  };
}

async function cleanupDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

// Build a stub fetchImpl that records each call and returns 200 OK.
// Returned object exposes `calls` (array) and `count(deliveryId)`.
function makeStubFetch() {
  const calls = [];
  async function stub(url, opts = {}) {
    const headers = opts.headers || {};
    calls.push({ url: String(url), deliveryId: headers["x-webhook-id"] || null });
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      // body methods used by undici-style consumers in webhook-service.
      text: async () => "ok",
      arrayBuffer: async () => new ArrayBuffer(2),
      body: null
    };
  }
  return {
    fetch: stub,
    calls,
    countFor(deliveryId) {
      return calls.filter((c) => c.deliveryId === deliveryId).length;
    }
  };
}

async function buildService(extra = {}) {
  const paths = tempPaths();
  const subs = new WebhookStore({ filePath: paths.subsPath });
  const deliveries = new WebhookDeliveryStore({ filePath: paths.deliveriesPath });
  // Pre-load both stores so first emit() doesn't race the ENOENT
  // default-write path on top of the actual surface under test.
  await subs.load();
  await deliveries.load();
  const stub = extra.stub || makeStubFetch();
  const svc = new WebhookService({
    subscriptionStore: subs,
    deliveryStore: deliveries,
    enabled: true,
    backoffSchedule: [10, 20, 30],
    timeoutMs: 500,
    fetchImpl: stub.fetch,
    allowPrivateNetworks: true,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
    ...extra
  });
  return { svc, subs, deliveries, dir: paths.dir, stub };
}

// Wait for the WebhookService internal worker pool to drain. shutdown()
// flips shutdownRequested + clears pending timers + empties readyQueue,
// but already-in-flight executeOnce promises are not awaited. Without
// this, a subsequent teardown can race the file-write of the in-flight
// markSuccess/markFailure commit and rmdir trips ENOTEMPTY.
async function waitForWebhookDrain(svc, timeoutMs = 5000) {
  svc.shutdown?.();
  const deadline = Date.now() + timeoutMs;
  while (svc.activeCount > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  // Also drain any pending deliveryStore commits. Reading getSnapshot
  // (or commitQueue.then) doesn't block on disk fsync so a small final
  // sleep covers the rename window.
  await new Promise((r) => setImmediate(r));
}

describe("webhook-service: parallel emit lands every delivery row", () => {
  test("20 concurrent emit() for one enabled sub each enqueue a delivery row", async () => {
    // Without commitQueue serialization in WebhookDeliveryStore.enqueue,
    // two concurrent enqueues would clone the same baseline and one
    // would lose its row. With it, all N rows persist.
    await runConcurrencyScenario({
      name: "webhook-service: parallel emit",
      parallelism: 20,
      setup: async () => {
        const built = await buildService();
        await built.subs.create({
          url: "http://127.0.0.1:0/sink",
          events: ["test.event"],
          enabled: true
        });
        return built;
      },
      operation: async ({ svc }, i) => svc.emit("test.event", { i }),
      invariants: [
        async ({ deliveries }, { results, parallelism }) => {
          // Each emit() returns an array of created delivery rows
          // (one per enabled subscription that matched). With 1 sub,
          // we expect exactly 1 row per emit call → N rows total.
          const enqueuedIds = results.flatMap((rows) => rows.map((r) => r.id));
          const unique = new Set(enqueuedIds);
          if (unique.size !== parallelism) {
            throw new Error(
              `expected ${parallelism} unique delivery rows from ${parallelism} emits; got ${unique.size}`
            );
          }
          // Now verify every enqueued id is actually present in
          // the delivery store snapshot. This catches the "enqueue
          // returned but the commit dropped it" lost-write race.
          const snap = await deliveries.getSnapshot();
          const storeIds = new Set(snap.deliveries.map((d) => d.id));
          for (const id of enqueuedIds) {
            if (!storeIds.has(id)) {
              throw new Error(
                `delivery ${id} returned from enqueue() but missing from store snapshot`
              );
            }
          }
        }
      ],
      teardown: async ({ svc, dir }) => {
        await waitForWebhookDrain(svc);
        await cleanupDir(dir);
      }
    });
  }, 120000);
});

describe("webhook-service: duplicate-scheduleDelivery guard", () => {
  test("duplicate scheduleDelivery against a single-inflight executor bumps attempts once", async () => {
    // executeOnce explicitly returns early if delivery.status !== "queued".
    // The transition from "queued" → "running" happens inside the first
    // executeOnce, BEFORE the network send. If a duplicate
    // scheduleDelivery() races AFTER that update, the second executeOnce
    // sees "running" (or terminal) and bails — that's the documented
    // duplicate-timer guard for the production race (recovery racing a
    // freshly-armed retry timer).
    //
    // We force globalInflight=1 so executeOnce calls serialize. That
    // matches the realistic production trigger: a single delivery's
    // own duplicate timer, not a synthetic burst of N parallel
    // scheduleDelivery() into a multi-worker drain (the latter is
    // outside the guard's contract — N parallel executeOnce calls
    // all reading "queued" simultaneously will each proceed; the
    // guard exists for cross-restart-recovery edges, not for a
    // synthetic tight-loop burst).
    const { svc, subs, deliveries, dir, stub } = await buildService({
      globalInflight: 1
    });
    try {
      const sub = await subs.create({
        url: "http://127.0.0.1:0/sink",
        events: ["dup.event"],
        enabled: true
      });
      // Manually enqueue ONE delivery row. We'll fire N scheduleDelivery
      // calls against it and assert exactly one send happens (or, if
      // the timing collapses, the row's `attempts` is ≤ 1).
      const delivery = await deliveries.enqueue({
        subscriptionId: sub.id,
        event: "dup.event",
        url: sub.url,
        payload: { ok: true }
      });
      for (let i = 0; i < 10; i += 1) {
        svc.scheduleDelivery(delivery.id, 0, { event: "dup.event", subscription: sub });
      }
      // Wait for executeOnce to complete. We poll until the row is
      // succeeded OR a sensible timeout — webhook send w/ stub fetch
      // is fast (under ~100ms in practice).
      const deadline = Date.now() + 5000;
      let final = null;
      while (Date.now() <= deadline) {
        final = await deliveries.findById(delivery.id);
        if (final && (final.status === "succeeded" || final.status === "failed")) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      if (!final || (final.status !== "succeeded" && final.status !== "failed")) {
        throw new Error(
          `timed out waiting for delivery ${delivery.id}; status=${final ? final.status : "<missing>"}`
        );
      }
      expect(final.status).toBe("succeeded");
      // Duplicate-guard invariant: attempts must be exactly 1.
      expect(final.attempts).toBe(1);
      // Stub fetch was called exactly once for this delivery.
      expect(stub.countFor(delivery.id)).toBe(1);
    } finally {
      await waitForWebhookDrain(svc);
      await cleanupDir(dir);
    }
  }, 30000);
});

describe("webhook-service: emit racing subscription mutation", () => {
  test("parallel emit + concurrent unsubscribe leaves no half-enqueued state", async () => {
    // Half the operations emit a new event; half remove the subscription.
    // Real-world scenario: admin deletes a webhook while events are
    // firing. The contract is: each emit() takes a snapshot of
    // findEnabledForEvent at call time; removals that land AFTER the
    // snapshot can't unenqueue an in-flight delivery. We verify:
    //   - The store ends consistent (subscription either present or
    //     absent — never a phantom).
    //   - The delivery store contains only rows that were created.
    //     (No "ghost" rows referencing a never-created sub.)
    await runConcurrencyScenario({
      name: "webhook-service: emit racing remove",
      parallelism: 20,
      setup: async () => {
        const { svc, subs, deliveries, dir } = await buildService();
        const sub = await subs.create({
          url: "http://127.0.0.1:0/sink",
          events: ["race.event"],
          enabled: true
        });
        return { svc, subs, deliveries, dir, subId: sub.id };
      },
      operation: async ({ svc, subs, subId }, i) => {
        if (i === 0) {
          // One remover; everyone else emits. We tag the response so
          // invariants can tell the remover apart from emitters in
          // results[]. (We do NOT use parallelism=2 because we want
          // the emit-vs-remove race played out under heavy load.)
          try {
            await subs.remove(subId);
            return { kind: "removed" };
          } catch (err) {
            // Remove may race with another caller; SUBSCRIPTION_NOT_FOUND
            // is acceptable — it just means we lost the race.
            if (err && err.code === "SUBSCRIPTION_NOT_FOUND") {
              return { kind: "remove-lost" };
            }
            throw err;
          }
        }
        const rows = await svc.emit("race.event", { i });
        return { kind: "emit", count: rows.length };
      },
      invariants: [
        async ({ subs, deliveries, subId }, { results }) => {
          // After the dust settles: subscription either exists or doesn't.
          const snap = await subs.getSnapshot();
          const subStillPresent = snap.subscriptions.some((s) => s.id === subId);
          // Each emit() returned either 0 (sub was already removed)
          // or 1 (sub was still enabled). No row should report > 1
          // since we only have one sub.
          for (const r of results) {
            if (r.kind === "emit" && r.count > 1) {
              throw new Error(
                `emit() created ${r.count} delivery rows for a single-sub setup`
              );
            }
          }
          // Delivery rows in the store must all reference the sub we
          // created (no ghost subscriptionId values).
          const drySnap = await deliveries.getSnapshot();
          for (const row of drySnap.deliveries) {
            if (row.subscriptionId !== subId) {
              throw new Error(
                `delivery row ${row.id} has unexpected subscriptionId ${row.subscriptionId}`
              );
            }
          }
          // Consistency: total emit-rows-created must equal the
          // delivery store's row count exactly (no lost enqueues).
          const totalEmitted = results
            .filter((r) => r.kind === "emit")
            .reduce((sum, r) => sum + r.count, 0);
          if (totalEmitted !== drySnap.deliveries.length) {
            throw new Error(
              `emit() reported ${totalEmitted} created rows but store has ${drySnap.deliveries.length}`
            );
          }
          // Confirm we got SOME emits-with-rows OR the remove landed
          // before any emits — either is fine, but if subStillPresent
          // is true, the remove must have lost the race entirely.
          if (subStillPresent) {
            const removeOk = results.some((r) => r.kind === "removed");
            if (removeOk) {
              throw new Error(
                "subscription was removed successfully but is still present in store"
              );
            }
          }
        }
      ],
      teardown: async ({ svc, dir }) => {
        await waitForWebhookDrain(svc);
        await cleanupDir(dir);
      }
    });
  }, 120000);
});

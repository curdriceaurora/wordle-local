"use strict";

// Direct-store concurrency tests for the three async stores that
// Phase 3's service-layer tests cover transitively:
//   - WebhookStore (covered by tests/webhook-service.concurrency.test.js)
//   - WebhookDeliveryStore (same)
//   - PushSubscriptionStore (covered by
//     tests/notification-service.concurrency.test.js)
//
// The service tests stress these stores via their producing services;
// these tests stress the store's own surface API directly so a future
// caller (e.g. a new admin route) using the store without the service
// wrapper still has its race invariants pinned.
//
// Each store has writeQueue/commitQueue serialization — the invariants
// are the same as Phase 3's: parallel mutators serialize through the
// queue; lost-write races would be observable as missing/duplicate
// rows. We add one heavy-contention test per store to keep the PR
// scope tight; deeper coverage is a fast follow-up if needed.
//
// Filed as #132 (Epic C: Test Coverage & Fault Injection).

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { WebhookStore } = require("../lib/webhook-store");
const { WebhookDeliveryStore } = require("../lib/webhook-delivery-store");
const {
  PushSubscriptionStore,
  endpointHashOf
} = require("../lib/push-subscription-store");

const { runConcurrencyScenario } = require("./helpers/concurrency-fixture");

function tempFilePath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-direct-concurrency-"));
  return { dir, filePath: path.join(dir, name) };
}

async function cleanupDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

function frozenNow(iso = "2026-05-11T00:00:00.000Z") {
  return () => new Date(iso);
}

describe("webhook-store: parallel create/update/remove", () => {
  test("N parallel create with distinct URLs: every subscription persists", async () => {
    await runConcurrencyScenario({
      name: "webhook-store: parallel create",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath("webhooks.json");
        const store = new WebhookStore({ filePath, now: frozenNow() });
        await store.load();
        return { store, dir };
      },
      operation: async ({ store }, i) =>
        store.create({
          url: `https://example.com/hook-${i}`,
          events: ["daily.posted"],
          enabled: true
        }),
      invariants: [
        async ({ store }, { results, parallelism }) => {
          const ids = new Set(results.map((s) => s.id));
          if (ids.size !== parallelism) {
            throw new Error(`expected ${parallelism} unique subscription ids; got ${ids.size}`);
          }
          const snap = await store.getSnapshot();
          if (snap.subscriptions.length !== parallelism) {
            throw new Error(
              `expected ${parallelism} subscriptions in store; got ${snap.subscriptions.length} ` +
                `(lost-write race — commitQueue is not serializing)`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});

describe("webhook-delivery-store: parallel enqueue", () => {
  test("N parallel enqueue with distinct events: every delivery row persists", async () => {
    await runConcurrencyScenario({
      name: "webhook-delivery-store: parallel enqueue",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath("webhook-deliveries.json");
        const store = new WebhookDeliveryStore({ filePath, now: frozenNow() });
        await store.load();
        return { store, dir };
      },
      operation: async ({ store }, i) =>
        store.enqueue({
          subscriptionId: "sub-test",
          event: `daily.posted-${i}`,
          url: "https://example.com/sink",
          payload: { i }
        }),
      invariants: [
        async ({ store }, { results, parallelism }) => {
          const ids = new Set(results.map((d) => d.id));
          if (ids.size !== parallelism) {
            throw new Error(`expected ${parallelism} unique delivery ids; got ${ids.size}`);
          }
          const snap = await store.getSnapshot();
          if (snap.deliveries.length !== parallelism) {
            throw new Error(
              `expected ${parallelism} deliveries in store; got ${snap.deliveries.length}`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});

describe("push-subscription-store: parallel upsert", () => {
  test("N parallel upsert with the SAME endpoint converges to one row (upsert semantics)", async () => {
    // Push subscriptions are keyed by endpointHash; concurrent upserts
    // of the same endpoint should converge to exactly one row, not
    // duplicate. The atomic re-check inside #commit guarantees this.
    const fixedEndpoint = "https://push.example.com/abcdef";
    await runConcurrencyScenario({
      name: "push-subscription-store: parallel upsert (same endpoint)",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath("push-subscriptions.json");
        const store = new PushSubscriptionStore({ filePath, now: frozenNow() });
        await store.load();
        return { store, dir };
      },
      operation: async ({ store }) =>
        store.upsert({
          endpoint: fixedEndpoint,
          keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) }
        }),
      invariants: [
        async ({ store }) => {
          const snap = await store.getSnapshot();
          // Use the store's exported helper so this test stays in
          // sync if the hash algorithm/format ever changes (Copilot
          // caught the inline re-implementation on PR #134 r1).
          const expectedHash = endpointHashOf(fixedEndpoint);
          const matches = snap.subscriptions.filter(
            (s) => s.endpointHash === expectedHash
          );
          if (matches.length !== 1) {
            throw new Error(
              `expected exactly 1 subscription for the shared endpoint; got ${matches.length} ` +
                `(duplicate upsert landed)`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);

  test("N parallel upsert with DISTINCT endpoints: every subscription persists", async () => {
    await runConcurrencyScenario({
      name: "push-subscription-store: parallel upsert (distinct endpoints)",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath("push-subscriptions.json");
        const store = new PushSubscriptionStore({ filePath, now: frozenNow() });
        await store.load();
        return { store, dir };
      },
      operation: async ({ store }, i) =>
        store.upsert({
          endpoint: `https://push.example.com/sub-${i}`,
          keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) }
        }),
      invariants: [
        async ({ store }, { parallelism }) => {
          const snap = await store.getSnapshot();
          if (snap.subscriptions.length !== parallelism) {
            throw new Error(
              `expected ${parallelism} subscriptions; got ${snap.subscriptions.length} ` +
                `(lost-write race — commitQueue is not serializing)`
            );
          }
          // All endpointHashes unique.
          const hashes = new Set(snap.subscriptions.map((s) => s.endpointHash));
          if (hashes.size !== parallelism) {
            throw new Error(`expected ${parallelism} unique hashes; got ${hashes.size}`);
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});

"use strict";

// Concurrency-stress tests for lib/notification-service.js.
//
// NotificationService.broadcast() uses an internal worker pool (default
// 8 concurrent sendOne() calls) reading from a shared subscriber queue.
// The contended state we care about:
//
//   1. The worker pool's queue is drained once per broadcast call. Two
//      concurrent broadcast() calls each get their OWN snapshot of
//      subStore.list() and their own worker pool, so they SHOULD NOT
//      interfere — but they share the underlying subscriptionStore
//      (markSuccess / markFailure commits go through ONE commitQueue).
//      We verify: when two broadcasts fire concurrently against the
//      same 10 subs, every sub gets each broadcast's send, and both
//      broadcasts' aggregate counters add up consistently.
//
//   2. broadcast() racing with subStore.upsert() (a user registering
//      a new device while a daily broadcast is fanning out). The
//      contract: subscribers that exist at list() time get sends;
//      subscribers added AFTER list() are out-of-scope for that
//      broadcast. We verify the post-state is consistent — every
//      registered subscriber is present, no duplicates.
//
//   3. broadcast() racing with sub-failure that triggers markFailure +
//      pruning. Per-sub `gone` removals must not break the iteration
//      across the rest of the workers.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { NotificationService } = require("../lib/notification-service");
const { PushSubscriptionStore } = require("../lib/push-subscription-store");

const { runConcurrencyScenario } = require("./helpers/concurrency-fixture");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lhw-notify-concurrency-"));
}

async function cleanupDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

async function buildService(extra = {}) {
  const dir = tempDir();
  const subStore = new PushSubscriptionStore({
    filePath: path.join(dir, "push.json")
  });
  await subStore.load();
  const fakeKeys = {
    publicKey: "B".repeat(87),
    privateKey: "p".repeat(43),
    subject: "mailto:test@example.com"
  };
  const fakeWebPush = extra.webPush || {
    setVapidDetails: () => {},
    sendNotification: async () => ({ statusCode: 200 })
  };
  const svc = new NotificationService({
    subscriptionStore: subStore,
    enabled: true,
    webPush: fakeWebPush,
    getPushKeys: () => fakeKeys,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
    ...extra
  });
  return { svc, subStore, fakeWebPush, dir };
}

async function seedSubscriptions(subStore, count) {
  for (let i = 0; i < count; i += 1) {
    await subStore.upsert({
      endpoint: `https://example.com/sub-${i}`,
      keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) }
    });
  }
}

describe("notification-service: parallel broadcast against shared subscribers", () => {
  test("two concurrent broadcasts each fan out to every subscriber consistently", async () => {
    // Per-iter setup is essential here: under CONCURRENCY_REPEAT=100
    // the mock and store must reset each iteration. If we built the
    // service once outside the fixture, the mock's call count would
    // accumulate across iterations and the invariant would fail on
    // iter 2.
    const SUBSCRIBER_COUNT = 10;
    const PARALLEL_BROADCASTS = 5;
    await runConcurrencyScenario({
      name: "notification-service: parallel broadcast",
      parallelism: PARALLEL_BROADCASTS,
      setup: async () => {
        const built = await buildService({
          webPush: {
            setVapidDetails: () => {},
            sendNotification: jest.fn(async () => ({ statusCode: 200 }))
          }
        });
        await seedSubscriptions(built.subStore, SUBSCRIBER_COUNT);
        return built;
      },
      operation: async ({ svc }) =>
        svc.broadcast({ title: "T", body: "B", url: "/" }),
      invariants: [
        async ({ subStore, fakeWebPush }) => {
          // Per-iter expected calls = PARALLEL_BROADCASTS × SUBSCRIBER_COUNT.
          const expectedCalls = PARALLEL_BROADCASTS * SUBSCRIBER_COUNT;
          const got = fakeWebPush.sendNotification.mock.calls.length;
          if (got !== expectedCalls) {
            throw new Error(
              `expected ${expectedCalls} sendNotification calls per iter; got ${got} ` +
                `(worker-pool drop or list() race?)`
            );
          }
          // Every subscriber must still exist in the store post-
          // broadcast (all 200 OK; no `gone` evictions, no
          // dropped rows from racing markSuccess).
          const remaining = await subStore.list();
          if (remaining.length !== SUBSCRIBER_COUNT) {
            throw new Error(
              `subscriber count mutated: expected ${SUBSCRIBER_COUNT}, got ${remaining.length}`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 120000);
});

describe("notification-service: broadcast racing upsert", () => {
  test("upsert mid-broadcast: snapshot consistency, no duplicate rows", async () => {
    const SEED_COUNT = 5;
    await runConcurrencyScenario({
      name: "notification-service: broadcast vs upsert",
      parallelism: 20,
      setup: async () => {
        const built = await buildService({
          webPush: {
            setVapidDetails: () => {},
            sendNotification: jest.fn(async () => {
              // Small delay so upserts can race the worker loop.
              await new Promise((r) => setTimeout(r, 5));
              return { statusCode: 200 };
            })
          }
        });
        await seedSubscriptions(built.subStore, SEED_COUNT);
        return built;
      },
      // Operation kinds:
      //   i === 0 → broadcast (single in-flight)
      //   i > 0   → upsert of new subscribers concurrent with the broadcast
      operation: async ({ svc, subStore }, i) => {
        if (i === 0) {
          return {
            kind: "broadcast",
            result: await svc.broadcast({ title: "T", body: "B", url: "/" })
          };
        }
        return {
          kind: "upsert",
          result: await subStore.upsert({
            endpoint: `https://example.com/new-${i}`,
            keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) }
          })
        };
      },
      invariants: [
        async ({ subStore }, { results }) => {
          const upserts = results.filter((r) => r.kind === "upsert");
          const broadcasts = results.filter((r) => r.kind === "broadcast");
          if (broadcasts.length !== 1) {
            throw new Error(`expected 1 broadcast result; got ${broadcasts.length}`);
          }
          if (upserts.length !== 19) {
            throw new Error(`expected 19 upsert results; got ${upserts.length}`);
          }
          // Store should now have SEED_COUNT + 19 = 24 unique subs.
          const final = await subStore.list();
          const expectedTotal = SEED_COUNT + 19;
          if (final.length !== expectedTotal) {
            throw new Error(
              `expected ${expectedTotal} subscribers; got ${final.length} ` +
                `(lost upsert during broadcast — commitQueue not serializing)`
            );
          }
          // No duplicates by endpointHash.
          const hashes = new Set(final.map((s) => s.endpointHash));
          if (hashes.size !== final.length) {
            throw new Error(
              `duplicate endpointHash detected: ${hashes.size} unique vs ${final.length} rows`
            );
          }
          // Broadcast self-consistency.
          const b = broadcasts[0].result;
          if (b.recipients < SEED_COUNT) {
            throw new Error(
              `broadcast saw ${b.recipients} subs; expected at least ${SEED_COUNT} seeded`
            );
          }
          if (b.sent !== b.recipients) {
            throw new Error(
              `broadcast inconsistency: recipients=${b.recipients}, sent=${b.sent}, failed=${b.failed}, gone=${b.gone}`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 180000);
});

describe("notification-service: per-sub gone + failure don't poison worker loop", () => {
  test("broadcast across mixed success / gone / failure subscribers tallies correctly", async () => {
    await runConcurrencyScenario({
      name: "notification-service: mixed-outcome broadcast",
      parallelism: 3,
      setup: async () => {
        const built = await buildService({
          webPush: {
            setVapidDetails: () => {},
            sendNotification: jest.fn(async (sub) => {
              // Per-endpoint outcomes: 4 success, 3 gone (410), 3 fail (500).
              if (sub.endpoint.includes("/ok-")) return { statusCode: 200 };
              if (sub.endpoint.includes("/gone-")) {
                throw Object.assign(new Error("gone"), { statusCode: 410 });
              }
              if (sub.endpoint.includes("/fail-")) {
                throw Object.assign(new Error("boom"), { statusCode: 500 });
              }
              return { statusCode: 200 };
            })
          }
        });
        for (let i = 0; i < 4; i += 1) {
          await built.subStore.upsert({
            endpoint: `https://example.com/ok-${i}`,
            keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) }
          });
        }
        for (let i = 0; i < 3; i += 1) {
          await built.subStore.upsert({
            endpoint: `https://example.com/gone-${i}`,
            keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) }
          });
        }
        for (let i = 0; i < 3; i += 1) {
          await built.subStore.upsert({
            endpoint: `https://example.com/fail-${i}`,
            keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) }
          });
        }
        return built;
      },
      operation: async ({ svc }) =>
        svc.broadcast({ title: "T", body: "B", url: "/" }),
      invariants: [
        async ({ subStore }, { results }) => {
          for (const r of results) {
            if (r.sent + r.failed + r.gone !== r.recipients) {
              throw new Error(
                `broadcast tally mismatch: sent=${r.sent}+failed=${r.failed}+gone=${r.gone} != recipients=${r.recipients}`
              );
            }
          }
          // All 3 `gone-` subs must be removed from the store by
          // the end (regardless of which broadcast's worker touched
          // them — markFailure({gone:true}) is destructive and
          // commit-queued).
          const remaining = await subStore.list();
          const stillGone = remaining.filter((s) => s.endpoint.includes("/gone-"));
          if (stillGone.length !== 0) {
            throw new Error(
              `expected all gone- subs removed; ${stillGone.length} remain`
            );
          }
          // ok- + fail- subs still present (10 - 3 = 7).
          if (remaining.length !== 7) {
            throw new Error(
              `expected 7 remaining subs; got ${remaining.length}`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 120000);
});

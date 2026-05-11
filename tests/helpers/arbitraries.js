"use strict";

// fast-check arbitraries for property-based testing of `normalize*`
// functions in `lib/`. Each arbitrary produces VALID input (or
// near-valid — explicit reject cases live in unit tests). The
// canonical-shape gate is `normalize*` — we want to exercise its
// idempotence + schema-validity invariants across a wide input space
// without hand-rolling examples per case.
//
// Background: filed as #127 (Epic C: Test Coverage & Fault Injection).
// See `tests/normalize.property.test.js` for the property runner.
//
// Conventions:
//   - Every exported generator returns a fast-check Arbitrary<T>.
//   - Inputs are valid by construction. If a normalize throws on a
//     generated input, that's a bug in either the arbitrary OR the
//     normalize contract.
//   - Optional fields are sometimes absent (use `fc.option` so the
//     "no key present" path is also exercised).
//   - Generated strings are bounded length to keep runs fast.

const fc = require("fast-check");

// ---------- Primitive arbitraries ----------

// ISO-8601-Z timestamp. Many stores accept any string-shaped
// updatedAt; this generator picks plausible values to keep the noise
// down while still exercising different points in time.
const isoTimestamp = fc
  .integer({ min: 0, max: 4_102_444_800_000 }) // 1970-01-01 .. 2100-01-01
  .map((ms) => new Date(ms).toISOString());

// Date in YYYY-MM-DD form. Constructed via Date so all generated
// values are calendar-valid (no Feb 30, no May 32).
const isoDate = fc
  .integer({ min: 0, max: 4_102_444_800_000 })
  .map((ms) => new Date(ms).toISOString().slice(0, 10));

// 3–12 uppercase A-Z. Matches `WORD_PATTERN` used by schedule-store
// + challenge-results-store puzzle.word + guesses.
const wordAZ = fc
  .integer({ min: 3, max: 12 })
  .chain((length) =>
    fc.string({
      unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")),
      minLength: length,
      maxLength: length
    })
  );

// Language code (BCP-47-ish; matches `LANG_PATTERN`).
const langCode = fc.constantFrom("en", "es", "fr", "de", "it", "pt", "en-US", "es-MX");

// IANA timezone (subset — full list is huge and irrelevant to test).
const ianaTimezone = fc.constantFrom("UTC", "America/New_York", "Europe/London", "Asia/Tokyo");

// Base64url-style id (≤64 chars, [A-Za-z0-9_-]). Matches the
// `ID_PATTERN` used across challenge stores.
const base64urlId = fc
  .integer({ min: 1, max: 32 })
  .chain((length) =>
    fc.string({
      unit: fc.constantFrom(
        ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".split("")
      ),
      minLength: length,
      maxLength: length
    })
  );

// Profile id: 1–64 chars, no embedded NULs. Matches
// `challenge-results-store` profileId rules.
const profileId = fc.string({ minLength: 1, maxLength: 64 }).filter((s) => !s.includes("\u0000"));

// SHA-256 hex digest (64 chars). For endpointHash on
// `push-subscription-store`. Generated from a random buffer so we
// can also generate the same digest deterministically when needed.
const sha256Hex = fc
  .uint8Array({ minLength: 16, maxLength: 16 })
  .map((bytes) => {
    let out = "";
    for (let i = 0; i < bytes.length; i += 1) {
      out += bytes[i].toString(16).padStart(2, "0");
    }
    // Pad to 64 chars to match SHA-256 length. Real digests are 64-hex;
    // shorter prefix-padded values still satisfy `^[a-f0-9]{64}$` if
    // we right-pad with zeros.
    return out.padEnd(64, "0").slice(0, 64);
  });

// HTTPS URL for webhook subscriptions. Schema requires `https://`
// scheme; we generate plausible host + path.
const httpsUrl = fc
  .tuple(
    fc.constantFrom("example.com", "hook.example.org", "webhook.test"),
    fc.string({ minLength: 0, maxLength: 16 }).map((s) => s.replace(/[^A-Za-z0-9_-]/g, ""))
  )
  .map(([host, path]) => `https://${host}/${path || "hook"}`);

// VAPID p256dh + auth keys (base64url, plausible lengths). Schema
// requires p256dh ≤ 100 chars, auth ≤ 24 chars.
const pushKeys = fc.record({
  p256dh: fc
    .integer({ min: 80, max: 88 })
    .chain((len) =>
      fc.string({
        unit: fc.constantFrom(
          ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("")
        ),
        minLength: len,
        maxLength: len
      })
    ),
  auth: fc
    .integer({ min: 16, max: 22 })
    .chain((len) =>
      fc.string({
        unit: fc.constantFrom(
          ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("")
        ),
        minLength: len,
        maxLength: len
      })
    )
});

// ---------- Per-store top-level arbitraries ----------

// schedule.json (lib/schedule-store.js → normalizeSchedule)
const scheduleEntry = fc.record(
  {
    date: isoDate,
    word: wordAZ,
    lang: langCode,
    notes: fc.option(fc.string({ minLength: 1, maxLength: 200 }))
  },
  { requiredKeys: ["date", "word", "lang"] }
);

const schedule = fc.record(
  {
    version: fc.constant(1),
    updatedAt: isoTimestamp,
    timezone: ianaTimezone,
    auto_rotate: fc.boolean(),
    retention_days: fc.integer({ min: 0, max: 365 }),
    scheduled_words: fc.array(scheduleEntry, { minLength: 0, maxLength: 10 }),
    auto_rotate_seed: fc.option(fc.string({ minLength: 0, maxLength: 64 })),
    last_reconciled_for: fc.option(isoDate),
    last_reconciled_at: fc.option(isoTimestamp)
  },
  {
    requiredKeys: [
      "version",
      "updatedAt",
      "timezone",
      "auto_rotate",
      "retention_days",
      "scheduled_words"
    ]
  }
).map((s) => {
  // Deduplicate (date, lang) keys so normalize doesn't throw
  // DUPLICATE_ENTRY (the strict-mode default).
  const seen = new Set();
  s.scheduled_words = s.scheduled_words.filter((e) => {
    const key = `${e.date}|${e.lang}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return s;
});

// challenges.json (lib/challenge-config-store.js → normalizeStore)
const challengeConfig = fc.record(
  {
    id: base64urlId,
    name: fc.string({ minLength: 1, maxLength: 80 }),
    lang: langCode,
    puzzleCount: fc.integer({ min: 1, max: 50 }),
    timeBudgetSeconds: fc.integer({ min: 30, max: 7200 }),
    maxGuesses: fc.integer({ min: 1, max: 12 }),
    speedBonusFactor: fc.float({ min: 0, max: 5, noNaN: true }),
    perPuzzleScore: fc.integer({ min: 1, max: 100000 }),
    replayPolicy: fc.constantFrom("best", "first", "latest"),
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    deleted: fc.option(fc.boolean())
  },
  {
    requiredKeys: [
      "id",
      "name",
      "lang",
      "puzzleCount",
      "timeBudgetSeconds",
      "maxGuesses",
      "speedBonusFactor",
      "perPuzzleScore",
      "replayPolicy",
      "createdAt",
      "updatedAt"
    ]
  }
);

const challengesStore = fc.record(
  {
    version: fc.constant(1),
    updatedAt: isoTimestamp,
    challenges: fc.array(challengeConfig, { minLength: 0, maxLength: 5 })
  },
  { requiredKeys: ["version", "updatedAt", "challenges"] }
).map((s) => {
  // Dedupe id within the array.
  const seen = new Set();
  s.challenges = s.challenges.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  return s;
});

// challenge-results.json (lib/challenge-results-store.js → normalizeStore)
const puzzleEntry = fc.record(
  {
    index: fc.integer({ min: 0, max: 49 }),
    word: wordAZ,
    guesses: fc.array(wordAZ, { minLength: 0, maxLength: 12 }),
    solved: fc.boolean(),
    solvedAtMs: fc.option(fc.integer({ min: 0, max: 100000 }))
  },
  { requiredKeys: ["index", "word", "guesses", "solved"] }
);

const sessionEntry = fc.record(
  {
    id: base64urlId,
    challengeId: base64urlId,
    profileId,
    profileName: fc.option(fc.string({ minLength: 1, maxLength: 64 })),
    status: fc.constantFrom("in-progress", "pending", "completed", "abandoned", "timed-out"),
    startedAt: isoTimestamp,
    finishedAt: fc.option(isoTimestamp),
    score: fc.option(fc.integer({ min: 0, max: 1000000 })),
    puzzles: fc.array(puzzleEntry, { minLength: 1, maxLength: 5 })
  },
  {
    requiredKeys: ["id", "challengeId", "profileId", "status", "startedAt", "puzzles"]
  }
);

const challengeResultsStore = fc.record(
  {
    version: fc.constant(1),
    updatedAt: isoTimestamp,
    sessions: fc.array(sessionEntry, { minLength: 0, maxLength: 5 })
  },
  { requiredKeys: ["version", "updatedAt", "sessions"] }
).map((s) => {
  const seen = new Set();
  s.sessions = s.sessions.filter((sess) => {
    if (seen.has(sess.id)) return false;
    seen.add(sess.id);
    return true;
  });
  return s;
});

// webhooks.json (lib/webhook-store.js → normalizeStore)
const webhookSubscription = fc.record(
  {
    id: base64urlId,
    url: httpsUrl,
    events: fc
      .array(
        fc.constantFrom("daily.posted", "challenge.completed", "schedule.changed"),
        { minLength: 1, maxLength: 5 }
      )
      .map((arr) => [...new Set(arr)]),
    enabled: fc.boolean(),
    maxAttempts: fc.integer({ min: 1, max: 12 }),
    secret: fc.string({ minLength: 16, maxLength: 64 }),
    label: fc.option(fc.string({ minLength: 1, maxLength: 64 })),
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp
  },
  {
    requiredKeys: [
      "id",
      "url",
      "events",
      "enabled",
      "maxAttempts",
      "secret",
      "createdAt",
      "updatedAt"
    ]
  }
);

const webhookStore = fc.record(
  {
    version: fc.constant(1),
    updatedAt: isoTimestamp,
    subscriptions: fc.array(webhookSubscription, { minLength: 0, maxLength: 5 })
  },
  { requiredKeys: ["version", "updatedAt", "subscriptions"] }
).map((s) => {
  const seen = new Set();
  s.subscriptions = s.subscriptions.filter((sub) => {
    if (seen.has(sub.id)) return false;
    seen.add(sub.id);
    return true;
  });
  return s;
});

// webhook-deliveries.json (lib/webhook-delivery-store.js → normalizeStore)
const webhookDelivery = fc.record(
  {
    id: base64urlId,
    subscriptionId: base64urlId,
    event: fc.string({ minLength: 1, maxLength: 64 }),
    url: httpsUrl,
    status: fc.constantFrom("queued", "running", "succeeded", "failed", "canceled"),
    attempts: fc.integer({ min: 0, max: 20 }),
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    nextAttemptAt: fc.option(isoTimestamp),
    lastError: fc.option(fc.string({ minLength: 0, maxLength: 200 }))
  },
  {
    requiredKeys: [
      "id",
      "subscriptionId",
      "event",
      "url",
      "status",
      "attempts",
      "createdAt",
      "updatedAt"
    ]
  }
);

const webhookDeliveryStore = fc.record(
  {
    version: fc.constant(1),
    updatedAt: isoTimestamp,
    deliveries: fc.array(webhookDelivery, { minLength: 0, maxLength: 5 })
  },
  { requiredKeys: ["version", "updatedAt", "deliveries"] }
).map((s) => {
  const seen = new Set();
  s.deliveries = s.deliveries.filter((d) => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });
  return s;
});

// push-subscriptions.json (lib/push-subscription-store.js → normalizeStore)
const pushSubscription = fc.record(
  {
    endpointHash: sha256Hex,
    endpoint: httpsUrl,
    keys: pushKeys,
    createdAt: isoTimestamp,
    ua: fc.option(fc.string({ minLength: 0, maxLength: 200 }))
  },
  { requiredKeys: ["endpointHash", "endpoint", "keys", "createdAt"] }
);

const pushSubscriptionStore = fc.record(
  {
    version: fc.constant(1),
    updatedAt: isoTimestamp,
    lastBroadcastAt: fc.option(isoTimestamp),
    lastDailyFireAt: fc.option(isoTimestamp),
    subscriptions: fc.array(pushSubscription, { minLength: 0, maxLength: 5 })
  },
  { requiredKeys: ["version", "updatedAt", "subscriptions"] }
).map((s) => {
  const seen = new Set();
  s.subscriptions = s.subscriptions.filter((sub) => {
    if (seen.has(sub.endpointHash)) return false;
    seen.add(sub.endpointHash);
    return true;
  });
  return s;
});

// classes.json (lib/classes-store.js → normalizeClassesState)
const classProfile = fc.record(
  {
    id: base64urlId,
    name: fc.string({ minLength: 1, maxLength: 40 }),
    addedAt: isoTimestamp
  },
  { requiredKeys: ["id", "name", "addedAt"] }
);

const classEntry = fc.record(
  {
    id: base64urlId,
    name: fc.string({ minLength: 1, maxLength: 40 }),
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    profiles: fc.array(classProfile, { minLength: 0, maxLength: 3 })
  },
  { requiredKeys: ["id", "name", "createdAt", "updatedAt", "profiles"] }
).map((c) => {
  const seen = new Set();
  c.profiles = c.profiles.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
  return c;
});

const classesState = fc.record(
  {
    version: fc.constant(1),
    updatedAt: isoTimestamp,
    classes: fc.array(classEntry, { minLength: 0, maxLength: 5 })
  },
  { requiredKeys: ["version", "updatedAt", "classes"] }
).map((s) => {
  const seen = new Set();
  s.classes = s.classes.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  return s;
});

// leaderboard.json (lib/leaderboard-store.js → normalizeLeaderboardState)
const leaderboardProfile = fc.record(
  {
    id: base64urlId,
    name: fc.string({ minLength: 1, maxLength: 40 }),
    createdAt: isoTimestamp
  },
  { requiredKeys: ["id", "name", "createdAt"] }
);

// Note: a separate `leaderboardResult` arbitrary is in scope for a
// follow-up — we currently start each generated leaderboard with an
// empty `resultsByProfile` to keep the first-cut arbitrary small.
// Idempotence + schema-validity on the wrapper shape still get
// exercised; per-result shrinking is the natural next step.

const leaderboardState = fc.record(
  {
    version: fc.constant(1),
    updatedAt: isoTimestamp,
    profiles: fc.array(leaderboardProfile, { minLength: 0, maxLength: 3 }),
    resultsByProfile: fc.constant({})
  },
  { requiredKeys: ["version", "updatedAt", "profiles", "resultsByProfile"] }
).map((s) => {
  const seen = new Set();
  s.profiles = s.profiles.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
  // Build resultsByProfile keyed by retained profile ids.
  const map = {};
  for (const p of s.profiles) {
    // 0-3 results per profile; generated lazily via deterministic sampling
    // to keep the arbitrary's space bounded.
    map[p.id] = [];
  }
  s.resultsByProfile = map;
  return s;
});

// app-config.json overrides (lib/app-config-store.js → normalizeOverrides)
// This one's a deep-merge config blob; for property tests we just exercise
// the shape — the deep semantics live in unit tests.
const appConfigOverrides = fc.record(
  {
    definitions: fc.option(
      fc.record({
        primary: fc.option(
          fc.constantFrom("packaged", "managed", "providers", "wordnet")
        ),
        fallbackChain: fc.option(
          fc.array(fc.constantFrom("packaged", "managed", "providers"), {
            minLength: 0,
            maxLength: 3
          })
        )
      })
    ),
    limits: fc.option(
      fc.record({
        guessesPerPuzzleMax: fc.option(fc.integer({ min: 1, max: 12 }))
      })
    )
  },
  { requiredKeys: [] }
);

module.exports = {
  // Primitives — useful for stitching new generators in follow-up PRs.
  isoTimestamp,
  isoDate,
  wordAZ,
  langCode,
  ianaTimezone,
  base64urlId,
  profileId,
  sha256Hex,
  httpsUrl,
  pushKeys,
  // Top-level per-store generators.
  schedule,
  challengesStore,
  challengeResultsStore,
  webhookStore,
  webhookDeliveryStore,
  pushSubscriptionStore,
  classesState,
  leaderboardState,
  appConfigOverrides
};

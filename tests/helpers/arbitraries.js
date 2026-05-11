"use strict";

// fast-check arbitraries for property-based testing of `normalize*`
// functions in `lib/`. Each arbitrary produces input that is VALID
// against the corresponding `data/*.schema.json` — exactly, not
// loosely. The idempotence + schema-validity properties in
// `tests/normalize.property.test.js` rely on every generated input
// (a) passing `normalize` without throwing, and (b) producing
// schema-valid output. Loose arbitraries make the schema-validity
// property test coercion rather than genuine validity — see
// PR #133 round-1 review (Codex P2, Copilot ×5).
//
// Background: filed as #127 (Epic C: Test Coverage & Fault Injection).
//
// Conventions:
//   - Every exported generator returns a fast-check Arbitrary<T>.
//   - Generated inputs are schema-valid by construction. If
//     `normalize` throws on a generated input, that's a bug to
//     investigate, not a `catch` to swallow.
//   - Optional fields are controlled via `fc.record(..., { requiredKeys })`
//     — keys NOT in `requiredKeys` are sometimes absent in the
//     generated record. We deliberately do NOT wrap optional values
//     in `fc.option`, because `fc.option(arb, { nil: undefined })`
//     produces records with `key: undefined` (not absent) — which
//     is neither JSON-representable nor schema-valid (Copilot caught
//     this on PR #133 round 3).
//   - Generated strings are bounded length to keep runs fast.

const nodeCrypto = require("node:crypto");
const fc = require("fast-check");

// ---------- Primitive arbitraries ----------

// ISO-8601 timestamp with millisecond precision. All `*.schema.json`
// `format: date-time` properties consume this.
const isoTimestamp = fc
  .integer({ min: 0, max: 4_102_444_800_000 })
  .map((ms) => new Date(ms).toISOString());

// YYYY-MM-DD calendar date string. Constructed via Date so all values
// are calendar-valid (no Feb 30, no May 32).
const isoDate = fc
  .integer({ min: 0, max: 4_102_444_800_000 })
  .map((ms) => new Date(ms).toISOString().slice(0, 10));

// Constant-character pool helpers. Spreading a string is the same
// as `.split("")` in JS, so we drop the `.split` (per CodeRabbit
// PR #133 review).
const UPPER_AZ = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const BASE64URL_CHARS = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
];
const HEX_LOWER = [..."0123456789abcdef"];

function stringFromPool(pool, minLength, maxLength) {
  return fc
    .integer({ min: minLength, max: maxLength })
    .chain((length) =>
      fc.string({
        unit: fc.constantFrom(...pool),
        minLength: length,
        maxLength: length
      })
    );
}

// 3-12 uppercase A-Z. Matches schedule-store's WORD_PATTERN and
// challenge-results-store's puzzle.word + guesses entry shape.
const wordAZ = stringFromPool(UPPER_AZ, 3, 12);

// Language code (BCP-47-ish). Matches `^[a-z]{2}(-[A-Z]{2})?$`.
const langCode = fc.constantFrom("en", "es", "fr", "de", "it", "pt", "en-US", "es-MX");

// IANA timezone (subset; full list is huge and our normalize doesn't
// care which one as long as Intl recognises it).
const ianaTimezone = fc.constantFrom("UTC", "America/New_York", "Europe/London", "Asia/Tokyo");

// Generic id matching `^[A-Za-z0-9_-]{1,64}$` — covers challenge-results
// session id, challenge-config challenge id, webhook subscription id,
// webhook delivery id.
const base64urlId = stringFromPool(BASE64URL_CHARS, 1, 32);

// Profile id: 1-64 chars, no whitespace (matches challenge-results-store
// and leaderboard-store profileId conventions). The `\u0000` escape
// keeps the source pure ASCII (a literal NUL byte would flip git's
// file-mode to binary).
const profileId = fc
  .string({ minLength: 1, maxLength: 64 })
  .filter((s) => !s.includes("\u0000") && !/\s/.test(s));

// HTTPS URL matching `^https?://` (webhook + push-subscription
// endpoint schemas) and tightly bounded length.
const httpsUrl = fc
  .tuple(
    fc.constantFrom("example.com", "hook.example.org", "webhook.test"),
    stringFromPool(BASE64URL_CHARS, 0, 16)
  )
  .map(([host, path]) => `https://${host}/${path || "hook"}`);

// VAPID p256dh + auth keys (base64url). Push-subscriptions schema
// accepts wide ranges; we use realistic web-push lengths.
const pushKeys = fc.record({
  p256dh: stringFromPool(BASE64URL_CHARS, 80, 88),
  auth: stringFromPool(BASE64URL_CHARS, 16, 24)
});

// Webhook secret: lowercase hex, 16-256 chars. Matches
// `data/webhooks.schema.json` `secret.pattern = ^[a-f0-9]+$`. Generated
// from a random byte buffer so values are realistic hex strings (PR
// #133 review: Codex P2 + Copilot caught the prior random-string
// generator that violated SECRET_PATTERN).
const webhookSecret = fc
  .integer({ min: 8, max: 128 })
  .chain((byteLen) =>
    fc
      .uint8Array({ minLength: byteLen, maxLength: byteLen })
      .map((bytes) => Buffer.from(bytes).toString("hex"))
  );

// Class id pattern `^class-[a-f0-9-]{12,64}$`. The body uses only
// [a-f0-9-]. We generate 12-32 valid chars and prefix.
const classId = stringFromPool([...HEX_LOWER, "-"], 12, 32).map(
  (body) => `class-${body}`
);

// Leaderboard profile name. Schema: `^[A-Za-z][A-Za-z '\\-]*$`,
// max 24 chars. Start with a letter then letters/spaces/hyphens/quotes.
// Codex P2 PR #133 round 3 caught that names ending in a space pass
// the schema but `normalizeProfile` trims and rejects when
// `raw !== trimmed`. We anchor the LAST char to be non-space too —
// the middle can have spaces/hyphens/quotes freely.
const NAME_LETTERS = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
];
const NAME_MIDDLE_CHARS = [...NAME_LETTERS, " ", "'", "-"];
const leaderboardProfileName = fc
  .tuple(
    fc.constantFrom(...NAME_LETTERS),
    stringFromPool(NAME_MIDDLE_CHARS, 0, 22),
    fc.constantFrom(...NAME_LETTERS)
  )
  .map(([first, middle, last]) => `${first}${middle}${last}`);

// ---------- Per-store top-level arbitraries ----------

// schedule.json (lib/schedule-store.js → normalizeSchedule)
const scheduleEntry = fc.record(
  {
    date: isoDate,
    word: wordAZ,
    lang: langCode,
    notes: fc.string({ minLength: 1, maxLength: 200 })
  },
  { requiredKeys: ["date", "word", "lang"] }
);

const schedule = fc
  .record(
    {
      version: fc.constant(1),
      updatedAt: isoTimestamp,
      timezone: ianaTimezone,
      auto_rotate: fc.boolean(),
      retention_days: fc.integer({ min: 0, max: 365 }),
      scheduled_words: fc.array(scheduleEntry, { minLength: 0, maxLength: 10 }),
      auto_rotate_seed: fc.string({ minLength: 0, maxLength: 64 }),
      last_reconciled_for: isoDate,
      last_reconciled_at: isoTimestamp
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
  )
  .map((s) => {
    // Deduplicate (date, lang) — normalize rejects duplicates.
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
//
// Per data/challenges.schema.json: replayPolicy enum is exactly
// ["best", "first-only", "unlimited"] — Copilot caught the prior
// incorrect values on PR #133.
const challengeConfig = fc.record(
  {
    id: base64urlId,
    // Schema permits any 1-80 char string but
    // `normalizeChallenge` calls `clampString` which trims first
    // then rejects empty. So a whitespace-only name passes schema
    // validation but fails normalize. Generate names with a
    // non-whitespace leading char to avoid the asymmetry (and
    // document the schema-vs-normalize drift as a follow-up note
    // — could tighten the schema to require a non-whitespace
    // leading character in a sibling issue).
    name: fc
      .tuple(
        fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"),
        fc.string({ minLength: 0, maxLength: 79 })
      )
      .map(([first, rest]) => `${first}${rest}`),
    lang: langCode,
    puzzleCount: fc.integer({ min: 1, max: 50 }),
    timeBudgetSeconds: fc.integer({ min: 30, max: 7200 }),
    maxGuesses: fc.integer({ min: 1, max: 12 }),
    speedBonusFactor: fc.float({ min: 0, max: 100, noNaN: true }),
    perPuzzleScore: fc.integer({ min: 0, max: 10000 }),
    replayPolicy: fc.constantFrom("best", "first-only", "unlimited"),
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    deleted: fc.boolean()
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

const challengesStore = fc
  .record(
    {
      version: fc.constant(1),
      updatedAt: isoTimestamp,
      challenges: fc.array(challengeConfig, { minLength: 0, maxLength: 5 })
    },
    { requiredKeys: ["version", "updatedAt", "challenges"] }
  )
  .map((s) => {
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
    solvedAtMs: fc.integer({ min: 0, max: 100000 })
  },
  { requiredKeys: ["index", "word", "guesses", "solved"] }
);

const sessionEntry = fc.record(
  {
    id: base64urlId,
    challengeId: base64urlId,
    profileId,
    profileName: fc.string({ minLength: 1, maxLength: 64 }),
    status: fc.constantFrom("in-progress", "pending", "completed", "abandoned", "timed-out"),
    startedAt: isoTimestamp,
    finishedAt: isoTimestamp,
    score: fc.integer({ min: 0, max: 1000000 }),
    puzzles: fc.array(puzzleEntry, { minLength: 1, maxLength: 5 })
  },
  {
    requiredKeys: ["id", "challengeId", "profileId", "status", "startedAt", "puzzles"]
  }
);

const challengeResultsStore = fc
  .record(
    {
      version: fc.constant(1),
      updatedAt: isoTimestamp,
      sessions: fc.array(sessionEntry, { minLength: 0, maxLength: 5 })
    },
    { requiredKeys: ["version", "updatedAt", "sessions"] }
  )
  .map((s) => {
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
      .array(fc.constantFrom("daily.posted", "challenge.completed", "schedule.changed"), {
        minLength: 1,
        maxLength: 5
      })
      .map((arr) => [...new Set(arr)]),
    enabled: fc.boolean(),
    secret: webhookSecret,
    maxAttempts: fc.integer({ min: 1, max: 20 }),
    label: fc.string({ minLength: 0, maxLength: 80 }),
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp
  },
  {
    requiredKeys: ["id", "url", "events", "enabled", "secret", "maxAttempts", "createdAt", "updatedAt"]
  }
);

const webhookStore = fc
  .record(
    {
      version: fc.constant(1),
      updatedAt: isoTimestamp,
      subscriptions: fc.array(webhookSubscription, { minLength: 0, maxLength: 5 })
    },
    { requiredKeys: ["version", "updatedAt", "subscriptions"] }
  )
  .map((s) => {
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
    event: fc
      .tuple(
        fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"),
        stringFromPool([..."abcdefghijklmnopqrstuvwxyz0123456789._-"], 0, 32)
      )
      .map(([head, rest]) => `${head}${rest}`),
    url: httpsUrl,
    status: fc.constantFrom("queued", "running", "succeeded", "failed", "canceled"),
    attempts: fc.integer({ min: 0, max: 20 }),
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    nextAttemptAt: isoTimestamp,
    lastError: fc.string({ minLength: 0, maxLength: 200 })
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

const webhookDeliveryStore = fc
  .record(
    {
      version: fc.constant(1),
      updatedAt: isoTimestamp,
      deliveries: fc.array(webhookDelivery, { minLength: 0, maxLength: 5 })
    },
    { requiredKeys: ["version", "updatedAt", "deliveries"] }
  )
  .map((s) => {
    const seen = new Set();
    s.deliveries = s.deliveries.filter((d) => {
      if (seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });
    return s;
  });

// push-subscriptions.json (lib/push-subscription-store.js → normalizeStore)
//
// `endpointHash` must equal sha256(endpoint).slice(0,16) per
// data/push-subscriptions.schema.json + the store's normalize. The
// generator BUILDS endpointHash from the generated endpoint so the
// pair is consistent (Copilot caught the prior random-hex generator
// on PR #133).
const pushSubscription = httpsUrl.chain((endpoint) =>
  fc.record(
    {
      endpointHash: fc.constant(
        nodeCrypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 16)
      ),
      endpoint: fc.constant(endpoint),
      keys: pushKeys,
      createdAt: isoTimestamp,
      ua: fc.string({ minLength: 0, maxLength: 200 })
    },
    { requiredKeys: ["endpointHash", "endpoint", "keys", "createdAt"] }
  )
);

const pushSubscriptionStore = fc
  .record(
    {
      version: fc.constant(1),
      updatedAt: isoTimestamp,
      lastBroadcastAt: isoTimestamp,
      lastDailyFireAt: isoTimestamp,
      subscriptions: fc.array(pushSubscription, { minLength: 0, maxLength: 5 })
    },
    { requiredKeys: ["version", "updatedAt", "subscriptions"] }
  )
  .map((s) => {
    const seen = new Set();
    s.subscriptions = s.subscriptions.filter((sub) => {
      if (seen.has(sub.endpointHash)) return false;
      seen.add(sub.endpointHash);
      return true;
    });
    return s;
  });

// classes.json (lib/classes-store.js → normalizeClassesState)
//
// Per data/classes.schema.json:
//   - id matches `^class-[a-f0-9-]{12,64}$`
//   - name: 1-64 chars (className $def)
//   - memberProfileIds: array of profileIds (NOT nested profile objects;
//     the prior version had the shape wrong — Copilot caught on PR #133)
//
// Additionally `lib/classes-store.js#normalizeClassName` rejects any
// class name that's whitespace-only or contains a control character
// (code < 0x20 or 0x7f DEL). A class with a rejected name is silently
// pruned by `normalizeClassesState`. If the arbitrary generated such
// names, idempotence + schema-validity would still pass (drop-and-drop-
// again is idempotent) but the test wouldn't actually exercise class-
// record normalization on retained entries. Codex P2 caught this on
// PR #133 round 2 — we now build names from printable, trim-safe chars.
const PRINTABLE_NON_SPACE = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_."
];
const PRINTABLE_WITH_SPACE = [...PRINTABLE_NON_SPACE, " "];
const className = fc
  .tuple(
    fc.constantFrom(...PRINTABLE_NON_SPACE),
    stringFromPool(PRINTABLE_WITH_SPACE, 0, 62),
    fc.constantFrom(...PRINTABLE_NON_SPACE)
  )
  .map(([first, middle, last]) => `${first}${middle}${last}`);

const classEntry = fc.record(
  {
    id: classId,
    name: className,
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    memberProfileIds: fc
      .array(profileId, { minLength: 0, maxLength: 5 })
      .map((arr) => [...new Set(arr)])
  },
  {
    requiredKeys: ["id", "name", "createdAt", "updatedAt", "memberProfileIds"]
  }
);

const classesState = fc
  .record(
    {
      version: fc.constant(1),
      updatedAt: isoTimestamp,
      classes: fc.array(classEntry, { minLength: 0, maxLength: 5 })
    },
    { requiredKeys: ["version", "updatedAt", "classes"] }
  )
  .map((s) => {
    const seenIds = new Set();
    const seenNames = new Set();
    s.classes = s.classes.filter((c) => {
      if (seenIds.has(c.id)) return false;
      // Class names are uniqued case-insensitively by the store.
      const nameKey = c.name.toLowerCase();
      if (seenNames.has(nameKey)) return false;
      seenIds.add(c.id);
      seenNames.add(nameKey);
      return true;
    });
    return s;
  });

// leaderboard.json (lib/leaderboard-store.js → normalizeLeaderboardState)
//
// Per data/leaderboard.schema.json (Copilot PR #133 caught the prior
// generator's missing `updatedAt` and over-permissive `name`):
//   - profiles entries require id, name, createdAt, updatedAt
//   - name pattern `^[A-Za-z][A-Za-z '\\-]*$`, max 24 chars
//   - resultsByProfile is a map of profileId -> { dateKey -> result }
//
// Each per-date result entry must satisfy the schema's allOf
// conditional: when `won === true` then `attempts: integer >= 1`;
// when `won === false` then `attempts: null`. Copilot PR #133 r2
// asked us to actually exercise this branch rather than always
// shipping `resultsByProfile: {}`.
const leaderboardProfile = fc.record(
  {
    id: profileId,
    name: leaderboardProfileName,
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp
  },
  { requiredKeys: ["id", "name", "createdAt", "updatedAt"] }
);

// Leaderboard result key format from lib/leaderboard-store.js:
//   DAILY_KEY_PATTERN = /^(\d{4}-\d{2}-\d{2})\|([^|]+)\|([^|]+)$/
// The key has 3 segments: date, lang, code. `code` is opaque to the
// store (a non-pipe string identifying the result source — daily vs
// challenge etc.). `normalizeResultEntry` requires the entry's
// `date` to equal the key's date part — Codex P2 caught the
// bare-date-key bug on PR #133 round 3.
const leaderboardResultLang = fc.constantFrom("en", "es", "fr", "de", "en-US");
const leaderboardResultCode = stringFromPool(
  [..."abcdefghijklmnopqrstuvwxyz0123456789-"],
  3,
  16
);

const leaderboardResultEntry = fc
  .boolean()
  .chain((won) =>
    fc.record(
      {
        date: isoDate,
        won: fc.constant(won),
        attempts: won ? fc.integer({ min: 1, max: 12 }) : fc.constant(null),
        maxGuesses: fc.integer({ min: 1, max: 12 }),
        submissionCount: fc.integer({ min: 1, max: 50 }),
        updatedAt: isoTimestamp
      },
      {
        requiredKeys: [
          "date",
          "won",
          "attempts",
          "maxGuesses",
          "submissionCount",
          "updatedAt"
        ]
      }
    )
  )
  .chain((entry) =>
    fc
      .tuple(leaderboardResultLang, leaderboardResultCode)
      .map(([lang, code]) => ({
        entry,
        dailyKey: `${entry.date}|${lang}|${code}`
      }))
  );

const leaderboardState = fc
  .record(
    {
      version: fc.constant(1),
      updatedAt: isoTimestamp,
      profiles: fc.array(leaderboardProfile, { minLength: 0, maxLength: 3 }),
      // Populated by the .map below from the retained profile ids;
      // a fc.constant({}) placeholder keeps the record shape stable.
      resultsByProfile: fc.constant({})
    },
    { requiredKeys: ["version", "updatedAt", "profiles", "resultsByProfile"] }
  )
  .chain((s) => {
    // Dedup profiles by id first so the resultsByProfile map keys
    // match exactly one profile each.
    const seen = new Set();
    const profiles = s.profiles.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
    // For each retained profile, generate 0-3 result entries keyed
    // by their date string. Use fc.array → reduce to map so we
    // pull a deterministic generator chain per profile.
    if (profiles.length === 0) {
      return fc.constant({ ...s, profiles, resultsByProfile: {} });
    }
    return fc
      .tuple(
        ...profiles.map(() => fc.array(leaderboardResultEntry, { minLength: 0, maxLength: 3 }))
      )
      .map((entriesPerProfile) => {
        const resultsByProfile = {};
        profiles.forEach((p, i) => {
          const seenKeys = new Set();
          const dailyMap = {};
          for (const { entry, dailyKey } of entriesPerProfile[i]) {
            if (seenKeys.has(dailyKey)) continue;
            seenKeys.add(dailyKey);
            dailyMap[dailyKey] = entry;
          }
          resultsByProfile[p.id] = dailyMap;
        });
        return { ...s, profiles, resultsByProfile };
      });
  });

module.exports = {
  // Primitives — useful for stitching new generators in follow-up PRs.
  isoTimestamp,
  isoDate,
  wordAZ,
  langCode,
  ianaTimezone,
  base64urlId,
  profileId,
  webhookSecret,
  httpsUrl,
  pushKeys,
  classId,
  leaderboardProfileName,
  // Top-level per-store generators.
  schedule,
  challengesStore,
  challengeResultsStore,
  webhookStore,
  webhookDeliveryStore,
  pushSubscriptionStore,
  classesState,
  leaderboardState
};

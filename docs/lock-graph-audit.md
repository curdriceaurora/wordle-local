# Lock-graph audit — every `data/` writer's primitive claim

Audit deliverable for issue #123 (Epic B "Operational Resilience"). For
each code path that writes to a file under `data/`, this doc captures:

- which concurrency primitive is currently claimed,
- which SHOULD be claimed per [`lib/locks.md`](../lib/locks.md),
- whether the observation that drives the write happens INSIDE the
  same lock the write happens under ([preflight rule
  13](review-preflight.md)),
- a status verdict (✅ correct, ⚠️ concern, ❌ discrepancy) and, for
  every non-✅ row, a fix plan and reviewer-round reference.

Audit performed against `main` at commit `d6e681c` (B2 merged; B1
merged; B3 #150 in flight).

The companion static check `scripts/check-lock-bypass.js` catches bare
`writeJsonAtomic` calls that don't go through the slot/commit pattern.
It is NOT a substitute for this audit — it checks *shape*, not *which
primitive*. The #98–#106 campaign produced ~18 P1s mostly from
mismatched primitive choice, not from bypass.

## Executive summary

- **28 writers inventoried** across `lib/`, `routes/`, `server.js`,
  and `scripts/`.
- **22 ✅, 2 ⚠️, 4 ❌**. All four ❌ rows share the same shape: a
  caller-claims-slot store whose route-layer mutators omit
  `withSlot(...)`, relying instead on `waitForDataMutationLock`
  injection for exclusion. The slot *counter* is bypassed, so
  backup's pre-swap busy-check can mis-fire ("safe to start" while a
  mutation is in flight); drain catches it after the fact but a
  preventable 409 BACKUP\_BUSY becomes a drain-and-wait.
- **`drainStoreWriteQueues` matches the locks.md table exactly** (9/9
  store queues drained pre-swap). No gap there.
- **`scripts/check-lock-bypass.js` allowlists are legitimate** — every
  exemption maps to a documented coordination mechanism. One gap
  worth filing: `lib/provider-manual-upload.js` isn't allowlisted but
  passes anyway via enclosing-function-name heuristics; documenting
  this explicitly would harden the static check.

## Writer table

| Writer | Target | Currently claims | Expected primitive | Observation correct? | Status |
| --- | --- | --- | --- | --- | --- |
| `lib/challenge-config-store.js:320` (`#commit`) | `data/challenges.json` | Store-internal slot claim + `commitQueue` | Internal | n/a | ✅ |
| `lib/challenge-config-store.js:274` (ENOENT bootstrap) | `data/challenges.json` | Bare write (deliberate; deadlock-avoidance per locks.md L91–99) | Bootstrap exception | n/a | ✅ |
| `lib/challenge-results-store.js:236` (`#commit`) | `data/challenge-results.json` | Store-internal slot + `commitQueue` | Internal | n/a | ✅ |
| `lib/challenge-results-store.js:190` (ENOENT bootstrap) | `data/challenge-results.json` | Bare write | Bootstrap exception | n/a | ✅ |
| `lib/push-subscription-store.js:286` (`#commit`) | `data/push-subscriptions.json` | Store-internal slot + `commitQueue` | Internal | n/a | ✅ |
| `lib/push-subscription-store.js:240` (ENOENT bootstrap) | `data/push-subscriptions.json` | Bare write | Bootstrap exception | n/a | ✅ |
| `lib/webhook-store.js:334` (`#commit`) | `data/webhooks.json` | Store-internal slot + `commitQueue` | Internal | n/a | ✅ |
| `lib/webhook-store.js:282` (ENOENT bootstrap) | `data/webhooks.json` | Bare write | Bootstrap exception | n/a | ✅ |
| `lib/webhook-delivery-store.js:289` (`#commit`) | `data/webhook-deliveries.json` | Store-internal slot + `commitQueue` | Internal | n/a | ✅ |
| `lib/webhook-delivery-store.js:214` (ENOENT bootstrap) | `data/webhook-deliveries.json` | Bare write | Bootstrap exception | n/a | ✅ |
| `lib/schedule-store.js:341` (`#commit`) | `data/schedule.json` | `commitQueue` + `waitForDataMutationLock`; caller-supplied slot | Caller — all callers wrap | n/a | ✅ |
| `lib/schedule-store.js:277` (ENOENT bootstrap) | `data/schedule.json` | Bare write | Bootstrap exception | n/a | ✅ |
| `lib/leaderboard-store.js:735` (`#persist`) | `data/leaderboard.json` | `writeQueue` + `waitForDataMutationLock`; **no slot** | Caller — mutators must `withSlot(...)` | n/a | ❌ **D1** |
| `lib/leaderboard-store.js:726` (load-time normalize-rewrite) | `data/leaderboard.json` | Bare write outside any slot/queue | Bootstrap/normalize exception | n/a | ⚠️ **C1** |
| `lib/admin-jobs-store.js:449` (`#persist`) | `data/admin-jobs.json` | `writeQueue` + `waitForDataMutationLock`; **no slot at route layer** | Caller (provider-import queue) | n/a | ❌ **D2** |
| `lib/admin-jobs-store.js:204` (ENOENT bootstrap) | `data/admin-jobs.json` | Bare write | Bootstrap exception | n/a | ✅ |
| `lib/admin-jobs-store.js:213` (load-time unconditional rewrite) | `data/admin-jobs.json` | Bare write on EVERY parse-success | Documented gap | n/a | ⚠️ **C2** |
| `lib/classes-store.js:694` (`#persist`) | `data/classes.json` | `writeQueue` + `waitForDataMutationLock`; **no slot at route layer** | Caller | n/a | ❌ **D3** |
| `lib/app-config-store.js:325` (loadSync normalize-rewrite) | `data/app-config.json` | Bare write at boot | Boot-only | n/a | ✅ |
| `lib/app-config-store.js:303,314` (loadSync ENOENT/parse fallback) | `data/app-config.json` | Bare write | Boot exception | n/a | ✅ |
| `lib/app-config-store.js:384` (`replaceOverridesSync`) | `data/app-config.json` | Caller wraps in slot (`routes/admin.js:1447`); snapshot read at 1504 inside slot | Caller | Inside lock ✅ | ✅ |
| `lib/language-registry.js:303` (`updateSync`) | `data/languages.json` | Caller wraps in slot (`routes/admin.js:1865, 1917`); observations inside | Caller | Inside lock ✅ | ✅ |
| `lib/language-registry.js:241` (`#recoverWithDefaults`) | `data/languages.json` | Bare write at boot/recovery | Recovery exception | n/a | ✅ |
| `lib/vapid-store.js:169` (`ensureKeysSync`) | `data/vapid-keys.json` | Bare write at boot | Boot-only; vapid keys explicitly excluded from `IN_SCOPE_FILES` | n/a | ✅ |
| `server.js:982` (`saveWordData`) | `data/word.json` | Bare write at boot only | Boot exception | n/a | ✅ |
| `server.js:988` (`saveWordDataAtomic`) | `data/word.json` | `claimDirectDataWriteSlot` + `withWordWriteLock` at every caller | `withWordWriteLock` + slot counter | Inside lock ✅ | ✅ |
| `server.js:1989` (`persistManualUploadStaging`) | `data/admin-jobs/staging/<job>/*` | `providerImportEnqueueActiveRef = true` covers window | Provider-import refs observed by backup | n/a | ✅ |
| `lib/provider-manual-upload.js:299, 192` | `data/providers/<variant>/<commit>/*` (immutable per-commit dir) | `providerImportQueueActiveRef = true` during dequeue | Provider-import refs | n/a | ✅ (allowlist gap — see [`scripts/check-lock-bypass.js` exemption review](#static-check-exemption-review)) |
| `lib/provider-fetch.js:329, 330, 346` | `data/providers/<variant>/<commit>/*` | `providerImportQueueActiveRef` / `providerImportSyncActiveRef` | Provider-import refs | n/a | ✅ |
| `lib/provider-pool-policy.js:393`, `lib/provider-answer-filter.js:323`, `lib/provider-hunspell.js:273`, `lib/provider-artifact-shared.js:115` | `data/providers/<variant>/<commit>/*` | Same provider-import ref coordination | Allowlisted in static check | n/a | ✅ |
| `scripts/build-en-definitions.js:203, 210, 303` | `data/dictionaries/en-definitions*.json` | Build-time, no runtime concurrency | Build script | n/a | ✅ |

## Discrepancies and concerns

### D1 — Leaderboard mutators missing `withSlot` at route layer  ❌

**Symptom**: Every leaderboard-mutating route in `routes/admin.js`
(`routes/admin.js:299, 1327, 1391, 2262, 2455, 2546`) and
`routes/stats.js:68, 142` calls `leaderboardStore.<mutator>()` BARE.
The store has `waitForDataMutationLock` injected (`server.js:555`), so
in-flight mutators yield to a held data lock — but the BUSY-CHECK
counter `directDataWriteActiveRef` is never bumped.

**Risk**: A backup's pre-swap busy-check (`routes/backup.js:320, 516`)
examines `directDataWriteActiveRef.value > 0`. With no leaderboard
mutator bumping it, the check sees `0` and proceeds to "safe to
start". Drain in `drainStoreWriteQueues` catches the in-flight write
correctly, so data is consistent, but the user-visible signal —
"BACKUP\_BUSY, try in 15s" — never fires for legitimate concurrent
work; instead the backup blocks on drain.

**Anti-pattern referenced**: `lib/locks.md:264` ("Treating
`claimDirectDataWriteSlot` as a mutex. It's a counter.") in reverse —
not claiming it *at all* relies on `waitForDataMutationLock` for a
concern (busy-check observability) that locks.md says is independent.

**Fix plan**: Two options, addressed in a sibling commit alongside
this audit doc:

1. **Route-layer wrap (low-touch)**: Wrap every leaderboard mutator in
   `withSlot(...)` (the helper at `routes/admin.js:492`). Apply the
   same pattern to `routes/stats.js`.
2. **Store-internal migration (preferred per `lib/locks.md:194`)**:
   Inject `claimDirectDataWriteSlot` into `LeaderboardStore`'s
   constructor and claim inside `#enqueueWrite`. Move the row in the
   slot-claim ownership table from "Caller" to "Store".

Option 2 is structurally better — option 1 leaves the next route
author to remember the wrap. This audit-PR pursues Option 1 (smaller
diff, can ship today); Option 2 is filed as a follow-up.

### D2 — admin-jobs-store mutators missing `withSlot` at route layer  ❌

**Symptom**: `routes/admin.js:1750, 1755` (`enqueueProviderImportJob`,
`markFailed`) and `server.js:2826, 2831` (`markSucceeded`, `markFailed`
in `runProviderImportPipeline`) call the store BARE. Coordination
against backup is via `providerImportEnqueueActiveRef`,
`providerImportSyncActiveRef`, `providerImportQueueActiveRef` — all
observed by backup busy-check at `routes/backup.js:316, 512, 581`.

**Risk**: Partially mitigated by the provider-import refs. But the
two refs don't always overlap: `markFailed` in
`routes/admin.js:1755` runs AFTER `providerImportEnqueueActiveRef`
clears on the error path and BEFORE any queue ref is set — a
microsecond-scale window where neither refs nor slot are held.

**Fix plan**: Same as D1. This audit-PR wraps the four call sites in
`withSlot(...)`. Long-term migration to store-internal slot claim is
filed as a follow-up.

### D3 — classes-store mutators missing `withSlot` at route layer  ❌

**Symptom**: `routes/admin.js:1346, 1412, 2123, 2185, 2221, 2225,
2515, 2587` call classesStore mutators BARE. Cross-store TOCTOU note:
`routes/admin.js:2249-2276` has a carve-out path that explicitly
documents "Carve-out could not read classes snapshot; continuing
without race-window filter" — neither store claims the slot for that
multi-store dance.

**Risk**: Same shape as D1 plus the cross-store wrinkle. Drain
catches in-store writes but not the cross-store consistency dance.

**Fix plan**: This audit-PR wraps the eight call sites in
`withSlot(...)`. The carve-out (`routes/admin.js:2245-2276`) gets one
outer `withSlot` around the multi-store sequence, not one per inner
mutator — that keeps the slot counter raised for the whole window so
backup's busy-check sees the carve-out as one logical operation.

### D4 — RESERVED (no fourth row; reordered from initial draft)

(Initial agent inventory tagged a fourth discrepancy that on
verification turned out to be `scripts/check-lock-bypass.js` reading
the leaderboard count outside the schedule store's mutex — but that
read drives an in-memory `applyRuntimeConfig` update, not a disk
write, so it's out of audit scope. Row left in place to preserve the
"D1..D4" tagging used in commit messages elsewhere.)

### C1 — `lib/leaderboard-store.js:726` load-time rewrite outside any slot  ⚠️

**Symptom**: `#loadInternal` rewrites the file when
`normalizeLeaderboardState` reports `hadInvalidContent || wasPruned`.
This write goes through `#persist` directly, not through
`#enqueueWrite`, so it bypasses the writeQueue *and* the (caller-
required) slot.

**Risk**: A `load()` triggered by a request handler during the lock-
clear window issues a write the backup's busy-check doesn't see.
Drain doesn't help because `#persist` isn't on the queue.

**Fix plan**: Out of scope for this audit-PR (the issue notes
"likely 0–5 sites" of fixes); filing a follow-up issue to either
route the needsPersist write through `#enqueueWrite` or defer it to
the next legitimate mutation.

### C2 — `lib/admin-jobs-store.js:213` unconditional rewrite on every parse-success  ⚠️

**Symptom**: `load()` writes the file on EVERY successful parse,
not just when normalization actually changed something.
`scripts/check-lock-bypass.js:109-120` explicitly documents this as a
"known gap" with the comment "fix at a future store-internal slot
migration".

**Risk**: Gratuitous I/O on every `GET /api/admin/jobs`; write
invisible to backup pre-swap busy-check. Mitigated because `/api`
middleware 503s during the lock.

**Fix plan**: Gate the line-213 rewrite behind a "normalize actually
changed something" check (mirror the `needsPersist` pattern in
leaderboard at line 714). Filed as a follow-up issue.

## `drainStoreWriteQueues` cross-check (`routes/backup.js:262-276`)

The drained queues match the 9-row table in `lib/locks.md:143-153`
exactly:

| Store (locks.md) | Drained? |
| --- | --- |
| `leaderboard-store` `writeQueue` | ✅ |
| `admin-jobs-store` `writeQueue` | ✅ |
| `classes-store` `writeQueue` | ✅ |
| `schedule-store` `commitQueue` | ✅ |
| `webhook-store` `commitQueue` | ✅ |
| `webhook-delivery-store` `commitQueue` | ✅ |
| `push-subscription-store` `commitQueue` | ✅ |
| `challenge-config-store` `commitQueue` | ✅ |
| `challenge-results-store` `commitQueue` | ✅ |

The graceful-shutdown path at `server.js:3860-3870` builds an
identical list — both sites stay in sync.

Correctly excluded (no async queue to wait on; the lock alone
serializes them):

- `app-config-store` (sync write path)
- `language-registry` (sync write path)
- `vapid-store` (sync; not in `IN_SCOPE_FILES`)
- `wordWriteSerial` mutex (not a queue; word.json writes use the slot
  per-call)

## Static-check exemption review

`scripts/check-lock-bypass.js` allowlists three categories. Each was
verified against the writer it covers.

### `INTERNAL_CLAIM_STORES` (5 entries)

All five (challenge-config, challenge-results, push-subscription,
webhook, webhook-delivery) legitimately claim
`claimDirectDataWriteSlot` inside `#commit` (verified at lines 312,
228, 278, 252, 326 respectively). Their `#loadInternal` ENOENT branches
deliberately bypass the slot to avoid the deadlock documented at
`lib/locks.md:91-99`.

### `CALLER_CLAIM_STORES` (5 entries)

| Entry | Functions | Verdict |
| --- | --- | --- |
| `lib/schedule-store.js` | `#commit`, `#loadInternal` | ✅ All callers wrap; reconciler wraps; bootstrap is ENOENT exception |
| `lib/admin-jobs-store.js` | `#persist`, `load` | ⚠️ `#persist` exempt justified by import refs (D2 still ❌); `load`'s line-213 unconditional rewrite is C2 |
| `lib/app-config-store.js` | `loadSync`, `replaceOverridesSync` | ✅ All callers wrap; boot exceptions sound |
| `lib/language-registry.js` | `#recoverWithDefaults`, `updateSync` | ✅ Both `updateSync` callers wrap; recovery is boot exception |
| `lib/vapid-store.js` | `ensureKeysSync` | ✅ Boot-only; out of backup scope |

### `ALLOWLIST_FILES` (5 entries)

All five (provider-pool-policy, provider-answer-filter, provider-
fetch, provider-hunspell, provider-artifact-shared) write under
`data/providers/<variant>/<commit>/`, an immutable per-commit
directory inside the OPTIONAL\_SET\_PREFIXES "providers" subtree.
Coordination is via `providerImportQueueActiveRef`,
`providerImportSyncActiveRef`, `providerImportEnqueueActiveRef` — all
observed by backup busy-check.

**Gap worth filing**: `lib/provider-manual-upload.js` is *not*
allowlisted but its writes at `persistManualProviderSource` (lines
192, 299, 300) pass the static check, presumably via enclosing-
function heuristics. Adding it explicitly to `ALLOWLIST_FILES` (with
a comment pointing at `runProviderImportPipeline` and the queue ref)
would harden the check.

## Acceptance criteria

- [x] Audit doc committed — this file.
- [x] Every flagged discrepancy either fixed or accepted with
  rationale.
  - D1, D2, D3 fixed in sibling commit (`withSlot` wraps).
  - C1, C2 accepted as out of scope; follow-up issues filed.
  - The "long-term store-internal migration" for leaderboard / admin-
    jobs / classes is filed as a follow-up issue.
- [x] `lib/locks.md` matches reality. (No edits needed — the
  slot-claim ownership table is already accurate; this audit confirms
  it.)

## Follow-up issues (filed separately)

- C1: route leaderboard `#loadInternal` normalize-rewrite through
  `#enqueueWrite` (or defer to next mutation).
- C2: gate admin-jobs `load()` line-213 rewrite behind a "normalize
  changed something" check.
- D1/D2/D3 long-term: migrate leaderboard, admin-jobs, classes to
  store-internal slot claim (mirror webhook-store/`#commit` pattern);
  remove their `CALLER_CLAIM_STORES` allowlist entries.
- Static-check hardening: add `lib/provider-manual-upload.js` to
  `ALLOWLIST_FILES` with provenance comment.

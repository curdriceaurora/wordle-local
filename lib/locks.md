# Concurrency primitives — lock graph and usage rules

Authoritative reference for every lock, slot, and ref used to coordinate
writes against `data/`. Distilled from the patterns reviewers caught
during the #98–#106 campaign.

**Read this before adding code that:**

- writes to a file under `data/`
- mounts middleware that gates an admin/data route
- adds a new busy-check or in-flight ref
- introduces a new mutex or counter

**Mental model.** `data/` writes are coordinated through three concerns:

1. **Backup/restore exclusion.** A backup must not snapshot a tree that's
   being mutated; a restore must not stomp a mutation in flight.
2. **Cross-route serialization.** Some operations span multiple stores
   and need their own atomicity (admin update vs user start).
3. **Per-store atomicity.** Each store has its own write queue so
   concurrent callers don't clobber each other.

Each primitive below addresses one or more of these concerns. **Mixing
them up was the most common P1 source in the campaign.**

## Quick reference

| Primitive | Kind | Concern | Where it's declared | Typical caller |
| --- | --- | --- | --- | --- |
| `dataMutationLockRef` | Promise barrier (boolean + waitable) | Backup/restore exclusion | `server.js` | Backup route (sets `true` during phase 3 swap) |
| `restoreInProgressRef` | Promise barrier (boolean + waitable) | Backup/restore exclusion | `server.js` | Restore route (sets `true` for the full upload+apply window) |
| `claimDirectDataWriteSlot` | **Counter** (`directDataWriteActiveRef`) | Backup/restore exclusion | `server.js` | Direct writers (`POST /api/word`, schedule routes, store `#commit`) |
| `directDataWriteActiveRef` | Counter (read by busy-check) | Backup/restore exclusion | `server.js` | Backup/restore busy-check observes it |
| `withWordWriteLock` | Strict per-key mutex (Promise chain) | Decide-then-write atomicity | `server.js` | Manual `POST /api/word`, scheduler reconciler |
| `withChallengeAdminUserMutex` | Cross-route Promise chain | Cross-store atomicity | `server.js` | `PUT /api/admin/challenges/:id`, `POST /api/challenges/:id/start` |
| Per-store `commitQueue` / `writeQueue` | Per-instance Promise chain (FIFO) | Per-store atomicity | each `lib/<store>.js` | The store's own `update`/`createSession`/`#commit` |
| `providerImportQueueActiveRef` | Boolean | Backup/restore exclusion | `server.js` | Async provider import queue |
| `providerImportSyncActiveRef` | Boolean | Backup/restore exclusion | `server.js` | Sync provider import path |
| `providerImportEnqueueActiveRef` | Boolean | Backup/restore exclusion | `server.js` | Provider import upload+enqueue window |
| `webhookEmitInFlightRef` | Counter | Backup/restore exclusion | `server.js` | Detached `webhookService.emit(...)` from import queue |

## Primitives — deep dive

### `dataMutationLockRef` (Promise barrier)

A boolean with a `waitForRelease()` method. Set to `true` ONLY by the
backup/restore route during the phase-3 swap window (the moment the
archive's bytes get renamed into `data/`).

- **Use when**: you need exclusive disk access against backup/restore.
  Generally you don't claim it directly — it's claimed by the backup
  route, observed by everything else.
- **Don't use when**: you want to serialize two regular writers against
  each other. Use a per-store `commitQueue` / `writeQueue` or a dedicated mutex
  instead — `dataMutationLockRef` is a *single global flag*, not a
  general-purpose lock.
- **Pitfall**: awaiting `waitForRelease()` when the lock isn't held is
  a no-op (resolves immediately). `claimDirectDataWriteSlot` busy-loops
  on this — see its entry below for why that's intentional.

### `restoreInProgressRef` (Promise barrier)

Same shape as `dataMutationLockRef`. Set to `true` for the **entire**
restore window: from upload start through final reload, including the
multi-second multipart-upload phase BEFORE `dataMutationLockRef` is
claimed. Has its own waitable promise so direct writers can yield.

- **Use when**: same answer as `dataMutationLockRef` — you don't claim
  it; you observe it.
- **Why two barriers, not one**: backup needs the data lock for a
  short swap window; restore needs to refuse other operations for a
  much longer upload+validate+apply window. Splitting lets backup
  not stall during a long upload phase that's not yet writing.

### `claimDirectDataWriteSlot` → `directDataWriteActiveRef` (**counter, NOT mutex**)

This one trips people up. **It is a counter. Multiple writers can hold
it concurrently.** Its purpose is to make the backup/restore busy-check
see "any direct writer is active right now" — not to serialize the
direct writers against each other.

- **Use when**: you're adding a route handler or scheduled job that
  writes directly to a `data/` file (bypassing a store's
  `commitQueue` / `writeQueue`) and you need the backup/restore busy-check to see
  the work as in-flight.
- **Don't use when**: you need EXCLUSIVE access. Two callers can both
  hold the slot at once and both will write; the slot doesn't prevent
  that. If two writers must serialize against each other, layer a
  dedicated mutex (`withWordWriteLock`, `withChallengeAdminUserMutex`,
  or a new one) ON TOP OF the slot.
- **Pitfall — deadlock if claimed under `dataMutationLockRef`**:
  `claimDirectDataWriteSlot()` busy-loops on `dataMutationLockRef.waitForRelease()`
  and `restoreInProgressRef.waitForRelease()`. If you claim the slot
  from inside the backup/restore route (which sets the data lock
  `true` BEFORE calling `warmInScopeStores()`), you wait forever.
  This is exactly what bit PR #105 round 3 in the challenge-config
  bootstrap path. Bootstrap-on-ENOENT in stores intentionally writes
  via raw `writeJsonAtomic` (no slot claim) for this reason — see the
  comment block in `lib/challenge-config-store.js` for the full story.

### `withWordWriteLock` (strict per-key Promise chain)

Exclusive mutex around `data/word.json` writes. Manual `POST /api/word`
and the scheduler reconciler both serialize through it.

- **Use when**: you need decide-then-write atomicity for a specific key.
  The decision (read current state, compute next state) and the write
  must not interleave with another writer's decision-then-write.
- **Don't use when**: a per-store `commitQueue` / `writeQueue` already provides this.
  `withWordWriteLock` exists because `data/word.json` is written from
  TWO independent code paths that don't share a store instance.

### `withChallengeAdminUserMutex` (cross-route Promise chain)

Added in PR #105 round 5 specifically because `claimDirectDataWriteSlot`
is a counter. Serializes admin's `PUT /api/admin/challenges/:id` against
user's `POST /api/challenges/:id/start` so the admin's hasResults
observation is atomic with respect to the user's `createSession`.

- **Use when**: two routes touch DIFFERENT stores in a sequence that
  must look atomic from each route's perspective. Per-store commit
  queues serialize within a store; this primitive serializes across.
- **Pitfall — re-read inside the lock**: PR #105 round 6 caught this.
  If the route reads its config BEFORE entering the mutex and the
  other route changes that config inside its own mutex hold, the
  first route writes derived state from the stale config. Always
  re-read authoritative state INSIDE the mutex closure.

### Per-store `commitQueue` / `writeQueue` (per-instance Promise chain)

Each persistent store has its own per-instance Promise chain that
serializes writes within that store. **Two names exist for historical
reasons**: older stores call the field `writeQueue` (the original
naming convention from the leaderboard store); newer stores added
during the #98–#103 campaign use `commitQueue` paired with a
private `#commit(updater)` method. Both are the same primitive.
The backup-restore drain path (`drainStoreWriteQueues` in
`routes/backup.js`) is the authoritative list — when adding a new
store, append its queue there too.

Mapping today:

| Store | Queue field name |
| --- | --- |
| `lib/leaderboard-store.js` | `writeQueue` |
| `lib/admin-jobs-store.js` | `writeQueue` |
| `lib/classes-store.js` | `writeQueue` |
| `lib/schedule-store.js` | `commitQueue` |
| `lib/webhook-store.js` | `commitQueue` |
| `lib/webhook-delivery-store.js` | `commitQueue` |
| `lib/push-subscription-store.js` | `commitQueue` |
| `lib/challenge-config-store.js` | `commitQueue` |
| `lib/challenge-results-store.js` | `commitQueue` |

Each `commitQueue`-style store is driven by a private `#commit(updater)`
that:

1. Chains the updater onto `commitQueue` so prior commits drain first.
2. Inside the updater: reads cached state, runs the mutator, runs
   the store's normalizer, persists via `writeJsonAtomic`, returns.

The older `writeQueue` stores follow the same pattern with slightly
different method names (e.g. `commit()` rather than `#commit()`); the
behavioral contract is identical.

#### Slot-claim ownership: store vs caller

The backup-restore slot (`claimDirectDataWriteSlot`) **must** be held
while the disk write happens. Where that claim originates differs
across stores — class-wide, two ownership patterns exist:

| Store | Slot claimed by |
| --- | --- |
| `lib/challenge-config-store.js` | Store (inside `#commit`) |
| `lib/challenge-results-store.js` | Store (inside `#commit`) |
| `lib/push-subscription-store.js` | Store (inside `#commit`) |
| `lib/webhook-store.js` | Store (inside `#commit`) |
| `lib/webhook-delivery-store.js` | Store (inside `#commit`) |
| `lib/schedule-store.js` | Caller (route layer wraps in `withSlot(...)`) |
| `lib/leaderboard-store.js` | Caller (route layer) |
| `lib/admin-jobs-store.js` | Caller (provider-import queue) |
| `lib/classes-store.js` | Caller (route layer) |

Both patterns are correct as long as **something in the call chain**
claims the slot before the write. Stores that take
`claimDirectDataWriteSlot` as a constructor dep (the 5 above) embed
the claim in `#commit`, so callers don't need to know about it.
Stores that don't (the 4 above) require every mutation site to wrap
in `withSlot(...)` (or equivalent) explicitly.

When adding a NEW store, prefer the store-claims-slot pattern: it's
harder to forget the claim at a future caller site. The caller-
claims pattern persists in older stores for historical reasons (they
predate the slot mechanism's standardization at the store layer).

- **Use when**: implementing a store update method. Wrap your mutator
  in `#commit`. The mutator should be pure (state in, next state out)
  so it's safe to retry and so race-condition tests can replay it.
- **Pitfall — return post-normalize state**: if your mutator returns
  a session/object with extra fields, `normalizeStore` strips them
  during persistence — but a naïve `return cloneState(updated)` (where
  `updated` was the raw mutator return) gives the caller pre-normalize
  state that diverges from disk. Caught by Copilot on PR #105 round 4.
  Always re-read from `this.state` after `#commit` returns, or
  normalize before storing.
- **Pitfall — bootstrap on ENOENT**: when `#loadInternal()` hits
  ENOENT, it must NOT claim the slot (deadlock — see
  `claimDirectDataWriteSlot` above) and must NOT skip persistence
  (breaks backup-warming — see PR #105 rounds 3+4). The pattern
  every in-scope store uses: write directly via `writeJsonAtomic`
  with no slot claim. Safe because: (a) all read paths are gated by
  the `/api` middleware which 503s during backup, OR (b) the read
  is the backup/restore route itself calling `warmInScopeStores`
  while it already holds the data lock.

### `webhookEmitInFlightRef` (counter)

A counter incremented before a detached `webhookService.emit(...)` from
the provider-import queue's `.finally()` and decremented when the emit's
promise settles. Lets the restore busy-check observe in-flight webhook
deliveries even though the import queue itself has cleared.

- **Use when**: you have a fire-and-forget side effect that does disk
  I/O AND must not race a restore. Don't use a boolean — multiple
  emits can be in flight at once; you need a counter.
- **Don't use when**: you can simply `await` the side effect. Awaiting
  is always preferable; this primitive exists because awaiting blocked
  the import queue throughput.

## Common patterns

### "I want to write a JSON file under `data/`"

1. Is there a store for it? Use the store's mutation methods. Done.
2. No store? Are you in a request handler or scheduled job? Wrap with
   `claimDirectDataWriteSlot` so the backup/restore busy-check sees
   the work, AND a dedicated mutex if more than one caller writes the
   same file (cf. `withWordWriteLock`).
3. Is this a bootstrap-on-ENOENT path called from a read? Write
   directly via `writeJsonAtomic`, no slot. (See challenge-config-store
   comment for why.)

### "I'm adding a new admin route that mutates a store"

1. Mount under `/api/admin` so `requireAdminAccess` + the standard
   admin gate applies.
2. Wrap the handler in `withSlot` (admin's local helper that calls
   `claimDirectDataWriteSlot`) so the busy-check sees you.
3. If the mutation observation reads from another store and the
   decision must be atomic, layer a cross-route mutex (extend
   `withChallengeAdminUserMutex` if it's challenge-related, or add a
   new dedicated one).

### "I'm adding a fire-and-forget side effect"

1. Don't `await` it — defeats fire-and-forget.
2. But also don't drop it — track it with a counter (cf.
   `webhookEmitInFlightRef`) and have the restore busy-check observe
   that counter, so a restore can't roll the action back while the
   side effect is still landing.

## Anti-patterns and known traps

- **Treating `claimDirectDataWriteSlot` as a mutex.** It's a counter.
  Two callers can hold it at once. PR #105 round 1 made this mistake.
- **Claiming the slot from a code path that may be called by the
  backup/restore route.** Deadlock. PR #105 round 3.
- **Reading authoritative state OUTSIDE a cross-store mutex, then
  computing inside.** Stale read. PR #105 round 6.
- **Returning the mutator's pre-normalize value.** Disk diverges from
  what the caller sees. PR #105 round 4.
- **Detaching a side effect WITHOUT a counter for the busy-check.**
  Restore rolls back; late emit fires for the reverted action. PR #105
  round 2.
- **Writing on bootstrap-ENOENT WITH a slot claim.** Deadlock when the
  call comes from inside backup/restore. PR #105 rounds 3 + 4.

## When adding a new primitive to this list

1. Add a row to the Quick reference table.
2. Add a Deep-dive section: kind, what it locks against, when to use,
   when NOT to use, known pitfalls.
3. Tag the declaration site in code with a `// Locks: see lib/locks.md`
   comment so the next reader has a path to this doc.
4. If the primitive interacts with backup/restore busy-checks, audit
   `routes/backup.js` busy-checks to make sure it's observed.

## Related docs

- [docs/backup-restore.md](../docs/backup-restore.md) — operator
  runbook for the backup/restore feature.
- [docs/admin-platform-architecture-contract.md](../docs/admin-platform-architecture-contract.md) —
  config precedence and queue semantics at the admin platform layer.

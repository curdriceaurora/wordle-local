# Daily word scheduler

Operator-side overview of the **Schedule** tab in the admin shell and the
runtime behavior that owns `data/word.json`.

## What it does

The scheduler reads `data/schedule.json`, picks the right word for "today"
(in the schedule's own timezone), and writes it into `data/word.json`. It
runs in two places:

1. **Boot**: a single reconcile pass before the HTTP server starts taking
   traffic, so the first `GET /api/word` and `/daily` see the right word.

2. **Tick**: `setInterval` (default 60s, configurable via
   `SCHEDULER_CHECK_INTERVAL_MS`) re-runs reconcile so a long-running
   process crosses local midnight without operator intervention.

The reconciler is **idempotent** — if `data/word.json` already matches the
scheduled word for today, no write happens. It's also **deterministic**:
restart the server twice on the same local date with the same schedule
and the resulting `data/word.json` is byte-equal (modulo `updatedAt`).

## Data flow

```text
                  +----------------------+
                  |  data/schedule.json  |  (operator edits via Schedule tab)
                  +----------+-----------+
                             |
                  reconcileDailyWord()
                             |
                             v
                  +----------+-----------+
                  |   data/word.json     |  (used by /api/word, /daily)
                  +----------------------+
                             ^
                             |
                  POST /api/word (manual override)
```

The schedule is **upstream**. Manual `POST /api/word` writes are still
honoured for the rest of the local day — the reconciler detects them and
yields. At the next local-day rollover, the schedule wins again.

## Schema

`data/schedule.schema.json` (Draft 2020-12, `additionalProperties: false`,
registered with `npm run schema:check`).

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `version` | integer (`const: 1`) | yes | Migration anchor — bump when the shape changes incompatibly. |
| `updatedAt` | ISO-8601 string | yes | Bumped on every write. |
| `timezone` | IANA zone | yes | Validated against `Intl.DateTimeFormat` at load. The schedule's "today" is computed in this zone. |
| `auto_rotate` | boolean | yes | When true, days without an explicit entry get filled from the active language's answer pool. |
| `auto_rotate_seed` | string ≤128 | no | If present, mixed into the seeded pick so two operators can deterministically diverge their picks (or pin them). |
| `retention_days` | integer 0-36500 | yes | Past entries older than `today − retention_days` are eligible for `POST /api/admin/schedule/prune`. |
| `scheduled_words[]` | array | yes | Each entry is `{ date: YYYY-MM-DD, word: A-Z{3,12}, lang: en\|en-US\|..., notes?: string≤200 }`. Uniqueness enforced on `(date, lang)`. The 3–12 cap matches the game's `MIN_LEN`/`MAX_LEN` so a scheduled puzzle is always playable through `/api/guess`. |
| `last_reconciled_at` | ISO-8601 string | no | Stamped by the reconciler. |
| `last_reconciled_for` | YYYY-MM-DD | no | Stamped by the reconciler — the local date it most recently wrote (or attempted to write). |

## Reconcile decision

`lib/scheduler-tick.js` exports a pure `decideReconcile()` function that
returns one of:

- `noop` — schedule has no entry for today, auto-rotate is off, or
  word.json already matches.

- `skip-manual-override` — word.json's `date` matches today but
  `lastScheduledFor !== today`, meaning a manual write happened after our
  last scheduler write.

- `write-scheduled` — there's an entry for today; write it.
- `auto-rotate` — no entry for today, auto-rotate is on; pick a word
  deterministically from the active language's answer pool and write it.

Auto-rotate uses `sha256(seed | date | lang | commit)` mapped modulo the
pool size, so the same date in the same provider commit always picks the
same word. Setting `auto_rotate_seed` lets operators pin a different
sequence (or coordinate across deployments).

### Manual override semantics

`POST /api/word` is still the manual-override path. The scheduler writes
`data/word.json.lastScheduledFor = todayLocal` whenever it persists a
word; manual writes don't set that field at all. The reconciler decides
"manual override?" by checking `lastScheduledFor` for **absence**
(`=== undefined || === null`) — NOT by comparing it to `todayLocal`. A
prior scheduler write whose `lastScheduledFor` is yesterday's
schedule-local day is therefore correctly classified as a stale
scheduler write (not a manual override) and is fair game to overwrite.

When the reconciler runs, it sees one of:

- `lastScheduledFor` absent (manual override path) AND the override is
  fresh (see "fresh enough to honour" rules below) → **leave it alone**
  for the rest of the local day.

- `lastScheduledFor` absent AND the override is stale → fair game.
- `lastScheduledFor` present (scheduler-owned write) → fair game; the
  reconciler may overwrite with the day's scheduled or auto-rotated
  word, regardless of whether `lastScheduledFor` matches `todayLocal`.

A manual override is "fresh enough to honour" if either:

1. `word.json.date === serverToday` (the operator pinned today
   explicitly), OR

2. `word.json.date === null` or omitted entirely AND the override's
   effective day, computed from `updatedAt`'s server-local date, is
   still `serverToday`. Without this fallback, a null-date override
   would live forever instead of expiring at the next midnight.

`serverToday` is the server's local date (`getLocalDateString(now)`),
NOT the schedule's timezone. An operator POSTing without `date`
shouldn't be surprised that the override expires sooner than expected
if the server's TZ differs from the schedule's. Recommend setting
`date: serverToday` in manual writes for explicit clarity.

The scheduler is NOT timezone-aware in the override-freshness check —
it always uses the server's own `getLocalDateString(now)`. The
schedule's `timezone` only affects which row is picked from
`scheduled_words`, not whether a manual override is still considered
fresh.

## Timezone alignment

Two zones interact:

- The **schedule's timezone** (`schedule.timezone`) — drives "today" for
  the reconciler and the scheduled-word date keys. Defaults to
  `SCHEDULE_TIMEZONE_DEFAULT` env var on first boot, falling back to
  `process.env.TZ` then `UTC`.

- The **server's local timezone** — used by `getLocalDateString()` when
  the game persists the daily-key for a play.

If `schedule.timezone` differs from the server's local zone, scheduled
words and daily-key dates can disagree by a day around midnight. Set
the server's TZ to match the schedule's TZ (or vice versa) unless you
explicitly want this divergence.

## Endpoints

All under `/api/admin/schedule`, gated by `x-admin-key` and the standard
admin write rate limit.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/schedule` | Read-only snapshot. |
| `POST` | `/api/admin/schedule/entries` | Add an entry. `?overwrite=true` replaces an existing one. `201` on add, `200 { replaced: true }` on overwrite, `409 { code: DUPLICATE_ENTRY }` on conflict. |
| `PUT` | `/api/admin/schedule/entries/:date/:lang` | Partial edit (word, notes). |
| `DELETE` | `/api/admin/schedule/entries/:date/:lang` | `204` on success, `404` on missing. |
| `PUT` | `/api/admin/schedule/config` | Update `auto_rotate`, `timezone`, `retention_days`, `auto_rotate_seed`. |
| `POST` | `/api/admin/schedule/prune` | Delete entries older than `today − retention_days` (today computed in `schedule.timezone`). |
| `POST` | `/api/admin/schedule/reconcile` | Trigger an immediate reconcile pass. Returns the decision. |

Every write emits a structured `[schedule]` audit log line via stdout
JSON: `{ event, ts, actor, ...action-specific fields }`. `actor` is the
first 12 hex chars of `sha256(adminKey)` so the secret doesn't end up in
the log itself.

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `SCHEDULE_TIMEZONE_DEFAULT` | `process.env.TZ` or `UTC` | IANA zone seeded into a freshly-created `data/schedule.json`. After first boot the file's value wins; this var only affects *new* installs. |
| `SCHEDULER_CHECK_INTERVAL_MS` | `60000` | How often the reconcile tick fires. Range 1000–3600000. |
| `SCHEDULE_RETENTION_DAYS` | `90` | Initial `retention_days` for new installs (0–36500). |
| `SCHEDULE_STORE_PATH` | `data/schedule.json` | Override for tests; should not be set in production. |

## Boot ordering

`startServer()` runs a single boot reconcile **before** the listener
accepts traffic, then starts the interval. Failures during boot reconcile
are logged with `[scheduler]` prefix but don't block the server from
coming up — the schedule is a soft layer over manual word.json writes,
not a hard dependency.

The interval timer is `unref()`'d so test teardown doesn't hang waiting
for the next tick.

## Rollback

Stop the server and delete `data/schedule.json`. On the next boot
the store recreates an empty default file (with `auto_rotate=false`
and an empty `scheduled_words` array) — there's no separate
"scheduler off" mode in v1. Functionally this is the same as
disabled: the reconciler tick has nothing to apply and `decideReconcile`
returns `noop` every minute, so `data/word.json` is never touched
by the scheduler.

Manual `POST /api/word` overrides keep working as they did before.
`data/word.json` itself is untouched by the rollback — if the
scheduler had written today's word, it stays until the operator
changes it manually. To prevent the scheduler from running entirely,
the operator can also unset `SCHEDULER_CHECK_INTERVAL_MS` and
disable the boot reconcile by reverting the scheduler wiring (a
separate code change, not a config knob in v1).

## Drift considerations

- A docker host that resumes from sleep at 00:05 will delay the
  reconcile by up to one tick interval (default 60s). Acceptable for a
  family-scale instance; raise the polling cadence if you need tighter.

- DST forward/backward in IANA zones is handled by `Intl.DateTimeFormat`
  — the unit tests in `tests/scheduler-tick.test.js` cover both
  transitions in `America/New_York`.

## Adding a new metric or field

1. Bump the schema's `version` constant and add the field with
   `additionalProperties: false`.

2. Update `normalizeSchedule()` in `lib/schedule-store.js` so old files
   migrate forward (or hard-fail with `VERSION_UNSUPPORTED` so the
   operator can repair).

3. Add a regression fixture in `tests/schedule-store.test.js` that pins
   the new field's values against a known input.

4. Document the field above and update the env-var table if applicable.

## Known limitations (v1)

- Recurring rules (RRULE / weekly templates) are not supported — each
  entry is one date.

- No CSV / iCal import. Use the REST API in scripts if you need bulk.
- Auto-rotate is single-language: it picks from the language already
  named in `word.json` (or the registry default `en`). A multi-language
  daily would require a separate per-language toggle, deferred to a
  later issue.

- The Schedule tab is English-only, matching the rest of the admin
  surface.

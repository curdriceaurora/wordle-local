# Backup & Restore

Operator runbook for the admin Data tab.

## What gets backed up

The archive is a single `.zip` with a `manifest.json` at the root and
the following files, all at their canonical paths under the project
root:

**Always included** (in-scope, restored on apply):

- `data/leaderboard.json`
- `data/languages.json`
- `data/admin-jobs.json`
- `data/app-config.json`
- `data/classes.json`
- `data/word.json`

**Diagnostic-only** (read-only, included for cross-version diagnostics
but never restored):

- `data/leaderboard.schema.json`
- `data/languages.schema.json`
- `data/admin-jobs.schema.json`
- `data/app-config.schema.json`
- `data/classes.schema.json`
- `data/backup-manifest.schema.json`
- `data/providers/provider-import-manifest.schema.json`

**Optional sets** (off by default; toggled in the export UI or via
`includeProviders=true` / `includeDictionaries=true` query params):

- `data/providers/**` — provider artifacts (per-language, per-commit).
  Can be tens of MiB per language. See *Sizing* below.

- `data/dictionaries/**` — raw dictionary files.

**Explicitly excluded**:

- `.env` and any other secrets directory
- `data/.admin-key`
- Anything not under `data/`

## Manifest schema

[`data/backup-manifest.schema.json`](../data/backup-manifest.schema.json) —
JSON Schema 2020-12, validated by `npm run schema:check`.

Required fields:

- `manifestVersion` — currently locked at `1`. Mismatched manifest
  versions are rejected with `MANIFEST_VERSION_UNSUPPORTED`.

- `appVersion` — from the server's `package.json` at export time.
- `createdAt` — ISO-8601 UTC.
- `nodeId` — taken from `data/app-config.json` `nodeId` (defaults to
  `"unknown-node"` if unset).

- `files[]` — every entry has `path`, `bytes`, `sha256`. Files that
  have a paired schema also carry a `schema: { schemaPath, sha256 }`
  digest used for schema-drift detection on restore.

- `optionalSets[]` — `"providers"` and/or `"dictionaries"` if those
  sets were included.

## Endpoints

All under `/api/admin/*`, gated by `x-admin-key`. The strict
`BACKUP_RATE_LIMIT_*` bucket guards the bandwidth-heavy export and
destructive restore operations; preview is idempotent and gated only
by the standard admin-write rate limit so the normal preview-then-
apply UI flow never collides with itself.

| Method | Path | Backup-rate-limited | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/admin/backup` | Yes | Streams the archive. Query: `includeProviders=true\|false`, `includeDictionaries=true\|false`. |
| `POST` | `/api/admin/backup/preview` | No | Validates an uploaded archive without applying. Returns `{ manifestVersion, appVersion, createdAt, nodeId, files, totalBytes }`. |
| `POST` | `/api/admin/restore` | Yes | Applies atomically. Requires the header `x-admin-confirm: I-UNDERSTAND` plus a multipart `archive` field. |

## Restore algorithm

1. Validate the uploaded archive against
   `data/backup-manifest.schema.json`.

2. Reject if `manifestVersion !== 1`, if any entry's recomputed sha256
   differs from the manifest, or if any entry exceeds the per-entry
   size cap (default 64 MiB) or pushes the total past
   `BACKUP_MAX_BYTES`.

3. Schema-drift guard: for each manifest entry that carries a
   `schema:` digest, recompute the digest of the matching schema file
   on disk. Reject with `SCHEMA_DRIFT` if they differ — the archive
   was produced under an incompatible schema and needs offline
   migration before restoring.

4. Extract every restorable file (in-scope + included optional sets)
   into `data/.restore-staging-<ts>-<rand>/`.

5. Validate each staged in-scope file against its schema.
6. For each file, snapshot the live copy into
   `data/.restore-rollback-<ts>-<rand>/` and rename the staged file
   into place.

7. On any error in step 6, reverse the renames from the rollback dir;
   the live `data/` is left byte-identical to its pre-restore state.

8. On success, remove both the staging and rollback directories.
9. Reload in-memory caches (`leaderboardStore`, `adminJobsStore`,
   `classesStore`, `appConfigStore`, `languageRegistryStore`, language
   runtime catalog). The response surfaces per-store reload status.

## Atomicity

Every in-scope file is byte-copied via the staging dir, validated
against its schema, then atomically renamed into place. A failure
mid-apply triggers a reverse rename from the rollback dir.

Restore returns:

- HTTP **200** with `{ ok: true, restored, removed, filesRestored,
  rolledBackOnError: false, reloads, warnings }` when every in-scope
  file was swapped into place. Per-store cache reload outcomes are
  in `reloads` (an array of `{ name, ok, error? }` entries) — that's
  where to look when a single store's reload throws after a
  successful apply. `warnings` only carries archive/apply-time
  warnings (e.g. `ROLLBACK_PARTIAL`); a successful apply normally
  has an empty `warnings` array.

- HTTP **400** for pre-apply validation failures (manifest invalid,
  manifest version unsupported, schema drift, malformed zip, sha256
  mismatch, path traversal). The body has
  `rolledBackOnError: false` because no on-disk mutation happened.

- HTTP **400** with `rolledBackOnError: true` for failures that
  occurred after at least one file had been swapped — the rewind
  ran and the live tree is byte-equal to its pre-restore state.
  `warnings` may include `ROLLBACK_PARTIAL` notes when a rewind step
  itself failed (rare; operator action required).

- HTTP **409** when another admin operation (provider import or a
  concurrent restore) holds the single-flight mutex.

- HTTP **413** when the upload exceeds `BACKUP_MAX_BYTES`.
- HTTP **503** with `code: DATA_LOCK_HELD` for *other* mutating
  `/api/*` requests (jobs, runtime-config, profiles, classes,
  `/api/word`, etc.) while an export stream or restore apply holds
  the data lock. The `Retry-After` header is set to 5. Backup,
  preview, and restore endpoints are exempt — they're the operations
  the lock is protecting — so an operator can still preview an
  archive even while one is being applied or exported.

## Mutex with provider import

The restore handler shares a single-flight mutex with the provider
import queue. While a restore is in flight, the queue and any
follow-on syncs return HTTP 409. While an import is in flight, restore
returns HTTP 409 (`code: RESTORE_BUSY`).

## Sizing

`BACKUP_MAX_BYTES` defaults to 256 MiB. Reference sizes from upstream
LibreOffice/dictionaries (raw `.dic` files only — wordle-local
processed artifacts are typically 2-5x larger):

| Locale | Raw size | Notes |
| --- | --- | --- |
| `en_US.dic` | ~539 KiB | Comfortably under default cap. |
| `de_DE_frami.dic` | ~4.4 MiB | The DE thesaurus is 31 MiB each — wordle doesn't use it. |
| `tr_TR.dic` | ~1.7 MiB | Rich morphology — expanded forms can balloon. |

A typical 1-3 language deployment with the latest commit per language
fits well under 256 MiB. For multi-language deployments with several
historical commits, raise `BACKUP_MAX_BYTES`.

## Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `BACKUP_MAX_BYTES` | `268435456` (256 MiB) | Per-archive byte cap (export streaming + import upload). Clamped to `[1 MiB, 4 GiB]`. |
| `BACKUP_INCLUDE_PROVIDERS_DEFAULT` | `false` | Server-side default applied when `GET /api/admin/backup` is called without an `includeProviders` query param. The admin UI starts with the checkbox unchecked and always sends an explicit value, so this only affects scripts/`curl` callers that omit the param. |
| `BACKUP_RATE_LIMIT_WINDOW_MS` | `30000` | Rolling window for the strict backup rate limiter. |
| `BACKUP_RATE_LIMIT_MAX` | `1` | Max calls per window per admin key against the strict backup limiter. **Only `GET /api/admin/backup` and `POST /api/admin/restore` are gated by this limiter** — `POST /api/admin/backup/preview` is read-only and falls through to the standard admin-write limit. |
| `BACKUP_PROJECT_ROOT` | (server's `__dirname`) | Override for tests; should not be set in production. |

## Boot-time orphan cleanup

If a previous restore crashed mid-apply (SIGKILL, container OOM-kill,
disk full mid-write), it can leave `data/.restore-staging-*` or
`data/.restore-rollback-*` directories behind. They take real disk
space and accumulate if never cleaned up.

On boot, the server runs a two-pass check (B5 / #124):

1. **Find**: list every orphan candidate and emit a structured
   `backup-store.orphans.found` log at `warn` level.
2. **Cleanup**: delete any orphan whose mtime is older than
   `RESTORE_ORPHAN_CLEANUP_AGE_HOURS` (default 24h). Younger orphans
   are retained and emit a `backup-store.orphans.retained` log so an
   operator can inspect them before they auto-disappear.

Why a threshold rather than "delete every orphan at boot": a real
restore in flight (on another node sharing the same `data/` mount,
or in a HA pair) briefly has these dirs on disk. If we auto-deleted
unconditionally, we'd race that legitimate work. The 24h window is
both a safety margin AND an explicit inspection window for the
operator.

Tunables:

- `RESTORE_ORPHAN_CLEANUP_AGE_HOURS=24` — threshold in hours. Set to
  `0` to auto-delete every orphan at boot regardless of age (useful
  in stateless CI containers where mtime is unreliable). Set to a
  very large number (e.g. `RESTORE_ORPHAN_CLEANUP_AGE_HOURS=87600` =
  10 years) to effectively disable auto-cleanup and revert to the
  pre-B5 behavior of warn-and-retain-forever.
- `BACKUP_PROJECT_ROOT` — alternate scan root for non-default
  deployments.

Log events the operator can grep for:

- `backup-store.orphans.found` (warn) — count + names.
- `backup-store.orphans.cleaned` (info) — count + each entry's
  approximate age in hours.
- `backup-store.orphans.retained` (warn) — entries kept because
  they're younger than the threshold. Operator action: inspect
  before the next boot cycle if recovery is possible.
- `backup-store.orphans.errors` (error) — individual rm failures
  (permission, mount weirdness). Boot continues; manual cleanup
  required.

## Operator runbook: disaster recovery

Three failure shapes the system can land in. Each one has a
detection signal and a recovery path.

### 1. SIGKILL / OOM-kill mid-restore

**Symptom**: server crashes mid-apply. After restart, see
`backup-store.orphans.found` in boot logs. Live `data/` files may be
in the partially-applied state (some renamed, some not) — but the
rollback dir contains the originals.

**Detection**: boot log lines as above. The orphan staging dir name
follows `.restore-staging-<timestamp>-<random>` and the matching
rollback dir is `.restore-rollback-<timestamp>-<random>` from the
same restore. The two dirs are created by separate
`makeStagingDir()` calls so they each have an INDEPENDENT random
suffix — pair them by the closest `<timestamp>` (the same restore
creates both within milliseconds of each other), not by exact
suffix match. (Codex P2 on PR #153: a multi-orphan environment can
otherwise mis-pair across failed restores.)

**Recovery**:

1. Stop the server.
2. Inspect the rollback dir. Each in-scope file inside it is the
   ORIGINAL bytes from before the restore tried to overwrite live.
3. To **undo** the partial apply: move the rollback files back over
   the live data file(s).
4. To **complete** the apply (if you trust the restore was correct
   up to the crash): examine the staging dir and finish the
   remaining renames manually.
5. Restart the server. Verify health (see
   `docs/admin-platform-architecture-contract.md`).
6. Delete the staging/rollback dirs (or let auto-cleanup do it on
   the next boot cycle after the
   `RESTORE_ORPHAN_CLEANUP_AGE_HOURS` window elapses).

### 2. Archive corruption mid-stream

**Symptom**: `applyRestore` fails with `BackupError` codes
`SHA256_MISMATCH`, `BYTES_MISMATCH`, `MANIFEST_INCOMPLETE`, or
`MANIFEST_PARSE_FAILED` (CR Minor on PR #153 caught: the code name
in `lib/backup-store.js:540` is `MANIFEST_PARSE_FAILED`, not
`INVALID_MANIFEST_JSON`).

On-disk artifacts depend on where the failure occurred (Copilot on
PR #153 caught the previous "auto-cleaned" claim was incorrect):

- Failures BEFORE `makeStagingDir` runs (manifest schema invalid,
  schema-digest drift, etc.): no staging or rollback dirs are
  created.
- Failures AFTER staging+rollback are created (extraction, byte
  validation, mid-swap rename): BOTH dirs remain on disk for
  operator inspection. The success path (and only the success path)
  removes them — `lib/backup-store.js:1098-1110`. Use the
  SIGKILL-recovery procedure above for these.

**Detection**: the API response includes the BackupError code and
message. Log line `applyRestore.failed` at `error` level.

**Recovery**: rebuild the archive on a known-good source.
`validateArchive` checks per-entry SHA256 (recomputed from
decompressed bytes — not just zip CRC), so a corrupt entry won't
slip through; the archive must be intact on upload. If you cannot
recompute the manifest, use `scripts/restore-from-disk.js` with a
different archive.

### 3. Schema drift between archive and current server

**Symptom**: restore aborts with `BackupError("SCHEMA_DRIFT", ...)`.

**Detection**: error message names which schema's digest changed.

**Recovery**: see *Schema drift between archive and current server*
section below.

## Offline restore

If the admin UI is unreachable (e.g. a config-driven boot loop after a
failed apply), use the CLI fallback:

```bash
node scripts/restore-from-disk.js path/to/wordle-backup-XXXXX.zip
```

Stop the server before running. The script reuses
`lib/backup-store.js` so the atomicity guarantees are identical.

## Schema drift between archive and current server

If the manifest carries schema digests that don't match the live
schema files, restore aborts with `SCHEMA_DRIFT`. Migrating the
archive offline:

1. Stop the server.
2. Extract the archive.
3. Apply your project's schema-migration tool (or hand-edit) to bring
   each `data/<store>.json` up to the current schema.

4. Recompute the manifest's `files[].sha256` and the schema digests
   (or rebuild the archive via the export endpoint after applying the
   migrated state in a controlled environment).

5. Re-zip with the updated `manifest.json` at the root.
6. Run `node scripts/restore-from-disk.js <new-archive>` or upload it
   via the admin Data tab.

## PII boundary

The archive is plaintext. `data/leaderboard.json` and
`data/classes.json` contain profile names and per-game timing. Treat
backups as sensitive; encrypt at rest if you are sharing them off-host.

## Configured data paths

The backup/restore implementation reads and writes files at their
canonical paths under `<projectRoot>/data/` (e.g.
`<projectRoot>/data/leaderboard.json`). If a deployment redirects an
individual store via env (`STATS_STORE_PATH`, `CLASSES_STORE_PATH`,
`ADMIN_JOBS_STORE_PATH`, `APP_CONFIG_PATH`) the live store reads from
the configured path but backup/restore still operates on the
canonical location. Symlinks are NOT a workaround — both the backup
build and restore-time schema check call `assertRegularFile` on
in-scope paths and reject symlinks/non-regular files with
`PATH_UNSAFE`. Operators using non-default paths must either:

- Copy or hard-link the configured paths to `<projectRoot>/data/`
  before each backup so both sides see the same regular file, or

- Set `BACKUP_PROJECT_ROOT` to the directory whose `data/` subtree
  contains the configured files (test-style isolation), or

- Skip backup/restore entirely for that store and reconcile it
  manually.

A future revision can route backup through the same path-resolution
logic the stores use; tracked separately.

## What's NOT in v1

- Selective per-file restore (all-or-nothing only)
- Cross-host migration (archives are local to a single node)
- Encryption / password protection
- Continuous backups, retention policies
- Backup with non-default `STATS_STORE_PATH` /
  `CLASSES_STORE_PATH` / `ADMIN_JOBS_STORE_PATH` /
  `APP_CONFIG_PATH` (see *Configured data paths* above)

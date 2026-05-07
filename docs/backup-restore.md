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

## Boot-time orphan check

If the server starts and finds `data/.restore-staging-*` or
`data/.restore-rollback-*` directories left over from a previous run,
it logs a warning at boot but does not auto-delete. Inspect the
contents before removing — they may contain partial state from a
restore that was killed mid-apply, and rolling forward or back may
need an operator decision.

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
canonical location. Operators using non-default paths must either:

- Symlink the configured paths into `<projectRoot>/data/` so backup
  and the live store agree, or
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

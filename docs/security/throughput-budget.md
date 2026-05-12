# Throughput budget audit

Tracking issue: [#116](https://github.com/curdriceaurora/wordle-local/issues/116) (A3 — Body/multipart × rate-limit reconciliation review)

This document tabulates every body-size cap × rate-limit cap pair active on a route and identifies asymmetric pairs where worst-case ingress could exceed the operational budget. **Update this doc whenever you change `JSON_BODY_LIMIT`, `PROVIDER_MANUAL_MAX_FILE_BYTES`, `BACKUP_MAX_BYTES`, or any `RATE_LIMIT_*` env var.**

## Configured limits

### Body-size caps

| Cap | Default | Configurable via | Notes |
|---|---|---|---|
| `JSON_BODY_LIMIT` | 12 MiB | env `JSON_BODY_LIMIT` (string, e.g. `"12mb"`) | Applied globally via `app.use(express.json({ limit }))`. Sized for the admin manual-provider-upload path (~11 MiB base64). |
| `SMALL_BODY_LIMIT_BYTES` | 256 KiB | hardcoded in `server.js` | Pre-check on `/api/stats/*`, `/api/challenges/*`, `/api/push/*`, `/api/notifications/*`. Content-Length over the limit returns 413 before `express.json` parses. |
| `PROVIDER_MANUAL_MAX_FILE_BYTES` | 8 MiB | env (range 1-32 MiB) | Per-file cap inside `manualFiles[].dataBase64`. Decoded after JSON parsing. |
| `BACKUP_MAX_BYTES` | 256 MiB | env (range 1 MiB - 4 GiB) | Busboy `fileSize` cap on `POST /api/backups/restore` (multipart, not JSON). |

### Rate limits

| Tier | Default max | Default window | env vars | Mounted on |
|---|---|---|---|---|
| Global | 300 | 15 min (= 20 req/min) | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | Every request (`app.use(rateLimit(...))`) |
| Admin | 90 | 15 min (= 6 req/min) | `ADMIN_RATE_LIMIT_MAX`, `ADMIN_RATE_LIMIT_WINDOW_MS` | `/api/admin/*` (any method) |
| Admin-write | 30 | 15 min (= 2 req/min) | `ADMIN_WRITE_RATE_LIMIT_MAX`, `ADMIN_WRITE_RATE_LIMIT_WINDOW_MS` | `/api/admin/*` (non-GET/HEAD) |
| Backup | 1 | 30 s (= 2 req/min) | `BACKUP_RATE_LIMIT_MAX`, `BACKUP_RATE_LIMIT_WINDOW_MS` | `/api/backups/*`. Keyed by hashed admin-key (per-operator bucket). |

## Per-route-class throughput

Worst-case ingress per minute (per IP / per admin-key bucket where the limiter is keyed that way).

| Route class | Methods | Body cap effective | Rate × cap | Worst MiB/min |
|---|---|---|---|---|
| Public read (`/api/word`, `/api/meta`, `/api/daily`, `/api/auth/*` GET) | GET | n/a | 20/min × 0 | 0 |
| Player write — stats, challenges, push, notifications | POST/PUT/DELETE | **256 KiB** (small-body pre-check) | 20/min × 256 KiB | **5 MiB/min** |
| Other public write (anything outside the small-body allowlist) | POST | 12 MiB (`JSON_BODY_LIMIT`) | 20/min × 12 MiB | 240 MiB/min |
| Admin read | GET | n/a | 6/min × 0 | 0 |
| Admin write (config, schedule, profiles, etc.) | POST/PUT/DELETE | 12 MiB | 2/min × 12 MiB | 24 MiB/min |
| Admin provider manual upload | POST `/api/admin/providers/import` | 12 MiB JSON (base64 inside) | 2/min × 12 MiB | 24 MiB/min |
| Backup restore | POST `/api/backups/restore` | 256 MiB (multipart) | 2/min × 256 MiB | 512 MiB/min, but serialized by `dataMutationLockRef` (one in-flight) |
| Backup export | GET `/api/backups/export` | n/a (response only) | 2/min × 0 | 0 inbound |

## Asymmetric pairs

### Player write paths (mitigated)

**Was:** A POST to `/api/stats/result` could carry 12 MiB of JSON (200× over the actual payload size), giving 240 MiB/min × parse-cost CPU as a worst-case ingress per IP. The handler discards unknown fields, but the parser still has to materialize and validate the body.

**Mitigation:** Two layers in `server.js`:

1. **Content-Length pre-check** for fast-fail 413 on honest clients that declare an oversized payload. Skips JSON parsing entirely.
2. **Per-prefix `express.json({ limit: 256 KiB })`** mounted on each prefix BEFORE the global `express.json({ limit: JSON_BODY_LIMIT })`. This is the load-bearing defense — chunked-transfer requests that omit `Content-Length` bypass layer 1, but the per-prefix parser still counts bytes during streaming and throws `entity.too.large` (Codex P2 on PR #146 caught the chunked bypass; the layered approach closes it).

Player API paths now reject oversized payloads with 413 regardless of whether the client uses `Content-Length` or `Transfer-Encoding: chunked`, dropping the worst case from 240 MiB/min to ~5 MiB/min.

**Audit:** If a future endpoint legitimately needs a larger payload, add its path prefix to the allowlist via a separate exception (or move it out of the `SMALL_BODY_PATH_PREFIXES` covered set). Don't drop the 256 KiB cap for everyone.

### Backup restore (accepted)

**Pattern:** 256 MiB × 2 req/min = 512 MiB/min worst-case ingress. The limit is per-admin-key (hashed) so two operators don't share a bucket.

**Why accepted:** Three concentric gates limit real-world abuse:

1. **Admin key required** — `requireAdmin` middleware runs before backup routes; without the key the request is rejected at 401 before busboy spins up.
2. **`dataMutationLockRef` is held during apply** — only one restore can be in flight; concurrent restore attempts queue/fail.
3. **Operational class** — the endpoint is designed for occasional disaster recovery, not steady-state traffic. Operators running concurrent restores under load are misusing the deployment.

If an operator-level abuse becomes a concern, the right knob is `BACKUP_RATE_LIMIT_MAX` (per-admin-key) rather than reducing `BACKUP_MAX_BYTES` (which has a legitimate upper bound for full-archive restores).

### Other public write paths (acceptable)

The "Other public write" row in the throughput table covers any future POST endpoint that isn't in the small-body allowlist. Worst case at default settings: 240 MiB/min × parse-cost. No such endpoint exists today; if one is added, the reviewer should categorize it (small-body or admin) and update both the allowlist and this doc.

## Workflow

When changing any of:

- `JSON_BODY_LIMIT`, `SMALL_BODY_LIMIT_BYTES`, or `SMALL_BODY_PATH_PREFIXES` in `server.js`
- `RATE_LIMIT_*`, `ADMIN_RATE_LIMIT_*`, `ADMIN_WRITE_RATE_LIMIT_*`, `BACKUP_RATE_LIMIT_*` env vars
- `BACKUP_MAX_BYTES`, `PROVIDER_MANUAL_MAX_FILE_BYTES`

…re-tabulate the affected row(s) in this doc and confirm the worst-MiB/min column stays consistent with the operational budget. Reviewers should treat ratio changes as security decisions.

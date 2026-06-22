# Advanced Settings

Use these settings if you want admin controls or are hosting behind a VPN/proxy. Otherwise, you can ignore this file.

> **Note on hosting paths.** Most settings on this page only apply when you run the full Node/Docker server. The gameplay-only [Vercel deploy path](../README.md#deploy-to-vercel-gameplay-only) ignores admin auth, rate-limit env vars, definitions mode, performance logging, and most of the Server block — it ships a fixed-config serverless function. Run the full server for anything beyond Create-a-puzzle gameplay.

## Admin Auth

Set `ADMIN_KEY` to protect admin endpoints. When set, include `x-admin-key: <value>` on admin requests.

- Admin shell is available at `/admin` and uses a session-scoped unlock key in the browser.

- `ADMIN_KEY` — secret key required for admin endpoints.
- `REQUIRE_ADMIN_KEY` — set to `true` to force admin auth (default `true` in production).
- Pitfall: keep `ADMIN_KEY` long and random; short keys are easier to brute-force even with rate limiting.
- Current admin API endpoints:
  - `GET /api/word`
  - `POST /api/word`
  - `PATCH /api/admin/stats/profile/:id`
  - `GET /api/admin/runtime-config`
  - `PUT /api/admin/runtime-config`
  - `GET /api/admin/jobs`
  - `GET /api/admin/jobs/:id`
  - `GET /api/admin/providers`
  - `POST /api/admin/providers/import`
  - `POST /api/admin/providers/:variant/check-update`
  - `POST /api/admin/providers/:variant/enable`
  - `POST /api/admin/providers/:variant/disable`
- Import request body example:
  - Remote fetch: `{"async":true,"sourceType":"remote-fetch","variant":"en-US","commit":"<40-char-sha>","filterMode":"denylist-only","expectedChecksums":{"dic":"<sha256>","aff":"<sha256>"}}`
  - Manual upload fallback: `{"async":true,"sourceType":"manual-upload","variant":"en-US","commit":"<optional-40-char-sha>","filterMode":"denylist-only","expectedChecksums":{"dic":"<sha256>","aff":"<sha256>"},"manualFiles":{"dicBase64":"<base64>","affBase64":"<base64>","dicFileName":"en_US.dic","affFileName":"en_US.aff"}}`
    - `async=true` queues imports and returns a job ID for progress polling.
    - `async=false` preserves direct synchronous import behavior for legacy tooling.
    - If `commit` is omitted for manual uploads, the server derives a deterministic synthetic commit from file checksums.
    - `dicFileName`/`affFileName` are optional metadata and must be safe filenames (`[A-Za-z0-9._-]`) with `.dic` / `.aff` extensions.
- Manual update-check outcomes:
  - `up-to-date` (installed commit matches latest upstream)
  - `update-available` (newer upstream commit found)
  - `unknown` (no installed commit selected for comparison)
  - `error` (upstream check failed; no dictionary changes are applied automatically)

## Network/Proxy

- `TRUST_PROXY` — set to `true` if running behind a reverse proxy or Tailscale (default `true` in production).
- `TRUST_PROXY_HOPS` — number of trusted proxy hops when `TRUST_PROXY=true` (default `1`).

## Rate Limiting

- `RATE_LIMIT_MAX` — default 300 requests per 15 minutes.
- `RATE_LIMIT_WINDOW_MS` — default 900000.
- `ADMIN_RATE_LIMIT_MAX` — default 90 admin requests per window (`/api/admin/*`).
- `ADMIN_RATE_LIMIT_WINDOW_MS` — default mirrors `RATE_LIMIT_WINDOW_MS`.
- `ADMIN_WRITE_RATE_LIMIT_MAX` — default 30 admin write requests per window (`POST`/`PATCH`/`PUT`/`DELETE` under `/api/admin/*`).
- `ADMIN_WRITE_RATE_LIMIT_WINDOW_MS` — default mirrors `ADMIN_RATE_LIMIT_WINDOW_MS`.

## Definitions Memory Mode

- `DEFINITIONS_MODE` — `memory` (eager full-map load), `lazy` (load full-map on first reveal), or `indexed` (load per-letter shards from `data/dictionaries/en-definitions-index`).
- `LOW_MEMORY_DEFINITIONS` — legacy toggle; if `true` and `DEFINITIONS_MODE` is unset, defaults to `indexed`.
- `DEFINITION_CACHE_SIZE` — max in-process LRU entries for definition lookups (default `512`).
- `DEFINITION_CACHE_TTL_MS` — cache TTL in milliseconds (default `1800000` / 30 minutes).
- `DEFINITION_SHARD_CACHE_SIZE` — max loaded shard maps in `indexed` mode (default `6`).
- Pitfall: if `DEFINITIONS_MODE=indexed` but index artifacts are missing or invalid, server falls back to lazy full-map loading.

## Performance Logging

- `PERF_LOGGING` — set to `true` to log server/client timing traces for local benchmarking.

## Server

- `PORT` — default 3000.
- `HOST` — default 0.0.0.0.
- `NODE_ENV` — `development` or `production`.
- `WORDLE_DATA_DIR` — Docker Compose host path mounted at `/app/data`
  (default `./data`). Point this at the mounted plaintext view of an
  encrypted filesystem for encryption at rest; see
  [the encryption runbook](security/data-encryption-at-rest.md).
- `JSON_BODY_LIMIT` — max JSON payload size for API requests (default `12mb`).
- `PROVIDER_MANUAL_MAX_FILE_BYTES` — max bytes per manual upload file (default `8388608` / 8 MiB).
- `APP_CONFIG_PATH` — optional override path for persisted runtime overrides (`data/app-config.json` by default).
- `ADMIN_JOBS_STORE_PATH` — optional override path for persisted admin queue jobs (`data/admin-jobs.json` by default).
- Language registry file: `data/languages.json` (auto-recovers to baked defaults if missing/invalid).

## Vercel (gameplay-only deploy)

The repo includes `vercel.json` and `api/[...path].js`. Importing the repo into Vercel gets you a public gameplay-only preview with zero config.

- No env vars are read by the serverless function. `ADMIN_KEY`, `REQUIRE_ADMIN_KEY`, `TRUST_PROXY`, the rate-limit envs, `DEFINITIONS_MODE`, `PERF_LOGGING`, and the `*_PATH` overrides on this page have no effect there — the function uses hard-coded defaults (rate limit at 300 req / 15 min per IP **per warm instance**, definitions off, trust 1 proxy hop). The rate limit is best-effort, not durable: `express-rate-limit`'s default in-memory store resets on every cold start and is not shared across concurrent serverless instances or regions, so the effective ceiling under load can be several multiples of 300/15min. Treat it as a courtesy throttle, not a security control.
- The bundle ships only `data/dictionaries/en.txt`. `en-definitions.json` and the runtime state JSONs are excluded by `.vercelignore`.
- Only English is exposed (the front-end auto-hides the language dropdown when `/api/meta` reports a single language).
- Stateful endpoints (`/api/word`, `/api/stats/*`, `/api/challenges/*`, `/api/admin/*`, `/api/notifications/*`, `/api/backup`, `/api/restore`) return `404 {"code": "STATIC_DEPLOY_ENDPOINT_MISSING"}`.
- See [README — Deploy to Vercel](../README.md#deploy-to-vercel-gameplay-only) for the full scope of what works.

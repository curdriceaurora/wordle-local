# Advanced Settings

Use these settings if you want admin controls or are hosting behind a VPN/proxy. Otherwise, you can ignore this file.

## Admin Auth
Set `ADMIN_KEY` to protect admin endpoints. When set, include `x-admin-key: <value>` on admin requests.
- Admin shell is available at `/admin` and uses a session-scoped unlock key in the browser.

- `ADMIN_KEY` — secret key required for admin endpoints.
- `REQUIRE_ADMIN_KEY` — set to `true` to force admin auth (default `true` in production).
- Current admin API endpoints:
  - `GET /api/word`
  - `POST /api/word`
  - `PATCH /api/admin/stats/profile/:id`
  - `GET /api/admin/providers`
  - `POST /api/admin/providers/import`
  - `POST /api/admin/providers/:variant/check-update`
  - `POST /api/admin/providers/:variant/enable`
  - `POST /api/admin/providers/:variant/disable`
- Import request body example:
  - `{"variant":"en-US","commit":"<40-char-sha>","filterMode":"denylist-only","expectedChecksums":{"dic":"<sha256>","aff":"<sha256>"}}`
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
- Language registry file: `data/languages.json` (auto-recovers to baked defaults if missing/invalid).

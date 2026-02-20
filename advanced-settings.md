# Advanced Settings

Use these settings if you want admin controls or are hosting behind a VPN/proxy. Otherwise, you can ignore this file.

## Admin Auth
Set `ADMIN_KEY` to protect admin endpoints. When set, include `x-admin-key: <value>` on admin requests.

- `ADMIN_KEY` — secret key required for admin endpoints.
- `REQUIRE_ADMIN_KEY` — set to `true` to force admin auth (default `true` in production).

## Network/Proxy
- `TRUST_PROXY` — set to `true` if running behind a reverse proxy or Tailscale (default `true` in production).

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

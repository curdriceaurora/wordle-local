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
- `LOW_MEMORY_DEFINITIONS` — set to `true` to reduce baseline RAM by avoiding eager in-memory loading of all definitions.
- `DEFINITION_CACHE_SIZE` — max in-process LRU entries when `LOW_MEMORY_DEFINITIONS=true` (default `512`).

## Server
- `PORT` — default 3000.
- `HOST` — default 0.0.0.0.
- `NODE_ENV` — `development` or `production`.

# Admin Security Checklist

Use this checklist for any release that touches `/api/admin/*`, provider imports, or admin UI behavior.

## Why this exists
- Admin endpoints can trigger file writes, upstream fetches, and runtime language changes.
- A small misconfiguration (weak key, missing proxy trust, too-permissive limits) can turn routine admin actions into an abuse path.
- This checklist keeps admin controls usable for family-hosted setups while failing closed on risky inputs.

## Required controls
1. Auth gate:
- `ADMIN_KEY` is set in non-dev deployments.
- `REQUIRE_ADMIN_KEY=true` for production deployments.
- Admin requests without `x-admin-key` return `401`.

2. Rate limits:
- Global API limiter is enabled (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`).
- Admin route limiter is enabled (`ADMIN_RATE_LIMIT_MAX`, `ADMIN_RATE_LIMIT_WINDOW_MS`).
- Admin write limiter is enabled (`ADMIN_WRITE_RATE_LIMIT_MAX`, `ADMIN_WRITE_RATE_LIMIT_WINDOW_MS`).

3. Upload/path hardening:
- Manual upload requires checksums for `.dic` and `.aff`.
- Manual upload enforces per-file byte cap (`PROVIDER_MANUAL_MAX_FILE_BYTES`).
- Manual upload metadata filenames are safe and extension-checked (`.dic`, `.aff`).
- Provider artifact paths are safe relative paths without traversal.

4. Failure isolation:
- Provider pipeline errors return sanitized client messages (no filesystem paths/secrets).
- Non-validation provider failures return service-unavailable responses.
- Import mutex behavior is validated (`409` when another import is in flight).

## Operational verification
1. Run `npm run check`.
2. Run `npm run test:provider:ui` if admin/provider UI changed.
3. Verify docs parity:
- `/Users/rahul/Projects/Noventa/wordle-local/README.md`
- `/Users/rahul/Projects/Noventa/wordle-local/advanced-settings.md`
4. Confirm deployment config includes:
- `ADMIN_KEY`
- `TRUST_PROXY` and `TRUST_PROXY_HOPS` appropriate for topology
- explicit admin rate-limit overrides only when justified

## Common pitfalls
- Leaving `ADMIN_KEY` empty in production and assuming admin endpoints are still protected.
- Treating encoded share links as secrets (they are convenience encoding only).
- Raising `JSON_BODY_LIMIT` without reviewing upload limits and rate limits together.
- Running behind proxy/VPN without `TRUST_PROXY=true`, causing poor IP attribution for rate limiting.

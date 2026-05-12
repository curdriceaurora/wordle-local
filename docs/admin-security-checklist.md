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

5. Secret-handling (enforced by `npm run secrets:check`):

   - Every security-sensitive token/key comparison uses `crypto.timingSafeEqual` after an explicit length pre-check (rule 27 in `docs/review-preflight.md`). `lib/admin-auth.js`'s `timingSafeEqualString` is the canonical helper.
   - `===` / `!==` against a secret-flavored value (`process.env.*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`, `VAPID_PRIVATE_*`; or any identifier / member access ending in `secret`, `token`, `adminKey`, `apiKey`, `vapidPrivateKey`, etc.) is mechanically rejected by `scripts/check-secret-handling.js` unless the RHS is a categorically-safe shape (boolean / number / null / `""` / `typeof` enum match / `.length` pre-check).
   - Log call sites never splat a secret-bearing object: `console.log(req)`, `console.warn(req.headers)`, `console.error(process.env)`, `console.log({...process.env})`, and analogues are mechanically rejected. Log specific fields (`req.method`, `req.path`, `req.headers['user-agent']`) — never the whole object.
   - If a rare case genuinely needs an exception, add a substring-signature entry to `ALLOWLIST_SITES` (or, for a whole file, to `ALLOWLIST_FILES`) in `scripts/check-secret-handling.js` with a written rationale. Reviewers should treat allowlist additions as security decisions.

## Operational verification

1. Run `npm run check`.
2. Run `npm run test:provider:ui` if admin/provider UI changed.
3. Verify docs parity:

   - `README.md`
   - `docs/advanced-settings.md`

4. Confirm deployment config includes:

   - `ADMIN_KEY`
   - `TRUST_PROXY` and `TRUST_PROXY_HOPS` appropriate for topology
   - explicit admin rate-limit overrides only when justified

## Common pitfalls

- Leaving `ADMIN_KEY` empty in production and assuming admin endpoints are still protected.
- Treating encoded share links as secrets (they are convenience encoding only).
- Raising `JSON_BODY_LIMIT` without reviewing upload limits and rate limits together. See [`docs/security/throughput-budget.md`](security/throughput-budget.md) for the tabulated body × rate-limit pairs and the small-body pre-check that gates player API paths separately from the global cap.
- Running behind proxy/VPN without `TRUST_PROXY=true`, causing poor IP attribution for rate limiting.

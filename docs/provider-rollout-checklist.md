# Provider Rollout Checklist

Use this checklist for releases that touch LibreOffice provider sourcing, provider-admin workflows, or provider-backed language activation.

## Why this gate exists
Provider imports add an external-source trust boundary and an admin-controlled activation path. We gate these changes separately so provider failures never degrade baked English gameplay.

## Automated gates (required)
1. Run `npm run check`.
2. Run `npm run test:provider:ui` to validate `/admin` provider workflows in Chromium.
3. Confirm PR CI executed `Run Provider Workflow UI Regression Gate` when provider/admin files changed.

## Provenance and integrity checks (required)
1. Confirm import payload requires:
   - pinned 40-char commit SHA
   - `expectedChecksums.dic`
   - `expectedChecksums.aff`
2. Confirm imported commit folder includes:
   - `source-manifest.json`
   - `expanded-forms.txt`
   - `guess-pool.txt`
   - `answer-pool.txt`
   - `answer-pool-active.txt`
3. Confirm provider status API reports deterministic commit ordering and diagnostics for incomplete commit folders.

## Security checks (required)
1. Confirm `/api/admin/providers*` endpoints require `x-admin-key` when admin key enforcement is enabled.
2. Confirm provider variant is allowlisted (`en-GB`, `en-US`, `en-CA`, `en-AU`, `en-ZA`) and path joins are traversal-safe.
3. Confirm imports fail closed on checksum mismatch or missing checksum fields.
4. Confirm admin UI shows actionable diagnostics for provider warning/error states.

## Fallback and resilience checks (required)
1. Confirm provider import failure does not remove baked `en` from `/api/meta`.
2. Confirm `enable` fails with clear `404` when import artifacts are missing for the selected variant/commit.
3. Confirm variants with valid imports but incomplete stale commit folders are reported as usable with warnings, not hard errors.
4. Confirm provider disable returns variant to non-active state without breaking daily/create/play flows.

## Manual API spot-check examples
Use these commands against a local server. Replace `ADMIN_KEY_VALUE` with the configured admin key.

```bash
curl -sS http://localhost:3000/api/admin/providers \
  -H 'x-admin-key: ADMIN_KEY_VALUE'
```

```bash
curl -sS -X POST http://localhost:3000/api/admin/providers/import \
  -H 'content-type: application/json' \
  -H 'x-admin-key: ADMIN_KEY_VALUE' \
  -d '{
    "variant":"en-US",
    "commit":"0123456789abcdef0123456789abcdef01234567",
    "filterMode":"denylist-only",
    "expectedChecksums":{
      "dic":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "aff":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  }'
```

## Common pitfalls
1. `status` + `error` coupling drift: `error` must only be present for `status="error"`; usable variants should use `warning`.
2. Incomplete diagnostics hidden in UI: status text alone is not sufficient for operator troubleshooting.
3. Provider gate skipped in CI: verify path filters include all provider/admin workflow files when changing workflow config.

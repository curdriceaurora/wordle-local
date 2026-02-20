# Release Checklist

Use this checklist before tagging or publishing a release.

## Build and quality gates
1. Run `npm run check`.
2. Run `npm run test:all`.
3. Confirm CI is green on the release PR branch.

## Security and runtime baseline
1. Confirm `.env.example`, `README.md`, and `advanced-settings.md` are consistent.
2. Confirm Docker image includes `LICENSE` and `THIRD_PARTY_NOTICES.md`.
3. Confirm rate-limit/proxy guidance is documented for deployment topology (`TRUST_PROXY` behavior).

## Leaderboard rollout gate
1. Review `docs/server-leaderboard-rollout.md`.
2. Confirm the release notes explicitly call out:
   - server-backed stats storage in `data/leaderboard.json`
   - no migration/import from legacy browser `localStorage` stats
   - expected cross-device shared leaderboard behavior
3. Confirm contract expectations still match implementation:
   - `docs/leaderboard-data-contract.md`

## Documentation gate
1. Ensure `README.md` reflects current shipped behavior (not roadmap assumptions).
2. Ensure roadmap items are exploratory only and do not duplicate already shipped features.
3. Ensure any operational gotchas discovered in PR review are captured in docs.

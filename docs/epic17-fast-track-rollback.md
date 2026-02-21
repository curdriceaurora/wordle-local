# Epic #17 Fast-Track Rollback Runbook

## Scope
This runbook covers the parallel rollout stream for:
- `#10` admin auth/guard primitives
- `#21` Hunspell expansion pipeline
- `#8` language registry primitives

Rollback posture is per-PR revert, not branch-wide reset.

## Why this model
- Keeps blast radius small when streams merge independently.
- Avoids reverting unrelated work from parallel tracks.
- Matches the current GitHub-first PR workflow.

## Rollback triggers
Rollback a merged PR if any of these occur:
1. Server startup regression.
2. Admin auth regressions (`401` behavior mismatch, false allow/deny).
3. `/api/meta` language output drift outside approved scope.
4. Provider artifact write/read regressions tied to the merged change.

## Standard rollback procedure
1. Identify offending PR merge commit on `main`.
2. Revert that merge commit only:
```bash
git checkout main
git pull --ff-only
git revert <merge_commit_sha>
git push
```
3. Validate rollback:
```bash
npm run check
```
4. Smoke-test critical endpoints:
- `GET /api/meta`
- `GET /api/word`
- `POST /api/word`
- `PATCH /api/admin/stats/profile/:id`

## Data and artifact notes
### `#10` rollback
- Code-only rollback. No data migration needed.

### `#21` rollback
- Reverted code stops consuming/generated Hunspell artifacts.
- Existing files under `data/providers/<variant>/<commit>/` are inert after revert.

### `#8` rollback
- `data/languages.json` may remain on disk.
- Reverted server path ignores registry primitives and continues with baked language defaults.

## Hard-failure contingency
If revert does not restore service quickly:
1. Deploy last known-good commit from `main`.
2. Open hotfix issue with root cause and corrective actions.
3. Add a prevention rule update to `docs/review-preflight.md`.

## Operational guardrails
1. Keep PRs single-issue and isolated (`#10`, `#21`, `#8`).
2. Require green `npm run check` locally before push.
3. Merge only with zero actionable Copilot/human review threads.
4. Re-run smoke checks immediately after each merge.

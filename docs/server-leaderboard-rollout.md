# Server-Backed Leaderboard Rollout

## Why this changed
- Browser-local stats created split leaderboards across phones/laptops.
- Family usage expects one shared leaderboard from a single local host.
- Server persistence now provides one canonical source of truth for daily profiles and results.

## What changed
- Source of truth moved to `data/leaderboard.json`.
- Daily profile/leaderboard API paths are now server-backed:
  - `POST /api/stats/profile`
  - `POST /api/stats/result`
  - `GET /api/stats/leaderboard`
  - `GET /api/stats/profile/:id`
- Daily gameplay endpoints (`/api/puzzle`, `/api/guess`, `/daily`) remain unchanged.

## Big-bang cutover implications
- There is no migration/import from historical browser `localStorage` stats.
- Existing users start with a fresh server-backed leaderboard file.
- Devices that previously had separate local stats now converge on shared server results.

## Known behavior changes and pitfalls
- Clearing browser storage no longer deletes shared leaderboard data.
- Clearing browser storage can remove local UI state (for example, active profile selection).
- Joining by existing display name remains allowed (honor system by design).
- If stats storage is unavailable, gameplay still works and stats panels degrade gracefully.

## Operator checklist for upgrade
1. Back up current app data (`data/word.json`, dictionaries, and existing `data/leaderboard.json` if present).
2. Deploy the new build.
3. Verify `GET /api/health` returns `ok`.
4. Open `/daily`, create/select a profile, complete a game, and confirm leaderboard updates.
5. Validate cross-device behavior by loading `/daily` from a second device and confirming shared results.

## Rollback guidance
- Restore prior app version and restore backed up `data/` files.
- If rollback crosses schema/behavior changes, validate `/daily` flow before family usage.

## Related docs
- Contract and schema details: `docs/leaderboard-data-contract.md`
- Release gate checklist: `docs/release-checklist.md`

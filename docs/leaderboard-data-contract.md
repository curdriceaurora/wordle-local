# Leaderboard Data Contract (Issue #30)

## Purpose
This contract defines the canonical server-side persistence shape for shared daily profile and leaderboard data.

Why this exists:
- Browser localStorage splits leaderboard history per device.
- Multi-device family play needs one shared, durable source of truth.
- Later issues (#31-#37) need stable schema and merge rules to avoid drift.

## Storage Location
- File: `data/leaderboard.json`
- Write strategy: atomic replace (`.tmp` + rename)
- Runtime model: in-memory cache loaded from this file, then persisted on mutation

## Top-Level Schema
```json
{
  "version": 1,
  "updatedAt": "2026-02-20T00:00:00.000Z",
  "profiles": [
    {
      "id": "ava",
      "name": "Ava",
      "createdAt": "2026-02-20T00:00:00.000Z",
      "updatedAt": "2026-02-20T00:00:00.000Z"
    }
  ],
  "resultsByProfile": {
    "ava": {
      "2026-02-20|en|fotnd": {
        "date": "2026-02-20",
        "won": true,
        "attempts": 3,
        "maxGuesses": 6,
        "submissionCount": 2,
        "updatedAt": "2026-02-20T00:00:00.000Z"
      }
    }
  }
}
```

## Field Rules
### `version`
- Integer.
- Initial value: `1`.
- Bumped only for breaking schema changes.

### `updatedAt`
- ISO-8601 timestamp for last persisted mutation.

### `profiles[]`
- Max retained profiles: `20`.
- Ordered by `createdAt` ascending for deterministic pruning behavior.
- Fields:
  - `id`: server-generated stable identifier.
  - `name`: normalized display name (`A-Za-z`, spaces, apostrophes, hyphens; max 24 chars).
  - `createdAt`, `updatedAt`: ISO-8601 timestamps.

### `resultsByProfile`
- Map keyed by `profile.id`.
- Each profile map keyed by `dailyKey` format: `YYYY-MM-DD|<lang>|<code>`.
- Max retained daily entries per profile: `400`.

### Result Entry
- `date`: `YYYY-MM-DD` in server-local calendar.
- `won`: boolean.
- `attempts`: positive integer when solved; nullable when unsolved.
- `maxGuesses`: positive integer guess limit used when result was submitted.
- `submissionCount`: positive integer; increments every submission for same `dailyKey`.
- `updatedAt`: ISO-8601 timestamp.

## Replay Merge Policy (Canonical)
For multiple submissions on the same `dailyKey` by same profile:
1. Increment `submissionCount` on every accepted submission.
2. Keep exactly one canonical scored entry.
3. Prefer `won=true` over `won=false`.
4. If both are wins, keep the lower `attempts`.
5. Preserve the latest `updatedAt`.

Why this policy:
- Keeps leaderboard scoring fair and stable.
- Captures repeated play behavior without inflating scored totals.

## Normalization and Recovery
On load:
1. If file missing, initialize empty valid structure.
2. If file is malformed, reset to empty valid structure and log warning.
3. Drop profile rows with invalid IDs or invalid names.
4. Drop results with invalid dates or invalid numeric fields.
5. Remove `resultsByProfile` keys that do not exist in `profiles`.
6. Enforce retention limits after normalization.

## Retention/Pruning
### Profiles
- If profiles exceed `20`, retain newest `20` by `createdAt` and remove pruned profile result maps.

### Daily Results
- If a profile has more than `400` result entries:
  - sort by `date` ascending, then `updatedAt` ascending,
  - prune oldest until `400` remain.

## API Contract Dependencies
This schema supports planned API behavior in #32 and #33:
- `POST /api/stats/profile`
- `POST /api/stats/result`
- `GET /api/stats/leaderboard`
- `GET /api/stats/profile/:id`
- `PATCH /api/admin/stats/profile/:id`

## Non-Goals (for this contract)
- Ownership/authentication enforcement beyond honor-system naming.
- Importing legacy localStorage stats.
- Device-level identity binding.

## Gotchas
- Name collisions are intentionally allowed to resolve to existing profile.
- Server-local date is authoritative; client timezone is informational only.
- JSON storage is enough for family/local scale; move to SQLite only if write contention or query complexity grows.

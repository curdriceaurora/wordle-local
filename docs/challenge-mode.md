# Timed challenge mode

Multi-puzzle, time-budgeted gameplay that coexists with the daily mode.
Server-authoritative timing and word selection prevent client-side
cheating; scoring is deterministic and replayable.

## Player flow

1. Player navigates to **Challenges** in the header (or the
   `/challenges` URL).
2. Picks a profile name (stored in `localStorage`) and clicks **Start**
   on a challenge.
3. The server builds the puzzle set (all words chosen server-side, never
   sent to the client until each puzzle is solved or runs out of
   guesses) and returns a `sessionId` plus the first puzzle's *length*.
4. Player guesses one puzzle at a time. Each guess returns
   per-letter feedback and, on solve/exhaust, advances to the next
   puzzle.
5. Session ends when all puzzles are solved/exhausted, when the time
   budget runs out (server-authoritative), or when the player clicks
   **Quit**.
6. Score = `sum(perPuzzleScore for solved puzzles) + max(0, timeBudgetSeconds - elapsedSeconds) * speedBonusFactor`,
   floored to integer.

## Admin flow

The admin **Challenges** tab supports:

- **Create / edit** challenge configs. Once any session has been
  recorded against a challenge, scoring/timing/replay parameters are
  frozen — the operator must soft-delete and create a new challenge.
  This keeps the leaderboard from comparing different formulas.
- **Soft-delete** preserves historical leaderboard data.
- **Per-challenge leaderboard** view.

## Locked design decisions

| Topic | Behavior |
| --- | --- |
| **Word selection** | Server-side per puzzle within a session. The session payload exposes `length` for each puzzle but never `word` until the puzzle is solved or guesses are exhausted. |
| **Timer authority** | `now > startedAt + timeBudgetSeconds` triggers `timed-out` on the next request. Client clock is never trusted for end-of-session decisions. |
| **Single in-flight session** | Starting a new session while an in-progress one exists for the same `(challengeId, profileId)` returns the existing session as a resume (HTTP 200 with `resumed: true`), not 409. |
| **Replay policy** | `best` (default), `first-only`, `unlimited`. Affects leaderboard projection: best collapses to one row per profile (highest score wins); first-only takes the earliest attempt only; unlimited shows every session. |
| **Restart recovery** | At boot, any `in-progress` session whose `startedAt + timeBudgetSeconds` has passed is settled to `timed-out` with a final score. Sessions still within budget remain active and continue from their persisted state. |
| **Config-locked-on-results** | A challenge with at least one session in `data/challenge-results.json` cannot be edited via PUT — the admin endpoint returns `409 CONFIG_LOCKED`. |

## Scoring formula

```text
score = sum(perPuzzleScore for each solved puzzle)
      + max(0, timeBudgetSeconds - elapsedSeconds) * speedBonusFactor
```

- `perPuzzleScore` is operator-set per challenge (default 1000, range 0–10000).
- `speedBonusFactor` is operator-set (default 0.5, range 0–100). Setting it to 0 disables the speed bonus.
- `elapsedSeconds` is clamped to `timeBudgetSeconds` so going over budget never produces a negative bonus.
- The result is floored to an integer.

## Anti-cheat

- Words for unsolved puzzles are NEVER in the network response. The
  player gets `length` (so the keyboard knows how many tiles to draw)
  but no answer text.
- Timeouts settle on the server's `Date.now()` against the persisted
  `startedAt`; tab-backgrounding on the client can't pause the budget.
- Wrong-length guesses are rejected without consuming a try.
- Non-dictionary guesses are rejected (when the answer dictionary for
  the language is loaded).

## Storage

| File | Schema | Purpose |
| --- | --- | --- |
| `data/challenges.json` | `data/challenges.schema.json` | Challenge configs (names, timing, scoring, replay policy, soft-delete flag). |
| `data/challenge-results.json` | `data/challenge-results.schema.json` | Per-attempt sessions (status, puzzles, guesses, score). |

Both files are part of the standard backup/restore set.

## Player API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/challenges` | Active challenges (excludes soft-deleted, applies `startTime`/`endTime` window). |
| POST | `/api/challenges/:id/start` | Body: `{profileId, profileName?}`. Returns the projected session (lengths only, no answers). Resumes an in-flight session if one exists. |
| GET | `/api/challenges/:id/sessions/:sessionId` | Current state. Settles `timed-out` on read. |
| POST | `/api/challenges/:id/sessions/:sessionId/guess` | Body: `{guess}`. Per-letter feedback in response. Auto-completes session when all puzzles solved/exhausted. |
| POST | `/api/challenges/:id/sessions/:sessionId/finish` | Idempotent. Marks session `abandoned` (or `completed` if all puzzles already done). |
| GET | `/api/challenges/:id/leaderboard` | Per-challenge leaderboard rows projected from completed sessions. |

## Admin API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/challenges` | All challenges (including soft-deleted) with per-row `sessionCount`. |
| POST | `/api/admin/challenges` | Create. Subject to `CHALLENGE_MAX_TIME_BUDGET_S` / `CHALLENGE_MAX_PUZZLES` env caps. |
| PUT | `/api/admin/challenges/:id` | Update. 409 `CONFIG_LOCKED` if any sessions exist. |
| DELETE | `/api/admin/challenges/:id` | Soft-delete (sets `deleted: true`, preserves data). |
| GET | `/api/admin/challenges/:id/leaderboard` | Same projection as the player endpoint. |

All write endpoints are wrapped in `withSlot` (data-mutation slot) and
log audit entries.

## Environment variables

| Var | Default | Range | Purpose |
| --- | --- | --- | --- |
| `CHALLENGE_MODE_ENABLED` | `true` | bool | Master switch. When false, all challenge endpoints return 404 `CHALLENGE_MODE_DISABLED`. |
| `CHALLENGE_MAX_TIME_BUDGET_S` | `1800` | 30–7200 | Operator-soft cap on `timeBudgetSeconds`. Schema hard cap is 7200. |
| `CHALLENGE_MAX_PUZZLES` | `20` | 1–50 | Operator-soft cap on `puzzleCount`. Schema hard cap is 50. |
| `CHALLENGE_STORE_PATH` | `data/challenges.json` | path | Override the config store location (tests/alt storage). |
| `CHALLENGE_RESULTS_STORE_PATH` | `data/challenge-results.json` | path | Override the results store location. |

## Test coverage

- Unit: `tests/challenge-engine.test.js` — `computeScore` (sum + bonus + clamp + floor), `projectSessionForPlayer` (anti-cheat: hidden words for unsolved puzzles), `buildLeaderboard` (best / first-only / unlimited policy), replay-policy gate.
- Unit: `tests/challenge-config-store.test.js` — schema validation rejects malformed configs, `softDelete` filters from `listActive`, `update` honors `hasResults` lock, window filters.
- Integration: `tests/challenge-routes.test.js` — admin CRUD round-trip, player start/resume, guess validation (length, dictionary), finish idempotency, server-authoritative timeout (mutates `startedAt` to past on disk and verifies `GET` settles to `timed-out`).

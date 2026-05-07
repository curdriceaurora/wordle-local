# Classroom Mode

Operator-facing overview for the Classes admin tab.

## What a class is

A *class* is a named container of profile IDs. Profiles continue to live in
`data/leaderboard.json` via `LeaderboardStore`; classes live in
`data/classes.json` via `ClassesStore` and reference profiles by ID.

A profile may belong to zero, one, or many classes simultaneously. Two
profiles cannot share a name (case-insensitive) — bulk-add will reuse an
existing profile when the trimmed/lowercased name matches.

## Persistence

- `data/classes.json` (schema: `data/classes.schema.json`)
- Atomic writes via temp-file + rename, mirroring `lib/leaderboard-store.js`.
- Recovery on missing/malformed JSON: warn and reset to empty state, just like
  the leaderboard store.
- Default cap: 200 classes per host, 1000 members per class.

## Admin endpoints (admin-key gated)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/classes?includeArchived=true\|false` | List classes with member counts |
| `POST` | `/api/admin/classes` | Create class — `{ name }` |
| `GET` | `/api/admin/classes/:id` | Class detail with members hydrated from leaderboard |
| `PATCH` | `/api/admin/classes/:id` | Rename and/or archive — `{ name?, archived? }` |
| `DELETE` | `/api/admin/classes/:id` | Delete — `{ confirmed: true, deleteProfiles?: bool }` |
| `POST` | `/api/admin/classes/:id/members/bulk` | Bulk add — `{ names: string[] }` or `{ csv: string }` |
| `DELETE` | `/api/admin/classes/:id/members/:profileId` | Remove a member from this class only |
| `GET` | `/api/admin/classes/:id/report` | Participation report — query: `lang`, `from`, `to`, `format=json\|csv`, `bom=true\|false` |

## Bulk-add formats

The bulk endpoint accepts either:

- `{ "names": ["Alice", "Bob"] }` — explicit array.
- `{ "csv": "Alice\r\nBob\r\n\"O'Hara\"\r\n" }` — single-column CSV (RFC 4180:
  CRLF line endings, double-quoted fields with `""` to escape inner quotes).
  Only the first column is read; subsequent columns are ignored.

Profile names must satisfy the existing player-name rules: 1–24 chars, start
with a letter, only letters / spaces / apostrophes / hyphens.

The endpoint is **idempotent on (class, normalized-name)** — re-uploading the
same roster adds zero new members.

## Participation report

`GET /api/admin/classes/:id/report?lang=en&from=YYYY-MM-DD&to=YYYY-MM-DD`

Returns one row per member with:

| Field | Meaning |
| --- | --- |
| `profileId`, `name` | Identity (or `(missing profile)` if the leaderboard has dropped it) |
| `days[]` | Per-day status: `won`, `lost`, `not-started`, or `no-profile` (when the member's profile was deleted from the leaderboard but the class still references it; surfaces alongside the row's `missing: true` flag), plus `attempts`, `submissionCount`, `updatedAt` |
| `wins`, `playedCount` | Totals across the requested range |
| `winRate` | Wins ÷ played |
| `lastPlayedAt` | Newest `updatedAt` across the range |

Report range is capped at **90 days** to keep responses bounded.

### CSV export

`format=csv` returns `text/csv; charset=utf-8` with `Content-Disposition:
attachment; filename="class-<id>-report-<from>-<to>.csv"`. The first row is
the header; each member becomes one row with one (`status`, `attempts`)
column-pair per day plus the totals.

`bom=true` prepends a UTF-8 byte-order mark so Excel opens the file as UTF-8
without prompting.

## Archive vs delete

- **Archive** (`PATCH ... { archived: true }`) sets `archivedAt` but preserves
  members and the class itself. Archived classes don't appear in the default
  list (`GET /api/admin/classes`) — toggle "Show archived" / pass
  `?includeArchived=true` to see them.
- **Delete** (`DELETE ...`) requires `confirmed: true`. `deleteProfiles=true`
  triggers the carve-out: only profiles that are NOT a member of any other
  *non-archived* class get removed from the leaderboard. Profiles still
  referenced elsewhere are preserved. The response body lists the
  `deletedProfileIds`.

## Profile cap

The default profile cap is now **50** (raised from 20 to support classroom
rosters). Configure via:

- Env: `LEADERBOARD_MAX_PROFILES` (locks the cap when set, must be a positive
  integer in `[1, 1000]`).
- Persisted override: `overrides.limits.leaderboardMaxProfiles` in
  `data/app-config.json` — see
  `docs/admin-platform-architecture-contract.md`.

## PII boundary

CSV exports contain only profile names (already stored locally), dates,
status, attempts, and win flag. No host metadata, IP addresses, or user-agent
strings are exported. Operators sharing exports outside the host should treat
them as roster + game-result data.

## Concurrent safety

All class mutations go through `lib/classes-store.js`'s write queue — two
simultaneous bulk uploads serialize into a deterministic outcome.

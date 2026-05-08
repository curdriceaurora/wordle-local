# Admin Analytics

Operator-side overview of the **Analytics** tab in the admin shell.

## What it shows

A read-only dashboard for engagement and completion patterns, computed
server-side from the leaderboard snapshot. There is **no event log** — the
metrics are derived from the same `data/leaderboard.json` that the Stats
tab reads.

### Summary cards

| Metric | Definition |
| --- | --- |
| **DAU** | Distinct profiles that submitted a result on the operator's *today* (server-local, matching the date the daily-key was written with). |
| **WAU** | Distinct profiles with a result in the trailing 7 days, regardless of the selected window. |
| **Games in window** | Total result rows submitted within the selected window. |
| **Win rate** | `wins / games` over the window. Wins are entries with `won=true`. |
| **Avg attempts** | Mean of the `attempts` field across **wins only** in the window. Losses have `attempts=null` and are excluded so a loss doesn't masquerade as 0 attempts. |
| **Replay rate** | `(profiles with >1 game in window) / (profiles with >=1 game in window)`. |
| **Profiles** | Total profile count in the leaderboard (not gated by window). |

### Charts

1. **Activity over time** — line chart with two series (`dailyActive`,
   `dailyGames`). Shares an x-axis (date) with two y-axes so DAU and game
   counts don't squash each other when the scales diverge.
2. **Attempts distribution** — bar chart with one bucket per attempt
   count from `1` to `10` (matching the server's `MAX_GUESSES`), plus
   an `11+` overflow bucket for any wins beyond that, plus `DNF` for
   non-wins (`won === false`) regardless of attempt count. Histogram
   bar values always sum to `gamesInWindow` — no result is silently
   dropped.
3. **Language mix** — horizontal bar chart, count of games per `lang` code.
   Sorted by count (desc), then alphabetical.
4. **Time-of-day** — 24-bucket histogram of result `updatedAt`, bucketed
   in `ANALYTICS_TIMEZONE`. Use this to see when families typically play.

Each chart has a sibling `<details>`-collapsed table with the same
data — accessible to screen readers and copy-paste-friendly.

## Time-window control

Three options, segmented control: `7d`, `30d`, `all`. Default `7d`.
- `7d` and `30d` count *days inclusive of today* (so `7d` covers today
  back to today − 6).
- `all` starts at the earliest result/profile date in the snapshot.

The control is a `role="radiogroup"` with arrow-key navigation and proper
`aria-checked` state.

## Endpoint

```
GET /api/admin/analytics?window=7d|30d|all
```

- Admin-gated via the standard `requireAdminAccess` middleware (same
  `x-admin-key` header as every other `/api/admin/*` route).
- Default `window=7d` when omitted.
- Returns 400 with `{ code: "INVALID_WINDOW" }` on unknown values.
- Response: `{ window, generatedAt, summary, series, distributions }`
  with the shapes documented in `lib/analytics-aggregator.js`.

### Cache

A per-router cache keyed by `(window | snapshot.updatedAt | today)`
returns the same payload across calls within the TTL. Any leaderboard
mutation bumps `snapshot.updatedAt` and invalidates the entry instantly;
the `today` term causes the cache to roll over at the server-local day
boundary so a payload generated yesterday never serves today's request.

- Cache hit responses set `X-Analytics-Cache: HIT`.
- Cache misses set `X-Analytics-Cache: MISS`.
- TTL: `ANALYTICS_CACHE_TTL_MS` env var (default `60000`, range `1`
  – `3600000`). A value of `1` effectively disables the cache —
  sequential requests cross more than a millisecond, so any entry
  is already expired by the next call.

## Environment variables

| Var | Default | Range / values | Purpose |
| --- | --- | --- | --- |
| `ANALYTICS_CACHE_TTL_MS` | `60000` | 1 to 3600000 | Server-side cache TTL for the aggregated payload. Use `1` to effectively disable caching (subsequent requests cross more than a millisecond and miss). |
| `ANALYTICS_TIMEZONE` | `process.env.TZ` or `UTC` | IANA timezone name (e.g. `America/New_York`) | Timezone used for the **time-of-day histogram only**. Invalid zones fall back to UTC and a warning is logged at boot. |

`ANALYTICS_TIMEZONE` is hour-of-day-only. The window-edge "today" is
computed via `getLocalDateString(new Date())`, the same helper the game
uses when it writes daily-key dates into the leaderboard. Aligning the
aggregator's "today" with the storage convention is the important
invariant — otherwise a play that just landed in the storage as `2026-05-08`
could end up bucketed under "yesterday" from the dashboard's perspective
when the window edge said today is `2026-05-07` in some other zone. Set
the **server's** TZ (`process.env.TZ`) to the operator's calendar if you
want both the storage and the dashboard's date math to follow it.

## CSP and offline

The admin shell's CSP (Helmet) restricts `script-src` to `'self'` plus
inline (no external origins). Chart.js is vendored at
`public/dist/vendor/chart.umd.min.js`; the page never makes external
network calls, which the Playwright UI test asserts.

License for the vendored bundle is in `public/dist/vendor/chart.js-LICENSE.md`
and is recorded in `THIRD_PARTY_NOTICES.md`.

## Adding a new metric

1. Compute it in `lib/analytics-aggregator.js`. Add a field to either
   `summary`, `series.*`, or `distributions.*` so consumers can rely on
   the shape.
2. Add a unit test fixture in `tests/analytics-aggregator.test.js` that
   pins the new field's values for a known snapshot — the file already
   has empty / sparse / dense / leap-day / TZ-boundary fixtures to copy.
3. Render the new field in `public/admin/app.js` (`renderAnalyticsPayload`).
   Add a card to the markup in `public/admin/index.html` and update the
   data-table fallback if appropriate.
4. Update this doc with the new row and definition.

## Known limitations

- The aggregator runs over the full snapshot for every cache miss. For
  the family-scale operator (≤ a few thousand profiles, ≤ low-hundreds
  of results each) this is sub-100ms; the integration test pins p99 < 200
  ms on a synthetic 1000-profile / 30-day fixture. Larger deployments
  should consider raising `ANALYTICS_CACHE_TTL_MS` first.
- The endpoint reads a single `leaderboardStore.getSnapshot()` per call
  — there's no profile-level drilldown here. The Stats tab covers
  per-profile views.
- Hour-of-day bucketing falls back to UTC if `ANALYTICS_TIMEZONE` is
  unrecognised. Validate locally with `node -e "new
  Intl.DateTimeFormat('en', { timeZone: '<zone>' })"` if a value is
  rejected at boot.

# local-hosted-wordle

Local, privacy-first Wordle you can run anywhere.

For families, classrooms, and friend groups who want a self-hosted Wordle.
Beyond the basics: daily words, timed challenges, classroom rosters, opt-in push notifications, and an English/Spanish UI.

## How To Use

1. Open the site in your browser.
2. Create a puzzle, play the daily word, or join a timed challenge.
3. Share the link.
4. Play it together.

Want a daily puzzle? Visit `/daily` after you've set one ([step 3 below](#3-optional-set-a-daily-word)).
Want timed multi-puzzle runs? Visit `/challenges` once a challenge is configured (Admin Console → Challenges).

## Quick Start

A two-minute walkthrough from install to your first puzzle. **No admin setup required** — everything below works against an out-of-the-box install on `localhost`.

### 1. Install and run

Node 20+ (matches CI and the bundled Docker image):

```bash
npm install
npm start
```

…or Docker (the bundled Compose file declares `.env` as `env_file`, so create one first):

```bash
cp .env.example .env
docker compose up --build
```

Open `http://localhost:3000`.

> `npm start` doesn't load `.env`, so admin endpoints run **open** by default — fine for a local game on `localhost`. To lock the server down before exposing it beyond your machine, see [Locking it down](#locking-it-down) under Admin Console.

### 2. Create and share a puzzle

1. On the home page, type a word into **Word** (3–12 letters, A–Z), or click **Random word**.
2. Optional: tweak **Length** or **Guesses**. The Length field updates automatically as you type.
3. Click **Start puzzle**. The play screen shows a **Share link** at the bottom.
4. Copy the link and send it. Anyone who opens it plays the same word — no login required.

> Share links encode the word for convenience, not security. Don't share links to puzzles you don't want decoded.

### 3. (Optional) Set a daily word

If you want everyone using your install to play the same word at `/daily`:

```bash
curl -X POST http://localhost:3000/api/word \
  -H 'Content-Type: application/json' \
  -d '{"word":"CRANE","lang":"en"}'
```

If you locked the server down, add `-H 'x-admin-key: YOUR_ADMIN_KEY'` to the request. Details: [Locking it down](#locking-it-down).

Visit `http://localhost:3000/daily`. The first time a player plays the daily word, they pick a profile name; results show on the family leaderboard automatically — no account or password.

### 4. (Optional) Switch the UI language

The header has a language switcher (English, Spanish). Selection persists in the browser.

### What next?

- **More player features** — timed challenges, notifications, classroom rosters: see [Highlights](#highlights).
- **Operator controls** — provider imports, scheduled words, backups, webhooks, analytics: see [Admin Console](#admin-console).
- **Hosting beyond defaults** — env vars, proxies, Tailscale: see [advanced-settings.md](advanced-settings.md).

## Highlights

- **Custom puzzles**: create-and-share links, no login.
- **Daily word** with optional admin-managed schedule + auto-rotate from the active answer pool.
- **Timed challenges** — solve N puzzles inside a server-authoritative time budget; per-challenge leaderboard.
- **Classroom mode** — admin manages classes, rosters, and CSV reports ([docs/classroom-mode.md](docs/classroom-mode.md)).
- **Opt-in browser push notifications** when the daily puzzle is ready ([docs/notifications.md](docs/notifications.md)).
- **Outbound webhooks** with HMAC-signed deliveries, retry queue, and recovery on boot ([docs/webhooks.md](docs/webhooks.md)).
- **Backup / restore** — versioned, schema-checked archives applied atomically ([docs/backup-restore.md](docs/backup-restore.md)).
- **Usage analytics** — admin dashboard with offline charting ([docs/admin-analytics.md](docs/admin-analytics.md)).
- **UI internationalization** — English + Spanish at strict per-key parity, switchable from the header ([docs/i18n.md](docs/i18n.md)).

## Other Goodies (Optional)

- For English puzzles, a local meaning is shown when a game ends (solve or final reveal), when available.
- Theme controls include `System`, `Dark`, and `Light`; `System` follows your OS/browser color scheme when available.
- Hosting behind a proxy or running with admin features? See [advanced-settings.md](advanced-settings.md).

## Admin Console

- Visit `/admin` for the operator console.
- Unlock uses `x-admin-key` semantics and keeps the key session-scoped in memory (no browser storage persistence).
- Admin platform architecture contracts (schemas, config precedence, queue semantics): [docs/admin-platform-architecture-contract.md](docs/admin-platform-architecture-contract.md).

### Locking it down

By default, `npm start` runs **open** — `node server.js` doesn't load `.env`, `ADMIN_KEY` is empty, and the admin gate falls through. Fine for a local game on `localhost`; not fine if you're exposing the server beyond your machine.

Set the key **before** starting the server. `server.js` reads `ADMIN_KEY` and `REQUIRE_ADMIN_KEY` once at boot, and both `docker compose`'s `env_file` and Node's `--env-file` flag are evaluated at process startup — editing `.env` after launch leaves the running process using whatever values were in place when it started (notably the `change-me` placeholder from `.env.example`). If you need to rotate the key on a running server, edit `.env` then restart.

```bash
cp .env.example .env
# Edit .env now — set ADMIN_KEY to a long random value.
```

Then load it with one of:

```bash
# Option A — Docker (Compose reads .env automatically via env_file)
docker compose up --build

# Option B — Node 20+'s built-in --env-file flag (no dotenv dependency)
node --env-file=.env server.js
```

The gate covers `/api/admin/*` (the API the admin console talks to). The `/admin` HTML page itself is served unauthenticated — so an unauthenticated visitor can see the unlock form, but every read or write the form makes goes through the gate.

Once locked down, requests to admin endpoints need the header:

```bash
curl -X POST http://localhost:3000/api/word \
  -H 'Content-Type: application/json' \
  -H 'x-admin-key: YOUR_ADMIN_KEY' \
  -d '{"word":"CRANE","lang":"en"}'
```

### Provider workflows

- import/re-import (`en-GB`, `en-US`, `en-CA`, `en-AU`, `en-ZA`) via either remote fetch (pinned commit + required SHA-256 checksums) or manual `.dic` + `.aff` upload fallback.
- async import queue with persisted job history under `data/admin-jobs.json`.
- check upstream updates on demand with status outcomes (`up-to-date`, `update-available`, `unknown`, `error`).
- enable/disable imported variants without CLI usage.
- Import uses `denylist-only` (default) or `allowlist-required` family filter modes.

### Tabs

- **Providers** — provider/dictionary lifecycle (above).
- **Import Queue** — live status of async import jobs.
- **Runtime Settings** — edits only hot-refresh-safe overrides (`data/app-config.json`); env-defined security/infrastructure values remain read-only.
- **Profiles** — leaderboard profile management.
- **Classes** — classroom rosters, bulk-add by names/CSV, participation reports ([docs/classroom-mode.md](docs/classroom-mode.md)).
- **Data** — download a versioned, schema-checked backup archive and restore it atomically ([docs/backup-restore.md](docs/backup-restore.md)).
- **Analytics** — usage dashboard (active days, attempts distribution, language mix, hour-of-day) with offline-friendly charting ([docs/admin-analytics.md](docs/admin-analytics.md)).
- **Schedule** — queue words against specific dates or turn on auto-rotate from the active answer pool; the runtime owns `data/word.json` from then on ([docs/scheduler.md](docs/scheduler.md)).
- **Webhooks** — manage outbound subscriptions with per-event filters; view recent deliveries with status/attempts/latency. Deliveries are HMAC-signed, retried with exponential backoff, and recovered on boot ([docs/webhooks.md](docs/webhooks.md)).
- **Notifications** — VAPID status, subscriber count, manual broadcast (with dry-run preview) for the daily puzzle ([docs/notifications.md](docs/notifications.md)).
- **Challenges** — define timed challenges (puzzle count, word length, time budget, max guesses, replay policy, scoring) and inspect per-challenge leaderboards ([docs/challenge-mode.md](docs/challenge-mode.md)).

## Daily Word (API)

Daily word endpoints remain available:

- `GET /api/word` — read current daily word config
- `POST /api/word` — set daily word
  - Body: `{ "word": "CRANE", "lang": "en", "date": "YYYY-MM-DD" }`
  - If `date` is provided, it is interpreted in server local time.
- The **scheduler** owns `data/word.json` at each local-midnight rollover when `data/schedule.json` exists. A manual `POST /api/word` overrides the schedule for the rest of the day; the next day the schedule wins again. To stop the scheduler from acting on `word.json`, delete `data/schedule.json` **and restart the server** — the in-memory schedule cache is loaded once at boot and is not invalidated by filesystem deletes, so the running process will keep reconciling against the cached schedule until restart. After restart, the store recreates an empty default file and the reconciler no-ops every tick (there's no separate "off" mode in v1). See [docs/scheduler.md](docs/scheduler.md) for the full contract.

## Languages & Dictionaries

- English dictionary is baked in (`en`).
- English meanings are baked in locally (`data/dictionaries/en-definitions.json`).
- Language registry state is persisted in `data/languages.json`; missing/invalid registry data auto-recovers to baked defaults.
- Minimum word length is 3.
- Dictionaries accept A–Z only (no accents).
- If a dictionary file is missing or empty, that language is not shown in the UI.
- English word list source: wordlist-en_US-2020.12.07 (derived from SCOWL). See `data/dictionaries/wordlist-en_US-2020.12.07-README.txt` for license and credits.
- Meanings are loaded from local files only; no external dictionary API calls are made at runtime.
- To refresh local meanings from WordNet data (and rebuild indexed lookup artifacts): `npm run definitions:build`.
- To rebuild only indexed lookup artifacts from the existing definitions file: `npm run definitions:index`.
- For performance tuning, `DEFINITIONS_MODE` supports `memory`, `lazy`, and `indexed` (see [advanced-settings.md](advanced-settings.md)).

## Daily Link

- Visit `/daily` to play the configured daily word.
- If no daily word is set (or the date doesn’t match today), a friendly error page is shown.

## Family Profiles & Leaderboards

- Daily mode prompts for a player name (no password; honor system for families).
- Profiles and leaderboard stats are stored on the server in `data/leaderboard.json` and shared across devices on the same host.
- Server retention limits are applied for performance:
  - up to 20 profiles
  - up to 400 daily results per profile
- Leaderboards support three views:
  - Weekly: last 7 days including today.
  - Monthly: current calendar month.
  - Overall: all recorded daily games.
- Streaks are tracked per profile based on consecutive winning daily entries.
- No local import from historical browser `localStorage` stats is performed.
- Pitfall: clearing browser storage no longer deletes server stats, but it can clear local UI state such as the active profile selection on that device.
- Rollout and cutover notes: [docs/server-leaderboard-rollout.md](docs/server-leaderboard-rollout.md)
- Data contract details: [docs/leaderboard-data-contract.md](docs/leaderboard-data-contract.md)

## Timed Challenges

- Visit `/challenges` to see the active list (the link is hidden until at least one challenge is configured).
- Each challenge defines a fixed puzzle count, word length, time budget, max guesses per puzzle, and a replay policy (`unlimited`, `best`, or `first-only`).
- The timer is **server-authoritative** — switching tabs, sleeping the device, or reloading does not pause the budget. The server settles a session if it expires before the player finishes.
- Server-side per-letter feedback is computed on each guess; the client only renders, never decides.
- Per-challenge leaderboards rank by score → fewer elapsed seconds → earlier finish.
- Profile name is stored on this device (no login); used on the leaderboard.
- Operator-facing details + replay policy mechanics: [docs/challenge-mode.md](docs/challenge-mode.md).

## Daily Puzzle Notifications

- Optional opt-in browser push for the daily puzzle. Toggle in the header settings strip — the toggle is hidden if your browser doesn't support `PushManager` / Service Worker, or if the page is loaded over plain HTTP (notifications need HTTPS or `localhost`).
- The daily fire is server-scheduled at the operator's configured local time (default `00:00`).
- Subscriptions are pruned on `404`/`410` from the push service so dead endpoints don't accumulate.
- VAPID keypair lives in `data/vapid-keys.json` (auto-generated on first boot, persisted thereafter).
- Operator runbook: [docs/notifications.md](docs/notifications.md).

## UI Languages

- The header has a language switcher (English, Spanish). Selection persists per device.
- Both the player and admin shells are translated; `npm run i18n:check` enforces strict per-key parity between locales in CI.
- HTTP error JSON is also localized for the small set of routes wired through `lib/server-i18n.js` (`Accept-Language` aware).
- Adding a new locale: drop a JSON file under `public/locales/` and update the small list of allowlists documented in [docs/i18n.md](docs/i18n.md).

## Security Notes

- Rate limiting is enabled by default.
- `TRUST_PROXY=true` is recommended behind proxies or Tailscale (`TRUST_PROXY_HOPS` defaults to `1`).
- Container runs as a non-root user and includes `/api/health`.
- For provider/admin releases, use [docs/admin-security-checklist.md](docs/admin-security-checklist.md) in addition to release gates.

## Troubleshooting

- Nothing loads at `http://localhost:3000`: confirm the server is running and your port is free.
- Daily link says no puzzle set: set one via `POST /api/word` (Quick Start step 3). If you locked the server down, pass `x-admin-key` — see [Locking it down](#locking-it-down).
- Share link doesn't work: make sure the link wasn't truncated and is from the Create screen.
- `/challenges` link is missing from the header: no challenges are configured. The admin Challenges tab can create one.
- Notifications toggle is hidden: page is loaded over plain HTTP, or the browser lacks `PushManager` / Service Worker. Use HTTPS (or `localhost`) and a modern browser.
- Notifications toggle is disabled with "Notifications blocked": browser permission was denied. Open browser site permissions, allow notifications, then reload.
- Webhook deliveries are stuck `queued`: confirm `WEBHOOKS_ENABLED=true` and that no other admin operation is holding the data lock; recovery on boot also requeues stale `running` rows.
- UI keeps reverting to English: the language switcher writes to `localStorage`. Clearing browser storage clears the preference too.

## Roadmap

The two original exploratory tracks shipped:

- **Admin Platform expansion** ([#6](https://github.com/curdriceaurora/wordle-local/issues/6), closed) — Admin UI, runtime settings, classes, scheduler, analytics, backup/restore, webhooks, notifications, challenges.
- **LibreOffice English variants** ([#17](https://github.com/curdriceaurora/wordle-local/issues/17), closed) — `en-GB`, `en-US`, `en-CA`, `en-AU`, `en-ZA` via admin import flows, Hunspell-based guess handling, curated answer policy.

Current priorities remain stability, low operational overhead, and a simple local-hosted gameplay experience. Contributions for additional UI locales (drop a JSON file under `public/locales/` per [docs/i18n.md](docs/i18n.md)) and additional language variants are welcome.

## License

CC0-1.0 public domain dedication. See `LICENSE`.
Third-party assets (notably the English dictionary) are licensed separately. See `THIRD_PARTY_NOTICES.md`.

## Contributing

See `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`.
Release maintainers should also use [docs/release-checklist.md](docs/release-checklist.md).
Provider/admin release changes should additionally follow [docs/provider-rollout-checklist.md](docs/provider-rollout-checklist.md).

## Disclaimer

This project is provided “as is”, without warranty of any kind. See `DISCLAIMER.md`.

## Support

No support or SLAs. See `SUPPORT.md`.

## Trademark

Wordle is a trademark of The New York Times Company. This project is not affiliated with or endorsed by The New York Times.

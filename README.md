# local-hosted-wordle

Local, privacy-first Wordle you can run anywhere.

For families, classrooms, and friend groups who want a simple, self-hosted Wordle.

## How To Use
1. Open the site in your browser.
2. Create a puzzle.
3. Share the link.
4. Play it together.

Want a daily puzzle? Visit `/daily` after you’ve set one (see below).

## Quickstart (Local)
Download this repo (or clone it), then run:

```bash
npm install
cp .env.example .env
npm start
```
Open `http://localhost:3000`.

## Quickstart (Docker)
If you don’t use Docker, skip this section.

```bash
docker build -t local-hosted-wordle .
docker run --rm -p 3000:3000 --env-file .env local-hosted-wordle
```
Or with Compose:
```bash
docker compose up --build
```

## Advanced Settings (Optional)
If you want admin controls or are hosting behind a VPN/proxy, see `advanced-settings.md`.

## Create & Share
- Create a puzzle on the Create screen.
- Share links are encoded for convenience, not security.
- For English puzzles, a local meaning is shown when a game ends (solve or final reveal), when available.
- Theme controls include `System`, `Dark`, and `Light`; `System` follows your OS/browser color scheme when available.

## Admin Console
- Visit `/admin` for the provider admin shell.
- Unlock uses `x-admin-key` semantics and keeps the key session-scoped in memory (no browser storage persistence).
- Provider workflows are built in:
  - import/re-import (`en-GB`, `en-US`, `en-CA`, `en-AU`, `en-ZA`) via either remote fetch (pinned commit + required SHA-256 checksums) or manual `.dic` + `.aff` upload fallback
  - async import queue with persisted job history under `data/admin-jobs.json`
  - check upstream updates on demand with status outcomes (`up-to-date`, `update-available`, `unknown`, `error`)
  - enable/disable imported variants without CLI usage
- Import uses `denylist-only` (default) or `allowlist-required` family filter modes.
- Admin platform architecture contracts (schemas, config precedence, queue semantics): `docs/admin-platform-architecture-contract.md`.
- Runtime settings tab edits only hot-refresh-safe overrides (`data/app-config.json`); env-defined security/infrastructure values remain read-only.

## Daily Word (API)
Daily word endpoints remain available:

- `GET /api/word` — read current daily word config
- `POST /api/word` — set daily word
  - Body: `{ "word": "CRANE", "lang": "en", "date": "YYYY-MM-DD" }`
  - If `date` is provided, it is interpreted in server local time.

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
- For performance tuning, `DEFINITIONS_MODE` supports `memory`, `lazy`, and `indexed` (see `advanced-settings.md`).

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
- Rollout and cutover notes: `docs/server-leaderboard-rollout.md`
- Data contract details: `docs/leaderboard-data-contract.md`

## Security Notes
- Rate limiting is enabled by default.
- `TRUST_PROXY=true` is recommended behind proxies or Tailscale (`TRUST_PROXY_HOPS` defaults to `1`).
- Container runs as a non-root user and includes `/api/health`.
- For provider/admin releases, use `docs/admin-security-checklist.md` in addition to release gates.

## Troubleshooting
- Nothing loads at `http://localhost:3000`: confirm the server is running and your port is free.
- Daily link says no puzzle set: set one via `POST /api/word`.
- Share link doesn’t work: make sure the link wasn’t truncated and is from the Create screen.

## Roadmap (Exploratory)
We are evaluating exploratory tracks that are intentionally outside the current core scope:
- Admin Platform expansion (Admin UI, dictionary lifecycle management, and selected runtime settings controls): https://github.com/curdriceaurora/wordle-local/issues/6
- LibreOffice English variant sourcing (`en-GB`, `en-US`, `en-CA`, `en-AU`, `en-ZA`) via Admin import flows, with Hunspell-based guess handling and curated answer policy: https://github.com/curdriceaurora/wordle-local/issues/17

This second track is planned after foundational Admin Platform work in #6.

Whether it ships next will depend on adoption signals and community feedback.
Current priority remains a stable, simple local-hosted gameplay experience.

## License
CC0-1.0 public domain dedication. See `LICENSE`.
Third-party assets (notably the English dictionary) are licensed separately. See `THIRD_PARTY_NOTICES.md`.

## Contributing
See `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`.
Release maintainers should also use `docs/release-checklist.md`.
Provider/admin release changes should additionally follow `docs/provider-rollout-checklist.md`.

## Disclaimer
This project is provided “as is”, without warranty of any kind. See `DISCLAIMER.md`.

## Support
No support or SLAs. See `SUPPORT.md`.

## Trademark
Wordle is a trademark of The New York Times Company. This project is not affiliated with or endorsed by The New York Times.

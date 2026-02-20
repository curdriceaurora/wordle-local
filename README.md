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

## Daily Word (API-only)
There is no admin UI. Use the API endpoints below.

- `GET /api/word` — read current daily word config
- `POST /api/word` — set daily word
  - Body: `{ "word": "CRANE", "lang": "en", "date": "YYYY-MM-DD" }`
  - If `date` is provided, it is interpreted in server local time.

## Languages & Dictionaries
- English dictionary is baked in (`en`).
- English meanings are baked in locally (`data/dictionaries/en-definitions.json`).
- `none` disables dictionary checks for fully custom words and guesses (A–Z only, length rules still apply).
- Minimum word length is 3.
- Dictionaries accept A–Z only (no accents).
- If a dictionary file is missing or empty, that language is not shown in the UI.
- English word list source: wordlist-en_US-2020.12.07 (derived from SCOWL). See `data/dictionaries/wordlist-en_US-2020.12.07-README.txt` for license and credits.
- Meanings are loaded from local files only; no external dictionary API calls are made at runtime.
- To refresh local meanings from WordNet data: `npm run definitions:build`.

## Daily Link
- Visit `/daily` to play the configured daily word.
- If no daily word is set (or the date doesn’t match today), a friendly error page is shown.

## Family Profiles & Leaderboards
- Daily mode prompts for a player name (no password; honor system for families).
- Profiles and stats are stored only in browser localStorage on that device.
- Leaderboards support three views:
  - Weekly: last 7 days including today.
  - Monthly: current calendar month.
  - Overall: all recorded daily games.
- Streaks are tracked per profile based on consecutive winning daily entries.
- Pitfall: clearing browser storage resets profile history and leaderboards.

## Security Notes
- Rate limiting is enabled by default.
- `TRUST_PROXY=true` is recommended behind proxies or Tailscale.
- Container runs as a non-root user and includes `/api/health`.

## Troubleshooting
- Nothing loads at `http://localhost:3000`: confirm the server is running and your port is free.
- Daily link says no puzzle set: set one via `POST /api/word`.
- Share link doesn’t work: make sure the link wasn’t truncated and is from the Create screen.

## License
CC0-1.0 public domain dedication. See `LICENSE`.
Third-party assets (notably the English dictionary) are licensed separately. See `THIRD_PARTY_NOTICES.md`.

## Contributing
See `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`.

## Disclaimer
This project is provided “as is”, without warranty of any kind. See `DISCLAIMER.md`.

## Support
No support or SLAs. See `SUPPORT.md`.

## Trademark
Wordle is a trademark of The New York Times Company. This project is not affiliated with or endorsed by The New York Times.

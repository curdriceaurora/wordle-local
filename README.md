# MyWordle Local

Local, privacy-first Wordle you can run anywhere.

## Run

```bash
npm install
cp .env.example .env
npm start
```

App runs on `http://localhost:3000` by default.

## Tests
- `npm test` for API tests.
- `npm run test:ui` for UI tests across Chromium, Firefox, and WebKit.
- `npm run test:ui:fast` for a quick Chromium-only run.

## Create & Share
- Create a puzzle on the Create screen.
- Share links are encoded for convenience, not security. Don’t use them for secrets.

## Daily Word (API-only)
There is no admin UI. Use the API endpoints below.

- `GET /api/word` — read current daily word config
- `POST /api/word` — set daily word
  - Body: `{ "word": "CRANE", "lang": "en", "date": "YYYY-MM-DD" }`
  - If `date` is provided, it is interpreted in server local time.

### Admin Key
If `ADMIN_KEY` is set, include the header `x-admin-key: <value>` on admin requests.
Unauthorized requests return `401`.
When running the public Docker image (NODE_ENV=production), admin endpoints require `ADMIN_KEY` by default.

## Security Notes (Public Images)
- **Admin key required** in production. Set `ADMIN_KEY` and keep it private.
- **Rate limiting** is enabled by default. Optional overrides:
  - `RATE_LIMIT_MAX` (default 300 requests / 15 min)
  - `RATE_LIMIT_WINDOW_MS` (default 900000)
- If behind a reverse proxy, set `TRUST_PROXY=true` so rate limiting uses the real client IP.
- Container runs as a non-root user and includes a `/api/health` healthcheck.

## Languages & Dictionaries
- Supported: `en` and `none` (no dictionary).
- Minimum word length is 3.
- Dictionaries only accept A–Z (no accents).
- If a dictionary file is missing or empty, that language is not shown in the UI.

## Daily Link
- Visit `/daily` to play the configured daily word.
- If no daily word is set (or the date doesn’t match today), a friendly error page is shown.

## License
CC0-1.0 public domain dedication. No attribution required. See `LICENSE`.

## Contributing
See `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`.

## Trademark
Wordle is a trademark of The New York Times Company. This project is not affiliated with or endorsed by The New York Times.

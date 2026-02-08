# MyWordle Local

Local, privacy-first Wordle you can run anywhere.

## Run

```bash
npm install
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

## Languages & Dictionaries
- Supported: `en`, `es`, `fr`, `de`, and `none` (no dictionary).
- Spanish/French/German require a minimum word length of 5.
- Dictionaries only accept A–Z (no accents).
- If a dictionary file is missing or empty, that language is not shown in the UI.

## Daily Link
- Visit `/daily` to play the configured daily word.
- If no daily word is set (or the date doesn’t match today), a friendly error page is shown.

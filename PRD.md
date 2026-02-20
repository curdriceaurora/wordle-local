# local-hosted-wordle — Product Requirements Document (PRD)

## 1. Overview
**Product name:** local-hosted-wordle

**Purpose:** Provide a locally hosted, privacy‑preserving Wordle experience that enables anyone to create and share custom word puzzles without login, tracking, or external services.

**Primary goals:**
- Allow creators to generate a playable Wordle puzzle in a single step.
- Support sharing via encoded links (URL contains a Vigenère‑encoded word).
- Provide a daily word set by an admin.
- Include strict mode and high‑contrast options for accessibility.
- Run fully locally (self‑hosted) with a simple Docker workflow.

**Non‑goals:**
- Password-protected accounts or cloud identity.
- Monetization or telemetry.
- Server‑side persistence of user gameplay.

## 2. Personas
- **Creator/Teacher**: Wants to set a word (custom, themed, or educational) and share with a group.
- **Player**: Opens a link and plays immediately without login.
- **Admin**: Sets the daily word for regular play.

## 3. Functional Requirements
### 3.1 Create/Start a Puzzle
- User selects language.
- User either:
  - enters a specific word, or
  - requests a random word (dictionary required).
- User chooses word length (3–12) and guesses (4–10).
- On submit, the puzzle opens immediately (no extra open step).
- A share link is generated and displayed below the keyboard.

**Acceptance criteria:**
- Clicking **Start puzzle** transitions directly into play.
- Share link includes query params: `word=<encoded>` and optional `lang=<id>` and `g=<guesses>`.
- Random word is available only when a dictionary is selected.

### 3.2 Shareable Link
- Link encodes the answer via a Vigenère cipher with keyword `WORDLE`.
- Opening the link loads the puzzle without revealing the answer in the client.

**Acceptance criteria:**
- `JACKS` encodes to `FOTND`.
- Link with `?word=fotnd` launches the corresponding puzzle.

### 3.3 Gameplay
- Standard Wordle rules: 6 default guesses, configurable 4–10.
- Letter evaluations: `correct`, `present`, `absent`.
- Keyboard updates based on highest priority status.
- End state when solved or out of guesses.

**Acceptance criteria:**
- Correct guess displays “Solved in X/Y”.
- On final failure, answer is revealed.
- If a local meaning exists for the answer, it is displayed when the game ends (solved or revealed on failure).

### 3.4 Strict Mode
- Enforces all revealed hints:
  - Green letters must stay in the same positions.
  - Yellow letters must be used and cannot appear in the same position.
  - Minimum counts for revealed letters must be met.

**Acceptance criteria:**
- If a strict rule is violated, the guess is blocked with a strict‑mode error message.

### 3.5 High‑Contrast Mode
- Toggleable at any time.
- Persists via localStorage.
- Increases contrast and provides extra visual indicators.

**Acceptance criteria:**
- Color palette switches to a higher-contrast palette for board and keyboard states.

### 3.6 Daily Word
- Admin sets a daily word and optional date.
- `/daily` redirects to the encoded daily puzzle.
- Date is interpreted in server local time.
- If a date is provided, the daily word is only active on that date.
- If no date is provided, the daily word is always active.
- If no daily word is configured, `/daily` returns a friendly error.

**Acceptance criteria:**
- Visiting `/daily` opens the currently configured word.
- Visiting `/daily` with no configured word returns a 404 and a friendly message.
- A date-specific daily word is only active on its configured date in server local time.

### 3.7 Admin
- Admin endpoints allow setting daily word, language, date.
- Admin is API-only (no admin UI assets are shipped).
- `ADMIN_KEY` protects admin endpoints.

**Acceptance criteria:**
- Unauthorized updates are rejected when `ADMIN_KEY` is set.

### 3.8 Dictionary Management
- Languages: English (local dictionary) or “No dictionary”.
- If dictionary selected, guesses are validated against it.
- Languages with missing dictionary files are omitted from language options.
- English dictionary is sourced from wordlist-en_US-2020.12.07 (derived from SCOWL) with attribution in `data/dictionaries/wordlist-en_US-2020.12.07-README.txt`.
- English meanings are sourced from local `en-definitions.json` generated from Princeton WordNet 3.1 data.

**Acceptance criteria:**
- “Not in word list” displayed for invalid guesses when dictionary is active.
- Languages with missing dictionaries are not returned by `/api/meta` and do not appear in the UI.

### 3.9 Character Normalization
- Inputs are normalized to uppercase A-Z.
- Non A-Z characters are rejected by default.
- Accented letters are rejected.

**Acceptance criteria:**
- Words containing non A-Z characters are rejected with a clear error.
- Dictionary words and user input are normalized consistently.

### 3.10 Validation & Error Handling
- Missing or invalid `word` query param yields a friendly error and does not crash the client.
- Invalid or undecodable encoded words return a 400 with a readable error.
- `lang` not in the available language list returns a 400 with a readable error.
- `g` outside configured bounds returns a 400 with a readable error.
- Word length outside configured bounds returns a 400 with a readable error.
- Invalid share links show an interstitial error state, a 10-second countdown, then redirect to the create screen.

**Acceptance criteria:**
- All validation errors return JSON with an `error` field.
- Invalid share links show an interstitial error with a 10-second countdown then redirect to the create screen.
- Admin endpoints return 401/403 when `ADMIN_KEY` is set and the key is missing or incorrect.

### 3.11 Family Profiles & Daily Leaderboards
- Daily links (`/daily`) include local daily context in query params.
- In daily mode, player must pick or create a local profile name before entering guesses.
- No password or server identity checks (family honor system).
- Stats are stored in browser localStorage only.
- Track per-profile daily outcomes and streaks.
- Show local leaderboard periods: weekly (last 7 days), monthly (current calendar month), and overall.

**Acceptance criteria:**
- Daily mode blocks guesses until a local player is selected.
- Player can create/select a name in one step.
- Solves/failures update local stats for that profile.
- Leaderboard ranking updates without any server call or account system.

## 4. Architectural Requirements
### 4.1 Client
- Static HTML/CSS/JS served from `public/`.
- No authentication or tracking.
- Local storage used for user settings (strict/contrast) and local daily profile stats.

### 4.2 Server
- Node.js + Express.
- Stateless gameplay: client submits guesses, server evaluates by decoding.
- Persistent data: daily word stored in `data/word.json`.
- Dictionaries stored in `data/dictionaries/*.txt`.
- Local answer-meaning dictionary stored in `data/dictionaries/en-definitions.json`.

### 4.3 API Endpoints
- `GET /api/meta`: returns length/guess bounds and language list.
- `POST /api/encode`: validates and encodes a word.
- `POST /api/random`: returns a random word from dictionary.
- `POST /api/puzzle`: returns puzzle metadata.
- `POST /api/guess`: evaluates a guess without revealing answer.
- `GET/POST /api/word`: admin daily word control.
- `GET /daily`: redirect to current daily puzzle.

**Non‑functional:**
- All endpoints return JSON and proper error codes.
- No user state stored server‑side.

### 4.4 Deployment
- Docker image built from `node:20-alpine`.
- Data volume mount for `/app/data` to persist daily word and dictionaries.

## 5. UI Requirements
### 5.1 Create Screen
- Inputs: Language, Word, Length, Guesses.
- Random word button.
- Single primary action: “Start puzzle”.

### 5.2 Play Screen
- Wordle board (dynamic rows based on guesses).
- Keyboard centered, with mobile‑like layout.
- Share link input and “Copy link” button below keyboard.
- Strict/high‑contrast toggles visible in header.
- In daily mode: player-name prompt, profile summary, and leaderboard selector/table.

### 5.3 Responsive Layout
- Mobile‑first layout.
- Keyboard and board scale with viewport.
- Supports safe‑area insets and `100dvh`.

## 6. Accessibility Requirements (WCAG 2.2 AA)
- **Text contrast** minimum 4.5:1.
- **Keyboard access** for all actions.
- **Visible focus** for all interactive elements.
- **Skip link** to main content.
- **ARIA roles/labels** for board and tiles.
- **Status messages** announced via `aria-live`.
- **Reduced motion** support.
- **Touch target size** at least 24px.

## 7. Security & Privacy
- No tracking, analytics, or login.
- Admin protected by `ADMIN_KEY` header.
- In production (`NODE_ENV=production`), admin endpoints require `ADMIN_KEY` by default.
- Rate limiting enabled to reduce abuse (configurable via `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`).
- Security headers added via Helmet.
- Shareable links encode the word but do not conceal it from those who know the cipher; intended for light‑weight sharing, not secrecy.
- Word meanings are served from local static files only (no runtime third-party API calls).

## 8. Testing Requirements
- **Unit/API tests**: encode/decode, dictionary validation, puzzle metadata, guess evaluation.
- **UI tests**: create and play flows, strict mode validation, high‑contrast toggle, daily profile and leaderboard flows.
- **Manual**: screen reader checks, mobile viewport testing, reduced motion.
- **Edge cases**: invalid share links, missing daily word, daily date boundary tests.

## 9. Success Metrics
- Zero required login steps.
- Puzzle starts immediately after creation.
- Share link generated and functional.
- Accessibility toggles persist across reloads.

## 10. Out of Scope (for now)
- Password-protected user accounts.
- Multiplayer real-time sessions.
- Analytics or telemetry.

## 11. Known Limitations
- Encoded link can be decoded by anyone who knows the cipher.
- English-only dictionaries; other languages are not supported.
- Daily profile stats are device/browser-local and do not sync across devices.

---

## 12. Open Source Readiness
- CC0-1.0 public domain dedication (no attribution required).
- Code of Conduct and Contributing guidelines.
- Security policy for reporting vulnerabilities.
- Trademark disclaimer clarifying no affiliation with Wordle’s trademark holder.
- Dictionary source attribution and licensing notes.
- Disclaimer covering no warranty and no liability.
- Support policy stating no SLA or guaranteed responses.
- Third-party notices documenting any non-CC0 assets.

---

## 13. Related Docs
- Milestones: `MILESTONES.md`
- Risks: `RISKS.md`
- Launch checklist: `LAUNCH_CHECKLIST.md`

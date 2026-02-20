# GitHub Copilot Instructions for `local-hosted-wordle`

## Overview
This is a local, privacy-first Wordle clone designed to run anywhere. The philosophy is minimal dependencies, simple deployment, and offline capability where possible.

## Tech Stack & Architecture
- **Backend**: Node.js, Express.js.
  - **Modules**: CommonJS (`require`/`module.exports`). Do not use ES modules on the backend.
  - **Persistence**: File-based storage (e.g., `data/word.json`) or in-memory. **Do not** introduce external databases like Postgres or MongoDB.
- **Frontend**: Vanilla HTML, CSS, and JavaScript.
  - **No Frameworks**: Do not use React, Vue, Angular, or Tailwind. Keep the stack dependency-free unless absolutely necessary.
  - **No Build Pipelines**: Currently relies on static serving of `public/` assets, though there is some `esbuild` usage in the scripts structure. Prefer native vanilla syntax.
  - **State**: Client-side state (profiles, leaderboards, saved games) is stored entirely in browser `localStorage`.
- **Testing**:
  - **Unit/Backend**: Jest.
  - **End-to-End (E2E)**: Playwright (with `@axe-core/playwright` for accessibility testing).
  - Code coverage uses `istanbul` and `v8-to-istanbul`.

## General Guidelines
- **Offline & Privacy First**: Features should not rely on external APIs at runtime. For example, dictionary meanings are loaded from local files instead of querying an external service.
- **Security & Performance**:
  - Always consider rate limiting, input validation, and sanitization before processing client input.
  - Read from `server.js` functions `ensureWordData()`, `loadDictionary()`, etc., to get an idea of memory and state handling constraints (e.g., `memory`, `lazy`, or `indexed` definition modes).
- **Simplicity**: Favor standard JS/HTML/CSS features over adding new tools or libraries. Emulate existing design patterns on the frontend.
- **Testing Standard**: When modifying UI or API behavior, write tests (Jest or Playwright) to validate the integration and accessibility.

## Code Style
- Use descriptive, `camelCase` variable naming in JavaScript.
- Maintain consistent indentation and formatting.
- Stick strictly to the CommonJS standard on the backend. Do not introduce ES6 `import`/`export` keywords in Node scripts unless the `package.json` setup is updated project-wide. 

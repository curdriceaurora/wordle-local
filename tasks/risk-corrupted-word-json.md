# Task: Validate and Recover Corrupted data/word.json

## Risk
Corrupted data/word.json can break daily word behavior.

## Goal
Validate data on boot and recover safely.

## Scope
- Add schema validation for data/word.json on server startup.
- If invalid, recreate with defaults and log a warning.
- Add a regression test for invalid JSON or missing keys.

## Acceptance Criteria
- Server starts even if data/word.json is invalid.
- Defaults are restored when corruption is detected.
- Invalid data cases are covered by tests.

## Implementation Notes
- Added schema validation and startup recovery in `server.js` (`ensureWordData`).
- Invalid or unreadable `data/word.json` is reset to defaults (empty word).

## Tests
- Added recovery test in `tests/server.test.js`.

## Status
- Done (2026-02-08)

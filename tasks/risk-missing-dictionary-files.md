# Task: Handle Missing or Empty Dictionary Files

## Risk
Missing or empty dictionary files can break language selection.

## Goal
Prevent missing dictionaries from appearing in the UI and avoid runtime errors.

## Scope
- Validate dictionary file existence and non-empty content at startup.
- Exclude missing/empty dictionaries from `/api/meta` language list.
- Surface a clear error if a request targets a missing dictionary.

## Acceptance Criteria
- Languages with missing/empty dictionaries are not shown in the UI.
- `/api/meta` omits missing/empty dictionary languages.
- Requests using unavailable dictionaries return a clear error.

## Implementation Notes
- Dictionary loader returns `null` for missing or empty files.
- `/api/meta` now only includes available languages (plus `none`).
- Invalid `lang` now returns 400 with “Unknown language.”

## Tests
- Server tests cover unknown language rejection in `tests/server.test.js`.

## Status
- Done (2026-02-08)

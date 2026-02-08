# Task: Eliminate Daily Word Timezone/Date Drift

## Risk
Daily word timezone/date drift can show the wrong puzzle.

## Goal
Guarantee daily word behavior based on server local time and test date boundaries.

## Scope
- Implement date comparison using server local time.
- Add tests for boundary conditions around local midnight.
- Ensure `/daily` returns a friendly error when no daily word is configured.

## Acceptance Criteria
- Date-scoped daily words activate only on the configured local date.
- Boundary tests around local midnight pass.
- `/daily` returns a friendly error when no word is configured.

## Implementation Notes
- `/daily` now validates `date` against server local date.
- Friendly HTML error is returned when no daily word is configured or date mismatch.

## Tests
- Added `/daily` date mismatch and missing-word tests in `tests/server.test.js`.

## Status
- Done (2026-02-08)

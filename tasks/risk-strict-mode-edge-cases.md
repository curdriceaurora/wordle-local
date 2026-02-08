# Task: Cover Strict Mode Edge Cases

## Risk
Strict mode logic has edge cases, especially with repeated letters.

## Goal
Ensure strict mode behavior is correct and test-covered.

## Scope
- Add unit tests for repeated-letter scenarios (greens/yellows/absents).
- Verify enforcement of minimum letter counts.
- Document expected behavior for ambiguous guesses.

## Acceptance Criteria
- Unit tests cover repeated-letter cases and pass.
- Strict mode rejects guesses that violate revealed constraints.
- Behavior is documented with at least 2 concrete examples.

## Implementation Notes
- Added Playwright test for repeated-letter enforcement using LEVEL/ALLOT/LAMER.
- Strict mode now verified for minimum letter counts.

## Examples
- Answer `LEVEL`, guess `ALLOT` → strict mode requires `L x2` in future guesses.
- Guess `LAMER` is rejected with `Strict mode: include L x2.`

## Status
- Done (2026-02-08)

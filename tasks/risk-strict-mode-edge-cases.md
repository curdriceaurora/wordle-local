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

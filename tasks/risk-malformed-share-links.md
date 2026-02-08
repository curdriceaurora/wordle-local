# Task: Handle Malformed Share Links Safely

## Risk
Malformed share links can cause crashes or confusing behavior.

## Goal
Validate inputs and show a clear interstitial error with a timed redirect.

## Scope
- Validate `word`, `lang`, and `g` query params before starting a puzzle.
- Return 400 with a readable error for invalid encoded words.
- Show an interstitial error with a 10-second countdown, then redirect to the create screen.

## Acceptance Criteria
- Invalid share links never start a puzzle.
- Interstitial error appears with a 10-second countdown and redirects to create.
- Server returns 400 with an `error` field for invalid inputs.

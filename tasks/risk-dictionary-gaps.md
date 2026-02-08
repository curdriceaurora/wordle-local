# Task: Mitigate Non-English Dictionary Gaps

## Risk
Dictionary gaps for non-English languages reduce usability.

## Goal
Improve coverage for supported languages or clearly communicate limitations.

## Scope
- Inventory existing word lists and identify low-coverage languages.
- Add or replace dictionaries with higher-quality word lists.
- Ensure dictionaries are normalized to A-Z (no accents).

## Acceptance Criteria
- Each supported language has a documented word count and source.
- Dictionaries for Spanish/French/German meet an agreed minimum size.
- All dictionary entries are normalized to A-Z.

## Decisions
- Spanish/French/German enforce a minimum word length of 5.

## Implementation Notes
- Dictionary counts documented in `data/dictionaries/README.md`.
- Dictionaries are normalized to A–Z only by the loader.

## Open Items
- Source attribution for word lists is not yet documented.

## Status
- In progress (2026-02-08)

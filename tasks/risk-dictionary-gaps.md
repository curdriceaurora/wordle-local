# Task: Address Dictionary Licensing

## Risk
Dictionary source licensing is unclear for an open-source release.

## Goal
Ensure the English word list has clear licensing/attribution or replace it with a permissive list.

## Scope
- Identify the current English word list source and license.
- Replace the list if licensing is unclear or incompatible.
- Keep normalization to A–Z only (no accents).

## Acceptance Criteria
- English dictionary source and license are documented.
- Word count and normalization details are recorded in `data/dictionaries/README.md`.
- If the source is unclear, a permissive, documented list is used instead.

## Decisions
- Non-English dictionaries removed; English-only support.

## Implementation Notes
- Dictionary counts documented in `data/dictionaries/README.md`.
- Dictionaries are normalized to A–Z only by the loader.

## Open Items
- Source attribution for the English list is not yet documented.

## Status
- In progress (2026-02-08)

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
- Switched to wordlist-en_US-2020.12.07 (Hunspell dictionary derived from SCOWL).
- License/credits captured in `data/dictionaries/wordlist-en_US-2020.12.07-README.txt`.
- Dictionary counts documented in `data/dictionaries/README.md`.
- Dictionaries are normalized to A–Z only by the loader.
- Added local `en-definitions.json` (generated from Princeton WordNet 3.1 via `wordnet-db`) for reveal-time meanings.
- Definition lookup is now fully local (no runtime network dependency).
- WordNet license text added in `data/dictionaries/wordnet-3.1-LICENSE.txt`.

## Open Items
- None.

## Status
- Done (2026-02-08)

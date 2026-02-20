# Dictionaries

All dictionaries are normalized to A–Z only (no accents).

## Word Counts (A–Z only)
- English (`en.txt`): 82,566 words (min length 3, max length 12)
- English definitions (`en-definitions.json`): 70,329 words (85.18% coverage of `en.txt`)

## Sources
- English: wordlist-en_US-2020.12.07 (Hunspell dictionary derived from SCOWL). See `wordlist-en_US-2020.12.07-README.txt` for licensing and credits.
- English definitions: Princeton WordNet 3.1 via `wordnet-db`. See `wordnet-3.1-LICENSE.txt` for license text.

## How Definitions Are Built
- Run `npm run definitions:build` to (re)generate `en-definitions.json` and `en-definitions-index/`.
- Run `npm run definitions:index` to regenerate only `en-definitions-index/` from existing definitions.
- Build input: local WordNet files from `wordnet-db` (no runtime network calls).
- Runtime behavior:
  - `DEFINITIONS_MODE=memory|lazy` reads from `en-definitions.json`.
  - `DEFINITIONS_MODE=indexed` reads per-letter shards from `en-definitions-index/`.

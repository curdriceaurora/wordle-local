# Provider Import Contract (Issue #18)

## Purpose
This contract defines the provider descriptor and persisted import manifest for LibreOffice English variant sourcing.

Why this exists:
- Epic #17 needs deterministic, auditable imports.
- Downstream work (`#19`, `#21`, `#22`, `#23`, `#24`, `#26`) needs one stable contract.
- Reproducible imports require provenance (source commit + checksums + policy version).

## Scope
This contract covers MVP variants only:
- `en-GB`
- `en-US`
- `en-CA`
- `en-AU`
- `en-ZA`

MVP assumptions locked here:
- Source repository is pinned to `https://github.com/LibreOffice/dictionaries`.
- Import mode is remote fetch only.
- Allowed output character set is strict `A-Z`.

## Files
- Schema: `data/providers/provider-import-manifest.schema.json`
- Example: `data/providers/provider-import-manifest.example.json`

## Provider Descriptor
The provider descriptor identifies a single source revision and the required Hunspell files.

Required fields:
- `providerId`: `libreoffice-dictionaries`
- `variant`: one of the MVP `en-*` variants
- `repository`: `https://github.com/LibreOffice/dictionaries`
- `commit`: pinned 40-char git SHA
- `dicPath`: relative path to `.dic` file in repo
- `affPath`: relative path to `.aff` file in repo

Example:
```json
{
  "providerId": "libreoffice-dictionaries",
  "variant": "en-GB",
  "repository": "https://github.com/LibreOffice/dictionaries",
  "commit": "9c8f3c3d8f1d0f730f5f4f0e99a9dd90b3f21a11",
  "dicPath": "en/en_GB.dic",
  "affPath": "en/en_GB.aff"
}
```

## Import Manifest
Each successful import persists a manifest with source provenance and processing metadata.

Top-level required fields:
- `schemaVersion`
- `provider`
- `sourceFiles`
- `retrievedAt`
- `processing`
- `artifacts`
- `stats`

### `sourceFiles`
Contains both source files and their integrity metadata:
- `path` (relative path)
- `sha256` (64 lowercase hex chars)
- `byteSize` (positive integer)

### `processing`
Tracks policy identity used to generate runtime pools:
- `policyVersion`
- `guessPoolPolicy`
- `answerPoolPolicy`
- `allowCharacters`
- `hunspellLibrary`

### `artifacts`
References generated outputs:
- `guessPoolPath`
- `answerPoolPath`
- `generatedAt`

### `stats`
Captures counts for audit and diagnostics:
- `rawEntries`
- `expandedForms`
- `guessPoolSize`
- `answerPoolSize`
- `filteredAnswerCount`

## Validation Rules
1. Unknown properties are rejected (`additionalProperties: false` at every object level).
2. `commit` must be a full 40-character lowercase git SHA.
3. `sha256` values must be 64-character lowercase hex.
4. Paths must be relative and cannot contain traversal (`..`) or leading slash.
5. Variant must be one of the MVP allowlisted `en-*` values.
6. Repository and provider ID are fixed constants in MVP.

## Gotchas
1. Uppercase hex checksums are intentionally rejected to avoid mixed-format drift in manifests.
2. Paths are contract-level relative paths; runtime code still must sanitize filesystem joins.
3. This contract is provenance and processing metadata, not a queue/job schema.

## Hunspell Expansion Artifacts (Issue #21)
After provider fetch artifacts are verified, Hunspell expansion produces deterministic runtime inputs under:
- `data/providers/<variant>/<commit>/expanded-forms.txt`
- `data/providers/<variant>/<commit>/processed.json`

`expanded-forms.txt` contract:
- uppercase `A-Z` words only
- one word per line
- unique and sorted lexicographically
- constrained to gameplay length policy (`3-12` for current MVP)

`processed.json` contract:
- `schemaVersion`
- `variant`
- `commit`
- `sourceManifestPath` (relative path to `source-manifest.json`)
- `policyVersion`
- `counts` (`rawEntries`, `expandedForms`, `filteredOut`)
- `generatedAt` (copied from `source-manifest.json.retrievedAt` to keep reruns reproducible for identical source inputs)

## Guess + Answer Pool Policy Artifacts (Issue #22)
After Hunspell expansion, policy generation derives gameplay pools under:
- `data/providers/<variant>/<commit>/guess-pool.txt`
- `data/providers/<variant>/<commit>/answer-pool.txt`
- `data/providers/<variant>/<commit>/pool-policy.json`

Policy behavior for MVP:
- Guess pool policy: `expanded-forms` (all normalized expanded forms from `expanded-forms.txt`).
- Answer pool policy: `base-plus-irregular`.
  - Base words come from `.dic` stems (token before `/`), constrained to `A-Z` and `3-12` length.
  - Irregular words are opt-in from `irregular-answer-allowlist.txt` (same variant/commit folder) and only accepted if present in guess pool.

Why this split exists:
- Guesses should be forgiving (accept valid inflections).
- Answers should stay simpler for daily play while still allowing explicitly-curated irregular forms.

`pool-policy.json` contract:
- `schemaVersion`
- `variant`
- `commit`
- `policyVersion`
- `guessPoolPolicy` (`expanded-forms`)
- `answerPoolPolicy` (`base-plus-irregular`)
- `sourceManifestPath`
- `expandedFormsPath`
- `irregularAllowlistPath`
- `counts`:
  - `rawBaseEntries`
  - `baseWords`
  - `baseWordsFilteredOut`
  - `baseMissingFromGuessPool`
  - `irregularAllowlisted`
  - `irregularAllowlistFilteredOut`
  - `irregularAccepted`
  - `irregularMissingFromGuessPool`
  - `expandedForms`
  - `expandedFormsFilteredOut`
  - `answerPool`
- `generatedAt`

Gotchas:
1. Plurals/past tense/gerunds from Hunspell stay valid guesses but do not become answers unless explicitly allowlisted.
2. Allowlist entries that are not in guess pool are ignored and counted in metadata for auditability.
3. If base+irregular selection yields an empty answer pool, generation fails closed.

## Family-Safe Activation Filter (Issue #23)
After policy generation, answer activation applies family-safety filtering under:
- `data/providers/<variant>/<commit>/answer-pool-active.txt`
- `data/providers/<variant>/<commit>/answer-filter.json`

Filtering modes:
- `denylist-only` (default): remove words listed in `family-denylist.txt`.
- `allowlist-required` (optional strict mode): after denylist filtering, keep only words explicitly listed in `family-allowlist.txt`.

Why this stage is separate:
- It keeps lexical policy (`#22`) independent from family moderation policy.
- Families can tune safety controls without rebuilding the earlier import/expansion stages.
- Metadata provides explainability for why answer counts changed.

Input files:
- source answers: `answer-pool.txt` (from `#22`)
- denylist: `family-denylist.txt` (optional, variant+commit scoped)
- allowlist: `family-allowlist.txt` (required only when `allowlist-required` mode is selected)

`answer-filter.json` contract:
- `schemaVersion`
- `variant`
- `commit`
- `filterMode`
- `sourceAnswerPoolPath`
- `denylistPath`
- `allowlistPath`
- `counts`:
  - `inputAnswers`
  - `inputFilteredOut`
  - `denylistEntries`
  - `denylistFilteredOut`
  - `denylistMatched`
  - `allowlistEntries`
  - `allowlistFilteredOut`
  - `allowlistExcluded`
  - `activatedAnswers`
- `generatedAt`

Gotchas:
1. `allowlist-required` fails closed if the allowlist file is missing.
2. Invalid/non-`A-Z` list entries are ignored and counted in `*FilteredOut` metrics.
3. If filtering removes all candidate answers, activation fails closed to avoid silent unsafe defaults.

## Related Issues
- Epic: `#17`
- Next dependent stories: `#19`, `#21`, `#22`, `#23`, `#24`, `#26`

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
- `generatedAt`

## Related Issues
- Epic: `#17`
- Next dependent stories: `#19`, `#21`, `#22`, `#23`, `#24`, `#26`

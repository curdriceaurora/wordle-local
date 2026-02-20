## Summary
- Issue: #<issue-number>
- Scope: <one-sentence objective>
- Epic: #<epic-number>

## In Scope
- <item>
- <item>

## Out of Scope
- <item>
- <item>

## Risk Review
- Primary risks:
  - <risk>
  - <risk>
- Mitigations:
  - <mitigation>
  - <mitigation>

## Review-Nit Preflight (Required)
- [ ] Docs and schema/API constraints are consistent (or explicitly documented where enforcement differs).
- [ ] Conditional invariants are encoded (`if/then/else`) or explicitly delegated to implementation checks.
- [ ] Ambiguous wording removed (deterministic tie-breaks, ordering, and timestamp semantics).
- [ ] Redundant fields have explicit consistency rules.
- [ ] Normalization/recovery rules include invalid examples and drop behavior.
- [ ] Retention-pruned data is not misclassified as invalid-content normalization.
- [ ] Unsupported persisted schema versions are rejected (fail-closed) instead of silently normalized.
- [ ] Extra/unknown object properties trigger canonicalization so persisted JSON honors schema `additionalProperties` rules.
- [ ] JSON/file formatting conventions verified (including trailing newline for JSON files).
- [ ] `docs/review-preflight.md` checklist reviewed before requesting review.

## Validation
- [ ] `npm test`
- [ ] `npm run test:ui` (if UI touched)
- [ ] `npm run test:all` (if cross-surface behavior changed)
- Notes:
  - <what changed in tests>

## Review Focus
1. <high-risk area>
2. <policy/edge-case>
3. <compatibility concern>

## Post-Merge Learning Update (Required)
- [ ] After merge, update `docs/review-preflight.md` -> **Merged PR Learnings Log** with any review nits and the preventive rule added.

# PR Review Preflight

## Why
This project now treats review-nit reduction as a first-class quality goal. The checklist below is required before requesting review on each PR.

## Mandatory Preflight Checklist
1. Contract parity: docs, schema, and endpoint behavior describe the same constraints.
2. Enforcement clarity: if schema cannot enforce a rule, docs explicitly say implementation enforces it.
3. Deterministic wording: no ambiguous terms such as "latest" or "newest" without exact tie-break/ordering rules.
4. Conditional invariants: state-dependent fields are validated (schema or implementation).
5. Redundancy checks: duplicate facts (for example, key/date pairs) have explicit consistency rules.
6. Recovery rules: malformed or partial data behavior is explicit and testable.
7. File conventions: JSON formatting and trailing newline conventions are preserved.
8. Retention semantics: retention-pruned rows are tracked as pruning (`wasPruned`) and not mislabeled as invalid content.

## Review Comment Handling Standard
1. Triage every comment as `must-fix`, `follow-up issue`, or `decline with rationale`.
2. Reply with commit hash + validation command when code/docs changed.
3. Do not leave unresolved threads when merging.

## Merged PR Learnings Log
Update this table after every successful PR merge.
If a PR had no substantive review nits, add a row with `Nit observed = none` and `Preventive rule added = no change`.

| Date (UTC) | PR | Type | Nit observed | Preventive rule added |
| --- | --- | --- | --- | --- |
| _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

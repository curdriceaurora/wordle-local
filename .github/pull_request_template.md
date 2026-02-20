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
- [ ] Endpoint docs use exact contracts (status code + payload shape), not shorthand wording.
- [ ] Conditional invariants are encoded (`if/then/else`) or explicitly delegated to implementation checks.
- [ ] Ambiguous wording removed (deterministic tie-breaks, ordering, and timestamp semantics).
- [ ] Redundant fields have explicit consistency rules.
- [ ] Normalization/recovery rules include invalid examples and drop behavior.
- [ ] Retention-pruned data is not misclassified as invalid-content normalization.
- [ ] Unsupported persisted schema versions are rejected (fail-closed) instead of silently normalized.
- [ ] Extra/unknown object properties trigger canonicalization so persisted JSON honors schema `additionalProperties` rules.
- [ ] Dynamic map keys are protected against prototype pollution (`__proto__`/`constructor`/`prototype`); avoid `obj[userKey] = ...` on plain objects in request paths (prefer `Map` + serialization or allowlisted null-prototype containers).
- [ ] For mutating store APIs, response payloads are derived from the normalized persisted snapshot returned by the store mutation (not stale draft/callback-captured objects).
- [ ] Tests that depend on date/time use deterministic fixed timestamps or mocked timers (no real-clock dependency).
- [ ] If rate limiting/IP logic is in scope and deployment may use proxies/VPNs, `TRUST_PROXY` defaults and docs/compose guidance are explicitly verified.
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

## Copilot Review Loop
- [ ] Native Copilot auto-review with **Review new pushes** is enabled for this repository/PR flow.
- [ ] Manual Copilot refresh was not used unless intentionally requesting an additional premium review.
- [ ] PR sticky status comment (`<!-- pr-watch-status -->`) is present and reflects latest CI/review state.
- [ ] After ~5 minutes, review threads were checked (`npm run pr:nits -- --pr <number>` or equivalent API check).
- [ ] Every actionable nit has a resolution commit and thread reply, or an explicit decline rationale.

## Post-Merge Learning Update (Required)
- [ ] After merge, update `docs/review-preflight.md` -> **Merged PR Learnings Log** with any review nits and the preventive rule added.

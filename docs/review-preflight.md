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
9. Schema compatibility: unsupported persisted schema versions fail closed (no best-effort normalization/persist).
10. Canonical shape enforcement: entries with unknown properties are treated as normalization-required so persisted JSON remains schema-compliant.
11. Key safety: dynamic object keys are validated against prototype-pollution sentinels (for example `__proto__`, `constructor`, `prototype`) and/or stored in null-prototype maps.
12. Dynamic key write pattern: never write user-influenced keys via `obj[key] = value` on plain objects in request paths; use `Map` (then serialize) or strict allowlist + null-prototype container.
13. Post-normalization response source: for mutating store APIs, build response payloads from the normalized snapshot returned by the store mutation, not from draft/captured objects inside the mutator callback.
14. Deterministic time in tests: avoid real clock dependency in tests (fixed dates or mocked timers), especially for daily/leaderboard date logic.
15. Proxy-aware rate limiting: when rate limiting depends on client IP and app may sit behind a proxy/VPN/load balancer, ensure `TRUST_PROXY` behavior is explicitly set and documented for deployment defaults (compose + docs).
16. Markdown/status escaping: when generating markdown tables or bot status comments from dynamic values, escape both `\\` and `|` (plus line breaks) to avoid malformed output and encoding warnings.
17. Partial failure isolation: when one panel/API fails, avoid clearing unrelated panel state; handle profile and leaderboard fetch failures independently.
18. Request minimization: UI controls should not trigger unrelated API calls (for example, leaderboard range changes must not refresh profile summary).
19. Loading-state lockout: disable all controls that can trigger concurrent state mutations while request-path loading flags are true.
20. Fixture parity for spawned pages: Playwright pages created outside shared fixtures must explicitly apply the same timeout/navigation defaults as fixture-managed pages.
21. Endpoint docs parity: documentation and rollout guides must match exact endpoint response contracts (status code + payload shape), not shorthand text.
22. Schema identity consistency: new JSON schema `$id` values must follow existing repository domain/namespace conventions.
23. Import integrity fail-closed: remote provider fetch paths must require both expected checksums (no silent no-op verification path).
24. Atomic write resilience: JSON persistence must use unique temp paths, cleanup-on-failure, and cross-platform replace semantics when destination files already exist (including Windows rename behavior).
25. Manifest intent clarity: stage-specific manifests must avoid near-duplicate contract shapes unless fully aligned; include explicit type and unambiguous source-vs-local path fields.
26. Error-branch test parity: every new runtime error code/path added in a PR must have direct test coverage.
27. Secret comparison hardening: security-sensitive token/key checks use constant-time comparison (`timingSafeEqual`) after explicit length checks.
28. Path-boundary hardening: any user/config/provider path segment used in `path.join` is allowlisted and traversal-safe before filesystem access.
29. Locale-independent determinism: deterministic artifact outputs use code-point ordering, not locale-dependent comparators.
30. BCP47 canonicalization: language IDs preserve canonical region casing (for example `en-US`) during normalization and lookup.
31. Registry fail-closed rules: partial-invalid persisted registry entries invalidate the snapshot (no best-effort drop-and-continue).
32. Baked baseline invariants: persisted language registry must retain the required baked baseline for the current release (currently `en`).
33. Coupled field invariants: when one field implies another (for example, `hasDictionary` ↔ `dictionaryFile`), enforce the pair consistently in both schema and runtime normalization.
34. Shared provider artifacts logic: commit/path normalization, variant allowlist, and atomic file-write behavior must come from shared helpers (not duplicated across provider pipeline modules). Reuse existing boundary helpers instead of reimplementing ad-hoc `path.resolve` checks.
35. Stateful UI test isolation: any UI flow that persists profile/stats server-side must use unique per-test identities (or isolated storage) to avoid cross-run collisions and flaky assertions.
36. ARIA tab semantics: any tabbed UI must ship full role/linkage semantics (`tablist` + `tab` + `tabpanel`, `aria-controls`/`aria-labelledby`, `aria-selected`, roving `tabIndex`) and keyboard navigation (`ArrowLeft`/`ArrowRight` + `Home`/`End`).
37. A11y parity for new pages: every new top-level UI route must have an axe regression test in both default/entry and primary interactive state.
38. Session key persistence guard: when admin or sensitive keys are expected to be memory-only, UI tests must assert keys are absent from both `localStorage` and `sessionStorage`.
39. Route asset-root consistency: any HTML route that can be served from multiple roots (`public` vs `public/dist`) must resolve the full asset set (`index.html` + referenced JS/CSS) from one consistent root.
40. Startup resolution for static paths: avoid request-path `fs.existsSync` probes for static shell assets; resolve once at startup and reuse.
41. Cache policy parity: when entry HTML is `no-store` for operational safety, ensure its companion route-specific assets are explicitly covered by matching cache policy (or document intentional differences).
42. Filesystem-order determinism: any API output derived from `fs.readdir*` must be explicitly sorted before use in responses/error strings/tests.

## Automation Coverage Map
- Automated + Manual: 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42
- Manual only: 3 (deterministic wording and ambiguity review still requires human check)

## Review Comment Handling Standard
1. Triage every comment as `must-fix`, `follow-up issue`, or `decline with rationale`.
2. Reply with commit hash + validation command when code/docs changed.
3. Do not leave unresolved threads when merging.

## Copilot Review Loop
1. Enable native GitHub Copilot automatic review with **Review new pushes** in repository settings.
2. `/.github/workflows/pr-watch.yml` updates a sticky PR status comment (marker: `<!-- pr-watch-status -->`) with CI state and unresolved threads.
3. Wait ~5 minutes after each push before triage to allow Copilot comments to land.
4. Run `npm run pr:nits -- --pr <number>` to get a deterministic thread list that still needs owner response.
5. If no Copilot review appears on the current head SHA, use the manual refresh in GitHub UI (or run the manual fallback `copilot-review.yml` workflow once).
6. Do not manually refresh repeatedly on the same SHA unless you intentionally want additional premium requests.
7. For each nit: fix, validate (`npm run check` minimum), reply with commit hash, then re-trigger only when necessary.
8. Merge target is `0` unresolved actionable nits.

## Local Gate Requirement
Run `npm run check` before requesting review. ESLint + Ajv schema checks + `guardrails:nits` are required and must pass locally.

## Merged PR Learnings Log
Update this table after every successful PR merge.
If a PR had no substantive review nits, add a row with `Nit observed = none` and `Preventive rule added = no change`.

| Date (UTC) | PR | Type | Nit observed | Preventive rule added |
| --- | --- | --- | --- | --- |
| _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

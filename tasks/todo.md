# Guardrail rollout plan — post-campaign #98–#106

Reduce P1 density and round count on future PRs by codifying the patterns
reviewers caught during the #98–#106 campaign. Target outcome: a typical PR
lands in ≤3 commits, ≤1 P1, and passes all bot reviews on first push.

Self-assessment that triggered this plan lives in the conversation history of
the campaign. Headline numbers across the 9 merged PRs:

- 102 commits, 404 review threads, **18 P1s** (codex-flagged), 85 P2s
- Worst PRs by commits: #98 (32), #106 (13), #99 (19)
- Worst PRs by P1 count: #98 (9), then #100/#101/#106 (2 each)
- Most P1s clustered in shared-state code (locks, slots, ordering, races)

Strategy: cheapest interventions first. Three PRs, each independently
shippable.

## PR A — Phase 1: Quick wins

Half-day of work. Highest immediate ROI per hour, mostly process + docs.

### 1.1 Markdownlint pre-commit hook

- Add `markdownlint-cli2` to `devDependencies`.
- New `.markdownlint.json` config: enable MD022/MD032/MD040, disable
  line-length and other rules we intentionally violate.

- Extend `.husky/pre-commit` to run markdownlint on changed `.md` files only.
- New npm script `markdown:check` for CI parity.
- **Why**: round 3 of #106 was a CodeRabbit MD022 catch that any local lint
  would have caught pre-push.

### 1.2 `lib/locks.md` — concurrency primitive cheatsheet

- Single page enumerating every lock/slot/ref primitive in the codebase:
  - `dataMutationLockRef` (Promise-barrier)
  - `restoreInProgressRef` (Promise-barrier)
  - `claimDirectDataWriteSlot` (**counter, not mutex**)
  - `directDataWriteActiveRef` (counter)
  - `commitQueue` per-store (serializer)
  - `withChallengeAdminUserMutex` (cross-route Promise chain)
  - `webhookEmitInFlightRef` (counter for restore busy-check)
- For each primitive: semantics, when to use, when NOT to use, typical
  dep-injection target, known pitfalls.

- **Why**: would have prevented #105 round 3 (deadlock from over-correcting)
  and #105 round 5 (slot-counter-vs-mutex confusion).

### 1.3 `CLAUDE.md` — `## PR Quality Gates` section

Process rules that cost ~zero per PR but apply immediately:

- **Pre-PR red-team checklist**: 3-pass self-review before push, one pass
  each for codex pattern (concurrency, ordering, factual claims), Copilot
  pattern (UX/wording/cross-references), CodeRabbit pattern (lint/test
  hygiene/style).

- **PR size cap**: PRs ≥ 2000 lines must be split unless the diff is a
  single semantic unit.

- **Sequence rehearsal**: for any docs change with ordered commands,
  copy-paste each in order against a clean state before pushing.

- **Commit-message-as-evidence**: code-behavior claims in docs must be
  backed by a quoted source reference in the commit message.

### 1.4 Pre-PR red-team subagent reference

- Codify in CLAUDE.md (under PR Quality Gates) the prompt for a
  general-purpose subagent: *"What three claims here would a reviewer
  catch as wrong? What shared-state pattern looks suspicious?"* with the
  diff stuffed in.

- Reduces friction on the 1.3 process gate.

### Acceptance

- [x] `npm run markdown:check` runs and passes on existing markdown.
- [x] `npm run check` invokes the new gate.
- [x] `lib/locks.md` exists and is referenced from `server.js` near the
      relevant primitive declarations.

- [x] `CLAUDE.md` has the new `## PR Quality Gates` section.
- [x] PR opens, CI green, merged.

---

## PR B — Phase 2: Mechanical CI checks

Half-day of work. Codifies the manual verification I was doing each round
into scripts that run in `npm run check`.

### 2.1 `scripts/check-readme-claims.js`

Parses README + `docs/*.md` and verifies factual claims against the codebase:

- Every `node:X-alpine` Dockerfile reference and every Node version
  mentioned in docs must match.

- Every `docs/X.md` link resolves to a real file.
- Every route mention (`POST /api/word`, etc.) matches a registered route
  in `server.js` / `routes/*.js`.

- Every env var mentioned (`ADMIN_KEY`, `REQUIRE_ADMIN_KEY`,
  `CHALLENGE_MODE_ENABLED`, etc.) appears in `.env.example`.

- Every npm script mentioned exists in `package.json`.
- Allow `<!-- claim:skip -->` HTML escape hatch for known-safe exceptions.

### 2.2 `scripts/check-lock-bypass.js`

Grep/AST-based check for the bypass pattern:

- `writeJsonAtomic(...)` call sites not preceded by
  `await claimDirectDataWriteSlot()` and not inside a `#commit(...)`
  callback.

- Allowlist for known-safe call sites (e.g., the bootstrap-on-ENOENT path
  documented in `lib/locks.md`). Allowlist itself becomes documentation:
  every entry must include a justification comment.

### 2.3 Wire both into `npm run check`

- Add to chain after `i18n:check`, before `test`.
- New npm scripts `claims:check` and `locks:check` (so they can be run
  individually).

### Acceptance

- [ ] `claims:check` and `locks:check` both pass on current main.
- [ ] Negative tests: tampered README + tampered `lib/X.js` both fail with
      clear error messages.

- [ ] Wired into `npm run check`.
- [ ] PR opens, CI green, merged.

---

## PR C — Phase 3: Concurrency test fixtures

Day+ of work. Highest P1-prevention impact, biggest investment. Probably
deserves its own focused session.

### 3.1 `tests/helpers/concurrency-fixture.js`

Reusable harness that:

- Accepts a store-under-test and a list of operations to fire concurrently.
- Runs N parallel invocations (default N=20, configurable; supports a
  "stress" mode at N=200 for nightly runs).

- Asserts post-conditions: no operation lost, no duplicate state, store
  passes its own normalize, optional caller-provided invariants.

- Runs against real disk (not mocks) so race conditions in `#commit` and
  `commitQueue` actually surface.

- Anti-flake measures: runs each scenario 100× during fixture validation
  before the fixture itself is allowed to land.

### 3.2 Apply fixture to each shared-state store

In order of P1 density on the campaign:

1. **`backup-store`** — parallel `applyRestore` + reads + `validateArchive`.
2. **`schedule-store`** — parallel `addEntry`/`updateEntry`/`removeEntry`
   against the same date+lang.

3. **`webhook-service`** — parallel `emit` + `scheduleDelivery` +
   `executeOnce` for the same delivery.

4. **`challenge-results-store`** — parallel `createSession` (single-in-flight
   invariant) + parallel `transactionalUpdate` (drop-guess race).

5. **`challenge-config-store`** — parallel `update` racing user-side
   `createSession` (admin-vs-user TOCTOU).

6. **`notification-service`** — parallel `broadcast` with various subscriber
   states.

### 3.3 Phase 4 — self-review automation

- Pre-push refinement: for non-markdown-only pushes, run
  `claims:check + locks:check` even when `npm run check` is already running.

- New slash command `/pr-checklist` that emits the 3-pass red-team prompt
  with the current diff stuffed in (reduces friction on the CLAUDE.md
  process gate).

### Acceptance

- [ ] Fixture passes 100 consecutive runs without flake during validation.
- [ ] Each of 6 stores has at least one concurrency test.
- [ ] At least one historical P1 from the campaign reproduces in a test
      that fails on the pre-fix commit and passes on main.

- [ ] PR opens, CI green, merged.

---

## Risks + mitigations

- **Concurrency fixtures going flaky**: 100× pre-merge validation before
  any fixture lands. Don't merge a fixture with any flake.

- **`check-readme-claims.js` over-flagging**: HTML-comment escape hatch.
  Flag only with high-confidence patterns; manual review of false-positive
  rate after the first month of use.

- **CLAUDE.md rules getting ignored**: cheaper to enforce mechanically
  than via discipline. Where Phase 2/3 mechanical checks can replace a
  Phase 1 process rule, prefer the mechanical version.

## Effort summary

| Phase | Effort | P1 prevention | Round prevention |
|---|---|---|---|
| 1 — Quick wins | 2–3h | Low (process only) | High |
| 2 — Mechanical checks | 4–6h | Medium | High |
| 3 — Concurrency tests | 6–10h | **High** | Medium |
| Total | 13–20h | | |

## Status

- **PR A** — in progress (this branch: `chore/guardrails-phase-1`).
- **PR B** — pending PR A merge.
- **PR C** — pending PR B merge.

## Lessons learned (post-mortem from #98–#106 campaign)

Logged for future reference. Rules I'm asking myself to follow on the
next campaign:

1. **Read the lock graph before touching lock-adjacent code.** Most P1s
   came from misunderstanding existing primitives (slot vs mutex, who's
   holding what when).

2. **Verify doc claims against code before writing them.** "Node 18+",
   "/admin gate scope", "delete schedule.json takes effect at runtime"
   were all unverified claims that took rounds to fix.

3. **Sequence-rehearse ordered command lists.** Round 8 of #106 (P1
   ordering error) would have surfaced in 60s of self-rehearsal.

4. **Split PRs ≥ 2000 lines.** PR #98 at 5270 lines accumulated 100
   threads and 32 commits; smaller PRs in #101–#103 averaged 4 commits.

5. **Different bots have different specialties.** Codex catches P1s
   (concurrency/ordering/facts). Copilot catches UX/wording. CodeRabbit
   catches lint/style. Self-review for each style separately.

6. **Spawn a red-team subagent before pushing non-trivial PRs.** Cost
   is ~30s of LLM time; benefit is catching what the bots will catch.

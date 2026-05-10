# wordle-local — project-specific Claude rules

These rules apply only to this repo. Layered ON TOP of any user-level
CLAUDE.md.

## Concurrency

**Read [`lib/locks.md`](lib/locks.md) BEFORE touching any code that
writes to `data/` or claims a lock/slot/ref.** Most P1s in the campaign
covering PRs 98–106 came from misunderstanding existing primitives:
treating the slot counter as a mutex, deadlocking against the data
lock, observing state outside a cross-store mutex.

Quick reminders:

- `claimDirectDataWriteSlot` is a **counter, not a mutex**. Multiple
  callers can hold it at once.
- Don't claim the slot from any code path the backup/restore route
  may transitively call — `claimDirectDataWriteSlot` busy-loops on
  `dataMutationLockRef.waitForRelease()` and the backup/restore route
  holds that lock while calling `warmInScopeStores()`. Deadlock.
- Observation that drives a write must happen INSIDE the same lock
  the write happens under. Stale reads from outside the lock are the
  most common cross-store TOCTOU pattern.

## PR Quality Gates

Run these gates before opening or pushing to a PR. Most cost ~zero
per PR; cumulatively they prevent the kind of round-trip churn that
dominated the #98–#106 campaign.

### 1. Pre-PR red-team (3-pass self-review)

For any non-trivial diff, do three passes before pushing — one each
for the patterns each bot reviewer specializes in:

- **Codex pass** — concurrency, ordering errors, factual claims.
  Walk every shared-state interaction in the diff and ask: "could
  two callers race here?" Walk every doc claim in the diff and ask:
  "is this verifiable against the code?"
- **Copilot pass** — UX/wording/cross-reference consistency. Check
  that documented behavior matches what the diff actually does.
  Check that all "see X" references resolve.
- **CodeRabbit pass** — lint/test hygiene/style. Run `npm run check`
  and `npm run markdown:check` locally. Address every warning;
  don't push with known lint hits.

For diffs > ~200 lines, spawn a general-purpose subagent with the
prompt: *"Here's a diff. What three claims would a reviewer catch
as wrong? What shared-state pattern looks suspicious?"* Cost is
~30s of LLM time, payback is catching issues before they cost a
review round.

### 2. PR size cap

PRs ≥ 2,000 lines must be split unless the diff is a single
semantic unit (rare). Reference: PR #98 at 5,270 lines accumulated
100 review threads and 32 commits; PR #101–#103 at similar
complexity but smaller diffs averaged 4 commits.

If you're about to push a 2k+ line PR, stop and ask: can this be
two PRs (e.g. "add the data structure" + "wire into routes")?
Almost always yes.

### 3. Sequence rehearsal for ordered-command docs

For any docs change that adds an ordered list of commands (Quick
Start, runbook steps, locking-down recipe, etc.), copy-paste each
command in order against a clean state before pushing. Round 8 of
PR #106 was a P1 caused by writing "launch, then edit .env"
instead of "edit, then launch" — would have surfaced in 60 seconds
of self-rehearsal.

### 4. Class-wide remediation

When a reviewer flags a single instance of an issue — a misleading
phrase, a missing aria-label, a TOCTOU-style race, a doc claim that
doesn't match the code — **don't just fix that line**. Treat the
flag as a representative of a *class* of bug and grep the codebase
for the rest of the class.

Process for each finding:

1. Identify the class. Reframe the finding from "wrong at file:line"
   to "what pattern does this represent?" Examples:
   - "`/admin` gate scope claim is wrong" → class: every place a gate
     scope is described (README, docs/, code comments).
   - "Backspace key missing aria-label" → class: every special key
     button rendered by `makeKbKey` or its callers.
   - "Slot bypass in `challenge-config-store` bootstrap" → class:
     every store with an ENOENT-on-bootstrap path.
   - "MD022 violation in README:69" → class: every `.md` file in
     the repo.
2. Grep / search for the pattern. `grep -rn`, `rg`, or a subagent
   for ambiguous patterns. Inspect each match.
3. Fix all instances in the same commit (or split into a sibling
   commit if the original PR's scope can't absorb them — but never
   defer to a follow-up PR; that's how rounds 9 and 13 of #106 came
   to be).
4. Mention the class-wide sweep in the commit message: "Reviewer
   flagged X at file:line; grep across codebase found N other
   matches; all N+1 fixed."

**This is the highest-leverage process rule.** Round 6 of #106
fixed one `/admin` gate scope claim; rounds 9 and 13 fixed the
other two — three rounds for what should have been one. The
markdownlint sweep that landed alongside this rule used exactly
this pattern: CodeRabbit flagged MD022 in one file; the fix was
to clean all 32 markdown files in the repo at once.

### 5. Commit-message-as-evidence for code-behavior claims

Any docs change that asserts "X requires Y" or "the route does Z"
must back the claim with a quoted source reference in the commit
message body. Example:

> Verified against `routes/admin.js:278`:
>
> ```js
> router.get("/admin", (req, res) => {
>   res.setHeader("Cache-Control", "no-store");
>   res.sendFile(ADMIN_SHELL.indexPath);
> });
> ```
>
> No middleware — `/admin` HTML is served unauthenticated.

Forces the verification before push. Round 6 of PR #106 (`/admin`
gate scope) and rounds 9 + 13 (`/api/word` also gated, recreate vs
restart) all stem from claims I asserted without verifying first.

### 6. Mechanical pre-flight

Before opening a PR or pushing a commit:

- `npm run check` — full gate (lint, schema, i18n, markdown, tests).
- `npm run markdown:check` — runs as part of `check` but useful to
  invoke alone when iterating on docs.
- `git status` — make sure no `.env`, no large binary, no
  unintended file is staged.

## Reviewer specialization (cheat sheet)

Different bots catch different patterns. Self-review for each style
separately during the 3-pass above.

| Reviewer | Catches | Doesn't catch |
| --- | --- | --- |
| `chatgpt-codex-connector` | P1 race conditions, ordering errors, factual inaccuracies | Style / lint |
| `copilot-pull-request-reviewer` | UX, wording, cross-reference consistency, broken examples | Most P1s |
| `coderabbitai` | Markdown lint, doc style, test hygiene, license | UX / wording |

All P1 badges in the campaign came from codex. If a diff has any
shared-state interaction or any factual claim, the codex pass is
the most important.

## Workflow notes

- The repo has Husky pre-commit + pre-push hooks. Pre-commit runs
  `nit-guardrails` and (for staged `.md` files) markdownlint on the
  *staged* content — it stashes unstaged work for the lint window so
  partial commits lint exactly what's being committed. Pre-push runs
  the full `npm run check` for non-markdown-only diffs.
- For docs-only PRs, pre-push correctly skips `npm run check` and
  exits without running any other gate at push time. The pre-commit
  markdownlint already ran on each staged commit, so this skip is
  safe — but it does mean `npm run check` never re-validates the
  combined diff. Don't add docs-only changes that would only show
  up as broken when seen as a whole.
- The `tasks/todo.md` file tracks multi-PR initiatives. Update it
  as PRs land.

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

### 4. Commit-message-as-evidence for code-behavior claims

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

### 5. Mechanical pre-flight

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
  `nit-guardrails` and markdownlint on staged files. Pre-push runs
  the full `npm run check` for non-markdown-only diffs.
- For docs-only PRs, pre-push correctly skips `npm run check` and
  runs markdownlint instead. Don't override the skip.
- The `tasks/todo.md` file tracks multi-PR initiatives. Update it
  as PRs land.

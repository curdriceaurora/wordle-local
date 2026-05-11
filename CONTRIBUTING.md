# Contributing

Thanks for your interest in contributing!

## Quick Start

- Fork the repo and create a feature branch.
- Keep changes focused and include tests when behavior changes.
- Install dependencies to bootstrap local hooks:
  - `npm install`
- Run the local quality gate before pushing:
  - `npm run check`
- Run tests locally:
  - `npm test`
  - `npm run test:ui` (or `npm run test:ui:fast` for a quick check)
  - For provider/admin workflow changes, also run `npm run test:provider:ui`

## Pull Requests

- Describe the user impact and any UI changes.
- Include screenshots or recordings for UI tweaks when helpful.
- Call out any follow-up work or known limitations.
- Use the repository PR template.
- Complete the mandatory preflight in `docs/review-preflight.md` before requesting review.
- After merge, add an entry to `docs/review-preflight.md` under **Merged PR Learnings Log** for any review nits and preventive rule updates.

## Supply-Chain Pinning

Both the Dockerfile base image and every GitHub Actions `uses:` reference are pinned to immutable SHAs so the build/CI graph is reproducible and supply-chain-safe.

Refresh cadence: **quarterly, or sooner if a security advisory affects a pinned action/image.** Refresh process:

- **Dockerfile** — query `https://hub.docker.com/v2/repositories/library/node/tags/20-alpine/` for the current `digest`, update the `FROM node:20-alpine@sha256:...` line (both stages), and update the `# digest fetched YYYY-MM-DD` comment.
- **GitHub Actions** — for each `uses: vendor/action@<sha> # vN` line, query `repos/vendor/action/git/refs/tags/vN` via `gh api` and paste the new SHA. Keep the `# vN` trailing comment so the version intent stays visible.

Renovate/Dependabot isn't currently wired up; manual quarterly refresh is sufficient for this repo's scale. If pinning churn becomes annoying, file a follow-up to add a Dependabot config restricted to GH Actions + Dockerfile.

### npm audit baseline

`npm run check` (via `audit:check`) fails CI on any new `npm audit` advisory that isn't listed in `.audit-baseline.json`. The baseline is a list of accepted-risk advisories (by GHSA id) plus rationale for each.

When CI surfaces a new advisory, you have two paths:

- **Fix it.** `npm update <pkg>`, `npm audit fix`, or pin a different package. CI clears once the GHSA disappears from `npm audit --json`.
- **Bless it.** Add a new entry to `.audit-baseline.json` with `ghsa`, `package`, `severity`, `title`, and a written `rationale` for why the risk is acceptable here (transitive-only, dev-only, not exposed to untrusted input, etc.). Reviewers should treat baseline additions as security decisions — comment on the PR with the threat model.

When an advisory eventually gets fixed in our dependency tree, its baseline entry becomes dead. The next person who touches the baseline removes it.

## License and Rights

By submitting a contribution, you agree to dedicate your work to the public domain under CC0‑1.0. You represent that you have the right to do so and that your contribution does not infringe on third‑party rights.

## Code of Conduct

By participating, you agree to follow the Code of Conduct in `CODE_OF_CONDUCT.md`.

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
- Use deterministic wording for ordering, timestamps, and tie-breaks;
  avoid ambiguous claims such as "latest" without defining the order.
- Resolve actionable review threads before merge.

## Supply-Chain Pinning

Both the Dockerfile base image and every GitHub Actions `uses:` reference are pinned to immutable SHAs so the build/CI graph is reproducible and supply-chain-safe.

### Renovate automation (closes #202)

SHA refreshes are automated by Renovate (config: `.github/renovate.json`). Cadence + escalation contract:

- **Weekly sweep**: every Monday before 6am UTC, Renovate opens PRs for any Dockerfile base-image SHA bump or GitHub Actions `uses:` SHA bump that has a newer digest upstream.
- **Auto-merge** on green CI for: patch + minor + digest-only bumps to GitHub Actions, Dockerfile base images, npm dev-dependencies, and npm runtime-dependency patches. The `docker-build` CI job (`.github/workflows/ci.yml`) builds the production image and smoke-tests `/api/health` on every PR, so a Dockerfile base-image bump is actually exercised before it's allowed to auto-merge.
- **Human review** required for: any major bump (semver-major upgrade), npm runtime-dependency minors (subtle behavior shifts the test suite may not exercise), `esbuild` (a devDependency, but it's the asset bundler the Dockerfile's production build depends on — `npm run check` doesn't exercise that path, only `docker-build` does), lock-file-maintenance PRs (can touch many transitive packages across both dev and prod scope in one PR), and any dependency-dashboard request flagged by Renovate.
- **Out-of-band**: vulnerability advisories bypass the Monday schedule and queue immediately. Still requires green CI to merge.
- **Concurrent PR cap**: 10 open Renovate PRs at a time so review attention isn't dominated by automation.

The JSON file's `$schema` reference enables editor IntelliSense but does NOT validate it. `.github/renovate.json` changes are checked in CI (the `test` job's `Validate Renovate Config` step, gated on changes to that file) by running:

```bash
npm run renovate:check
```

This invokes `renovate-config-validator` via `npx --package=renovate` (no install required; downloads on demand). Run it locally before pushing config changes too — CI catches it either way, but a local run is faster feedback.

### Manual refresh (fallback)

If Renovate is unavailable for any reason, the manual refresh process is:

- **Dockerfile** — query `https://hub.docker.com/v2/repositories/library/node/tags/20-alpine/` for the current `digest` and update the `FROM node:20-alpine@sha256:...` line (both stages).
- **GitHub Actions** — for each `uses: vendor/action@<sha> # vN` line, query `repos/vendor/action/git/refs/tags/vN` via `gh api` and paste the new SHA. Keep the `# vN` trailing comment so the version intent stays visible.

### npm audit baseline

`npm run check` (via `audit:check`) fails CI on any new `npm audit` advisory that isn't listed in `.audit-baseline.json`. The baseline is a list of accepted-risk advisories keyed by `(GHSA id, package)` pair, plus rationale for each — the same GHSA against a different package requires its own entry.

When CI surfaces a new advisory, you have two paths:

- **Fix it.** `npm update <pkg>`, `npm audit fix`, or pin a different package. CI clears once the GHSA disappears from `npm audit --json`.
- **Bless it.** Add a new entry to `.audit-baseline.json` with the full triage context (every field is required; the gate refuses to load a partial entry):
  - `ghsa`, `package`, `severity`, `title` — identification fields.
  - `nodes` — the current dependency paths from `npm audit --json`'s `vulnerabilities.<pkg>.nodes`. Non-empty. The gate requires the current audit's `nodes` for this advisory to be a subset of the listed paths; a new path fails the gate.
  - `scope` — one of `"dev"`, `"prod"`, or `"both"`. The dependency-tree context the bless applies to. The gate runs `npm audit --omit=dev` and infers current scope (`prod` if the advisory still appears, else `dev`). If a baseline says `"dev"` but the advisory now reaches us via a runtime dep, the gate fails with a "scope escalation" error and re-triage is required. Verify with `npm audit --omit=dev` before adding the entry.
  - `rationale` — why this is acceptable risk (transitive-only, dev-only, not exposed to untrusted input, etc.). Reviewers should treat baseline additions as security decisions — comment on the PR with the threat model.

When an advisory eventually gets fixed in our dependency tree, its baseline entry becomes dead. The next person who touches the baseline removes it.

### Prototype-pollution AST gate

`npm run proto:check` (wired into `npm run check`) walks every `.js` file under `routes/`, `lib/`, and `server.js` with `acorn` and flags any `obj[expr] = value` site where the key isn't a known-safe shape (string/number literal, array-index identifier, arithmetic on the above) AND the destination isn't a null-prototype container (`Object.create(null)`, `{__proto__: null, ...}`, `Object.assign(Object.create(null), {...})`, `new Uint8Array(...)`, `Buffer.alloc(...)`). The full list of recognized shapes is documented at the top of `scripts/check-proto-pollution.js`.

When the gate fails, fix the offending site by either:

- Routing the key through a sentinel check (e.g., `if (UNSAFE_OBJECT_KEYS.has(key))` — pattern in `lib/leaderboard-store.js`).
- Constructing the destination as `Object.create(null)` (or `Object.assign(Object.create(null), { defaults })` if you need initial keys).
- Switching to a `Map` (then serialize via `Object.fromEntries(...)` if persisting JSON).
- Adding the site to `ALLOWLIST_SITES` in `scripts/check-proto-pollution.js` with a written rationale and a substring signature that matches the offending line. Reviewers should treat allowlist additions as security decisions — comment on the PR with the threat model.

### Client-side HTML rendering

The admin and player shells render all dynamic content via `node.textContent = value` (or DOM-construction APIs — `createElement` + `appendChild`). Bare `element.innerHTML = value` is prohibited when `value` is anything other than an empty-string literal.

A guardrail in `scripts/nit-guardrails.js` flags new `innerHTML =`/`outerHTML =`/`insertAdjacentHTML(...)` sinks in `public/admin/app.js` and `public/app.js`. If a future feature genuinely needs HTML insertion (e.g., styled markup with embedded tags), route the value through `window.escapeHtml` (loaded from `/js/escape-html.js`, source at `public/js/escape-html.js`) AND add the call site to the audited allowlist in `nit-guardrails.js`. The Playwright `tests/ui/xss-lockin.spec.js` spec covers the helper and the `?word=` URL-param path; extend it whenever you add a new user-controlled render path.

## License and Rights

By submitting a contribution, you agree to dedicate your work to the public domain under CC0‑1.0. You represent that you have the right to do so and that your contribution does not infringe on third‑party rights.

## Code of Conduct

By participating, you agree to follow the Code of Conduct in `CODE_OF_CONDUCT.md`.

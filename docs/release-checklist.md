# Release Checklist

Use this checklist before tagging or publishing a release.

## Build and quality gates

1. Run `npm run check`.
2. For provider/admin changes, run `npm run test:provider:ui`.
3. Run `npm run test:all`.
4. Confirm CI is green on the release PR branch.

## Security and runtime baseline

1. Confirm `.env.example`, `README.md`, and `advanced-settings.md` are consistent.
2. Confirm Docker image includes `LICENSE` and `THIRD_PARTY_NOTICES.md`.
3. Confirm rate-limit/proxy guidance is documented for deployment topology (`TRUST_PROXY` behavior).
4. For admin/provider releases, review `docs/admin-security-checklist.md`.
5. Confirm graceful-shutdown is configured for the deployment topology. The process responds to `SIGTERM` and `SIGINT` by closing the HTTP listener, draining in-flight requests, stopping the schedulers, waiting for any active backup-restore, draining the webhook worker pool, and flushing every store's writeQueue / commitQueue. Total drain budget defaults to 30s — override via `SHUTDOWN_TIMEOUT_MS` if your supervisor's SIGKILL window is shorter (Docker's default is 10s, so either bump the supervisor's `stop_grace_period` to ≥35s or lower `SHUTDOWN_TIMEOUT_MS` so the process exits before SIGKILL).

## Leaderboard rollout gate

1. Review `docs/server-leaderboard-rollout.md`.
2. Confirm the release notes explicitly call out:
   - server-backed stats storage in `data/leaderboard.json`
   - no migration/import from legacy browser `localStorage` stats
   - expected cross-device shared leaderboard behavior
3. Confirm contract expectations still match implementation:
   - `docs/leaderboard-data-contract.md`

## Documentation gate

1. Ensure `README.md` reflects current shipped behavior (not roadmap assumptions).
2. Ensure roadmap items are exploratory only and do not duplicate already shipped features.
3. Ensure any operational gotchas discovered in PR review are captured in docs.

## Provider sourcing rollout gate

1. Review `docs/provider-rollout-checklist.md`.
2. Confirm release notes include:
   - supported provider variants (`en-GB`, `en-US`, `en-CA`, `en-AU`, `en-ZA`)
   - source provenance requirements (pinned commit + required checksums)
   - fail-closed behavior when provider import artifacts are incomplete
3. Confirm CI run includes the provider UI regression gate when provider/admin files changed.

## Load baseline (C5 / #131)

`scripts/load-test.js` is a self-contained load runner that drives a
locally-running server against three scenarios and reports RPS +
latency percentiles. Use it before each release on a reference
machine to detect throughput regressions.

### Running

`BASE_URL` is the load-runner's target URL — it's NOT a server-side
env var; the runner reads it from its own process environment. It's
documented in `.env.example` for discoverability.

```bash
# Terminal 1 — start the server with production-ish flags:
ADMIN_KEY=secret REQUIRE_ADMIN_KEY=true NODE_ENV=production \
  PORT=3000 node server.js

# Terminal 2 — drive the load:
BASE_URL=http://localhost:3000 ADMIN_KEY=secret \
  node scripts/load-test.js --duration=15 --concurrency=8

# Or just one scenario:
BASE_URL=http://localhost:3000 \
  node scripts/load-test.js --scenario=player-read --duration=30
```

Output is JSON to stdout (also writable to `--output=path.json`).

### Scenarios

- **player-read** — random GET across `/api/meta?lang=en` and
  `/api/stats/leaderboard?lang=en&range=7d`. Both are PUBLIC routes
  (no admin auth). Exercises helmet, request-id middleware, rate
  limiter, in-flight counter, and per-store snapshot read. No
  `ADMIN_KEY` needed.
- **admin-auth** — random GET across `/api/admin/providers` and
  `/api/admin/jobs`. Exercises the admin auth gate + admin rate
  limiter + structured logger. Read-only (no writes performed —
  exercising real writes would need a body crafted per endpoint
  and would mutate live state). Requires `ADMIN_KEY` env var; fails
  fast if absent.
- **mixed** — 10:1 ratio of player-read to admin-auth. Approximates
  a moderate-traffic deployment with periodic admin checks. Also
  requires `ADMIN_KEY`; refuses to run without one rather than
  silently downgrading to player-read.

### Interpreting the output

The JSON report has a top-level `scenarios[]` array with one entry
per scenario. Key fields:

- `requests` — total requests fired during the scenario window
  (warmup + measured).
- `sampledRequests` — count of measured requests (post-warmup).
- `rps` — sampled-requests / measured-window (excludes warmup).
- `latencyMs.p50`, `.p95`, `.p99` — percentile latencies in ms.
- `statusCodes` — distribution of HTTP status codes observed.
- `errorRate` — fraction of requests that failed to receive a
  response (network errors, timeouts) — NOT 4xx/5xx, which are
  surfaced in `statusCodes`.

### Recording a baseline

Run the load test on the reference machine for each release and
paste the report into the release notes (or attach as
`baseline-<release-tag>.json`). A regression alarm fires when:

- `rps` drops > 20% from the previous baseline.
- `latencyMs.p95` increases > 50% from the previous baseline.
- `errorRate` > 0.01 (1%) at the configured concurrency.

Numbers are machine-dependent — comparison is only meaningful
across runs on the same hardware.

### Out of scope (per #131)

- Distributed load testing (single-machine only).
- Stress-to-failure (the point is a healthy-state baseline, not a
  breaking-point).
- Cross-version comparison harness (operator records baselines per
  reference machine; comparison is by-hand).

# Perf Follow-up Report

Date: 2026-02-20
Scope: post-PR #4 follow-up optimization pass for `/api/guess` hot path and leaderboard rendering.

## Method
- Benchmark command: `npm run perf:server:modes`
- Options: `iterations=500`, `warmup=80`, `concurrency=12`
- Modes: `memory`, `lazy`, `indexed`
- Workload: repeatedly solve an English puzzle (`CRANE`) so definition lookup and guess evaluation run on each request.
- Note: this is a local micro-benchmark; results should be compared directionally (run-to-run variance is expected).

## Baseline (Before This Pass)
Run timestamp: `2026-02-20T03:14:23.665Z`

| Mode | p95 (ms) | p99 (ms) | Throughput (req/s) | RSS delta warmup | RSS delta run |
| --- | ---: | ---: | ---: | ---: | ---: |
| memory | 5.09 | 6.59 | 4656.09 | 2.41 MB | 35.52 MB |
| lazy | 2.58 | 4.82 | 5915.70 | 117.64 MB | 11.11 MB |
| indexed | 3.80 | 5.31 | 5212.48 | 114.45 MB | 33.98 MB |

## After Optimization
Run timestamp: `2026-02-20T03:15:48.940Z`

| Mode | p95 (ms) | p99 (ms) | Throughput (req/s) | RSS delta warmup | RSS delta run |
| --- | ---: | ---: | ---: | ---: | ---: |
| memory | 2.72 | 4.61 | 6182.61 | 1.72 MB | 22.41 MB |
| lazy | 2.53 | 4.52 | 5994.31 | 118.30 MB | 10.73 MB |
| indexed | 2.33 | 4.60 | 6275.50 | 110.80 MB | 21.13 MB |

## Delta (After - Baseline)

| Mode | p95 change | Throughput change | RSS run delta change |
| --- | ---: | ---: | ---: |
| memory | -46.56% | +32.79% | -13.11 MB |
| lazy | -1.94% | +1.33% | -0.38 MB |
| indexed | -38.68% | +20.39% | -12.85 MB |

## Changes Applied
- Server hot path:
  - Reworked `evaluateGuess()` to a two-pass frequency-count algorithm using fixed-size letter counters.
  - Removed nested inner scan and avoided per-request `answer.split("")`.
- UI render path:
  - Updated leaderboard row rendering to use a `DocumentFragment` and one append operation.
  - Kept cache invalidation semantics (`version`, `range`, `dayKey`) unchanged.
- Coverage:
  - Added duplicate-letter correctness tests for guess evaluation (multiple repeated-letter scenarios).

## Validation
- `npm test`
- `npm run test:ui`
- `npm run test:all`
- `npm run perf:server:modes`

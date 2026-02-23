# Admin Platform Architecture + Data Contracts

This document is the decision record for issue #7.

## Why This Exists
The Admin Platform scope has drifted across Epic #6 and Epic #17. Without a locked contract, later work (`#9`, `#13`) will keep re-deciding file formats, config precedence, and queue behavior. This record freezes those choices so deferred work can restart without redesigning fundamentals.

## Scope
In scope for this decision record:
- Data contract definitions for `languages.json`, `admin-jobs.json`, and `app-config.json`.
- Runtime config precedence rules.
- Queue lifecycle semantics and restart behavior.
- Backward compatibility and migration constraints.

Out of scope:
- Implementing queue execution (`#9`).
- Implementing admin settings UI (`#13`).
- Runtime behavior changes in gameplay APIs.

## System Boundaries
- Runtime gameplay remains server-owned (`/api/puzzle`, `/api/guess`, `/daily`).
- Admin writes are explicit and authenticated via `x-admin-key` on `/api/admin/*`.
- Persisted state is file-backed and local-node only.
- Provider imports are write-heavy operations and must fail closed on malformed metadata.

## Data Contract Files

| File | Purpose | Status | Schema |
| --- | --- | --- | --- |
| `data/languages.json` | Active language registry used by runtime/meta APIs | Active | `data/languages.schema.json` |
| `data/admin-jobs.json` | Persisted queue/job ledger for admin processing (deferred implementation) | Contract locked, runtime deferred | `data/admin-jobs.schema.json` |
| `data/app-config.json` | Persisted runtime-safe override layer for admin settings (deferred implementation) | Contract locked, runtime deferred | `data/app-config.schema.json` |

Examples are provided for tooling validation:
- `data/admin-jobs.example.json`
- `data/app-config.example.json`

## Runtime Config Precedence (Locked)
Order of precedence is deterministic:
1. **Hard environment controls (highest priority)**
- Security-critical and deployment-scoped values from environment variables always win.
- Examples: `ADMIN_KEY`, `REQUIRE_ADMIN_KEY`, `TRUST_PROXY`, rate-limit envs.

2. **Persisted override layer (`data/app-config.json`)**
- Applies only to whitelisted, runtime-safe keys.
- Any unknown key or invalid value is rejected (schema + server-side allowlist).

3. **Code defaults (lowest priority)**
- Used when neither env nor valid persisted override is present.

Why: this keeps local admin UX flexible without letting UI writes silently weaken deployment safety controls.

## Queue Lifecycle Semantics (Locked for #9)
Queue contract applies when `#9` is implemented.

Job states:
- `queued` -> `running` -> `succeeded | failed | canceled`

Operational rules:
- Single writer model for `data/admin-jobs.json` with atomic file replacement.
- `running` jobs found at process startup are recovered to `queued` with incremented attempt metadata (no silent drop).
- `succeeded` jobs are immutable except retention pruning.
- `failed` jobs keep structured error payload (`code`, `message`) for admin diagnostics.

Why: this prevents orphaned in-flight jobs after restarts and preserves operator-visible failure history.

## Backward Compatibility + Migration Constraints
- Baked `en` must always exist in language registry defaults.
- Registry recovery must be fail-safe: missing/corrupt `data/languages.json` regenerates baked baseline.
- Schema version fields are mandatory and monotonic (`version: 1` now).
- Unknown fields are rejected (`additionalProperties: false`) to prevent silent config drift.
- Future migrations must be explicit, one-way, and logged in release notes.

## Pitfalls To Avoid
- Treating persisted config as equal priority with env variables (can unintentionally weaken security posture).
- Allowing queue/job payloads to store raw upload content (store references/checksums only).
- Accepting absolute or traversing relative paths in any persisted artifact path field.
- Expanding deferred scope (`#9`, `#13`) before demand signals justify complexity.

## Concrete Examples

`data/admin-jobs.example.json`:
```json
{
  "version": 1,
  "updatedAt": "1970-01-01T00:00:00.000Z",
  "jobs": []
}
```

`data/app-config.example.json`:
```json
{
  "version": 1,
  "updatedAt": "1970-01-01T00:00:00.000Z",
  "overrides": {
    "definitions": {
      "mode": "memory",
      "cacheSize": 512,
      "cacheTtlMs": 1800000,
      "shardCacheSize": 6
    },
    "limits": {
      "jsonBodyLimit": "12mb",
      "providerManualMaxFileBytes": 8388608
    },
    "security": {
      "trustProxy": null,
      "trustProxyHops": null,
      "adminRateLimit": {
        "windowMs": 900000,
        "max": 90,
        "writeWindowMs": 900000,
        "writeMax": 30
      }
    }
  }
}
```

## Re-entry Criteria For Deferred Work
- `#9` queue work resumes only if import concurrency/reliability requirements exceed single-import mutex behavior.
- `#13` settings UI resumes only after concrete operator demand for runtime overrides beyond env-file workflows.

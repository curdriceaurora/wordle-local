# Webhooks

Outbound HTTP notifications for admin-significant events. Subscribers
receive a signed JSON `POST` whose body the recipient should verify with
HMAC-SHA-256 before trusting the payload.

The dispatcher is **disabled by default**. Subscriptions can still be
created, edited, and persisted at any time, but no requests are sent until
the operator restarts the server with `WEBHOOKS_ENABLED=true`.

## Event catalog

| Event                          | When fired                                                                                              | Payload fields                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `provider.import.completed`    | After a provider import (sync or async) succeeds.                                                       | `jobId`, `variant`, `commit`, `sourceType`, `filterMode`, `counts`, `artifacts` |
| `provider.import.failed`       | After a provider import (sync or async) fails. Errors are logged and re-emitted, never silenced.        | `jobId`, `variant`, `sourceType`, `error`                                     |
| `webhook.test`                 | When an operator clicks **Test** in the admin Webhooks tab. Used to verify endpoint reachability.       | `message`, `subscriptionId`, `requestedAt`                                    |

`jobId` is `null` for sync imports (the synchronous path doesn't enqueue a
record into `data/admin-jobs.json`).

## Request format

The dispatcher sends `POST <subscription.url>` with these headers:

| Header                  | Value                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `content-type`          | `application/json`                                                                     |
| `user-agent`            | `wordle-local-webhook/1`                                                               |
| `x-webhook-id`          | The delivery's id (base64url, ≤ 64 chars). Stable across retries.                       |
| `x-webhook-event`       | The event name (e.g. `provider.import.completed`).                                     |
| `x-webhook-timestamp`   | ISO-8601 timestamp of the attempt.                                                     |
| `x-webhook-attempt`     | 1-indexed attempt counter. Increments on every retry.                                  |
| `x-webhook-signature`   | `sha256=<hex>` HMAC-SHA-256 of the full request body, keyed with the subscription secret. |

The body is a JSON object:

```json
{
  "id": "<delivery id>",
  "event": "<event name>",
  "timestamp": "<ISO-8601>",
  "attempt": 1,
  "payload": { ... event-specific fields ... }
}
```

## Verifying the signature

The recipient should recompute the HMAC over the **raw request body**
(not the parsed JSON) using the subscription secret and compare it with
`x-webhook-signature` using a constant-time comparison.

### Node.js example

```js
const crypto = require("node:crypto");

function verify(rawBody, headerValue, secret) {
  const expected = "sha256=" + crypto.createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  // Buffer.byteLength check guards timingSafeEqual against length-mismatch throw
  if (Buffer.byteLength(headerValue) !== Buffer.byteLength(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(headerValue), Buffer.from(expected));
}
```

### Python example

```python
import hmac, hashlib

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(
        secret.encode("utf-8"), raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(header, expected)
```

## Outbound-call retry/timeout audit

Three outbound-call paths in this codebase. Snapshot of each as of
B6 / #125:

| Path | File:lines | HTTP client | Timeout | Retry | Intervals | Jitter | Concurrency cap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Webhook delivery** | `lib/webhook-service.js` | Node `fetch` (optional undici) | `WEBHOOK_REQUEST_TIMEOUT_MS` (default 10s) | Per-sub `maxAttempts` (default 5) | `[1s, 5s, 30s, 2m, 10m]` | 0–25% additive (B6) | `WEBHOOK_GLOBAL_INFLIGHT_LIMIT=4` for in-flight; `WEBHOOK_MAX_CONCURRENT_RETRIES=16` for retry budget (B6) |
| **Provider artifact fetch** | `lib/provider-fetch.js:97-171` | Node `fetch` | `DEFAULT_FETCH_TIMEOUT_MS=15s` | Single-shot (admin can re-upload) | n/a | n/a | None (single per-import event) |
| **Web-push send** | `lib/notification-service.js:110-141` | `web-push` npm | Delegated to library | Fire-and-forget; next daily fire retries | n/a | n/a | `maxConcurrent` worker pool (default 8) |

Web-push deliberately does NOT retry within a single fire — failure
modes are tracked via `failureStreak` and the next daily fire
retries. See `docs/notifications.md` for the failure-mode table.
Provider fetch is admin-initiated and re-invokable; adding retry
there would mask transient errors operators need to see.

## Retries and backoff

Failed deliveries are retried with exponential backoff. The default
schedule is `[1s, 5s, 30s, 2m, 10m]`. Each subscription has its own
`maxAttempts` (default 5, 1–20) and the dispatcher stops once that is
reached, marking the delivery as `failed`. An admin can manually retry a
failed delivery from the Webhooks tab.

A `Retry-After` header on the response (numeric seconds OR HTTP-date) is
honored, but capped at 10 minutes so a misbehaving recipient cannot
strand a delivery forever.

### Jitter (B6 / #125)

The retry schedule above is the BASE; every retry interval has 0–25%
additive random jitter applied on top. So an attempt-3 retry whose
base slot is 30s lands somewhere in `[30s, 37.5s]`. A fleet of
deliveries all failing at the same moment (e.g., the upstream
endpoint returned 503 for everyone) therefore smears the next attempt
across a 7.5-second window rather than synchronously hammering the
upstream as it tries to recover.

Jitter is `Math.floor(base * 0.25 * Math.random())` — pure additive,
never below the base. The thundering-herd argument is one-sided:
jittering above the base is always safe; jittering below would let a
delivery retry sooner than the operator configured, which we treat
as a contract violation.

### Aggregate retry-budget cap (B6 / #125)

In addition to the per-subscription `maxAttempts` cap, the dispatcher
enforces a **system-wide cap on concurrent retrying deliveries**.
Each delivery sitting in its inter-retry backoff sleep counts against
`WEBHOOK_MAX_CONCURRENT_RETRIES` (default 16). When a new attempt
fails and would enter retry state but the budget is full, the
delivery is marked `failed` with `lastError: "retry budget exhausted
(>=N retries inflight)"` and an operator-visible `[webhook] retry
budget exhausted` warn-log fires.

This caps memory and timer usage during a system-wide upstream
outage — without it, every failing delivery would queue an
indefinitely-extending retry timer, blowing the timer table and
delaying graceful shutdown. The default (16 = 4x `globalInflight=4`)
gives ample headroom for normal transient errors while still capping
a runaway.

If you observe `retry budget exhausted` logs and no upstream outage,
either raise the env var or investigate why so many deliveries are
piling up at once.

### HTTP status classification

| Status range            | Outcome                                              |
| ----------------------- | ---------------------------------------------------- |
| `2xx`                   | success — delivery marked `succeeded`                |
| `408`, `429`            | retriable — schedule next attempt with backoff       |
| `4xx` (other)           | non-retriable — delivery marked `failed` immediately |
| `5xx` and network errors | retriable                                            |

## SSRF guard

Outbound URLs are checked before the request is sent. The default policy
**rejects**:

- IPv4 in RFC1918 (`10/8`, `172.16/12`, `192.168/16`), loopback (`127/8`), link-local (`169.254/16`), and `0.0.0.0`
- IPv6 loopback (`::1`), link-local (`fe80::/10`), unique-local (`fc00::/7`)
- IPv4-mapped IPv6 forms of the above (e.g. `::ffff:10.0.0.1`)
- Hostnames whose DNS resolution returns ANY private/loopback address (verbatim, both A and AAAA records)

Set `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true` to bypass this guard for local
development. **Do not enable this in production** — it allows the
webhook dispatcher to reach the cloud-metadata service (`169.254.169.254`)
and any internal service reachable from the host.

## Restart recovery

Deliveries left in `running` (the previous process died mid-flight) or
`queued` (the in-memory timer was lost) at boot are requeued
automatically. `running` rows get a 1-second backoff to avoid
hammering the recipient if the prior process died from a crash loop;
`queued` rows honor their persisted `nextAttemptAt`.

## Storage

| File                                | Schema                                | Retention                                                         |
| ----------------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| `data/webhooks.json`                | `data/webhooks.schema.json`           | All subscriptions; bounded by operator action (no auto-eviction). |
| `data/webhook-deliveries.json`      | `data/webhook-deliveries.schema.json` | Capped at `WEBHOOK_DELIVERY_HISTORY_MAX` rows (default 200).      |

Both files are part of the standard backup/restore set. Restoring from a
backup also restores webhook subscriptions and recent deliveries.

## Environment variables

| Var                                | Default | Range            | Purpose                                                              |
| ---------------------------------- | ------- | ---------------- | -------------------------------------------------------------------- |
| `WEBHOOKS_ENABLED`                 | `false` | bool             | Master switch. Off → emits are no-ops.                               |
| `WEBHOOK_REQUEST_TIMEOUT_MS`       | `10000` | 1000–60000       | Per-attempt fetch timeout.                                           |
| `WEBHOOK_MAX_BODY_BYTES`           | `65536` | 1024–1048576     | Max bytes captured from the response body for `responseSnippet`.     |
| `WEBHOOK_DELIVERY_HISTORY_MAX`     | `200`   | 10–10000         | Retention cap for `data/webhook-deliveries.json`.                    |
| `WEBHOOK_MAX_ATTEMPTS_DEFAULT`     | `5`     | 1–20             | Default `maxAttempts` for new subscriptions.                         |
| `WEBHOOK_GLOBAL_INFLIGHT_LIMIT`    | `4`     | 1–64             | Concurrent in-flight delivery cap across all subscriptions.          |
| `WEBHOOK_MAX_CONCURRENT_RETRIES`   | `16`    | 1–256            | Aggregate retry-budget cap (B6 / #125). See *Aggregate retry-budget cap* above. |
| `WEBHOOK_ALLOW_PRIVATE_NETWORKS`   | `false` | bool             | Bypass SSRF guard. Local dev only — never enable in production.      |
| `WEBHOOKS_STORE_PATH`              | `data/webhooks.json` | path | Override the subscription store location (e.g. for tests). |
| `WEBHOOK_DELIVERIES_STORE_PATH`    | `data/webhook-deliveries.json` | path | Override the delivery store location.            |

## Admin API

All endpoints sit under `/api/admin/webhooks` and require the admin key
when `REQUIRE_ADMIN_KEY=true` (the production default). All write paths
acquire the data-mutation slot so they are serialized against backup and
restore.

| Method | Path                                                   | Notes                                                                             |
| ------ | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| GET    | `/api/admin/webhooks`                                  | List subscriptions (secrets redacted).                                            |
| POST   | `/api/admin/webhooks`                                  | Create a subscription. **Returns the secret one-time** in the response.            |
| PATCH  | `/api/admin/webhooks/:id`                              | Edit fields. Pass `rotateSecret: true` to issue a new secret (revealed in response). |
| DELETE | `/api/admin/webhooks/:id`                              | Delete a subscription and cascade its delivery rows.                              |
| POST   | `/api/admin/webhooks/:id/test`                         | Queue a `webhook.test` event for that subscription.                               |
| GET    | `/api/admin/webhooks/:id/deliveries?limit=&status=&event=` | Recent deliveries (newest first; `limit` 1–500, default 50).                  |
| POST   | `/api/admin/webhooks/:id/deliveries/:deliveryId/retry` | Manually retry a `failed` delivery.                                               |

Audit log entries are emitted on every write under
`[webhook] subscription.create`, `subscription.update`,
`subscription.delete`, `subscription.test`, and `delivery.retry`. The
`actor` field is the SHA-256 fingerprint of the admin key (first 12 hex
chars), never the key itself.

# ADMIN_KEY rotation runbook

How to rotate the `ADMIN_KEY` env var without downtime, with a
dual-accept window so requests authenticated by the old or the new
key both succeed during the rolling restart.

Closes #204 (A6 follow-up).

## When to rotate

- Suspected leak (key exposed in a log, sent to the wrong recipient,
  copied to an untrusted host).
- Operator handover (a person who knew the key is leaving access).
- Aged credential (≥ 90 days since last rotation, per
  [`docs/security/`](.) policy).

## What the dual-accept window does

The admin auth gate (`lib/admin-auth.js`) accepts EITHER the
current `ADMIN_KEY` OR a configured `ADMIN_KEY_PREVIOUS` while
`Date.now() < ADMIN_KEY_ROTATION_EXPIRES_AT`. After the timestamp
passes, only the current key is accepted.

This lets you roll out a new key across N nodes without a
synchronous flip: each request authenticated by either key
succeeds for the duration of the window, regardless of which
node received it.

When the previous key is the one that authenticated a request, the
server emits a structured log event:

```json
{
  "level": "info",
  "msg": "admin.auth.previous_key_used",
  "msRemaining": 42137,
  "expiresAt": "2026-06-01T00:00:00.000Z",
  "requestId": "<uuid>",
  "method": "GET",
  "path": "/api/admin/jobs"
}
```

No secret value is logged (verified by `tests/admin-auth.test.js`).
The event is your signal that the rotation is being exercised —
spike in volume = clients still using the old key; flat zero in
the final hours of the window = safe to retire.

## Procedure

### Phase 1 — open the rotation window

Set THREE env vars on every node:

```bash
export ADMIN_KEY=<new key>                       # e.g. fresh 32 random bytes
export ADMIN_KEY_PREVIOUS=<old key>              # the value you're retiring
export ADMIN_KEY_ROTATION_EXPIRES_AT=<ISO-8601>  # future timestamp
```

Choose `ADMIN_KEY_ROTATION_EXPIRES_AT` based on your rolling-restart
cadence. 60 seconds is the spec-default for a single-node deploy;
multi-node deploys should use enough lead time to cover the restart
window + a 10x safety margin (e.g. a 30-minute rolling restart →
5-hour expiry).

Rolling-restart each node (one at a time; `/readyz` returns 503
during graceful shutdown so the load balancer should withhold
traffic automatically — see `docs/admin-platform-architecture-contract.md`).

### Phase 2 — verify

While the window is open, test BOTH keys:

```bash
curl -sf -H "x-admin-key: $ADMIN_KEY_PREVIOUS" https://<host>/api/admin/jobs
# expect 200
curl -sf -H "x-admin-key: $ADMIN_KEY" https://<host>/api/admin/jobs
# expect 200
```

In the server logs, the old-key request should produce one
`admin.auth.previous_key_used` line; the new-key one should not.

Update any client tools / CI secrets / saved Postman collections /
operator-issued cheat sheets to use the new key.

### Phase 3 — retire the old key

After `ADMIN_KEY_ROTATION_EXPIRES_AT` passes (or you've verified
no `admin.auth.previous_key_used` events for the last hour),
remove the rotation env vars:

```bash
unset ADMIN_KEY_PREVIOUS
unset ADMIN_KEY_ROTATION_EXPIRES_AT
# ADMIN_KEY stays at the new value
```

Rolling-restart again. The dual-accept window is now closed; only
the new key authenticates.

### Verification

After Phase 3:

```bash
curl -i -H "x-admin-key: $ADMIN_KEY_PREVIOUS" https://<host>/api/admin/jobs
# expect 401 — old key no longer works
curl -sf -H "x-admin-key: $ADMIN_KEY" https://<host>/api/admin/jobs
# expect 200
```

## Failure modes and recovery

### Rotation window expired before all clients migrated

Symptoms: client tools/scripts return 401 unexpectedly.

Recovery: re-open the rotation window. Set
`ADMIN_KEY_PREVIOUS=<old>` and a new
`ADMIN_KEY_ROTATION_EXPIRES_AT` further in the future; rolling-
restart. Now have a longer migration window. If the operator has
LOST the old key, the only path is to inform every client to
update its key before the second window closes.

### `ADMIN_KEY_PREVIOUS` set without `ADMIN_KEY_ROTATION_EXPIRES_AT`

The previous key is silently REJECTED — by design. An unbounded
"previous" key is a forever-live shadow credential, which defeats
the point of rotation. The auth gate requires BOTH env vars
together. (Unit test `no adminKeyRotationExpiresAt: previous key
has no window, rejected` covers this.)

### Invalid `ADMIN_KEY_ROTATION_EXPIRES_AT`

If the timestamp doesn't parse (typo, wrong format), the previous
key is REJECTED. Catch this via local validation:

```bash
node -e "const v = process.env.ADMIN_KEY_ROTATION_EXPIRES_AT; \
  const t = Date.parse(v); \
  if (!Number.isFinite(t)) throw new Error('invalid'); \
  console.log('OK:', new Date(t).toISOString());"
```

before rolling-restart.

## Auto-rotation (not implemented)

This is a manual runbook by design — automated rotation (cron- or
KMS-driven) is out of scope per #204. The dual-accept window is the
critical primitive; automation can be layered on later by an
operator pipeline that writes the env vars + triggers a rolling
restart on a schedule.

## WEBHOOK_SECRET rotation

The per-subscription webhook signing secret (used to sign outgoing
HMAC headers when the dispatcher emits a `webhook.test` or
event-driven request) is rotated via a separate path:

```bash
curl -X PATCH -H "x-admin-key: $ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"rotateSecret": true}' \
  https://<host>/api/admin/webhooks/<id>
```

The response carries the new secret **once** — store it on the
recipient side, then the old secret is retired immediately. This
rotation is NOT dual-accept-windowed at the server because the
server only SIGNS outgoing requests; the RECIPIENT verifies.
Coordinating recipient-side acceptance of both old + new
signatures is the recipient's concern (their verification code
keeps both secrets around for a window, then drops the old one).

See `docs/webhooks.md` for the signing/verification protocol.

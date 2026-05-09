# Web Push notifications

Self-hosted, family-scale Web Push for the daily Wordle puzzle. No FCM,
APNs, or third-party push relays — every notification flows through the
local node using a VAPID keypair generated at first boot.

## Player flow

1. Player opens the site (HTTPS or `localhost`; secure context required).
2. Player toggles **Get notified when daily puzzle is ready** in the
   header settings strip. The browser's permission prompt appears
   only on this user gesture — never automatically.
3. Browser issues a `PushManager.subscribe()` against the
   server-supplied VAPID public key.
4. Browser sends the subscription record (endpoint, p256dh, auth) to
   `POST /api/notifications/subscribe`. Server returns an opaque
   `endpointHash`.
5. At the configured local time each day, the server's
   `DailyNotificationScheduler` broadcasts a payload to every
   registered subscription.

## Admin flow

The admin Notifications tab surfaces:

- **Subscription count** — how many devices are registered (raw
  endpoints are never echoed).
- **Last broadcast** / **Last daily fire** timestamps.
- **Broadcast** form: title (≤ 80 chars), body (≤ 200 chars),
  site-relative URL. Click **Preview** for a `dryRun` that returns the
  recipient count without sending; click **Send to all** to dispatch
  (with a confirmation modal).

## VAPID

| Item | Behavior |
| --- | --- |
| **Generation** | Once on first boot via `web-push.generateVAPIDKeys()`. |
| **Persistence** | `data/vapid-keys.json` (server-only file, **NOT** included in the backup `IN_SCOPE_FILES` set). |
| **Rotation** | Not currently supported in the admin UI. Manual rotation requires deleting `data/vapid-keys.json` (server restart will regenerate); ALL existing subscriptions become invalid and need to re-register. |
| **Server-only** | `privateKey` is never exposed via `/api/meta`, runtime config, any admin endpoint, OR the backup archive. Splitting VAPID into its own file (rather than nesting under `app-config.json`) keeps the secret pinned to the host that generated it — admin-key-holders downloading a backup can't extract the private half from offline copies. |
| **Subject** | `mailto:` or `https:` per RFC 8292. Defaults to `mailto:admin@localhost`; override with `PUSH_VAPID_SUBJECT`. |

## Browser support

| Browser | Status |
| --- | --- |
| Chrome / Chromium / Edge | Fully supported. |
| Firefox | Fully supported. |
| Safari (macOS 16+) | Supported in regular browser context. |
| **Safari (iOS / iPadOS 16.4+)** | **Requires PWA install** — the player must add the site to Home Screen first. The opt-in toggle is shown but `PushManager.subscribe()` will fail without the install. The page surfaces this via the toggle's status line. |
| Older mobile browsers | Toggle is hidden (no `PushManager` global). |

## HTTPS requirement

Service Workers and the Push API require a **secure context**. The
toggle is hidden on plain HTTP (except `localhost` / `127.0.0.1`,
which browsers treat as secure). The status line reads "Notifications
need HTTPS or localhost." in this case.

## Daily fire scheduler

- The scheduler computes the next absolute fire-time from wall clock
  (`Date.now()`) on every re-arm — never additive `+24h` — so DST
  transitions and clock skew can't drift the schedule.
- On boot, if the configured fire time has already passed today AND no
  fire happened in the window, the scheduler fires late if it's
  within `gracePeriodMinutes` (default 60). Beyond that, the missed
  fire is skipped and the schedule re-arms for tomorrow.
- The scheduler honors the runtime `notifications.enabled` flag:
  toggling it off in the admin UI suspends fires without restart;
  toggling on resumes within ~60 s.

## Retention

| Outcome | Action |
| --- | --- |
| HTTP 2xx | `lastSuccessAt` updated; failure tracking cleared. |
| HTTP 410 (Gone) / 404 | Subscription pruned immediately. |
| HTTP 408 / 429 / 5xx | Treated as transient; `failureStreak` incremented; no retry on this fire (next daily fire will try again). |
| Other 4xx | `failureStreak` incremented; the row is not pruned automatically — the operator can inspect via the admin tab. |
| First failure older than 7 days | Pruned by the next `pruneStale` pass. |

## Environment variables

| Var | Default | Range | Purpose |
| --- | --- | --- | --- |
| `PUSH_NOTIFICATIONS_ENABLED` | `true` | bool | Seed for the runtime `notifications.enabled` flag. After first boot, the admin UI override wins. |
| `PUSH_DAILY_FIRE_LOCAL_TIME` | `00:00` | HH:MM 24h | Server-local time of the daily fire. Seed only; the runtime override wins. |
| `PUSH_GRACE_PERIOD_MINUTES` | `60` | 0–60 | Fire-late grace window on boot. Capped at 60 so a long downtime doesn't blur day boundaries. |
| `PUSH_VAPID_SUBJECT` | `mailto:admin@localhost` | mailto: or https: | RFC 8292 subject for VAPID JWT. |
| `PUSH_SUBSCRIPTIONS_STORE_PATH` | `data/push-subscriptions.json` | path | Override the subscription store location. |
| `VAPID_KEYS_STORE_PATH` | `data/vapid-keys.json` | path | Override the VAPID keypair location (server-only; not backed up). |

The `notifications.{enabled,localFireTime,gracePeriodMinutes}` keys
under `overrides` in `data/app-config.json` shadow the env vars at
runtime.

## Admin API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/notifications/subscriptions` | Count + timestamps + opaque per-row hashes. Never raw endpoints/keys. |
| POST | `/api/admin/notifications/broadcast` | `{title, body, url, dryRun?}`. `dryRun:true` returns recipient count + rendered preview without sending. |

## Player API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/notifications/vapid-public-key` | Returns the public VAPID key (URL-safe base64). 503 with `code: VAPID_MISSING` until the boot path provisions keys. |
| POST | `/api/notifications/subscribe` | Body: `{endpoint, keys:{p256dh,auth}}`. Returns `{endpointHash}`. |
| DELETE | `/api/notifications/subscribe/:endpointHash` | 204 (idempotent). |

## Service worker

`public/sw.js` v3 adds two listeners:

- `push` — parses the JSON payload (`{title, body, url, tag}`) and
  calls `self.registration.showNotification`. Falls back to a generic
  daily-puzzle copy on empty payloads.
- `notificationclick` — focuses an existing tab at the URL if open,
  else opens a new window. The `tag` collapses repeat notifications so
  a daily fire that arrives before a previous one was dismissed
  doesn't pile up.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Toggle hidden | Browser lacks `PushManager` / Service Worker, or the site is HTTP (not HTTPS or localhost). |
| Toggle disabled, "Notifications blocked" | Browser permission denied. Open browser settings → site permissions → reload. |
| Subscribe returns 503 `VAPID_MISSING` | Boot path hasn't run `ensurePushKeysSync` yet — wait a few seconds and retry. |
| No notification at midnight | Check `notifications.enabled` in admin Runtime Settings, server-local timezone of the host, and the `lastDailyFireAt` timestamp on the admin Notifications tab. |
| Notification body shows wrong word length | The scheduler reads `wordDataCache` at fire time. If admin set a new word AFTER the daily reconcile, the new word reflects on the next fire. |

## Dependencies

- `web-push@^3.6.0` — runtime dependency for VAPID JWT signing and
  RFC 8291 message encryption.

## Test coverage

- Unit: `tests/push-subscription-store.test.js` — atomic write,
  dedupe-by-endpoint, prune-on-410, `pruneStale` cutoff.
- Unit: `tests/notification-service.test.js` — `buildPayload` clamps,
  `classifyResponse` decision table, sendOne mocking, broadcast
  aggregate counts.
- Unit: `tests/daily-notification-scheduler.test.js` — `computeNextFireAt`
  across DST, `decideBootAction` grace window, scheduler integration
  with mocked store + service.
- Integration: `tests/notification-routes.test.js` — subscribe, unsubscribe,
  vapid-public-key, admin subscriptions/broadcast, VAPID-private-key
  leak check across `/api/meta` + `/api/admin/notifications/*`.

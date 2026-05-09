"use strict";

// Web Push dispatcher. Wraps the `web-push` npm package so the rest of
// the codebase can ignore VAPID + RFC 8291/8292 details and just call
// `service.broadcast({title, body, url})`.

class NotificationServiceError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "NotificationServiceError";
    this.code = code;
    if (options.cause) this.cause = options.cause;
  }
}

// Web Push payload size cap is ~4 KiB encrypted; we keep ours far below
// so headers + cipher overhead don't push us over.
const PAYLOAD_MAX_BYTES = 1024;
const TITLE_MAX_LENGTH = 80;
const BODY_MAX_LENGTH = 200;
const URL_MAX_LENGTH = 256;

function clampString(value, max) {
  if (typeof value !== "string") return "";
  return value.length > max ? value.slice(0, max) : value;
}

function buildPayload({ title, body, url, tag } = {}) {
  const cleaned = {
    title: clampString(title, TITLE_MAX_LENGTH),
    body: clampString(body, BODY_MAX_LENGTH),
    url: clampString(url, URL_MAX_LENGTH)
  };
  if (typeof tag === "string" && tag.length > 0) {
    cleaned.tag = tag.length > 64 ? tag.slice(0, 64) : tag;
  }
  return cleaned;
}

// Map web-push send errors to a stable shape so the store can decide
// whether to retain or prune. statusCode comes straight from the push
// service's response.
function classifyResponse(err) {
  if (!err) return { ok: true, retriable: false, gone: false };
  const status = err.statusCode ?? err.status ?? null;
  // 410 Gone: subscription is permanently invalid; the store should
  // delete the row immediately rather than waiting for the prune cycle.
  if (status === 410 || status === 404) {
    return { ok: false, retriable: false, gone: true, status };
  }
  // 4xx (other than 408/429) means the request was malformed —
  // not retriable, but the subscription itself isn't gone.
  if (status === 408 || status === 429) {
    return { ok: false, retriable: true, gone: false, status };
  }
  if (status >= 400 && status < 500) {
    return { ok: false, retriable: false, gone: false, status };
  }
  // 5xx + network error → retriable.
  return { ok: false, retriable: true, gone: false, status };
}

class NotificationService {
  constructor(options = {}) {
    if (!options.subscriptionStore) {
      throw new NotificationServiceError("INVALID_REQUEST", "subscriptionStore is required.");
    }
    this.subscriptionStore = options.subscriptionStore;
    this.logger = options.logger || console;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    // Web Push sender. Defaults to `require('web-push')`; injected in
    // tests so we don't hit a real push service.
    this.webPush = options.webPush || require("web-push");
    // Live `enabled` getter — called on every send so admin toggling
    // the runtime `notifications.enabled` flag stops both the daily
    // scheduler AND admin broadcasts. The boot-time boolean fallback
    // is kept for tests + simple wirings.
    if (typeof options.isEnabled === "function") {
      this.isEnabled = options.isEnabled;
    } else {
      const enabledFlag = options.enabled !== false;
      this.isEnabled = () => enabledFlag;
    }
    // VAPID accessor — called every send so admin-rotated keys take
    // effect without restart. Returns `{publicKey, privateKey, subject}`
    // or null if VAPID isn't provisioned.
    this.getPushKeys = typeof options.getPushKeys === "function" ? options.getPushKeys : null;
    if (!this.getPushKeys) {
      throw new NotificationServiceError(
        "INVALID_REQUEST",
        "getPushKeys callback is required (must return {publicKey, privateKey, subject})."
      );
    }
    // Concurrency cap so a thundering herd of sends doesn't saturate
    // the event loop. Default conservatively low — push services are
    // happy to receive 100s of req/s from one source, but our retry
    // semaphore should match the dispatcher's polite-default ethos.
    this.maxConcurrent = Number.isInteger(options.maxConcurrent) && options.maxConcurrent > 0
      ? options.maxConcurrent
      : 8;
    this.ttlSeconds = Number.isInteger(options.ttlSeconds) && options.ttlSeconds > 0
      ? options.ttlSeconds
      : 24 * 60 * 60;
  }

  // Send a single push notification to a single subscription. Returns
  // `{ok, status, gone}`. Caller is expected to update the subscription
  // store based on the result.
  async sendOne(subscription, payload, { ttlSeconds = this.ttlSeconds } = {}) {
    if (!this.isEnabled()) return { ok: false, status: null, skipped: true, reason: "disabled" };
    const keys = this.getPushKeys();
    if (!keys || !keys.publicKey || !keys.privateKey) {
      throw new NotificationServiceError(
        "VAPID_MISSING",
        "Cannot send: VAPID keypair not provisioned."
      );
    }
    const body = JSON.stringify(buildPayload(payload));
    if (Buffer.byteLength(body, "utf8") > PAYLOAD_MAX_BYTES) {
      throw new NotificationServiceError(
        "PAYLOAD_TOO_LARGE",
        `Notification payload is ${Buffer.byteLength(body, "utf8")} bytes; cap is ${PAYLOAD_MAX_BYTES}.`
      );
    }
    try {
      this.webPush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
      await this.webPush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: subscription.keys
        },
        body,
        { TTL: ttlSeconds }
      );
      return { ok: true, status: 200, gone: false };
    } catch (err) {
      const classification = classifyResponse(err);
      this.logger.warn?.(`[notify] send failed for ${subscription.endpointHash}:`, err.message || err);
      return { ...classification, error: err.message || String(err) };
    }
  }

  // Broadcast to every active subscription. Settles all sends with a
  // small concurrency cap. Updates the store: success bumps
  // lastSuccessAt; gone deletes; non-gone failures increment streak.
  // Returns aggregate counts.
  async broadcast(payload, { dryRun = false } = {}) {
    if (!this.isEnabled()) return { sent: 0, failed: 0, gone: 0, skipped: true, reason: "disabled" };
    const subs = await this.subscriptionStore.list();
    if (dryRun) {
      return {
        recipients: subs.length,
        preview: buildPayload(payload),
        dryRun: true
      };
    }
    let sent = 0;
    let failed = 0;
    let gone = 0;
    const queue = subs.slice();
    const workers = Array.from({ length: Math.min(this.maxConcurrent, queue.length) }, async () => {
      while (queue.length > 0) {
        const sub = queue.shift();
        if (!sub) break;
        const result = await this.sendOne(sub, payload);
        if (result.ok) {
          await this.subscriptionStore.markSuccess(sub.endpointHash).catch(() => {});
          sent += 1;
        } else if (result.gone) {
          await this.subscriptionStore.markFailure(sub.endpointHash, { gone: true }).catch(() => {});
          gone += 1;
        } else {
          await this.subscriptionStore.markFailure(sub.endpointHash, { gone: false }).catch(() => {});
          failed += 1;
        }
      }
    });
    await Promise.all(workers);
    return { sent, failed, gone, recipients: subs.length };
  }
}

module.exports = {
  NotificationService,
  NotificationServiceError,
  buildPayload,
  classifyResponse,
  PAYLOAD_MAX_BYTES,
  TITLE_MAX_LENGTH,
  BODY_MAX_LENGTH
};

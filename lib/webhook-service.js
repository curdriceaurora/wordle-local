"use strict";

const dnsPromises = require("node:dns/promises");
const nodeCrypto = require("node:crypto");
let undiciAgentRef = null;
function getUndiciAgent() {
  if (undiciAgentRef !== null) return undiciAgentRef;
  try {
    // Lazy-require so the module loads cleanly in environments that
    // don't ship undici (e.g. ancient Node), even though Node 18+ does.
    undiciAgentRef = require("undici").Agent;
  } catch (_err) {
    undiciAgentRef = false;
  }
  return undiciAgentRef;
}

// Backoff schedule per the spec — total wait is roughly 12.5 minutes
// across 5 attempts before dead-letter.
const DEFAULT_BACKOFF_MS = Object.freeze([1000, 5000, 30000, 120000, 600000]);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_GLOBAL_INFLIGHT = 4;
const DEFAULT_RETRY_AFTER_CAP_MS = 600_000; // never wait more than the longest backoff slot

class WebhookSendError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "WebhookSendError";
    this.code = code;
    this.retriable = options.retriable === true;
    this.responseStatus = options.responseStatus;
    this.responseSnippet = options.responseSnippet;
    this.retryAfterMs = options.retryAfterMs;
    if (options.cause) this.cause = options.cause;
  }
}

function nextBackoffMs(attemptNumber, schedule = DEFAULT_BACKOFF_MS) {
  // attemptNumber is 1-indexed (the attempt that just failed). The backoff
  // for the NEXT attempt is schedule[attemptNumber-1] when retrying for
  // the second time, etc. If we've used the whole schedule, we cap at
  // the last slot (so a 6th attempt — if maxAttempts allowed it — still
  // gets the 10-minute slot).
  const idx = Math.max(0, Math.min(attemptNumber - 1, schedule.length - 1));
  return schedule[idx];
}

function isPrivateIPv4(ip) {
  // RFC1918 + loopback + link-local + 0.0.0.0
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable → treat as unsafe
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0 && b === 0 && parts[2] === 0 && parts[3] === 0) return true;
  return false;
}

function isPrivateIPv6(ip) {
  // ::1 (loopback), fe80::/10 (link-local), fc00::/7 (unique-local),
  // :: (unspecified — used by servers that bind to all interfaces; a
  // client connecting here on the same host hits the loopback path,
  // so block it like 0.0.0.0).
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9")
    || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // Also IPv4-mapped IPv6 (::ffff:10.0.0.1 etc.). Strip prefix and re-check.
  if (lower.startsWith("::ffff:")) {
    return isPrivateIPv4(lower.slice("::ffff:".length));
  }
  return false;
}

async function resolveHost(hostname) {
  // Returns array of resolved IP addresses (both v4 and v6 if present).
  // Throws on resolution failure.
  try {
    const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
    return records.map((r) => ({ address: r.address, family: r.family }));
  } catch (err) {
    throw new WebhookSendError(
      "DNS_RESOLUTION_FAILED",
      `Could not resolve ${hostname}: ${err.message}`,
      { retriable: true, cause: err }
    );
  }
}

async function assertOutboundUrlAllowed(rawUrl, { allowPrivateNetworks = false } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    throw new WebhookSendError("INVALID_URL", `Could not parse URL: ${rawUrl}`, { retriable: false });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebhookSendError(
      "INVALID_URL",
      `Webhook URL scheme must be http(s); got ${parsed.protocol}`,
      { retriable: false }
    );
  }
  if (allowPrivateNetworks) return { url: parsed, addresses: null };
  const hostname = parsed.hostname;
  // If the hostname is already a literal IP, check it directly.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    if (isPrivateIPv4(hostname)) {
      throw new WebhookSendError(
        "PRIVATE_ADDRESS_BLOCKED",
        `Outbound address ${hostname} is in a private/loopback range.`,
        { retriable: false }
      );
    }
    return { url: parsed, addresses: [{ address: hostname, family: 4 }] };
  }
  if (hostname.includes(":")) {
    const stripped = hostname.replace(/^\[|\]$/g, "");
    if (isPrivateIPv6(stripped)) {
      throw new WebhookSendError(
        "PRIVATE_ADDRESS_BLOCKED",
        `Outbound IPv6 ${hostname} is in a private/loopback range.`,
        { retriable: false }
      );
    }
    return { url: parsed, addresses: [{ address: stripped, family: 6 }] };
  }
  const records = await resolveHost(hostname);
  for (const rec of records) {
    const isPrivate = rec.family === 6 ? isPrivateIPv6(rec.address) : isPrivateIPv4(rec.address);
    if (isPrivate) {
      throw new WebhookSendError(
        "PRIVATE_ADDRESS_BLOCKED",
        `Outbound host ${hostname} resolves to a private/loopback address (${rec.address}).`,
        { retriable: false }
      );
    }
  }
  return { url: parsed, addresses: records };
}

// Builds a node:dns/promises-style lookup function that resolves the
// given hostname only to one of the pre-validated addresses. Pinning
// the resolution closes the DNS-rebinding window between
// assertOutboundUrlAllowed's check and fetch's own DNS lookup.
function buildPinnedLookup(hostname, addresses) {
  return (lookupHost, options, cb) => {
    let callback = cb;
    let opts = options;
    if (typeof options === "function") {
      callback = options;
      opts = {};
    }
    if (lookupHost !== hostname) {
      // Different hostname — fall through to default DNS. Shouldn't
      // happen in practice (we pin per-request), but be safe.
      dnsPromises
        .lookup(lookupHost, opts || {})
        .then((res) => {
          if (Array.isArray(res)) callback(null, res);
          else callback(null, res.address, res.family);
        })
        .catch(callback);
      return;
    }
    const valid = addresses.filter(
      (a) => !opts?.family || opts.family === 0 || opts.family === a.family
    );
    if (valid.length === 0) {
      const err = new Error(`No validated addresses for ${lookupHost}`);
      err.code = "ENOTFOUND";
      callback(err);
      return;
    }
    if (opts?.all) {
      callback(null, valid.map((a) => ({ address: a.address, family: a.family })));
    } else {
      callback(null, valid[0].address, valid[0].family);
    }
  };
}

function signPayload(body, secret) {
  const hmac = nodeCrypto.createHmac("sha256", secret);
  hmac.update(body);
  return `sha256=${hmac.digest("hex")}`;
}

function parseRetryAfterHeader(value, now) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  // Numeric seconds form
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Math.max(0, seconds * 1000);
  }
  // HTTP-date form
  const ts = Date.parse(trimmed);
  if (!Number.isNaN(ts)) {
    return Math.max(0, ts - now.getTime());
  }
  return null;
}

function classifyHttpStatus(status) {
  // 2xx success; 4xx (excluding 408/429) non-retriable; rest retriable.
  if (status >= 200 && status < 300) return { ok: true, retriable: false };
  if (status === 408 || status === 429) return { ok: false, retriable: true };
  if (status >= 400 && status < 500) return { ok: false, retriable: false };
  return { ok: false, retriable: true }; // 5xx + everything else
}

async function readResponseSnippet(response, maxBytes) {
  // Read at most maxBytes from the response. Truncate without exploding
  // memory; some recipients return giant HTML error pages.
  const reader = response.body?.getReader?.();
  if (!reader) return "";
  let collected = 0;
  const chunks = [];
  try {
    while (collected < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = maxBytes - collected;
      const slice = value.length > remaining ? value.slice(0, remaining) : value;
      chunks.push(slice);
      collected += slice.length;
      if (collected >= maxBytes) {
        try { await reader.cancel(); } catch (_e) { /* best-effort */ }
        break;
      }
    }
  } catch (_err) {
    // best-effort; we still return what we got
  }
  try {
    return Buffer.concat(chunks).toString("utf8");
  } catch (_err) {
    return "";
  }
}

async function sendWebhookRequest({
  url,
  body,
  headers,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  fetchImpl = globalThis.fetch,
  dispatcher = null
}) {
  if (typeof fetchImpl !== "function") {
    throw new WebhookSendError(
      "FETCH_UNAVAILABLE",
      "Global fetch is not available in this Node runtime.",
      { retriable: false }
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    const init = {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      // Don't follow redirects automatically; the recipient should
      // accept the URL we configured and not bounce us elsewhere.
      redirect: "manual"
    };
    if (dispatcher) init.dispatcher = dispatcher;
    response = await fetchImpl(url, init);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new WebhookSendError("TIMEOUT", `Webhook request timed out after ${timeoutMs}ms.`, { retriable: true, cause: err });
    }
    throw new WebhookSendError("NETWORK_ERROR", `Network error: ${err.message}`, { retriable: true, cause: err });
  } finally {
    clearTimeout(timer);
  }
  const responseStatus = response.status;
  const snippet = await readResponseSnippet(response, maxBodyBytes);
  const retryAfter = parseRetryAfterHeader(response.headers.get?.("retry-after"), new Date());
  return { responseStatus, responseSnippet: snippet, retryAfterMs: retryAfter };
}

class WebhookService {
  constructor(options = {}) {
    if (!options.subscriptionStore) {
      throw new Error("WebhookService: subscriptionStore is required.");
    }
    if (!options.deliveryStore) {
      throw new Error("WebhookService: deliveryStore is required.");
    }
    this.subscriptionStore = options.subscriptionStore;
    this.deliveryStore = options.deliveryStore;
    this.logger = options.logger || console;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    this.allowPrivateNetworks = options.allowPrivateNetworks === true;
    this.timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    this.maxBodyBytes = Number.isInteger(options.maxBodyBytes) && options.maxBodyBytes > 0
      ? options.maxBodyBytes
      : DEFAULT_MAX_BODY_BYTES;
    this.globalInflight = Number.isInteger(options.globalInflight) && options.globalInflight > 0
      ? options.globalInflight
      : DEFAULT_GLOBAL_INFLIGHT;
    this.backoffSchedule = Array.isArray(options.backoffSchedule) && options.backoffSchedule.length > 0
      ? options.backoffSchedule
      : DEFAULT_BACKOFF_MS;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.enabled = options.enabled !== false;
    // Pending due timers — tracked so shutdown can clear them.
    this.scheduledTimers = new Set();
    // Concurrency semaphore — counts in-flight executeOnce() calls.
    this.activeCount = 0;
    // Queue of delivery IDs ready to run when a slot frees up.
    this.readyQueue = [];
    this.shutdownRequested = false;
  }

  async emit(event, payload = {}) {
    if (!this.enabled) return [];
    if (typeof event !== "string" || !event) {
      throw new Error("emit(): event is required.");
    }
    const subs = await this.subscriptionStore.findEnabledForEvent(event);
    const out = [];
    for (const sub of subs) {
      // Persist the payload on the delivery row so boot recovery and
      // manual retries can resend the original body. Without this,
      // recovered/retried deliveries would only have the empty `{}`
      // fallback because runtimeContext lives in process memory.
      const delivery = await this.deliveryStore.enqueue({
        subscriptionId: sub.id,
        event,
        url: sub.url,
        payload
      });
      out.push(delivery);
      this.scheduleDelivery(delivery.id, 0, { event, payload, subscription: sub });
    }
    return out;
  }

  // Schedule a single delivery to run after delayMs. Stores a timer ref so
  // shutdown can clear pending work cleanly. Gated on `enabled` so admin
  // routes (and recoverOnBoot) can call this directly without bypassing
  // the WEBHOOKS_ENABLED contract.
  scheduleDelivery(deliveryId, delayMs = 0, runtimeContext = null) {
    if (this.shutdownRequested) return;
    if (!this.enabled) return;
    const timer = setTimeout(() => {
      this.scheduledTimers.delete(timer);
      this.enqueueReady(deliveryId, runtimeContext);
    }, Math.max(0, delayMs));
    if (typeof timer.unref === "function") timer.unref();
    this.scheduledTimers.add(timer);
  }

  enqueueReady(deliveryId, runtimeContext) {
    if (!this.enabled) return;
    this.readyQueue.push({ deliveryId, runtimeContext });
    this.drain();
  }

  drain() {
    if (!this.enabled) return;
    while (this.activeCount < this.globalInflight && this.readyQueue.length > 0 && !this.shutdownRequested) {
      const item = this.readyQueue.shift();
      this.activeCount += 1;
      this.executeOnce(item.deliveryId, item.runtimeContext)
        .catch((err) => {
          this.logger.error?.(`[webhook] executeOnce crashed for ${item.deliveryId}:`, err);
        })
        .finally(() => {
          this.activeCount -= 1;
          this.drain();
        });
    }
  }

  async executeOnce(deliveryId, runtimeContext) {
    const delivery = await this.deliveryStore.findById(deliveryId);
    if (!delivery) {
      this.logger.warn?.(`[webhook] delivery ${deliveryId} not found at execute time.`);
      return;
    }
    if (delivery.status !== "queued" && delivery.status !== "running") {
      // Already handled by another path (manual retry / cancellation /
      // duplicate timer).
      return;
    }
    // Always look up the subscription fresh from the store. Caching
    // it on runtimeContext (as an earlier draft did) would let same-
    // process retries post to the OLD url and sign with the OLD
    // secret even after the operator edited or rotated. The store
    // is the source of truth for subscription state at attempt time.
    const sub = await this.subscriptionStore.findById(delivery.subscriptionId);
    if (!sub || !sub.enabled) {
      await this.deliveryStore.update(delivery.id, {
        status: "canceled",
        lastError: sub ? "Subscription disabled" : "Subscription removed"
      });
      return;
    }
    const attemptNumber = delivery.attempts + 1;
    await this.deliveryStore.update(delivery.id, {
      status: "running",
      attempts: attemptNumber,
      nextAttemptAt: null
    });
    let result;
    let nonRetriableError;
    try {
      // Prefer in-memory payload (fast path for fresh emits), fall
      // back to the persisted row for boot recovery / manual retries
      // where runtimeContext is empty.
      const payload = runtimeContext?.payload
        ?? delivery.payload
        ?? {};
      const body = JSON.stringify({
        id: delivery.id,
        event: delivery.event,
        timestamp: this.now().toISOString(),
        attempt: attemptNumber,
        payload
      });
      const signature = signPayload(body, sub.secret);
      // Pre-flight URL check (every attempt — DNS could change, and the
      // operator could have edited the URL after the delivery was
      // enqueued). Throws WebhookSendError with retriable=false on
      // policy violations so the outer logic stops retrying.
      const { url: parsedUrl, addresses } = await assertOutboundUrlAllowed(sub.url, {
        allowPrivateNetworks: this.allowPrivateNetworks
      });
      const dispatcher = this.#buildPinnedDispatcher(parsedUrl, addresses);
      const headers = {
        "content-type": "application/json",
        "user-agent": "wordle-local-webhook/1",
        "x-webhook-id": delivery.id,
        "x-webhook-event": delivery.event,
        "x-webhook-timestamp": this.now().toISOString(),
        "x-webhook-attempt": String(attemptNumber),
        "x-webhook-signature": signature
      };
      result = await sendWebhookRequest({
        url: sub.url,
        body,
        headers,
        timeoutMs: this.timeoutMs,
        maxBodyBytes: this.maxBodyBytes,
        fetchImpl: this.fetchImpl,
        dispatcher
      });
    } catch (err) {
      if (err instanceof WebhookSendError) {
        if (!err.retriable) {
          nonRetriableError = err;
        } else {
          result = {
            responseStatus: err.responseStatus,
            responseSnippet: err.responseSnippet,
            retryAfterMs: err.retryAfterMs,
            errorMessage: err.message,
            errorRetriable: true
          };
        }
      } else {
        // Unexpected — treat as non-retriable to avoid retry storms on
        // programming errors. Logged loudly.
        nonRetriableError = err;
        this.logger.error?.(`[webhook] unexpected error for delivery ${deliveryId}:`, err);
      }
    }
    if (nonRetriableError) {
      await this.deliveryStore.update(delivery.id, {
        status: "failed",
        lastError: nonRetriableError.message
      });
      return;
    }
    if (result && result.responseStatus !== undefined) {
      const classification = classifyHttpStatus(result.responseStatus);
      if (classification.ok) {
        await this.deliveryStore.update(delivery.id, {
          status: "succeeded",
          responseStatus: result.responseStatus,
          responseSnippet: result.responseSnippet,
          lastError: ""
        });
        return;
      }
      if (!classification.retriable || attemptNumber >= sub.maxAttempts) {
        await this.deliveryStore.update(delivery.id, {
          status: "failed",
          responseStatus: result.responseStatus,
          responseSnippet: result.responseSnippet,
          lastError: `HTTP ${result.responseStatus}`
        });
        return;
      }
      const backoffMs = Math.min(
        Math.max(result.retryAfterMs ?? 0, nextBackoffMs(attemptNumber, this.backoffSchedule)),
        DEFAULT_RETRY_AFTER_CAP_MS
      );
      const nextAt = new Date(this.now().getTime() + backoffMs).toISOString();
      await this.deliveryStore.update(delivery.id, {
        status: "queued",
        responseStatus: result.responseStatus,
        responseSnippet: result.responseSnippet,
        lastError: `HTTP ${result.responseStatus}; retrying`,
        nextAttemptAt: nextAt
      });
      this.scheduleDelivery(delivery.id, backoffMs, runtimeContext);
      return;
    }
    // Reached here: result has an errorMessage (network/timeout) — treat as retriable.
    if (attemptNumber >= sub.maxAttempts) {
      await this.deliveryStore.update(delivery.id, {
        status: "failed",
        lastError: result?.errorMessage || "Unknown error"
      });
      return;
    }
    const backoffMs = nextBackoffMs(attemptNumber, this.backoffSchedule);
    const nextAt = new Date(this.now().getTime() + backoffMs).toISOString();
    await this.deliveryStore.update(delivery.id, {
      status: "queued",
      lastError: result?.errorMessage || "Unknown error",
      nextAttemptAt: nextAt
    });
    this.scheduleDelivery(delivery.id, backoffMs, runtimeContext);
  }

  async retryDelivery(deliveryId) {
    const d = await this.deliveryStore.findById(deliveryId);
    if (!d) return null;
    if (d.status !== "failed") {
      return d;
    }
    const sub = await this.subscriptionStore.findById(d.subscriptionId);
    if (!sub) return d;
    await this.deliveryStore.update(deliveryId, {
      status: "queued",
      lastError: ""
    });
    this.scheduleDelivery(deliveryId, 0, { subscription: sub });
    return this.deliveryStore.findById(deliveryId);
  }

  async recoverOnBoot() {
    if (!this.enabled) return 0;
    const candidates = await this.deliveryStore.findRecoverable();
    if (candidates.length === 0) return 0;
    let recovered = 0;
    for (const d of candidates) {
      if (d.status === "running") {
        // The previous process died mid-flight; requeue with a small
        // backoff so a tight crash loop doesn't hammer the recipient.
        await this.deliveryStore.update(d.id, {
          status: "queued",
          lastError: "Recovered after restart",
          nextAttemptAt: new Date(this.now().getTime() + 1000).toISOString()
        });
        this.scheduleDelivery(d.id, 1000);
        recovered += 1;
      } else if (d.status === "queued") {
        // Honor the persisted nextAttemptAt if any; otherwise schedule
        // immediately.
        let delay = 0;
        if (d.nextAttemptAt) {
          delay = Math.max(0, new Date(d.nextAttemptAt).getTime() - this.now().getTime());
        }
        this.scheduleDelivery(d.id, delay);
        recovered += 1;
      }
    }
    return recovered;
  }

  shutdown() {
    this.shutdownRequested = true;
    for (const t of this.scheduledTimers) clearTimeout(t);
    this.scheduledTimers.clear();
    this.readyQueue.length = 0;
  }

  // Returns an undici Agent that pins DNS resolution for `parsedUrl`'s
  // hostname to the addresses we already validated, closing the
  // DNS-rebinding window between assertOutboundUrlAllowed's lookup and
  // fetch's own resolution. Returns null if undici isn't available
  // (allowPrivateNetworks bypass) or pin information is missing.
  #buildPinnedDispatcher(parsedUrl, addresses) {
    if (!Array.isArray(addresses) || addresses.length === 0) return null;
    const Agent = getUndiciAgent();
    if (!Agent) return null;
    const lookup = buildPinnedLookup(parsedUrl.hostname, addresses);
    return new Agent({ connect: { lookup } });
  }
}

module.exports = {
  WebhookService,
  WebhookSendError,
  signPayload,
  parseRetryAfterHeader,
  classifyHttpStatus,
  isPrivateIPv4,
  isPrivateIPv6,
  assertOutboundUrlAllowed,
  nextBackoffMs,
  DEFAULT_BACKOFF_MS
};

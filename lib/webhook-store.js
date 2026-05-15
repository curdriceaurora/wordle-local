"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const { logger: defaultLogger } = require("./logger");
const { probeStoreFile } = require("./store-health-probe");

const STORE_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const URL_PATTERN = /^https?:\/\//i;
const EVENT_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
// Lowercase hex; matches generateSecret() output and the
// HMAC-SHA-256 signing convention documented in docs/webhooks.md.
// Enforcing the pattern at normalize time means a hand-edited
// data/webhooks.json that contains a non-hex secret fails to load
// instead of silently returning a delivery whose signature can't be
// recomputed by the recipient.
const SECRET_PATTERN = /^[a-f0-9]+$/;
const LABEL_MAX_LENGTH = 80;
const URL_MAX_LENGTH = 2048;
const SECRET_MIN_LENGTH = 16;
const SECRET_MAX_LENGTH = 256;
const MAX_ATTEMPTS_MIN = 1;
const MAX_ATTEMPTS_MAX = 20;
// Mirror admin-jobs-store.js — Windows surfaces these on rename-over-existing.
const WINDOWS_RENAME_OVERWRITE_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

class WebhookStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "WebhookStoreError";
    this.code = code;
    if (options.cause) this.cause = options.cause;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function generateSubscriptionId() {
  // 16 random bytes → 22-char base64url is plenty for a single-instance
  // deployment and stays inside the schema's id pattern.
  return nodeCrypto.randomBytes(16).toString("base64url");
}

function generateSecret() {
  // 32 bytes hex (64 chars) — same convention the salvage branch used.
  return nodeCrypto.randomBytes(32).toString("hex");
}

function normalizeUrl(raw) {
  if (typeof raw !== "string") {
    throw new WebhookStoreError("INVALID_URL", "URL must be a string.");
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > URL_MAX_LENGTH) {
    throw new WebhookStoreError("INVALID_URL", "URL must be 1–2048 characters.");
  }
  if (!URL_PATTERN.test(trimmed)) {
    throw new WebhookStoreError("INVALID_URL", "URL must use http(s) scheme.");
  }
  // Parse + canonicalize. The case-insensitive URL_PATTERN above
  // accepts `HTTPS://example.com`, but the persisted-file schema
  // (data/webhooks.schema.json) uses a case-sensitive `^https?://`
  // pattern, so we'd write an UPPERCASE-scheme URL that subsequently
  // failed restore-time schema validation. URL serialization
  // lowercases the scheme + host for us.
  // Also reject embedded credentials — `https://user:pass@host/...`
  // parses cleanly but persists admin-pasted secrets into listings
  // and backups outside the HMAC-secret flow.
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_err) {
    throw new WebhookStoreError("INVALID_URL", `Could not parse URL: ${trimmed}`);
  }
  if (parsed.username || parsed.password) {
    throw new WebhookStoreError(
      "INVALID_URL",
      "URL must not include embedded user:password credentials."
    );
  }
  const canonical = parsed.toString();
  if (canonical.length > URL_MAX_LENGTH) {
    throw new WebhookStoreError("INVALID_URL", "URL must be 1–2048 characters.");
  }
  return canonical;
}

function normalizeEvents(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new WebhookStoreError("INVALID_EVENTS", "events must be a non-empty array.");
  }
  const out = [];
  const seen = new Set();
  for (const evt of raw) {
    if (typeof evt !== "string" || !EVENT_PATTERN.test(evt)) {
      throw new WebhookStoreError("INVALID_EVENTS", `Invalid event name: ${evt}`);
    }
    if (seen.has(evt)) continue;
    seen.add(evt);
    out.push(evt);
  }
  return out;
}

function normalizeMaxAttempts(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MAX_ATTEMPTS_MIN || n > MAX_ATTEMPTS_MAX) {
    throw new WebhookStoreError(
      "INVALID_MAX_ATTEMPTS",
      `maxAttempts must be an integer between ${MAX_ATTEMPTS_MIN} and ${MAX_ATTEMPTS_MAX}.`
    );
  }
  return n;
}

function normalizeLabel(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > LABEL_MAX_LENGTH) {
    throw new WebhookStoreError(
      "INVALID_LABEL",
      `Label must be a string up to ${LABEL_MAX_LENGTH} chars.`
    );
  }
  return raw;
}

function normalizeSubscription(raw) {
  if (!isPlainObject(raw)) {
    throw new WebhookStoreError("INVALID_SUBSCRIPTION", "Subscription must be an object.");
  }
  if (!ID_PATTERN.test(raw.id || "")) {
    throw new WebhookStoreError("INVALID_SUBSCRIPTION", `Invalid subscription id: ${raw.id}`);
  }
  if (
    typeof raw.secret !== "string"
    || raw.secret.length < SECRET_MIN_LENGTH
    || raw.secret.length > SECRET_MAX_LENGTH
    || !SECRET_PATTERN.test(raw.secret)
  ) {
    throw new WebhookStoreError(
      "INVALID_SUBSCRIPTION",
      "secret must be a lowercase-hex string 16–256 chars long."
    );
  }
  if (typeof raw.enabled !== "boolean") {
    throw new WebhookStoreError("INVALID_SUBSCRIPTION", "enabled must be a boolean.");
  }
  if (typeof raw.createdAt !== "string" || !raw.createdAt) {
    throw new WebhookStoreError("INVALID_SUBSCRIPTION", "createdAt is required.");
  }
  if (typeof raw.updatedAt !== "string" || !raw.updatedAt) {
    throw new WebhookStoreError("INVALID_SUBSCRIPTION", "updatedAt is required.");
  }
  const out = {
    id: raw.id,
    url: normalizeUrl(raw.url),
    events: normalizeEvents(raw.events),
    enabled: raw.enabled,
    secret: raw.secret,
    maxAttempts: normalizeMaxAttempts(raw.maxAttempts, 5),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
  const label = normalizeLabel(raw.label);
  if (label !== undefined) out.label = label;
  return out;
}

function buildDefaultStore() {
  return {
    version: STORE_VERSION,
    updatedAt: new Date().toISOString(),
    subscriptions: []
  };
}

function normalizeStore(raw) {
  if (!isPlainObject(raw)) {
    throw new WebhookStoreError("INVALID_STORE", "Store must be an object.");
  }
  if (raw.version !== STORE_VERSION) {
    throw new WebhookStoreError(
      "VERSION_UNSUPPORTED",
      `Webhook store version ${raw.version} is not supported (expected ${STORE_VERSION}).`
    );
  }
  if (typeof raw.updatedAt !== "string") {
    throw new WebhookStoreError("INVALID_STORE", "updatedAt is required.");
  }
  if (!Array.isArray(raw.subscriptions)) {
    throw new WebhookStoreError("INVALID_STORE", "subscriptions must be an array.");
  }
  const seen = new Set();
  const subscriptions = [];
  for (const sub of raw.subscriptions) {
    const normalized = normalizeSubscription(sub);
    if (seen.has(normalized.id)) continue; // duplicate-id tolerance on load
    seen.add(normalized.id);
    subscriptions.push(normalized);
  }
  subscriptions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return {
    version: STORE_VERSION,
    updatedAt: raw.updatedAt,
    subscriptions
  };
}

async function writeJsonAtomic(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`;
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    try {
      await fsp.rename(tempPath, filePath);
    } catch (renameErr) {
      if (!renameErr || !WINDOWS_RENAME_OVERWRITE_CODES.has(renameErr.code)) throw renameErr;
      await fsp.rm(filePath, { force: true });
      await fsp.rename(tempPath, filePath);
    }
  } catch (err) {
    try { await fsp.rm(tempPath, { force: true }); } catch (_e) { /* best-effort */ }
    throw new WebhookStoreError(
      "STORE_WRITE_FAILED",
      `Failed to persist webhook store to ${filePath}: ${err.message}`,
      { cause: err }
    );
  }
}

class WebhookStore {
  constructor(options = {}) {
    if (!options.filePath) {
      throw new WebhookStoreError("INVALID_REQUEST", "filePath is required.");
    }
    this.filePath = options.filePath;
    this.logger = options.logger || defaultLogger;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    this.defaultMaxAttempts = Number.isInteger(options.defaultMaxAttempts) && options.defaultMaxAttempts > 0
      ? options.defaultMaxAttempts
      : 5;
    // Atomic claim that BOTH waits for the data-mutation lock AND
    // increments the direct-write counter so backup/restore's
    // busy-check sees us. Without this, the previous pre-queue
    // `await waitForDataMutationLock()` had a TOCTOU window: gate
    // observed lock clear → backup set lock and started reading
    // archive → this commit enqueued and renamed the JSON file
    // underneath the read. The slot must be released after the
    // write so the counter returns to zero.
    this.claimDirectDataWriteSlot = typeof options.claimDirectDataWriteSlot === "function"
      ? options.claimDirectDataWriteSlot
      : null;
    this.state = null;
    this.loadPromise = null;
    this.commitQueue = Promise.resolve();
  }

  async load() {
    if (this.state) return cloneState(this.state);
    if (!this.loadPromise) {
      this.loadPromise = this.#loadInternal().catch((err) => {
        this.loadPromise = null;
        throw err;
      });
    }
    await this.loadPromise;
    return cloneState(this.state);
  }

  async #loadInternal() {
    let raw;
    try {
      raw = await fsp.readFile(this.filePath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        const fresh = buildDefaultStore();
        fresh.updatedAt = this.now().toISOString();
        await writeJsonAtomic(this.filePath, fresh);
        this.state = fresh;
        return;
      }
      throw new WebhookStoreError(
        "STORE_READ_FAILED",
        `Failed to read webhook store from ${this.filePath}: ${err.message}`,
        { cause: err }
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new WebhookStoreError(
        "STORE_PARSE_FAILED",
        `Webhook store ${this.filePath} is not valid JSON: ${err.message}`,
        { cause: err }
      );
    }
    this.state = normalizeStore(parsed);
  }

  async getSnapshot() {
    return this.load();
  }

  // B7 follow-up / #205 — see lib/store-health-probe.js.
  async healthCheck() {
    return probeStoreFile(this.filePath);
  }

  async reload() {
    await this.commitQueue.catch(() => {});
    if (this.loadPromise) await this.loadPromise.catch(() => {});
    this.state = null;
    this.loadPromise = null;
    return this.load();
  }

  async #commit(updater) {
    // Atomically wait for the lock AND claim a direct-write slot.
    // The slot must be claimed BEFORE we enqueue (so backup drain
    // finds the queue empty and doesn't deadlock) AND released
    // AFTER the write (so backup's busy-check observes we're still
    // in flight). The slot is released in the `run`'s finally so
    // we hold it for the smallest possible window.
    let releaseSlot = null;
    if (this.claimDirectDataWriteSlot) {
      releaseSlot = await this.claimDirectDataWriteSlot();
    }
    const run = async () => {
      try {
        const current = this.state ? cloneState(this.state) : await this.load();
        const next = updater(current);
        next.updatedAt = this.now().toISOString();
        const finalState = normalizeStore(next);
        await writeJsonAtomic(this.filePath, finalState);
        this.state = finalState;
        return cloneState(this.state);
      } finally {
        if (releaseSlot) releaseSlot();
      }
    };
    const next = this.commitQueue.then(run, run);
    this.commitQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async create({ url, events, enabled = true, maxAttempts, label } = {}) {
    const normalizedUrl = normalizeUrl(url);
    const normalizedEvents = normalizeEvents(events);
    const normalizedMaxAttempts = normalizeMaxAttempts(maxAttempts, this.defaultMaxAttempts);
    const normalizedLabel = normalizeLabel(label);
    if (typeof enabled !== "boolean") {
      throw new WebhookStoreError("INVALID_REQUEST", "enabled must be boolean.");
    }
    const id = generateSubscriptionId();
    const secret = generateSecret();
    const nowIso = this.now().toISOString();
    const sub = {
      id,
      url: normalizedUrl,
      events: normalizedEvents,
      enabled,
      secret,
      maxAttempts: normalizedMaxAttempts,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    if (normalizedLabel !== undefined) sub.label = normalizedLabel;
    await this.#commit((state) => {
      state.subscriptions.push(sub);
      return state;
    });
    return cloneState(sub);
  }

  async update(id, patch) {
    if (!ID_PATTERN.test(String(id || ""))) {
      throw new WebhookStoreError("INVALID_REQUEST", "Invalid subscription id.");
    }
    if (!isPlainObject(patch)) {
      throw new WebhookStoreError("INVALID_REQUEST", "patch must be an object.");
    }
    let updated;
    await this.#commit((state) => {
      const idx = state.subscriptions.findIndex((s) => s.id === id);
      if (idx === -1) {
        throw new WebhookStoreError("SUBSCRIPTION_NOT_FOUND", `No subscription with id ${id}.`);
      }
      const merged = { ...state.subscriptions[idx] };
      if (patch.url !== undefined) merged.url = normalizeUrl(patch.url);
      if (patch.events !== undefined) merged.events = normalizeEvents(patch.events);
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== "boolean") {
          throw new WebhookStoreError("INVALID_REQUEST", "enabled must be boolean.");
        }
        merged.enabled = patch.enabled;
      }
      if (patch.maxAttempts !== undefined) {
        merged.maxAttempts = normalizeMaxAttempts(patch.maxAttempts, this.defaultMaxAttempts);
      }
      if (patch.label !== undefined) {
        const lbl = normalizeLabel(patch.label);
        if (lbl === undefined) delete merged.label;
        else merged.label = lbl;
      }
      if (patch.rotateSecret === true) {
        merged.secret = generateSecret();
      }
      merged.updatedAt = this.now().toISOString();
      state.subscriptions.splice(idx, 1, merged);
      updated = merged;
      return state;
    });
    return cloneState(updated);
  }

  async remove(id) {
    if (!ID_PATTERN.test(String(id || ""))) {
      throw new WebhookStoreError("INVALID_REQUEST", "Invalid subscription id.");
    }
    let removed = null;
    await this.#commit((state) => {
      const idx = state.subscriptions.findIndex((s) => s.id === id);
      if (idx === -1) {
        throw new WebhookStoreError("SUBSCRIPTION_NOT_FOUND", `No subscription with id ${id}.`);
      }
      removed = state.subscriptions[idx];
      state.subscriptions.splice(idx, 1);
      return state;
    });
    return cloneState(removed);
  }

  async findById(id) {
    const snap = await this.load();
    return snap.subscriptions.find((s) => s.id === id) || null;
  }

  async findEnabledForEvent(eventName) {
    const snap = await this.load();
    return snap.subscriptions.filter((s) => s.enabled && s.events.includes(eventName));
  }
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

// Strip the secret from a subscription for response payloads. Used by the
// listing endpoint and any update path that doesn't return the secret.
function redactSecret(sub) {
  if (!sub) return sub;
  const out = cloneState(sub);
  delete out.secret;
  return out;
}

module.exports = {
  WebhookStore,
  WebhookStoreError,
  generateSubscriptionId,
  generateSecret,
  redactSecret,
  normalizeSubscription,
  normalizeStore,
  STORE_VERSION,
  ID_PATTERN,
  EVENT_PATTERN
};

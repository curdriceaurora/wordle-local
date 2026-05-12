"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const { logger: defaultLogger } = require("./logger");

const STORE_VERSION = 1;
const ENDPOINT_HASH_PATTERN = /^[a-f0-9]{16}$/;
const ENDPOINT_PATTERN = /^https:\/\//;
const ENDPOINT_MAX_LENGTH = 4096;
const P256DH_MAX_LENGTH = 256;
const AUTH_MAX_LENGTH = 64;
const UA_MAX_LENGTH = 256;
// Mirror admin-jobs-store.js — Windows surfaces these on rename-over-existing.
const WINDOWS_RENAME_OVERWRITE_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

class PushSubscriptionStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "PushSubscriptionStoreError";
    this.code = code;
    if (options.cause) this.cause = options.cause;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function endpointHashOf(endpoint) {
  return nodeCrypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
}

function normalizeEndpoint(raw) {
  if (typeof raw !== "string") {
    throw new PushSubscriptionStoreError("INVALID_REQUEST", "endpoint must be a string.");
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > ENDPOINT_MAX_LENGTH) {
    throw new PushSubscriptionStoreError("INVALID_REQUEST", "endpoint must be 1–4096 chars.");
  }
  if (!ENDPOINT_PATTERN.test(trimmed)) {
    throw new PushSubscriptionStoreError("INVALID_REQUEST", "endpoint must use https:// scheme.");
  }
  try {
    new URL(trimmed);
  } catch (_err) {
    throw new PushSubscriptionStoreError("INVALID_REQUEST", "endpoint is not a valid URL.");
  }
  return trimmed;
}

function normalizeKeys(raw) {
  if (!isPlainObject(raw)) {
    throw new PushSubscriptionStoreError("INVALID_REQUEST", "keys must be an object.");
  }
  if (typeof raw.p256dh !== "string" || raw.p256dh.length === 0 || raw.p256dh.length > P256DH_MAX_LENGTH) {
    throw new PushSubscriptionStoreError(
      "INVALID_REQUEST",
      `keys.p256dh must be a 1–${P256DH_MAX_LENGTH} char string.`
    );
  }
  if (typeof raw.auth !== "string" || raw.auth.length === 0 || raw.auth.length > AUTH_MAX_LENGTH) {
    throw new PushSubscriptionStoreError(
      "INVALID_REQUEST",
      `keys.auth must be a 1–${AUTH_MAX_LENGTH} char string.`
    );
  }
  return { p256dh: raw.p256dh, auth: raw.auth };
}

function normalizeUa(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    throw new PushSubscriptionStoreError("INVALID_REQUEST", "ua must be a string.");
  }
  return raw.length > UA_MAX_LENGTH ? raw.slice(0, UA_MAX_LENGTH) : raw;
}

function normalizeSubscription(raw) {
  if (!isPlainObject(raw)) {
    throw new PushSubscriptionStoreError("INVALID_SUBSCRIPTION", "Subscription must be an object.");
  }
  if (!ENDPOINT_HASH_PATTERN.test(raw.endpointHash || "")) {
    throw new PushSubscriptionStoreError(
      "INVALID_SUBSCRIPTION",
      `Invalid endpointHash: ${raw.endpointHash}`
    );
  }
  const normalizedEndpoint = normalizeEndpoint(raw.endpoint);
  // The hash MUST match the endpoint — every dedupe/lookup/remove path
  // keys off endpointHash, so a hand-edited row with mismatched hash
  // would orphan the real endpoint or collide with the wrong row. Re-
  // compute and reject divergence rather than trusting on-disk input.
  const expectedHash = endpointHashOf(normalizedEndpoint);
  if (raw.endpointHash !== expectedHash) {
    throw new PushSubscriptionStoreError(
      "INVALID_SUBSCRIPTION",
      "endpointHash does not match sha256 of endpoint."
    );
  }
  const out = {
    endpointHash: expectedHash,
    endpoint: normalizedEndpoint,
    keys: normalizeKeys(raw.keys),
    createdAt: typeof raw.createdAt === "string" && raw.createdAt
      ? raw.createdAt
      : new Date().toISOString()
  };
  const ua = normalizeUa(raw.ua);
  if (ua !== undefined) out.ua = ua;
  if (typeof raw.lastSuccessAt === "string" || raw.lastSuccessAt === null) {
    if (raw.lastSuccessAt) out.lastSuccessAt = raw.lastSuccessAt;
  }
  if (typeof raw.lastFailureAt === "string" || raw.lastFailureAt === null) {
    if (raw.lastFailureAt) out.lastFailureAt = raw.lastFailureAt;
  }
  if (typeof raw.firstFailureAt === "string" || raw.firstFailureAt === null) {
    if (raw.firstFailureAt) out.firstFailureAt = raw.firstFailureAt;
  }
  if (Number.isInteger(raw.failureStreak) && raw.failureStreak >= 0) {
    out.failureStreak = raw.failureStreak;
  }
  return out;
}

function buildDefaultStore() {
  return {
    version: STORE_VERSION,
    updatedAt: new Date().toISOString(),
    lastBroadcastAt: null,
    lastDailyFireAt: null,
    subscriptions: []
  };
}

function normalizeStore(raw) {
  if (!isPlainObject(raw)) {
    throw new PushSubscriptionStoreError("INVALID_STORE", "Store must be an object.");
  }
  if (raw.version !== STORE_VERSION) {
    throw new PushSubscriptionStoreError(
      "VERSION_UNSUPPORTED",
      `Push subscription store version ${raw.version} is not supported.`
    );
  }
  if (typeof raw.updatedAt !== "string") {
    throw new PushSubscriptionStoreError("INVALID_STORE", "updatedAt is required.");
  }
  if (!Array.isArray(raw.subscriptions)) {
    throw new PushSubscriptionStoreError("INVALID_STORE", "subscriptions must be an array.");
  }
  const seen = new Set();
  const subscriptions = [];
  for (const sub of raw.subscriptions) {
    const normalized = normalizeSubscription(sub);
    if (seen.has(normalized.endpointHash)) continue;
    seen.add(normalized.endpointHash);
    subscriptions.push(normalized);
  }
  subscriptions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.endpointHash.localeCompare(b.endpointHash));
  return {
    version: STORE_VERSION,
    updatedAt: raw.updatedAt,
    lastBroadcastAt: typeof raw.lastBroadcastAt === "string" ? raw.lastBroadcastAt : null,
    lastDailyFireAt: typeof raw.lastDailyFireAt === "string" ? raw.lastDailyFireAt : null,
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
    throw new PushSubscriptionStoreError(
      "STORE_WRITE_FAILED",
      `Failed to persist push-subscription store to ${filePath}: ${err.message}`,
      { cause: err }
    );
  }
}

class PushSubscriptionStore {
  constructor(options = {}) {
    if (!options.filePath) {
      throw new PushSubscriptionStoreError("INVALID_REQUEST", "filePath is required.");
    }
    this.filePath = options.filePath;
    this.logger = options.logger || defaultLogger;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    // Cutoff (in days) used by `pruneStale()` to evict subscriptions
    // whose `firstFailureAt` is older than this. HTTP 410 (Gone)
    // responses are pruned IMMEDIATELY in `markFailure({gone:true})`
    // and don't depend on this value; only non-410 transient failure
    // streaks rely on the cutoff to eventually purge dead rows.
    this.pruneAfterDays = Number.isInteger(options.pruneAfterDays) && options.pruneAfterDays > 0
      ? options.pruneAfterDays
      : 7;
    // Same atomic-claim wiring as webhook stores — see WebhookStore for
    // the rationale around backup/restore safety.
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
      throw new PushSubscriptionStoreError(
        "STORE_READ_FAILED",
        `Failed to read push-subscription store from ${this.filePath}: ${err.message}`,
        { cause: err }
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new PushSubscriptionStoreError(
        "STORE_PARSE_FAILED",
        `Push-subscription store ${this.filePath} is not valid JSON: ${err.message}`,
        { cause: err }
      );
    }
    this.state = normalizeStore(parsed);
  }

  async getSnapshot() {
    return this.load();
  }

  async reload() {
    await this.commitQueue.catch(() => {});
    if (this.loadPromise) await this.loadPromise.catch(() => {});
    this.state = null;
    this.loadPromise = null;
    return this.load();
  }

  async #commit(updater) {
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

  // Insert or update by endpoint. Two browsers on the same host hit
  // different endpoints — they're separate subscriptions. The same
  // endpoint re-registering (re-subscribe after permission toggle)
  // updates the existing row in place rather than duplicating.
  async upsert({ endpoint, keys, ua } = {}) {
    const normalizedEndpoint = normalizeEndpoint(endpoint);
    const normalizedKeys = normalizeKeys(keys);
    const normalizedUa = normalizeUa(ua);
    const endpointHash = endpointHashOf(normalizedEndpoint);
    let result;
    await this.#commit((state) => {
      const idx = state.subscriptions.findIndex((s) => s.endpointHash === endpointHash);
      const nowIso = this.now().toISOString();
      if (idx >= 0) {
        const merged = { ...state.subscriptions[idx], endpoint: normalizedEndpoint, keys: normalizedKeys };
        // Reset failure tracking — a re-upsert is the user explicitly
        // re-establishing this device's subscription; without this,
        // a browser refreshing after a few transient failures could be
        // pruned by `pruneStale` almost immediately on its fresh
        // registration.
        delete merged.failureStreak;
        delete merged.firstFailureAt;
        delete merged.lastFailureAt;
        if (normalizedUa !== undefined) merged.ua = normalizedUa;
        state.subscriptions.splice(idx, 1, merged);
        result = merged;
      } else {
        const fresh = {
          endpointHash,
          endpoint: normalizedEndpoint,
          keys: normalizedKeys,
          createdAt: nowIso
        };
        if (normalizedUa !== undefined) fresh.ua = normalizedUa;
        state.subscriptions.push(fresh);
        result = fresh;
      }
      return state;
    });
    return cloneState(result);
  }

  async removeByHash(endpointHash) {
    if (!ENDPOINT_HASH_PATTERN.test(String(endpointHash || ""))) {
      throw new PushSubscriptionStoreError("INVALID_REQUEST", "Invalid endpointHash.");
    }
    let removed = null;
    await this.#commit((state) => {
      const idx = state.subscriptions.findIndex((s) => s.endpointHash === endpointHash);
      if (idx === -1) return state;
      removed = state.subscriptions[idx];
      state.subscriptions.splice(idx, 1);
      return state;
    });
    return cloneState(removed);
  }

  async findByHash(endpointHash) {
    const snap = await this.load();
    return snap.subscriptions.find((s) => s.endpointHash === endpointHash) || null;
  }

  async list() {
    const snap = await this.load();
    return snap.subscriptions.slice();
  }

  // Mark a successful send: clear failure tracking, bump lastSuccessAt.
  async markSuccess(endpointHash) {
    if (!ENDPOINT_HASH_PATTERN.test(String(endpointHash || ""))) {
      throw new PushSubscriptionStoreError("INVALID_REQUEST", "Invalid endpointHash.");
    }
    let updated = null;
    await this.#commit((state) => {
      const idx = state.subscriptions.findIndex((s) => s.endpointHash === endpointHash);
      if (idx === -1) return state;
      const merged = { ...state.subscriptions[idx], lastSuccessAt: this.now().toISOString() };
      delete merged.failureStreak;
      delete merged.firstFailureAt;
      delete merged.lastFailureAt;
      state.subscriptions.splice(idx, 1, merged);
      updated = merged;
      return state;
    });
    return cloneState(updated);
  }

  // Mark a failure. If `gone === true`, the row is deleted immediately
  // (HTTP 410 means the subscription is permanently invalid). Otherwise
  // we increment failureStreak and stamp firstFailureAt; the prune()
  // method evicts streaks older than `pruneAfterDays`.
  async markFailure(endpointHash, { gone = false } = {}) {
    if (!ENDPOINT_HASH_PATTERN.test(String(endpointHash || ""))) {
      throw new PushSubscriptionStoreError("INVALID_REQUEST", "Invalid endpointHash.");
    }
    let result = null;
    await this.#commit((state) => {
      const idx = state.subscriptions.findIndex((s) => s.endpointHash === endpointHash);
      if (idx === -1) return state;
      if (gone) {
        result = { ...state.subscriptions[idx], pruned: true };
        state.subscriptions.splice(idx, 1);
        return state;
      }
      const current = state.subscriptions[idx];
      const nowIso = this.now().toISOString();
      const merged = {
        ...current,
        lastFailureAt: nowIso,
        failureStreak: (current.failureStreak || 0) + 1,
        firstFailureAt: current.firstFailureAt || nowIso
      };
      state.subscriptions.splice(idx, 1, merged);
      result = merged;
      return state;
    });
    return cloneState(result);
  }

  // Evict subscriptions whose failure streak first started more than
  // `pruneAfterDays` ago. This catches rows that returned non-410 errors
  // but never came back; the operator's logs will show the streak.
  async pruneStale() {
    const cutoff = this.now().getTime() - this.pruneAfterDays * 24 * 60 * 60 * 1000;
    const removed = [];
    await this.#commit((state) => {
      state.subscriptions = state.subscriptions.filter((s) => {
        if (!s.firstFailureAt) return true;
        const firstFailMs = new Date(s.firstFailureAt).getTime();
        if (Number.isNaN(firstFailMs) || firstFailMs > cutoff) return true;
        removed.push(s.endpointHash);
        return false;
      });
      return state;
    });
    return removed;
  }

  async stampLastBroadcast(at = this.now()) {
    await this.#commit((state) => {
      state.lastBroadcastAt = at.toISOString();
      return state;
    });
  }

  async stampLastDailyFire(at = this.now()) {
    await this.#commit((state) => {
      state.lastDailyFireAt = at.toISOString();
      return state;
    });
  }
}

function cloneState(state) {
  if (state === null || state === undefined) return state;
  return JSON.parse(JSON.stringify(state));
}

module.exports = {
  PushSubscriptionStore,
  PushSubscriptionStoreError,
  endpointHashOf,
  normalizeSubscription,
  normalizeStore,
  STORE_VERSION,
  ENDPOINT_HASH_PATTERN
};

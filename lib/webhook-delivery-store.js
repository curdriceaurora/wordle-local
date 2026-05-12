"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const { logger: defaultLogger } = require("./logger");

const STORE_VERSION = 1;
const STATUSES = Object.freeze(["queued", "running", "succeeded", "failed", "canceled"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RESPONSE_SNIPPET_MAX = 4096;
const LAST_ERROR_MAX = 2048;
// Cap on serialized payload bytes. Persisted with the delivery row so
// boot recovery and manual retries can resend the original body. The
// cap exists so a malicious or buggy emit can't swell
// data/webhook-deliveries.json without bound.
const PAYLOAD_MAX_BYTES = 8 * 1024;
const WINDOWS_RENAME_OVERWRITE_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

class WebhookDeliveryStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "WebhookDeliveryStoreError";
    this.code = code;
    if (options.cause) this.cause = options.cause;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function generateDeliveryId() {
  return nodeCrypto.randomBytes(16).toString("base64url");
}

function clampString(value, max) {
  if (typeof value !== "string") return undefined;
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function normalizeDelivery(raw) {
  if (!isPlainObject(raw)) {
    throw new WebhookDeliveryStoreError("INVALID_DELIVERY", "Delivery must be an object.");
  }
  if (!ID_PATTERN.test(raw.id || "")) {
    throw new WebhookDeliveryStoreError("INVALID_DELIVERY", `Invalid delivery id: ${raw.id}`);
  }
  if (!ID_PATTERN.test(raw.subscriptionId || "")) {
    throw new WebhookDeliveryStoreError(
      "INVALID_DELIVERY",
      `Invalid subscriptionId: ${raw.subscriptionId}`
    );
  }
  if (typeof raw.event !== "string" || !raw.event) {
    throw new WebhookDeliveryStoreError("INVALID_DELIVERY", "event is required.");
  }
  if (!STATUSES.includes(raw.status)) {
    throw new WebhookDeliveryStoreError("INVALID_DELIVERY", `Invalid status: ${raw.status}`);
  }
  if (!Number.isInteger(raw.attempts) || raw.attempts < 0) {
    throw new WebhookDeliveryStoreError("INVALID_DELIVERY", "attempts must be a non-negative integer.");
  }
  // createdAt/updatedAt must be non-empty strings — without this guard
  // a hand-edited file could pass non-string values straight through to
  // normalizeStore's localeCompare sort and crash with a TypeError far
  // from the validation site.
  if (typeof raw.createdAt !== "string" || !raw.createdAt) {
    throw new WebhookDeliveryStoreError("INVALID_DELIVERY", "createdAt is required.");
  }
  if (typeof raw.updatedAt !== "string" || !raw.updatedAt) {
    throw new WebhookDeliveryStoreError("INVALID_DELIVERY", "updatedAt is required.");
  }
  const out = {
    id: raw.id,
    subscriptionId: raw.subscriptionId,
    event: raw.event,
    status: raw.status,
    attempts: raw.attempts,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
  if (typeof raw.url === "string") out.url = raw.url;
  if (Number.isInteger(raw.responseStatus)) out.responseStatus = raw.responseStatus;
  const snippet = clampString(raw.responseSnippet, RESPONSE_SNIPPET_MAX);
  if (snippet !== undefined) out.responseSnippet = snippet;
  const lastError = clampString(raw.lastError, LAST_ERROR_MAX);
  if (lastError !== undefined) out.lastError = lastError;
  if (typeof raw.nextAttemptAt === "string") out.nextAttemptAt = raw.nextAttemptAt;
  if (isPlainObject(raw.payload)) {
    // Drop oversized payloads silently; the delivery is still
    // executable, just with `{}` as the recovered payload. Compare in
    // BYTES (Buffer.byteLength), not String.length — JSON.stringify
    // returns a UTF-16 string but the persisted file is UTF-8, so a
    // payload with multi-byte characters could otherwise sneak past a
    // .length check.
    try {
      const serialized = JSON.stringify(raw.payload);
      if (serialized && Buffer.byteLength(serialized, "utf8") <= PAYLOAD_MAX_BYTES) {
        out.payload = JSON.parse(serialized);
      }
    } catch (_err) {
      // unrepresentable as JSON — drop
    }
  }
  return out;
}

function buildDefaultStore() {
  return {
    version: STORE_VERSION,
    updatedAt: new Date().toISOString(),
    deliveries: []
  };
}

function normalizeStore(raw) {
  if (!isPlainObject(raw)) {
    throw new WebhookDeliveryStoreError("INVALID_STORE", "Store must be an object.");
  }
  if (raw.version !== STORE_VERSION) {
    throw new WebhookDeliveryStoreError(
      "VERSION_UNSUPPORTED",
      `Webhook delivery store version ${raw.version} is not supported.`
    );
  }
  if (typeof raw.updatedAt !== "string") {
    throw new WebhookDeliveryStoreError("INVALID_STORE", "updatedAt is required.");
  }
  if (!Array.isArray(raw.deliveries)) {
    throw new WebhookDeliveryStoreError("INVALID_STORE", "deliveries must be an array.");
  }
  const seen = new Set();
  const deliveries = [];
  for (const d of raw.deliveries) {
    const norm = normalizeDelivery(d);
    if (seen.has(norm.id)) continue;
    seen.add(norm.id);
    deliveries.push(norm);
  }
  // Sort by createdAt ascending so retention prunes the oldest first.
  deliveries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { version: STORE_VERSION, updatedAt: raw.updatedAt, deliveries };
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
    throw new WebhookDeliveryStoreError(
      "STORE_WRITE_FAILED",
      `Failed to persist delivery store to ${filePath}: ${err.message}`,
      { cause: err }
    );
  }
}

class WebhookDeliveryStore {
  constructor(options = {}) {
    if (!options.filePath) {
      throw new WebhookDeliveryStoreError("INVALID_REQUEST", "filePath is required.");
    }
    this.filePath = options.filePath;
    this.logger = options.logger || defaultLogger;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    // History cap; oldest get evicted when the count exceeds this.
    this.historyMax = Number.isInteger(options.historyMax) && options.historyMax > 0
      ? options.historyMax
      : 200;
    // Atomic data-write claim — see WebhookStore for the rationale.
    // Background `executeOnce()` calls `update()` outside the admin
    // `withSlot()` wrapper, so without this slot, an in-flight
    // delivery could rename `webhook-deliveries.json` underneath a
    // backup that just observed the queue as empty.
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
      throw new WebhookDeliveryStoreError(
        "STORE_READ_FAILED",
        `Failed to read delivery store from ${this.filePath}: ${err.message}`,
        { cause: err }
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new WebhookDeliveryStoreError(
        "STORE_PARSE_FAILED",
        `Delivery store ${this.filePath} is not valid JSON: ${err.message}`,
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
    // Atomically claim a direct-write slot — see WebhookStore.#commit.
    let releaseSlot = null;
    if (this.claimDirectDataWriteSlot) {
      releaseSlot = await this.claimDirectDataWriteSlot();
    }
    const run = async () => {
      try {
        const current = this.state ? cloneState(this.state) : await this.load();
        const next = updater(current);
        // Apply retention cap before normalization. Only evict TERMINAL
        // rows (succeeded/failed/canceled) when the count exceeds the
        // cap — pruning a `queued` or `running` row would orphan its
        // timer and silently drop the delivery (executeOnce would log
        // "delivery not found" and never retry). In a sustained burst
        // bigger than `historyMax`, the oldest active rows are kept
        // and the file may temporarily exceed historyMax until they
        // reach a terminal state.
        if (Array.isArray(next.deliveries) && next.deliveries.length > this.historyMax) {
          const ACTIVE = new Set(["queued", "running"]);
          const sorted = next.deliveries.slice().sort(
            (a, b) => (a.createdAt || "").localeCompare(b.createdAt || "")
              || (a.id || "").localeCompare(b.id || "")
          );
          const target = this.historyMax;
          let toEvict = sorted.length - target;
          const survivorIds = new Set();
          const evictedIds = new Set();
          for (const d of sorted) {
            if (toEvict > 0 && !ACTIVE.has(d.status)) {
              evictedIds.add(d.id);
              toEvict -= 1;
            } else {
              survivorIds.add(d.id);
            }
          }
          next.deliveries = next.deliveries.filter((d) => survivorIds.has(d.id) || !evictedIds.has(d.id));
        }
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

  async enqueue({ subscriptionId, event, url, nextAttemptAt, payload }) {
    if (!ID_PATTERN.test(String(subscriptionId || ""))) {
      throw new WebhookDeliveryStoreError("INVALID_REQUEST", "subscriptionId is required.");
    }
    if (typeof event !== "string" || !event) {
      throw new WebhookDeliveryStoreError("INVALID_REQUEST", "event is required.");
    }
    const id = generateDeliveryId();
    const nowIso = this.now().toISOString();
    const delivery = {
      id,
      subscriptionId,
      event,
      status: "queued",
      attempts: 0,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    if (typeof url === "string") delivery.url = url;
    if (typeof nextAttemptAt === "string") delivery.nextAttemptAt = nextAttemptAt;
    if (isPlainObject(payload)) {
      // Drop oversized payloads (UTF-8 byte count, not String.length).
      // The delivery still fires; the recovered payload will be `{}`.
      try {
        const serialized = JSON.stringify(payload);
        if (serialized && Buffer.byteLength(serialized, "utf8") <= PAYLOAD_MAX_BYTES) {
          delivery.payload = JSON.parse(serialized);
        }
      } catch (_err) {
        // unrepresentable — proceed without payload
      }
    }
    await this.#commit((state) => {
      state.deliveries.push(delivery);
      return state;
    });
    return cloneState(delivery);
  }

  async update(id, patch) {
    if (!ID_PATTERN.test(String(id || ""))) {
      throw new WebhookDeliveryStoreError("INVALID_REQUEST", "Invalid delivery id.");
    }
    if (!isPlainObject(patch)) {
      throw new WebhookDeliveryStoreError("INVALID_REQUEST", "patch must be an object.");
    }
    let updated;
    await this.#commit((state) => {
      const idx = state.deliveries.findIndex((d) => d.id === id);
      if (idx === -1) {
        throw new WebhookDeliveryStoreError("DELIVERY_NOT_FOUND", `No delivery with id ${id}.`);
      }
      const merged = { ...state.deliveries[idx] };
      if (patch.status !== undefined) {
        if (!STATUSES.includes(patch.status)) {
          throw new WebhookDeliveryStoreError("INVALID_REQUEST", `Invalid status: ${patch.status}`);
        }
        merged.status = patch.status;
      }
      if (patch.attempts !== undefined) {
        if (!Number.isInteger(patch.attempts) || patch.attempts < 0) {
          throw new WebhookDeliveryStoreError("INVALID_REQUEST", "attempts must be a non-negative integer.");
        }
        merged.attempts = patch.attempts;
      }
      if (patch.responseStatus !== undefined) {
        if (!Number.isInteger(patch.responseStatus)) {
          throw new WebhookDeliveryStoreError("INVALID_REQUEST", "responseStatus must be an integer.");
        }
        merged.responseStatus = patch.responseStatus;
      }
      if (patch.responseSnippet !== undefined) {
        merged.responseSnippet = clampString(patch.responseSnippet, RESPONSE_SNIPPET_MAX);
      }
      if (patch.lastError !== undefined) {
        const trimmed = clampString(patch.lastError, LAST_ERROR_MAX);
        if (trimmed === undefined || trimmed === "") delete merged.lastError;
        else merged.lastError = trimmed;
      }
      if (patch.nextAttemptAt !== undefined) {
        if (patch.nextAttemptAt === null || patch.nextAttemptAt === "") {
          delete merged.nextAttemptAt;
        } else {
          merged.nextAttemptAt = patch.nextAttemptAt;
        }
      }
      merged.updatedAt = this.now().toISOString();
      state.deliveries.splice(idx, 1, merged);
      updated = merged;
      return state;
    });
    return cloneState(updated);
  }

  async findById(id) {
    const snap = await this.load();
    return snap.deliveries.find((d) => d.id === id) || null;
  }

  async findRecent({ subscriptionId, status, event, limit }) {
    const snap = await this.load();
    let rows = snap.deliveries.slice();
    if (subscriptionId) rows = rows.filter((d) => d.subscriptionId === subscriptionId);
    if (status) rows = rows.filter((d) => d.status === status);
    if (event) rows = rows.filter((d) => d.event === event);
    rows.reverse(); // newest first
    const cap = Number.isInteger(limit) && limit > 0 ? limit : rows.length;
    return rows.slice(0, cap);
  }

  async findRecoverable() {
    // Anything in `running` at boot is a candidate for restart recovery —
    // the previous process died mid-flight.
    const snap = await this.load();
    return snap.deliveries.filter((d) => d.status === "running" || d.status === "queued");
  }

  async deleteForSubscription(subscriptionId) {
    if (!ID_PATTERN.test(String(subscriptionId || ""))) {
      throw new WebhookDeliveryStoreError("INVALID_REQUEST", "Invalid subscription id.");
    }
    let removed = 0;
    await this.#commit((state) => {
      const before = state.deliveries.length;
      state.deliveries = state.deliveries.filter((d) => d.subscriptionId !== subscriptionId);
      removed = before - state.deliveries.length;
      return state;
    });
    return removed;
  }
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

module.exports = {
  WebhookDeliveryStore,
  WebhookDeliveryStoreError,
  generateDeliveryId,
  normalizeDelivery,
  normalizeStore,
  STORE_VERSION,
  STATUSES
};

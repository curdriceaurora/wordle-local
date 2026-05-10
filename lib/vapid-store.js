"use strict";

const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");

// Dedicated store for the VAPID keypair so the private half stays out
// of any user-visible export path. The earlier design persisted these
// in `data/app-config.json`, but that file is part of the backup
// archive — admin-key-holders downloading a backup could extract the
// private key from offline copies. Splitting it into a separate file
// (NOT in the backup `IN_SCOPE_FILES` list) keeps the secret pinned
// to the host that generated it; restoring a backup on a fresh node
// triggers re-generation, which invalidates existing subscriptions
// — but that was already true for any restore-to-new-host scenario.

const SCHEMA_VERSION = 1;
const VAPID_SUBJECT_PATTERN = /^(mailto:|https:)/;
const WINDOWS_RENAME_OVERWRITE_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

class VapidStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "VapidStoreError";
    this.code = code;
    if (options.cause) this.cause = options.cause;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (value === null || value === undefined) return value;
  return structuredClone(value);
}

function writeJsonAtomicSync(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    try {
      fs.renameSync(tempPath, filePath);
    } catch (renameErr) {
      if (!renameErr || !WINDOWS_RENAME_OVERWRITE_CODES.has(renameErr.code)) throw renameErr;
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tempPath, filePath);
    }
  } catch (err) {
    try { fs.rmSync(tempPath, { force: true }); } catch (_e) { /* best-effort */ }
    throw new VapidStoreError(
      "STORE_WRITE_FAILED",
      `Failed to persist VAPID store at ${filePath}.`,
      { cause: err }
    );
  }
}

function normalizeKeys(raw) {
  if (!isObject(raw)) {
    throw new VapidStoreError("INVALID_KEYS", "vapid-keys.keys must be an object.");
  }
  if (typeof raw.publicKey !== "string" || raw.publicKey.length < 80 || raw.publicKey.length > 200) {
    throw new VapidStoreError(
      "INVALID_KEYS",
      "vapid-keys.publicKey must be the URL-safe base64 string from generateVAPIDKeys()."
    );
  }
  if (typeof raw.privateKey !== "string" || raw.privateKey.length < 40 || raw.privateKey.length > 100) {
    throw new VapidStoreError(
      "INVALID_KEYS",
      "vapid-keys.privateKey must be the URL-safe base64 string from generateVAPIDKeys()."
    );
  }
  if (typeof raw.subject !== "string" || !VAPID_SUBJECT_PATTERN.test(raw.subject) || raw.subject.length > 256) {
    throw new VapidStoreError(
      "INVALID_KEYS",
      "vapid-keys.subject must be a mailto: or https: identifier (RFC 8292)."
    );
  }
  return {
    publicKey: raw.publicKey,
    privateKey: raw.privateKey,
    subject: raw.subject
  };
}

class VapidStore {
  constructor(options = {}) {
    if (!options.filePath) {
      throw new VapidStoreError("INVALID_REQUEST", "filePath is required.");
    }
    this.filePath = options.filePath;
    this.logger = options.logger || console;
    this.state = null;
  }

  loadSync() {
    if (this.state) return clone(this.state);
    if (!fs.existsSync(this.filePath)) {
      this.state = null;
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (err) {
      this.logger.warn?.(
        `[vapid-store] ${this.filePath} is not valid JSON; treating as missing. (${err.message})`
      );
      this.state = null;
      return null;
    }
    if (!isObject(parsed) || parsed.version !== SCHEMA_VERSION || !isObject(parsed.keys)) {
      this.logger.warn?.(
        `[vapid-store] ${this.filePath} has unsupported shape; treating as missing.`
      );
      this.state = null;
      return null;
    }
    try {
      const keys = normalizeKeys(parsed.keys);
      this.state = { version: SCHEMA_VERSION, keys, updatedAt: parsed.updatedAt || new Date().toISOString() };
    } catch (err) {
      this.logger.warn?.(`[vapid-store] ignoring invalid keys in ${this.filePath}: ${err.message}`);
      this.state = null;
    }
    return clone(this.state);
  }

  reloadSync() {
    this.state = null;
    return this.loadSync();
  }

  // Returns the persisted VAPID keypair or null if none exists yet.
  // The private key is included — server-only callers; never echo to
  // clients or include in backup/runtime-config responses.
  getKeysSync() {
    const snap = this.loadSync();
    return snap ? clone(snap.keys) : null;
  }

  // Generate-on-missing: if no keys yet, calls `generate` (typically
  // `web-push.generateVAPIDKeys`) and persists. Idempotent: subsequent
  // calls return existing keys.
  ensureKeysSync({ generate, subject } = {}) {
    if (typeof generate !== "function") {
      throw new VapidStoreError(
        "INVALID_REQUEST",
        "ensureKeysSync requires a generate function (e.g. web-push.generateVAPIDKeys)."
      );
    }
    const existing = this.getKeysSync();
    if (existing) return existing;
    const fresh = generate();
    const resolvedSubject = (typeof subject === "string" && VAPID_SUBJECT_PATTERN.test(subject))
      ? subject
      : "mailto:admin@localhost";
    const normalized = normalizeKeys({ ...fresh, subject: resolvedSubject });
    const nextState = {
      version: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      keys: normalized
    };
    writeJsonAtomicSync(this.filePath, nextState);
    this.state = nextState;
    return clone(normalized);
  }
}

module.exports = {
  VapidStore,
  VapidStoreError,
  normalizeKeys,
  SCHEMA_VERSION
};

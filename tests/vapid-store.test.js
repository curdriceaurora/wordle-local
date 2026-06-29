"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  VapidStore,
  VapidStoreError,
  normalizeKeys,
  SCHEMA_VERSION
} = require("../lib/vapid-store");

function tempPath(name = "vapid-keys.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-vapid-"));
  return path.join(dir, name);
}

function validRawKeys(overrides = {}) {
  return {
    publicKey: "B".repeat(87),
    privateKey: "x".repeat(43),
    subject: "mailto:admin@example.com",
    ...overrides
  };
}

function makeGenerate() {
  return () => ({
    publicKey: "B".repeat(87),
    privateKey: "x".repeat(43)
  });
}

describe("VapidStoreError", () => {
  test("sets name, code, and message", () => {
    const err = new VapidStoreError("TEST_CODE", "test message");
    expect(err.name).toBe("VapidStoreError");
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("test message");
  });

  test("attaches cause when provided", () => {
    const cause = new Error("underlying");
    const err = new VapidStoreError("ERR", "msg", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("SCHEMA_VERSION", () => {
  test("is 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});

describe("normalizeKeys", () => {
  test("passes through valid keys", () => {
    const raw = validRawKeys();
    const result = normalizeKeys(raw);
    expect(result).toEqual({
      publicKey: raw.publicKey,
      privateKey: raw.privateKey,
      subject: raw.subject
    });
  });

  test("throws for non-object", () => {
    expect(() => normalizeKeys(null)).toThrow(VapidStoreError);
    expect(() => normalizeKeys("string")).toThrow(VapidStoreError);
    expect(() => normalizeKeys([])).toThrow(VapidStoreError);
  });

  test("throws when publicKey is missing or wrong length", () => {
    expect(() => normalizeKeys(validRawKeys({ publicKey: "" }))).toThrow(VapidStoreError);
    expect(() => normalizeKeys(validRawKeys({ publicKey: "short" }))).toThrow(VapidStoreError);
    expect(() => normalizeKeys(validRawKeys({ publicKey: "B".repeat(201) }))).toThrow(VapidStoreError);
  });

  test("throws when privateKey is missing or wrong length", () => {
    expect(() => normalizeKeys(validRawKeys({ privateKey: "" }))).toThrow(VapidStoreError);
    expect(() => normalizeKeys(validRawKeys({ privateKey: "short" }))).toThrow(VapidStoreError);
    expect(() => normalizeKeys(validRawKeys({ privateKey: "x".repeat(101) }))).toThrow(VapidStoreError);
  });

  test("throws when subject is missing or invalid", () => {
    expect(() => normalizeKeys(validRawKeys({ subject: "" }))).toThrow(VapidStoreError);
    expect(() => normalizeKeys(validRawKeys({ subject: "plaintext" }))).toThrow(VapidStoreError);
    expect(() => normalizeKeys(validRawKeys({ subject: "mailto:" + "a".repeat(257) }))).toThrow(VapidStoreError);
  });

  test("accepts https: subject", () => {
    const raw = validRawKeys({ subject: "https://example.com" });
    const result = normalizeKeys(raw);
    expect(result.subject).toBe("https://example.com");
  });
});

describe("VapidStore constructor", () => {
  test("requires filePath option", () => {
    expect(() => new VapidStore()).toThrow(VapidStoreError);
    expect(() => new VapidStore({})).toThrow(VapidStoreError);
    expect(() => new VapidStore({ filePath: "/tmp/keys.json" })).not.toThrow();
  });

  test("initializes state to null", () => {
    const fp = tempPath();
    const store = new VapidStore({ filePath: fp });
    expect(store.state).toBeNull();
    expect(store.filePath).toBe(fp);
    fs.rmSync(path.dirname(fp), { recursive: true, force: true });
  });
});

describe("VapidStore loadSync / reloadSync", () => {
  let filePath;
  let store;

  beforeEach(() => {
    filePath = tempPath();
    store = new VapidStore({ filePath });
  });

  afterEach(async () => {
    await fsp.rm(path.dirname(filePath), { recursive: true, force: true }).catch(() => {});
  });

  test("returns null when file does not exist", () => {
    expect(store.loadSync()).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    fs.writeFileSync(filePath, "not-json", "utf8");
    expect(store.loadSync()).toBeNull();
    expect(store.state).toBeNull();
  });

  test("returns null for unsupported shape", () => {
    fs.writeFileSync(filePath, JSON.stringify({ version: 999 }), "utf8");
    expect(store.loadSync()).toBeNull();
    expect(store.state).toBeNull();
  });

  test("returns null for missing keys field", () => {
    fs.writeFileSync(filePath, JSON.stringify({ version: 1 }), "utf8");
    expect(store.loadSync()).toBeNull();
  });

  test("loads valid store file", () => {
    const raw = validRawKeys();
    const data = { version: 1, keys: raw, updatedAt: "2026-01-01T00:00:00.000Z" };
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    const result = store.loadSync();
    expect(result.version).toBe(1);
    expect(result.keys.publicKey).toBe(raw.publicKey);
    expect(result.keys.privateKey).toBe(raw.privateKey);
    expect(result.keys.subject).toBe(raw.subject);
  });

  test("loadSync caches result in state", () => {
    const raw = validRawKeys();
    const data = { version: 1, keys: raw, updatedAt: "2026-01-01T00:00:00.000Z" };
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    store.loadSync();
    expect(store.state).not.toBeNull();
    const second = store.loadSync();
    expect(second.version).toBe(1);
  });

  test("reloadSync clears cache and re-reads", () => {
    const raw = validRawKeys();
    const data = { version: 1, keys: raw, updatedAt: "2026-01-01T00:00:00.000Z" };
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    store.loadSync();
    expect(store.state).not.toBeNull();

    fs.writeFileSync(filePath, JSON.stringify({ wrong: true }), "utf8");
    const result = store.reloadSync();
    expect(result).toBeNull();
    expect(store.state).toBeNull();
  });

  test("handles missing updatedAt gracefully", () => {
    const raw = validRawKeys();
    const data = { version: 1, keys: raw };
    fs.writeFileSync(filePath, `${JSON.stringify(data)}\n`, "utf8");
    const result = store.loadSync();
    expect(result.updatedAt).toBeTruthy();
  });

  test("handles invalid keys in file gracefully", () => {
    const data = { version: 1, keys: { publicKey: "short", privateKey: "also-short", subject: "bad" } };
    fs.writeFileSync(filePath, `${JSON.stringify(data)}\n`, "utf8");
    expect(store.loadSync()).toBeNull();
    expect(store.state).toBeNull();
  });
});

describe("VapidStore getKeysSync", () => {
  let filePath;
  let store;

  beforeEach(() => {
    filePath = tempPath();
    store = new VapidStore({ filePath });
  });

  afterEach(async () => {
    await fsp.rm(path.dirname(filePath), { recursive: true, force: true }).catch(() => {});
  });

  test("returns null when no keys exist", () => {
    expect(store.getKeysSync()).toBeNull();
  });

  test("returns keys from loaded store", () => {
    const raw = validRawKeys();
    const data = { version: 1, keys: raw, updatedAt: "2026-01-01T00:00:00.000Z" };
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    const result = store.getKeysSync();
    expect(result.publicKey).toBe(raw.publicKey);
    expect(result.privateKey).toBe(raw.privateKey);
    expect(result.subject).toBe(raw.subject);
  });
});

describe("VapidStore ensureKeysSync", () => {
  let filePath;
  let store;

  beforeEach(() => {
    filePath = tempPath();
    store = new VapidStore({ filePath });
  });

  afterEach(async () => {
    await fsp.rm(path.dirname(filePath), { recursive: true, force: true }).catch(() => {});
  });

  test("throws when generate function is missing", () => {
    expect(() => store.ensureKeysSync()).toThrow(VapidStoreError);
    expect(() => store.ensureKeysSync({})).toThrow(VapidStoreError);
  });

  test("generates and persists keys when none exist", () => {
    const result = store.ensureKeysSync({ generate: makeGenerate() });
    expect(result.publicKey).toBe("B".repeat(87));
    expect(result.privateKey).toBe("x".repeat(43));
    expect(result.subject).toBe("mailto:admin@localhost");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test("uses custom subject when provided", () => {
    const result = store.ensureKeysSync({
      generate: makeGenerate(),
      subject: "mailto:admin@custom.com"
    });
    expect(result.subject).toBe("mailto:admin@custom.com");
  });

  test("falls back to default subject when custom subject is invalid", () => {
    const result = store.ensureKeysSync({
      generate: makeGenerate(),
      subject: "invalid-subject"
    });
    expect(result.subject).toBe("mailto:admin@localhost");
  });

  test("returns existing keys without generating again", () => {
    const generate = jest.fn(makeGenerate());
    store.ensureKeysSync({ generate });
    expect(generate).toHaveBeenCalledTimes(1);

    const second = store.ensureKeysSync({ generate });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(second.publicKey).toBe("B".repeat(87));
  });

  test("persisted keys survive reload", () => {
    store.ensureKeysSync({ generate: makeGenerate() });
    store.reloadSync();
    const keys = store.getKeysSync();
    expect(keys.publicKey).toBe("B".repeat(87));
  });
});

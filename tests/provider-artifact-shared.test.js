"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MAX_WORD_LENGTH,
  MIN_WORD_LENGTH,
  RELATIVE_PATH_PATTERN,
  SOURCE_MANIFEST_TYPES,
  SUPPORTED_VARIANT_IDS,
  WORD_PATTERN,
  normalizeCommit,
  normalizePolicyVersion,
  normalizeRelativePath,
  normalizeVariant,
  resolveWithinRoot,
  writeFileAtomic,
  writeJsonAtomic
} = require("../lib/provider-artifact-shared");

function errorFactory(code, message, options) {
  const err = new Error(message);
  err.code = code;
  if (options?.cause) err.cause = options.cause;
  return err;
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lhw-provider-artifact-"));
}

describe("constants", () => {
  test("MIN_WORD_LENGTH is 3", () => {
    expect(MIN_WORD_LENGTH).toBe(3);
  });

  test("MAX_WORD_LENGTH is 12", () => {
    expect(MAX_WORD_LENGTH).toBe(12);
  });

  test("WORD_PATTERN matches uppercase letters only", () => {
    expect(WORD_PATTERN.test("CAT")).toBe(true);
    expect(WORD_PATTERN.test("ABC123")).toBe(false);
    expect(WORD_PATTERN.test("cat")).toBe(false);
  });

  test("SUPPORTED_VARIANT_IDS is frozen and contains expected variants", () => {
    expect(SUPPORTED_VARIANT_IDS).toEqual(["en-GB", "en-US", "en-CA", "en-AU", "en-ZA"]);
    expect(Object.isFrozen(SUPPORTED_VARIANT_IDS)).toBe(true);
  });

  test("SOURCE_MANIFEST_TYPES is frozen", () => {
    expect(SOURCE_MANIFEST_TYPES.REMOTE_FETCH).toBe("provider-source-fetch");
    expect(SOURCE_MANIFEST_TYPES.MANUAL_UPLOAD).toBe("provider-source-manual-upload");
    expect(Object.isFrozen(SOURCE_MANIFEST_TYPES)).toBe(true);
  });

  test("RELATIVE_PATH_PATTERN matches safe relative paths", () => {
    expect(RELATIVE_PATH_PATTERN.test("en-US/abc/file.txt")).toBe(true);
    expect(RELATIVE_PATH_PATTERN.test("../escape")).toBe(false);
    expect(RELATIVE_PATH_PATTERN.test("/absolute")).toBe(false);
  });
});

describe("normalizeVariant", () => {
  test("passes through valid variant", () => {
    const result = normalizeVariant("en-US", {
      errorFactory,
      supportedVariants: new Set(SUPPORTED_VARIANT_IDS)
    });
    expect(result).toBe("en-US");
  });

  test("trims whitespace", () => {
    const result = normalizeVariant("  en-US  ", {
      errorFactory,
      supportedVariants: new Set(SUPPORTED_VARIANT_IDS)
    });
    expect(result).toBe("en-US");
  });

  test("throws for unsupported variant", () => {
    expect(() =>
      normalizeVariant("fr-FR", {
        errorFactory,
        supportedVariants: new Set(SUPPORTED_VARIANT_IDS)
      })
    ).toThrow(/variant must be one of/);
  });

  test("throws when supportedVariants is missing or empty", () => {
    expect(() =>
      normalizeVariant("en-US", { errorFactory })
    ).toThrow("normalizeVariant requires a non-empty supportedVariants Set.");

    expect(() =>
      normalizeVariant("en-US", { errorFactory, supportedVariants: new Set() })
    ).toThrow("normalizeVariant requires a non-empty supportedVariants Set.");
  });

  test("throws when errorFactory is missing", () => {
    expect(() =>
      normalizeVariant("en-US", { supportedVariants: new Set(SUPPORTED_VARIANT_IDS) })
    ).toThrow("normalizeVariant requires an errorFactory function.");
  });
});

describe("normalizeCommit", () => {
  test("passes through valid 40-char hex SHA", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(normalizeCommit(sha, { errorFactory })).toBe(sha);
  });

  test("trims whitespace", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(normalizeCommit(`  ${sha}  `, { errorFactory })).toBe(sha);
  });

  test("throws for non-40-char hex", () => {
    expect(() =>
      normalizeCommit("short", { errorFactory })
    ).toThrow(/commit must be a 40-character/);
  });

  test("throws when errorFactory is missing", () => {
    expect(() =>
      normalizeCommit("0123456789abcdef0123456789abcdef01234567", {})
    ).toThrow("normalizeCommit requires an errorFactory function.");
  });
});

describe("normalizePolicyVersion", () => {
  test("defaults to v1 when no value given", () => {
    expect(normalizePolicyVersion(undefined, { errorFactory })).toBe("v1");
    expect(normalizePolicyVersion("", { errorFactory })).toBe("v1");
  });

  test("passes through valid policy version", () => {
    expect(normalizePolicyVersion("v2", { errorFactory })).toBe("v2");
    expect(normalizePolicyVersion("strict-2024", { errorFactory })).toBe("strict-2024");
  });

  test("throws for invalid policy version", () => {
    expect(() =>
      normalizePolicyVersion("this is way too long for a valid policy version string!", { errorFactory })
    ).toThrow(/policyVersion/);
  });

  test("throws when errorFactory is missing", () => {
    expect(() =>
      normalizePolicyVersion("v1", {})
    ).toThrow("normalizePolicyVersion requires an errorFactory function.");
  });
});

describe("normalizeRelativePath", () => {
  test("passes through valid relative path", () => {
    expect(normalizeRelativePath("en-US/abc/file.txt", { errorFactory })).toBe("en-US/abc/file.txt");
  });

  test("trims whitespace", () => {
    expect(normalizeRelativePath("  file.txt  ", { errorFactory })).toBe("file.txt");
  });

  test("throws for empty path", () => {
    expect(() =>
      normalizeRelativePath("", { errorFactory })
    ).toThrow(/must be a non-empty path/);
  });

  test("throws for absolute path", () => {
    expect(() =>
      normalizeRelativePath("/etc/passwd", { errorFactory })
    ).toThrow(/must be a safe relative path/);
  });

  test("throws for path traversal", () => {
    expect(() =>
      normalizeRelativePath("../escape", { errorFactory })
    ).toThrow(/must be a safe relative path/);
  });

  test("uses custom fieldName and errorCode", () => {
    expect(() =>
      normalizeRelativePath("/abs", {
        errorFactory,
        fieldName: "customPath",
        errorCode: "CUSTOM_ERR"
      })
    ).toThrow(/customPath must be a safe relative path/);
  });

  test("throws when errorFactory is missing", () => {
    expect(() =>
      normalizeRelativePath("file.txt", {})
    ).toThrow("normalizeRelativePath requires an errorFactory function.");
  });
});

describe("resolveWithinRoot", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("resolves valid relative path within root", () => {
    const result = resolveWithinRoot(tmpDir, "sub/file.txt", { errorFactory });
    expect(result.normalized).toBe("sub/file.txt");
    expect(result.resolved).toBe(path.join(tmpDir, "sub/file.txt"));
  });

  test("throws for path that escapes root", () => {
    expect(() =>
      resolveWithinRoot(tmpDir, "../escape", { errorFactory })
    ).toThrow(/safe relative path/);
  });

  test("throws for absolute path", () => {
    expect(() =>
      resolveWithinRoot(tmpDir, "/etc/passwd", { errorFactory })
    ).toThrow(/must be a safe relative path/);
  });

  test("uses custom fieldName and errorCode", () => {
    expect(() =>
      resolveWithinRoot(tmpDir, "../escape", {
        errorFactory,
        fieldName: "myPath",
        errorCode: "BAD_PATH"
      })
    ).toThrow(/myPath must be a safe relative path/);
  });
});

describe("writeFileAtomic", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes file content atomically", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await writeFileAtomic(filePath, "hello world", { errorFactory });
    expect(fs.readFileSync(filePath, "utf8")).toBe("hello world");
  });

  test("throws with error code on failure", async () => {
    const filePath = path.join(tmpDir, "nonexistent", "test.txt");
    await expect(
      writeFileAtomic(filePath, "data", { errorFactory })
    ).rejects.toMatchObject({
      code: "PERSISTENCE_WRITE_FAILED"
    });
  });

  test("uses custom error code", async () => {
    const filePath = path.join(tmpDir, "nonexistent", "test.txt");
    await expect(
      writeFileAtomic(filePath, "data", { errorFactory, errorCode: "CUSTOM_WRITE_ERR" })
    ).rejects.toMatchObject({
      code: "CUSTOM_WRITE_ERR"
    });
  });
});

describe("writeJsonAtomic", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes JSON content with trailing newline", async () => {
    const filePath = path.join(tmpDir, "data.json");
    await writeJsonAtomic(filePath, { key: "value" }, { errorFactory });
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toBe('{\n  "key": "value"\n}\n');
  });

  test("throws on failure", async () => {
    const filePath = path.join(tmpDir, "nonexistent", "data.json");
    await expect(
      writeJsonAtomic(filePath, { key: "value" }, { errorFactory })
    ).rejects.toMatchObject({
      code: "PERSISTENCE_WRITE_FAILED"
    });
  });
});

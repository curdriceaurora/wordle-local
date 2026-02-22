const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");

const fsp = fs.promises;

const MIN_WORD_LENGTH = 3;
const MAX_WORD_LENGTH = 12;
const WORD_PATTERN = /^[A-Z]+$/;
const SUPPORTED_VARIANT_IDS = Object.freeze(["en-GB", "en-US", "en-CA", "en-AU", "en-ZA"]);
const SOURCE_MANIFEST_TYPES = Object.freeze({
  REMOTE_FETCH: "provider-source-fetch",
  MANUAL_UPLOAD: "provider-source-manual-upload"
});
const RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;

function normalizeVariant(variant, options) {
  const value = String(variant || "").trim();
  const errorFactory = options?.errorFactory;
  const supportedVariants = options?.supportedVariants;
  if (!(supportedVariants instanceof Set) || supportedVariants.size === 0) {
    throw new Error("normalizeVariant requires a non-empty supportedVariants Set.");
  }
  if (typeof errorFactory !== "function") {
    throw new Error("normalizeVariant requires an errorFactory function.");
  }
  if (!supportedVariants.has(value)) {
    throw errorFactory(
      "INVALID_VARIANT",
      `variant must be one of ${Array.from(supportedVariants).join(", ")}.`
    );
  }
  return value;
}

function normalizeCommit(commit, options) {
  const errorFactory = options?.errorFactory;
  if (typeof errorFactory !== "function") {
    throw new Error("normalizeCommit requires an errorFactory function.");
  }
  const value = String(commit || "").trim();
  if (!COMMIT_SHA_PATTERN.test(value)) {
    throw errorFactory("INVALID_COMMIT", "commit must be a 40-character hexadecimal git SHA.");
  }
  return value;
}

function normalizePolicyVersion(policyVersion, options) {
  const errorFactory = options?.errorFactory;
  if (typeof errorFactory !== "function") {
    throw new Error("normalizePolicyVersion requires an errorFactory function.");
  }
  const value = String(policyVersion || "v1").trim();
  if (!POLICY_VERSION_PATTERN.test(value)) {
    throw errorFactory(
      "INVALID_POLICY_VERSION",
      "policyVersion must be 1-32 chars using letters, numbers, dot, underscore, or hyphen."
    );
  }
  return value;
}

function normalizeRelativePath(relativePath, options) {
  const fieldName = options?.fieldName || "path";
  const errorFactory = options?.errorFactory;
  const errorCode = options?.errorCode || "INVALID_PATH";
  if (typeof errorFactory !== "function") {
    throw new Error("normalizeRelativePath requires an errorFactory function.");
  }

  const value = String(relativePath || "").trim();
  if (!value) {
    throw errorFactory(errorCode, `${fieldName} must be a non-empty path.`);
  }
  if (path.isAbsolute(value) || !RELATIVE_PATH_PATTERN.test(value)) {
    throw errorFactory(
      errorCode,
      `${fieldName} must be a safe relative path without traversal segments.`
    );
  }
  return value;
}

function resolveWithinRoot(root, relativePath, options) {
  const fieldName = options?.fieldName || "path";
  const errorFactory = options?.errorFactory;
  const errorCode = options?.errorCode || "INVALID_PATH";
  const rel = normalizeRelativePath(relativePath, {
    fieldName,
    errorFactory,
    errorCode
  });
  const resolved = path.resolve(root, rel);
  const relativeResolved = path.relative(root, resolved);
  if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) {
    throw errorFactory(errorCode, `${fieldName} points outside provider root.`);
  }
  return {
    resolved,
    normalized: rel
  };
}

async function writeFileAtomic(filePath, content, options) {
  const errorFactory = options?.errorFactory;
  const errorCode = options?.errorCode || "PERSISTENCE_WRITE_FAILED";
  if (typeof errorFactory !== "function") {
    throw new Error("writeFileAtomic requires an errorFactory function.");
  }

  const tempPath = `${filePath}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tempPath, content, "utf8");
    try {
      await fsp.rename(tempPath, filePath);
    } catch (renameErr) {
      if (renameErr && ["EEXIST", "EPERM", "EACCES"].includes(renameErr.code)) {
        await fsp.rm(filePath, { force: true });
        await fsp.rename(tempPath, filePath);
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw errorFactory(errorCode, `Failed to persist file at ${filePath}.`, { cause: err });
  }
}

async function writeJsonAtomic(filePath, payload, options) {
  await writeFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`, options);
}

module.exports = {
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
};

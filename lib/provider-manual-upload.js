const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");

const {
  buildProviderDescriptor,
  computeSha256,
  normalizeCommit,
  ProviderFetchError
} = require("./provider-fetch");
const { SOURCE_MANIFEST_TYPES } = require("./provider-artifact-shared");

const fsp = fs.promises;

const MANUAL_SOURCE_MANIFEST_TYPE = SOURCE_MANIFEST_TYPES.MANUAL_UPLOAD;
const DEFAULT_PROVIDER_OUTPUT_ROOT = path.join(__dirname, "..", "data", "providers");
const DEFAULT_MAX_MANUAL_FILE_BYTES = 8 * 1024 * 1024;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_MANIFEST_FILE_NAME = "source-manifest.json";

class ProviderManualUploadError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ProviderManualUploadError";
    this.code = code;
    this.retriable = options.retriable === true;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function normalizeExpectedChecksums(expectedChecksums) {
  if (!expectedChecksums || typeof expectedChecksums !== "object" || Array.isArray(expectedChecksums)) {
    throw new ProviderManualUploadError(
      "CHECKSUM_REQUIRED",
      "expectedChecksums.dic and expectedChecksums.aff are required for integrity verification."
    );
  }

  const normalized = {
    dic: String(expectedChecksums.dic || "").trim().toLowerCase(),
    aff: String(expectedChecksums.aff || "").trim().toLowerCase()
  };

  if (!CHECKSUM_PATTERN.test(normalized.dic)) {
    throw new ProviderManualUploadError(
      "INVALID_CHECKSUM",
      "expectedChecksums.dic must be a lowercase 64-character SHA-256 checksum."
    );
  }
  if (!CHECKSUM_PATTERN.test(normalized.aff)) {
    throw new ProviderManualUploadError(
      "INVALID_CHECKSUM",
      "expectedChecksums.aff must be a lowercase 64-character SHA-256 checksum."
    );
  }

  return normalized;
}

function parseMaxManualFileBytes(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_MANUAL_FILE_BYTES;
  }
  return parsed;
}

function sanitizeFileName(value, fallback) {
  const normalized = path.basename(String(value || "").trim());
  if (!normalized) {
    return fallback;
  }
  return normalized;
}

function decodeBase64File(value, fieldName) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new ProviderManualUploadError(
      "MANUAL_FILES_REQUIRED",
      `${fieldName} is required for manual uploads.`
    );
  }

  const normalized = raw.replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new ProviderManualUploadError(
      "INVALID_MANUAL_SOURCE",
      `${fieldName} must be valid base64 data.`
    );
  }

  let buffer;
  try {
    buffer = Buffer.from(normalized, "base64");
  } catch (err) {
    throw new ProviderManualUploadError(
      "INVALID_MANUAL_SOURCE",
      `${fieldName} must be valid base64 data.`,
      { cause: err }
    );
  }

  if (!buffer.length) {
    throw new ProviderManualUploadError(
      "INVALID_MANUAL_SOURCE",
      `${fieldName} resolved to an empty file.`
    );
  }

  return buffer;
}

function deriveSyntheticCommit(records) {
  return nodeCrypto
    .createHash("sha1")
    .update(records.dic.sha256)
    .update(":")
    .update(records.aff.sha256)
    .digest("hex");
}

function verifyChecksums(records, expectedChecksums) {
  const mismatches = [];
  ["dic", "aff"].forEach((kind) => {
    if (records[kind].sha256 !== expectedChecksums[kind]) {
      mismatches.push(
        `${kind} expected=${expectedChecksums[kind]} actual=${records[kind].sha256}`
      );
    }
  });

  if (mismatches.length > 0) {
    throw new ProviderManualUploadError(
      "CHECKSUM_MISMATCH",
      `Checksum verification failed: ${mismatches.join("; ")}`
    );
  }
}

async function writeManifestAtomic(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    try {
      await fsp.rename(tempPath, filePath);
    } catch (err) {
      if (!["EEXIST", "EPERM", "EACCES"].includes(String(err?.code || ""))) {
        throw err;
      }
      await fsp.rm(filePath, { force: true });
      await fsp.rename(tempPath, filePath);
    }
  } catch (err) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw new ProviderManualUploadError(
      "PERSISTENCE_WRITE_FAILED",
      `Failed to persist source manifest to ${filePath}.`,
      { cause: err }
    );
  }
}

async function persistManualProviderSource(options = {}) {
  const expectedChecksums = normalizeExpectedChecksums(options.expectedChecksums);
  const maxManualFileBytes = parseMaxManualFileBytes(options.maxManualFileBytes);

  const manualFiles =
    options.manualFiles && typeof options.manualFiles === "object" && !Array.isArray(options.manualFiles)
      ? options.manualFiles
      : null;
  if (!manualFiles) {
    throw new ProviderManualUploadError(
      "MANUAL_FILES_REQUIRED",
      "manualFiles.dicBase64 and manualFiles.affBase64 are required for manual uploads."
    );
  }

  const dicBuffer = decodeBase64File(manualFiles.dicBase64, "manualFiles.dicBase64");
  const affBuffer = decodeBase64File(manualFiles.affBase64, "manualFiles.affBase64");

  if (dicBuffer.length > maxManualFileBytes) {
    throw new ProviderManualUploadError(
      "MANUAL_FILE_TOO_LARGE",
      `manualFiles.dicBase64 exceeds the ${maxManualFileBytes} byte limit.`
    );
  }
  if (affBuffer.length > maxManualFileBytes) {
    throw new ProviderManualUploadError(
      "MANUAL_FILE_TOO_LARGE",
      `manualFiles.affBase64 exceeds the ${maxManualFileBytes} byte limit.`
    );
  }

  const records = {
    dic: {
      sha256: computeSha256(dicBuffer),
      byteSize: dicBuffer.length
    },
    aff: {
      sha256: computeSha256(affBuffer),
      byteSize: affBuffer.length
    }
  };
  verifyChecksums(records, expectedChecksums);

  let commit = String(options.commit || "").trim();
  if (commit) {
    try {
      commit = normalizeCommit(commit);
    } catch (err) {
      if (err instanceof ProviderFetchError) {
        throw new ProviderManualUploadError(err.code, err.message, { cause: err });
      }
      throw err;
    }
  } else {
    commit = deriveSyntheticCommit(records);
  }

  let descriptor;
  try {
    descriptor = buildProviderDescriptor({ variant: options.variant, commit });
  } catch (err) {
    if (err instanceof ProviderFetchError) {
      throw new ProviderManualUploadError(err.code, err.message, { cause: err });
    }
    throw err;
  }

  const outputRoot = options.outputRoot
    ? path.resolve(options.outputRoot)
    : DEFAULT_PROVIDER_OUTPUT_ROOT;
  const variantRoot = path.join(outputRoot, descriptor.variant, descriptor.commit);

  const dicFileName = path.basename(descriptor.dicPath);
  const affFileName = path.basename(descriptor.affPath);
  const dicUploadFileName = sanitizeFileName(manualFiles.dicFileName, dicFileName);
  const affUploadFileName = sanitizeFileName(manualFiles.affFileName, affFileName);

  await fsp.mkdir(variantRoot, { recursive: true });

  const dicFilePath = path.join(variantRoot, dicFileName);
  const affFilePath = path.join(variantRoot, affFileName);

  try {
    await Promise.all([
      fsp.writeFile(dicFilePath, dicBuffer),
      fsp.writeFile(affFilePath, affBuffer)
    ]);
  } catch (err) {
    throw new ProviderManualUploadError(
      "PERSISTENCE_WRITE_FAILED",
      "Failed to persist uploaded provider source files.",
      { cause: err }
    );
  }

  const retrievedAt = new Date().toISOString();
  const sourceFiles = {
    dic: {
      uploadFileName: dicUploadFileName,
      localPath: path.posix.join(descriptor.variant, descriptor.commit, dicFileName)
    },
    aff: {
      uploadFileName: affUploadFileName,
      localPath: path.posix.join(descriptor.variant, descriptor.commit, affFileName)
    }
  };

  const manifestPayload = {
    schemaVersion: 1,
    manifestType: MANUAL_SOURCE_MANIFEST_TYPE,
    provider: {
      providerId: descriptor.providerId,
      variant: descriptor.variant,
      repository: descriptor.repository,
      commit: descriptor.commit,
      dicPath: descriptor.dicPath,
      affPath: descriptor.affPath
    },
    sourceFiles: {
      dic: {
        sourcePath: descriptor.dicPath,
        localPath: sourceFiles.dic.localPath,
        uploadFileName: sourceFiles.dic.uploadFileName,
        sha256: records.dic.sha256,
        byteSize: records.dic.byteSize
      },
      aff: {
        sourcePath: descriptor.affPath,
        localPath: sourceFiles.aff.localPath,
        uploadFileName: sourceFiles.aff.uploadFileName,
        sha256: records.aff.sha256,
        byteSize: records.aff.byteSize
      }
    },
    manualUpload: {
      sourceType: "manual-upload",
      commitProvided: Boolean(String(options.commit || "").trim())
    },
    retrievedAt
  };

  const manifestPath = path.join(variantRoot, SOURCE_MANIFEST_FILE_NAME);
  await writeManifestAtomic(manifestPath, manifestPayload);

  return {
    descriptor,
    retrievedAt,
    sourceFiles: {
      dic: {
        path: dicFilePath,
        sha256: records.dic.sha256,
        byteSize: records.dic.byteSize,
        uploadFileName: dicUploadFileName
      },
      aff: {
        path: affFilePath,
        sha256: records.aff.sha256,
        byteSize: records.aff.byteSize,
        uploadFileName: affUploadFileName
      }
    },
    manifestPath
  };
}

module.exports = {
  MANUAL_SOURCE_MANIFEST_TYPE,
  ProviderManualUploadError,
  persistManualProviderSource
};

const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { SOURCE_MANIFEST_TYPES } = require("./provider-artifact-shared");

const fsp = fs.promises;

const PROVIDER_ID = "libreoffice-dictionaries";
const PROVIDER_REPOSITORY = "https://github.com/LibreOffice/dictionaries";
const PROVIDER_RAW_BASE = "https://raw.githubusercontent.com/LibreOffice/dictionaries";
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_PROVIDER_OUTPUT_ROOT = path.join(__dirname, "..", "data", "providers");
const SOURCE_MANIFEST_FILE_NAME = "source-manifest.json";
const SOURCE_MANIFEST_TYPE = SOURCE_MANIFEST_TYPES.REMOTE_FETCH;
const ALLOWED_VARIANTS = Object.freeze({
  "en-GB": Object.freeze({ dicPath: "en/en_GB.dic", affPath: "en/en_GB.aff" }),
  "en-US": Object.freeze({ dicPath: "en/en_US.dic", affPath: "en/en_US.aff" }),
  "en-CA": Object.freeze({ dicPath: "en/en_CA.dic", affPath: "en/en_CA.aff" }),
  "en-AU": Object.freeze({ dicPath: "en/en_AU.dic", affPath: "en/en_AU.aff" }),
  "en-ZA": Object.freeze({ dicPath: "en/en_ZA.dic", affPath: "en/en_ZA.aff" })
});

class ProviderFetchError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ProviderFetchError";
    this.code = code;
    this.status = options.status || null;
    this.retriable = options.retriable === true;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function normalizeChecksum(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const checksum = String(value).trim().toLowerCase();
  if (!CHECKSUM_PATTERN.test(checksum)) {
    throw new ProviderFetchError(
      "INVALID_CHECKSUM",
      `${fieldName} must be a lowercase 64-character SHA-256 checksum.`
    );
  }
  return checksum;
}

function normalizeCommit(commit) {
  const normalized = String(commit || "").trim().toLowerCase();
  if (!COMMIT_SHA_PATTERN.test(normalized)) {
    throw new ProviderFetchError(
      "INVALID_COMMIT",
      "Commit pin must be a 40-character lowercase git SHA."
    );
  }
  return normalized;
}

function normalizeVariant(variant) {
  const normalized = String(variant || "").trim();
  if (!ALLOWED_VARIANTS[normalized]) {
    throw new ProviderFetchError(
      "UNSUPPORTED_VARIANT",
      `Variant must be one of: ${Object.keys(ALLOWED_VARIANTS).join(", ")}.`
    );
  }
  return normalized;
}

function buildProviderDescriptor({ variant, commit }) {
  const normalizedVariant = normalizeVariant(variant);
  const normalizedCommit = normalizeCommit(commit);
  const source = ALLOWED_VARIANTS[normalizedVariant];

  return {
    providerId: PROVIDER_ID,
    repository: PROVIDER_REPOSITORY,
    variant: normalizedVariant,
    commit: normalizedCommit,
    dicPath: source.dicPath,
    affPath: source.affPath
  };
}

function buildRawFileUrl(commit, filePath) {
  return `${PROVIDER_RAW_BASE}/${commit}/${filePath}`;
}

function computeSha256(buffer) {
  return nodeCrypto.createHash("sha256").update(buffer).digest("hex");
}

async function fetchBinary(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_FETCH_TIMEOUT_MS;

  if (typeof fetchImpl !== "function") {
    throw new ProviderFetchError(
      "FETCH_UNAVAILABLE",
      "No fetch implementation is available to download provider files."
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal
    });

    if (response.status === 404) {
      throw new ProviderFetchError(
        "SOURCE_NOT_FOUND",
        `Provider source file was not found: ${url}`,
        { status: 404, retriable: false }
      );
    }
    if (response.status === 429) {
      throw new ProviderFetchError(
        "UPSTREAM_RATE_LIMITED",
        "Provider source is currently rate-limited. Try again later.",
        { status: 429, retriable: true }
      );
    }
    if (response.status >= 500) {
      throw new ProviderFetchError(
        "UPSTREAM_SERVER_ERROR",
        `Provider source returned server error ${response.status}.`,
        { status: response.status, retriable: true }
      );
    }
    if (!response.ok) {
      throw new ProviderFetchError(
        "UPSTREAM_REQUEST_FAILED",
        `Provider source request failed with status ${response.status}.`,
        { status: response.status, retriable: false }
      );
    }

    const body = await response.arrayBuffer();
    return Buffer.from(body);
  } catch (err) {
    if (err instanceof ProviderFetchError) {
      throw err;
    }
    if (err && err.name === "AbortError") {
      throw new ProviderFetchError(
        "FETCH_TIMEOUT",
        `Provider source request timed out after ${timeoutMs}ms.`,
        { retriable: true, cause: err }
      );
    }
    throw new ProviderFetchError(
      "FETCH_NETWORK_ERROR",
      "Provider source request failed due to a network error.",
      { retriable: true, cause: err }
    );
  } finally {
    clearTimeout(timer);
  }
}

function normalizeExpectedChecksums(expectedChecksums) {
  if (!expectedChecksums || typeof expectedChecksums !== "object" || Array.isArray(expectedChecksums)) {
    throw new ProviderFetchError(
      "CHECKSUM_REQUIRED",
      "expectedChecksums.dic and expectedChecksums.aff are required for integrity verification."
    );
  }
  const source = expectedChecksums && typeof expectedChecksums === "object"
    ? expectedChecksums
    : {};

  const checksums = {
    dic: normalizeChecksum(source.dic, "expectedChecksums.dic"),
    aff: normalizeChecksum(source.aff, "expectedChecksums.aff")
  };

  const missing = ["dic", "aff"].filter((kind) => !checksums[kind]);
  if (missing.length) {
    throw new ProviderFetchError(
      "CHECKSUM_REQUIRED",
      `Missing required checksum values: ${missing.map((kind) => `expectedChecksums.${kind}`).join(", ")}.`
    );
  }

  return checksums;
}

function verifyChecksums(fileRecords, expectedChecksums) {
  const mismatches = [];
  ["dic", "aff"].forEach((kind) => {
    const expected = expectedChecksums[kind];
    const actual = fileRecords[kind].sha256;
    if (expected !== actual) {
      mismatches.push(`${kind} expected=${expected} actual=${actual}`);
    }
  });

  if (mismatches.length) {
    throw new ProviderFetchError(
      "CHECKSUM_MISMATCH",
      `Checksum verification failed: ${mismatches.join("; ")}`
    );
  }
}

function toPosixPath(value) {
  return String(value).split(path.sep).join(path.posix.sep);
}

function createManifestPayload(descriptor, retrievedAt, records, sourceFiles) {
  return {
    schemaVersion: 1,
    manifestType: SOURCE_MANIFEST_TYPE,
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
        url: sourceFiles.dic.url,
        sha256: records.dic.sha256,
        byteSize: records.dic.byteSize
      },
      aff: {
        sourcePath: descriptor.affPath,
        localPath: sourceFiles.aff.localPath,
        url: sourceFiles.aff.url,
        sha256: records.aff.sha256,
        byteSize: records.aff.byteSize
      }
    },
    retrievedAt
  };
}

async function writeJsonAtomic(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    try {
      await fsp.rename(tempPath, filePath);
    } catch (err) {
      // Windows can reject rename-over-existing-file; fall back to replace path.
      if (!["EEXIST", "EPERM", "EACCES"].includes(String(err?.code || ""))) {
        throw err;
      }

      let existingIsFile = false;
      try {
        const stat = await fsp.stat(filePath);
        existingIsFile = stat.isFile();
      } catch (statErr) {
        if (String(statErr?.code || "") !== "ENOENT") {
          throw err;
        }
      }

      if (!existingIsFile) {
        throw err;
      }

      await fsp.unlink(filePath);
      await fsp.rename(tempPath, filePath);
    }
  } catch (err) {
    await fsp.unlink(tempPath).catch(() => {});
    throw new ProviderFetchError(
      "PERSISTENCE_WRITE_FAILED",
      `Failed to persist source manifest to ${filePath}.`,
      { cause: err, retriable: false }
    );
  }
}

async function fetchAndPersistProviderSource(options) {
  const descriptor = buildProviderDescriptor({
    variant: options.variant,
    commit: options.commit
  });
  const expectedChecksums = normalizeExpectedChecksums(options.expectedChecksums);

  const dicUrl = buildRawFileUrl(descriptor.commit, descriptor.dicPath);
  const affUrl = buildRawFileUrl(descriptor.commit, descriptor.affPath);

  const [dicBuffer, affBuffer] = await Promise.all([
    fetchBinary(dicUrl, options),
    fetchBinary(affUrl, options)
  ]);

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

  const outputRoot = options.outputRoot
    ? path.resolve(options.outputRoot)
    : DEFAULT_PROVIDER_OUTPUT_ROOT;
  const variantRoot = path.join(outputRoot, descriptor.variant, descriptor.commit);
  await fsp.mkdir(variantRoot, { recursive: true });

  const dicFilePath = path.join(variantRoot, path.basename(descriptor.dicPath));
  const affFilePath = path.join(variantRoot, path.basename(descriptor.affPath));
  await fsp.writeFile(dicFilePath, dicBuffer);
  await fsp.writeFile(affFilePath, affBuffer);

  const sourceFiles = {
    dic: {
      url: dicUrl,
      localPath: toPosixPath(path.relative(outputRoot, dicFilePath))
    },
    aff: {
      url: affUrl,
      localPath: toPosixPath(path.relative(outputRoot, affFilePath))
    }
  };

  const retrievedAt = new Date().toISOString();
  const manifestPayload = createManifestPayload(descriptor, retrievedAt, records, sourceFiles);
  const manifestPath = path.join(variantRoot, SOURCE_MANIFEST_FILE_NAME);
  await writeJsonAtomic(manifestPath, manifestPayload);

  return {
    descriptor,
    retrievedAt,
    sourceFiles: {
      dic: {
        url: dicUrl,
        path: dicFilePath,
        sha256: records.dic.sha256,
        byteSize: records.dic.byteSize
      },
      aff: {
        url: affUrl,
        path: affFilePath,
        sha256: records.aff.sha256,
        byteSize: records.aff.byteSize
      }
    },
    manifestPath
  };
}

module.exports = {
  ALLOWED_VARIANTS,
  PROVIDER_ID,
  PROVIDER_REPOSITORY,
  ProviderFetchError,
  buildProviderDescriptor,
  computeSha256,
  fetchAndPersistProviderSource,
  normalizeCommit
};

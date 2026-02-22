const { ALLOWED_VARIANTS, PROVIDER_ID, PROVIDER_REPOSITORY } = require("./provider-fetch");

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const PROVIDER_API_BASE = "https://api.github.com/repos/LibreOffice/dictionaries";

class ProviderUpdateCheckError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ProviderUpdateCheckError";
    this.code = code;
    this.status = options.status || null;
    this.retriable = options.retriable === true;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function normalizeVariant(value) {
  const variant = String(value || "").trim();
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_VARIANTS, variant)) {
    throw new ProviderUpdateCheckError(
      "UNSUPPORTED_VARIANT",
      `variant must be one of ${Object.keys(ALLOWED_VARIANTS).join(", ")}.`
    );
  }
  return variant;
}

function normalizeCurrentCommit(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const commit = String(value).trim().toLowerCase();
  if (!COMMIT_SHA_PATTERN.test(commit)) {
    throw new ProviderUpdateCheckError(
      "INVALID_COMMIT",
      "currentCommit must be a 40-character lowercase hexadecimal git SHA."
    );
  }
  return commit;
}

function buildPathCommitApiUrl(relativePath) {
  const encodedPath = encodeURIComponent(relativePath);
  return `${PROVIDER_API_BASE}/commits?path=${encodedPath}&per_page=1`;
}

async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_FETCH_TIMEOUT_MS;

  if (typeof fetchImpl !== "function") {
    throw new ProviderUpdateCheckError(
      "FETCH_UNAVAILABLE",
      "No fetch implementation is available for upstream update checks."
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Accept: "application/vnd.github+json"
  };
  if (typeof options.githubToken === "string" && options.githubToken.trim()) {
    headers.Authorization = `Bearer ${options.githubToken.trim()}`;
  }

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller.signal
    });
    if (response.status === 403 || response.status === 429) {
      throw new ProviderUpdateCheckError(
        "UPSTREAM_RATE_LIMITED",
        "Upstream update check is currently rate-limited. Try again later.",
        { status: response.status, retriable: true }
      );
    }
    if (response.status >= 500) {
      throw new ProviderUpdateCheckError(
        "UPSTREAM_SERVER_ERROR",
        `Upstream update check failed with status ${response.status}.`,
        { status: response.status, retriable: true }
      );
    }
    if (!response.ok) {
      throw new ProviderUpdateCheckError(
        "UPSTREAM_REQUEST_FAILED",
        `Upstream update check failed with status ${response.status}.`,
        { status: response.status, retriable: false }
      );
    }
    return await response.json();
  } catch (err) {
    if (err instanceof ProviderUpdateCheckError) {
      throw err;
    }
    if (err && err.name === "AbortError") {
      throw new ProviderUpdateCheckError(
        "FETCH_TIMEOUT",
        `Upstream update check timed out after ${timeoutMs}ms.`,
        { retriable: true, cause: err }
      );
    }
    throw new ProviderUpdateCheckError(
      "FETCH_NETWORK_ERROR",
      "Upstream update check failed due to a network error.",
      { retriable: true, cause: err }
    );
  } finally {
    clearTimeout(timer);
  }
}

function parsePathCommitEntry(relativePath, payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new ProviderUpdateCheckError(
      "UPSTREAM_RESPONSE_INVALID",
      `Upstream update check returned no commits for ${relativePath}.`
    );
  }
  const entry = payload[0] || {};
  const commit = String(entry.sha || "").trim().toLowerCase();
  if (!COMMIT_SHA_PATTERN.test(commit)) {
    throw new ProviderUpdateCheckError(
      "UPSTREAM_RESPONSE_INVALID",
      `Upstream update check returned an invalid commit SHA for ${relativePath}.`
    );
  }

  const dateString = String(
    entry?.commit?.committer?.date || entry?.commit?.author?.date || ""
  ).trim();
  const commitTimestamp = Number.isFinite(Date.parse(dateString))
    ? Date.parse(dateString)
    : 0;

  return {
    path: relativePath,
    commit,
    commitTimestamp,
    date: dateString || null
  };
}

function selectLatestCommit(dicEntry, affEntry) {
  const candidates = [dicEntry, affEntry];
  candidates.sort((left, right) => {
    if (left.commitTimestamp !== right.commitTimestamp) {
      return right.commitTimestamp - left.commitTimestamp;
    }
    if (left.commit === right.commit) {
      return 0;
    }
    return left.commit < right.commit ? 1 : -1;
  });
  return candidates[0].commit;
}

async function checkProviderUpdate(options = {}) {
  const variant = normalizeVariant(options.variant);
  const currentCommit = normalizeCurrentCommit(options.currentCommit);
  const variantPaths = ALLOWED_VARIANTS[variant];
  const checkedAt = new Date().toISOString();

  const [dicPayload, affPayload] = await Promise.all([
    fetchJson(buildPathCommitApiUrl(variantPaths.dicPath), options),
    fetchJson(buildPathCommitApiUrl(variantPaths.affPath), options)
  ]);
  const dicEntry = parsePathCommitEntry(variantPaths.dicPath, dicPayload);
  const affEntry = parsePathCommitEntry(variantPaths.affPath, affPayload);
  const latestCommit = selectLatestCommit(dicEntry, affEntry);

  let status = "unknown";
  let message = "No installed commit is currently selected for comparison.";
  if (currentCommit) {
    if (currentCommit === latestCommit) {
      status = "up-to-date";
      message = "Installed commit matches latest upstream commit.";
    } else {
      status = "update-available";
      message = "A newer upstream commit is available for this variant.";
    }
  }

  return {
    providerId: PROVIDER_ID,
    repository: PROVIDER_REPOSITORY,
    variant,
    checkedAt,
    status,
    message,
    currentCommit,
    latestCommit,
    latestByPath: {
      dic: dicEntry,
      aff: affEntry
    }
  };
}

module.exports = {
  ALLOWED_VARIANTS,
  ProviderUpdateCheckError,
  checkProviderUpdate
};

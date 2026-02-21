const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  FILTER_MODES,
  ProviderAnswerFilterError,
  buildFilteredAnswerPoolArtifacts
} = require("../lib/provider-answer-filter");

const PROVIDER_REPOSITORY = "https://github.com/LibreOffice/dictionaries";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lhw-provider-answer-filter-"));
}

function writeProviderAnswerArtifacts(options = {}) {
  const providerRoot = options.providerRoot || createTempDir();
  const variant = options.variant || "en-US";
  const commit = options.commit || COMMIT;
  const variantRoot = path.join(providerRoot, variant, commit);
  fs.mkdirSync(variantRoot, { recursive: true });

  const sourceManifest = {
    schemaVersion: 1,
    manifestType: "provider-source-fetch",
    provider: {
      providerId: "libreoffice-dictionaries",
      variant,
      repository: PROVIDER_REPOSITORY,
      commit,
      dicPath: "en/en_US.dic",
      affPath: "en/en_US.aff"
    },
    sourceFiles: {
      dic: {
        sourcePath: "en/en_US.dic",
        localPath: path.posix.join(variant, commit, "en_US.dic"),
        url: `${PROVIDER_REPOSITORY}/raw/${commit}/en/en_US.dic`,
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        byteSize: 100
      },
      aff: {
        sourcePath: "en/en_US.aff",
        localPath: path.posix.join(variant, commit, "en_US.aff"),
        url: `${PROVIDER_REPOSITORY}/raw/${commit}/en/en_US.aff`,
        sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        byteSize: 100
      }
    },
    retrievedAt: options.retrievedAt || "2026-02-21T00:00:00.000Z"
  };
  fs.writeFileSync(
    path.join(variantRoot, "source-manifest.json"),
    `${JSON.stringify(sourceManifest, null, 2)}\n`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(variantRoot, "answer-pool.txt"),
    options.answerPoolContent || "CAT\nDOG\nDOGS\nGOOSE\nWENT\nPLAY\nWALK\n",
    "utf8"
  );

  if (options.denylistContent !== undefined) {
    fs.writeFileSync(
      path.join(variantRoot, "family-denylist.txt"),
      options.denylistContent,
      "utf8"
    );
  }

  if (options.allowlistContent !== undefined) {
    fs.writeFileSync(
      path.join(variantRoot, "family-allowlist.txt"),
      options.allowlistContent,
      "utf8"
    );
  }

  return {
    providerRoot,
    variant,
    commit
  };
}

describe("provider-answer-filter", () => {
  test("applies denylist-only filter and persists metadata counts", async () => {
    const setup = writeProviderAnswerArtifacts({
      denylistContent: "WENT\n# keep list readable\nINVALID-WORD\n"
    });
    try {
      const result = await buildFilteredAnswerPoolArtifacts({
        variant: setup.variant,
        commit: setup.commit,
        providerRoot: setup.providerRoot,
        filterMode: FILTER_MODES.DENYLIST_ONLY
      });

      const active = fs
        .readFileSync(result.activeAnswerPoolPath, "utf8")
        .trim()
        .split("\n");
      expect(active).toEqual(["CAT", "DOG", "DOGS", "GOOSE", "PLAY", "WALK"]);

      const metadata = JSON.parse(fs.readFileSync(result.filterMetadataPath, "utf8"));
      expect(metadata.filterMode).toBe(FILTER_MODES.DENYLIST_ONLY);
      expect(metadata.counts.inputAnswers).toBe(7);
      expect(metadata.counts.denylistEntries).toBe(1);
      expect(metadata.counts.denylistFilteredOut).toBe(1);
      expect(metadata.counts.denylistMatched).toBe(1);
      expect(metadata.counts.activatedAnswers).toBe(6);
      expect(metadata.generatedAt).toBe("2026-02-21T00:00:00.000Z");
    } finally {
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
    }
  });

  test("enforces allowlist-required mode after denylist filtering", async () => {
    const setup = writeProviderAnswerArtifacts({
      denylistContent: "WENT\n",
      allowlistContent: "WENT\nGOOSE\nWALK\n"
    });
    try {
      const result = await buildFilteredAnswerPoolArtifacts({
        variant: setup.variant,
        commit: setup.commit,
        providerRoot: setup.providerRoot,
        filterMode: FILTER_MODES.ALLOWLIST_REQUIRED
      });

      const active = fs
        .readFileSync(result.activeAnswerPoolPath, "utf8")
        .trim()
        .split("\n");
      expect(active).toEqual(["GOOSE", "WALK"]);

      const metadata = JSON.parse(fs.readFileSync(result.filterMetadataPath, "utf8"));
      expect(metadata.counts.denylistMatched).toBe(1);
      expect(metadata.counts.allowlistEntries).toBe(3);
      expect(metadata.counts.allowlistExcluded).toBe(4);
      expect(metadata.counts.activatedAnswers).toBe(2);
    } finally {
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
    }
  });

  test("fails when allowlist-required mode is selected without allowlist file", async () => {
    const setup = writeProviderAnswerArtifacts({
      denylistContent: ""
    });
    try {
      await expect(
        buildFilteredAnswerPoolArtifacts({
          variant: setup.variant,
          commit: setup.commit,
          providerRoot: setup.providerRoot,
          filterMode: FILTER_MODES.ALLOWLIST_REQUIRED
        })
      ).rejects.toMatchObject({
        code: "ALLOWLIST_REQUIRED"
      });
    } finally {
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
    }
  });

  test("fails closed when filtering removes all answers", async () => {
    const setup = writeProviderAnswerArtifacts({
      denylistContent: "CAT\nDOG\nDOGS\nGOOSE\nWENT\nPLAY\nWALK\n"
    });
    try {
      await expect(
        buildFilteredAnswerPoolArtifacts({
          variant: setup.variant,
          commit: setup.commit,
          providerRoot: setup.providerRoot,
          filterMode: FILTER_MODES.DENYLIST_ONLY
        })
      ).rejects.toMatchObject({
        code: "FILTERED_POOL_EMPTY"
      });
    } finally {
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
    }
  });

  test("rejects commit values that are not strict 40-char lowercase hex", async () => {
    const setup = writeProviderAnswerArtifacts();
    try {
      await expect(
        buildFilteredAnswerPoolArtifacts({
          variant: setup.variant,
          commit: setup.commit.toUpperCase(),
          providerRoot: setup.providerRoot
        })
      ).rejects.toMatchObject({
        code: "INVALID_COMMIT"
      });
    } finally {
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
    }
  });

  test("exports typed filter errors", () => {
    const err = new ProviderAnswerFilterError("X", "failed");
    expect(err.name).toBe("ProviderAnswerFilterError");
    expect(err.code).toBe("X");
  });
});

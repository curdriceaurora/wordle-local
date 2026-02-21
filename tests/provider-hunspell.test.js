const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildExpandedFormsArtifacts, ProviderHunspellError } = require("../lib/provider-hunspell");

const PROVIDER_REPOSITORY = "https://github.com/LibreOffice/dictionaries";
const PROVIDER_ID = "libreoffice-dictionaries";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lhw-provider-hunspell-"));
}

function writeProviderSourceBundle(options = {}) {
  const providerRoot = options.providerRoot || createTempDir();
  const variant = options.variant || "en-US";
  const commit = options.commit || COMMIT;
  const variantRoot = path.join(providerRoot, variant, commit);
  fs.mkdirSync(variantRoot, { recursive: true });

  const dicFile = options.dicFile || "en_US.dic";
  const affFile = options.affFile || "en_US.aff";
  const dicPath = path.join(variantRoot, dicFile);
  const affPath = path.join(variantRoot, affFile);
  fs.writeFileSync(dicPath, options.dicContent || "2\nDOG/S\nCAT\n", "utf8");
  fs.writeFileSync(
    affPath,
    options.affContent || "SET UTF-8\nSFX S Y 1\nSFX S 0 S .\n",
    "utf8"
  );

  const sourceManifest = {
    schemaVersion: 1,
    manifestType: "provider-source-fetch",
    provider: {
      providerId: PROVIDER_ID,
      variant,
      repository: PROVIDER_REPOSITORY,
      commit,
      dicPath: "en/en_US.dic",
      affPath: "en/en_US.aff"
    },
    sourceFiles: {
      dic: {
        sourcePath: "en/en_US.dic",
        localPath: path.posix.join(variant, commit, dicFile),
        url: `${PROVIDER_REPOSITORY}/raw/${commit}/en/en_US.dic`,
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        byteSize: Buffer.byteLength(fs.readFileSync(dicPath, "utf8"), "utf8")
      },
      aff: {
        sourcePath: "en/en_US.aff",
        localPath: path.posix.join(variant, commit, affFile),
        url: `${PROVIDER_REPOSITORY}/raw/${commit}/en/en_US.aff`,
        sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        byteSize: Buffer.byteLength(fs.readFileSync(affPath, "utf8"), "utf8")
      }
    },
    retrievedAt: "2026-02-20T00:00:00.000Z"
  };
  fs.writeFileSync(
    path.join(variantRoot, "source-manifest.json"),
    `${JSON.stringify(sourceManifest, null, 2)}\n`,
    "utf8"
  );

  return {
    providerRoot,
    variant,
    commit
  };
}

describe("provider-hunspell", () => {
  test("builds deterministic expanded artifacts from source manifest", async () => {
    const setup = writeProviderSourceBundle({
      dicContent: "4\nDOG/S\nCAT\nA-B\nQWERTYUIOPASD/S\n",
      affContent: "SET UTF-8\nSFX S Y 1\nSFX S 0 S .\n"
    });
    try {
      const result = await buildExpandedFormsArtifacts({
        variant: setup.variant,
        commit: setup.commit,
        providerRoot: setup.providerRoot,
        policyVersion: "v1"
      });

      const words = fs
        .readFileSync(result.expandedFormsPath, "utf8")
        .trim()
        .split("\n");
      expect(words).toEqual(["CAT", "DOG", "DOGS"]);

      const processed = JSON.parse(fs.readFileSync(result.processedPath, "utf8"));
      expect(processed.schemaVersion).toBe(1);
      expect(processed.variant).toBe(setup.variant);
      expect(processed.commit).toBe(setup.commit);
      expect(processed.policyVersion).toBe("v1");
      expect(processed.counts.rawEntries).toBe(4);
      expect(processed.counts.expandedForms).toBe(3);
      expect(processed.counts.filteredOut).toBeGreaterThanOrEqual(1);
      expect(processed.generatedAt).toBe("2026-02-20T00:00:00.000Z");

      const rerun = await buildExpandedFormsArtifacts({
        variant: setup.variant,
        commit: setup.commit,
        providerRoot: setup.providerRoot,
        policyVersion: "v1"
      });
      const rerunWords = fs
        .readFileSync(rerun.expandedFormsPath, "utf8")
        .trim()
        .split("\n");
      expect(rerunWords).toEqual(words);
      const rerunProcessed = fs.readFileSync(rerun.processedPath, "utf8");
      expect(rerunProcessed).toEqual(fs.readFileSync(result.processedPath, "utf8"));
    } finally {
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
    }
  });

  test("rejects invalid variant values", async () => {
    const setup = writeProviderSourceBundle({ variant: "en-US" });
    try {
      await expect(
        buildExpandedFormsArtifacts({
          variant: "../en-US",
          commit: setup.commit,
          providerRoot: setup.providerRoot,
          policyVersion: "v1"
        })
      ).rejects.toMatchObject({
        code: "INVALID_VARIANT"
      });

      await expect(
        buildExpandedFormsArtifacts({
          variant: "fr-FR",
          commit: setup.commit,
          providerRoot: setup.providerRoot,
          policyVersion: "v1"
        })
      ).rejects.toMatchObject({
        code: "INVALID_VARIANT"
      });
    } finally {
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
    }
  });

  test("falls back to replace destination when rename overwrite fails", async () => {
    const setup = writeProviderSourceBundle();
    const originalRename = fs.promises.rename;
    let renameSpy = null;
    try {
      await buildExpandedFormsArtifacts({
        variant: setup.variant,
        commit: setup.commit,
        providerRoot: setup.providerRoot,
        policyVersion: "v1"
      });

      let shouldFailOnce = true;
      renameSpy = jest.spyOn(fs.promises, "rename").mockImplementation(async (...args) => {
        if (shouldFailOnce) {
          shouldFailOnce = false;
          const err = new Error("rename blocked");
          err.code = "EPERM";
          throw err;
        }
        return originalRename(...args);
      });

      await buildExpandedFormsArtifacts({
        variant: setup.variant,
        commit: setup.commit,
        providerRoot: setup.providerRoot,
        policyVersion: "v1"
      });

      expect(renameSpy).toHaveBeenCalled();
    } finally {
      if (renameSpy) {
        renameSpy.mockRestore();
      }
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
    }
  });

  test("fails when source manifest is missing", async () => {
    const providerRoot = createTempDir();
    try {
      await expect(
        buildExpandedFormsArtifacts({
          variant: "en-US",
          commit: COMMIT,
          providerRoot,
          policyVersion: "v1"
        })
      ).rejects.toMatchObject({
        code: "SOURCE_MANIFEST_MISSING"
      });
    } finally {
      fs.rmSync(providerRoot, { recursive: true, force: true });
    }
  });

  test("fails when source manifest variant does not match request", async () => {
    const setup = writeProviderSourceBundle({ variant: "en-US" });
    const manifestPath = path.join(setup.providerRoot, setup.variant, setup.commit, "source-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.provider.variant = "en-GB";
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    try {
      await expect(
        buildExpandedFormsArtifacts({
          variant: "en-US",
          commit: setup.commit,
          providerRoot: setup.providerRoot,
          policyVersion: "v1"
        })
      ).rejects.toMatchObject({
        code: "INVALID_MANIFEST"
      });
    } finally {
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
    }
  });

  test("fails when source file manifest path contains traversal segment", async () => {
    const setup = writeProviderSourceBundle({ variant: "en-US" });
    const manifestPath = path.join(setup.providerRoot, setup.variant, setup.commit, "source-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.sourceFiles.dic.localPath = `${setup.variant}/${setup.commit}/foo/../en_US.dic`;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    try {
      await expect(
        buildExpandedFormsArtifacts({
          variant: "en-US",
          commit: setup.commit,
          providerRoot: setup.providerRoot,
          policyVersion: "v1"
        })
      ).rejects.toMatchObject({
        code: "INVALID_MANIFEST"
      });
    } finally {
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
    }
  });

  test("rejects overriding fixed gameplay length policy", async () => {
    const setup = writeProviderSourceBundle({ variant: "en-US" });
    try {
      await expect(
        buildExpandedFormsArtifacts({
          variant: "en-US",
          commit: setup.commit,
          providerRoot: setup.providerRoot,
          policyVersion: "v1",
          minLength: 2
        })
      ).rejects.toMatchObject({
        code: "INVALID_POLICY_BOUNDS"
      });
    } finally {
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
    }
  });

  test("keeps source manifest path stable when outputRoot differs", async () => {
    const setup = writeProviderSourceBundle({ variant: "en-US" });
    const outputRoot = createTempDir();
    try {
      const result = await buildExpandedFormsArtifacts({
        variant: "en-US",
        commit: setup.commit,
        providerRoot: setup.providerRoot,
        outputRoot,
        policyVersion: "v1"
      });
      const processed = JSON.parse(fs.readFileSync(result.processedPath, "utf8"));
      expect(processed.sourceManifestPath).toBe(`${setup.variant}/${setup.commit}/source-manifest.json`);
      expect(processed.sourceManifestPath.includes("..")).toBe(false);
    } finally {
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  test("fails when hunspell affix file is malformed", async () => {
    const setup = writeProviderSourceBundle({
      affContent: "SET UTF-8\nPFX A Y 1\n"
    });
    try {
      await expect(
        buildExpandedFormsArtifacts({
          variant: setup.variant,
          commit: setup.commit,
          providerRoot: setup.providerRoot,
          policyVersion: "v1"
        })
      ).rejects.toMatchObject({
        code: "HUNSPELL_PARSE_FAILED"
      });
    } finally {
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
    }
  });

  test("exports typed provider errors", () => {
    const error = new ProviderHunspellError("X", "failed");
    expect(error.name).toBe("ProviderHunspellError");
    expect(error.code).toBe("X");
  });
});

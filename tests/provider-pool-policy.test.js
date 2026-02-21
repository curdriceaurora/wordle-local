const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildProviderPoolsArtifacts, ProviderPoolPolicyError } = require("../lib/provider-pool-policy");

const PROVIDER_REPOSITORY = "https://github.com/LibreOffice/dictionaries";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lhw-provider-policy-"));
}

function writeProviderArtifacts(options = {}) {
  const providerRoot = options.providerRoot || createTempDir();
  const variant = options.variant || "en-US";
  const commit = options.commit || COMMIT;
  const variantRoot = path.join(providerRoot, variant, commit);
  fs.mkdirSync(variantRoot, { recursive: true });

  const dicFile = options.dicFile || "en_US.dic";
  const dicPath = path.join(variantRoot, dicFile);
  fs.writeFileSync(
    dicPath,
    options.dicContent
      || "7\nDOG/S\nCAT\nWALK/DSG\nGOOSE\nPLAY/DSG\nA-B\nHI\n",
    "utf8"
  );

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
        localPath: path.posix.join(variant, commit, dicFile),
        url: `${PROVIDER_REPOSITORY}/raw/${commit}/en/en_US.dic`,
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        byteSize: Buffer.byteLength(fs.readFileSync(dicPath, "utf8"), "utf8")
      },
      aff: {
        sourcePath: "en/en_US.aff",
        localPath: path.posix.join(variant, commit, "en_US.aff"),
        url: `${PROVIDER_REPOSITORY}/raw/${commit}/en/en_US.aff`,
        sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        byteSize: 10
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
    path.join(variantRoot, "expanded-forms.txt"),
    options.expandedFormsContent
      || "DOG\nDOGS\nCAT\nWALK\nWALKED\nWALKING\nWENT\nGOOSE\nGEESE\nPLAY\nPLAYED\nPLAYING\n",
    "utf8"
  );

  if (options.allowlistContent !== undefined) {
    fs.writeFileSync(
      path.join(variantRoot, "irregular-answer-allowlist.txt"),
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

describe("provider-pool-policy", () => {
  test("builds base+irregular answer pool with deterministic artifacts", async () => {
    const setup = writeProviderArtifacts({
      allowlistContent: "WENT\nGEESE\nDOGS\n"
    });
    try {
      const result = await buildProviderPoolsArtifacts({
        variant: setup.variant,
        commit: setup.commit,
        providerRoot: setup.providerRoot,
        policyVersion: "v1"
      });

      const guessPool = fs.readFileSync(result.guessPoolPath, "utf8").trim().split("\n");
      expect(guessPool).toEqual([
        "CAT",
        "DOG",
        "DOGS",
        "GEESE",
        "GOOSE",
        "PLAY",
        "PLAYED",
        "PLAYING",
        "WALK",
        "WALKED",
        "WALKING",
        "WENT"
      ]);

      const answerPool = fs.readFileSync(result.answerPoolPath, "utf8").trim().split("\n");
      expect(answerPool).toEqual([
        "CAT",
        "DOG",
        "DOGS",
        "GEESE",
        "GOOSE",
        "PLAY",
        "WALK",
        "WENT"
      ]);

      const metadata = JSON.parse(fs.readFileSync(result.metadataPath, "utf8"));
      expect(metadata.variant).toBe(setup.variant);
      expect(metadata.commit).toBe(setup.commit);
      expect(metadata.policyVersion).toBe("v1");
      expect(metadata.guessPoolPolicy).toBe("expanded-forms");
      expect(metadata.answerPoolPolicy).toBe("base-plus-irregular");
      expect(metadata.generatedAt).toBe("2026-02-21T00:00:00.000Z");
      expect(metadata.counts.expandedForms).toBe(12);
      expect(metadata.counts.baseWords).toBe(5);
      expect(metadata.counts.baseWordsFilteredOut).toBe(2);
      expect(metadata.counts.irregularAllowlisted).toBe(3);
      expect(metadata.counts.irregularAccepted).toBe(3);
      expect(metadata.counts.answerPool).toBe(8);

      const rerun = await buildProviderPoolsArtifacts({
        variant: setup.variant,
        commit: setup.commit,
        providerRoot: setup.providerRoot,
        policyVersion: "v1"
      });
      expect(fs.readFileSync(rerun.guessPoolPath, "utf8")).toEqual(fs.readFileSync(result.guessPoolPath, "utf8"));
      expect(fs.readFileSync(rerun.answerPoolPath, "utf8")).toEqual(fs.readFileSync(result.answerPoolPath, "utf8"));
      expect(fs.readFileSync(rerun.metadataPath, "utf8")).toEqual(fs.readFileSync(result.metadataPath, "utf8"));
    } finally {
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
    }
  });

  test("keeps guess pool but answer pool excludes regular inflections without allowlist", async () => {
    const setup = writeProviderArtifacts({
      allowlistContent: ""
    });
    try {
      const result = await buildProviderPoolsArtifacts({
        variant: setup.variant,
        commit: setup.commit,
        providerRoot: setup.providerRoot,
        policyVersion: "v1"
      });

      const answerPool = fs.readFileSync(result.answerPoolPath, "utf8").trim().split("\n");
      expect(answerPool).toEqual(["CAT", "DOG", "GOOSE", "PLAY", "WALK"]);
      expect(answerPool.includes("DOGS")).toBe(false);
      expect(answerPool.includes("PLAYED")).toBe(false);
      expect(answerPool.includes("PLAYING")).toBe(false);
      expect(answerPool.includes("WALKED")).toBe(false);
      expect(answerPool.includes("WALKING")).toBe(false);
    } finally {
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
    }
  });

  test("fails when required input artifacts are missing", async () => {
    const setup = writeProviderArtifacts();
    fs.rmSync(path.join(setup.providerRoot, setup.variant, setup.commit, "expanded-forms.txt"));
    try {
      await expect(
        buildProviderPoolsArtifacts({
          variant: setup.variant,
          commit: setup.commit,
          providerRoot: setup.providerRoot,
          policyVersion: "v1"
        })
      ).rejects.toMatchObject({ code: "INPUT_ARTIFACT_MISSING" });
    } finally {
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
    }
  });

  test("fails when answer pool would be empty", async () => {
    const setup = writeProviderArtifacts({
      dicContent: "2\nA-B\nHI\n",
      expandedFormsContent: "DOG\nDOGS\n"
    });
    try {
      await expect(
        buildProviderPoolsArtifacts({
          variant: setup.variant,
          commit: setup.commit,
          providerRoot: setup.providerRoot,
          policyVersion: "v1"
        })
      ).rejects.toMatchObject({ code: "ANSWER_POOL_EMPTY" });
    } finally {
      fs.rmSync(setup.providerRoot, { recursive: true, force: true });
    }
  });

  test("exports typed policy errors", () => {
    const error = new ProviderPoolPolicyError("X", "failed");
    expect(error.name).toBe("ProviderPoolPolicyError");
    expect(error.code).toBe("X");
  });
});

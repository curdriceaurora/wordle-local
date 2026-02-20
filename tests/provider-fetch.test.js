const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ProviderFetchError,
  buildProviderDescriptor,
  computeSha256,
  fetchAndPersistProviderSource
} = require("../lib/provider-fetch");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lhw-provider-fetch-"));
}

function createFetchMock(responseMap) {
  return async (url) => {
    const response = responseMap[url];
    if (!response) {
      return {
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0)
      };
    }
    if (response.throwError) {
      throw response.throwError;
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      arrayBuffer: async () => response.body.buffer.slice(
        response.body.byteOffset,
        response.body.byteOffset + response.body.byteLength
      )
    };
  };
}

describe("provider-fetch", () => {
  test("builds descriptor for allowed variant", () => {
    const descriptor = buildProviderDescriptor({
      variant: "en-GB",
      commit: "0123456789abcdef0123456789abcdef01234567"
    });

    expect(descriptor.providerId).toBe("libreoffice-dictionaries");
    expect(descriptor.repository).toBe("https://github.com/LibreOffice/dictionaries");
    expect(descriptor.variant).toBe("en-GB");
    expect(descriptor.dicPath).toBe("en/en_GB.dic");
    expect(descriptor.affPath).toBe("en/en_GB.aff");
  });

  test("rejects unsupported variant", () => {
    expect(() =>
      buildProviderDescriptor({
        variant: "fr-FR",
        commit: "0123456789abcdef0123456789abcdef01234567"
      })
    ).toThrow(ProviderFetchError);
  });

  test("rejects non-pinned commit hash", () => {
    expect(() =>
      buildProviderDescriptor({
        variant: "en-US",
        commit: "main"
      })
    ).toThrow(ProviderFetchError);
  });

  test("fetches, verifies, and persists provider artifacts", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const dicBody = Buffer.from("3\nCAT\nDOG\nBIRD\n", "utf8");
    const affBody = Buffer.from("SET UTF-8\nFLAG long\n", "utf8");
    const dicUrl = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${commit}/en/en_US.dic`;
    const affUrl = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${commit}/en/en_US.aff`;
    const outputRoot = createTempDir();

    try {
      const result = await fetchAndPersistProviderSource({
        variant: "en-US",
        commit,
        expectedChecksums: {
          dic: computeSha256(dicBody),
          aff: computeSha256(affBody)
        },
        outputRoot,
        fetchImpl: createFetchMock({
          [dicUrl]: { status: 200, body: dicBody },
          [affUrl]: { status: 200, body: affBody }
        })
      });

      expect(result.descriptor.variant).toBe("en-US");
      expect(result.sourceFiles.dic.sha256).toBe(computeSha256(dicBody));
      expect(result.sourceFiles.aff.sha256).toBe(computeSha256(affBody));
      expect(fs.readFileSync(result.sourceFiles.dic.path, "utf8")).toBe(dicBody.toString("utf8"));
      expect(fs.readFileSync(result.sourceFiles.aff.path, "utf8")).toBe(affBody.toString("utf8"));

      const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
      expect(manifest.provider.variant).toBe("en-US");
      expect(manifest.provider.commit).toBe(commit);
      expect(manifest.sourceFiles.dic.sha256).toBe(computeSha256(dicBody));
      expect(manifest.sourceFiles.aff.sha256).toBe(computeSha256(affBody));
      expect(typeof manifest.retrievedAt).toBe("string");
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  test("fails closed on checksum mismatch", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const dicBody = Buffer.from("2\nCAT\nDOG\n", "utf8");
    const affBody = Buffer.from("SET UTF-8\n", "utf8");
    const dicUrl = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${commit}/en/en_CA.dic`;
    const affUrl = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${commit}/en/en_CA.aff`;

    await expect(
      fetchAndPersistProviderSource({
        variant: "en-CA",
        commit,
        expectedChecksums: {
          dic: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        fetchImpl: createFetchMock({
          [dicUrl]: { status: 200, body: dicBody },
          [affUrl]: { status: 200, body: affBody }
        })
      })
    ).rejects.toMatchObject({
      code: "CHECKSUM_MISMATCH"
    });
  });

  test("returns friendly error when upstream file is missing", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const dicUrl = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${commit}/en/en_AU.dic`;
    const affUrl = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${commit}/en/en_AU.aff`;

    await expect(
      fetchAndPersistProviderSource({
        variant: "en-AU",
        commit,
        fetchImpl: createFetchMock({
          [dicUrl]: { status: 200, body: Buffer.from("1\nCAT\n", "utf8") },
          [affUrl]: { status: 404, body: Buffer.alloc(0) }
        })
      })
    ).rejects.toMatchObject({
      code: "SOURCE_NOT_FOUND",
      status: 404
    });
  });

  test("returns friendly error when upstream rate limits", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const dicUrl = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${commit}/en/en_ZA.dic`;
    const affUrl = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${commit}/en/en_ZA.aff`;

    await expect(
      fetchAndPersistProviderSource({
        variant: "en-ZA",
        commit,
        fetchImpl: createFetchMock({
          [dicUrl]: { status: 429, body: Buffer.alloc(0) },
          [affUrl]: { status: 200, body: Buffer.from("SET UTF-8\n", "utf8") }
        })
      })
    ).rejects.toMatchObject({
      code: "UPSTREAM_RATE_LIMITED",
      status: 429
    });
  });
});

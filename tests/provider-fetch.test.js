const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ProviderFetchError,
  buildProviderDescriptor,
  computeSha256,
  fetchAndPersistProviderSource
} = require("../lib/provider-fetch");

const VALID_CHECKSUM_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VALID_CHECKSUM_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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

function createAbortFetchMock() {
  return async (_url, options = {}) => new Promise((_resolve, reject) => {
    if (options.signal && typeof options.signal.addEventListener === "function") {
      options.signal.addEventListener("abort", () => {
        const abortError = new Error("Request aborted");
        abortError.name = "AbortError";
        reject(abortError);
      });
      return;
    }

    setTimeout(() => {
      const abortError = new Error("Request aborted");
      abortError.name = "AbortError";
      reject(abortError);
    }, 10);
  });
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
      expect(manifest.manifestType).toBe("provider-source-fetch");
      expect(manifest.provider.variant).toBe("en-US");
      expect(manifest.provider.commit).toBe(commit);
      expect(manifest.sourceFiles.dic.sourcePath).toBe("en/en_US.dic");
      expect(manifest.sourceFiles.aff.sourcePath).toBe("en/en_US.aff");
      expect(manifest.sourceFiles.dic.localPath).toBe(`en-US/${commit}/en_US.dic`);
      expect(manifest.sourceFiles.aff.localPath).toBe(`en-US/${commit}/en_US.aff`);
      expect(manifest.sourceFiles.dic.url).toBe(dicUrl);
      expect(manifest.sourceFiles.aff.url).toBe(affUrl);
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
          dic: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          aff: computeSha256(affBody)
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

  test("requires both expected checksums for fetch integrity verification", async () => {
    await expect(
      fetchAndPersistProviderSource({
        variant: "en-GB",
        commit: "0123456789abcdef0123456789abcdef01234567",
        expectedChecksums: {
          dic: VALID_CHECKSUM_A
        }
      })
    ).rejects.toMatchObject({
      code: "CHECKSUM_REQUIRED"
    });
  });

  test("rejects malformed expected checksum values", async () => {
    await expect(
      fetchAndPersistProviderSource({
        variant: "en-GB",
        commit: "0123456789abcdef0123456789abcdef01234567",
        expectedChecksums: {
          dic: "ABCDEF",
          aff: VALID_CHECKSUM_B
        }
      })
    ).rejects.toMatchObject({
      code: "INVALID_CHECKSUM"
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
        expectedChecksums: {
          dic: VALID_CHECKSUM_A,
          aff: VALID_CHECKSUM_B
        },
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
        expectedChecksums: {
          dic: VALID_CHECKSUM_A,
          aff: VALID_CHECKSUM_B
        },
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

  test("returns friendly error when upstream responds with server error", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const dicUrl = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${commit}/en/en_GB.dic`;
    const affUrl = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${commit}/en/en_GB.aff`;

    await expect(
      fetchAndPersistProviderSource({
        variant: "en-GB",
        commit,
        expectedChecksums: {
          dic: VALID_CHECKSUM_A,
          aff: VALID_CHECKSUM_B
        },
        fetchImpl: createFetchMock({
          [dicUrl]: { status: 500, body: Buffer.alloc(0) },
          [affUrl]: { status: 200, body: Buffer.from("SET UTF-8\n", "utf8") }
        })
      })
    ).rejects.toMatchObject({
      code: "UPSTREAM_SERVER_ERROR",
      status: 500
    });
  });

  test("returns friendly error for non-404/429/5xx upstream failures", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const dicUrl = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${commit}/en/en_GB.dic`;
    const affUrl = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${commit}/en/en_GB.aff`;

    await expect(
      fetchAndPersistProviderSource({
        variant: "en-GB",
        commit,
        expectedChecksums: {
          dic: VALID_CHECKSUM_A,
          aff: VALID_CHECKSUM_B
        },
        fetchImpl: createFetchMock({
          [dicUrl]: { status: 401, body: Buffer.alloc(0) },
          [affUrl]: { status: 200, body: Buffer.from("SET UTF-8\n", "utf8") }
        })
      })
    ).rejects.toMatchObject({
      code: "UPSTREAM_REQUEST_FAILED",
      status: 401
    });
  });

  test("returns timeout error when provider fetch exceeds timeout", async () => {
    await expect(
      fetchAndPersistProviderSource({
        variant: "en-GB",
        commit: "0123456789abcdef0123456789abcdef01234567",
        expectedChecksums: {
          dic: VALID_CHECKSUM_A,
          aff: VALID_CHECKSUM_B
        },
        timeoutMs: 1,
        fetchImpl: createAbortFetchMock()
      })
    ).rejects.toMatchObject({
      code: "FETCH_TIMEOUT",
      retriable: true
    });
  });

  test("returns network error when fetch implementation throws", async () => {
    const networkError = new Error("network down");
    await expect(
      fetchAndPersistProviderSource({
        variant: "en-GB",
        commit: "0123456789abcdef0123456789abcdef01234567",
        expectedChecksums: {
          dic: VALID_CHECKSUM_A,
          aff: VALID_CHECKSUM_B
        },
        fetchImpl: async () => {
          throw networkError;
        }
      })
    ).rejects.toMatchObject({
      code: "FETCH_NETWORK_ERROR",
      retriable: true,
      cause: networkError
    });
  });

  test("returns explicit fetch unavailable error when fetch implementation is not callable", async () => {
    await expect(
      fetchAndPersistProviderSource({
        variant: "en-GB",
        commit: "0123456789abcdef0123456789abcdef01234567",
        expectedChecksums: {
          dic: VALID_CHECKSUM_A,
          aff: VALID_CHECKSUM_B
        },
        fetchImpl: "not-a-function"
      })
    ).rejects.toMatchObject({
      code: "FETCH_UNAVAILABLE"
    });
  });

  test("returns persistence error when source manifest cannot replace existing directory", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const dicBody = Buffer.from("2\nCAT\nDOG\n", "utf8");
    const affBody = Buffer.from("SET UTF-8\n", "utf8");
    const dicUrl = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${commit}/en/en_GB.dic`;
    const affUrl = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${commit}/en/en_GB.aff`;
    const outputRoot = createTempDir();
    const variantRoot = path.join(outputRoot, "en-GB", commit);
    fs.mkdirSync(path.join(variantRoot, "source-manifest.json"), { recursive: true });

    try {
      await expect(
        fetchAndPersistProviderSource({
          variant: "en-GB",
          commit,
          outputRoot,
          expectedChecksums: {
            dic: computeSha256(dicBody),
            aff: computeSha256(affBody)
          },
          fetchImpl: createFetchMock({
            [dicUrl]: { status: 200, body: dicBody },
            [affUrl]: { status: 200, body: affBody }
          })
        })
      ).rejects.toMatchObject({
        code: "PERSISTENCE_WRITE_FAILED"
      });
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  test("supports replacing an existing source-manifest file", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const outputRoot = createTempDir();
    const dicUrl = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${commit}/en/en_GB.dic`;
    const affUrl = `https://raw.githubusercontent.com/LibreOffice/dictionaries/${commit}/en/en_GB.aff`;
    const firstDicBody = Buffer.from("2\nCAT\nDOG\n", "utf8");
    const firstAffBody = Buffer.from("SET UTF-8\n", "utf8");
    const secondDicBody = Buffer.from("2\nCAT\nEEL\n", "utf8");
    const secondAffBody = Buffer.from("SET UTF-8\nFLAG long\n", "utf8");

    try {
      const firstResult = await fetchAndPersistProviderSource({
        variant: "en-GB",
        commit,
        outputRoot,
        expectedChecksums: {
          dic: computeSha256(firstDicBody),
          aff: computeSha256(firstAffBody)
        },
        fetchImpl: createFetchMock({
          [dicUrl]: { status: 200, body: firstDicBody },
          [affUrl]: { status: 200, body: firstAffBody }
        })
      });

      const firstManifest = JSON.parse(fs.readFileSync(firstResult.manifestPath, "utf8"));

      const secondResult = await fetchAndPersistProviderSource({
        variant: "en-GB",
        commit,
        outputRoot,
        expectedChecksums: {
          dic: computeSha256(secondDicBody),
          aff: computeSha256(secondAffBody)
        },
        fetchImpl: createFetchMock({
          [dicUrl]: { status: 200, body: secondDicBody },
          [affUrl]: { status: 200, body: secondAffBody }
        })
      });

      const secondManifest = JSON.parse(fs.readFileSync(secondResult.manifestPath, "utf8"));
      expect(secondManifest.sourceFiles.dic.sha256).toBe(computeSha256(secondDicBody));
      expect(secondManifest.sourceFiles.aff.sha256).toBe(computeSha256(secondAffBody));
      expect(secondManifest.retrievedAt >= firstManifest.retrievedAt).toBe(true);
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});

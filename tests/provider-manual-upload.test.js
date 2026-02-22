const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { computeSha256 } = require("../lib/provider-fetch");
const {
  MANUAL_SOURCE_MANIFEST_TYPE,
  persistManualProviderSource
} = require("../lib/provider-manual-upload");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lhw-provider-manual-"));
}

function toBase64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

describe("provider-manual-upload", () => {
  test("persists manual source files with explicit commit and checksums", async () => {
    const outputRoot = createTempDir();
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const dicText = "2\nDOG/S\nCAT\n";
    const affText = "SET UTF-8\nSFX S Y 1\nSFX S 0 S .\n";

    try {
      const result = await persistManualProviderSource({
        variant: "en-US",
        commit,
        expectedChecksums: {
          dic: computeSha256(Buffer.from(dicText, "utf8")),
          aff: computeSha256(Buffer.from(affText, "utf8"))
        },
        manualFiles: {
          dicBase64: toBase64(dicText),
          affBase64: toBase64(affText),
          dicFileName: "manual-en_US.dic",
          affFileName: "manual-en_US.aff"
        },
        outputRoot
      });

      expect(result.descriptor.commit).toBe(commit);
      expect(fs.existsSync(result.sourceFiles.dic.path)).toBe(true);
      expect(fs.existsSync(result.sourceFiles.aff.path)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
      expect(manifest.manifestType).toBe(MANUAL_SOURCE_MANIFEST_TYPE);
      expect(manifest.provider.variant).toBe("en-US");
      expect(manifest.provider.commit).toBe(commit);
      expect(manifest.manualUpload.commitProvided).toBe(true);
      expect(manifest.sourceFiles.dic.uploadFileName).toBe("manual-en_US.dic");
      expect(manifest.sourceFiles.aff.uploadFileName).toBe("manual-en_US.aff");
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  test("derives deterministic synthetic commit when commit is omitted", async () => {
    const outputRoot = createTempDir();
    const dicText = "1\nVAULT\n";
    const affText = "SET UTF-8\n";

    try {
      const resultA = await persistManualProviderSource({
        variant: "en-GB",
        expectedChecksums: {
          dic: computeSha256(Buffer.from(dicText, "utf8")),
          aff: computeSha256(Buffer.from(affText, "utf8"))
        },
        manualFiles: {
          dicBase64: toBase64(dicText),
          affBase64: toBase64(affText)
        },
        outputRoot
      });

      const resultB = await persistManualProviderSource({
        variant: "en-GB",
        expectedChecksums: {
          dic: computeSha256(Buffer.from(dicText, "utf8")),
          aff: computeSha256(Buffer.from(affText, "utf8"))
        },
        manualFiles: {
          dicBase64: toBase64(dicText),
          affBase64: toBase64(affText)
        },
        outputRoot
      });

      expect(resultA.descriptor.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(resultA.descriptor.commit).toBe(resultB.descriptor.commit);

      const manifest = JSON.parse(fs.readFileSync(resultA.manifestPath, "utf8"));
      expect(manifest.manualUpload.commitProvided).toBe(false);
      expect(manifest.provider.commit).toBe(resultA.descriptor.commit);
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  test("fails when manual files payload is missing", async () => {
    await expect(
      persistManualProviderSource({
        variant: "en-US",
        commit: "0123456789abcdef0123456789abcdef01234567",
        expectedChecksums: {
          dic: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          aff: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        }
      })
    ).rejects.toMatchObject({
      code: "MANUAL_FILES_REQUIRED"
    });
  });

  test("fails closed when checksum verification fails", async () => {
    await expect(
      persistManualProviderSource({
        variant: "en-CA",
        commit: "0123456789abcdef0123456789abcdef01234567",
        expectedChecksums: {
          dic: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          aff: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        },
        manualFiles: {
          dicBase64: toBase64("1\nDOG\n"),
          affBase64: toBase64("SET UTF-8\n")
        }
      })
    ).rejects.toMatchObject({
      code: "CHECKSUM_MISMATCH"
    });
  });

  test("rejects manual files above max size limit", async () => {
    const largePayload = Buffer.alloc(1024 * 1024 + 1, 65).toString("base64");

    await expect(
      persistManualProviderSource({
        variant: "en-AU",
        commit: "0123456789abcdef0123456789abcdef01234567",
        expectedChecksums: {
          dic: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          aff: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        },
        manualFiles: {
          dicBase64: largePayload,
          affBase64: toBase64("SET UTF-8\n")
        },
        maxManualFileBytes: 1024 * 1024
      })
    ).rejects.toMatchObject({
      code: "MANUAL_FILE_TOO_LARGE"
    });

    await expect(
      persistManualProviderSource({
        variant: "en-AU",
        commit: "0123456789abcdef0123456789abcdef01234567",
        expectedChecksums: {
          dic: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          aff: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        },
        manualFiles: {
          dicBase64: toBase64("1\nDOG\n"),
          affBase64: largePayload
        },
        maxManualFileBytes: 1024 * 1024
      })
    ).rejects.toMatchObject({
      code: "MANUAL_FILE_TOO_LARGE"
    });
  });
});

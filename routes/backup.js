const express = require("express");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const nodeCrypto = require("node:crypto");
const Busboy = require("busboy");

const {
  BackupError,
  createArchive,
  validateArchive,
  applyRestore
} = require("../lib/backup-store.js");

const RESTORE_CONFIRM_HEADER = "x-admin-confirm";
const RESTORE_CONFIRM_VALUE = "I-UNDERSTAND";

function logEvent(req, event, fields = {}) {
  try {
    const payload = {
      event,
      ts: new Date().toISOString(),
      ...fields
    };
    console.log(JSON.stringify(payload));
  } catch {
    // best effort
  }
}

function backupErrorStatus(err) {
  if (!(err instanceof BackupError)) return 500;
  switch (err.code) {
    case "INVALID_REQUEST":
    case "MANIFEST_INVALID":
    case "MANIFEST_PARSE_FAILED":
    case "MANIFEST_MISMATCH":
    case "MANIFEST_MISSING":
    case "ENTRY_MISSING":
    case "BYTES_MISMATCH":
    case "SHA256_MISMATCH":
    case "RESTORED_FILE_INVALID":
    case "PATH_UNSAFE":
    case "ARCHIVE_MALFORMED":
      return 400;
    case "MANIFEST_VERSION_UNSUPPORTED":
    case "SCHEMA_DRIFT":
      return 400;
    case "ENTRY_TOO_LARGE":
    case "ARCHIVE_TOO_LARGE":
      return 413;
    case "RESTORE_BUSY":
      return 409;
    default:
      return 500;
  }
}

function backupErrorBody(err) {
  if (!(err instanceof BackupError)) {
    return { error: "Backup operation failed.", code: "INTERNAL_ERROR" };
  }
  const body = { error: err.message, code: err.code };
  if (err.details) body.details = err.details;
  return body;
}

function parseBoolFlag(value, defaultValue) {
  if (value === undefined) return defaultValue;
  const normalized = String(value).toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return defaultValue;
}

function safeFilenameTimestamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, "-");
}

async function readNodeIdSafe(projectRoot) {
  try {
    const config = JSON.parse(
      await fsp.readFile(path.join(projectRoot, "data", "app-config.json"), "utf8")
    );
    if (config && typeof config.nodeId === "string" && config.nodeId.length > 0) {
      return config.nodeId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) || "node";
    }
  } catch {
    // fall through
  }
  return "node";
}

// Streaming multipart receiver. Writes the uploaded file to a temp path on
// disk, enforcing the configured byte cap. Returns { tempPath, bytes,
// originalName }. Rejects with a 413-friendly BackupError if the cap is
// exceeded; the partial temp file is removed before rejecting.
async function receiveUpload(req, { maxBytes, tempDir }) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new BackupError("INVALID_REQUEST", "Expected multipart/form-data upload.");
  }
  await fsp.mkdir(tempDir, { recursive: true });
  const stamp = safeFilenameTimestamp();
  const random = nodeCrypto.randomBytes(4).toString("hex");
  const tempPath = path.join(tempDir, `upload-${stamp}-${random}.zip`);

  return new Promise((resolve, reject) => {
    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          fileSize: maxBytes + 1,
          files: 1,
          fields: 10
        }
      });
    } catch (err) {
      reject(new BackupError("INVALID_REQUEST", `Multipart parser init failed: ${err.message}`));
      return;
    }

    let received = false;
    let originalName = "upload.zip";
    let bytesWritten = 0;
    let writeStream = null;
    let truncated = false;

    const cleanupAndReject = async (err) => {
      try {
        if (writeStream && !writeStream.destroyed) writeStream.destroy();
        await fsp.rm(tempPath, { force: true });
      } catch {
        // best effort
      }
      reject(err);
    };

    busboy.on("file", (_fieldname, file, info) => {
      if (received) {
        file.resume();
        return;
      }
      received = true;
      originalName = (info && info.filename) || originalName;
      writeStream = fs.createWriteStream(tempPath);

      file.on("limit", () => {
        truncated = true;
        file.resume();
      });
      file.on("data", (chunk) => {
        bytesWritten += chunk.length;
      });
      file.on("error", (err) => cleanupAndReject(err));

      writeStream.on("error", (err) => cleanupAndReject(err));
      file.pipe(writeStream);
      writeStream.on("finish", () => {
        if (truncated || bytesWritten > maxBytes) {
          cleanupAndReject(new BackupError(
            "ARCHIVE_TOO_LARGE",
            `Uploaded archive exceeds the per-request limit of ${maxBytes} bytes.`
          ));
          return;
        }
        resolve({ tempPath, bytes: bytesWritten, originalName });
      });
    });

    busboy.on("error", (err) => cleanupAndReject(err));
    busboy.on("finish", () => {
      if (!received) {
        cleanupAndReject(new BackupError("INVALID_REQUEST", "Upload did not include a file."));
      }
    });

    req.pipe(busboy);
  });
}

function createBackupRouter(deps) {
  const {
    projectRoot,
    leaderboardStore,
    languageRegistryStore,
    adminJobsStore,
    appConfigStore,
    classesStore,
    rebuildLanguageRuntimeCatalog,
    providerImportQueueActiveRef,
    providerImportSyncActiveRef,
    restoreActiveRef,
    backupMaxBytes,
    backupIncludeProvidersDefault,
    backupRateLimiter
  } = deps;

  if (!projectRoot) {
    throw new Error("createBackupRouter requires projectRoot.");
  }

  const router = express.Router();
  const dataRoot = path.join(projectRoot, "data");
  const uploadsTempDir = path.join(dataRoot, ".restore-uploads");
  const passthrough = (req, res, next) => next();
  const limit = typeof backupRateLimiter === "function" ? backupRateLimiter : passthrough;

  // GET /api/admin/backup
  router.get("/api/admin/backup", limit, async (req, res) => {
    const includeProviders = parseBoolFlag(req.query.includeProviders, backupIncludeProvidersDefault);
    const includeDictionaries = parseBoolFlag(req.query.includeDictionaries, false);
    logEvent(req, "backup.create", { includeProviders, includeDictionaries });

    const stamp = safeFilenameTimestamp();
    const nodeId = await readNodeIdSafe(projectRoot);
    const filename = `wordle-backup-${stamp}-${nodeId}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");

    let archive;
    try {
      const result = createArchive({
        projectRoot,
        includeProviders,
        includeDictionaries
      });
      archive = result.archive;
    } catch (err) {
      logEvent(req, "backup.create.error", { error: err?.message || String(err) });
      return res.status(backupErrorStatus(err)).json(backupErrorBody(err));
    }

    archive.on("error", (err) => {
      logEvent(req, "backup.create.error", { error: err?.message || String(err) });
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to build archive.", code: "ARCHIVE_BUILD_FAILED" });
      } else {
        res.destroy(err);
      }
    });
    archive.on("end", () => {
      logEvent(req, "backup.create.complete");
    });

    archive.pipe(res);
  });

  // POST /api/admin/backup/preview
  router.post("/api/admin/backup/preview", limit, async (req, res) => {
    let upload;
    try {
      upload = await receiveUpload(req, {
        maxBytes: backupMaxBytes,
        tempDir: uploadsTempDir
      });
    } catch (err) {
      return res.status(backupErrorStatus(err)).json(backupErrorBody(err));
    }
    logEvent(req, "backup.preview", { bytes: upload.bytes, originalName: upload.originalName });
    try {
      const { manifest, fileChecks } = await validateArchive(upload.tempPath, {
        projectRoot,
        totalMaxBytes: backupMaxBytes
      });
      const totalBytes = fileChecks.reduce((sum, entry) => sum + entry.bytes, 0);
      return res.json({
        ok: true,
        manifestVersion: manifest.manifestVersion,
        appVersion: manifest.appVersion,
        createdAt: manifest.createdAt,
        nodeId: manifest.nodeId,
        files: fileChecks,
        totalBytes,
        warnings: []
      });
    } catch (err) {
      logEvent(req, "backup.preview.error", { code: err?.code, error: err?.message });
      return res.status(backupErrorStatus(err)).json(backupErrorBody(err));
    } finally {
      try {
        await fsp.rm(upload.tempPath, { force: true });
      } catch {
        // best effort
      }
    }
  });

  // POST /api/admin/restore
  router.post("/api/admin/restore", limit, async (req, res) => {
    if (req.headers[RESTORE_CONFIRM_HEADER] !== RESTORE_CONFIRM_VALUE) {
      return res.status(400).json({
        error: `Restore requires header ${RESTORE_CONFIRM_HEADER}: ${RESTORE_CONFIRM_VALUE}.`,
        code: "RESTORE_CONFIRM_MISSING"
      });
    }
    // Atomic check-and-set: must be synchronous (no await between the
    // check and the assignment) so two simultaneous requests can't both
    // pass the check before either one sets the flag.
    if (
      providerImportQueueActiveRef?.value
      || providerImportSyncActiveRef?.value
      || restoreActiveRef?.value
    ) {
      return res.status(409).json({
        error: "Another admin operation is in flight; retry shortly.",
        code: "RESTORE_BUSY"
      });
    }
    restoreActiveRef.value = true;

    let upload;
    try {
      upload = await receiveUpload(req, {
        maxBytes: backupMaxBytes,
        tempDir: uploadsTempDir
      });
    } catch (err) {
      restoreActiveRef.value = false;
      return res.status(backupErrorStatus(err)).json(backupErrorBody(err));
    }

    logEvent(req, "backup.restore.start", { bytes: upload.bytes, originalName: upload.originalName });

    try {
      const result = await applyRestore({ archivePath: upload.tempPath, projectRoot });

      // Reload in-memory caches so consumers see the restored state.
      const reloadResults = [];
      for (const [name, action] of [
        ["leaderboardStore", () => leaderboardStore?.reload?.()],
        ["adminJobsStore", () => adminJobsStore?.reload?.()],
        ["classesStore", () => classesStore?.reload?.()],
        ["appConfigStore", () => appConfigStore?.reloadSync?.()],
        ["languageRegistryStore", () => languageRegistryStore?.reloadSync?.()],
        ["languageRuntimeCatalog", () => rebuildLanguageRuntimeCatalog?.()]
      ]) {
        try {
          await action();
          reloadResults.push({ name, ok: true });
        } catch (reloadErr) {
          reloadResults.push({ name, ok: false, error: reloadErr?.message || String(reloadErr) });
        }
      }
      logEvent(req, "backup.restore.complete", {
        filesRestored: result.restored.length,
        warnings: result.warnings.length
      });
      return res.json({
        ok: true,
        restored: result.restored,
        filesRestored: result.restored.length,
        rolledBackOnError: false,
        warnings: result.warnings,
        reloads: reloadResults
      });
    } catch (err) {
      logEvent(req, "backup.restore.rollback", { code: err?.code, error: err?.message });
      const status = backupErrorStatus(err);
      const body = backupErrorBody(err);
      body.rolledBackOnError = true;
      return res.status(status).json(body);
    } finally {
      restoreActiveRef.value = false;
      try {
        await fsp.rm(upload.tempPath, { force: true });
      } catch {
        // best effort
      }
    }
  });

  return router;
}

module.exports = createBackupRouter;
module.exports.RESTORE_CONFIRM_HEADER = RESTORE_CONFIRM_HEADER;
module.exports.RESTORE_CONFIRM_VALUE = RESTORE_CONFIRM_VALUE;

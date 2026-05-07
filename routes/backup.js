const express = require("express");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const nodeCrypto = require("node:crypto");
const Busboy = require("busboy");

const {
  BackupError,
  buildManifest,
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
    case "MANIFEST_DUPLICATE_PATH":
    case "ARCHIVE_DUPLICATE_PATH":
    case "OPTIONAL_SET_PATH_INVALID":
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
    case "MANIFEST_TOO_LARGE":
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

function parseBoolFlag(value, defaultValue, fieldName) {
  if (value === undefined) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  // Reject anything that isn't an explicit boolean — silently
  // defaulting on a typo would silently exclude providers/dictionaries
  // from the backup with no signal to the operator.
  throw new BackupError(
    "INVALID_REQUEST",
    `${fieldName || "boolean flag"} must be 'true' or 'false'.`
  );
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
    // Once the promise resolves (caller has the tempPath and is using
    // it), late events from busboy/writeStream must not delete the
    // file. Track whether we've settled so cleanupAndReject becomes a
    // no-op after success.
    let settled = false;

    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const cleanupAndReject = async (err) => {
      if (settled) return;
      settled = true;
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
        settleResolve({ tempPath, bytes: bytesWritten, originalName });
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
    reloadWordData,
    providerImportQueueActiveRef,
    providerImportSyncActiveRef,
    providerImportEnqueueActiveRef,
    dataMutationLockRef,
    restoreInProgressRef,
    directDataWriteActiveRef,
    backupMaxBytes,
    backupIncludeProvidersDefault,
    backupRateLimiter
  } = deps;

  // Touch every in-scope store so its file exists on disk before
  // buildManifest runs. On a fresh node where a store hasn't been read
  // yet, its data file doesn't exist; without this, buildManifest
  // would throw INSCOPE_FILE_MISSING. Each store's load() / loadSync()
  // is idempotent and creates the file with its default state on first
  // call.
  async function warmInScopeStores() {
    if (leaderboardStore?.load) await leaderboardStore.load();
    if (adminJobsStore?.load) await adminJobsStore.load();
    if (classesStore?.load) await classesStore.load();
    if (appConfigStore?.loadSync) appConfigStore.loadSync();
    if (languageRegistryStore?.loadSync) languageRegistryStore.loadSync();
  }

  // Wait for every async store's write queue to drain. Called AFTER
  // dataMutationLockRef is set (so the /api gate has already started
  // refusing new mutations) and BEFORE buildManifest/applyRestore reads
  // or swaps any files. Without this, a mutation that passed the gate
  // moments before the lock was taken could complete its atomic-rename
  // step after we've hashed/swapped, overwriting the just-restored
  // file with stale bytes.
  async function drainStoreWriteQueues() {
    const queues = [
      leaderboardStore?.writeQueue,
      adminJobsStore?.writeQueue,
      classesStore?.writeQueue
    ].filter(Boolean);
    if (queues.length === 0) return;
    await Promise.allSettled(queues);
  }

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
    let includeProviders;
    let includeDictionaries;
    try {
      includeProviders = parseBoolFlag(
        req.query.includeProviders,
        backupIncludeProvidersDefault,
        "includeProviders"
      );
      includeDictionaries = parseBoolFlag(
        req.query.includeDictionaries,
        false,
        "includeDictionaries"
      );
    } catch (err) {
      return res.status(backupErrorStatus(err)).json(backupErrorBody(err));
    }
    logEvent(req, "backup.create", { includeProviders, includeDictionaries });

    // Take the data-mutation lock for the entire export. Without it,
    // a write between hash-time (in buildManifest) and archive-time
    // (the streaming archive.file reads) would produce an archive whose
    // bytes don't match its own manifest sha256. Same flag the restore
    // uses, so both ops are mutually exclusive and writers see 503s.
    if (
      providerImportQueueActiveRef?.value
      || providerImportSyncActiveRef?.value
      || providerImportEnqueueActiveRef?.value
      || dataMutationLockRef?.value
      || restoreInProgressRef?.value
      || (directDataWriteActiveRef && directDataWriteActiveRef.value > 0)
    ) {
      return res.status(409).json({
        error: "Another admin operation is in flight; retry shortly.",
        code: "BACKUP_BUSY"
      });
    }
    dataMutationLockRef.value = true;

    let releaseLock = () => {
      dataMutationLockRef.value = false;
    };

    try {
      // Make sure every in-scope store's file exists on disk before
      // hashing. On a fresh node, an unread store's data file may not
      // exist yet — buildManifest would otherwise throw. Wrap with the
      // same error-mapping as the rest of the route so a store-load
      // disk failure surfaces as a structured JSON 500 instead of an
      // unhandled rejection / generic Express HTML error.
      try {
        await warmInScopeStores();
      } catch (err) {
        logEvent(req, "backup.create.error", { phase: "warm", error: err?.message || String(err) });
        return res.status(500).json({
          error: `Could not warm in-scope stores before backup: ${err?.message || String(err)}`,
          code: "STORE_WARM_FAILED"
        });
      }

      // Drain in-flight writers that already passed the gate before we
      // took the lock. Without this, an in-progress leaderboard mutation
      // could complete its rename mid-build and produce an archive
      // whose hashed bytes don't match its streamed bytes.
      try {
        await drainStoreWriteQueues();
      } catch (err) {
        logEvent(req, "backup.create.error", { phase: "drain", error: err?.message || String(err) });
        return res.status(500).json({
          error: `Could not drain in-flight writers before backup: ${err?.message || String(err)}`,
          code: "STORE_DRAIN_FAILED"
        });
      }

      // Pre-check uncompressed total size before piping. Without this, an
      // export of an over-cap data tree would stream past the operator's
      // configured limit; for the import path, busboy guards uploads.
      let manifest;
      try {
        manifest = await buildManifest({
          projectRoot,
          includeProviders,
          includeDictionaries
        });
      } catch (err) {
        logEvent(req, "backup.create.error", { error: err?.message || String(err) });
        return res.status(backupErrorStatus(err)).json(backupErrorBody(err));
      }
      const totalBytes = manifest.files.reduce((sum, entry) => sum + entry.bytes, 0);
      if (totalBytes > backupMaxBytes) {
        logEvent(req, "backup.create.too-large", { totalBytes, cap: backupMaxBytes });
        return res.status(413).json({
          error: `Archive uncompressed size ${totalBytes} bytes exceeds the cap of ${backupMaxBytes} bytes. ` +
            "Disable optional sets, raise BACKUP_MAX_BYTES, or split the export.",
          code: "ARCHIVE_TOO_LARGE",
          totalBytes,
          cap: backupMaxBytes
        });
      }

      const stamp = safeFilenameTimestamp();
      const nodeId = await readNodeIdSafe(projectRoot);
      const filename = `wordle-backup-${stamp}-${nodeId}.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Cache-Control", "no-store");

      let archive;
      try {
        // Reuse the manifest we just built for the size check so
        // createArchive doesn't re-walk and re-hash every file under
        // the lock.
        const result = createArchive({
          projectRoot,
          includeProviders,
          includeDictionaries,
          manifest
        });
        archive = result.archive;
      } catch (err) {
        logEvent(req, "backup.create.error", { error: err?.message || String(err) });
        return res.status(backupErrorStatus(err)).json(backupErrorBody(err));
      }

      // Release the lock when the archive finishes streaming or errors.
      const lockFn = releaseLock;
      releaseLock = () => {}; // prevent finally-block double-release
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        lockFn();
      };
      archive.on("error", (err) => {
        logEvent(req, "backup.create.error", { error: err?.message || String(err) });
        release();
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to build archive.", code: "ARCHIVE_BUILD_FAILED" });
        } else {
          res.destroy(err);
        }
      });
      archive.on("end", () => {
        logEvent(req, "backup.create.complete");
        release();
      });
      res.on("close", () => {
        // Client disconnected mid-stream; ensure we don't hold the lock.
        release();
      });

      archive.pipe(res);
    } finally {
      // If we exited the synchronous path without piping (early return),
      // releaseLock is still the original lock-clearer. Otherwise it's
      // a no-op and the archive event handlers own the release.
      releaseLock();
    }
  });

  // POST /api/admin/backup/preview
  // Not gated by the strict backup rate limiter: preview is idempotent
  // and read-only, and the normal UI flow is preview-then-apply within
  // a few seconds. The admin write rate limiter still applies.
  router.post("/api/admin/backup/preview", async (req, res) => {
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
    // Atomic check-and-set for single-flight: claims the restore slot
    // synchronously so two simultaneous requests can't both proceed.
    // restoreInProgressRef is separate from dataMutationLockRef — we
    // don't take the data-mutation lock yet because that would hold the
    // /api gate closed for the full upload duration (potentially many
    // seconds for large archives over slow connections). The data lock
    // is acquired later, right before the actual swap.
    if (
      providerImportQueueActiveRef?.value
      || providerImportSyncActiveRef?.value
      || providerImportEnqueueActiveRef?.value
      || dataMutationLockRef?.value
      || restoreInProgressRef?.value
      || (directDataWriteActiveRef && directDataWriteActiveRef.value > 0)
    ) {
      return res.status(409).json({
        error: "Another admin operation is in flight; retry shortly.",
        code: "RESTORE_BUSY"
      });
    }
    restoreInProgressRef.value = true;

    let upload;
    try {
      upload = await receiveUpload(req, {
        maxBytes: backupMaxBytes,
        tempDir: uploadsTempDir
      });
    } catch (err) {
      restoreInProgressRef.value = false;
      return res.status(backupErrorStatus(err)).json(backupErrorBody(err));
    }

    logEvent(req, "backup.restore.start", { bytes: upload.bytes, originalName: upload.originalName });

    // Warm every in-scope store before phase 3 starts. If a store
    // hasn't loaded yet (cold cache on a fresh process), a GET-side
    // read fired during the brief rename gap (livePath momentarily
    // absent between snapshot-rename and staged-rename) would
    // otherwise see ENOENT and persist default state on top of the
    // restore. Each load is idempotent. Failure is non-fatal — the
    // restore can still proceed; warm is just a defense.
    try {
      await warmInScopeStores();
    } catch (warmErr) {
      console.warn(
        `[admin] Pre-restore warm of in-scope stores failed: ${warmErr?.message || String(warmErr)}`
      );
    }

    // Recheck the provider-import refs after the upload window. Even
    // though restoreInProgressRef has been claimed since the busy
    // check, a provider import that started AFTER restoreInProgressRef
    // was set but BEFORE we updated the import-side guards (older
    // build) could be in flight. If any ref is now true, abort and
    // tell the operator to retry — we don't want to take the data
    // lock and race a running import.
    if (
      providerImportQueueActiveRef?.value
      || providerImportSyncActiveRef?.value
      || providerImportEnqueueActiveRef?.value
    ) {
      restoreInProgressRef.value = false;
      try {
        await fsp.rm(upload.tempPath, { force: true });
      } catch {
        // best effort
      }
      return res.status(409).json({
        error: "A provider import started while the restore archive was uploading; retry once the import completes.",
        code: "RESTORE_BUSY"
      });
    }

    // NOW take the data-mutation lock — upload is done, we're about to
    // start touching live data/. Other /api mutations are 503'd from
    // here until the apply + reload completes.
    dataMutationLockRef.value = true;

    try {
      // Drain in-flight writers that already passed the gate before we
      // took the lock. Without this, an in-progress mutation could
      // rename its stale JSON over the just-swapped restored file
      // after applyRestore returns success.
      await drainStoreWriteQueues();

      const result = await applyRestore({ archivePath: upload.tempPath, projectRoot });

      // Reload in-memory caches so consumers see the restored state.
      const reloadResults = [];
      for (const [name, action] of [
        ["leaderboardStore", () => leaderboardStore?.reload?.()],
        ["adminJobsStore", () => adminJobsStore?.reload?.()],
        ["classesStore", () => classesStore?.reload?.()],
        ["appConfigStore", () => appConfigStore?.reloadSync?.()],
        ["languageRegistryStore", () => languageRegistryStore?.reloadSync?.()],
        ["languageRuntimeCatalog", () => rebuildLanguageRuntimeCatalog?.()],
        ["wordDataCache", () => reloadWordData?.()]
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
      // True only when the failure happened after we'd started swapping
      // files into place; pre-apply validation failures (malformed zip,
      // schema drift, etc.) didn't mutate anything, so the flag stays
      // false to avoid misleading operators.
      body.rolledBackOnError = err?.rolledBackChanges === true;
      if (Array.isArray(err?.warnings) && err.warnings.length > 0) {
        body.warnings = err.warnings;
      }
      return res.status(status).json(body);
    } finally {
      dataMutationLockRef.value = false;
      restoreInProgressRef.value = false;
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

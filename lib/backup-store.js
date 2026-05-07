const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");

const archiver = require("archiver");
const yauzl = require("yauzl");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const MANIFEST_VERSION = 1;
const MANIFEST_ENTRY_PATH = "manifest.json";

const IN_SCOPE_FILES = Object.freeze([
  "data/leaderboard.json",
  "data/languages.json",
  "data/admin-jobs.json",
  "data/app-config.json",
  "data/classes.json",
  "data/word.json"
]);

const IN_SCOPE_SCHEMAS = Object.freeze({
  "data/leaderboard.json": "data/leaderboard.schema.json",
  "data/languages.json": "data/languages.schema.json",
  "data/admin-jobs.json": "data/admin-jobs.schema.json",
  "data/app-config.json": "data/app-config.schema.json",
  "data/classes.json": "data/classes.schema.json"
});

const DIAGNOSTIC_SCHEMAS = Object.freeze([
  "data/leaderboard.schema.json",
  "data/languages.schema.json",
  "data/admin-jobs.schema.json",
  "data/app-config.schema.json",
  "data/classes.schema.json",
  "data/backup-manifest.schema.json",
  "data/providers/provider-import-manifest.schema.json"
]);

const DEFAULT_TOTAL_UNCOMPRESSED_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_PER_ENTRY_MAX_BYTES = 64 * 1024 * 1024;
const ARCHIVE_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;

class BackupError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "BackupError";
    this.code = code;
    if (details) this.details = details;
  }
}

function isPathSafe(entryPath) {
  if (typeof entryPath !== "string" || entryPath.length === 0) return false;
  if (!ARCHIVE_PATH_PATTERN.test(entryPath)) return false;
  if (entryPath.startsWith("/")) return false;
  if (entryPath.includes("\\")) return false;
  const normalized = path.posix.normalize(entryPath);
  if (normalized !== entryPath) return false;
  if (normalized.startsWith("..") || normalized.includes("/../")) return false;
  return true;
}

function sha256OfBuffer(buf) {
  return nodeCrypto.createHash("sha256").update(buf).digest("hex");
}

async function sha256OfFile(filePath) {
  const hash = nodeCrypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk);
      yield chunk;
    }
  }, new (require("node:stream").Writable)({
    write(_chunk, _enc, cb) { cb(); }
  }));
  return hash.digest("hex");
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function statBytes(filePath) {
  const st = await fsp.stat(filePath);
  return st.size;
}

async function readJsonFile(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function readAppVersion(projectRoot) {
  try {
    const pkg = await readJsonFile(path.join(projectRoot, "package.json"));
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

async function readNodeId(projectRoot) {
  try {
    const config = await readJsonFile(path.join(projectRoot, "data", "app-config.json"));
    if (config && typeof config.nodeId === "string" && config.nodeId.length > 0) {
      return config.nodeId;
    }
  } catch {
    // fall through
  }
  return "unknown-node";
}

function compileManifestValidator(projectRoot) {
  const schemaPath = path.join(projectRoot, "data", "backup-manifest.schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

async function listFilesUnder(rootDir, baseRel) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries) {
    const abs = path.join(rootDir, entry.name);
    const rel = path.posix.join(baseRel, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFilesUnder(abs, rel);
      out.push(...nested);
    } else if (entry.isFile()) {
      out.push({ absPath: abs, archivePath: rel });
    }
    // Symlinks intentionally skipped — backups must not follow.
  }
  out.sort((a, b) => a.archivePath.localeCompare(b.archivePath));
  return out;
}

async function buildManifest({
  projectRoot,
  includeProviders,
  includeDictionaries,
  now = () => new Date()
}) {
  const dataRoot = path.join(projectRoot, "data");
  const files = [];
  const optionalSets = [];

  for (const archivePath of IN_SCOPE_FILES) {
    const absPath = path.join(projectRoot, archivePath);
    if (!(await fileExists(absPath))) continue;
    const sha256 = await sha256OfFile(absPath);
    const bytes = await statBytes(absPath);
    const entry = { path: archivePath, bytes, sha256 };
    const schemaRel = IN_SCOPE_SCHEMAS[archivePath];
    if (schemaRel) {
      const schemaAbs = path.join(projectRoot, schemaRel);
      if (await fileExists(schemaAbs)) {
        entry.schema = {
          schemaPath: schemaRel,
          sha256: await sha256OfFile(schemaAbs)
        };
      }
    }
    files.push(entry);
  }

  // Diagnostic schemas (read-only, never restored)
  for (const schemaRel of DIAGNOSTIC_SCHEMAS) {
    const absPath = path.join(projectRoot, schemaRel);
    if (!(await fileExists(absPath))) continue;
    files.push({
      path: schemaRel,
      bytes: await statBytes(absPath),
      sha256: await sha256OfFile(absPath)
    });
  }

  if (includeProviders) {
    optionalSets.push("providers");
    const providersRoot = path.join(dataRoot, "providers");
    const providerFiles = await listFilesUnder(providersRoot, "data/providers");
    for (const file of providerFiles) {
      files.push({
        path: file.archivePath,
        bytes: await statBytes(file.absPath),
        sha256: await sha256OfFile(file.absPath),
        optionalSet: "providers"
      });
    }
  }

  if (includeDictionaries) {
    optionalSets.push("dictionaries");
    const dictionariesRoot = path.join(dataRoot, "dictionaries");
    const dictFiles = await listFilesUnder(dictionariesRoot, "data/dictionaries");
    for (const file of dictFiles) {
      files.push({
        path: file.archivePath,
        bytes: await statBytes(file.absPath),
        sha256: await sha256OfFile(file.absPath),
        optionalSet: "dictionaries"
      });
    }
  }

  return {
    manifestVersion: MANIFEST_VERSION,
    appVersion: await readAppVersion(projectRoot),
    createdAt: now().toISOString(),
    nodeId: await readNodeId(projectRoot),
    files,
    optionalSets
  };
}

function createArchive({
  projectRoot,
  includeProviders = false,
  includeDictionaries = false,
  now = () => new Date()
}) {
  if (!projectRoot) {
    throw new BackupError("INVALID_REQUEST", "projectRoot is required.");
  }
  const archive = archiver("zip", {
    zlib: { level: 6 },
    forceLocalTime: false
  });

  archive.on("error", (err) => {
    archive.emit("end");
    archive.destroy(err);
  });

  const builder = (async () => {
    const manifest = await buildManifest({
      projectRoot,
      includeProviders,
      includeDictionaries,
      now
    });
    // Manifest first so streaming consumers can validate before extracting.
    archive.append(`${JSON.stringify(manifest, null, 2)}\n`, {
      name: MANIFEST_ENTRY_PATH,
      date: now()
    });
    for (const entry of manifest.files) {
      const absPath = path.join(projectRoot, entry.path);
      archive.file(absPath, { name: entry.path, date: now() });
    }
    await archive.finalize();
    return manifest;
  })();

  builder.catch((err) => {
    archive.destroy(err);
  });

  return { archive, manifestPromise: builder };
}

function openZip(archivePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) {
        // yauzl throws "end of central directory record signature not
        // found" / "invalid local file header signature" etc. for malformed
        // uploads. Surface them as a 400-mapped BackupError rather than a
        // raw error that the route would 500.
        return reject(new BackupError(
          "ARCHIVE_MALFORMED",
          `Archive could not be opened as a zip: ${err.message}`
        ));
      }
      resolve(zip);
    });
  });
}

function readEntryToBuffer(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, readStream) => {
      if (err) return reject(err);
      const chunks = [];
      readStream.on("data", (chunk) => chunks.push(chunk));
      readStream.on("end", () => resolve(Buffer.concat(chunks)));
      readStream.on("error", reject);
    });
  });
}

function readEntryToFile(zip, entry, destPath) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, readStream) => {
      if (err) return reject(err);
      const writeStream = fs.createWriteStream(destPath);
      readStream.pipe(writeStream);
      writeStream.on("finish", () => resolve());
      writeStream.on("error", reject);
      readStream.on("error", reject);
    });
  });
}

async function readManifest(zip) {
  return new Promise((resolve, reject) => {
    let manifestEntry = null;
    zip.on("entry", (entry) => {
      if (entry.fileName === MANIFEST_ENTRY_PATH && !manifestEntry) {
        manifestEntry = entry;
        readEntryToBuffer(zip, entry)
          .then((buf) => {
            try {
              resolve(JSON.parse(buf.toString("utf8")));
            } catch (err) {
              reject(new BackupError("MANIFEST_PARSE_FAILED", `manifest.json is not valid JSON: ${err.message}`));
            }
          })
          .catch(reject);
      } else {
        zip.readEntry();
      }
    });
    zip.on("end", () => {
      if (!manifestEntry) {
        reject(new BackupError("MANIFEST_MISSING", "Archive does not contain a manifest.json entry."));
      }
    });
    zip.on("error", reject);
    zip.readEntry();
  });
}

async function listArchiveEntries(zip) {
  return new Promise((resolve, reject) => {
    const entries = [];
    zip.on("entry", (entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.on("end", () => resolve(entries));
    zip.on("error", reject);
    zip.readEntry();
  });
}

async function validateArchive(archivePath, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const totalMaxBytes = Number.isInteger(options.totalMaxBytes) && options.totalMaxBytes > 0
    ? options.totalMaxBytes
    : DEFAULT_TOTAL_UNCOMPRESSED_MAX_BYTES;
  const perEntryMaxBytes = Number.isInteger(options.perEntryMaxBytes) && options.perEntryMaxBytes > 0
    ? options.perEntryMaxBytes
    : DEFAULT_PER_ENTRY_MAX_BYTES;

  const validateManifest = compileManifestValidator(projectRoot);

  let zipForManifest;
  let manifest;
  try {
    zipForManifest = await openZip(archivePath);
    manifest = await readManifest(zipForManifest);
  } finally {
    if (zipForManifest) zipForManifest.close();
  }

  if (!validateManifest(manifest)) {
    throw new BackupError("MANIFEST_INVALID", "manifest.json failed schema validation.", {
      errors: validateManifest.errors
    });
  }

  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    throw new BackupError(
      "MANIFEST_VERSION_UNSUPPORTED",
      `manifest version ${manifest.manifestVersion} is not supported by this server (expected ${MANIFEST_VERSION}).`,
      { expected: MANIFEST_VERSION, got: manifest.manifestVersion }
    );
  }

  // Re-open to walk entries (yauzl is single-pass).
  const zip = await openZip(archivePath);
  const fileChecks = [];
  let totalUncompressed = 0;
  const expectedByPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const seenPaths = new Set();

  try {
    const entries = await listArchiveEntries(zip);
    for (const entry of entries) {
      if (entry.fileName === MANIFEST_ENTRY_PATH) continue;
      const safePath = entry.fileName;
      if (!isPathSafe(safePath)) {
        throw new BackupError("PATH_UNSAFE", `Archive entry rejected for unsafe path: ${safePath}`);
      }
      const expected = expectedByPath.get(safePath);
      if (!expected) {
        throw new BackupError("MANIFEST_MISMATCH", `Archive contains entry not declared in manifest: ${safePath}`);
      }
      if (entry.uncompressedSize > perEntryMaxBytes) {
        throw new BackupError(
          "ENTRY_TOO_LARGE",
          `Archive entry ${safePath} exceeds the per-entry limit (${entry.uncompressedSize} > ${perEntryMaxBytes}).`
        );
      }
      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > totalMaxBytes) {
        throw new BackupError(
          "ARCHIVE_TOO_LARGE",
          `Archive uncompressed size exceeds the total limit (${totalUncompressed} > ${totalMaxBytes}).`
        );
      }
      const buf = await readEntryToBuffer(zip, entry);
      if (buf.length !== expected.bytes) {
        throw new BackupError(
          "BYTES_MISMATCH",
          `Archive entry ${safePath} bytes ${buf.length} differ from manifest ${expected.bytes}.`
        );
      }
      const sha256 = sha256OfBuffer(buf);
      if (sha256 !== expected.sha256) {
        throw new BackupError(
          "SHA256_MISMATCH",
          `Archive entry ${safePath} sha256 ${sha256} differs from manifest ${expected.sha256}.`
        );
      }
      seenPaths.add(safePath);
      fileChecks.push({ path: safePath, bytes: buf.length, sha256, ok: true });
    }
  } finally {
    zip.close();
  }

  for (const expected of manifest.files) {
    if (!seenPaths.has(expected.path)) {
      throw new BackupError(
        "ENTRY_MISSING",
        `Manifest declares ${expected.path} but the archive does not contain it.`
      );
    }
  }

  return { manifest, fileChecks };
}

async function makeStagingDir(dataRoot, kind) {
  const stamp = new Date().toISOString().replace(/[^0-9T-]/g, "");
  const random = nodeCrypto.randomBytes(4).toString("hex");
  const name = `.restore-${kind}-${stamp}-${random}`;
  const dir = path.join(dataRoot, name);
  await fsp.mkdir(dir, { recursive: false });
  return dir;
}

async function rmDirRecursive(dirPath) {
  try {
    await fsp.rm(dirPath, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

async function ensureParentDir(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function applyRestore({ archivePath, projectRoot, logger = console }, options = {}) {
  if (!projectRoot) {
    throw new BackupError("INVALID_REQUEST", "projectRoot is required.");
  }
  const dataRoot = path.join(projectRoot, "data");
  const warnings = [];

  const validation = await validateArchive(archivePath, {
    projectRoot,
    totalMaxBytes: options.totalMaxBytes,
    perEntryMaxBytes: options.perEntryMaxBytes
  });
  const { manifest } = validation;

  // Schema-drift guard: every manifest file with a `schema` block must have
  // its declared schema digest match the schema currently on disk.
  for (const entry of manifest.files) {
    if (!entry.schema) continue;
    const currentSchemaPath = path.join(projectRoot, entry.schema.schemaPath);
    if (!(await fileExists(currentSchemaPath))) {
      throw new BackupError(
        "SCHEMA_DRIFT",
        `Archive references schema ${entry.schema.schemaPath} which is missing on this server.`,
        { schemaPath: entry.schema.schemaPath }
      );
    }
    const currentDigest = await sha256OfFile(currentSchemaPath);
    if (currentDigest !== entry.schema.sha256) {
      throw new BackupError(
        "SCHEMA_DRIFT",
        `Archive's ${entry.path} was produced under a different ${entry.schema.schemaPath}. ` +
          `Run the offline migration tool before restoring.`,
        {
          schemaPath: entry.schema.schemaPath,
          archiveSha256: entry.schema.sha256,
          currentSha256: currentDigest
        }
      );
    }
  }

  const stagingDir = await makeStagingDir(dataRoot, "staging");
  const rollbackDir = await makeStagingDir(dataRoot, "rollback");
  const restoredFiles = [];
  const stagedFiles = [];
  let zip;
  let succeeded = false;

  try {
    // Phase 1: extract every restorable file (in-scope + optional sets) into staging
    zip = await openZip(archivePath);
    const entries = await listArchiveEntries(zip);
    const restorablePaths = new Set();
    for (const entry of manifest.files) {
      // Only restore in-scope files and explicitly-included optional sets.
      if (
        IN_SCOPE_FILES.includes(entry.path)
        || (entry.optionalSet && manifest.optionalSets.includes(entry.optionalSet))
      ) {
        restorablePaths.add(entry.path);
      }
    }
    for (const entry of entries) {
      if (!restorablePaths.has(entry.fileName)) continue;
      const stagedAbs = path.join(stagingDir, entry.fileName);
      await ensureParentDir(stagedAbs);
      await readEntryToFile(zip, entry, stagedAbs);
      stagedFiles.push({ archivePath: entry.fileName, stagedAbs });
    }

    // Phase 2: validate every staged in-scope file against its current schema
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    for (const staged of stagedFiles) {
      const schemaRel = IN_SCOPE_SCHEMAS[staged.archivePath];
      if (!schemaRel) continue;
      const schemaAbs = path.join(projectRoot, schemaRel);
      if (!(await fileExists(schemaAbs))) continue;
      const schemaJson = await readJsonFile(schemaAbs);
      const validate = ajv.compile(schemaJson);
      const data = await readJsonFile(staged.stagedAbs);
      if (!validate(data)) {
        throw new BackupError(
          "RESTORED_FILE_INVALID",
          `Staged ${staged.archivePath} fails validation against ${schemaRel}.`,
          { errors: validate.errors }
        );
      }
    }

    // Phase 3: snapshot existing files into the rollback dir, then swap
    // staged files into place. Each file is snapshot-then-swap individually
    // so rollback can rewind by reversing the renames.
    const swapped = []; // { archivePath, livePath, rolledPath, hadPrior }
    try {
      for (const staged of stagedFiles) {
        const livePath = path.join(projectRoot, staged.archivePath);
        const rolledPath = path.join(rollbackDir, staged.archivePath);
        await ensureParentDir(rolledPath);
        const hadPrior = await fileExists(livePath);
        if (hadPrior) {
          await fsp.rename(livePath, rolledPath);
        }
        await ensureParentDir(livePath);
        await fsp.rename(staged.stagedAbs, livePath);
        swapped.push({ archivePath: staged.archivePath, livePath, rolledPath, hadPrior });
        restoredFiles.push(staged.archivePath);
      }
    } catch (err) {
      // Rewind: for each successfully-swapped file, put the live file back
      // to where it came from (delete current → move rolled back into place
      // if there was a prior).
      for (let i = swapped.length - 1; i >= 0; i -= 1) {
        const op = swapped[i];
        try {
          await fsp.rm(op.livePath, { force: true });
          if (op.hadPrior) {
            await fsp.rename(op.rolledPath, op.livePath);
          }
        } catch (rewindErr) {
          warnings.push({
            code: "ROLLBACK_PARTIAL",
            message: `Could not fully rewind ${op.archivePath}: ${rewindErr.message}`
          });
        }
      }
      throw err;
    }

    succeeded = true;
  } finally {
    if (zip) zip.close();
    if (succeeded) {
      // Best-effort cleanup; both dirs should be safe to remove on success.
      await rmDirRecursive(stagingDir);
      await rmDirRecursive(rollbackDir);
    } else {
      // On failure leave both dirs in place so an operator can investigate.
      // The boot-time orphan-dir warning will surface them.
      logger?.warn?.(
        `[backup-store] Restore failed — staging dir at ${stagingDir} and rollback dir at ${rollbackDir} were left in place for inspection.`
      );
    }
  }

  return {
    restored: restoredFiles,
    rolledBack: !succeeded,
    warnings,
    manifest
  };
}

async function findOrphanedRestoreDirs(dataRoot) {
  let entries;
  try {
    entries = await fsp.readdir(dataRoot, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(".restore-staging-") && !entry.name.startsWith(".restore-rollback-")) {
      continue;
    }
    const abs = path.join(dataRoot, entry.name);
    let mtime = null;
    try {
      const st = await fsp.stat(abs);
      mtime = st.mtime;
    } catch {
      // ignore
    }
    out.push({ name: entry.name, path: abs, mtime });
  }
  return out;
}

module.exports = {
  BackupError,
  MANIFEST_VERSION,
  MANIFEST_ENTRY_PATH,
  IN_SCOPE_FILES,
  IN_SCOPE_SCHEMAS,
  DIAGNOSTIC_SCHEMAS,
  DEFAULT_TOTAL_UNCOMPRESSED_MAX_BYTES,
  DEFAULT_PER_ENTRY_MAX_BYTES,
  buildManifest,
  createArchive,
  validateArchive,
  applyRestore,
  findOrphanedRestoreDirs,
  isPathSafe,
  sha256OfBuffer,
  sha256OfFile
};

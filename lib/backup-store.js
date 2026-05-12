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
  "data/schedule.json",
  "data/webhooks.json",
  "data/webhook-deliveries.json",
  "data/push-subscriptions.json",
  "data/challenges.json",
  "data/challenge-results.json",
  "data/word.json"
]);

// Files added after the initial backup spec shipped. An archive produced
// before each feature landed would not declare these in its manifest;
// validateArchive must not fail MANIFEST_INCOMPLETE for them, and
// applyRestore intentionally leaves the live file untouched (each store's
// own auto-recover default kicks in if the file is missing entirely).
// When adding a new IN_SCOPE_FILES entry for a feature shipping AFTER
// this date, add it here too — failure to do so makes every prior backup
// non-restorable until the fleet catches up.
const BACKWARDS_COMPATIBLE_FILES = Object.freeze([
  "data/schedule.json",
  "data/webhooks.json",
  "data/webhook-deliveries.json",
  "data/push-subscriptions.json",
  "data/challenges.json",
  "data/challenge-results.json"
]);

const IN_SCOPE_SCHEMAS = Object.freeze({
  "data/leaderboard.json": "data/leaderboard.schema.json",
  "data/languages.json": "data/languages.schema.json",
  "data/admin-jobs.json": "data/admin-jobs.schema.json",
  "data/app-config.json": "data/app-config.schema.json",
  "data/classes.json": "data/classes.schema.json",
  "data/schedule.json": "data/schedule.schema.json",
  "data/webhooks.json": "data/webhooks.schema.json",
  "data/webhook-deliveries.json": "data/webhook-deliveries.schema.json",
  "data/push-subscriptions.json": "data/push-subscriptions.schema.json",
  "data/challenges.json": "data/challenges.schema.json",
  "data/challenge-results.json": "data/challenge-results.schema.json"
});

const DIAGNOSTIC_SCHEMAS = Object.freeze([
  "data/leaderboard.schema.json",
  "data/languages.schema.json",
  "data/admin-jobs.schema.json",
  "data/app-config.schema.json",
  "data/classes.schema.json",
  "data/schedule.schema.json",
  "data/webhooks.schema.json",
  "data/webhook-deliveries.schema.json",
  "data/push-subscriptions.schema.json",
  "data/challenges.schema.json",
  "data/challenge-results.schema.json",
  "data/backup-manifest.schema.json",
  "data/providers/provider-import-manifest.schema.json"
]);

// Optional-set names map to the path prefix their entries must live
// under. A crafted manifest claiming `optionalSet: "providers"` for a
// path like `server.js` is rejected — the prefix check enforces that
// optional-set entries can only restore into their declared subtree.
const OPTIONAL_SET_PREFIXES = Object.freeze({
  providers: "data/providers/",
  dictionaries: "data/dictionaries/"
});

const DEFAULT_TOTAL_UNCOMPRESSED_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_PER_ENTRY_MAX_BYTES = 64 * 1024 * 1024;
// Manifest is the metadata index; in practice a few KB even with hundreds
// of provider files. Capping it at 4 MiB before buffering defends against
// a zip-bomb that hides a huge manifest under a small compressed payload.
const MANIFEST_MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024;
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

// Like fileExists, but lstat-based so it returns true for dangling
// symlinks (where the target is gone but the symlink itself is still
// present on disk). Used by the optional-root prune so that stale
// symlink-backed artifacts get removed even when their target is
// already missing — fileExists() would follow the link, see ENOENT
// on the target, and return false, leaving the symlink stranded.
async function pathEntryExists(filePath) {
  try {
    await fsp.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

// Reject symlinks (and anything that isn't a regular file) before
// reading the file into the backup. listFilesUnder() already skips
// symlinks for optional roots, but the in-scope and diagnostic loops
// use fixed paths and would otherwise follow a symlink to pull bytes
// from outside projectRoot into the archive.
async function assertRegularFile(filePath, archivePath) {
  const st = await fsp.lstat(filePath);
  if (!st.isFile()) {
    throw new BackupError(
      "PATH_UNSAFE",
      `Backup entry must be a regular file (not a symlink/dir/special): ${archivePath}.`,
      { path: archivePath }
    );
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

// Recursively remove empty directories under rootDir, bottom-up.
// Used by applyRestore after pruning files from optional-root
// subtrees so empty <variant>/<commit>/ shells don't survive a
// replace-all restore. The root itself is preserved (we only delete
// its children if they're empty).
async function pruneEmptyDirectoriesUnder(rootDir) {
  let entries;
  try {
    entries = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(rootDir, entry.name);
    await pruneEmptyDirectoriesUnder(child);
    try {
      await fsp.rmdir(child);
    } catch (err) {
      // ENOTEMPTY = still has files (intentional); ENOENT = race; both fine.
      if (err && err.code !== "ENOTEMPTY" && err.code !== "ENOENT") {
        throw err;
      }
    }
  }
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

// Variant of listFilesUnder used by the optional-root prune. Includes
// symlinks (recorded as regular file entries) so they get queued for
// deletion alongside real files. Without this, a stale symlink-backed
// artifact under data/providers/<variant>/<commit>/ would survive a
// restore even though the archive didn't contain it — and provider
// discovery (which uses fs.existsSync) would still report the commit
// as importable. We DON'T descend into directory symlinks (those
// could escape projectRoot); we only treat symlink-as-file entries
// the same as regular files for pruning purposes.
async function listFilesForPruneUnder(rootDir, baseRel) {
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
    if (entry.isSymbolicLink()) {
      // Treat any symlink (regardless of target type) as a removable
      // artifact for prune purposes.
      out.push({ absPath: abs, archivePath: rel });
      continue;
    }
    if (entry.isDirectory()) {
      const nested = await listFilesForPruneUnder(abs, rel);
      out.push(...nested);
    } else if (entry.isFile()) {
      out.push({ absPath: abs, archivePath: rel });
    }
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
    if (!(await fileExists(absPath))) {
      // In-scope files are documented as "always included". On a fresh
      // node where the matching store hasn't loaded yet, the file may
      // not exist. The route is responsible for warming each store
      // before calling buildManifest, but we error here as a safety
      // net so a partial manifest never silently ships.
      throw new BackupError(
        "INSCOPE_FILE_MISSING",
        `Required in-scope file is missing: ${archivePath}. Ensure the matching store has loaded before requesting a backup.`,
        { path: archivePath }
      );
    }
    await assertRegularFile(absPath, archivePath);
    const sha256 = await sha256OfFile(absPath);
    const bytes = await statBytes(absPath);
    const entry = { path: archivePath, bytes, sha256 };
    const schemaRel = IN_SCOPE_SCHEMAS[archivePath];
    if (schemaRel) {
      const schemaAbs = path.join(projectRoot, schemaRel);
      if (await fileExists(schemaAbs)) {
        await assertRegularFile(schemaAbs, schemaRel);
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
    await assertRegularFile(absPath, schemaRel);
    files.push({
      path: schemaRel,
      bytes: await statBytes(absPath),
      sha256: await sha256OfFile(absPath)
    });
  }

  // Skip files that were already added above (in-scope or diagnostic
  // schemas) so the provider/dictionary walks don't produce duplicate
  // manifest entries — duplicates would conflict during restore staging.
  const alreadyIncluded = new Set(files.map((entry) => entry.path));

  if (includeProviders) {
    optionalSets.push("providers");
    const providersRoot = path.join(dataRoot, "providers");
    const providerFiles = await listFilesUnder(providersRoot, "data/providers");
    for (const file of providerFiles) {
      if (alreadyIncluded.has(file.archivePath)) continue;
      files.push({
        path: file.archivePath,
        bytes: await statBytes(file.absPath),
        sha256: await sha256OfFile(file.absPath),
        optionalSet: "providers"
      });
      alreadyIncluded.add(file.archivePath);
    }
  }

  if (includeDictionaries) {
    optionalSets.push("dictionaries");
    const dictionariesRoot = path.join(dataRoot, "dictionaries");
    const dictFiles = await listFilesUnder(dictionariesRoot, "data/dictionaries");
    for (const file of dictFiles) {
      if (alreadyIncluded.has(file.archivePath)) continue;
      files.push({
        path: file.archivePath,
        bytes: await statBytes(file.absPath),
        sha256: await sha256OfFile(file.absPath),
        optionalSet: "dictionaries"
      });
      alreadyIncluded.add(file.archivePath);
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
  now = () => new Date(),
  manifest: precomputedManifest = null
}) {
  if (!projectRoot) {
    throw new BackupError("INVALID_REQUEST", "projectRoot is required.");
  }
  const archive = archiver("zip", {
    zlib: { level: 6 },
    forceLocalTime: false
  });

  archive.on("error", (err) => {
    // Don't emit a synthetic "end" here — consumers (e.g. the route)
    // treat the real "end" event as success. Just destroy with the
    // error and let the consumer's "error" listener handle the failure.
    archive.destroy(err);
  });

  const builder = (async () => {
    // The route can pass in a manifest it already built (e.g. for the
    // pre-stream byte-cap check) so we don't re-walk + re-hash every
    // file. Without this, the export path doubles the FS IO + sha256
    // work and the data lock is held twice as long.
    const manifest = precomputedManifest || await buildManifest({
      projectRoot,
      includeProviders,
      includeDictionaries,
      now
    });
    // Manifest first so streaming consumers can validate before extracting.
    // Verify the serialized manifest fits the same cap readManifest will
    // enforce on preview/restore — without this, we could ship an
    // archive that this very server would later reject with
    // MANIFEST_TOO_LARGE on its own preview.
    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestBytes = Buffer.byteLength(manifestJson);
    if (manifestBytes > MANIFEST_MAX_UNCOMPRESSED_BYTES) {
      throw new BackupError(
        "MANIFEST_TOO_LARGE",
        `Generated manifest.json is ${manifestBytes} bytes, exceeding the ${MANIFEST_MAX_UNCOMPRESSED_BYTES}-byte cap.`
      );
    }
    archive.append(manifestJson, {
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
        // Cap before buffering. A malicious zip whose manifest claims a
        // 500 MB uncompressed size would otherwise fully expand into
        // memory before any later validation can return 413.
        if (entry.uncompressedSize > MANIFEST_MAX_UNCOMPRESSED_BYTES) {
          reject(new BackupError(
            "MANIFEST_TOO_LARGE",
            `manifest.json uncompressed size ${entry.uncompressedSize} exceeds the ${MANIFEST_MAX_UNCOMPRESSED_BYTES}-byte cap.`
          ));
          return;
        }
        readEntryToBuffer(zip, entry)
          .then((buf) => {
            if (buf.length > MANIFEST_MAX_UNCOMPRESSED_BYTES) {
              reject(new BackupError(
                "MANIFEST_TOO_LARGE",
                `manifest.json read ${buf.length} bytes, exceeding the ${MANIFEST_MAX_UNCOMPRESSED_BYTES}-byte cap.`
              ));
              return;
            }
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

  // Reject duplicate paths in the manifest itself before touching the
  // archive — two manifest entries pointing at the same path could
  // otherwise interfere with each other during staging.
  {
    const manifestPathCounts = new Map();
    for (const entry of manifest.files) {
      manifestPathCounts.set(entry.path, (manifestPathCounts.get(entry.path) || 0) + 1);
    }
    for (const [archivePath, count] of manifestPathCounts) {
      if (count > 1) {
        throw new BackupError(
          "MANIFEST_DUPLICATE_PATH",
          `Manifest contains ${count} entries for ${archivePath}; paths must be unique.`
        );
      }
    }
  }

  // Enforce optional-set prefix at validation time so a crafted manifest
  // can't bypass scope by tagging an arbitrary path as "providers" or
  // "dictionaries". Each optional-set entry must live under the
  // declared subtree, AND its set must be in manifest.optionalSets.
  // Without the membership check, preview would succeed but
  // applyRestore() silently skips entries whose set isn't declared
  // (restorablePaths only adds entries from declared sets), so preview
  // and apply would disagree on what gets restored.
  const declaredOptionalSets = new Set(
    Array.isArray(manifest.optionalSets) ? manifest.optionalSets : []
  );
  for (const entry of manifest.files) {
    if (!entry.optionalSet) continue;
    if (!declaredOptionalSets.has(entry.optionalSet)) {
      throw new BackupError(
        "MANIFEST_OPTIONAL_SET_UNDECLARED",
        `Manifest entry ${entry.path} references optionalSet=${entry.optionalSet}, but that set is not declared in manifest.optionalSets.`
      );
    }
    const requiredPrefix = OPTIONAL_SET_PREFIXES[entry.optionalSet];
    if (!requiredPrefix || !entry.path.startsWith(requiredPrefix)) {
      throw new BackupError(
        "OPTIONAL_SET_PATH_INVALID",
        `Manifest entry ${entry.path} is tagged optionalSet=${entry.optionalSet} but is not under ${requiredPrefix || "an allowed prefix"}.`
      );
    }
  }

  // Reject manifests that omit any required IN_SCOPE_FILES entry. The
  // runbook documents these as "always included / replace-all", and
  // applyRestore relies on each one being staged before phase 3. A crafted
  // (or accidentally-trimmed) archive that drops, say, data/app-config.json
  // would otherwise produce a partial restore that violates the
  // documented semantics — the dropped file would silently retain its
  // pre-restore contents. Runs AFTER the optional-set checks so a
  // crafted manifest that's both incomplete AND has bad optional-set
  // paths still surfaces the security-relevant error first.
  //
  // BACKWARDS_COMPATIBLE_FILES are excepted: archives produced before the
  // corresponding feature landed cannot declare those entries, and the
  // runbook explicitly allows restoring those older archives — the
  // post-restore reload of each store handles a missing file by writing
  // its own default (which is the same behavior as a clean install).
  {
    const declaredPaths = new Set(manifest.files.map((entry) => entry.path));
    const backwardsCompatible = new Set(BACKWARDS_COMPATIBLE_FILES);
    const missing = IN_SCOPE_FILES.filter(
      (p) => !declaredPaths.has(p) && !backwardsCompatible.has(p)
    );
    if (missing.length > 0) {
      throw new BackupError(
        "MANIFEST_INCOMPLETE",
        `Manifest is missing required in-scope files: ${missing.join(", ")}.`,
        { missing }
      );
    }
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
      // Some zip writers include explicit directory entries (trailing
      // slash, zero bytes). Skip them — there's nothing to validate or
      // restore, and complaining about MANIFEST_MISMATCH for them is
      // noise.
      if (entry.fileName.endsWith("/")) continue;
      const safePath = entry.fileName;
      if (!isPathSafe(safePath)) {
        throw new BackupError("PATH_UNSAFE", `Archive entry rejected for unsafe path: ${safePath}`);
      }
      if (seenPaths.has(safePath)) {
        throw new BackupError(
          "ARCHIVE_DUPLICATE_PATH",
          `Archive contains multiple entries for ${safePath}; paths must be unique.`
        );
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
  // Reject unsafe schemaPaths BEFORE joining + reading. Without this,
  // a malicious manifest could set schemaPath to '../../../../dev/zero'
  // and trick sha256OfFile into hashing a special file outside
  // projectRoot — hanging the restore while it holds the data lock.
  for (const entry of manifest.files) {
    if (!entry.schema) continue;
    if (!isPathSafe(entry.schema.schemaPath)) {
      throw new BackupError(
        "PATH_UNSAFE",
        `Archive schema reference rejected for unsafe path: ${entry.schema.schemaPath}`,
        { schemaPath: entry.schema.schemaPath }
      );
    }
    const currentSchemaPath = path.join(projectRoot, entry.schema.schemaPath);
    if (!(await fileExists(currentSchemaPath))) {
      throw new BackupError(
        "SCHEMA_DRIFT",
        `Archive references schema ${entry.schema.schemaPath} which is missing on this server.`,
        { schemaPath: entry.schema.schemaPath }
      );
    }
    // Belt-and-suspenders: even though schemaPath is sanitized and
    // fileExists confirmed something is there, an attacker (or
    // accidental misconfiguration) could symlink it to a special
    // file like /dev/zero. assertRegularFile lstats and rejects
    // anything that isn't a regular file, so sha256OfFile won't
    // hang reading bytes from a device while we hold the data lock.
    await assertRegularFile(currentSchemaPath, entry.schema.schemaPath);
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
  const removedFiles = [];
  const stagedFiles = [];
  let zip;
  let succeeded = false;

  try {
    // Phase 1: extract every restorable file (in-scope + optional sets) into staging
    zip = await openZip(archivePath);
    const entries = await listArchiveEntries(zip);
    const restorablePaths = new Set();
    const diagnosticSchemaSet = new Set(DIAGNOSTIC_SCHEMAS);
    for (const entry of manifest.files) {
      // Only restore in-scope files and explicitly-included optional sets.
      if (IN_SCOPE_FILES.includes(entry.path)) {
        restorablePaths.add(entry.path);
        continue;
      }
      if (!entry.optionalSet || !manifest.optionalSets.includes(entry.optionalSet)) {
        continue;
      }
      // Defense in depth: validateArchive already enforces this prefix,
      // but check again here so a future code path that skips the
      // validator can't hand applyRestore an out-of-tree path.
      const requiredPrefix = OPTIONAL_SET_PREFIXES[entry.optionalSet];
      if (!requiredPrefix || !entry.path.startsWith(requiredPrefix)) continue;
      // Diagnostic schemas live under the optional prefixes (e.g.
      // data/providers/provider-import-manifest.schema.json under
      // data/providers/) but are bundled as read-only artifacts —
      // never restored. A crafted manifest tagging one with
      // optionalSet="providers" must not be allowed to swap the
      // live schema with archive contents and break future schema
      // checks.
      if (diagnosticSchemaSet.has(entry.path)) continue;
      restorablePaths.add(entry.path);
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
      // Same symlink/special-file defense as the drift loop above —
      // assertRegularFile rejects anything that isn't a regular file
      // before we read it, so a symlinked schema can't hang phase 2.
      await assertRegularFile(schemaAbs, schemaRel);
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
    // Phase 2 doesn't have a schema for data/word.json (it's a
    // simple shape, not in IN_SCOPE_SCHEMAS), so a malformed staged
    // word.json would silently restore and reloadWordData would
    // overwrite it with defaults — turning a bad archive into a
    // false success. Inline a minimal shape check before phase 3
    // so the restore fails fast on parse errors and obviously-wrong
    // structures. We accept missing optional fields (older fixtures
    // omit `lang`/`updatedAt`); we only reject non-objects, arrays,
    // and fields with the wrong primitive type.
    for (const staged of stagedFiles) {
      if (staged.archivePath !== "data/word.json") continue;
      let parsed;
      try {
        parsed = await readJsonFile(staged.stagedAbs);
      } catch (err) {
        throw new BackupError(
          "RESTORED_FILE_INVALID",
          `Staged data/word.json could not be parsed as JSON: ${err.message}`
        );
      }
      const isPlainObject = parsed && typeof parsed === "object" && !Array.isArray(parsed);
      const fieldOk = (val) => val === undefined || val === null || typeof val === "string";
      const isValidWordEntry =
        isPlainObject
        && fieldOk(parsed.word)
        && fieldOk(parsed.lang)
        && fieldOk(parsed.date)
        && fieldOk(parsed.updatedAt);
      if (!isValidWordEntry) {
        throw new BackupError(
          "RESTORED_FILE_INVALID",
          "Staged data/word.json must be an object whose word/lang/date/updatedAt fields, when present, are strings or null."
        );
      }
    }

    // Phase 2.5: replace-all semantics for INCLUDED optional roots. Walk
    // each included optional-set root on disk; any file that's NOT in the
    // archive (and therefore not in restorablePaths) gets queued for
    // deletion alongside the swap, so restoring an older provider-
    // inclusive backup actually replaces the live tree under
    // data/providers/** instead of leaving newer commits intact.
    // Deletions go through the same snapshot-then-rewind logic as swaps.
    // diagnosticSchemaSet is declared earlier (in the restorable-paths
    // loop) so the same exclusion applies to both restore staging and
    // optional-root prune. Diagnostic schemas live under an optional-set
    // prefix but are bundled in the archive as read-only metadata; they
    // never get restored and must survive a provider-inclusive restore.
    const removalQueue = [];
    for (const optionalSet of manifest.optionalSets) {
      const prefix = OPTIONAL_SET_PREFIXES[optionalSet];
      if (!prefix) continue;
      const rootAbs = path.join(projectRoot, prefix);
      // Use the prune-specific walk that includes symlinks. Stale
      // symlink-backed artifacts under <variant>/<commit>/ would
      // otherwise survive the restore (the backup-side
      // listFilesUnder skips symlinks intentionally so we never
      // archive their targets, but the prune side needs to see them
      // so they don't outlive the restore).
      const liveFiles = await listFilesForPruneUnder(rootAbs, prefix.replace(/\/$/, ""));
      for (const file of liveFiles) {
        if (restorablePaths.has(file.archivePath)) continue;
        if (diagnosticSchemaSet.has(file.archivePath)) continue;
        removalQueue.push({ archivePath: file.archivePath });
      }
    }
    // Replace-all semantics for BACKWARDS_COMPATIBLE_FILES: when an old
    // archive omits one of these files (e.g. a pre-scheduler backup
    // doesn't declare data/schedule.json), the live file on a newer
    // node would otherwise survive the restore — producing a mix of
    // archived and current state that breaks the "true restore"
    // contract. Queue the live file for removal so the post-restore
    // reload of each store hits the missing-file path and writes its
    // own auto-recover default (the same state a clean install of
    // that feature would produce). Files declared in the manifest are
    // already in restorablePaths and won't be queued for removal.
    {
      const declaredPaths = new Set(manifest.files.map((entry) => entry.path));
      for (const compatPath of BACKWARDS_COMPATIBLE_FILES) {
        if (declaredPaths.has(compatPath)) continue;
        const liveAbs = path.join(projectRoot, compatPath);
        // Skip if no live file: nothing to remove. This is the
        // fresh-install path — no replace-all action needed because
        // there's nothing to replace.
        if (!(await fileExists(liveAbs))) continue;
        removalQueue.push({ archivePath: compatPath });
      }
    }

    // Phase 3: snapshot existing files into the rollback dir, then swap
    // staged files into place. Each file is snapshot-then-swap individually
    // so rollback can rewind by reversing the renames. removalQueue items
    // share the same shape but skip the staged-into-live rename.
    //
    // We record the rewindable operation BEFORE the staged-into-live
    // rename. If that rename throws (transient FS error etc.), the live
    // file is missing but the original is in the rollback dir — the
    // rewind logic still works because the entry is in `swapped` with
    // `hadPrior` set correctly.
    const swapped = [];
    try {
      for (const staged of stagedFiles) {
        const livePath = path.join(projectRoot, staged.archivePath);
        const rolledPath = path.join(rollbackDir, staged.archivePath);
        await ensureParentDir(rolledPath);
        const hadPrior = await fileExists(livePath);
        if (hadPrior) {
          await fsp.rename(livePath, rolledPath);
        }
        // Record the rewindable state immediately. Even if the next
        // rename throws, the rewind loop will see this entry and
        // restore from rollback if `hadPrior`.
        const op = {
          archivePath: staged.archivePath,
          livePath,
          rolledPath,
          hadPrior
        };
        swapped.push(op);
        await ensureParentDir(livePath);
        await fsp.rename(staged.stagedAbs, livePath);
        restoredFiles.push(staged.archivePath);
      }
      // Apply removals from optional roots (replace-all semantics).
      for (const removal of removalQueue) {
        const livePath = path.join(projectRoot, removal.archivePath);
        const rolledPath = path.join(rollbackDir, removal.archivePath);
        // Use the lstat-based check so dangling symlinks are treated
        // as present and renamed into the rollback dir. fileExists()
        // follows the link and would skip them, leaving the symlink
        // on disk after restore — listProviderCommitDirectories()
        // would then continue reporting the stale commit.
        if (!(await pathEntryExists(livePath))) continue;
        await ensureParentDir(rolledPath);
        await fsp.rename(livePath, rolledPath);
        swapped.push({
          archivePath: removal.archivePath,
          livePath,
          rolledPath,
          hadPrior: true
        });
        removedFiles.push(removal.archivePath);
      }
      // Prune empty directories left behind under each included
      // optional root. listProviderCommitDirectories() etc. scan
      // directories and would otherwise report empty commit dirs as
      // incomplete artifacts after restoring an older backup.
      // Rollback semantics: the rewind loop calls ensureParentDir
      // before each rename, so removing empty dirs here is
      // rollback-safe even if a later step throws.
      for (const optionalSet of manifest.optionalSets) {
        const prefix = OPTIONAL_SET_PREFIXES[optionalSet];
        if (!prefix) continue;
        const rootAbs = path.join(projectRoot, prefix);
        await pruneEmptyDirectoriesUnder(rootAbs);
      }
    } catch (err) {
      // Rewind: for each entry recorded, delete the (possibly partial)
      // live file and, if there was a prior copy, move it back from the
      // rollback dir. ensureParentDir runs before the rename because an
      // earlier optional-root prune (or a partial prune that errored
      // mid-way) may have removed the parent directory, which would
      // otherwise leave the prior copy stranded in the rollback dir.
      for (let i = swapped.length - 1; i >= 0; i -= 1) {
        const op = swapped[i];
        try {
          await fsp.rm(op.livePath, { force: true });
          if (op.hadPrior) {
            await ensureParentDir(op.livePath);
            await fsp.rename(op.rolledPath, op.livePath);
          }
        } catch (rewindErr) {
          warnings.push({
            code: "ROLLBACK_PARTIAL",
            message: `Could not fully rewind ${op.archivePath}: ${rewindErr.message}`
          });
        }
      }
      // Tag the error so callers can distinguish "validation failed
      // before any on-disk mutation" from "we mutated, then rewound",
      // and surface any partial-rewind warnings so the UI can prompt
      // the operator for manual intervention.
      if (err && typeof err === "object") {
        err.rolledBackChanges = swapped.length > 0;
        if (warnings.length > 0) {
          err.warnings = warnings.slice();
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
    removed: removedFiles,
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

const DEFAULT_ORPHAN_AGE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// Auto-cleanup helper for orphan `.restore-staging-*` /
// `.restore-rollback-*` dirs left behind by a SIGKILL or crash during
// applyRestore (B5 / #124). Used by the server boot path.
//
// Why a threshold (default 24h, configurable):
// applyRestore briefly has its staging/rollback dirs on disk before
// returning and rm'ing them. If a cleanup ran synchronously during a
// real restore, it would race that legitimate work. The age threshold
// is a safety margin — a dir older than that is, by definition,
// orphaned, not in-flight. The threshold also gives operators a
// chance to inspect a freshly orphaned dir before it disappears: a
// crash an hour ago is still recoverable by a thoughtful operator;
// auto-delete inside the inspect window would erase that option.
//
// Errors are collected, not thrown — boot must not fail because one
// stale dir is undeletable (permission, mount weirdness, etc.). The
// caller logs the structured result.
//
// Returns:
//   {
//     cleaned: [{ name, path, ageMs }],
//     retained: [{ name, path, ageMs, reason }],
//     errors:  [{ name, path, message }]
//   }
async function cleanupOrphanedRestoreDirs(dataRoot, options = {}) {
  const ageThresholdMs = Number.isFinite(options.ageThresholdMs)
    ? Math.max(0, options.ageThresholdMs)
    : DEFAULT_ORPHAN_AGE_THRESHOLD_MS;
  const now = typeof options.now === "function" ? options.now() : Date.now();
  // Allow the caller to pass a pre-computed orphan list so the boot
  // path doesn't scan twice (Copilot on PR #153 caught the double-
  // scan). When omitted we still compute internally for the simple
  // call shape.
  const orphans = Array.isArray(options.orphans)
    ? options.orphans
    : await findOrphanedRestoreDirs(dataRoot);
  const cleaned = [];
  const retained = [];
  const errors = [];
  for (const orphan of orphans) {
    const mtimeMs = orphan.mtime ? orphan.mtime.getTime() : null;
    const ageMs = mtimeMs === null ? null : Math.max(0, now - mtimeMs);
    if (ageMs === null) {
      retained.push({
        name: orphan.name,
        path: orphan.path,
        ageMs: null,
        reason: "mtime unavailable; refusing to delete without an age signal"
      });
      continue;
    }
    if (ageMs < ageThresholdMs) {
      retained.push({
        name: orphan.name,
        path: orphan.path,
        ageMs,
        reason: `younger than ageThresholdMs=${ageThresholdMs} (possible in-flight restore)`
      });
      continue;
    }
    try {
      await fsp.rm(orphan.path, { recursive: true, force: true });
      cleaned.push({ name: orphan.name, path: orphan.path, ageMs });
    } catch (err) {
      errors.push({
        name: orphan.name,
        path: orphan.path,
        message: err && err.message ? err.message : String(err)
      });
    }
  }
  return { cleaned, retained, errors };
}

module.exports = {
  BackupError,
  MANIFEST_VERSION,
  MANIFEST_ENTRY_PATH,
  IN_SCOPE_FILES,
  IN_SCOPE_SCHEMAS,
  DIAGNOSTIC_SCHEMAS,
  BACKWARDS_COMPATIBLE_FILES,
  DEFAULT_TOTAL_UNCOMPRESSED_MAX_BYTES,
  DEFAULT_PER_ENTRY_MAX_BYTES,
  buildManifest,
  createArchive,
  validateArchive,
  applyRestore,
  findOrphanedRestoreDirs,
  cleanupOrphanedRestoreDirs,
  DEFAULT_ORPHAN_AGE_THRESHOLD_MS,
  isPathSafe,
  sha256OfBuffer,
  sha256OfFile
};

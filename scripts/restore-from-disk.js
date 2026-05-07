#!/usr/bin/env node

// CLI fallback for applying a backup archive when the admin UI is
// unreachable (e.g. post-corruption boot loop). Reads an archive from
// disk and writes the restored data/ tree atomically.
//
// Usage:
//   node scripts/restore-from-disk.js <archive.zip> [--project-root <dir>]
//
// The script does NOT take the in-process admin mutex — it's intended to
// run when the server is offline. Make sure the server is stopped before
// running, or operators may observe inconsistent reads from a half-swapped
// data/ during the restore window.

const path = require("node:path");
const { existsSync } = require("node:fs");
const { applyRestore } = require("../lib/backup-store.js");

function parseArgs(argv) {
  const args = { archivePath: null, projectRoot: path.resolve(__dirname, "..") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root" || arg === "-p") {
      const next = argv[i + 1];
      if (typeof next !== "string" || next.length === 0 || next.startsWith("-")) {
        throw new Error(`${arg} requires a path argument`);
      }
      args.projectRoot = path.resolve(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (!arg.startsWith("-") && !args.archivePath) {
      args.archivePath = path.resolve(arg);
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write([
    "Usage: node scripts/restore-from-disk.js <archive.zip> [--project-root <dir>]",
    "",
    "Restores a wordle-local node from a backup archive. The server should",
    "be stopped before running. The atomic-apply algorithm in",
    "lib/backup-store.js writes to <project-root>/data/ via a staging dir",
    "and rewinds from a rollback dir on any failure.",
    "",
    "Options:",
    "  --project-root, -p   Path to the wordle-local project root.",
    "                       Default: the script's parent directory.",
    "  --help, -h           Print this help and exit.",
    ""
  ].join("\n"));
}

(async () => {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n`);
    printHelp();
    process.exit(64);
    return;
  }

  if (args.help) {
    printHelp();
    process.exit(0);
    return;
  }
  if (!args.archivePath) {
    process.stderr.write("error: archive path is required\n\n");
    printHelp();
    process.exit(64);
    return;
  }
  if (!existsSync(args.archivePath)) {
    process.stderr.write(`error: archive not found at ${args.archivePath}\n`);
    process.exit(66);
    return;
  }
  if (!existsSync(path.join(args.projectRoot, "data"))) {
    process.stderr.write(`error: project root has no data/ directory: ${args.projectRoot}\n`);
    process.exit(66);
    return;
  }

  process.stdout.write(`[restore] applying ${args.archivePath} -> ${args.projectRoot}/data/\n`);
  try {
    const result = await applyRestore({
      archivePath: args.archivePath,
      projectRoot: args.projectRoot
    });
    process.stdout.write(
      `[restore] OK — ${result.restored.length} file(s) restored. ` +
      `Warnings: ${result.warnings.length}\n`
    );
    for (const file of result.restored) {
      process.stdout.write(`  ${file}\n`);
    }
    for (const warning of result.warnings) {
      process.stdout.write(`  warning: ${warning.code} ${warning.message}\n`);
    }
    process.exit(0);
  } catch (err) {
    const code = err && err.code ? err.code : "UNKNOWN";
    process.stderr.write(`[restore] FAILED — ${code}: ${err.message}\n`);
    if (err && err.details) {
      process.stderr.write(`  details: ${JSON.stringify(err.details)}\n`);
    }
    process.stderr.write(
      "[restore] data/ should be unchanged (rollback ran). Inspect any " +
      ".restore-staging-* and .restore-rollback-* directories under data/ " +
      "before deleting; see docs/backup-restore.md.\n"
    );
    process.exit(1);
  }
})();

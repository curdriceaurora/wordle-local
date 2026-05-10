#!/usr/bin/env node
"use strict";

// Mechanical detection of `writeJsonAtomic` / `writeJsonAtomicSync`
// call sites that bypass the backup/restore slot. These were the
// most common P1 source in the #98–#106 campaign — slot bypass in
// challenge-config-store bootstrap (PR #105 round 1), webhook
// emit/delivery race conditions, and so on. See `lib/locks.md` for
// the full lock graph.
//
// Heuristic: every `writeJsonAtomic(...)` call must be inside a
// function whose body either:
//
//   1. Itself calls `claimDirectDataWriteSlot(...)` (explicit slot
//      claim), OR
//   2. Has a name matching one of the allowlisted patterns:
//      - `#commit` / `commit` (per-store atomic commit; the store's
//        constructor injects the slot through dep injection and
//        either the inner `#commit` or a wrapping caller claims).
//      - `#loadInternal` / `loadSync` (per-store ENOENT bootstrap
//        path; documented as a known exemption in `lib/locks.md`).
//      - `replaceOverridesSync` / `saveSync` / `recoverOnBoot` /
//        `reload` / `reloadSync` (older sync bootstrap conventions).
//
// Files in `ALLOWLIST_FILES` are exempt entirely — typically because
// they own a different domain (e.g. provider artifacts under
// `data/providers/`) governed by their own coordination mechanism.
//
// Failures here block `npm run check`. Adding a new allowed
// function name to `SAFE_FUNCTION_NAMES` is fine when justified;
// adding a file to `ALLOWLIST_FILES` requires a comment explaining
// the alternative coordination path.

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");

// Names whose function body is exempt from needing an explicit
// slot claim. These are the documented patterns from `lib/locks.md`.
const SAFE_FUNCTION_NAMES = new Set([
  "#commit", "commit",
  "#loadInternal", "loadSync",
  "replaceOverridesSync", "saveSync",
  "recoverOnBoot", "reload", "reloadSync",
  "loadOrInitSync", "loadOrCreateSync",
]);

// Files whose `writeJsonAtomic` call sites are exempt entirely.
// Each entry MUST have a justification comment explaining the
// alternative coordination mechanism.
const ALLOWLIST_FILES = new Map([
  // Provider artifacts under data/providers/<variant>/<commit>/
  // are immutable per-commit and governed by the provider import
  // queue (providerImportQueueActiveRef / providerImportSyncActiveRef
  // observed by backup busy-checks). They don't need
  // claimDirectDataWriteSlot; the import queue refs serve the same
  // role at a coarser granularity.
  ["lib/provider-pool-policy.js", "provider artifacts; coordinated via providerImportQueueActiveRef"],
  ["lib/provider-answer-filter.js", "provider artifacts; coordinated via providerImportQueueActiveRef"],
  ["lib/provider-fetch.js", "provider artifacts; coordinated via providerImportQueueActiveRef"],
  ["lib/provider-hunspell.js", "provider artifacts; coordinated via providerImportQueueActiveRef"],
  ["lib/provider-artifact-shared.js", "shared writer helper; provider-internal, not /data state"],
]);

// Function names that ARE the writer helpers themselves (their
// bodies call fs.write* / similar, which is not a slot concern).
// Matching `writeJsonAtomic` / `writeJsonAtomicSync` as function
// names skips the false-positive flag on the helpers' own bodies.
const HELPER_DEFINITION_NAMES = new Set([
  "writeJsonAtomic", "writeJsonAtomicSync",
]);

// Recursively collect .js files in the given dirs (excluding tests
// and node_modules). The check applies to production code only.
function collectJsFiles() {
  const out = [];
  const includeRoots = ["lib", "routes"];
  for (const root of includeRoots) {
    walk(path.join(projectRoot, root), out);
  }
  // server.js at top level too.
  const top = path.join(projectRoot, "server.js");
  if (fs.existsSync(top)) out.push(top);
  return out;
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === "tests" || name.startsWith(".")) continue;
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) walk(abs, out);
    else if (stat.isFile() && abs.endsWith(".js")) out.push(abs);
  }
}

// Match function/method declarations. Captures the function name in
// group 1. Handles:
//   function foo() {
//   async function foo() {
//   foo() {
//   async foo() {
//   #foo() {
//   async #foo() {
const FN_DECL_PATTERN =
  /^[ \t]*(?:async\s+)?(?:function\s+)?(#?[a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*\{/;

// Match a `writeJsonAtomic(` or `writeJsonAtomicSync(` call (any
// receiver — we deliberately also catch destructured/aliased forms
// like `await write(...)` only when the function NAME is exact).
const WRITE_CALL_PATTERN = /\bwriteJsonAtomic(?:Sync)?\b\s*\(/;

// Match a slot claim within a function body.
const SLOT_CLAIM_PATTERN = /\bclaimDirectDataWriteSlot\s*\(/;

// For each file, segment into top-level functions/methods and check
// each segment that contains a writeJsonAtomic call. Naive nesting:
// we treat every `{` after a function declaration as opening a new
// scope and `}` as closing. Good enough for our codebase's style;
// false positives would only be triggered by deeply-nested helper
// closures inside a method, which we don't currently use.
function checkFile(filePath) {
  const errors = [];
  const rel = path.relative(projectRoot, filePath);

  if (ALLOWLIST_FILES.has(rel)) {
    return errors;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  // Build a stack of function names + their start/end line ranges.
  // This is a lightweight tokenizer — we only care about identifying
  // which named function each line belongs to.
  let depth = 0;
  const fnStack = []; // entries: { name, startLine, body: [] }
  const fnRanges = []; // { name, body: string }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Strip line comments and string literals to make brace counting
    // a little less wrong. NOT a real parser — close enough for our
    // codebase's style (no braces in template literals on the same
    // line as a fn decl, no string-embedded braces in fn bodies).
    const stripped = line
      .replace(/\/\/.*$/, "")
      .replace(/\/\*.*?\*\//g, "");

    const fnMatch = stripped.match(FN_DECL_PATTERN);
    if (fnMatch && depth === 0) {
      fnStack.push({ name: fnMatch[1], startLine: i + 1, body: [line] });
      depth = 1;
      continue;
    }

    if (fnStack.length > 0) {
      const top = fnStack[fnStack.length - 1];
      top.body.push(line);
    }

    for (const ch of stripped) {
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0 && fnStack.length > 0) {
          const fn = fnStack.pop();
          fn.endLine = i + 1;
          fnRanges.push(fn);
        }
      }
    }
  }

  // Now scan each detected function range. If its body has a
  // writeJsonAtomic call AND the function isn't safe-named AND
  // doesn't claim the slot, flag it.
  for (const fn of fnRanges) {
    const body = fn.body.join("\n");
    if (!WRITE_CALL_PATTERN.test(body)) continue;
    if (HELPER_DEFINITION_NAMES.has(fn.name)) continue;
    if (SAFE_FUNCTION_NAMES.has(fn.name)) continue;
    if (SLOT_CLAIM_PATTERN.test(body)) continue;
    // Find the line within the body where the call appears for a
    // useful error.
    let callLine = fn.startLine;
    for (let j = 0; j < fn.body.length; j += 1) {
      if (WRITE_CALL_PATTERN.test(fn.body[j])) {
        callLine = fn.startLine + j;
        break;
      }
    }
    errors.push(
      `${rel}:${callLine}: writeJsonAtomic in function ${fn.name}() not protected ` +
        `by claimDirectDataWriteSlot, and ${fn.name} not in SAFE_FUNCTION_NAMES.`
    );
  }

  // Also flag top-level (non-function) writeJsonAtomic calls. These
  // are unambiguously bypasses.
  let depthSimple = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = lines[i].replace(/\/\/.*$/, "");
    if (FN_DECL_PATTERN.test(stripped)) {
      depthSimple += 1;
    }
    for (const ch of stripped) {
      if (ch === "{") depthSimple += 1;
      else if (ch === "}") depthSimple = Math.max(0, depthSimple - 1);
    }
    if (depthSimple === 0 && WRITE_CALL_PATTERN.test(stripped)) {
      errors.push(`${rel}:${i + 1}: top-level writeJsonAtomic call (no enclosing function).`);
    }
  }

  return errors;
}

function main() {
  const files = collectJsFiles();
  let allErrors = [];
  for (const f of files) {
    allErrors = allErrors.concat(checkFile(f));
  }

  if (allErrors.length > 0) {
    console.error("[locks:check] FAIL — writeJsonAtomic call sites bypass the slot:\n");
    for (const e of allErrors) console.error(`  ${e}`);
    console.error(`\n[locks:check] ${allErrors.length} error(s).`);
    console.error(
      "[locks:check] To fix: wrap the call in `await claimDirectDataWriteSlot()` or, " +
        "if it's a documented pattern, rename to one of: " +
        Array.from(SAFE_FUNCTION_NAMES).join(", ")
    );
    console.error("[locks:check] See lib/locks.md for the full lock graph.");
    process.exit(1);
  }

  console.log(
    `[locks:check] OK — ${files.length} file(s) scanned; no slot bypass detected.`
  );
}

main();

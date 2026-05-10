#!/usr/bin/env node
"use strict";

// Mechanical detection of `writeJsonAtomic` / `writeJsonAtomicSync`
// call sites that bypass the backup/restore slot. These were the
// most common P1 source in the #98–#106 campaign — slot bypass in
// challenge-config-store bootstrap (PR #105 round 1), webhook
// emit/delivery race conditions, and so on. See `lib/locks.md` for
// the full lock graph.
//
// Implementation: parses each .js file with `acorn` (the ESLint-
// bundled JS parser; no extra dep) and walks the AST. The earlier
// regex-based draft missed every method inside a `class { ... }`
// body because its function-detector keyed on top-level depth,
// which is a real correctness bug surfaced by reviewers on PR #108.
// AST-based scope tracking handles classes, nested closures, arrow
// methods, and other JS forms uniformly.
//
// Heuristic per call site:
//
//   1. Walk up the enclosing function/method chain.
//   2. If the closest named function is in `SAFE_FUNCTION_NAMES`,
//      the call is allowed (these names are documented patterns
//      from `lib/locks.md`).
//   3. If any enclosing function body itself calls
//      `claimDirectDataWriteSlot(...)`, the call is allowed
//      (slot is explicitly claimed in scope).
//   4. If the file is in `ALLOWLIST_FILES`, the call is allowed
//      (the file owns a different domain — provider artifacts,
//      etc. — with its own coordination mechanism).
//   5. Otherwise, flag.
//
// The script also flags top-level (module-scope) calls — those are
// unambiguous bypasses because module-scope code runs at require()
// time, before any slot can be claimed.

const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

const projectRoot = path.resolve(__dirname, "..");

// Names whose function body is exempt from needing an explicit
// slot claim. These are the documented patterns from `lib/locks.md`.
//
// The list covers two pattern families:
//   * Modern stores: `#commit` / `#loadInternal` (challenge-config,
//     challenge-results, push-subscription, webhook, webhook-delivery).
//   * Legacy / sync stores: `commit`, `load`, `loadSync`, `#persist`,
//     `replaceOverridesSync`, `recoverOnBoot`, `reload[Sync]`,
//     `loadOrInitSync` / `loadOrCreateSync`, `updateSync`,
//     `#recoverWithDefaults`, `ensureKeysSync`. These predate the
//     slot-in-`#commit` standardization; the slot is claimed by
//     callers (or the path runs at boot before any concurrency).
const SAFE_FUNCTION_NAMES = new Set([
  // Modern stores
  "#commit", "commit",
  "#loadInternal", "loadSync", "load",
  // Older write-queue stores' commit equivalent
  "#persist",
  // Per-store sync entry points and recovery paths
  "replaceOverridesSync", "saveSync", "updateSync",
  "recoverOnBoot", "reload", "reloadSync",
  "loadOrInitSync", "loadOrCreateSync",
  "#recoverWithDefaults",
  // Boot-time keypair init (vapid-store)
  "ensureKeysSync",
]);

// Files whose `writeJsonAtomic` call sites are exempt entirely.
// Each entry MUST have a justification comment explaining the
// alternative coordination mechanism. Keys are repo-relative paths
// using POSIX separators — we normalize Windows separators in `rel`
// before lookup so cross-platform contributors aren't surprised.
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
const HELPER_DEFINITION_NAMES = new Set([
  "writeJsonAtomic", "writeJsonAtomicSync",
]);

const TARGET_CALL_NAMES = new Set([
  "writeJsonAtomic", "writeJsonAtomicSync",
]);

const SLOT_CLAIM_NAME = "claimDirectDataWriteSlot";

// ---------- File discovery ----------

function collectJsFiles() {
  const out = [];
  const includeRoots = ["lib", "routes"];
  for (const root of includeRoots) {
    walk(path.join(projectRoot, root), out);
  }
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

// ---------- AST helpers ----------

// Parse a file with acorn. We allow the latest spec so private
// class fields (`#commit`) etc. are supported.
function parseFile(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  return acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    locations: true,
    allowAwaitOutsideFunction: false,
    allowReturnOutsideFunction: false,
  });
}

// Get a printable name for a function-like node. Handles regular
// declarations, named expressions, methods (including private and
// computed), and falls back to `<anonymous>` for arrow functions
// without a binding context.
function nameOf(node, methodKey) {
  if (methodKey) return methodKey;
  if (node.id && node.id.name) return node.id.name;
  return "<anonymous>";
}

// Decode a MethodDefinition / PropertyDefinition `key` to a string.
// Private identifiers come back with a leading `#`.
function methodKeyName(keyNode) {
  if (!keyNode) return null;
  if (keyNode.type === "Identifier") return keyNode.name;
  if (keyNode.type === "PrivateIdentifier") return "#" + keyNode.name;
  if (keyNode.type === "Literal") return String(keyNode.value);
  return null;
}

// Recursive AST visitor. Tracks a stack of enclosing function-like
// nodes (with their resolved names) and a parallel stack of body
// strings (for the "any enclosing fn body claims the slot" check).
function visit(node, ctx) {
  if (!node || typeof node !== "object" || !node.type) return;

  // Open a function-like scope. We push BEFORE recursing into
  // children so calls inside the body see the enclosing chain.
  let pushed = false;
  let methodName = null;

  if (node.type === "MethodDefinition" || node.type === "PropertyDefinition") {
    methodName = methodKeyName(node.key);
  }

  if (
    node.type === "FunctionDeclaration"
    || node.type === "FunctionExpression"
    || node.type === "ArrowFunctionExpression"
  ) {
    const resolvedName = nameOf(node, ctx._pendingMethodName);
    ctx.fnStack.push({ name: resolvedName, node });
    pushed = true;
  }

  // For MethodDefinition we'll resolve the name when visiting the
  // .value (a FunctionExpression). Stash it on ctx so the
  // FunctionExpression branch can pick it up.
  if (node.type === "MethodDefinition") {
    ctx._pendingMethodName = methodName;
  }

  // Detect the call site of interest.
  if (node.type === "CallExpression" && node.callee) {
    let calleeName = null;
    if (node.callee.type === "Identifier") calleeName = node.callee.name;
    if (node.callee.type === "MemberExpression" && node.callee.property) {
      if (node.callee.property.type === "Identifier") {
        calleeName = node.callee.property.name;
      } else if (node.callee.property.type === "PrivateIdentifier") {
        calleeName = "#" + node.callee.property.name;
      }
    }
    if (calleeName && TARGET_CALL_NAMES.has(calleeName)) {
      ctx.calls.push({
        name: calleeName,
        line: node.loc ? node.loc.start.line : 0,
        fnStack: ctx.fnStack.slice(),
      });
    }
    if (calleeName === SLOT_CLAIM_NAME) {
      // Mark only the INNERMOST enclosing function as having an
      // explicit claim. Marking ancestors would incorrectly accept
      // an unrelated `writeJsonAtomic(...)` in an outer function
      // when the only `claimDirectDataWriteSlot()` was in a nested
      // helper:
      //
      //   function outer() {
      //     async function helper() {
      //       await claimDirectDataWriteSlot();  // marks helper only
      //     }
      //     writeJsonAtomic(...);                // ← still flagged
      //   }
      //
      // The reverse direction (claim in outer, write in nested
      // helper) is still accepted because the writeJsonAtomic
      // check inspects the entire enclosing chain via
      // `call.fnStack.some((f) => f.hasSlotClaim)`.
      if (ctx.fnStack.length > 0) {
        ctx.fnStack[ctx.fnStack.length - 1].hasSlotClaim = true;
      }
    }
  }

  // Recurse.
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "type") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) visit(c, ctx);
    } else if (child && typeof child === "object" && child.type) {
      visit(child, ctx);
    }
  }

  if (node.type === "MethodDefinition") {
    ctx._pendingMethodName = null;
  }
  if (pushed) {
    ctx.fnStack.pop();
  }
}

// ---------- Per-file check ----------

function checkFile(filePath) {
  const errors = [];
  const relRaw = path.relative(projectRoot, filePath);
  const rel = relRaw.split(path.sep).join("/"); // normalize for allowlist lookup

  if (ALLOWLIST_FILES.has(rel)) return errors;

  let ast;
  try {
    ast = parseFile(filePath);
  } catch (err) {
    errors.push(`${rel}: parse error — ${err.message}`);
    return errors;
  }

  const ctx = { fnStack: [], calls: [], _pendingMethodName: null };
  visit(ast, ctx);

  for (const call of ctx.calls) {
    // Top-level call (no enclosing function) — unambiguous bypass.
    if (call.fnStack.length === 0) {
      errors.push(`${rel}:${call.line}: top-level ${call.name} call (no enclosing function).`);
      continue;
    }
    const innermost = call.fnStack[call.fnStack.length - 1];

    // Skip the helper-definition false positive: `writeJsonAtomic`
    // helpers in store files include calls like
    // `await fs.rename(...)` after their own body which we don't
    // mind — but more importantly we don't want to flag calls to
    // writeJsonAtomic from INSIDE the helper named writeJsonAtomic
    // itself (recursive — doesn't happen, but defensive).
    if (HELPER_DEFINITION_NAMES.has(innermost.name)) continue;

    // Safe-named enclosing function: any of the documented patterns.
    if (call.fnStack.some((f) => SAFE_FUNCTION_NAMES.has(f.name))) continue;

    // Slot explicitly claimed somewhere in the enclosing chain.
    if (call.fnStack.some((f) => f.hasSlotClaim)) continue;

    errors.push(
      `${rel}:${call.line}: ${call.name} in function ${innermost.name}() not protected by ` +
        `${SLOT_CLAIM_NAME} and ${innermost.name} not in SAFE_FUNCTION_NAMES.`
    );
  }

  return errors;
}

// ---------- Driver ----------

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
        "if it's a documented pattern, name it as one of: " +
        Array.from(SAFE_FUNCTION_NAMES).join(", ")
    );
    console.error("[locks:check] See lib/locks.md for the full lock graph.");
    process.exit(1);
  }

  console.log(
    `[locks:check] OK — ${files.length} file(s) parsed; no slot bypass detected.`
  );
}

main();

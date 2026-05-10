#!/usr/bin/env node
"use strict";

// Mechanical detection of `writeJsonAtomic` / `writeJsonAtomicSync`
// call sites that bypass the backup/restore slot. These were the
// most common P1 source in the #98–#106 campaign — slot bypass in
// challenge-config-store bootstrap (PR #105 round 1), webhook
// emit/delivery race conditions, and so on. See `lib/locks.md` for
// the full lock graph.
//
// Implementation: parses each .js file with `acorn` (an explicit
// devDependency — declared in package.json so the check doesn't
// silently break if eslint stops bringing it transitively) and
// walks the AST. The earlier regex-based draft missed every
// method inside a `class { ... }` body because its function-
// detector keyed on top-level depth, which was a real correctness
// bug surfaced by reviewers on PR #108. AST-based scope tracking
// handles classes, nested closures, arrow methods, and other JS
// forms uniformly.
//
// Heuristic per call site:
//
//   1. Walk up the enclosing function/method chain.
//   2. If any enclosing function name has a (file, name) entry in
//      `SAFE_PER_FILE`, the call is allowed (these are documented
//      store patterns from `lib/locks.md`; scoped per-file so a
//      generic name like `commit`/`load` only earns the exemption
//      inside the listed store files, not repo-wide).
//   3. If any enclosing function body itself calls
//      `await claimDirectDataWriteSlot(...)`, the call is allowed
//      (slot is explicitly held in scope).
//   4. If the file is in `ALLOWLIST_FILES`, the call is allowed
//      (the file owns a different domain — provider artifacts,
//      etc. — with its own coordination mechanism).
//   5. Otherwise, flag.
//
// The script also flags top-level (module-scope) calls — those are
// unambiguous bypasses because module-scope code runs at require()
// time, before any slot can be claimed.
//
// Known limitations (this is a heuristic guardrail, not a complete
// static analyzer):
//
//   * Slot-release tracking. The check accepts an awaited claim
//     anywhere earlier in the enclosing function but doesn't track
//     `release()` calls. A pattern like
//     `await claim(); release(); await writeJsonAtomic(...)`
//     passes even though the slot was dropped before the write.
//     Mitigation: SAFE_PER_FILE is the authoritative allowlist for
//     documented stores; new code outside that list still has to
//     follow `claim → write → release` in source order.
//
//   * Source-order vs execution-order. The visitor walks function
//     definitions in source order, not call/execution order. A
//     helper defined in the same scope and invoked AFTER a claim
//     can show as unprotected because it was visited first. The
//     existing store pattern (claim at top of `#commit`, writer
//     in a nested `run` arrow defined later) walks correctly
//     because source order matches execution order; refactors
//     that violate that may produce false positives or negatives.
//
// In short: SAFE_PER_FILE captures the truth for documented store
// patterns; the slot-claim heuristic catches casual bypasses in
// new code; sophisticated mis-uses still need code review.

const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

const projectRoot = path.resolve(__dirname, "..");

// Per-(file, function-name) allowlist of `writeJsonAtomic` callers.
// Generic names like `commit` / `load` are only exempt INSIDE the
// listed store files; a bypass with the same name in `routes/` or
// a new lib file is still flagged.
//
// Two tiers (treated identically by the runtime check, but split
// for documentation — see `lib/locks.md` "Slot-claim ownership"):
//
//   * INTERNAL — store's own `#commit` claims
//     `claimDirectDataWriteSlot()`. Safe regardless of who calls
//     the store's public mutators. The modern pattern from PR
//     #103 onward.
//
//   * CALLER — store does NOT claim internally. Callers MUST
//     wrap mutators in `withSlot(...)` (admin routes do this) or
//     run at boot before any concurrency (sync init paths). A
//     future caller that invokes a store mutator without wrapping
//     would still pass `locks:check` because of the per-file
//     exemption — codex named this risk on PR #108 round 10. The
//     mitigation is `lib/locks.md`'s "Slot-claim ownership"
//     subsection (audit each new caller) plus the SAFE_PER_FILE
//     entries below being explicit about which tier each store
//     belongs to. Long-term, the right fix is to migrate these
//     stores to the INTERNAL pattern; tracked separately.
const INTERNAL_CLAIM_STORES = new Map([
  ["lib/challenge-config-store.js", new Set(["#commit", "#loadInternal"])],
  ["lib/challenge-results-store.js", new Set(["#commit", "#loadInternal"])],
  ["lib/push-subscription-store.js", new Set(["#commit", "#loadInternal"])],
  ["lib/webhook-delivery-store.js", new Set(["#commit", "#loadInternal"])],
  ["lib/webhook-store.js", new Set(["#commit", "#loadInternal"])],
]);
const CALLER_CLAIM_STORES = new Map([
  // Schedule store: route layer (admin schedule routes) wraps
  // mutators in withSlot(); reconciler runs under the data lock.
  ["lib/schedule-store.js", new Set(["#commit", "#loadInternal"])],
  // Admin-jobs store: write paths run under the import-queue
  // active ref (observed by backup busy-check) or under withSlot
  // at the route layer.
  ["lib/admin-jobs-store.js", new Set(["#persist", "load"])],
  // App-config store: replaceOverridesSync runs under withSlot in
  // routes/admin.js; loadSync runs at boot before any concurrency.
  ["lib/app-config-store.js", new Set(["loadSync", "replaceOverridesSync"])],
  // Language-registry: updateSync runs under withSlot in
  // routes/admin.js; #recoverWithDefaults is the boot/recovery path.
  ["lib/language-registry.js", new Set(["#recoverWithDefaults", "updateSync"])],
  // Vapid-store: keypair init at boot before any concurrency.
  ["lib/vapid-store.js", new Set(["ensureKeysSync"])],
]);
const SAFE_PER_FILE = new Map([...INTERNAL_CLAIM_STORES, ...CALLER_CLAIM_STORES]);

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

// AST node types that gate execution conditionally between their
// position and an outer scope. A `claimDirectDataWriteSlot()`
// whose path back to the enclosing function passes through any
// of these isn't guaranteed to run; subsequent writes in the
// function body can't be assumed slot-protected.
//
// `TryStatement` is intentionally NOT in this set — the `try`
// block itself runs unconditionally (the only conditional flow
// is through `CatchClause`, which IS in the set). A common
// pattern is:
//
//   await claimDirectDataWriteSlot();
//   try {
//     await writeJsonAtomic(...);   // safe — try doesn't gate the claim
//   } finally {
//     release();
//   }
//
// Treating `try` as conditional would falsely flag this pattern
// (Copilot caught the issue on PR #108 round 9).
const CONDITIONAL_NODE_TYPES = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchStatement",
  "SwitchCase",
  "CatchClause",
  "ConditionalExpression", // ternary
  "LogicalExpression",      // &&, ||, ??
]);

// AST node types that introduce a new function scope (boundary
// for the dominance walk).
const FUNCTION_NODE_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

// Walk ctx.nodeStack from innermost (the call site) outward and
// determine whether the slot claim's path to its enclosing function
// is unconditional. Returns true ONLY if every ancestor between
// the call and the function body is non-conditional. Once a
// FunctionDeclaration/Expression/ArrowFunctionExpression is
// encountered, the walk stops at that scope boundary.
function isClaimUnconditional(nodeStack) {
  for (let i = nodeStack.length - 1; i >= 0; i -= 1) {
    const n = nodeStack[i];
    if (CONDITIONAL_NODE_TYPES.has(n.type)) return false;
    if (FUNCTION_NODE_TYPES.has(n.type)) return true;
  }
  return false;
}

// Recursive AST visitor. Tracks a stack of enclosing function-like
// nodes (with their resolved names) and a parallel stack of body
// strings (for the "any enclosing fn body claims the slot" check).
// `parentType` lets the CallExpression branch tell whether the
// call is wrapped in an AwaitExpression — needed because
// `claimDirectDataWriteSlot()` returns a Promise that must be
// awaited before the slot is actually held; an unawaited call
// returns immediately with a pending Promise and the next line
// runs as if the slot weren't claimed.
function visit(node, ctx, parentType) {
  if (!node || typeof node !== "object" || !node.type) return;
  ctx.nodeStack.push(node);

  // Open a function-like scope. We push BEFORE recursing into
  // children so calls inside the body see the enclosing chain.
  let pushed = false;

  // For class members (MethodDefinition for normal methods,
  // PropertyDefinition for class-field arrow methods like
  // `bar = () => {}`), stash the resolved key name on ctx so the
  // function-like child node (`.value`) can pick it up. Save and
  // restore the previous value so a method whose body contains
  // ANOTHER class definition doesn't leak the outer name into the
  // inner methods.
  let savedPendingMethodName;
  let restorePending = false;
  if (node.type === "MethodDefinition" || node.type === "PropertyDefinition") {
    savedPendingMethodName = ctx._pendingMethodName;
    ctx._pendingMethodName = methodKeyName(node.key);
    restorePending = true;
  }

  if (
    node.type === "FunctionDeclaration"
    || node.type === "FunctionExpression"
    || node.type === "ArrowFunctionExpression"
  ) {
    // Consume the pending method name (if set by an enclosing
    // MethodDefinition / PropertyDefinition). Clearing it here
    // makes nested anonymous functions inside the method body fall
    // back to "<anonymous>" instead of being incorrectly named the
    // outer method — which would otherwise let a nested closure
    // accidentally match a SAFE_PER_FILE allowlist entry.
    const inheritedName = ctx._pendingMethodName;
    ctx._pendingMethodName = null;
    const resolvedName = nameOf(node, inheritedName);
    ctx.fnStack.push({ name: resolvedName, node });
    pushed = true;
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
      // Snapshot each frame's name + hasSlotClaim AT THIS MOMENT,
      // not as a live reference. Without this deep snapshot, a
      // slot claim that appears AFTER the writer in source order
      // would retroactively mark this recorded call as safe — but
      // ordering matters: `writeJsonAtomic(...); await claim();`
      // is a real bypass even though the same function eventually
      // claims. Source-order visit guarantees claims seen so far
      // are encoded; claims seen later are not.
      ctx.calls.push({
        name: calleeName,
        line: node.loc ? node.loc.start.line : 0,
        fnStack: ctx.fnStack.map((f) => ({
          name: f.name,
          hasSlotClaim: f.hasSlotClaim === true,
        })),
      });
    }
    if (calleeName === SLOT_CLAIM_NAME) {
      // Only treat the claim as effective if it satisfies BOTH:
      //   * It's awaited. `claimDirectDataWriteSlot()` returns a
      //     Promise; the slot isn't actually held until the await
      //     resolves. An expression like
      //     `const release = claimDirectDataWriteSlot();` (no
      //     await) returns a pending Promise and the next line
      //     runs as if the slot weren't claimed.
      //   * It's UNCONDITIONAL within the enclosing function.
      //     A guarded claim like
      //     `if (needsSlot) await claimDirectDataWriteSlot();`
      //     only runs on paths where `needsSlot` is true; later
      //     writes in the same function aren't actually
      //     protected on the other branch. The unconditional
      //     check walks the AST node-stack from the claim site
      //     back to the enclosing function and rejects if any
      //     conditional construct (if/for/try/switch/?:/&&/||)
      //     sits between them.
      const isAwaited = parentType === "AwaitExpression";
      const isUnconditional = isClaimUnconditional(ctx.nodeStack);
      if (isAwaited && isUnconditional) {
        // Mark only the INNERMOST enclosing function as having an
        // explicit claim. Marking ancestors would incorrectly
        // accept an unrelated `writeJsonAtomic(...)` in an outer
        // function when the claim was in a nested helper. The
        // reverse direction (claim in outer, write in nested
        // helper) is still accepted because the writeJsonAtomic
        // check inspects the entire enclosing chain.
        if (ctx.fnStack.length > 0) {
          ctx.fnStack[ctx.fnStack.length - 1].hasSlotClaim = true;
        }
      }
    }
  }

  // Recurse, passing the current node's type as parentType so
  // children can detect whether they're wrapped in an
  // AwaitExpression / etc.
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "type") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) visit(c, ctx, node.type);
    } else if (child && typeof child === "object" && child.type) {
      visit(child, ctx, node.type);
    }
  }

  if (restorePending) {
    ctx._pendingMethodName = savedPendingMethodName;
  }
  if (pushed) {
    ctx.fnStack.pop();
  }
  ctx.nodeStack.pop();
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

  const ctx = { fnStack: [], nodeStack: [], calls: [], _pendingMethodName: null };
  visit(ast, ctx);

  const safeNamesForThisFile = SAFE_PER_FILE.get(rel) || new Set();

  for (const call of ctx.calls) {
    // Top-level call (no enclosing function) — unambiguous bypass.
    if (call.fnStack.length === 0) {
      errors.push(`${rel}:${call.line}: top-level ${call.name} call (no enclosing function).`);
      continue;
    }
    const innermost = call.fnStack[call.fnStack.length - 1];

    // Skip the helper-definition false positive: don't flag calls
    // to writeJsonAtomic from INSIDE the helper named writeJsonAtomic
    // itself (recursive — doesn't happen, but defensive).
    if (HELPER_DEFINITION_NAMES.has(innermost.name)) continue;

    // Per-file safe-named enclosing function. The exemption is
    // scoped to the file in `SAFE_PER_FILE`; a generic name like
    // `commit` or `load` does NOT earn the exemption in some other
    // file. This is the round-4 fix for codex's "scope safe writer
    // names to documented stores" concern.
    if (call.fnStack.some((f) => safeNamesForThisFile.has(f.name))) continue;

    // Slot explicitly claimed somewhere in the enclosing chain.
    if (call.fnStack.some((f) => f.hasSlotClaim)) continue;

    errors.push(
      `${rel}:${call.line}: ${call.name} in function ${innermost.name}() not protected by ` +
        `${SLOT_CLAIM_NAME} and not in ${rel}'s safe-names allowlist.`
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
      "[locks:check] To fix: wrap the call in `await claimDirectDataWriteSlot()`, OR " +
        "if it's a documented store pattern, add an explicit (file, function-name) entry " +
        "to SAFE_PER_FILE in scripts/check-lock-bypass.js with a justification."
    );
    console.error("[locks:check] See lib/locks.md for the full lock graph.");
    process.exit(1);
  }

  console.log(
    `[locks:check] OK — ${files.length} file(s) parsed; no slot bypass detected.`
  );
}

main();

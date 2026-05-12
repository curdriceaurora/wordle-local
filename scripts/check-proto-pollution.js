#!/usr/bin/env node
"use strict";

// Mechanical detection of dynamic-key writes to plain objects, the
// class of bug behind rules 11 + 12 in `docs/review-preflight.md`:
//
//   "Key safety: dynamic object keys are validated against
//    prototype-pollution sentinels (__proto__, constructor, prototype)
//    and/or stored in null-prototype maps."
//
//   "Dynamic key write pattern: never write user-influenced keys via
//    obj[key] = value on plain objects in request paths; use Map
//    (then serialize) or strict allowlist + null-prototype container."
//
// Today the rule is enforced by human review only. This script is
// the AST sibling to `scripts/check-lock-bypass.js` — both walk
// every .js file under `routes/`, `lib/`, and `server.js` with
// acorn, looking for a specific dangerous AST shape.
//
// Heuristic per `obj[expr] = value` site:
//
//   1. Skip if the key expression is a string or number literal —
//      that's a constant the developer chose; not user-influenced.
//   2. Skip if the key expression looks like an array index:
//      identifiers matching `/^(i|j|k|idx|index|n|hour|day|count)\d*$/`,
//      numeric literals, arithmetic on the above. Array writes don't
//      pollute a prototype.
//   3. Skip if the object expression is null-prototype-protected:
//        - LHS root identifier was declared with `= Object.create(null)`
//          (or one of the equivalents recognized by `isNullProtoExpression`).
//          `Map` containers don't appear here — by convention they
//          use `.set()`, which is not an `obj[key] = ...` site at all.
//        - LHS property signature (e.g., `draft.resultsByProfile`) is
//          assigned `Object.create(null)` anywhere in the same file —
//          conservative but matches every current site.
//   4. Skip if the file is in ALLOWLIST_FILES (each entry must carry
//      a rationale comment in this script).
//   5. Otherwise, flag with the file:line and the offending snippet.
//
// Limitations (this is a guardrail, not a soundness proof):
//
//   * Cross-module flow not tracked. A null-prototype object passed
//     across files isn't recognized — but the write site itself is
//     usually inside the same file, so the rule works in practice.
//   * The "array-index" identifier heuristic is name-based. A loop
//     counter named `key` would be flagged; rename it or allowlist.
//   * The check assumes file-level scope is sufficient for object
//     signature lookup. A closure that shadows `draft.resultsByProfile`
//     to a non-null-proto value would slip past. The companion
//     `check-lock-bypass.js` script makes the same scope tradeoff
//     for similar reasons.
//
// Wired into `npm run check` between `locks:check` and `audit:check`.

const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");

const projectRoot = path.resolve(__dirname, "..");

const TARGET_DIRS = ["routes", "lib"];
const TARGET_ROOT_FILES = ["server.js"];

// Audited dynamic-write sites that are known-safe by upstream
// contract. Each entry MUST carry a rationale and a `signature`
// matching a substring of the offending line — that way unrelated
// edits don't break the allowlist (line numbers shift) and a
// different future sink can't silently steal the slot.
const ALLOWLIST_SITES = [
  {
    file: "routes/stats.js",
    signature: "draft.resultsByProfile[payload.profileId]",
    rationale:
      "draft.resultsByProfile is constructed as Object.create(null) by " +
      "leaderboard-store's createEmptyLeaderboardState function, and every " +
      "code path that assigns to draft.resultsByProfile = ... in that store " +
      "also uses Object.create(null). The destination is null-prototype by " +
      "upstream contract — a proto-pollution attempt via payload.profileId " +
      "would set an own property on the null-prototype object, not poison " +
      "Object.prototype. Cross-file AST flow analysis is out of scope for " +
      "this guard; the audit is captured here so the dependency is documented."
  }
];

// Files where the script is structurally inapplicable. Each entry
// requires a written rationale.
const ALLOWLIST_FILES = new Map([
  // none today.
]);

// Names that signal an array-index loop variable. Includes the
// idiomatic `i`/`j`/`k`/`n`, plus suffix patterns (`oldIdx`,
// `nextIndex`, `attemptIdx`), and time-bucket names that are
// numeric by construction.
const ARRAY_INDEX_IDENT_RE = /^(i|j|k|n)\d*$|(idx|index|count|hour|day)\d*$/i;

function collectJsFiles() {
  const out = [];
  for (const root of TARGET_DIRS) {
    const absDir = path.join(projectRoot, root);
    if (!fs.existsSync(absDir)) continue;
    walk(absDir, out);
  }
  for (const f of TARGET_ROOT_FILES) {
    const abs = path.join(projectRoot, f);
    if (fs.existsSync(abs)) out.push(abs);
  }
  return out;
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      walk(p, out);
    } else if (e.isFile() && e.name.endsWith(".js")) {
      out.push(p);
    }
  }
}

function parseSource(source) {
  return acorn.parse(source, {
    // Pinned year (not "latest") so the gate's behavior stays
    // predictable across acorn upgrades — new syntax / node types
    // can't silently widen what the check accepts. Bump when the
    // codebase intentionally adopts a newer syntax.
    ecmaVersion: 2024,
    sourceType: "script",
    allowReturnOutsideFunction: true,
    locations: true
  });
}

function visit(node, fn, parent = null) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") return;
  fn(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) visit(c, fn, node);
    } else if (v && typeof v === "object" && typeof v.type === "string") {
      visit(v, fn, node);
    }
  }
}

// Serialize a MemberExpression chain as a dotted signature
// (computed segments collapse to `[*]`). Returns null for shapes we
// can't represent cleanly (call expressions in the middle, etc.).
function serializeAccess(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "ThisExpression") return "this";
  if (node.type === "MemberExpression") {
    const base = serializeAccess(node.object);
    if (base === null) return null;
    if (node.computed) {
      // For object lookup we only care about static property names.
      if (node.property.type === "Literal" && typeof node.property.value === "string") {
        return `${base}.${node.property.value}`;
      }
      return `${base}[*]`;
    }
    return `${base}.${node.property.name}`;
  }
  return null;
}

function isObjectCreateNull(node) {
  return (
    node &&
    node.type === "CallExpression" &&
    node.callee &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "Object" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "create" &&
    node.arguments.length === 1 &&
    node.arguments[0].type === "Literal" &&
    node.arguments[0].value === null
  );
}

function isNullProtoObjectLiteral(node) {
  // Critical: only NON-COMPUTED `__proto__` keys actually set the
  // object's prototype to null. `{ ["__proto__"]: null }` is a
  // regular own-property assignment with a `__proto__` name and
  // does NOT change the prototype. Codex P2 caught this on PR #145.
  return (
    node &&
    node.type === "ObjectExpression" &&
    node.properties.some(
      (p) =>
        p.type === "Property" &&
        !p.computed &&
        ((p.key.type === "Identifier" && p.key.name === "__proto__") ||
          (p.key.type === "Literal" && p.key.value === "__proto__")) &&
        p.value.type === "Literal" &&
        p.value.value === null
    )
  );
}

// Typed arrays (Uint8Array, Float32Array, etc.) and Buffer.alloc()
// are fixed-length byte/number containers with no polluteable
// prototype lookup on integer keys. Treat their construction as
// null-proto-equivalent.
const TYPED_ARRAY_CTORS = new Set([
  "Int8Array", "Uint8Array", "Uint8ClampedArray",
  "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array",
  "BigInt64Array", "BigUint64Array"
]);

function isTypedArrayCtor(node) {
  return (
    node &&
    node.type === "NewExpression" &&
    node.callee.type === "Identifier" &&
    TYPED_ARRAY_CTORS.has(node.callee.name)
  );
}

function isBufferAlloc(node) {
  return (
    node &&
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "Buffer" &&
    node.callee.property.type === "Identifier" &&
    (node.callee.property.name === "alloc" || node.callee.property.name === "allocUnsafe")
  );
}

// `Object.assign(Object.create(null), {...})` — common idiom for
// a null-prototype container with initial keys. Recognize the
// first argument's null-proto source so the whole expression
// inherits the protection.
function isObjectAssignToNullProto(node) {
  if (!node || node.type !== "CallExpression") return false;
  const c = node.callee;
  if (
    !c ||
    c.type !== "MemberExpression" ||
    c.computed ||
    c.object.type !== "Identifier" ||
    c.object.name !== "Object" ||
    c.property.type !== "Identifier" ||
    c.property.name !== "assign"
  ) return false;
  const first = node.arguments[0];
  return Boolean(first) && isNullProtoExpression(first);
}

function isNullProtoExpression(node) {
  return (
    isObjectCreateNull(node) ||
    isNullProtoObjectLiteral(node) ||
    isTypedArrayCtor(node) ||
    isBufferAlloc(node) ||
    isObjectAssignToNullProto(node)
  );
}

function isLikelyArrayIndexKey(keyNode) {
  if (!keyNode) return false;
  if (keyNode.type === "Literal" && typeof keyNode.value === "number") return true;
  if (keyNode.type === "Identifier") return ARRAY_INDEX_IDENT_RE.test(keyNode.name);
  // Require BOTH sides of an arithmetic expression to be index-safe.
  // The earlier permissive form (`||`) would accept
  // `obj[req.body.key + 1]` because the right side is a number,
  // even though the left is request-influenced. Copilot caught
  // this false-negative on PR #145.
  if (keyNode.type === "BinaryExpression") {
    return isLikelyArrayIndexKey(keyNode.left) && isLikelyArrayIndexKey(keyNode.right);
  }
  if (keyNode.type === "UpdateExpression") return isLikelyArrayIndexKey(keyNode.argument);
  return false;
}

// Collect every property-signature in the file that's set to a
// null-prototype value, so subsequent `that.signature[key] = ...`
// assignments are recognized as safe.
function collectNullProtoSignatures(ast) {
  const sigs = new Set();
  visit(ast, (node) => {
    // const X = Object.create(null);  or  let X = ...; X = Object.create(null);
    if (node.type === "VariableDeclarator" && node.init && isNullProtoExpression(node.init)) {
      const sig = serializeAccess(node.id);
      if (sig) sigs.add(sig);
    }
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      isNullProtoExpression(node.right)
    ) {
      const sig = serializeAccess(node.left);
      if (sig) sigs.add(sig);
    }
    // Object-literal field: `{ resultsByProfile: Object.create(null) }`
    // record both as `Object.<fieldName>` and as a wildcard prefix
    // match (handled at lookup time via endsWith).
    if (
      node.type === "Property" &&
      !node.computed &&
      node.key.type === "Identifier" &&
      isNullProtoExpression(node.value)
    ) {
      // Track the property NAME — every `something.<name>` lookup
      // is allowed if the named field is always initialized
      // null-proto in this file.
      sigs.add(`*.${node.key.name}`);
    }
  });
  return sigs;
}

function isProtectedByNullProtoSignatures(objNode, sigs) {
  const sig = serializeAccess(objNode);
  if (!sig) return false;
  if (sigs.has(sig)) return true;
  // Check the trailing-property wildcard: `entry.memberProfileIds`
  // matches `*.memberProfileIds`.
  const lastDot = sig.lastIndexOf(".");
  if (lastDot >= 0 && sigs.has(`*${sig.slice(lastDot)}`)) return true;
  return false;
}

function checkProtoPollution(errors) {
  for (const absPath of collectJsFiles()) {
    const relPath = path.relative(projectRoot, absPath);
    if (ALLOWLIST_FILES.has(relPath)) continue;
    const source = fs.readFileSync(absPath, "utf8");
    let ast;
    try {
      ast = parseSource(source);
    } catch (err) {
      errors.push(`[check-proto-pollution] failed to parse ${relPath}: ${err.message}`);
      continue;
    }
    const nullProtoSigs = collectNullProtoSignatures(ast);
    visit(ast, (node) => {
      if (node.type !== "AssignmentExpression") return;
      const lhs = node.left;
      if (!lhs || lhs.type !== "MemberExpression" || !lhs.computed) return;
      const key = lhs.property;
      // Skip string-literal keys — constant, developer-chosen.
      if (key.type === "Literal" && typeof key.value === "string") return;
      // Skip numeric-literal / array-index keys.
      if (isLikelyArrayIndexKey(key)) return;
      // Skip if the destination is a null-prototype container.
      if (isProtectedByNullProtoSignatures(lhs.object, nullProtoSigs)) return;
      const line = node.loc.start.line;
      const snippet = source
        .slice(node.start, Math.min(node.end, node.start + 100))
        .replace(/\n/g, " ");
      // Skip audited allowlist entries (file + substring signature).
      const allowed = ALLOWLIST_SITES.find(
        (entry) => entry.file === relPath && snippet.includes(entry.signature)
      );
      if (allowed) return;
      errors.push(
        `${relPath}:${line} dynamic-key write to a plain object — route the key ` +
          "through an UNSAFE_OBJECT_KEYS sentinel check, store the container as " +
          "`Object.create(null)` (or `Object.assign(Object.create(null), {...})` " +
          "for default keys; switching to a `Map` removes the `[]=` site " +
          "entirely via `.set()`), or add the site to ALLOWLIST_SITES in " +
          "scripts/check-proto-pollution.js with a rationale (rules 11 + 12 / " +
          `A2 / #115). Site: ${snippet}`
      );
    });
  }
}

function main() {
  const errors = [];
  checkProtoPollution(errors);
  if (errors.length > 0) {
    console.error("[check-proto-pollution] FAIL — dynamic-key write(s) not protected:");
    for (const err of errors) console.error(`  ${err}`);
    process.exit(1);
  }
  console.log("[check-proto-pollution] OK — no unprotected dynamic-key writes.");
}

if (require.main === module) {
  main();
}

module.exports = {
  collectNullProtoSignatures,
  isProtectedByNullProtoSignatures,
  isLikelyArrayIndexKey,
  isObjectCreateNull,
  isNullProtoObjectLiteral,
  serializeAccess,
  parseSource
};

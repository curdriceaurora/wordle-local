#!/usr/bin/env node
"use strict";

// Mechanical detection of secret-handling anti-patterns (A6 / #119).
//
// Two classes of bug this script flags:
//
// 1. Non-constant-time secret compare. Every security-sensitive
//    token/key check must use `crypto.timingSafeEqual` after a length
//    pre-check. A `===` / `!==` compare leaks length + prefix via
//    timing. This script walks every `.js` file under `routes/`,
//    `lib/`, and `server.js` with acorn and flags any binary equality
//    whose left or right side is a secret-flavored expression:
//
//      - `process.env.ADMIN_KEY`, `process.env.<X_KEY>`, `<X_SECRET>`,
//        `<X_TOKEN>`, `<X_PASSWORD>`, `VAPID_PRIVATE_KEY`, etc.
//      - Member access ending in `.secret`, `.adminKey`, `.apiKey`,
//        `.token`, `.password`, `.vapidPrivate*`, etc.
//      - Identifiers whose name contains `secret`, `apiKey`,
//        `adminKey`, `vapidPrivate`, etc. (case-insensitive).
//
//    Whitelisted RHS shapes that are SAFE despite using `===`/`!==`:
//      - The literal `"" / 0` (existence/empty check).
//      - A `typeof X === "string"` comparison.
//      - `secret.length === N` (length pre-check used by
//        `timingSafeEqualString` itself).
//      - Inside `lib/admin-auth.js` — that file IS the constant-time
//        compare helper; the length pre-check is intentional.
//
// 2. Secret splat in logs. `console.log(req)`, `console.log(req.headers)`,
//    `console.warn(process.env)`, `console.error({...process.env})`, and
//    similar patterns dump the full request/env object which can
//    contain an admin key in headers or a secret in env. Flagged
//    regardless of context.
//
// This is a sibling to `check-lock-bypass.js`, `check-audit.js`,
// `check-proto-pollution.js`, and `nit-guardrails.js`. Wired into
// `npm run check` between `proto:check` and `audit:check`.

const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");

const projectRoot = path.resolve(__dirname, "..");
const TARGET_DIRS = ["routes", "lib"];
const TARGET_ROOT_FILES = ["server.js"];

// Files where the script is structurally inapplicable. Each entry
// requires a written rationale.
const ALLOWLIST_FILES = new Map([
  [
    "lib/admin-auth.js",
    "This file IS the constant-time-compare helper. " +
      "The `leftBuffer.length !== rightBuffer.length` check inside " +
      "`timingSafeEqualString` is the spec-required length pre-check " +
      "before `crypto.timingSafeEqual`."
  ]
]);

// Audited per-line allowlist entries. Each entry must carry a
// rationale and a substring `signature` that matches a portion of
// the offending line. Use substring matching (not file:line tuples)
// so unrelated edits above the line don't break the allowlist.
const ALLOWLIST_SITES = [
  // none today.
];

// Identifier-name patterns that look like secrets. Case-insensitive
// substring match against simple identifiers AND the last segment
// of a member-access chain.
// Matches a secret-flavored word at a camelCase / snake_case
// boundary. Bare `token` matches; `keyMap` and `nextKey` deliberately
// don't (avoid noise from common iteration variables).
const SECRET_NAME_RE = /(?:^|_|[A-Z])(?:secret|password|token|api[_]?key|admin[_]?key|access[_]?token|refresh[_]?token|client[_]?secret|webhook[_]?secret|vapid[_]?private)(?:$|_|[A-Z])/i;

// Env-var names that flag a secret. Used to detect
// `process.env.<NAME>` reads.
const SECRET_ENV_NAME_RE = /(?:_KEY$|_SECRET$|_TOKEN$|_PASSWORD$|^VAPID_PRIVATE)/;

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
    ecmaVersion: 2024,
    sourceType: "script",
    allowReturnOutsideFunction: true,
    locations: true
  });
}

function visit(node, fn) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") return;
  fn(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) visit(c, fn);
    } else if (v && typeof v === "object" && typeof v.type === "string") {
      visit(v, fn);
    }
  }
}

function isProcessEnvAccess(node) {
  // process.env.X
  return (
    node &&
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object &&
    node.object.type === "MemberExpression" &&
    !node.object.computed &&
    node.object.object.type === "Identifier" &&
    node.object.object.name === "process" &&
    node.object.property.type === "Identifier" &&
    node.object.property.name === "env" &&
    node.property.type === "Identifier"
  );
}

function envVarLooksSecret(node) {
  if (!isProcessEnvAccess(node)) return false;
  return SECRET_ENV_NAME_RE.test(node.property.name);
}

function memberLastSegmentLooksSecret(node) {
  // obj.X — flag if X matches the secret-name pattern. Walk one
  // level; the immediate property name is the leaf.
  if (!node || node.type !== "MemberExpression" || node.computed) return false;
  if (!node.property || node.property.type !== "Identifier") return false;
  return SECRET_NAME_RE.test(node.property.name);
}

function identifierLooksSecret(node) {
  return Boolean(node && node.type === "Identifier" && SECRET_NAME_RE.test(node.name));
}

function looksLikeSecretExpr(node) {
  return (
    envVarLooksSecret(node) ||
    memberLastSegmentLooksSecret(node) ||
    identifierLooksSecret(node)
  );
}

function isSafeEqualityRhs(node) {
  // RHS shapes that are categorically safe regardless of LHS:
  //   - String literals: `=== ""` (empty check), `=== "string"`
  //     (typeof check), `=== "<short identifier>"` (enum check).
  //   - Boolean literals: `=== true` / `=== false` — flag checks,
  //     NOT secret-value compares. `obj.rotateSecret === true`
  //     is a flag for "should I rotate the secret?", not a compare
  //     of the secret itself.
  //   - Numeric literals: `=== 0` (existence check), `=== N`
  //     (length check usually paired via `.length`).
  //   - `null` / `undefined`: existence checks.
  if (!node) return false;
  if (node.type === "Literal") {
    if (node.value === null) return true;
    if (typeof node.value === "boolean") return true;
    if (typeof node.value === "number") return true;
    if (node.value === "") return true;
    if (typeof node.value === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(node.value)) {
      // typeof string comparisons + short enum literals.
      return true;
    }
  }
  if (node.type === "Identifier" && (node.name === "undefined" || node.name === "null")) {
    return true;
  }
  return false;
}

function isTypeofExpression(node) {
  return node && node.type === "UnaryExpression" && node.operator === "typeof";
}

function isLengthAccess(node) {
  return (
    node &&
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property &&
    node.property.type === "Identifier" &&
    node.property.name === "length"
  );
}

// Console.<log|warn|error> dump patterns. Flag if any argument is:
//   - `req` (the whole request object)
//   - `req.headers` / `req.body` / `req.cookies` / `req.session`
//   - `process.env` (without a specific property)
//   - object expression that spreads process.env (`{ ...process.env }`)
//   - object expression that contains a value sourced from a
//     secret-looking name as a SHALLOW property.
function isConsoleSpread(node) {
  if (!node || node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (
    !callee ||
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.object.type !== "Identifier" ||
    callee.object.name !== "console" ||
    callee.property.type !== "Identifier"
  ) return false;
  if (!["log", "warn", "error", "info", "debug"].includes(callee.property.name)) return false;
  for (const arg of node.arguments) {
    if (!arg) continue;
    if (arg.type === "Identifier" && arg.name === "req") return true;
    if (
      arg.type === "MemberExpression" &&
      !arg.computed &&
      arg.object.type === "Identifier" &&
      arg.object.name === "req" &&
      arg.property &&
      arg.property.type === "Identifier" &&
      ["headers", "body", "cookies", "session"].includes(arg.property.name)
    ) return true;
    if (
      arg.type === "MemberExpression" &&
      !arg.computed &&
      arg.object.type === "Identifier" &&
      arg.object.name === "process" &&
      arg.property.type === "Identifier" &&
      arg.property.name === "env"
    ) return true;
    if (arg.type === "ObjectExpression") {
      for (const p of arg.properties) {
        if (
          p.type === "SpreadElement" &&
          p.argument.type === "MemberExpression" &&
          p.argument.object.type === "Identifier" &&
          p.argument.object.name === "process" &&
          p.argument.property.name === "env"
        ) return true;
      }
    }
  }
  return false;
}

function checkSecretHandling(errors) {
  for (const absPath of collectJsFiles()) {
    const relPath = path.relative(projectRoot, absPath);
    if (ALLOWLIST_FILES.has(relPath)) continue;
    const source = fs.readFileSync(absPath, "utf8");
    let ast;
    try {
      ast = parseSource(source);
    } catch (err) {
      errors.push(`[check-secret-handling] failed to parse ${relPath}: ${err.message}`);
      continue;
    }
    visit(ast, (node) => {
      // 1. Non-constant-time secret compare
      if (
        node.type === "BinaryExpression" &&
        (node.operator === "===" || node.operator === "!==")
      ) {
        const left = node.left;
        const right = node.right;
        // typeof X === "string" — safe (returns short fixed-set output).
        if (isTypeofExpression(left) || isTypeofExpression(right)) return;
        // `.length === N` — length pre-check, safe.
        if (isLengthAccess(left) || isLengthAccess(right)) return;
        const leftIsSecret = looksLikeSecretExpr(left);
        const rightIsSecret = looksLikeSecretExpr(right);
        if (!leftIsSecret && !rightIsSecret) return;
        // `secret === ""` / `secret !== ""` — existence/empty check, safe.
        if (isSafeEqualityRhs(right) || isSafeEqualityRhs(left)) return;
        const line = node.loc.start.line;
        const snippet = source.slice(node.start, Math.min(node.end, node.start + 120)).replace(/\n/g, " ");
        const allowed = ALLOWLIST_SITES.find(
          (e) => e.file === relPath && snippet.includes(e.signature)
        );
        if (allowed) return;
        errors.push(
          `${relPath}:${line} non-constant-time secret compare — use ` +
            "`crypto.timingSafeEqual(left, right)` after an explicit " +
            "length pre-check, NOT `===` / `!==`. Pattern: `<expr> " +
            `${node.operator} <expr>\` where one side looks like a secret. ` +
            `Site: ${snippet}`
        );
      }
      // 2. Secret splat in logs
      if (isConsoleSpread(node)) {
        const line = node.loc.start.line;
        const snippet = source.slice(node.start, Math.min(node.end, node.start + 120)).replace(/\n/g, " ");
        const allowed = ALLOWLIST_SITES.find(
          (e) => e.file === relPath && snippet.includes(e.signature)
        );
        if (allowed) return;
        errors.push(
          `${relPath}:${line} console call splats a secret-bearing object ` +
            "(req, req.headers, req.body, req.cookies, process.env, or a " +
            "spread of any of these). Log explicit fields (e.g., " +
            "`req.method`, `req.path`, `req.headers['user-agent']`) — never " +
            `the whole object. Site: ${snippet}`
        );
      }
    });
  }
}

function main() {
  const errors = [];
  checkSecretHandling(errors);
  if (errors.length > 0) {
    console.error("[check-secret-handling] FAIL — secret-handling anti-pattern(s):");
    for (const err of errors) console.error(`  ${err}`);
    process.exit(1);
  }
  console.log("[check-secret-handling] OK — no secret-handling anti-patterns.");
}

if (require.main === module) {
  main();
}

module.exports = {
  looksLikeSecretExpr,
  isConsoleSpread,
  envVarLooksSecret,
  memberLastSegmentLooksSecret,
  identifierLooksSecret,
  parseSource
};

"use strict";

// Unit tests for the pure helpers exposed by check-proto-pollution.
// The real script (which walks the project tree) is exercised once
// via a tampering-style integration test at the bottom that runs the
// CLI against the current repo and asserts it exits 0 / fails 1 on
// a planted bypass.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  collectNullProtoSignatures,
  isProtectedByNullProtoSignatures,
  isLikelyArrayIndexKey,
  isObjectCreateNull,
  isNullProtoObjectLiteral,
  serializeAccess,
  parseSource
} = require("../scripts/check-proto-pollution");

function parse(src) {
  return parseSource(src);
}

function firstStatementExpr(ast) {
  return ast.body[0].expression;
}

describe("isObjectCreateNull", () => {
  test("matches Object.create(null)", () => {
    const expr = firstStatementExpr(parse("Object.create(null)"));
    expect(isObjectCreateNull(expr)).toBe(true);
  });
  test("does not match Object.create({})", () => {
    const expr = firstStatementExpr(parse("Object.create({})"));
    expect(isObjectCreateNull(expr)).toBe(false);
  });
  test("does not match arbitrary call expressions", () => {
    const expr = firstStatementExpr(parse("foo.bar()"));
    expect(isObjectCreateNull(expr)).toBe(false);
  });
});

describe("isNullProtoObjectLiteral", () => {
  test("matches { __proto__: null, ... }", () => {
    const expr = firstStatementExpr(parse('({ __proto__: null, foo: 1 })'));
    expect(isNullProtoObjectLiteral(expr)).toBe(true);
  });
  test("does not match {} (no __proto__ field)", () => {
    const expr = firstStatementExpr(parse('({ foo: 1 })'));
    expect(isNullProtoObjectLiteral(expr)).toBe(false);
  });
  test("does NOT match computed-key `{ [\"__proto__\"]: null }` — JS treats that as a regular own-property assignment, not a prototype set (Codex P2)", () => {
    const expr = firstStatementExpr(parse('({ ["__proto__"]: null })'));
    expect(isNullProtoObjectLiteral(expr)).toBe(false);
  });
});

describe("isLikelyArrayIndexKey", () => {
  test("accepts canonical loop names", () => {
    const ast = parse("a[i] = 1; a[j] = 1; a[k] = 1; a[n] = 1;");
    for (const stmt of ast.body) {
      expect(isLikelyArrayIndexKey(stmt.expression.left.property)).toBe(true);
    }
  });
  test("accepts camelCase index suffixes", () => {
    for (const name of ["oldIdx", "nextIndex", "attemptIdx", "currentIndex"]) {
      const ast = parse(`a[${name}] = 1;`);
      expect(isLikelyArrayIndexKey(ast.body[0].expression.left.property)).toBe(true);
    }
  });
  test("accepts numeric literal keys", () => {
    const ast = parse("a[5] = 1;");
    expect(isLikelyArrayIndexKey(ast.body[0].expression.left.property)).toBe(true);
  });
  test("rejects arbitrary identifier names", () => {
    const ast = parse("a[userInput] = 1;");
    expect(isLikelyArrayIndexKey(ast.body[0].expression.left.property)).toBe(false);
  });
  test("accepts simple arithmetic on index names", () => {
    const ast = parse("a[i + 1] = 1;");
    expect(isLikelyArrayIndexKey(ast.body[0].expression.left.property)).toBe(true);
  });
  test("rejects mixed-source arithmetic (Copilot: `obj[req.body.key + 1]` must NOT pass)", () => {
    const ast = parse("a[req.body.key + 1] = 1;");
    expect(isLikelyArrayIndexKey(ast.body[0].expression.left.property)).toBe(false);
  });
});

describe("collectNullProtoSignatures + isProtectedByNullProtoSignatures", () => {
  test("tracks `const X = Object.create(null)`", () => {
    const ast = parse("const cache = Object.create(null); cache[k] = 1;");
    const sigs = collectNullProtoSignatures(ast);
    expect(sigs.has("cache")).toBe(true);
    const assign = ast.body[1].expression;
    expect(isProtectedByNullProtoSignatures(assign.left.object, sigs)).toBe(true);
  });

  test("tracks `obj.prop = Object.create(null)` and matches via field name wildcard", () => {
    const ast = parse(
      "const state = {}; state.cache = Object.create(null); other.cache[k] = 1;"
    );
    const sigs = collectNullProtoSignatures(ast);
    expect(sigs.has("state.cache")).toBe(true);
    expect(sigs.has("*.cache")).toBe(false); // assignment doesn't add wildcard
    const assign = ast.body[2].expression;
    // Direct signature `state.cache` matches; `other.cache` does NOT
    // unless wildcard was added (it wasn't, this is an Assignment).
    expect(isProtectedByNullProtoSignatures(assign.left.object, sigs)).toBe(false);
  });

  test("tracks `{ field: Object.create(null) }` as `*.field` wildcard", () => {
    const ast = parse(
      "function f() { return { resultsByProfile: Object.create(null) }; }"
    );
    const sigs = collectNullProtoSignatures(ast);
    expect(sigs.has("*.resultsByProfile")).toBe(true);
  });

  test("recognizes typed-array constructors as null-proto-equivalent", () => {
    const ast = parse("const buf = new Uint8Array(26); buf[i] = 1;");
    const sigs = collectNullProtoSignatures(ast);
    expect(sigs.has("buf")).toBe(true);
  });

  test("recognizes `Object.assign(Object.create(null), {...})`", () => {
    const ast = parse(
      "const totals = Object.assign(Object.create(null), { a: 0 }); totals[k] = 1;"
    );
    const sigs = collectNullProtoSignatures(ast);
    expect(sigs.has("totals")).toBe(true);
  });
});

describe("serializeAccess", () => {
  test("serializes chained member access", () => {
    const ast = parse("a.b.c[k] = 1;");
    const lhs = ast.body[0].expression.left;
    expect(serializeAccess(lhs.object)).toBe("a.b.c");
  });
  test("collapses computed segments to [*]", () => {
    const ast = parse("a[i].b = 1;");
    const lhs = ast.body[0].expression.left;
    expect(serializeAccess(lhs.object)).toBe("a[*]");
  });
});

describe("check-proto-pollution CLI end-to-end", () => {
  const CLI = path.resolve(__dirname, "..", "scripts", "check-proto-pollution.js");
  test("exits 0 on current main", () => {
    const result = execFileSync("node", [CLI], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(result).toMatch(/OK/);
  });

  test("exits 1 when a planted bare `obj[req.body.key] = v` is dropped under routes/", () => {
    // Plant the bypass in a NEW file inside routes/ rather than
    // mutating routes/admin.js — jest runs test files in parallel
    // and other suites do `require("../server")` which transitively
    // loads routes/admin.js, so in-place mutation could cause
    // cross-worker races (Copilot caught this on PR #145).
    const tempFile = path.resolve(
      __dirname,
      "..",
      "routes",
      `__proto_pollution_test_harness_${process.pid}_${Date.now()}.js`
    );
    try {
      fs.writeFileSync(
        tempFile,
        "module.exports = function injectedUnsafe(req) {\n" +
          "  const dest = {};\n" +
          "  dest[req.body.key] = req.body.value;\n" +
          "  return dest;\n" +
          "};\n"
      );
      let exitCode = 0;
      let stderr = "";
      try {
        execFileSync("node", [CLI], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        exitCode = err.status;
        stderr = err.stderr?.toString() || "";
      }
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/dest\[req\.body\.key\]/);
    } finally {
      try { fs.unlinkSync(tempFile); } catch (_err) { /* best effort */ }
    }
  });
});

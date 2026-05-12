"use strict";

// Unit tests for `scripts/check-secret-handling.js`. Helper tests
// against fixture ASTs, plus two integration tests that run the CLI
// against the current repo (asserts clean) and plant tampering files
// in temp paths (asserts the guard fires).

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  looksLikeSecretExpr,
  isConsoleSpread,
  envVarLooksSecret,
  memberLastSegmentLooksSecret,
  identifierLooksSecret,
  parseSource
} = require("../scripts/check-secret-handling");

function parse(src) {
  return parseSource(src);
}

function firstStmtExpr(ast) {
  return ast.body[0].expression;
}

describe("envVarLooksSecret", () => {
  test.each([
    ["process.env.ADMIN_KEY", true],
    ["process.env.WEBHOOK_SECRET", true],
    ["process.env.GITHUB_TOKEN", true],
    ["process.env.DB_PASSWORD", true],
    ["process.env.VAPID_PRIVATE_KEY", true],
    ["process.env.NODE_ENV", false],
    ["process.env.PORT", false],
    ["process.env.RATE_LIMIT_MAX", false]
  ])("%s -> %s", (src, expected) => {
    expect(envVarLooksSecret(firstStmtExpr(parse(src)))).toBe(expected);
  });
});

describe("memberLastSegmentLooksSecret", () => {
  test.each([
    ["sub.secret", true],
    ["config.adminKey", true],
    ["req.body.apiKey", true],
    ["payload.vapidPrivateKey", true],
    ["obj.token", true],
    ["obj.password", true],
    ["obj.label", false],
    ["obj.url", false]
  ])("%s -> %s", (src, expected) => {
    expect(memberLastSegmentLooksSecret(firstStmtExpr(parse(src)))).toBe(expected);
  });
});

describe("identifierLooksSecret", () => {
  test.each([
    ["secret", true],
    ["adminKey", true],
    ["apiKey", true],
    ["webhookSecret", true],
    ["vapidPrivateKey", true],
    ["request", false],
    ["payload", false]
  ])("%s -> %s", (src, expected) => {
    expect(identifierLooksSecret(parse(`(${src})`).body[0].expression)).toBe(expected);
  });
});

describe("looksLikeSecretExpr (composite)", () => {
  test("typeof check on secret expression is recognized as the LHS but harmless via isSafeEqualityRhs path", () => {
    // The check-secret-handling integration tests cover the
    // BinaryExpression-level filtering; this just confirms the
    // helper itself returns true so the BinaryExpression code path
    // is entered.
    expect(looksLikeSecretExpr(firstStmtExpr(parse("process.env.ADMIN_KEY")))).toBe(true);
  });
});

describe("isConsoleSpread", () => {
  test.each([
    ["console.log(req)", true],
    ["console.warn(req.headers)", true],
    ["console.error(req.body)", true],
    ["console.info(req.cookies)", true],
    ["console.debug(req.session)", true],
    ["console.log(process.env)", true],
    ["console.log({ ...process.env })", true],
    ['console.log("starting")', false],
    ["console.log(req.method, req.path)", false],
    ['console.log("hdr:", req.headers["user-agent"])', false],
    ["console.warn(err.message)", false],
    ["notConsole.log(req)", false]
  ])("%s -> %s", (src, expected) => {
    expect(isConsoleSpread(firstStmtExpr(parse(src)))).toBe(expected);
  });
});

describe("check-secret-handling CLI end-to-end", () => {
  const CLI = path.resolve(__dirname, "..", "scripts", "check-secret-handling.js");

  test("exits 0 on current main", () => {
    const result = execFileSync("node", [CLI], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(result).toMatch(/OK/);
  });

  function plantAndRun(content) {
    const tempFile = path.resolve(
      __dirname,
      "..",
      "routes",
      `__secret_handling_test_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.js`
    );
    try {
      fs.writeFileSync(tempFile, content);
      let exitCode = 0;
      let stderr = "";
      try {
        execFileSync("node", [CLI], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        exitCode = err.status;
        stderr = err.stderr?.toString() || "";
      }
      return { exitCode, stderr };
    } finally {
      try { fs.unlinkSync(tempFile); } catch (_e) { /* best effort */ }
    }
  }

  test("flags a bare `=== process.env.ADMIN_KEY` compare", () => {
    const { exitCode, stderr } = plantAndRun(
      "module.exports = function(req) {\n" +
        "  return req.headers['x-admin-key'] === process.env.ADMIN_KEY;\n" +
        "};\n"
    );
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/non-constant-time secret compare/);
  });

  test("flags `console.log(req)`", () => {
    const { exitCode, stderr } = plantAndRun(
      "module.exports = function(req) { console.log(req); };\n"
    );
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/splats a secret-bearing object/);
  });

  test("flags `console.warn(process.env)`", () => {
    const { exitCode, stderr } = plantAndRun(
      "module.exports = function() { console.warn(process.env); };\n"
    );
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/splats a secret-bearing object/);
  });

  test("does NOT flag `console.log(req.method, req.path)` (explicit fields)", () => {
    const { exitCode } = plantAndRun(
      "module.exports = function(req) { console.log(req.method, req.path); };\n"
    );
    expect(exitCode).toBe(0);
  });

  test("does NOT flag `patch.rotateSecret === true` (boolean flag, not secret value)", () => {
    const { exitCode } = plantAndRun(
      "module.exports = function(patch) { return patch.rotateSecret === true; };\n"
    );
    expect(exitCode).toBe(0);
  });

  test("does NOT flag `typeof secret === \"string\"` (typeof check)", () => {
    const { exitCode } = plantAndRun(
      "module.exports = function(secret) { return typeof secret === 'string'; };\n"
    );
    expect(exitCode).toBe(0);
  });

  test("does NOT flag `secret.length === 64` (length pre-check)", () => {
    const { exitCode } = plantAndRun(
      "module.exports = function(secret) { return secret.length === 64; };\n"
    );
    expect(exitCode).toBe(0);
  });
});

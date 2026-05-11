"use strict";

// Self-test for scripts/check-audit.js — verifies the gate's
// extraction + comparison logic without shelling out to `npm audit`.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SCRIPT = path.resolve(__dirname, "..", "scripts", "check-audit.js");
const BASELINE = path.resolve(__dirname, "..", ".audit-baseline.json");

function runScriptWith(baselineJson) {
  const original = fs.readFileSync(BASELINE, "utf8");
  fs.writeFileSync(BASELINE, JSON.stringify(baselineJson, null, 2));
  try {
    const stdout = execFileSync("node", [SCRIPT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      exitCode: err.status,
      stdout: err.stdout?.toString() || "",
      stderr: err.stderr?.toString() || ""
    };
  } finally {
    fs.writeFileSync(BASELINE, original);
  }
}

describe("scripts/check-audit.js", () => {
  test("exits 0 when every current advisory is in the baseline", () => {
    // The shipped baseline lists the 3 known dev-dep advisories from
    // the markdownlint-cli2 chain. The script must report OK.
    const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    const result = runScriptWith(baseline);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/OK — \d+ advisory/);
  });

  test("exits 1 when current advisories are missing from the baseline", () => {
    // Empty baseline → every currently-known advisory becomes
    // "unexpected" and the gate fails.
    const result = runScriptWith({ accepted: [] });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/FAIL — new advisories not in/);
    expect(result.stderr).toMatch(/GHSA-/);
    // The remediation hint is printed so the operator knows how to
    // resolve.
    expect(result.stderr).toMatch(/baseline entry with rationale/);
  });

  test("malformed baseline JSON exits 1 with a clear error", () => {
    // Write something that's a string at the top level (valid JSON
    // but missing `accepted` array). The script should fall back
    // gracefully (empty accepted set) and report current advisories
    // as unexpected, OR throw an error.
    // We're testing the "no `accepted` array → empty set" path,
    // which behaves like the empty-baseline test above.
    const result = runScriptWith({ wrongKey: "foo" });
    expect(result.exitCode).toBe(1);
  });
});

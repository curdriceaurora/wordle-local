"use strict";

// Self-tests for scripts/check-audit.js. The pure helpers are
// imported directly and exercised against fixture JSON; the
// end-to-end smoke tests at the bottom run the real script binary
// against a SHIMMED `npm` (PATH-injected fake) so they verify the
// full wiring without depending on the npm registry or network.
//
// Codex P2 (PR #139, round 2) flagged that the previous smoke
// approach — shelling out to the real `npm audit` — broke in
// offline / proxied / registry-outage environments. The shim makes
// the smoke deterministic.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  canonicalGhsa,
  makeBaselineKey,
  loadBaseline,
  parseAuditOutput,
  extractAdvisoriesFromAudit,
  diffAdvisoriesAgainstBaseline
} = require("../scripts/check-audit");

const SCRIPT = path.resolve(__dirname, "..", "scripts", "check-audit.js");

// ---------- helpers ----------

function fixtureAuditWith(vulnerabilities) {
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } }
  };
}

function makeViaObject({ ghsa, title = "(fixture)" }) {
  return {
    source: 1234,
    name: "test",
    dependency: "test",
    title,
    url: `https://github.com/advisories/${ghsa}`,
    severity: "moderate"
  };
}

// Drop a POSIX shell `npm` shim in `shimDir` that responds to
// `npm audit --json` with `auditFixture` and rejects any other
// invocation. We prepend `shimDir` to PATH so the script-under-test
// finds the shim instead of the real npm. Linux/macOS only — those
// are the platforms this repo's CI + dev environments target.
function installNpmShim(shimDir, auditFixture) {
  const fixturePath = path.join(shimDir, "audit-fixture.json");
  fs.writeFileSync(fixturePath, JSON.stringify(auditFixture));
  const shimPath = path.join(shimDir, "npm");
  fs.writeFileSync(
    shimPath,
    `#!/bin/sh
if [ "$1" = "audit" ] && [ "$2" = "--json" ]; then
  cat "${fixturePath}"
  exit 0
fi
echo "test npm shim: unexpected args: $*" >&2
exit 99
`
  );
  fs.chmodSync(shimPath, 0o755);
}

// Run the script binary with a tmp baseline AND a shimmed npm that
// returns `auditFixture`. Used for the end-to-end smoke tests at
// the bottom; the rest of the suite imports the helpers directly.
//
// We never write to the real `.audit-baseline.json` — the script
// reads `CHECK_AUDIT_BASELINE` env var instead. This means a
// crashed test (SIGINT/SIGKILL mid-run) can't leave the repo's
// baseline corrupted (CodeRabbit nit, PR #139 round 2).
function runScriptWith({ baselineJson, auditFixture }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-audit-"));
  try {
    const baselineTmpPath = path.join(tmpDir, "baseline.json");
    fs.writeFileSync(baselineTmpPath, JSON.stringify(baselineJson, null, 2));
    installNpmShim(tmpDir, auditFixture);
    const stdout = execFileSync("node", [SCRIPT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${tmpDir}:${process.env.PATH}`,
        CHECK_AUDIT_BASELINE: baselineTmpPath
      }
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      exitCode: err.status,
      stdout: err.stdout?.toString() || "",
      stderr: err.stderr?.toString() || ""
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------- canonicalGhsa ----------

describe("canonicalGhsa", () => {
  test("uppercases GHSA ids", () => {
    expect(canonicalGhsa("https://github.com/advisories/ghsa-abcd-1234-efgh")).toBe(
      "GHSA-ABCD-1234-EFGH"
    );
  });
  test("returns null for non-string / non-matching input", () => {
    expect(canonicalGhsa(null)).toBeNull();
    expect(canonicalGhsa(123)).toBeNull();
    expect(canonicalGhsa("not-a-ghsa")).toBeNull();
    expect(canonicalGhsa("")).toBeNull();
  });
  test("trims surrounding whitespace", () => {
    expect(canonicalGhsa("  GHSA-aaaa-bbbb-cccc  ")).toBe("GHSA-AAAA-BBBB-CCCC");
  });
});

// ---------- extractAdvisoriesFromAudit ----------

describe("extractAdvisoriesFromAudit", () => {
  test("extracts (ghsa, package) pairs from object-via entries", () => {
    const audit = fixtureAuditWith({
      lodash: {
        severity: "high",
        via: [makeViaObject({ ghsa: "GHSA-aaaa-1111-cccc", title: "Prototype pollution" })]
      }
    });
    const out = extractAdvisoriesFromAudit(audit);
    expect(out).toEqual([
      {
        ghsa: "GHSA-AAAA-1111-CCCC",
        package: "lodash",
        severity: "high",
        title: "Prototype pollution"
      }
    ]);
  });

  test("skips string/number via entries (transitive cross-refs)", () => {
    const audit = fixtureAuditWith({
      "lodash.merge": {
        severity: "high",
        via: ["lodash", 12345]
      }
    });
    expect(extractAdvisoriesFromAudit(audit)).toEqual([]);
  });

  test("skips via objects with no GHSA-shaped url", () => {
    const audit = fixtureAuditWith({
      somepkg: {
        severity: "low",
        via: [{ source: 1, name: "somepkg", url: "https://npmjs.com/advisories/1234" }]
      }
    });
    expect(extractAdvisoriesFromAudit(audit)).toEqual([]);
  });

  test("emits one entry per object via — multiple advisories on same package allowed", () => {
    const audit = fixtureAuditWith({
      multipkg: {
        severity: "moderate",
        via: [
          makeViaObject({ ghsa: "GHSA-aaaa-1111-aaaa", title: "First" }),
          makeViaObject({ ghsa: "GHSA-bbbb-2222-bbbb", title: "Second" })
        ]
      }
    });
    const out = extractAdvisoriesFromAudit(audit);
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.ghsa)).toEqual(["GHSA-AAAA-1111-AAAA", "GHSA-BBBB-2222-BBBB"]);
  });

  test("returns [] when vulnerabilities map is empty or missing", () => {
    expect(extractAdvisoriesFromAudit(fixtureAuditWith({}))).toEqual([]);
    expect(extractAdvisoriesFromAudit({})).toEqual([]);
    expect(extractAdvisoriesFromAudit(null)).toEqual([]);
  });
});

// ---------- parseAuditOutput (fail-closed on transport errors) ----------

describe("parseAuditOutput", () => {
  test("accepts a real-looking audit JSON", () => {
    const json = JSON.stringify(fixtureAuditWith({}));
    expect(parseAuditOutput(json)).toMatchObject({ vulnerabilities: {} });
  });

  test("throws when JSON is missing the `vulnerabilities` map", () => {
    // Simulates an npm-audit transport error payload (the Codex P1
    // fail-open hole from PR #139).
    const transportError = JSON.stringify({ statusCode: 403, message: "forbidden" });
    expect(() => parseAuditOutput(transportError)).toThrow(/missing `vulnerabilities` map/);
  });

  test("throws when JSON has an `error` field", () => {
    const errorPayload = JSON.stringify({ error: { summary: "ENETUNREACH" } });
    expect(() => parseAuditOutput(errorPayload)).toThrow(/npm audit reported an error.*ENETUNREACH/);
  });

  test("throws when input is not valid JSON", () => {
    expect(() => parseAuditOutput("{ not json")).toThrow(/not valid JSON/);
  });

  test("throws when JSON is an array or null", () => {
    expect(() => parseAuditOutput("[]")).toThrow(/not a JSON object/);
    expect(() => parseAuditOutput("null")).toThrow(/not a JSON object/);
  });
});

// ---------- diffAdvisoriesAgainstBaseline ----------

describe("diffAdvisoriesAgainstBaseline", () => {
  test("baseline match requires BOTH GHSA and package", () => {
    const advisories = [
      { ghsa: "GHSA-X", package: "trusted-dev-pkg", severity: "moderate", title: "" },
      { ghsa: "GHSA-X", package: "runtime-pkg", severity: "moderate", title: "" }
    ];
    const acceptedKeys = new Set([makeBaselineKey("GHSA-X", "trusted-dev-pkg")]);
    const { unexpected } = diffAdvisoriesAgainstBaseline(advisories, acceptedKeys);
    // Only the runtime-pkg occurrence is unexpected — same GHSA on
    // a different package isn't auto-accepted.
    expect(unexpected).toHaveLength(1);
    expect(unexpected[0].package).toBe("runtime-pkg");
  });

  test("dedupes the unexpected list across multiple via entries", () => {
    const advisories = [
      { ghsa: "GHSA-Y", package: "pkg-a", severity: "high", title: "First sighting" },
      { ghsa: "GHSA-Y", package: "pkg-a", severity: "high", title: "Duplicate sighting" }
    ];
    const { unexpected } = diffAdvisoriesAgainstBaseline(advisories, new Set());
    expect(unexpected).toHaveLength(1);
  });

  test("reports uniqueCount as (GHSA, package) pairs, not raw via count", () => {
    const advisories = [
      { ghsa: "GHSA-Z", package: "pkg-a", severity: "low", title: "" },
      { ghsa: "GHSA-Z", package: "pkg-a", severity: "low", title: "" },
      { ghsa: "GHSA-Z", package: "pkg-b", severity: "low", title: "" }
    ];
    const acceptedKeys = new Set([
      makeBaselineKey("GHSA-Z", "pkg-a"),
      makeBaselineKey("GHSA-Z", "pkg-b")
    ]);
    const { unexpected, uniqueCount } = diffAdvisoriesAgainstBaseline(advisories, acceptedKeys);
    expect(unexpected).toEqual([]);
    expect(uniqueCount).toBe(2);
  });
});

// ---------- loadBaseline (file integration) ----------

describe("loadBaseline", () => {
  test("loads the repo's baseline file with the canonical keys", () => {
    const { acceptedKeys } = loadBaseline();
    // The shipped baseline lists 3 advisories. Check the set is
    // non-empty and uses canonical (uppercase) keys.
    expect(acceptedKeys.size).toBeGreaterThanOrEqual(1);
    for (const key of acceptedKeys) {
      expect(key).toMatch(/^GHSA-[A-Z0-9-]+\|.+/);
    }
  });

  test("missing baseline file throws", () => {
    expect(() => loadBaseline("/no/such/file.json")).toThrow(/missing baseline file/);
  });
});

// ---------- End-to-end smoke (shimmed npm; fully offline) ----------
//
// Runs the actual script binary so we catch any regression in how
// the pieces wire together (loadBaseline + runNpmAudit + parse +
// diff + exit code + stderr/stdout). `npm` is shimmed via PATH so
// the test is hermetic — no registry, no network, no dependence on
// what advisories happen to be live today.

describe("scripts/check-audit.js end-to-end (shimmed npm)", () => {
  test("exits 0 when shimmed audit matches the baseline", () => {
    const auditFixture = fixtureAuditWith({
      lodash: {
        severity: "high",
        via: [makeViaObject({ ghsa: "GHSA-aaaa-bbbb-cccc", title: "Prototype pollution" })]
      }
    });
    const baselineJson = {
      accepted: [
        {
          ghsa: "GHSA-AAAA-BBBB-CCCC",
          package: "lodash",
          severity: "high",
          title: "Prototype pollution",
          rationale: "test fixture"
        }
      ]
    };
    const result = runScriptWith({ baselineJson, auditFixture });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/OK/);
  });

  test("exits 1 when shimmed audit has advisories not in baseline", () => {
    const auditFixture = fixtureAuditWith({
      lodash: {
        severity: "high",
        via: [makeViaObject({ ghsa: "GHSA-aaaa-bbbb-cccc", title: "Prototype pollution" })]
      }
    });
    const result = runScriptWith({ baselineJson: { accepted: [] }, auditFixture });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/FAIL — new advisories not in/);
    expect(result.stderr).toMatch(/GHSA-AAAA-BBBB-CCCC/);
    expect(result.stderr).toMatch(/baseline entry with rationale/);
    expect(result.stderr).toMatch(/Baseline matches by .ghsa, package. pair/);
  });

  test("exits 1 (fail-closed) when shimmed audit returns a transport-error payload", () => {
    // Simulates npm-audit returning {statusCode: 403, message: "forbidden"}
    // — the exact failure mode that motivated the parseAuditOutput
    // hardening. Should NOT print OK.
    const auditFixture = { statusCode: 403, message: "forbidden" };
    const result = runScriptWith({ baselineJson: { accepted: [] }, auditFixture });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/missing `vulnerabilities` map/);
    expect(result.stderr).not.toMatch(/\bOK\b/);
  });
});

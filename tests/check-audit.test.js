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
  computeScopeMap,
  diffAdvisoriesAgainstBaseline,
  scopeAllows
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

// Drop a POSIX shell `npm` shim in `shimDir` that responds to:
//   - `npm audit --json`              → auditFixture
//   - `npm audit --json --omit=dev`   → prodAuditFixture
// and rejects any other invocation. We prepend `shimDir` to PATH so
// the script-under-test finds the shim instead of the real npm.
// Linux/macOS only — those are the platforms this repo's CI + dev
// environments target.
function installNpmShim(shimDir, { auditFixture, prodAuditFixture }) {
  const fullFixturePath = path.join(shimDir, "audit-fixture.json");
  const prodFixturePath = path.join(shimDir, "audit-fixture-prod.json");
  fs.writeFileSync(fullFixturePath, JSON.stringify(auditFixture));
  fs.writeFileSync(prodFixturePath, JSON.stringify(prodAuditFixture));
  const shimPath = path.join(shimDir, "npm");
  fs.writeFileSync(
    shimPath,
    `#!/bin/sh
if [ "$1" = "audit" ] && [ "$2" = "--json" ]; then
  if [ "$3" = "--omit=dev" ]; then
    cat "${prodFixturePath}"
  else
    cat "${fullFixturePath}"
  fi
  exit 0
fi
echo "test npm shim: unexpected args: $*" >&2
exit 99
`
  );
  fs.chmodSync(shimPath, 0o755);
}

// Run the script binary with a tmp baseline AND a shimmed npm that
// returns `auditFixture` for the full audit and `prodAuditFixture`
// for the `--omit=dev` audit. Used for the end-to-end smoke tests
// at the bottom; the rest of the suite imports helpers directly.
//
// We never write to the real `.audit-baseline.json` — the script
// reads `CHECK_AUDIT_BASELINE` env var instead. This means a
// crashed test (SIGINT/SIGKILL mid-run) can't leave the repo's
// baseline corrupted (CodeRabbit nit, PR #139 round 2).
function runScriptWith({ baselineJson, auditFixture, prodAuditFixture }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-audit-"));
  try {
    const baselineTmpPath = path.join(tmpDir, "baseline.json");
    fs.writeFileSync(baselineTmpPath, JSON.stringify(baselineJson, null, 2));
    // Default the prod fixture to an empty audit if not provided —
    // matches the common case where blessed advisories are dev-only.
    installNpmShim(tmpDir, {
      auditFixture,
      prodAuditFixture: prodAuditFixture ?? fixtureAuditWith({})
    });
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
  test("extracts (ghsa, package) pairs from object-via entries including `nodes`", () => {
    const audit = fixtureAuditWith({
      lodash: {
        severity: "high",
        nodes: ["node_modules/lodash"],
        via: [makeViaObject({ ghsa: "GHSA-aaaa-1111-cccc", title: "Prototype pollution" })]
      }
    });
    const out = extractAdvisoriesFromAudit(audit);
    expect(out).toEqual([
      {
        ghsa: "GHSA-AAAA-1111-CCCC",
        package: "lodash",
        severity: "high",
        title: "Prototype pollution",
        nodes: ["node_modules/lodash"]
      }
    ]);
  });

  test("sets `nodes` to null when audit info omits the field (fail-closed signal)", () => {
    const audit = fixtureAuditWith({
      lodash: {
        severity: "high",
        via: [makeViaObject({ ghsa: "GHSA-aaaa-1111-cccc" })]
      }
    });
    const out = extractAdvisoriesFromAudit(audit);
    expect(out[0].nodes).toBeNull();
  });

  test("sets `nodes` to [] when audit info has explicit empty array", () => {
    const audit = fixtureAuditWith({
      lodash: {
        severity: "high",
        nodes: [],
        via: [makeViaObject({ ghsa: "GHSA-aaaa-1111-cccc" })]
      }
    });
    const out = extractAdvisoriesFromAudit(audit);
    expect(out[0].nodes).toEqual([]);
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

  test("baseline with `nodes` blesses subset, rejects new node (Codex P2 round 2)", () => {
    // Baseline pinned a dev-only path. A new node appearing (e.g.,
    // brace-expansion escalates from dev-only to runtime) must
    // fail the gate even though (GHSA, package) match.
    const key = makeBaselineKey("GHSA-W", "brace-expansion");
    const acceptedKeys = new Set([key]);
    const acceptedByKey = new Map([
      [key, { nodes: ["node_modules/brace-expansion"], scope: "both" }]
    ]);
    const subsetAdvisories = [
      {
        ghsa: "GHSA-W",
        package: "brace-expansion",
        severity: "moderate",
        title: "",
        nodes: ["node_modules/brace-expansion"]
      }
    ];
    const newNodeAdvisories = [
      {
        ghsa: "GHSA-W",
        package: "brace-expansion",
        severity: "moderate",
        title: "",
        nodes: [
          "node_modules/brace-expansion",
          "node_modules/express/node_modules/brace-expansion"
        ]
      }
    ];
    expect(diffAdvisoriesAgainstBaseline(subsetAdvisories, acceptedKeys, acceptedByKey).unexpected).toEqual([]);
    const failed = diffAdvisoriesAgainstBaseline(newNodeAdvisories, acceptedKeys, acceptedByKey);
    expect(failed.unexpected).toHaveLength(1);
    expect(failed.unexpected[0].reason).toMatch(/new dependency path/);
    expect(failed.unexpected[0].reason).toMatch(/express/);
  });

  test("audit `nodes: null` fails closed when baseline entry has nodes (CR Major round 3)", () => {
    // npm-audit can omit `nodes` (Arborist drops empty node sets).
    // If a baseline entry pins nodes, the gate must REFUSE to bless
    // when current nodes is null — we can't verify subset.
    const key = makeBaselineKey("GHSA-N", "somepkg");
    const acceptedKeys = new Set([key]);
    const acceptedByKey = new Map([
      [key, { nodes: ["node_modules/somepkg"], scope: "both" }]
    ]);
    const advisories = [
      { ghsa: "GHSA-N", package: "somepkg", severity: "moderate", title: "", nodes: null }
    ];
    const failed = diffAdvisoriesAgainstBaseline(advisories, acceptedKeys, acceptedByKey);
    expect(failed.unexpected).toHaveLength(1);
    expect(failed.unexpected[0].reason).toMatch(/omitted `nodes`/);
  });

  test("scope check: baseline 'dev' rejects current 'prod' (Codex P2 round 3)", () => {
    const key = makeBaselineKey("GHSA-S", "lib");
    const acceptedKeys = new Set([key]);
    const acceptedByKey = new Map([
      [key, { nodes: ["node_modules/lib"], scope: "dev" }]
    ]);
    const advisories = [
      { ghsa: "GHSA-S", package: "lib", severity: "low", title: "", nodes: ["node_modules/lib"] }
    ];
    const scopeByKey = new Map([[key, "prod"]]);
    const failed = diffAdvisoriesAgainstBaseline(advisories, acceptedKeys, acceptedByKey, scopeByKey);
    expect(failed.unexpected).toHaveLength(1);
    expect(failed.unexpected[0].reason).toMatch(/scope escalation/);
    expect(failed.unexpected[0].reason).toMatch(/dev/);
    expect(failed.unexpected[0].reason).toMatch(/prod/);
  });

  test("scope check: baseline 'dev' accepts current 'dev'", () => {
    const key = makeBaselineKey("GHSA-S", "lib");
    const acceptedKeys = new Set([key]);
    const acceptedByKey = new Map([
      [key, { nodes: ["node_modules/lib"], scope: "dev" }]
    ]);
    const advisories = [
      { ghsa: "GHSA-S", package: "lib", severity: "low", title: "", nodes: ["node_modules/lib"] }
    ];
    const scopeByKey = new Map([[key, "dev"]]);
    expect(
      diffAdvisoriesAgainstBaseline(advisories, acceptedKeys, acceptedByKey, scopeByKey).unexpected
    ).toEqual([]);
  });

  test("scope check: baseline 'both' accepts any current scope", () => {
    const key = makeBaselineKey("GHSA-B", "lib");
    const acceptedKeys = new Set([key]);
    const acceptedByKey = new Map([
      [key, { nodes: ["node_modules/lib"], scope: "both" }]
    ]);
    const advisories = [
      { ghsa: "GHSA-B", package: "lib", severity: "low", title: "", nodes: ["node_modules/lib"] }
    ];
    expect(
      diffAdvisoriesAgainstBaseline(
        advisories,
        acceptedKeys,
        acceptedByKey,
        new Map([[key, "prod"]])
      ).unexpected
    ).toEqual([]);
    expect(
      diffAdvisoriesAgainstBaseline(
        advisories,
        acceptedKeys,
        acceptedByKey,
        new Map([[key, "dev"]])
      ).unexpected
    ).toEqual([]);
  });
});

// ---------- computeScopeMap / scopeAllows (pure helpers) ----------

describe("computeScopeMap", () => {
  test('marks "prod" for advisories present in the prod-only audit', () => {
    const full = [
      { ghsa: "GHSA-A", package: "x", severity: "low", title: "", nodes: [] },
      { ghsa: "GHSA-B", package: "y", severity: "low", title: "", nodes: [] }
    ];
    const prod = [{ ghsa: "GHSA-A", package: "x", severity: "low", title: "", nodes: [] }];
    const map = computeScopeMap(full, prod);
    expect(map.get(makeBaselineKey("GHSA-A", "x"))).toBe("prod");
    expect(map.get(makeBaselineKey("GHSA-B", "y"))).toBe("dev");
  });
});

describe("scopeAllows", () => {
  test("dev baseline only allows dev current", () => {
    expect(scopeAllows("dev", "dev")).toBe(true);
    expect(scopeAllows("dev", "prod")).toBe(false);
  });
  test("prod baseline allows both", () => {
    expect(scopeAllows("prod", "dev")).toBe(true);
    expect(scopeAllows("prod", "prod")).toBe(true);
  });
  test("both baseline allows everything", () => {
    expect(scopeAllows("both", "dev")).toBe(true);
    expect(scopeAllows("both", "prod")).toBe(true);
  });
});

// ---------- loadBaseline (file integration) ----------

describe("loadBaseline", () => {
  test("loads the repo's baseline file and returns canonical keys", () => {
    // No non-empty assertion — if the dep tree is fully patched and
    // the baseline legitimately becomes empty, this test should
    // still pass. The shape is what matters: a Set of canonical
    // GHSA|pkg keys + per-entry detail in a Map.
    const { acceptedKeys, acceptedByKey } = loadBaseline();
    expect(acceptedKeys).toBeInstanceOf(Set);
    expect(acceptedByKey).toBeInstanceOf(Map);
    for (const key of acceptedKeys) {
      expect(key).toMatch(/^GHSA-[A-Z0-9-]+\|.+/);
      const entry = acceptedByKey.get(key);
      expect(entry).toBeDefined();
      expect(Array.isArray(entry.nodes)).toBe(true);
      expect(entry.nodes.length).toBeGreaterThan(0);
      expect(["dev", "prod", "both"]).toContain(entry.scope);
    }
  });

  test("missing baseline file throws", () => {
    expect(() => loadBaseline("/no/such/file.json")).toThrow(/missing baseline file/);
  });

  test("strict validation: rejects partial entries (CR Major round 3)", () => {
    // Each missing-field case should throw with a specific message
    // so contributors get a clear pointer to what they forgot.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loadBaseline-strict-"));
    function writeBaseline(json) {
      const p = path.join(tmpDir, "baseline.json");
      fs.writeFileSync(p, JSON.stringify(json));
      return p;
    }
    const fullEntry = {
      ghsa: "GHSA-aaaa-bbbb-cccc",
      package: "lib",
      severity: "moderate",
      title: "x",
      nodes: ["node_modules/lib"],
      scope: "dev",
      rationale: "x"
    };
    try {
      expect(() => loadBaseline(writeBaseline({ accepted: [{ ...fullEntry, ghsa: "bad" }] }))).toThrow(
        /invalid `ghsa`/
      );
      expect(() => loadBaseline(writeBaseline({ accepted: [{ ...fullEntry, package: "" }] }))).toThrow(
        /missing `package`/
      );
      expect(() => loadBaseline(writeBaseline({ accepted: [{ ...fullEntry, severity: "" }] }))).toThrow(
        /missing `severity`/
      );
      expect(() => loadBaseline(writeBaseline({ accepted: [{ ...fullEntry, title: "" }] }))).toThrow(
        /missing `title`/
      );
      expect(() => loadBaseline(writeBaseline({ accepted: [{ ...fullEntry, rationale: "" }] }))).toThrow(
        /missing `rationale`/
      );
      expect(() => loadBaseline(writeBaseline({ accepted: [{ ...fullEntry, nodes: [] }] }))).toThrow(
        /requires a non-empty `nodes` array/
      );
      expect(() => loadBaseline(writeBaseline({ accepted: [{ ...fullEntry, scope: "foo" }] }))).toThrow(
        /invalid `scope`/
      );
      // Full entry should load cleanly.
      expect(() => loadBaseline(writeBaseline({ accepted: [fullEntry] }))).not.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------- End-to-end smoke (shimmed npm; fully offline) ----------
//
// Runs the actual script binary so we catch any regression in how
// the pieces wire together (loadBaseline + runNpmAudit + parse +
// diff + exit code + stderr/stdout). `npm` is shimmed via PATH so
// the test is hermetic — no registry, no network, no dependence on
// what advisories happen to be live today.
//
// The shim is a POSIX shell script (`#!/bin/sh`, `chmod +x`,
// PATH-prepend with `:`), so the smoke is skipped on win32 — the
// gate itself still works on Windows; only this offline smoke
// pathway is platform-specific. Contributors on Windows still get
// the 18 fixture-based unit tests above.

const describeSmoke = process.platform === "win32" ? describe.skip : describe;

describeSmoke("scripts/check-audit.js end-to-end (shimmed npm)", () => {
  function makeFullBaselineEntry(overrides) {
    return {
      ghsa: "GHSA-AAAA-BBBB-CCCC",
      package: "lodash",
      severity: "high",
      title: "Prototype pollution",
      nodes: ["node_modules/lodash"],
      scope: "dev",
      rationale: "test fixture — dev-only",
      ...overrides
    };
  }

  function makeFullAudit() {
    return fixtureAuditWith({
      lodash: {
        severity: "high",
        nodes: ["node_modules/lodash"],
        via: [makeViaObject({ ghsa: "GHSA-aaaa-bbbb-cccc", title: "Prototype pollution" })]
      }
    });
  }

  test("exits 0 when shimmed audit matches the baseline (dev-only scope)", () => {
    const result = runScriptWith({
      baselineJson: { accepted: [makeFullBaselineEntry()] },
      auditFixture: makeFullAudit(),
      prodAuditFixture: fixtureAuditWith({})
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/OK/);
  });

  test("exits 1 when shimmed audit has advisories not in baseline", () => {
    const result = runScriptWith({
      baselineJson: { accepted: [] },
      auditFixture: makeFullAudit(),
      prodAuditFixture: fixtureAuditWith({})
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/FAIL — new advisories not in/);
    expect(result.stderr).toMatch(/GHSA-AAAA-BBBB-CCCC/);
    expect(result.stderr).toMatch(/baseline entry with rationale/);
    expect(result.stderr).toMatch(/All fields are required/);
    expect(result.stderr).toMatch(/scope/);
  });

  test("exits 1 (fail-closed) when shimmed audit returns a transport-error payload", () => {
    // Simulates npm-audit returning {statusCode: 403, message: "forbidden"}.
    const result = runScriptWith({
      baselineJson: { accepted: [] },
      auditFixture: { statusCode: 403, message: "forbidden" },
      prodAuditFixture: fixtureAuditWith({})
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/missing `vulnerabilities` map/);
    expect(result.stderr).not.toMatch(/\bOK\b/);
  });

  test("exits 1 on scope escalation: baseline says dev-only but advisory in prod audit (Codex P2 round 3)", () => {
    // Same advisory, but the prod audit ALSO reports it — so current
    // scope is "prod" — even though baseline blesses only dev. Gate
    // must fail with a clear scope-escalation message.
    const result = runScriptWith({
      baselineJson: { accepted: [makeFullBaselineEntry({ scope: "dev" })] },
      auditFixture: makeFullAudit(),
      prodAuditFixture: makeFullAudit() // same advisory in prod
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/scope escalation/);
    expect(result.stderr).toMatch(/dev/);
    expect(result.stderr).toMatch(/prod/);
  });
});

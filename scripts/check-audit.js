#!/usr/bin/env node
"use strict";

// `npm audit` CI gate (A5 / #118).
//
// Runs `npm audit --json`, extracts every advisory by (GHSA id,
// package) pair, and compares the set against the accepted list in
// `.audit-baseline.json`.
//
//   - If every current advisory is in the baseline → exit 0.
//   - If ANY current advisory is NOT in the baseline → exit 1, printing
//     the diff. CI fails and a human triages: either resolve the
//     advisory (npm update / npm audit fix / pin a replacement), or
//     bless it by adding an `{ghsa, package, severity, title, rationale}`
//     entry to `.audit-baseline.json` after the rationale is written
//     down.
//
// FAIL-CLOSED on npm-audit transport errors. `npm audit --json` can
// return a JSON payload like `{statusCode: 403, message: "..."}` when
// the registry refuses to talk or a proxy is in the way. Previously
// the script accepted that as an empty vulnerability list and printed
// OK, silently disabling the gate during registry outages. The
// validator now rejects audit output that doesn't carry a
// `vulnerabilities` map and exits 1 with a clear error (Codex P1
// on PR #139).
//
// Baseline matching is by (GHSA, package) pair, not GHSA alone.
// A baseline entry blesses an advisory ONLY against the package it
// was triaged for. If the same GHSA later affects a different
// package — say the dev-only ReDoS finds its way into a runtime
// dependency — the gate still fails until the new occurrence is
// triaged separately (Codex P2 on PR #139).
//
// What this file does NOT do:
//   - Override the npm-audit severity classification.
//   - Auto-update the baseline. Drift is intentional — when a fix
//     lands and the advisory disappears, the baseline entry becomes
//     dead and the next baseline-tidy PR removes it.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const baselinePath = path.join(projectRoot, ".audit-baseline.json");

// Canonicalize a GHSA id (uppercase + trim). Some sources use
// lowercase, some uppercase; the baseline normalizes both sides so
// comparison stays stable. Copilot caught this on PR #139.
function canonicalGhsa(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/GHSA-[a-z0-9-]+/i);
  return m ? m[0].toUpperCase() : null;
}

function makeBaselineKey(ghsa, pkg) {
  return `${ghsa}|${pkg}`;
}

function loadBaseline(filePath = baselinePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `[check-audit] missing baseline file at ${filePath}. Create it ` +
        `with an empty accepted list to start: { "accepted": [] }`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`[check-audit] failed to parse baseline JSON: ${err.message}`);
  }
  const acceptedList = Array.isArray(parsed.accepted) ? parsed.accepted : [];
  const acceptedKeys = new Set();
  for (const entry of acceptedList) {
    if (!entry || typeof entry !== "object") continue;
    const ghsa = canonicalGhsa(entry.ghsa);
    const pkg = typeof entry.package === "string" ? entry.package : null;
    if (!ghsa || !pkg) continue;
    acceptedKeys.add(makeBaselineKey(ghsa, pkg));
  }
  return { acceptedList, acceptedKeys };
}

function runNpmAudit() {
  let raw;
  try {
    raw = execFileSync("npm", ["audit", "--json"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (err) {
    // `npm audit` exits non-zero when vulns are present. The JSON
    // payload still arrives on stdout; capture it.
    if (err && err.stdout) {
      raw = err.stdout.toString();
    } else {
      throw new Error(`[check-audit] npm audit failed to run: ${err.message}`);
    }
  }
  return raw;
}

// Validate + parse npm audit output. Throws if the JSON doesn't look
// like a real audit report — closes the fail-open hole that would
// have surfaced as "OK" during a registry outage when npm prints a
// `{statusCode, message}` envelope instead of a vulnerabilities
// report.
function parseAuditOutput(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[check-audit] npm audit output was not valid JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("[check-audit] npm audit output is not a JSON object");
  }
  if (parsed.error) {
    const msg = parsed.error?.summary || parsed.error?.detail || JSON.stringify(parsed.error);
    throw new Error(`[check-audit] npm audit reported an error: ${msg}`);
  }
  // Real audit reports include a `vulnerabilities` map (even when
  // empty). Transport-error payloads (registry 403, network failure)
  // do not. Refusing the latter ensures we fail closed.
  if (!parsed.vulnerabilities || typeof parsed.vulnerabilities !== "object") {
    throw new Error(
      "[check-audit] npm audit output missing `vulnerabilities` map " +
        "(likely a registry/transport error; refusing to mark CI green)"
    );
  }
  return parsed;
}

// Walk the audit's nested `vulnerabilities` map and collect every
// (GHSA id, package) occurrence. The structure is:
//
//   vulnerabilities: {
//     <pkg-name>: {
//       severity, name, ...,
//       via: Array<number | {source, name, url, ...} | string>
//     }
//   }
//
// `via` entries that are OBJECTS with a `url` like
// `https://github.com/advisories/GHSA-...` are primary advisories.
// String / number entries cross-reference other vulns in the map
// (transitively-affected packages) and don't carry their own GHSA
// from the via — we extract directly only from object entries.
function extractAdvisoriesFromAudit(auditJson) {
  const advisories = [];
  const vulns = auditJson?.vulnerabilities || {};
  for (const [pkgName, info] of Object.entries(vulns)) {
    if (!info || !Array.isArray(info.via)) continue;
    for (const via of info.via) {
      if (typeof via !== "object" || !via) continue;
      const ghsa = canonicalGhsa(via.url);
      if (!ghsa) continue;
      advisories.push({
        ghsa,
        package: pkgName,
        severity: info.severity || "unknown",
        title: via.title || "(no title)"
      });
    }
  }
  return advisories;
}

// Pure logic — exported for unit tests. Determines which advisories
// in the current audit are missing from the baseline.
function diffAdvisoriesAgainstBaseline(advisories, acceptedKeys) {
  const seenKeys = new Set();
  const unexpected = [];
  for (const a of advisories) {
    const key = makeBaselineKey(a.ghsa, a.package);
    if (acceptedKeys.has(key)) continue;
    if (seenKeys.has(key)) continue; // de-dupe across multiple via entries
    seenKeys.add(key);
    unexpected.push(a);
  }
  // Also dedupe the OK-path total so the success message reports
  // unique (GHSA, package) pairs, not raw via entries.
  const uniqueKeys = new Set();
  for (const a of advisories) {
    uniqueKeys.add(makeBaselineKey(a.ghsa, a.package));
  }
  return { unexpected, uniqueCount: uniqueKeys.size };
}

function formatRemediationHint() {
  return [
    "",
    "[check-audit] To resolve: either fix the advisory (npm update / npm audit fix /",
    "                          pin a replacement) OR add a baseline entry with rationale:",
    "",
    "    {",
    '      "ghsa": "<GHSA-id>",',
    '      "package": "<package>",',
    '      "severity": "<severity>",',
    '      "title": "<title>",',
    '      "rationale": "<why this is acceptable risk>"',
    "    }",
    "",
    "[check-audit] Baseline matches by (ghsa, package) pair — the same GHSA",
    "              against a different package requires its own entry."
  ].join("\n");
}

function main() {
  let acceptedKeys;
  let auditRaw;
  try {
    ({ acceptedKeys } = loadBaseline());
    auditRaw = runNpmAudit();
  } catch (err) {
    // Top-level handler — print a concise message instead of a
    // stack trace so CI output stays readable (Copilot caught the
    // raw-stack behavior on PR #139).
    console.error(err.message);
    process.exit(1);
  }

  let auditJson;
  try {
    auditJson = parseAuditOutput(auditRaw);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const advisories = extractAdvisoriesFromAudit(auditJson);
  const { unexpected, uniqueCount } = diffAdvisoriesAgainstBaseline(advisories, acceptedKeys);

  if (unexpected.length === 0) {
    if (uniqueCount === 0) {
      console.log("[check-audit] OK — no known npm advisories.");
    } else {
      console.log(
        `[check-audit] OK — ${uniqueCount} unique (advisory × package) ` +
          `pair(s), all listed in .audit-baseline.json.`
      );
    }
    process.exit(0);
  }

  console.error("[check-audit] FAIL — new advisories not in .audit-baseline.json:\n");
  for (const a of unexpected) {
    console.error(`  ${a.ghsa} × ${a.package}  [${a.severity}]`);
    console.error(`    ${a.title}`);
  }
  console.error(formatRemediationHint());
  process.exit(1);
}

module.exports = {
  // Pure helpers exported for testing — no shell-out required.
  canonicalGhsa,
  makeBaselineKey,
  loadBaseline,
  parseAuditOutput,
  extractAdvisoriesFromAudit,
  diffAdvisoriesAgainstBaseline
};

// Run main only when invoked directly, not when require()'d by tests.
if (require.main === module) {
  main();
}

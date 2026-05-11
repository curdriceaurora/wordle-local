#!/usr/bin/env node
"use strict";

// `npm audit` CI gate (A5 / #118).
//
// Runs `npm audit --json`, extracts every advisory by GHSA id, and
// compares the set against the accepted list in `.audit-baseline.json`.
//
//   - If every current advisory is in the baseline → exit 0.
//   - If ANY current advisory is NOT in the baseline → exit 1, printing
//     the diff. CI fails and a human triages: either resolve the
//     advisory (npm update / npm audit fix / pin a replacement), or
//     bless it by adding an `{ghsa, package, severity, title, rationale}`
//     entry to `.audit-baseline.json` after the rationale is written
//     down.
//
// This file is the gate; the baseline file holds the policy. Adding
// an advisory to the baseline is a SECURITY DECISION that should
// happen via PR review, not silently.
//
// What it does NOT do:
//   - Override the npm-audit severity classification.
//   - Auto-update the baseline. Drift is intentional — when a fix
//     lands and the advisory disappears, the baseline entry becomes
//     dead and the next baseline-tidy PR removes it.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const baselinePath = path.join(projectRoot, ".audit-baseline.json");

function loadBaseline() {
  if (!fs.existsSync(baselinePath)) {
    throw new Error(
      `[check-audit] missing baseline file at ${baselinePath}. Create it ` +
        `with an empty accepted list to start: { "accepted": [] }`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch (err) {
    throw new Error(`[check-audit] failed to parse baseline JSON: ${err.message}`);
  }
  const acceptedList = Array.isArray(parsed.accepted) ? parsed.accepted : [];
  const acceptedGhsaSet = new Set();
  for (const entry of acceptedList) {
    if (entry && typeof entry.ghsa === "string") {
      acceptedGhsaSet.add(entry.ghsa);
    }
  }
  return { acceptedList, acceptedGhsaSet };
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
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[check-audit] npm audit output was not valid JSON: ${err.message}`);
  }
  return parsed;
}

// Walk the audit's nested `vulnerabilities` map and collect every
// advisory's GHSA id. The structure is:
//
//   vulnerabilities: {
//     <pkg-name>: {
//       severity, name, ...,
//       via: Array<number | {source, name, url, ...} | string>
//     }
//   }
//
// Each `via` entry that's an OBJECT with a `url` like
// `https://github.com/advisories/GHSA-...` is a primary advisory.
// String / number entries are cross-references back to other vulns
// in the map (transitively-affected packages).
function extractAdvisoriesFromAudit(auditJson) {
  const advisories = [];
  const vulns = auditJson?.vulnerabilities || {};
  for (const [pkgName, info] of Object.entries(vulns)) {
    if (!info || !Array.isArray(info.via)) continue;
    for (const via of info.via) {
      if (typeof via !== "object" || !via) continue;
      const url = typeof via.url === "string" ? via.url : "";
      const ghsaMatch = url.match(/GHSA-[a-z0-9-]+/i);
      if (!ghsaMatch) continue;
      advisories.push({
        ghsa: ghsaMatch[0],
        package: pkgName,
        severity: info.severity || "unknown",
        title: via.title || "(no title)"
      });
    }
  }
  return advisories;
}

function main() {
  const { acceptedGhsaSet } = loadBaseline();
  const auditJson = runNpmAudit();
  const advisories = extractAdvisoriesFromAudit(auditJson);

  const unexpected = advisories.filter((a) => !acceptedGhsaSet.has(a.ghsa));
  if (unexpected.length === 0) {
    const total = advisories.length;
    if (total === 0) {
      console.log("[check-audit] OK — no known npm advisories.");
    } else {
      console.log(
        `[check-audit] OK — ${total} advisory/advisories, all listed in .audit-baseline.json.`
      );
    }
    process.exit(0);
  }

  console.error("[check-audit] FAIL — new advisories not in .audit-baseline.json:\n");
  // Dedupe by GHSA — the same advisory can show up via multiple
  // affected packages.
  const seen = new Set();
  for (const a of unexpected) {
    if (seen.has(a.ghsa)) continue;
    seen.add(a.ghsa);
    console.error(`  ${a.ghsa} [${a.severity}] ${a.package}`);
    console.error(`    ${a.title}`);
  }
  console.error(
    "\n[check-audit] To resolve: either fix the advisory (npm update / npm audit fix /"
  );
  console.error(
    "                          pin a replacement) OR add a baseline entry with rationale:"
  );
  console.error("");
  console.error("    {");
  console.error(`      "ghsa": "<GHSA-id>",`);
  console.error(`      "package": "<package>",`);
  console.error(`      "severity": "<severity>",`);
  console.error(`      "title": "<title>",`);
  console.error(`      "rationale": "<why this is acceptable risk>"`);
  console.error("    }");
  process.exit(1);
}

main();

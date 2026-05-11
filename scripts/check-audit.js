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
// triaged separately (Codex P2 on PR #139, round 1).
//
// Each baseline entry pins dependency-path AND dev/prod scope:
//
//   `nodes` (required, non-empty): the current audit's `nodes` for
//     that advisory must be a subset of the listed paths; any new
//     node fails the gate. If npm-audit omits `nodes` for a
//     scoped advisory (npm can do this for empty node sets), the
//     gate FAILS — we can't verify subset, so we refuse to bless
//     (CodeRabbit Major on PR #139, round 3).
//
//   `scope` ("dev" | "prod" | "both", required): the dependency-tree
//     context the bless applies to. The gate runs npm audit twice —
//     `--omit=dev` for prod scope, then the full audit. If a baseline
//     entry says `scope: "dev"` but the advisory appears in the
//     `--omit=dev` audit, the gate FAILS with a "scope escalation"
//     error: the same vulnerable package now reaches us through a
//     runtime chain and needs fresh triage (Codex P2 on PR #139,
//     round 3 — addresses npm-hoisting blind spot where a top-level
//     `node_modules/<pkg>` path can be shared by dev AND prod deps).
//
// `severity`, `title`, `rationale` (all required strings, non-empty):
//   triage hygiene. Reviewers gate baseline additions on the
//   written rationale; the script refuses to load a baseline entry
//   that lacks any of these fields (CodeRabbit Major on PR #139,
//   round 3 — prevents `{ghsa, package}` entries from silently
//   weakening the gate).
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
// Baseline path can be overridden via env var for tests (so the
// e2e smoke can point at a temp fixture instead of mutating the
// real .audit-baseline.json in the working tree).
const baselinePath =
  process.env.CHECK_AUDIT_BASELINE || path.join(projectRoot, ".audit-baseline.json");

// Canonicalize a GHSA id (uppercase + trim). Some sources use
// lowercase, some uppercase; the baseline normalizes both sides so
// comparison stays stable. Copilot caught this on PR #139.
//
// The regex is intentionally permissive — GitHub's canonical format
// is `GHSA(-[23456789cfghjmpqrvwx]{4}){3}` but we don't enforce it
// here. A typo in `.audit-baseline.json` like `GHSA-foo-bar-baz`
// just becomes a dead baseline entry (it matches no current
// advisory), while the actual advisory it tried to bless surfaces
// as an "unexpected" gate failure. The fail-noisy behavior makes
// strict validation redundant; loose matching keeps tests readable.
function canonicalGhsa(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/GHSA-[a-z0-9-]+/i);
  return m ? m[0].toUpperCase() : null;
}

function makeBaselineKey(ghsa, pkg) {
  return `${ghsa}|${pkg}`;
}

// Allowed values for the `scope` field on a baseline entry.
const VALID_SCOPES = new Set(["dev", "prod", "both"]);

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
  // acceptedByKey holds the per-entry detail (`nodes`, `scope`)
  // needed at diff time. The Set above is kept for cheap membership
  // probes.
  const acceptedByKey = new Map();
  for (const entry of acceptedList) {
    if (!entry || typeof entry !== "object") {
      throw new Error("[check-audit] baseline `accepted` contains a non-object entry");
    }
    // Strict validation — every entry must carry the full triage
    // context. Partial entries silently weaken the gate (CodeRabbit
    // Major on PR #139, round 3).
    const ghsa = canonicalGhsa(entry.ghsa);
    if (!ghsa) {
      throw new Error(`[check-audit] baseline entry has invalid \`ghsa\`: ${JSON.stringify(entry.ghsa)}`);
    }
    const pkg = typeof entry.package === "string" && entry.package.trim() ? entry.package : null;
    if (!pkg) {
      throw new Error(`[check-audit] baseline entry for ${ghsa} missing \`package\``);
    }
    const severity = typeof entry.severity === "string" && entry.severity.trim() ? entry.severity : null;
    if (!severity) {
      throw new Error(`[check-audit] baseline entry for ${ghsa}|${pkg} missing \`severity\``);
    }
    const title = typeof entry.title === "string" && entry.title.trim() ? entry.title : null;
    if (!title) {
      throw new Error(`[check-audit] baseline entry for ${ghsa}|${pkg} missing \`title\``);
    }
    const rationale =
      typeof entry.rationale === "string" && entry.rationale.trim() ? entry.rationale : null;
    if (!rationale) {
      throw new Error(
        `[check-audit] baseline entry for ${ghsa}|${pkg} missing \`rationale\` ` +
          "(baseline blesses are security decisions — write it down)"
      );
    }
    const nodes = Array.isArray(entry.nodes)
      ? entry.nodes.filter((n) => typeof n === "string" && n.trim())
      : null;
    if (!nodes || nodes.length === 0) {
      throw new Error(
        `[check-audit] baseline entry for ${ghsa}|${pkg} requires a non-empty \`nodes\` array ` +
          "(pins the dependency-path scope of the bless)"
      );
    }
    const scope = typeof entry.scope === "string" ? entry.scope : null;
    if (!scope || !VALID_SCOPES.has(scope)) {
      throw new Error(
        `[check-audit] baseline entry for ${ghsa}|${pkg} has invalid \`scope\` ` +
          `(${JSON.stringify(entry.scope)}); expected one of: dev, prod, both`
      );
    }
    const key = makeBaselineKey(ghsa, pkg);
    acceptedKeys.add(key);
    acceptedByKey.set(key, { nodes, scope });
  }
  return { acceptedList, acceptedKeys, acceptedByKey };
}

function runNpmAudit({ prodOnly = false } = {}) {
  const args = ["audit", "--json"];
  if (prodOnly) {
    // `--omit=dev` runs the audit against production deps only,
    // giving us the dev/prod scope signal needed for scope-aware
    // baseline matching (Codex P2 on PR #139, round 3).
    args.push("--omit=dev");
  }
  let raw;
  try {
    raw = execFileSync("npm", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // npm audit JSON for a moderate dep tree easily exceeds Node's
      // 1 MiB default; bump well past that. Bound runtime so a stuck
      // registry / proxy can't park CI indefinitely — the gate fails
      // closed if the timeout fires (caller surfaces the error).
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000
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
    // npm can return either a structured envelope ({summary, detail})
    // or a bare string ({error: "ENETUNREACH"}). Short-circuit the
    // string case so the rendered message doesn't carry extra
    // JSON-quoting (CodeRabbit nit on PR #139 round 4).
    const msg =
      typeof parsed.error === "string"
        ? parsed.error
        : parsed.error?.summary || parsed.error?.detail || JSON.stringify(parsed.error);
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
//
// Assumption — GHSA appears ONLY in `via.url`. We do NOT try to
// recover a GHSA from `via.source` (numeric advisory-DB id, not a
// GHSA) or `via.name` (package name). If npm's JSON ever drifts to
// place a GHSA elsewhere, the gate would silently undercount; the
// OK-path test in tests/check-audit.test.js would catch the
// regression if any advisory disappeared from extraction.
function extractAdvisoriesFromAudit(auditJson) {
  const advisories = [];
  const vulns = auditJson?.vulnerabilities || {};
  for (const [pkgName, info] of Object.entries(vulns)) {
    if (!info || !Array.isArray(info.via)) continue;
    // Fail-closed: distinguish "audit omitted nodes" (null) from
    // "audit reported empty nodes" ([]). The diff step refuses to
    // bless a scoped baseline entry when nodes is null — npm can
    // legitimately omit the field for empty node sets, so a missing
    // `nodes` is ambiguous and we don't trust ambiguity here
    // (CodeRabbit Major on PR #139, round 3).
    const nodes = Array.isArray(info.nodes)
      ? info.nodes.filter((n) => typeof n === "string")
      : null;
    for (const via of info.via) {
      if (typeof via !== "object" || !via) continue;
      const ghsa = canonicalGhsa(via.url);
      if (!ghsa) continue;
      advisories.push({
        ghsa,
        package: pkgName,
        severity: info.severity || "unknown",
        title: via.title || "(no title)",
        nodes
      });
    }
  }
  return advisories;
}

// Compute the dev/prod scope per (GHSA, package) pair. An advisory
// is considered "prod" scope if its (ghsa, package) pair appears in
// the prod-only audit (i.e., npm audit --omit=dev still reports it).
// Otherwise it's "dev" scope — only reached through dev dependencies.
//
// Invariant: `prodAdvisories ⊆ fullAdvisories`. `npm audit --json`
// (the full run) returns the union of dev + prod vulnerabilities;
// `npm audit --json --omit=dev` returns a strict subset. We populate
// `scopeByKey` only from the full audit because the diff loop
// downstream iterates full advisories. A prod-only-not-in-full entry
// would indicate a bug in npm-audit (e.g., a cache race between the
// two execFileSync calls) and is not defensively handled here —
// the gate would simply fail to attach a scope to that advisory,
// which falls through to the (GHSA, package) match and is still
// safer than silently blessing.
function computeScopeMap(fullAdvisories, prodAdvisories) {
  const prodKeys = new Set();
  for (const a of prodAdvisories) {
    prodKeys.add(makeBaselineKey(a.ghsa, a.package));
  }
  const scopeByKey = new Map();
  for (const a of fullAdvisories) {
    const key = makeBaselineKey(a.ghsa, a.package);
    scopeByKey.set(key, prodKeys.has(key) ? "prod" : "dev");
  }
  return scopeByKey;
}

// Pure logic — exported for unit tests. Determines which advisories
// in the current audit are missing from the baseline. Single pass:
// `uniqueKeys` tracks every (GHSA, package) pair seen (drives the
// OK-path total), `seenUnexpected` dedupes the failure list across
// multiple via entries.
//
// `acceptedByKey` (Map of key → {nodes, scope}) carries per-entry
// detail. The diff enforces:
//   - (GHSA, package) match — same as before.
//   - `nodes` subset — current audit's nodes for that advisory
//     must be a subset of the baseline's pinned `nodes`. If audit
//     omits `nodes` (a === null), the entry fails closed.
//   - scope match — `scopeByKey` (if provided) gives the current
//     scope per advisory ("dev" or "prod"). The baseline's `scope`
//     value scopes the bless: "dev" rejects current "prod" (scope
//     escalation), "prod" accepts either, "both" always accepts.
function diffAdvisoriesAgainstBaseline(advisories, acceptedKeys, acceptedByKey, scopeByKey) {
  const seenUnexpected = new Set();
  const uniqueKeys = new Set();
  const unexpected = [];
  for (const a of advisories) {
    const key = makeBaselineKey(a.ghsa, a.package);
    uniqueKeys.add(key);
    let accepted = acceptedKeys.has(key);
    let reason = null;
    if (accepted && acceptedByKey instanceof Map) {
      const entry = acceptedByKey.get(key);
      if (entry && Array.isArray(entry.nodes) && entry.nodes.length > 0) {
        if (!Array.isArray(a.nodes)) {
          accepted = false;
          reason =
            "audit output omitted `nodes`; cannot verify dependency-path scope " +
            "(scoped baseline entry refused fail-closed)";
        } else {
          const allowed = new Set(entry.nodes);
          const newNodes = a.nodes.filter((n) => !allowed.has(n));
          if (newNodes.length > 0) {
            accepted = false;
            reason = `new dependency path(s): ${newNodes.join(", ")}`;
          }
        }
      }
      if (accepted && entry && entry.scope && scopeByKey instanceof Map) {
        const currentScope = scopeByKey.get(key);
        if (currentScope && !scopeAllows(entry.scope, currentScope)) {
          accepted = false;
          reason = `scope escalation: baseline blesses "${entry.scope}", current is "${currentScope}"`;
        }
      }
    }
    if (accepted) continue;
    if (seenUnexpected.has(key)) continue;
    seenUnexpected.add(key);
    unexpected.push(reason ? { ...a, reason } : a);
  }
  return { unexpected, uniqueCount: uniqueKeys.size };
}

// Does a baseline scope value allow a current scope?
//   - baseline "both" — always.
//   - baseline "prod" — accepts "prod" or "dev" (weaker scope is fine).
//   - baseline "dev"  — accepts only "dev" (current "prod" is an
//                       escalation that requires re-triage).
function scopeAllows(baselineScope, currentScope) {
  if (baselineScope === "both") return true;
  if (baselineScope === "prod") return true;
  if (baselineScope === "dev") return currentScope === "dev";
  return false;
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
    '      "nodes": ["node_modules/<path>"],',
    '      "scope": "dev" | "prod" | "both",',
    '      "rationale": "<why this is acceptable risk>"',
    "    }",
    "",
    "[check-audit] All fields are required. Baseline matches by (ghsa, package)",
    "              pair AND nodes-subset AND scope: a new dependency path or a",
    "              dev→prod escalation fails the gate until re-triaged."
  ].join("\n");
}

function main() {
  let acceptedKeys;
  let acceptedByKey;
  let auditRaw;
  let auditProdRaw;
  try {
    ({ acceptedKeys, acceptedByKey } = loadBaseline());
    auditRaw = runNpmAudit();
    auditProdRaw = runNpmAudit({ prodOnly: true });
  } catch (err) {
    // Top-level handler — print a concise message instead of a
    // stack trace so CI output stays readable (Copilot caught the
    // raw-stack behavior on PR #139).
    console.error(err.message);
    process.exit(1);
  }

  let auditJson;
  let auditProdJson;
  try {
    auditJson = parseAuditOutput(auditRaw);
    auditProdJson = parseAuditOutput(auditProdRaw);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const advisories = extractAdvisoriesFromAudit(auditJson);
  const prodAdvisories = extractAdvisoriesFromAudit(auditProdJson);
  const scopeByKey = computeScopeMap(advisories, prodAdvisories);
  const { unexpected, uniqueCount } = diffAdvisoriesAgainstBaseline(
    advisories,
    acceptedKeys,
    acceptedByKey,
    scopeByKey
  );

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
    if (a.reason) {
      console.error(`    reason: ${a.reason}`);
    }
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
  computeScopeMap,
  diffAdvisoriesAgainstBaseline,
  scopeAllows
};

// Run main only when invoked directly, not when require()'d by tests.
if (require.main === module) {
  main();
}

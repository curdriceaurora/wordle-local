#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

function readFile(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function parseJson(relativePath) {
  return JSON.parse(readFile(relativePath));
}

function parseQuotedValues(source) {
  const matches = source.matchAll(/"([^"]+)"/g);
  return Array.from(matches, (match) => match[1]);
}

function checkProviderVariantAllowlist(errors) {
  const sharedSource = readFile("lib/provider-artifact-shared.js");
  const arrayMatch = sharedSource.match(
    /SUPPORTED_VARIANT_IDS\s*=\s*Object\.freeze\(\[(?<items>[\s\S]*?)\]\);/
  );
  if (!arrayMatch || !arrayMatch.groups || !arrayMatch.groups.items) {
    errors.push("lib/provider-artifact-shared.js must define SUPPORTED_VARIANT_IDS as an explicit array.");
    return;
  }
  const values = parseQuotedValues(arrayMatch.groups.items);
  const expected = ["en-GB", "en-US", "en-CA", "en-AU", "en-ZA"];
  if (values.length !== expected.length || values.some((value, idx) => value !== expected[idx])) {
    errors.push(
      `SUPPORTED_VARIANT_IDS must match ${expected.join(", ")} exactly (current: ${values.join(", ")}).`
    );
  }

  const hunspellSource = readFile("lib/provider-hunspell.js");
  if (!hunspellSource.includes("new Set(SUPPORTED_VARIANT_IDS)")) {
    errors.push("lib/provider-hunspell.js must derive SUPPORTED_VARIANTS from shared SUPPORTED_VARIANT_IDS.");
  }

  const poolSource = readFile("lib/provider-pool-policy.js");
  if (!poolSource.includes("new Set(SUPPORTED_VARIANT_IDS)")) {
    errors.push("lib/provider-pool-policy.js must derive SUPPORTED_VARIANTS from shared SUPPORTED_VARIANT_IDS.");
  }
}

function checkLanguageSchemaDictionaryCoupling(errors) {
  const schema = parseJson("data/languages.schema.json");
  const entry = schema?.$defs?.languageEntry;
  if (!entry || typeof entry !== "object") {
    errors.push("data/languages.schema.json is missing $defs.languageEntry.");
    return;
  }
  const rules = Array.isArray(entry.allOf) ? entry.allOf : [];
  const hasTrueRule = rules.some((rule) => (
    rule?.if?.properties?.hasDictionary?.const === true
    && rule?.then?.properties?.dictionaryFile?.type === "string"
  ));
  const hasFalseRule = rules.some((rule) => (
    rule?.if?.properties?.hasDictionary?.const === false
    && rule?.then?.properties?.dictionaryFile?.type === "null"
  ));
  if (!hasTrueRule || !hasFalseRule) {
    errors.push(
      "languages.schema.json must enforce hasDictionary<->dictionaryFile coupling with conditional rules."
    );
  }
}

function checkProviderDiagnosticsContract(errors) {
  const serverSource = readFile("server.js");
  if (!serverSource.includes("warning:")) {
    errors.push("server.js provider status rows must expose warning diagnostics for usable variants.");
  }
  if (!serverSource.includes('error: status === "error" ? incompleteDetails : null')) {
    errors.push("server.js must keep provider `error` field exclusive to status=\"error\".");
  }
  if (!serverSource.includes('status === "enabled" || status === "imported"')) {
    errors.push("server.js must classify usable provider variants as warning-bearing (not error) when incomplete commits exist.");
  }

  const adminAppSource = readFile("public/admin/app.js");
  if (!adminAppSource.includes("provider.error") || !adminAppSource.includes("provider.warning")) {
    errors.push("public/admin/app.js must render provider error/warning diagnostics from API payload.");
  }
  if (!adminAppSource.includes("admin-provider-status-detail")) {
    errors.push("public/admin/app.js must render provider diagnostics as a visible secondary status detail.");
  }
}

function checkProviderWorkflowCiGate(errors) {
  const ciWorkflow = readFile(".github/workflows/ci.yml");
  if (!ciWorkflow.includes("Run Provider Workflow UI Regression Gate")) {
    errors.push("ci.yml must include an explicit provider workflow UI regression gate step.");
  }
  if (!ciWorkflow.includes("npm run test:provider:ui")) {
    errors.push("ci.yml provider workflow gate must execute npm run test:provider:ui.");
  }
  const requiredProviderFilterPaths = [
    "'server.js'",
    "'lib/admin-auth.js'",
    "'lib/provider-*.js'",
    "'public/admin/**'",
    "'tests/ui/admin-shell.spec.js'",
    "'tests/ui/fixtures.js'"
  ];
  requiredProviderFilterPaths.forEach((pattern) => {
    if (!ciWorkflow.includes(pattern)) {
      errors.push(
        `ci.yml provider_workflow path filter must include ${pattern} to avoid skipping provider UI gates.`
      );
    }
  });
}

function checkProviderUpdateCheckSemantics(errors) {
  const serverSource = readFile("server.js");
  const resolverStart = serverSource.indexOf("function resolveCurrentProviderCommitForUpdateCheck");
  if (resolverStart < 0) {
    errors.push("server.js must define resolveCurrentProviderCommitForUpdateCheck.");
  } else {
    const resolverBody = serverSource.slice(resolverStart, resolverStart + 700);
    if (resolverBody.includes("listImportableProviderCommits(")) {
      errors.push(
        "resolveCurrentProviderCommitForUpdateCheck must not infer current commit from importable commit lists."
      );
    }
  }

  const adminAppSource = readFile("public/admin/app.js");
  if (adminAppSource.includes("state.providerUpdates[provider.variant] = response")) {
    errors.push(
      "public/admin/app.js must not store full update-check response payload in providerUpdates state."
    );
  }
}

function checkManualUploadGuardrails(errors) {
  const serverSource = readFile("server.js");
  const adminRouteSource = readFile("routes/admin.js");
  if (!adminRouteSource.includes("parseProviderImportSource(")) {
    errors.push("routes/admin.js must validate provider import sourceType explicitly.");
  }
  if (!serverSource.includes("persistManualProviderSource(") && !adminRouteSource.includes("persistManualProviderSource(")) {
    errors.push(
      "Manual upload imports must route through persistManualProviderSource (in server.js or routes/admin.js)."
    );
  }
  if (!serverSource.includes("PROVIDER_MANUAL_MAX_FILE_BYTES")) {
    errors.push("server.js must enforce a provider manual upload max file size guardrail.");
  }
  if (!serverSource.includes("express.json({ limit: JSON_BODY_LIMIT })")) {
    errors.push("server.js must set an explicit JSON body limit for admin upload payloads.");
  }

  const adminAppSource = readFile("public/admin/app.js");
  if (!adminAppSource.includes("sourceType")) {
    errors.push("public/admin/app.js must include sourceType in provider import payloads.");
  }
  if (!adminAppSource.includes("manualFiles")) {
    errors.push("public/admin/app.js must send manualFiles payload for manual imports.");
  }
  if (!adminAppSource.includes("sha256Hex(")) {
    errors.push("public/admin/app.js manual import path must compute and send SHA-256 checksums.");
  }
}

function run() {
  const errors = [];

  const adminAuth = readFile("lib/admin-auth.js");
  if (!adminAuth.includes("timingSafeEqual")) {
    errors.push("lib/admin-auth.js must use timingSafeEqual for admin key comparison.");
  }
  if (/req\.headers\["x-admin-key"\]\s*===\s*adminKey/.test(adminAuth)) {
    errors.push("lib/admin-auth.js must not compare x-admin-key to adminKey with ===.");
  }

  const providerHunspell = readFile("lib/provider-hunspell.js");
  if (/localeCompare\s*\(/.test(providerHunspell)) {
    errors.push("lib/provider-hunspell.js must avoid localeCompare for deterministic artifact ordering.");
  }
  if (!providerHunspell.includes("resolveLengthBounds(")) {
    errors.push("lib/provider-hunspell.js must enforce fixed gameplay length bounds via resolveLengthBounds.");
  }
  if (providerHunspell.includes("path.relative(outputRoot, sourceManifestPath)")) {
    errors.push("lib/provider-hunspell.js must not derive sourceManifestPath relative to outputRoot.");
  }
  checkProviderVariantAllowlist(errors);

  const languageRegistry = readFile("lib/language-registry.js");
  if (/localeCompare\s*\(/.test(languageRegistry)) {
    errors.push("lib/language-registry.js must avoid localeCompare for deterministic persisted ordering.");
  }
  if (!languageRegistry.includes("if (hasDictionary && !dictionaryFile)")) {
    errors.push("lib/language-registry.js must reject hasDictionary=true with null dictionaryFile.");
  }
  if (!languageRegistry.includes("if (!hasDictionary && dictionaryFile !== null)")) {
    errors.push("lib/language-registry.js must reject hasDictionary=false with non-null dictionaryFile.");
  }

  const providerPoolPolicy = readFile("lib/provider-pool-policy.js");
  if (providerPoolPolicy.includes("path.resolve(providerRoot, relativePath)")) {
    errors.push(
      "lib/provider-pool-policy.js must reuse resolveWithinRoot for allowlist path boundary checks."
    );
  }
  if (!providerPoolPolicy.includes("resolveWithinSharedRoot")) {
    errors.push("lib/provider-pool-policy.js must use shared provider artifact boundary helpers.");
  }

  const providerAnswerFilter = readFile("lib/provider-answer-filter.js");
  if (!providerAnswerFilter.includes("resolveWithinSharedRoot")) {
    errors.push("lib/provider-answer-filter.js must use shared provider artifact boundary helpers.");
  }
  if (!providerAnswerFilter.includes("writeSharedFileAtomic")) {
    errors.push("lib/provider-answer-filter.js must use shared atomic write helpers.");
  }
  if (providerAnswerFilter.includes("path.resolve(providerRoot, relativePath)")) {
    errors.push(
      "lib/provider-answer-filter.js must avoid manual providerRoot path resolution for list files."
    );
  }

  checkLanguageSchemaDictionaryCoupling(errors);
  checkProviderDiagnosticsContract(errors);
  checkProviderWorkflowCiGate(errors);
  checkProviderUpdateCheckSemantics(errors);
  checkManualUploadGuardrails(errors);
  checkClientSideHtmlInjectionSurface(errors);

  if (errors.length > 0) {
    console.error("[nit:guardrails] Failed:");
    errors.forEach((error, idx) => {
      console.error(`${idx + 1}. ${error}`);
    });
    process.exit(1);
  }

  console.log("[nit:guardrails] OK: critical anti-regression guardrails are in place.");
}

// A1 / #114: keep client-side HTML-injection surface small. The
// current admin shell uses `textContent =` and DOM-construction APIs
// (createElement + appendChild) for every dynamic-content path, so
// the XSS surface is already minimal. This guard flags any future
// `innerHTML = <expression>` / `outerHTML = <expression>` /
// `insertAdjacentHTML(...)` site in the watched files (which cover
// `public/app.js`, `public/admin/app.js`, and the inline <script>
// blocks in `public/admin/classroom-report.html`) where the
// right-hand side isn't an empty-string literal.
//
// Policy: an entry in `auditedAllowlist` MAY contain interpolated
// segments only if every non-constant segment is passed through
// `window.escapeHtml` (loaded from `/js/escape-html.js`). New plain
// dynamic HTML must route through `window.escapeHtml` AND add a
// signature to the allowlist below. The signature is a substring
// of the actual line content (not a file:line tuple) so unrelated
// edits above the sink don't break this guard and a different
// future sink can't silently steal an allowlisted line number.
function checkClientSideHtmlInjectionSurface(errors) {
  const watchedFiles = [
    "public/app.js",
    "public/admin/app.js",
    // Inline <script> blocks inside this HTML file. The guard treats
    // the whole file as JS for grep purposes — false positives on
    // attribute-named "innerHTML" would have to start with a literal
    // dot, which never happens in HTML attribute syntax.
    "public/admin/classroom-report.html"
  ];
  // Substrings of audited sink lines. Each entry must uniquely match
  // ONE current line in the watched files; the matched line must be a
  // constant string literal (no `${}`, no identifier interpolation)
  // OR every interpolated segment must be passed through
  // `window.escapeHtml`. Update this list when you intentionally
  // introduce or remove a sink.
  const auditedAllowlist = [
    // public/app.js: constant fallback row for empty leaderboard.
    'row.innerHTML = \'<td class="leaderboard-empty"'
  ];
  // Match `.innerHTML =`, `.outerHTML =`, `.insertAdjacentHTML(`.
  const sinkPattern = /\.(innerHTML|outerHTML)\s*=|\.insertAdjacentHTML\s*\(/;
  // Empty-string literal (the dominant safe pattern: clear-and-rebuild
  // before DOM construction). Permits "" or ''.
  const emptyStringRhs = /\.(innerHTML|outerHTML)\s*=\s*['"]['"]\s*;?\s*$/;
  for (const relPath of watchedFiles) {
    const source = readFile(relPath);
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!sinkPattern.test(line)) continue;
      if (emptyStringRhs.test(line.trim())) continue;
      if (auditedAllowlist.some((sig) => line.includes(sig))) continue;
      errors.push(
        `${relPath}:${i + 1} introduces an HTML-injection sink — route ` +
          "the value through `window.escapeHtml` (loaded from " +
          "/js/escape-html.js) and add a substring signature for this " +
          "line to the audited allowlist in scripts/nit-guardrails.js " +
          "(A1 / #114)."
      );
    }
  }
}

run();

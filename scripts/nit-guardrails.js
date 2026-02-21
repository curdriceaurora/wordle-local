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

  checkLanguageSchemaDictionaryCoupling(errors);

  if (errors.length > 0) {
    console.error("[nit:guardrails] Failed:");
    errors.forEach((error, idx) => {
      console.error(`${idx + 1}. ${error}`);
    });
    process.exit(1);
  }

  console.log("[nit:guardrails] OK: critical anti-regression guardrails are in place.");
}

run();

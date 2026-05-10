#!/usr/bin/env node
"use strict";

// i18n coverage gate.
//
// Walks public/index.html, public/admin/index.html, public/app.js,
// public/admin/app.js for `data-i18n="…"`, `data-i18n-attr="…"`, and
// runtime `i18n.t("…")` references. Asserts:
//   1. Every referenced key resolves to a string in `public/locales/en.json`.
//   2. `public/locales/en.json` and `public/locales/es.json` have
//      identical key sets (after collapsing plural suffixes).
//
// Pluralization: keys ending in `_one`/`_other`/`_zero`/`_two`/`_few`/
// `_many` are treated as variants of the base key. They count as
// covered if EITHER the bare key OR any plural variant exists.
//
// Exits non-zero if any assertion fails.

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const localesDir = path.join(projectRoot, "public", "locales");
const SCAN_FILES = [
  "public/index.html",
  "public/admin/index.html",
  "public/app.js",
  "public/admin/app.js"
];

const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectKeys(obj, prefix = "") {
  const out = new Set();
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const dotted = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") {
      out.add(dotted);
    } else if (v && typeof v === "object") {
      for (const sub of collectKeys(v, dotted)) out.add(sub);
    }
  }
  return out;
}

// Strip a trailing plural suffix from a key. `score.heading` → `score.heading`.
// `summary_one` → `summary`. `prefix.label_other` → `prefix.label`.
function stripPluralSuffix(key) {
  for (const suffix of PLURAL_SUFFIXES) {
    if (key.endsWith(suffix)) {
      return key.slice(0, key.length - suffix.length);
    }
  }
  return key;
}

function findReferencesInSource(source) {
  const refs = new Set();
  // data-i18n="key"
  const attrPattern = /data-i18n\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = attrPattern.exec(source)) !== null) {
    refs.add(match[1].trim());
  }
  // data-i18n='key'
  const attrSinglePattern = /data-i18n\s*=\s*'([^']+)'/g;
  while ((match = attrSinglePattern.exec(source)) !== null) {
    refs.add(match[1].trim());
  }
  // data-i18n-attr="placeholder:key;aria-label:key"
  const kindPattern = /data-i18n-attr\s*=\s*"([^"]+)"/g;
  while ((match = kindPattern.exec(source)) !== null) {
    const spec = match[1];
    for (const entry of spec.split(";")) {
      const pair = entry.split(":");
      if (pair.length === 2) refs.add(pair[1].trim());
    }
  }
  // i18n.t("key")
  const tPattern = /i18n\.t\s*\(\s*["']([^"']+)["']/g;
  while ((match = tPattern.exec(source)) !== null) {
    refs.add(match[1].trim());
  }
  return refs;
}

function fail(message) {
  console.error(`[i18n:check] ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`[i18n:check] ${message}`);
}

function main() {
  // Load locales.
  const enPath = path.join(localesDir, "en.json");
  const esPath = path.join(localesDir, "es.json");
  if (!fs.existsSync(enPath)) {
    fail(`missing ${enPath}`);
    return;
  }
  if (!fs.existsSync(esPath)) {
    fail(`missing ${esPath}`);
    return;
  }
  const en = readJson(enPath);
  const es = readJson(esPath);
  const enKeys = collectKeys(en);
  const esKeys = collectKeys(es);

  // Parity check: en and es must have the same key set.
  const onlyInEn = [...enKeys].filter((k) => !esKeys.has(k));
  const onlyInEs = [...esKeys].filter((k) => !enKeys.has(k));
  if (onlyInEn.length > 0) {
    fail(`keys present in en.json but missing in es.json:\n  ${onlyInEn.join("\n  ")}`);
  }
  if (onlyInEs.length > 0) {
    fail(`keys present in es.json but missing in en.json:\n  ${onlyInEs.join("\n  ")}`);
  }

  // Coverage check: every reference in source files must resolve in en.
  const allReferences = new Set();
  for (const rel of SCAN_FILES) {
    const filePath = path.join(projectRoot, rel);
    if (!fs.existsSync(filePath)) {
      console.warn(`[i18n:check] WARN: ${rel} not found`);
      continue;
    }
    const source = fs.readFileSync(filePath, "utf8");
    const refs = findReferencesInSource(source);
    for (const r of refs) allReferences.add(r);
  }

  // For each reference, check if a matching key (or any plural variant)
  // exists in en.json. A bare reference like "stats.daysAgo" resolves
  // if "stats.daysAgo_one" or "stats.daysAgo_other" etc. exist.
  const missing = [];
  for (const ref of allReferences) {
    if (enKeys.has(ref)) continue;
    let found = false;
    for (const suffix of PLURAL_SUFFIXES) {
      if (enKeys.has(ref + suffix)) { found = true; break; }
    }
    if (!found) missing.push(ref);
  }
  if (missing.length > 0) {
    fail(`references in source not found in en.json:\n  ${missing.join("\n  ")}`);
  }

  // Orphan-key check: keys in locale files that no source references.
  // Skip any key that is a plural variant whose base IS referenced.
  // Soft-allowed namespaces are utility keys consumed by dynamic
  // strings (HTTP error JSON via `Accept-Language`, runtime status
  // copy that doesn't appear in HTML literals, future migrations).
  // Surfacing them as orphans would be noise; the parity check still
  // catches typos because every soft-allowed key must exist in BOTH
  // locale files.
  const SOFT_ALLOW_PREFIXES = [
    "admin.",
    "common.",
    "error.",
    "share.",
    "stats.",
    "play.solved",
    "play.guess",
    "challenge.timer"
  ];
  const orphans = [];
  for (const key of enKeys) {
    if (allReferences.has(key)) continue;
    const base = stripPluralSuffix(key);
    if (allReferences.has(base)) continue;
    if (SOFT_ALLOW_PREFIXES.some((p) => key.startsWith(p))) continue;
    orphans.push(key);
  }
  if (orphans.length > 0) {
    fail(`keys in en.json with no matching reference (orphans):\n  ${orphans.join("\n  ")}`);
  }

  if (process.exitCode === 1) {
    return;
  }
  ok(`${allReferences.size} references covered; en.json + es.json have ${enKeys.size} keys at parity`);
}

main();

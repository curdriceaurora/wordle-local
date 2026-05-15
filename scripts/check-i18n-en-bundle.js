#!/usr/bin/env node
"use strict";

// Verifies that `public/js/i18n-en.js` is in sync with
// `public/locales/en.json`. Run in `npm run check` to catch drift
// (someone edited en.json without regenerating the bundle).
//
// Drift signature: the static `public/js/i18n-en.js` ships to the
// Vercel deploy as the SW-precached default-locale pre-bundle. If
// it's out of sync with en.json, returning users see stale strings
// after the bundle reloads. If it's malformed, SW `cache.addAll()`
// rejects and PWA install fails on Vercel. See
// `scripts/build-i18n-en-bundle.js` for the regenerate flow.

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const bundlePath = path.join(repoRoot, "public", "js", "i18n-en.js");
const enJsonPath = path.join(repoRoot, "public", "locales", "en.json");

function buildExpected() {
  const enJson = fs.readFileSync(enJsonPath, "utf8");
  JSON.parse(enJson);
  const header = [
    "// AUTO-GENERATED from public/locales/en.json.",
    "// Do NOT edit by hand. Run `node scripts/build-i18n-en-bundle.js`",
    "// to regenerate. `npm run check` verifies these files stay in sync.",
    "//",
    "// Loaded BEFORE /js/i18n.js in both shells so the default-locale",
    "// messages are available synchronously — eliminates the race where",
    "// a slow fetch of /locales/en.json left every i18n.t() returning",
    "// the literal key. PR #214."
  ].join("\n");
  return `${header}\nwindow.__i18nMessagesEn = ${enJson};\n`;
}

const expectedBody = buildExpected();
const actualBody = fs.readFileSync(bundlePath, "utf8");

if (expectedBody !== actualBody) {
  console.error("[check:i18n-en-bundle] FAIL: public/js/i18n-en.js is out of sync with public/locales/en.json.");
  console.error("[check:i18n-en-bundle] Run `node scripts/build-i18n-en-bundle.js` to regenerate.");
  process.exit(1);
}

console.log("[check:i18n-en-bundle] OK: public/js/i18n-en.js matches public/locales/en.json");

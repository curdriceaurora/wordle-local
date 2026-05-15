#!/usr/bin/env node
"use strict";

// Regenerates `public/js/i18n-en.js` from `public/locales/en.json`.
// Usage:
//   node scripts/build-i18n-en-bundle.js
//
// Why this exists: the Vercel gameplay-only deploy serves `public/`
// directly as static files (vercel.json has buildCommand: ""), so
// the Express `/js/i18n-en.js` server route never runs there. The
// service worker precache (#214) needs a real static file at this
// URL or `cache.addAll()` rejects on 404 and PWA install aborts.
// We ship a checked-in generated file and verify drift in
// `npm run check` via `scripts/check-i18n-en-bundle.js`.

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const enJsonPath = path.join(repoRoot, "public", "locales", "en.json");
const outPath = path.join(repoRoot, "public", "js", "i18n-en.js");

const enJson = fs.readFileSync(enJsonPath, "utf8");
// Parse-and-stringify validates the JSON; writing the raw text
// preserves the canonical formatting (which `check-i18n-en-bundle.js`
// also compares verbatim).
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

const body = `${header}\nwindow.__i18nMessagesEn = ${enJson};\n`;
fs.writeFileSync(outPath, body);

console.log(`[build-i18n-en-bundle] wrote ${outPath} (${body.length} bytes)`);

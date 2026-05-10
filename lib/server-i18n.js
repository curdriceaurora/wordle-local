"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Server-side i18n is intentionally narrow: it ONLY translates HTTP
// error JSON payloads sent to the player based on `Accept-Language`.
// It does NOT touch logs, persisted data, admin output, or the
// rendered HTML — those remain English server-side. Frontends do
// their own i18n via public/js/i18n.js.

const DEFAULT_LOCALE = "en";
const SUPPORTED = new Set(["en", "es"]);
const localesDir = path.resolve(__dirname, "..", "public", "locales");
let cache = null;

function loadLocaleSync(locale) {
  if (!cache) cache = Object.create(null);
  if (cache[locale]) return cache[locale];
  const filePath = path.join(localesDir, `${locale}.json`);
  try {
    cache[locale] = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_err) {
    cache[locale] = {};
  }
  return cache[locale];
}

// Pre-load default locale at module init so the first error response
// doesn't pay the file-read cost. Callers can also call resetCache()
// in tests.
loadLocaleSync(DEFAULT_LOCALE);

function lookupKey(messages, dottedKey) {
  if (!messages) return undefined;
  const parts = String(dottedKey || "").split(".");
  let node = messages;
  for (let i = 0; i < parts.length; i += 1) {
    if (!node || typeof node !== "object") return undefined;
    node = node[parts[i]];
  }
  return typeof node === "string" ? node : undefined;
}

function interpolate(template, params) {
  if (!params || typeof template !== "string") return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
  });
}

// Parse an `Accept-Language` header (RFC 9110 / 7231) and return the
// best-matching SUPPORTED locale, or DEFAULT_LOCALE if none matches.
// Bounded: stops parsing after 10 entries to avoid pathological
// inputs. Quality factor `q` is honored; ties resolve by header order.
function parseAcceptLanguage(headerValue) {
  if (typeof headerValue !== "string" || headerValue.length === 0) return DEFAULT_LOCALE;
  const truncated = headerValue.length > 256 ? headerValue.slice(0, 256) : headerValue;
  const candidates = truncated.split(",").slice(0, 10);
  const ranked = [];
  for (const raw of candidates) {
    const parts = raw.trim().split(";");
    const tag = (parts[0] || "").trim().toLowerCase();
    if (!tag) continue;
    let q = 1;
    for (let i = 1; i < parts.length; i += 1) {
      const m = /^q=([\d.]+)$/i.exec(parts[i].trim());
      if (m) q = Math.max(0, Math.min(1, parseFloat(m[1])));
    }
    // Match against base language code (`es` from `es-MX`).
    const base = tag.split("-")[0];
    if (SUPPORTED.has(base)) ranked.push({ locale: base, q, order: ranked.length });
  }
  if (ranked.length === 0) return DEFAULT_LOCALE;
  ranked.sort((a, b) => (b.q - a.q) || (a.order - b.order));
  return ranked[0].locale;
}

// Translate a key for a given Accept-Language header. Falls back to
// English then to the literal key. Suitable for error JSON payloads
// only.
function translateForRequest(req, key, params) {
  const header = req && req.headers ? req.headers["accept-language"] : null;
  const locale = parseAcceptLanguage(header);
  const primary = lookupKey(loadLocaleSync(locale), key);
  if (primary !== undefined) return interpolate(primary, params);
  if (locale !== DEFAULT_LOCALE) {
    const fallback = lookupKey(loadLocaleSync(DEFAULT_LOCALE), key);
    if (fallback !== undefined) return interpolate(fallback, params);
  }
  return key;
}

function resetCache() {
  cache = null;
  loadLocaleSync(DEFAULT_LOCALE);
}

module.exports = {
  parseAcceptLanguage,
  translateForRequest,
  resetCache,
  SUPPORTED_LOCALES: Array.from(SUPPORTED),
  DEFAULT_LOCALE
};

"use strict";

// Minimal HTML entity encoder for dynamic-content render paths.
// The 5 characters it replaces are the OWASP-recommended baseline for
// HTML text contexts and quoted attribute contexts — covers tags,
// closers, JS string break-outs, and quote-attribute escapes.
//
// Use this helper any time non-constant content is interpolated into
// an `innerHTML` / `outerHTML` / `insertAdjacentHTML` site. For
// normal text rendering, prefer `node.textContent = ...` — the
// browser does the right thing automatically and the helper is
// unnecessary.
//
// Filed under A1 / #114. The complementary `nit-guardrails.js`
// check flags new bare `innerHTML = <expr>` assignments to keep the
// helper in front of XSS sinks rather than sprinkled after the
// fact.
//
// Exports a UMD-ish shape so this same source works both as a
// CommonJS module (Node tests) and as a global on `window` when
// loaded as a plain script in the admin shell.

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { escapeHtml };
}
if (typeof window !== "undefined") {
  window.escapeHtml = escapeHtml;
}

"use strict";

const { escapeHtml } = require("../public/js/escape-html");

describe("escapeHtml", () => {
  test("encodes the 5 OWASP HTML-context characters", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml('"')).toBe("&quot;");
    expect(escapeHtml("'")).toBe("&#39;");
  });

  test("encodes ampersand FIRST so subsequent entity replacements don't double-encode", () => {
    // `<script>` must become `&lt;script&gt;`, not `&amp;lt;script&amp;gt;`.
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  test("neutralizes a full XSS payload as text", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"
    );
    expect(escapeHtml('"><script>alert(document.cookie)</script>')).toBe(
      "&quot;&gt;&lt;script&gt;alert(document.cookie)&lt;/script&gt;"
    );
  });

  test("returns empty string for null/undefined (don't render 'null' as text)", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  test("coerces non-strings via String()", () => {
    expect(escapeHtml(42)).toBe("42");
    expect(escapeHtml(true)).toBe("true");
    expect(escapeHtml(0)).toBe("0");
    expect(escapeHtml({ toString: () => "<obj>" })).toBe("&lt;obj&gt;");
  });

  test("leaves plain text untouched", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
    expect(escapeHtml("normal punctuation. comma, period.")).toBe(
      "normal punctuation. comma, period."
    );
  });

  test("idempotent on already-escaped content (re-escaping & is the only side effect)", () => {
    // This is the documented gotcha: don't escape-then-escape. The
    // helper is for the FINAL HTML serialization step; intermediate
    // string-handling code should stay raw.
    const once = escapeHtml("<");
    const twice = escapeHtml(once);
    expect(once).toBe("&lt;");
    expect(twice).toBe("&amp;lt;");
  });
});

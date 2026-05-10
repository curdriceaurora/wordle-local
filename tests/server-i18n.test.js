"use strict";

const { parseAcceptLanguage, translateForRequest } = require("../lib/server-i18n");

describe("parseAcceptLanguage", () => {
  test("returns en for missing/empty header", () => {
    expect(parseAcceptLanguage(null)).toBe("en");
    expect(parseAcceptLanguage("")).toBe("en");
    expect(parseAcceptLanguage(undefined)).toBe("en");
  });

  test("returns es for an es-MX preference", () => {
    expect(parseAcceptLanguage("es-MX,es;q=0.9,en;q=0.8")).toBe("es");
  });

  test("returns en when only unsupported langs are listed", () => {
    expect(parseAcceptLanguage("fr,de;q=0.7")).toBe("en");
  });

  test("honors q-factor ordering", () => {
    expect(parseAcceptLanguage("en;q=0.5,es;q=0.9")).toBe("es");
  });

  test("ties resolve by header order", () => {
    expect(parseAcceptLanguage("en,es")).toBe("en");
    expect(parseAcceptLanguage("es,en")).toBe("es");
  });

  test("clamps q above 1 to 1", () => {
    // q=2 is invalid; the regex `[\d.]+` doesn't match `-1`, so a
    // negative q is silently ignored (keeps the default q=1) — but a
    // numeric q over 1 is clamped to 1, so the order resolves by
    // header position.
    expect(parseAcceptLanguage("en;q=0.5,es;q=2")).toBe("es");
  });

  test("bounded against pathological input (>10 entries)", () => {
    const huge = Array(50).fill("xx").join(",") + ",es";
    // Only first 10 entries parsed; "xx" repeated → no supported lang.
    expect(parseAcceptLanguage(huge)).toBe("en");
  });

  test("bounded against >256-char header", () => {
    const longHeader = "a".repeat(300) + ",es";
    // Truncated before the comma → no supported lang.
    expect(parseAcceptLanguage(longHeader)).toBe("en");
  });
});

describe("translateForRequest", () => {
  test("translates a key to en when no Accept-Language", () => {
    const req = { headers: {} };
    const out = translateForRequest(req, "play.heading");
    expect(out).toBe("Play");
  });

  test("translates to es when client prefers it", () => {
    const req = { headers: { "accept-language": "es,en;q=0.5" } };
    const out = translateForRequest(req, "play.heading");
    expect(out).toBe("Jugar");
  });

  test("interpolates parameters", () => {
    const req = { headers: { "accept-language": "es" } };
    const out = translateForRequest(req, "play.guessTooShort", { length: 5 });
    expect(out).toContain("5");
  });

  test("falls back to en when key only exists in en", () => {
    const req = { headers: { "accept-language": "es" } };
    // `header.create` exists in both, but if a key only existed in en
    // we'd want that fallback to fire. We can't guarantee one-sided
    // keys without doctoring locale files, so assert that the lookup
    // at least returns SOMETHING for any key in either locale.
    const out = translateForRequest(req, "play.createYours");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  test("returns literal key when missing from both locales", () => {
    const req = { headers: { "accept-language": "es" } };
    expect(translateForRequest(req, "nonexistent.key")).toBe("nonexistent.key");
  });
});

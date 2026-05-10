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

  test("malformed q (e.g. q=.) is ignored — no NaN poisoning the comparator", () => {
    // Without the Number.isFinite guard, parseFloat("." ) returns NaN
    // and the sort comparator becomes unstable. The default q=1
    // should be retained for any non-finite parse result.
    expect(parseAcceptLanguage("en;q=0.5,es;q=.")).toBe("es");
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
    // Use the test seam to construct deliberately one-sided fixtures
    // so the es→en fallback branch is actually exercised. The shipped
    // locale files maintain strict parity (the coverage gate enforces
    // it), so a real one-sided key won't appear from disk.
    const { _setLocaleForTests, resetCache } = require("../lib/server-i18n");
    _setLocaleForTests("en", { fixture: { onlyInEn: "English-only value" } });
    _setLocaleForTests("es", { fixture: {} });
    const req = { headers: { "accept-language": "es" } };
    expect(translateForRequest(req, "fixture.onlyInEn")).toBe("English-only value");
    // Sanity: a key missing from both locales should return the
    // literal key, not silently emit empty string.
    expect(translateForRequest(req, "fixture.missing")).toBe("fixture.missing");
    // Cleanup: restore real on-disk locales for downstream tests.
    resetCache();
  });

  test("returns literal key when missing from both locales", () => {
    const req = { headers: { "accept-language": "es" } };
    expect(translateForRequest(req, "nonexistent.key")).toBe("nonexistent.key");
  });
});

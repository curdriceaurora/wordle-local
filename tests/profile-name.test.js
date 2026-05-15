"use strict";

// Unit tests for the shared profile-name validator (issue #174).
// The validator is now imported by both `lib/leaderboard-store.js`
// and `routes/challenges.js` + `lib/challenge-results-store.js`, so
// any change to its accept/reject behavior would break both paths
// uniformly — these tests pin the contract.

const {
  NAME_LENGTH_MAX,
  NAME_PATTERN,
  isValidProfileName
} = require("../lib/profile-name");

describe("profile-name validator", () => {
  describe("isValidProfileName: accepts", () => {
    const accepted = [
      // English first names
      "Alice",
      "Bob",
      "Mary",
      // Compound and hyphenated names
      "Mary-Jane",
      "Mary Jane",
      "Mary-Jane O'Brien",
      "Jean-Luc",
      // International / Unicode letters
      "José",
      "Pavlína",
      "García",
      "Müller",
      "Łukasz",
      // CJK
      "李明",
      "山田",
      // Arabic
      "محمد",
      // Devanagari (Indic)
      "अनिता",
      // Min length 1
      "X",
      // Exactly 32 chars (the cap), BMP-only so codepoint count
      // and UTF-16 code unit count coincide.
      "A" + "b".repeat(31),
      // Single astral-plane letter (CJK Extension B, 1 codepoint =
      // 2 UTF-16 units, under both caps).
      // 𠀀 = U+20000.
      "𠀀",
      // Internal apostrophes
      "O'Brien",
      "D'Angelo",
      // Multi-word names
      "Anne Marie",
      "Van Der Berg"
    ];
    test.each(accepted)("accepts %p", (name) => {
      expect(isValidProfileName(name)).toBe(true);
    });
  });

  describe("isValidProfileName: rejects", () => {
    const rejected = [
      // Empty / non-string
      "",
      null,
      undefined,
      42,
      // Leading whitespace / hyphen / apostrophe (must start with letter)
      " Alice",
      "-Mary",
      "'Pat",
      // Digits
      "Alice123",
      "Bob2",
      "1Mary",
      // Symbols
      "Alice!",
      "Bob<script>",
      "Mary&Pat",
      "Alice@home",
      "Alice/Bob",
      // Emojis
      "🎉",
      "Alice🎉",
      // Underscores
      "Alice_Bob",
      // Newlines / tabs (regex only allows space among whitespace)
      "Alice\nBob",
      "Alice\tBob",
      // Over the 32-char cap (33 BMP letters = 33 UTF-16 units)
      "A" + "b".repeat(32),
      // Way over
      "A".repeat(100)
    ];
    test.each(rejected)("rejects %p", (name) => {
      expect(isValidProfileName(name)).toBe(false);
    });
  });

  describe("constants", () => {
    test("NAME_LENGTH_MAX is 32", () => {
      expect(NAME_LENGTH_MAX).toBe(32);
    });

    test("NAME_PATTERN is a unicode-mode regex", () => {
      expect(NAME_PATTERN).toBeInstanceOf(RegExp);
      expect(NAME_PATTERN.flags).toContain("u");
    });
  });

  // Contract test for the client-side default-name generator. A bad
  // adjective or animal edit (introducing a digit, accent the regex
  // doesn't allow, etc.) would silently ship a default name that
  // gets rejected on submit. This test pins the invariant: every
  // single token in every locale must pass on its own, every
  // per-locale Adjective × Animal cross-product must pass, and a
  // random sample of 1000 pickRandomName() calls per locale must
  // always pass.
  describe("pickRandomName contract", () => {
    const {
      RANDOM_NAME_LISTS,
      RANDOM_NAME_ADJECTIVES,
      RANDOM_NAME_ANIMALS,
      pickRandomName
    } = require("../public/js/random-name");

    test("English back-compat aliases still resolve to the en sub-lists", () => {
      expect(RANDOM_NAME_ADJECTIVES).toBe(RANDOM_NAME_LISTS.en.adjectives);
      expect(RANDOM_NAME_ANIMALS).toBe(RANDOM_NAME_LISTS.en.animals);
    });

    // #206: iterate every locale-keyed list so adding a new locale
    // (fr, de, ja, ...) automatically picks up coverage. A future
    // PR adding bad words to any locale fails this test before it
    // can ship a broken default.
    const locales = Object.keys(RANDOM_NAME_LISTS);

    test.each(locales)("every adjective in '%s' passes isValidProfileName", (locale) => {
      RANDOM_NAME_LISTS[locale].adjectives.forEach((adj) => {
        expect(isValidProfileName(adj)).toBe(true);
      });
    });

    test.each(locales)("every animal in '%s' passes isValidProfileName", (locale) => {
      RANDOM_NAME_LISTS[locale].animals.forEach((animal) => {
        expect(isValidProfileName(animal)).toBe(true);
      });
    });

    test.each(locales)(
      "every Adjective × Animal combination in '%s' passes isValidProfileName",
      (locale) => {
        const { adjectives, animals } = RANDOM_NAME_LISTS[locale];
        adjectives.forEach((adj) => {
          animals.forEach((animal) => {
            const name = `${adj} ${animal}`;
            expect(isValidProfileName(name)).toBe(true);
          });
        });
      }
    );

    test.each(locales)(
      "1000 pickRandomName('%s') draws all pass isValidProfileName",
      (locale) => {
        for (let i = 0; i < 1000; i += 1) {
          const name = pickRandomName(locale);
          expect(isValidProfileName(name)).toBe(true);
        }
      }
    );

    test("pickRandomName() with no locale falls back to en", () => {
      // Implicit-en path — verify the default doesn't produce
      // empty/invalid output if a caller forgets to pass a locale.
      for (let i = 0; i < 100; i += 1) {
        const name = pickRandomName();
        expect(isValidProfileName(name)).toBe(true);
        // Should pull from the en adjective set.
        const [adj] = name.split(" ");
        expect(RANDOM_NAME_LISTS.en.adjectives).toContain(adj);
      }
    });

    test("pickRandomName('zz-unknown-locale') falls back to en", () => {
      // A future locale id we haven't curated lists for yet must not
      // strand callers with an empty default — fall back to en.
      for (let i = 0; i < 100; i += 1) {
        const name = pickRandomName("zz-unknown");
        expect(isValidProfileName(name)).toBe(true);
        const [adj] = name.split(" ");
        expect(RANDOM_NAME_LISTS.en.adjectives).toContain(adj);
      }
    });

    test("locales other than en produce locale-specific output", () => {
      // pickRandomName('es') should never accidentally return an
      // English adjective. 200 draws is enough — if the locale-pick
      // logic regresses to always-en, every draw lands outside the
      // es set.
      //
      // Note: this checks ADJECTIVE overlap only. Some animal nouns
      // are spelled identically across locales (e.g. "Jaguar" is the
      // same word in en and es) — that overlap is correct and not a
      // signal that locale routing is broken. Adjectives have no
      // cross-locale overlap by curation, so they're a clean probe.
      const enAdjSet = new Set(RANDOM_NAME_LISTS.en.adjectives);
      const esAdjSet = new Set(RANDOM_NAME_LISTS.es.adjectives);
      let sawEsOnly = false;
      for (let i = 0; i < 200; i += 1) {
        const name = pickRandomName("es");
        const [adj] = name.split(" ");
        expect(esAdjSet).toContain(adj);
        if (!enAdjSet.has(adj)) sawEsOnly = true;
      }
      // If a future edit introduces en/es adjective overlap, this
      // invariant weakens — at that point split into two tests:
      // (a) the adj is in the es set, and (b) the picker calls into
      // the right sub-list. The current curation has no overlap.
      expect(sawEsOnly).toBe(true);
    });
  });

  describe("NFC normalization contract", () => {
    // The dedup comparison in routes/stats.js is case-insensitive but
    // not Unicode-aware, so `José` (NFC: "José") and `José` (NFD:
    // "José") would create duplicate profile rows unless
    // both forms are normalized to NFC before write/compare. Codex P2
    // on PR #180. Tests pin both the validator's form-agnostic accept
    // behavior and the NFC equivalence callers rely on.
    const nfcJose = "José";
    const nfdJose = "José";

    test("both NFC and NFD `José` pass isValidProfileName", () => {
      expect(isValidProfileName(nfcJose)).toBe(true);
      expect(isValidProfileName(nfdJose)).toBe(true);
    });

    test("NFC and NFD `José` render identically but differ in bytes", () => {
      expect(nfcJose).not.toBe(nfdJose);
      expect(nfcJose.normalize("NFC")).toBe(nfdJose.normalize("NFC"));
    });
  });

  describe("codepoint length cap (astral acceptance)", () => {
    // The validator caps at 32 Unicode codepoints (regex `{0,31}`
    // under /u). This matches the JSON-schema `maxLength: 32`
    // (codepoints per spec) so a name accepted here also passes
    // schema validation on the persisted file — no silent drops on
    // load. The HTML `maxlength="32"` UI cap is UTF-16 (tighter for
    // astral typing); astral content > 16 codepoints can only enter
    // via API or backup-restore, never typed input. Codex P2 on
    // PR #180 caught the prior UTF-16-cap mismatch.

    test("32 astral letters (32 codepoints, 64 UTF-16) accepted", () => {
      // U+20BB7 (𠮷, CJK UNIFIED IDEOGRAPH-20BB7) is `\p{L}` and a
      // single supplementary-plane codepoint = 2 UTF-16 units.
      const astralLetter = String.fromCodePoint(0x20BB7);
      const name32astral = astralLetter.repeat(32);
      expect(Array.from(name32astral).length).toBe(32);
      expect(name32astral.length).toBe(64);
      expect(isValidProfileName(name32astral)).toBe(true);
    });

    test("33 astral letters (33 codepoints, 66 UTF-16) rejected", () => {
      const astralLetter = String.fromCodePoint(0x20BB7);
      const name33astral = astralLetter.repeat(33);
      expect(Array.from(name33astral).length).toBe(33);
      expect(isValidProfileName(name33astral)).toBe(false);
    });
  });
});

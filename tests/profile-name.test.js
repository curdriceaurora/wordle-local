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
      // Exactly 32 codepoints (the regex cap)
      "A" + "b".repeat(31),
      // Astral-plane letter (CJK Extension B). `.length` for this
      // single character is 2 (UTF-16 surrogate pair) but it's one
      // codepoint — the validator must use the regex (which counts
      // codepoints in /u mode) and not bare `.length` for the cap.
      // 𠀀 = U+20000 = "𠀀".
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
      // Over the 32-codepoint cap
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
  // single token must pass on its own, every Adjective × Animal
  // cross-product must pass, and a random sample of 1000
  // pickRandomName() calls must always pass.
  describe("pickRandomName contract", () => {
    const {
      RANDOM_NAME_ADJECTIVES,
      RANDOM_NAME_ANIMALS,
      pickRandomName
    } = require("../public/js/random-name");

    test("every adjective passes isValidProfileName", () => {
      RANDOM_NAME_ADJECTIVES.forEach((adj) => {
        expect(isValidProfileName(adj)).toBe(true);
      });
    });

    test("every animal passes isValidProfileName", () => {
      RANDOM_NAME_ANIMALS.forEach((animal) => {
        expect(isValidProfileName(animal)).toBe(true);
      });
    });

    test("every Adjective × Animal combination passes isValidProfileName", () => {
      RANDOM_NAME_ADJECTIVES.forEach((adj) => {
        RANDOM_NAME_ANIMALS.forEach((animal) => {
          const name = `${adj} ${animal}`;
          expect(isValidProfileName(name)).toBe(true);
        });
      });
    });

    test("1000 pickRandomName() draws all pass isValidProfileName", () => {
      for (let i = 0; i < 1000; i += 1) {
        const name = pickRandomName();
        expect(isValidProfileName(name)).toBe(true);
      }
    });
  });
});

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
});

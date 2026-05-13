"use strict";

// Profile name validator — shared between the leaderboard store (play
// daily mode) and the challenge stores so both paths apply the same
// rule. Pre-#174 the two diverged: leaderboard capped at 24 chars
// with an ASCII-only regex `^[A-Za-z][A-Za-z '-]*$` (rejected `José`,
// `李明`, etc.); challenge capped at 64 chars with no regex.
//
// Unified rule (option C from #174):
//   - First char: any Unicode letter (\p{L}).
//   - Remaining 0-31 chars: letters, combining marks (for decomposed
//     accents like é = e + ́), spaces, apostrophes, hyphens.
//   - No digits, no symbols, no emojis.
//   - Total length 1-32 codepoints AND 1-32 UTF-16 code units (both
//     caps enforced; see below). The HTML `maxlength="32"` attribute
//     on both profile inputs caps typed input at 32 UTF-16 units, and
//     `data/leaderboard.schema.json` enforces the same on stored
//     data — so the validator matches that contract to keep API
//     callers from writing names a later schema check rejects.
//
// This accepts the international names the old leaderboard regex
// rejected (`José`, `李明`, `محمد`, `Pavlína`) while still excluding
// arbitrary `<script>` / digit / emoji content. Server-side rendering
// also uses `textContent` everywhere a name appears, so even if a
// future code path bypasses this validator the rendered output stays
// XSS-safe.

const NAME_LENGTH_MAX = 32;
// Regex quantifier derived from the constant so changing the cap in
// one place updates both. The pattern requires one leading letter +
// up to NAME_LENGTH_MAX-1 following chars (total 1..NAME_LENGTH_MAX).
// CodeRabbit suggestion on PR #180.
const NAME_PATTERN = new RegExp(
  `^\\p{L}[\\p{L}\\p{M}' -]{0,${NAME_LENGTH_MAX - 1}}$`,
  "u"
);

function isValidProfileName(name) {
  // Both caps enforced:
  //   - `name.length`: UTF-16 code units (matches HTML maxlength and
  //     `data/leaderboard.schema.json` maxLength, both 32). For
  //     supplementary-plane letters (surrogate pairs) this is the
  //     binding constraint — a 17-astral-codepoint name passes the
  //     regex's codepoint quantifier but exceeds 32 UTF-16 units.
  //   - NAME_PATTERN: character class + codepoint quantifier under /u.
  // The regex cap is redundant for BMP-only input (codepoint count ==
  // UTF-16 count) but kept as defense-in-depth.
  return typeof name === "string"
    && name.length <= NAME_LENGTH_MAX
    && NAME_PATTERN.test(name);
}

module.exports = {
  NAME_LENGTH_MAX,
  NAME_PATTERN,
  isValidProfileName
};

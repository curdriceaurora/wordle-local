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
//   - Total length 1-32 codepoints (regex anchors enforce both).
//
// This accepts the international names the old leaderboard regex
// rejected (`José`, `李明`, `محمد`, `Pavlína`) while still excluding
// arbitrary `<script>` / digit / emoji content. Server-side rendering
// also uses `textContent` everywhere a name appears, so even if a
// future code path bypasses this validator the rendered output stays
// XSS-safe.

const NAME_LENGTH_MAX = 32;
const NAME_PATTERN = /^\p{L}[\p{L}\p{M}' -]{0,31}$/u;

function isValidProfileName(name) {
  return typeof name === "string" && NAME_PATTERN.test(name);
}

module.exports = {
  NAME_LENGTH_MAX,
  NAME_PATTERN,
  isValidProfileName
};

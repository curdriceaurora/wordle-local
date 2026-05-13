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
//   - Total length 1-32 Unicode codepoints (regex anchors enforce
//     both bounds; the `/u` flag makes the quantifier count
//     codepoints rather than UTF-16 code units). Matches the
//     `maxLength: 32` constraint in `data/leaderboard.schema.json`
//     and `data/challenge-results.schema.json` (JSON Schema
//     `maxLength` also counts codepoints per spec).
//
//   HTML `maxlength="32"` on the profile inputs is a UI cap measured
//   in UTF-16 code units, which is tighter than the codepoint cap
//   here for astral letters (16 surrogate pairs = 32 UTF-16 = 16
//   codepoints). That's intentional — astral content > 16 codepoints
//   can only enter via API or backup-restore, never typed input.
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
  // Cap is enforced by NAME_PATTERN's `{0,31}` codepoint quantifier
  // under `/u`. Matches the JSON-schema `maxLength` (also codepoints
  // per spec / AJV impl), so a name accepted here will also pass
  // schema validation on the persisted file — no silent drops on
  // load. Codex P2 on PR #180 caught the prior UTF-16-cap mismatch.
  return typeof name === "string" && NAME_PATTERN.test(name);
}

module.exports = {
  NAME_LENGTH_MAX,
  NAME_PATTERN,
  isValidProfileName
};

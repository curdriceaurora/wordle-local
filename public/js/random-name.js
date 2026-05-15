"use strict";

// Adjective + Animal random name generator (issue #174). Pre-fills
// both profile inputs with a regex-clean default so the input isn't
// blank on first visit. Every `<Adjective> <Animal>` combination
// passes the shared NAME_PATTERN in lib/profile-name.js (Unicode
// letters + combining marks + one internal space, well under the
// 32-codepoint cap).
//
// Curated lists per locale; no profanity sweep needed at this size.
// The `tests/profile-name.test.js` contract test iterates every
// entry across every locale and asserts isValidProfileName() accepts
// it — a bad list edit fails the test before it can ship a broken
// default.
//
// Localized lists (#206 / #174 follow-up): Spanish lists shipped
// alongside English so the player UI shows locale-matching defaults
// when the i18n locale switches. Adjectives are masculine-singular
// across the board in Spanish — grammatical-gender agreement with
// the noun would be the right thing in prose, but here the value is
// a fun nickname not a sentence; same accepted compromise every
// mixed-genre random-name generator in a Romance language makes.
// Additional locales should each be their own follow-up PR (small,
// curated by a native reader); never machine-translated.
//
// UMD-ish shape (same pattern as public/js/escape-html.js) so this
// same source works both as a CommonJS module (Node tests) and as a
// global on `window` when loaded as a plain script in the player
// shell.

const RANDOM_NAME_LISTS = Object.freeze({
  en: Object.freeze({
    adjectives: Object.freeze([
      "Brave", "Bold", "Calm", "Clever", "Curious", "Daring", "Eager",
      "Friendly", "Gentle", "Happy", "Jolly", "Keen", "Kind", "Lively",
      "Lucky", "Merry", "Nimble", "Plucky", "Proud", "Quiet", "Quick",
      "Sharp", "Silly", "Smart", "Steady", "Sunny", "Swift", "Witty"
    ]),
    animals: Object.freeze([
      "Badger", "Beaver", "Falcon", "Ferret", "Fox", "Hare", "Hawk",
      "Heron", "Jaguar", "Lynx", "Magpie", "Marten", "Mongoose", "Otter",
      "Owl", "Panda", "Penguin", "Raven", "Robin", "Seal", "Shark",
      "Sparrow", "Stoat", "Stork", "Tiger", "Toucan", "Vixen", "Walrus"
    ])
  }),
  es: Object.freeze({
    adjectives: Object.freeze([
      "Alegre", "Amable", "Astuto", "Atento", "Audaz", "Brillante",
      "Calmo", "Cordial", "Curioso", "Despierto", "Diestro", "Discreto",
      "Feliz", "Firme", "Hábil", "Honesto", "Humilde", "Ingenioso",
      "Listo", "Noble", "Pacífico", "Paciente", "Pícaro", "Sereno",
      "Simpático", "Sincero", "Veloz", "Vivaz"
    ]),
    animals: Object.freeze([
      "Águila", "Ardilla", "Búho", "Caballo", "Ciervo", "Coyote",
      "Delfín", "Erizo", "Foca", "Gacela", "Gato", "Halcón", "Hurón",
      "Jaguar", "León", "Liebre", "Lince", "Lobo", "Mapache", "Mono",
      "Nutria", "Oso", "Pantera", "Pingüino", "Tigre", "Tucán", "Visón",
      "Zorro"
    ])
  })
});

// Back-compat aliases for callers (and the original #174 test
// contract) that import the flat English lists by name. Pointing
// these at the en sub-lists keeps a single source of truth — editing
// `RANDOM_NAME_LISTS.en.adjectives` updates the alias too.
const RANDOM_NAME_ADJECTIVES = RANDOM_NAME_LISTS.en.adjectives;
const RANDOM_NAME_ANIMALS = RANDOM_NAME_LISTS.en.animals;

// Picks a random `<Adjective> <Animal>` from the requested locale's
// lists. Unknown locale falls back to `en` so a future locale id we
// haven't curated lists for yet doesn't strand the caller with an
// empty default. Explicit-locale-only signature (no global peek into
// `window.i18n`) keeps the function pure and trivially testable —
// the player shell's call sites pass `window.i18n.getCurrentLocale()`
// explicitly.
function pickRandomName(locale) {
  const lists = RANDOM_NAME_LISTS[locale] || RANDOM_NAME_LISTS.en;
  const adj = lists.adjectives[Math.floor(Math.random() * lists.adjectives.length)];
  const animal = lists.animals[Math.floor(Math.random() * lists.animals.length)];
  return `${adj} ${animal}`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    RANDOM_NAME_LISTS,
    RANDOM_NAME_ADJECTIVES,
    RANDOM_NAME_ANIMALS,
    pickRandomName
  };
}
if (typeof window !== "undefined") {
  window.pickRandomName = pickRandomName;
  window.RANDOM_NAME_LISTS = RANDOM_NAME_LISTS;
  window.RANDOM_NAME_ADJECTIVES = RANDOM_NAME_ADJECTIVES;
  window.RANDOM_NAME_ANIMALS = RANDOM_NAME_ANIMALS;
}

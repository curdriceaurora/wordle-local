"use strict";

// Adjective + Animal random name generator (issue #174). Pre-fills
// both profile inputs with a regex-clean default so the input isn't
// blank on first visit. Every `<Adjective> <Animal>` combination
// passes the shared NAME_PATTERN in lib/profile-name.js (ASCII
// letters + one internal space, well under the 32-codepoint cap).
//
// Curated lists; no profanity sweep needed at this size. The
// `tests/profile-name.test.js` contract test iterates every entry
// and asserts isValidProfileName() accepts it — a bad list edit
// fails the test before it can ship a broken default.
//
// UMD-ish shape (same pattern as public/js/escape-html.js) so this
// same source works both as a CommonJS module (Node tests) and as a
// global on `window` when loaded as a plain script in the player
// shell.

const RANDOM_NAME_ADJECTIVES = Object.freeze([
  "Brave", "Bold", "Calm", "Clever", "Curious", "Daring", "Eager",
  "Friendly", "Gentle", "Happy", "Jolly", "Keen", "Kind", "Lively",
  "Lucky", "Merry", "Nimble", "Plucky", "Proud", "Quiet", "Quick",
  "Sharp", "Silly", "Smart", "Steady", "Sunny", "Swift", "Witty"
]);

const RANDOM_NAME_ANIMALS = Object.freeze([
  "Badger", "Beaver", "Falcon", "Ferret", "Fox", "Hare", "Hawk",
  "Heron", "Jaguar", "Lynx", "Magpie", "Marten", "Mongoose", "Otter",
  "Owl", "Panda", "Penguin", "Raven", "Robin", "Seal", "Shark",
  "Sparrow", "Stoat", "Stork", "Tiger", "Toucan", "Vixen", "Walrus"
]);

function pickRandomName() {
  const adj = RANDOM_NAME_ADJECTIVES[Math.floor(Math.random() * RANDOM_NAME_ADJECTIVES.length)];
  const animal = RANDOM_NAME_ANIMALS[Math.floor(Math.random() * RANDOM_NAME_ANIMALS.length)];
  return `${adj} ${animal}`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { RANDOM_NAME_ADJECTIVES, RANDOM_NAME_ANIMALS, pickRandomName };
}
if (typeof window !== "undefined") {
  window.pickRandomName = pickRandomName;
  window.RANDOM_NAME_ADJECTIVES = RANDOM_NAME_ADJECTIVES;
  window.RANDOM_NAME_ANIMALS = RANDOM_NAME_ANIMALS;
}

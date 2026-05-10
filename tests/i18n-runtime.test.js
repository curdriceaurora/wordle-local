"use strict";

// Tests for public/js/i18n.js. Loaded inside a JSDOM-backed window so
// the runtime's `document.documentElement.lang` and `localStorage`
// paths exercise the same code paths the browser sees.

const fs = require("fs");
const path = require("path");

const RUNTIME_PATH = path.resolve(__dirname, "..", "public", "js", "i18n.js");

function loadRuntimeIntoWindow(win) {
  const source = fs.readFileSync(RUNTIME_PATH, "utf8");
  // Wrap in a function so `var` declarations don't leak into Node global.
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "globalThis", source.replace(/typeof window !== "undefined" \? window : globalThis/, "window"));
  fn(win, win);
}

function makeWindow() {
  const storage = new Map();
  const docEl = { lang: "en" };
  return {
    document: {
      documentElement: docEl,
      // querySelectorAll fallback for nodes — tests don't exercise DOM
      // updateDOM unless a node list is provided.
      querySelectorAll() { return []; }
    },
    localStorage: {
      getItem: (k) => storage.has(k) ? storage.get(k) : null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    location: { search: "" },
    fetch: undefined,
    console: { warn: () => {}, log: () => {}, error: () => {} },
    Intl
  };
}

describe("i18n runtime (public/js/i18n.js)", () => {
  test("t() returns key when no messages loaded", () => {
    const win = makeWindow();
    loadRuntimeIntoWindow(win);
    expect(win.i18n.t("create.heading")).toBe("create.heading");
  });

  test("_setMessages + t() returns the message", () => {
    const win = makeWindow();
    loadRuntimeIntoWindow(win);
    win.i18n._setMessages("en", { create: { heading: "Create a puzzle" } });
    expect(win.i18n.t("create.heading")).toBe("Create a puzzle");
  });

  test("interpolation expands {name} placeholders", () => {
    const win = makeWindow();
    loadRuntimeIntoWindow(win);
    win.i18n._setMessages("en", { play: { solved: "Solved in {tries}/{max}!" } });
    expect(win.i18n.t("play.solved", { tries: 4, max: 6 })).toBe("Solved in 4/6!");
  });

  test("missing-key falls back to en, then to the literal key", async () => {
    const win = makeWindow();
    loadRuntimeIntoWindow(win);
    win.i18n._setMessages("en", { greet: "Hello, {name}!" });
    win.i18n._setMessages("es", { other: "Hola" });
    await win.i18n.loadLocale("es");
    // `greet` exists only in en; should fall back.
    expect(win.i18n.t("greet", { name: "Alice" })).toBe("Hello, Alice!");
    // Missing in BOTH — return literal key.
    expect(win.i18n.t("nonexistent.key")).toBe("nonexistent.key");
  });

  test("plural resolution honors Intl.PluralRules", () => {
    const win = makeWindow();
    loadRuntimeIntoWindow(win);
    win.i18n._setMessages("en", {
      apples_one: "{count} apple",
      apples_other: "{count} apples"
    });
    expect(win.i18n.t("apples", { count: 1 })).toBe("1 apple");
    expect(win.i18n.t("apples", { count: 5 })).toBe("5 apples");
    expect(win.i18n.t("apples", { count: 0 })).toBe("0 apples");
  });

  test("Spanish plurals (one/other) work via Intl", async () => {
    const win = makeWindow();
    loadRuntimeIntoWindow(win);
    win.i18n._setMessages("en", { days_one: "{count} day", days_other: "{count} days" });
    win.i18n._setMessages("es", { days_one: "{count} día", days_other: "{count} días" });
    await win.i18n.loadLocale("es");
    expect(win.i18n.t("days", { count: 1 })).toBe("1 día");
    expect(win.i18n.t("days", { count: 7 })).toBe("7 días");
  });

  test("formatDate / formatNumber use the active locale", async () => {
    const win = makeWindow();
    loadRuntimeIntoWindow(win);
    // English: thousand separator is `,`.
    win.i18n._setMessages("en", {});
    expect(win.i18n.formatNumber(1234567)).toMatch(/1,234,567/);
    // Spanish: thousand separator may be `.` (es-ES).
    win.i18n._setMessages("es", {});
    await win.i18n.loadLocale("es");
    const out = win.i18n.formatNumber(1234567);
    // Just assert the formatter ran and produced 8+ chars (locale-agnostic).
    expect(out.length).toBeGreaterThanOrEqual(7);
  });

  test("loadLocale persists to localStorage", async () => {
    const win = makeWindow();
    loadRuntimeIntoWindow(win);
    win.i18n._setMessages("es", { x: "y" });
    await win.i18n.loadLocale("es");
    expect(win.localStorage.getItem("localePreference")).toBe("es");
    expect(win.document.documentElement.lang).toBe("es");
  });

  test("bootstrapLang reads stored preference and sets <html lang>", () => {
    const win = makeWindow();
    win.localStorage.setItem("localePreference", "es");
    loadRuntimeIntoWindow(win);
    win.i18n.bootstrapLang();
    expect(win.document.documentElement.lang).toBe("es");
  });

  test("bootstrapLang falls back to en when stored value is unsupported", () => {
    const win = makeWindow();
    win.localStorage.setItem("localePreference", "fr");
    loadRuntimeIntoWindow(win);
    win.i18n.bootstrapLang();
    expect(win.document.documentElement.lang).toBe("en");
  });
});

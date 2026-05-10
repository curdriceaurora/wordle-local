// Zero-dep i18n runtime. Loaded as a regular <script> tag from
// public/index.html and public/admin/index.html (NOT as a module —
// the rest of the app is plain script and we don't want to introduce
// import semantics here).
//
// Usage from app code:
//   await window.i18n.init({ initial: "es" });
//   window.i18n.t("create.startPuzzle", { name: "Alice" });
//   window.i18n.formatDate(new Date(), { year: "numeric" });
//   await window.i18n.loadLocale("en");
//   window.i18n.updateDOM();   // re-render data-i18n attributes
//
// DOM bindings:
//   <span data-i18n="create.startPuzzle"></span>
//   <input data-i18n-attr="placeholder:create.wordPlaceholder;aria-label:create.wordAria">
//
// Locale resource files live at /locales/<lang>.json. Missing-key
// behavior: fall back to en, then to the literal key string. Plural
// keys carry suffixes (`_one`, `_other`, etc.); the resolver picks
// based on `Intl.PluralRules.select(n)`.

(function (global) {
  "use strict";

  var DEFAULT_LOCALE = "en";
  var STORAGE_KEY = "localePreference";
  var LOCALE_PATH_PREFIX = "/locales/";
  var INTERPOLATION_PATTERN = /\{(\w+)\}/g;
  var DOM_BINDING_ATTR = "data-i18n";
  var DOM_BINDING_ATTR_KIND = "data-i18n-attr";

  var availableLocales = ["en", "es"];
  var loadedMessages = Object.create(null); // { en: {...}, es: {...} }
  var currentLocale = DEFAULT_LOCALE;
  var pluralRulesCache = Object.create(null);
  var dateFormatterCache = Object.create(null);
  var numberFormatterCache = Object.create(null);
  var debugMissing = false;
  var warnedKeys = Object.create(null);

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function readStoredLocale() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
      if (typeof raw === "string" && availableLocales.indexOf(raw) >= 0) return raw;
    } catch (_e) {
      // ignore — quota/private mode
    }
    return null;
  }

  function writeStoredLocale(locale) {
    try {
      if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, locale);
    } catch (_e) { /* ignore */ }
  }

  function lookupKey(messages, dottedKey) {
    if (!messages) return undefined;
    var parts = String(dottedKey || "").split(".");
    var node = messages;
    for (var i = 0; i < parts.length; i += 1) {
      if (!isPlainObject(node)) return undefined;
      node = node[parts[i]];
    }
    return typeof node === "string" ? node : undefined;
  }

  function getPluralRules(locale) {
    if (pluralRulesCache[locale]) return pluralRulesCache[locale];
    try {
      pluralRulesCache[locale] = new Intl.PluralRules(locale);
    } catch (_e) {
      pluralRulesCache[locale] = new Intl.PluralRules("en");
    }
    return pluralRulesCache[locale];
  }

  function interpolate(template, params) {
    if (!params || typeof template !== "string") return template;
    return template.replace(INTERPOLATION_PATTERN, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }

  function reportMissing(key) {
    if (!debugMissing) return;
    if (warnedKeys[key]) return;
    warnedKeys[key] = true;
    if (global.console && typeof global.console.warn === "function") {
      global.console.warn("[i18n] missing key: " + key);
    }
  }

  function resolveKey(rawKey, params, locale) {
    var key = rawKey;
    var count;
    if (params && Object.prototype.hasOwnProperty.call(params, "count")) {
      count = Number(params.count);
      if (Number.isFinite(count)) {
        var rule = getPluralRules(locale).select(count);
        var pluralKey = rawKey + "_" + rule;
        var pluralMatch = lookupKey(loadedMessages[locale], pluralKey);
        if (pluralMatch !== undefined) return pluralMatch;
        // Try `_other` as a fallback within the active locale.
        var otherMatch = lookupKey(loadedMessages[locale], rawKey + "_other");
        if (otherMatch !== undefined) return otherMatch;
      }
    }
    return lookupKey(loadedMessages[locale], key);
  }

  function t(rawKey, params) {
    var primary = resolveKey(rawKey, params, currentLocale);
    if (primary !== undefined) return interpolate(primary, params);
    if (currentLocale !== DEFAULT_LOCALE) {
      var fallback = resolveKey(rawKey, params, DEFAULT_LOCALE);
      if (fallback !== undefined) return interpolate(fallback, params);
    }
    reportMissing(rawKey);
    return rawKey;
  }

  function getDateFormatter(locale, opts) {
    var key = locale + "::" + JSON.stringify(opts || {});
    if (dateFormatterCache[key]) return dateFormatterCache[key];
    try {
      dateFormatterCache[key] = new Intl.DateTimeFormat(locale, opts);
    } catch (_e) {
      dateFormatterCache[key] = new Intl.DateTimeFormat("en", opts);
    }
    return dateFormatterCache[key];
  }

  function getNumberFormatter(locale, opts) {
    var key = locale + "::" + JSON.stringify(opts || {});
    if (numberFormatterCache[key]) return numberFormatterCache[key];
    try {
      numberFormatterCache[key] = new Intl.NumberFormat(locale, opts);
    } catch (_e) {
      numberFormatterCache[key] = new Intl.NumberFormat("en", opts);
    }
    return numberFormatterCache[key];
  }

  function formatDate(date, opts) {
    if (!(date instanceof Date)) date = new Date(date);
    if (Number.isNaN(date.getTime())) return "";
    return getDateFormatter(currentLocale, opts).format(date);
  }

  function formatNumber(value, opts) {
    var n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return "";
    return getNumberFormatter(currentLocale, opts).format(n);
  }

  async function fetchLocale(locale) {
    var url = LOCALE_PATH_PREFIX + encodeURIComponent(locale) + ".json";
    var res = await global.fetch(url, { credentials: "same-origin" });
    if (!res.ok) {
      throw new Error("[i18n] fetch failed for " + locale + " (HTTP " + res.status + ")");
    }
    return res.json();
  }

  async function loadLocale(locale) {
    if (loadedMessages[locale]) {
      currentLocale = locale;
      writeStoredLocale(locale);
      updateHtmlLang(locale);
      // Apply translations to all bound DOM nodes so callers don't
      // have to remember to call updateDOM() themselves. This matches
      // the documented contract.
      updateDOM();
      return;
    }
    if (availableLocales.indexOf(locale) === -1) {
      throw new Error("[i18n] unsupported locale: " + locale);
    }
    var json = await fetchLocale(locale);
    if (!isPlainObject(json)) {
      throw new Error("[i18n] locale " + locale + " did not return an object");
    }
    loadedMessages[locale] = json;
    currentLocale = locale;
    writeStoredLocale(locale);
    updateHtmlLang(locale);
    updateDOM();
  }

  function updateHtmlLang(locale) {
    if (global.document && global.document.documentElement) {
      global.document.documentElement.lang = locale;
    }
  }

  // Apply translations to all DOM nodes carrying data-i18n / data-i18n-attr.
  // Called automatically after loadLocale() and once during init().
  function updateDOM(root) {
    var doc = root || global.document;
    if (!doc) return;
    var textNodes = doc.querySelectorAll
      ? doc.querySelectorAll("[" + DOM_BINDING_ATTR + "]")
      : [];
    for (var i = 0; i < textNodes.length; i += 1) {
      var el = textNodes[i];
      var key = el.getAttribute(DOM_BINDING_ATTR);
      if (!key) continue;
      var text = t(key);
      // For inputs/textareas with data-i18n, treat it as placeholder.
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        el.placeholder = text;
      } else {
        el.textContent = text;
      }
    }
    var attrNodes = doc.querySelectorAll
      ? doc.querySelectorAll("[" + DOM_BINDING_ATTR_KIND + "]")
      : [];
    for (var j = 0; j < attrNodes.length; j += 1) {
      var node = attrNodes[j];
      var spec = node.getAttribute(DOM_BINDING_ATTR_KIND);
      if (!spec) continue;
      var entries = spec.split(";");
      for (var k = 0; k < entries.length; k += 1) {
        var pair = entries[k].split(":");
        if (pair.length !== 2) continue;
        var attr = pair[0].trim();
        var keyForAttr = pair[1].trim();
        if (!attr || !keyForAttr) continue;
        node.setAttribute(attr, t(keyForAttr));
      }
    }
  }

  function getCurrentLocale() {
    return currentLocale;
  }

  function getAvailableLocales() {
    return availableLocales.slice();
  }

  // Pre-paint boot helper. Reads the stored locale (or default) and
  // sets <html lang> immediately so SR/CSS see the right value before
  // the rest of the page paints. Called inline from index.html before
  // the stylesheet.
  function bootstrapLang() {
    var stored = readStoredLocale();
    var initial = stored || DEFAULT_LOCALE;
    updateHtmlLang(initial);
    return initial;
  }

  // init() is called by the page's bootstrap script after the
  // resources are available. It loads `en` first (always — fallback
  // baseline) then the active locale if different. Resolves with the
  // locale that ended up active.
  async function init(options) {
    var opts = options || {};
    debugMissing = opts.debug === true
      || (global.location && /[?&]i18nDebug=1/.test(global.location.search));
    var initial = (opts.initial && availableLocales.indexOf(opts.initial) >= 0)
      ? opts.initial
      : (readStoredLocale() || DEFAULT_LOCALE);
    // Always load `en` — used as the second-level fallback.
    if (!loadedMessages[DEFAULT_LOCALE]) {
      try {
        loadedMessages[DEFAULT_LOCALE] = await fetchLocale(DEFAULT_LOCALE);
      } catch (_err) {
        loadedMessages[DEFAULT_LOCALE] = {};
      }
    }
    if (initial !== DEFAULT_LOCALE) {
      try {
        await loadLocale(initial);
      } catch (_err) {
        currentLocale = DEFAULT_LOCALE;
        updateHtmlLang(DEFAULT_LOCALE);
      }
    } else {
      currentLocale = DEFAULT_LOCALE;
      updateHtmlLang(DEFAULT_LOCALE);
    }
    updateDOM();
    return currentLocale;
  }

  global.i18n = {
    init: init,
    loadLocale: loadLocale,
    t: t,
    formatDate: formatDate,
    formatNumber: formatNumber,
    getCurrentLocale: getCurrentLocale,
    getAvailableLocales: getAvailableLocales,
    updateDOM: updateDOM,
    bootstrapLang: bootstrapLang,
    // Test seam: lets tests pre-populate messages without fetch.
    _setMessages: function (locale, messages) {
      loadedMessages[locale] = messages;
    }
  };
})(typeof window !== "undefined" ? window : globalThis);

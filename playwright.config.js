const { defineConfig } = require("@playwright/test");

// All browsers the suite runs by default: chromium, firefox, webkit.
// Webkit was temporarily parked from the default matrix in PR #141
// after 61/64 webkit tests failed; investigation in #142 / PR #143
// surfaced two real production bugs masked by chromium + firefox
// silently exempting localhost:
//   1. Helmet's default CSP includes `upgrade-insecure-requests`,
//      which webkit enforces literally for localhost — fixed by
//      explicitly disabling it in server.js.
//   2. `.toggle` buttons had no `background-color`, exposing the
//      webkit UA default #c0c0c0 and dropping contrast against
//      `--muted` below WCAG AA — fixed in public/styles.css.
// Plus a Playwright 1.49 → 1.60 upgrade resolved older webkit
// anchor-click navigation bugs. Full suite is now 192/192 across
// all 3 browsers.
const ALL_BROWSERS = ["chromium", "firefox", "webkit"];
const DEFAULT_BROWSERS = ["chromium", "firefox", "webkit"];
const requestedBrowsers = process.env.PLAYWRIGHT_BROWSERS
  ? process.env.PLAYWRIGHT_BROWSERS.split(",").map((entry) => entry.trim()).filter(Boolean)
  : [];
const browsers = requestedBrowsers.length ? requestedBrowsers : DEFAULT_BROWSERS;
const unknownBrowsers = browsers.filter((name) => !ALL_BROWSERS.includes(name));
if (unknownBrowsers.length) {
  throw new Error(
    `Unknown PLAYWRIGHT_BROWSERS value(s): ${unknownBrowsers.join(", ")}. Use ${ALL_BROWSERS.join(", ")}.`
  );
}

module.exports = defineConfig({
  testDir: "./tests/ui",
  timeout: 30000,
  retries: 0,
  workers: process.env.CI ? 1 : 2,
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    serviceWorkers: "block"
  },
  projects: browsers.map((browserName) => ({
    name: browserName,
    use: { browserName }
  })),
  webServer: {
    command: "RATE_LIMIT_MAX=10000 RATE_LIMIT_WINDOW_MS=60000 node server.js",
    port: 3000,
    reuseExistingServer: false
  }
});

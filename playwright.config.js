const { defineConfig } = require("@playwright/test");

const ALL_BROWSERS = ["chromium", "firefox", "webkit"];
const requestedBrowsers = process.env.PLAYWRIGHT_BROWSERS
  ? process.env.PLAYWRIGHT_BROWSERS.split(",").map((entry) => entry.trim()).filter(Boolean)
  : [];
const browsers = requestedBrowsers.length ? requestedBrowsers : ALL_BROWSERS;
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
  use: {
    baseURL: "http://localhost:3000",
    headless: true
  },
  projects: browsers.map((browserName) => ({
    name: browserName,
    use: { browserName }
  })),
  webServer: {
    command: "node server.js",
    port: 3000,
    reuseExistingServer: !process.env.CI
  }
});

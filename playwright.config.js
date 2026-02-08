const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/ui",
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3000",
    headless: true
  },
  webServer: {
    command: "node server.js",
    port: 3000,
    reuseExistingServer: !process.env.CI
  }
});

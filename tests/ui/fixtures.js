const fs = require("fs");
const path = require("path");
const { test: base, expect } = require("@playwright/test");

const RAW_DIR = path.join(__dirname, "..", "..", "coverage", "ui", "raw");

function sanitizeTitle(value) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "").toLowerCase();
}

const test = base.extend({
  page: async ({ page, browserName }, use, testInfo) => {
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);
    const shouldCollect = process.env.UI_COVERAGE === "1" && browserName === "chromium";
    if (shouldCollect) {
      await page.coverage.startJSCoverage({ reportAnonymousScripts: false });
    }

    await use(page);

    if (shouldCollect) {
      const coverage = await page.coverage.stopJSCoverage();
      fs.mkdirSync(RAW_DIR, { recursive: true });
      const title = sanitizeTitle(testInfo.titlePath.join(" "));
      const fileName = `${testInfo.project.name}-${title}-${Date.now()}.json`;
      fs.writeFileSync(path.join(RAW_DIR, fileName), JSON.stringify(coverage));
    }
  }
});

module.exports = { test, expect };

const { test, expect } = require("./fixtures");
const AxeBuilder = require("@axe-core/playwright");

async function waitForLanguages(page) {
  await page.waitForSelector("#langSelect option", { state: "attached" });
}

test("create screen passes axe checks", async ({ page }) => {
  await page.goto("/", { waitUntil: "commit" });
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("play screen passes axe checks", async ({ page }) => {
  test.setTimeout(60000);
  page.setDefaultNavigationTimeout(60000);
  await page.goto("/", { waitUntil: "commit" });
  await waitForLanguages(page);
  await page.selectOption("#langSelect", "none");
  await page.fill("#wordInput", "JACKS");
  await page.click("form#createForm button[type=submit]");
  await page.waitForSelector("#playPanel:not(.hidden)");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

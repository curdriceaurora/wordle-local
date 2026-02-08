const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright");

test("create screen passes axe checks", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("play screen passes axe checks", async ({ page }) => {
  await page.goto("/");
  await page.selectOption("#langSelect", "none");
  await page.fill("#wordInput", "JACKS");
  await page.click("form#createForm button[type=submit]");
  await page.waitForSelector("#playPanel:not(.hidden)");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

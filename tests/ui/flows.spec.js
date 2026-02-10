const { test, expect } = require("./fixtures");

test("invalid link CTA returns to create screen", async ({ page }) => {
  await page.goto("/?word=!!!", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#errorPanel")).toBeVisible();
  await page.click('#errorPanel a[href="/"]');
  await expect(page).toHaveURL("/");
  await expect(page.locator("#createPanel")).toBeVisible();
});

test("skip link navigates to main content", async ({ page }) => {
  await page.goto("/", { waitUntil: "commit" });
  await page.evaluate(() => {
    document.querySelector(".skip-link")?.click();
  });
  await expect(page).toHaveURL(/#main$/);
});

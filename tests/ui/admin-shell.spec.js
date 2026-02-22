const { test, expect } = require("./fixtures");
const AxeBuilder = require("@axe-core/playwright");

test("admin shell unlocks with session-only key and loads provider status", async ({ page }) => {
  await page.goto("/admin", { waitUntil: "commit" });

  await expect(page.locator("#unlockPanel")).toBeVisible();
  await expect(page.locator("#shellPanel")).toBeHidden();

  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");

  await expect(page.locator("#shellPanel")).toBeVisible();
  await expect(page.locator("#workspaceStatus")).toContainText("Provider status loaded");
  await expect(page.locator("#providersBody tr")).toHaveCount(5);

  const localStorageContainsAdminKey = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      const value = localStorage.getItem(key);
      if (String(key).toLowerCase().includes("admin")) return true;
      if (String(value || "").includes("demo-key")) return true;
    }
    return false;
  });
  expect(localStorageContainsAdminKey).toBe(false);

  await page.reload({ waitUntil: "commit" });
  await expect(page.locator("#unlockPanel")).toBeVisible();
  await expect(page.locator("#shellPanel")).toBeHidden();
});

test("admin shell lock button clears unlocked session", async ({ page }) => {
  await page.goto("/admin", { waitUntil: "commit" });

  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");
  await expect(page.locator("#shellPanel")).toBeVisible();

  await page.click("#lockSessionBtn");
  await expect(page.locator("#unlockPanel")).toBeVisible();
  await expect(page.locator("#shellPanel")).toBeHidden();
  await expect(page.locator("#adminUpdated")).toContainText("Session locked");
});

test("admin shell passes axe checks in locked and unlocked states", async ({ page }) => {
  await page.goto("/admin", { waitUntil: "commit" });
  const lockedResults = await new AxeBuilder({ page }).analyze();
  expect(lockedResults.violations).toEqual([]);

  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");
  await expect(page.locator("#shellPanel")).toBeVisible();

  const unlockedResults = await new AxeBuilder({ page }).analyze();
  expect(unlockedResults.violations).toEqual([]);
});

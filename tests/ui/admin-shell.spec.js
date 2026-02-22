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

  const storageContainsAdminKey = await page.evaluate(() => {
    function hasSecret(storage) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (!key) continue;
        const value = storage.getItem(key);
        if (String(key).toLowerCase().includes("admin")) return true;
        if (String(value || "").includes("demo-key")) return true;
      }
      return false;
    }

    return {
      local: hasSecret(localStorage),
      session: hasSecret(sessionStorage)
    };
  });
  expect(storageContainsAdminKey.local).toBe(false);
  expect(storageContainsAdminKey.session).toBe(false);

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

test("admin shell tablist supports keyboard tab navigation", async ({ page }) => {
  await page.goto("/admin", { waitUntil: "commit" });
  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");
  await expect(page.locator("#shellPanel")).toBeVisible();

  const providersTab = page.locator("#admin-tab-providers");
  const importsTab = page.locator("#admin-tab-imports");
  const runtimeTab = page.locator("#admin-tab-runtime");

  await providersTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(importsTab).toBeFocused();
  await expect(importsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#admin-panel-imports")).toBeVisible();

  await page.keyboard.press("End");
  await expect(runtimeTab).toBeFocused();
  await expect(runtimeTab).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Home");
  await expect(providersTab).toBeFocused();
  await expect(providersTab).toHaveAttribute("aria-selected", "true");
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

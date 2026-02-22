const { test, expect } = require("./fixtures");
const AxeBuilder = require("@axe-core/playwright");

function createProviderRows(state) {
  const variants = [
    ["en-GB", "English (UK)"],
    ["en-US", "English (US)"],
    ["en-CA", "English (Canada)"],
    ["en-AU", "English (Australia)"],
    ["en-ZA", "English (South Africa)"]
  ];
  return variants.map(([variant, label]) => {
    const isTarget = variant === "en-US";
    const imported = isTarget ? Boolean(state.imported) : false;
    const enabled = isTarget ? Boolean(state.enabled) : false;
    const importedCommits = imported && state.commit ? [state.commit] : [];
    let status = "not-imported";
    if (enabled) {
      status = "enabled";
    } else if (imported) {
      status = "imported";
    }
    return {
      variant,
      label,
      imported,
      enabled,
      status,
      activeCommit: enabled && state.commit ? state.commit : null,
      importedCommits,
      incompleteCommits: [],
      warning: null,
      error: null
    };
  });
}

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

test("admin shell supports import and enable workflows without CLI usage", async ({ page }) => {
  const state = {
    imported: false,
    enabled: false,
    commit: ""
  };

  await page.route("**/api/admin/providers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        providers: createProviderRows(state)
      })
    });
  });

  await page.route("**/api/admin/providers/import", async (route) => {
    const payload = JSON.parse(route.request().postData() || "{}");
    state.imported = true;
    state.enabled = false;
    state.commit = payload.commit;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        action: "imported",
        variant: "en-US",
        commit: state.commit,
        filterMode: payload.filterMode,
        counts: { filteredAnswers: 123 },
        providers: createProviderRows(state)
      })
    });
  });

  await page.route("**/api/admin/providers/en-US/enable", async (route) => {
    state.enabled = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        action: "enabled",
        variant: "en-US",
        commit: state.commit,
        providers: createProviderRows(state)
      })
    });
  });

  await page.goto("/admin", { waitUntil: "commit" });
  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");
  await expect(page.locator("#shellPanel")).toBeVisible();

  await page.click("#admin-tab-imports");
  await page.selectOption("#importVariant", "en-US");
  await page.fill("#importCommit", "0123456789abcdef0123456789abcdef01234567");
  await page.fill(
    "#importChecksumDic",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  );
  await page.fill(
    "#importChecksumAff",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  );
  await page.click("#importSubmitBtn");
  await expect(page.locator("#importStatus")).toContainText("Import complete");

  await page.once("dialog", (dialog) => dialog.accept());
  await page.click("#admin-tab-providers");
  await page.click('button[data-action="enable"][data-variant="en-US"]');
  await expect(
    page.locator("#providersBody tr", { has: page.locator("td", { hasText: "en-US" }) }).first()
  ).toContainText("enabled");
  await expect(page.locator('button[data-action="disable"][data-variant="en-US"]')).toBeVisible();
});

test("admin shell supports manual provider update checks", async ({ page }) => {
  const state = {
    imported: true,
    enabled: true,
    commit: "0123456789abcdef0123456789abcdef01234567"
  };

  await page.route("**/api/admin/providers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        providers: createProviderRows(state)
      })
    });
  });

  await page.route("**/api/admin/providers/en-US/check-update", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        variant: "en-US",
        status: "update-available",
        currentCommit: "0123456789abcdef0123456789abcdef01234567",
        latestCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        message: "A newer upstream commit is available for this variant.",
        providers: createProviderRows(state)
      })
    });
  });

  await page.goto("/admin", { waitUntil: "commit" });
  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");
  await expect(page.locator("#shellPanel")).toBeVisible();

  await page.click('button[data-action="check-update"][data-variant="en-US"]');
  await expect(page.locator("#workspaceStatus")).toContainText("update available");
  const usRow = page
    .locator("#providersBody tr", { has: page.locator("td", { hasText: "en-US" }) })
    .first();
  await expect(usRow).toContainText("Upstream check: update available");
});

test("admin shell surfaces provider warning and error details", async ({ page }) => {
  await page.route("**/api/admin/providers", async (route) => {
    const providers = createProviderRows({ imported: false, enabled: false, commit: "" });
    const errorRow = providers.find((provider) => provider.variant === "en-US");
    const warningRow = providers.find((provider) => provider.variant === "en-GB");
    if (errorRow) {
      errorRow.status = "error";
      errorRow.error = "Incomplete artifacts found for commits: deadbeef.";
      errorRow.incompleteCommits = ["deadbeef"];
    }
    if (warningRow) {
      warningRow.status = "enabled";
      warningRow.enabled = true;
      warningRow.warning = "Incomplete artifacts found for commits: cafe.";
      warningRow.incompleteCommits = ["cafe"];
      warningRow.imported = true;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        providers
      })
    });
  });

  await page.goto("/admin", { waitUntil: "commit" });
  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");
  await expect(page.locator("#shellPanel")).toBeVisible();

  const usRow = page
    .locator("#providersBody tr", { has: page.locator("td", { hasText: "en-US" }) })
    .first();
  await expect(usRow).toContainText("error");
  await expect(usRow).toContainText("Incomplete artifacts found for commits: deadbeef.");

  const gbRow = page
    .locator("#providersBody tr", { has: page.locator("td", { hasText: "en-GB" }) })
    .first();
  await expect(gbRow).toContainText("enabled");
  await expect(gbRow).toContainText("Incomplete artifacts found for commits: cafe.");
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

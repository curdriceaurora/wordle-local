const { test, expect } = require("@playwright/test");

test("create page generates encoded link", async ({ page }) => {
  await page.goto("/");
  await page.selectOption("#langSelect", "none");
  await page.fill("#wordInput", "JACKS");
  await page.fill("#guessInput", "4");
  await page.click("form#createForm button[type=submit]");
  await expect(page.locator("#shareLink")).toHaveValue(/word=fotnd/i);
  await expect(page.locator("#shareLink")).toHaveValue(/g=4/);
  await expect(page.locator("#playMeta")).toContainText("4 tries");
});

test("random word generates link", async ({ page }) => {
  await page.goto("/");
  await page.selectOption("#langSelect", "en");
  await page.fill("#lengthInput", "5");
  await page.click("#randomBtn");
  await expect(page.locator("#shareLink")).not.toHaveValue("");
});

test("play puzzle from encoded link", async ({ page }) => {
  await page.goto("/?word=fotnd&lang=none");
  await page.waitForSelector("#board");
  await page.keyboard.type("JACKS");
  await page.keyboard.press("Enter");
  await expect(page.locator("#message")).toContainText("Solved in 1/6");
});

test("strict mode enforces revealed hints", async ({ page }) => {
  await page.goto("/?word=fotnd&lang=none");
  await page.check("#strictToggle");
  await page.keyboard.type("JELLO");
  await page.keyboard.press("Enter");
  await page.keyboard.type("APPLE");
  await page.keyboard.press("Enter");
  await expect(page.locator("#message")).toContainText("Strict mode");
});

test("strict mode requires repeated letters when revealed", async ({ page }) => {
  await page.goto("/");
  await page.selectOption("#langSelect", "none");
  await page.fill("#wordInput", "LEVEL");
  await page.click("form#createForm button[type=submit]");
  await page.check("#strictToggle");
  await page.keyboard.type("ALLOT");
  await page.keyboard.press("Enter");
  await expect(page.locator("#board .row:nth-child(1) .tile.present")).toHaveCount(2);
  await page.keyboard.type("LAMER");
  await page.keyboard.press("Enter");
  await expect(page.locator("#message")).toContainText("L x2");
});

test("high contrast toggle updates theme", async ({ page }) => {
  await page.goto("/");
  await page.check("#contrastToggle");
  await expect(page.locator("body")).toHaveClass(/high-contrast/);
});

test("language selection updates minimum length", async ({ page }) => {
  await page.goto("/");
  await page.selectOption("#langSelect", "es");
  await expect(page.locator("#lengthInput")).toHaveAttribute("min", "5");
  await expect(page.locator(".hint")).toContainText("5-12");
});

test("share link info modal opens and closes", async ({ page }) => {
  await page.goto("/");
  await page.selectOption("#langSelect", "none");
  await page.fill("#wordInput", "JACKS");
  await page.click("form#createForm button[type=submit]");
  await page.waitForSelector("#playPanel:not(.hidden)");
  const modal = page.locator("#shareModal");

  await expect(modal).toHaveAttribute("aria-hidden", "true");
  await page.click("#shareInfoBtn");
  await expect(modal).toHaveClass(/is-open/);
  await expect(modal).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#shareModalDesc")).toContainText("not secure");

  await page.keyboard.press("Escape");
  await expect(modal).not.toHaveClass(/is-open/);
  await expect(modal).toHaveAttribute("aria-hidden", "true");
});

test("invalid share link shows interstitial and redirects", async ({ page }) => {
  await page.addInitScript(() => {
    const originalSetInterval = window.setInterval;
    window.setInterval = (fn, delay, ...args) => originalSetInterval(fn, 100, ...args);
  });

  await page.goto("/?word=!!!");
  await expect(page.locator("#errorPanel")).toBeVisible();
  await expect(page.locator("#errorMessage")).toContainText("That link doesn't work");
  await expect(page.locator("#errorCountdown")).toContainText("Going back in");
  await page.waitForURL("/", { timeout: 2000 });
});

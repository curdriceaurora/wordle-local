const { test, expect } = require("./fixtures");
const gotoOptions = { waitUntil: "commit" };
const RUN_TOKEN =
  Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 6).toUpperCase() || "RUNNER";

function todayLocalDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function waitForLanguages(page) {
  await page.waitForSelector("#langSelect option", { state: "attached" });
}

test("create page generates encoded link", async ({ page }) => {
  await page.goto("/", gotoOptions);
  await waitForLanguages(page);
  await page.selectOption("#langSelect", "en");
  await page.fill("#wordInput", "CRANE");
  await page.fill("#guessInput", "4");
  await page.click("form#createForm button[type=submit]");
  await expect(page.locator("#shareLink")).toHaveValue(/word=yfrqp/i);
  await expect(page.locator("#shareLink")).toHaveValue(/g=4/);
  await expect(page.locator("#playMeta")).toContainText("4 tries");
});

test("random word generates link", async ({ page }) => {
  await page.goto("/", gotoOptions);
  await waitForLanguages(page);
  await page.selectOption("#langSelect", "en");
  await page.fill("#lengthInput", "5");
  await page.click("#randomBtn");
  await expect(page.locator("#shareLink")).not.toHaveValue("");
});

test("play puzzle from encoded link", async ({ page }) => {
  await page.goto("/?word=yfrqp&lang=en", gotoOptions);
  await page.waitForSelector("#board");
  // Firefox can leave focus on non-game chrome after initial navigation; click board to bind keystrokes.
  await page.click("#board");
  await page.keyboard.type("CRANE");
  await page.keyboard.press("Enter");
  await expect(page.locator("#message")).toContainText("Solved in 1/6");
});

test("shows local meaning when english puzzle is solved", async ({ page }) => {
  await page.goto("/", gotoOptions);
  await waitForLanguages(page);
  await page.selectOption("#langSelect", "en");
  await page.fill("#wordInput", "CRANE");
  await page.click("form#createForm button[type=submit]");
  await page.waitForSelector("#playPanel:not(.hidden)");
  await page.keyboard.type("CRANE");
  await page.keyboard.press("Enter");
  await expect(page.locator("#message")).toContainText("Solved in 1/6!");
  await expect(page.locator("#message")).toContainText("Meaning:");
});

test("reveals a local meaning after final failed guess", async ({ page }) => {
  await page.goto("/", gotoOptions);
  await waitForLanguages(page);
  await page.selectOption("#langSelect", "en");
  await page.fill("#wordInput", "CRANE");
  await page.click("form#createForm button[type=submit]");
  await page.waitForSelector("#playPanel:not(.hidden)");

  const failedGuesses = ["SLATE", "CRATE", "STONE", "TRAIL", "ABATE", "ADORE"];
  for (let i = 0; i < failedGuesses.length; i += 1) {
    await page.keyboard.type(failedGuesses[i]);
    await page.keyboard.press("Enter");
    await expect(
      page.locator(
        `#board .row:nth-child(${i + 1}) .tile.absent, #board .row:nth-child(${i + 1}) .tile.present, #board .row:nth-child(${i + 1}) .tile.correct`
      )
    ).toHaveCount(5);
  }

  await expect(page.locator("#message")).toContainText("Out of tries. Word was CRANE.");
  await expect(page.locator("#message")).toContainText("Meaning:");
});

test("daily mode requires a player name and updates leaderboard stats", async ({ page }) => {
  const playerName = `Ava ${RUN_TOKEN}`;
  await page.goto(`/?word=yfrqp&lang=en&daily=1&day=${todayLocalDate()}`, gotoOptions);
  await page.waitForSelector("#playPanel:not(.hidden)");
  await expect(page.locator("#profilePanel")).toBeVisible();

  await page.keyboard.type("CRANE");
  await page.keyboard.press("Enter");
  await expect(page.locator("#message")).toContainText("Pick a player name");

  await expect(page.locator("#profileNameInput")).toBeEnabled();
  await page.fill("#profileNameInput", playerName);
  await page.click("#profileForm button[type=submit]");
  await expect(page.locator("#activePlayerWrap")).toContainText(playerName);

  await page.keyboard.type("CRANE");
  await page.keyboard.press("Enter");
  await expect(page.locator("#message")).toContainText("Solved in 1/6!");

  await expect(page.locator("#statPlayed")).toHaveText("1");
  await expect(page.locator("#statWinRate")).toHaveText("100%");
  await expect(page.locator("#statStreak")).toHaveText("1");
  await expect(page.locator("#statBest")).toHaveText("1");
  await expect(page.locator("#leaderboardBody")).toContainText(playerName);

  await page.selectOption("#leaderboardRange", "overall");
  await expect(page.locator("#leaderboardMeta")).toContainText("All recorded daily games");
});

test("strict mode enforces revealed hints", async ({ page }) => {
  await page.goto("/?word=yfrqp&lang=en", gotoOptions);
  await page.waitForSelector("#playPanel:not(.hidden)");
  await expect(page.locator("#updated")).toContainText("Game ready");
  await page.check("#strictToggle");
  await page.keyboard.type("CRATE");
  await page.keyboard.press("Enter");
  await expect(
    page.locator(
      "#board .row:nth-child(1) .tile.absent, #board .row:nth-child(1) .tile.present, #board .row:nth-child(1) .tile.correct"
    )
  ).toHaveCount(5);
  await page.keyboard.type("BLOOM");
  await page.keyboard.press("Enter");
  await expect(page.locator("#message")).toContainText("Strict mode");
});

test("strict mode requires repeated letters when revealed", async ({ page }) => {
  await page.goto("/", gotoOptions);
  await waitForLanguages(page);
  await page.selectOption("#langSelect", "en");
  await page.fill("#wordInput", "LEVEL");
  await page.click("form#createForm button[type=submit]");
  await page.waitForSelector("#playPanel:not(.hidden)");
  await expect(page.locator("#updated")).toContainText("Game ready");
  await page.check("#strictToggle");
  await page.keyboard.type("ALLOT");
  await page.keyboard.press("Enter");
  await expect(page.locator("#board .row:nth-child(1) .tile.present")).toHaveCount(2);
  await page.keyboard.type("LAMER");
  await page.keyboard.press("Enter");
  await expect(page.locator("#message")).toContainText("L x2");
});

test("high contrast toggle updates theme", async ({ page }) => {
  await page.goto("/", gotoOptions);
  await page.check("#contrastToggle");
  await expect(page.locator("body")).toHaveClass(/high-contrast/);
});

test("theme selector persists explicit light and dark preferences", async ({ page }) => {
  await page.goto("/", gotoOptions);
  await page.selectOption("#themeSelect", "light");
  await expect(page.locator("html")).toHaveClass(/theme-light/);

  await page.reload(gotoOptions);
  await expect(page.locator("#themeSelect")).toHaveValue("light");
  await expect(page.locator("html")).toHaveClass(/theme-light/);

  await page.selectOption("#themeSelect", "dark");
  await expect(page.locator("html")).toHaveClass(/theme-dark/);
});

test("system theme preference follows browser color-scheme changes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/", gotoOptions);
  await expect(page.locator("#themeSelect")).toHaveValue("system");
  await expect(page.locator("html")).toHaveClass(/theme-light/);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/theme-dark/);
});

test("language selection updates minimum length", async ({ page }) => {
  await page.goto("/", gotoOptions);
  await waitForLanguages(page);
  await page.selectOption("#langSelect", "en");
  await expect(page.locator("#lengthInput")).toHaveAttribute("min", "3");
  await expect(page.locator(".hint")).toContainText("3-12");
});

test("share link info modal opens and closes", async ({ page, browserName }) => {
  await page.goto("/", gotoOptions);
  await waitForLanguages(page);
  await page.selectOption("#langSelect", "en");
  await page.fill("#wordInput", "CRANE");
  await page.click("form#createForm button[type=submit]");
  await page.waitForSelector("#playPanel:not(.hidden)");
  const modal = page.locator("#shareModal");
  const infoButton = page.locator("#shareInfoBtn");
  const closeButton = page.locator("#shareModalClose");

  await expect(modal).toHaveAttribute("aria-hidden", "true");
  await infoButton.click();
  await expect(modal).toHaveClass(/is-open/);
  await expect(modal).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#shareModalDesc")).toContainText("not secure");
  await expect(closeButton).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(modal).not.toHaveClass(/is-open/);
  await expect(modal).toHaveAttribute("aria-hidden", "true");
  if (browserName !== "webkit") {
    await expect(infoButton).toBeFocused();
  }
});

test("invalid share link shows interstitial and redirects", async ({ page }) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    const originalSetInterval = window.setInterval;
    window.setInterval = (fn, delay, ...args) => originalSetInterval(fn, 100, ...args);
  });

  await page.goto("/?word=!!!", gotoOptions);
  await expect(page.locator("#errorPanel")).toBeVisible({ timeout: 10000 });
  await expect(page.locator("#errorMessage")).toContainText("That link doesn't work");
  await expect(page.locator("#errorCountdown")).toContainText("Going back in");
  await page.waitForURL("/", { timeout: 2000 });
});

test("share link copy shows confirmation", async ({ page }) => {
  test.setTimeout(60000);
  await page.goto("/?word=yfrqp&lang=en", gotoOptions);
  await page.waitForSelector("#playPanel:not(.hidden)", { timeout: 10000 });
  await page.click("#shareCopyBtn");
  await expect(page.locator("#message")).toContainText("Share link copied.");
});

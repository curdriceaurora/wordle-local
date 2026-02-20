const { test, expect } = require("./fixtures");

const gotoOptions = { waitUntil: "commit" };
const DAILY_WORD_CODE = "fotnd"; // JACKS
const DAILY_LANG = "none";
const WRONG_GUESSES = ["PLANT", "MERRY", "VIVID", "QUEUE", "BLOOM", "TRUCK"];
const RUN_TOKEN =
  Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 6).toUpperCase() || "RUNNER";

function buildProfileName(prefix, browserName) {
  return `${prefix} ${RUN_TOKEN}${browserName.slice(0, 1).toUpperCase()}`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function localDateOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDateFromDate(date);
}

function localDateFromDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDateOutsideCurrentMonthAndWeek() {
  const today = new Date();
  const currentMonth = today.getMonth();
  for (let days = 8; days <= 120; days += 1) {
    const candidate = new Date(today);
    candidate.setDate(candidate.getDate() - days);
    if (candidate.getMonth() !== currentMonth) {
      return localDateFromDate(candidate);
    }
  }
  return localDateOffset(-40);
}

function dailyLink(day) {
  return `/?word=${DAILY_WORD_CODE}&lang=${DAILY_LANG}&daily=1&day=${day}`;
}

async function openDaily(page, day, options = {}) {
  const expectProfilePanel = options.expectProfilePanel !== false;
  await page.goto(dailyLink(day), gotoOptions);
  await page.waitForSelector("#playPanel:not(.hidden)");
  if (expectProfilePanel) {
    await expect(page.locator("#profilePanel")).toBeVisible();
  }
}

async function createIsolatedPage(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);
  return { context, page };
}

async function selectProfile(page, name) {
  const activeWrap = page.locator("#activePlayerWrap");
  if (await activeWrap.isVisible()) {
    await page.click("#switchPlayerBtn");
  }

  const existingChip = page.locator("#savedPlayers .player-chip", {
    hasText: new RegExp(`^${escapeRegex(name)}(?: \\(active\\))?$`)
  });
  if (await existingChip.count()) {
    await existingChip.first().click();
    await expect(activeWrap).toContainText(name);
    await expect(page.locator("#keyboard")).not.toHaveClass(/locked/);
    return;
  }

  await expect(page.locator("#profileNameInput")).toBeVisible();
  await page.fill("#profileNameInput", name);
  await page.click("#profileForm button[type=submit]");
  await expect(page.locator("#activePlayerWrap")).toContainText(name);
  await expect(page.locator("#keyboard")).not.toHaveClass(/locked/);
}

async function solveInOne(page) {
  await page.keyboard.type("JACKS");
  await page.keyboard.press("Enter");
  await expect(
    page.locator(
      "#board .row:nth-child(1) .tile.absent, #board .row:nth-child(1) .tile.present, #board .row:nth-child(1) .tile.correct"
    )
  ).toHaveCount(5);
  await expect(page.locator("#message")).toContainText("Solved in 1/6!");
}

async function solveInTwo(page) {
  await page.keyboard.type("PLANT");
  await page.keyboard.press("Enter");
  await expect(
    page.locator(
      "#board .row:nth-child(1) .tile.absent, #board .row:nth-child(1) .tile.present, #board .row:nth-child(1) .tile.correct"
    )
  ).toHaveCount(5);
  await page.keyboard.type("JACKS");
  await page.keyboard.press("Enter");
  await expect(
    page.locator(
      "#board .row:nth-child(2) .tile.absent, #board .row:nth-child(2) .tile.present, #board .row:nth-child(2) .tile.correct"
    )
  ).toHaveCount(5);
  await expect(page.locator("#message")).toContainText("Solved in 2/6!");
}

async function losePuzzle(page) {
  for (let i = 0; i < WRONG_GUESSES.length; i += 1) {
    const guess = WRONG_GUESSES[i];
    await page.keyboard.type(guess);
    await page.keyboard.press("Enter");
    await expect(
      page.locator(
        `#board .row:nth-child(${i + 1}) .tile.absent, #board .row:nth-child(${i + 1}) .tile.present, #board .row:nth-child(${i + 1}) .tile.correct`
      )
    ).toHaveCount(5);
  }
  await expect(page.locator("#message")).toContainText("Out of tries.");
}

test("concurrent clients persist results for different profiles", async ({ page, browser, browserName }) => {
  const day = localDateOffset(0);
  const playerA = buildProfileName("Drew", browserName);
  const playerB = buildProfileName("Eli", browserName);

  await openDaily(page, day);

  const isolatedA = await createIsolatedPage(browser);
  const isolatedB = await createIsolatedPage(browser);
  try {
    const pageA = isolatedA.page;
    const pageB = isolatedB.page;

    await Promise.all([openDaily(pageA, day), openDaily(pageB, day)]);
    await Promise.all([selectProfile(pageA, playerA), selectProfile(pageB, playerB)]);
    await Promise.all([solveInOne(pageA), solveInTwo(pageB)]);

    await openDaily(page, day);
    await expect(page.locator("#leaderboardBody")).toContainText(playerA);
    await expect(page.locator("#leaderboardBody")).toContainText(playerB);

    await selectProfile(page, playerA);
    await expect(page.locator("#statPlayed")).toHaveText("1");
    await expect(page.locator("#statBest")).toHaveText("1");

    await selectProfile(page, playerB);
    await expect(page.locator("#statPlayed")).toHaveText("1");
    await expect(page.locator("#statBest")).toHaveText("2");
  } finally {
    await isolatedA.context.close();
    await isolatedB.context.close();
  }
});

test("concurrent clients submitting same profile preserve best-attempt outcome", async ({ page, browser, browserName }) => {
  const day = localDateOffset(0);
  const sharedPlayer = buildProfileName("Finn", browserName);

  await openDaily(page, day);
  await selectProfile(page, sharedPlayer);

  const isolatedA = await createIsolatedPage(browser);
  const isolatedB = await createIsolatedPage(browser);
  try {
    const pageA = isolatedA.page;
    const pageB = isolatedB.page;

    await Promise.all([openDaily(pageA, day), openDaily(pageB, day)]);
    await Promise.all([selectProfile(pageA, sharedPlayer), selectProfile(pageB, sharedPlayer)]);
    await Promise.all([solveInTwo(pageA), solveInOne(pageB)]);

    await openDaily(page, day);
    await selectProfile(page, sharedPlayer);
    await expect(page.locator("#statPlayed")).toHaveText("1");
    await expect(page.locator("#statWinRate")).toHaveText("100%");
    await expect(page.locator("#statBest")).toHaveText("1");

    const playerRow = page.locator("#leaderboardBody tr", { hasText: sharedPlayer }).first();
    await expect(playerRow.locator("td").nth(2)).toHaveText("1");
    await expect(playerRow.locator("td").nth(3)).toHaveText("1");
  } finally {
    await isolatedA.context.close();
    await isolatedB.context.close();
  }
});

test("server-backed daily stats persist across browser contexts", async ({ page, browser, browserName }) => {
  const playerName = buildProfileName("Ava", browserName);
  const day = localDateOffset(0);

  await openDaily(page, day);
  await selectProfile(page, playerName);
  await solveInOne(page);
  await expect(page.locator("#statPlayed")).toHaveText("1");
  await expect(page.locator("#statBest")).toHaveText("1");

  const isolated = await createIsolatedPage(browser);
  try {
    const page2 = isolated.page;
    await openDaily(page2, day);
    await expect(page2.locator("#leaderboardBody")).toContainText(playerName);
    await selectProfile(page2, playerName);
    await expect(page2.locator("#statPlayed")).toHaveText("1");
    await expect(page2.locator("#statWinRate")).toHaveText("100%");
    await expect(page2.locator("#statBest")).toHaveText("1");
  } finally {
    await isolated.context.close();
  }
});

test("server replay policy keeps best attempts for repeated same-day submissions", async ({ page, browser, browserName }) => {
  const playerName = buildProfileName("Ben", browserName);
  const day = localDateOffset(0);

  await openDaily(page, day);
  await selectProfile(page, playerName);
  await solveInTwo(page);
  await expect(page.locator("#statPlayed")).toHaveText("1");
  await expect(page.locator("#statBest")).toHaveText("2");

  const isolated = await createIsolatedPage(browser);
  try {
    const page2 = isolated.page;
    await openDaily(page2, day);
    await selectProfile(page2, playerName);
    await solveInOne(page2);
    await expect(page2.locator("#statPlayed")).toHaveText("1");
    await expect(page2.locator("#statBest")).toHaveText("1");
    await expect(page2.locator("#leaderboardBody")).toContainText(playerName);
  } finally {
    await isolated.context.close();
  }
});

test("leaderboard range uses server-side date windows", async ({ page, browserName }) => {
  const playerName = buildProfileName("Cora", browserName);
  const oldDay = localDateOutsideCurrentMonthAndWeek();
  const recentDay = localDateOffset(0);

  await openDaily(page, oldDay);
  await selectProfile(page, playerName);
  await solveInOne(page);

  await openDaily(page, recentDay);
  await selectProfile(page, playerName);
  await losePuzzle(page);

  await expect(page.locator("#statPlayed")).toHaveText("2");
  await expect(page.locator("#statWinRate")).toHaveText("50%");

  await page.selectOption("#leaderboardRange", "weekly");
  let playerRow = page.locator("#leaderboardBody tr", { hasText: playerName }).first();
  await expect(playerRow.locator("td").nth(3)).toHaveText("1");

  await page.selectOption("#leaderboardRange", "monthly");
  playerRow = page.locator("#leaderboardBody tr", { hasText: playerName }).first();
  await expect(playerRow.locator("td").nth(3)).toHaveText("1");

  await page.selectOption("#leaderboardRange", "overall");
  playerRow = page.locator("#leaderboardBody tr", { hasText: playerName }).first();
  await expect(playerRow.locator("td").nth(3)).toHaveText("2");
});

test("daily puzzle remains playable when stats service is unavailable", async ({ page }) => {
  const day = localDateOffset(0);
  await page.route("**/api/stats/**", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Stats service unavailable right now. Try again soon." })
    });
  });

  await openDaily(page, day, { expectProfilePanel: false });
  await expect(page.locator("#profilePanel")).toBeHidden();
  await expect(page.locator("#leaderboardPanel")).toBeHidden();
  await expect(page.locator("#keyboard")).not.toHaveClass(/locked/);
  await expect(page.locator("#message")).toContainText("temporarily unavailable");

  await solveInOne(page);
});

const { test, expect } = require("./fixtures");
const AxeBuilder = require("@axe-core/playwright");

test.use({ serviceWorkers: "block" });

async function blockServiceWorkerScript(page) {
  await page.route("**/sw.js", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/javascript",
      body: ""
    });
  });
}

test.beforeEach(async ({ page }) => {
  await blockServiceWorkerScript(page);
});

const RUNTIME_CONFIG_RESPONSE = {
  effective: {
    definitions: { mode: "memory", cacheSize: 0, cacheTtlMs: 0, shardCacheSize: 0 },
    limits: {
      providerManualMaxFileBytes: 1048576,
      leaderboardMaxProfiles: 50,
      leaderboardMaxResultsPerProfile: 400
    },
    diagnostics: { perfLogging: false }
  },
  sources: {},
  locks: {}
};

const PROVIDERS_RESPONSE = { providers: [] };
const PROFILES_RESPONSE = {
  profiles: [],
  meta: {
    leaderboardMaxProfiles: 50,
    leaderboardMaxResultsPerProfile: 400,
    leaderboardMaxProfilesEnvLocked: false,
    leaderboardMaxResultsPerProfileEnvLocked: false
  }
};
const JOBS_RESPONSE = { jobs: [], queue: { active: false, syncActive: false, queueDepth: 0 } };
const CLASSES_RESPONSE = { classes: [] };

function buildAnalyticsResponse(window) {
  const dayCount = window === "30d" ? 30 : window === "all" ? 14 : 7;
  const today = new Date("2026-05-07");
  const series = (label, baseValue) => {
    const out = [];
    for (let i = dayCount - 1; i >= 0; i -= 1) {
      const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
      out.push({ date: d.toISOString().slice(0, 10), value: baseValue + (i % 3) });
    }
    return out;
  };
  return {
    window,
    generatedAt: "2026-05-07T12:00:00.000Z",
    summary: {
      dau: window === "7d" ? 5 : window === "30d" ? 12 : 17,
      wau: 11,
      gamesInWindow: window === "7d" ? 28 : window === "30d" ? 130 : 200,
      winRate: 0.625,
      avgAttempts: 4.1,
      replayRate: 0.4,
      profileCount: 23
    },
    series: {
      dailyActive: series("DAU", 3),
      dailyGames: series("Games", 5),
      profileGrowth: series("growth", 20)
    },
    distributions: {
      attempts: [
        { bucket: "1", value: 0 },
        { bucket: "2", value: 1 },
        { bucket: "3", value: 5 },
        { bucket: "4", value: 9 },
        { bucket: "5", value: 7 },
        { bucket: "6", value: 3 },
        { bucket: "7", value: 1 },
        { bucket: "8", value: 0 },
        { bucket: "9", value: 0 },
        { bucket: "10", value: 0 },
        { bucket: "dnf", value: 3 }
      ],
      languageMix: [
        { lang: "en", value: 18 },
        { lang: "es", value: 10 }
      ],
      hourOfDay: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        value: hour >= 9 && hour <= 21 ? hour - 8 : 0
      }))
    }
  };
}

const EMPTY_ANALYTICS = {
  window: "7d",
  generatedAt: "2026-05-07T12:00:00.000Z",
  summary: {
    dau: 0, wau: 0, gamesInWindow: 0, winRate: 0,
    avgAttempts: 0, replayRate: 0, profileCount: 0
  },
  series: {
    dailyActive: Array.from({ length: 7 }, (_, i) => ({
      date: `2026-05-0${i + 1}`,
      value: 0
    })),
    dailyGames: Array.from({ length: 7 }, (_, i) => ({
      date: `2026-05-0${i + 1}`,
      value: 0
    })),
    profileGrowth: Array.from({ length: 7 }, (_, i) => ({
      date: `2026-05-0${i + 1}`,
      value: 0
    }))
  },
  distributions: {
    attempts: [
      { bucket: "1", value: 0 },
      { bucket: "2", value: 0 },
      { bucket: "3", value: 0 },
      { bucket: "4", value: 0 },
      { bucket: "5", value: 0 },
      { bucket: "6", value: 0 },
      { bucket: "7", value: 0 },
      { bucket: "8", value: 0 },
      { bucket: "9", value: 0 },
      { bucket: "10", value: 0 },
      { bucket: "dnf", value: 0 }
    ],
    languageMix: [],
    hourOfDay: Array.from({ length: 24 }, (_, hour) => ({ hour, value: 0 }))
  }
};

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

async function setupAdminMocks(page) {
  await page.route("/api/admin/runtime-config", (route) => fulfillJson(route, RUNTIME_CONFIG_RESPONSE));
  await page.route("/api/admin/providers", (route) => fulfillJson(route, PROVIDERS_RESPONSE));
  await page.route(/\/api\/admin\/stats\/profiles(\?.*)?$/, (route) => fulfillJson(route, PROFILES_RESPONSE));
  await page.route(/\/api\/admin\/jobs(\?.*)?$/, (route) => fulfillJson(route, JOBS_RESPONSE));
  await page.route(/\/api\/admin\/classes(\?.*)?$/, (route) => fulfillJson(route, CLASSES_RESPONSE));
}

test("Analytics tab renders charts, switches windows, and stays self-hosted", async ({ page }) => {
  await setupAdminMocks(page);
  const requestedWindows = [];
  await page.route(/\/api\/admin\/analytics(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const window = url.searchParams.get("window") || "7d";
    requestedWindows.push(window);
    return fulfillJson(route, buildAnalyticsResponse(window));
  });

  // Track all external network attempts during the analytics flow.
  // "External" here means anything that isn't localhost / 127.0.0.1 — the
  // test config runs the server on a localhost port; Chart.js is vendored
  // under same-origin /dist/vendor/, so no other host should ever be hit.
  const externalRequests = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const parsed = new URL(url);
    if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      externalRequests.push(url);
    }
  });

  await page.goto("/admin", { waitUntil: "commit" });
  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");
  await expect(page.locator("#shellPanel")).toBeVisible();

  await page.click("#admin-tab-analytics");
  await expect(page.locator("#admin-panel-analytics")).toBeVisible();

  // 7d cards populate.
  await expect(page.locator('[data-metric="gamesInWindow"]')).toHaveText("28");
  await expect(page.locator('[data-metric="winRate"]')).toHaveText("62.5%");
  await expect(page.locator('[data-metric="profileCount"]')).toHaveText("23");

  // Chart canvases are present and have non-empty aria-label.
  for (const id of [
    "analyticsActivityChart",
    "analyticsAttemptsChart",
    "analyticsLanguageChart",
    "analyticsHourChart"
  ]) {
    const canvas = page.locator(`#${id}`);
    await expect(canvas).toBeVisible();
    const ariaLabel = await canvas.getAttribute("aria-label");
    expect(ariaLabel).toBeTruthy();
    expect(ariaLabel.length).toBeGreaterThan(5);
  }

  // Data-table fallbacks are populated even though they're inside <details>.
  const activityRows = page.locator("#analyticsActivityTable tbody tr");
  await expect(activityRows).toHaveCount(7);

  // Window switch to 30d triggers a fresh fetch and updates cards.
  await page.click('[data-window="30d"]');
  await expect(page.locator('[data-metric="gamesInWindow"]')).toHaveText("130");
  await expect(page.locator('[data-window="30d"]')).toHaveAttribute("aria-checked", "true");
  await expect(page.locator('[data-window="7d"]')).toHaveAttribute("aria-checked", "false");

  // Window switch to all.
  await page.click('[data-window="all"]');
  await expect(page.locator('[data-metric="gamesInWindow"]')).toHaveText("200");

  // Confirm fresh fetch happened for each window.
  expect(requestedWindows).toContain("7d");
  expect(requestedWindows).toContain("30d");
  expect(requestedWindows).toContain("all");

  // No external network calls — Chart.js is vendored, all API is same-origin.
  expect(externalRequests).toEqual([]);
});

test("Analytics tab handles empty leaderboard without exceptions", async ({ page }) => {
  await setupAdminMocks(page);
  await page.route(/\/api\/admin\/analytics(\?.*)?$/, (route) =>
    fulfillJson(route, EMPTY_ANALYTICS)
  );

  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await page.goto("/admin", { waitUntil: "commit" });
  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");
  await expect(page.locator("#shellPanel")).toBeVisible();

  await page.click("#admin-tab-analytics");
  await expect(page.locator("#admin-panel-analytics")).toBeVisible();
  await expect(page.locator('[data-metric="gamesInWindow"]')).toHaveText("0");
  await expect(page.locator('[data-metric="profileCount"]')).toHaveText("0");
  await expect(page.locator("#analyticsStatus")).toContainText("No games recorded");

  // Charts still render the empty distributions; no thrown exceptions.
  expect(consoleErrors).toEqual([]);
});

test("Analytics tab passes axe a11y scan with no serious or critical violations", async ({ page }) => {
  await setupAdminMocks(page);
  await page.route(/\/api\/admin\/analytics(\?.*)?$/, (route) =>
    fulfillJson(route, buildAnalyticsResponse("7d"))
  );

  await page.goto("/admin", { waitUntil: "commit" });
  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");
  await expect(page.locator("#shellPanel")).toBeVisible();

  await page.click("#admin-tab-analytics");
  await expect(page.locator("#admin-panel-analytics")).toBeVisible();
  // Wait for cards to populate so axe scans the live state.
  await expect(page.locator('[data-metric="gamesInWindow"]')).toHaveText("28");

  const results = await new AxeBuilder({ page })
    .include("#admin-panel-analytics")
    .analyze();

  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical"
  );
  expect(blocking).toEqual([]);
});

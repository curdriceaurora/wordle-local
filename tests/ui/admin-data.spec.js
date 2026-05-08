const { test, expect } = require("./fixtures");

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

const PROVIDERS_RESPONSE = {
  providers: []
};

const PROFILES_RESPONSE = {
  profiles: [],
  meta: {
    leaderboardMaxProfiles: 50,
    leaderboardMaxResultsPerProfile: 400,
    leaderboardMaxProfilesEnvLocked: false,
    leaderboardMaxResultsPerProfileEnvLocked: false
  }
};

const JOBS_RESPONSE = {
  jobs: [],
  queue: { active: false, syncActive: false, queueDepth: 0 }
};

const CLASSES_RESPONSE = { classes: [] };

const PREVIEW_RESPONSE = {
  ok: true,
  manifestVersion: 1,
  appVersion: "1.0.0-test",
  createdAt: "2026-01-01T00:00:00.000Z",
  nodeId: "test-node",
  files: [
    { path: "data/leaderboard.json", bytes: 128, sha256: "0".repeat(64), ok: true },
    { path: "data/admin-jobs.json", bytes: 64, sha256: "1".repeat(64), ok: true }
  ],
  totalBytes: 192,
  warnings: []
};

const RESTORE_RESPONSE = {
  ok: true,
  restored: ["data/leaderboard.json", "data/admin-jobs.json"],
  filesRestored: 2,
  rolledBackOnError: false,
  warnings: [],
  reloads: [
    { name: "leaderboardStore", ok: true },
    { name: "adminJobsStore", ok: true }
  ]
};

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

test("admin Data tab supports export, preview, typed-confirm gate, and apply", async ({ page }) => {
  await page.route("/api/admin/runtime-config", (route) => fulfillJson(route, RUNTIME_CONFIG_RESPONSE));
  await page.route("/api/admin/providers", (route) => fulfillJson(route, PROVIDERS_RESPONSE));
  await page.route(/\/api\/admin\/stats\/profiles(\?.*)?$/, (route) =>
    fulfillJson(route, PROFILES_RESPONSE)
  );
  await page.route(/\/api\/admin\/jobs(\?.*)?$/, (route) => fulfillJson(route, JOBS_RESPONSE));
  await page.route(/\/api\/admin\/classes(\?.*)?$/, (route) => fulfillJson(route, CLASSES_RESPONSE));

  // Export: serve a tiny fake zip with a Content-Disposition header so the
  // client's download path triggers without a real archiver in play.
  await page.route(/\/api\/admin\/backup(\?.*)?$/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/zip",
      headers: {
        "Content-Disposition": 'attachment; filename="wordle-backup-test.zip"'
      },
      body: Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    });
  });

  await page.route("/api/admin/backup/preview", (route) => fulfillJson(route, PREVIEW_RESPONSE));
  // Assert the destructive headers on the restore mock — the typed-confirm
  // gate is the headline guarantee of this PR, so a future regression in
  // app.js that drops x-admin-key or x-admin-confirm should fail this test
  // rather than silently pass.
  await page.route("/api/admin/restore", (route) => {
    const headers = route.request().headers();
    if (headers["x-admin-key"] !== "demo-key" || headers["x-admin-confirm"] !== "I-UNDERSTAND") {
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "missing required restore confirm headers" })
      });
    }
    return fulfillJson(route, RESTORE_RESPONSE);
  });

  await page.goto("/admin", { waitUntil: "commit" });
  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");
  await expect(page.locator("#shellPanel")).toBeVisible();

  // Activate Data tab
  await page.click("#admin-tab-data");
  await expect(page.locator("#admin-panel-data")).toBeVisible();
  await expect(page.locator("#backupExportBtn")).toBeVisible();

  // Export — wait for the download to start (browser will catch the
  // attachment response).
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#backupExportBtn")
  ]);
  expect(download.suggestedFilename()).toContain("wordle-backup");
  await expect(page.locator("#backupExportStatus")).toContainText("Downloaded");

  // Preview — upload a fake zip file.
  await page.setInputFiles("#backupRestoreFile", {
    name: "test-archive.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("PK")
  });
  await page.click("#backupRestorePreviewBtn");
  await expect(page.locator("#backupRestoreDialog")).toBeVisible();
  // Summary now renders as a definition list; assert label + value
  // appear together in the panel text without being colon-joined.
  await expect(page.locator("#backupRestorePreviewSummary")).toContainText("Manifest version");
  await expect(page.locator("#backupRestorePreviewSummary dd").first()).toHaveText("1");
  await expect(page.locator("#backupRestoreApplyBtn")).toBeDisabled();

  // Typed-confirm gate — wrong text leaves it disabled.
  await page.fill("#backupRestoreConfirmInput", "WRONG");
  await expect(page.locator("#backupRestoreApplyBtn")).toBeDisabled();

  // Right text enables apply, then apply succeeds.
  await page.fill("#backupRestoreConfirmInput", "RESTORE");
  await expect(page.locator("#backupRestoreApplyBtn")).toBeEnabled();
  await page.click("#backupRestoreApplyBtn");
  await expect(page.locator("#backupRestoreStatus")).toContainText("Restore complete");
});

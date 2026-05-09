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

function emptySchedule() {
  return {
    version: 1,
    updatedAt: "2026-05-08T00:00:00.000Z",
    timezone: "UTC",
    auto_rotate: false,
    retention_days: 90,
    scheduled_words: []
  };
}

function scheduleWith(entries, overrides = {}) {
  return { ...emptySchedule(), ...overrides, scheduled_words: entries };
}

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

test("Schedule tab loads, adds, edits, deletes entries and triggers config + reconcile", async ({ page }) => {
  await setupAdminMocks(page);
  // The mocks for /api/admin/schedule mutate this in-place so successive
  // GETs reflect the most recent POST/PUT/DELETE — gives us a small
  // back-end without standing up the real server.
  let snapshot = scheduleWith([]);
  let lastReconcileTriggered = null;

  await page.route(/\/api\/admin\/schedule(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname === "/api/admin/schedule") {
      return fulfillJson(route, snapshot);
    }
    return route.fallback();
  });
  await page.route(/\/api\/admin\/schedule\/entries(\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() || "{}");
      const overwrite = new URL(route.request().url()).searchParams.get("overwrite") === "true";
      const idx = snapshot.scheduled_words.findIndex(
        (e) => e.date === body.date && e.lang === body.lang
      );
      if (idx !== -1 && !overwrite) {
        return fulfillJson(
          route,
          { error: "duplicate", code: "DUPLICATE_ENTRY" },
          409
        );
      }
      const entry = { date: body.date, word: body.word, lang: body.lang };
      if (body.notes) entry.notes = body.notes;
      if (idx !== -1) snapshot.scheduled_words.splice(idx, 1, entry);
      else snapshot.scheduled_words.push(entry);
      return fulfillJson(
        route,
        { ok: true, entry, replaced: idx !== -1, schedule: snapshot },
        idx !== -1 ? 200 : 201
      );
    }
    return route.fallback();
  });
  await page.route(/\/api\/admin\/schedule\/entries\/[^/]+\/[^/]+$/, async (route) => {
    if (route.request().method() === "DELETE") {
      const segs = new URL(route.request().url()).pathname.split("/");
      const lang = decodeURIComponent(segs.pop());
      const date = decodeURIComponent(segs.pop());
      const idx = snapshot.scheduled_words.findIndex((e) => e.date === date && e.lang === lang);
      if (idx === -1) return fulfillJson(route, { error: "not found", code: "ENTRY_NOT_FOUND" }, 404);
      snapshot.scheduled_words.splice(idx, 1);
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  await page.route("/api/admin/schedule/config", async (route) => {
    if (route.request().method() === "PUT") {
      const body = JSON.parse(route.request().postData() || "{}");
      Object.assign(snapshot, body);
      return fulfillJson(route, { ok: true, schedule: snapshot });
    }
    return route.fallback();
  });
  await page.route("/api/admin/schedule/reconcile", async (route) => {
    lastReconcileTriggered = "yes";
    return fulfillJson(route, {
      ok: true,
      result: { action: "noop", todayLocal: "2026-05-08", reason: "ALREADY_RECONCILED" }
    });
  });

  // Auto-confirm window.confirm before any delete fires.
  await page.addInitScript(() => {
    window.confirm = () => true;
  });

  await page.goto("/admin", { waitUntil: "commit" });
  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");
  await expect(page.locator("#shellPanel")).toBeVisible();

  await page.click("#admin-tab-schedule");
  await expect(page.locator("#admin-panel-schedule")).toBeVisible();
  await expect(page.locator("#scheduleTimezoneInput")).toHaveValue("UTC");

  // Add an entry.
  await page.fill("#scheduleEntryDate", "2026-05-09");
  await page.fill("#scheduleEntryWord", "crane");
  await page.fill("#scheduleEntryLang", "en");
  await page.click("#scheduleEntryForm button[type=submit]");
  await expect(page.locator("#scheduleStatus")).toContainText("Entry added");
  await expect(page.locator("#scheduleEntriesTable tbody tr")).toHaveCount(1);
  await expect(page.locator("#scheduleEntriesTable tbody tr").first()).toContainText("CRANE");

  // Toggle config + save.
  await page.check("#scheduleAutoRotate");
  await page.fill("#scheduleRetentionDays", "30");
  await page.click("#scheduleConfigForm button[type=submit]");
  await expect(page.locator("#scheduleStatus")).toContainText("Configuration saved");

  // Trigger reconcile.
  await page.click("#scheduleReconcileBtn");
  await expect(page.locator("#scheduleStatus")).toContainText("Reconcile complete");
  expect(lastReconcileTriggered).toBe("yes");

  // Delete the entry.
  await page.click("#scheduleEntriesTable tbody tr .schedule-delete-btn");
  await expect(page.locator("#scheduleEntriesTable tbody tr")).toHaveCount(1);
  await expect(page.locator("#scheduleEntriesTable tbody tr").first()).toContainText(
    "No scheduled entries yet"
  );
});

test("Schedule tab passes axe a11y scan with no serious or critical violations", async ({ page }) => {
  await setupAdminMocks(page);
  await page.route(/\/api\/admin\/schedule(\?.*)?$/, (route) =>
    fulfillJson(route, scheduleWith([{ date: "2026-05-08", word: "CRANE", lang: "en" }]))
  );

  await page.goto("/admin", { waitUntil: "commit" });
  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");
  await expect(page.locator("#shellPanel")).toBeVisible();

  await page.click("#admin-tab-schedule");
  await expect(page.locator("#admin-panel-schedule")).toBeVisible();
  await expect(page.locator("#scheduleEntriesTable tbody tr").first()).toContainText("CRANE");

  const results = await new AxeBuilder({ page })
    .include("#admin-panel-schedule")
    .analyze();

  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical"
  );
  expect(blocking).toEqual([]);
});

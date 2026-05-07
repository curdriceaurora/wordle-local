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

const PROVIDER_ROWS = [
  { variant: "en-GB", label: "English (UK)" },
  { variant: "en-US", label: "English (US)" },
  { variant: "en-CA", label: "English (Canada)" },
  { variant: "en-AU", label: "English (Australia)" },
  { variant: "en-ZA", label: "English (South Africa)" }
].map(({ variant, label }) => ({
  variant,
  label,
  imported: false,
  enabled: false,
  status: "not-imported",
  activeCommit: null,
  importedCommits: [],
  incompleteCommits: [],
  warning: null,
  error: null
}));

test("admin shell classes tab supports create, bulk-add, report, archive, and delete flows", async ({ page }) => {
  const state = {
    classes: [],
    members: new Map(),
    profiles: new Map(),
    profileCounter: 0,
    classCounter: 0,
    capturedDeletes: [],
    capturedBulk: []
  };

  function ensureProfile(name) {
    const existing = Array.from(state.profiles.values()).find(
      (profile) => profile.name.toLowerCase() === name.toLowerCase()
    );
    if (existing) return existing;
    state.profileCounter += 1;
    const profile = {
      id: `profile-${state.profileCounter}`,
      name
    };
    state.profiles.set(profile.id, profile);
    return profile;
  }

  function makeClass(name) {
    state.classCounter += 1;
    const id = `class-${state.classCounter.toString(16).padStart(12, "0")}`;
    const now = new Date().toISOString();
    const record = {
      id,
      name,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      memberProfileIds: []
    };
    state.classes.push(record);
    state.members.set(id, []);
    return record;
  }

  function listClassesPayload(includeArchived) {
    return {
      ok: true,
      classes: state.classes
        .filter((entry) => includeArchived || !entry.archivedAt)
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          archivedAt: entry.archivedAt,
          memberCount: state.members.get(entry.id)?.length ?? 0
        }))
    };
  }

  await page.route("**/api/admin/providers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, providers: PROVIDER_ROWS })
    });
  });
  await page.route("**/api/admin/jobs?limit=30", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        queue: { active: false, queued: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 },
        jobs: []
      })
    });
  });
  await page.route("**/api/admin/runtime-config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        effective: {
          definitions: { mode: "memory", cacheSize: 512, cacheTtlMs: 1800000, shardCacheSize: 6 },
          limits: {
            providerManualMaxFileBytes: 8388608,
            leaderboardMaxProfiles: 50,
            leaderboardMaxResultsPerProfile: 400
          },
          diagnostics: { perfLogging: false }
        },
        overrides: {},
        sources: {
          definitions: {
            mode: "default", cacheSize: "default", cacheTtlMs: "default", shardCacheSize: "default"
          },
          limits: {
            providerManualMaxFileBytes: "default",
            leaderboardMaxProfiles: "default",
            leaderboardMaxResultsPerProfile: "default"
          },
          diagnostics: { perfLogging: "default" }
        }
      })
    });
  });

  await page.route(/\/api\/admin\/classes(\?[^/]*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === "GET") {
      const includeArchived = url.searchParams.get("includeArchived") === "true";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(listClassesPayload(includeArchived))
      });
      return;
    }
    if (method === "POST") {
      const body = JSON.parse(route.request().postData() || "{}");
      const created = makeClass(body.name.trim());
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          class: {
            id: created.id,
            name: created.name,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
            archivedAt: created.archivedAt,
            memberCount: 0
          }
        })
      });
      return;
    }
    await route.continue();
  });

  await page.route(/\/api\/admin\/classes\/[^/]+$/, async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/").pop();
    const method = route.request().method();
    const target = state.classes.find((entry) => entry.id === id);
    if (!target) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Class not found." })
      });
      return;
    }
    if (method === "GET") {
      const memberIds = state.members.get(id) || [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          class: {
            ...target,
            memberCount: memberIds.length
          },
          members: memberIds.map((profileId) => ({
            profileId,
            name: state.profiles.get(profileId)?.name ?? null,
            missing: !state.profiles.has(profileId)
          }))
        })
      });
      return;
    }
    if (method === "PATCH") {
      const body = JSON.parse(route.request().postData() || "{}");
      if (typeof body.name === "string") {
        target.name = body.name.trim();
      }
      if (typeof body.archived === "boolean") {
        target.archivedAt = body.archived ? new Date().toISOString() : null;
      }
      target.updatedAt = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          class: {
            id: target.id,
            name: target.name,
            createdAt: target.createdAt,
            updatedAt: target.updatedAt,
            archivedAt: target.archivedAt,
            memberCount: state.members.get(id)?.length ?? 0
          }
        })
      });
      return;
    }
    if (method === "DELETE") {
      const body = JSON.parse(route.request().postData() || "{}");
      state.capturedDeletes.push({ id, body });
      const memberIds = state.members.get(id) || [];
      const removedProfileIds = body.deleteProfiles
        ? memberIds.filter((profileId) => {
          for (const otherId of state.classes.map((entry) => entry.id)) {
            if (otherId === id) continue;
            const otherTarget = state.classes.find((entry) => entry.id === otherId);
            if (otherTarget?.archivedAt) continue;
            if (state.members.get(otherId)?.includes(profileId)) return false;
          }
          return true;
        })
        : [];
      removedProfileIds.forEach((profileId) => state.profiles.delete(profileId));
      state.classes = state.classes.filter((entry) => entry.id !== id);
      state.members.delete(id);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          deletedClassId: id,
          deletedProfileIds: removedProfileIds
        })
      });
      return;
    }
    await route.continue();
  });

  await page.route(/\/api\/admin\/classes\/[^/]+\/members\/bulk$/, async (route) => {
    const url = new URL(route.request().url());
    const segments = url.pathname.split("/");
    const classId = segments[segments.length - 3];
    const body = JSON.parse(route.request().postData() || "{}");
    state.capturedBulk.push({ classId, body });
    const target = state.classes.find((entry) => entry.id === classId);
    if (!target) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Class not found." })
      });
      return;
    }
    let names = [];
    if (Array.isArray(body.names)) names = body.names;
    if (typeof body.csv === "string") {
      names = body.csv
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
    const memberIds = state.members.get(classId) || [];
    const added = [];
    const created = [];
    const reused = [];
    for (const name of names) {
      const existing = Array.from(state.profiles.values()).find(
        (profile) => profile.name.toLowerCase() === name.toLowerCase()
      );
      const profile = existing || ensureProfile(name);
      if (!existing) created.push(profile.id);
      else reused.push(profile.id);
      if (!memberIds.includes(profile.id)) {
        memberIds.push(profile.id);
        added.push(profile.id);
      }
    }
    state.members.set(classId, memberIds);
    target.updatedAt = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        addedToClass: added,
        createdProfileIds: created,
        reusedProfileIds: reused,
        classMemberCount: memberIds.length
      })
    });
  });

  await page.route(/\/api\/admin\/classes\/[^/]+\/report(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const segments = url.pathname.split("/");
    const classId = segments[segments.length - 2];
    const target = state.classes.find((entry) => entry.id === classId);
    if (!target) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Class not found." }) });
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const memberIds = state.members.get(classId) || [];
    const rows = memberIds.map((profileId) => {
      const profile = state.profiles.get(profileId);
      return {
        profileId,
        name: profile?.name ?? null,
        missing: !profile,
        wins: 0,
        playedCount: 0,
        winRate: 0,
        lastPlayedAt: null,
        days: [{ date: today, status: "not-started" }]
      };
    });
    const format = url.searchParams.get("format");
    if (format === "csv") {
      const header = "profile_id,profile_name,lang,date_status,date_attempts,wins,played,rate,last_played\r\n";
      const csvRows = rows.map((row) =>
        `${row.profileId},${row.name || ""},en,${row.days[0].status},,0,0,,\r\n`
      ).join("");
      await route.fulfill({
        status: 200,
        contentType: "text/csv; charset=utf-8",
        headers: { "Content-Disposition": `attachment; filename=class-${classId}-report.csv` },
        body: header + csvRows
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        class: { id: target.id, name: target.name },
        lang: url.searchParams.get("lang") || "en",
        from: today,
        to: today,
        dates: [today],
        rows
      })
    });
  });

  await page.addInitScript(() => {
    window.__promptResponses = ["Period 1 Math"];
    window.__confirmResponses = [false];
    window.prompt = () => window.__promptResponses.shift() ?? null;
    window.confirm = () => window.__confirmResponses.shift() ?? false;
  });

  await page.goto("/admin", { waitUntil: "commit" });
  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");
  await expect(page.locator("#shellPanel")).toBeVisible();

  await page.click("#admin-tab-classes");
  await expect(page.locator("#admin-panel-classes")).toBeVisible();

  // Create
  await page.fill("#classCreateName", "Period 1 Math");
  await page.click("#classCreateForm button[type=submit]");
  await expect(page.locator("#classesStatus")).toContainText("Created \"Period 1 Math\".");
  await expect(page.locator("#classesBody tr")).toHaveCount(1);

  // Open + bulk add
  await page.locator("#classesBody button[data-action='open-class']").click();
  await expect(page.locator("#classDetailPanel")).toBeVisible();
  await page.fill("#classBulkAddNames", "Alice\nBob\nCarol");
  await page.click("#classBulkAddForm button[type=submit]");
  await expect(page.locator("#classDetailStatus")).toContainText("Added 3 new members");

  // Report (JSON)
  await page.click("#classReportForm button[type=submit]");
  await expect(page.locator("#classReportStatus")).toContainText("Report ");
  await expect(page.locator("#classReportRendered table")).toBeVisible();

  // Archive
  await page.locator("#classesBody button[data-action='archive-class']").click();
  await expect(page.locator("#classesStatus")).toContainText("Class archived.");
  await expect(page.locator("#classesBody td").first()).toContainText("No active classes");

  // Show archived to bring it back into view, then delete with deleteProfiles=true (carve-out).
  await page.check("#classesIncludeArchived");
  await expect(page.locator("#classesBody tr")).toHaveCount(1);

  // Delete: confirm typed name + accept "delete profiles too" prompt.
  await page.evaluate(() => {
    window.__promptResponses = ["Period 1 Math"];
    window.__confirmResponses = [true];
  });
  await page.locator("#classesBody button[data-action='delete-class']").click();
  await expect(page.locator("#classesStatus")).toContainText("Deleted \"Period 1 Math\"");
  await expect(page.locator("#classesBody td").first()).toContainText("No classes yet");
  // The captured DELETE body should have asked for profile cleanup.
  expect(state.capturedDeletes[0].body).toEqual({ confirmed: true, deleteProfiles: true });
});

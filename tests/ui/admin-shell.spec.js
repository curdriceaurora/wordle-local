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

test("admin shell supports manual upload fallback import mode", async ({ page }) => {
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
    expect(payload.sourceType).toBe("manual-upload");
    expect(payload.manualFiles).toMatchObject({
      dicFileName: "offline-en_US.dic",
      affFileName: "offline-en_US.aff"
    });
    expect(typeof payload.manualFiles.dicBase64).toBe("string");
    expect(typeof payload.manualFiles.affBase64).toBe("string");
    const decodedDic = Buffer.from(payload.manualFiles.dicBase64, "base64").toString("utf8");
    const decodedAff = Buffer.from(payload.manualFiles.affBase64, "base64").toString("utf8");
    expect(decodedDic).toContain("DOG/S");
    expect(decodedAff).toContain("SET UTF-8");
    expect(payload.expectedChecksums.dic).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.expectedChecksums.aff).toMatch(/^[a-f0-9]{64}$/);

    state.imported = true;
    state.commit = "fedcba9876543210fedcba9876543210fedcba98";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        action: "imported",
        sourceType: "manual-upload",
        variant: "en-US",
        commit: state.commit,
        filterMode: payload.filterMode,
        counts: { filteredAnswers: 88 },
        providers: createProviderRows(state)
      })
    });
  });

  await page.goto("/admin", { waitUntil: "commit" });
  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");
  await expect(page.locator("#shellPanel")).toBeVisible();

  await page.click("#admin-tab-imports");
  await page.selectOption("#importSourceType", "manual-upload");
  await page.selectOption("#importVariant", "en-US");
  await page.setInputFiles("#importDicFile", {
    name: "offline-en_US.dic",
    mimeType: "text/plain",
    buffer: Buffer.from("2\nDOG/S\nCAT\n", "utf8")
  });
  await page.setInputFiles("#importAffFile", {
    name: "offline-en_US.aff",
    mimeType: "text/plain",
    buffer: Buffer.from("SET UTF-8\nSFX S Y 1\nSFX S 0 S .\n", "utf8")
  });
  await page.click("#importSubmitBtn");

  await expect(page.locator("#importStatus")).toContainText("Import complete");
  await expect(page.locator("#workspaceStatus")).toContainText("Provider import succeeded");
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

test("admin shell saves runtime overrides and renders source metadata", async ({ page }) => {
  const state = {
    imported: false,
    enabled: false,
    commit: ""
  };
  let runtimeConfig = {
    ok: true,
    effective: {
      definitions: {
        mode: "memory",
        cacheSize: 512,
        cacheTtlMs: 1800000,
        shardCacheSize: 6
      },
      limits: {
        providerManualMaxFileBytes: 8388608
      },
      diagnostics: {
        perfLogging: false
      }
    },
    overrides: {},
    sources: {
      definitions: {
        mode: "default",
        cacheSize: "default",
        cacheTtlMs: "default",
        shardCacheSize: "default"
      },
      limits: {
        providerManualMaxFileBytes: "default"
      },
      diagnostics: {
        perfLogging: "default"
      }
    }
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
  await page.route("**/api/admin/jobs?limit=30", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        queue: {
          active: false,
          queued: 0,
          running: 0,
          succeeded: 0,
          failed: 0,
          canceled: 0
        },
        jobs: []
      })
    });
  });
  await page.route("**/api/admin/runtime-config", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(runtimeConfig)
      });
      return;
    }

    const payload = JSON.parse(route.request().postData() || "{}");
    runtimeConfig = {
      ...runtimeConfig,
      overrides: payload.overrides,
      effective: {
        ...runtimeConfig.effective,
        definitions: payload.overrides.definitions,
        limits: payload.overrides.limits,
        diagnostics: payload.overrides.diagnostics
      },
      sources: {
        definitions: {
          mode: "override",
          cacheSize: "override",
          cacheTtlMs: "override",
          shardCacheSize: "override"
        },
        limits: {
          providerManualMaxFileBytes: "override"
        },
        diagnostics: {
          perfLogging: "override"
        }
      }
    };

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runtimeConfig)
    });
  });

  await page.goto("/admin", { waitUntil: "commit" });
  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");
  await expect(page.locator("#shellPanel")).toBeVisible();

  await page.click("#admin-tab-runtime");
  await page.selectOption("#runtimeDefinitionsMode", "lazy");
  await page.fill("#runtimeDefinitionCacheSize", "700");
  await page.fill("#runtimeDefinitionCacheTtlMs", "2400000");
  await page.fill("#runtimeDefinitionShardCacheSize", "9");
  await page.fill("#runtimeManualMaxBytes", "6291456");
  await page.check("#runtimePerfLogging");
  await page.click("#saveRuntimeBtn");

  await expect(page.locator("#runtimeStatus")).toContainText("saved");
  await expect(page.locator("#runtimeSourcesBody")).toContainText("definitions.mode");
  await expect(page.locator("#runtimeSourcesBody")).toContainText("override");
});

test("admin shell shows queued imports in import queue panel", async ({ page }) => {
  const state = {
    imported: false,
    enabled: false,
    commit: ""
  };
  let jobsCallCount = 0;

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
  await page.route("**/api/admin/runtime-config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        effective: {
          definitions: {
            mode: "memory",
            cacheSize: 512,
            cacheTtlMs: 1800000,
            shardCacheSize: 6
          },
          limits: {
            providerManualMaxFileBytes: 8388608
          },
          diagnostics: {
            perfLogging: false
          }
        },
        overrides: {},
        sources: {
          definitions: {
            mode: "default",
            cacheSize: "default",
            cacheTtlMs: "default",
            shardCacheSize: "default"
          },
          limits: {
            providerManualMaxFileBytes: "default"
          },
          diagnostics: {
            perfLogging: "default"
          }
        }
      })
    });
  });
  await page.route("**/api/admin/providers/import", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        action: "queued",
        job: {
          id: "job-1234567890ab",
          status: "queued",
          request: {
            variant: "en-US",
            sourceType: "remote-fetch",
            commit: "0123456789abcdef0123456789abcdef01234567"
          },
          updatedAt: "2026-02-23T12:00:00.000Z"
        },
        providers: createProviderRows(state),
        queue: {
          active: true,
          queued: 1,
          running: 0,
          succeeded: 0,
          failed: 0,
          canceled: 0
        }
      })
    });
  });
  await page.route("**/api/admin/jobs?limit=30", async (route) => {
    jobsCallCount += 1;
    const status = jobsCallCount > 1 ? "succeeded" : "queued";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        queue: {
          active: status === "queued",
          queued: status === "queued" ? 1 : 0,
          running: 0,
          succeeded: status === "succeeded" ? 1 : 0,
          failed: 0,
          canceled: 0
        },
        jobs: [
          {
            id: "job-1234567890ab",
            status,
            request: {
              variant: "en-US",
              sourceType: "remote-fetch",
              commit: "0123456789abcdef0123456789abcdef01234567"
            },
            updatedAt: "2026-02-23T12:00:00.000Z",
            artifacts: status === "succeeded"
              ? { commit: "0123456789abcdef0123456789abcdef01234567" }
              : null,
            error: null
          }
        ]
      })
    });
  });

  await page.goto("/admin", { waitUntil: "commit" });
  await page.fill("#adminKeyInput", "demo-key");
  await page.click("#unlockForm button[type=submit]");
  await page.click("#admin-tab-imports");

  await page.selectOption("#importVariant", "en-US");
  await page.fill("#importCommit", "0123456789abcdef0123456789abcdef01234567");
  await page.fill("#importChecksumDic", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  await page.fill("#importChecksumAff", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  await page.click("#importSubmitBtn");

  await expect(page.locator("#importStatus")).toContainText("queued");
  await expect(page.locator("#jobsBody")).toContainText("job-1234567890ab");

  await page.click("#refreshJobsBtn");
  await expect(page.locator("#jobsBody")).toContainText("succeeded");
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

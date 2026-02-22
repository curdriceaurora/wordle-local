const unlockPanelEl = document.getElementById("unlockPanel");
const shellPanelEl = document.getElementById("shellPanel");
const unlockFormEl = document.getElementById("unlockForm");
const adminKeyInputEl = document.getElementById("adminKeyInput");
const unlockStatusEl = document.getElementById("unlockStatus");
const workspaceStatusEl = document.getElementById("workspaceStatus");
const providersBodyEl = document.getElementById("providersBody");
const refreshProvidersBtnEl = document.getElementById("refreshProvidersBtn");
const lockSessionBtnEl = document.getElementById("lockSessionBtn");
const updatedEl = document.getElementById("adminUpdated");
const importFormEl = document.getElementById("importForm");
const importVariantEl = document.getElementById("importVariant");
const importCommitEl = document.getElementById("importCommit");
const importChecksumDicEl = document.getElementById("importChecksumDic");
const importChecksumAffEl = document.getElementById("importChecksumAff");
const importFilterModeEl = document.getElementById("importFilterMode");
const importSubmitBtnEl = document.getElementById("importSubmitBtn");
const importStatusEl = document.getElementById("importStatus");

const tabButtons = Array.from(document.querySelectorAll(".admin-tab"));
const tabPanels = Array.from(document.querySelectorAll(".admin-slot"));

const state = {
  adminKey: "",
  unlocked: false,
  loading: false,
  importing: false,
  providers: [],
  providerUpdates: Object.create(null),
  activeTab: "providers"
};

function setStatus(element, message, tone = "") {
  if (!element) return;
  element.textContent = message;
  element.classList.remove("admin-status-ok", "admin-status-off", "admin-status-missing");
  if (tone) {
    element.classList.add(tone);
  }
}

function setHidden(element, hidden) {
  if (!element) return;
  element.classList.toggle("hidden", hidden);
}

function applyProvidersPayload(payload) {
  state.providers = Array.isArray(payload?.providers) ? payload.providers : [];
  const visibleVariants = new Set(state.providers.map((provider) => String(provider.variant || "").trim()));
  Object.keys(state.providerUpdates).forEach((variant) => {
    if (!visibleVariants.has(variant)) {
      delete state.providerUpdates[variant];
    }
  });
}

function formatCommitShort(commit) {
  const value = String(commit || "").trim();
  if (!value) return "none";
  return value.slice(0, 10);
}

function summarizeProviderUpdateStatus(update) {
  if (!update || typeof update !== "object") {
    return "";
  }
  const status = String(update.status || "").trim();
  if (status === "up-to-date") {
    return `Upstream check: up-to-date (${formatCommitShort(update.currentCommit)}).`;
  }
  if (status === "update-available") {
    return `Upstream check: update available (${formatCommitShort(update.currentCommit)} -> ${formatCommitShort(update.latestCommit)}).`;
  }
  if (status === "unknown") {
    const latest = String(update.latestCommit || "").trim();
    if (latest) {
      return `Upstream check: latest available is ${formatCommitShort(latest)} (no installed commit selected).`;
    }
    return `Upstream check: ${String(update.message || "Unknown state.")}`;
  }
  return `Upstream check failed: ${String(update.message || "Try again later.")}`;
}

function toProviderUpdateInfo(payload) {
  return {
    status: String(payload?.status || "").trim(),
    currentCommit: payload?.currentCommit || null,
    latestCommit: payload?.latestCommit || null,
    message: String(payload?.message || "").trim(),
    checkedAt: payload?.checkedAt || null
  };
}

function renderTabs() {
  tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === state.activeTab;
    button.setAttribute("aria-selected", isActive ? "true" : "false");
    button.tabIndex = isActive ? 0 : -1;
  });

  tabPanels.forEach((panel) => {
    const isActive = panel.dataset.panel === state.activeTab;
    panel.hidden = !isActive;
    panel.classList.toggle("hidden", !isActive);
  });
}

function focusActiveTab() {
  const active = tabButtons.find((button) => button.dataset.tab === state.activeTab);
  if (active) {
    active.focus();
  }
}

function activateTab(nextTab, focus = false) {
  const tabId = String(nextTab || "").trim();
  if (!tabId) return;
  const exists = tabButtons.some((button) => button.dataset.tab === tabId);
  if (!exists) return;
  state.activeTab = tabId;
  renderTabs();
  if (focus) {
    focusActiveTab();
  }
}

function renderProviders() {
  providersBodyEl.innerHTML = "";
  if (!state.providers.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No provider variants are registered yet.";
    row.appendChild(cell);
    providersBodyEl.appendChild(row);
    return;
  }

  const fragment = document.createDocumentFragment();
  state.providers.forEach((provider) => {
    const row = document.createElement("tr");

    const variantCell = document.createElement("td");
    variantCell.textContent = provider.variant;
    row.appendChild(variantCell);

    const labelCell = document.createElement("td");
    labelCell.textContent = provider.label;
    row.appendChild(labelCell);

    const statusCell = document.createElement("td");
    statusCell.classList.add("admin-provider-status");
    const status = String(provider.status || "").trim()
      || (provider.enabled ? "enabled" : provider.imported ? "imported" : "not-imported");
    const statusText = status.replace(/-/g, " ");
    const statusLabel = document.createElement("span");
    statusLabel.textContent = statusText;
    statusCell.appendChild(statusLabel);
    if (status === "enabled" || status === "imported") {
      statusCell.className = "admin-status-ok";
    } else if (status === "error") {
      statusCell.className = "admin-status-missing";
    } else {
      statusCell.className = "admin-status-off";
    }
    statusCell.classList.add("admin-provider-status");

    const detailText = status === "error"
      ? String(provider.error || "").trim()
      : String(provider.warning || "").trim();
    if (detailText) {
      const details = document.createElement("small");
      details.className = "admin-provider-status-detail";
      details.textContent = detailText;
      statusCell.appendChild(details);
      statusCell.title = detailText;
    }

    const updateSummary = summarizeProviderUpdateStatus(state.providerUpdates[provider.variant]);
    if (updateSummary) {
      const updateDetails = document.createElement("small");
      updateDetails.className = "admin-provider-update-detail";
      updateDetails.textContent = updateSummary;
      statusCell.appendChild(updateDetails);
    }
    row.appendChild(statusCell);

    const commitCell = document.createElement("td");
    commitCell.textContent = provider.activeCommit || "-";
    row.appendChild(commitCell);

    const actionsCell = document.createElement("td");
    const actionsWrap = document.createElement("div");
    actionsWrap.className = "admin-action-stack";

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "ghost";
    toggleButton.dataset.variant = provider.variant;
    toggleButton.dataset.action = provider.enabled ? "disable" : "enable";
    toggleButton.textContent = provider.enabled ? "Disable" : "Enable";
    toggleButton.disabled = state.loading
      || state.importing
      || (!provider.enabled && !Array.isArray(provider.importedCommits))
      || (!provider.enabled && provider.importedCommits.length === 0);
    actionsWrap.appendChild(toggleButton);

    const importButton = document.createElement("button");
    importButton.type = "button";
    importButton.className = "ghost";
    importButton.dataset.variant = provider.variant;
    importButton.dataset.action = "prefill-import";
    importButton.textContent = provider.imported ? "Re-import" : "Import";
    importButton.disabled = state.loading || state.importing;
    actionsWrap.appendChild(importButton);

    const updateButton = document.createElement("button");
    updateButton.type = "button";
    updateButton.className = "ghost";
    updateButton.dataset.variant = provider.variant;
    updateButton.dataset.action = "check-update";
    updateButton.textContent = "Check update";
    updateButton.disabled = state.loading || state.importing;
    actionsWrap.appendChild(updateButton);

    actionsCell.appendChild(actionsWrap);
    row.appendChild(actionsCell);

    fragment.appendChild(row);
  });

  providersBodyEl.appendChild(fragment);
}

function renderWorkspace() {
  setHidden(unlockPanelEl, state.unlocked);
  setHidden(shellPanelEl, !state.unlocked);
  refreshProvidersBtnEl.disabled = !state.unlocked || state.loading || state.importing;
  lockSessionBtnEl.disabled = state.loading || state.importing;
  if (importSubmitBtnEl) {
    importSubmitBtnEl.disabled = !state.unlocked || state.loading || state.importing;
  }
  updatedEl.textContent = state.unlocked ? "Session unlocked" : "Session locked";
  renderTabs();
  renderProviders();
}

async function requestAdminJson(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.adminKey) {
    headers.set("x-admin-key", state.adminKey);
  }

  const response = await fetch(url, {
    ...options,
    headers
  });

  const payload = await response.json().catch(() => ({}));
  if (response.ok) {
    return payload;
  }

  const message =
    typeof payload.error === "string" && payload.error.trim()
      ? payload.error
      : `Request failed with status ${response.status}`;
  const error = new Error(message);
  error.status = response.status;
  throw error;
}

async function loadProviders() {
  state.loading = true;
  renderWorkspace();
  try {
    const payload = await requestAdminJson("/api/admin/providers");
    applyProvidersPayload(payload);
    state.unlocked = true;
    setStatus(workspaceStatusEl, "Provider status loaded.", "admin-status-ok");
    setStatus(unlockStatusEl, "");
  } catch (err) {
    const unauthorized = Number(err.status || 0) === 401;
    state.unlocked = false;
    state.providers = [];
    setStatus(
      unlockStatusEl,
      unauthorized ? "Admin key rejected. Check the key and try again." : `Could not unlock admin shell: ${err.message}`,
      "admin-status-missing"
    );
    setStatus(workspaceStatusEl, "");
    throw err;
  } finally {
    state.loading = false;
    renderWorkspace();
  }
}

function findProviderByVariant(variant) {
  const key = String(variant || "").trim().toLowerCase();
  return state.providers.find((provider) => String(provider.variant || "").toLowerCase() === key) || null;
}

async function checkProviderUpdateStatus(variant) {
  const provider = findProviderByVariant(variant);
  if (!provider) {
    throw new Error("Provider variant could not be found in current status list.");
  }

  const fallbackCommit = provider.activeCommit || provider.importedCommits?.[0] || "";
  state.loading = true;
  renderWorkspace();
  try {
    const response = await requestAdminJson(
      `/api/admin/providers/${encodeURIComponent(provider.variant)}/check-update`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: fallbackCommit ? JSON.stringify({ commit: fallbackCommit }) : JSON.stringify({})
      }
    );
    const updateInfo = toProviderUpdateInfo(response);
    state.providerUpdates[provider.variant] = updateInfo;
    applyProvidersPayload(response);
    const summary = summarizeProviderUpdateStatus(updateInfo);
    const tone = updateInfo.status === "error"
      ? "admin-status-missing"
      : updateInfo.status === "update-available"
        ? "admin-status-off"
        : "admin-status-ok";
    setStatus(workspaceStatusEl, summary || "Upstream update check complete.", tone);
  } finally {
    state.loading = false;
    renderWorkspace();
  }
}

function parseImportPayloadFromForm() {
  const variant = String(importVariantEl?.value || "").trim();
  const commit = String(importCommitEl?.value || "").trim();
  const checksumDic = String(importChecksumDicEl?.value || "").trim().toLowerCase();
  const checksumAff = String(importChecksumAffEl?.value || "").trim().toLowerCase();
  const filterMode = String(importFilterModeEl?.value || "denylist-only").trim();

  const commitPattern = /^[a-f0-9]{40}$/;
  const checksumPattern = /^[a-f0-9]{64}$/;
  if (!variant) {
    throw new Error("Select a variant before importing.");
  }
  if (!commitPattern.test(commit)) {
    throw new Error("Commit must be a 40-character lowercase hexadecimal SHA.");
  }
  if (!checksumPattern.test(checksumDic) || !checksumPattern.test(checksumAff)) {
    throw new Error("Checksums must be 64-character lowercase SHA-256 values.");
  }
  if (filterMode !== "denylist-only" && filterMode !== "allowlist-required") {
    throw new Error("Filter mode must be denylist-only or allowlist-required.");
  }

  return {
    variant,
    commit,
    filterMode,
    expectedChecksums: {
      dic: checksumDic,
      aff: checksumAff
    }
  };
}

async function importProvider() {
  const payload = parseImportPayloadFromForm();
  state.importing = true;
  renderWorkspace();
  setStatus(importStatusEl, "Import started. Building provider artifacts...", "admin-status-off");
  try {
    const response = await requestAdminJson("/api/admin/providers/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const activated = Number(response?.counts?.filteredAnswers || 0);
    setStatus(
      importStatusEl,
      `Import complete for ${payload.variant} @ ${payload.commit.slice(0, 10)}... (${activated} family-safe answers).`,
      "admin-status-ok"
    );
    await loadProviders();
    setStatus(workspaceStatusEl, `Provider import succeeded for ${payload.variant}.`, "admin-status-ok");
  } finally {
    state.importing = false;
    renderWorkspace();
  }
}

async function toggleProviderState(variant, action) {
  const provider = findProviderByVariant(variant);
  if (!provider) {
    throw new Error("Provider variant could not be found in current status list.");
  }

  const wantsEnable = action === "enable";
  const endpoint = wantsEnable
    ? `/api/admin/providers/${encodeURIComponent(provider.variant)}/enable`
    : `/api/admin/providers/${encodeURIComponent(provider.variant)}/disable`;
  const commit = provider.activeCommit || provider.importedCommits?.[0] || null;

  if (wantsEnable) {
    if (!commit) {
      throw new Error("No imported commit is available to enable.");
    }
    const shouldContinue = window.confirm(
      `Enable ${provider.variant} using commit ${commit}? This will expose the language in Create/Play.`
    );
    if (!shouldContinue) {
      return;
    }
  }

  state.loading = true;
  renderWorkspace();
  try {
    const payload = wantsEnable ? { commit } : {};
    await requestAdminJson(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    setStatus(
      workspaceStatusEl,
      wantsEnable
        ? `${provider.variant} enabled.`
        : `${provider.variant} disabled.`,
      "admin-status-ok"
    );
    await loadProviders();
  } finally {
    state.loading = false;
    renderWorkspace();
  }
}

unlockFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.adminKey = String(adminKeyInputEl.value || "").trim();
  await loadProviders().catch(() => {});
  adminKeyInputEl.value = "";
});

refreshProvidersBtnEl.addEventListener("click", async () => {
  if (!state.unlocked) return;
  await loadProviders().catch(() => {});
});

lockSessionBtnEl.addEventListener("click", () => {
  state.adminKey = "";
  state.unlocked = false;
  state.providers = [];
  state.providerUpdates = Object.create(null);
  setStatus(workspaceStatusEl, "Session locked. Re-enter admin key to continue.", "admin-status-off");
  setStatus(unlockStatusEl, "");
  renderWorkspace();
  adminKeyInputEl.focus();
});

if (importFormEl) {
  importFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await importProvider();
    } catch (err) {
      setStatus(importStatusEl, `Import failed: ${err.message}`, "admin-status-missing");
    }
  });
}

providersBodyEl.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
  if (!target) {
    return;
  }
  const action = String(target.dataset.action || "").trim();
  const variant = String(target.dataset.variant || "").trim();
  if (!action || !variant) {
    return;
  }

  if (action === "prefill-import") {
    const provider = findProviderByVariant(variant);
    if (!provider) return;
    if (importVariantEl) importVariantEl.value = provider.variant;
    if (importCommitEl) {
      importCommitEl.value = provider.activeCommit || provider.importedCommits?.[0] || "";
      importCommitEl.focus();
    }
    setStatus(
      importStatusEl,
      `Import form prefilled for ${provider.variant}. Enter checksums and submit.`,
      "admin-status-off"
    );
    activateTab("imports", true);
    return;
  }

  if (action === "check-update") {
    try {
      await checkProviderUpdateStatus(variant);
    } catch (err) {
      setStatus(workspaceStatusEl, `Update check failed: ${err.message}`, "admin-status-missing");
    }
    return;
  }

  try {
    await toggleProviderState(variant, action);
  } catch (err) {
    setStatus(workspaceStatusEl, `Provider update failed: ${err.message}`, "admin-status-missing");
  }
});

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activateTab(button.dataset.tab || "providers");
  });

  button.addEventListener("keydown", (event) => {
    if (!tabButtons.length) return;
    const currentIndex = tabButtons.findIndex((entry) => entry === button);
    if (currentIndex < 0) return;

    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % tabButtons.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabButtons.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextTab = tabButtons[nextIndex].dataset.tab || "providers";
    activateTab(nextTab, true);
  });
});

renderWorkspace();

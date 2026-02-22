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

const tabButtons = Array.from(document.querySelectorAll(".admin-tab"));
const tabPanels = Array.from(document.querySelectorAll(".admin-slot"));

const state = {
  adminKey: "",
  unlocked: false,
  loading: false,
  providers: [],
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

    const importedCell = document.createElement("td");
    importedCell.textContent = provider.imported ? "Yes" : "No";
    importedCell.className = provider.imported ? "admin-status-ok" : "admin-status-missing";
    row.appendChild(importedCell);

    const enabledCell = document.createElement("td");
    enabledCell.textContent = provider.enabled ? "Yes" : "No";
    enabledCell.className = provider.enabled ? "admin-status-ok" : "admin-status-off";
    row.appendChild(enabledCell);

    const commitCell = document.createElement("td");
    commitCell.textContent = provider.activeCommit || "-";
    row.appendChild(commitCell);

    fragment.appendChild(row);
  });

  providersBodyEl.appendChild(fragment);
}

function renderWorkspace() {
  setHidden(unlockPanelEl, state.unlocked);
  setHidden(shellPanelEl, !state.unlocked);
  refreshProvidersBtnEl.disabled = !state.unlocked || state.loading;
  lockSessionBtnEl.disabled = state.loading;
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
    state.providers = Array.isArray(payload.providers) ? payload.providers : [];
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
  setStatus(workspaceStatusEl, "Session locked. Re-enter admin key to continue.", "admin-status-off");
  setStatus(unlockStatusEl, "");
  renderWorkspace();
  adminKeyInputEl.focus();
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

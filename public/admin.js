const form = document.getElementById("adminForm");
const statusEl = document.getElementById("adminStatus");
const currentWordEl = document.getElementById("currentWord");
const wordInput = document.getElementById("wordInput");
const dateInput = document.getElementById("dateInput");
const keyInput = document.getElementById("keyInput");
const langInput = document.getElementById("langInput");

function setStatus(text) {
  statusEl.textContent = text;
}

function sanitizeWord(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z]/g, "");
}

function buildHeaders(key) {
  return {
    "Content-Type": "application/json",
    ...(key ? { "x-admin-key": key } : {})
  };
}

async function loadLanguages() {
  const response = await fetch("/api/meta");
  if (!response.ok) return;
  const data = await response.json();
  langInput.innerHTML = "";
  data.languages.forEach((lang) => {
    const option = document.createElement("option");
    option.value = lang.id;
    option.textContent = lang.label;
    langInput.appendChild(option);
  });
}

async function loadCurrent() {
  const key = keyInput.value.trim();
  const response = await fetch("/api/word", {
    headers: key ? { "x-admin-key": key } : {}
  });
  if (!response.ok) {
    currentWordEl.textContent = "Failed to load.";
    return;
  }
  const data = await response.json();
  currentWordEl.textContent = `${data.word || "—"}${data.date ? ` · ${data.date}` : ""}${data.lang ? ` · ${data.lang.toUpperCase()}` : ""}`;
  if (data.lang) {
    langInput.value = data.lang;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const word = sanitizeWord(wordInput.value.trim());
  const date = dateInput.value || null;
  const key = keyInput.value.trim();
  const lang = langInput.value || "en";

  if (word.length < 3 || word.length > 12) {
    setStatus("Word must be 3-12 letters.");
    return;
  }

  if (key) {
    localStorage.setItem("adminKey", key);
  }

  const response = await fetch("/api/word", {
    method: "POST",
    headers: buildHeaders(key),
    body: JSON.stringify({ word, date, lang })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Request failed." }));
    setStatus(error.error || "Request failed.");
    return;
  }

  setStatus("Saved.");
  wordInput.value = "";
  await loadCurrent();
});

const savedKey = localStorage.getItem("adminKey");
if (savedKey) {
  keyInput.value = savedKey;
}

(async () => {
  await loadLanguages();
  await loadCurrent();
})();

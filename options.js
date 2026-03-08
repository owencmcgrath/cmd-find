/* options.js — cmd-find settings page */

// Show the correct shortcut for the user's OS
const isMac =
  navigator.platform.startsWith("Mac") ||
  navigator.userAgentData?.platform === "macOS";
document.getElementById("shortcut-hint").textContent = isMac
  ? "cmd + shift + f"
  : "ctrl + shift + f";

const DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  google: "gemini-2.5-flash",
};

const providerEl   = document.getElementById("provider");
const apiKeyEl     = document.getElementById("api-key");
const modelEl      = document.getElementById("model");
const saveBtn      = document.getElementById("save-btn");
const saveFeedback = document.getElementById("save-feedback");
const themeToggle  = document.getElementById("theme-toggle");
const iconAuto     = document.getElementById("icon-auto");
const iconMoon     = document.getElementById("icon-moon");
const iconSun      = document.getElementById("icon-sun");

// Arrow SVG for the select dropdown, color-swapped per theme
const ARROW_DARK  = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%238e8e93' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";
const ARROW_LIGHT = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23636366' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";

// Cycle: system → light → dark → system
const NEXT_THEME = { system: "light", light: "dark", dark: "system" };

let currentThemeState = "system"; // tracks the stored state, not just light/dark
let feedbackTimeout = null;

function applyTheme(state) {
  currentThemeState = state;

  const isLight =
    state === "light" ||
    (state === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);

  document.documentElement.classList.toggle("cmdf-light", isLight);
  providerEl.style.backgroundImage = isLight ? ARROW_LIGHT : ARROW_DARK;

  iconAuto.style.display = state === "system" ? "inline" : "none";
  iconMoon.style.display = state === "dark"   ? "block"  : "none";
  iconSun.style.display  = state === "light"  ? "block"  : "none";
}

themeToggle.addEventListener("click", async () => {
  const next = NEXT_THEME[currentThemeState] ?? "system";
  applyTheme(next);
  await chrome.storage.local.set({ theme: next });
});

function updateModelPlaceholder() {
  modelEl.placeholder = DEFAULT_MODELS[providerEl.value] ?? "";
}

providerEl.addEventListener("change", updateModelPlaceholder);

// Migrate any existing data from sync to local (one-time)
async function migrateSyncToLocal() {
  const synced = await chrome.storage.sync.get(["provider", "apiKey", "model"]);
  if (synced.provider || synced.apiKey || synced.model) {
    const local = await chrome.storage.local.get(["provider", "apiKey", "model"]);
    if (!local.provider && !local.apiKey && !local.model) {
      await chrome.storage.local.set(synced);
    }
    await chrome.storage.sync.remove(["provider", "apiKey", "model"]);
  }
}

async function loadSettings() {
  await migrateSyncToLocal();
  const stored = await chrome.storage.local.get(["provider", "apiKey", "model", "theme"]);
  if (stored.provider && providerEl.querySelector(`option[value="${stored.provider}"]`)) {
    providerEl.value = stored.provider;
  }
  apiKeyEl.value = stored.apiKey ?? "";
  modelEl.value  = stored.model  ?? "";
  updateModelPlaceholder();

  // Default to "system" if no theme has been explicitly saved
  applyTheme(stored.theme ?? "system");
}

saveBtn.addEventListener("click", async () => {
  const provider = providerEl.value;
  const apiKey   = apiKeyEl.value.trim();
  const model    = modelEl.value.trim();

  await chrome.storage.local.set({ provider, apiKey, model });

  clearTimeout(feedbackTimeout);
  saveFeedback.classList.add("visible");
  feedbackTimeout = setTimeout(() => saveFeedback.classList.remove("visible"), 2000);
});

loadSettings();

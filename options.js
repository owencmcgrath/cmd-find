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

const providerEl = document.getElementById("provider");
const apiKeyEl = document.getElementById("api-key");
const modelEl = document.getElementById("model");
const saveBtn = document.getElementById("save-btn");
const saveFeedback = document.getElementById("save-feedback");

let feedbackTimeout = null;

function updateModelPlaceholder() {
  const provider = providerEl.value;
  modelEl.placeholder = DEFAULT_MODELS[provider] ?? "";
}

providerEl.addEventListener("change", updateModelPlaceholder);

// Migrate any existing data from sync to local (one-time)
async function migrateSyncToLocal() {
  const synced = await chrome.storage.sync.get(["provider", "apiKey", "model"]);
  if (synced.provider || synced.apiKey || synced.model) {
    const local = await chrome.storage.local.get(["provider", "apiKey", "model"]);
    // Only migrate if local has no data yet
    if (!local.provider && !local.apiKey && !local.model) {
      await chrome.storage.local.set(synced);
    }
    await chrome.storage.sync.remove(["provider", "apiKey", "model"]);
  }
}

// Load saved settings on open
async function loadSettings() {
  await migrateSyncToLocal();
  const stored = await chrome.storage.local.get(["provider", "apiKey", "model"]);
  if (
    stored.provider &&
    providerEl.querySelector(`option[value="${stored.provider}"]`)
  ) {
    providerEl.value = stored.provider;
  }
  apiKeyEl.value = stored.apiKey ?? "";
  modelEl.value = stored.model ?? "";
  updateModelPlaceholder();
}

saveBtn.addEventListener("click", async () => {
  const provider = providerEl.value;
  const apiKey = apiKeyEl.value.trim();
  const model = modelEl.value.trim();

  await chrome.storage.local.set({ provider, apiKey, model });

  // Brief "Saved" confirmation
  clearTimeout(feedbackTimeout);
  saveFeedback.classList.add("visible");
  feedbackTimeout = setTimeout(
    () => saveFeedback.classList.remove("visible"),
    2000,
  );
});

loadSettings();

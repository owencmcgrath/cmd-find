/* content.js — cmd-find: AI-powered semantic search overlay */

const PROVIDERS = {
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-4o-mini",
    endpoint: "https://api.openai.com/v1/chat/completions",
  },
  anthropic: {
    label: "Anthropic",
    defaultModel: "claude-haiku-4-5-20251001",
    endpoint: "https://api.anthropic.com/v1/messages",
  },
  google: {
    label: "Google",
    defaultModel: "gemini-2.5-flash",
    // endpoint built dynamically — model and key go in the URL
    endpointBase: "https://generativelanguage.googleapis.com/v1beta/models",
  },
};

const SYSTEM_PROMPT =
  "You are a helpful assistant. The user is searching within a web page. Answer their queries using only the provided page content. Be concise and direct. When listing items, always use markdown bullet points (- item). NEVER, EVER use horizontal rules (<hr>) or dividers in your response.";

// ─── Page text extraction ─────────────────────────────────────────────────────

function getPageText() {
  const raw = document.body?.innerText ?? "";
  const cleaned = raw
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  const words = cleaned.split(/\s+/);
  return words.slice(0, 12000).join(" ");
}

// ─── Overlay DOM ──────────────────────────────────────────────────────────────

// Fetch CSS eagerly; fall back to lazy load in createOverlay if runtime is unavailable
let overlayCSSText = "";
let cssFetchPromise = null;

function fetchCSS() {
  if (cssFetchPromise) return cssFetchPromise;
  try {
    cssFetchPromise = fetch(chrome.runtime.getURL("overlay.css"))
      .then((r) => r.text())
      .then((css) => { overlayCSSText = css; return css; })
      .catch(() => "");
  } catch (_) {
    cssFetchPromise = Promise.resolve("");
  }
  return cssFetchPromise;
}

fetchCSS();

let host = null;
let overlay = null;
let inputEl = null;
let resultsEl = null;
let spinnerEl = null;
let currentAbortController = null;

// Conversation state — reset each time the overlay opens
let conversationTurns = []; // { query: string, response: string }[]
let currentQuery = "";
let streamBuffer = "";

// Query history — persists across overlay open/close, max 10 entries
let queryHistory = [];
let historyIndex = -1;  // -1 = not browsing; 0 = most recent entry
let historyDraft = "";  // saves in-progress input when user starts navigating

async function createOverlay() {
  if (overlay) return;

  // Ensure CSS is loaded (no-op if already fetched)
  await fetchCSS();

  // Shadow host — an unstyled element in the page DOM that isolates our CSS
  host = document.createElement("div");
  host.id = "cmdf-host";
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });

  // Inject cached CSS into shadow root so page styles can't bleed in
  const style = document.createElement("style");
  style.textContent = overlayCSSText;
  shadow.appendChild(style);

  overlay = document.createElement("div");
  overlay.id = "cmdf-overlay";
  overlay.className = "cmdf-hidden";
  overlay.innerHTML = `
    <div id="cmdf-input-row">
      <span id="cmdf-icon">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="6.5" cy="6.5" r="4.5" stroke="#8e8e93" stroke-width="1.5"/>
          <line x1="10" y1="10" x2="14" y2="14" stroke="#8e8e93" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </span>
      <input id="cmdf-input" type="text" placeholder="ask anything about this page" autocomplete="off" spellcheck="false" />
      <div id="cmdf-spinner"></div>
    </div>
    <div id="cmdf-results"></div>
    <div id="cmdf-footer">
      <button id="cmdf-settings-btn" title="Settings" aria-label="Open settings">
        <svg width="14" height="14" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M7.5 9.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" stroke="currentColor" stroke-width="1.3"/>
          <path d="M6.06 1.5h2.88l.44 1.48a5 5 0 0 1 1.04.6l1.5-.48 1.44 2.5-1.1 1.05a5 5 0 0 1 0 1.7l1.1 1.05-1.44 2.5-1.5-.48a5 5 0 0 1-1.04.6L8.94 13.5H6.06l-.44-1.48a5 5 0 0 1-1.04-.6l-1.5.48-1.44-2.5 1.1-1.05a5 5 0 0 1 0-1.7L1.64 5.6l1.44-2.5 1.5.48a5 5 0 0 1 1.04-.6L6.06 1.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
        </svg>
      </button>
      <div id="cmdf-footer-hints">
        <button id="cmdf-new-btn" title="New thread" aria-label="New thread"><kbd>+</kbd> new</button>
        <span><kbd class="cmdf-kbd-enter">↵</kbd> search</span>
      </div>
    </div>
  `;
  shadow.appendChild(overlay);

  inputEl = overlay.querySelector("#cmdf-input");
  resultsEl = overlay.querySelector("#cmdf-results");
  spinnerEl = overlay.querySelector("#cmdf-spinner");

  overlay.querySelector("#cmdf-settings-btn").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "openOptions" });
  });

  overlay.querySelector("#cmdf-new-btn").addEventListener("click", () => {
    clearSession();
    inputEl.focus();
  });

  // Block all keyboard events from reaching the page while the overlay is active
  ["keydown", "keyup", "keypress"].forEach((type) => {
    inputEl.addEventListener(type, (e) => e.stopPropagation());
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && inputEl.value.trim()) {
      e.preventDefault();
      handleSearch(inputEl.value.trim());
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideOverlay();
    }
    if (e.key === "ArrowUp" && queryHistory.length > 0) {
      e.preventDefault();
      if (historyIndex === -1) {
        historyDraft = inputEl.value;
        historyIndex = queryHistory.length - 1;
      } else if (historyIndex > 0) {
        historyIndex--;
      }
      inputEl.value = queryHistory[historyIndex];
    }
    if (e.key === "ArrowDown" && historyIndex !== -1) {
      e.preventDefault();
      if (historyIndex < queryHistory.length - 1) {
        historyIndex++;
        inputEl.value = queryHistory[historyIndex];
      } else {
        historyIndex = -1;
        inputEl.value = historyDraft;
      }
    }
  });

  document.addEventListener("mousedown", onOutsideClick);
}

function onOutsideClick(e) {
  if (
    host &&
    !host.contains(e.target) &&
    !overlay.classList.contains("cmdf-hidden")
  ) {
    hideOverlay();
  }
}

async function showOverlay() {
  if (!overlay) await createOverlay();
  overlay.classList.remove("cmdf-hidden");
  clearSession();
  inputEl.focus();
}

function hideOverlay() {
  if (!overlay) return;
  overlay.classList.add("cmdf-hidden");
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
}

// Reset the full conversation — called when the overlay opens fresh
function clearSession() {
  if (!resultsEl) return;
  conversationTurns = [];
  currentQuery = "";
  streamBuffer = "";
  resultsEl.innerHTML = "";
  resultsEl.classList.remove("cmdf-visible", "cmdf-error");
  spinnerEl.classList.remove("cmdf-visible");
  inputEl.value = "";
}

function showSpinner() {
  spinnerEl.classList.add("cmdf-visible");
}

function hideSpinner() {
  spinnerEl.classList.remove("cmdf-visible");
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(raw) {
  // Split on fenced code blocks first so their contents are never processed
  const parts = raw.split(/(```[\s\S]*?```)/g);

  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        const inner = part.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
        return `<pre><code>${escapeHtml(inner)}</code></pre>`;
      }

      let s = escapeHtml(part);

      // Setext-style headings (Title\n=== or Title\n---) — must come before HR stripper
      // so the underline isn't mistaken for a horizontal rule
      s = s.replace(/^(.+)\n={3,}$/gm, "<h1>$1</h1>");
      s = s.replace(/^(.+)\n-{3,}$/gm, "<h2>$1</h2>");

      // Strip horizontal rules (---, ***, ___, and spaced variants like - - -)
      s = s.replace(/^(\s*[-*_]\s*){3,}$/gm, "");

      // Inline code
      s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");

      // Headers
      s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>");
      s = s.replace(/^## (.+)$/gm, "<h2>$1</h2>");
      s = s.replace(/^# (.+)$/gm, "<h1>$1</h1>");

      // Bold + italic, bold, italic (order matters)
      s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>");
      s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");

      // Unordered list items, then wrap runs in <ul>
      s = s.replace(/^[*-] (.+)$/gm, "<li>$1</li>");
      s = s.replace(/((?:<li>[^\n]*<\/li>\n?)+)/g, "<ul>$1</ul>");

      const blocks = s
        .split(/\n{2,}/)
        .map((block) => {
          block = block.trim();
          if (!block) return "";
          if (/^<(h[1-6]|ul|ol|pre|blockquote)/.test(block)) return block;
          // A lone <li> from a blank-line-separated list — wrap it
          if (block.startsWith("<li>")) return `<ul>${block}</ul>`;
          return `<p>${block.replace(/\n/g, "<br>")}</p>`;
        })
        .join("");
      // Merge adjacent <ul> tags that were split by blank lines
      return blocks.replace(/<\/ul>\s*<ul>/g, "");
    })
    .join("");
}

// ─── Conversation rendering ───────────────────────────────────────────────────

function buildTurnHtml(query, responseHtml, extraClass = "") {
  return `<div class="cmdf-turn${extraClass ? " " + extraClass : ""}">
    <p class="cmdf-query-label">${escapeHtml(query)}</p>
    <div class="cmdf-response">${responseHtml}</div>
  </div>`;
}

function renderConversation() {
  if (!resultsEl || !currentQuery) return;

  let html = conversationTurns
    .map((t) => buildTurnHtml(t.query, renderMarkdown(t.response)))
    .join("");

  // Current in-progress turn
  html += buildTurnHtml(
    currentQuery,
    streamBuffer ? renderMarkdown(streamBuffer) : "",
    "cmdf-turn-active",
  );

  resultsEl.classList.add("cmdf-visible");
  resultsEl.classList.remove("cmdf-error");
  resultsEl.innerHTML = html;
  resultsEl.scrollTop = resultsEl.scrollHeight;
}

function appendChunk(text) {
  hideSpinner(); // idempotent — safe to call on every chunk
  resultsEl.classList.remove("cmdf-error");
  streamBuffer += text;
  renderConversation();
}

function showError(msg) {
  hideSpinner();
  let html = conversationTurns
    .map((t) => buildTurnHtml(t.query, renderMarkdown(t.response)))
    .join("");
  if (currentQuery) {
    html += buildTurnHtml(
      currentQuery,
      `<p class="cmdf-error-text">${escapeHtml(msg)}</p>`,
    );
  } else {
    html += `<p class="cmdf-error-text">${escapeHtml(msg)}</p>`;
  }
  resultsEl.classList.add("cmdf-visible");
  resultsEl.classList.remove("cmdf-error");
  resultsEl.innerHTML = html;
}

function showNoKeyMessage() {
  hideSpinner();
  let html = conversationTurns
    .map((t) => buildTurnHtml(t.query, renderMarkdown(t.response)))
    .join("");
  if (currentQuery) {
    html += buildTurnHtml(
      currentQuery,
      `<p>No API key set. <a id="cmdf-open-settings" href="#">Open settings →</a></p>`,
    );
  } else {
    html += `<p>No API key set. <a id="cmdf-open-settings" href="#">Open settings →</a></p>`;
  }
  resultsEl.classList.add("cmdf-visible");
  resultsEl.classList.remove("cmdf-error");
  resultsEl.innerHTML = html;
  resultsEl
    .querySelector("#cmdf-open-settings")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: "openOptions" });
    });
}

// ─── Search orchestration ─────────────────────────────────────────────────────

async function handleSearch(query) {
  // Commit the previous turn before starting a new one
  if (currentQuery && streamBuffer) {
    conversationTurns.push({ query: currentQuery, response: streamBuffer });
    streamBuffer = "";
  }

  currentQuery = query;
  inputEl.value = ""; // Clear input so user can type a follow-up

  // Record in history (dedupe consecutive identical queries, cap at 10)
  if (queryHistory[queryHistory.length - 1] !== query) {
    queryHistory.push(query);
    if (queryHistory.length > 10) queryHistory.shift();
  }
  historyIndex = -1;
  historyDraft = "";

  if (currentAbortController) {
    currentAbortController.abort();
  }
  currentAbortController = new AbortController();

  showSpinner();
  renderConversation(); // Show query label while loading

  let settings;
  try {
    settings = await chrome.storage.local.get(["provider", "apiKey", "model"]);
  } catch (err) {
    showError("Could not read settings. Try reloading the extension.");
    return;
  }

  const provider = settings.provider || "openai";
  const apiKey = settings.apiKey || "";
  const model = settings.model || PROVIDERS[provider]?.defaultModel || "";

  if (!apiKey) {
    showNoKeyMessage();
    return;
  }

  const pageText = getPageText();
  const signal = currentAbortController.signal;

  // Build history for multi-turn context
  const history = conversationTurns.map((t) => ({
    query: t.query,
    response: t.response,
  }));

  try {
    if (provider === "openai") {
      await streamOpenAI(query, pageText, history, apiKey, model, signal);
    } else if (provider === "anthropic") {
      await streamAnthropic(query, pageText, history, apiKey, model, signal);
    } else if (provider === "google") {
      await streamGoogle(query, pageText, history, apiKey, model, signal);
    } else {
      showError("Unknown provider. Please check your settings.");
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    showError("Something went wrong. Please check your API key and try again.");
  }
}

// ─── SSE line parser helper ───────────────────────────────────────────────────

async function* readSSELines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      yield line;
    }
  }
  if (buffer) yield buffer;
}

// ─── OpenAI streaming ─────────────────────────────────────────────────────────

async function streamOpenAI(query, pageText, history, apiKey, model, signal) {
  const messages = [
    {
      role: "system",
      content: `${SYSTEM_PROMPT}\n\nPage content:\n${pageText}`,
    },
    // Interleave prior turns
    ...history.flatMap((t) => [
      { role: "user", content: t.query },
      { role: "assistant", content: t.response },
    ]),
    { role: "user", content: query },
  ];

  const res = await fetch(PROVIDERS.openai.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, stream: true, messages }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${errText}`);
  }

  for await (const line of readSSELines(res.body)) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") break;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    const text = parsed?.choices?.[0]?.delta?.content;
    if (text) appendChunk(text);
  }
}

// ─── Anthropic streaming ──────────────────────────────────────────────────────

async function streamAnthropic(
  query,
  pageText,
  history,
  apiKey,
  model,
  signal,
) {
  const messages = [
    ...history.flatMap((t) => [
      { role: "user", content: t.query },
      { role: "assistant", content: t.response },
    ]),
    { role: "user", content: query },
  ];

  const res = await fetch(PROVIDERS.anthropic.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      stream: true,
      system: `${SYSTEM_PROMPT}\n\nPage content:\n${pageText}`,
      messages,
    }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic error ${res.status}: ${errText}`);
  }

  for await (const line of readSSELines(res.body)) {
    if (!line.startsWith("data: ")) continue;
    let parsed;
    try {
      parsed = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    if (
      parsed?.type === "content_block_delta" &&
      parsed?.delta?.type === "text_delta"
    ) {
      appendChunk(parsed.delta.text);
    }
  }
}

// ─── Google streaming ─────────────────────────────────────────────────────────

async function streamGoogle(query, pageText, history, apiKey, model, signal) {
  const url = `${PROVIDERS.google.endpointBase}/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;

  // Google uses role "model" instead of "assistant"
  const contents = [
    ...history.flatMap((t) => [
      { role: "user", parts: [{ text: t.query }] },
      { role: "model", parts: [{ text: t.response }] },
    ]),
    { role: "user", parts: [{ text: query }] },
  ];

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: `${SYSTEM_PROMPT}\n\nPage content:\n${pageText}` }],
      },
      contents,
    }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Google error ${res.status}: ${errText}`);
  }

  for await (const line of readSSELines(res.body)) {
    if (!line.startsWith("data: ")) continue;
    let parsed;
    try {
      parsed = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) appendChunk(text);
  }
}

// ─── Keydown intercept ────────────────────────────────────────────────────────

document.addEventListener(
  "keydown",
  (e) => {
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const triggerKey = isMac ? e.metaKey : e.ctrlKey;

    if (triggerKey && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      if (overlay && !overlay.classList.contains("cmdf-hidden")) {
        inputEl.focus();
      } else {
        showOverlay();
      }
    }
  },
  true,
);

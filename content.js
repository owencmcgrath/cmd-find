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
  "You are a helpful assistant. The user is searching within a web page. Answer their queries using only the provided page content. Be concise and direct, answering correctly, but with as few sentences as possible. When listing items, always use markdown bullet points (- item). Never use horizontal rules (<hr>) or dividers in your response. Also, never use code blocks, instead choosing to use inline code formatting.";

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
      .then((css) => {
        overlayCSSText = css;
        return css;
      })
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

// Query history — persists across overlay open/close, max 25 entries
let queryHistory = [];
let historyIndex = -1; // -1 = not browsing; 0 = most recent entry
let historyDraft = ""; // saves in-progress input when user starts navigating

// Load saved query history for the current hostname from persistent storage
async function loadQueryHistory() {
  const key = `queries_${window.location.hostname}`;
  const result = await chrome.storage.local.get(key);
  return result[key] || [];
}

// Persist query history for the current hostname
async function saveQueryHistory(queries) {
  const key = `queries_${window.location.hostname}`;
  await chrome.storage.local.set({ [key]: queries });
}

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
        <button id="cmdf-new-btn" class="cmdf-hint" title="New thread" aria-label="New thread"><kbd>+</kbd> new</button>
        <span class="cmdf-hint"><kbd class="cmdf-kbd-enter">↵</kbd> search</span>
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

  // Apply the user's theme preference
  const { theme } = await chrome.storage.local.get("theme");
  const preferLight =
    theme === "light" ||
    ((!theme || theme === "system") &&
      window.matchMedia("(prefers-color-scheme: light)").matches);
  overlay.classList.toggle("cmdf-light", preferLight);

  // Load persisted query history for this hostname
  queryHistory = await loadQueryHistory();

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
  activeTurnEl = null;
  activeResponseEl = null;
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

// Appends inline markdown (bold, italic, inline code) as DOM nodes to `parent`.
// Uses textContent so no HTML escaping is needed.
function appendInline(parent, text) {
  // Split on inline code spans first so their contents are never processed
  const parts = text.split(/(`[^`\n]+`)/g);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const code = document.createElement("code");
      code.textContent = part.slice(1, -1);
      parent.appendChild(code);
      return;
    }
    // Process ***bold+italic***, **bold**, *italic* in order
    const re = /(\*\*\*([^*\n]+)\*\*\*|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*)/g;
    let last = 0;
    let m;
    while ((m = re.exec(part)) !== null) {
      if (m.index > last) {
        parent.appendChild(document.createTextNode(part.slice(last, m.index)));
      }
      if (m[2] !== undefined) {
        const strong = document.createElement("strong");
        const em = document.createElement("em");
        em.textContent = m[2];
        strong.appendChild(em);
        parent.appendChild(strong);
      } else if (m[3] !== undefined) {
        const strong = document.createElement("strong");
        strong.textContent = m[3];
        parent.appendChild(strong);
      } else {
        const em = document.createElement("em");
        em.textContent = m[4];
        parent.appendChild(em);
      }
      last = re.lastIndex;
    }
    if (last < part.length) {
      parent.appendChild(document.createTextNode(part.slice(last)));
    }
  });
}

// Returns a DocumentFragment with the markdown rendered as real DOM nodes.
function renderMarkdownToDOM(raw) {
  const frag = document.createDocumentFragment();

  // Split on fenced code blocks so their contents are never processed
  const parts = raw.split(/(```[\s\S]*?```)/g);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const wrapper = document.createElement("div");
      wrapper.className = "cmdf-code-wrapper";

      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = part
        .replace(/^```[^\n]*\n?/, "")
        .replace(/\n?```$/, "")
        .replace(/\n+$/, "");
      pre.appendChild(code);

      const copyBtn = document.createElement("button");
      copyBtn.className = "cmdf-copy-btn";
      copyBtn.title = "Copy";

      function makeSvg(attrs, children) {
        const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        s.setAttribute("width", "14");
        s.setAttribute("height", "14");
        s.setAttribute("viewBox", "0 0 24 24");
        s.setAttribute("fill", "none");
        s.setAttribute("stroke", "currentColor");
        s.setAttribute("stroke-width", "2");
        s.setAttribute("stroke-linecap", "round");
        s.setAttribute("stroke-linejoin", "round");
        children.forEach(([tag, a]) => {
          const el = document.createElementNS(
            "http://www.w3.org/2000/svg",
            tag,
          );
          Object.entries(a).forEach(([k, v]) => el.setAttribute(k, v));
          s.appendChild(el);
        });
        return s;
      }

      const copySvg = makeSvg({}, [
        ["rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }],
        [
          "path",
          { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" },
        ],
      ]);
      const checkSvg = makeSvg({}, [
        ["polyline", { points: "20 6 9 17 4 12" }],
      ]);
      copyBtn.appendChild(copySvg);

      copyBtn.addEventListener("click", () => {
        navigator.clipboard
          .writeText(code.textContent)
          .then(() => {
            copyBtn.classList.add("copied");
            copyBtn.replaceChild(checkSvg, copySvg);
            setTimeout(() => {
              copyBtn.classList.remove("copied");
              copyBtn.replaceChild(copySvg, checkSvg);
            }, 1500);
          })
          .catch(() => {});
      });

      wrapper.appendChild(pre);
      wrapper.appendChild(copyBtn);
      frag.appendChild(wrapper);
      return;
    }

    part.split(/\n{2,}/).forEach((block) => {
      block = block.trim();
      if (!block) return;

      // Horizontal rules — silently dropped per system prompt
      if (/^(\s*[-*_]\s*){3,}$/.test(block)) return;

      // Setext headings (must check before ATX to avoid --- being an HR)
      let m;
      if ((m = block.match(/^(.+)\n={3,}$/))) {
        const h = document.createElement("h1");
        appendInline(h, m[1].trim());
        frag.appendChild(h);
        return;
      }
      if ((m = block.match(/^(.+)\n-{3,}$/))) {
        const h = document.createElement("h2");
        appendInline(h, m[1].trim());
        frag.appendChild(h);
        return;
      }

      // ATX headings
      if ((m = block.match(/^(#{1,6})\s+(.+)$/))) {
        const h = document.createElement(`h${m[1].length}`);
        appendInline(h, m[2]);
        frag.appendChild(h);
        return;
      }

      // Unordered list — every non-empty line must start with "- " or "* "
      const lines = block.split("\n");
      if (lines.every((l) => !l.trim() || /^[*-] /.test(l))) {
        const ul = document.createElement("ul");
        lines.forEach((line) => {
          const lm = line.match(/^[*-] (.+)$/);
          if (!lm) return;
          const li = document.createElement("li");
          appendInline(li, lm[1]);
          ul.appendChild(li);
        });
        if (ul.children.length) frag.appendChild(ul);
        return;
      }

      // Paragraph — single newlines become <br>
      const p = document.createElement("p");
      lines.forEach((line, idx) => {
        appendInline(p, line);
        if (idx < lines.length - 1) p.appendChild(document.createElement("br"));
      });
      frag.appendChild(p);
    });
  });

  return frag;
}

// ─── Conversation rendering ───────────────────────────────────────────────────

// DOM references for the currently-streaming turn
let activeTurnEl = null;
let activeResponseEl = null;

// Create and append a new active turn div for the given query.
function startTurn(query) {
  const turn = document.createElement("div");
  turn.className = "cmdf-turn cmdf-turn-active";

  const label = document.createElement("p");
  label.className = "cmdf-query-label";
  label.textContent = query;
  turn.appendChild(label);

  const response = document.createElement("div");
  response.className = "cmdf-response";
  turn.appendChild(response);

  resultsEl.appendChild(turn);
  resultsEl.classList.add("cmdf-visible");
  resultsEl.classList.remove("cmdf-error");

  activeTurnEl = turn;
  activeResponseEl = response;
}

// Called after a stream completes — renders markdown into the active turn and locks it.
function finalizeCurrentTurn() {
  if (!activeTurnEl) return;

  if (streamBuffer) {
    activeResponseEl.textContent = "";
    activeResponseEl.appendChild(renderMarkdownToDOM(streamBuffer));
    activeTurnEl.classList.remove("cmdf-turn-active");
    conversationTurns.push({ query: currentQuery, response: streamBuffer });
    streamBuffer = "";
  } else {
    // No content arrived (e.g. aborted before first chunk) — remove the empty shell
    activeTurnEl.remove();
  }

  activeTurnEl = null;
  activeResponseEl = null;
  if (resultsEl) resultsEl.scrollTop = resultsEl.scrollHeight;
}

// During streaming: update plain text. Markdown is applied only on completion.
function appendChunk(text) {
  hideSpinner();
  streamBuffer += text;
  if (activeResponseEl) {
    activeResponseEl.textContent = streamBuffer;
  }
  if (resultsEl) resultsEl.scrollTop = resultsEl.scrollHeight;
}

function showError(msg) {
  hideSpinner();
  const p = document.createElement("p");
  p.className = "cmdf-error-text";
  p.textContent = msg;
  if (activeResponseEl) {
    activeResponseEl.textContent = "";
    activeResponseEl.appendChild(p);
    activeTurnEl?.classList.remove("cmdf-turn-active");
    activeTurnEl = null;
    activeResponseEl = null;
  } else {
    resultsEl.classList.add("cmdf-visible");
    resultsEl.appendChild(p);
  }
}

function showNoKeyMessage() {
  hideSpinner();
  const p = document.createElement("p");
  p.appendChild(document.createTextNode("No API key set. "));
  const a = document.createElement("a");
  a.textContent = "Open settings →";
  a.href = "#";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: "openOptions" });
  });
  p.appendChild(a);
  if (activeResponseEl) {
    activeResponseEl.textContent = "";
    activeResponseEl.appendChild(p);
    activeTurnEl?.classList.remove("cmdf-turn-active");
    activeTurnEl = null;
    activeResponseEl = null;
  } else {
    resultsEl.classList.add("cmdf-visible");
    resultsEl.appendChild(p);
  }
}

// ─── Search orchestration ─────────────────────────────────────────────────────

async function handleSearch(query) {
  // Finalize any in-progress turn before starting a new one
  finalizeCurrentTurn();

  currentQuery = query;
  inputEl.value = ""; // Clear input so user can type a follow-up

  // Record in history (dedupe consecutive identical queries, cap at 25)
  if (queryHistory[queryHistory.length - 1] !== query) {
    queryHistory.push(query);
    if (queryHistory.length > 25) queryHistory.shift();
    saveQueryHistory(queryHistory); // fire-and-forget
  }
  historyIndex = -1;
  historyDraft = "";

  if (currentAbortController) currentAbortController.abort();
  currentAbortController = new AbortController();

  showSpinner();
  startTurn(query); // Create the active turn div and show the query label

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
      return;
    }
    finalizeCurrentTurn(); // Render markdown now that the stream is complete
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

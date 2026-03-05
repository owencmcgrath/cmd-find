# Saved Queries Per Hostname — Design

**Date:** 2026-03-04
**Branch:** feat/saved-queries

## Problem

Query history is currently in-memory only and resets when the overlay closes. Users who return to a site they've searched before have no access to their previous queries.

## Goal

Persist the last 25 queries per hostname in `chrome.storage.local`, loaded when the overlay opens and navigable via the up/down arrow keys (existing behavior).

## Data Model

- **Storage key:** `queries_${window.location.hostname}` (e.g., `queries_en.wikipedia.org`)
- **Storage backend:** `chrome.storage.local`
- **Value:** JSON array of strings, most-recent-first, max 25 entries
- **Deduplication:** consecutive identical queries are still collapsed (existing behavior preserved)

## Implementation

Only `content.js` changes. Two helper functions added:

```js
async function loadQueryHistory(hostname) {
  const key = `queries_${hostname}`;
  const result = await chrome.storage.local.get(key);
  return result[key] || [];
}

async function saveQueryHistory(hostname, queries) {
  await chrome.storage.local.set({ [`queries_${hostname}`]: queries });
}
```

Two call sites:

1. **Overlay open** — call `loadQueryHistory(window.location.hostname)` and assign to `queryHistory`
2. **Query submission** — after existing dedup + prepend, slice to 25, call `saveQueryHistory`

The up/down arrow navigation logic is untouched.

Max history size bumped: 10 → 25.

## Files Changed

- `content.js` — only file affected

## Verification

1. Load the extension unpacked in Chrome
2. Open a page (e.g., wikipedia.org), run several queries, close the overlay
3. Reopen the overlay on the same page — up arrow should surface previous queries
4. Navigate to a different hostname — up arrow history should be empty (or reflect that site's history)
5. Close and reopen the tab — queries should persist

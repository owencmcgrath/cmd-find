/* background.js — service worker for cmd-find */

// Content scripts can't call chrome.runtime.openOptionsPage() directly,
// so we relay the message from content.js here.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
  }
});

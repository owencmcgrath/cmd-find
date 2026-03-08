# cmd-find

A Chrome extension that replaces the native `Cmd+F` (`Ctrl+F` on Windows) find bar with an AI-powered semantic search overlay. Ask questions about the page in plain language instead of searching for exact strings.

No backend. No account. No data leaves your browser except the direct API call you authorize.

## Requirements

- Google Chrome (or any Chromium-based browser that supports Manifest V3)
- An API key from one of the supported providers:
  - [OpenAI](https://platform.openai.com/api-keys)
  - [Anthropic](https://console.anthropic.com/settings/keys)
  - [Google AI Studio](https://aistudio.google.com/app/apikey)

## Installation

Chrome does not allow loading unpacked extensions from iCloud Drive on some systems. If you run into issues, copy the folder to a local path first.

**1. Download the extension**

Clone the repository or download it as a ZIP and extract it:

```
git clone https://github.com/owencmcgrath/cmd-find.git
```

**2. Open the Chrome extensions page**

Navigate to `chrome://extensions` in your browser.

**3. Enable Developer Mode**

Toggle the "Developer mode" switch in the top-right corner of the extensions page.

**4. Load the extension**

Click "Load unpacked" and select the `cmd-find` directory (the folder containing `manifest.json`).

The extension will appear in your extensions list and is now active on all pages.

## Setup

Before using the extension, you need to configure your API key.

**1. Open the options page**

Right-click the extension icon in the Chrome toolbar and select "Options". Alternatively, click "Details" on the extensions page and then "Extension options".

**2. Select your provider**

Choose OpenAI, Anthropic, or Google from the dropdown.

**3. Enter your API key**

Paste your API key into the key field. The key is stored in `chrome.storage.sync` and never sent anywhere except the provider's API endpoint.

**4. Save**

Click Save. The extension is ready to use.

## Usage

Press **Cmd+F** on Mac or **Ctrl+F** on Windows/Linux on any page to open the overlay. Type a question or search query in natural language and press Enter. The response streams in below the input field.

Press **Escape** or click outside the overlay to close it.

## Permissions

The extension requests the following permissions:

| Permission | Reason |
|---|---|
| `storage` | Saves your provider selection and API key locally |
| `https://api.openai.com/*` | Required if using OpenAI |
| `https://api.anthropic.com/*` | Required if using Anthropic |
| `https://generativelanguage.googleapis.com/*` | Required if using Google |

No other network access is made. No telemetry, no analytics.

## Default Models

| Provider | Default Model |
|---|---|
| OpenAI | `gpt-4o-mini` |
| Anthropic | `claude-haiku-4-5-20251001` |
| Google | `gemini-2.5-flash` |

You can override the model on the options page by entering any valid model string for your provider.

## Roadmap

- [x] align icons
- [x] light/dark mode
- [x] improve markdown rendering
- [x] save queries after page is closed
- [ ] better readme
- [ ] demo website
- [ ] chrome web release
- [ ] edge/firefox
- [ ] safari (MAYBE)...

# extensions-cross_browser-sync

Cross-browser WebExtension (Manifest V3) to sync your installed browser extensions and their **enabled/disabled state** across **Chromium-based browsers** (Chrome, Edge, Brave, Vivaldi, Opera) and **Firefox** using a private **GitHub Gist**.

---

## Features

- **Cross-Browser Extension Matching (Chromium ↔ Firefox)**:
  - Bridges 32-character Chrome Web Store / Edge Add-ons IDs and Firefox Add-on GUIDs (`addons.mozilla.org`).
  - Includes a built-in catalog of popular cross-browser extensions (`src/shared/catalog.js`), normalized title & homepage matching (`src/shared/matcher.js`), live Mozilla AMO REST API v5 lookup, and custom canonical key pairing in the dashboard.
- **Enabled / Disabled State Sync**:
  - Automatically toggles installed extensions on or off (`management.setEnabled`) to match your synced state across browsers.
  - Tracks per-extension modification timestamps for smart bidirectional **Merge Sync**, as well as explicit **Push ↑** and **Pull ↓** actions.
- **1-Click Store Install for Missing Extensions**:
  - Lists extensions present in your sync cloud that aren't installed in your current browser yet, with 1-click links to the **Chrome Web Store**, **Firefox Add-ons (AMO)**, or **Microsoft Edge Add-ons** (plus an **Install All Missing** batch button).
- **Private GitHub Gist Backend (Zero Server Required)**:
  - Auto-creates a private Gist (`extensions-cross_browser-sync.json`) or auto-discovers your existing sync Gist with just a GitHub Personal Access Token (`gist` scope).
  - Also supports local JSON export & import for offline backups.

---

## Quick Start & Installation

### 1. Build Browser Packages

```bash
npm run build
```

This generates icons in `assets/` and outputs clean browser-specific packages:
- `dist/chromium/` — For **Chrome, Brave, Edge, Vivaldi, Opera**
- `dist/firefox/` — For **Firefox** (with `background.scripts` and `browser_specific_settings.gecko`)

*(You can also load the repository root directory directly in Chromium or Firefox 121+).*

### 2. Load in Chromium Browsers (Chrome, Edge, Brave, Vivaldi, Opera)

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `dist/chromium` folder (or the repository root folder).

### 3. Load in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select `dist/firefox/manifest.json`.

---

## Setting Up GitHub Gist Sync

1. Click the **extensions-cross_browser-sync** toolbar icon and click the **Settings (gear)** icon to open the Dashboard.
2. Create a [GitHub Personal Access Token](https://github.com/settings/tokens/new?scopes=gist&description=extensions-cross_browser-sync) with the **`gist`** scope.
3. Paste your token into **1. GitHub Gist Backend**:
   - On your **first browser**: Click **+ Create New Private Gist** to create a private Gist initialized with your currently installed extensions.
   - On your **other browsers**: Paste the same token and click **Verify & Auto-Discover Gist** — it will automatically find and connect your `extensions-cross_browser-sync.json` Gist!
4. Click **Sync Now (Merge)** in the popup or dashboard anytime, or enable **Periodic Background Sync** and **Auto-push on change**.

---

## Running Tests

```bash
npm test
```


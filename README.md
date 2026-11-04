# extensions-cross_browser-sync

Cross-browser WebExtension (Manifest V3) to sync your installed browser extensions, their **enabled/disabled state**, and **ignored extensions** across **Chromium-based browsers** (Chrome, Edge, Brave, Vivaldi, Opera) and **Firefox** using a private **GitHub Gist** — with support for **1-click Store Auto-Install** and **Git Repository `.xpi` File Auto-Install**.

---

## Key Features

### 1. Cross-Browser Extension Matching & ID Enrichment (Chromium ↔ Firefox ↔ Edge)
- **Automatic ID Bridging**: Maps 32-character Chrome Web Store / Edge Add-ons IDs (`[a-p]{32}`) to Firefox Add-on GUIDs and AMO slugs (`addons.mozilla.org`).
- **Multi-Layer Resolution** (`src/shared/matcher.js`):
  1. **Custom Overrides**: User-defined canonical keys (`customMappings`) and manual browser ID/store URL overrides (`customBrowserIds`).
  2. **Built-in Catalog** (`src/shared/catalog.js`): `KNOWN_EXTENSIONS_CATALOG` entries containing `key`, `name`, `chromiumId`, `edgeId`, `firefoxId`, `firefoxSlug`, `xpiFile`, and `aliases`.
  3. **Live Store Discovery**: Automatically queries the Mozilla AMO REST API v5 and Chrome Web Store in the background to populate missing counterpart browser IDs and store links (`Cr:`, `Ff:`, `Ed:`).
  4. **Normalized Name & Homepage Matching**: Strips browser suffixes (e.g., *"for Chrome"*, *"for Firefox"*) and compares normalized titles and homepage URLs.

### 2. Smart Bidirectional State & Ignore Sync
- **Enabled / Disabled State Sync**: Automatically toggles installed extensions on or off (`management.setEnabled`) to match your synced state across browsers.
- **Sync Modes**:
  - **Sync Now (Merge)**: Bidirectional smart merge using per-extension `updatedAt` timestamps so the most recent change wins.
  - **Push ↑**: Overwrites the Gist with your current local browser state.
  - **Pull ↓**: Applies the remote Gist state to your local browser.
- **Synced Ignore List**: Ignoring or unignoring an extension updates both local settings and the Gist payload (`ignoredKeys` and `ignored: true`), keeping ignored extensions consistent across all your browsers.

### 3. Flexible Installation (`Install ▾` Menu)
Missing extensions display an **`Install ▾`** dropdown in both the **Popup** and the **Dashboard**:
- **Auto Install (from Browser Store / AMO)**:
  - **Firefox**: Resolves the latest signed `.xpi` package via the Mozilla AMO API (`https://addons.mozilla.org/firefox/downloads/latest/<slug>/addon-latest.xpi`) and opens it to trigger Firefox's native installation prompt directly.
  - **Chromium**: Opens the direct Chrome Web Store or Microsoft Edge Add-ons detail page.
  - **Post-Install State Sync**: Listens to `management.onInstalled` and automatically enables or disables the newly installed extension to match its Gist state.
- **Auto Install from File (`xpi-files/`)**:
  - Displayed **only on Firefox** and **only when the extension's `.xpi` file is available and accessible** in the `xpi-files/<key>.xpi` folder of your configured GitHub repository (supports both public and private repositories via GitHub API / raw URLs).
- **Auto-Install All Missing**: Batch action in the toolbar to trigger installation for all missing extensions at once.

### 4. Dashboard & Compact Popup UI
- **Interactive Filter Tabs & Chips**: Filter by **All**, **Installed (Local)**, **Out of sync**, **Missing**, or **Ignored**, plus instant search by name, key, or ID.
- **Hover Tooltips**: Every button across the Popup, Dashboard, and Modals provides a concise explanation on hover.
- **Browser IDs Column (`Cr:`, `Ff:`, `Ed:`)**:
  - Displays known IDs for each browser family alongside direct **`Store ↗`** buttons for every available store.
  - Supports inline editing of Chromium and Firefox IDs (accepts either raw IDs or full store URLs) via **`Save IDs`**.
- **Catalog JSON Snippet Modal (`Catalog JSON`)**: Generates a ready-to-paste `KNOWN_EXTENSIONS_CATALOG` object (complete with `xpiFile: 'xpi-files/<key>.xpi'`) for any extension.
- **Remote Gist Management**: Remove individual extensions from your Gist (**`Remove from Gist`**) or wipe the remote list (**`Clear Saved Gist Data`**).

### 5. Full Settings & Profile Backup
- **Export Settings ↓ / Import Settings ↑**: Back up or restore **all** configuration values in a single JSON file (`githubToken`, `gistId`, `gitRepoUrl`, `gitRepoToken`, `gitRepoBranch`, `deviceName`, sync schedule & automation toggles, `ignoredKeys`, `customMappings`, and `customBrowserIds`).
- **Export Extensions JSON ↓ / Import Extensions JSON ↑**: Export a snapshot of your installed extensions or load a JSON payload into the comparison matrix.

---

## Quick Start & Installation

### 1. Build Browser Packages

```bash
npm run build
```

This generates icons in `assets/` and outputs clean browser-specific packages from `src/`:
- `dist/chromium/` — For **Chrome, Brave, Edge, Vivaldi, Opera**
- `dist/firefox/` — For **Firefox** (with `background.scripts` and `browser_specific_settings.gecko`)

> **Why are there multiple `catalog.js` files?**
> `src/shared/catalog.js` is the single source of truth. Running `npm run build` (`scripts/build.mjs`) copies `src/` into `dist/chromium/src/` and `dist/firefox/src/` so each browser target has a self-contained extension bundle. Always edit `src/shared/catalog.js` and run `npm run build`.

### 2. Load in Chromium Browsers (Chrome, Edge, Brave, Vivaldi, Opera)
1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `dist/chromium` (or the repository root folder).

### 3. Load in Firefox
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select `dist/firefox/manifest.json`.

---

## Configuring GitHub Gist & Git Repo (`xpi-files`)

1. Click the **extensions-cross_browser-sync** toolbar icon and click **Settings** (gear icon) to open the Dashboard, then click **Settings** in the top-right bar.
2. **GitHub Gist Backend**:
   - Create a [GitHub Personal Access Token](https://github.com/settings/tokens/new?scopes=gist&description=extensions-cross_browser-sync) with the **`gist`** scope.
   - Paste your token (use **Show/Hide** to verify):
     - **First browser**: Click **+ Create New Private Gist** to initialize a private `extensions-cross_browser-sync.json` Gist.
     - **Additional browsers**: Click **Verify & Auto-Discover Gist** to automatically locate and connect your existing Gist.
3. **Git Repository for `xpi-files` Installation (Optional)**:
   - **Git Repository URL**: Enter your repository URL (e.g. `https://github.com/owner/extensions-cross_browser-sync`).
   - **Git Repo Access Token**: Optional token with `repo` / `contents:read` access if your repository is private (falls back to the Gist token or public access if left blank).
   - **Git Branch**: Optional branch name (defaults to `main`).
4. Click **Save Connection Settings** (or use **Export Settings ↓** / **Import Settings ↑** to transfer your setup to another browser in seconds).

---

## Automated Catalog & `.xpi` Workflow

The GitHub Actions workflow `.github/workflows/update-and-download-catalog.yml` (**Update and Download EXTENSIONS_CATALOG**) automates catalog maintenance and `.xpi` mirroring:

1. **Sync `catalog.js` to `dist/firefox` and `dist/chromium`** (`npm run build`) — Ensures `dist/` mirrors `src/shared/catalog.js`.
2. **Update `KNOWN_EXTENSIONS_CATALOG` with Gist Content** (`node scripts/update-catalog.mjs`) — Reads your synced Gist (`secrets.GIST_ID` / `secrets.GIST_TOKEN`, skipping ignored extensions), validates candidate extensions against both the Chrome Web Store and Mozilla AMO REST API v5, and appends entries that have **both** valid Chromium and Firefox IDs/URLs to `src/shared/catalog.js`.
3. **Download / Update `.xpi` Files** (`node scripts/download-xpi.mjs`) — Downloads the latest Firefox `.xpi` package for each catalog entry into `xpi-files/<key>.xpi` and records version, SHA-256 hash, and metadata in `xpi-files/manifest.json`.
4. **Update `xpiFile` Paths in `KNOWN_EXTENSIONS_CATALOG`** (`node scripts/update-catalog-xpi-paths.mjs`) — Ensures every catalog entry with a downloaded `.xpi` in `xpi-files/` has `xpiFile: 'xpi-files/<key>.xpi'` set in `src/shared/catalog.js`.
5. **Sync Updated `catalog.js` & Run Tests** (`npm run build && npm test`) — Mirrors the updated `src/shared/catalog.js` back into `dist/chromium/` and `dist/firefox/` and runs the test suite before committing.

### Running Scripts Locally

```bash
# Build dist/chromium and dist/firefox packages
npm run build

# Update KNOWN_EXTENSIONS_CATALOG from a Gist (requires GIST_ID env var)
GIST_ID=<your_gist_id> npm run update-catalog

# Download latest Firefox .xpi files for catalog entries into xpi-files/
npm run download-xpi

# Sync xpiFile paths in src/shared/catalog.js with xpi-files/*.xpi on disk
npm run update-catalog-xpi-paths

# Run unit tests
npm test
```



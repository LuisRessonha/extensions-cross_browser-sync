# Privacy Policy for Cross-Browser Extensions Sync

Last updated: November 4, 2026

**Cross-Browser Extensions Sync** ("the Extension") is an open-source browser extension developed by Luis Ressonha. We respect your privacy and are committed to protecting it.

## 1. Overview & Core Philosophy

The Extension is designed to operate locally on your devices without collecting, storing, or transmitting your personal data to any developer-owned or intermediary servers. All synchronization is performed directly between your browser and your personal GitHub account via a private GitHub Gist.

## 2. Information Handled by the Extension

To perform its synchronization functionality, the Extension processes the following data:

* **Installed Extensions Metadata**: The Extension queries the list of extensions installed in your browser, including their names, IDs, enabled/disabled state, and store URLs, using the standard browser `management` API.
* **Authentication Credentials (GitHub Personal Access Token)**: When configured, your GitHub Personal Access Token (PAT) and Gist ID are stored locally on your device via `chrome.storage.local`.
* **Sync Configuration**: User preferences such as ignored extension lists, custom mappings, and sync schedules are stored locally on your device.

## 3. Data Storage & Transmission

* **Local Storage**: All settings, tokens, and preferences are stored exclusively on your device using the browser's local storage API (`chrome.storage.local`).
* **GitHub Gist**: The list of synced extension IDs and states is stored in a private GitHub Gist owned and controlled solely by you. Communications are made directly to GitHub's official APIs (`api.github.com`) over secure HTTPS connections using your personal credentials.
* **Store Lookups**: Public extension store endpoints (Chrome Web Store, Mozilla Add-ons AMO) are queried directly to resolve cross-browser extension IDs and public store links. No personally identifiable information or browsing history is sent with these queries.

## 4. No Third-Party Tracking or Data Collection

* We do **not** collect, track, or log any personal information, browsing history, web traffic, or keystrokes.
* We do **not** use any analytics, telemetry, tracking pixels, or advertising SDKs.
* We do **not** sell, rent, or transfer any user data to third parties.

## 5. Permissions Justification

* `management`: Required to detect installed extensions, read their enabled/disabled states, and toggle states during synchronization.
* `storage`: Required to save user preferences, Gist IDs, and access tokens locally on the device.
* `alarms`: Required to trigger periodic background synchronization according to user preferences.
* `tabs`: Required to open extension store pages and settings dashboards in browser tabs.
* Host Permissions (`api.github.com`, `gist.githubusercontent.com`, `raw.githubusercontent.com`, `github.com`, `addons.mozilla.org`, `chromewebstore.google.com`): Required exclusively to interact with GitHub APIs for Gist synchronization and query public extension store listings for ID matching.

## 6. Open Source Verification

The Extension is open source. You can inspect the complete source code and verify our privacy practices at:
https://github.com/LuisRessonha/extensions-cross_browser-sync

## 7. Contact

If you have any questions or feedback regarding this Privacy Policy, please open an issue on GitHub:
https://github.com/LuisRessonha/extensions-cross_browser-sync/issues


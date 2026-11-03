/**
 * Unified WebExtension API wrapper and browser runtime detector.
 * Works across Chromium (Chrome, Edge, Brave, Vivaldi, Opera) and Firefox (Gecko).
 */

export const ext = typeof globalThis.browser !== 'undefined' && globalThis.browser?.runtime
  ? globalThis.browser
  : globalThis.chrome;

/**
 * Detects the current browser family ('firefox' or 'chromium') and specific browser brand.
 * @returns {{ family: 'firefox' | 'chromium', brand: string, label: string }}
 */
export function detectBrowserEnvironment() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const runtimeUrl = ext?.runtime?.getURL ? ext.runtime.getURL('') : '';

  if (runtimeUrl.startsWith('moz-extension://') || /Firefox\//i.test(ua)) {
    return { family: 'firefox', brand: 'firefox', label: 'Firefox' };
  }
  if (/Edg\//i.test(ua)) {
    return { family: 'chromium', brand: 'edge', label: 'Microsoft Edge' };
  }
  if (/OPR\//i.test(ua) || /Opera/i.test(ua)) {
    return { family: 'chromium', brand: 'opera', label: 'Opera' };
  }
  if (/Vivaldi/i.test(ua)) {
    return { family: 'chromium', brand: 'vivaldi', label: 'Vivaldi' };
  }
  if (typeof navigator !== 'undefined' && navigator.brave) {
    return { family: 'chromium', brand: 'brave', label: 'Brave' };
  }
  return { family: 'chromium', brand: 'chrome', label: 'Chrome / Chromium' };
}

/**
 * Promise-safe wrapper for management.getAll()
 */
export async function getInstalledExtensions() {
  if (!ext?.management?.getAll) {
    return [];
  }
  const all = await ext.management.getAll();
  const selfId = ext.runtime?.id;
  // Filter to only regular extensions (exclude themes, apps, and this sync extension itself)
  return all.filter((item) => {
    if (item.id === selfId) return false;
    if (item.type && item.type !== 'extension') return false;
    // Also exclude built-in system/component extensions that cannot be uninstalled or managed
    if (item.installType === 'admin') return true;
    return true;
  });
}

/**
 * Promise-safe wrapper to toggle an extension's enabled state.
 * @param {string} id
 * @param {boolean} enabled
 */
export async function setExtensionEnabled(id, enabled) {
  if (!ext?.management?.setEnabled) {
    throw new Error('management.setEnabled API is not available');
  }
  await ext.management.setEnabled(id, Boolean(enabled));
}

/**
 * Promise-safe wrapper to prompt uninstalling an extension.
 * @param {string} id
 */
export async function uninstallExtension(id) {
  if (!ext?.management?.uninstall) {
    throw new Error('management.uninstall API is not available');
  }
  await ext.management.uninstall(id, { showConfirmDialog: true });
}

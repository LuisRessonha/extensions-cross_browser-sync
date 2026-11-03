import { ext, detectBrowserEnvironment } from './browser-polyfill.js';

const STORAGE_KEYS = {
  SETTINGS: 'ecbs_settings',
  LOCAL_META: 'ecbs_local_meta',
  REMOTE_CACHE: 'ecbs_remote_cache',
  SYNC_LOG: 'ecbs_sync_log'
};

export const DEFAULT_SETTINGS = {
  githubToken: '',
  gistId: '',
  deviceName: '',
  autoSyncMinutes: 30, // 0 = disabled, otherwise minutes
  autoPushOnChange: false,
  autoApplyEnabledState: true,
  syncDisabledExtensions: true,
  includeDevelopmentExtensions: false,
  ignoredKeys: [], // Array of canonical keys or extension IDs excluded from sync
  customMappings: {}, // Map of local extension ID -> canonical key override
  customBrowserIds: {} // Map of canonical key -> { chromium?: string, firefox?: string }
};

/**
 * Generates a persistent random device ID when first initialized.
 */
function generateDeviceId() {
  const rand = Math.random().toString(36).substring(2, 10);
  return `dev_${Date.now().toString(36)}_${rand}`;
}

export async function getSettings() {
  if (!ext?.storage?.local) {
    return { ...DEFAULT_SETTINGS };
  }
  const data = await ext.storage.local.get(STORAGE_KEYS.SETTINGS);
  const stored = data?.[STORAGE_KEYS.SETTINGS] || {};
  const env = detectBrowserEnvironment();

  const merged = {
    ...DEFAULT_SETTINGS,
    ...stored,
    ignoredKeys: Array.isArray(stored.ignoredKeys) ? stored.ignoredKeys : [],
    customMappings:
      stored.customMappings && typeof stored.customMappings === 'object'
        ? stored.customMappings
        : {},
    customBrowserIds:
      stored.customBrowserIds && typeof stored.customBrowserIds === 'object'
        ? stored.customBrowserIds
        : {}
  };

  if (!merged.deviceId) {
    merged.deviceId = generateDeviceId();
    if (!merged.deviceName) {
      merged.deviceName = `${env.label}`;
    }
    await saveSettings(merged);
  } else if (!merged.deviceName) {
    merged.deviceName = `${env.label}`;
  }

  return merged;
}

export async function saveSettings(partialSettings) {
  if (!ext?.storage?.local) return partialSettings;
  const current = await ext.storage.local.get(STORAGE_KEYS.SETTINGS);
  const existing = current?.[STORAGE_KEYS.SETTINGS] || {};
  const updated = {
    ...DEFAULT_SETTINGS,
    ...existing,
    ...partialSettings
  };
  await ext.storage.local.set({ [STORAGE_KEYS.SETTINGS]: updated });
  return updated;
}

/**
 * Local metadata tracks per-extension change timestamps (`updatedAtByKey`)
 * and last sync status.
 */
export async function getLocalMeta() {
  if (!ext?.storage?.local) {
    return { updatedAtByKey: {}, lastSyncAt: null, lastSyncStatus: null, lastSyncError: null };
  }
  const data = await ext.storage.local.get(STORAGE_KEYS.LOCAL_META);
  const meta = data?.[STORAGE_KEYS.LOCAL_META] || {};
  return {
    updatedAtByKey: meta.updatedAtByKey || {},
    lastSyncAt: meta.lastSyncAt || null,
    lastSyncStatus: meta.lastSyncStatus || null,
    lastSyncError: meta.lastSyncError || null,
    lastSyncSummary: meta.lastSyncSummary || null
  };
}

export async function saveLocalMeta(partialMeta) {
  if (!ext?.storage?.local) return;
  const current = await getLocalMeta();
  const updated = {
    ...current,
    ...partialMeta,
    updatedAtByKey: {
      ...current.updatedAtByKey,
      ...(partialMeta.updatedAtByKey || {})
    }
  };
  await ext.storage.local.set({ [STORAGE_KEYS.LOCAL_META]: updated });
  return updated;
}

/**
 * Records that a specific canonical extension key had its state changed locally right now.
 * @param {string} key
 * @param {string} [isoTime]
 */
export async function touchExtensionTimestamp(key, isoTime = new Date().toISOString()) {
  if (!key) return;
  const current = await getLocalMeta();
  current.updatedAtByKey[key] = isoTime;
  await ext.storage.local.set({ [STORAGE_KEYS.LOCAL_META]: current });
}

/**
 * Stores a cached copy of the last fetched/pushed remote Gist payload for fast popup rendering.
 */
export async function getRemoteCache() {
  if (!ext?.storage?.local) return null;
  const data = await ext.storage.local.get(STORAGE_KEYS.REMOTE_CACHE);
  return data?.[STORAGE_KEYS.REMOTE_CACHE] || null;
}

export async function saveRemoteCache(payload) {
  if (!ext?.storage?.local) return;
  await ext.storage.local.set({ [STORAGE_KEYS.REMOTE_CACHE]: payload });
}

/**
 * Appends an entry to the sync activity log (keeps latest 30 entries).
 */
export async function appendSyncLog(entry) {
  if (!ext?.storage?.local) return;
  const data = await ext.storage.local.get(STORAGE_KEYS.SYNC_LOG);
  const logs = Array.isArray(data?.[STORAGE_KEYS.SYNC_LOG]) ? data[STORAGE_KEYS.SYNC_LOG] : [];
  logs.unshift({
    timestamp: new Date().toISOString(),
    ...entry
  });
  await ext.storage.local.set({ [STORAGE_KEYS.SYNC_LOG]: logs.slice(0, 30) });
}

export async function getSyncLogs() {
  if (!ext?.storage?.local) return [];
  const data = await ext.storage.local.get(STORAGE_KEYS.SYNC_LOG);
  return Array.isArray(data?.[STORAGE_KEYS.SYNC_LOG]) ? data[STORAGE_KEYS.SYNC_LOG] : [];
}


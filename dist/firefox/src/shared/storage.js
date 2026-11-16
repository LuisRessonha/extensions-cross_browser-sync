import { ext, detectBrowserEnvironment } from './browser-polyfill.js';

const STORAGE_KEYS = {
  SETTINGS: 'ecbs_settings',
  LOCAL_META: 'ecbs_local_meta',
  REMOTE_CACHE: 'ecbs_remote_cache',
  SYNC_LOG: 'ecbs_sync_log'
};

export const DEFAULT_GROUPS = {
  default: {
    id: 'default',
    name: 'Default',
    color: '#64748b',
    isDefault: true
  },
  work: {
    id: 'work',
    name: 'Work',
    color: '#3b82f6',
    isDefault: false
  },
  personal: {
    id: 'personal',
    name: 'Personal',
    color: '#10b981',
    isDefault: false
  },
  fun: {
    id: 'fun',
    name: 'Fun',
    color: '#f59e0b',
    isDefault: false
  }
};

/**
 * Normalizes a groups dictionary, ensuring the immutable `default` group always exists.
 * Seeds `DEFAULT_GROUPS` when no groups object has been initialized yet.
 */
export function normalizeGroupsMap(rawGroups) {
  const source =
    rawGroups && typeof rawGroups === 'object' && Object.keys(rawGroups).length > 0
      ? rawGroups
      : DEFAULT_GROUPS;

  const result = {
    default: {
      ...DEFAULT_GROUPS.default,
      ...(source.default && typeof source.default === 'object' ? source.default : {}),
      id: 'default',
      isDefault: true
    }
  };

  for (const [rawId, grp] of Object.entries(source)) {
    if (!grp || typeof grp !== 'object') continue;
    const id = String(grp.id || rawId)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-');
    if (!id || id === 'default') continue;
    result[id] = {
      id,
      name: String(grp.name || id).trim() || id,
      color: String(grp.color || '#3b82f6').trim(),
      isDefault: false
    };
  }

  return result;
}

/**
 * Normalizes an extension's assigned group IDs.
 * Any new or ungrouped extension defaults to `['default']`.
 */
export function normalizeExtensionGroupsList(rawList, groupsMap = null) {
  const arr = Array.isArray(rawList) ? rawList : [];
  const cleaned = [];
  for (const item of arr) {
    const id = String(item || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-');
    if (!id) continue;
    if (groupsMap && !groupsMap[id]) continue;
    if (!cleaned.includes(id)) {
      cleaned.push(id);
    }
  }
  return cleaned.length > 0 ? cleaned : ['default'];
}

export const DEFAULT_SETTINGS = {
  githubToken: '',
  gistId: '',
  gitRepoUrl: '',
  gitRepoToken: '',
  gitRepoBranch: '',
  deviceName: '',
  autoSyncMinutes: 30, // 0 = disabled, otherwise minutes
  autoPushOnChange: false,
  autoApplyEnabledState: true,
  syncDisabledExtensions: true,
  includeDevelopmentExtensions: false,
  exclusiveGroupActivation: true, // true = only 1 non-default group active at a time; false = multiple allowed
  syncActiveGroupsToGist: true, // true = sync activeGroupIds with Gist; false = keep activeGroupIds local only
  groups: { ...DEFAULT_GROUPS }, // Map of groupId -> { id, name, color, isDefault }
  extensionGroups: {}, // Map of canonical key -> string[] of groupIds
  activeGroupIds: [], // Array of currently active non-default groupIds
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

  const groups = normalizeGroupsMap(stored.groups);
  const rawExtensionGroups =
    stored.extensionGroups && typeof stored.extensionGroups === 'object'
      ? stored.extensionGroups
      : {};
  const extensionGroups = {};
  for (const [k, list] of Object.entries(rawExtensionGroups)) {
    if (!k) continue;
    extensionGroups[k] = normalizeExtensionGroupsList(list, groups);
  }
  const activeGroupIds = Array.isArray(stored.activeGroupIds)
    ? stored.activeGroupIds.filter((id) => id && id !== 'default' && Boolean(groups[id]))
    : [];

  const merged = {
    ...DEFAULT_SETTINGS,
    ...stored,
    exclusiveGroupActivation: stored.exclusiveGroupActivation !== false,
    syncActiveGroupsToGist: stored.syncActiveGroupsToGist !== false,
    groups,
    extensionGroups,
    activeGroupIds,
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


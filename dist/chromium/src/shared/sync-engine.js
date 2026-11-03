import {
  detectBrowserEnvironment,
  getInstalledExtensions,
  setExtensionEnabled
} from './browser-polyfill.js';
import {
  findCatalogEntry,
  findMatchingRemoteRecord,
  getStoreInstallInfo,
  isChromiumExtensionId,
  parseAndResolveManualBrowserId,
  resolveCanonicalKey,
  resolveChromiumExtensionFromStore,
  resolveFirefoxAddonFromAmo
} from './matcher.js';
import {
  appendSyncLog,
  getLocalMeta,
  getRemoteCache,
  getSettings,
  saveLocalMeta,
  saveRemoteCache,
  saveSettings,
  touchExtensionTimestamp
} from './storage.js';
import {
  createEmptySyncPayload,
  fetchSyncGist,
  normalizeSyncPayload,
  updateSyncGist
} from './gist.js';

// Guard flag so programmatic setExtensionEnabled calls during Pull/Merge do not re-trigger auto-push
let isApplyingRemoteState = false;

export function isCurrentlyApplyingRemoteState() {
  return isApplyingRemoteState;
}

/**
 * Picks the best icon URL from management.ExtensionInfo.icons
 */
function pickBestIcon(icons) {
  if (!Array.isArray(icons) || icons.length === 0) return '';
  const sorted = [...icons].sort((a, b) => (b.size || 0) - (a.size || 0));
  return sorted[0]?.url || '';
}

/**
 * Enriches an extension record's IDs and storeUrls using the local browser info and static catalog.
 */
export function buildSyncRecordFromLocal(localExt, existingRemote, browserEnv, settings, localMeta) {
  const key = existingRemote?.key || resolveCanonicalKey(localExt, settings.customMappings);
  const catalog = findCatalogEntry({ key, id: localExt.id, name: localExt.name });

  const prevIds = existingRemote?.ids || {};
  const ids = {};
  if (prevIds.chromium) ids.chromium = prevIds.chromium;
  if (prevIds.edge) ids.edge = prevIds.edge;
  if (prevIds.firefox) ids.firefox = prevIds.firefox;

  if (browserEnv.family === 'firefox') {
    ids.firefox = localExt.id;
  } else if (browserEnv.brand === 'edge' && localExt.updateUrl?.includes('microsoft.com')) {
    ids.edge = localExt.id;
  } else if (isChromiumExtensionId(localExt.id)) {
    ids.chromium = localExt.id;
  }

  if (catalog) {
    if (!ids.chromium && catalog.chromiumId) ids.chromium = catalog.chromiumId;
    if (!ids.edge && catalog.edgeId) ids.edge = catalog.edgeId;
    if (!ids.firefox && catalog.firefoxId) ids.firefox = catalog.firefoxId;
  }

  const customIds = settings?.customBrowserIds?.[key];
  if (customIds) {
    if (customIds.chromium) ids.chromium = customIds.chromium;
    if (customIds.edge) ids.edge = customIds.edge;
    if (customIds.firefox) ids.firefox = customIds.firefox;
  }

  const storeUrls = { ...(existingRemote?.storeUrls || {}) };
  if (customIds?.chromiumUrl) {
    storeUrls.chromium = customIds.chromiumUrl;
  } else if (ids.chromium && isChromiumExtensionId(ids.chromium)) {
    storeUrls.chromium = `https://chromewebstore.google.com/detail/${ids.chromium}`;
  }
  if (customIds?.firefoxUrl) {
    storeUrls.firefox = customIds.firefoxUrl;
  } else if (catalog?.firefoxSlug) {
    storeUrls.firefox = `https://addons.mozilla.org/firefox/addon/${catalog.firefoxSlug}/`;
  } else if (ids.firefox && !storeUrls.firefox) {
    storeUrls.firefox = `https://addons.mozilla.org/firefox/addon/${encodeURIComponent(ids.firefox)}/`;
  }
  if (ids.edge && isChromiumExtensionId(ids.edge) && !storeUrls.edge) {
    storeUrls.edge = `https://microsoftedge.microsoft.com/addons/detail/${ids.edge}`;
  }

  const localTouch = localMeta?.updatedAtByKey?.[key];
  const updatedAt = localTouch || existingRemote?.updatedAt || new Date().toISOString();

  return {
    key,
    name: localExt.name || existingRemote?.name || key,
    description: localExt.description || existingRemote?.description || '',
    homepageUrl: localExt.homepageUrl || existingRemote?.homepageUrl || '',
    enabled: Boolean(localExt.enabled),
    updatedAt,
    lastSeenVersion: localExt.version || existingRemote?.lastSeenVersion || '',
    ids,
    storeUrls
  };
}

/**
 * Checks if an extension is marked as ignored by key or ID.
 */
export function isExtensionIgnored(localExtOrRecord, key, ignoredKeys = []) {
  if (!Array.isArray(ignoredKeys) || ignoredKeys.length === 0) return false;
  if (key && ignoredKeys.includes(key)) return true;
  if (localExtOrRecord?.id && ignoredKeys.includes(localExtOrRecord.id)) return true;
  if (localExtOrRecord?.ids) {
    const { chromium, firefox, edge } = localExtOrRecord.ids;
    if (
      (chromium && ignoredKeys.includes(chromium)) ||
      (firefox && ignoredKeys.includes(firefox)) ||
      (edge && ignoredKeys.includes(edge))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Pure function that computes the full comparison view between local extensions and a remote Gist payload.
 */
export function computeSyncComparison({
  localExtensions,
  remotePayload,
  browserEnv,
  settings,
  localMeta
}) {
  const normalizedRemote = normalizeSyncPayload(remotePayload);
  const remoteMap = { ...normalizedRemote.extensions };
  const matchedRemoteKeys = new Set();

  const items = [];
  const counts = {
    totalLocal: 0,
    inSync: 0,
    stateDiff: 0,
    localOnly: 0,
    missingInLocal: 0,
    ignored: 0
  };

  for (const localExt of localExtensions) {
    // Skip unpacked development extensions unless enabled in settings
    if (localExt.installType === 'development' && !settings.includeDevelopmentExtensions) {
      continue;
    }

    counts.totalLocal++;

    const remoteMatch = findMatchingRemoteRecord(
      localExt,
      remoteMap,
      browserEnv.family,
      settings.customMappings
    );
    const key = remoteMatch?.key || resolveCanonicalKey(localExt, settings.customMappings);
    const ignored = isExtensionIgnored(localExt, key, settings.ignoredKeys);

    if (remoteMatch) {
      matchedRemoteKeys.add(remoteMatch.key);
    }

    const enrichedRecord = buildSyncRecordFromLocal(
      localExt,
      remoteMatch,
      browserEnv,
      settings,
      localMeta
    );
    const storeInfo = getStoreInstallInfo(enrichedRecord, browserEnv.family, browserEnv.brand);

    if (ignored) {
      counts.ignored++;
      items.push({
        status: 'ignored',
        key,
        inGist: Boolean(remoteMatch),
        localId: localExt.id,
        name: localExt.name,
        description: localExt.description || '',
        version: localExt.version || '',
        iconUrl: pickBestIcon(localExt.icons),
        localEnabled: Boolean(localExt.enabled),
        remoteEnabled: remoteMatch ? Boolean(remoteMatch.enabled) : null,
        mayDisable: localExt.mayDisable !== false,
        installType: localExt.installType || 'normal',
        ids: enrichedRecord.ids,
        storeUrls: enrichedRecord.storeUrls,
        storeInfo,
        updatedAt: enrichedRecord.updatedAt
      });
      continue;
    }

    if (remoteMatch) {
      const stateMatches = Boolean(localExt.enabled) === Boolean(remoteMatch.enabled);
      const status = stateMatches ? 'in-sync' : 'state-diff';
      if (stateMatches) {
        counts.inSync++;
      } else {
        counts.stateDiff++;
      }

      items.push({
        status,
        key,
        inGist: true,
        localId: localExt.id,
        name: localExt.name,
        description: localExt.description || remoteMatch.description || '',
        version: localExt.version || '',
        iconUrl: pickBestIcon(localExt.icons),
        localEnabled: Boolean(localExt.enabled),
        remoteEnabled: Boolean(remoteMatch.enabled),
        mayDisable: localExt.mayDisable !== false,
        installType: localExt.installType || 'normal',
        ids: enrichedRecord.ids,
        storeUrls: enrichedRecord.storeUrls,
        storeInfo,
        updatedAt: remoteMatch.updatedAt || enrichedRecord.updatedAt
      });
    } else {
      counts.localOnly++;
      items.push({
        status: 'local-only',
        key,
        inGist: false,
        localId: localExt.id,
        name: localExt.name,
        description: localExt.description || '',
        version: localExt.version || '',
        iconUrl: pickBestIcon(localExt.icons),
        localEnabled: Boolean(localExt.enabled),
        remoteEnabled: null,
        mayDisable: localExt.mayDisable !== false,
        installType: localExt.installType || 'normal',
        ids: enrichedRecord.ids,
        storeUrls: enrichedRecord.storeUrls,
        storeInfo,
        updatedAt: enrichedRecord.updatedAt
      });
    }
  }

  // Now check remote extensions that are NOT installed locally
  for (const [remKey, remRecord] of Object.entries(remoteMap)) {
    if (matchedRemoteKeys.has(remKey)) continue;

    const customIds = settings?.customBrowserIds?.[remKey];
    const catalog = findCatalogEntry({
      key: remKey,
      name: remRecord.name,
      id: remRecord.ids?.chromium || remRecord.ids?.firefox || remRecord.ids?.edge
    });
    const mergedIds = {};
    if (catalog?.chromiumId) mergedIds.chromium = catalog.chromiumId;
    if (catalog?.edgeId) mergedIds.edge = catalog.edgeId;
    if (catalog?.firefoxId) mergedIds.firefox = catalog.firefoxId;
    if (remRecord.ids?.chromium) mergedIds.chromium = remRecord.ids.chromium;
    if (remRecord.ids?.edge) mergedIds.edge = remRecord.ids.edge;
    if (remRecord.ids?.firefox) mergedIds.firefox = remRecord.ids.firefox;
    if (customIds?.chromium) mergedIds.chromium = customIds.chromium;
    if (customIds?.edge) mergedIds.edge = customIds.edge;
    if (customIds?.firefox) mergedIds.firefox = customIds.firefox;

    const mergedStoreUrls = { ...(remRecord.storeUrls || {}) };
    if (customIds?.chromiumUrl) {
      mergedStoreUrls.chromium = customIds.chromiumUrl;
    } else if (
      !mergedStoreUrls.chromium &&
      mergedIds.chromium &&
      isChromiumExtensionId(mergedIds.chromium)
    ) {
      mergedStoreUrls.chromium = `https://chromewebstore.google.com/detail/${mergedIds.chromium}`;
    }
    if (customIds?.firefoxUrl) {
      mergedStoreUrls.firefox = customIds.firefoxUrl;
    } else if (!mergedStoreUrls.firefox && catalog?.firefoxSlug) {
      mergedStoreUrls.firefox = `https://addons.mozilla.org/firefox/addon/${catalog.firefoxSlug}/`;
    } else if (!mergedStoreUrls.firefox && mergedIds.firefox) {
      mergedStoreUrls.firefox = `https://addons.mozilla.org/firefox/addon/${encodeURIComponent(
        mergedIds.firefox
      )}/`;
    }
    if (
      !mergedStoreUrls.edge &&
      mergedIds.edge &&
      isChromiumExtensionId(mergedIds.edge)
    ) {
      mergedStoreUrls.edge = `https://microsoftedge.microsoft.com/addons/detail/${mergedIds.edge}`;
    }

    const mergedRecord = {
      ...remRecord,
      ids: mergedIds,
      storeUrls: mergedStoreUrls
    };

    const ignored = isExtensionIgnored(mergedRecord, remKey, settings.ignoredKeys);
    const storeInfo = getStoreInstallInfo(mergedRecord, browserEnv.family, browserEnv.brand);

    if (ignored) {
      counts.ignored++;
      items.push({
        status: 'ignored',
        key: remKey,
        inGist: true,
        localId: null,
        name: remRecord.name || remKey,
        description: remRecord.description || '',
        version: remRecord.lastSeenVersion || '',
        iconUrl: '',
        localEnabled: null,
        remoteEnabled: Boolean(remRecord.enabled),
        mayDisable: true,
        installType: null,
        ids: mergedIds,
        storeUrls: mergedStoreUrls,
        storeInfo,
        updatedAt: remRecord.updatedAt || null
      });
      continue;
    }

    counts.missingInLocal++;
    items.push({
      status: 'missing',
      key: remKey,
      inGist: true,
      localId: null,
      name: remRecord.name || remKey,
      description: remRecord.description || '',
      version: remRecord.lastSeenVersion || '',
      iconUrl: '',
      localEnabled: null,
      remoteEnabled: Boolean(remRecord.enabled),
      mayDisable: true,
      installType: null,
      ids: mergedIds,
      storeUrls: mergedStoreUrls,
      storeInfo,
      updatedAt: remRecord.updatedAt || null
    });
  }

  // Sort items alphabetically by name
  items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return {
    browserEnv,
    counts,
    items,
    remoteUpdatedAt: remotePayload ? normalizedRemote.updatedAt : null,
    remoteUpdatedBy: remotePayload ? normalizedRemote.updatedBy : null
  };
}

/**
 * Pure function that computes the merged remote payload and the list of local enable/disable
 * actions to perform for a given sync mode ('merge', 'push', or 'pull').
 *
 * @param {object} params
 * @param {Array} params.localExtensions
 * @param {object} params.remotePayload
 * @param {object} params.browserEnv
 * @param {object} params.settings
 * @param {object} params.localMeta
 * @param {'merge' | 'push' | 'pull'} [params.mode='merge']
 * @returns {{
 *   nextPayload: object,
 *   localToggleActions: Array<{ id: string, key: string, name: string, targetEnabled: boolean }>,
 *   missingExtensions: Array<object>,
 *   remoteChanged: boolean,
 *   updatedTimestamps: Record<string, string>
 * }}
 */
export function planSyncExecution({
  localExtensions,
  remotePayload,
  browserEnv,
  settings,
  localMeta,
  mode = 'merge'
}) {
  const nowIso = new Date().toISOString();
  const normalizedRemote = normalizeSyncPayload(remotePayload);
  const existingRemoteExtensions = normalizedRemote.extensions || {};
  const nextExtensions = {};
  const matchedRemoteKeys = new Set();
  const localToggleActions = [];
  const updatedTimestamps = { ...(localMeta?.updatedAtByKey || {}) };
  let remoteChanged = false;

  for (const localExt of localExtensions) {
    if (localExt.installType === 'development' && !settings.includeDevelopmentExtensions) {
      continue;
    }
    if (!localExt.enabled && !settings.syncDisabledExtensions && mode === 'push') {
      continue;
    }

    const remoteMatch = findMatchingRemoteRecord(
      localExt,
      existingRemoteExtensions,
      browserEnv.family,
      settings.customMappings
    );
    const key = remoteMatch?.key || resolveCanonicalKey(localExt, settings.customMappings);

    if (remoteMatch) {
      matchedRemoteKeys.add(remoteMatch.key);
    }

    if (isExtensionIgnored(localExt, key, settings.ignoredKeys)) {
      continue;
    }

    const baseRecord = buildSyncRecordFromLocal(
      localExt,
      remoteMatch,
      browserEnv,
      settings,
      localMeta
    );

    if (!remoteMatch) {
      // Extension only exists locally
      if (mode === 'push' || mode === 'merge') {
        if (localExt.enabled || settings.syncDisabledExtensions) {
          baseRecord.updatedAt = updatedTimestamps[key] || nowIso;
          updatedTimestamps[key] = baseRecord.updatedAt;
          nextExtensions[key] = baseRecord;
          remoteChanged = true;
        }
      }
      continue;
    }

    // Extension exists both locally and in remote Gist
    const localState = Boolean(localExt.enabled);
    const remoteState = Boolean(remoteMatch.enabled);

    // Check if cross-browser IDs were enriched by this browser
    const prevIdsJson = JSON.stringify(remoteMatch.ids || {});
    const nextIdsJson = JSON.stringify(baseRecord.ids || {});
    if (prevIdsJson !== nextIdsJson) {
      remoteChanged = true;
    }

    if (localState === remoteState) {
      nextExtensions[key] = {
        ...remoteMatch,
        ...baseRecord,
        enabled: localState,
        updatedAt: remoteMatch.updatedAt || baseRecord.updatedAt
      };
      continue;
    }

    // State differs between local and remote!
    if (mode === 'push') {
      nextExtensions[key] = {
        ...remoteMatch,
        ...baseRecord,
        enabled: localState,
        updatedAt: nowIso
      };
      updatedTimestamps[key] = nowIso;
      remoteChanged = true;
    } else if (mode === 'pull') {
      nextExtensions[key] = {
        ...remoteMatch,
        ...baseRecord,
        enabled: remoteState,
        updatedAt: remoteMatch.updatedAt || nowIso
      };
      updatedTimestamps[key] = remoteMatch.updatedAt || nowIso;
      if (localExt.mayDisable !== false) {
        localToggleActions.push({
          id: localExt.id,
          key,
          name: localExt.name,
          targetEnabled: remoteState
        });
      }
    } else {
      // mode === 'merge': Compare timestamps
      const localTime = updatedTimestamps[key] ? Date.parse(updatedTimestamps[key]) : 0;
      const remoteTime = remoteMatch.updatedAt ? Date.parse(remoteMatch.updatedAt) : 0;

      if (localTime > remoteTime) {
        // Local change is newer -> push local state to remote
        nextExtensions[key] = {
          ...remoteMatch,
          ...baseRecord,
          enabled: localState,
          updatedAt: updatedTimestamps[key] || nowIso
        };
        remoteChanged = true;
      } else {
        // Remote change is newer (or local has no recorded change timestamp) -> apply remote state locally
        nextExtensions[key] = {
          ...remoteMatch,
          ...baseRecord,
          enabled: remoteState,
          updatedAt: remoteMatch.updatedAt || nowIso
        };
        updatedTimestamps[key] = remoteMatch.updatedAt || nowIso;
        if (localExt.mayDisable !== false) {
          localToggleActions.push({
            id: localExt.id,
            key,
            name: localExt.name,
            targetEnabled: remoteState
          });
        }
      }
    }
  }

  // Carry over remote extensions that are not installed on this browser
  const missingExtensions = [];
  for (const [remKey, remRecord] of Object.entries(existingRemoteExtensions)) {
    if (matchedRemoteKeys.has(remKey)) continue;
    if (isExtensionIgnored(remRecord, remKey, settings.ignoredKeys)) continue;

    // Even in 'push' mode, we preserve extensions installed on other browsers unless replaceRemote is explicitly requested
    nextExtensions[remKey] = remRecord;
    missingExtensions.push({
      ...remRecord,
      storeInfo: getStoreInstallInfo(remRecord, browserEnv.family, browserEnv.brand)
    });
  }

  const nextPayload = {
    app: 'extensions-cross_browser-sync',
    schemaVersion: 1,
    updatedAt: remoteChanged ? nowIso : normalizedRemote.updatedAt || nowIso,
    updatedBy: remoteChanged
      ? {
          deviceId: settings.deviceId,
          deviceName: settings.deviceName || browserEnv.label,
          browser: browserEnv.brand,
          family: browserEnv.family
        }
      : normalizedRemote.updatedBy,
    extensions: nextExtensions
  };

  return {
    nextPayload,
    localToggleActions,
    missingExtensions,
    remoteChanged,
    updatedTimestamps
  };
}

/**
 * Automatically enriches missing cross-browser IDs (`ids.chromium` and `ids.firefox`)
 * and store URLs for all extension records in a sync payload.
 *
 * @param {Record<string, object>} extensionsMap
 * @param {object} settings
 * @returns {Promise<boolean>} True if any Browser ID or Store URL was newly added/updated.
 */
export async function enrichMissingBrowserIds(extensionsMap, settings) {
  if (!extensionsMap || typeof extensionsMap !== 'object') return false;
  let changed = false;

  const entries = Object.values(extensionsMap);
  for (const rec of entries) {
    if (!rec.ids) rec.ids = {};
    if (!rec.storeUrls) rec.storeUrls = {};

    const prevSnapshot = JSON.stringify({ ids: rec.ids, storeUrls: rec.storeUrls });

    // 1. Apply manual overrides from settings.customBrowserIds
    const custom = settings?.customBrowserIds?.[rec.key];
    if (custom) {
      if (custom.chromium) rec.ids.chromium = custom.chromium;
      if (custom.firefox) rec.ids.firefox = custom.firefox;
      if (custom.chromiumUrl) rec.storeUrls.chromium = custom.chromiumUrl;
      if (custom.firefoxUrl) rec.storeUrls.firefox = custom.firefoxUrl;
    }

    // 2. Check static catalog
    const catalog = findCatalogEntry({
      key: rec.key,
      name: rec.name,
      id: rec.ids.chromium || rec.ids.firefox || rec.ids.edge
    });
    if (catalog) {
      if (!rec.ids.chromium && catalog.chromiumId) {
        rec.ids.chromium = catalog.chromiumId;
      }
      if (!rec.ids.firefox && catalog.firefoxId) {
        rec.ids.firefox = catalog.firefoxId;
      }
      if (!rec.storeUrls.chromium && rec.ids.chromium) {
        rec.storeUrls.chromium = `https://chromewebstore.google.com/detail/${rec.ids.chromium}`;
      }
      if (!rec.storeUrls.firefox && catalog.firefoxSlug) {
        rec.storeUrls.firefox = `https://addons.mozilla.org/firefox/addon/${catalog.firefoxSlug}/`;
      }
    }

    // 3. Automatically query Mozilla AMO API if Firefox ID is missing
    if (!rec.ids.firefox) {
      const amo = await resolveFirefoxAddonFromAmo(rec);
      if (amo?.firefoxId) {
        rec.ids.firefox = amo.firefoxId;
        if (amo.firefoxUrl) {
          rec.storeUrls.firefox = amo.firefoxUrl;
        }
      }
    }

    // 4. Automatically query Chrome Web Store if Chromium ID is missing
    if (!rec.ids.chromium) {
      const cws = await resolveChromiumExtensionFromStore(rec);
      if (cws?.chromiumId) {
        rec.ids.chromium = cws.chromiumId;
        if (cws.chromiumUrl) {
          rec.storeUrls.chromium = cws.chromiumUrl;
        }
      }
    }

    const nextSnapshot = JSON.stringify({ ids: rec.ids, storeUrls: rec.storeUrls });
    if (prevSnapshot !== nextSnapshot) {
      changed = true;
    }
  }

  return changed;
}

/**
 * Saves manual Browser ID overrides (`chromium` and/or `firefox`) for a canonical extension key,
 * resolving store URLs if pasted, and updates the cached remote payload.
 *
 * @param {{ key: string, chromiumInput?: string, firefoxInput?: string }} params
 */
export async function saveManualBrowserIds({ key, chromiumInput, firefoxInput }) {
  if (!key) throw new Error('Extension key is required.');

  const settings = await getSettings();
  const customBrowserIds = { ...(settings.customBrowserIds || {}) };
  const existing = customBrowserIds[key] || {};

  const nextEntry = { ...existing };

  if (typeof chromiumInput === 'string') {
    const parsedCr = await parseAndResolveManualBrowserId(chromiumInput, 'chromium');
    if (parsedCr.id) {
      nextEntry.chromium = parsedCr.id;
      if (parsedCr.storeUrl) nextEntry.chromiumUrl = parsedCr.storeUrl;
    } else {
      delete nextEntry.chromium;
      delete nextEntry.chromiumUrl;
    }
  }

  if (typeof firefoxInput === 'string') {
    const parsedFf = await parseAndResolveManualBrowserId(firefoxInput, 'firefox');
    if (parsedFf.id) {
      nextEntry.firefox = parsedFf.id;
      if (parsedFf.storeUrl) nextEntry.firefoxUrl = parsedFf.storeUrl;
    } else {
      delete nextEntry.firefox;
      delete nextEntry.firefoxUrl;
    }
  }

  customBrowserIds[key] = nextEntry;
  await saveSettings({ customBrowserIds });

  // Also update remote cache if present so UI and Gist sync reflect it immediately
  const cached = await getRemoteCache();
  if (cached?.extensions?.[key]) {
    const rec = cached.extensions[key];
    rec.ids = { ...(rec.ids || {}) };
    rec.storeUrls = { ...(rec.storeUrls || {}) };

    if (nextEntry.chromium) {
      rec.ids.chromium = nextEntry.chromium;
      if (nextEntry.chromiumUrl) rec.storeUrls.chromium = nextEntry.chromiumUrl;
    }
    if (nextEntry.firefox) {
      rec.ids.firefox = nextEntry.firefox;
      if (nextEntry.firefoxUrl) rec.storeUrls.firefox = nextEntry.firefoxUrl;
    }
    await saveRemoteCache(cached);
  }

  return nextEntry;
}

/**
 * Executes a full sync operation ('merge', 'push', or 'pull') with GitHub Gist.
 *
 * @param {{ mode?: 'merge' | 'push' | 'pull' }} [options]
 */
export async function performSync(options = {}) {
  const mode = options.mode || 'merge';
  const settings = await getSettings();
  const localMeta = await getLocalMeta();
  const browserEnv = detectBrowserEnvironment();

  if (!settings.githubToken || !settings.gistId) {
    throw new Error(
      'GitHub Token and Gist ID are required. Open Sync Settings to connect your GitHub Gist.'
    );
  }

  try {
    // 1. Fetch remote Gist state and local installed extensions
    const [{ payload: remotePayload }, localExtensions] = await Promise.all([
      fetchSyncGist(settings.githubToken, settings.gistId),
      getInstalledExtensions()
    ]);

    // 2. Compute sync plan
    const plan = planSyncExecution({
      localExtensions,
      remotePayload,
      browserEnv,
      settings,
      localMeta,
      mode
    });

    // 3. Automatically resolve & update any missing Chromium or Firefox Browser IDs across all extensions
    const idsEnriched = await enrichMissingBrowserIds(
      plan.nextPayload.extensions,
      settings
    );
    if (idsEnriched) {
      plan.remoteChanged = true;
    }

    // 4. Apply local enable/disable state changes if allowed
    const appliedToggles = [];
    if (settings.autoApplyEnabledState && plan.localToggleActions.length > 0) {
      isApplyingRemoteState = true;
      try {
        for (const action of plan.localToggleActions) {
          try {
            await setExtensionEnabled(action.id, action.targetEnabled);
            appliedToggles.push(action);
          } catch (err) {
            console.warn(`Failed to toggle extension ${action.name} (${action.id}):`, err);
          }
        }
      } finally {
        // Delay clearing flag slightly so asynchronous onEnabled/onDisabled events settle
        setTimeout(() => {
          isApplyingRemoteState = false;
        }, 500);
      }
    }

    // 5. Push updated payload to Gist if remoteChanged or mode === 'push'
    let finalPayload = plan.nextPayload;
    if (plan.remoteChanged || mode === 'push') {
      await updateSyncGist(settings.githubToken, settings.gistId, finalPayload);
    }

    // 6. Persist cache, timestamps, and sync log
    await saveRemoteCache(finalPayload);
    const summary = {
      mode,
      totalSynced: Object.keys(finalPayload.extensions).length,
      toggledLocally: appliedToggles.length,
      missingCount: plan.missingExtensions.length,
      remoteUpdated: plan.remoteChanged || mode === 'push'
    };

    await saveLocalMeta({
      updatedAtByKey: plan.updatedTimestamps,
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: 'success',
      lastSyncError: null,
      lastSyncSummary: summary
    });

    await appendSyncLog({
      status: 'success',
      mode,
      message: `Synced ${summary.totalSynced} extensions (${summary.toggledLocally} toggled locally, ${summary.missingCount} missing on this browser).`
    });

    return {
      ok: true,
      summary,
      payload: finalPayload
    };
  } catch (error) {
    const errMsg = error?.message || String(error);
    await saveLocalMeta({
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: 'error',
      lastSyncError: errMsg
    });
    await appendSyncLog({
      status: 'error',
      mode,
      message: errMsg
    });
    throw error;
  }
}

/**
 * Returns the current live dashboard state combining local extensions and cached (or fresh) remote Gist payload.
 * @param {{ refreshRemote?: boolean }} [options]
 */
export async function getDashboardState(options = {}) {
  const settings = await getSettings();
  const localMeta = await getLocalMeta();
  const browserEnv = detectBrowserEnvironment();
  const localExtensions = await getInstalledExtensions();

  let remotePayload = await getRemoteCache();
  let remoteError = null;

  if (options.refreshRemote && settings.githubToken && settings.gistId) {
    try {
      const fetched = await fetchSyncGist(settings.githubToken, settings.gistId);
      remotePayload = fetched.payload;
      await saveRemoteCache(remotePayload);
    } catch (err) {
      remoteError = err?.message || String(err);
    }
  }

  const comparison = computeSyncComparison({
    localExtensions,
    remotePayload: remotePayload || createEmptySyncPayload(),
    browserEnv,
    settings,
    localMeta
  });

  return {
    settings,
    localMeta,
    browserEnv,
    hasGistConfigured: Boolean(settings.githubToken && settings.gistId),
    hasRemoteCache: Boolean(remotePayload),
    remoteError,
    comparison
  };
}

/**
 * Resolves any missing Chromium or Firefox Browser IDs and Store URLs for Dashboard items
 * (including local-only extensions) via Mozilla AMO and Chrome Web Store, and caches them in settings.
 *
 * @param {Array<object>} items
 * @returns {Promise<boolean>} True if any new ID or store URL was resolved
 */
export async function enrichDashboardItemsIds(items = []) {
  if (!Array.isArray(items) || items.length === 0) return false;

  const settings = await getSettings();
  const customBrowserIds = { ...(settings.customBrowserIds || {}) };
  const cached = await getRemoteCache();
  let changed = false;

  for (const item of items) {
    if (!item?.key || item.status === 'ignored') continue;

    const hasCr = Boolean(item.ids?.chromium);
    const hasFf = Boolean(item.ids?.firefox);
    if (hasCr && hasFf) continue;

    const existing = { ...(customBrowserIds[item.key] || {}) };
    let itemChanged = false;

    if (!hasFf && !existing.firefox) {
      const amo = await resolveFirefoxAddonFromAmo(item);
      if (amo?.firefoxId) {
        existing.firefox = amo.firefoxId;
        if (amo.firefoxUrl) existing.firefoxUrl = amo.firefoxUrl;
        itemChanged = true;
      }
    }

    if (!hasCr && !existing.chromium) {
      const cws = await resolveChromiumExtensionFromStore(item);
      if (cws?.chromiumId) {
        existing.chromium = cws.chromiumId;
        if (cws.chromiumUrl) existing.chromiumUrl = cws.chromiumUrl;
        itemChanged = true;
      }
    }

    if (itemChanged) {
      customBrowserIds[item.key] = existing;
      changed = true;

      if (cached?.extensions?.[item.key]) {
        const rec = cached.extensions[item.key];
        rec.ids = { ...(rec.ids || {}) };
        rec.storeUrls = { ...(rec.storeUrls || {}) };
        if (existing.chromium) rec.ids.chromium = existing.chromium;
        if (existing.firefox) rec.ids.firefox = existing.firefox;
        if (existing.chromiumUrl) rec.storeUrls.chromium = existing.chromiumUrl;
        if (existing.firefoxUrl) rec.storeUrls.firefox = existing.firefoxUrl;
      }
    }
  }

  if (changed) {
    await saveSettings({ customBrowserIds });
    if (cached) {
      await saveRemoteCache(cached);
    }
  }

  return changed;
}

/**
 * Builds a complete initial sync payload from the currently installed extensions.
 * Used when creating a brand new Gist or exporting to JSON.
 */
export async function buildInitialPayloadFromLocal() {
  const settings = await getSettings();
  const localMeta = await getLocalMeta();
  const browserEnv = detectBrowserEnvironment();
  const localExtensions = await getInstalledExtensions();

  const plan = planSyncExecution({
    localExtensions,
    remotePayload: createEmptySyncPayload(),
    browserEnv,
    settings,
    localMeta,
    mode: 'push'
  });

  await enrichMissingBrowserIds(plan.nextPayload.extensions, settings);

  return plan.nextPayload;
}

/**
 * Clears all saved extension data from the remote GitHub Gist and resets the local remote cache.
 *
 * @param {{ token?: string, gistId?: string }} [overrides]
 */
export async function clearGistData(overrides = {}) {
  const settings = await getSettings();
  const browserEnv = detectBrowserEnvironment();
  const token = (overrides.token || settings.githubToken || '').trim();
  const gistId = (overrides.gistId || settings.gistId || '').trim();

  if (!token || !gistId) {
    throw new Error(
      'GitHub Token and Gist ID are required to clear Gist data.'
    );
  }

  const emptyPayload = {
    ...createEmptySyncPayload(),
    updatedAt: new Date().toISOString(),
    updatedBy: {
      deviceId: settings.deviceId,
      deviceName: settings.deviceName || browserEnv.label,
      browser: browserEnv.brand,
      family: browserEnv.family
    },
    extensions: {}
  };

  try {
    await updateSyncGist(token, gistId, emptyPayload);
    await saveRemoteCache(emptyPayload);
    await saveLocalMeta({
      updatedAtByKey: {},
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: 'success',
      lastSyncError: null,
      lastSyncSummary: {
        mode: 'clear',
        totalSynced: 0,
        toggledLocally: 0,
        missingCount: 0,
        remoteUpdated: true
      }
    });
    await appendSyncLog({
      status: 'success',
      mode: 'clear',
      message: 'Cleared all saved extension data from GitHub Gist.'
    });

    return { ok: true, payload: emptyPayload };
  } catch (error) {
    const errMsg = error?.message || String(error);
    await appendSyncLog({
      status: 'error',
      mode: 'clear',
      message: `Failed to clear Gist: ${errMsg}`
    });
    throw error;
  }
}

/**
 * Removes a single extension entry from the remote GitHub Gist and updates the local remote cache.
 *
 * @param {{ key: string, name?: string }} params
 */
export async function removeExtensionFromGist({ key, name }) {
  if (!key) {
    throw new Error('Extension key is required to remove from Gist.');
  }

  const settings = await getSettings();
  const browserEnv = detectBrowserEnvironment();
  const token = (settings.githubToken || '').trim();
  const gistId = (settings.gistId || '').trim();

  let payload = null;
  if (token && gistId) {
    const fetched = await fetchSyncGist(token, gistId);
    payload = fetched.payload;
  } else {
    payload = (await getRemoteCache()) || createEmptySyncPayload();
  }

  const nextExtensions = { ...(payload.extensions || {}) };
  delete nextExtensions[key];

  const updatedPayload = {
    ...payload,
    updatedAt: new Date().toISOString(),
    updatedBy: {
      deviceId: settings.deviceId,
      deviceName: settings.deviceName || browserEnv.label,
      browser: browserEnv.brand,
      family: browserEnv.family
    },
    extensions: nextExtensions
  };

  if (token && gistId) {
    await updateSyncGist(token, gistId, updatedPayload);
  }

  await saveRemoteCache(updatedPayload);
  await appendSyncLog({
    status: 'success',
    mode: 'remove',
    message: `Removed "${name || key}" from GitHub Gist.`
  });

  return { ok: true, payload: updatedPayload };
}




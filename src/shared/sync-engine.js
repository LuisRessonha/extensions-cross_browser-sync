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
  resolveCanonicalKey,
  resolveFirefoxAddonFromAmo
} from './matcher.js';
import {
  appendSyncLog,
  getLocalMeta,
  getRemoteCache,
  getSettings,
  saveLocalMeta,
  saveRemoteCache,
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
  const ids = { ...prevIds };

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

  const storeUrls = { ...(existingRemote?.storeUrls || {}) };
  if (ids.chromium && isChromiumExtensionId(ids.chromium)) {
    storeUrls.chromium = `https://chromewebstore.google.com/detail/${ids.chromium}`;
  }
  if (catalog?.firefoxSlug) {
    storeUrls.firefox = `https://addons.mozilla.org/firefox/addon/${catalog.firefoxSlug}/`;
  } else if (ids.firefox && !storeUrls.firefox) {
    storeUrls.firefox = `https://addons.mozilla.org/firefox/addon/${encodeURIComponent(ids.firefox)}/`;
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
        storeInfo,
        updatedAt: remoteMatch.updatedAt || enrichedRecord.updatedAt
      });
    } else {
      counts.localOnly++;
      items.push({
        status: 'local-only',
        key,
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
        storeInfo,
        updatedAt: enrichedRecord.updatedAt
      });
    }
  }

  // Now check remote extensions that are NOT installed locally
  for (const [remKey, remRecord] of Object.entries(remoteMap)) {
    if (matchedRemoteKeys.has(remKey)) continue;

    const ignored = isExtensionIgnored(remRecord, remKey, settings.ignoredKeys);
    const storeInfo = getStoreInstallInfo(remRecord, browserEnv.family, browserEnv.brand);

    if (ignored) {
      counts.ignored++;
      items.push({
        status: 'ignored',
        key: remKey,
        localId: null,
        name: remRecord.name || remKey,
        description: remRecord.description || '',
        version: remRecord.lastSeenVersion || '',
        iconUrl: '',
        localEnabled: null,
        remoteEnabled: Boolean(remRecord.enabled),
        mayDisable: true,
        installType: null,
        ids: remRecord.ids || {},
        storeInfo,
        updatedAt: remRecord.updatedAt || null
      });
      continue;
    }

    counts.missingInLocal++;
    items.push({
      status: 'missing',
      key: remKey,
      localId: null,
      name: remRecord.name || remKey,
      description: remRecord.description || '',
      version: remRecord.lastSeenVersion || '',
      iconUrl: '',
      localEnabled: null,
      remoteEnabled: Boolean(remRecord.enabled),
      mayDisable: true,
      installType: null,
      ids: remRecord.ids || {},
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

    // 3. Optionally enrich Firefox AMO store URLs for newly pushed Chromium extensions
    if (plan.remoteChanged && browserEnv.family === 'chromium') {
      const entries = Object.values(plan.nextPayload.extensions);
      for (const rec of entries) {
        if (!rec.storeUrls?.firefox && !rec.ids?.firefox) {
          const amo = await resolveFirefoxAddonFromAmo(rec);
          if (amo) {
            rec.ids.firefox = amo.firefoxId;
            rec.storeUrls.firefox = amo.firefoxUrl;
          }
        }
      }
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

  return plan.nextPayload;
}


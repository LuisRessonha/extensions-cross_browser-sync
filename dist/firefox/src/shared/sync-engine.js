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
  DEFAULT_GROUPS,
  appendSyncLog,
  getLocalMeta,
  getRemoteCache,
  getSettings,
  normalizeExtensionGroupsList,
  normalizeGroupsMap,
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

  const equivalentAlternative = Boolean(
    customIds?.equivalentAlternative ??
      existingRemote?.equivalentAlternative ??
      catalog?.equivalentAlternative
  );
  const alternativeName =
    customIds?.alternativeName ||
    existingRemote?.alternativeName ||
    catalog?.alternativeName ||
    '';

  const groupsMap = normalizeGroupsMap({
    ...(existingRemote?.groupsMap || {}),
    ...(settings?.groups || {})
  });
  const localAssignedGroups = settings?.extensionGroups?.[key];
  const rawGroups =
    Array.isArray(localAssignedGroups) && localAssignedGroups.length > 0
      ? localAssignedGroups
      : Array.isArray(existingRemote?.groups) && existingRemote.groups.length > 0
      ? existingRemote.groups
      : ['default'];
  const groups = normalizeExtensionGroupsList(rawGroups, groupsMap);

  return {
    key,
    name: localExt.name || existingRemote?.name || key,
    description: localExt.description || existingRemote?.description || '',
    homepageUrl: localExt.homepageUrl || existingRemote?.homepageUrl || '',
    enabled: Boolean(localExt.enabled),
    updatedAt,
    lastSeenVersion: localExt.version || existingRemote?.lastSeenVersion || '',
    groups,
    ids,
    storeUrls,
    ...(equivalentAlternative ? { equivalentAlternative: true } : {}),
    ...(alternativeName ? { alternativeName } : {})
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
  const effectiveIgnoredKeys = Array.from(
    new Set([...(settings.ignoredKeys || []), ...(normalizedRemote.ignoredKeys || [])])
  );
  const mergedGroups = normalizeGroupsMap({
    ...(normalizedRemote.groups || {}),
    ...(settings.groups || {})
  });
  const effectiveSettings = {
    ...settings,
    groups: mergedGroups
  };
  const activeGroupIds = Array.isArray(settings.activeGroupIds)
    ? settings.activeGroupIds.filter((id) => id && id !== 'default' && Boolean(mergedGroups[id]))
    : [];

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
    const ignored =
      Boolean(remoteMatch?.ignored) ||
      isExtensionIgnored(localExt, key, effectiveIgnoredKeys);

    if (remoteMatch) {
      matchedRemoteKeys.add(remoteMatch.key);
    }

    const enrichedRecord = buildSyncRecordFromLocal(
      localExt,
      remoteMatch,
      browserEnv,
      effectiveSettings,
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
        groups: enrichedRecord.groups,
        ids: enrichedRecord.ids,
        storeUrls: enrichedRecord.storeUrls,
        storeInfo,
        equivalentAlternative: Boolean(enrichedRecord.equivalentAlternative),
        alternativeName: enrichedRecord.alternativeName || '',
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
        groups: enrichedRecord.groups,
        ids: enrichedRecord.ids,
        storeUrls: enrichedRecord.storeUrls,
        storeInfo,
        equivalentAlternative: Boolean(enrichedRecord.equivalentAlternative),
        alternativeName: enrichedRecord.alternativeName || '',
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
        groups: enrichedRecord.groups,
        ids: enrichedRecord.ids,
        storeUrls: enrichedRecord.storeUrls,
        storeInfo,
        equivalentAlternative: Boolean(enrichedRecord.equivalentAlternative),
        alternativeName: enrichedRecord.alternativeName || '',
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

    const equivalentAlternative = Boolean(
      customIds?.equivalentAlternative ??
        remRecord?.equivalentAlternative ??
        catalog?.equivalentAlternative
    );
    const alternativeName =
      customIds?.alternativeName ||
      remRecord?.alternativeName ||
      catalog?.alternativeName ||
      '';

    const itemGroups = normalizeExtensionGroupsList(
      settings?.extensionGroups?.[remKey] || remRecord.groups,
      mergedGroups
    );

    const mergedRecord = {
      ...remRecord,
      groups: itemGroups,
      ids: mergedIds,
      storeUrls: mergedStoreUrls,
      ...(equivalentAlternative ? { equivalentAlternative: true } : {}),
      ...(alternativeName ? { alternativeName } : {})
    };

    const ignored =
      Boolean(remRecord?.ignored) ||
      isExtensionIgnored(mergedRecord, remKey, effectiveIgnoredKeys);
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
        groups: itemGroups,
        ids: mergedIds,
        storeUrls: mergedStoreUrls,
        storeInfo,
        equivalentAlternative,
        alternativeName,
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
      groups: itemGroups,
      ids: mergedIds,
      storeUrls: mergedStoreUrls,
      storeInfo,
      equivalentAlternative,
      alternativeName,
      updatedAt: remRecord.updatedAt || null
    });
  }

  // Sort items alphabetically by name
  items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return {
    browserEnv,
    counts,
    items,
    groups: mergedGroups,
    activeGroupIds,
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

  const nextGroups =
    mode === 'push'
      ? normalizeGroupsMap(settings.groups)
      : mode === 'pull'
      ? normalizeGroupsMap({ ...(settings.groups || {}), ...(normalizedRemote.groups || {}) })
      : normalizeGroupsMap({ ...(normalizedRemote.groups || {}), ...(settings.groups || {}) });

  const effectiveSettings = {
    ...settings,
    groups: nextGroups
  };

  if (JSON.stringify(normalizedRemote.groups || {}) !== JSON.stringify(nextGroups)) {
    remoteChanged = true;
  }

  const effectiveIgnoredKeys =
    mode === 'push'
      ? Array.from(new Set(settings.ignoredKeys || []))
      : mode === 'pull'
      ? Array.from(new Set(normalizedRemote.ignoredKeys || []))
      : Array.from(
          new Set([...(normalizedRemote.ignoredKeys || []), ...(settings.ignoredKeys || [])])
        );

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

    const baseRecord = buildSyncRecordFromLocal(
      localExt,
      remoteMatch,
      browserEnv,
      effectiveSettings,
      localMeta
    );

    if (remoteMatch && mode === 'pull' && Array.isArray(remoteMatch.groups)) {
      baseRecord.groups = normalizeExtensionGroupsList(remoteMatch.groups, nextGroups);
    } else if (remoteMatch && mode === 'merge') {
      const localTime = updatedTimestamps[key] ? Date.parse(updatedTimestamps[key]) : 0;
      const remoteTime = remoteMatch.updatedAt ? Date.parse(remoteMatch.updatedAt) : 0;
      const hasLocalExplicit = Array.isArray(settings?.extensionGroups?.[key]);
      if (
        remoteTime > localTime &&
        Array.isArray(remoteMatch.groups) &&
        remoteMatch.groups.length > 0 &&
        !(
          remoteMatch.groups.length === 1 &&
          remoteMatch.groups[0] === 'default' &&
          hasLocalExplicit
        )
      ) {
        baseRecord.groups = normalizeExtensionGroupsList(remoteMatch.groups, nextGroups);
      }
    }

    const isIgnored =
      (mode === 'pull' && Boolean(remoteMatch?.ignored)) ||
      isExtensionIgnored(localExt, key, effectiveIgnoredKeys);

    if (isIgnored) {
      // Keep ignored extensions tracked in Gist with `ignored: true`, but exclude from active sync actions
      const ignoredRecord = {
        ...(remoteMatch || {}),
        ...baseRecord,
        ignored: true,
        updatedAt: remoteMatch?.updatedAt || baseRecord.updatedAt
      };
      nextExtensions[key] = ignoredRecord;
      if (!remoteMatch || !remoteMatch.ignored) {
        remoteChanged = true;
      }
      continue;
    }

    baseRecord.ignored = false;
    if (remoteMatch?.ignored) {
      remoteChanged = true;
    }

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

    // Check if cross-browser IDs or groups were enriched/updated by this browser
    const prevIdsJson = JSON.stringify(remoteMatch.ids || {});
    const nextIdsJson = JSON.stringify(baseRecord.ids || {});
    const prevGroupsJson = JSON.stringify(
      normalizeExtensionGroupsList(remoteMatch.groups, nextGroups)
    );
    const nextGroupsJson = JSON.stringify(baseRecord.groups || ['default']);
    if (prevIdsJson !== nextIdsJson || prevGroupsJson !== nextGroupsJson) {
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

    const isIgnored =
      (mode !== 'push' && Boolean(remRecord?.ignored)) ||
      isExtensionIgnored(remRecord, remKey, effectiveIgnoredKeys);

    if (Boolean(remRecord.ignored) !== isIgnored) {
      remoteChanged = true;
    }

    const remGroups = normalizeExtensionGroupsList(
      mode === 'push'
        ? settings?.extensionGroups?.[remKey] || remRecord.groups
        : remRecord.groups || settings?.extensionGroups?.[remKey],
      nextGroups
    );
    if (
      JSON.stringify(normalizeExtensionGroupsList(remRecord.groups, nextGroups)) !==
      JSON.stringify(remGroups)
    ) {
      remoteChanged = true;
    }

    // Even in 'push' mode, we preserve extensions installed on other browsers unless replaceRemote is explicitly requested
    nextExtensions[remKey] = {
      ...remRecord,
      groups: remGroups,
      ignored: isIgnored
    };

    if (isIgnored) continue;

    missingExtensions.push({
      ...remRecord,
      groups: remGroups,
      storeInfo: getStoreInstallInfo(remRecord, browserEnv.family, browserEnv.brand)
    });
  }

  const finalIgnoredSet = new Set(effectiveIgnoredKeys);
  for (const [k, rec] of Object.entries(nextExtensions)) {
    if (rec?.ignored) {
      finalIgnoredSet.add(k);
    } else {
      finalIgnoredSet.delete(k);
    }
  }
  const finalIgnoredKeys = Array.from(finalIgnoredSet);
  if (JSON.stringify(normalizedRemote.ignoredKeys || []) !== JSON.stringify(finalIgnoredKeys)) {
    remoteChanged = true;
  }

  const syncActiveToGist = settings.syncActiveGroupsToGist !== false;
  let nextActiveGroupIds = normalizedRemote.activeGroupIds || [];
  if (syncActiveToGist) {
    if (mode === 'push') {
      nextActiveGroupIds = Array.isArray(settings.activeGroupIds) ? settings.activeGroupIds : [];
    } else if (mode === 'pull') {
      nextActiveGroupIds = Array.isArray(normalizedRemote.activeGroupIds)
        ? normalizedRemote.activeGroupIds
        : [];
    } else {
      const localActive = Array.isArray(settings.activeGroupIds) ? settings.activeGroupIds : [];
      const remoteActive = Array.isArray(normalizedRemote.activeGroupIds)
        ? normalizedRemote.activeGroupIds
        : [];
      nextActiveGroupIds = localActive.length > 0 ? localActive : remoteActive;
    }
    nextActiveGroupIds = nextActiveGroupIds.filter(
      (id) => id && id !== 'default' && Boolean(nextGroups[id])
    );
    if (
      JSON.stringify(normalizedRemote.activeGroupIds || []) !== JSON.stringify(nextActiveGroupIds)
    ) {
      remoteChanged = true;
    }
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
    groups: nextGroups,
    activeGroupIds: nextActiveGroupIds,
    ignoredKeys: finalIgnoredKeys,
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
      if (custom.equivalentAlternative) {
        rec.equivalentAlternative = true;
      }
      if (custom.alternativeName) {
        rec.alternativeName = custom.alternativeName;
      }
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
 * @param {{ key: string, chromiumInput?: string, firefoxInput?: string, equivalentAlternative?: boolean, alternativeName?: string }} params
 */
export async function saveManualBrowserIds({
  key,
  chromiumInput,
  firefoxInput,
  equivalentAlternative,
  alternativeName
}) {
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

  if (typeof equivalentAlternative === 'boolean') {
    if (equivalentAlternative) {
      nextEntry.equivalentAlternative = true;
    } else {
      delete nextEntry.equivalentAlternative;
      delete nextEntry.alternativeName;
    }
  }
  if (typeof alternativeName === 'string') {
    const trimmedAlt = alternativeName.trim();
    if (trimmedAlt && nextEntry.equivalentAlternative) {
      nextEntry.alternativeName = trimmedAlt;
    } else if (!trimmedAlt) {
      delete nextEntry.alternativeName;
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
    if (nextEntry.equivalentAlternative) {
      rec.equivalentAlternative = true;
      if (nextEntry.alternativeName) {
        rec.alternativeName = nextEntry.alternativeName;
      }
    } else {
      delete rec.equivalentAlternative;
      delete rec.alternativeName;
    }
    await saveRemoteCache(cached);
  }

  return nextEntry;
}

/**
 * Matches an extension with an equivalent alternative on the counterpart browser store
 * (or merges it with another extension entry) and flags it as `equivalentAlternative: true`
 * both locally and in the GitHub Gist.
 *
 * @param {{
 *   key: string,
 *   targetFamily?: 'chromium' | 'firefox',
 *   alternativeInput?: string,
 *   alternativeName?: string,
 *   mergeSourceKey?: string,
 *   mergeSourceLocalId?: string,
 *   clearAlternative?: boolean
 * }} params
 */
export async function saveEquivalentAlternative({
  key,
  targetFamily,
  alternativeInput,
  alternativeName,
  mergeSourceKey,
  mergeSourceLocalId,
  clearAlternative = false
}) {
  if (!key) throw new Error('Extension key is required.');

  const settings = await getSettings();
  const localMeta = await getLocalMeta();
  const browserEnv = detectBrowserEnvironment();
  const localExtensions = await getInstalledExtensions();

  const customBrowserIds = { ...(settings.customBrowserIds || {}) };
  const customMappings = { ...(settings.customMappings || {}) };
  const existing = { ...(customBrowserIds[key] || {}) };

  const cached = (await getRemoteCache()) || createEmptySyncPayload();
  const nextExtensions = { ...(cached.extensions || {}) };

  if (clearAlternative) {
    delete existing.equivalentAlternative;
    delete existing.alternativeName;
    customBrowserIds[key] = existing;
    await saveSettings({ customBrowserIds });

    if (nextExtensions[key]) {
      const rec = { ...nextExtensions[key] };
      delete rec.equivalentAlternative;
      delete rec.alternativeName;
      rec.updatedAt = new Date().toISOString();
      nextExtensions[key] = rec;
    }
  } else {
    const family = targetFamily === 'chromium' ? 'chromium' : 'firefox';
    const rawInput = (alternativeInput || '').trim();
    if (!rawInput) {
      throw new Error(
        `Please enter or select an equivalent ${
          family === 'chromium' ? 'Chrome Web Store' : 'Firefox Add-ons'
        } ID or URL.`
      );
    }

    const parsed = await parseAndResolveManualBrowserId(rawInput, family);
    if (!parsed.id) {
      throw new Error('Could not resolve a valid extension ID from the provided input.');
    }

    existing[family] = parsed.id;
    if (parsed.storeUrl) {
      existing[`${family}Url`] = parsed.storeUrl;
    }
    existing.equivalentAlternative = true;
    const resolvedAltName = (alternativeName || parsed.name || '').trim();
    if (resolvedAltName) {
      existing.alternativeName = resolvedAltName;
    }

    if (mergeSourceLocalId) {
      customMappings[mergeSourceLocalId] = key;
    }
    // Also map the resolved ID to `key` so when that alternative extension is installed locally it automatically pairs with `key`
    customMappings[parsed.id] = key;

    customBrowserIds[key] = existing;
    await saveSettings({ customBrowserIds, customMappings });

    let baseRec = nextExtensions[key];
    if (!baseRec) {
      const localMatch = localExtensions.find(
        (extItem) => resolveCanonicalKey(extItem, customMappings) === key
      );
      if (localMatch) {
        baseRec = buildSyncRecordFromLocal(
          localMatch,
          null,
          browserEnv,
          { ...settings, customBrowserIds, customMappings },
          localMeta
        );
      } else {
        baseRec = {
          key,
          name: resolvedAltName || key,
          description: '',
          homepageUrl: '',
          enabled: true,
          updatedAt: new Date().toISOString(),
          lastSeenVersion: '',
          ids: {},
          storeUrls: {}
        };
      }
    }

    const mergedIds = {
      ...(baseRec.ids || {}),
      [family]: parsed.id
    };
    const mergedStoreUrls = {
      ...(baseRec.storeUrls || {}),
      ...(parsed.storeUrl ? { [family]: parsed.storeUrl } : {})
    };

    if (mergeSourceKey && mergeSourceKey !== key && nextExtensions[mergeSourceKey]) {
      const srcRec = nextExtensions[mergeSourceKey];
      if (srcRec.ids?.chromium && !mergedIds.chromium) mergedIds.chromium = srcRec.ids.chromium;
      if (srcRec.ids?.firefox && !mergedIds.firefox) mergedIds.firefox = srcRec.ids.firefox;
      if (srcRec.ids?.edge && !mergedIds.edge) mergedIds.edge = srcRec.ids.edge;
      if (srcRec.storeUrls?.chromium && !mergedStoreUrls.chromium) {
        mergedStoreUrls.chromium = srcRec.storeUrls.chromium;
      }
      if (srcRec.storeUrls?.firefox && !mergedStoreUrls.firefox) {
        mergedStoreUrls.firefox = srcRec.storeUrls.firefox;
      }
      delete nextExtensions[mergeSourceKey];
    }

    nextExtensions[key] = {
      ...baseRec,
      ids: mergedIds,
      storeUrls: mergedStoreUrls,
      equivalentAlternative: true,
      ...(resolvedAltName ? { alternativeName: resolvedAltName } : {}),
      updatedAt: new Date().toISOString()
    };
  }

  const nextPayload = {
    ...normalizeSyncPayload(cached),
    updatedAt: new Date().toISOString(),
    updatedBy: {
      deviceId: settings.deviceId,
      deviceName: settings.deviceName || browserEnv.label,
      browser: browserEnv.brand,
      family: browserEnv.family
    },
    extensions: nextExtensions
  };

  await saveRemoteCache(nextPayload);

  const token = (settings.githubToken || '').trim();
  const gistId = (settings.gistId || '').trim();
  if (token && gistId) {
    try {
      await updateSyncGist(token, gistId, nextPayload);
    } catch (err) {
      console.warn('Failed to push equivalent alternative update to Gist:', err);
    }
  }

  return customBrowserIds[key];
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

    // 6. Persist cache, synced ignoredKeys, groups, timestamps, and sync log
    await saveRemoteCache(finalPayload);
    const nextSettingsPatch = {};
    if (Array.isArray(finalPayload.ignoredKeys)) {
      nextSettingsPatch.ignoredKeys = finalPayload.ignoredKeys;
    }
    if (finalPayload.groups && typeof finalPayload.groups === 'object') {
      nextSettingsPatch.groups = normalizeGroupsMap(finalPayload.groups);
    }
    if (finalPayload.extensions && typeof finalPayload.extensions === 'object') {
      const mergedExtGroups = { ...(settings.extensionGroups || {}) };
      for (const [k, rec] of Object.entries(finalPayload.extensions)) {
        if (Array.isArray(rec?.groups) && rec.groups.length > 0) {
          mergedExtGroups[k] = normalizeExtensionGroupsList(rec.groups, nextSettingsPatch.groups);
        }
      }
      nextSettingsPatch.extensionGroups = mergedExtGroups;
    }
    if (settings.syncActiveGroupsToGist !== false && Array.isArray(finalPayload.activeGroupIds)) {
      nextSettingsPatch.activeGroupIds = finalPayload.activeGroupIds;
    }
    if (Object.keys(nextSettingsPatch).length > 0) {
      await saveSettings(nextSettingsPatch);
    }
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
  const nextIgnoredKeys = (payload.ignoredKeys || []).filter((k) => k !== key);

  const updatedPayload = {
    ...payload,
    updatedAt: new Date().toISOString(),
    updatedBy: {
      deviceId: settings.deviceId,
      deviceName: settings.deviceName || browserEnv.label,
      browser: browserEnv.brand,
      family: browserEnv.family
    },
    ignoredKeys: nextIgnoredKeys,
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

/**
 * Toggles the ignored status of an extension key locally and updates the Gist & remote cache
 * so ignored extensions are tracked across browsers in the Gist.
 *
 * @param {string} key
 */
export async function toggleIgnoreKeyAndSync(key) {
  if (!key) throw new Error('Extension key is required.');

  const settings = await getSettings();
  const localMeta = await getLocalMeta();
  const browserEnv = detectBrowserEnvironment();
  const localExtensions = await getInstalledExtensions();
  const cached = (await getRemoteCache()) || createEmptySyncPayload();

  const ignoredSet = new Set([
    ...(settings.ignoredKeys || []),
    ...(cached.ignoredKeys || [])
  ]);

  const isNowIgnored = !ignoredSet.has(key);
  if (isNowIgnored) {
    ignoredSet.add(key);
  } else {
    ignoredSet.delete(key);
  }

  const nextIgnoredKeys = Array.from(ignoredSet);
  const updatedSettings = await saveSettings({ ignoredKeys: nextIgnoredKeys });

  const nextExtensions = { ...(cached.extensions || {}) };
  if (nextExtensions[key]) {
    nextExtensions[key] = {
      ...nextExtensions[key],
      ignored: isNowIgnored,
      updatedAt: new Date().toISOString()
    };
  } else {
    const localMatch = localExtensions.find(
      (extItem) => resolveCanonicalKey(extItem, updatedSettings.customMappings) === key
    );
    if (localMatch) {
      const rec = buildSyncRecordFromLocal(
        localMatch,
        null,
        browserEnv,
        updatedSettings,
        localMeta
      );
      rec.ignored = isNowIgnored;
      nextExtensions[key] = rec;
    }
  }

  const nextPayload = {
    ...normalizeSyncPayload(cached),
    updatedAt: new Date().toISOString(),
    updatedBy: {
      deviceId: updatedSettings.deviceId,
      deviceName: updatedSettings.deviceName || browserEnv.label,
      browser: browserEnv.brand,
      family: browserEnv.family
    },
    ignoredKeys: nextIgnoredKeys,
    extensions: nextExtensions
  };

  await saveRemoteCache(nextPayload);

  const token = (updatedSettings.githubToken || '').trim();
  const gistId = (updatedSettings.gistId || '').trim();
  if (token && gistId) {
    try {
      await updateSyncGist(token, gistId, nextPayload);
    } catch (err) {
      console.warn('Failed to push ignored state to Gist:', err);
    }
  }

  return nextPayload;
}

/**
 * Pure function that computes the next active group IDs and the local extension enable/disable
 * actions when activating or deactivating a group.
 *
 * Rules:
 * - Extensions in the `default` group (`groups.includes('default')`) are NEVER affected by other groups.
 * - Ignored extensions are NEVER affected.
 * - Extensions belonging to at least one active group are enabled (`targetEnabled = true`).
 * - Extensions belonging only to inactive non-default groups are disabled (`targetEnabled = false`).
 * - Respects `settings.exclusiveGroupActivation` (exclusive single active group vs. multiple active groups).
 */
export function planGroupActivation({
  localExtensions = [],
  remotePayload = null,
  settings = {},
  groupId,
  active
}) {
  if (groupId === 'default') {
    throw new Error('The Default group is always independent and is not affected by other groups.');
  }

  const normalizedRemote = normalizeSyncPayload(remotePayload);
  const remoteMap = normalizedRemote.extensions || {};
  const groupsMap = normalizeGroupsMap({
    ...(normalizedRemote.groups || {}),
    ...(settings.groups || {})
  });

  const currentActive = Array.isArray(settings.activeGroupIds)
    ? settings.activeGroupIds.filter((id) => id && id !== 'default' && Boolean(groupsMap[id]))
    : [];

  let nextActiveGroupIds = [];
  if (!groupId || groupId === 'none') {
    nextActiveGroupIds = [];
  } else {
    const cleanGroupId = String(groupId)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-');
    if (!groupsMap[cleanGroupId]) {
      throw new Error(`Group "${cleanGroupId}" does not exist.`);
    }
    const shouldBeActive =
      typeof active === 'boolean' ? active : !currentActive.includes(cleanGroupId);

    if (settings.exclusiveGroupActivation !== false) {
      nextActiveGroupIds = shouldBeActive
        ? [cleanGroupId]
        : currentActive.filter((id) => id !== cleanGroupId);
    } else {
      nextActiveGroupIds = shouldBeActive
        ? Array.from(new Set([...currentActive, cleanGroupId]))
        : currentActive.filter((id) => id !== cleanGroupId);
    }
  }

  const effectiveIgnoredKeys = Array.from(
    new Set([...(settings.ignoredKeys || []), ...(normalizedRemote.ignoredKeys || [])])
  );

  const localToggleActions = [];
  const targetStatesByKey = {};
  const untouchedDefaultKeys = [];
  const matchedRemoteKeys = new Set();

  for (const localExt of localExtensions) {
    if (localExt.installType === 'development' && !settings.includeDevelopmentExtensions) {
      continue;
    }

    const remoteMatch = findMatchingRemoteRecord(
      localExt,
      remoteMap,
      'chromium',
      settings.customMappings
    );
    const key = remoteMatch?.key || resolveCanonicalKey(localExt, settings.customMappings);
    if (remoteMatch) {
      matchedRemoteKeys.add(remoteMatch.key);
    }

    const isIgnored =
      Boolean(remoteMatch?.ignored) ||
      isExtensionIgnored(localExt, key, effectiveIgnoredKeys);
    if (isIgnored) {
      continue;
    }

    const extGroups = normalizeExtensionGroupsList(
      settings?.extensionGroups?.[key] || remoteMatch?.groups,
      groupsMap
    );

    if (extGroups.includes('default')) {
      untouchedDefaultKeys.push(key);
      continue;
    }

    const targetEnabled =
      nextActiveGroupIds.length > 0
        ? extGroups.some((gid) => nextActiveGroupIds.includes(gid))
        : false;

    targetStatesByKey[key] = targetEnabled;

    if (Boolean(localExt.enabled) !== targetEnabled && localExt.mayDisable !== false) {
      localToggleActions.push({
        id: localExt.id,
        key,
        name: localExt.name,
        targetEnabled
      });
    }
  }

  for (const [remKey, remRecord] of Object.entries(remoteMap)) {
    if (matchedRemoteKeys.has(remKey)) continue;
    const isIgnored =
      Boolean(remRecord?.ignored) ||
      isExtensionIgnored(remRecord, remKey, effectiveIgnoredKeys);
    if (isIgnored) continue;

    const extGroups = normalizeExtensionGroupsList(
      settings?.extensionGroups?.[remKey] || remRecord?.groups,
      groupsMap
    );

    if (extGroups.includes('default')) {
      untouchedDefaultKeys.push(remKey);
      continue;
    }

    targetStatesByKey[remKey] =
      nextActiveGroupIds.length > 0
        ? extGroups.some((gid) => nextActiveGroupIds.includes(gid))
        : false;
  }

  return {
    nextActiveGroupIds,
    localToggleActions,
    targetStatesByKey,
    untouchedDefaultKeys
  };
}

/**
 * Activates or deactivates a group, toggles local extensions accordingly (leaving `default`
 * and `ignored` extensions untouched), and optionally syncs the active group state to Gist
 * when `settings.syncActiveGroupsToGist` is enabled.
 *
 * @param {{ groupId: string | null, active?: boolean }} params
 */
export async function activateGroup({ groupId, active }) {
  const settings = await getSettings();
  const localMeta = await getLocalMeta();
  const browserEnv = detectBrowserEnvironment();
  const localExtensions = await getInstalledExtensions();
  const cached = (await getRemoteCache()) || createEmptySyncPayload();

  const plan = planGroupActivation({
    localExtensions,
    remotePayload: cached,
    settings,
    groupId,
    active
  });

  const nowIso = new Date().toISOString();
  const appliedToggles = [];

  if (plan.localToggleActions.length > 0) {
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
      setTimeout(() => {
        isApplyingRemoteState = false;
      }, 500);
    }
  }

  const updatedTimestamps = { ...(localMeta.updatedAtByKey || {}) };
  for (const key of Object.keys(plan.targetStatesByKey)) {
    updatedTimestamps[key] = nowIso;
  }

  await saveSettings({ activeGroupIds: plan.nextActiveGroupIds });
  await saveLocalMeta({ updatedAtByKey: updatedTimestamps });

  if (settings.syncActiveGroupsToGist !== false) {
    const nextExtensions = { ...(cached.extensions || {}) };
    for (const [key, targetEnabled] of Object.entries(plan.targetStatesByKey)) {
      if (nextExtensions[key]) {
        nextExtensions[key] = {
          ...nextExtensions[key],
          enabled: targetEnabled,
          updatedAt: nowIso
        };
      }
    }

    const nextPayload = {
      ...normalizeSyncPayload(cached),
      updatedAt: nowIso,
      updatedBy: {
        deviceId: settings.deviceId,
        deviceName: settings.deviceName || browserEnv.label,
        browser: browserEnv.brand,
        family: browserEnv.family
      },
      groups: normalizeGroupsMap({ ...(cached.groups || {}), ...(settings.groups || {}) }),
      activeGroupIds: plan.nextActiveGroupIds,
      extensions: nextExtensions
    };

    await saveRemoteCache(nextPayload);

    const token = (settings.githubToken || '').trim();
    const gistId = (settings.gistId || '').trim();
    if (token && gistId) {
      try {
        await updateSyncGist(token, gistId, nextPayload);
      } catch (err) {
        console.warn('Failed to push active group state to Gist:', err);
      }
    }
  }

  const activeNames = plan.nextActiveGroupIds
    .map((id) => settings.groups?.[id]?.name || id)
    .join(', ');

  await appendSyncLog({
    status: 'success',
    mode: 'group',
    message:
      plan.nextActiveGroupIds.length > 0
        ? `Activated group(s): ${activeNames} (${appliedToggles.length} local extensions toggled).`
        : `Deactivated context groups (${appliedToggles.length} local extensions toggled).`
  });

  return {
    activeGroupIds: plan.nextActiveGroupIds,
    toggledCount: appliedToggles.length,
    untouchedDefaultCount: plan.untouchedDefaultKeys.length
  };
}

/**
 * Creates or updates a custom extension group and syncs the group definition to Gist.
 *
 * @param {{ id?: string, name: string, color?: string }} params
 */
export async function saveGroup({ id, name, color }) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) {
    throw new Error('Group name is required.');
  }

  const cleanId = String(id || trimmedName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!cleanId) {
    throw new Error('Invalid group identifier.');
  }

  const settings = await getSettings();
  const browserEnv = detectBrowserEnvironment();
  const cached = (await getRemoteCache()) || createEmptySyncPayload();
  const nextGroups = normalizeGroupsMap({
    ...(cached.groups || {}),
    ...(settings.groups || {})
  });

  nextGroups[cleanId] = {
    id: cleanId,
    name: trimmedName,
    color: String(color || nextGroups[cleanId]?.color || '#3b82f6').trim(),
    isDefault: cleanId === 'default'
  };

  await saveSettings({ groups: nextGroups });

  const nextPayload = {
    ...normalizeSyncPayload(cached),
    updatedAt: new Date().toISOString(),
    updatedBy: {
      deviceId: settings.deviceId,
      deviceName: settings.deviceName || browserEnv.label,
      browser: browserEnv.brand,
      family: browserEnv.family
    },
    groups: nextGroups
  };

  await saveRemoteCache(nextPayload);

  const token = (settings.githubToken || '').trim();
  const gistId = (settings.gistId || '').trim();
  if (token && gistId) {
    try {
      await updateSyncGist(token, gistId, nextPayload);
    } catch (err) {
      console.warn('Failed to push saved group to Gist:', err);
    }
  }

  return nextGroups[cleanId];
}

/**
 * Deletes a custom group (cannot delete `default`). Any extension that belonged only
 * to the deleted group automatically reverts to `['default']`.
 *
 * @param {string} groupId
 */
export async function deleteGroup(groupId) {
  const cleanId = String(groupId || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-');

  if (!cleanId) {
    throw new Error('Group ID is required.');
  }
  if (cleanId === 'default') {
    throw new Error('The Default group cannot be deleted.');
  }

  const settings = await getSettings();
  const browserEnv = detectBrowserEnvironment();
  const cached = (await getRemoteCache()) || createEmptySyncPayload();

  const nextGroups = normalizeGroupsMap({
    ...(cached.groups || {}),
    ...(settings.groups || {})
  });
  delete nextGroups[cleanId];

  const nextActiveGroupIds = (settings.activeGroupIds || []).filter((id) => id !== cleanId);
  const nextExtensionGroups = {};
  for (const [k, list] of Object.entries(settings.extensionGroups || {})) {
    const filtered = Array.isArray(list) ? list.filter((id) => id !== cleanId) : [];
    nextExtensionGroups[k] = normalizeExtensionGroupsList(filtered, nextGroups);
  }

  await saveSettings({
    groups: nextGroups,
    activeGroupIds: nextActiveGroupIds,
    extensionGroups: nextExtensionGroups
  });

  const nextExtensions = { ...(cached.extensions || {}) };
  for (const [k, rec] of Object.entries(nextExtensions)) {
    if (!rec || typeof rec !== 'object') continue;
    const filtered = Array.isArray(rec.groups)
      ? rec.groups.filter((id) => id !== cleanId)
      : [];
    nextExtensions[k] = {
      ...rec,
      groups: normalizeExtensionGroupsList(filtered, nextGroups)
    };
  }

  const nextPayload = {
    ...normalizeSyncPayload(cached),
    updatedAt: new Date().toISOString(),
    updatedBy: {
      deviceId: settings.deviceId,
      deviceName: settings.deviceName || browserEnv.label,
      browser: browserEnv.brand,
      family: browserEnv.family
    },
    groups: nextGroups,
    activeGroupIds: (cached.activeGroupIds || []).filter((id) => id !== cleanId),
    extensions: nextExtensions
  };

  await saveRemoteCache(nextPayload);

  const token = (settings.githubToken || '').trim();
  const gistId = (settings.gistId || '').trim();
  if (token && gistId) {
    try {
      await updateSyncGist(token, gistId, nextPayload);
    } catch (err) {
      console.warn('Failed to push group deletion to Gist:', err);
    }
  }

  return { deletedId: cleanId, groups: nextGroups };
}

/**
 * Updates the groups assigned to a specific extension (`key`).
 * If `groupIds` is empty, the extension automatically belongs to `['default']`.
 *
 * @param {{ key: string, groupIds: string[] }} params
 */
export async function setExtensionGroups({ key, groupIds }) {
  if (!key) throw new Error('Extension key is required.');

  const settings = await getSettings();
  const localMeta = await getLocalMeta();
  const browserEnv = detectBrowserEnvironment();
  const localExtensions = await getInstalledExtensions();
  const cached = (await getRemoteCache()) || createEmptySyncPayload();

  const groupsMap = normalizeGroupsMap({
    ...(cached.groups || {}),
    ...(settings.groups || {})
  });

  const normalizedGroupIds = normalizeExtensionGroupsList(groupIds, groupsMap);
  const nextExtensionGroups = {
    ...(settings.extensionGroups || {}),
    [key]: normalizedGroupIds
  };

  const updatedSettings = await saveSettings({ extensionGroups: nextExtensionGroups });
  const nowIso = new Date().toISOString();
  await touchExtensionTimestamp(key, nowIso);

  // If a context group is currently active and this extension is not in `default`,
  // apply the active group state to this extension locally if installed
  const activeGroupIds = Array.isArray(updatedSettings.activeGroupIds)
    ? updatedSettings.activeGroupIds.filter((id) => id && id !== 'default' && Boolean(groupsMap[id]))
    : [];

  let localTargetEnabled = null;
  if (activeGroupIds.length > 0 && !normalizedGroupIds.includes('default')) {
    localTargetEnabled = normalizedGroupIds.some((gid) => activeGroupIds.includes(gid));
    const localMatch = localExtensions.find(
      (extItem) => resolveCanonicalKey(extItem, updatedSettings.customMappings) === key
    );
    if (
      localMatch &&
      !isExtensionIgnored(localMatch, key, updatedSettings.ignoredKeys) &&
      localMatch.mayDisable !== false &&
      Boolean(localMatch.enabled) !== localTargetEnabled &&
      updatedSettings.autoApplyEnabledState !== false
    ) {
      isApplyingRemoteState = true;
      try {
        await setExtensionEnabled(localMatch.id, localTargetEnabled);
      } catch (err) {
        console.warn(`Failed to toggle extension ${localMatch.name} after group change:`, err);
      } finally {
        setTimeout(() => {
          isApplyingRemoteState = false;
        }, 500);
      }
    }
  }

  const nextExtensions = { ...(cached.extensions || {}) };
  if (nextExtensions[key]) {
    nextExtensions[key] = {
      ...nextExtensions[key],
      groups: normalizedGroupIds,
      ...(typeof localTargetEnabled === 'boolean' && updatedSettings.syncActiveGroupsToGist !== false
        ? { enabled: localTargetEnabled }
        : {}),
      updatedAt: nowIso
    };
  } else {
    const localMatch = localExtensions.find(
      (extItem) => resolveCanonicalKey(extItem, updatedSettings.customMappings) === key
    );
    if (localMatch) {
      const rec = buildSyncRecordFromLocal(
        localMatch,
        null,
        browserEnv,
        updatedSettings,
        localMeta
      );
      rec.groups = normalizedGroupIds;
      if (typeof localTargetEnabled === 'boolean' && updatedSettings.syncActiveGroupsToGist !== false) {
        rec.enabled = localTargetEnabled;
      }
      rec.updatedAt = nowIso;
      nextExtensions[key] = rec;
    }
  }

  const nextPayload = {
    ...normalizeSyncPayload(cached),
    updatedAt: nowIso,
    updatedBy: {
      deviceId: updatedSettings.deviceId,
      deviceName: updatedSettings.deviceName || browserEnv.label,
      browser: browserEnv.brand,
      family: browserEnv.family
    },
    groups: groupsMap,
    extensions: nextExtensions
  };

  await saveRemoteCache(nextPayload);

  const token = (updatedSettings.githubToken || '').trim();
  const gistId = (updatedSettings.gistId || '').trim();
  if (token && gistId) {
    try {
      await updateSyncGist(token, gistId, nextPayload);
    } catch (err) {
      console.warn('Failed to push extension groups update to Gist:', err);
    }
  }

  return {
    key,
    groups: normalizedGroupIds
  };
}





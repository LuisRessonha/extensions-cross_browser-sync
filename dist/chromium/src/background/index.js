import {
  ext,
  setExtensionEnabled,
  uninstallExtension
} from '../shared/browser-polyfill.js';
import { resolveCanonicalKey } from '../shared/matcher.js';
import {
  getSettings,
  getSyncLogs,
  saveRemoteCache,
  saveSettings,
  touchExtensionTimestamp
} from '../shared/storage.js';
import {
  createSyncGist,
  validateTokenAndDiscoverGist
} from '../shared/gist.js';
import {
  buildInitialPayloadFromLocal,
  clearGistData,
  getDashboardState,
  isCurrentlyApplyingRemoteState,
  performSync
} from '../shared/sync-engine.js';

const ALARM_PERIODIC_SYNC = 'ecbs-periodic-sync';
const ALARM_DEBOUNCED_SYNC = 'ecbs-debounced-sync';

/**
 * Updates the toolbar badge to indicate missing or out-of-sync extensions.
 */
async function refreshBadge() {
  try {
    if (!ext?.action?.setBadgeText) return;
    const state = await getDashboardState({ refreshRemote: false });
    if (!state.hasRemoteCache) {
      await ext.action.setBadgeText({ text: '' });
      return;
    }

    const { missingInLocal, stateDiff } = state.comparison.counts;
    const attentionCount = missingInLocal + stateDiff;

    if (attentionCount > 0) {
      await ext.action.setBadgeText({ text: String(attentionCount) });
      await ext.action.setBadgeBackgroundColor({
        color: stateDiff > 0 ? '#f59e0b' : '#3b82f6'
      });
    } else {
      await ext.action.setBadgeText({ text: '' });
    }
  } catch (err) {
    console.warn('Failed to update badge:', err);
  }
}

/**
 * Configures or clears the periodic background sync alarm based on settings.
 */
async function configureSyncAlarm() {
  if (!ext?.alarms) return;
  const settings = await getSettings();
  await ext.alarms.clear(ALARM_PERIODIC_SYNC);

  const minutes = Number(settings.autoSyncMinutes) || 0;
  if (minutes > 0 && settings.githubToken && settings.gistId) {
    ext.alarms.create(ALARM_PERIODIC_SYNC, {
      periodInMinutes: Math.max(1, minutes)
    });
  }
}

/**
 * Handles local management change events (enable, disable, install, uninstall).
 */
async function handleLocalExtensionChange(extInfo) {
  if (isCurrentlyApplyingRemoteState()) {
    return;
  }
  const selfId = ext.runtime?.id;
  if (extInfo?.id === selfId) return;
  if (extInfo?.type && extInfo.type !== 'extension') return;

  const settings = await getSettings();
  if (extInfo?. name) {
    const key = resolveCanonicalKey(extInfo, settings.customMappings);
    await touchExtensionTimestamp(key);
  }

  await refreshBadge();

  if (settings.autoPushOnChange && settings.githubToken && settings.gistId && ext?.alarms) {
    await ext.alarms.clear(ALARM_DEBOUNCED_SYNC);
    ext.alarms.create(ALARM_DEBOUNCED_SYNC, { delayInMinutes: 0.2 });
  }
}

// Register management listeners
if (ext?.management) {
  ext.management.onEnabled?.addListener((info) => {
    handleLocalExtensionChange(info);
  });
  ext.management.onDisabled?.addListener((info) => {
    handleLocalExtensionChange(info);
  });
  ext.management.onInstalled?.addListener((info) => {
    handleLocalExtensionChange(info);
  });
  ext.management.onUninstalled?.addListener(() => {
    refreshBadge();
  });
}

// Register alarm listeners
if (ext?.alarms?.onAlarm) {
  ext.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_PERIODIC_SYNC || alarm.name === ALARM_DEBOUNCED_SYNC) {
      const settings = await getSettings();
      if (settings.githubToken && settings.gistId) {
        try {
          await performSync({ mode: 'merge' });
          await refreshBadge();
        } catch (err) {
          console.warn('Background sync failed:', err);
        }
      }
    }
  });
}

// Initialize on install / startup
ext?.runtime?.onInstalled?.addListener(async () => {
  await configureSyncAlarm();
  await refreshBadge();
});

ext?.runtime?.onStartup?.addListener(async () => {
  await configureSyncAlarm();
  const settings = await getSettings();
  if (settings.githubToken && settings.gistId && Number(settings.autoSyncMinutes) > 0) {
    try {
      await performSync({ mode: 'merge' });
    } catch (err) {
      console.warn('Startup sync error:', err);
    }
  }
  await refreshBadge();
});

// Handle runtime messages from Popup & Options UI
ext?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case 'GET_DASHBOARD_STATE': {
          const state = await getDashboardState({
            refreshRemote: Boolean(message.refreshRemote)
          });
          await refreshBadge();
          sendResponse({ ok: true, data: state });
          break;
        }

        case 'PERFORM_SYNC': {
          const result = await performSync({ mode: message.mode || 'merge' });
          const state = await getDashboardState({ refreshRemote: false });
          await refreshBadge();
          sendResponse({ ok: true, result, data: state });
          break;
        }

        case 'TOGGLE_LOCAL_EXTENSION': {
          const { id, key, enabled } = message;
          await setExtensionEnabled(id, enabled);
          if (key) {
            await touchExtensionTimestamp(key);
          }
          const state = await getDashboardState({ refreshRemote: false });
          await refreshBadge();
          sendResponse({ ok: true, data: state });
          break;
        }

        case 'UNINSTALL_LOCAL_EXTENSION': {
          await uninstallExtension(message.id);
          const state = await getDashboardState({ refreshRemote: false });
          await refreshBadge();
          sendResponse({ ok: true, data: state });
          break;
        }

        case 'TOGGLE_IGNORE_KEY': {
          const { key } = message;
          const settings = await getSettings();
          const ignored = new Set(settings.ignoredKeys || []);
          if (ignored.has(key)) {
            ignored.delete(key);
          } else {
            ignored.add(key);
          }
          await saveSettings({ ignoredKeys: Array.from(ignored) });
          const state = await getDashboardState({ refreshRemote: false });
          await refreshBadge();
          sendResponse({ ok: true, data: state });
          break;
        }

        case 'SAVE_SETTINGS': {
          const updated = await saveSettings(message.settings || {});
          await configureSyncAlarm();
          const state = await getDashboardState({ refreshRemote: false });
          await refreshBadge();
          sendResponse({ ok: true, settings: updated, data: state });
          break;
        }

        case 'VALIDATE_AND_DISCOVER_GIST': {
          const info = await validateTokenAndDiscoverGist(message.token);
          sendResponse({ ok: true, info });
          break;
        }

        case 'CREATE_GIST': {
          const token = message.token;
          const initialPayload = await buildInitialPayloadFromLocal();
          const created = await createSyncGist(token, initialPayload);
          await saveSettings({
            githubToken: token,
            gistId: created.gistId
          });
          await saveRemoteCache(created.payload);
          await configureSyncAlarm();
          await refreshBadge();
          sendResponse({ ok: true, created });
          break;
        }

        case 'CLEAR_GIST_DATA': {
          await clearGistData({
            token: message.token,
            gistId: message.gistId
          });
          const state = await getDashboardState({ refreshRemote: false });
          await refreshBadge();
          sendResponse({ ok: true, data: state });
          break;
        }

        case 'IMPORT_PAYLOAD_CACHE': {
          await saveRemoteCache(message.payload);
          const state = await getDashboardState({ refreshRemote: false });
          await refreshBadge();
          sendResponse({ ok: true, data: state });
          break;
        }

        case 'GET_SYNC_LOGS': {
          const logs = await getSyncLogs();
          sendResponse({ ok: true, logs });
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message?.type}` });
      }
    } catch (error) {
      sendResponse({
        ok: false,
        error: error?.message || String(error)
      });
    }
  })();

  // Return true to keep the message channel open for async response
  return true;
});


import { ext } from '../shared/browser-polyfill.js';
import { buildInitialPayloadFromLocal } from '../shared/sync-engine.js';
import { normalizeSyncPayload } from '../shared/gist.js';

let currentState = null;

const els = {
  envBadge: document.getElementById('env-badge'),
  headerSyncBtn: document.getElementById('header-sync-btn'),
  headerPushBtn: document.getElementById('header-push-btn'),
  headerPullBtn: document.getElementById('header-pull-btn'),
  openSettingsModalBtn: document.getElementById('open-settings-modal-btn'),
  closeSettingsModalBtn: document.getElementById('close-settings-modal-btn'),
  settingsModal: document.getElementById('settings-modal'),
  alertBanner: document.getElementById('alert-banner'),
  githubToken: document.getElementById('github-token'),
  toggleTokenBtn: document.getElementById('toggle-token-btn'),
  discoverGistBtn: document.getElementById('discover-gist-btn'),
  createGistBtn: document.getElementById('create-gist-btn'),
  gistId: document.getElementById('gist-id'),
  openGistLink: document.getElementById('open-gist-link'),
  deviceName: document.getElementById('device-name'),
  saveGistBtn: document.getElementById('save-gist-btn'),
  clearGistBtn: document.getElementById('clear-gist-btn'),
  autoSyncMinutes: document.getElementById('auto-sync-minutes'),
  autoPushOnChange: document.getElementById('auto-push-on-change'),
  autoApplyEnabled: document.getElementById('auto-apply-enabled'),
  syncDisabledExtensions: document.getElementById('sync-disabled-extensions'),
  includeDevExtensions: document.getElementById('include-dev-extensions'),
  savePrefsBtn: document.getElementById('save-prefs-btn'),
  exportJsonBtn: document.getElementById('export-json-btn'),
  importJsonInput: document.getElementById('import-json-input'),
  syncLogList: document.getElementById('sync-log-list'),
  matrixStats: document.getElementById('matrix-stats'),
  matrixSearch: document.getElementById('matrix-search'),
  matrixFilter: document.getElementById('matrix-filter'),
  matrixInstallMissingBtn: document.getElementById('matrix-install-missing-btn'),
  refreshRemoteBtn: document.getElementById('refresh-remote-btn'),
  matrixTbody: document.getElementById('matrix-tbody')
};

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    ext.runtime.sendMessage(msg, (response) => {
      const err = ext.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || 'Operation failed'));
        return;
      }
      resolve(response);
    });
  });
}

function showAlert(message, isError = false) {
  els.alertBanner.textContent = message;
  els.alertBanner.classList.remove('hidden', 'error');
  if (isError) {
    els.alertBanner.classList.add('error');
  }
  clearTimeout(showAlert._timer);
  showAlert._timer = setTimeout(() => {
    els.alertBanner.classList.add('hidden');
  }, 6000);
}

function updateGistLink(gistId) {
  if (gistId && gistId.trim()) {
    els.openGistLink.href = `https://gist.github.com/${encodeURIComponent(gistId.trim())}`;
    els.openGistLink.classList.remove('hidden');
  } else {
    els.openGistLink.classList.add('hidden');
  }
}

function populateSettingsForm(settings, browserEnv) {
  els.envBadge.textContent = `${browserEnv?.label || 'Browser'} (${browserEnv?.family || ''})`;
  els.githubToken.value = settings.githubToken || '';
  els.gistId.value = settings.gistId || '';
  els.deviceName.value = settings.deviceName || browserEnv?.label || '';
  updateGistLink(settings.gistId);

  els.autoSyncMinutes.value = String(settings.autoSyncMinutes ?? 30);
  els.autoPushOnChange.checked = Boolean(settings.autoPushOnChange);
  els.autoApplyEnabled.checked = settings.autoApplyEnabledState !== false;
  els.syncDisabledExtensions.checked = settings.syncDisabledExtensions !== false;
  els.includeDevExtensions.checked = Boolean(settings.includeDevelopmentExtensions);
}

function renderMatrix() {
  if (!currentState) return;
  const { comparison, settings } = currentState;
  const { counts, items } = comparison;

  els.matrixStats.replaceChildren();
  const statEntries = [
    ['Installed', counts.totalLocal],
    ['In Sync', counts.inSync],
    ['State Diff', counts.stateDiff],
    ['Missing', counts.missingInLocal],
    ['Local Only', counts.localOnly],
    ['Ignored', counts.ignored]
  ];
  for (const [label, val] of statEntries) {
    const chip = document.createElement('div');
    chip.className = 'stat-chip';
    const strong = document.createElement('strong');
    strong.textContent = String(val);
    chip.append(`${label}: `, strong);
    els.matrixStats.appendChild(chip);
  }

  const missingItems = items.filter((i) => i.status === 'missing');
  if (missingItems.length > 0) {
    els.matrixInstallMissingBtn.classList.remove('hidden');
    els.matrixInstallMissingBtn.textContent = `Auto-Install All Missing (${missingItems.length})`;
  } else {
    els.matrixInstallMissingBtn.classList.add('hidden');
  }

  const query = els.matrixSearch.value.trim().toLowerCase();
  const statusFilter = els.matrixFilter.value;

  const filtered = items.filter((item) => {
    if (statusFilter === 'all' && item.status === 'ignored') return false;
    if (statusFilter !== 'all' && item.status !== statusFilter) return false;
    if (query) {
      const hay = `${item.name} ${item.key} ${item.localId || ''} ${item.ids?.chromium || ''} ${
        item.ids?.firefox || ''
      }`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  els.matrixTbody.replaceChildren();

  if (filtered.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'empty-cell';
    td.textContent = 'No extensions match the current filter.';
    tr.appendChild(td);
    els.matrixTbody.appendChild(tr);
    return;
  }

  for (const item of filtered) {
    const tr = document.createElement('tr');

    // Col 1: Extension Icon + Name + Version
    const tdExt = document.createElement('td');
    const extWrap = document.createElement('div');
    extWrap.className = 'cell-ext';
    if (item.iconUrl) {
      const img = document.createElement('img');
      img.className = 'cell-icon';
      img.src = item.iconUrl;
      img.alt = '';
      extWrap.appendChild(img);
    } else {
      const fb = document.createElement('div');
      fb.className = 'cell-fallback';
      fb.textContent = (item.name || '?').charAt(0).toUpperCase();
      extWrap.appendChild(fb);
    }
    const nameBox = document.createElement('div');
    const titleEl = document.createElement('div');
    titleEl.style.fontWeight = '600';
    titleEl.textContent = item.name;
    const verEl = document.createElement('div');
    verEl.className = 'muted';
    verEl.style.fontSize = '11px';
    verEl.textContent = item.version ? `v${item.version}` : '';
    nameBox.appendChild(titleEl);
    nameBox.appendChild(verEl);
    extWrap.appendChild(nameBox);
    tdExt.appendChild(extWrap);

    // Col 2: Canonical Sync Key (editable for local extensions to allow custom cross-browser pairing)
    const tdKey = document.createElement('td');
    if (item.localId) {
      const wrap = document.createElement('div');
      wrap.className = 'key-input-wrap';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'key-input';
      input.value = item.key;
      input.title =
        'Canonical key used to pair this extension across Chromium & Firefox. Edit and click Save to customize.';

      const saveKeyBtn = document.createElement('button');
      saveKeyBtn.className = 'btn btn-secondary btn-sm hidden';
      saveKeyBtn.textContent = 'Save';

      input.addEventListener('input', () => {
        if (input.value.trim() && input.value.trim() !== item.key) {
          saveKeyBtn.classList.remove('hidden');
        } else {
          saveKeyBtn.classList.add('hidden');
        }
      });

      saveKeyBtn.addEventListener('click', async () => {
        const newKey = input.value.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
        if (!newKey) return;
        const nextMappings = {
          ...(settings.customMappings || {}),
          [item.localId]: newKey
        };
        const res = await sendMessage({
          type: 'SAVE_SETTINGS',
          settings: { customMappings: nextMappings }
        });
        currentState = res.data;
        renderMatrix();
        showAlert(`Mapped "${item.name}" to canonical sync key "${newKey}".`);
      });

      wrap.appendChild(input);
      wrap.appendChild(saveKeyBtn);
      tdKey.appendChild(wrap);
    } else {
      const code = document.createElement('code');
      code.textContent = item.key;
      tdKey.appendChild(code);
    }

    // Col 3: Browser IDs (Chromium / Firefox) with manual edit support when missing or overridden
    const tdIds = document.createElement('td');
    const idList = document.createElement('div');
    idList.className = 'id-list';

    const initialCr = item.ids?.chromium || '';
    const initialFf = item.ids?.firefox || '';

    const crRow = document.createElement('div');
    crRow.className = 'id-edit-row';
    const crLabel = document.createElement('span');
    crLabel.className = 'id-prefix';
    crLabel.textContent = 'Cr:';
    const crInput = document.createElement('input');
    crInput.type = 'text';
    crInput.className = `id-input${!initialCr ? ' id-missing' : ''}`;
    crInput.value = initialCr;
    crInput.placeholder = 'Missing — enter Chromium ID or URL';
    crInput.title = initialCr
      ? `Chromium ID: ${initialCr} (edit or paste Chrome Web Store URL to override)`
      : 'Chromium ID not found automatically — enter 32-char ID or paste Chrome Web Store URL';
    crRow.appendChild(crLabel);
    crRow.appendChild(crInput);

    const ffRow = document.createElement('div');
    ffRow.className = 'id-edit-row';
    const ffLabel = document.createElement('span');
    ffLabel.className = 'id-prefix';
    ffLabel.textContent = 'Ff:';
    const ffInput = document.createElement('input');
    ffInput.type = 'text';
    ffInput.className = `id-input${!initialFf ? ' id-missing' : ''}`;
    ffInput.value = initialFf;
    ffInput.placeholder = 'Missing — enter Firefox ID or URL';
    ffInput.title = initialFf
      ? `Firefox ID: ${initialFf} (edit or paste Firefox Add-ons URL to override)`
      : 'Firefox ID not found automatically — enter Add-on GUID/slug or paste Firefox Add-ons URL';
    ffRow.appendChild(ffLabel);
    ffRow.appendChild(ffInput);

    const saveIdsBtn = document.createElement('button');
    saveIdsBtn.className = 'btn btn-secondary btn-sm hidden';
    saveIdsBtn.textContent = 'Save IDs';
    saveIdsBtn.style.alignSelf = 'flex-start';

    const checkIdsDirty = () => {
      const changed =
        crInput.value.trim() !== initialCr || ffInput.value.trim() !== initialFf;
      if (changed) {
        saveIdsBtn.classList.remove('hidden');
      } else {
        saveIdsBtn.classList.add('hidden');
      }
    };

    crInput.addEventListener('input', checkIdsDirty);
    ffInput.addEventListener('input', checkIdsDirty);

    saveIdsBtn.addEventListener('click', async () => {
      try {
        saveIdsBtn.disabled = true;
        const res = await sendMessage({
          type: 'SAVE_BROWSER_IDS',
          key: item.key,
          chromiumInput: crInput.value.trim(),
          firefoxInput: ffInput.value.trim()
        });
        currentState = res.data;
        renderMatrix();
        showAlert(
          `Updated Browser IDs for "${item.name}" (Cr: ${
            res.savedIds?.chromium || 'none'
          }, Ff: ${res.savedIds?.firefox || 'none'}).`
        );
      } catch (err) {
        showAlert(err.message, true);
      } finally {
        saveIdsBtn.disabled = false;
      }
    });

    idList.appendChild(crRow);
    idList.appendChild(ffRow);
    idList.appendChild(saveIdsBtn);
    tdIds.appendChild(idList);

    // Col 4: Sync Status
    const tdStatus = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `pill pill-${item.status}`;
    const labels = {
      'in-sync': 'In Sync',
      'state-diff': `State Diff (Cloud: ${item.remoteEnabled ? 'ON' : 'OFF'})`,
      missing: `Missing (Cloud: ${item.remoteEnabled ? 'ON' : 'OFF'})`,
      'local-only': 'Local Only',
      ignored: 'Ignored'
    };
    pill.textContent = labels[item.status] || item.status;
    tdStatus.appendChild(pill);

    // Col 5: Local State
    const tdLocal = document.createElement('td');
    if (item.localId) {
      const toggleBtn = document.createElement('button');
      toggleBtn.className = `btn btn-sm ${item.localEnabled ? 'btn-accent' : 'btn-secondary'}`;
      toggleBtn.textContent = item.localEnabled ? 'Enabled' : 'Disabled';
      toggleBtn.disabled = !item.mayDisable;
      toggleBtn.addEventListener('click', async () => {
        try {
          const res = await sendMessage({
            type: 'TOGGLE_LOCAL_EXTENSION',
            id: item.localId,
            key: item.key,
            enabled: !item.localEnabled
          });
          currentState = res.data;
          renderMatrix();
        } catch (err) {
          showAlert(err.message, true);
        }
      });
      tdLocal.appendChild(toggleBtn);
    } else {
      const span = document.createElement('span');
      span.className = 'muted';
      span.textContent = 'Not installed';
      tdLocal.appendChild(span);
    }

    // Col 6: Actions (Store link + Ignore/Unignore)
    const tdActions = document.createElement('td');
    const actRow = document.createElement('div');
    actRow.className = 'button-row';

    if (item.storeInfo?.url) {
      const storeBtn = document.createElement('a');
      storeBtn.href = item.storeInfo.url;
      storeBtn.target = '_blank';
      storeBtn.rel = 'noopener';
      storeBtn.className = 'btn btn-sm btn-secondary';
      storeBtn.textContent = 'Store ↗';
      storeBtn.title = `Open store page in ${item.storeInfo.storeName}`;
      actRow.appendChild(storeBtn);
    }

    if (item.status === 'missing') {
      const autoInstallBtn = document.createElement('button');
      autoInstallBtn.className = 'btn btn-sm btn-primary';
      autoInstallBtn.textContent = 'Auto Install';
      autoInstallBtn.title =
        'Install automatically (direct XPI on Firefox / managed auto-closing installer on Chromium)';
      autoInstallBtn.addEventListener('click', async () => {
        try {
          autoInstallBtn.disabled = true;
          await sendMessage({
            type: 'AUTO_INSTALL_EXTENSION',
            item
          });
        } catch (err) {
          showAlert(err.message, true);
        } finally {
          autoInstallBtn.disabled = false;
        }
      });
      actRow.appendChild(autoInstallBtn);
    }

    const ignoreBtn = document.createElement('button');
    ignoreBtn.className = 'btn btn-sm btn-secondary';
    ignoreBtn.textContent = item.status === 'ignored' ? 'Unignore' : 'Ignore';
    ignoreBtn.addEventListener('click', async () => {
      try {
        const res = await sendMessage({
          type: 'TOGGLE_IGNORE_KEY',
          key: item.key
        });
        currentState = res.data;
        renderMatrix();
      } catch (err) {
        showAlert(err.message, true);
      }
    });
    actRow.appendChild(ignoreBtn);

    const removeGistBtn = document.createElement('button');
    removeGistBtn.className = 'btn btn-sm btn-danger';
    removeGistBtn.textContent = 'Remove from Gist';
    removeGistBtn.disabled = !item.inGist;
    removeGistBtn.title = item.inGist
      ? `Remove "${item.name}" from your GitHub Gist`
      : 'This extension is not currently saved in your GitHub Gist';
    removeGistBtn.addEventListener('click', async () => {
      try {
        removeGistBtn.disabled = true;
        const res = await sendMessage({
          type: 'REMOVE_FROM_GIST',
          key: item.key,
          name: item.name
        });
        currentState = res.data;
        renderMatrix();
        await refreshSyncLogs();
        showAlert(`Removed "${item.name}" from your GitHub Gist.`);
      } catch (err) {
        removeGistBtn.disabled = false;
        showAlert(err.message, true);
      }
    });
    actRow.appendChild(removeGistBtn);

    tdActions.appendChild(actRow);

    tr.appendChild(tdExt);
    tr.appendChild(tdKey);
    tr.appendChild(tdIds);
    tr.appendChild(tdStatus);
    tr.appendChild(tdLocal);
    tr.appendChild(tdActions);
    els.matrixTbody.appendChild(tr);
  }
}

async function refreshSyncLogs() {
  try {
    const res = await sendMessage({ type: 'GET_SYNC_LOGS' });
    const logs = res.logs || [];
    els.syncLogList.replaceChildren();
    if (logs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'No sync events recorded yet.';
      els.syncLogList.appendChild(empty);
      return;
    }
    for (const item of logs) {
      const row = document.createElement('div');
      row.className = 'log-item';
      const time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = `${new Date(item.timestamp).toLocaleString()} [${(
        item.mode || 'sync'
      ).toUpperCase()}]`;
      const msg = document.createElement('span');
      msg.className = `log-msg ${item.status === 'error' ? 'error' : ''}`;
      msg.textContent = item.message;
      row.appendChild(time);
      row.appendChild(msg);
      els.syncLogList.appendChild(row);
    }
  } catch {
    // Ignore log load errors
  }
}

async function runSync(mode) {
  try {
    els.headerSyncBtn.disabled = true;
    els.headerPushBtn.disabled = true;
    els.headerPullBtn.disabled = true;

    const res = await sendMessage({ type: 'PERFORM_SYNC', mode });
    currentState = res.data;
    renderMatrix();
    await refreshSyncLogs();

    const s = res.result?.summary;
    showAlert(
      `Sync (${mode}) complete! Total synced: ${s?.totalSynced ?? 0}, Local state updates: ${
        s?.toggledLocally ?? 0
      }, Missing on this browser: ${s?.missingCount ?? 0}.`
    );
  } catch (err) {
    showAlert(err.message, true);
    await refreshSyncLogs();
  } finally {
    els.headerSyncBtn.disabled = false;
    els.headerPushBtn.disabled = false;
    els.headerPullBtn.disabled = false;
  }
}

// Event Listeners
els.toggleTokenBtn.addEventListener('click', () => {
  const isPwd = els.githubToken.type === 'password';
  els.githubToken.type = isPwd ? 'text' : 'password';
  els.toggleTokenBtn.textContent = isPwd ? 'Hide' : 'Show';
});

els.discoverGistBtn.addEventListener('click', async () => {
  const token = els.githubToken.value.trim();
  if (!token) {
    showAlert('Please enter your GitHub Personal Access Token first.', true);
    return;
  }
  try {
    els.discoverGistBtn.disabled = true;
    const res = await sendMessage({ type: 'VALIDATE_AND_DISCOVER_GIST', token });
    const { username, discoveredGistId } = res.info;
    if (discoveredGistId) {
      els.gistId.value = discoveredGistId;
      updateGistLink(discoveredGistId);
      await sendMessage({
        type: 'SAVE_SETTINGS',
        settings: { githubToken: token, gistId: discoveredGistId }
      });
      const refreshed = await sendMessage({ type: 'GET_DASHBOARD_STATE', refreshRemote: true });
      currentState = refreshed.data;
      renderMatrix();
      showAlert(
        `Authenticated as @${username} and auto-connected existing sync Gist (${discoveredGistId})!`
      );
    } else {
      showAlert(
        `Authenticated as @${username}! No existing sync Gist found yet — click "+ Create New Private Gist" to initialize one.`
      );
    }
  } catch (err) {
    showAlert(err.message, true);
  } finally {
    els.discoverGistBtn.disabled = false;
  }
});

els.createGistBtn.addEventListener('click', async () => {
  const token = els.githubToken.value.trim();
  if (!token) {
    showAlert('Please enter your GitHub Personal Access Token first.', true);
    return;
  }
  try {
    els.createGistBtn.disabled = true;
    const res = await sendMessage({ type: 'CREATE_GIST', token });
    els.gistId.value = res.created.gistId;
    updateGistLink(res.created.gistId);

    const refreshed = await sendMessage({ type: 'GET_DASHBOARD_STATE', refreshRemote: false });
    currentState = refreshed.data;
    renderMatrix();
    showAlert(`Created new private Gist (${res.created.gistId}) with your installed extensions!`);
  } catch (err) {
    showAlert(err.message, true);
  } finally {
    els.createGistBtn.disabled = false;
  }
});

els.saveGistBtn.addEventListener('click', async () => {
  try {
    const githubToken = els.githubToken.value.trim();
    const gistId = els.gistId.value.trim();
    const deviceName = els.deviceName.value.trim();

    await sendMessage({
      type: 'SAVE_SETTINGS',
      settings: { githubToken, gistId, deviceName }
    });
    updateGistLink(gistId);

    const refreshed = await sendMessage({
      type: 'GET_DASHBOARD_STATE',
      refreshRemote: Boolean(githubToken && gistId)
    });
    currentState = refreshed.data;
    renderMatrix();
    showAlert('Connection settings saved!');
  } catch (err) {
    showAlert(err.message, true);
  }
});

els.clearGistBtn.addEventListener('click', async () => {
  const token = els.githubToken.value.trim();
  const gistId = els.gistId.value.trim();
  if (!token || !gistId) {
    showAlert('GitHub Token and Gist ID are required to clear Gist data.', true);
    return;
  }
  const confirmed = window.confirm(
    'Are you sure you want to clear all saved extension data from your GitHub Gist? This will empty the remote sync list.'
  );
  if (!confirmed) return;

  try {
    els.clearGistBtn.disabled = true;
    const res = await sendMessage({
      type: 'CLEAR_GIST_DATA',
      token,
      gistId
    });
    currentState = res.data;
    renderMatrix();
    await refreshSyncLogs();
    showAlert('Cleared all saved extension data from your GitHub Gist.');
  } catch (err) {
    showAlert(err.message, true);
    await refreshSyncLogs();
  } finally {
    els.clearGistBtn.disabled = false;
  }
});

els.savePrefsBtn.addEventListener('click', async () => {
  try {
    const res = await sendMessage({
      type: 'SAVE_SETTINGS',
      settings: {
        autoSyncMinutes: Number(els.autoSyncMinutes.value) || 0,
        autoPushOnChange: els.autoPushOnChange.checked,
        autoApplyEnabledState: els.autoApplyEnabled.checked,
        syncDisabledExtensions: els.syncDisabledExtensions.checked,
        includeDevelopmentExtensions: els.includeDevExtensions.checked
      }
    });
    currentState = res.data;
    renderMatrix();
    showAlert('Sync preferences saved!');
  } catch (err) {
    showAlert(err.message, true);
  }
});

els.headerSyncBtn.addEventListener('click', () => runSync('merge'));
els.headerPushBtn.addEventListener('click', () => runSync('push'));
els.headerPullBtn.addEventListener('click', () => runSync('pull'));

function openSettingsModal() {
  els.settingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
  els.settingsModal.classList.add('hidden');
}

els.openSettingsModalBtn.addEventListener('click', openSettingsModal);
els.closeSettingsModalBtn.addEventListener('click', closeSettingsModal);

els.settingsModal.addEventListener('click', (e) => {
  if (e.target === els.settingsModal) {
    closeSettingsModal();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.settingsModal.classList.contains('hidden')) {
    closeSettingsModal();
  }
});

els.refreshRemoteBtn.addEventListener('click', async () => {
  try {
    els.refreshRemoteBtn.disabled = true;
    const res = await sendMessage({ type: 'GET_DASHBOARD_STATE', refreshRemote: true });
    currentState = res.data;
    renderMatrix();
    showAlert('Refreshed remote state from GitHub Gist.');
  } catch (err) {
    showAlert(err.message, true);
  } finally {
    els.refreshRemoteBtn.disabled = false;
  }
});

els.matrixSearch.addEventListener('input', () => renderMatrix());
els.matrixFilter.addEventListener('change', () => renderMatrix());

els.matrixInstallMissingBtn.addEventListener('click', async () => {
  if (!currentState) return;
  const missing = currentState.comparison.items.filter((i) => i.status === 'missing');
  if (missing.length === 0) return;
  try {
    els.matrixInstallMissingBtn.disabled = true;
    await sendMessage({
      type: 'AUTO_INSTALL_ALL_MISSING',
      items: missing
    });
  } catch (err) {
    showAlert(err.message, true);
  } finally {
    els.matrixInstallMissingBtn.disabled = false;
  }
});

// Export JSON
els.exportJsonBtn.addEventListener('click', async () => {
  try {
    const payload = await buildInitialPayloadFromLocal();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `extensions-cross_browser-sync-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showAlert(err.message, true);
  }
});

// Import JSON
els.importJsonInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = normalizeSyncPayload(JSON.parse(text));
    const res = await sendMessage({
      type: 'IMPORT_PAYLOAD_CACHE',
      payload: parsed
    });
    currentState = res.data;
    renderMatrix();
    showAlert(
      `Imported ${Object.keys(parsed.extensions).length} extensions into comparison view. Click "Pull ↓" or "Sync Now" to apply.`
    );
  } catch (err) {
    showAlert(`Failed to import JSON: ${err.message}`, true);
  } finally {
    e.target.value = '';
  }
});

// Initialize page
(async () => {
  try {
    const res = await sendMessage({ type: 'GET_DASHBOARD_STATE', refreshRemote: false });
    currentState = res.data;
    populateSettingsForm(currentState.settings, currentState.browserEnv);
    renderMatrix();
    await refreshSyncLogs();
  } catch (err) {
    showAlert(err.message, true);
  }
})();


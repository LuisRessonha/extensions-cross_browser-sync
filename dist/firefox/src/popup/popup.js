import { ext } from '../shared/browser-polyfill.js';
import {
  getCachedExtensionIconUrl,
  resolveExtensionIconUrl
} from '../shared/matcher.js';

let currentState = null;
let activeTab = 'all';
let activeGroupFilter = 'all';
let searchQuery = '';
let availableXpiByKey = {};
let xpiCheckPromise = null;

const els = {
  browserBadge: document.getElementById('browser-badge'),
  lastSyncLabel: document.getElementById('last-sync-label'),
  openOptionsBtn: document.getElementById('open-options-btn'),
  setupBanner: document.getElementById('setup-banner'),
  setupGistBtn: document.getElementById('setup-gist-btn'),
  statusToast: document.getElementById('status-toast'),
  syncMergeBtn: document.getElementById('sync-merge-btn'),
  syncPushBtn: document.getElementById('sync-push-btn'),
  syncPullBtn: document.getElementById('sync-pull-btn'),
  popupGroupsBar: document.getElementById('popup-groups-bar'),
  countAll: document.getElementById('count-all'),
  countMissing: document.getElementById('count-missing'),
  countDiff: document.getElementById('count-diff'),
  countInstalled: document.getElementById('count-installed'),
  countIgnored: document.getElementById('count-ignored'),
  searchInput: document.getElementById('search-input'),
  installAllMissingBtn: document.getElementById('install-all-missing-btn'),
  extensionsList: document.getElementById('extensions-list'),
  tabs: Array.from(document.querySelectorAll('.tab'))
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
        reject(new Error(response?.error || 'Request failed'));
        return;
      }
      resolve(response);
    });
  });
}

function showToast(message, isError = false) {
  els.statusToast.textContent = message;
  els.statusToast.classList.remove('hidden', 'error');
  if (isError) {
    els.statusToast.classList.add('error');
  }
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    els.statusToast.classList.add('hidden');
  }, 4500);
}

function formatRelativeTime(iso) {
  if (!iso) return 'Never synced';
  const diffSec = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (Number.isNaN(diffSec) || diffSec < 5) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return new Date(iso).toLocaleDateString();
}

function getStatusLabel(item) {
  switch (item.status) {
    case 'in-sync':
      return { text: 'In Sync', cls: 'status-in-sync' };
    case 'state-diff':
      return {
        text: item.remoteEnabled ? 'Cloud: ON' : 'Cloud: OFF',
        cls: 'status-state-diff'
      };
    case 'missing':
      return {
        text: item.remoteEnabled ? 'Missing (Enabled)' : 'Missing (Disabled)',
        cls: 'status-missing'
      };
    case 'local-only':
      return { text: 'Local Only', cls: 'status-local-only' };
    case 'ignored':
      return { text: 'Ignored', cls: 'status-ignored' };
    default:
      return { text: item.status, cls: 'status-local-only' };
  }
}

function getOrderedGroups(groupsMap = {}) {
  const entries = Object.values(groupsMap);
  const def = entries.find((g) => g.id === 'default') || {
    id: 'default',
    name: 'Default',
    color: '#64748b',
    isDefault: true
  };
  const others = entries
    .filter((g) => g && g.id !== 'default')
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return [def, ...others];
}

function renderPopupGroupsBar() {
  if (!els.popupGroupsBar || !currentState) return;
  const { comparison, settings } = currentState;
  const groupsMap = comparison?.groups || settings?.groups || {};
  const activeGroupIds = Array.isArray(comparison?.activeGroupIds)
    ? comparison.activeGroupIds
    : Array.isArray(settings?.activeGroupIds)
    ? settings.activeGroupIds
    : [];
  const orderedGroups = getOrderedGroups(groupsMap);

  if (activeGroupFilter !== 'all' && !groupsMap[activeGroupFilter]) {
    activeGroupFilter = 'all';
  }

  els.popupGroupsBar.replaceChildren();

  const allChip = document.createElement('div');
  allChip.className = `popup-group-chip${
    activeGroupFilter === 'all' ? ' group-filter-selected' : ''
  }`;
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'popup-group-filter-btn';
  allBtn.textContent = 'All Groups';
  allBtn.title = 'Show extensions from all groups';
  allBtn.addEventListener('click', () => {
    activeGroupFilter = 'all';
    renderDashboard();
  });
  allChip.appendChild(allBtn);
  els.popupGroupsBar.appendChild(allChip);

  for (const grp of orderedGroups) {
    const isActive = !grp.isDefault && activeGroupIds.includes(grp.id);
    const isSelected = activeGroupFilter === grp.id;

    const chip = document.createElement('div');
    chip.className = `popup-group-chip${isSelected ? ' group-filter-selected' : ''}${
      isActive ? ' group-active-state' : ''
    }`;

    const filterBtn = document.createElement('button');
    filterBtn.type = 'button';
    filterBtn.className = 'popup-group-filter-btn';
    filterBtn.title = grp.isDefault
      ? 'Default Group (independent from other groups). Click to filter.'
      : `Filter by "${grp.name}" group`;

    const dot = document.createElement('span');
    dot.className = 'group-dot';
    dot.style.backgroundColor = grp.color || '#3b82f6';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = grp.name;
    filterBtn.append(dot, nameSpan);
    filterBtn.addEventListener('click', () => {
      activeGroupFilter = activeGroupFilter === grp.id ? 'all' : grp.id;
      renderDashboard();
    });
    chip.appendChild(filterBtn);

    if (!grp.isDefault) {
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = `popup-group-toggle-btn${isActive ? ' is-active' : ''}`;
      toggleBtn.textContent = isActive ? 'ON' : 'OFF';
      toggleBtn.title = isActive
        ? `Deactivate group "${grp.name}"`
        : `Activate group "${grp.name}" (enables extensions in this group; Default stays untouched)`;
      toggleBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          toggleBtn.disabled = true;
          const res = await sendMessage({
            type: 'ACTIVATE_GROUP',
            groupId: grp.id,
            active: !isActive
          });
          currentState = res.data;
          renderDashboard();
          const r = res.result;
          showToast(
            !isActive
              ? `Activated "${grp.name}" (${r?.toggledCount ?? 0} toggled).`
              : `Deactivated "${grp.name}" (${r?.toggledCount ?? 0} toggled).`
          );
        } catch (err) {
          showToast(err.message, true);
        } finally {
          toggleBtn.disabled = false;
        }
      });
      chip.appendChild(toggleBtn);
    }

    els.popupGroupsBar.appendChild(chip);
  }
}

function filterItems(items) {
  return items.filter((item) => {
    if (activeTab === 'all' && item.status === 'ignored') return false;
    if (activeTab === 'installed' && (!item.localId || item.status === 'ignored')) {
      return false;
    }
    if (activeTab === 'state-diff' && item.status !== 'state-diff') return false;
    if (activeTab === 'missing' && item.status !== 'missing') return false;
    if (activeTab === 'ignored' && item.status !== 'ignored') return false;
    if (activeGroupFilter !== 'all') {
      const itemGroups =
        Array.isArray(item.groups) && item.groups.length > 0 ? item.groups : ['default'];
      if (!itemGroups.includes(activeGroupFilter)) return false;
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchName = (item.name || '').toLowerCase().includes(q);
      const matchKey = (item.key || '').toLowerCase().includes(q);
      if (!matchName && !matchKey) return false;
    }
    return true;
  });
}

async function refreshXpiAvailability() {
  if (currentState?.browserEnv?.family !== 'firefox') {
    availableXpiByKey = {};
    return;
  }
  const missingItems = (currentState?.comparison?.items || []).filter(
    (i) => i.status === 'missing'
  );
  if (missingItems.length === 0) {
    availableXpiByKey = {};
    return;
  }
  const promise = (async () => {
    try {
      const res = await sendMessage({
        type: 'CHECK_REPO_XPI_AVAILABILITY',
        items: missingItems
      });
      availableXpiByKey = res?.availableByKey || {};
      renderDashboard();
    } catch {
      availableXpiByKey = {};
    }
  })();
  xpiCheckPromise = promise;
  await promise;
}

function renderDashboard() {
  if (!currentState) return;

  const { browserEnv, localMeta, hasGistConfigured, comparison, settings } = currentState;
  const { counts, items } = comparison;
  const groupsMap = comparison?.groups || settings?.groups || {};
  const orderedGroups = getOrderedGroups(groupsMap);

  renderPopupGroupsBar();

  els.browserBadge.textContent = browserEnv?.label || 'Browser';
  els.lastSyncLabel.textContent = localMeta?.lastSyncAt
    ? `Synced ${formatRelativeTime(localMeta.lastSyncAt)}`
    : 'Not synced yet';

  if (hasGistConfigured) {
    els.setupBanner.classList.add('hidden');
  } else {
    els.setupBanner.classList.remove('hidden');
  }

  const nonIgnoredItems = items.filter((i) => i.status !== 'ignored');
  els.countAll.textContent = String(nonIgnoredItems.length);
  els.countInstalled.textContent = String(
    nonIgnoredItems.filter((i) => Boolean(i.localId)).length
  );
  els.countDiff.textContent = String(counts.stateDiff);
  els.countMissing.textContent = String(counts.missingInLocal);
  els.countIgnored.textContent = String(counts.ignored);

  const missingItems = items.filter((i) => i.status === 'missing');
  if (missingItems.length > 0 && (activeTab === 'missing' || activeTab === 'all')) {
    els.installAllMissingBtn.classList.remove('hidden');
    els.installAllMissingBtn.textContent = `Auto-Install Missing (${missingItems.length})`;
  } else {
    els.installAllMissingBtn.classList.add('hidden');
  }

  const filtered = filterItems(items);
  els.extensionsList.replaceChildren();

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent =
      activeTab === 'missing'
        ? 'All synced extensions are installed in this browser!'
        : activeTab === 'state-diff'
        ? 'Everything is in sync between this browser and your Gist!'
        : activeTab === 'ignored'
        ? 'No ignored extensions.'
        : 'No matching extensions found.';
    els.extensionsList.appendChild(empty);
    return;
  }

  for (const item of filtered) {
    const card = document.createElement('div');
    card.className = `ext-card${item.localId && !item.localEnabled ? ' disabled-ext' : ''}`;

    const left = document.createElement('div');
    left.className = 'ext-left';
    left.appendChild(createPopupIconElement(item));

    const info = document.createElement('div');
    info.className = 'ext-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'ext-title-row';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'ext-name';
    nameSpan.textContent = item.name;
    nameSpan.title = item.name;
    titleRow.appendChild(nameSpan);

    const metaRow = document.createElement('div');
    metaRow.className = 'ext-meta-row';

    const statusBadge = document.createElement('span');
    const st = getStatusLabel(item);
    statusBadge.className = `status-pill ${st.cls}`;
    statusBadge.textContent = st.text;
    metaRow.appendChild(statusBadge);

    if (item.ids?.chromium) {
      const crTag = document.createElement('span');
      crTag.className = 'store-tag';
      crTag.textContent = 'Cr';
      crTag.title = `Chromium ID: ${item.ids.chromium}`;
      metaRow.appendChild(crTag);
    }
    if (item.ids?.firefox) {
      const ffTag = document.createElement('span');
      ffTag.className = 'store-tag';
      ffTag.textContent = 'Ff';
      ffTag.title = `Firefox ID: ${item.ids.firefox}`;
      metaRow.appendChild(ffTag);
    }
    if (item.equivalentAlternative) {
      const altTag = document.createElement('span');
      altTag.className = 'store-tag store-tag-alt';
      altTag.textContent = '≈ Alt';
      altTag.title = item.alternativeName
        ? `Matched with Equivalent Alternative: ${item.alternativeName}`
        : 'Matched with an Equivalent Alternative across browsers';
      metaRow.appendChild(altTag);
    }

    const itemGroups =
      Array.isArray(item.groups) && item.groups.length > 0 ? item.groups : ['default'];
    for (const gid of itemGroups) {
      const grp = groupsMap[gid] || {
        id: gid,
        name: gid,
        color: '#64748b',
        isDefault: gid === 'default'
      };
      const grpTag = document.createElement('span');
      grpTag.className = `popup-group-tag${grp.isDefault ? ' is-default' : ''}`;
      grpTag.title = grp.isDefault
        ? 'Default Group: Not affected when other groups are activated or deactivated'
        : `Group: ${grp.name}`;
      const dot = document.createElement('span');
      dot.className = 'group-dot';
      dot.style.backgroundColor = grp.color || '#3b82f6';
      const labelSpan = document.createElement('span');
      labelSpan.textContent = grp.name;
      grpTag.append(dot, labelSpan);
      metaRow.appendChild(grpTag);
    }

    info.appendChild(titleRow);
    info.appendChild(metaRow);
    left.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'ext-actions';

    // Compact Group Assignment Dropdown
    const groupPickerWrap = document.createElement('div');
    groupPickerWrap.className = 'group-picker-dropdown';
    const groupPickerBtn = document.createElement('button');
    groupPickerBtn.type = 'button';
    groupPickerBtn.className = 'icon-btn';
    groupPickerBtn.title = 'Assign groups to this extension';
    groupPickerBtn.textContent = '🏷';
    groupPickerBtn.style.fontSize = '12px';

    const groupMenu = document.createElement('div');
    groupMenu.className = 'group-picker-menu hidden';
    groupMenu.addEventListener('click', (e) => e.stopPropagation());

    for (const grp of orderedGroups) {
      const optLabel = document.createElement('label');
      optLabel.className = 'group-picker-option';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = itemGroups.includes(grp.id);
      const dot = document.createElement('span');
      dot.className = 'group-dot';
      dot.style.backgroundColor = grp.color || '#3b82f6';
      const text = document.createElement('span');
      text.textContent = grp.isDefault ? `${grp.name} (Independent)` : grp.name;

      cb.addEventListener('change', async () => {
        let nextGroups;
        if (grp.isDefault) {
          if (cb.checked) {
            nextGroups = ['default'];
          } else {
            const nonDefault = itemGroups.filter((g) => g !== 'default');
            nextGroups = nonDefault.length > 0 ? nonDefault : ['default'];
          }
        } else {
          const baseNonDefault = itemGroups.filter((g) => g !== 'default');
          if (cb.checked) {
            nextGroups = Array.from(new Set([...baseNonDefault, grp.id]));
          } else {
            const remaining = baseNonDefault.filter((g) => g !== grp.id);
            nextGroups = remaining.length > 0 ? remaining : ['default'];
          }
        }

        try {
          const res = await sendMessage({
            type: 'SET_EXTENSION_GROUPS',
            key: item.key,
            groupIds: nextGroups
          });
          currentState = res.data;
          renderDashboard();
        } catch (err) {
          showToast(err.message, true);
        }
      });

      optLabel.append(cb, dot, text);
      groupMenu.appendChild(optLabel);
    }

    groupPickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasHidden = groupMenu.classList.contains('hidden');
      for (const openMenu of document.querySelectorAll('.install-dropdown-menu, .group-picker-menu')) {
        openMenu.classList.add('hidden');
      }
      if (wasHidden) {
        const rect = groupPickerBtn.getBoundingClientRect();
        if (rect.bottom + 140 > window.innerHeight) {
          groupMenu.classList.add('drop-up');
        } else {
          groupMenu.classList.remove('drop-up');
        }
        groupMenu.classList.remove('hidden');
      }
    });

    groupPickerWrap.append(groupPickerBtn, groupMenu);
    actions.appendChild(groupPickerWrap);

    if (item.storeInfo?.url) {
      const storeBtn = document.createElement('button');
      storeBtn.className = 'btn btn-sm btn-secondary';
      storeBtn.textContent = 'Store ↗';
      storeBtn.title = `Open store page in ${item.storeInfo?.storeName || 'Browser Store'}`;
      storeBtn.addEventListener('click', () => {
        ext.tabs.create({ url: item.storeInfo.url });
      });
      actions.appendChild(storeBtn);
    }

    if (item.status === 'missing') {
      const dropdownWrap = document.createElement('div');
      dropdownWrap.className = 'install-dropdown';

      const installTriggerBtn = document.createElement('button');
      installTriggerBtn.type = 'button';
      installTriggerBtn.className = 'btn btn-sm btn-accent';
      installTriggerBtn.textContent = 'Install ▾';
      installTriggerBtn.title = 'Choose how to install this extension';

      const menu = document.createElement('div');
      menu.className = 'install-dropdown-menu hidden';

      const autoInstallOpt = document.createElement('button');
      autoInstallOpt.type = 'button';
      autoInstallOpt.className = 'install-dropdown-item';
      autoInstallOpt.title =
        'Install this extension directly from the official browser store (Chrome Web Store / Firefox AMO)';
      const autoTitle = document.createElement('strong');
      autoTitle.textContent = 'Auto Install';
      const autoSub = document.createElement('span');
      autoSub.textContent = 'From Browser Store / AMO';
      autoInstallOpt.append(autoTitle, autoSub);

      autoInstallOpt.addEventListener('click', async (e) => {
        e.stopPropagation();
        menu.classList.add('hidden');
        try {
          installTriggerBtn.disabled = true;
          await sendMessage({
            type: 'AUTO_INSTALL_EXTENSION',
            item
          });
        } catch (err) {
          showToast(err.message, true);
        } finally {
          installTriggerBtn.disabled = false;
        }
      });

      menu.appendChild(autoInstallOpt);

      const isFirefox = currentState?.browserEnv?.family === 'firefox';
      if (isFirefox && availableXpiByKey[item.key]) {
        const fileInstallOpt = document.createElement('button');
        fileInstallOpt.type = 'button';
        fileInstallOpt.className = 'install-dropdown-item';
        fileInstallOpt.title =
          'Install this extension from its .xpi package in your configured Git repository (xpi-files/)';
        const fileTitle = document.createElement('strong');
        fileTitle.textContent = 'Auto Install from File';
        const fileSub = document.createElement('span');
        fileSub.textContent = 'From Git repo xpi-files/';
        fileInstallOpt.append(fileTitle, fileSub);

        fileInstallOpt.addEventListener('click', async (e) => {
          e.stopPropagation();
          menu.classList.add('hidden');
          try {
            installTriggerBtn.disabled = true;
            await sendMessage({
              type: 'AUTO_INSTALL_FROM_FILE',
              item
            });
          } catch (err) {
            showToast(err.message, true);
          } finally {
            installTriggerBtn.disabled = false;
          }
        });

        menu.appendChild(fileInstallOpt);
      }

      installTriggerBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isFirefox && xpiCheckPromise) {
          await xpiCheckPromise;
        }
        const wasHidden = menu.classList.contains('hidden');
        for (const openMenu of document.querySelectorAll('.install-dropdown-menu, .group-picker-menu')) {
          openMenu.classList.add('hidden');
        }
        if (wasHidden) {
          const rect = installTriggerBtn.getBoundingClientRect();
          if (rect.bottom + 100 > window.innerHeight) {
            menu.classList.add('drop-up');
          } else {
            menu.classList.remove('drop-up');
          }
          menu.classList.remove('hidden');
        }
      });

      dropdownWrap.append(installTriggerBtn, menu);
      actions.appendChild(dropdownWrap);
    } else if (item.localId) {
      // Enable/Disable Switch
      const label = document.createElement('label');
      label.className = 'switch';
      label.title = item.localEnabled ? 'Enabled (Click to disable)' : 'Disabled (Click to enable)';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(item.localEnabled);
      input.disabled = !item.mayDisable;
      input.addEventListener('change', async () => {
        try {
          const res = await sendMessage({
            type: 'TOGGLE_LOCAL_EXTENSION',
            id: item.localId,
            key: item.key,
            enabled: input.checked
          });
          currentState = res.data;
          renderDashboard();
        } catch (err) {
          input.checked = !input.checked;
          showToast(err.message, true);
        }
      });

      const slider = document.createElement('span');
      slider.className = 'slider';
      label.appendChild(input);
      label.appendChild(slider);
      actions.appendChild(label);
    }

    // Ignore / Unignore button
    const ignoreBtn = document.createElement('button');
    ignoreBtn.className = 'icon-btn';
    ignoreBtn.title =
      item.status === 'ignored'
        ? 'Include in cross-browser sync'
        : 'Exclude/ignore this extension from sync';
    ignoreBtn.textContent = item.status === 'ignored' ? '＋' : '⊘';
    ignoreBtn.addEventListener('click', async () => {
      try {
        const res = await sendMessage({
          type: 'TOGGLE_IGNORE_KEY',
          key: item.key
        });
        currentState = res.data;
        renderDashboard();
      } catch (err) {
        showToast(err.message, true);
      }
    });
    actions.appendChild(ignoreBtn);

    card.appendChild(left);
    card.appendChild(actions);
    els.extensionsList.appendChild(card);
  }
}

function createFallbackIcon(name) {
  const div = document.createElement('div');
  div.className = 'ext-icon-fallback';
  div.textContent = (name || '?').trim().charAt(0).toUpperCase();
  return div;
}

function createPopupIconElement(item) {
  const cachedIconUrl = getCachedExtensionIconUrl(item);
  const isMozExtUrl = Boolean(item.iconUrl && item.iconUrl.startsWith('moz-extension://'));
  const initialSrc = cachedIconUrl || (!isMozExtUrl ? item.iconUrl : '') || item.iconUrl || '';

  const fallbackAndResolve = (currentEl) => {
    const fb = createFallbackIcon(item.name);
    if (currentEl?.parentNode) {
      currentEl.replaceWith(fb);
    }
    resolveExtensionIconUrl(item)
      .then((resolvedUrl) => {
        if (resolvedUrl && fb.parentNode) {
          const resolvedImg = document.createElement('img');
          resolvedImg.className = 'ext-icon';
          resolvedImg.src = resolvedUrl;
          resolvedImg.alt = '';
          resolvedImg.addEventListener('error', () => {
            if (resolvedImg.parentNode) {
              resolvedImg.replaceWith(createFallbackIcon(item.name));
            }
          });
          fb.replaceWith(resolvedImg);
        }
      })
      .catch(() => {});
    return fb;
  };

  if (initialSrc) {
    const img = document.createElement('img');
    img.className = 'ext-icon';
    img.src = initialSrc;
    img.alt = '';
    img.addEventListener('error', () => {
      fallbackAndResolve(img);
    });
    return img;
  }

  return fallbackAndResolve(null);
}

async function runSync(mode) {
  try {
    els.syncMergeBtn.disabled = true;
    els.syncPushBtn.disabled = true;
    els.syncPullBtn.disabled = true;
    els.syncMergeBtn.classList.add('spinning');

    const res = await sendMessage({ type: 'PERFORM_SYNC', mode });
    currentState = res.data;
    renderDashboard();
    refreshXpiAvailability();

    const s = res.result?.summary;
    if (s) {
      showToast(
        `Synced ${s.totalSynced} extensions (${s.toggledLocally} toggled, ${s.missingCount} missing).`
      );
    } else {
      showToast('Sync completed successfully!');
    }
  } catch (err) {
    showToast(err.message, true);
  } finally {
    els.syncMergeBtn.disabled = false;
    els.syncPushBtn.disabled = false;
    els.syncPullBtn.disabled = false;
    els.syncMergeBtn.classList.remove('spinning');
  }
}

// Event Listeners
els.openOptionsBtn.addEventListener('click', () => {
  ext.runtime.openOptionsPage();
});

els.setupGistBtn.addEventListener('click', () => {
  ext.runtime.openOptionsPage();
});

els.syncMergeBtn.addEventListener('click', () => runSync('merge'));
els.syncPushBtn.addEventListener('click', () => runSync('push'));
els.syncPullBtn.addEventListener('click', () => runSync('pull'));

for (const tabBtn of els.tabs) {
  tabBtn.addEventListener('click', () => {
    for (const t of els.tabs) t.classList.remove('active');
    tabBtn.classList.add('active');
    activeTab = tabBtn.dataset.tab || 'all';
    renderDashboard();
  });
}

els.searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  renderDashboard();
});

document.addEventListener('click', () => {
  for (const openMenu of document.querySelectorAll('.install-dropdown-menu, .group-picker-menu')) {
    openMenu.classList.add('hidden');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    for (const openMenu of document.querySelectorAll('.install-dropdown-menu, .group-picker-menu')) {
      openMenu.classList.add('hidden');
    }
  }
});

els.installAllMissingBtn.addEventListener('click', async () => {
  if (!currentState) return;
  const missing = currentState.comparison.items.filter((i) => i.status === 'missing');
  if (missing.length === 0) return;
  try {
    els.installAllMissingBtn.disabled = true;
    await sendMessage({
      type: 'AUTO_INSTALL_ALL_MISSING',
      items: missing
    });
  } catch (err) {
    showToast(err.message, true);
  } finally {
    els.installAllMissingBtn.disabled = false;
  }
});

// Initial load
(async () => {
  try {
    const res = await sendMessage({ type: 'GET_DASHBOARD_STATE', refreshRemote: false });
    currentState = res.data;
    renderDashboard();
    refreshXpiAvailability();
  } catch (err) {
    showToast(err.message, true);
  }
})();


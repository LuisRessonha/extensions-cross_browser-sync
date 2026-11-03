import { ext } from '../shared/browser-polyfill.js';
import { buildCatalogEntry, formatCatalogEntrySnippet } from '../shared/matcher.js';

let currentState = null;
let activeTab = 'all';
let searchQuery = '';

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
  syncClearBtn: document.getElementById('sync-clear-btn'),
  countAll: document.getElementById('count-all'),
  countMissing: document.getElementById('count-missing'),
  countDiff: document.getElementById('count-diff'),
  countInstalled: document.getElementById('count-installed'),
  countIgnored: document.getElementById('count-ignored'),
  searchInput: document.getElementById('search-input'),
  installAllMissingBtn: document.getElementById('install-all-missing-btn'),
  extensionsList: document.getElementById('extensions-list'),
  catalogJsonModal: document.getElementById('catalog-json-modal'),
  catalogJsonTitle: document.getElementById('catalog-json-title'),
  catalogJsonPre: document.getElementById('catalog-json-pre'),
  closeCatalogJsonBtn: document.getElementById('close-catalog-json-btn'),
  copyCatalogJsonBtn: document.getElementById('copy-catalog-json-btn'),
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

function filterItems(items) {
  return items.filter((item) => {
    if (activeTab === 'all' && item.status === 'ignored') return false;
    if (activeTab === 'installed' && (!item.localId || item.status === 'ignored')) {
      return false;
    }
    if (activeTab === 'state-diff' && item.status !== 'state-diff') return false;
    if (activeTab === 'missing' && item.status !== 'missing') return false;
    if (activeTab === 'ignored' && item.status !== 'ignored') return false;

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchName = (item.name || '').toLowerCase().includes(q);
      const matchKey = (item.key || '').toLowerCase().includes(q);
      if (!matchName && !matchKey) return false;
    }
    return true;
  });
}

function renderDashboard() {
  if (!currentState) return;

  const { browserEnv, localMeta, hasGistConfigured, comparison } = currentState;
  const { counts, items } = comparison;

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

    if (item.iconUrl) {
      const img = document.createElement('img');
      img.className = 'ext-icon';
      img.src = item.iconUrl;
      img.alt = '';
      img.addEventListener('error', () => {
        img.replaceWith(createFallbackIcon(item.name));
      });
      left.appendChild(img);
    } else {
      left.appendChild(createFallbackIcon(item.name));
    }

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

    info.appendChild(titleRow);
    info.appendChild(metaRow);
    left.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'ext-actions';

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
      const autoInstallBtn = document.createElement('button');
      autoInstallBtn.className = 'btn btn-sm btn-accent';
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
          showToast(err.message, true);
        } finally {
          autoInstallBtn.disabled = false;
        }
      });
      actions.appendChild(autoInstallBtn);
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

    // Catalog JSON button
    const catalogBtn = document.createElement('button');
    catalogBtn.className = 'icon-btn';
    catalogBtn.title = 'Show catalog entry JSON snippet';
    catalogBtn.textContent = '{}';
    catalogBtn.addEventListener('click', () => {
      openCatalogJsonModal(item);
    });
    actions.appendChild(catalogBtn);

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

    // Remove from Gist button
    if (item.inGist) {
      const removeGistBtn = document.createElement('button');
      removeGistBtn.className = 'icon-btn';
      removeGistBtn.title = `Remove "${item.name}" from GitHub Gist`;
      removeGistBtn.textContent = '✕';
      removeGistBtn.addEventListener('click', async () => {
        try {
          removeGistBtn.disabled = true;
          const res = await sendMessage({
            type: 'REMOVE_FROM_GIST',
            key: item.key,
            name: item.name
          });
          currentState = res.data;
          renderDashboard();
          showToast(`Removed "${item.name}" from Gist.`);
        } catch (err) {
          removeGistBtn.disabled = false;
          showToast(err.message, true);
        }
      });
      actions.appendChild(removeGistBtn);
    }

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

async function runSync(mode) {
  try {
    els.syncMergeBtn.disabled = true;
    els.syncPushBtn.disabled = true;
    els.syncPullBtn.disabled = true;
    els.syncMergeBtn.classList.add('spinning');

    const res = await sendMessage({ type: 'PERFORM_SYNC', mode });
    currentState = res.data;
    renderDashboard();

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

els.syncClearBtn.addEventListener('click', async () => {
  const confirmed = window.confirm(
    'Clear all saved extension data from your GitHub Gist?'
  );
  if (!confirmed) return;

  try {
    els.syncClearBtn.disabled = true;
    const res = await sendMessage({ type: 'CLEAR_GIST_DATA' });
    currentState = res.data;
    renderDashboard();
    showToast('Cleared all saved extension data from GitHub Gist.');
  } catch (err) {
    showToast(err.message, true);
  } finally {
    els.syncClearBtn.disabled = false;
  }
});

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

async function openCatalogJsonModal(item) {
  const initialEntry = buildCatalogEntry(item);
  els.catalogJsonTitle.textContent = item.name;
  els.catalogJsonPre.textContent = formatCatalogEntrySnippet(initialEntry);
  els.copyCatalogJsonBtn.textContent = 'Copy to Clipboard';
  els.catalogJsonModal.classList.remove('hidden');

  try {
    const res = await sendMessage({
      type: 'RESOLVE_CATALOG_SNIPPET',
      item
    });
    if (res?.snippet && !els.catalogJsonModal.classList.contains('hidden')) {
      els.catalogJsonPre.textContent = res.snippet;
    }
  } catch {
    // Keep initial snippet
  }
}

els.closeCatalogJsonBtn.addEventListener('click', () => {
  els.catalogJsonModal.classList.add('hidden');
});

els.catalogJsonModal.addEventListener('click', (e) => {
  if (e.target === els.catalogJsonModal) {
    els.catalogJsonModal.classList.add('hidden');
  }
});

els.copyCatalogJsonBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.catalogJsonPre.textContent);
    els.copyCatalogJsonBtn.textContent = 'Copied!';
    setTimeout(() => {
      els.copyCatalogJsonBtn.textContent = 'Copy to Clipboard';
    }, 2000);
  } catch (err) {
    showToast(err.message, true);
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
  } catch (err) {
    showToast(err.message, true);
  }
})();


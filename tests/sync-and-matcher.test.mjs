import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCatalogEntry,
  checkRepoXpiAvailabilityForItems,
  findCatalogEntry,
  findMatchingRemoteRecord,
  formatCatalogEntrySnippet,
  getExpectedXpiFilePath,
  getStoreInstallInfo,
  normalizeExtensionName,
  parseAndResolveManualBrowserId,
  parseGitRepoUrl,
  resolveCanonicalKey,
  resolveRepoXpiInstallTarget
} from '../src/shared/matcher.js';
import {
  computeSyncComparison,
  enrichMissingBrowserIds,
  planGroupActivation,
  planSyncExecution
} from '../src/shared/sync-engine.js';
import { createEmptySyncPayload } from '../src/shared/gist.js';
import {
  DEFAULT_GROUPS,
  normalizeExtensionGroupsList,
  normalizeGroupsMap
} from '../src/shared/storage.js';

test('normalizeExtensionName strips browser suffixes, trademarks, and taglines', () => {
  assert.equal(normalizeExtensionName('uBlock Origin™'), 'ublock-origin');
  assert.equal(
    normalizeExtensionName('SponsorBlock for YouTube - Skip Sponsorships'),
    'sponsorblock-for-youtube'
  );
  assert.equal(
    resolveCanonicalKey({ name: 'Bitwarden - Free Password Manager' }),
    'bitwarden'
  );
  assert.equal(
    normalizeExtensionName('Bitwarden - Free Password Manager (for Firefox)'),
    'bitwarden'
  );
});

test('findCatalogEntry bridges Chromium ID and Firefox GUID for known extensions', () => {
  const fromChrome = findCatalogEntry({
    id: 'nngceckbapebfimnlniiiahkandclblb',
    name: 'Bitwarden Password Manager'
  });
  const fromFirefox = findCatalogEntry({
    id: '{446900e4-71c2-419f-a6a7-df9c091e268b}',
    name: 'Bitwarden Password Manager'
  });

  assert.ok(fromChrome);
  assert.ok(fromFirefox);
  assert.equal(fromChrome.key, 'bitwarden');
  assert.equal(fromChrome.key, fromFirefox.key);
  assert.equal(fromChrome.firefoxSlug, 'bitwarden-password-manager');
});

test('findMatchingRemoteRecord pairs uncataloged extensions across Chrome and Firefox via name or homepage', () => {
  const remoteExtensions = {
    'custom-tab-helper': {
      key: 'custom-tab-helper',
      name: 'Custom Tab Helper for Chrome',
      homepageUrl: 'https://github.com/example/custom-tab-helper',
      enabled: true,
      ids: {
        chromium: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      }
    }
  };

  const firefoxLocalExt = {
    id: 'custom-tab-helper@example.org',
    name: 'Custom Tab Helper for Firefox',
    homepageUrl: 'https://github.com/example/custom-tab-helper/',
    enabled: false
  };

  const match = findMatchingRemoteRecord(firefoxLocalExt, remoteExtensions, 'firefox', {});
  assert.ok(match);
  assert.equal(match.key, 'custom-tab-helper');
});

test('getStoreInstallInfo returns direct store URLs for Chromium and Firefox when IDs/slugs are known', () => {
  const bitwardenRecord = {
    key: 'bitwarden',
    name: 'Bitwarden Password Manager',
    ids: {
      chromium: 'nngceckbapebfimnlniiiahkandclblb',
      firefox: '{446900e4-71c2-419f-a6a7-df9c091e268b}'
    }
  };

  const chromeStore = getStoreInstallInfo(bitwardenRecord, 'chromium', 'chrome');
  assert.equal(chromeStore.isDirect, true);
  assert.equal(
    chromeStore.url,
    'https://chromewebstore.google.com/detail/nngceckbapebfimnlniiiahkandclblb'
  );

  const ffStore = getStoreInstallInfo(bitwardenRecord, 'firefox', 'firefox');
  assert.equal(ffStore.isDirect, true);
  assert.equal(ffStore.url, 'https://addons.mozilla.org/firefox/addon/bitwarden-password-manager/');
});

test('planSyncExecution and computeSyncComparison sync state between Chrome and Firefox', () => {
  const defaultSettings = {
    deviceId: 'dev_chrome_1',
    deviceName: 'Chrome Desktop',
    syncDisabledExtensions: true,
    includeDevelopmentExtensions: false,
    ignoredKeys: [],
    customMappings: {}
  };

  // Step 1: Chrome pushes Bitwarden (enabled) and Dark Reader (disabled)
  const chromeInstalled = [
    {
      id: 'nngceckbapebfimnlniiiahkandclblb',
      name: 'Bitwarden Password Manager',
      enabled: true,
      version: '2026.1.0'
    },
    {
      id: 'eimadpbcbfnmbkopoojfekhnkhdbieeh',
      name: 'Dark Reader',
      enabled: false,
      version: '4.9.88'
    }
  ];

  const pushPlan = planSyncExecution({
    localExtensions: chromeInstalled,
    remotePayload: createEmptySyncPayload(),
    browserEnv: { family: 'chromium', brand: 'chrome', label: 'Chrome' },
    settings: defaultSettings,
    localMeta: { updatedAtByKey: {} },
    mode: 'push'
  });

  assert.equal(pushPlan.remoteChanged, true);
  assert.ok(pushPlan.nextPayload.extensions['bitwarden']);
  assert.equal(pushPlan.nextPayload.extensions['bitwarden'].enabled, true);
  assert.equal(
    pushPlan.nextPayload.extensions['bitwarden'].ids.firefox,
    '{446900e4-71c2-419f-a6a7-df9c091e268b}'
  );
  assert.equal(pushPlan.nextPayload.extensions['dark-reader'].enabled, false);

  // Step 2: Firefox has Dark Reader installed (currently enabled=true) and does NOT have Bitwarden installed yet
  const firefoxInstalled = [
    {
      id: 'addon@darkreader.org',
      name: 'Dark Reader',
      enabled: true,
      mayDisable: true,
      version: '4.9.88'
    },
    {
      id: 'firefox-only@addon.org',
      name: 'Multi-Account Containers',
      enabled: true,
      mayDisable: true,
      version: '8.1.3'
    }
  ];

  const ffEnv = { family: 'firefox', brand: 'firefox', label: 'Firefox' };
  const comparison = computeSyncComparison({
    localExtensions: firefoxInstalled,
    remotePayload: pushPlan.nextPayload,
    browserEnv: ffEnv,
    settings: defaultSettings,
    localMeta: { updatedAtByKey: {} }
  });

  assert.equal(comparison.counts.stateDiff, 1); // Dark Reader is ON locally, OFF in cloud
  assert.equal(comparison.counts.missingInLocal, 1); // Bitwarden is missing on Firefox
  assert.equal(comparison.counts.localOnly, 1); // Multi-Account Containers is local-only on Firefox

  // Step 3: Firefox runs bidirectional merge sync
  // Since Dark Reader has a newer remote timestamp than Firefox's empty localMeta, Dark Reader should be toggled OFF on Firefox,
  // and Multi-Account Containers should be added to the merged cloud payload!
  const mergePlan = planSyncExecution({
    localExtensions: firefoxInstalled,
    remotePayload: pushPlan.nextPayload,
    browserEnv: ffEnv,
    settings: defaultSettings,
    localMeta: { updatedAtByKey: {} },
    mode: 'merge'
  });

  assert.equal(mergePlan.localToggleActions.length, 1);
  assert.equal(mergePlan.localToggleActions[0].id, 'addon@darkreader.org');
  assert.equal(mergePlan.localToggleActions[0].targetEnabled, false);
  assert.ok(mergePlan.nextPayload.extensions['multi-account-containers']);
  assert.ok(mergePlan.nextPayload.extensions['bitwarden']);
  assert.equal(mergePlan.missingExtensions.length, 1);
  assert.equal(mergePlan.missingExtensions[0].key, 'bitwarden');
});

test('parseAndResolveManualBrowserId extracts IDs from raw strings or full store URLs', async () => {
  const crFromUrl = await parseAndResolveManualBrowserId(
    'https://chromewebstore.google.com/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm',
    'chromium'
  );
  assert.equal(crFromUrl.id, 'cjpalhdlnbpafiamejdnhcphjbkeiagm');
  assert.equal(
    crFromUrl.storeUrl,
    'https://chromewebstore.google.com/detail/cjpalhdlnbpafiamejdnhcphjbkeiagm'
  );

  const crRaw = await parseAndResolveManualBrowserId(
    'eimadpbcbfnmbkopoojfekhnkhdbieeh',
    'chromium'
  );
  assert.equal(crRaw.id, 'eimadpbcbfnmbkopoojfekhnkhdbieeh');
});

test('enrichMissingBrowserIds populates missing Chromium and Firefox IDs from catalog and custom overrides', async () => {
  const extensionsMap = {
    bitwarden: {
      key: 'bitwarden',
      name: 'Bitwarden Password Manager',
      ids: { firefox: '{446900e4-71c2-419f-a6a7-df9c091e268b}' },
      storeUrls: {}
    },
    'my-custom-ext': {
      key: 'my-custom-ext',
      name: 'My Custom Ext',
      ids: {},
      storeUrls: {}
    }
  };

  const settings = {
    customBrowserIds: {
      'my-custom-ext': {
        chromium: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        firefox: 'my-custom-ext@example.org'
      }
    }
  };

  const changed = await enrichMissingBrowserIds(extensionsMap, settings);
  assert.equal(changed, true);
  assert.equal(
    extensionsMap['bitwarden'].ids.chromium,
    'nngceckbapebfimnlniiiahkandclblb'
  );
  assert.equal(
    extensionsMap['my-custom-ext'].ids.chromium,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );
  assert.equal(
    extensionsMap['my-custom-ext'].ids.firefox,
    'my-custom-ext@example.org'
  );
});

test('buildCatalogEntry and formatCatalogEntrySnippet produce catalog.js snippet format', () => {
  const entry = buildCatalogEntry({
    key: 'bitwarden',
    name: 'Bitwarden Password Manager',
    ids: {
      chromium: 'nngceckbapebfimnlniiiahkandclblb',
      edge: 'jbkfoedolllekgbhcbcoahefnbanhhlh',
      firefox: '{446900e4-71c2-419f-a6a7-df9c091e268b}'
    }
  });

  const snippet = formatCatalogEntrySnippet(entry);
  assert.equal(
    snippet,
    `  {
    key: 'bitwarden',
    name: 'Bitwarden Password Manager',
    aliases: ['Bitwarden - Free Password Manager', 'Bitwarden'],
    chromiumId: 'nngceckbapebfimnlniiiahkandclblb',
    edgeId: 'jbkfoedolllekgbhcbcoahefnbanhhlh',
    firefoxId: '{446900e4-71c2-419f-a6a7-df9c091e268b}',
    firefoxSlug: 'bitwarden-password-manager',
    xpiFile: 'xpi-files/bitwarden.xpi'
  }`
  );
});

test('parseGitRepoUrl and resolveRepoXpiInstallTarget validate git repo settings', async () => {
  assert.deepEqual(
    parseGitRepoUrl('https://github.com/LuisRessonha/extensions-cross_browser-sync'),
    {
      owner: 'LuisRessonha',
      repo: 'extensions-cross_browser-sync',
      branch: ''
    }
  );
  assert.deepEqual(
    parseGitRepoUrl('LuisRessonha/extensions-cross_browser-sync', 'main'),
    {
      owner: 'LuisRessonha',
      repo: 'extensions-cross_browser-sync',
      branch: 'main'
    }
  );

  await assert.rejects(
    () => resolveRepoXpiInstallTarget({ key: 'ublock-origin', name: 'uBlock Origin' }, {}),
    /Git repository not configured/
  );

  assert.equal(
    getExpectedXpiFilePath({ key: 'bitwarden', name: 'Bitwarden Password Manager' }),
    'xpi-files/bitwarden.xpi'
  );

  // Without repo URL or token, checkRepoXpiAvailabilityForItems returns empty object
  const emptyAvail = await checkRepoXpiAvailabilityForItems(
    [{ key: 'bitwarden', name: 'Bitwarden Password Manager' }],
    {}
  );
  assert.deepEqual(emptyAvail, {});
});

test('planSyncExecution and computeSyncComparison track ignored extensions in Gist payload across browsers', () => {
  const chromeSettings = {
    deviceId: 'dev_chrome_1',
    deviceName: 'Chrome Desktop',
    syncDisabledExtensions: true,
    includeDevelopmentExtensions: false,
    ignoredKeys: ['dark-reader'],
    customMappings: {}
  };

  const chromeInstalled = [
    {
      id: 'cjpalhdlnbpafiamejdnhcphjbkeiagm',
      name: 'uBlock Origin',
      enabled: true,
      version: '1.60.0'
    },
    {
      id: 'eimadpbcbfnmbkopoojfekhnkhdbieeh',
      name: 'Dark Reader',
      enabled: true,
      version: '4.9.88'
    }
  ];

  const pushPlan = planSyncExecution({
    localExtensions: chromeInstalled,
    remotePayload: createEmptySyncPayload(),
    browserEnv: { family: 'chromium', brand: 'chrome', label: 'Chrome' },
    settings: chromeSettings,
    localMeta: { updatedAtByKey: {} },
    mode: 'push'
  });

  // Dark Reader is tracked in the Gist payload with `ignored: true` and in `ignoredKeys`
  assert.deepEqual(pushPlan.nextPayload.ignoredKeys, ['dark-reader']);
  assert.equal(pushPlan.nextPayload.extensions['dark-reader']?.ignored, true);
  assert.equal(pushPlan.nextPayload.extensions['ublock-origin']?.ignored, false);

  // On Firefox (where local settings.ignoredKeys is still empty before sync), computeSyncComparison
  // reads ignored state from the Gist payload so Dark Reader is recognized as ignored!
  const ffComparison = computeSyncComparison({
    localExtensions: [],
    remotePayload: pushPlan.nextPayload,
    browserEnv: { family: 'firefox', brand: 'firefox', label: 'Firefox' },
    settings: {
      deviceId: 'dev_ff_1',
      deviceName: 'Firefox',
      syncDisabledExtensions: true,
      includeDevelopmentExtensions: false,
      ignoredKeys: [],
      customMappings: {}
    },
    localMeta: { updatedAtByKey: {} }
  });

  assert.equal(ffComparison.counts.ignored, 1);
  assert.equal(ffComparison.counts.missingInLocal, 1); // Only uBlock Origin is missing; Dark Reader is ignored
  const ignoredItem = ffComparison.items.find((i) => i.key === 'dark-reader');
  assert.equal(ignoredItem?.status, 'ignored');
});

test('equivalentAlternative flag and alternativeName propagate across sync comparison and catalog snippets', () => {
  const settings = {
    deviceId: 'dev_cr_1',
    deviceName: 'Chrome',
    syncDisabledExtensions: true,
    includeDevelopmentExtensions: false,
    ignoredKeys: [],
    customMappings: {},
    customBrowserIds: {
      'chrome-only-tab-manager': {
        chromium: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        firefox: 'simple-tab-groups@drive4ik',
        firefoxUrl: 'https://addons.mozilla.org/firefox/addon/simple-tab-groups/',
        equivalentAlternative: true,
        alternativeName: 'Simple Tab Groups'
      }
    }
  };

  const localInstalled = [
    {
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'Chrome Only Tab Manager',
      enabled: true,
      version: '2.1.0'
    }
  ];

  const comparison = computeSyncComparison({
    localExtensions: localInstalled,
    remotePayload: createEmptySyncPayload(),
    browserEnv: { family: 'chromium', brand: 'chrome', label: 'Chrome' },
    settings,
    localMeta: { updatedAtByKey: {} }
  });

  assert.equal(comparison.items.length, 1);
  const item = comparison.items[0];
  assert.equal(item.equivalentAlternative, true);
  assert.equal(item.alternativeName, 'Simple Tab Groups');
  assert.equal(item.ids.firefox, 'simple-tab-groups@drive4ik');

  const catalogEntry = buildCatalogEntry(item);
  assert.equal(catalogEntry.equivalentAlternative, true);
  assert.equal(catalogEntry.alternativeName, 'Simple Tab Groups');
  assert.ok(catalogEntry.aliases.includes('Simple Tab Groups'));
  const snippet = formatCatalogEntrySnippet(catalogEntry);
  assert.ok(snippet.includes('equivalentAlternative: true,'));
  assert.ok(snippet.includes("alternativeName: 'Simple Tab Groups',"));
});

test('new or ungrouped extensions automatically belong to the default group', () => {
  const groupsMap = normalizeGroupsMap({
    ...DEFAULT_GROUPS,
    gaming: { id: 'gaming', name: 'Gaming', color: '#ec4899' }
  });

  assert.deepEqual(normalizeExtensionGroupsList(undefined, groupsMap), ['default']);
  assert.deepEqual(normalizeExtensionGroupsList([], groupsMap), ['default']);
  assert.deepEqual(normalizeExtensionGroupsList(['non-existent'], groupsMap), ['default']);
  assert.deepEqual(normalizeExtensionGroupsList(['work', 'gaming'], groupsMap), [
    'work',
    'gaming'
  ]);
});

test('planGroupActivation supports exclusive vs multiple activation and leaves default & ignored extensions untouched', () => {
  const groups = normalizeGroupsMap({
    ...DEFAULT_GROUPS,
    gaming: { id: 'gaming', name: 'Gaming', color: '#ec4899' }
  });

  const localInstalled = [
    {
      id: 'nngceckbapebfimnlniiiahkandclblb',
      name: 'Bitwarden Password Manager',
      enabled: true,
      mayDisable: true
    },
    {
      id: 'cjpalhdlnbpafiamejdnhcphjbkeiagm',
      name: 'uBlock Origin',
      enabled: false,
      mayDisable: true
    },
    {
      id: 'fmkadmapgofadopljbjfkapdkoienihi',
      name: 'React Developer Tools',
      enabled: false,
      mayDisable: true
    },
    {
      id: 'dbepggeogbaibhgnhhndojpepiihcmeb',
      name: 'Vimium',
      enabled: false,
      mayDisable: true
    },
    {
      id: 'eimadpbcbfnmbkopoojfekhnkhdbieeh',
      name: 'Dark Reader',
      enabled: true,
      mayDisable: true
    }
  ];

  // Bitwarden & uBlock Origin are in 'default' (one enabled, one disabled -> both must stay untouched)
  // React DevTools is in ['work']
  // Vimium is in ['work', 'personal']
  // Dark Reader is in ['fun', 'gaming']
  const baseSettings = {
    groups,
    extensionGroups: {
      bitwarden: ['default'],
      'ublock-origin': ['default'],
      'react-developer-tools': ['work'],
      vimium: ['work', 'personal'],
      'dark-reader': ['fun', 'gaming']
    },
    activeGroupIds: [],
    exclusiveGroupActivation: true,
    ignoredKeys: []
  };

  // 1. Activate 'work' in exclusive mode
  const workPlan = planGroupActivation({
    localExtensions: localInstalled,
    settings: baseSettings,
    groupId: 'work',
    active: true
  });

  assert.deepEqual(workPlan.nextActiveGroupIds, ['work']);
  assert.deepEqual(workPlan.untouchedDefaultKeys.sort(), ['bitwarden', 'ublock-origin']);
  assert.equal(workPlan.targetStatesByKey['react-developer-tools'], true);
  assert.equal(workPlan.targetStatesByKey['vimium'], true);
  assert.equal(workPlan.targetStatesByKey['dark-reader'], false);
  // React DevTools (was false -> true), Vimium (was false -> true), Dark Reader (was true -> false)
  assert.equal(workPlan.localToggleActions.length, 3);

  // 2. Switch to 'fun' in exclusive mode (`exclusiveGroupActivation: true`) -> 'work' is deactivated
  const funExclusivePlan = planGroupActivation({
    localExtensions: localInstalled,
    settings: { ...baseSettings, activeGroupIds: ['work'] },
    groupId: 'fun',
    active: true
  });

  assert.deepEqual(funExclusivePlan.nextActiveGroupIds, ['fun']);
  assert.equal(funExclusivePlan.targetStatesByKey['react-developer-tools'], false);
  assert.equal(funExclusivePlan.targetStatesByKey['vimium'], false);
  assert.equal(funExclusivePlan.targetStatesByKey['dark-reader'], true);

  // 3. Activate 'fun' while 'work' is active in multiple mode (`exclusiveGroupActivation: false`)
  const multiPlan = planGroupActivation({
    localExtensions: localInstalled,
    settings: {
      ...baseSettings,
      activeGroupIds: ['work'],
      exclusiveGroupActivation: false
    },
    groupId: 'fun',
    active: true
  });

  assert.deepEqual(multiPlan.nextActiveGroupIds, ['work', 'fun']);
  assert.equal(multiPlan.targetStatesByKey['react-developer-tools'], true);
  assert.equal(multiPlan.targetStatesByKey['vimium'], true);
  assert.equal(multiPlan.targetStatesByKey['dark-reader'], true);
});

test('planSyncExecution respects syncActiveGroupsToGist setting (local vs Gist activeGroupIds)', () => {
  const remotePayload = {
    ...createEmptySyncPayload(),
    activeGroupIds: ['fun']
  };

  const localInstalled = [
    {
      id: 'nngceckbapebfimnlniiiahkandclblb',
      name: 'Bitwarden Password Manager',
      enabled: true
    }
  ];

  // Case 1: syncActiveGroupsToGist = true -> pushes local activeGroupIds ['work'] to Gist
  const syncedPlan = planSyncExecution({
    localExtensions: localInstalled,
    remotePayload,
    browserEnv: { family: 'chromium', brand: 'chrome', label: 'Chrome' },
    settings: {
      deviceId: 'dev_1',
      syncDisabledExtensions: true,
      syncActiveGroupsToGist: true,
      activeGroupIds: ['work'],
      extensionGroups: { bitwarden: ['default'] }
    },
    localMeta: { updatedAtByKey: {} },
    mode: 'push'
  });
  assert.deepEqual(syncedPlan.nextPayload.activeGroupIds, ['work']);

  // Case 2: syncActiveGroupsToGist = false -> keeps remote payload's activeGroupIds untouched
  const localOnlyPlan = planSyncExecution({
    localExtensions: localInstalled,
    remotePayload,
    browserEnv: { family: 'chromium', brand: 'chrome', label: 'Chrome' },
    settings: {
      deviceId: 'dev_1',
      syncDisabledExtensions: true,
      syncActiveGroupsToGist: false,
      activeGroupIds: ['work'],
      extensionGroups: { bitwarden: ['default'] }
    },
    localMeta: { updatedAtByKey: {} },
    mode: 'push'
  });
  assert.deepEqual(localOnlyPlan.nextPayload.activeGroupIds, ['fun']);
});





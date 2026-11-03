import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCatalogEntry,
  findCatalogEntry,
  findMatchingRemoteRecord,
  formatCatalogEntrySnippet,
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
  planSyncExecution
} from '../src/shared/sync-engine.js';
import { createEmptySyncPayload } from '../src/shared/gist.js';

test('normalizeExtensionName strips browser suffixes, trademarks, and taglines', () => {
  assert.equal(normalizeExtensionName('uBlock Origin™'), 'ublock-origin');
  assert.equal(
    normalizeExtensionName('SponsorBlock for YouTube - Skip Sponsorships'),
    'sponsorblock-for-youtube'
  );
  assert.equal(
    resolveCanonicalKey({ name: 'SponsorBlock for YouTube - Skip Sponsorships' }),
    'sponsorblock'
  );
  assert.equal(
    normalizeExtensionName('Bitwarden - Free Password Manager (for Firefox)'),
    'bitwarden'
  );
});

test('findCatalogEntry bridges Chromium ID and Firefox GUID for known extensions', () => {
  const fromChrome = findCatalogEntry({
    id: 'cjpalhdlnbpafiamejdnhcphjbkeiagm',
    name: 'uBlock Origin'
  });
  const fromFirefox = findCatalogEntry({
    id: 'uBlock0@raymondhill.net',
    name: 'uBlock Origin'
  });

  assert.ok(fromChrome);
  assert.ok(fromFirefox);
  assert.equal(fromChrome.key, 'ublock-origin');
  assert.equal(fromChrome.key, fromFirefox.key);
  assert.equal(fromChrome.firefoxSlug, 'ublock-origin');
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
  const ublockRecord = {
    key: 'ublock-origin',
    name: 'uBlock Origin',
    ids: {
      chromium: 'cjpalhdlnbpafiamejdnhcphjbkeiagm',
      firefox: 'uBlock0@raymondhill.net'
    }
  };

  const chromeStore = getStoreInstallInfo(ublockRecord, 'chromium', 'chrome');
  assert.equal(chromeStore.isDirect, true);
  assert.equal(
    chromeStore.url,
    'https://chromewebstore.google.com/detail/cjpalhdlnbpafiamejdnhcphjbkeiagm'
  );

  const ffStore = getStoreInstallInfo(ublockRecord, 'firefox', 'firefox');
  assert.equal(ffStore.isDirect, true);
  assert.equal(ffStore.url, 'https://addons.mozilla.org/firefox/addon/ublock-origin/');
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

  // Step 1: Chrome pushes uBlock Origin (enabled) and Dark Reader (disabled)
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
  assert.ok(pushPlan.nextPayload.extensions['ublock-origin']);
  assert.equal(pushPlan.nextPayload.extensions['ublock-origin'].enabled, true);
  assert.equal(
    pushPlan.nextPayload.extensions['ublock-origin'].ids.firefox,
    'uBlock0@raymondhill.net'
  );
  assert.equal(pushPlan.nextPayload.extensions['dark-reader'].enabled, false);

  // Step 2: Firefox has Dark Reader installed (currently enabled=true) and does NOT have uBlock Origin installed yet
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
  assert.equal(comparison.counts.missingInLocal, 1); // uBlock Origin is missing on Firefox
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
  assert.ok(mergePlan.nextPayload.extensions['ublock-origin']);
  assert.equal(mergePlan.missingExtensions.length, 1);
  assert.equal(mergePlan.missingExtensions[0].key, 'ublock-origin');
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
    'dark-reader': {
      key: 'dark-reader',
      name: 'Dark Reader',
      ids: { firefox: 'addon@darkreader.org' },
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
    extensionsMap['dark-reader'].ids.chromium,
    'eimadpbcbfnmbkopoojfekhnkhdbieeh'
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
});



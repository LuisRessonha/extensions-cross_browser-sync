import { KNOWN_EXTENSIONS_CATALOG } from './catalog.js';

/**
 * Normalizes an extension title for cross-browser comparison.
 * Strips trademarks, browser-specific suffixes ("for Chrome", "for Firefox"),
 * and collapses punctuation/whitespace into a lowercase slug.
 *
 * @param {string} rawName
 * @returns {string}
 */
export function normalizeExtensionName(rawName) {
  if (!rawName || typeof rawName !== 'string') return '';

  let cleaned = rawName
    .replace(/[™®©]/g, '')
    .replace(/\b(for|on)\s+(google\s+chrome|chrome|firefox|microsoft\s+edge|edge|brave|opera|browsers?)\b/gi, '')
    .replace(/\([^)]*\)/g, ' ')
    .trim();

  // Also strip trailing tagline after em-dash, en-dash, colon, or spaced hyphen if the prefix is >= 3 chars
  const parts = cleaned.split(/\s+[-–—:]\s+|\s*:\s+/);
  if (parts[0] && parts[0].trim().length >= 3) {
    cleaned = parts[0].trim();
  }

  return cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Normalizes a homepage URL for comparison across browsers.
 * @param {string} url
 * @returns {string}
 */
export function normalizeHomepageUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    // Ignore store URLs themselves as homepages
    if (
      parsed.hostname.includes('chrome.google.com') ||
      parsed.hostname.includes('chromewebstore.google.com') ||
      parsed.hostname.includes('addons.mozilla.org') ||
      parsed.hostname.includes('microsoftedge.microsoft.com')
    ) {
      return '';
    }
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Checks whether an ID looks like a standard 32-character Chromium extension ID (a-p).
 * @param {string} id
 * @returns {boolean}
 */
export function isChromiumExtensionId(id) {
  return typeof id === 'string' && /^[a-p]{32}$/.test(id);
}

/**
 * Finds a matching entry in KNOWN_EXTENSIONS_CATALOG by ID or normalized name.
 * @param {{ id?: string, name?: string, key?: string }} info
 * @returns {object | null}
 */
export function findCatalogEntry(info) {
  if (!info) return null;

  if (info.key) {
    const byKey = KNOWN_EXTENSIONS_CATALOG.find((c) => c.key === info.key);
    if (byKey) return byKey;
  }

  if (info.id) {
    const byId = KNOWN_EXTENSIONS_CATALOG.find(
      (c) => c.chromiumId === info.id || c.edgeId === info.id || c.firefoxId === info.id
    );
    if (byId) return byId;
  }

  if (info.name) {
    const norm = normalizeExtensionName(info.name);
    if (norm) {
      const byName = KNOWN_EXTENSIONS_CATALOG.find((c) => {
        if (c.key === norm || normalizeExtensionName(c.name) === norm) return true;
        if (Array.isArray(c.aliases)) {
          return c.aliases.some((alias) => normalizeExtensionName(alias) === norm);
        }
        return false;
      });
      if (byName) return byName;
    }
  }

  return null;
}

/**
 * Determines the canonical cross-browser key for an installed extension.
 *
 * @param {{ id: string, name: string, homepageUrl?: string }} extInfo
 * @param {Record<string, string>} [customMappings={}] Map of local extension ID -> canonical key
 * @returns {string}
 */
export function resolveCanonicalKey(extInfo, customMappings = {}) {
  if (!extInfo) return 'unknown';

  if (extInfo.id && customMappings[extInfo.id]) {
    return customMappings[extInfo.id];
  }

  const catalogEntry = findCatalogEntry(extInfo);
  if (catalogEntry) {
    return catalogEntry.key;
  }

  const slug = normalizeExtensionName(extInfo.name);
  if (slug) {
    return slug;
  }

  return `ext-${extInfo.id}`;
}

/**
 * Finds the matching synced extension record from a remote extensions map for a local extension.
 * Matches by:
 *  1. Custom ID mapping
 *  2. Exact browser-family ID in `record.ids`
 *  3. Canonical key match
 *  4. Normalized name or normalized homepage URL match
 *
 * @param {{ id: string, name: string, homepageUrl?: string }} localExt
 * @param {Record<string, object>} remoteExtensions
 * @param {'chromium' | 'firefox'} browserFamily
 * @param {Record<string, string>} [customMappings={}]
 * @returns {object | null}
 */
export function findMatchingRemoteRecord(
  localExt,
  remoteExtensions,
  browserFamily,
  customMappings = {}
) {
  if (!localExt || !remoteExtensions) return null;

  const entries = Object.values(remoteExtensions);

  // 1. Custom mapping override
  const mappedKey = customMappings[localExt.id];
  if (mappedKey && remoteExtensions[mappedKey]) {
    return remoteExtensions[mappedKey];
  }

  // 2. Match by exact ID stored in remote record
  for (const record of entries) {
    const ids = record.ids || {};
    if (
      ids.chromium === localExt.id ||
      ids.edge === localExt.id ||
      ids.firefox === localExt.id
    ) {
      return record;
    }
  }

  // 3. Match by canonical key
  const canonicalKey = resolveCanonicalKey(localExt, customMappings);
  if (remoteExtensions[canonicalKey]) {
    return remoteExtensions[canonicalKey];
  }

  // 4. Match by normalized name or homepage URL
  const localNormName = normalizeExtensionName(localExt.name);
  const localHomepage = normalizeHomepageUrl(localExt.homepageUrl);

  for (const record of entries) {
    const remoteNormName = normalizeExtensionName(record.name);
    if (localNormName && remoteNormName && localNormName === remoteNormName) {
      return record;
    }
    if (localHomepage) {
      const remoteHomepage = normalizeHomepageUrl(record.homepageUrl);
      if (remoteHomepage && localHomepage === remoteHomepage) {
        return record;
      }
    }
  }

  return null;
}

/**
 * Builds the best 1-click store installation URL (and whether it is a direct detail page or search fallback)
 * for a synced extension record in the current target browser.
 *
 * @param {object} record Synced extension record
 * @param {'chromium' | 'firefox'} targetFamily
 * @param {string} [targetBrand='chrome']
 * @returns {{ url: string, isDirect: boolean, storeName: string }}
 */
export function getStoreInstallInfo(record, targetFamily, targetBrand = 'chrome') {
  const catalogEntry = findCatalogEntry({
    key: record?.key,
    name: record?.name,
    id: record?.ids?.chromium || record?.ids?.firefox || record?.ids?.edge
  });

  if (targetFamily === 'firefox') {
    const storeName = 'Firefox Add-ons';
    if (record?.storeUrls?.firefox) {
      return { url: record.storeUrls.firefox, isDirect: true, storeName };
    }
    if (catalogEntry?.firefoxSlug) {
      return {
        url: `https://addons.mozilla.org/firefox/addon/${catalogEntry.firefoxSlug}/`,
        isDirect: true,
        storeName
      };
    }
    const ffId = record?.ids?.firefox || catalogEntry?.firefoxId;
    if (ffId) {
      return {
        url: `https://addons.mozilla.org/firefox/addon/${encodeURIComponent(ffId)}/`,
        isDirect: true,
        storeName
      };
    }
    return {
      url: `https://addons.mozilla.org/firefox/search/?q=${encodeURIComponent(record?.name || record?.key || '')}`,
      isDirect: false,
      storeName
    };
  }

  // Chromium family (Chrome, Brave, Edge, Vivaldi, Opera)
  const chromiumId = record?.ids?.chromium || catalogEntry?.chromiumId;
  const edgeId = record?.ids?.edge || catalogEntry?.edgeId;

  if (targetBrand === 'edge' && edgeId && !chromiumId) {
    return {
      url: `https://microsoftedge.microsoft.com/addons/detail/${edgeId}`,
      isDirect: true,
      storeName: 'Edge Add-ons'
    };
  }

  if (record?.storeUrls?.chromium) {
    return {
      url: record.storeUrls.chromium,
      isDirect: true,
      storeName: 'Chrome Web Store'
    };
  }

  if (chromiumId && isChromiumExtensionId(chromiumId)) {
    return {
      url: `https://chromewebstore.google.com/detail/${chromiumId}`,
      isDirect: true,
      storeName: 'Chrome Web Store'
    };
  }

  if (edgeId && isChromiumExtensionId(edgeId)) {
    return {
      url: `https://microsoftedge.microsoft.com/addons/detail/${edgeId}`,
      isDirect: true,
      storeName: 'Edge Add-ons'
    };
  }

  return {
    url: `https://chromewebstore.google.com/search/${encodeURIComponent(record?.name || record?.key || '')}`,
    isDirect: false,
    storeName: 'Chrome Web Store'
  };
}

/**
 * Queries the public Mozilla Add-ons (AMO) REST API v5 to resolve a Firefox add-on GUID and direct page URL
 * for an extension when only its name/homepage is known.
 *
 * @param {{ name: string, homepageUrl?: string }} record
 * @returns {Promise<{ firefoxId: string, firefoxUrl: string } | null>}
 */
export async function resolveFirefoxAddonFromAmo(record) {
  if (!record?.name) return null;
  try {
    const query = encodeURIComponent(record.name);
    const res = await fetch(
      `https://addons.mozilla.org/api/v5/addons/search/?q=${query}&type=extension&page_size=5&lang=en-US`
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data?.results) || data.results.length === 0) return null;

    const targetNorm = normalizeExtensionName(record.name);
    const targetHome = normalizeHomepageUrl(record.homepageUrl);

    for (const item of data.results) {
      const itemName =
        typeof item.name === 'string'
          ? item.name
          : item.name?.['en-US'] || Object.values(item.name || {})[0] || '';
      const itemHome =
        typeof item.homepage?.url === 'string'
          ? item.homepage.url
          : item.homepage?.url?.['en-US'] || '';

      if (
        normalizeExtensionName(itemName) === targetNorm ||
        (targetHome && normalizeHomepageUrl(itemHome) === targetHome)
      ) {
        return {
          firefoxId: item.guid,
          firefoxUrl: item.url
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

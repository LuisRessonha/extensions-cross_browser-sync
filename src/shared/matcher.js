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
      const itemNorm = normalizeExtensionName(itemName);

      if (
        itemNorm === targetNorm ||
        (targetHome && normalizeHomepageUrl(itemHome) === targetHome)
      ) {
        return {
          firefoxId: item.guid,
          firefoxSlug: item.slug || null,
          firefoxUrl: item.url,
          xpiUrl: item.current_version?.file?.url || null
        };
      }
    }

    // Second pass: prefix/substring match on the top AMO search result if targetNorm is >= 4 chars
    if (targetNorm && targetNorm.length >= 4 && data.results[0]) {
      const top = data.results[0];
      const topName =
        typeof top.name === 'string'
          ? top.name
          : top.name?.['en-US'] || Object.values(top.name || {})[0] || '';
      const topNorm = normalizeExtensionName(topName);
      if (topNorm && (topNorm.startsWith(targetNorm) || targetNorm.startsWith(topNorm))) {
        return {
          firefoxId: top.guid,
          firefoxSlug: top.slug || null,
          firefoxUrl: top.url,
          xpiUrl: top.current_version?.file?.url || null
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Attempts to automatically resolve a missing Chromium 32-character Extension ID (`[a-p]{32}`)
 * using the built-in catalog, homepage URL links, or Chrome Web Store search results.
 *
 * @param {{ key?: string, name: string, homepageUrl?: string, description?: string }} record
 * @returns {Promise<{ chromiumId: string, chromiumUrl: string } | null>}
 */
export async function resolveChromiumExtensionFromStore(record) {
  if (!record?.name) return null;

  // 1. Check built-in catalog first
  const catalog = findCatalogEntry({ key: record.key, name: record.name });
  if (catalog?.chromiumId && isChromiumExtensionId(catalog.chromiumId)) {
    return {
      chromiumId: catalog.chromiumId,
      chromiumUrl: `https://chromewebstore.google.com/detail/${catalog.chromiumId}`
    };
  }

  // 2. Check if homepageUrl or description directly contains a Chrome Web Store detail link
  const textToScan = `${record.homepageUrl || ''} ${record.description || ''}`;
  const directMatch = textToScan.match(
    /(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)\/detail\/(?:[^/"'\s?]+\/)?([a-p]{32})/i
  );
  if (directMatch?.[1]) {
    const id = directMatch[1].toLowerCase();
    return {
      chromiumId: id,
      chromiumUrl: `https://chromewebstore.google.com/detail/${id}`
    };
  }

  // 3. Query Chrome Web Store search page and match detail slug against normalized extension name
  try {
    const query = encodeURIComponent(record.name);
    const res = await fetch(`https://chromewebstore.google.com/search/${query}`);
    if (!res.ok) return null;
    const html = await res.text();
    const targetNorm = normalizeExtensionName(record.name);
    if (!targetNorm) return null;

    const regex = /\/detail\/([^/"'\s?]+)\/([a-p]{32})/gi;
    let match;
    let firstCandidate = null;

    while ((match = regex.exec(html)) !== null) {
      const slug = decodeURIComponent(match[1]);
      const id = match[2].toLowerCase();
      const slugNorm = normalizeExtensionName(slug);

      if (!firstCandidate) {
        firstCandidate = { slugNorm, id };
      }

      if (slugNorm === targetNorm) {
        return {
          chromiumId: id,
          chromiumUrl: `https://chromewebstore.google.com/detail/${id}`
        };
      }
    }

    if (
      firstCandidate &&
      targetNorm.length >= 4 &&
      (firstCandidate.slugNorm.startsWith(targetNorm) ||
        targetNorm.startsWith(firstCandidate.slugNorm))
    ) {
      return {
        chromiumId: firstCandidate.id,
        chromiumUrl: `https://chromewebstore.google.com/detail/${firstCandidate.id}`
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Parses a user-entered Browser ID or Store URL for Chromium or Firefox.
 * Allows pasting either a raw ID/GUID or a full Chrome Web Store / Edge Add-ons / Firefox AMO URL.
 *
 * @param {string} rawInput
 * @param {'chromium' | 'firefox'} family
 * @returns {Promise<{ id: string, storeUrl?: string }>}
 */
export async function parseAndResolveManualBrowserId(rawInput, family) {
  const trimmed = (rawInput || '').trim();
  if (!trimmed) {
    return { id: '' };
  }

  if (family === 'chromium') {
    const urlMatch = trimmed.match(/\/detail\/(?:[^/"'\s?]+\/)?([a-p]{32})/i);
    if (urlMatch?.[1]) {
      const id = urlMatch[1].toLowerCase();
      return {
        id,
        storeUrl: `https://chromewebstore.google.com/detail/${id}`
      };
    }
    const cleanId = trimmed.toLowerCase();
    return {
      id: cleanId,
      storeUrl: isChromiumExtensionId(cleanId)
        ? `https://chromewebstore.google.com/detail/${cleanId}`
        : undefined
    };
  }

  // Firefox: check if input is a full AMO URL (e.g. https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/)
  const amoMatch = trimmed.match(/addons\.mozilla\.org\/(?:[^/]+\/)?firefox\/addon\/([^/?#]+)/i);
  const slugOrId = amoMatch?.[1] ? decodeURIComponent(amoMatch[1]) : trimmed;

  try {
    const res = await fetch(
      `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(slugOrId)}/`
    );
    if (res.ok) {
      const data = await res.json();
      if (data?.guid) {
        return {
          id: data.guid,
          storeUrl: data.url || `https://addons.mozilla.org/firefox/addon/${slugOrId}/`
        };
      }
    }
  } catch {
    // Fall back to raw slugOrId
  }

  return {
    id: slugOrId,
    storeUrl: amoMatch
      ? trimmed
      : `https://addons.mozilla.org/firefox/addon/${encodeURIComponent(slugOrId)}/`
  };
}

/**
 * Resolves the most direct automatic installation URL for a missing extension.
 * - On Firefox: resolves the direct `.xpi` package URL via Mozilla AMO API v5 so Firefox
 *   immediately triggers the native extension install prompt without browsing the store page.
 * - On Chromium: resolves the direct store page URL to be opened in a managed auto-closing installer tab.
 *
 * @param {object} record
 * @param {'chromium' | 'firefox'} targetFamily
 * @param {string} [targetBrand='chrome']
 * @returns {Promise<{ installUrl: string, storeUrl: string, isDirectPackage: boolean }>}
 */
export async function resolveDirectInstallTarget(record, targetFamily, targetBrand = 'chrome') {
  const storeInfo = getStoreInstallInfo(record, targetFamily, targetBrand);
  const catalogEntry = findCatalogEntry({
    key: record?.key,
    name: record?.name,
    id: record?.ids?.chromium || record?.ids?.firefox || record?.ids?.edge
  });

  if (targetFamily === 'firefox') {
    let slugOrGuid =
      catalogEntry?.firefoxSlug || record?.ids?.firefox || catalogEntry?.firefoxId || null;

    if (!slugOrGuid && record?.storeUrls?.firefox) {
      const m = record.storeUrls.firefox.match(/\/firefox\/addon\/([^/?#]+)/);
      if (m?.[1]) slugOrGuid = decodeURIComponent(m[1]);
    }

    if (slugOrGuid) {
      try {
        const res = await fetch(
          `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(slugOrGuid)}/`
        );
        if (res.ok) {
          const data = await res.json();
          const xpiUrl = data?.current_version?.file?.url;
          if (xpiUrl) {
            return {
              installUrl: xpiUrl,
              storeUrl: data?.url || storeInfo.url,
              isDirectPackage: true
            };
          }
        }
      } catch {
        // Fall through to latest download path or search
      }

      if (catalogEntry?.firefoxSlug) {
        return {
          installUrl: `https://addons.mozilla.org/firefox/downloads/latest/${catalogEntry.firefoxSlug}/addon-latest.xpi`,
          storeUrl: storeInfo.url,
          isDirectPackage: true
        };
      }
    }

    // Try live AMO search by extension name/homepage
    const amoMatch = await resolveFirefoxAddonFromAmo(record);
    if (amoMatch?.xpiUrl) {
      return {
        installUrl: amoMatch.xpiUrl,
        storeUrl: amoMatch.firefoxUrl || storeInfo.url,
        isDirectPackage: true
      };
    }
    if (amoMatch?.firefoxUrl) {
      return {
        installUrl: amoMatch.firefoxUrl,
        storeUrl: amoMatch.firefoxUrl,
        isDirectPackage: false
      };
    }
  }

  return {
    installUrl: storeInfo.url,
    storeUrl: storeInfo.url,
    isDirectPackage: false
  };
}

/**
 * Extracts a Firefox AMO slug from a URL if present and not a GUID.
 * @param {string} url
 * @returns {string}
 */
function extractFirefoxSlugFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const m = url.match(/addons\.mozilla\.org\/(?:[^/]+\/)?firefox\/addon\/([^/?#]+)/i);
  if (!m?.[1]) return '';
  const candidate = decodeURIComponent(m[1]);
  if (candidate.startsWith('{') || candidate.includes('@')) return '';
  return candidate;
}

/**
 * Builds a structured catalog entry object for an extension item.
 *
 * @param {object} item
 * @param {{ chromiumId?: string, edgeId?: string, firefoxId?: string, firefoxSlug?: string }} [extra={}]
 */
export function buildCatalogEntry(item, extra = {}) {
  const catalog = findCatalogEntry({
    key: item?.key,
    name: item?.name,
    id: item?.localId || item?.ids?.chromium || item?.ids?.firefox || item?.ids?.edge
  });

  const key = item?.key || catalog?.key || resolveCanonicalKey(item || {});
  const name = catalog?.name || item?.name || key;

  const aliasSet = new Set(Array.isArray(catalog?.aliases) ? catalog.aliases : []);
  if (item?.name && item.name !== name) {
    aliasSet.add(item.name);
  }
  if (item?.name) {
    const shortParts = item.name.split(/\s+[-–—:]\s+|\s*:\s+/);
    if (shortParts[0] && shortParts[0].trim().length >= 3 && shortParts[0].trim() !== name) {
      aliasSet.add(shortParts[0].trim());
    }
  }
  const aliases = Array.from(aliasSet);

  const chromiumId =
    extra.chromiumId ||
    item?.ids?.chromium ||
    (isChromiumExtensionId(item?.localId) ? item.localId : '') ||
    catalog?.chromiumId ||
    '';

  const edgeId = extra.edgeId || item?.ids?.edge || catalog?.edgeId || '';

  const firefoxId =
    extra.firefoxId ||
    item?.ids?.firefox ||
    (item?.localId && !isChromiumExtensionId(item.localId) ? item.localId : '') ||
    catalog?.firefoxId ||
    '';

  const firefoxSlug =
    extra.firefoxSlug ||
    catalog?.firefoxSlug ||
    extractFirefoxSlugFromUrl(item?.storeUrls?.firefox) ||
    extractFirefoxSlugFromUrl(item?.storeInfo?.url) ||
    '';

  const safeKey = String(key || 'extension')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const xpiFile =
    extra.xpiFile ||
    catalog?.xpiFile ||
    (safeKey ? `xpi-files/${safeKey}.xpi` : '');

  return {
    key,
    name,
    aliases,
    chromiumId,
    edgeId,
    firefoxId,
    firefoxSlug,
    xpiFile
  };
}

/**
 * Formats a catalog entry object into the exact JavaScript snippet format used in `src/shared/catalog.js`.
 *
 * @param {object} entry
 * @returns {string}
 */
export function formatCatalogEntrySnippet(entry) {
  const esc = (str) => String(str ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const lines = ['  {'];
  lines.push(`    key: '${esc(entry.key)}',`);
  lines.push(`    name: '${esc(entry.name)}',`);
  if (Array.isArray(entry.aliases) && entry.aliases.length > 0) {
    const formattedAliases = entry.aliases.map((a) => `'${esc(a)}'`).join(', ');
    lines.push(`    aliases: [${formattedAliases}],`);
  }
  lines.push(`    chromiumId: '${esc(entry.chromiumId)}',`);
  if (entry.edgeId) {
    lines.push(`    edgeId: '${esc(entry.edgeId)}',`);
  }
  lines.push(`    firefoxId: '${esc(entry.firefoxId)}',`);
  lines.push(`    firefoxSlug: '${esc(entry.firefoxSlug)}',`);
  lines.push(`    xpiFile: '${esc(entry.xpiFile || `xpi-files/${entry.key}.xpi`)}'`);
  lines.push('  }');
  return lines.join('\n');
}

/**
 * Resolves any missing Firefox slug/GUID or Chromium ID from AMO / Chrome Web Store
 * and returns both the structured catalog entry and formatted snippet.
 *
 * @param {object} item
 * @returns {Promise<{ entry: object, snippet: string }>}
 */
export async function resolveFullCatalogEntry(item) {
  const initial = buildCatalogEntry(item);
  const extra = {};

  if (!initial.firefoxId || !initial.firefoxSlug) {
    // If we have a firefoxId, query AMO addon endpoint directly to get the exact slug
    if (initial.firefoxId) {
      try {
        const res = await fetch(
          `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(initial.firefoxId)}/`
        );
        if (res.ok) {
          const data = await res.json();
          if (data?.guid) extra.firefoxId = data.guid;
          if (data?.slug) extra.firefoxSlug = data.slug;
        }
      } catch {
        // Ignore network error
      }
    }
    if (!extra.firefoxSlug && !initial.firefoxSlug) {
      const amo = await resolveFirefoxAddonFromAmo(item);
      if (amo?.firefoxId && !initial.firefoxId) extra.firefoxId = amo.firefoxId;
      if (amo?.firefoxSlug) extra.firefoxSlug = amo.firefoxSlug;
    }
  }

  if (!initial.chromiumId) {
    const cws = await resolveChromiumExtensionFromStore(item);
    if (cws?.chromiumId) extra.chromiumId = cws.chromiumId;
  }

  const entry = buildCatalogEntry(item, extra);
  return {
    entry,
    snippet: formatCatalogEntrySnippet(entry)
  };
}




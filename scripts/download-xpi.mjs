import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { KNOWN_EXTENSIONS_CATALOG } from '../src/shared/catalog.js';

const XPI_DIR = path.resolve(process.cwd(), 'xpi-files');
const MANIFEST_PATH = path.join(XPI_DIR, 'manifest.json');
const FORCE_DOWNLOAD = process.argv.includes('--force');

/**
 * Extracts a Firefox AMO slug or GUID from a store URL if present.
 * @param {string} url
 * @returns {string | null}
 */
function extractSlugFromAmoUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/addons\.mozilla\.org\/(?:[^/]+\/)?firefox\/addon\/([^/?#]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * Sanitizes a key into a safe filename base for `<key>.xpi`.
 * @param {string} key
 * @returns {string}
 */
function sanitizeFileName(key) {
  return String(key || 'extension')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Loads optional synced extensions from a GitHub Gist if GIST_ID is configured in environment.
 */
async function loadGistExtensions() {
  const gistId = process.env.GIST_ID?.trim();
  if (!gistId) return [];

  const token = (process.env.GIST_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    console.log(`Fetching additional extensions from Gist: ${gistId}...`);
    const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, {
      headers
    });
    if (!res.ok) {
      console.warn(`Could not fetch Gist ${gistId} (HTTP ${res.status}). Proceeding with catalog only.`);
      return [];
    }
    const data = await res.json();
    const fileObj =
      data.files?.['extensions-cross_browser-sync.json'] || Object.values(data.files || {})[0];
    if (!fileObj?.content) return [];

    const parsed = JSON.parse(fileObj.content);
    const exts = Object.values(parsed?.extensions || {});
    return exts.map((rec) => ({
      key: rec.key,
      name: rec.name || rec.key,
      firefoxId: rec.ids?.firefox || null,
      firefoxSlug: extractSlugFromAmoUrl(rec.storeUrls?.firefox),
      firefoxUrl: rec.storeUrls?.firefox || null
    }));
  } catch (err) {
    console.warn(`Warning: Failed to load extensions from Gist: ${err.message}`);
    return [];
  }
}

/**
 * Queries Mozilla AMO API v5 for the latest XPI download URL, version, and SHA256 hash.
 *
 * @param {{ key: string, name?: string, firefoxId?: string, firefoxSlug?: string, firefoxUrl?: string }} item
 */
async function resolveAmoDownloadInfo(item) {
  const slugFromUrl = extractSlugFromAmoUrl(item.firefoxUrl);
  const candidates = [item.firefoxSlug, slugFromUrl, item.firefoxId].filter(Boolean);

  for (const identifier of candidates) {
    try {
      const apiUrl = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(
        identifier
      )}/`;
      const res = await fetch(apiUrl, {
        headers: { Accept: 'application/json' }
      });

      if (res.ok) {
        const data = await res.json();
        const fileObj = data?.current_version?.file;
        if (fileObj?.url) {
          return {
            guid: data.guid || item.firefoxId || null,
            slug: data.slug || item.firefoxSlug || null,
            version: data.current_version?.version || 'unknown',
            downloadUrl: fileObj.url,
            expectedHash: fileObj.hash || null
          };
        }
      }
    } catch {
      // Try next identifier candidate
    }
  }

  // Fallback direct download URL if a slug is available
  const fallbackSlug = item.firefoxSlug || slugFromUrl;
  if (fallbackSlug && !fallbackSlug.startsWith('{') && !fallbackSlug.includes('@')) {
    return {
      guid: item.firefoxId || null,
      slug: fallbackSlug,
      version: 'latest',
      downloadUrl: `https://addons.mozilla.org/firefox/downloads/latest/${encodeURIComponent(
        fallbackSlug
      )}/addon-latest.xpi`,
      expectedHash: null
    };
  }

  return null;
}

async function main() {
  fs.mkdirSync(XPI_DIR, { recursive: true });

  let existingManifest = { updatedAt: null, extensions: {} };
  if (fs.existsSync(MANIFEST_PATH)) {
    try {
      existingManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
      if (!existingManifest.extensions) existingManifest.extensions = {};
    } catch {
      existingManifest = { updatedAt: null, extensions: {} };
    }
  }

  // Merge catalog entries + any Gist entries
  const combinedMap = new Map();
  for (const entry of KNOWN_EXTENSIONS_CATALOG) {
    if (entry.firefoxId || entry.firefoxSlug || entry.firefoxUrl) {
      combinedMap.set(entry.key, { ...entry });
    }
  }

  const gistEntries = await loadGistExtensions();
  for (const gEntry of gistEntries) {
    if (!gEntry.firefoxId && !gEntry.firefoxSlug && !gEntry.firefoxUrl) continue;
    const existing = combinedMap.get(gEntry.key) || {};
    combinedMap.set(gEntry.key, {
      ...existing,
      key: gEntry.key,
      name: existing.name || gEntry.name,
      firefoxId: existing.firefoxId || gEntry.firefoxId,
      firefoxSlug: existing.firefoxSlug || gEntry.firefoxSlug,
      firefoxUrl: existing.firefoxUrl || gEntry.firefoxUrl
    });
  }

  const items = Array.from(combinedMap.values());
  console.log(`Found ${items.length} Firefox extensions with valid ID or URL to check.`);

  let downloadedCount = 0;
  let upToDateCount = 0;
  let failedCount = 0;

  for (const item of items) {
    const safeKey = sanitizeFileName(item.key);
    const fileName = `${safeKey}.xpi`;
    const filePath = path.join(XPI_DIR, fileName);

    const amoInfo = await resolveAmoDownloadInfo(item);
    if (!amoInfo?.downloadUrl) {
      console.warn(`[SKIP] ${item.key}: Could not resolve a valid XPI download URL from AMO.`);
      failedCount++;
      continue;
    }

    const prevMeta = existingManifest.extensions[item.key];
    const fileExists = fs.existsSync(filePath);

    if (
      !FORCE_DOWNLOAD &&
      fileExists &&
      prevMeta &&
      prevMeta.version === amoInfo.version &&
      amoInfo.version !== 'latest' &&
      (!amoInfo.expectedHash || prevMeta.amoHash === amoInfo.expectedHash)
    ) {
      console.log(`[OK]   ${item.key} (v${amoInfo.version}) is already up to date.`);
      upToDateCount++;
      continue;
    }

    try {
      console.log(`[DL]   Downloading ${item.key} (v${amoInfo.version}) from ${amoInfo.downloadUrl}...`);
      const res = await fetch(amoInfo.downloadUrl, { redirect: 'follow' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const arrayBuf = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);

      // Verify ZIP/XPI magic bytes (PK\x03\x04)
      if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
        throw new Error('Downloaded file is not a valid XPI/ZIP archive.');
      }

      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      fs.writeFileSync(filePath, buffer);

      existingManifest.extensions[item.key] = {
        key: item.key,
        name: item.name || item.key,
        fileName,
        version: amoInfo.version,
        firefoxId: amoInfo.guid || item.firefoxId || null,
        firefoxSlug: amoInfo.slug || item.firefoxSlug || null,
        downloadUrl: amoInfo.downloadUrl,
        sha256,
        amoHash: amoInfo.expectedHash || `sha256:${sha256}`,
        sizeBytes: buffer.length,
        updatedAt: new Date().toISOString()
      };

      downloadedCount++;
    } catch (err) {
      console.error(`[FAIL] ${item.key}: ${err.message}`);
      failedCount++;
    }
  }

  existingManifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(existingManifest, null, 2) + '\n', 'utf8');

  console.log(
    `\nSummary: ${downloadedCount} downloaded/updated, ${upToDateCount} already up-to-date, ${failedCount} skipped/failed.`
  );
}

main().catch((err) => {
  console.error('Fatal error in download-xpi:', err);
  process.exit(1);
});


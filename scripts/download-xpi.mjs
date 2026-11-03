import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { KNOWN_EXTENSIONS_CATALOG } from '../src/shared/catalog.js';
import { isChromiumExtensionId } from '../src/shared/matcher.js';

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
 * Extracts a 32-char Chromium extension ID from a raw ID or Chrome Web Store URL.
 * @param {string} idOrUrl
 * @returns {string}
 */
function extractChromiumId(idOrUrl) {
  if (!idOrUrl || typeof idOrUrl !== 'string') return '';
  const trimmed = idOrUrl.trim();
  const urlMatch = trimmed.match(/\/detail\/(?:[^/"'\s?]+\/)?([a-p]{32})/i);
  if (urlMatch?.[1]) return urlMatch[1].toLowerCase();
  const lower = trimmed.toLowerCase();
  return isChromiumExtensionId(lower) ? lower : '';
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

  // Forced rule: only include catalog entries that have BOTH a valid Chromium ID/URL and Firefox ID/URL
  const items = KNOWN_EXTENSIONS_CATALOG.filter((entry) => {
    const crId = extractChromiumId(entry.chromiumId || entry.chromiumUrl);
    const hasFirefox = Boolean(entry.firefoxId || entry.firefoxSlug || entry.firefoxUrl);
    if (!crId || !hasFirefox) {
      console.warn(
        `[SKIP] ${entry.key}: Missing valid Chromium or Firefox ID/URL (both are required).`
      );
      return false;
    }
    return true;
  });

  console.log(
    `Found ${items.length} cross-browser extensions (with both Chromium and Firefox IDs/URLs) to check.`
  );

  const validKeys = new Set();
  const validFileNames = new Set(['manifest.json']);

  let downloadedCount = 0;
  let upToDateCount = 0;
  let failedCount = 0;

  for (const item of items) {
    const safeKey = sanitizeFileName(item.key);
    const relativeXpiPath = item.xpiFile || `xpi-files/${safeKey}.xpi`;
    const fileName = path.basename(relativeXpiPath);
    const filePath = path.resolve(process.cwd(), relativeXpiPath);

    validKeys.add(item.key);
    validFileNames.add(fileName);

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
      prevMeta.xpiFile = `xpi-files/${fileName}`;
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
        xpiFile: `xpi-files/${fileName}`,
        version: amoInfo.version,
        chromiumId: item.chromiumId || null,
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

  // Prune any orphan XPI files or manifest entries that do not have both Chromium & Firefox IDs in KNOWN_EXTENSIONS_CATALOG
  for (const key of Object.keys(existingManifest.extensions)) {
    if (!validKeys.has(key)) {
      delete existingManifest.extensions[key];
    }
  }

  for (const existingFile of fs.readdirSync(XPI_DIR)) {
    if (existingFile.endsWith('.xpi') && !validFileNames.has(existingFile)) {
      fs.rmSync(path.join(XPI_DIR, existingFile), { force: true });
      console.log(`[PRUNE] Removed ${existingFile} (not a valid cross-browser entry in catalog).`);
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

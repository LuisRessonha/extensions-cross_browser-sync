import fs from 'node:fs';
import path from 'node:path';
import { KNOWN_EXTENSIONS_CATALOG } from '../src/shared/catalog.js';
import { formatCatalogEntrySnippet, isChromiumExtensionId } from '../src/shared/matcher.js';

const CATALOG_PATH = path.resolve(process.cwd(), 'src/shared/catalog.js');
const XPI_DIR = path.resolve(process.cwd(), 'xpi-files');

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

function main() {
  const validEntries = [];

  for (const entry of KNOWN_EXTENSIONS_CATALOG) {
    const crId = extractChromiumId(entry.chromiumId || entry.chromiumUrl);
    const hasFirefox = Boolean(entry.firefoxId || entry.firefoxSlug || entry.firefoxUrl);

    // Forced rule: only include entries with BOTH Chromium and Firefox ID/URL valid
    if (!crId || !hasFirefox) {
      console.warn(
        `[SKIP] ${entry.key}: Missing valid Chromium or Firefox ID/URL; excluding from KNOWN_EXTENSIONS_CATALOG.`
      );
      continue;
    }

    const safeKey = sanitizeFileName(entry.key);
    const expectedRelPath = `xpi-files/${safeKey}.xpi`;
    const absXpiPath = path.join(XPI_DIR, `${safeKey}.xpi`);
    const hasXpiFile = fs.existsSync(absXpiPath) && fs.statSync(absXpiPath).size > 0;

    validEntries.push({
      ...entry,
      chromiumId: crId,
      xpiFile: hasXpiFile ? expectedRelPath : entry.xpiFile || expectedRelPath
    });
  }

  const header = `/**
 * Curated cross-browser catalog of popular extensions.
 * Bridges Chrome Web Store IDs (32-char a-p), Firefox Add-on GUIDs, and Firefox AMO slugs
 * so extensions match seamlessly between Chromium browsers and Firefox even if their
 * store names or IDs differ.
 */

export const KNOWN_EXTENSIONS_CATALOG = [\n`;

  const body = validEntries.map((entry) => formatCatalogEntrySnippet(entry)).join(',\n');
  const nextContent = `${header}${body}\n];\n`;

  const currentContent = fs.readFileSync(CATALOG_PATH, 'utf8').replace(/\r\n/g, '\n');
  if (currentContent === nextContent) {
    console.log('All xpiFile paths in KNOWN_EXTENSIONS_CATALOG are already up to date.');
    return;
  }

  fs.writeFileSync(CATALOG_PATH, nextContent, 'utf8');
  console.log(
    `Updated xpiFile paths for ${validEntries.length} entries in src/shared/catalog.js.`
  );
}

main();


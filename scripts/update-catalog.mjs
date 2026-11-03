import fs from 'node:fs';
import path from 'node:path';
import { KNOWN_EXTENSIONS_CATALOG } from '../src/shared/catalog.js';
import {
  buildCatalogEntry,
  formatCatalogEntrySnippet,
  isChromiumExtensionId,
  parseAndResolveManualBrowserId,
  resolveChromiumExtensionFromStore,
  resolveFirefoxAddonFromAmo
} from '../src/shared/matcher.js';

const CATALOG_PATH = path.resolve(process.cwd(), 'src/shared/catalog.js');

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
 * Verifies a Chromium extension ID against the Chrome Web Store.
 * Must be a valid 32-char [a-p] ID and return HTTP 200 on the Chrome Web Store detail page.
 *
 * @param {string} chromiumId
 * @returns {Promise<{ valid: boolean, chromiumId: string, storeUrl: string }>}
 */
async function verifyChromiumExtension(chromiumId) {
  const cleanId = String(chromiumId || '').trim().toLowerCase();
  if (!isChromiumExtensionId(cleanId)) {
    return { valid: false, chromiumId: cleanId, storeUrl: '' };
  }

  const storeUrl = `https://chromewebstore.google.com/detail/${cleanId}`;
  try {
    const res = await fetch(storeUrl, {
      method: 'GET',
      redirect: 'follow'
    });
    if (res.ok) {
      return { valid: true, chromiumId: cleanId, storeUrl };
    }
  } catch {
    // Network error
  }
  return { valid: false, chromiumId: cleanId, storeUrl };
}

/**
 * Verifies a Firefox extension ID, slug, or AMO URL against the Mozilla AMO REST API v5.
 * Must return HTTP 200 and a valid add-on `guid` and `slug`.
 *
 * @param {{ firefoxId?: string, firefoxSlug?: string, firefoxUrl?: string }} info
 * @returns {Promise<{ valid: boolean, firefoxId: string, firefoxSlug: string, name?: string }>}
 */
async function verifyFirefoxExtension(info) {
  const slugFromUrl = extractSlugFromAmoUrl(info.firefoxUrl);
  const candidates = [info.firefoxSlug, slugFromUrl, info.firefoxId].filter(Boolean);

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
        if (data?.guid && data?.slug) {
          const resolvedName =
            typeof data.name === 'string'
              ? data.name
              : data.name?.['en-US'] || Object.values(data.name || {})[0] || '';
          return {
            valid: true,
            firefoxId: data.guid,
            firefoxSlug: data.slug,
            name: resolvedName
          };
        }
      }
    } catch {
      // Try next candidate
    }
  }

  return { valid: false, firefoxId: '', firefoxSlug: '' };
}

/**
 * Loads candidate extensions from a GitHub Gist if GIST_ID is provided.
 */
async function loadCandidatesFromGist() {
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

  console.log(`Fetching candidate extensions from Gist: ${gistId}...`);
  const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, {
    headers
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Gist ${gistId}: HTTP ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const fileObj =
    data.files?.['extensions-cross_browser-sync.json'] || Object.values(data.files || {})[0];
  if (!fileObj?.content) return [];

  const parsed = JSON.parse(fileObj.content);
  return Object.values(parsed?.extensions || {});
}

/**
 * Loads an optional single candidate extension from environment variables (for manual workflow_dispatch input).
 */
async function loadCandidateFromEnvInputs() {
  const rawCr = process.env.INPUT_CHROMIUM?.trim();
  const rawFf = process.env.INPUT_FIREFOX?.trim();
  if (!rawCr && !rawFf) return [];

  const parsedCr = rawCr ? await parseAndResolveManualBrowserId(rawCr, 'chromium') : { id: '' };
  const parsedFf = rawFf ? await parseAndResolveManualBrowserId(rawFf, 'firefox') : { id: '' };

  const name = process.env.INPUT_NAME?.trim() || process.env.INPUT_KEY?.trim() || '';
  const key = process.env.INPUT_KEY?.trim() || '';

  return [
    {
      key,
      name,
      ids: {
        chromium: parsedCr.id || '',
        edge: process.env.INPUT_EDGE?.trim() || '',
        firefox: parsedFf.id || ''
      },
      storeUrls: {
        chromium: parsedCr.storeUrl || '',
        firefox: parsedFf.storeUrl || rawFf || ''
      }
    }
  ];
}

/**
 * Checks whether an entry already exists in KNOWN_EXTENSIONS_CATALOG by key, chromiumId, or firefoxId.
 */
function existsInCatalog(entry) {
  return KNOWN_EXTENSIONS_CATALOG.some(
    (c) =>
      c.key === entry.key ||
      (entry.chromiumId && c.chromiumId === entry.chromiumId) ||
      (entry.firefoxId && c.firefoxId === entry.firefoxId) ||
      (entry.firefoxSlug && c.firefoxSlug === entry.firefoxSlug)
  );
}

async function main() {
  const candidates = [
    ...(await loadCandidateFromEnvInputs()),
    ...(await loadCandidatesFromGist())
  ];

  if (candidates.length === 0) {
    console.log('No candidate extensions provided via inputs or GIST_ID.');
    return;
  }

  console.log(`Evaluating ${candidates.length} candidate extension(s) for KNOWN_EXTENSIONS_CATALOG...`);

  const newEntries = [];

  for (const candidate of candidates) {
    let chromiumId = candidate.ids?.chromium || '';
    let firefoxId = candidate.ids?.firefox || '';
    let firefoxSlug = extractSlugFromAmoUrl(candidate.storeUrls?.firefox) || '';
    let firefoxUrl = candidate.storeUrls?.firefox || '';

    // Attempt automatic resolution if one side is not yet populated on the candidate
    if (!firefoxId && !firefoxSlug && !firefoxUrl && candidate.name) {
      const amo = await resolveFirefoxAddonFromAmo(candidate);
      if (amo) {
        firefoxId = amo.firefoxId || '';
        firefoxSlug = amo.firefoxSlug || '';
        firefoxUrl = amo.firefoxUrl || '';
      }
    }

    if (!chromiumId && candidate.name) {
      const cws = await resolveChromiumExtensionFromStore(candidate);
      if (cws?.chromiumId) {
        chromiumId = cws.chromiumId;
      }
    }

    // 1. Validate Firefox ID / URL via AMO API
    const ffCheck = await verifyFirefoxExtension({
      firefoxId,
      firefoxSlug,
      firefoxUrl
    });

    if (!ffCheck.valid) {
      console.log(
        `[SKIP] "${candidate.name || candidate.key}": Firefox ID/URL is missing or invalid.`
      );
      continue;
    }

    // 2. Validate Chromium ID / URL via Chrome Web Store
    const crCheck = await verifyChromiumExtension(chromiumId);

    if (!crCheck.valid) {
      console.log(
        `[SKIP] "${candidate.name || candidate.key}": Chromium ID/URL is missing or invalid.`
      );
      continue;
    }

    const entry = buildCatalogEntry(
      {
        ...candidate,
        name: candidate.name || ffCheck.name || candidate.key
      },
      {
        chromiumId: crCheck.chromiumId,
        edgeId: candidate.ids?.edge || '',
        firefoxId: ffCheck.firefoxId,
        firefoxSlug: ffCheck.firefoxSlug
      }
    );

    if (existsInCatalog(entry) || newEntries.some((e) => e.key === entry.key)) {
      console.log(`[OK]   "${entry.name}" (${entry.key}) is already in KNOWN_EXTENSIONS_CATALOG.`);
      continue;
    }

    console.log(
      `[ADD]  Validated both Chromium (${entry.chromiumId}) and Firefox (${entry.firefoxId} / ${entry.firefoxSlug}) for "${entry.name}" (${entry.key})!`
    );
    newEntries.push(entry);
  }

  if (newEntries.length === 0) {
    console.log('No new valid cross-browser entries to add to KNOWN_EXTENSIONS_CATALOG.');
    return;
  }

  // Insert new entries before the closing `];` of KNOWN_EXTENSIONS_CATALOG in src/shared/catalog.js
  const currentFile = fs.readFileSync(CATALOG_PATH, 'utf8');
  const closingIndex = currentFile.lastIndexOf('];');
  if (closingIndex === -1) {
    throw new Error('Could not find closing `];` in src/shared/catalog.js');
  }

  const formattedSnippets = newEntries.map((e) => formatCatalogEntrySnippet(e)).join(',\n');
  const beforeClosing = currentFile.slice(0, closingIndex).trimEnd();
  const needsComma = beforeClosing.endsWith('}');
  const updatedFile = `${beforeClosing}${needsComma ? ',' : ''}\n${formattedSnippets}\n];\n`;

  fs.writeFileSync(CATALOG_PATH, updatedFile, 'utf8');
  console.log(
    `Successfully added ${newEntries.length} new entry/entries to src/shared/catalog.js!`
  );
}

main().catch((err) => {
  console.error('Fatal error updating catalog:', err);
  process.exit(1);
});


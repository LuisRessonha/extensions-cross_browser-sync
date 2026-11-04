export const GIST_FILENAME = 'extensions-cross_browser-sync.json';
export const GIST_DESCRIPTION =
  'extensions-cross_browser-sync — Synced browser extensions & enabled/disabled state';

const GITHUB_API_BASE = 'https://api.github.com';

function buildHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token && token.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

/**
 * Validates a GitHub Personal Access Token and searches the user's gists for an existing
 * `extensions-cross_browser-sync.json` file.
 *
 * @param {string} token
 * @returns {Promise<{ username: string, discoveredGistId: string | null, gistUrl: string | null }>}
 */
export async function validateTokenAndDiscoverGist(token) {
  if (!token || !token.trim()) {
    throw new Error('GitHub Personal Access Token is required.');
  }

  const userRes = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: buildHeaders(token)
  });

  if (!userRes.ok) {
    if (userRes.status === 401) {
      throw new Error('Invalid or expired GitHub token (401 Unauthorized).');
    }
    throw new Error(`GitHub API error (${userRes.status}): ${userRes.statusText}`);
  }

  const user = await userRes.json();

  // Search user's gists for an existing sync file
  const gistsRes = await fetch(`${GITHUB_API_BASE}/gists?per_page=100`, {
    headers: buildHeaders(token)
  });

  let discoveredGistId = null;
  let gistUrl = null;

  if (gistsRes.ok) {
    const gists = await gistsRes.json();
    if (Array.isArray(gists)) {
      const match = gists.find((g) => g.files && g.files[GIST_FILENAME]);
      if (match) {
        discoveredGistId = match.id;
        gistUrl = match.html_url;
      }
    }
  }

  return {
    username: user.login || 'unknown',
    discoveredGistId,
    gistUrl
  };
}

/**
 * Creates a new private GitHub Gist initialized with the given sync payload.
 *
 * @param {string} token
 * @param {object} initialPayload
 * @returns {Promise<{ gistId: string, htmlUrl: string, payload: object }>}
 */
export async function createSyncGist(token, initialPayload) {
  if (!token || !token.trim()) {
    throw new Error('GitHub Personal Access Token is required to create a Gist.');
  }

  const payload = initialPayload || createEmptySyncPayload();

  const res = await fetch(`${GITHUB_API_BASE}/gists`, {
    method: 'POST',
    headers: {
      ...buildHeaders(token),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      description: GIST_DESCRIPTION,
      public: false,
      files: {
        [GIST_FILENAME]: {
          content: JSON.stringify(payload, null, 2)
        }
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Failed to create Gist (${res.status}): ${errText || res.statusText}`);
  }

  const data = await res.json();
  return {
    gistId: data.id,
    htmlUrl: data.html_url,
    payload
  };
}

/**
 * Fetches and parses `extensions-cross_browser-sync.json` from a GitHub Gist.
 *
 * @param {string} token
 * @param {string} gistId
 * @returns {Promise<{ payload: object, updatedAt: string, htmlUrl: string }>}
 */
export async function fetchSyncGist(token, gistId) {
  if (!gistId || !gistId.trim()) {
    throw new Error('Gist ID is not configured.');
  }

  const cleanId = gistId.trim();
  const res = await fetch(`${GITHUB_API_BASE}/gists/${encodeURIComponent(cleanId)}`, {
    headers: buildHeaders(token),
    cache: 'no-store'
  });

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`Gist "${cleanId}" not found (404). Check your Gist ID and token permissions.`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Authentication failed (${res.status}). Check your GitHub token.`);
    }
    throw new Error(`Failed to fetch Gist (${res.status}): ${res.statusText}`);
  }

  const data = await res.json();
  const fileObj = data.files?.[GIST_FILENAME] || Object.values(data.files || {})[0];

  if (!fileObj) {
    return {
      payload: createEmptySyncPayload(),
      updatedAt: data.updated_at,
      htmlUrl: data.html_url
    };
  }

  let contentText = fileObj.content;
  if (fileObj.truncated && fileObj.raw_url) {
    const rawRes = await fetch(fileObj.raw_url, { headers: buildHeaders(token) });
    if (rawRes.ok) {
      contentText = await rawRes.text();
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(contentText);
  } catch {
    throw new Error(`Gist file "${fileObj.filename}" does not contain valid JSON.`);
  }

  return {
    payload: normalizeSyncPayload(parsed),
    updatedAt: data.updated_at,
    htmlUrl: data.html_url
  };
}

/**
 * Updates `extensions-cross_browser-sync.json` in an existing GitHub Gist.
 *
 * @param {string} token
 * @param {string} gistId
 * @param {object} payload
 * @returns {Promise<{ gistId: string, updatedAt: string, htmlUrl: string }>}
 */
export async function updateSyncGist(token, gistId, payload) {
  if (!token || !token.trim()) {
    throw new Error('GitHub Personal Access Token is required to update Gist.');
  }
  if (!gistId || !gistId.trim()) {
    throw new Error('Gist ID is required to update Gist.');
  }

  const cleanId = gistId.trim();
  const res = await fetch(`${GITHUB_API_BASE}/gists/${encodeURIComponent(cleanId)}`, {
    method: 'PATCH',
    headers: {
      ...buildHeaders(token),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      description: GIST_DESCRIPTION,
      files: {
        [GIST_FILENAME]: {
          content: JSON.stringify(payload, null, 2)
        }
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Failed to update Gist (${res.status}): ${errText || res.statusText}`);
  }

  const data = await res.json();
  return {
    gistId: data.id,
    updatedAt: data.updated_at,
    htmlUrl: data.html_url
  };
}

/**
 * Creates a clean empty sync payload object.
 */
export function createEmptySyncPayload() {
  return {
    app: 'extensions-cross_browser-sync',
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: null,
    ignoredKeys: [],
    extensions: {}
  };
}

/**
 * Ensures any loaded sync payload conforms to schemaVersion 1 structure.
 */
export function normalizeSyncPayload(raw) {
  if (!raw || typeof raw !== 'object') {
    return createEmptySyncPayload();
  }
  const extensions = raw.extensions && typeof raw.extensions === 'object' ? raw.extensions : {};
  const ignoredSet = new Set(Array.isArray(raw.ignoredKeys) ? raw.ignoredKeys.filter(Boolean) : []);
  for (const [k, rec] of Object.entries(extensions)) {
    if (rec?.ignored) {
      ignoredSet.add(rec.key || k);
    }
  }
  return {
    app: 'extensions-cross_browser-sync',
    schemaVersion: 1,
    updatedAt: raw.updatedAt || new Date().toISOString(),
    updatedBy: raw.updatedBy || null,
    ignoredKeys: Array.from(ignoredSet),
    extensions
  };
}


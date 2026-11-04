#!/usr/bin/env node
/**
 * Automated Packaging & Release Script for Cross-Browser Extensions Sync
 *
 * Automates:
 * 1. Semantic version bumping / version control (package.json + manifest.json)
 * 2. Building clean distribution targets (dist/chromium, dist/firefox)
 * 3. Packaging store-ready ZIP archives:
 *    - dist/Cross-Browser-Extensions-Sync-chrome-v<version>.zip
 *    - dist/Cross-Browser-Extensions-Sync-firefox-v<version>.zip
 * 4. Optional Git commit and tagging (--commit, --tag)
 *
 * Usage:
 *   node scripts/package.mjs                     # Package current version
 *   node scripts/package.mjs patch               # Bump patch (1.0.1 -> 1.0.2) and package
 *   node scripts/package.mjs minor               # Bump minor (1.0.1 -> 1.1.0) and package
 *   node scripts/package.mjs major               # Bump major (1.0.1 -> 2.0.0) and package
 *   node scripts/package.mjs 1.2.0               # Set explicit version and package
 *   node scripts/package.mjs patch --commit --tag # Bump, commit, and create git tag
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const CHROMIUM_DIR = path.join(DIST_DIR, 'chromium');
const FIREFOX_DIR = path.join(DIST_DIR, 'firefox');
const PACKAGE_JSON_PATH = path.join(ROOT, 'package.json');
const ROOT_MANIFEST_PATH = path.join(ROOT, 'manifest.json');

// --- 1. Version Management ---

function parseSemver(versionStr) {
  const match = versionStr.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?$/);
  if (!match) {
    throw new Error(`Invalid semver version: "${versionStr}". Expected format: X.Y.Z`);
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null
  };
}

function bumpVersion(currentVersion, bumpType) {
  const semver = parseSemver(currentVersion);
  switch (bumpType.toLowerCase()) {
    case 'major':
      return `${semver.major + 1}.0.0`;
    case 'minor':
      return `${semver.major}.${semver.minor + 1}.0`;
    case 'patch':
      return `${semver.major}.${semver.minor}.${semver.patch + 1}`;
    default:
      // If it's a specific version string, validate it
      parseSemver(bumpType);
      return bumpType;
  }
}

function updateVersions(newVersion) {
  // Update package.json
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  const oldVersion = pkg.version;
  pkg.version = newVersion;
  fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  // Update root manifest.json
  const manifest = JSON.parse(fs.readFileSync(ROOT_MANIFEST_PATH, 'utf8'));
  manifest.version = newVersion;
  fs.writeFileSync(ROOT_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`Version updated: v${oldVersion} -> v${newVersion}`);
  return { oldVersion, newVersion };
}

// --- 2. Build Targets ---

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function buildTargets(version) {
  // Ensure assets/icons are generated
  const generateIconsScript = path.join(ROOT, 'scripts', 'generate-icons.mjs');
  if (fs.existsSync(generateIconsScript)) {
    execSync(`node "${generateIconsScript}"`, { stdio: 'inherit' });
  }

  const baseManifest = JSON.parse(fs.readFileSync(ROOT_MANIFEST_PATH, 'utf8'));
  baseManifest.version = version;

  function buildTarget(targetDir, transformManifest) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });

    copyRecursive(path.join(ROOT, 'assets'), path.join(targetDir, 'assets'));
    copyRecursive(path.join(ROOT, 'src'), path.join(targetDir, 'src'));

    const targetManifest = transformManifest(structuredClone(baseManifest));
    fs.writeFileSync(
      path.join(targetDir, 'manifest.json'),
      JSON.stringify(targetManifest, null, 2) + '\n',
      'utf8'
    );
  }

  // 1. Build Chromium target (Chrome, Edge, Brave, Vivaldi, Opera)
  buildTarget(CHROMIUM_DIR, (m) => {
    delete m.browser_specific_settings;
    m.background = {
      service_worker: 'src/background/index.js',
      type: 'module'
    };
    return m;
  });

  // 2. Build Firefox target (Gecko MV3)
  buildTarget(FIREFOX_DIR, (m) => {
    delete m.background.service_worker;
    m.background = {
      scripts: ['src/background/index.js'],
      type: 'module'
    };
    return m;
  });

  console.log(`Built distribution targets:`);
  console.log(`  - Chromium: ${CHROMIUM_DIR}`);
  console.log(`  - Firefox:  ${FIREFOX_DIR}`);
}

// --- 3. Pure-Node Zero-Dependency ZIP Creation ---

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[i] = c >>> 0;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const d = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: d };
}

function createZipArchive(sourceDir, destZipPath) {
  const entries = [];

  function collect(dir, baseRel = '') {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    // Sort items for deterministic reproducible zip files
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      const relPath = baseRel ? `${baseRel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        collect(fullPath, relPath);
      } else if (item.isFile()) {
        const content = fs.readFileSync(fullPath);
        const stat = fs.statSync(fullPath);
        entries.push({
          name: relPath.replace(/\\/g, '/'),
          data: content,
          mtime: stat.mtime
        });
      }
    }
  }

  collect(sourceDir);

  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const uncompressedSize = entry.data.length;
    const crc = crc32(entry.data);
    const compressed = zlib.deflateRawSync(entry.data, { level: 9 });
    const compressedSize = compressed.length;
    const { time, date } = dosDateTime(entry.mtime);

    // Local file header (30 bytes)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);       // Local header signature
    localHeader.writeUInt16LE(20, 4);               // Version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6);           // General purpose bit flag (UTF-8)
    localHeader.writeUInt16LE(8, 8);                // Compression method (Deflate)
    localHeader.writeUInt16LE(time, 10);            // Last mod time
    localHeader.writeUInt16LE(date, 12);            // Last mod date
    localHeader.writeUInt32LE(crc, 14);             // CRC-32
    localHeader.writeUInt32LE(compressedSize, 18);   // Compressed size
    localHeader.writeUInt32LE(uncompressedSize, 22); // Uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);   // File name length
    localHeader.writeUInt16LE(0, 28);               // Extra field length
    nameBuf.copy(localHeader, 30);

    localHeaders.push(localHeader);
    localHeaders.push(compressed);

    // Central directory header (46 bytes)
    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);     // Central directory header signature
    centralHeader.writeUInt16LE(20, 4);             // Version made by
    centralHeader.writeUInt16LE(20, 6);             // Version needed
    centralHeader.writeUInt16LE(0x0800, 8);         // UTF-8 flag
    centralHeader.writeUInt16LE(8, 10);             // Deflate
    centralHeader.writeUInt16LE(time, 12);          // Time
    centralHeader.writeUInt16LE(date, 14);          // Date
    centralHeader.writeUInt32LE(crc, 16);           // CRC-32
    centralHeader.writeUInt32LE(compressedSize, 20); // Compressed size
    centralHeader.writeUInt32LE(uncompressedSize, 24); // Uncompressed size
    centralHeader.writeUInt16LE(nameBuf.length, 28); // File name length
    centralHeader.writeUInt16LE(0, 30);             // Extra field length
    centralHeader.writeUInt16LE(0, 32);             // File comment length
    centralHeader.writeUInt16LE(0, 34);             // Disk number start
    centralHeader.writeUInt16LE(0, 36);             // Internal file attributes
    centralHeader.writeUInt32LE(0, 38);             // External file attributes
    centralHeader.writeUInt32LE(offset, 42);        // Offset of local header
    nameBuf.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);
    offset += localHeader.length + compressed.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralHeaders.reduce((sum, h) => sum + h.length, 0);

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);               // EOCD signature
  eocd.writeUInt16LE(0, 4);                        // Disk number
  eocd.writeUInt16LE(0, 6);                        // Disk with CD
  eocd.writeUInt16LE(entries.length, 8);           // Entries on this disk
  eocd.writeUInt16LE(entries.length, 10);          // Total entries
  eocd.writeUInt32LE(centralDirSize, 12);          // CD size
  eocd.writeUInt32LE(centralDirOffset, 16);        // CD offset
  eocd.writeUInt16LE(0, 20);                       // Comment length

  const allBuffers = [...localHeaders, ...centralHeaders, eocd];
  fs.mkdirSync(path.dirname(destZipPath), { recursive: true });
  fs.writeFileSync(destZipPath, Buffer.concat(allBuffers));

  const stats = fs.statSync(destZipPath);
  return { entryCount: entries.length, sizeBytes: stats.size };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

// --- 4. Main Execution ---

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('-')));
  const nonFlags = args.filter((a) => !a.startsWith('-'));

  const doCommit = flags.has('--commit') || flags.has('-c');
  const doTag = flags.has('--tag') || flags.has('-t');

  // Read current version
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  let currentVersion = pkg.version;
  let targetVersion = currentVersion;

  if (nonFlags.length > 0) {
    const versionArg = nonFlags[0];
    targetVersion = bumpVersion(currentVersion, versionArg);
  }

  console.log(`\n========================================`);
  console.log(` Cross-Browser Extensions Sync Packager`);
  console.log(`========================================`);

  if (targetVersion !== currentVersion) {
    updateVersions(targetVersion);
  } else {
    console.log(`Packaging current version: v${targetVersion}`);
  }

  // Build target folders
  buildTargets(targetVersion);

  // Define zip filenames
  const chromeZipName = `Cross-Browser-Extensions-Sync-chrome-v${targetVersion}.zip`;
  const firefoxZipName = `Cross-Browser-Extensions-Sync-firefox-v${targetVersion}.zip`;

  const chromeZipPath = path.join(DIST_DIR, chromeZipName);
  const firefoxZipPath = path.join(DIST_DIR, firefoxZipName);

  console.log(`\nCreating store ZIP packages...`);

  // Package Chrome/Chromium ZIP
  const chromeResult = createZipArchive(CHROMIUM_DIR, chromeZipPath);
  console.log(`  ✓ Chrome Web Store:  dist/${chromeZipName} (${formatBytes(chromeResult.sizeBytes)}, ${chromeResult.entryCount} files)`);

  // Package Firefox ZIP
  const firefoxResult = createZipArchive(FIREFOX_DIR, firefoxZipPath);
  console.log(`  ✓ Firefox Add-ons (AMO): dist/${firefoxZipName} (${formatBytes(firefoxResult.sizeBytes)}, ${firefoxResult.entryCount} files)`);

  // Also maintain convenience alias if desired
  const legacyFirefoxZip = path.join(DIST_DIR, 'extensions-cross-browser-sync.zip');
  fs.copyFileSync(firefoxZipPath, legacyFirefoxZip);

  // Optional Git actions
  if (doCommit || doTag) {
    try {
      if (doCommit) {
        execSync(`git add package.json manifest.json dist/`, { stdio: 'inherit' });
        execSync(`git commit -m "chore(release): v${targetVersion}"`, { stdio: 'inherit' });
        console.log(`  ✓ Git commit created: "chore(release): v${targetVersion}"`);
      }
      if (doTag) {
        execSync(`git tag "v${targetVersion}"`, { stdio: 'inherit' });
        console.log(`  ✓ Git tag created: "v${targetVersion}"`);
      }
    } catch (err) {
      console.warn(`  ! Git command warning:`, err.message);
    }
  }

  console.log(`\nDone! Packages ready for upload in: ${DIST_DIR}\n`);
}

main();


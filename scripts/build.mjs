import fs from 'node:fs';
import path from 'node:path';
import './generate-icons.mjs';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const CHROMIUM_DIR = path.join(DIST_DIR, 'chromium');
const FIREFOX_DIR = path.join(DIST_DIR, 'firefox');

const baseManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

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
buildTarget(CHROMIUM_DIR, (manifest) => {
  delete manifest.browser_specific_settings;
  manifest.background = {
    service_worker: 'src/background/index.js',
    type: 'module'
  };
  return manifest;
});

// 2. Build Firefox target (Gecko MV3)
buildTarget(FIREFOX_DIR, (manifest) => {
  manifest.background = {
    scripts: ['src/background/index.js'],
    type: 'module'
  };
  return manifest;
});

console.log('Built extension targets:');
console.log(`  - Chromium: ${CHROMIUM_DIR}`);
console.log(`  - Firefox:  ${FIREFOX_DIR}`);


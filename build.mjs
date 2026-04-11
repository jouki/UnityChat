#!/usr/bin/env node
// UnityChat extension build script
// Usage:
//   node build.mjs          build both chrome + opera
//   node build.mjs chrome   build chrome only
//   node build.mjs opera    build opera only
// Output:
//   dist/chrome/                             (unpacked, for "Load unpacked" dev install)
//   dist/opera/                              (unpacked, for "Load unpacked" dev install)
//   dist/unitychat-chrome-v{version}.zip     (for Chrome Web Store / Opera addons upload)
//   dist/unitychat-opera-v{version}.zip

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'extension');
const distDir = path.join(__dirname, 'dist');

const SHARED_FILES = ['sidepanel.html', 'sidepanel.css', 'sidepanel.js'];
const SHARED_DIRS = ['content', 'icons'];

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function buildFor(browser) {
  const stageDir = path.join(distDir, browser);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  for (const f of SHARED_FILES) {
    fs.copyFileSync(path.join(srcDir, f), path.join(stageDir, f));
  }
  for (const d of SHARED_DIRS) {
    copyDir(path.join(srcDir, d), path.join(stageDir, d));
  }

  const manifestSrc = path.join(srcDir, `manifest.${browser}.json`);
  fs.copyFileSync(manifestSrc, path.join(stageDir, 'manifest.json'));

  const bgSrc = path.join(srcDir, `background.${browser}.js`);
  fs.copyFileSync(bgSrc, path.join(stageDir, 'background.js'));

  const manifest = JSON.parse(fs.readFileSync(manifestSrc, 'utf8'));
  const version = manifest.version;

  const zipName = `unitychat-${browser}-v${version}.zip`;
  const zipPath = path.join(distDir, zipName);
  fs.rmSync(zipPath, { force: true });

  const zip = new AdmZip();
  zip.addLocalFolder(stageDir);
  zip.writeZip(zipPath);

  const zipKb = (fs.statSync(zipPath).size / 1024).toFixed(1);
  console.log(`  \u2713 dist/${browser}/  +  ${zipName} (${zipKb} KB)`);
}

fs.mkdirSync(distDir, { recursive: true });

const target = process.argv[2];
console.log('Building UnityChat extension...\n');

if (!target || target === 'chrome') buildFor('chrome');
if (!target || target === 'opera') buildFor('opera');

console.log(`\nDone. Output in ./${path.relative(__dirname, distDir)}/`);

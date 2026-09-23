// node scripts/build-firefox.mjs — testovací build UnityChatu pro Firefox.
//
// Kód je JEDEN (extension/, stejný jako pro Chrome Web Store); pro Firefox se mění jen
// manifest: background.scripts místo service_workeru, postranní lišta sidebar_action místo
// side_panel, bez oprávnění sidePanel, ID doplňku (browser_specific_settings.gecko) a min.
// verze 128 (chrome.scripting world: 'MAIN'). Chování podle prohlížeče řeší runtime detekce
// v background.js (HAS_SIDE_PANEL / FF_SIDEBAR).
//
// Výstup: store/build/firefox/unpacked/ (about:debugging → Načíst dočasný doplněk → manifest.json)
//         store/build/firefox/unitychat-firefox-vX.Y.Z.xpi (zip)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'extension');
const outDir = path.join(root, 'store', 'build', 'firefox');
const unpacked = path.join(outDir, 'unpacked');

export const GECKO_ID = 'unitychat@jouki.cz';
export const MIN_FIREFOX = '128.0';

/** Chrome manifest → Firefox manifest (čistá funkce, testovatelná). */
export function toFirefoxManifest(m) {
  const out = structuredClone(m);
  out.background = { scripts: [m.background.service_worker] };
  out.permissions = (m.permissions || []).filter((p) => p !== 'sidePanel');
  delete out.side_panel;
  out.sidebar_action = {
    default_panel: m.side_panel?.default_path || 'sidepanel.html',
    default_title: 'UnityChat',
    default_icon: m.action?.default_icon || m.icons,
    open_at_install: false,
  };
  out.browser_specific_settings = { gecko: { id: GECKO_ID, strict_min_version: MIN_FIREFOX } };
  return out;
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  // Mazat jen vlastní výstupy, ne celou složku (tu může držet otevřenou web-ext / terminál).
  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(unpacked, { recursive: true, force: true });
  for (const f of fs.readdirSync(outDir)) if (/\.(xpi|zip)$/.test(f)) fs.rmSync(path.join(outDir, f), { force: true });
  fs.cpSync(src, unpacked, { recursive: true });
  const ff = toFirefoxManifest(manifest);
  fs.writeFileSync(path.join(unpacked, 'manifest.json'), JSON.stringify(ff, null, 2) + '\n');

  // Kontrola: každý skript musí projít syntaxí (stejně jako build-store.ps1).
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const scripts = walk(unpacked).filter((f) => f.endsWith('.js'));
  for (const f of scripts) execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });

  // Zip (.xpi) přes PowerShell Compress-Archive (Windows), jinde přes `zip`.
  const xpi = path.join(outDir, `unitychat-firefox-v${manifest.version}.xpi`);
  const zipTmp = xpi.replace(/\.xpi$/, '.zip');
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${unpacked}\\*' -DestinationPath '${zipTmp}' -Force`], { stdio: 'pipe' });
    fs.renameSync(zipTmp, xpi);
  } else {
    execFileSync('zip', ['-qr', xpi, '.'], { cwd: unpacked, stdio: 'pipe' });
  }
  console.log(`Firefox build v${manifest.version}: ${scripts.length} skriptů OK`);
  console.log(`  unpacked: ${path.relative(root, unpacked)}`);
  console.log(`  xpi:      ${path.relative(root, xpi)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

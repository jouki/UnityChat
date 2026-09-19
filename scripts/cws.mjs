#!/usr/bin/env node
/**
 * Chrome Web Store API v2 — status / upload / publish.
 *
 * Proč vlastní skript a ne hotová GitHub Action: potřebujeme i `status`
 * lokálně (jaká verze je publikovaná, jaká čeká na review) a guard, který
 * shodí release, když verze není vyšší než ta ve storu. Jedna implementace
 * pro CI i pro ruční použití.
 *
 * V1 API končí 15. 10. 2026, tohle jede na v2.
 *
 * Autentizace: service account JSON klíč. Bere se z env CWS_SERVICE_ACCOUNT
 * (obsah JSON) nebo z --key <cesta>. Klíč NIKDY nepatří do repa — je veřejné.
 *
 * Použití:
 *   node scripts/cws.mjs status
 *   node scripts/cws.mjs upload store/build/unitychat-store-v3.38.62.zip
 *   node scripts/cws.mjs publish
 *   node scripts/cws.mjs release store/build/unitychat-store-v3.38.62.zip
 *   node scripts/cws.mjs check-version 3.38.62   # exit 1 když není vyšší než publikovaná
 *
 * Env:
 *   CWS_SERVICE_ACCOUNT  obsah JSON klíče (v CI z GitHub secrets)
 *   CWS_PUBLISHER_ID     publisher ID z URL dashboardu
 *   CWS_ITEM_ID          ID položky (default: produkční UnityChat)
 */

import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const API = 'https://chromewebstore.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const ITEM_ID = process.env.CWS_ITEM_ID || 'picaeipbmkgcippknkpkbnbgjlkblbnp';

// ---------------------------------------------------------------- auth ----

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Service account JSON → access token přes podepsaný JWT (RS256). */
async function getAccessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  }));

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(key.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Výměna JWT za token selhala (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function loadKey(argv) {
  const inline = process.env.CWS_SERVICE_ACCOUNT;
  if (inline) return JSON.parse(inline);

  const i = argv.indexOf('--key');
  if (i !== -1 && argv[i + 1]) return JSON.parse(await readFile(argv[i + 1], 'utf8'));

  throw new Error(
    'Chybí service account klíč. Nastav CWS_SERVICE_ACCOUNT (obsah JSON) ' +
    'nebo předej --key <cesta k JSON>.'
  );
}

function publisherId() {
  const id = process.env.CWS_PUBLISHER_ID;
  if (!id) throw new Error('Chybí CWS_PUBLISHER_ID (je v URL Developer Dashboardu).');
  return id;
}

// ------------------------------------------------------------- requests ----

async function api(token, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} na ${path}: ${JSON.stringify(body)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

const itemPath = (verb) => `/v2/publishers/${publisherId()}/items/${ITEM_ID}:${verb}`;

async function fetchStatus(token) {
  return api(token, itemPath('fetchStatus'));
}

/** Verze z distributionChannels — u revize může být víc kanálů, bereme první. */
function versionOf(revision) {
  return revision?.distributionChannels?.[0]?.crxVersion ?? null;
}

// -------------------------------------------------------------- příkazy ----

async function cmdStatus(token) {
  const s = await fetchStatus(token);
  const published = versionOf(s.publishedItemRevisionStatus);
  const submitted = versionOf(s.submittedItemRevisionStatus);

  console.log('');
  console.log(`  Položka        ${s.itemId || ITEM_ID}`);
  console.log(`  Publikováno    ${published ? `v${published}` : '— (zatím nic)'}`);
  console.log(`  Čeká na review ${submitted ? `v${submitted}  [${s.submittedItemRevisionStatus?.state || '?'}]` : '— (nic nečeká)'}`);
  if (s.publishedItemRevisionStatus?.state) {
    console.log(`  Stav published ${s.publishedItemRevisionStatus.state}`);
  }
  if (s.uploadState) console.log(`  Upload state   ${s.uploadState}`);
  if (s.warned)    console.log('  ⚠️  WARNED — Google nahlásil porušení policy, mrkni do dashboardu');
  if (s.takenDown) console.log('  ⛔ TAKEN DOWN — položka byla stažena ze storu');
  if (s.itemError?.length) {
    console.log('  Chyby:');
    for (const e of s.itemError) console.log(`    - ${e.error_detail || JSON.stringify(e)}`);
  }
  console.log('');
  return s;
}

/** Porovná semver-like verze. Vrací >0 když a > b. */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Guard proti odeslání verze, kterou store odmítne. Volá se z CI na PR do
 * master, aby se na bump nedalo zapomenout.
 */
async function cmdCheckVersion(token, version) {
  if (!version) throw new Error('check-version potřebuje verzi, např. `check-version 3.38.63`.');
  const s = await fetchStatus(token);
  const published = versionOf(s.publishedItemRevisionStatus);
  const submitted = versionOf(s.submittedItemRevisionStatus);

  console.log(`  manifest: v${version}`);
  console.log(`  store:    publikováno ${published ? 'v' + published : '—'}, čeká ${submitted ? 'v' + submitted : '—'}`);

  for (const [label, other] of [['publikovanou', published], ['odeslanou', submitted]]) {
    if (other && cmpVersion(version, other) <= 0) {
      console.error(`\n  ❌ v${version} není vyšší než ${label} v${other}.`);
      console.error('     Bumpni version v extension/manifest.json — store by upload odmítl.');
      process.exit(1);
    }
  }
  console.log('\n  ✅ verze je vyšší než cokoli ve storu');
}

async function cmdUpload(token, zipPath) {
  if (!zipPath) throw new Error('upload potřebuje cestu k ZIPu.');
  const zip = await readFile(zipPath);
  console.log(`  nahrávám ${basename(zipPath)} (${(zip.length / 1024).toFixed(1)} KB)…`);

  const res = await api(token, `/upload/v2/publishers/${publisherId()}/items/${ITEM_ID}:upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: zip,
  });

  // Upload může skončit asynchronně — pak je potřeba dotázat fetchStatus.
  if (res.uploadState === 'UPLOAD_IN_PROGRESS') {
    console.log('  upload běží, čekám na dokončení…');
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const s = await fetchStatus(token);
      if (s.uploadState && s.uploadState !== 'UPLOAD_IN_PROGRESS') {
        if (s.uploadState === 'FAILURE') {
          throw new Error(`Upload selhal: ${JSON.stringify(s.itemError || s)}`);
        }
        break;
      }
    }
  }
  if (res.uploadState === 'FAILURE') {
    throw new Error(`Upload selhal: ${JSON.stringify(res.itemError || res)}`);
  }
  console.log('  ✅ nahráno');
  return res;
}

async function cmdPublish(token) {
  console.log('  odesílám ke kontrole…');
  const res = await api(token, itemPath('publish'), { method: 'POST' });
  const statuses = res.status || res.statuses || [];
  if (statuses.length) console.log(`  odpověď: ${JSON.stringify(statuses)}`);
  console.log('  ✅ odesláno ke kontrole');
  return res;
}

/**
 * Zruší čekající odeslání (review). Store při probíhající review odmítá
 * jakýkoli upload (`NOT_UPDATEABLE — You may not edit or publish an item
 * that is in review`, stalo se 2026-09-20 s 3.39.3 vs 3.39.14). Bez čekající
 * submission je volání neškodné.
 */
async function cmdCancel(token) {
  const before = await fetchStatus(token);
  const submitted = versionOf(before.submittedItemRevisionStatus);
  if (!submitted) { console.log('  nic nečeká na review — není co rušit'); return; }
  console.log(`  ruším čekající odeslání v${submitted}…`);
  await api(token, itemPath('cancelSubmission'), { method: 'POST' });
  console.log('  ✅ zrušeno');
}

// ----------------------------------------------------------------- main ----

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(`
Chrome Web Store API v2

  node scripts/cws.mjs status
  node scripts/cws.mjs check-version <verze>
  node scripts/cws.mjs upload <zip>
  node scripts/cws.mjs publish
  node scripts/cws.mjs cancel             # zrušit čekající review
  node scripts/cws.mjs release <zip>      # upload + publish

Klíč: env CWS_SERVICE_ACCOUNT (obsah JSON) nebo --key <cesta>
Dále: CWS_PUBLISHER_ID, volitelně CWS_ITEM_ID
`);
    return;
  }

  const key = await loadKey(argv);
  const token = await getAccessToken(key);
  const arg = argv.find((a, i) => i > 0 && !a.startsWith('--') && argv[i - 1] !== '--key');

  switch (cmd) {
    case 'status':        await cmdStatus(token); break;
    case 'check-version': await cmdCheckVersion(token, arg); break;
    case 'upload':        await cmdUpload(token, arg); break;
    case 'publish':       await cmdPublish(token); break;
    case 'cancel':        await cmdCancel(token); break;
    case 'release':
      await cmdUpload(token, arg);
      await cmdPublish(token);
      await cmdStatus(token);
      break;
    default:
      throw new Error(`Neznámý příkaz: ${cmd}`);
  }
}

main().catch((e) => {
  console.error(`\n  ❌ ${e.message}\n`);
  process.exit(1);
});

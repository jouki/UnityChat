#!/usr/bin/env node
// Audit chat ingestu: která platform:id z DIAG dumpů extension (pole msgCacheIds,
// v3.38.78+) v DB chybí (recall) a jaká je latence created_at - sent_at.
// Kritéria ze specu §6: Twitch/Kick recall ≥ 99,5 % a p95 < 2 s, YouTube ≥ 95 % a p95 < 10 s.
//
//   node scripts/ingest-audit.mjs --db postgres://user:pass@host:5432/unitychat dump1.txt [dump2.txt ...]
//
// DB port je na VPS interní — pouštět na VPS (repo ~/UnityChat) nebo přes ssh tunel.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Lokálně z repa (../backend/node_modules), v backend kontejneru (/app) přímo 'postgres'.
let postgres;
try { postgres = require('../backend/node_modules/postgres'); } catch { postgres = require('postgres'); }

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
const url = dbIdx !== -1 ? args[dbIdx + 1] : process.env.DATABASE_URL;
if (!url) {
  console.error('usage: node scripts/ingest-audit.mjs --db <DATABASE_URL> dump.txt [...]  (nebo DATABASE_URL v env)');
  process.exit(2);
}
const chIdx = args.indexOf('--channel');
const channel = chIdx !== -1 ? args[chIdx + 1] : null;
const skip = new Set([dbIdx, dbIdx + 1, chIdx, chIdx + 1].filter((i) => i >= 0));
const files = args.filter((_a, i) => !skip.has(i));
if (!files.length) { console.error('žádné dumpy'); process.exit(2); }

// "platform:id|ts|user|text" → {platform, id, ts, user, text}
const seen = new Map();
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  const m = txt.match(/"msgCacheIds"\s*:\s*\[([\s\S]*?)\]/);
  if (!m) { console.warn(`${f}: msgCacheIds nenalezeno (dump ze starší verze než 3.38.78?)`); continue; }
  for (const item of JSON.parse('[' + m[1] + ']')) {
    const [key, ts, user, ...textParts] = item.split('|');
    const [platform, ...rest] = key.split(':');
    seen.set(key, { platform, id: rest.join(':'), ts: Number(ts), user, text: textParts.join('|') });
  }
}
console.log(`dumpy: ${files.length}, unikátních zpráv: ${seen.size}`);

const sql = postgres(url, { max: 2 });

// Okno auditu: jen zprávy odeslané po prvním zápisu daného kanálu na dané
// platformě (ingest nemůže mít, co proběhlo před jeho startem). Bez --channel
// se bere první zápis platformy napříč kanály.
const firstRows = channel
  ? await sql`select platform, min(created_at) as first_in from messages where channel = ${channel} group by 1`
  : await sql`select platform, min(created_at) as first_in from messages group by 1`;
const firstIn = Object.fromEntries(firstRows.map((r) => [r.platform, new Date(r.first_in).getTime()]));
const byPlatform = { twitch: [], kick: [], youtube: [] };
let skippedBefore = 0;
for (const v of seen.values()) {
  if (!byPlatform[v.platform]) continue;
  if (firstIn[v.platform] && v.ts < firstIn[v.platform]) { skippedBefore++; continue; }
  byPlatform[v.platform].push(v);
}
console.log(`okno: ${channel || 'všechny kanály'}, start ingestu ${JSON.stringify(Object.fromEntries(Object.entries(firstIn).map(([k, v]) => [k, new Date(v).toISOString()])))}, mimo okno vynecháno: ${skippedBefore}`);

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
};
const crit = { twitch: { recall: 99.5, p95: 2000 }, kick: { recall: 99.5, p95: 2000 }, youtube: { recall: 95, p95: 10000 } };

let allOk = true;
for (const [platform, list] of Object.entries(byPlatform)) {
  if (!list.length) { console.log(`\n${platform}: v dumpech nic`); continue; }
  const ids = list.map((v) => v.id);
  // Latence jen pro zprávy přijaté živě: backlog z úvodní stránky (YouTube dá
  // při connectu i desítky minut starých zpráv) má created_at = čas startu,
  // ne latenci ingestu → vyloučit vše se sent_at před prvním zápisem kanálu.
  const rows = await sql`
    with f as (select platform, channel, min(created_at) as first_in from messages group by 1, 2)
    select m.platform_message_id as id,
           extract(epoch from (m.created_at - m.sent_at)) * 1000 as lat,
           (m.sent_at >= f.first_in) as live
    from messages m join f using (platform, channel)
    where m.platform = ${platform} and m.platform_message_id in ${sql(ids)}`;
  const found = new Map(rows.map((r) => [r.id, { lat: Number(r.lat), live: !!r.live }]));
  const missing = list.filter((v) => !found.has(v.id));
  const lat = [...found.values()].filter((x) => x.live).map((x) => x.lat);
  const recall = (found.size / list.length) * 100;
  const p95 = pct(lat, 0.95);
  const ok = recall >= crit[platform].recall && (p95 ?? Infinity) < crit[platform].p95;
  allOk &&= ok;
  console.log(`\n${platform}: seen=${list.length} found=${found.size} recall=${recall.toFixed(2)}% (≥${crit[platform].recall}) p50=${pct(lat, 0.5)}ms p95=${p95}ms (<${crit[platform].p95}) max=${pct(lat, 1)}ms → ${ok ? 'OK' : 'FAIL'}`);
  for (const v of missing.slice(0, 20)) console.log(`  chybí ${v.id} ${new Date(v.ts).toISOString()} ${v.user}: ${v.text}`);
  if (missing.length > 20) console.log(`  … a dalších ${missing.length - 20}`);
}
await sql.end();
console.log(`\n=== ${allOk ? 'PASS' : 'FAIL'} ===`);
process.exit(allOk ? 0 : 1);

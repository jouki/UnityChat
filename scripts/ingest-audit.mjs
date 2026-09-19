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
const postgres = require('../backend/node_modules/postgres');

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
if (dbIdx === -1 || !args[dbIdx + 1]) {
  console.error('usage: node scripts/ingest-audit.mjs --db <DATABASE_URL> dump.txt [...]');
  process.exit(2);
}
const url = args[dbIdx + 1];
const files = args.filter((_a, i) => i !== dbIdx && i !== dbIdx + 1);
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
const byPlatform = { twitch: [], kick: [], youtube: [] };
for (const v of seen.values()) byPlatform[v.platform]?.push(v);

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
  const rows = await sql`
    select platform_message_id as id, extract(epoch from (created_at - sent_at)) * 1000 as lat
    from messages where platform = ${platform} and platform_message_id in ${sql(ids)}`;
  const found = new Map(rows.map((r) => [r.id, Number(r.lat)]));
  const missing = list.filter((v) => !found.has(v.id));
  const lat = [...found.values()];
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import {
  PHASH_FRAMES, PHASH_MAX_HAMMING, PHASH_MIN_SCORE, dhashFromGray, hamming, pickFramesByTime, sequenceSimilarity,
  isSimilarSequence, computePhash, FLAT_HASH, PHASH_MAX_INPUT_PIXELS, PHASH_TOOL_TIMEOUT_MS,
} from './gifPhash.js';

// Syntetické animace: pruhy, které se posouvají (A), a šachovnice s rostoucím kruhem (B) — obsahově jiné.
const W = 96, H = 64, N = 16;
function framesA(w = W, h = H): Buffer[] {
  const out: Buffer[] = [];
  for (let f = 0; f < N; f++) {
    const b = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const xs = Math.floor((x * W) / w), ys = Math.floor((y * H) / h);
      const v = ((xs + f * 6) % 48 < 24) !== (ys < H / 2) ? 230 : 25;
      b[i] = v; b[i + 1] = Math.min(255, v + (ys * 2)); b[i + 2] = 255 - v;
    }
    out.push(b);
  }
  return out;
}
function framesB(): Buffer[] {
  const out: Buffer[] = [];
  for (let f = 0; f < N; f++) {
    const b = Buffer.alloc(W * H * 3);
    const r = 6 + f * 2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const inCircle = (x - W * 0.7) ** 2 + (y - H * 0.4) ** 2 < r * r;
      const checker = ((x >> 3) + (y >> 4)) % 2 === 0;
      const v = inCircle ? 250 : checker ? 170 - y * 2 : 40 + x;
      b[i] = v; b[i + 1] = v; b[i + 2] = v;
    }
    out.push(b);
  }
  return out;
}
const encode = (frames: Buffer[], w: number, h: number, fmt: 'gif' | 'webp') => {
  const img = sharp(Buffer.concat(frames), { raw: { width: w, height: h * frames.length, channels: 3, pageHeight: h } });
  return (fmt === 'gif' ? img.gif({ delay: Array(frames.length).fill(80), loop: 0 }) : img.webp({ delay: Array(frames.length).fill(80), quality: 40 })).toBuffer();
};

test('dhashFromGray: 9×8 → 16 hex, rostoucí řádky = samé 1, plochý snímek = FLAT_HASH', () => {
  const up = Buffer.alloc(72);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) up[y * 9 + x] = x * 20;
  assert.equal(dhashFromGray(up), 'ffffffffffffffff');
  const down = Buffer.alloc(72);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) down[y * 9 + x] = 200 - x * 20;
  assert.equal(dhashFromGray(down), '0000000000000000');
  assert.equal(dhashFromGray(Buffer.alloc(72, 128)), FLAT_HASH);
  assert.equal(hamming('ffffffffffffffff', '0000000000000000'), 64);
  assert.equal(hamming('00000000000000f0', '0000000000000000'), 4);
});

test('pickFramesByTime: rovnoměrně v čase podle délek snímků; méně snímků než N = všechny', () => {
  assert.deepEqual(pickFramesByTime([100, 100, 100], 8), [0, 1, 2]);
  // 16 × 100 ms, středy osmin času 100, 300, … 1500 ms.
  assert.deepEqual(pickFramesByTime(Array(16).fill(100), 8), [1, 3, 5, 7, 9, 11, 13, 15]);
  // Zpoždění < 20 ms prohlížeče berou jako 100 ms (4 × 100 ms, středy polovin 100 a 300 ms).
  assert.deepEqual(pickFramesByTime([0, 0, 0, 0], 2), [1, 3]);
  // Dlouhý první snímek zabere většinu času → vybere se vícekrát (sekvence odpovídá času, jako fps u MP4).
  assert.deepEqual(pickFramesByTime([1000, 10, 10, 10], 3), [0, 0, 1]);
  assert.deepEqual(pickFramesByTime([], 8), []);
});

test('sequenceSimilarity: posunuté zarovnání, podíl shod ≤ 10 bitů vůči kratší sekvenci', () => {
  const a = ['0f0f0f0f0f0f0f0f', 'f0f0f0f0f0f0f0f0', '00ff00ff00ff00ff', 'ff00ff00ff00ff00'];
  assert.equal(sequenceSimilarity(a, a), 1);
  // Posun o 1 (oříznutý začátek).
  assert.equal(sequenceSimilarity(a, a.slice(1)), 1);
  assert.equal(sequenceSimilarity(a, ['123456789abcdef0']), 0);
  // Ploché snímky se nepočítají jako shoda (černé GIFy nejsou duplikáty).
  assert.equal(sequenceSimilarity([FLAT_HASH, FLAT_HASH], [FLAT_HASH, FLAT_HASH]), 0);
  assert.equal(sequenceSimilarity([], a), 0);
  assert.equal(PHASH_FRAMES, 8);
  assert.equal(PHASH_MAX_HAMMING, 10);
  assert.equal(PHASH_MIN_SCORE, 0.6);
});

test('computePhash: stejný GIF překomprimovaný do WebP a zmenšený = podobný; jiný GIF = nepodobný', async () => {
  const gif = await encode(framesA(), W, H, 'gif');
  const smallWebp = await encode(framesA(48, 32), 48, 32, 'webp');
  const other = await encode(framesB(), W, H, 'gif');
  const ha = await computePhash(gif, 'gif');
  const hb = await computePhash(smallWebp, 'webp');
  const hc = await computePhash(other, 'gif');
  assert.ok(ha && hb && hc);
  assert.equal(ha!.length, PHASH_FRAMES);
  assert.ok(ha!.every((h) => /^[0-9a-f]{16}$/.test(h)));
  assert.ok(isSimilarSequence(ha!, hb!), `podobné: ${sequenceSimilarity(ha!, hb!)}`);
  assert.ok(!isSimilarSequence(ha!, hc!), `nepodobné: ${sequenceSimilarity(ha!, hc!)}`);
});

test('computePhash: statický obrázek (1 snímek) = jeden hash', async () => {
  const png = await sharp(framesA()[0], { raw: { width: W, height: H, channels: 3 } }).gif().toBuffer();
  const h = await computePhash(png, 'gif');
  assert.equal(h?.length, 1);
});

test('computePhash: poškozená data / chybějící nástroj → null a varování, nic nevyhodí', async () => {
  const warns: string[] = [];
  const log = { warn: (_o: object, m: string) => { warns.push(m); } };
  assert.equal(await computePhash(Buffer.from('GIF89a nesmysl'), 'gif', { log }), null);
  assert.equal(await computePhash(Buffer.from('xxxxftypisom'), 'mp4', { log, ffmpeg: 'neexistujici-ffmpeg-xyz', ffprobe: 'neexistujici-ffprobe-xyz' }), null);
  assert.equal(await computePhash(Buffer.from('GIF89a'), 'gif', { log, loadSharp: async () => { throw new Error('sharp chybí'); } }), null);
  assert.ok(warns.length >= 3);
});

test('computePhash: výpočet přes limit (zaseknutý sharp) → null + varování; strop pixelů vstupu', async () => {
  const warns: Array<Record<string, unknown>> = [];
  const log = { warn: (o: object) => { warns.push(o as Record<string, unknown>); } };
  let seenOpts: Record<string, unknown> | null = null;
  const stuck = (async () => ((_b: Buffer, o: Record<string, unknown>) => { seenOpts = o; return { metadata: () => new Promise(() => {}) }; })) as never;
  const t0 = Date.now();
  assert.equal(await computePhash(Buffer.from('GIF89a'), 'gif', { log, loadSharp: stuck, timeoutMs: 50 }), null);
  assert.ok(Date.now() - t0 < 2000);
  assert.match(String(warns[0]?.err), /timeout/);
  assert.equal((seenOpts as unknown as Record<string, unknown>)?.limitInputPixels, PHASH_MAX_INPUT_PIXELS);
  assert.equal(PHASH_TOOL_TIMEOUT_MS, 20_000);
});

const hasFfmpeg =(() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('computePhash: MP4 přes ffmpeg — stejný obsah jako GIF = podobný', { skip: hasFfmpeg ? false : 'ffmpeg není v PATH' }, async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'phash-test-'));
  try {
    const gif = await encode(framesA(), W, H, 'gif');
    writeFileSync(join(dir, 'a.gif'), gif);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(dir, 'a.gif'), '-pix_fmt', 'yuv420p', '-vf', 'scale=48:32', '-movflags', '+faststart', join(dir, 'a.mp4')]);
    const mp4 = readFileSync(join(dir, 'a.mp4'));
    const hm = await computePhash(mp4, 'mp4');
    const hg = await computePhash(gif, 'gif');
    const ho = await computePhash(await encode(framesB(), W, H, 'gif'), 'gif');
    assert.ok(hm && hm.length >= 6, `mp4 snímků: ${hm?.length}`);
    assert.ok(isSimilarSequence(hg!, hm!), `gif~mp4: ${sequenceSimilarity(hg!, hm!)}`);
    assert.ok(!isSimilarSequence(ho!, hm!), `jiný~mp4: ${sequenceSimilarity(ho!, hm!)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

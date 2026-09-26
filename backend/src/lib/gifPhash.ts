// Perceptuální hash GIFů (GIF knihovna 2026-09-26, spec docs/superpowers/specs/2026-09-26-gif-knihovna-design.md §3,
// plán Task 2): návrhy duplikátů k potvrzení modem, nic se neslučuje samo.
//
//   computePhash(bytes, kind) → pole dHashů (64 bit, 16 hex) z N = 8 snímků rozprostřených rovnoměrně v čase;
//                               GIF / WebP přes `sharp` (všechny snímky naráz zmenšené na 9×8), MP4 přes `ffmpeg`
//                               (`-vf fps=N/délka`). Chybí nástroj / poškozená data → null + varování, nikdy výjimka.
//   sequenceSimilarity(a, b)  → podíl snímků s Hammingovou vzdáleností ≤ 10 přes posunuté zarovnání sekvencí
//                               (posun = oříznutý začátek/konec), vůči kratší sekvenci; ≥ 0,6 = návrh duplikátu.
//
// dHash je odolný vůči kompresi a rozlišení (snímek se zmenší na 9×8 v šedi a porovnají se sousední pixely).
// Plochý snímek (všechny pixely stejné → hash 0) se za shodu nepočítá — dva černé GIFy nejsou duplikát.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GifKind } from './gifMedia.js';

export const PHASH_FRAMES = 8;
export const PHASH_MAX_HAMMING = 10;
export const PHASH_MIN_SCORE = 0.6;
/** Hash plochého snímku (i klesajícího přechodu) — do shody se nepočítá. */
export const FLAT_HASH = '0000000000000000';
/** Časový limit ffmpeg / ffprobe. */
export const PHASH_TOOL_TIMEOUT_MS = 20_000;

const HASH_RE = /^[0-9a-f]{16}$/;

/** Šedý snímek 9×8 (řádky po 9 bajtech, `stride` bajtů na pixel) → dHash 16 hex (bit = levý pixel < pravý). */
export function dhashFromGray(buf: Uint8Array, offset = 0, stride = 1): string {
  let hi = 0, lo = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const l = buf[offset + (y * 9 + x) * stride], r = buf[offset + (y * 9 + x + 1) * stride];
      const bit = l < r ? 1 : 0;
      const k = y * 8 + x;
      if (k < 32) hi = ((hi << 1) | bit) >>> 0; else lo = ((lo << 1) | bit) >>> 0;
    }
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

const popcount = (n: number): number => { n = n - ((n >>> 1) & 0x55555555); n = (n & 0x33333333) + ((n >>> 2) & 0x33333333); return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };

/** Hammingova vzdálenost dvou hashů (16 hex); neplatný vstup = 64. */
export function hamming(a: string, b: string): number {
  if (!HASH_RE.test(a) || !HASH_RE.test(b)) return 64;
  return popcount((parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0) + popcount((parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16)) >>> 0);
}

/**
 * Indexy snímků rovnoměrně v čase: středy N stejných dílů celkové délky (zpoždění < 20 ms = 100 ms jako
 * v prohlížečích). Snímků ≤ N → všechny. Dlouhý snímek se může vybrat víckrát (sekvence odpovídá času).
 */
export function pickFramesByTime(delays: number[], n: number = PHASH_FRAMES): number[] {
  const count = delays.length;
  if (count <= n) return Array.from({ length: count }, (_, i) => i);
  const d = delays.map((v) => (Number.isFinite(v) && v >= 20 ? v : 100));
  const total = d.reduce((s, v) => s + v, 0);
  const out: number[] = [];
  let frame = 0, end = d[0];
  for (let k = 0; k < n; k++) {
    const t = ((k + 0.5) * total) / n;
    while (t >= end && frame < count - 1) { frame++; end += d[frame]; }
    out.push(frame);
  }
  return out;
}

/** Indexy rovnoměrně podle pořadí (snímky se stejnou délkou — výstup ffmpeg). */
function pickEven(count: number, n: number): number[] {
  return pickFramesByTime(Array(count).fill(100), n);
}

const match = (a: string, b: string): boolean => a !== FLAT_HASH && b !== FLAT_HASH && hamming(a, b) <= PHASH_MAX_HAMMING;

/**
 * Podobnost dvou sekvencí hashů 0–1: nejlepší posunuté zarovnání (a[i] ↔ b[i + s]), počet shod
 * (Hamming ≤ PHASH_MAX_HAMMING) vůči délce kratší sekvence.
 */
export function sequenceSimilarity(a: string[], b: string[]): number {
  const la = a.length, lb = b.length;
  const min = Math.min(la, lb);
  if (!min) return 0;
  let best = 0;
  for (let s = -(la - 1); s <= lb - 1; s++) {
    let hits = 0;
    for (let i = Math.max(0, -s); i < la && i + s < lb; i++) if (match(a[i], b[i + s])) hits++;
    if (hits > best) best = hits;
  }
  return best / min;
}

export const isSimilarSequence = (a: string[], b: string[]): boolean => sequenceSimilarity(a, b) >= PHASH_MIN_SCORE;

// ---------------------------------------------------------------------------
// Výpočet
// ---------------------------------------------------------------------------

type Log = { warn: (o: object, m: string) => void };
type SharpFn = typeof import('sharp');

export interface PhashDeps {
  log?: Log;
  /** Načtení `sharp` (testy); výchozí dynamický import — chybějící modul = hash null, server běží dál. */
  loadSharp?: () => Promise<SharpFn>;
  ffmpeg?: string;
  ffprobe?: string;
  timeoutMs?: number;
}

const defaultLoadSharp = async (): Promise<SharpFn> => (await import('sharp')).default as unknown as SharpFn;

/** GIF / WebP: všechny snímky naráz zmenšené na 9×8 v šedi (průhlednost na šedém pozadí), výběr podle času. */
async function framesViaSharp(bytes: Buffer, deps: PhashDeps): Promise<string[]> {
  const sharp = await (deps.loadSharp ?? defaultLoadSharp)();
  const md = await sharp(bytes, { animated: true }).metadata();
  const { data, info } = await sharp(bytes, { animated: true })
    .flatten({ background: '#808080' }).greyscale().resize(9, 8, { fit: 'fill' }).raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels || 1;
  const frameBytes = 72 * ch;
  const count = Math.floor(data.length / frameBytes);
  const delays = Array.from({ length: count }, (_, i) => (Array.isArray(md.delay) ? md.delay[i] : undefined) ?? 100);
  return pickFramesByTime(delays).map((i) => dhashFromGray(data, i * frameBytes, ch));
}

const run = (cmd: string, args: string[], timeoutMs: number, binary: boolean) => new Promise<{ stdout: Buffer | string }>((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8', windowsHide: true }, (err, stdout) => {
    if (err) reject(err); else resolve({ stdout });
  });
});

/** MP4: dočasný soubor (moov může být na konci → potřeba seek), ffprobe délka, ffmpeg `fps=N/délka` → 9×8 šedé. */
async function framesViaFfmpeg(bytes: Buffer, deps: PhashDeps): Promise<string[]> {
  const timeout = deps.timeoutMs ?? PHASH_TOOL_TIMEOUT_MS;
  const dir = await mkdtemp(join(tmpdir(), 'uc-phash-'));
  const file = join(dir, 'm.mp4');
  try {
    await writeFile(file, bytes);
    const probe = await run(deps.ffprobe ?? 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], timeout, false);
    const duration = Number(String(probe.stdout).trim());
    const known = Number.isFinite(duration) && duration > 0;
    // Středy N dílů (jako u GIFu): začít o půl intervalu později, pak N snímků za celou délku.
    const seek = known ? ['-ss', (duration / PHASH_FRAMES / 2).toFixed(6)] : [];
    const fps = known ? `fps=${(PHASH_FRAMES / duration).toFixed(6)},` : '';
    const out = await run(deps.ffmpeg ?? 'ffmpeg', ['-v', 'error', '-nostdin', ...seek, '-i', file, '-frames:v', '2000', '-vf', `${fps}scale=9:8:flags=area,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], timeout, true);
    const raw = out.stdout as Buffer;
    const count = Math.floor(raw.length / 72);
    return pickEven(count, PHASH_FRAMES).map((i) => dhashFromGray(raw, i * 72));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Pole hashů média, nebo null (nástroj chybí / selhal / bez snímků) — varování do logu, nikdy výjimka. */
export async function computePhash(bytes: Buffer, kind: GifKind, deps: PhashDeps = {}): Promise<string[] | null> {
  try {
    const hashes = kind === 'mp4' ? await framesViaFfmpeg(bytes, deps) : await framesViaSharp(bytes, deps);
    if (!hashes.length) { deps.log?.warn({ kind }, 'gif phash: médium bez snímků'); return null; }
    return hashes;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    deps.log?.warn({ kind, err: err.code === 'ENOENT' ? `${kind === 'mp4' ? 'ffmpeg' : 'sharp'} chybí` : String(err.message || err).slice(0, 200) }, 'gif phash: výpočet selhal');
    return null;
  }
}

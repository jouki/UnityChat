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
import { GifError, type GifKind, type MediaProbe } from './gifMedia.js';

export const PHASH_FRAMES = 8;
export const PHASH_MAX_HAMMING = 10;
export const PHASH_MIN_SCORE = 0.6;
/** Hash plochého snímku (i klesajícího přechodu) — do shody se nepočítá. */
export const FLAT_HASH = '0000000000000000';
/** Časový limit výpočtu (ffmpeg / ffprobe se po něm zabije SIGKILL, sharp se přestane čekat). */
export const PHASH_TOOL_TIMEOUT_MS = 20_000;
/**
 * Strop pixelů vstupu pro sharp (u animace šířka × výška × snímky) — proti dekompresní bombě. 25 M px = ~100 MB RGBA
 * (audit SEC-7; nová média navíc projdou limitem GIF_MAX_DIM / GIF_MAX_FRAMES už při stažení).
 */
export const PHASH_MAX_INPUT_PIXELS = 25_000_000;
/** Časový limit sondy média při stažení (probeMedia). */
export const PROBE_TIMEOUT_MS = 10_000;

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
// sharp 0.35: modul je ESM s default exportem (SharpConstructor), `typeof import('sharp')` je jen namespace.
type SharpFn = (typeof import('sharp'))['default'];

export interface PhashDeps {
  log?: Log;
  /** Načtení `sharp` (testy); výchozí dynamický import — chybějící modul = hash null, server běží dál. */
  loadSharp?: () => Promise<SharpFn>;
  ffmpeg?: string;
  ffprobe?: string;
  timeoutMs?: number;
}

const defaultLoadSharp = async (): Promise<SharpFn> => {
  const s = (await import('sharp')).default as unknown as SharpFn;
  // Jedno vlákno libvips: hash běží na pozadí a nesmí brát CPU VPS ingestu a API.
  s.concurrency(1);
  return s;
};

/** Promise s limitem; po vypršení výjimka `timeout` (práce sama se nezruší, jen se na ni přestane čekat). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`timeout ${ms} ms`)), ms); t.unref?.(); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

/** GIF / WebP: všechny snímky naráz zmenšené na 9×8 v šedi (průhlednost na šedém pozadí), výběr podle času. */
async function framesViaSharp(bytes: Buffer, deps: PhashDeps): Promise<string[]> {
  const sharp = await (deps.loadSharp ?? defaultLoadSharp)();
  const opts = { animated: true, limitInputPixels: PHASH_MAX_INPUT_PIXELS };
  const md = await sharp(bytes, opts).metadata();
  const { data, info } = await sharp(bytes, opts)
    .flatten({ background: '#808080' }).greyscale().resize(9, 8, { fit: 'fill' }).raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels || 1;
  const frameBytes = 72 * ch;
  const count = Math.floor(data.length / frameBytes);
  const delays = Array.from({ length: count }, (_, i) => (Array.isArray(md.delay) ? md.delay[i] : undefined) ?? 100);
  return pickFramesByTime(delays).map((i) => dhashFromGray(data, i * frameBytes, ch));
}

const run = (cmd: string, args: string[], timeoutMs: number, binary: boolean) => new Promise<{ stdout: Buffer | string }>((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8', windowsHide: true }, (err, stdout) => {
    if (err) reject(err); else resolve({ stdout });
  });
});

/** Vstup ffmpeg / ffprobe: vždy MP4 demuxer a jen lokální soubor. */
const MP4_INPUT = ['-f', 'mp4', '-protocol_whitelist', 'file'];

/** Dočasný soubor s médiem (MP4: moov může být na konci → nástroje potřebují seek). */
async function withTempFile<T>(bytes: Buffer, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'uc-gif-'));
  try {
    const file = join(dir, 'm.mp4');
    await writeFile(file, bytes);
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Sonda média při stažení (audit SEC-7) — rozměr snímku a počet snímků BEZ dekódování pixelů:
 * GIF / WebP přes `sharp().metadata()` (animated), MP4 přes `ffprobe -count_packets` (pakety, ne dekódování).
 * Nástroj chybí → null (volající se spolehne na hlavičku); poškozené médium / timeout → GifError('bad_media').
 */
export async function probeMedia(bytes: Buffer, kind: GifKind, deps: PhashDeps = {}): Promise<MediaProbe | null> {
  const timeout = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  if (kind === 'mp4') {
    return withTempFile(bytes, async (file) => {
      let out: { stdout: Buffer | string };
      try {
        out = await run(deps.ffprobe ?? 'ffprobe', ['-v', 'error', ...MP4_INPUT, '-select_streams', 'v:0', '-count_packets',
          '-show_entries', 'stream=width,height,nb_read_packets', '-of', 'json', file], timeout, false);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new GifError('bad_media');
      }
      let st: Record<string, unknown> | undefined;
      try { st = (JSON.parse(String(out.stdout)) as { streams?: Array<Record<string, unknown>> }).streams?.[0]; } catch { st = undefined; }
      if (!st) throw new GifError('bad_media');
      const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
      return { width: num(st.width), height: num(st.height), frames: num(st.nb_read_packets) };
    });
  }
  let sharp: SharpFn;
  try { sharp = await (deps.loadSharp ?? defaultLoadSharp)(); } catch { return null; }
  try {
    // metadata() čte hlavičky snímků, pixely nedekóduje → strop pixelů tu není potřeba (počet snímků teprve zjišťujeme).
    const md = await withTimeout(sharp(bytes, { animated: true, limitInputPixels: false }).metadata(), timeout);
    const w = md.width ?? null, h = md.pageHeight ?? md.height ?? null;
    return { width: w, height: h, frames: md.pages ?? 1 };
  } catch {
    throw new GifError('bad_media');
  }
}

/** MP4: dočasný soubor (moov může být na konci → potřeba seek), ffprobe délka, ffmpeg `fps=N/délka` → 9×8 šedé. */
async function framesViaFfmpeg(bytes: Buffer, deps: PhashDeps): Promise<string[]> {
  const timeout = deps.timeoutMs ?? PHASH_TOOL_TIMEOUT_MS;
  return withTempFile(bytes, async (file) => {
    // -f mp4 + jen protokol file: demuxer podle obsahu (HLS, concat…) by mohl sahat jinam (audit SEC-7).
    const probe = await run(deps.ffprobe ?? 'ffprobe', ['-v', 'error', ...MP4_INPUT, '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], timeout, false);
    const duration = Number(String(probe.stdout).trim());
    const known = Number.isFinite(duration) && duration > 0;
    // Středy N dílů (jako u GIFu): začít o půl intervalu později, pak N snímků za celou délku.
    const seek = known ? ['-ss', (duration / PHASH_FRAMES / 2).toFixed(6)] : [];
    const fps = known ? `fps=${(PHASH_FRAMES / duration).toFixed(6)},` : '';
    // -threads 1 (dekodér) + -filter_threads 1: jedno vlákno, hash nesmí brát CPU VPS.
    const out = await run(deps.ffmpeg ?? 'ffmpeg', ['-v', 'error', '-nostdin', '-threads', '1', ...seek, ...MP4_INPUT, '-i', file, '-filter_threads', '1', '-threads', '1', '-frames:v', '2000', '-vf', `${fps}scale=9:8:flags=area,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], timeout, true);
    const raw = out.stdout as Buffer;
    const count = Math.floor(raw.length / 72);
    return pickEven(count, PHASH_FRAMES).map((i) => dhashFromGray(raw, i * 72));
  });
}

/** Pole hashů média, nebo null (nástroj chybí / selhal / bez snímků) — varování do logu, nikdy výjimka. */
export async function computePhash(bytes: Buffer, kind: GifKind, deps: PhashDeps = {}): Promise<string[] | null> {
  try {
    // Celkový strop i pro ffmpeg (ffprobe + ffmpeg mají každý vlastní kill, dohromady by mohly překročit).
    const hashes = await withTimeout(kind === 'mp4' ? framesViaFfmpeg(bytes, deps) : framesViaSharp(bytes, deps), deps.timeoutMs ?? PHASH_TOOL_TIMEOUT_MS);
    if (!hashes.length) { deps.log?.warn({ kind }, 'gif phash: médium bez snímků'); return null; }
    return hashes;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    deps.log?.warn({ kind, err: err.code === 'ENOENT' ? `${kind === 'mp4' ? 'ffmpeg' : 'sharp'} chybí` : String(err.message || err).slice(0, 200) }, 'gif phash: výpočet selhal');
    return null;
  }
}

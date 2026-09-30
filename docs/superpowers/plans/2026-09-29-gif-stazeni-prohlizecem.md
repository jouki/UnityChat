# GIF — stažení prohlížečem odesílatele: implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Když host blokuje IP serveru (imgur: 429 na stránky i CDN), server získá popis média (adresa + typ + rozměry), požádá odesílatele s účtem UnityChatu, ať médium stáhne jeho prohlížeč a nahraje ho; server nahrané bajty ověří proti popisu a pustí je běžnou cestou (fronta / knihovna). Volbu si účet může zapamatovat. Proxy modul Bright Data (pro imgur nepoužitelný) se odstraní.

**Architecture:** Backend: `gifMedia.ts` dostane registr blokujících hostů + popis zdroje přes Web Unlocker; nový `lib/gifClientFetch.ts` drží jednorázové granty (token → Promise<ResolvedGif|null>), na které `gifRequests.intercept` čeká místo selhání; routy `POST /gif/client-upload`, `POST /gif/client-fetch/decline`, `PUT /account/gif-prefs`. Klient (sdílený core `gif-library.js` + nový `gif-client-fetch.js`): fáze `client_fetch` v GifOutboxu → štítek s tlačítky → `fetch()` z prohlížeče → upload; addon a web jen dodají `upload`/`decline`/nastavení.

**Tech Stack:** Node 22 + TypeScript (Fastify 5, Drizzle, `node --test` přes tsx s `.env.test`), ES moduly v `extension/core/` (bez `chrome.*`/DOM tam, kde to jde), e2e přes headless Chrome + CDP (`scripts/e2e-gif.mjs`, `web/scripts/e2e-gif.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-29-gif-stazeni-prohlizecem-design.md`

## Global Constraints

- Česky s diakritikou v UI textech, komentářích i commitech; žádné slovo „donace“.
- Backend se z `dev` nasazuje rovnou na produkci: **SQL (`backend/sql/2026-09-29-gif-client-fetch.sql`) spustit na produkci PŘED pushem** tasku, který na sloupce sahá (Task 6).
- Před každým pushem backendu `npx tsc --noEmit -p .` (testy se kompilují taky) a `npm test` (jediný známý lokální pád: `gifPhash.test.ts` bez `sharp`).
- Token grantu, Bearer ani obsah média nikdy do logu; log jen host + kód.
- Limity média beze změny: `GIF_MAX_BYTES` 10 MiB, `GIF_MAX_DIM` 2048, `GIF_MAX_FRAMES` 600.
- Klient adresu média nikdy nevolí — vždy `url` z grantu.
- Commity: `type(scope): popis (vX.Y.Z)` + `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; addon verze jen třetí číslo (3.41.x); `git add` jen konkrétních souborů; před pushem `git pull --rebase origin dev`; nikdy `git stash pop`.
- Web žije v `D:\_BACKUP_2.0\Code Projects\UnityChat-web` (mirror + `web/`): sdílené soubory (`extension/core/*`) se mění **jen** v UnityChat repu; web je převezme `git fetch upstream && git merge upstream/dev`. Deploy webu: `cd web && npx vite build && npm run deploy`.
- Release do master / storu nenavrhovat.

---

## Soubory

**Backend (`backend/src/`)**
- Modify `lib/gifMedia.ts` — smazat proxy vazbu; `BlockedHosts`, `GifError('host_blocked')`, `pickOgDescriptor`, `describeGifSource`, unlocker i pro blokujícího hosta.
- Delete `lib/gifProxy.ts`, `lib/gifProxy.test.ts`.
- Create `lib/gifClientFetch.ts` (+ `.test.ts`) — granty.
- Create `lib/gifPrefs.ts` — předvolba účtu `client_fetch`.
- Modify `lib/gifRequests.ts` — intercept čeká na klienta; `saveMedia` se `source`; meta `clientFetched`; `pendingView.media.clientFetched`.
- Modify `routes/gif.ts` (+ `gif.test.ts`) — upload, decline, prefs; `routes/webAuth.ts` (`/auth/me`).
- Modify `db/schema.ts`, Create `sql/2026-09-29-gif-client-fetch.sql`.
- Modify `config.ts`, `server.ts`, `.env.example`, `README.md`.

**Core (`extension/core/`)**
- Modify `gif-library.js` — fáze `client_fetch`, stavy, štítek s tlačítky.
- Create `gif-client-fetch.js` — stažení v prohlížeči + upload + delegované klikání.
- Modify `gif.js` — karta moda: štítek „z prohlížeče odesílatele“.
- Modify `core-bridge.js`, `gif.css`.

**Hosté**
- Modify `extension/sidepanel.js`, `extension/sidepanel.html`, `extension/manifest.json`.
- Modify `UnityChat-web/web/src/main.js`, `settings.js`, `auth.js`.

**Testy**
- Modify `scripts/test-gif-library.js`, `scripts/e2e-gif.mjs`, `UnityChat-web/web/scripts/e2e-gif.mjs`.

---

### Task 1: Odstranit proxy modul Bright Data

**Files:**
- Delete: `backend/src/lib/gifProxy.ts`, `backend/src/lib/gifProxy.test.ts`
- Modify: `backend/src/lib/gifMedia.ts` (import `GifProxy`, `FetchDeps.proxy`, `transportFor`), `backend/src/lib/gifMedia.test.ts` (test „host blokující IP serveru … deps.proxy“), `backend/src/config.ts` (`BRIGHTDATA_CUSTOMER_ID`, `BRIGHTDATA_PROXY_PASSWORD`, `BRIGHTDATA_PROXY_CA`), `backend/src/server.ts` (`createGifProxy`, `gifProxy`, `proxy: gifProxy`), `backend/.env.example`, `backend/README.md` (odstavec „native proxy mode“)

**Interfaces:**
- Produces: `FetchDeps` bez `proxy`; `safeGet` zpět na `const transport = deps.transport ?? nodeTransport;` (Task 2 ho znovu upraví).

- [ ] **Step 1: Smazat soubory a vazby**

```bash
cd "D:/_BACKUP_2.0/Code Projects/UnityChat/backend"
git rm -q src/lib/gifProxy.ts src/lib/gifProxy.test.ts
```
V `src/lib/gifMedia.ts`: smazat řádek `import type { GifProxy } from './gifProxy.js';`, z `FetchDeps` blok
```ts
  /** Proxy Bright Data pro hosty, které blokují IP serveru úplně — stránky i CDN (Imgur; lib/gifProxy.ts). null = vypnuto. */
  proxy?: GifProxy | null;
```
a v `safeGet` nahradit
```ts
  // Host blokující IP serveru → proxy (lib/gifProxy.ts); každý hop přesměrování zvlášť. Veřejnost adresy se ověří i tak.
  const transportFor = (u: URL): Transport => deps.proxy?.transportFor(u.hostname) ?? deps.transport ?? nodeTransport;
```
za `const transport = deps.transport ?? nodeTransport;` a volání `transportFor(url)(url, …)` za `transport(url, …)`.
V `gifMedia.test.ts` smazat celý test `resolveGif: host blokující IP serveru (imgur.com, i.imgur.com) jde přes deps.proxy…`.
V `config.ts` smazat tři proměnné `BRIGHTDATA_CUSTOMER_ID`, `BRIGHTDATA_PROXY_PASSWORD`, `BRIGHTDATA_PROXY_CA` i jejich komentář. V `server.ts` smazat import `createGifProxy`, blok `const gifProxy = createGifProxy({...});` a v `resolve:` volání odstranit `, proxy: gifProxy`. V `.env.example` smazat řádky `BRIGHTDATA_CUSTOMER_ID=`, `BRIGHTDATA_PROXY_PASSWORD=`, `BRIGHTDATA_PROXY_CA=` s komentářem. V `README.md` odstavec o „native proxy mode“ nahradit jednou větou: „Hosts that block the VPS IP entirely (Imgur) are handled by the sender's browser, see `docs/superpowers/specs/2026-09-29-gif-stazeni-prohlizecem-design.md`.“

- [ ] **Step 2: Ověřit**

Run: `npx tsc --noEmit -p . && npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `fail 1` jen `gifPhash.test.ts` (chybí `sharp` lokálně), jinak pass.

- [ ] **Step 3: Commit**

```bash
cd .. && git add -A backend/src/lib/gifProxy.ts backend/src/lib/gifProxy.test.ts backend/src/lib/gifMedia.ts backend/src/lib/gifMedia.test.ts backend/src/config.ts backend/src/server.ts backend/.env.example backend/README.md
git commit -m "chore(backend): proxy Bright Data pryč — pro imgur nepoužitelná (médium vrací jako HTML)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
(Operátor po nasazení smaže z Coolify env `BRIGHTDATA_CUSTOMER_ID` a `BRIGHTDATA_PROXY_PASSWORD` — viz závěr plánu.)

---

### Task 2: Blokující hosty + popis zdroje přes unlocker (`gifMedia.ts`)

**Files:**
- Modify: `backend/src/lib/gifMedia.ts`
- Test: `backend/src/lib/gifMedia.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BlockedHosts { isBlocked(host: string): boolean; mark(host: string): void; readonly size: number }
  export function createBlockedHosts(o?: { ttlMs?: number; max?: number; now?: () => number }): BlockedHosts;
  export const BLOCKED_HOST_TTL_MS = 24 * 3_600_000;
  export interface GifDescriptor { url: string; kind: GifKind | null; width: number | null; height: number | null; host: string }
  export function pickOgDescriptor(html: string, base: URL): GifDescriptor | null;
  export function sameSite(a: URL, b: URL): boolean;   // stejné registrované jméno (poslední 2 popisky hostu)
  export async function describeGifSource(src: GifSource, deps: FetchDeps & { timeoutMs?: number }): Promise<GifDescriptor | null>;
  // FetchDeps navíc: blockedHosts?: BlockedHosts | null
  // GifError kód 'host_blocked' (429/403 mimo Cloudflare challenge, jen když deps.blockedHosts existuje)
  ```

- [ ] **Step 1: Testy**

Do `gifMedia.test.ts` přidat (import rozšířit o `createBlockedHosts, pickOgDescriptor, sameSite, describeGifSource`):

```ts
test('blockedHosts: 429 mimo challenge → host si zapamatuje, kód host_blocked; bez registru zůstává http_429', async () => {
  const transport = fakeTransport({ 'https://i.imgur.com/a.mp4': { status: 429, headers: {}, body: Buffer.from('') } });
  await assert.rejects(resolveGif({ url: 'https://i.imgur.com/a.mp4', mode: 'direct' }, { transport, lookupAll: publicDns }), (e: GifError) => e.code === 'http_429');
  const blocked = createBlockedHosts({ now: () => 1000 });
  await assert.rejects(resolveGif({ url: 'https://i.imgur.com/a.mp4', mode: 'direct' }, { transport, lookupAll: publicDns, blockedHosts: blocked }), (e: GifError) => e.code === 'host_blocked');
  assert.equal(blocked.isBlocked('i.imgur.com'), true);
  assert.equal(blocked.isBlocked('IMGUR.com.'), true, 'subdomény i kořen téhož místa');
  assert.equal(blocked.isBlocked('tenor.com'), false);
});

test('blockedHosts: známý host → přímé stažení se přeskočí (transport se nevolá) a jde se přes unlocker; TTL 24 h', async () => {
  let t = 1000;
  const blocked = createBlockedHosts({ now: () => t });
  blocked.mark('imgur.com');
  const direct: string[] = [];
  const transport: Transport = async (url) => { direct.push(url.toString()); return { status: 429, headers: {}, body: (async function* () {})(), dispose() {} }; };
  const page = Buffer.from('<meta property="og:video" content="https://i.imgur.com/auBmmCk.mp4"><meta property="og:video:width" content="640"><meta property="og:video:height" content="360">');
  const unlocker = { timeoutMs: 25_000, fetch: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: (async function* () { yield page; })(), dispose() {} }), report() {} };
  const d = await describeGifSource({ url: 'https://imgur.com/a/8as1KiG', mode: 'page' }, { transport, lookupAll: publicDns, blockedHosts: blocked, unlocker });
  assert.deepEqual(d, { url: 'https://i.imgur.com/auBmmCk.mp4', kind: 'mp4', width: 640, height: 360, host: 'i.imgur.com' });
  assert.deepEqual(direct, [], 'blokovaný host se přímo nevolá');
  t += 24 * 3_600_000 + 1;
  assert.equal(blocked.isBlocked('imgur.com'), false, 'po TTL znovu naostro');
});

test('describeGifSource: direct = adresa + typ z přípony bez rozměrů; médium na cizím místě než stránka → null; bez og → null', async () => {
  const blocked = createBlockedHosts();
  blocked.mark('imgur.com');
  const d = await describeGifSource({ url: 'https://i.imgur.com/x.gif', mode: 'direct' }, { lookupAll: publicDns, blockedHosts: blocked });
  assert.deepEqual(d, { url: 'https://i.imgur.com/x.gif', kind: 'gif', width: null, height: null, host: 'i.imgur.com' });
  const mk = (html: string) => ({ timeoutMs: 25_000, fetch: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: (async function* () { yield Buffer.from(html); })(), dispose() {} }), report() {} });
  assert.equal(await describeGifSource({ url: 'https://imgur.com/a/x', mode: 'page' }, { lookupAll: publicDns, blockedHosts: blocked, unlocker: mk('<meta property="og:video" content="https://evil.example/a.mp4">') }), null);
  assert.equal(await describeGifSource({ url: 'https://imgur.com/a/x', mode: 'page' }, { lookupAll: publicDns, blockedHosts: blocked, unlocker: mk('<title>nic</title>') }), null);
  assert.equal(await describeGifSource({ url: 'https://imgur.com/a/x', mode: 'page' }, { lookupAll: publicDns, blockedHosts: blocked }), null, 'bez unlockeru stránku nepřečte');
});

test('pickOgDescriptor: og:video přednostně s rozměry, jinak og:image; sameSite', () => {
  const base = new URL('https://imgur.com/a/x');
  assert.deepEqual(pickOgDescriptor('<meta property="og:image" content="https://i.imgur.com/a.gif"><meta property="og:image:width" content="10"><meta property="og:image:height" content="20">', base), { url: 'https://i.imgur.com/a.gif', kind: 'gif', width: 10, height: 20, host: 'i.imgur.com' });
  assert.deepEqual(pickOgDescriptor('<meta property="og:video" content="https://i.imgur.com/a.mp4">', base), { url: 'https://i.imgur.com/a.mp4', kind: 'mp4', width: null, height: null, host: 'i.imgur.com' });
  assert.equal(sameSite(new URL('https://imgur.com/a'), new URL('https://i.imgur.com/b.mp4')), true);
  assert.equal(sameSite(new URL('https://tenor.com/v'), new URL('https://media.tenor.com/x.gif')), true);
  assert.equal(sameSite(new URL('https://imgur.com/a'), new URL('https://evil.example/a.mp4')), false);
});
```

- [ ] **Step 2: Spustit — musí padat** (`createBlockedHosts is not a function`)

Run: `node --env-file=.env.test --import tsx --test src/lib/gifMedia.test.ts 2>&1 | grep -E "^not ok|^# (pass|fail)"`

- [ ] **Step 3: Implementace**

Do `gifMedia.ts` (za `GIF_TIMEOUT_MS`):

```ts
/** Hosty, které blokují IP serveru (429/403 mimo Cloudflare challenge): 24 h se přímé stažení přeskakuje. */
export const BLOCKED_HOST_TTL_MS = 24 * 3_600_000;
export interface BlockedHosts { isBlocked(host: string): boolean; mark(host: string): void; readonly size: number }
/** Registrované jméno (poslední dva popisky): imgur.com ↔ i.imgur.com. Vědomé zjednodušení (co.uk apod. se nečeká). */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  const p = h.split('.');
  return p.length > 2 ? p.slice(-2).join('.') : h;
}
export const sameSite = (a: URL, b: URL): boolean => siteOf(a.hostname) === siteOf(b.hostname);
export function createBlockedHosts({ ttlMs = BLOCKED_HOST_TTL_MS, max = 200, now = Date.now }: { ttlMs?: number; max?: number; now?: () => number } = {}): BlockedHosts {
  const m = new Map<string, number>();
  return {
    isBlocked(host) {
      const k = siteOf(host);
      const until = m.get(k);
      if (until === undefined) return false;
      if (until <= now()) { m.delete(k); return false; }
      return true;
    },
    mark(host) {
      const k = siteOf(host);
      m.delete(k);
      m.set(k, now() + ttlMs);
      if (m.size > max) m.delete(m.keys().next().value!);
    },
    get size() { return m.size; },
  };
}
```
`FetchDeps` doplnit `blockedHosts?: BlockedHosts | null;` s komentářem „Registr hostů blokujících IP serveru; 429/403 → GifError('host_blocked') + zápis; známý host jde rovnou přes unlocker (jen HTML stránky, médium neumí).“

V `safeGet` uvnitř smyčky, **před** přímým `transport(...)`, přidat větev pro známý blokovaný host:
```ts
    const blockedKnown = !!deps.blockedHosts?.isBlocked(url.hostname);
    let res: TransportResponse;
    if (blockedKnown) {
      // Známý blokující host: přímé stažení by jen spálilo čas → rovnou unlocker (jen když je; jinak host_blocked).
      if (!deps.unlocker) throw new GifError('host_blocked');
      ctx.extend(deps.unlocker.timeoutMs);
      ctx.unlocked.push(url);
      ctx.unlockStart = Date.now();
      const via = await deps.unlocker.fetch(url, signal);
      if (!via) { ctx.unlocked.pop(); throw new GifError('host_blocked'); }
      res = via;
    } else {
      try { res = await transport(url, { Accept: accept, 'User-Agent': UA, 'Accept-Encoding': 'identity' }, signal); }
      catch (e) { throw e instanceof GifError ? e : new GifError(signal.aborted ? 'timeout' : 'network'); }
    }
```
(původní `let res` + `try { res = await transport… }` tím nahradit) a za stávající Cloudflare větev přidat:
```ts
    // Host blokuje IP serveru (429 / 403 bez challenge): zapamatovat, kód host_blocked (flow nabídne stažení prohlížečem).
    if (!blockedKnown && deps.blockedHosts && (res.status === 429 || res.status === 403)) {
      res.dispose();
      deps.blockedHosts.mark(url.hostname);
      throw new GifError('host_blocked');
    }
```
Pozor na pořadí: Cloudflare větev (403/503 + challenge) zůstává první; tahle až po ní.

Popis zdroje (za `pickOgMedia`):
```ts
export interface GifDescriptor { url: string; kind: GifKind | null; width: number | null; height: number | null; host: string }
const kindFromUrl = (u: string): GifKind | null => { const m = /\.(gif|webp|mp4)(\?|$)/i.exec(u); return m ? (m[1].toLowerCase() as GifKind) : null; };
/** og:video (MP4) přednostně, jinak og:image; rozměry z og:*:width/height. null = bez média. */
export function pickOgDescriptor(html: string, base: URL): GifDescriptor | null {
  const url = pickOgMedia(html, base);
  if (!url) return null;
  const meta = metaTags(html);
  const num = (k: string): number | null => { const v = Number((meta[k] ?? [])[0]); return Number.isInteger(v) && v > 0 ? v : null; };
  const video = /\.mp4(\?|$)/i.test(url);
  const kind = kindFromUrl(url) ?? (video ? 'mp4' : null);
  return { url, kind, width: num(video ? 'og:video:width' : 'og:image:width'), height: num(video ? 'og:video:height' : 'og:image:height'), host: new URL(url).hostname };
}
/**
 * Popis média pro stažení prohlížečem odesílatele (spec 2026-09-29 §2): direct = odkaz sám; page = stránka přes
 * unlocker (host blokuje server) → og. Médium musí být na stejném místě jako stránka a veřejné. null = není co nabídnout.
 */
export async function describeGifSource(src: GifSource, deps: FetchDeps & { timeoutMs?: number }): Promise<GifDescriptor | null> {
  if (src.mode === 'own') return null;
  let base: URL;
  try { base = new URL(src.url); await assertPublicUrl(base, deps.lookupAll); } catch { return null; }
  if (src.mode === 'direct') return { url: base.toString(), kind: kindFromUrl(base.toString()), width: null, height: null, host: base.hostname };
  if (!deps.unlocker) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? deps.unlocker.timeoutMs); timer.unref?.();
  try {
    const res = await deps.unlocker.fetch(base, ctl.signal);
    if (!res) return null;
    if (res.status < 200 || res.status >= 300) { res.dispose(); return null; }
    const html = (await readLimited(res, PAGE_MAX_BYTES, ctl.signal, true)).toString('utf8');
    const d = pickOgDescriptor(html, base);
    if (!d) return null;
    const mu = new URL(d.url);
    if (!sameSite(base, mu)) return null;
    await assertPublicUrl(mu, deps.lookupAll);
    return d;
  } catch { return null; } finally { clearTimeout(timer); }
}
```
Pozn.: `describeGifSource` unlocker volá přímo (bez `safeGet`), protože přímý pokus je u blokujícího hosta zbytečný; report unlockeru (`deps.unlocker.report`) se tu nevolá — negativní cache se týká selhání celého převodu.

- [ ] **Step 4: Testy zelené**

Run: `node --env-file=.env.test --import tsx --test src/lib/gifMedia.test.ts 2>&1 | grep -E "^not ok|^# (pass|fail)"` → `fail 0`. Pak `npx tsc --noEmit -p .`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/gifMedia.ts backend/src/lib/gifMedia.test.ts
git commit -m "feat(backend): registr hostů blokujících server + popis GIF zdroje přes unlocker (spec 2026-09-29 §1–2)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Granty pro stažení klientem (`lib/gifClientFetch.ts`)

**Files:**
- Create: `backend/src/lib/gifClientFetch.ts`, `backend/src/lib/gifClientFetch.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const CLIENT_FETCH_TTL_MS = 90_000;
  export interface ClientFetchGrant { requestKey: string; channel: string; accountId: number; mediaUrl: string; host: string; kind: GifKind | null; width: number | null; height: number | null; maxBytes: number; expiresAt: number }
  export type ClientUploadError = 'bad_token' | 'empty' | 'bad_type' | 'too_large' | 'size_mismatch' | 'bad_media';
  export interface ClientFetchGrants {
    issue(g: Omit<ClientFetchGrant, 'expiresAt' | 'maxBytes'>): { token: string; grant: ClientFetchGrant; result: Promise<ResolvedGif | null> };
    /** Upload: ověří token+účet, typ, limity (probe), rozměry; při úspěchu splní `result` a vrátí { ok: true }. Grant je po volání vždy pryč. */
    complete(token: string, accountId: number, bytes: Buffer, probe?: MediaProber): Promise<{ ok: true } | { ok: false; error: ClientUploadError }>;
    /** Odmítnutí odesílatelem: splní `result` null; neznámý token = tiše true. */
    decline(token: string, accountId: number): boolean;
    /** Vypršelé granty → result null. */
    sweep(): number;
    /** Zrušit grant bez ohledu na účet (413 z parseru těla ještě před preHandlerem): result null; neznámý = false. */
    expire(token: string): boolean;
    readonly size: number;
  }
  export function createClientFetchGrants(o?: { now?: () => number; ttlMs?: number; max?: number; random?: () => string }): ClientFetchGrants;
  ```

- [ ] **Step 1: Test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClientFetchGrants, CLIENT_FETCH_TTL_MS } from './gifClientFetch.js';

const mp4 = (w: number, h: number): Buffer => { /* stejný helper jako v gifMedia.test.ts: ftyp + tkhd s rozměry */ 
  const b = Buffer.alloc(200); b.write('ftyp', 4, 'latin1'); b.writeUInt32BE(8, 0); b.write('isom', 8, 'latin1');
  b.writeUInt32BE(100, 16); b.write('moov', 20, 'latin1'); b.writeUInt32BE(92, 24); b.write('trak', 28, 'latin1'); b.writeUInt32BE(84, 32); b.write('tkhd', 36, 'latin1');
  b.writeUInt32BE(w << 16, 36 + 8 + 76); b.writeUInt32BE(h << 16, 36 + 8 + 80); return b; };
const gif = (w: number, h: number): Buffer => { const b = Buffer.alloc(32); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };
const base = { requestKey: 'twitch:m1', channel: 'robdiesalot', accountId: 7, mediaUrl: 'https://i.imgur.com/a.gif', host: 'i.imgur.com', kind: 'gif' as const, width: 320, height: 240 };

test('granty: upload správných bajtů splní result, grant je jednorázový', async () => {
  const g = createClientFetchGrants({ now: () => 1000, random: () => 'tok-1' });
  const { token, grant, result } = g.issue(base);
  assert.equal(token, 'tok-1');
  assert.equal(grant.expiresAt, 1000 + CLIENT_FETCH_TTL_MS);
  assert.equal(grant.maxBytes, 10 * 1024 * 1024);
  assert.deepEqual(await g.complete(token, 7, gif(320, 240)), { ok: true });
  const r = await result;
  assert.equal(r?.kind, 'gif'); assert.deepEqual([r?.width, r?.height], [320, 240]); assert.equal(r?.sourceUrl, base.mediaUrl);
  assert.deepEqual(await g.complete(token, 7, gif(320, 240)), { ok: false, error: 'bad_token' }, 'podruhé ne');
  assert.equal(g.size, 0);
});

test('granty: cizí účet, po TTL, prázdné, jiný typ, jiné rozměry → chyba a result null', async () => {
  let t = 1000;
  const g = createClientFetchGrants({ now: () => t });
  const a = g.issue(base);
  assert.deepEqual(await g.complete(a.token, 8, gif(320, 240)), { ok: false, error: 'bad_token' });
  assert.equal(await a.result, null, 'po chybě uploadu grant končí');
  const b = g.issue(base);
  t += CLIENT_FETCH_TTL_MS + 1;
  assert.deepEqual(await g.complete(b.token, 7, gif(320, 240)), { ok: false, error: 'bad_token' });
  assert.equal(await b.result, null);
  for (const [bytes, err] of [[Buffer.alloc(0), 'empty'], [mp4(320, 240), 'bad_type'], [gif(321, 240), 'size_mismatch'], [Buffer.from('nesmysl'), 'bad_type']] as const) {
    const x = g.issue(base);
    assert.deepEqual(await g.complete(x.token, 7, bytes as Buffer), { ok: false, error: err });
    assert.equal(await x.result, null);
  }
  const tol = g.issue(base);
  assert.deepEqual(await g.complete(tol.token, 7, gif(321, 239)), { ok: true }, 'tolerance ±1 px');
  const noDims = g.issue({ ...base, kind: null, width: null, height: null });
  assert.deepEqual(await g.complete(noDims.token, 7, mp4(640, 360)), { ok: true }, 'bez popisu jen limity');
});

test('granty: decline → result null hned; sweep po TTL; strop počtu', async () => {
  let t = 0;
  const g = createClientFetchGrants({ now: () => t, max: 2 });
  const a = g.issue(base);
  assert.equal(g.decline(a.token, 7), true);
  assert.equal(await a.result, null);
  assert.equal(g.decline('neznamy', 7), true, 'neznámý token tiše');
  const ex = g.issue(base);
  assert.equal(g.expire(ex.token), true); assert.equal(await ex.result, null); assert.equal(g.expire(ex.token), false);
  const b = g.issue(base); g.issue(base); g.issue(base);
  assert.equal(g.size, 2, 'nejstarší vypadl');
  assert.equal(await b.result, null, 'vypadlý grant = null');
  t = CLIENT_FETCH_TTL_MS + 1;
  assert.equal(g.sweep(), 2);
  assert.equal(g.size, 0);
});
```

- [ ] **Step 2: Spustit — padá** (`Cannot find module './gifClientFetch.js'`)

- [ ] **Step 3: Implementace**

```ts
// Granty pro stažení GIFu prohlížečem odesílatele (spec docs/superpowers/specs/2026-09-29-gif-stazeni-prohlizecem-design.md §3, §6):
// server médium stáhnout nemůže (host blokuje IP), ale zná jeho adresu, typ a rozměry. Vydá jednorázový token
// (jen odesílateli přes /account/stream), intercept čeká na `result`; POST /gif/client-upload bajty ověří proti
// grantu (typ, limity, rozměry ±1 px) a `result` splní. Token nikdy do logu. V paměti procesu.
import { createHash, randomBytes } from 'node:crypto';
import { GIF_MAX_BYTES, GifError, sniffKind, mediaSize, withinLimits, CONTENT_TYPES, type GifKind, type ResolvedGif, type MediaProber } from './gifMedia.js';

export const CLIENT_FETCH_TTL_MS = 90_000;
export const CLIENT_FETCH_DIM_TOLERANCE = 1;
export interface ClientFetchGrant { requestKey: string; channel: string; accountId: number; mediaUrl: string; host: string; kind: GifKind | null; width: number | null; height: number | null; maxBytes: number; expiresAt: number }
export type ClientUploadError = 'bad_token' | 'empty' | 'bad_type' | 'too_large' | 'size_mismatch' | 'bad_media';
export interface ClientFetchGrants {
  issue(g: Omit<ClientFetchGrant, 'expiresAt' | 'maxBytes'>): { token: string; grant: ClientFetchGrant; result: Promise<ResolvedGif | null> };
  complete(token: string, accountId: number, bytes: Buffer, probe?: MediaProber): Promise<{ ok: true } | { ok: false; error: ClientUploadError }>;
  decline(token: string, accountId: number): boolean;
  sweep(): number;
  readonly size: number;
}
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export function createClientFetchGrants({ now = Date.now, ttlMs = CLIENT_FETCH_TTL_MS, max = 500, random = () => randomBytes(32).toString('base64url') }: { now?: () => number; ttlMs?: number; max?: number; random?: () => string } = {}): ClientFetchGrants {
  type Row = { grant: ClientFetchGrant; resolve: (v: ResolvedGif | null) => void };
  const rows = new Map<string, Row>();
  const drop = (k: string, v: ResolvedGif | null) => { const r = rows.get(k); if (!r) return false; rows.delete(k); r.resolve(v); return true; };
  return {
    issue(g) {
      const token = random();
      const grant: ClientFetchGrant = { ...g, maxBytes: GIF_MAX_BYTES, expiresAt: now() + ttlMs };
      let resolve!: (v: ResolvedGif | null) => void;
      const result = new Promise<ResolvedGif | null>((r) => { resolve = r; });
      rows.set(hash(token), { grant, resolve });
      while (rows.size > max) drop(rows.keys().next().value!, null);
      return { token, grant, result };
    },
    async complete(token, accountId, bytes, probe) {
      const k = hash(String(token || ''));
      const r = rows.get(k);
      if (!r || r.grant.accountId !== accountId || r.grant.expiresAt <= now()) { if (r) drop(k, null); return { ok: false, error: 'bad_token' }; }
      const fail = (error: ClientUploadError) => { drop(k, null); return { ok: false as const, error }; };
      if (!bytes?.length) return fail('empty');
      if (bytes.length > r.grant.maxBytes) return fail('too_large');
      const kind = sniffKind(bytes);
      if (!kind || (r.grant.kind && kind !== r.grant.kind)) return fail('bad_type');
      let v: ResolvedGif = { bytes, kind, contentType: CONTENT_TYPES[kind], ...mediaSize(bytes, kind), sourceUrl: r.grant.mediaUrl };
      try { v = await withinLimits(v, { probe }); }
      catch (e) { return fail(e instanceof GifError && e.code === 'too_large' ? 'too_large' : 'bad_media'); }
      const off = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) > CLIENT_FETCH_DIM_TOLERANCE;
      if (off(r.grant.width, v.width) || off(r.grant.height, v.height)) return fail('size_mismatch');
      drop(k, v);
      return { ok: true };
    },
    decline(token, accountId) {
      const k = hash(String(token || ''));
      const r = rows.get(k);
      if (r && r.grant.accountId === accountId) drop(k, null);
      return true;
    },
    sweep() { let n = 0; const t = now(); for (const [k, r] of rows) if (r.grant.expiresAt <= t) { drop(k, null); n++; } return n; },
    expire(token) { return drop(hash(String(token || '')), null); },
    get size() { return rows.size; },
  };
}
```
Ověř, že `CONTENT_TYPES`, `mediaSize`, `sniffKind`, `withinLimits`, `MediaProber` jsou z `gifMedia.ts` exportované (jsou; `CONTENT_TYPES` případně doexportovat).

- [ ] **Step 4: Testy zelené** — `node --env-file=.env.test --import tsx --test src/lib/gifClientFetch.test.ts`

- [ ] **Step 5: Commit** — `feat(backend): granty pro stažení GIFu prohlížečem odesílatele (lib/gifClientFetch.ts)`

---

### Task 4: Intercept čeká na klienta (`gifRequests.ts`)

**Files:**
- Modify: `backend/src/lib/gifRequests.ts` (GifFlowDeps, `obtain()` v `intercept`, `saveMedia`, meta, `pendingView`, `mediaCols`), `backend/src/db/schema.ts` (`gifMedia.source`)
- Test: `backend/src/lib/gifRequests.test.ts`

**Interfaces:**
- Consumes: `ClientFetchGrants` (Task 3), `describeGifSource` (Task 2).
- Produces v `GifFlowDeps`:
  ```ts
  /** Popis média pro stažení klientem (describeGifSource); chybí = výzva se nenabízí. */
  describe?: (src: GifSource) => Promise<GifDescriptor | null>;
  grants?: ClientFetchGrants;
  senderAccount?: (platform: Platform, userId: string) => Promise<number | null>;
  /** Předvolba účtu (lib/gifPrefs.ts); do události, ať klient nečeká na /auth/me. */
  clientFetchPref?: (accountId: number) => Promise<'ask' | 'always' | 'never'>;
  ```
  `GifStore.saveMedia(m, meta: { channel; sourceUrlNorm; sha256; source?: 'server' | 'client' })`; `GifPendingView.media.clientFetched?: true`; request `meta.clientFetched: true`.

- [ ] **Step 1: Testy** (do `gifRequests.test.ts`; `setup()` nechat, `memStore.saveMedia` zapíše i `source`)

```ts
test('intercept: host blokuje server → popis + grant jen odesílateli (gif-progress client_fetch bez logu tokenu), upload → žádost; médium bez URL klíče', async () => {
  const grants = createClientFetchGrants({ now: () => 1_000_000, random: () => 'tok-A' });
  const sent: Array<[string, Record<string, unknown>]> = [];
  const s = setup({
    resolve: async () => { throw new GifError('host_blocked'); },
    describe: async () => ({ url: 'https://i.imgur.com/a.gif', kind: 'gif', width: 320, height: 240, host: 'i.imgur.com' }),
    grants,
    senderAccount: async () => 7,
    clientFetchPref: async () => 'ask',
    toSender: async () => (e, d) => { sent.push([e, d as Record<string, unknown>]); },
  });
  const run = s.flow.intercept(params({ candidate: { url: 'https://imgur.com/a/8as1KiG', mode: 'page', token: 'https://imgur.com/a/8as1KiG' } }));
  await new Promise((r) => setImmediate(r));
  const cf = sent.find(([e, d]) => e === 'gif-progress' && d.phase === 'client_fetch')?.[1];
  assert.ok(cf, 'výzva odešla');
  assert.equal(cf!.token, 'tok-A'); assert.equal(cf!.url, 'https://i.imgur.com/a.gif'); assert.equal(cf!.host, 'i.imgur.com'); assert.equal(cf!.pref, 'ask'); assert.equal(cf!.pct, 50);
  assert.deepEqual(await grants.complete('tok-A', 7, gifBytes(320, 240)), { ok: true });
  assert.equal(await run, 'requested');
  const r = s.mem.reqs.get(1)!;
  assert.equal(r.meta.clientFetched, true);
  const m = [...s.mem.media.values()][0];
  assert.equal(m.urlNorm, null, 'URL zdroje není klíč dedupu');
  assert.equal(m.source, 'client');
  const pending = s.calls.find((c) => c[0] === 'notify:gif-pending')![1] as { media: Record<string, unknown> };
  assert.equal(pending.media.clientFetched, true);
});

test('intercept: odmítnutí / vypršení grantu → běžný odkaz (settleHeld error); bez účtu, v režimu approved a bez popisu se výzva nenabízí', async () => {
  const grants = createClientFetchGrants({ now: () => 1_000_000, random: () => 'tok-B' });
  const sent: string[] = [];
  const mk = (over: Partial<GifFlowDeps>) => setup({ resolve: async () => { throw new GifError('host_blocked'); }, describe: async () => ({ url: 'https://i.imgur.com/a.gif', kind: 'gif', width: 320, height: 240, host: 'i.imgur.com' }), grants, senderAccount: async () => 7, toSender: async () => (e, d) => { sent.push(`${e}:${(d as { phase?: string }).phase ?? ''}`); }, ...over });
  const a = mk({});
  const run = a.flow.intercept(params());
  await new Promise((r) => setImmediate(r));
  assert.ok(sent.includes('gif-progress:client_fetch'));
  grants.decline('tok-B', 7);
  assert.equal(await run, 'failed');
  assert.ok(a.calls.some((c) => c[0] === 'restore'), 'zpráva obnovena jako běžný odkaz');
  sent.length = 0;
  const noAcc = mk({ toSender: async () => null });
  assert.equal(await noAcc.flow.intercept(params()), 'failed');
  assert.equal(sent.length, 0);
  const approved = mk({ access: async () => ({ allowed: true, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 120, mode: 'approved' }) });
  assert.equal(await approved.flow.intercept(params()), 'not_allowed');
  assert.ok(!sent.includes('gif-progress:client_fetch'));
  const noDesc = mk({ describe: async () => null });
  assert.equal(await noDesc.flow.intercept(params()), 'failed');
  assert.ok(!sent.includes('gif-progress:client_fetch'));
});
```
(`gifBytes(w,h)` = GIF hlavička jako `gif()` v `gifUnlocker.test.ts`; import `createClientFetchGrants`.) Do `memStore.saveMedia` přidat `source: meta.source ?? 'server'` a do typu položky `source`.

- [ ] **Step 2: Spustit — padá** (`describe` neznámé / `client_fetch` neodešlo)

- [ ] **Step 3: Implementace**

`db/schema.ts` v `gifMedia`: `source: text('source').notNull().default('server'),   // server | client (stažení prohlížečem odesílatele, spec 2026-09-29 §7)`. `mediaCols` + `GifMediaInfo` doplnit `source`. `saveMedia`: `source: meta.source ?? 'server'`.

`GifFlowDeps` rozšířit podle Interfaces. V `intercept` za `progress('access', 10);` přidat proměnnou `let clientFetched = false;`. V `obtain()` nahradit
```ts
          } catch (e) { return { ok: false, code: e instanceof GifError ? e.code : 'exception' }; }
```
za
```ts
          } catch (e) {
            const code = e instanceof GifError ? e.code : 'exception';
            // Host blokuje IP serveru (spec 2026-09-29): popis média + jednorázový grant → odesílatel stáhne prohlížečem.
            // Jen s účtem (tell), mimo režim approved (bajty by se nepoužily) a jen když popis je.
            if (code !== 'host_blocked' || !tell || mode === 'approved' || !deps.grants || !deps.describe || !deps.senderAccount) return { ok: false, code };
            const accountId = await deps.senderAccount(m.platform, m.platformUserId).catch(() => null);
            const desc = accountId === null ? null : await deps.describe(p.candidate);
            if (!desc || accountId === null) return { ok: false, code };
            const pref = deps.clientFetchPref ? await deps.clientFetchPref(accountId).catch(() => 'ask' as const) : 'ask';
            const { token, grant, result } = deps.grants.issue({ requestKey: mk, channel: p.ucChannel, accountId, mediaUrl: desc.url, host: desc.host, kind: desc.kind, width: desc.width, height: desc.height });
            progress('client_fetch', 50, { token, url: grant.mediaUrl, kind: grant.kind, width: grant.width, height: grant.height, host: grant.host, expiresAt: grant.expiresAt, serverNow: deps.now(), pref });
            deps.log.info({ channel: p.ucChannel, platform: m.platform, host: grant.host }, 'gif: host blokuje server → výzva odesílateli ke stažení prohlížečem');
            const got = await result;
            if (!got) return { ok: false, code: 'client_fetch' };
            clientFetched = true;
            v = got;
          }
```
(proměnná `v` už je deklarovaná `let v: ResolvedGif;` výš — `try` blok ji přiřazuje; po catch pokračuje výpočet `sha256` beze změny.)

`saveMedia` volání: `{ channel: p.ucChannel, sourceUrlNorm: clientFetched ? null : urlNorm, sha256: res.sha256, source: clientFetched ? 'client' : 'server' }`.
V `insertRequest.meta` přidat `...(clientFetched ? { clientFetched: true } : {})`. V `recordAction` u `gif_request`: `source: (clientFetched ? 'client:' : '') + safeHost(p.candidate.url)`.
`pendingView`: do `media` přidat `...((r.meta as Record<string, unknown> | null)?.clientFetched ? { clientFetched: true as const } : {})`; `GifPendingView.media` typ `clientFetched?: true`.
Log selhání (`gif: převod odkazu selhal (běžný odkaz)`) dostane i `code: 'client_fetch'` automaticky.

- [ ] **Step 4: Testy zelené** — celý `npm test` (+ `tsc`).

- [ ] **Step 5: Commit** — `feat(backend): intercept čeká na stažení GIFu prohlížečem odesílatele; médium z klienta bez URL klíče`

---

### Task 5: Routy upload / decline (`routes/gif.ts`)

**Files:**
- Modify: `backend/src/routes/gif.ts`, `backend/src/routes/gif.test.ts`

**Interfaces:**
- Consumes: `ClientFetchGrants`, `RateLimiter` (`routes/chat.ts`), `requireWebSession` (`req.webAccountId`), `MediaProber`.
- Produces v `GifRouteOpts`: `grants?: ClientFetchGrants; probe?: MediaProber; prefs?: GifPrefs` (`GifPrefs` z Task 6 — pro tento task jen volitelný `setClientFetch(accountId, v)`; implementace Task 6).
  Routy: `POST /gif/client-upload` (Bearer; `Content-Type: application/octet-stream`; `X-Gif-Token`; volitelně `X-Gif-Remember: 1`) → 202 `{ok:true}` | 4xx `{ok:false,error}`; `POST /gif/client-fetch/decline {token, remember?}` → 200 `{ok:true}`.

- [ ] **Step 1: Test** (Fastify inject jako v testu `/media/gif`)

```ts
test('POST /gif/client-upload: jen s Bearer, tokenem účtu a správnými bajty → 202 a grant splněn; cizí / chybné → 4xx; decline → result null', async () => {
  const { default: Fastify } = await import('fastify');
  const { default: gifRoutes } = await import('./gif.js');
  const { createClientFetchGrants } = await import('../lib/gifClientFetch.js');
  const grants = createClientFetchGrants({ random: () => 'tok-Z' });
  const media = new MediaServer(async () => null);
  const app = Fastify();
  let who = 7;
  const auth: preHandlerAsyncHookHandler = async (req) => { (req as { webAccountId?: number }).webAccountId = who; };
  const remembered: unknown[] = [];
  await app.register(gifRoutes, { flow: {} as never, store: {} as never, media, grants, auth, prefs: { setClientFetch: async (a: number, v: string) => { remembered.push([a, v]); }, getClientFetch: async () => 'ask' } as never });
  const gif = Buffer.alloc(32); gif.write('GIF89a', 0, 'latin1'); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(240, 8);
  const post = (headers: Record<string, string>, body: Buffer) => app.inject({ method: 'POST', url: '/gif/client-upload', headers: { 'content-type': 'application/octet-stream', ...headers }, payload: body });
  const g1 = grants.issue({ requestKey: 'twitch:m1', channel: 'robdiesalot', accountId: 7, mediaUrl: 'https://i.imgur.com/a.gif', host: 'i.imgur.com', kind: 'gif', width: 320, height: 240 });
  let r = await post({ 'x-gif-token': 'jiny' }, gif);
  assert.equal(r.statusCode, 400); assert.equal(r.json().error, 'bad_token');
  r = await post({ 'x-gif-token': 'tok-Z', 'x-gif-remember': '1' }, gif);
  assert.equal(r.statusCode, 202);
  assert.equal((await g1.result)?.kind, 'gif');
  assert.deepEqual(remembered, [[7, 'always']]);
  const g2 = grants.issue({ requestKey: 'twitch:m2', channel: 'robdiesalot', accountId: 7, mediaUrl: 'https://i.imgur.com/b.gif', host: 'i.imgur.com', kind: 'gif', width: 320, height: 240 });
  who = 8;
  r = await post({ 'x-gif-token': 'tok-Z' }, gif);
  assert.equal(r.statusCode, 400); assert.equal(await g2.result, null);
  who = 7;
  const g3 = grants.issue({ requestKey: 'twitch:m3', channel: 'robdiesalot', accountId: 7, mediaUrl: 'https://i.imgur.com/c.gif', host: 'i.imgur.com', kind: 'gif', width: 320, height: 240 });
  r = await app.inject({ method: 'POST', url: '/gif/client-fetch/decline', payload: { token: 'tok-Z', remember: true } });
  assert.equal(r.statusCode, 200); assert.equal(await g3.result, null);
  assert.deepEqual(remembered[1], [7, 'never']);
  // Přes limit těla → 413 dřív, než se čte obsah.
  const g4 = grants.issue({ requestKey: 'twitch:m4', channel: 'robdiesalot', accountId: 7, mediaUrl: 'https://i.imgur.com/d.gif', host: 'i.imgur.com', kind: 'gif', width: 320, height: 240 });
  r = await post({ 'x-gif-token': 'tok-Z' }, Buffer.alloc(10 * 1024 * 1024 + 2048));
  assert.equal(r.statusCode, 413); assert.equal(await g4.result, null);
});
```
(`random` vrací stále `tok-Z` — po každém vyřízení je předchozí grant pryč, takže hash koliduje jen záměrně; v testu se granty vydávají postupně.)

- [ ] **Step 2: Spustit — padá** (404 na routu)

- [ ] **Step 3: Implementace** (v pluginu `gifRoutes`, vedle `/gif/held`)

```ts
  // Stažení GIFu prohlížečem odesílatele (spec 2026-09-29 §6): tělo = bajty média, token v hlavičce (ne v URL — logy).
  const grants = opts.grants ?? null;
  const uploadByAccount = new RateLimiter(5, 5 / 60);
  const uploadByIp = new RateLimiter(20, 20 / 60);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.post('/gif/client-upload', { preHandler: session, bodyLimit: GIF_MAX_BYTES + 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!grants) return reply.code(503).send({ ok: false, error: 'unavailable' });
    const acc = req.webAccountId!;
    if (!uploadByAccount.allow(String(acc)) || !uploadByIp.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const token = String(req.headers['x-gif-token'] || '');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const r = await grants.complete(token, acc, body, opts.probe);
    if (!r.ok) { app.log.info({ accountId: acc, error: r.error, bytes: body.length }, 'gif: upload z prohlížeče odmítnut'); return reply.code(400).send({ ok: false, error: r.error }); }
    if (req.headers['x-gif-remember'] === '1') await opts.prefs?.setClientFetch(acc, 'always').catch(() => {});
    app.log.info({ accountId: acc, bytes: body.length }, 'gif: médium z prohlížeče odesílatele přijato');
    return reply.code(202).send({ ok: true });
  });
  app.post<{ Body: { token?: unknown; remember?: unknown } }>('/gif/client-fetch/decline', { preHandler: session }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const acc = req.webAccountId!;
    grants?.decline(String(req.body?.token || ''), acc);
    if (req.body?.remember === true) await opts.prefs?.setClientFetch(acc, 'never').catch(() => {});
    return { ok: true };
  });
```
Pozn.: `gif-notice client_declined` ze serveru (spec §3) se neposílá — hlášku „Odkaz zůstal běžnou zprávou“ ukáže klient, který odmítl, sám (Task 9); ostatní zařízení účtu uvidí obnovenou zprávu přes `message-restored` jako dnes.
Import `RateLimiter` z `./chat.js`, `GIF_MAX_BYTES` z `../lib/gifMedia.js`, typy `ClientFetchGrants`, `MediaProber`. `GifRouteOpts` doplnit `grants?`, `probe?`, `prefs?: { getClientFetch(accountId: number): Promise<'ask'|'always'|'never'>; setClientFetch(accountId: number, v: 'ask'|'always'|'never'): Promise<void> }`. Fastify vrací 413 sám (`FST_ERR_CTP_BODY_TOO_LARGE`) — grant se přitom nevyřídí; proto v `onError`/`setErrorHandler` pluginu není třeba nic, **ale** grant zůstane viset do TTL: přidat `app.addHook('onError', async (req, _reply, err) => { if ((err as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE' && req.url.startsWith('/gif/client-upload')) grants?.decline(String(req.headers['x-gif-token'] || ''), req.webAccountId ?? -1); })`. Pozn.: `onError` běží až po preHandleru? Ne — parsování těla je před preHandlerem, takže `req.webAccountId` tam není; proto `decline` s účtem `-1` neprojde kontrolou účtu. Řešení: v hooku volat `grants?.expire(token)` (Task 3, bez kontroly účtu — jen zruší grant, nic neprozradí). Test výš očekává `await g4.result === null`.

- [ ] **Step 4: Testy zelené** — `node --env-file=.env.test --import tsx --test src/routes/gif.test.ts src/lib/gifClientFetch.test.ts`; `tsc`.

- [ ] **Step 5: Commit** — `feat(backend): POST /gif/client-upload + /gif/client-fetch/decline (token, typ, rozměry, limity, rate limit)`

---

### Task 6: Předvolba účtu (`account_gif_prefs`, `/auth/me`, `PUT /account/gif-prefs`)

**Files:**
- Create: `backend/sql/2026-09-29-gif-client-fetch.sql`, `backend/src/lib/gifPrefs.ts`
- Modify: `backend/src/db/schema.ts`, `backend/src/routes/gif.ts` (PUT), `backend/src/routes/webAuth.ts` (`/auth/me`), `backend/src/routes/gif.test.ts`

**Interfaces:**
- Produces: `export type ClientFetchPref = 'ask' | 'always' | 'never'; export const CLIENT_FETCH_PREFS = ['ask','always','never'] as const; export async function getClientFetchPref(accountId): Promise<ClientFetchPref>; export async function setClientFetchPref(accountId, v): Promise<void>; export const gifPrefs = { getClientFetch: getClientFetchPref, setClientFetch: setClientFetchPref }`.
  `GET /auth/me` → `gifClientFetch: ClientFetchPref`. `PUT /account/gif-prefs { clientFetch }` → `{ ok: true, clientFetch }` | 400 `{ ok:false, error:'clientFetch' }`.

- [ ] **Step 1: SQL** (a hned spustit na produkci: `ssh root@178.104.160.182 'docker exec -i aj70ceyvdhxuvhe07suo3q9y psql -U postgres -d unitychat' < backend/sql/2026-09-29-gif-client-fetch.sql`)

```sql
-- Stažení GIFu prohlížečem odesílatele (spec 2026-09-29): zdroj média + předvolba účtu.
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'server';
CREATE TABLE IF NOT EXISTS account_gif_prefs (
  account_id   bigint PRIMARY KEY REFERENCES web_accounts(id) ON DELETE CASCADE,
  client_fetch text NOT NULL DEFAULT 'ask',
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Schema + lib**

`schema.ts` (za `accountDonatePrefs`):
```ts
// Stažení GIFu prohlížečem odesílatele (spec 2026-09-29 §5): předvolba účtu ask | always | never. Ručně SQL.
export const accountGifPrefs = pgTable('account_gif_prefs', {
  accountId: bigint('account_id', { mode: 'number' }).primaryKey().references(() => webAccounts.id, { onDelete: 'cascade' }),
  clientFetch: text('client_fetch').notNull().default('ask'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```
`lib/gifPrefs.ts`:
```ts
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accountGifPrefs } from '../db/schema.js';
export const CLIENT_FETCH_PREFS = ['ask', 'always', 'never'] as const;
export type ClientFetchPref = (typeof CLIENT_FETCH_PREFS)[number];
export const isClientFetchPref = (v: unknown): v is ClientFetchPref => (CLIENT_FETCH_PREFS as readonly unknown[]).includes(v);
export async function getClientFetchPref(accountId: number): Promise<ClientFetchPref> {
  const [r] = await db.select({ v: accountGifPrefs.clientFetch }).from(accountGifPrefs).where(eq(accountGifPrefs.accountId, accountId)).limit(1);
  return isClientFetchPref(r?.v) ? r.v : 'ask';
}
export async function setClientFetchPref(accountId: number, v: ClientFetchPref): Promise<void> {
  await db.insert(accountGifPrefs).values({ accountId, clientFetch: v }).onConflictDoUpdate({ target: accountGifPrefs.accountId, set: { clientFetch: v, updatedAt: new Date() } });
}
export const gifPrefs = { getClientFetch: getClientFetchPref, setClientFetch: setClientFetchPref };
```

- [ ] **Step 3: Routy** — v `gif.ts`:
```ts
  app.put<{ Body: { clientFetch?: unknown } }>('/account/gif-prefs', { preHandler: session }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const v = req.body?.clientFetch;
    if (!isClientFetchPref(v)) return reply.code(400).send({ ok: false, error: 'clientFetch' });
    if (!opts.prefs) return reply.code(503).send({ ok: false, error: 'unavailable' });
    await opts.prefs.setClientFetch(req.webAccountId!, v);
    return { ok: true, clientFetch: v };
  });
```
`webAuth.ts` `/auth/me`: `let gifClientFetch: ClientFetchPref = 'ask'; try { gifClientFetch = await getClientFetchPref(req.webAccountId!); } catch { /* výchozí */ }` a do odpovědi `gifClientFetch`.
Test v `gif.test.ts` (rozšířit test z Task 5 nebo nový): PUT `always` → 200 + zaznamenáno, PUT `x` → 400.

- [ ] **Step 4:** `tsc` + `npm test`; commit `feat(backend): předvolba účtu pro stažení GIFu prohlížečem (account_gif_prefs, /auth/me, PUT /account/gif-prefs)`.

---

### Task 7: Wiring v `server.ts` + dokumentace backendu

**Files:**
- Modify: `backend/src/server.ts`, `backend/README.md`, `backend/.env.example` (nic nového — jen ověřit)

- [ ] **Step 1:** V `server.ts`:
```ts
import { createBlockedHosts, describeGifSource, resolveGif } from './lib/gifMedia.js';
import { createClientFetchGrants } from './lib/gifClientFetch.js';
import { gifPrefs } from './lib/gifPrefs.js';
// …
const gifBlockedHosts = createBlockedHosts();
const gifGrants = createClientFetchGrants();
setInterval(() => gifGrants.sweep(), 30_000).unref();
```
`resolve:` doplnit `blockedHosts: gifBlockedHosts`; do `createGifFlow` deps přidat
```ts
  describe: (src) => describeGifSource(src, { unlocker: gifUnlocker, blockedHosts: gifBlockedHosts }),
  grants: gifGrants,
  senderAccount: (platform, userId) => senderAccount(platform, userId),
  clientFetchPref: (accountId) => gifPrefs.getClientFetch(accountId),
```
a do `app.register(gifRoutes, { …, grants: gifGrants, probe: (b, k) => probeMedia(b, k), prefs: gifPrefs })`.
- [ ] **Step 2:** README: sekce „GIF media: fetching sources that block the server“ přepsat na dvě odrážky: Cloudflare challenge → Web Unlocker; host blokující IP (imgur) → popis stránky přes Web Unlocker + stažení prohlížečem odesílatele (`POST /gif/client-upload`, spec).
- [ ] **Step 3:** `tsc`, `npm test`; commit `feat(backend): zapojení stažení GIFu prohlížečem (granty, popis zdroje, předvolby)`; push `dev` (SQL z Task 6 už na produkci). Po deployi ověřit `curl -s https://api.jouki.cz/health`.

---

### Task 8: Core `gif-library.js` — fáze `client_fetch`, stavy a štítek

**Files:**
- Modify: `extension/core/gif-library.js`, `extension/gif.css`
- Test: `scripts/test-gif-library.js`

**Interfaces:**
- Produces (GifOutbox): fáze `client_fetch` v `PHASES`; `normalizeGifProgress` propouští `token, url, kind, width, height, host, expiresAt, pref`; stav `e.state = 'client_fetch'`, `e.cf = { token, url, kind, width, height, host, expiresAt, pref }`; `view()` → `{ kind: 'client_fetch', text, host, url, token, expiresAt, pref, remaining }`; metody `clientFetchStarted(platform, id)` (stav `progress`, `phase: 'client_download'`, `pct: 50`, `dl: true`), `clientFetchFailed(platform, id, code)` (stav `client_failed`, `final: true`, text podle kódu, po 5 s `state 'none'`), `clientFetchExpired` automaticky z `_arm` tiku (po `expiresAt` → stav `client_expired`, po 5 s pryč); `onNotice` kind `client_declined` → stav `client_declined` (5 s → `none`). `busy()` počítá i `client_fetch`.
  Texty: `GIF_CLIENT_FETCH_TEXT = (host) => \`Server nemůže GIF z ${host} stáhnout. Stáhnout ho tvým prohlížečem a poslat?\``, `GIF_CLIENT_FETCH_TIP = 'Stáhne se z tvého prohlížeče (host uvidí tvou IP)'`, `GIF_STATUS_TEXT.client_declined = 'Odkaz zůstal běžnou zprávou'`, `client_expired = 'Vypršelo, odkaz zůstal běžnou zprávou'`, `client_failed_*`: `too_large: 'GIF je moc velký (max 10 MB)'`, `bad_type: 'Za odkazem není GIF'`, `size_mismatch: 'Stažený soubor neodpovídá stránce'`, `network: 'Stažení v prohlížeči selhalo'`, `rate_limited: 'Moc rychle za sebou, chvíli počkej.'`, jinak `'Odeslání se nepovedlo'`.
  `paintGifStatus` kind `client_fetch`: `st.innerHTML` =
  `<span class="uc-gif-st-txt"></span><span class="uc-gif-cf-actions"><button type="button" class="uc-gif-cf-btn" data-cf="yes">Stáhnout a poslat</button><button type="button" class="uc-gif-cf-btn uc-gif-cf-no" data-cf="no">Ne</button><label class="uc-gif-cf-rem"><input type="checkbox" data-cf="remember"> Zapamatovat volbu</label></span><span class="uc-gif-st-wait uc-gif-cf-left" aria-hidden="true"></span>`, `title`/`data-tooltip` = tip; text z `view.text`; `.uc-gif-cf-left` = odpočet `formatCountdown(remaining)`; `st.dataset.cfToken` se **nenastavuje** (token jde jen přes outbox `view()`).

- [ ] **Step 1: Testy** (`scripts/test-gif-library.js`, u outbox sekce)

```js
  // Stažení prohlížečem (spec 2026-09-29): výzva → view s tlačítky; start → kolečko; odmítnutí / vypršení → 5 s text.
  {
    const ch = []; let t = 5_000_000;
    const bx = new L.GifOutbox({ channel: () => 'robdiesalot', now: () => t, onChange: (k) => ch.push(...k), hasMessage: () => true, setInterval: (fn) => { intervals.push(fn); return 99; }, clearInterval: () => {} });
    const CF = { requestKey: 'twitch:c1', channel: 'robdiesalot', platform: 'twitch', messageId: 'c1', phase: 'client_fetch', pct: 50, token: 'tok', url: 'https://i.imgur.com/a.mp4', kind: 'mp4', width: 640, height: 360, host: 'i.imgur.com', expiresAt: t + 90_000, serverNow: t, pref: 'ask' };
    bx.onProgress({ ...CF, phase: 'detect', pct: 0, token: undefined });
    bx.onProgress(CF);
    const v = bx.view('twitch', 'c1');
    check('Outbox: client_fetch → view s hostem, tokenem, adresou a odpočtem', v.kind === 'client_fetch' && v.host === 'i.imgur.com' && v.token === 'tok' && v.url === CF.url && v.pref === 'ask' && v.remaining === 90_000 && /imgur\.com/.test(v.text), JSON.stringify(v));
    check('Outbox: busy() i při výzvě', bx.busy() === true);
    bx.clientFetchStarted('twitch', 'c1');
    check('Outbox: start stahování → kolečko 50 %', bx.view('twitch', 'c1').kind === 'progress' && bx.view('twitch', 'c1').text === '50 %');
    bx.onProgress({ ...CF, phase: 'client_fetch', token: 'tok2', messageId: 'c2', requestKey: 'twitch:c2' });
    bx.clientFetchFailed('twitch', 'c2', 'too_large');
    check('Outbox: chyba → červený text, po 5 s pryč', bx.view('twitch', 'c2').kind === 'client_failed' && bx.view('twitch', 'c2').text === 'GIF je moc velký (max 10 MB)');
    t += 5_001; for (const fn of intervals) fn();
    check('Outbox: … po 5 s bez štítku', bx.view('twitch', 'c2') === null);
    bx.onProgress({ ...CF, messageId: 'c3', requestKey: 'twitch:c3' });
    t += 90_001; for (const fn of intervals) fn();
    check('Outbox: vypršení výzvy → „Vypršelo, odkaz zůstal běžnou zprávou“', bx.view('twitch', 'c3')?.text === 'Vypršelo, odkaz zůstal běžnou zprávou');
    bx.onProgress({ ...CF, messageId: 'c4', requestKey: 'twitch:c4', expiresAt: t + 90_000 });
    bx.onNotice({ requestKey: 'twitch:c4', channel: 'robdiesalot', platform: 'twitch', messageId: 'c4', kind: 'client_declined' });
    check('Outbox: gif-notice client_declined → „Odkaz zůstal běžnou zprávou“', bx.view('twitch', 'c4')?.kind === 'client_declined');
    check('normalizeGifProgress: client_fetch propouští popis', eq(Object.keys(L.normalizeGifProgress(CF)).filter((k) => ['token', 'url', 'host', 'kind', 'width', 'height', 'expiresAt', 'pref'].includes(k)).sort(), ['expiresAt', 'height', 'host', 'kind', 'pref', 'token', 'url', 'width']));
  }
```
(pokud `intervals` v souboru není v dosahu, definovat lokálně.)

- [ ] **Step 2:** `node scripts/test-gif-library.js` → nové checky FAIL.

- [ ] **Step 3: Implementace** v `gif-library.js`
  - `PHASES` přidat `'client_fetch'`, `'client_download'`; `DOWNLOAD_PHASES` přidat `'client_download'`.
  - `normalizeGifProgress`: do návratu `token: d.token ? String(d.token) : null, url: d.url ? String(d.url) : null, host: d.host ? String(d.host) : null, kind: d.kind ? String(d.kind) : null, width: num(d.width), height: num(d.height), expiresAt: num(d.expiresAt), serverNow: num(d.serverNow), pref: ['ask','always','never'].includes(d.pref) ? d.pref : 'ask'`.
  - `onProgress`: před `if (e.state === 'none' && p.phase !== 'done')` přidat
    ```js
    if (p.phase === 'client_fetch') {
      if (e.state !== 'progress' && e.state !== 'none') return e;
      // Vypršení podle hodin serveru (serverNow) → lokální čas.
      const off = p.serverNow !== null ? this.now() - p.serverNow : this.serverOffset();
      e.state = 'client_fetch'; e.optimistic = false;
      e.cf = { token: p.token, url: p.url, kind: p.kind, width: p.width, height: p.height, host: p.host || 'server', pref: p.pref, expiresAt: p.expiresAt !== null ? p.expiresAt + off : this.now() + 90_000 };
      this._L(`${p.key} výzva ke stažení prohlížečem (${e.cf.host}, ${e.cf.pref})`);
      this._arm(); this.onChange([p.key]); try { this.onClientFetch?.(e, p); } catch { /* ignore */ }
      return e;
    }
    ```
    a v konstruktoru `this.onClientFetch = onClientFetch || null;` (nový parametr).
  - `_entry` výchozí pole `cf: null, clearAt: null`.
  - Nové metody:
    ```js
    clientFetchStarted(platform, id) { const e = this.get(platform, id); if (!e || e.state !== 'client_fetch') return null; e.state = 'progress'; e.phase = 'client_download'; e.pct = 50; e.floor = 50; e.dl = true; e.at = this.now(); this._arm(); this.onChange([e.key]); return e; }
    clientFetchFailed(platform, id, code) { const e = this.get(platform, id); if (!e) return null; e.state = 'client_failed'; e.failCode = String(code || ''); e.final = true; e.clearAt = this.now() + GIF_CLIENT_NOTE_MS; this._arm(); this.onChange([e.key]); return e; }
    ```
    `export const GIF_CLIENT_NOTE_MS = 5_000;`
  - `_tick` (funkce volaná z `_arm` intervalu): pro každé `e`: `if (e.state === 'client_fetch' && e.cf && this.now() >= e.cf.expiresAt) { e.state = 'client_expired'; e.final = true; e.clearAt = this.now() + GIF_CLIENT_NOTE_MS; changed.push(e.key); }`; `if (e.clearAt && this.now() >= e.clearAt) { e.state = 'none'; e.clearAt = null; changed.push(e.key); }`; výzva se překresluje každý tik (odpočet).
  - `onNotice`: `else if (d.kind === 'client_declined') { e.state = 'client_declined'; e.clearAt = this.now() + GIF_CLIENT_NOTE_MS; }` (před `else { neznámý }`); `e.final = true` platí.
  - `busy()`: `|| v.kind === 'client_fetch'`.
  - `view()`: před `if (e.state === 'approved')`:
    ```js
    if (e.state === 'client_fetch' && e.cf) return { kind: 'client_fetch', text: GIF_CLIENT_FETCH_TEXT(e.cf.host), host: e.cf.host, url: e.cf.url, token: e.cf.token, expiresAt: e.cf.expiresAt, pref: e.cf.pref, remaining: Math.max(0, e.cf.expiresAt - now) };
    if (e.state === 'client_failed') return { kind: 'client_failed', text: gifClientFailText(e.failCode) };
    ```
    a `GIF_STATUS_TEXT` doplnit `client_declined`, `client_expired`; `export const gifClientFailText = (code) => ({ too_large: 'GIF je moc velký (max 10 MB)', bad_type: 'Za odkazem není GIF', size_mismatch: 'Stažený soubor neodpovídá stránce', network: 'Stažení v prohlížeči selhalo', rate_limited: 'Moc rychle za sebou, chvíli počkej.' })[code] || 'Odeslání se nepovedlo';`
  - `isGifOwnFinal`: **ne** pro nové stavy (zpráva zůstává běžný odkaz, ne smazaná).
  - `paintGifStatus`: větev `kind === 'client_fetch'` (innerHTML výš); při každém překreslení `st.querySelector('.uc-gif-cf-left').textContent = formatCountdown(view.remaining)`; kinds `client_declined`, `client_expired`, `client_failed` = text.
  - `gif.css`: `.uc-gif-st--client_fetch { flex-wrap: wrap; background: rgba(255, 140, 0, 0.12); color: var(--text, #efeff1); font-weight: 600; max-width: 100%; }`, `.uc-gif-cf-actions { display: inline-flex; gap: 6px; align-items: center; }`, `.uc-gif-cf-btn { border: 1px solid rgba(255, 140, 0, 0.6); background: rgba(255, 140, 0, 0.18); color: inherit; border-radius: 999px; padding: 1px 9px; font: inherit; cursor: pointer; }`, `.uc-gif-cf-btn:hover { background: rgba(255, 140, 0, 0.32); }`, `.uc-gif-cf-no { border-color: rgba(255, 255, 255, 0.25); background: transparent; }`, `.uc-gif-cf-rem { display: inline-flex; align-items: center; gap: 4px; font-weight: 400; opacity: .85; }`, `.uc-gif-st--client_declined, .uc-gif-st--client_expired, .uc-gif-st--client_failed { background: rgba(255, 255, 255, 0.06); color: var(--text-secondary, #adadb8); }`, `.uc-gif-st--client_failed { color: #ff9a9d; }`.

- [ ] **Step 4:** `node scripts/test-gif-library.js` → vše PASS. Commit `feat(core): výzva ke stažení GIFu prohlížečem — fáze client_fetch v GifOutboxu + štítek s tlačítky (v3.41.89)` (manifest bump).

---

### Task 9: Core `gif-client-fetch.js` — stažení v prohlížeči + upload + klikání

**Files:**
- Create: `extension/core/gif-client-fetch.js`
- Modify: `extension/core-bridge.js` (import + spread)
- Test: `scripts/test-gif-library.js` (čisté části: `runClientFetch` s mockem fetch/upload)

**Interfaces:**
- Produces:
  ```js
  export const CLIENT_FETCH_TIMEOUT_MS = 20_000;
  /** Stáhne url v prohlížeči (CORS, bez cookies), ohlídá velikost, nahraje. Vrací { ok: true } | { ok: false, code }. */
  export async function runClientFetch({ url, token, maxBytes = 10 * 1024 * 1024, remember = false, fetchImpl = fetch, upload, onProgress = () => {} });
  /**
   * Delegované klikání na štítek výzvy + automatika podle předvolby (always/never).
   * deps: { outbox, upload(bytes, token, remember) → Promise<{ok, error?, status?}>, decline(token, remember) → Promise, fetchImpl?, log?, pref: () => 'ask'|'always'|'never' }
   */
  export function installGifClientFetch(doc, chatEl, deps) → () => void;
  ```

- [ ] **Step 1: Test** (`scripts/test-gif-library.js`, import `../extension/core/gif-client-fetch.js` jako `CF`)

```js
  {
    const mkRes = (bytes, headers = { 'content-type': 'video/mp4', 'content-length': String(bytes.length) }) => ({ ok: true, status: 200, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    const bytes = new Uint8Array(1000);
    const calls = [];
    const upload = async (b, token, remember) => { calls.push([b.byteLength, token, remember]); return { ok: true }; };
    const r1 = await CF.runClientFetch({ url: 'https://i.imgur.com/a.mp4', token: 'tok', remember: true, fetchImpl: async (u, init) => { calls.push(['fetch', u, init.mode, init.credentials, init.redirect]); return mkRes(bytes); }, upload });
    check('runClientFetch: CORS bez cookies, upload s tokenem a remember', eq(r1, { ok: true }) && eq(calls[0], ['fetch', 'https://i.imgur.com/a.mp4', 'cors', 'omit', 'error']) && eq(calls[1], [1000, 'tok', true]), JSON.stringify(calls));
    const r2 = await CF.runClientFetch({ url: 'https://i.imgur.com/a.mp4', token: 'tok', maxBytes: 500, fetchImpl: async () => mkRes(bytes), upload });
    check('runClientFetch: Content-Length přes limit → too_large bez uploadu', eq(r2, { ok: false, code: 'too_large' }) && calls.length === 2);
    const r3 = await CF.runClientFetch({ url: 'https://i.imgur.com/a.mp4', token: 'tok', fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, upload });
    check('runClientFetch: chyba sítě / CORS → network', eq(r3, { ok: false, code: 'network' }));
    const r4 = await CF.runClientFetch({ url: 'https://i.imgur.com/a.mp4', token: 'tok', fetchImpl: async () => mkRes(bytes), upload: async () => ({ ok: false, error: 'size_mismatch', status: 400 }) });
    check('runClientFetch: server odmítl → jeho kód', eq(r4, { ok: false, code: 'size_mismatch' }));
  }
```

- [ ] **Step 2:** spustit → FAIL (`CF` chybí).

- [ ] **Step 3: Implementace**

```js
// Stažení GIFu prohlížečem odesílatele (spec docs/superpowers/specs/2026-09-29-gif-stazeni-prohlizecem-design.md §4):
// server médium stáhnout nemůže (host blokuje jeho IP), zná ale adresu, typ a rozměry a poslal odesílateli jednorázový
// token (gif-progress client_fetch, core gif-library.js GifOutbox). Tady: štítek s tlačítky → fetch() z prohlížeče
// (CORS, bez cookies, jen adresa ze serveru) → upload bajtů s tokenem. Sdílené addonem i webem; host dodá upload/decline.
import { GIF_MAX_BYTES } from './gif.js';

export const CLIENT_FETCH_TIMEOUT_MS = 20_000;

export async function runClientFetch({ url, token, maxBytes = GIF_MAX_BYTES, remember = false, fetchImpl = globalThis.fetch, upload, onProgress = () => {} }) {
  let res;
  try {
    res = await fetchImpl(url, { mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(CLIENT_FETCH_TIMEOUT_MS) });
  } catch { return { ok: false, code: 'network' }; }
  if (!res.ok) return { ok: false, code: 'network' };
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > maxBytes) return { ok: false, code: 'too_large' };
  let buf;
  try { buf = await res.arrayBuffer(); } catch { return { ok: false, code: 'network' }; }
  if (buf.byteLength > maxBytes) return { ok: false, code: 'too_large' };
  if (!buf.byteLength) return { ok: false, code: 'bad_type' };
  onProgress(75);
  try {
    const r = await upload(buf, token, remember);
    return r?.ok ? { ok: true } : { ok: false, code: r?.error || (r?.status === 429 ? 'rate_limited' : 'upload') };
  } catch (e) { return { ok: false, code: e?.error || (e?.status === 429 ? 'rate_limited' : 'upload') }; }
}

/** Klik na tlačítka štítku + automatika podle předvolby účtu. */
export function installGifClientFetch(doc, chatEl, { outbox, upload, decline, fetchImpl, log = () => {}, pref = () => 'ask' } = {}) {
  if (!chatEl || !outbox) return () => {};
  const keyOf = (st) => { const m = st.closest('.msg'); return m ? { platform: m.dataset.platform, id: m.dataset.msgId } : null; };
  const go = async (platform, id, remember) => {
    const v = outbox.view(platform, id);
    if (!v || v.kind !== 'client_fetch') return;
    outbox.clientFetchStarted(platform, id);
    log('Gif', `stahuji z ${v.host} prohlížečem${remember ? ' (zapamatovat)' : ''}`);
    const r = await runClientFetch({ url: v.url, token: v.token, remember, fetchImpl, upload });
    if (!r.ok) { outbox.clientFetchFailed(platform, id, r.code); log('Gif', `stažení prohlížečem selhalo: ${r.code}`); }
  };
  const no = async (platform, id, remember) => {
    const v = outbox.view(platform, id);
    if (!v || v.kind !== 'client_fetch') return;
    try { await decline(v.token, remember); } catch { /* server grant zruší po TTL */ }
    outbox.onNotice({ requestKey: `${platform}:${id}`, platform, messageId: id, kind: 'client_declined' });
  };
  const onClick = (e) => {
    const b = e.target?.closest?.('[data-cf="yes"],[data-cf="no"]');
    if (!b || !chatEl.contains(b)) return;
    const st = b.closest('.uc-gif-st--client_fetch');
    const k = st && keyOf(st);
    if (!k) return;
    e.preventDefault(); e.stopPropagation();
    const remember = !!st.querySelector('[data-cf="remember"]')?.checked;
    if (b.dataset.cf === 'yes') void go(k.platform, k.id, remember); else void no(k.platform, k.id, remember);
  };
  chatEl.addEventListener('click', onClick);
  // Předvolba účtu: always → rovnou stáhnout, never → rovnou odmítnout (bez zapamatování znovu).
  const prev = outbox.onClientFetch;
  outbox.onClientFetch = (entry, p) => {
    prev?.(entry, p);
    const eff = p.pref !== 'ask' ? p.pref : pref();
    if (eff === 'always') void go(entry.platform, entry.messageId, false);
    else if (eff === 'never') void no(entry.platform, entry.messageId, false);
  };
  return () => { chatEl.removeEventListener('click', onClick); outbox.onClientFetch = prev || null; };
}
```
`GIF_MAX_BYTES` v `core/gif.js` — pokud tam není, přidat `export const GIF_MAX_BYTES = 10 * 1024 * 1024;`. `core-bridge.js`: `import * as gifClientFetch from './core/gif-client-fetch.js';` + `...gifClientFetch`.

- [ ] **Step 4:** testy PASS; `node --check` obou souborů; commit `feat(core): stažení GIFu v prohlížeči a upload s tokenem (core/gif-client-fetch.js)`.

---

### Task 10: Addon — napojení, nastavení, `/auth/me`

**Files:**
- Modify: `extension/sidepanel.js`, `extension/sidepanel.html`, `extension/manifest.json` (bump)

- [ ] **Step 1:** V `_refreshAccount` uložit `gifClientFetch: j.gifClientFetch || 'ask'` do `this._account`; v `_afterAccountChange` zavolat `this._syncGifClientFetchRow()`.
- [ ] **Step 2:** `sidepanel.html` za `#row-deleted-style`:
```html
    <div class="setting-row" id="row-gif-client-fetch" hidden>
      <label for="input-gif-client-fetch">GIF, který server nestáhne</label>
      <select id="input-gif-client-fetch" title="Některé weby (imgur) blokují stahování ze serveru UnityChatu. GIF pak může stáhnout tvůj prohlížeč a poslat ho — host uvidí tvou IP.">
        <option value="ask">Zeptat se</option>
        <option value="always">Stáhnout mým prohlížečem</option>
        <option value="never">Nechat jako odkaz</option>
      </select>
    </div>
```
- [ ] **Step 3:** `sidepanel.js`:
```js
  /** Řádek předvolby stažení GIFu prohlížečem: jen s účtem; hodnota z /auth/me, změna → PUT /account/gif-prefs. */
  _syncGifClientFetchRow() {
    const row = $('row-gif-client-fetch'), sel = $('input-gif-client-fetch');
    if (!row || !sel) return;
    row.hidden = !this._account;
    if (this._account) sel.value = this._account.gifClientFetch || 'ask';
    if (!sel._ucWired) {
      sel._ucWired = true;
      sel.addEventListener('change', async () => {
        const v = sel.value;
        try { await this._ucApi('/account/gif-prefs', { method: 'PUT', body: { clientFetch: v } }); if (this._account) this._account.gifClientFetch = v; this._ucLog('Gif', `předvolba stažení prohlížečem → ${v}`); }
        catch (e) { this._ucLog('Gif', `předvolba se neuložila: ${e?.error || e}`); sel.value = this._account?.gifClientFetch || 'ask'; }
      });
    }
  }
```
- [ ] **Step 4:** Instalace klikání + upload (u `installGifLightbox` v `_init`):
```js
    // Stažení GIFu prohlížečem odesílatele (core/gif-client-fetch.js): upload bajtů s tokenem v hlavičce, Bearer účtu.
    window.UC_CORE?.installGifClientFetch?.(document, this.chatEl, {
      outbox: this._gifOut(),
      upload: async (buf, token, remember) => {
        const tok = await this._ucSessionToken();
        const r = await fetch(`${UC_API}/gif/client-upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Gif-Token': token, ...(remember ? { 'X-Gif-Remember': '1' } : {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: buf, cache: 'no-store', signal: AbortSignal.timeout(30000) });
        let j = {}; try { j = await r.json(); } catch {}
        if (remember && r.ok && this._account) { this._account.gifClientFetch = 'always'; this._syncGifClientFetchRow(); }
        return { ok: r.ok && j.ok !== false, error: j.error, status: r.status };
      },
      decline: async (token, remember) => { await this._ucApi('/gif/client-fetch/decline', { method: 'POST', body: { token, remember } }); if (remember && this._account) { this._account.gifClientFetch = 'never'; this._syncGifClientFetchRow(); } },
      pref: () => this._account?.gifClientFetch || 'ask',
      log: (tag, t) => this._ucLog(tag, t),
    });
```
(`this._gifOut()` = existující getter outboxu; pokud se outbox tvoří líně až po přihlášení, volat instalaci až v `_afterAccountChange` jednou — ohlídat `this._gifCfInstalled`.)
- [ ] **Step 5:** bump `manifest.json` (3.41.90), `node --check extension/sidepanel.js`, ruční smoke: reload rozšíření, `/uc` mock? Není → ověření e2e v Task 12. Commit `feat: stažení GIFu prohlížečem — napojení v addonu, předvolba v nastavení (v3.41.90)`.

---

### Task 11: Web — napojení, nastavení, `/auth/me`

**Files:**
- Modify: `UnityChat-web/web/src/main.js`, `UnityChat-web/web/src/settings.js`, `UnityChat-web/web/src/auth.js`

- [ ] **Step 1:** `auth.js`: přidat
```js
/** Upload média staženého prohlížečem (spec 2026-09-29): tělo = bajty, token v hlavičce. Vrací { ok, error?, status }. */
export async function uploadClientGif(buf, token, remember) {
  const r = await fetch(`${API_BASE}/gif/client-upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Gif-Token': token, ...(remember ? { 'X-Gif-Remember': '1' } : {}), ...authHeaders() }, body: buf, signal: AbortSignal.timeout(30000) });
  let j = {}; try { j = await r.json(); } catch { /* ignore */ }
  return { ok: r.ok && j.ok !== false, error: j.error, status: r.status };
}
```
- [ ] **Step 2:** `main.js` po `fetchMe()` (řádek ~857): uložit `composer.gifClientFetch = me?.gifClientFetch || 'ask'` a `settings?.setAccountPrefs?.({ gifClientFetch: composer.gifClientFetch })`. Po vytvoření `gifOut` (řádek ~346):
```js
  if (gifOut) installGifClientFetch(document, $('chat'), {
    outbox: gifOut,
    upload: async (buf, token, remember) => { const r = await uploadClientGif(buf, token, remember); if (remember && r.ok) setPref('always'); return r; },
    decline: async (token, remember) => { await ucApi('/gif/client-fetch/decline', { method: 'POST', body: { token, remember } }); if (remember) setPref('never'); },
    pref: () => composer?.gifClientFetch || 'ask',
    log,
  });
```
kde `const setPref = (v) => { if (composer) composer.gifClientFetch = v; settings?.setAccountPrefs?.({ gifClientFetch: v }); };` a import `installGifClientFetch` z `@core/gif-client-fetch.js`, `uploadClientGif` z `./auth.js`.
- [ ] **Step 3:** `settings.js`: `this.accountPrefs = null; setAccountPrefs(p) { this.accountPrefs = { ...(this.accountPrefs || {}), ...p }; this.render(); }`; v `render()` za `deletedRow`:
```js
    const cfRow = p && this.accountPrefs ? `<div class="st-row"><span class="st-label">GIF, který server nestáhne</span><select id="st-gif-cf" class="st-select" title="Některé weby (imgur) blokují stahování ze serveru UnityChatu. GIF pak může stáhnout tvůj prohlížeč a poslat ho — host uvidí tvou IP."><option value="ask">Zeptat se</option><option value="always">Stáhnout mým prohlížečem</option><option value="never">Nechat jako odkaz</option></select></div>` : '';
```
vložit `${cfRow}` za `${deletedRow}`; po renderu `const cf = this.menuEl.querySelector('#st-gif-cf'); if (cf) { cf.value = this.accountPrefs.gifClientFetch || 'ask'; cf.addEventListener('change', () => this.onAccountPref?.('gifClientFetch', cf.value)); }`. V `main.js` nastavit `settings.onAccountPref = async (k, v) => { if (k !== 'gifClientFetch') return; try { await ucApi('/account/gif-prefs', { method: 'PUT', body: { clientFetch: v } }); setPref(v); } catch (e) { log('Gif', `předvolba se neuložila: ${e.message}`); settings.render(); } };`.
- [ ] **Step 4:** merge upstream (`git fetch upstream && git merge upstream/dev`), `npx vite build`, `node scripts/e2e-gif.mjs` (musí zůstat zelené), commit `feat(web): stažení GIFu prohlížečem — napojení, předvolba v nastavení`; deploy až po Task 12.

---

### Task 12: E2E (addon + web)

**Files:**
- Modify: `scripts/e2e-gif.mjs`, `UnityChat-web/web/scripts/e2e-gif.mjs`

- [ ] **Step 1 (web):** Do Fetch interception přidat vzor `*i.imgur.com*` → odpověď `200`, hlavičky `content-type: video/mp4`, `access-control-allow-origin: *`, tělo `mp4(640, 360)` (helper z testu; pokud není, malý MP4 buffer s `ftyp`). Zachytit `POST /gif/client-upload` → zaznamenat `x-gif-token`, `x-gif-remember`, délku těla → `202 {ok:true}`; `POST /gif/client-fetch/decline` → `{ok:true}`; `PUT /account/gif-prefs` → `{ok:true, clientFetch}`; `/auth/me` už mock je — přidat `gifClientFetch: 'ask'`.
  Scénář (po přihlášeném stavu a vlastní zprávě `e2e-cf1` s odkazem `https://imgur.com/a/8as1KiG`):
  ```js
  pushAcc(PR('e2e-cf1', 'client_fetch', 50, { token: 'tok-cf1', url: 'https://i.imgur.com/auBmmCk.mp4', kind: 'mp4', width: 640, height: 360, host: 'i.imgur.com', expiresAt: Date.now() + 90000, serverNow: Date.now(), pref: 'ask' }));
  check('CF výzva: štítek s textem o imgur.com a tlačítky', await until(`(() => { const st = document.querySelector('.msg[data-msg-id="e2e-cf1"] .uc-gif-st--client_fetch'); return !!st && /imgur\\.com/.test(st.textContent) && !!st.querySelector('[data-cf="yes"]') && !!st.querySelector('[data-cf="no"]') && !!st.querySelector('[data-cf="remember"]'); })()`, 6000));
  await ev(`(() => { const st = document.querySelector('.msg[data-msg-id="e2e-cf1"] .uc-gif-st--client_fetch'); st.querySelector('[data-cf="remember"]').checked = true; st.querySelector('[data-cf="yes"]').click(); return true; })()`);
  check('CF: klik → stažení z i.imgur.com a upload s tokenem + remember', await waitFor(() => uploads.length === 1, 6000) && uploads[0].token === 'tok-cf1' && uploads[0].remember === '1' && uploads[0].bytes > 100, JSON.stringify(uploads));
  check('CF: během uploadu kolečko', await ev(`document.querySelector('.msg[data-msg-id="e2e-cf1"] .uc-gif-st')?.dataset.kind`) === 'progress');
  pushAcc(PR('e2e-cf1', 'verify', 95), PR('e2e-cf1', 'done', 100, { outcome: 'pending' }));
  check('CF: po serveru „Schvalování moderátorem“', await until(`document.querySelector('.msg[data-msg-id="e2e-cf1"] .uc-gif-st')?.dataset.kind === 'pending'`, 6000));
  // Ne + zapamatovat
  pushAcc(PR('e2e-cf2', 'client_fetch', 50, { token: 'tok-cf2', url: 'https://i.imgur.com/b1Fyunv.mp4', kind: 'mp4', width: 480, height: 854, host: 'i.imgur.com', expiresAt: Date.now() + 90000, serverNow: Date.now(), pref: 'ask' }));
  await until(`!!document.querySelector('.msg[data-msg-id="e2e-cf2"] .uc-gif-st--client_fetch')`, 6000);
  await ev(`(() => { const st = document.querySelector('.msg[data-msg-id="e2e-cf2"] .uc-gif-st--client_fetch'); st.querySelector('[data-cf="no"]').click(); return true; })()`);
  check('CF: Ne → decline na server a text „Odkaz zůstal běžnou zprávou“', await waitFor(() => declines.length === 1, 6000) && declines[0].token === 'tok-cf2' && await until(`document.querySelector('.msg[data-msg-id="e2e-cf2"] .uc-gif-st')?.dataset.kind === 'client_declined'`, 3000));
  // pref always ze serveru → bez výzvy rovnou stažení
  pushAcc(PR('e2e-cf3', 'client_fetch', 50, { token: 'tok-cf3', url: 'https://i.imgur.com/auBmmCk.mp4', kind: 'mp4', width: 640, height: 360, host: 'i.imgur.com', expiresAt: Date.now() + 90000, serverNow: Date.now(), pref: 'always' }));
  check('CF: předvolba always → bez výzvy rovnou upload', await waitFor(() => uploads.length === 2, 6000) && uploads[1].token === 'tok-cf3');
  ```
  (zprávy `e2e-cf1..3` vytvořit stejně jako jiné vlastní zprávy v testu — přes `OWNMSG` / echo, aby byly „moje“.)
- [ ] **Step 2 (addon):** totéž v `scripts/e2e-gif.mjs` (stejné helpery `PR`, `pushAcc`, `until`, `ev`; zachytávání `client-upload`/`decline` v jeho Fetch mocku; vzor `*i.imgur.com*`).
- [ ] **Step 3:** oba běhy zelené; commit `test: e2e stažení GIFu prohlížečem (výzva, upload, Ne, předvolba always)`; web: push `main`, `npx vite build && npm run deploy`; addon: push `dev`.

---

### Task 13: Karta moda + dokumentace + úklid

**Files:**
- Modify: `extension/core/gif.js` (normalizace `media.clientFetched` → `req.clientFetched`; v kartě fronty i v knihovně štítek „z prohlížeče odesílatele“ vedle rozměrů), `extension/gif.css` (`.uc-gif-card-src { font-weight: 400; opacity: .8; }`), `CLAUDE.md` (řádek milestone v3.41.89–90), `backend/README.md` (hotovo v Task 7), paměť (`memory/project_gif_library.md`).

- [ ] **Step 1:** `gif.js` `normalizeGifPending`: `clientFetched: d.media?.clientFetched === true`; render karty: `${req.clientFetched ? ' <span class="uc-gif-card-src" title="Médium stáhl prohlížeč odesílatele — adresa zdroje je jen jeho tvrzení">· z prohlížeče odesílatele</span>' : ''}` u řádku s rozměry. Test v `scripts/test-gif-library.js`: `normalizeGifPending({ …, media: { …, clientFetched: true } }).clientFetched === true`.
- [ ] **Step 2:** `CLAUDE.md` milestone: „**v3.41.89–90** – **Stažení GIFu prohlížečem odesílatele** (spec `2026-09-29-gif-stazeni-prohlizecem-design.md`): host blokující IP serveru (imgur 429) → popis přes Web Unlocker, jednorázový grant (`lib/gifClientFetch.ts`), výzva ve štítku vlastní zprávy (core `gif-client-fetch.js`), `POST /gif/client-upload` ověřuje typ/limity/rozměry, médium z klienta bez URL klíče dedupu, předvolba účtu `account_gif_prefs` (`PUT /account/gif-prefs`, `/auth/me`). Proxy modul Bright Data odstraněn.“ + `CLAUDE-HISTORY.md` changelog dokumentace.
- [ ] **Step 3:** commit `docs: stažení GIFu prohlížečem — milestone, karta moda se zdrojem (v3.41.91)`.

---

## Po dokončení (operátor)
- Coolify: smazat env `BRIGHTDATA_CUSTOMER_ID` a `BRIGHTDATA_PROXY_PASSWORD` (Task 1 je z kódu odstranil): `docker exec coolify-db psql -U coolify -d coolify -c "delete from environment_variables where resourceable_id=1 and key in ('BRIGHTDATA_CUSTOMER_ID','BRIGHTDATA_PROXY_PASSWORD');"` a redeploy.
- Živý test na `uctest`: poslat `https://imgur.com/a/8as1KiG` z účtu s UnityChatem → výzva → „Stáhnout a poslat“ → GIF ve frontě / v chatu; log serveru: `gif: host blokuje server → výzva odesílateli`, `gif: médium z prohlížeče odesílatele přijato`.

# Server-side chat log + klientská historie — implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server poslouchá Twitch/YouTube/Kick chat kanálu `robdiesalot` nepřetržitě, ukládá zprávy s reálným časem platformy a panel si po otevření stáhne historii z `GET /chat/history` — lokální cache, DOM scrape i import z Twitch tabu zmizí.

**Architecture:** Backend dostane modul `ingest/` (tři posluchače + normalizace + retence) zapisující do existující tabulky `messages` (`ON CONFLICT DO NOTHING` přes unikát `platform, platform_message_id`) a route `/chat/history` s kurzorovou paginací. Extension dostane `ChatStore` (jediný držitel dat, bez DOM) a renderer s oknem ~300 uzlů; providery začnou používat čas z platformy. Klient jde ven až po auditu kompletnosti a latence ingestu.

**Tech Stack:** Node 22 (global `WebSocket`, `fetch`, `node --test`), TypeScript ESM, Fastify 5, Drizzle ORM + `postgres`, Zod; extension = vanilla JS bez bundleru (testy přes `node` + `vm` jako `scripts/test-send-race.js`).

**Spec:** `docs/superpowers/specs/2026-09-19-server-chat-log-design.md`

## Global Constraints

- Backend verze po dokončení §Backend: **0.3.0** (`package.json`, `/health.version`, `GET /`).
- Extension verze klientské části: **3.39.0**; každý dílčí commit v `extension/` bumpne patch (`3.38.78`, `3.38.79`, …) podle CLAUDE.md „Verzování".
- Env: `CHAT_INGEST_CHANNELS` (formát `twitch:robdiesalot,kick:robdiesalot,youtube:robdiesalot`, prázdné = ingest vypnutý), `CHAT_RETENTION_DAYS` (int, default `7`).
- Retence: `DELETE FROM messages WHERE sent_at < now() - interval '<CHAT_RETENTION_DAYS> days'`, 1× za hodinu.
- `sent_at` = čas z platformy; `created_at` = čas přijetí serverem (default `now()`).
- `platform_user_id` NOT NULL → kde chybí, ukládat `''`.
- API: `GET /chat/history?channel=<twitchLogin>&limit=<1..200, default 100>[&before=<sent_at_ms>:<id>]`, řazení `sent_at DESC, id DESC`, odpověď `{ ok, messages: [nejstarší → nejnovější], nextBefore: string|null }`, `Cache-Control: no-store`, rate limit 10 req/s/IP.
- Klient: dedup **jen** podle `platform:id`; timestamp z platformy (`tmi-sent-ts` ms, Kick `created_at` ISO, YT `timestampUsec` µs → ms); okno DOM ~300; boot = `limit=100`; scroll nahoru dotahuje po 100.
- Kritéria auditu před zapnutím klienta: Twitch a Kick recall ≥ 99,5 % a p95 latence < 2 s; YouTube recall ≥ 95 % a p95 < 10 s.
- Commit message formát z CLAUDE.md: `type(scope): popis (vX.Y.Z)` + `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; před každým commitem `git stash; git pull --rebase origin dev; git stash pop`; push na `dev`.
- Nikdy nenavrhovat release do masteru (memory `feedback_no_release_nagging`).

---

## Soubory

**Backend (nové):**
| Soubor | Odpovědnost |
|---|---|
| `backend/src/ingest/types.ts` | `IngestMessage` (normalizovaný tvar před zápisem), `PlatformStatus`, `IngestListener` interface |
| `backend/src/ingest/normalize.ts` | čisté funkce: Twitch IRC řádek → `IngestMessage`, Kick payload → `IngestMessage`, YT renderer → `IngestMessage`; `toRow()` → `NewMessage` |
| `backend/src/ingest/store.ts` | `insertMessages(rows)` (ON CONFLICT DO NOTHING, vrací počet), `deleteOlderThan(days)` |
| `backend/src/ingest/twitch.ts` | `TwitchListener` — anonymní IRC WS, reconnect s backoffem |
| `backend/src/ingest/kick.ts` | `KickListener` — channel API + Pusher WS |
| `backend/src/ingest/youtube.ts` | `YouTubeListener` — findLiveVideoId, live_chat page, get_live_chat polling, page-refresh fallback |
| `backend/src/ingest/index.ts` | `startIngest(app)` / `stopIngest()`, parsování `CHAT_INGEST_CHANNELS`, retence, `getIngestStatus()` |
| `backend/src/routes/chat.ts` | `GET /chat/history`, kurzor, rate limit, `toClientMessage(row)` |
| `backend/src/lib/cursor.ts` | `encodeCursor(sentAtMs, id)`, `decodeCursor(str)` |
| `backend/src/**/*.test.ts` | `node --test` přes `tsx` |
| `scripts/ingest-audit.mjs` | audit recall + latence z DIAG dumpů proti DB |

**Backend (upravené):** `config.ts` (env), `server.ts` (registrace ingest lifecycle + route + health), `package.json` (`test` script, verze 0.3.0), `.env.example`, `README.md`.

**Extension (nové):** `extension/chat-store.js` (ChatStore), `scripts/test-chat-store.js`, `scripts/test-provider-timestamps.js`.

**Extension (upravené):** `sidepanel.html` (script tag), `sidepanel.js` (providery, boot, renderer, mazání cache/dedup/tab-importu, DIAG), `background.js` (smazat `TW_HISTORY`), `sidepanel.css` (toast), `manifest.json` (verze).

**Docs:** `CLAUDE.md`, `backend/README.md`, memory checkpoint, privacy policy v repu `jouki/jouki.cz` (`unitychat/privacy/index.html`).

---

# ČÁST A — Backend v0.3.0

### Task 1: Test harness + env konfigurace

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/src/config.ts`
- Modify: `backend/.env.example`
- Create: `backend/src/ingest/config.test.ts`
- Create: `backend/src/ingest/channels.ts`

**Interfaces:**
- Produces: `parseIngestChannels(raw: string): IngestChannel[]` kde `IngestChannel = { platform: 'twitch'|'kick'|'youtube'; channel: string }`; `config.CHAT_INGEST_CHANNELS: string`, `config.CHAT_RETENTION_DAYS: number`.

- [ ] **Step 1: Přidat test script a spustit ho naprázdno**

`backend/package.json` → do `"scripts"` přidat:
```json
"test": "node --import tsx --test \"src/**/*.test.ts\""
```
Run: `cd backend && npm test`
Expected: `# tests 0` (nic nenalezeno, exit 0). Pokud `node --test` s glob selže na Windows, použít `node --import tsx --test src/ingest/*.test.ts src/lib/*.test.ts src/routes/*.test.ts`.

- [ ] **Step 2: Failing test pro parsování kanálů**

`backend/src/ingest/config.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIngestChannels } from './channels.js';

test('parseIngestChannels: prázdné = nic', () => {
  assert.deepEqual(parseIngestChannels(''), []);
  assert.deepEqual(parseIngestChannels('   '), []);
});

test('parseIngestChannels: tři platformy, lowercase, trim', () => {
  assert.deepEqual(
    parseIngestChannels('twitch:RobDiesALot, kick:robdiesalot ,youtube:robdiesalot'),
    [
      { platform: 'twitch', channel: 'robdiesalot' },
      { platform: 'kick', channel: 'robdiesalot' },
      { platform: 'youtube', channel: 'robdiesalot' },
    ],
  );
});

test('parseIngestChannels: neznámá platforma nebo chybějící kanál → throw', () => {
  assert.throws(() => parseIngestChannels('discord:x'), /neznámá platforma/);
  assert.throws(() => parseIngestChannels('twitch:'), /chybí kanál/);
});
```

- [ ] **Step 3: Spustit, ověřit FAIL**

Run: `cd backend && npm test`
Expected: FAIL — `Cannot find module './channels.js'`.

- [ ] **Step 4: Implementace**

`backend/src/ingest/channels.ts`:
```ts
export type IngestPlatform = 'twitch' | 'kick' | 'youtube';
export interface IngestChannel { platform: IngestPlatform; channel: string }

const PLATFORMS: IngestPlatform[] = ['twitch', 'kick', 'youtube'];

/** `twitch:robdiesalot,kick:robdiesalot` → seznam; prázdný string = ingest vypnutý. */
export function parseIngestChannels(raw: string): IngestChannel[] {
  const out: IngestChannel[] = [];
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const idx = item.indexOf(':');
    const platform = (idx === -1 ? item : item.slice(0, idx)).trim().toLowerCase() as IngestPlatform;
    const channel = idx === -1 ? '' : item.slice(idx + 1).trim().toLowerCase();
    if (!PLATFORMS.includes(platform)) throw new Error(`CHAT_INGEST_CHANNELS: neznámá platforma "${platform}"`);
    if (!channel) throw new Error(`CHAT_INGEST_CHANNELS: chybí kanál u "${item}"`);
    out.push({ platform, channel });
  }
  return out;
}
```

`backend/src/config.ts` → do `EnvSchema` přidat (za `CWS_ITEM_ID`):
```ts
  // Server-side chat log (spec 2026-09-19). Prázdné = ingest vypnutý.
  // Formát: "twitch:robdiesalot,kick:robdiesalot,youtube:robdiesalot"
  CHAT_INGEST_CHANNELS: z.string().default(''),
  // Retence zpráv v tabulce messages (dny). Jedno číslo ke změně.
  CHAT_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
```

`backend/.env.example` → na konec:
```
# Server-side chat log. Prázdné = ingest vypnutý (dev bez efektu).
# Formát: twitch:robdiesalot,kick:robdiesalot,youtube:robdiesalot
CHAT_INGEST_CHANNELS=
# Retence zpráv (dny)
CHAT_RETENTION_DAYS=7
```

- [ ] **Step 5: Spustit testy → PASS, typecheck**

Run: `cd backend && npm test && npm run typecheck`
Expected: 3 tests PASS, tsc bez chyb.

- [ ] **Step 6: Commit**

```bash
git add backend/package.json backend/src/config.ts backend/.env.example backend/src/ingest/channels.ts backend/src/ingest/config.test.ts
git commit -m "feat(backend): test harness (node --test) + env pro chat ingest"
```

---

### Task 2: Normalizace zpráv (Twitch IRC, Kick, YouTube → IngestMessage)

**Files:**
- Create: `backend/src/ingest/types.ts`
- Create: `backend/src/ingest/normalize.ts`
- Create: `backend/src/ingest/normalize.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface IngestMessage {
    platform: 'twitch'|'kick'|'youtube';
    platformMessageId: string;
    platformUserId: string;     // '' když chybí
    username: string;           // display name / handle bez '@'
    channel: string;            // twitch login / kick slug / yt handle (lowercase)
    content: string;            // plain text
    contentRaw: Record<string, unknown>; // viz níže
    sentAt: Date;
    isUnitychatUser: boolean;   // text obsahuje U+2800
    isReply: boolean;
    replyToMessageId: string | null;
  }
  parseIrcLine(line: string): { tags: Record<string,string>; command: string; params: string; trailing: string; prefix: string } | null
  normalizeTwitchPrivmsg(line: string, channel: string): IngestMessage | null
  normalizeKickMessage(data: unknown, channel: string): IngestMessage | null
  normalizeYoutubeAction(action: unknown, channel: string): IngestMessage | null
  toRow(m: IngestMessage): NewMessage
  ```
- `contentRaw` tvar: Twitch `{ color, badges, emotes, displayName, login, replyParentDisplayName, replyParentBody, firstMsg, action }`; Kick `{ content, color, badges: [{type,text,count?}], senderSlug }`; YouTube `{ runs, authorPhoto, superChat, purchaseAmount, badges: [tooltip…] }`.

- [ ] **Step 1: Failing testy**

`backend/src/ingest/normalize.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIrcLine, normalizeTwitchPrivmsg, normalizeKickMessage, normalizeYoutubeAction, toRow } from './normalize.js';

const IRC = '@badge-info=subscriber/12;badges=moderator/1,subscriber/12;color=#B22222;display-name=Trokner;emotes=425618:10-12;first-msg=0;id=2efb6cb3-47ec-4288-8c41-885b4147d478;mod=1;reply-parent-display-name=hlavis697;reply-parent-msg-body=Ehmm\\sco\\sje;reply-parent-msg-id=10050d7c-f53a-455f-9a3d-4a9586687739;room-id=39661750;tmi-sent-ts=1789820014396;user-id=12345 :trokner!trokner@trokner.tmi.twitch.tv PRIVMSG #robdiesalot :@hlavis697 specifick LUL build';

test('parseIrcLine rozloží tagy, prefix, command, trailing', () => {
  const p = parseIrcLine(IRC)!;
  assert.equal(p.command, 'PRIVMSG');
  assert.equal(p.tags['display-name'], 'Trokner');
  assert.equal(p.tags['tmi-sent-ts'], '1789820014396');
  assert.equal(p.trailing, '@hlavis697 specifick LUL build');
  assert.equal(p.prefix, 'trokner!trokner@trokner.tmi.twitch.tv');
});

test('normalizeTwitchPrivmsg: čas z tmi-sent-ts, reply prefix stripnutý, raw nese emotes/badges', () => {
  const m = normalizeTwitchPrivmsg(IRC, 'robdiesalot')!;
  assert.equal(m.platform, 'twitch');
  assert.equal(m.platformMessageId, '2efb6cb3-47ec-4288-8c41-885b4147d478');
  assert.equal(m.platformUserId, '12345');
  assert.equal(m.username, 'Trokner');
  assert.equal(m.channel, 'robdiesalot');
  assert.equal(m.content, 'specifick LUL build');
  assert.equal(m.sentAt.getTime(), 1789820014396);
  assert.equal(m.isReply, true);
  assert.equal(m.replyToMessageId, '10050d7c-f53a-455f-9a3d-4a9586687739');
  assert.equal(m.contentRaw.emotes, '425618:10-12');
  assert.equal(m.contentRaw.emotesOffset, 11); // délka "@hlavis697 "
  assert.equal(m.contentRaw.badges, 'moderator/1,subscriber/12');
  assert.equal(m.contentRaw.color, '#B22222');
  assert.equal(m.contentRaw.replyParentBody, 'Ehmm co je');
  assert.equal(m.isUnitychatUser, false);
});

test('normalizeTwitchPrivmsg: UC marker → isUnitychatUser, /me → action', () => {
  const line = '@display-name=Jouki;id=abc;tmi-sent-ts=1700000000000;user-id=1 :jouki!jouki@jouki.tmi.twitch.tv PRIVMSG #robdiesalot :\u0001ACTION mává \u2800\u0001';
  const m = normalizeTwitchPrivmsg(line, 'robdiesalot')!;
  assert.equal(m.isUnitychatUser, true);
  assert.equal(m.contentRaw.action, true);
  assert.equal(m.content, 'mává \u2800');
});

test('normalizeTwitchPrivmsg: bez id → null, bez tmi-sent-ts → sentAt ≈ now', () => {
  assert.equal(normalizeTwitchPrivmsg('@display-name=X :x!x@x PRIVMSG #c :hi', 'c'), null);
  const m = normalizeTwitchPrivmsg('@id=1;display-name=X :x!x@x PRIVMSG #c :hi', 'c')!;
  assert.ok(Math.abs(m.sentAt.getTime() - Date.now()) < 2000);
});

test('normalizeKickMessage: created_at ISO, identity badges, reply metadata', () => {
  const data = {
    id: 'k1', type: 'reply', content: '@Trokner jo [emote:37221:KEKW]', created_at: '2026-09-19T12:13:34.396Z',
    sender: { id: 77, username: 'mikita1977', slug: 'mikita1977', identity: { color: '#53fc18', badges: [{ type: 'moderator', text: 'Moderator' }, { type: 'subscriber', text: 'Subscriber', count: 8 }] } },
    metadata: { original_message: { id: 'k0', content: 'ahoj' }, original_sender: { id: 5, username: 'Trokner' } },
  };
  const m = normalizeKickMessage(data, 'robdiesalot')!;
  assert.equal(m.platform, 'kick');
  assert.equal(m.platformMessageId, 'k1');
  assert.equal(m.platformUserId, '77');
  assert.equal(m.username, 'mikita1977');
  assert.equal(m.content, 'jo [emote:37221:KEKW]');
  assert.equal(m.sentAt.toISOString(), '2026-09-19T12:13:34.396Z');
  assert.equal(m.isReply, true);
  assert.equal(m.replyToMessageId, 'k0');
  assert.deepEqual(m.contentRaw.badges, [{ type: 'moderator', text: 'Moderator' }, { type: 'subscriber', text: 'Subscriber', count: 8 }]);
  assert.equal(m.contentRaw.content, '@Trokner jo [emote:37221:KEKW]');
});

test('normalizeKickMessage: jiný typ eventu nebo chybějící id → null', () => {
  assert.equal(normalizeKickMessage({ type: 'something', id: 'x', content: 'a', sender: {} }, 'c'), null);
  assert.equal(normalizeKickMessage({ type: 'message', content: 'a', sender: {} }, 'c'), null);
});

test('normalizeYoutubeAction: timestampUsec → ms, handle bez @, runs uložené', () => {
  const action = { addChatItemAction: { item: { liveChatTextMessageRenderer: {
    id: 'yt1', timestampUsec: '1789820014396123',
    authorName: { simpleText: '@EricThorwaldson' }, authorExternalChannelId: 'UCabc',
    authorPhoto: { thumbnails: [{ url: 'https://yt3/x.jpg' }] },
    message: { runs: [{ text: 'ked mozu ' }, { emoji: { emojiId: 'x', shortcuts: [':grinning_face:'] } }] },
    authorBadges: [{ liveChatAuthorBadgeRenderer: { tooltip: 'Moderátor' } }],
  } } } };
  const m = normalizeYoutubeAction(action, 'robdiesalot')!;
  assert.equal(m.platform, 'youtube');
  assert.equal(m.platformMessageId, 'yt1');
  assert.equal(m.platformUserId, 'UCabc');
  assert.equal(m.username, 'EricThorwaldson');
  assert.equal(m.content, 'ked mozu :grinning_face:');
  assert.equal(m.sentAt.getTime(), 1789820014396);
  assert.deepEqual(m.contentRaw.badges, ['Moderátor']);
  assert.equal((m.contentRaw.runs as unknown[]).length, 2);
  assert.equal(m.contentRaw.superChat, false);
});

test('normalizeYoutubeAction: paid message → superChat + purchaseAmount; jiná akce → null', () => {
  const action = { addChatItemAction: { item: { liveChatPaidMessageRenderer: {
    id: 'yt2', timestampUsec: '1789820014396123', authorName: { simpleText: 'Dono' }, authorExternalChannelId: 'UCd',
    purchaseAmountText: { simpleText: '100 Kč' }, message: { runs: [{ text: 'dík' }] },
  } } } };
  const m = normalizeYoutubeAction(action, 'c')!;
  assert.equal(m.contentRaw.superChat, true);
  assert.equal(m.contentRaw.purchaseAmount, '100 Kč');
  assert.equal(normalizeYoutubeAction({ markChatItemAsDeletedAction: {} }, 'c'), null);
});

test('toRow mapuje na NewMessage', () => {
  const m = normalizeTwitchPrivmsg(IRC, 'robdiesalot')!;
  const row = toRow(m);
  assert.equal(row.platform, 'twitch');
  assert.equal(row.platformMessageId, m.platformMessageId);
  assert.equal(row.platformUsername, 'Trokner');
  assert.equal(row.channel, 'robdiesalot');
  assert.equal(row.sentAt, m.sentAt);
  assert.equal(row.isReply, true);
  assert.equal(row.replyToMessageId, m.replyToMessageId);
});
```

- [ ] **Step 2: Spustit → FAIL (modul neexistuje)**

Run: `cd backend && npm test`

- [ ] **Step 3: Implementace**

`backend/src/ingest/types.ts`:
```ts
import type { IngestPlatform } from './channels.js';

export interface IngestMessage {
  platform: IngestPlatform;
  platformMessageId: string;
  platformUserId: string;
  username: string;
  channel: string;
  content: string;
  contentRaw: Record<string, unknown>;
  sentAt: Date;
  isUnitychatUser: boolean;
  isReply: boolean;
  replyToMessageId: string | null;
}

export type PlatformStatus = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface IngestListener {
  start(): void;
  stop(): void;
  status(): PlatformStatus;
  lastMessageAt(): Date | null;
}
```

`backend/src/ingest/normalize.ts`:
```ts
import type { NewMessage } from '../db/schema.js';
import type { IngestMessage } from './types.js';

// Braille Pattern Blank — marker zpráv odeslaných z UnityChatu (viz CLAUDE.md).
export const UC_MARKER = '\u2800';

// ---------------------------------------------------------------- Twitch --

export interface IrcLine {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string;
  trailing: string;
}

/** IRC tag value unescaping (IRCv3): \s→space, \n→space, \r→'', \:→';', \\→'\'. */
export function unescapeTag(v: string): string {
  return v.replace(/\\s/g, ' ').replace(/\\n/g, ' ').replace(/\\r/g, '').replace(/\\:/g, ';').replace(/\\\\/g, '\\');
}

export function parseIrcLine(line: string): IrcLine | null {
  let rest = line.trim();
  if (!rest) return null;
  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    for (const t of rest.substring(1, sp).split(';')) {
      const eq = t.indexOf('=');
      if (eq !== -1) tags[t.substring(0, eq)] = unescapeTag(t.substring(eq + 1));
      else if (t) tags[t] = '';
    }
    rest = rest.substring(sp + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    prefix = rest.substring(1, sp);
    rest = rest.substring(sp + 1);
  }
  let trailing = '';
  const ti = rest.indexOf(' :');
  let head = rest;
  if (ti !== -1) { trailing = rest.substring(ti + 2); head = rest.substring(0, ti); }
  const [command, ...params] = head.split(' ');
  if (!command) return null;
  return { tags, prefix, command, params: params.join(' '), trailing };
}

export function normalizeTwitchPrivmsg(line: string, channel: string): IngestMessage | null {
  const p = parseIrcLine(line);
  if (!p || p.command !== 'PRIVMSG') return null;
  const id = p.tags['id'];
  if (!id) return null;

  let message = p.trailing;
  let action = false;
  if (message.startsWith('\u0001ACTION ') && message.endsWith('\u0001')) {
    message = message.substring(8, message.length - 1);
    action = true;
  }
  const login = p.prefix.match(/^(\w+)!/)?.[1] || '';
  const username = p.tags['display-name'] || login || 'Unknown';

  const replyParentId = p.tags['reply-parent-msg-id'] || null;
  let emotesOffset = 0;
  if (replyParentId && message.startsWith('@')) {
    // Twitch přidává "@user " na začátek reply — panel ho stripuje, emote
    // pozice v tagu ale počítají s původním textem → offset pro klienta.
    const sp = message.indexOf(' ');
    if (sp !== -1) { emotesOffset = sp + 1; message = message.substring(sp + 1); }
  }

  const ts = Number(p.tags['tmi-sent-ts']);
  return {
    platform: 'twitch',
    platformMessageId: id,
    platformUserId: p.tags['user-id'] || '',
    username,
    channel: channel.toLowerCase(),
    content: message,
    contentRaw: {
      login,
      displayName: p.tags['display-name'] || null,
      color: p.tags['color'] || null,
      badges: p.tags['badges'] || '',
      emotes: p.tags['emotes'] || null,
      emotesOffset,
      firstMsg: p.tags['first-msg'] === '1',
      action,
      replyParentDisplayName: p.tags['reply-parent-display-name'] || null,
      replyParentBody: p.tags['reply-parent-msg-body'] || null,
    },
    sentAt: Number.isFinite(ts) && ts > 0 ? new Date(ts) : new Date(),
    isUnitychatUser: message.includes(UC_MARKER),
    isReply: !!replyParentId,
    replyToMessageId: replyParentId,
  };
}

// ------------------------------------------------------------------ Kick --

interface KickPayload {
  id?: string; type?: string; content?: string; created_at?: string;
  sender?: { id?: number | string; username?: string; slug?: string; identity?: { color?: string; badges?: unknown[] } };
  metadata?: { original_message?: { id?: string; content?: string }; original_sender?: { id?: number | string; username?: string } };
}

export function normalizeKickMessage(raw: unknown, channel: string): IngestMessage | null {
  const data = (typeof raw === 'string' ? JSON.parse(raw) : raw) as KickPayload;
  if (!data || (data.type !== 'message' && data.type !== 'reply')) return null;
  if (!data.id) return null;
  let content = data.content || '';
  const orig = data.type === 'reply' ? data.metadata?.original_message : undefined;
  const origSender = data.type === 'reply' ? data.metadata?.original_sender : undefined;
  if (orig?.id && origSender?.username) {
    const at = `@${origSender.username}`;
    if (content.startsWith(at + ' ')) content = content.substring(at.length + 1);
    else if (content.startsWith(at)) content = content.substring(at.length);
  }
  const ts = data.created_at ? Date.parse(data.created_at) : NaN;
  const badges = Array.isArray(data.sender?.identity?.badges) ? data.sender!.identity!.badges : [];
  return {
    platform: 'kick',
    platformMessageId: String(data.id),
    platformUserId: data.sender?.id != null ? String(data.sender.id) : '',
    username: data.sender?.username || 'Unknown',
    channel: channel.toLowerCase(),
    content,
    contentRaw: {
      content: data.content || '',
      color: data.sender?.identity?.color || null,
      badges,
      senderSlug: data.sender?.slug || null,
      replyParentUsername: origSender?.username || null,
      replyParentBody: orig?.content || null,
    },
    sentAt: Number.isFinite(ts) ? new Date(ts) : new Date(),
    isUnitychatUser: content.includes(UC_MARKER),
    isReply: !!orig?.id,
    replyToMessageId: orig?.id ? String(orig.id) : null,
  };
}

// --------------------------------------------------------------- YouTube --

interface YtRun { text?: string; emoji?: { emojiId?: string; shortcuts?: string[] } }
interface YtRenderer {
  id?: string; timestampUsec?: string;
  authorName?: { simpleText?: string }; authorExternalChannelId?: string;
  authorPhoto?: { thumbnails?: { url?: string }[] };
  message?: { runs?: YtRun[] };
  authorBadges?: { liveChatAuthorBadgeRenderer?: { tooltip?: string } }[];
  purchaseAmountText?: { simpleText?: string };
}

export function normalizeYoutubeAction(action: unknown, channel: string): IngestMessage | null {
  const item = (action as { addChatItemAction?: { item?: Record<string, YtRenderer> } })?.addChatItemAction?.item;
  if (!item) return null;
  const paid = item.liveChatPaidMessageRenderer;
  const r = item.liveChatTextMessageRenderer || paid;
  if (!r?.id) return null;
  const rawName = r.authorName?.simpleText || 'Unknown';
  const username = rawName.replace(/^@/, '') || rawName;
  const runs = r.message?.runs || [];
  const content = runs.map((x) => x.text || x.emoji?.shortcuts?.[0] || x.emoji?.emojiId || '').join('');
  const usec = Number(r.timestampUsec);
  return {
    platform: 'youtube',
    platformMessageId: r.id,
    platformUserId: r.authorExternalChannelId || '',
    username,
    channel: channel.toLowerCase(),
    content,
    contentRaw: {
      runs,
      authorPhoto: r.authorPhoto?.thumbnails?.[0]?.url || null,
      badges: (r.authorBadges || []).map((b) => b.liveChatAuthorBadgeRenderer?.tooltip || '').filter(Boolean),
      superChat: !!paid,
      purchaseAmount: paid?.purchaseAmountText?.simpleText || null,
    },
    sentAt: Number.isFinite(usec) && usec > 0 ? new Date(Math.floor(usec / 1000)) : new Date(),
    isUnitychatUser: content.includes(UC_MARKER),
    isReply: false,
    replyToMessageId: null,
  };
}

// ------------------------------------------------------------------- Row --

export function toRow(m: IngestMessage): NewMessage {
  return {
    platform: m.platform,
    platformMessageId: m.platformMessageId,
    platformUserId: m.platformUserId,
    platformUsername: m.username,
    content: m.content,
    contentRaw: m.contentRaw,
    channel: m.channel,
    isUnitychatUser: m.isUnitychatUser,
    isReply: m.isReply,
    replyToMessageId: m.replyToMessageId,
    sentAt: m.sentAt,
  };
}
```

- [ ] **Step 4: Spustit testy → PASS; typecheck**

Run: `cd backend && npm test && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add backend/src/ingest/types.ts backend/src/ingest/normalize.ts backend/src/ingest/normalize.test.ts
git commit -m "feat(backend): normalizace Twitch/Kick/YouTube zpráv pro chat ingest"
```

---

### Task 3: Zápis do DB + retence

**Files:**
- Create: `backend/src/ingest/store.ts`
- Create: `backend/src/ingest/store.test.ts`

**Interfaces:**
- Produces: `insertMessages(rows: NewMessage[]): Promise<number>` (počet reálně vložených, duplicity přes unique index tiše zahozeny), `deleteOlderThan(days: number): Promise<number>`, oba přijímají volitelný `dbi` (Drizzle instance) pro testy — default `db` z `../db/index.js`.

- [ ] **Step 1: Test (integrace proti DB, přeskočí se bez `TEST_DATABASE_URL`)**

`backend/src/ingest/store.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

test('insertMessages: duplicita (platform, platform_message_id) se tiše zahodí', { skip: !url && 'TEST_DATABASE_URL není nastavené' }, async () => {
  process.env.DATABASE_URL = url!;
  const { insertMessages, deleteOlderThan } = await import('./store.js');
  const { db } = await import('../db/index.js');
  const { messages } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const id = 'test-' + Date.now();
  const row = {
    platform: 'twitch', platformMessageId: id, platformUserId: '1', platformUsername: 'tester',
    content: 'hi', contentRaw: {}, channel: '__test__', isUnitychatUser: false, isReply: false,
    replyToMessageId: null, sentAt: new Date(Date.now() - 10 * 24 * 3600 * 1000),
  };
  assert.equal(await insertMessages([row]), 1);
  assert.equal(await insertMessages([row]), 0);
  // retence: 10 dní stará zpráva s cutoff 7 dní zmizí
  const deleted = await deleteOlderThan(7);
  assert.ok(deleted >= 1);
  const left = await db.select().from(messages).where(eq(messages.platformMessageId, id));
  assert.equal(left.length, 0);
});
```

- [ ] **Step 2: Spustit → bez `TEST_DATABASE_URL` skip, s ním FAIL (modul chybí)**

Run: `cd backend && npm test`

- [ ] **Step 3: Implementace**

`backend/src/ingest/store.ts`:
```ts
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { messages, type NewMessage } from '../db/schema.js';

type Db = typeof defaultDb;

/** Vloží dávku, duplicity (platform, platform_message_id) přeskočí. Vrací počet vložených. */
export async function insertMessages(rows: NewMessage[], dbi: Db = defaultDb): Promise<number> {
  if (!rows.length) return 0;
  const inserted = await dbi
    .insert(messages)
    .values(rows)
    .onConflictDoNothing({ target: [messages.platform, messages.platformMessageId] })
    .returning({ id: messages.id });
  return inserted.length;
}

/** Retence: smaže zprávy se sent_at starším než `days` dní. Vrací počet smazaných. */
export async function deleteOlderThan(days: number, dbi: Db = defaultDb): Promise<number> {
  const res = await dbi
    .delete(messages)
    .where(sql`${messages.sentAt} < now() - make_interval(days => ${days})`)
    .returning({ id: messages.id });
  return res.length;
}
```

- [ ] **Step 4: Spustit s testovací DB → PASS**

Run (na VPS je Postgres dostupný přes `docker exec`; lokálně použít vlastní): `cd backend && TEST_DATABASE_URL=postgres://... npm test`
Expected: PASS. Bez DB: `# skipped 1`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/ingest/store.ts backend/src/ingest/store.test.ts
git commit -m "feat(backend): zápis chat zpráv s ON CONFLICT DO NOTHING + retence"
```

---

### Task 4: TwitchListener (anonymní IRC)

**Files:**
- Create: `backend/src/ingest/twitch.ts`
- Create: `backend/src/ingest/twitch.test.ts`

**Interfaces:**
- Consumes: `normalizeTwitchPrivmsg`, `IngestMessage`, `IngestListener`.
- Produces: `class TwitchListener implements IngestListener` s konstruktorem `(channel: string, onMessage: (m: IngestMessage) => void, opts?: { WebSocketCtor?: typeof WebSocket; log?: Logger; reconnectBaseMs?: number })`. `Logger = { info(o: object, msg: string): void; warn(...): void; error(...): void }` (Fastify `app.log` sedí).

- [ ] **Step 1: Failing test s falešným WebSocketem**

`backend/src/ingest/twitch.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TwitchListener } from './twitch.js';
import type { IngestMessage } from './types.js';

class FakeWs {
  static instances: FakeWs[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) { FakeWs.instances.push(this); }
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; this.onclose?.(); }
  // test helpers
  open() { this.readyState = 1; this.onopen?.(); }
  recv(data: string) { this.onmessage?.({ data }); }
}

const silent = { info() {}, warn() {}, error() {} };

test('TwitchListener: handshake, JOIN, PING→PONG, PRIVMSG → onMessage', () => {
  FakeWs.instances = [];
  const got: IngestMessage[] = [];
  const l = new TwitchListener('robdiesalot', (m) => got.push(m), { WebSocketCtor: FakeWs as unknown as typeof WebSocket, log: silent });
  l.start();
  const ws = FakeWs.instances[0];
  assert.equal(ws.url, 'wss://irc-ws.chat.twitch.tv:443');
  ws.open();
  assert.ok(ws.sent.some((s) => s.startsWith('CAP REQ :twitch.tv/tags twitch.tv/commands')));
  assert.ok(ws.sent.some((s) => s.startsWith('NICK justinfan')));
  assert.ok(ws.sent.includes('JOIN #robdiesalot'));
  assert.equal(l.status(), 'connected');
  ws.recv('PING :tmi.twitch.tv\r\n');
  assert.ok(ws.sent.includes('PONG :tmi.twitch.tv'));
  ws.recv('@id=m1;display-name=A;tmi-sent-ts=1700000000000;user-id=1 :a!a@a PRIVMSG #robdiesalot :hello\r\n@id=m2;display-name=B;tmi-sent-ts=1700000001000;user-id=2 :b!b@b PRIVMSG #robdiesalot :world\r\n');
  assert.equal(got.length, 2);
  assert.equal(got[1].content, 'world');
  assert.equal(l.lastMessageAt()?.getTime(), 1700000001000);
  l.stop();
  assert.equal(l.status(), 'off');
});

test('TwitchListener: po close se reconnectne s backoffem a stop() reconnect zruší', async () => {
  FakeWs.instances = [];
  const l = new TwitchListener('robdiesalot', () => {}, { WebSocketCtor: FakeWs as unknown as typeof WebSocket, log: silent, reconnectBaseMs: 10 });
  l.start();
  FakeWs.instances[0].open();
  FakeWs.instances[0].close();
  assert.equal(l.status(), 'reconnecting');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(FakeWs.instances.length, 2);
  l.stop();
  FakeWs.instances[1].close();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(FakeWs.instances.length, 2, 'po stop() žádný další pokus');
});
```

- [ ] **Step 2: Spustit → FAIL**

- [ ] **Step 3: Implementace**

`backend/src/ingest/twitch.ts`:
```ts
import { normalizeTwitchPrivmsg } from './normalize.js';
import type { IngestListener, IngestMessage, PlatformStatus } from './types.js';

export interface Logger { info(o: object, msg: string): void; warn(o: object, msg: string): void; error(o: object, msg: string): void }
export const noopLog: Logger = { info() {}, warn() {}, error() {} };

interface Opts { WebSocketCtor?: typeof WebSocket; log?: Logger; reconnectBaseMs?: number }

/**
 * Anonymní IRC posluchač (justinfan) — port TwitchProvider z extension
 * (sidepanel.js), bez UI: jen PRIVMSG → onMessage. USERNOTICE (raid, sub…)
 * se zatím neukládá — klient je renderuje živě a v historii by potřeboval
 * vlastní render cestu; přidá se, až bude klientská část hotová.
 */
export class TwitchListener implements IngestListener {
  private ws: WebSocket | null = null;
  private st: PlatformStatus = 'off';
  private last: Date | null = null;
  private stopped = true;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly Ctor: typeof WebSocket;
  private readonly log: Logger;
  private readonly baseMs: number;

  constructor(private readonly channel: string, private readonly onMessage: (m: IngestMessage) => void, opts: Opts = {}) {
    this.Ctor = opts.WebSocketCtor ?? WebSocket;
    this.log = opts.log ?? noopLog;
    this.baseMs = opts.reconnectBaseMs ?? 1000;
  }

  status() { return this.st; }
  lastMessageAt() { return this.last; }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const ws = this.ws; this.ws = null;
    if (ws) { try { ws.onclose = null; ws.close(); } catch {} }
    this.st = 'off';
  }

  private connect() {
    this.st = this.attempt ? 'reconnecting' : 'connecting';
    let ws: WebSocket;
    try {
      ws = new this.Ctor('wss://irc-ws.chat.twitch.tv:443');
    } catch (err) {
      this.log.error({ err, channel: this.channel }, 'twitch ingest: WebSocket ctor selhal');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const nick = 'justinfan' + Math.floor(10000 + Math.random() * 90000);
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send('NICK ' + nick);
      ws.send('JOIN #' + this.channel);
      this.st = 'connected';
      this.attempt = 0;
      this.log.info({ channel: this.channel }, 'twitch ingest: connected');
    };
    ws.onmessage = (e: MessageEvent) => {
      const data = typeof e.data === 'string' ? e.data : String(e.data);
      for (const line of data.split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
        if (!line.includes('PRIVMSG')) continue;
        const m = normalizeTwitchPrivmsg(line, this.channel);
        if (!m) continue;
        this.last = m.sentAt;
        try { this.onMessage(m); } catch (err) { this.log.error({ err }, 'twitch ingest: onMessage threw'); }
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.log.warn({ channel: this.channel }, 'twitch ingest: socket closed');
      this.scheduleReconnect();
    };
    ws.onerror = (e: Event) => this.log.warn({ channel: this.channel, e: String(e) }, 'twitch ingest: socket error');
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.st = 'reconnecting';
    const delay = Math.min(30000, this.baseMs * 2 ** Math.min(this.attempt, 5));
    this.attempt++;
    this.timer = setTimeout(() => { this.timer = null; if (!this.stopped) this.connect(); }, delay);
  }
}
```

- [ ] **Step 4: Testy → PASS; typecheck**

Run: `cd backend && npm test && npm run typecheck`
Poznámka: TS může chtít `lib: ["DOM"]` kvůli typu `WebSocket`/`MessageEvent` — Node 22 typy (`@types/node` ≥ 22.10) `WebSocket` globál mají; pokud tsc hlásí `Cannot find name 'WebSocket'`, přidat do `tsconfig.json` `"lib": ["ES2022", "DOM"]`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/ingest/twitch.ts backend/src/ingest/twitch.test.ts
git commit -m "feat(backend): Twitch IRC listener pro chat ingest (anonymní, reconnect s backoffem)"
```

---

### Task 5: KickListener (channel API + Pusher)

**Files:**
- Create: `backend/src/ingest/kick.ts`
- Create: `backend/src/ingest/kick.test.ts`

**Interfaces:**
- Produces: `class KickListener implements IngestListener` — ctor `(slug: string, onMessage, opts?: { WebSocketCtor?, fetchImpl?: typeof fetch, log?, reconnectBaseMs? })`.

- [ ] **Step 1: Failing test**

`backend/src/ingest/kick.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KickListener } from './kick.js';
import type { IngestMessage } from './types.js';

class FakeWs {
  static instances: FakeWs[] = [];
  readyState = 0; sent: string[] = [];
  onopen: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null; onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) { FakeWs.instances.push(this); }
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  recv(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
}
const silent = { info() {}, warn() {}, error() {} };
const fakeFetch = (async (url: string) => {
  assert.equal(url, 'https://kick.com/api/v2/channels/robdiesalot');
  return new Response(JSON.stringify({ chatroom: { id: 91976532 }, user_id: 5 }), { status: 200 });
}) as unknown as typeof fetch;

test('KickListener: chatroom id z API, subscribe, ChatMessageEvent → onMessage', async () => {
  FakeWs.instances = [];
  const got: IngestMessage[] = [];
  const l = new KickListener('robdiesalot', (m) => got.push(m), { WebSocketCtor: FakeWs as unknown as typeof WebSocket, fetchImpl: fakeFetch, log: silent });
  l.start();
  await new Promise((r) => setTimeout(r, 10));
  const ws = FakeWs.instances[0];
  assert.match(ws.url, /^wss:\/\/ws-us2\.pusher\.com\/app\/32cbd69e4b950bf97679/);
  ws.open();
  ws.recv({ event: 'pusher:connection_established', data: '{}' });
  const sub = JSON.parse(ws.sent[0]);
  assert.equal(sub.event, 'pusher:subscribe');
  assert.equal(sub.data.channel, 'chatrooms.91976532.v2');
  ws.recv({ event: 'pusher_internal:subscription_succeeded', data: '{}' });
  assert.equal(l.status(), 'connected');
  ws.recv({ event: 'pusher:ping', data: {} });
  assert.ok(ws.sent.some((s) => s.includes('pusher:pong')));
  ws.recv({ event: 'App\\Events\\ChatMessageEvent', data: JSON.stringify({ id: 'k1', type: 'message', content: 'ahoj', created_at: '2026-09-19T12:00:00.000Z', sender: { id: 1, username: 'x', identity: { badges: [] } } }) });
  assert.equal(got.length, 1);
  assert.equal(got[0].platform, 'kick');
  l.stop();
});

test('KickListener: chybějící chatroom → reconnecting (retry přes fetch)', async () => {
  FakeWs.instances = [];
  const badFetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  const l = new KickListener('robdiesalot', () => {}, { WebSocketCtor: FakeWs as unknown as typeof WebSocket, fetchImpl: badFetch, log: silent, reconnectBaseMs: 10 });
  l.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(l.status(), 'reconnecting');
  assert.equal(FakeWs.instances.length, 0);
  l.stop();
});
```

- [ ] **Step 2: Spustit → FAIL**

- [ ] **Step 3: Implementace**

`backend/src/ingest/kick.ts`:
```ts
import { normalizeKickMessage } from './normalize.js';
import { noopLog, type Logger } from './twitch.js';
import type { IngestListener, IngestMessage, PlatformStatus } from './types.js';

interface Opts { WebSocketCtor?: typeof WebSocket; fetchImpl?: typeof fetch; log?: Logger; reconnectBaseMs?: number }

const PUSHER_KEY = '32cbd69e4b950bf97679';

/** Port KickProvider z extension: channel API → chatroom id → Pusher subscribe. */
export class KickListener implements IngestListener {
  private ws: WebSocket | null = null;
  private st: PlatformStatus = 'off';
  private last: Date | null = null;
  private stopped = true;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private ping: NodeJS.Timeout | null = null;
  private chatroomId: number | null = null;
  private readonly Ctor: typeof WebSocket;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly baseMs: number;

  constructor(private readonly slug: string, private readonly onMessage: (m: IngestMessage) => void, opts: Opts = {}) {
    this.Ctor = opts.WebSocketCtor ?? WebSocket;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? noopLog;
    this.baseMs = opts.reconnectBaseMs ?? 1000;
  }

  status() { return this.st; }
  lastMessageAt() { return this.last; }

  start() { this.stopped = false; void this.connect(); }

  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.ping) { clearInterval(this.ping); this.ping = null; }
    const ws = this.ws; this.ws = null;
    if (ws) { try { ws.onclose = null; ws.close(); } catch {} }
    this.st = 'off';
  }

  private async connect() {
    this.st = this.attempt ? 'reconnecting' : 'connecting';
    try {
      const resp = await this.fetchImpl(`https://kick.com/api/v2/channels/${this.slug}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (UnityChat ingest)' },
      });
      if (!resp.ok) throw new Error(`Kick API ${resp.status}`);
      const data = (await resp.json()) as { chatroom?: { id?: number } };
      this.chatroomId = data?.chatroom?.id ?? null;
      if (!this.chatroomId) throw new Error('chatroom id nenalezen');
    } catch (err) {
      this.log.warn({ err, slug: this.slug }, 'kick ingest: channel API selhalo');
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;

    const ws = new this.Ctor(`wss://ws-us2.pusher.com/app/${PUSHER_KEY}?protocol=7&client=js&version=8.3.0&flash=false`);
    this.ws = ws;
    ws.onmessage = (e: MessageEvent) => {
      let msg: { event?: string; data?: unknown };
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      switch (msg.event) {
        case 'pusher:connection_established':
          ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: `chatrooms.${this.chatroomId}.v2` } }));
          break;
        case 'pusher_internal:subscription_succeeded':
          this.st = 'connected';
          this.attempt = 0;
          this.startPing(ws);
          this.log.info({ slug: this.slug, chatroom: this.chatroomId }, 'kick ingest: subscribed');
          break;
        case 'pusher:ping':
          ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
          break;
        case 'pusher:error':
        case 'pusher_internal:subscription_error':
          this.log.warn({ slug: this.slug, data: msg.data }, 'kick ingest: pusher error → reconnect');
          try { ws.close(); } catch {}
          break;
        case 'App\\Events\\ChatMessageEvent': {
          const m = normalizeKickMessage(msg.data, this.slug);
          if (!m) return;
          this.last = m.sentAt;
          try { this.onMessage(m); } catch (err) { this.log.error({ err }, 'kick ingest: onMessage threw'); }
          break;
        }
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.ping) { clearInterval(this.ping); this.ping = null; }
      this.log.warn({ slug: this.slug }, 'kick ingest: socket closed');
      this.scheduleReconnect();
    };
    ws.onerror = (e: Event) => this.log.warn({ slug: this.slug, e: String(e) }, 'kick ingest: socket error');
  }

  private startPing(ws: WebSocket) {
    if (this.ping) clearInterval(this.ping);
    this.ping = setInterval(() => { try { ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })); } catch {} }, 30000);
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.st = 'reconnecting';
    const delay = Math.min(30000, this.baseMs * 2 ** Math.min(this.attempt, 5));
    this.attempt++;
    this.timer = setTimeout(() => { this.timer = null; if (!this.stopped) void this.connect(); }, delay);
  }
}
```

- [ ] **Step 4: Testy → PASS; typecheck**

- [ ] **Step 5: Commit**

```bash
git add backend/src/ingest/kick.ts backend/src/ingest/kick.test.ts
git commit -m "feat(backend): Kick Pusher listener pro chat ingest"
```

---

### Task 6: YouTubeListener (poller)

**Files:**
- Create: `backend/src/ingest/youtube.ts`
- Create: `backend/src/ingest/youtube.test.ts`

**Interfaces:**
- Produces: `class YouTubeListener implements IngestListener` — ctor `(handle: string, onMessage, opts?: { fetchImpl?, log?, liveCheckMs?: number })`; exportované čisté helpery `extractJson(html, varName)`, `lcr(data)`, `pickAllChatToken(lcr)`, `pickTimedContinuation(lcr)`.

Port z extension `YouTubeProvider` (sidepanel.js `connect`, `_findLiveVideoId`, `_fetchChatPage`, `_extractJson`, `_lcr`, `_pickAllChatToken`, `_pollApi`, `_pollPageRefresh`). Rozdíly proti extension: bez `credentials: 'include'`, vlastní `User-Agent`, `Accept-Language: cs`, žádné UI logy; když stream není live, čeká `liveCheckMs` (60 s) a zkouší znovu; když `videoId` přestane odpovídat (stream skončil → API vrací bez `liveChatContinuation` 3× po sobě), vrátí se na hledání videoId.

- [ ] **Step 1: Failing testy helperů a jednoho poll cyklu**

`backend/src/ingest/youtube.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, lcr, pickAllChatToken, pickTimedContinuation, YouTubeListener } from './youtube.js';
import type { IngestMessage } from './types.js';

test('extractJson: brace counting přes vnořené objekty a stringy se závorkami', () => {
  const html = 'x var ytInitialData = {"a":{"b":"}"},"c":[1,{"d":2}]}; y';
  assert.deepEqual(extractJson(html, 'ytInitialData'), { a: { b: '}' }, c: [1, { d: 2 }] });
  assert.equal(extractJson('nothing', 'ytInitialData'), null);
});

test('lcr + pickAllChatToken + pickTimedContinuation', () => {
  const data = { contents: { liveChatRenderer: {
    header: { liveChatHeaderRenderer: { viewSelector: { sortFilterSubMenuRenderer: { subMenuItems: [
      { title: 'Nejlepší zprávy', selected: true },
      { title: 'Chat', selected: false, continuation: { reloadContinuationData: { continuation: 'ALL' } } },
    ] } } } },
    continuations: [{ invalidationContinuationData: { continuation: 'INV' } }, { timedContinuationData: { continuation: 'TIMED', timeoutMs: 4000 } }],
  } } };
  const l = lcr(data)!;
  assert.equal(pickAllChatToken(l), 'ALL');
  assert.deepEqual(pickTimedContinuation(l), { continuation: 'TIMED', timeoutMs: 4000 });
  assert.equal(pickAllChatToken({ header: { liveChatHeaderRenderer: { viewSelector: { sortFilterSubMenuRenderer: { subMenuItems: [{}, { selected: true }] } } } } }), null);
});

test('YouTubeListener: findLive → chat page (popout) → all-chat switch → API poll → onMessage', async () => {
  const calls: string[] = [];
  const renderer = (id: string, usec: string) => ({ addChatItemAction: { item: { liveChatTextMessageRenderer: { id, timestampUsec: usec, authorName: { simpleText: '@a' }, authorExternalChannelId: 'UC1', message: { runs: [{ text: 'hi ' + id }] } } } } });
  const pageJson = (actions: unknown[], all: boolean) => JSON.stringify({ contents: { liveChatRenderer: {
    header: { liveChatHeaderRenderer: { viewSelector: { sortFilterSubMenuRenderer: { subMenuItems: [{ selected: !all }, { selected: all, continuation: { reloadContinuationData: { continuation: 'ALLTOK' } } }] } } } },
    continuations: [{ timedContinuationData: { continuation: 'T1', timeoutMs: 1000 } }],
    actions,
  } } });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(url.split('?')[0] + (init?.method === 'POST' ? ' POST' : ''));
    if (url.endsWith('/robdiesalot/live')) return new Response('"isLive":true "videoId":"ABCDEFGHIJK"', { status: 200 });
    if (url.startsWith('https://www.youtube.com/live_chat?v=')) return new Response(`<script>var ytInitialData = ${pageJson([renderer('old', '1000000')], false)};</script>"INNERTUBE_API_KEY":"KEY" "clientVersion":"2.20260101.00.00"`, { status: 200 });
    if (url.startsWith('https://www.youtube.com/live_chat?continuation=')) return new Response(`<script>var ytInitialData = ${pageJson([renderer('old', '1000000')], true)};</script>`, { status: 200 });
    if (url.includes('/youtubei/v1/live_chat/get_live_chat')) return new Response(JSON.stringify({ continuationContents: { liveChatContinuation: { continuations: [{ timedContinuationData: { continuation: 'T2', timeoutMs: 1000 } }], actions: [renderer('new1', '1789820014396123')] } } }), { status: 200 });
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;

  const got: IngestMessage[] = [];
  const l = new YouTubeListener('robdiesalot', (m) => got.push(m), { fetchImpl, log: { info() {}, warn() {}, error() {} }, minPollMs: 20 });
  l.start();
  await new Promise((r) => setTimeout(r, 120));
  l.stop();
  assert.ok(calls.includes('https://www.youtube.com/robdiesalot/live'));
  assert.ok(calls.includes('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat POST'));
  // úvodní 'old' zprávy ze stránky se ukládají také (historie), 'new1' z API pollu
  assert.deepEqual(got.map((m) => m.platformMessageId).sort(), ['new1', 'old']);
  assert.equal(got.find((m) => m.platformMessageId === 'new1')!.sentAt.getTime(), 1789820014396);
});
```

- [ ] **Step 2: Spustit → FAIL**

- [ ] **Step 3: Implementace**

`backend/src/ingest/youtube.ts`:
```ts
import { normalizeYoutubeAction } from './normalize.js';
import { noopLog, type Logger } from './twitch.js';
import type { IngestListener, IngestMessage, PlatformStatus } from './types.js';

interface Opts { fetchImpl?: typeof fetch; log?: Logger; liveCheckMs?: number; minPollMs?: number }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'cs,en;q=0.8' };

export function extractJson(html: string, varName: string): unknown {
  const markers = [`var ${varName} = `, `window["${varName}"] = `, `window['${varName}'] = `];
  let start = -1;
  for (const m of markers) { const i = html.indexOf(m); if (i !== -1) { start = i + m.length; break; } }
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.substring(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Lcr = any;
export function lcr(data: unknown): Lcr | null {
  const d = data as { contents?: { liveChatRenderer?: Lcr }; continuationContents?: { liveChatContinuation?: Lcr } };
  return d?.contents?.liveChatRenderer || d?.continuationContents?.liveChatContinuation || null;
}

/** Reload token režimu „Chat" (všechny zprávy); null když už v něm jsme / chybí. */
export function pickAllChatToken(l: Lcr): string | null {
  const items = l?.header?.liveChatHeaderRenderer?.viewSelector?.sortFilterSubMenuRenderer?.subMenuItems;
  if (!Array.isArray(items) || items.length < 2) return null;
  const all = items[items.length - 1];
  if (all?.selected) return null;
  return all?.continuation?.reloadContinuationData?.continuation || null;
}

export function pickTimedContinuation(l: Lcr): { continuation: string; timeoutMs: number } | null {
  for (const c of l?.continuations || []) {
    if (c?.timedContinuationData?.continuation) return { continuation: c.timedContinuationData.continuation, timeoutMs: c.timedContinuationData.timeoutMs || 5000 };
  }
  return null;
}

export class YouTubeListener implements IngestListener {
  private st: PlatformStatus = 'off';
  private last: Date | null = null;
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private videoId: string | null = null;
  private apiKey = '';
  private clientVersion = '2.20250401.00.00';
  private cont: string | null = null;
  private allCont: string | null = null;
  private usePageRefresh = false;
  private apiFails = 0;
  private seen = new Set<string>();
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly liveCheckMs: number;
  private readonly minPollMs: number;

  constructor(private readonly handle: string, private readonly onMessage: (m: IngestMessage) => void, opts: Opts = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? noopLog;
    this.liveCheckMs = opts.liveCheckMs ?? 60000;
    this.minPollMs = opts.minPollMs ?? 1500;
  }

  status() { return this.st; }
  lastMessageAt() { return this.last; }
  start() { this.stopped = false; void this.connect(); }
  stop() { this.stopped = true; if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.st = 'off'; }

  private schedule(fn: () => Promise<void>, ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.timer = null; void fn(); }, Math.max(ms, this.minPollMs));
  }

  private async get(url: string): Promise<string> {
    const r = await this.fetchImpl(url, { headers: HEADERS, redirect: 'follow' });
    if (!r.ok) throw new Error(`${url.split('?')[0]} → ${r.status}`);
    return r.text();
  }

  private async findLiveVideoId(): Promise<string | null> {
    for (const url of [`https://www.youtube.com/${this.handle}/live`, `https://www.youtube.com/@${this.handle}/live`]) {
      try {
        const html = await this.get(url);
        const isLive = html.includes('"isLive":true') || html.includes('"isLiveNow":true') || html.includes('"isLiveBroadcast":true');
        const m = html.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
        if (isLive && m) return m[1];
      } catch (err) {
        this.log.warn({ err, url }, 'youtube ingest: findLive selhal');
      }
    }
    return null;
  }

  private chatPage(cont?: string | null): Promise<string> {
    const qs = cont ? `continuation=${encodeURIComponent(cont)}` : `v=${this.videoId}&is_popout=1`;
    return this.get(`https://www.youtube.com/live_chat?${qs}`);
  }

  private async connect() {
    if (this.stopped) return;
    this.st = 'connecting';
    this.cont = null; this.allCont = null; this.usePageRefresh = false; this.apiFails = 0;
    try {
      this.videoId = await this.findLiveVideoId();
      if (!this.videoId) {
        this.st = 'connecting';
        this.log.info({ handle: this.handle }, 'youtube ingest: není live, zkusím za minutu');
        this.schedule(() => this.connect(), this.liveCheckMs);
        return;
      }
      const html = await this.chatPage();
      let l = lcr(extractJson(html, 'ytInitialData'));
      if (!l) throw new Error('ytInitialData bez liveChatRenderer');
      const allTok = pickAllChatToken(l);
      if (allTok) {
        const allL = lcr(extractJson(await this.chatPage(allTok), 'ytInitialData'));
        if (allL) { l = allL; this.allCont = allTok; }
      }
      this.apiKey = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1] || '';
      this.clientVersion = html.match(/"clientVersion"\s*:\s*"([^"]+)"/)?.[1] || this.clientVersion;
      const timed = pickTimedContinuation(l);
      this.cont = timed?.continuation || null;
      this.usePageRefresh = !this.cont || !this.apiKey;
      this.processActions(l.actions || []);
      this.st = 'connected';
      this.log.info({ handle: this.handle, videoId: this.videoId, mode: this.usePageRefresh ? 'page' : 'api', all: !!this.allCont }, 'youtube ingest: connected');
      this.schedule(() => this.poll(), timed?.timeoutMs || 5000);
    } catch (err) {
      this.st = 'reconnecting';
      this.log.warn({ err, handle: this.handle }, 'youtube ingest: connect selhal');
      this.schedule(() => this.connect(), 15000);
    }
  }

  private async poll() {
    if (this.stopped) return;
    if (this.usePageRefresh) return this.pollPage();
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const resp = await this.fetchImpl(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${this.apiKey}&prettyPrint=false`, {
        method: 'POST', signal: ctrl.signal,
        headers: { ...HEADERS, 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': this.clientVersion },
        body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: this.clientVersion, hl: 'cs', gl: 'CZ' } }, continuation: this.cont }),
      });
      clearTimeout(t);
      if (!resp.ok) throw new Error(`get_live_chat ${resp.status}`);
      const l = lcr(await resp.json());
      if (!l) {
        if (++this.apiFails >= 3) { this.log.info({ handle: this.handle }, 'youtube ingest: API bez obsahu 3×, stream skončil? → znovu hledám live'); this.schedule(() => this.connect(), 5000); return; }
        this.schedule(() => this.poll(), 5000); return;
      }
      const timed = pickTimedContinuation(l);
      if (timed) this.cont = timed.continuation; else this.usePageRefresh = true;
      const actions = l.actions || [];
      if (actions.length) this.apiFails = 0; else if (++this.apiFails >= 5) this.usePageRefresh = true;
      this.processActions(actions);
      this.schedule(() => this.poll(), timed?.timeoutMs || 5000);
    } catch (err) {
      this.log.warn({ err, handle: this.handle }, 'youtube ingest: API poll selhal');
      if (++this.apiFails >= 3) this.usePageRefresh = true;
      this.schedule(() => this.poll(), 5000);
    }
  }

  private async pollPage() {
    try {
      const l = lcr(extractJson(await this.chatPage(this.allCont), 'ytInitialData'));
      if (!l) {
        this.allCont = null;
        if (++this.apiFails >= 3) { this.schedule(() => this.connect(), 5000); return; }
        this.schedule(() => this.pollPage(), 8000); return;
      }
      this.apiFails = 0;
      this.processActions(l.actions || []);
      this.schedule(() => this.pollPage(), 3000);
    } catch (err) {
      this.log.warn({ err, handle: this.handle }, 'youtube ingest: page poll selhal');
      this.schedule(() => this.pollPage(), 10000);
    }
  }

  private processActions(actions: unknown[]) {
    for (const a of actions) {
      const m = normalizeYoutubeAction(a, this.handle);
      if (!m || this.seen.has(m.platformMessageId)) continue;
      this.seen.add(m.platformMessageId);
      if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
      this.last = m.sentAt;
      try { this.onMessage(m); } catch (err) { this.log.error({ err }, 'youtube ingest: onMessage threw'); }
    }
  }
}
```

- [ ] **Step 4: Testy → PASS; typecheck**

Run: `cd backend && npm test && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add backend/src/ingest/youtube.ts backend/src/ingest/youtube.test.ts
git commit -m "feat(backend): YouTube live chat poller pro chat ingest (all-chat režim, page-refresh fallback)"
```

---

### Task 7: Orchestrace ingestu, retence, health, lifecycle

**Files:**
- Create: `backend/src/ingest/index.ts`
- Create: `backend/src/ingest/index.test.ts`
- Modify: `backend/src/server.ts`

**Interfaces:**
- Produces: `createIngest(opts: { channels: IngestChannel[]; retentionDays: number; log: Logger; insert?: typeof insertMessages; deleteOld?: typeof deleteOlderThan; listenerFactory?: (c: IngestChannel, onMessage) => IngestListener })` → `{ start(), stop(), status(): IngestStatus }` kde `IngestStatus = { twitch: PlatformStatus; kick: PlatformStatus; youtube: PlatformStatus; lastMessageAt: string|null; inserted: number; dropped: number }`.
- Zápis je dávkový: fronta, flush každých 500 ms nebo při 50 zprávách (jeden INSERT místo desítek).

- [ ] **Step 1: Failing test s falešnými listenery a insertem**

`backend/src/ingest/index.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngest } from './index.js';
import type { IngestListener, IngestMessage } from './types.js';

const silent = { info() {}, warn() {}, error() {} };
const msg = (id: string): IngestMessage => ({ platform: 'twitch', platformMessageId: id, platformUserId: '', username: 'u', channel: 'c', content: 'x', contentRaw: {}, sentAt: new Date(1700000000000), isUnitychatUser: false, isReply: false, replyToMessageId: null });

test('createIngest: startuje listenery per kanál, dávkuje inserty, hlásí status', async () => {
  const batches: number[] = [];
  let emit: ((m: IngestMessage) => void) | null = null;
  const fakeListener: IngestListener & { started: boolean } = { started: false, start() { this.started = true; }, stop() { this.started = false; }, status: () => 'connected', lastMessageAt: () => new Date(1700000000000) };
  const ing = createIngest({
    channels: [{ platform: 'twitch', channel: 'c' }],
    retentionDays: 7, log: silent, flushMs: 10,
    insert: async (rows) => { batches.push(rows.length); return rows.length; },
    deleteOld: async () => 0,
    listenerFactory: (_c, onMessage) => { emit = onMessage; return fakeListener; },
  });
  ing.start();
  assert.equal(fakeListener.started, true);
  emit!(msg('1')); emit!(msg('2'));
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(batches, [2]);
  const s = ing.status();
  assert.equal(s.twitch, 'connected');
  assert.equal(s.kick, 'off');
  assert.equal(s.inserted, 2);
  assert.equal(s.lastMessageAt, '2023-11-14T22:13:20.000Z');
  ing.stop();
  assert.equal(fakeListener.started, false);
});

test('createIngest: bez kanálů je vše off a start() nic nedělá', () => {
  const ing = createIngest({ channels: [], retentionDays: 7, log: silent, insert: async () => 0, deleteOld: async () => 0 });
  ing.start();
  assert.deepEqual(ing.status(), { twitch: 'off', kick: 'off', youtube: 'off', lastMessageAt: null, inserted: 0, dropped: 0 });
  ing.stop();
});
```

- [ ] **Step 2: Spustit → FAIL**

- [ ] **Step 3: Implementace**

`backend/src/ingest/index.ts`:
```ts
import type { IngestChannel } from './channels.js';
import { insertMessages, deleteOlderThan } from './store.js';
import { toRow } from './normalize.js';
import { TwitchListener, type Logger } from './twitch.js';
import { KickListener } from './kick.js';
import { YouTubeListener } from './youtube.js';
import type { IngestListener, IngestMessage, PlatformStatus } from './types.js';

export interface IngestStatus {
  twitch: PlatformStatus; kick: PlatformStatus; youtube: PlatformStatus;
  lastMessageAt: string | null; inserted: number; dropped: number;
}

interface CreateOpts {
  channels: IngestChannel[];
  retentionDays: number;
  log: Logger;
  insert?: typeof insertMessages;
  deleteOld?: typeof deleteOlderThan;
  listenerFactory?: (c: IngestChannel, onMessage: (m: IngestMessage) => void) => IngestListener;
  flushMs?: number;
  retentionMs?: number;
}

function defaultFactory(log: Logger) {
  return (c: IngestChannel, onMessage: (m: IngestMessage) => void): IngestListener => {
    if (c.platform === 'twitch') return new TwitchListener(c.channel, onMessage, { log });
    if (c.platform === 'kick') return new KickListener(c.channel, onMessage, { log });
    return new YouTubeListener(c.channel, onMessage, { log });
  };
}

export function createIngest(opts: CreateOpts) {
  const insert = opts.insert ?? insertMessages;
  const deleteOld = opts.deleteOld ?? deleteOlderThan;
  const factory = opts.listenerFactory ?? defaultFactory(opts.log);
  const flushMs = opts.flushMs ?? 500;
  const retentionMs = opts.retentionMs ?? 60 * 60 * 1000;

  const listeners = new Map<IngestChannel['platform'], IngestListener>();
  let queue: IngestMessage[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let retentionTimer: NodeJS.Timeout | null = null;
  let inserted = 0, dropped = 0;
  let lastAt: Date | null = null;
  let flushing: Promise<void> = Promise.resolve();

  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!queue.length) return flushing;
    const batch = queue; queue = [];
    flushing = flushing.then(async () => {
      try {
        const n = await insert(batch.map(toRow));
        inserted += n; dropped += batch.length - n;
      } catch (err) {
        opts.log.error({ err, size: batch.length }, 'chat ingest: insert selhal, dávka zahozena');
        dropped += batch.length;
      }
    });
    return flushing;
  };

  const onMessage = (m: IngestMessage) => {
    lastAt = !lastAt || m.sentAt > lastAt ? m.sentAt : lastAt;
    queue.push(m);
    if (queue.length >= 50) { void flush(); return; }
    if (!flushTimer) flushTimer = setTimeout(() => void flush(), flushMs);
  };

  const runRetention = async () => {
    try {
      const n = await deleteOld(opts.retentionDays);
      if (n) opts.log.info({ deleted: n, days: opts.retentionDays }, 'chat ingest: retence');
    } catch (err) {
      opts.log.error({ err }, 'chat ingest: retence selhala');
    }
  };

  return {
    start() {
      if (!opts.channels.length) return;
      for (const c of opts.channels) {
        const l = factory(c, onMessage);
        listeners.set(c.platform, l);
        l.start();
      }
      void runRetention();
      retentionTimer = setInterval(() => void runRetention(), retentionMs);
      opts.log.info({ channels: opts.channels }, 'chat ingest: started');
    },
    async stop() {
      for (const l of listeners.values()) l.stop();
      listeners.clear();
      if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
      await flush();
    },
    status(): IngestStatus {
      const st = (p: IngestChannel['platform']): PlatformStatus => listeners.get(p)?.status() ?? 'off';
      return { twitch: st('twitch'), kick: st('kick'), youtube: st('youtube'), lastMessageAt: lastAt ? lastAt.toISOString() : null, inserted, dropped };
    },
  };
}

export type Ingest = ReturnType<typeof createIngest>;
```

`backend/src/server.ts` — přidat importy a zapojení:
```ts
import { parseIngestChannels } from './ingest/channels.js';
import { createIngest } from './ingest/index.js';
import chatRoutes from './routes/chat.js';   // Task 8 — do té doby řádek vynechat
```
před `app.get('/', …)`:
```ts
const ingest = createIngest({
  channels: parseIngestChannels(config.CHAT_INGEST_CHANNELS),
  retentionDays: config.CHAT_RETENTION_DAYS,
  log: app.log,
});
app.addHook('onReady', async () => { ingest.start(); });
app.addHook('onClose', async () => { await ingest.stop(); });
```
v `/health` odpovědi přidat `ingest: ingest.status(),` a verzi `'0.3.0'` (i v `GET /` a `package.json`).

- [ ] **Step 4: Testy → PASS; typecheck; lokální start bez kanálů**

Run: `cd backend && npm test && npm run typecheck && CHAT_INGEST_CHANNELS= npm run dev` → `curl localhost:3000/health` → `ingest: {twitch:'off',…}`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/ingest/index.ts backend/src/ingest/index.test.ts backend/src/server.ts backend/package.json
git commit -m "feat(backend): chat ingest orchestrace, dávkový zápis, retence, /health.ingest (v0.3.0)"
```

---

### Task 8: `GET /chat/history` s kurzorem a rate limitem

**Files:**
- Create: `backend/src/lib/cursor.ts`, `backend/src/lib/cursor.test.ts`
- Create: `backend/src/routes/chat.ts`, `backend/src/routes/chat.test.ts`
- Modify: `backend/src/server.ts` (registrace)

**Interfaces:**
- Produces: `encodeCursor(sentAtMs: number, id: number): string` → `"1789820014396:123"`, `decodeCursor(s: string): { sentAtMs: number; id: number } | null`; `toClientMessage(row: Message): ClientMessage`; route `GET /chat/history`.
- `ClientMessage` (musí odpovídat tomu, co panel dostává z providerů):
  ```ts
  { platform, id, username, message, timestamp, color?, badgesRaw?, twitchEmotes?, twitchEmotesOffset?, replyTo?: {username, message, id}|null,
    firstMsg?, isAction?, kickContent?, kickBadges?, ytRuns?, superChat?, historical: true }
  ```

- [ ] **Step 1: Failing testy**

`backend/src/lib/cursor.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCursor, decodeCursor } from './cursor.js';

test('cursor roundtrip + odmítne nesmysly', () => {
  assert.equal(encodeCursor(1789820014396, 42), '1789820014396:42');
  assert.deepEqual(decodeCursor('1789820014396:42'), { sentAtMs: 1789820014396, id: 42 });
  assert.equal(decodeCursor(''), null);
  assert.equal(decodeCursor('abc:1'), null);
  assert.equal(decodeCursor('1:-5'), null);
  assert.equal(decodeCursor('1:2:3'), null);
});
```

`backend/src/routes/chat.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toClientMessage, RateLimiter } from './chat.js';
import type { Message } from '../db/schema.js';

const base: Message = { id: 7, platform: 'twitch', platformMessageId: 'abc', platformUserId: '1', platformUsername: 'Trokner', userId: null, content: 'hi LUL', contentRaw: { color: '#B22222', badges: 'moderator/1', emotes: '425618:3-5', emotesOffset: 0, firstMsg: false, action: false, replyParentDisplayName: 'hlavis697', replyParentBody: 'x' }, channel: 'robdiesalot', isUnitychatUser: false, isReply: true, replyToMessageId: 'p1', sentAt: new Date(1789820014396), createdAt: new Date() };

test('toClientMessage: twitch', () => {
  const c = toClientMessage(base);
  assert.deepEqual(c, { platform: 'twitch', id: 'abc', username: 'Trokner', userId: '1', message: 'hi LUL', timestamp: 1789820014396, color: '#B22222', badgesRaw: 'moderator/1', twitchEmotes: '425618:3-5', twitchEmotesOffset: 0, firstMsg: false, isAction: false, replyTo: { username: 'hlavis697', message: 'x', id: 'p1' }, historical: true });
});

test('toClientMessage: kick a youtube nesou platformní payload', () => {
  const k = toClientMessage({ ...base, platform: 'kick', contentRaw: { content: 'a [emote:1:X]', color: '#53fc18', badges: [{ type: 'moderator', text: 'Moderator' }] }, isReply: false, replyToMessageId: null });
  assert.equal(k.kickContent, 'a [emote:1:X]');
  assert.equal(k.badgesRaw, 'moderator');
  const y = toClientMessage({ ...base, platform: 'youtube', contentRaw: { runs: [{ text: 'hi' }], superChat: true, badges: ['Moderátor'] }, isReply: false, replyToMessageId: null });
  assert.deepEqual(y.ytRuns, [{ text: 'hi' }]);
  assert.equal(y.superChat, true);
  assert.equal(y.color, '#ffd600');
});

test('RateLimiter: 10 tokenů, doplňuje 10/s', () => {
  let now = 0;
  const rl = new RateLimiter(10, 10, () => now);
  for (let i = 0; i < 10; i++) assert.equal(rl.allow('ip'), true);
  assert.equal(rl.allow('ip'), false);
  now = 100; // +1 token
  assert.equal(rl.allow('ip'), true);
  assert.equal(rl.allow('ip'), false);
  assert.equal(rl.allow('other'), true);
});
```

- [ ] **Step 2: Spustit → FAIL**

- [ ] **Step 3: Implementace**

`backend/src/lib/cursor.ts`:
```ts
/** Kurzor stránkování: "<sent_at_ms>:<id>" poslední (nejstarší) zprávy stránky. */
export function encodeCursor(sentAtMs: number, id: number): string {
  return `${sentAtMs}:${id}`;
}

export function decodeCursor(s: string): { sentAtMs: number; id: number } | null {
  const m = /^(\d{1,16}):(\d{1,16})$/.exec(s || '');
  if (!m) return null;
  return { sentAtMs: Number(m[1]), id: Number(m[2]) };
}
```

`backend/src/routes/chat.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, streamers, type Message } from '../db/schema.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';

export interface ClientMessage {
  platform: string; id: string; username: string; userId: string; message: string; timestamp: number;
  color?: string | null; badgesRaw?: string; twitchEmotes?: string | null; twitchEmotesOffset?: number;
  firstMsg?: boolean; isAction?: boolean; replyTo?: { username: string; message: string; id: string } | null;
  kickContent?: string; ytRuns?: unknown[]; superChat?: boolean; historical: true;
}

/** Řádek z DB → tvar, který panel dostává od providerů (renderer má jednu cestu). */
export function toClientMessage(row: Message): ClientMessage {
  const raw = (row.contentRaw || {}) as Record<string, unknown>;
  const base = {
    platform: row.platform, id: row.platformMessageId, username: row.platformUsername, userId: row.platformUserId,
    message: row.content, timestamp: row.sentAt.getTime(), historical: true as const,
  };
  if (row.platform === 'twitch') {
    return {
      ...base,
      color: (raw.color as string) || null,
      badgesRaw: (raw.badges as string) || '',
      twitchEmotes: (raw.emotes as string) || null,
      twitchEmotesOffset: (raw.emotesOffset as number) || 0,
      firstMsg: !!raw.firstMsg,
      isAction: !!raw.action,
      replyTo: row.isReply && row.replyToMessageId
        ? { username: (raw.replyParentDisplayName as string) || '', message: (raw.replyParentBody as string) || '', id: row.replyToMessageId }
        : null,
    };
  }
  if (row.platform === 'kick') {
    const badges = Array.isArray(raw.badges) ? (raw.badges as { type: string; count?: number }[]) : [];
    return {
      ...base,
      color: (raw.color as string) || '#53fc18',
      kickContent: (raw.content as string) || row.content,
      badgesRaw: badges.filter((b) => b && b.type).map((b) => (b.count ? `${b.type}/${b.count}` : b.type)).join(','),
      replyTo: row.isReply && row.replyToMessageId
        ? { username: (raw.replyParentUsername as string) || '', message: (raw.replyParentBody as string) || '', id: row.replyToMessageId }
        : null,
    };
  }
  return {
    ...base,
    ytRuns: Array.isArray(raw.runs) ? (raw.runs as unknown[]) : [],
    superChat: !!raw.superChat,
    color: raw.superChat ? '#ffd600' : null,
  };
}

/** Token bucket per klíč; capacity tokenů, refill tokenů/s. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly capacity: number, private readonly perSec: number, private readonly now: () => number = Date.now) {}
  allow(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.perSec);
    b.at = t;
    if (b.tokens < 1) { this.buckets.set(key, b); return false; }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 5000) this.buckets.clear();
    return true;
  }
}

export default async function chatRoutes(app: FastifyInstance) {
  const limiter = new RateLimiter(10, 10);

  app.get<{ Querystring: { channel?: string; limit?: string; before?: string } }>('/chat/history', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!limiter.allow(req.ip)) { reply.code(429); return { ok: false, error: 'too many requests' }; }

    const channel = (req.query.channel || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{1,40}$/.test(channel)) { reply.code(400); return { ok: false, error: 'channel' }; }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '100', 10) || 100));
    const cursor = req.query.before ? decodeCursor(req.query.before) : null;
    if (req.query.before && !cursor) { reply.code(400); return { ok: false, error: 'before' }; }

    // Kanál je Twitch login; ostatní platformy přes streamers directory.
    const dir = await db.select({ yt: streamers.youtubeHandle, kick: streamers.kickSlug }).from(streamers).where(eq(streamers.twitchLogin, channel)).limit(1);
    const channels = [channel, dir[0]?.yt?.toLowerCase(), dir[0]?.kick?.toLowerCase()].filter((c): c is string => !!c);

    const conds = [inArray(messages.channel, channels)];
    if (cursor) {
      const at = new Date(cursor.sentAtMs);
      conds.push(or(lt(messages.sentAt, at), and(eq(messages.sentAt, at), lt(messages.id, cursor.id)))!);
    }
    const rows = await db.select().from(messages).where(and(...conds)).orderBy(desc(messages.sentAt), desc(messages.id)).limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const oldest = page[page.length - 1];
    return {
      ok: true,
      messages: page.reverse().map(toClientMessage),
      nextBefore: hasMore && oldest ? encodeCursor(oldest.sentAt.getTime(), oldest.id) : null,
    };
  });
}
```
(`sql` import odstranit, pokud ho lint hlásí jako nepoužitý.)

`backend/src/server.ts`: `await app.register(chatRoutes);` za `storeRoutes`.

- [ ] **Step 4: Testy → PASS; typecheck; ruční ověření proti lokální DB**

Run: `cd backend && npm test && npm run typecheck`
Lokálně s DB: vložit testovací řádek a `curl "localhost:3000/chat/history?channel=robdiesalot&limit=2"` → `{ok:true, messages:[…], nextBefore:…}`; druhý dotaz s `before=<nextBefore>` vrátí starší stránku bez překryvu.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/cursor.ts backend/src/lib/cursor.test.ts backend/src/routes/chat.ts backend/src/routes/chat.test.ts backend/src/server.ts
git commit -m "feat(backend): GET /chat/history s kurzorem, mapováním na tvar klienta a rate limitem"
```

---

### Task 9: Nasazení backendu a kontrola ingestu naostro

**Files:**
- Modify: `backend/README.md` (endpoint, env), `CLAUDE.md` (Backend v0.3.0 sekce: endpoint, env, ingest), `SERVER.md` (lokální: Coolify env `CHAT_INGEST_CHANNELS`)

- [ ] **Step 1: Coolify env**

V Coolify (viz SERVER.md — env přes DB `environment_variables`, jen sloupec `value`, žádné víceřádkové hodnoty): přidat `CHAT_INGEST_CHANNELS=twitch:robdiesalot,kick:robdiesalot,youtube:robdiesalot` a `CHAT_RETENTION_DAYS=7`.

- [ ] **Step 2: Push do dev → merge backend změn tak, jak user rozhodne**

Backend deploy z Coolify sleduje `backend/**` na nasazené větvi — ověřit v SERVER.md, ze které větve Coolify staví. Pokud z `master`: **nepřidávat release sám** — říct userovi, že backend je připravený a čeká na jeho merge (memory `feedback_no_release_nagging`: jen informovat, nenavrhovat). Pokud z `dev`: push stačí.

- [ ] **Step 3: Ověřit**

```bash
curl -s https://api.jouki.cz/health | python -m json.tool     # ingest.twitch=connected, kick=connected, youtube=connected|connecting
curl -s "https://api.jouki.cz/chat/history?channel=robdiesalot&limit=3"
```
Na VPS: `docker exec aj70ceyvdhxuvhe07suo3q9y psql -U postgres -d unitychat -c "select platform, count(*), max(sent_at), max(created_at - sent_at) from messages where channel='robdiesalot' group by 1"`.
Expected: řádky přibývají pro Twitch (i mimo stream chat běží), Kick/YT během streamu; `created_at - sent_at` v řádu stovek ms (Twitch/Kick), sekund (YT).

- [ ] **Step 4: Docs + commit**

`backend/README.md`: sekce „Chat ingest" (env, co ukládá, retence) + endpoint `GET /chat/history` (parametry, kurzor, tvar odpovědi). `CLAUDE.md` → Backend sekce: verze 0.3.0, endpoint do seznamu, env do Deploy odstavce. Changelog do `CLAUDE-HISTORY.md`.
```bash
git add backend/README.md CLAUDE.md CLAUDE-HISTORY.md
git commit -m "docs(backend): chat ingest + /chat/history (v0.3.0)"
```

---

### Task 10: Audit kompletnosti a latence (`scripts/ingest-audit.mjs`)

**Files:**
- Modify: `extension/sidepanel.js` — DIAG dump: přidat pole `msgCacheIds` (všechna `platform:id` z `_msgCache`, ne jen posledních 30) — bump `3.38.78`
- Create: `scripts/ingest-audit.mjs`

**Interfaces:**
- `node scripts/ingest-audit.mjs --db postgres://… dump1.txt [dump2.txt …]` → tabulka per platforma: `seen` (v dumpech), `found` (v DB), `recall %`, `p50/p95/max latence` (`created_at − sent_at` ms pro nalezené), seznam prvních 20 chybějících id s textem z dumpu.

- [ ] **Step 1: DIAG dump rozšířit**

V `sidepanel.js` v DIAG dumpu (u `msgCacheSize:`) přidat:
```js
      msgCacheIds: (this._msgCache || []).filter((m) => m.id && m.platform && !String(m.id).startsWith('opt-')).map((m) => `${m.platform}:${m.id}|${m.timestamp || 0}|${(m.username || '')}|${String(m.message || '').slice(0, 40)}`),
```
Bump manifest `3.38.78`, commit `debug(extension): DIAG dump nese všechna platform:id z cache pro audit ingestu (v3.38.78)`.

- [ ] **Step 2: Skript**

`scripts/ingest-audit.mjs`:
```js
#!/usr/bin/env node
// Audit ingestu: která platform:id z DIAG dumpů extension (msgCacheIds) v DB chybí
// a jaká je latence created_at - sent_at. Kritéria viz spec §6.
import fs from 'node:fs';
import postgres from '../backend/node_modules/postgres/src/index.js';

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
if (dbIdx === -1 || !args[dbIdx + 1]) { console.error('usage: node scripts/ingest-audit.mjs --db <DATABASE_URL> dump.txt [...]'); process.exit(2); }
const url = args[dbIdx + 1];
const files = args.filter((a, i) => i !== dbIdx && i !== dbIdx + 1);
if (!files.length) { console.error('žádné dumpy'); process.exit(2); }

const seen = new Map(); // "platform:id" -> {platform, id, ts, user, text}
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  const m = txt.match(/"msgCacheIds"\s*:\s*\[([\s\S]*?)\]/);
  if (!m) { console.warn(`${f}: msgCacheIds nenalezeno (dump ze starší verze?)`); continue; }
  for (const item of JSON.parse('[' + m[1] + ']')) {
    const [key, ts, user, text] = item.split('|');
    const [platform, ...rest] = key.split(':');
    seen.set(key, { platform, id: rest.join(':'), ts: Number(ts), user, text });
  }
}
console.log(`dumpy: ${files.length}, unikátních zpráv: ${seen.size}`);

const sql = postgres(url, { max: 2 });
const byPlatform = { twitch: [], kick: [], youtube: [] };
for (const v of seen.values()) byPlatform[v.platform]?.push(v);

const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const crit = { twitch: { recall: 99.5, p95: 2000 }, kick: { recall: 99.5, p95: 2000 }, youtube: { recall: 95, p95: 10000 } };

let allOk = true;
for (const [platform, list] of Object.entries(byPlatform)) {
  if (!list.length) { console.log(`\n${platform}: v dumpech nic`); continue; }
  const ids = list.map((v) => v.id);
  const rows = await sql`select platform_message_id as id, extract(epoch from (created_at - sent_at)) * 1000 as lat from messages where platform = ${platform} and platform_message_id in ${sql(ids)}`;
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
```

- [ ] **Step 3: Sběr dat a vyhodnocení**

Postup (spec §6): ≥ 1 h živého streamu s v3.38.78 u ≥ 3 uživatelů (včetně Joukiho), po streamu 💾 dump od každého → `node scripts/ingest-audit.mjs --db <url z SERVER.md> dump1.txt dump2.txt dump3.txt` (DB port je interní — pouštět na VPS, nebo přes ssh tunel). Výsledek zapsat do `CLAUDE-HISTORY.md` changelogu s čísly. **Klientská část (Task 11+) se pouští až po PASS**; při FAIL najít příčinu chybějících id (typicky YT page-refresh mezera nebo Twitch reconnect) a opravit ingest.

- [ ] **Step 4: Commit**

```bash
git add scripts/ingest-audit.mjs
git commit -m "feat(scripts): audit recall a latence chat ingestu proti DIAG dumpům"
```

---

# ČÁST B — Extension v3.39.0 (až po PASS auditu)

### Task 11: Čas z platformy v providerech

**Files:**
- Modify: `extension/sidepanel.js` — `TwitchProvider._parse` a `_parseNotice` (`timestamp: Date.now()` → tag), `KickProvider._parse`, `YouTubeProvider._processActions`
- Create: `scripts/test-provider-timestamps.js`

- [ ] **Step 1: Failing test (vm nad skutečnými třídami)**

`scripts/test-provider-timestamps.js` — stejný vzor jako `scripts/test-send-race.js`: načíst `extension/sidepanel.js`, vyříznout `class TwitchProvider` až po `class KickProvider` (a dál `class KickProvider` … `class YouTubeProvider`, `class YouTubeProvider` … `class NicknameManager` nebo další třídu), spustit ve `vm` se stubem `twitchDefaultColor = () => '#fff'`, `ytNameColor = () => '#fff'`, `crypto`, `chrome.runtime.sendMessage`:
```js
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'sidepanel.js'), 'utf8');
const between = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
const code = between('class TwitchProvider', 'class KickProvider') + between('class KickProvider', 'class YouTubeProvider') + between('class YouTubeProvider', 'class NicknameManager');
const sandbox = { console, crypto: { randomUUID: () => 'r' }, twitchDefaultColor: () => '#fff', ytNameColor: () => '#fff', chrome: { runtime: { sendMessage: () => ({ catch() {} }) } }, setTimeout, clearTimeout, Date, WebSocket: class {}, fetch: async () => { throw new Error('no net'); }, performance };
vm.createContext(sandbox); vm.runInContext(code + '\nthis.TwitchProvider = TwitchProvider; this.KickProvider = KickProvider; this.YouTubeProvider = YouTubeProvider;', sandbox);

let fails = 0; const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };

const tw = new sandbox.TwitchProvider(); let got; tw.onMessage = (m) => { got = m; };
tw._parse('@id=m1;display-name=A;tmi-sent-ts=1789820014396;user-id=1 :a!a@a PRIVMSG #c :hi');
check('twitch: timestamp = tmi-sent-ts', got.timestamp === 1789820014396);
tw._parse('@id=m2;display-name=A;user-id=1 :a!a@a PRIVMSG #c :hi');
check('twitch: bez tagu fallback Date.now()', Math.abs(got.timestamp - Date.now()) < 1000);

const ki = new sandbox.KickProvider(); ki.onMessage = (m) => { got = m; };
ki._parse({ id: 'k', type: 'message', content: 'x', created_at: '2026-09-19T12:13:34.396Z', sender: { id: 1, username: 'u', identity: { badges: [] } } });
check('kick: timestamp = created_at', got.timestamp === Date.parse('2026-09-19T12:13:34.396Z'));

const yt = new sandbox.YouTubeProvider(); yt.onMessage = (m) => { got = m; };
yt._processActions([{ addChatItemAction: { item: { liveChatTextMessageRenderer: { id: 'y', timestampUsec: '1789820014396123', authorName: { simpleText: '@a' }, message: { runs: [{ text: 'hi' }] } } } } }]);
check('youtube: timestamp = timestampUsec/1000', got.timestamp === 1789820014396);
process.exit(fails ? 1 : 0);
```
Run: `node scripts/test-provider-timestamps.js` → 3× FAIL (dnes `Date.now()`).

- [ ] **Step 2: Implementace**

`TwitchProvider._parse`: `timestamp: Date.now(),` → `timestamp: Number(tags['tmi-sent-ts']) || Date.now(),`; totéž v `_parseNotice` (USERNOTICE nese `tmi-sent-ts`).
`KickProvider._parse`: `timestamp: Date.now(),` → `timestamp: Date.parse(data.created_at) || Date.now(),`.
`YouTubeProvider._processActions`: `timestamp: Date.now(),` → `timestamp: Math.floor(Number(renderer.timestampUsec) / 1000) || Date.now(),`.

- [ ] **Step 3: Test → PASS; bump `3.38.79`; commit**

```bash
git add extension/sidepanel.js extension/manifest.json scripts/test-provider-timestamps.js
git commit -m "feat(extension): timestamp zpráv z platformy (tmi-sent-ts, created_at, timestampUsec) (v3.38.79)"
```

---

### Task 12: `ChatStore` (bez DOM, testovaný v Node)

**Files:**
- Create: `extension/chat-store.js`
- Create: `scripts/test-chat-store.js`
- Modify: `extension/sidepanel.html` (`<script src="chat-store.js"></script>` před `sidepanel.js`)

**Interfaces:**
- Produces (globál `ChatStore` v panelu, `module.exports` v Node):
  ```js
  class ChatStore {
    constructor()
    get length()
    add(msg) → 'added' | 'dup'            // vloží podle (timestamp, id); dup = platform:id už je
    prependOlder(msgs) → number            // z /chat/history; vrací kolik přibylo
    upgrade(optimisticId, realMsg) → boolean  // nahradí optimistickou zprávu echem (id, timestamp, badges…)
    markFailed(id) → boolean               // msg.sendFailed = true
    remove(id) → boolean
    get(id) → msg | null
    indexOf(id) → number
    slice(from, to) → msg[]
    at(i) → msg
    key(msg) → 'platform:id'
    oldestCursor → string | null           // nastavuje renderer z odpovědi API (nextBefore)
  }
  ```
- Řazení: `timestamp ASC`, tie-break `id` (string compare). Vkládání binárním hledáním od konce (live zprávy jsou skoro vždy nejnovější).

- [ ] **Step 1: Failing testy**

`scripts/test-chat-store.js`:
```js
const ChatStore = require('../extension/chat-store.js');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };
const m = (id, ts, platform = 'twitch', extra = {}) => ({ id, timestamp: ts, platform, username: 'u', message: 'x', ...extra });

const s = new ChatStore();
check('add vrací added', s.add(m('a', 100)) === 'added');
check('add stejné id → dup', s.add(m('a', 100)) === 'dup');
check('stejné id jiná platforma není dup', s.add(m('a', 100, 'kick')) === 'added');
s.add(m('b', 50)); s.add(m('c', 200)); s.add(m('d', 100));
check('seřazeno podle času, tie podle id', s.slice(0, s.length).map((x) => x.platform + ':' + x.id).join(',') === 'twitch:b,kick:a,twitch:a,twitch:d,twitch:c');
check('indexOf', s.indexOf('c') === 4 && s.indexOf('nope') === -1);

check('prependOlder vrací počet nových a ignoruje duplicity', s.prependOlder([m('b', 50), m('z', 10), m('y', 20)]) === 2);
check('nejstarší první', s.at(0).id === 'z' && s.at(1).id === 'y');

const opt = m('opt-1', 300, 'twitch', { _optimistic: true, message: 'hello' });
s.add(opt);
check('upgrade nahradí id i timestamp a zachová pozici podle nového času', s.upgrade('opt-1', m('real', 299, 'twitch', { badgesRaw: 'moderator/1' })) === true && s.get('real').badgesRaw === 'moderator/1' && s.get('opt-1') === null && s.at(s.length - 1).id === 'real');
check('upgrade neznámého → false', s.upgrade('nope', m('q', 1)) === false);
check('markFailed', s.add(m('opt-2', 400, 'twitch', { _optimistic: true })) === 'added' && s.markFailed('opt-2') && s.get('opt-2').sendFailed === true);
check('remove', s.remove('opt-2') && s.get('opt-2') === null);
check('slice mimo rozsah je bezpečný', s.slice(-5, 999).length === s.length);
process.exit(fails ? 1 : 0);
```
Run: `node scripts/test-chat-store.js` → FAIL (modul chybí).

- [ ] **Step 2: Implementace**

`extension/chat-store.js`:
```js
// ChatStore — jediný držitel dat zpráv v panelu. Bez DOM, bez chrome.*,
// aby šel testovat v Node (scripts/test-chat-store.js). Renderer si z něj
// bere okno (slice) a nikdy nedrží zprávy, které store nemá.
//
// Řazení: timestamp ASC, tie-break id. Dedup jen podle "platform:id" —
// content-key dedup zmizel spolu se scrape (zprávy bez id už neexistují).
class ChatStore {
  constructor() {
    this._all = [];
    this._ids = new Set();
    this.oldestCursor = null;
  }

  get length() { return this._all.length; }
  key(msg) { return `${msg.platform}:${msg.id}`; }
  at(i) { return this._all[i]; }
  get(id) { const i = this.indexOf(id); return i === -1 ? null : this._all[i]; }
  indexOf(id) {
    for (let i = this._all.length - 1; i >= 0; i--) if (this._all[i].id === id) return i;
    return -1;
  }
  slice(from, to) {
    const a = Math.max(0, from | 0);
    const b = Math.min(this._all.length, to == null ? this._all.length : to | 0);
    return a < b ? this._all.slice(a, b) : [];
  }

  static _cmp(a, b) {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  }

  // Pozice pro vložení: první index, jehož prvek je > msg. Hledá se od konce,
  // protože živé zprávy jsou skoro vždy nejnovější (O(1) typicky).
  _insertPos(msg) {
    let i = this._all.length;
    while (i > 0 && ChatStore._cmp(this._all[i - 1], msg) > 0) i--;
    return i;
  }

  add(msg) {
    if (!msg || msg.id == null || !msg.platform) return 'dup';
    if (typeof msg.timestamp !== 'number' || !Number.isFinite(msg.timestamp)) msg.timestamp = Date.now();
    const k = this.key(msg);
    if (this._ids.has(k)) return 'dup';
    this._ids.add(k);
    this._all.splice(this._insertPos(msg), 0, msg);
    return 'added';
  }

  prependOlder(msgs) {
    let n = 0;
    for (const m of msgs || []) if (this.add(m) === 'added') n++;
    return n;
  }

  upgrade(optimisticId, realMsg) {
    const i = this.indexOf(optimisticId);
    if (i === -1) return false;
    const old = this._all[i];
    this._ids.delete(this.key(old));
    this._all.splice(i, 1);
    const merged = { ...old, ...realMsg, _optimistic: false };
    delete merged.sendFailed;
    this.add(merged);
    return true;
  }

  markFailed(id) {
    const m = this.get(id);
    if (!m) return false;
    m.sendFailed = true;
    return true;
  }

  remove(id) {
    const i = this.indexOf(id);
    if (i === -1) return false;
    this._ids.delete(this.key(this._all[i]));
    this._all.splice(i, 1);
    return true;
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = ChatStore;
```

`extension/sidepanel.html`: před `<script src="sidepanel.js"></script>` vložit `<script src="chat-store.js"></script>`.

- [ ] **Step 3: Test → PASS; bump `3.38.80`; commit**

```bash
git add extension/chat-store.js extension/sidepanel.html extension/manifest.json scripts/test-chat-store.js
git commit -m "feat(extension): ChatStore — jediný držitel zpráv, řazení podle času z platformy (v3.38.80)"
```

---

### Task 13: Boot z `/chat/history`, live přes store, mazání cache/dedup/tab-importu

**Files:**
- Modify: `extension/sidepanel.js` (viz seznam níže), `extension/background.js` (smazat handler `TW_HISTORY`), `extension/manifest.json`

Tohle je největší úkol; postupovat v pořadí a po každém kroku `node --check extension/sidepanel.js` + reload panelu na živém streamu.

- [ ] **Step 1: Store v konstruktoru, `_addMessage` přes store**

V konstruktoru `UnityChat` (u `this._msgCache = [];`): nahradit `_msgCache`, `_hydratedIdx`, `_hydratingOlder`, `_dedupChannels`, `_dedupLRU`, `_dedupMaxChannels` jedním `this.store = new ChatStore();` + `this._win = { start: 0, end: 0 };` + `this._historyBusy = false; this._historyCooldownUntil = 0;`.

V `_addMessage(msg)` nahradit celý blok dedupu (od `const dedup = this._dedupEntry(msg)` přes `dedup.ids.has` až po content-key větev s `_optimisticKeys`) tímto:
```js
    // Optimistická ↔ echo: párování podle content key zůstává (echo má jiné id).
    const contentKey = msg.username && msg.message ? this._contentKey(msg.username, msg.message) : null;
    if (contentKey && !msg._optimistic && this._optimisticKeys.has(contentKey)) {
      const optId = this._optimisticKeys.get(contentKey);
      this._optimisticKeys.delete(contentKey);
      if (this.store.get(optId)) {
        this.store.upgrade(optId, msg);
        this._upgradeOptimistic(optId, msg);   // DOM část (barva, badges, id)
        return;
      }
    }
    if (msg._optimistic && contentKey) this._optimisticKeys.set(contentKey, msg.id);

    const res = this.store.add(msg);
    if (res === 'dup') return;
```
Zbytek `_addMessage` (render elementu) zůstává, ale místo `this.chatEl.appendChild(el)` / `insertBefore` volat `this._placeInDom(el, msg)` (Step 3). Na konci **odstranit** `this._cacheMsg(msg)` a `if (this.msgCount > this.config.maxMessages) this._trim();`.

- [ ] **Step 2: Boot: `_loadHistory()` místo `_loadCachedMessages()`**

Nová metoda (za `_init`):
```js
  // Historie výhradně ze serveru (spec 2026-09-19). Lokální cache i scrape
  // zmizely: server poslouchá platformy sám a vrací zprávy s časem platformy.
  async _loadHistory({ before = null, limit = 100 } = {}) {
    const channel = (this.config.channel || '').toLowerCase();
    if (!channel) return 0;
    const url = new URL(`${UC_API}/chat/history`);
    url.searchParams.set('channel', channel);
    url.searchParams.set('limit', String(limit));
    if (before) url.searchParams.set('before', before);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!data?.ok) throw new Error(data?.error || 'bad response');
      const added = this.store.prependOlder(data.messages || []);
      if (!before || data.nextBefore !== undefined) this.store.oldestCursor = data.nextBefore || null;
      this._historyFetches = (this._historyFetches || 0) + 1;
      this._log?.('History', `before=${before || '-'} got=${data.messages?.length || 0} added=${added} next=${data.nextBefore || '-'}`);
      return added;
    } catch (err) {
      this._sys(`Historie nedostupná (${err.name === 'AbortError' ? 'timeout' : err.message})`);
      this._historyCooldownUntil = performance.now() + 3000;
      return 0;
    } finally {
      clearTimeout(t);
    }
  }
```
(`UC_API` je existující konstanta `https://api.jouki.cz`; `this._log` — pokud UnityChat nemá helper, použít `chrome.runtime.sendMessage({ type: 'UC_LOG', tag: 'History', text })` jako v `_importTwitchHistory`.)

V `_init`: `await this._loadCachedMessages(); this._bootMark('cache loaded', …)` → 
```js
    await this._loadHistory();
    this._renderWindow({ toEnd: true });
    this._bootMark('history loaded', `store=${this.store.length} rendered=${this._win.end - this._win.start}`);
```

- [ ] **Step 3: Renderer okno**

Nové metody (vedle `_scroll`):
```js
  _placeInDom(el, msg) {
    // Zpráva je ve store; do DOM jde jen když spadá do okna nebo těsně za něj
    // (live append). Jinak zůstane jen v datech a vykreslí se, až okno dojde.
    const idx = this.store.indexOf(msg.id);
    if (idx === -1) return;
    if (idx >= this._win.end) {
      if (idx === this._win.end && (this.autoScroll || this._win.end === this.store.length - 1)) {
        this.chatEl.appendChild(el);
        this._win.end++;
        this._unloadTop();
        return;
      }
      // Uživatel je nahoře → jen počítadlo, DOM se dotáhne po kliknutí na „N nových".
      this._bumpUnread();
      return;
    }
    if (idx < this._win.start) return;
    // Historická zpráva uvnitř okna (např. z /chat/history po scrollu): vložit podle pořadí.
    const next = this.chatEl.querySelector(`.msg[data-msg-id="${CSS.escape(String(this.store.at(idx + 1)?.id ?? ''))}"]`);
    if (next) this.chatEl.insertBefore(el, next); else this.chatEl.appendChild(el);
    this._win.end++;
  }

  // Překreslí okno [start,end) ze store do DOM. toEnd = okno končí poslední zprávou.
  _renderWindow({ toEnd = false } = {}) {
    const len = this.store.length;
    if (toEnd) this._win = { start: Math.max(0, len - 300), end: len };
    this.chatEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const m of this.store.slice(this._win.start, this._win.end)) frag.appendChild(this._buildMessageEl(m));
    this.chatEl.appendChild(frag);
    if (toEnd) { this.autoScroll = true; this.chatEl.scrollTop = this.chatEl.scrollHeight; this._clearUnread(); }
  }

  _unloadTop() {
    const over = (this._win.end - this._win.start) - 300;
    if (over <= 0 || !this.autoScroll) return;
    for (let i = 0; i < over; i++) { const first = this.chatEl.querySelector('.msg'); if (first) first.remove(); }
    this._win.start += over;
  }

  _unloadBottom() {
    const over = (this._win.end - this._win.start) - 300;
    if (over <= 0) return;
    const nodes = this.chatEl.querySelectorAll('.msg');
    for (let i = 0; i < over; i++) nodes[nodes.length - 1 - i]?.remove();
    this._win.end -= over;
    this.autoScroll = false;
  }

  async _extendUp() {
    if (this._historyBusy || performance.now() < this._historyCooldownUntil) return;
    this._historyBusy = true;
    try {
      let take = Math.min(100, this._win.start);
      if (take === 0 && this.store.oldestCursor) {
        this._showHydrateSpinner();
        const added = await this._loadHistory({ before: this.store.oldestCursor });
        this._hideHydrateSpinner();
        // prependOlder posunul indexy: okno se posune o počet přidaných
        this._win.start += added; this._win.end += added;
        take = Math.min(100, this._win.start);
      }
      if (take === 0) return;
      const prevHeight = this.chatEl.scrollHeight, prevTop = this.chatEl.scrollTop;
      const frag = document.createDocumentFragment();
      for (const m of this.store.slice(this._win.start - take, this._win.start)) frag.appendChild(this._buildMessageEl(m));
      this.chatEl.prepend(frag);
      this._win.start -= take;
      this._programmaticScrollUntil = performance.now() + 50;
      this.chatEl.scrollTop = prevTop + (this.chatEl.scrollHeight - prevHeight);
      this._unloadBottom();
    } finally {
      this._historyBusy = false;
    }
  }

  _extendDown() {
    const take = Math.min(100, this.store.length - this._win.end);
    if (take <= 0) return;
    const frag = document.createDocumentFragment();
    for (const m of this.store.slice(this._win.end, this._win.end + take)) frag.appendChild(this._buildMessageEl(m));
    this.chatEl.appendChild(frag);
    this._win.end += take;
    // unload shora symetricky
    const over = (this._win.end - this._win.start) - 300;
    for (let i = 0; i < over; i++) this.chatEl.querySelector('.msg')?.remove();
    if (over > 0) this._win.start += over;
  }
```
`_buildMessageEl(msg)` = dnešní tělo `_addMessage` od `const el = document.createElement('div'); el.className = 'msg';` po dokončení elementu **bez** vkládání do DOM — extrahovat do metody (render je pak jedna cesta pro live i historii). `_addMessage` = dedup/store + `const el = this._buildMessageEl(msg); this._placeInDom(el, msg);` + zbytek (unread, scroll). `_showHydrateSpinner/_hideHydrateSpinner` = dnešní kód spinneru z `_hydrateOlderMessages` (`.hydrate-spinner`), vytažený do dvou metod.

Scroll handler: `if (el.scrollTop < 200 && this._hydratedIdx > 0 && !this._hydratingOlder) this._hydrateOlderMessages();` → `if (el.scrollTop < 200) this._extendUp();` a přidat `if (el.scrollHeight - el.scrollTop - el.clientHeight < 200 && this._win.end < this.store.length) this._extendDown();`.
`scrollBtn` click: `this._renderWindow({ toEnd: true });`.

- [ ] **Step 4: Smazat mrtvé cesty**

Odstranit metody a jejich volání: `_cacheKey`, `_compactMsg`, `_expandMsg`, `_cacheMsg`, `_loadCachedMessages`, `_hydrateOlderMessages`, `_trim`, `_dedupEntry`, `_dedupTrim`, `_importTwitchHistory`, `_historyToMsg`, `_firstNewerMsgEl`; `beforeunload` handler zapisující cache; `setTimeout(() => this._importTwitchHistory(), 1500)` v `_connectAll`; v `background.js` blok `if (msg.type === 'TW_HISTORY' …)`. `_markSendFailed`: místo filtrování `_msgCache` volat `this.store.markFailed(optId)` (a při kliknutí „vrátit text" `this.store.remove(optId)`). `_upgradeOptimistic`: smazat část, která mění `cached` záznam v `_msgCache` (store to udělal). `msgCount`: ponechat jen jako `this.store.length` v DIAG (`this.msgCount++` smazat). Grep `_msgCache|_hydrat|_dedup|msgCount|maxMessages|initialRender` musí po kroku vrátit jen DIAG/DEFAULTS řádky, které upravíš níže.

Jednorázový úklid storage v `_init` (po `_loadConfig`):
```js
    // v3.39: lokální cache zpráv nahradil server. Staré klíče uklidit jednou.
    try {
      const all = await chrome.storage.local.get(null);
      const stale = Object.keys(all).filter((k) => k.startsWith('uc_messages'));
      if (stale.length) await chrome.storage.local.remove(stale);
    } catch {}
```
`DEFAULTS`: smazat `maxMessages`, `initialRender`. DIAG dump: `msgCacheSize/Newest/Oldest`, `dedup*`, `msgCacheIds` → `storeLength: this.store.length, window: this._win, oldestCursor: this.store.oldestCursor, historyFetches: this._historyFetches || 0` + `last30: this.store.slice(-30).map(...)` v dosavadním tvaru.

`_msgHistory` (ArrowUp) naplnění z cache v bývalém `_loadCachedMessages` → po `_loadHistory()` v `_init`:
```js
    const me = (this.config.username || '').toLowerCase();
    if (me) for (const m of this.store.slice(0, this.store.length)) if ((m.username || '').toLowerCase() === me && m.message) this._msgHistory.push(m.message);
    if (this._msgHistory.length > 50) this._msgHistory = this._msgHistory.slice(-50);
```

- [ ] **Step 5: Ověření na živém streamu**

`node --check extension/sidepanel.js && node --check extension/background.js && node scripts/test-chat-store.js && node scripts/test-provider-timestamps.js`. Reload panelu: (a) po otevření je vidět posledních 100 zpráv ze všech tří platforem seřazených podle času, (b) live zprávy se řadí za ně bez duplicit (dump: `[History] got=100 added=100`, žádné `dup` chyby), (c) scroll nahoru dotahuje po 100, spinner, žádný skok scrollu, (d) po >300 zprávách je `document.querySelectorAll('.msg').length ≤ 300` (F12), (e) zavřít panel, počkat 2 minuty, otevřít → chybějící zprávy jsou tam (tohle je ten původní bug), (f) odeslat zprávu → echo nahradí optimistickou, čas se srovná.

- [ ] **Step 6: Bump `3.39.0`, commit**

```bash
git add extension/sidepanel.js extension/background.js extension/manifest.json
git commit -m "feat(extension): historie ze serveru, ChatStore + okno 300, konec lokální cache a scrape (v3.39.0)"
```

---

### Task 14: Systémové řádky jako toast

**Files:**
- Modify: `extension/sidepanel.js` (`_sys`), `extension/sidepanel.html` (`<div id="sys-toast"></div>` nad `#input-area`), `extension/sidepanel.css`

- [ ] **Step 1: Implementace**

`_sys(text, { inline = false } = {})`: pokud `inline` (používá se jen pro „Připojování: …" a chyby odeslání), vloží do store zprávu `{ platform: 'system', id: 'sys-' + Date.now() + Math.random(), timestamp: Date.now(), message: text }` a `_addMessage` ji vykreslí jako dnešní `.msg.system`; jinak zobrazí toast:
```js
  _sys(text, { inline = false } = {}) {
    if (inline) { this._addMessage({ platform: 'system', id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, timestamp: Date.now(), message: text, isSystem: true }); return; }
    const box = document.getElementById('sys-toast');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'sys-toast-item';
    el.textContent = text;
    box.appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3000);
  }
```
Volání `_sys(\`Připojování: …\`)` a `_sys(\`Chyba: …\`)` / `Nelze odeslat` přepnout na `{ inline: true }`. V `_buildMessageEl` větev `if (msg.isSystem)` = dnešní render systémového řádku. `_applyFilters` systémové zprávy nefiltruje (`data-platform="system"` → přeskočit).

CSS:
```css
#sys-toast { position: absolute; left: 0; right: 0; bottom: 100%; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 4px 8px; pointer-events: none; z-index: 30; }
.sys-toast-item { background: rgba(20,20,24,.92); color: var(--text-muted); font-size: 11px; font-style: italic; padding: 3px 10px; border-radius: 10px; border: 1px solid var(--border); opacity: 1; transition: opacity .35s; }
.sys-toast-item.out { opacity: 0; }
```
`#input-area` musí mít `position: relative` (ověřit, případně přidat).

- [ ] **Step 2: Ověřit + bump `3.39.1` + commit**

Reload: „YOUTUBE: Streamer není live" se ukáže jako toast nad inputem a zmizí; „Připojování…" zůstává v proudu.
```bash
git add extension/sidepanel.js extension/sidepanel.html extension/sidepanel.css extension/manifest.json
git commit -m "feat(extension): systémové hlášky jako toast, v proudu jen připojování a chyby odeslání (v3.39.1)"
```

---

### Task 15: Dokumentace, privacy policy, memory

**Files:**
- Modify: `CLAUDE.md` (Architektura sidepanel.js: sekce Message cache / Globální dedup / Twitch chat scrape → ChatStore + okno + historie ze serveru; milestones v3.38.78–v3.39.1; Backend v0.3.0), `CLAUDE-HISTORY.md` (changelog + výsledek auditu), `store/listing/privacy-disclosure.md` a popis položky (archiv už není „připravuje se")
- Modify (repo `jouki/jouki.cz`): `unitychat/privacy/index.html` sekce 1c a 5 (CS i EN) podle spec §7, datum platnosti
- Memory: `checkpoint_v3_23_1.md` + `MEMORY.md` (stav), `bug_scrape_boundary_overlap.md` (definitivně uzavřeno v3.39.0), `todo_session_handoff.md`

- [ ] **Step 1: CLAUDE.md** — nahradit odstavce „Message cache", „Globální dedup" textem:
```
**Historie a data zpráv (v3.39+):**
- `ChatStore` (`extension/chat-store.js`) — jediný držitel zpráv, řazení `timestamp ASC, id`; dedup jen `platform:id`
- Boot: `GET /chat/history?channel&limit=100` → `store.prependOlder` → okno posledních ≤300 v DOM
- Scroll nahoru: nejdřív ze store, pak `before=<cursor>` po 100; spodek DOM se unloaduje nad 300 uzlů
- Timestamp = čas platformy (`tmi-sent-ts`, `created_at`, `timestampUsec`); optimistická zpráva má `Date.now()` do echa
- Žádná lokální cache, žádný DOM scrape, žádný import z Twitch tabu — historii dává server (backend `ingest/`)
```
- [ ] **Step 2: Privacy policy** — v klonu `jouki.cz` upravit 1c/5, commit `docs(privacy): archiv chatu robdiesalot 7 dní`, push (deploy landing je automatický).
- [ ] **Step 3: Store texty** — `store/listing/privacy-disclosure.md` + `listing-cs.md`/`listing-en.md`: přeformulovat „připravuje se archiv" na popis 7denní historie (do dashboardu se propíše při další verzi — to je userův krok, jen připravit texty).
- [ ] **Step 4: Memory + commit docs**

```bash
git add CLAUDE.md CLAUDE-HISTORY.md store/listing
git commit -m "docs: server chat log v0.3.0 + klient v3.39 (ChatStore, okno, historie ze serveru)"
```

---

## Self-review (provedeno při psaní)

- **Spec coverage:** §3.1 ingest (T2–T7), retence (T3, T7), env (T1), systémové události — **vědomě odloženo**: USERNOTICE se do logu neukládá (T4 komentář), klient je renderuje jen živě; §3.2 API (T8) vč. streamers mapování, kurzoru, no-store, rate limitu; `/health.ingest` (T7); §3.3 ChatStore (T12) + časy z platformy (T11); §3.4 renderer okno, scroll oběma směry, „N nových", spinner (T13); §3.5 mazání (T13 Step 4) vč. storage úklidu a `_msgHistory`; §3.6 hotovo dřív (v3.38.63); §4 boot flow (T13 Step 2); §5 chybové stavy: timeout 5 s + system řádek + cooldown 3 s (T13), reconnect backoff (T4–T6), YT konec/začátek streamu (T6 `liveCheckMs` + apiFails→connect), Kick subscription_error (T5); §6 audit (T10) s kritérii; §7 privacy (T15); §9 verze (Global Constraints).
- **Placeholder scan:** žádné TBD; každý krok má kód nebo přesný příkaz.
- **Type consistency:** `IngestMessage` (T2) používají T4–T7; `toRow` (T2) v T7; `insertMessages/deleteOlderThan` (T3) v T7; `Logger`/`noopLog` (T4) v T5–T7; `encodeCursor/decodeCursor` (T8); `ChatStore` API (T12) používá T13 (`add/prependOlder/upgrade/markFailed/remove/get/indexOf/slice/at/length/oldestCursor`); `_buildMessageEl`, `_placeInDom`, `_renderWindow`, `_extendUp/_extendDown`, `_unloadTop/_unloadBottom` (T13) používá T14 (`isSystem` větev v `_buildMessageEl`).

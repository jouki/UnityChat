// Filtr odkazů a permit (moderace část 3, spec docs/superpowers/specs/2026-09-25-moderace-odkazy-gify-design.md,
// kontrakt docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md §Část 3). Náhrada link filtru StreamElements.
//
// Tok (ingest onLive, jen ŽIVÉ zprávy, ne historie):
//   zpráva v kanálu namapovaném na workspace → nastavení workspace ze Židolišty (enabled, allowDomains, extraBots)
//   → odkaz mimo povolené domény a autor bez výjimky (broadcaster, mod, VIP, známý bot, aktivní permit)
//   → zpráva se označí jako smazaná JEŠTĚ PŘED zápisem do DB a rozesláním (/chat/stream ji dostane bez obsahu),
//     pak publishDeleted (SSE message-deleted + chat.deleted) a smazání na platformě botem workspace.
//   `!permit <login> [doba]` od moda/streamera (z libovolného klienta) → permit v paměti + link_permits.
//
// Rozhodnutí je SYNCHRONNÍ (nastavení i permity z paměti), aby se smazaná zpráva nikdy nedostala
// do /chat/stream ani do archivu s obsahem viditelným klientům. Nic tady nesmí vyhodit do ingestu.
// Výchozí stav bez odpovědi Židolišty = vypnuto (fail-open: nic se nemaže). NIKDY nelogovat tokeny.
import { gt } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { linkPermits } from '../db/schema.js';
import type { IngestMessage } from '../ingest/types.js';
import { rolesFromBadges, type Roles } from '../sse/integrationStream.js';
import { hostAllowed, linkHosts, normalizeDomain } from './links.js';
import { zidolistaBase, type Platform, type WorkspaceInfo } from './zidolista.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

// ---------------------------------------------------------------------------
// Nastavení workspace (GET <ZIDOLISTA_API_BASE>/integrations/:slug/link-filter, ETag/304)
// ---------------------------------------------------------------------------

export interface LinkFilterSettings {
  enabled: boolean;
  allowDomains: string[];
  extraBots: string[];
  /** ISO updated_at v Židolištce (jen informativní). */
  version: string | null;
}

export const LINK_FILTER_OFF: LinkFilterSettings = Object.freeze({ enabled: false, allowDomains: [], extraBots: [], version: null }) as LinkFilterSettings;

const BOT_LOGIN_RE = /^[a-z0-9_.-]{1,60}$/;

/** Odpověď Židolišty → nastavení (čistá funkce). Cokoli jiného než `enabled: true` = vypnuto. */
export function normalizeLinkFilter(raw: unknown): LinkFilterSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const allow = Array.isArray(r.allowDomains) ? r.allowDomains.map((d) => normalizeDomain(String(d ?? ''))).filter(Boolean) : [];
  const bots = Array.isArray(r.extraBots) ? r.extraBots.map((b) => String(b ?? '').trim().toLowerCase().replace(/^@/, '')).filter((b) => BOT_LOGIN_RE.test(b)) : [];
  return {
    enabled: r.enabled === true,
    allowDomains: [...new Set(allow)].slice(0, 500),
    extraBots: [...new Set(bots)].slice(0, 100),
    version: typeof r.version === 'string' ? r.version.slice(0, 64) : null,
  };
}

const SETTINGS_TTL_MS = 60_000;
interface SettingsEntry { at: number; etag: string | null; value: LinkFilterSettings; inflight: Promise<LinkFilterSettings> | null }
const settingsCache = new Map<string, SettingsEntry>();

export interface FetchSettingsDeps { fetch?: typeof fetch; log?: Log; apiKey?: string; base?: string }

/**
 * Načte nastavení workspace (If-None-Match → 304 = beze změny). Při chybě zůstává poslední známý stav;
 * když Židolišta nikdy neodpověděla (nebo chybí klíč), platí LINK_FILTER_OFF.
 */
export async function refreshLinkFilter(slug: string, opts: { force?: boolean } & FetchSettingsDeps = {}): Promise<LinkFilterSettings> {
  const s = slug.toLowerCase();
  const hit = settingsCache.get(s);
  if (!opts.force && hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.value;
  if (hit?.inflight) return hit.inflight;
  const apiKey = opts.apiKey ?? config.ZIDOLISTA_API_KEY;
  const entry: SettingsEntry = hit ?? { at: 0, etag: null, value: LINK_FILTER_OFF, inflight: null };
  settingsCache.set(s, entry);
  if (!apiKey) { entry.at = Date.now(); return entry.value; }
  const f = opts.fetch ?? fetch;
  entry.inflight = (async () => {
    try {
      const headers: Record<string, string> = { 'X-Api-Key': apiKey, Accept: 'application/json' };
      if (entry.etag && !opts.force) headers['If-None-Match'] = entry.etag;
      const r = await f(`${(opts.base ?? zidolistaBase()).replace(/\/$/, '')}/integrations/${encodeURIComponent(s)}/link-filter`, { headers, signal: AbortSignal.timeout(8000) });
      if (r.status === 304) { entry.at = Date.now(); return entry.value; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { ok?: boolean };
      if (!j || j.ok === false) throw new Error('not ok');
      const next = normalizeLinkFilter(j);
      if (next.enabled !== entry.value.enabled || next.version !== entry.value.version) {
        opts.log?.info({ workspace: s, enabled: next.enabled, allow: next.allowDomains.length, extraBots: next.extraBots.length, version: next.version }, 'link filter: nastavení');
      }
      entry.value = next;
      entry.etag = r.headers.get('etag');
      entry.at = Date.now();
      return next;
    } catch (e) {
      opts.log?.warn({ workspace: s, err: (e as Error).message }, 'link filter: načtení nastavení selhalo (platí poslední známé / vypnuto)');
      entry.at = Date.now(); // další pokus až po TTL, ne při každé zprávě
      return entry.value;
    } finally {
      entry.inflight = null;
    }
  })();
  return entry.inflight;
}

/** Synchronně z cache (ingest onLive); prošlou cache obnoví na pozadí. Nic v cache = vypnuto. */
export function linkFilterSync(slug: string, log?: Log): LinkFilterSettings {
  const s = slug.toLowerCase();
  const hit = settingsCache.get(s);
  if (!hit || (!hit.inflight && Date.now() - hit.at >= SETTINGS_TTL_MS)) void refreshLinkFilter(s, { log }).catch(() => {});
  return hit?.value ?? LINK_FILTER_OFF;
}

/** Webhook `reason: "link-filter"` → zahodit ETag a načíst znovu. */
export async function invalidateLinkFilter(slug: string, log?: Log): Promise<LinkFilterSettings> {
  const hit = settingsCache.get(slug.toLowerCase());
  if (hit) { hit.at = 0; hit.etag = null; }
  return refreshLinkFilter(slug, { force: true, log });
}

/** Jen pro testy. */
export function _resetLinkFilterCache(): void { settingsCache.clear(); }
/** Jen pro testy: cache prošlá, ETag zůstává (další načtení pošle If-None-Match). */
export function _expireLinkFilterForTest(slug: string): void { const h = settingsCache.get(slug); if (h) h.at = 0; }

// ---------------------------------------------------------------------------
// Výjimky
// ---------------------------------------------------------------------------

/** Boti, kteří smí odkazy vždy (vedle botů workspace z bot_identities a extraBots ze Židolišty). */
export const KNOWN_BOTS = ['streamelements', 'nightbot', 'streamlabs'] as const;

export interface BotCheck {
  platform: Platform;
  login: string;
  userId: string | null;
  ws: WorkspaceInfo;
  extraBots: string[];
  /** isBotAuthor z lib/botIdentities.ts (identity botů workspace / sdíleného JoukiBOTa). */
  isBotAuthor: (platform: string, login: string, workspace: string, platformUserId?: string | null) => boolean;
}

export function isKnownBot(p: BotCheck): boolean {
  const l = p.login.toLowerCase();
  if ((KNOWN_BOTS as readonly string[]).includes(l) || p.extraBots.includes(l)) return true;
  if (p.ws.bot.ownLogins?.[p.platform] === l) return true;
  return p.isBotAuthor(p.platform, l, p.ws.slug, p.userId);
}

export interface FilterInput {
  roles: Roles;
  /** Hosty odkazů ve zprávě (linkHosts). */
  hosts: string[];
  allow: string[];
  /** Má autor aktivní permit? */
  permit: boolean;
  /** Je autor známý bot? */
  bot: boolean;
}

/**
 * Čisté rozhodnutí filtru: vrací první nepovolený host (= zprávu smazat), jinak null.
 * Výjimky: broadcaster, mod, VIP, známý bot, aktivní permit. Povolené domény i jejich subdomény projdou všem.
 */
export function shouldFilter(p: FilterInput): string | null {
  if (p.roles.isBroadcaster || p.roles.isMod || p.roles.isVip || p.bot || p.permit) return null;
  return p.hosts.find((h) => !hostAllowed(h, p.allow)) ?? null;
}

// ---------------------------------------------------------------------------
// !permit z chatu
// ---------------------------------------------------------------------------

export const PERMIT_DEFAULT_SEC = 60;
export const PERMIT_MIN_SEC = 30;
export const PERMIT_MAX_SEC = 600;

/**
 * `!permit <login> [doba]` → { login, durationSec }. Doba: `90`, `90s`, `2m`, `2min` (sekundy/minuty),
 * oříznutá do 30–600 s; chybí/nečitelná = 60 s (jako SE). Login bez `@`, lowercase.
 */
export function parsePermitCommand(text: string): { login: string; durationSec: number } | null {
  const m = /^\s*!permit\s+@?([\p{L}\p{N}_.-]{1,60})(?:\s+(\S+))?/iu.exec(String(text || ''));
  if (!m) return null;
  let dur = PERMIT_DEFAULT_SEC;
  const d = m[2] ? /^(\d{1,5})(s|sec|secs|m|min|mins)?$/i.exec(m[2]) : null;
  if (d) {
    const n = Number(d[1]) * (d[2] && d[2].toLowerCase().startsWith('m') ? 60 : 1);
    dur = Math.min(PERMIT_MAX_SEC, Math.max(PERMIT_MIN_SEC, n));
  }
  return { login: m[1].toLowerCase(), durationSec: dur };
}

// ---------------------------------------------------------------------------
// Permity v paměti (zdroj pro synchronní rozhodnutí) + link_permits pro restart
// ---------------------------------------------------------------------------

export interface PermitGrant { channel: string; platform: Platform | string; userId?: string | null; login?: string | null; until: number }

export class PermitStore {
  private m = new Map<string, number>();
  private static keys(p: { channel: string; platform: string; userId?: string | null; login?: string | null }): string[] {
    const base = `${p.channel.toLowerCase()}|${p.platform}|`;
    const out: string[] = [];
    if (p.userId) out.push(`${base}id:${p.userId}`);
    if (p.login) out.push(`${base}login:${p.login.toLowerCase()}`);
    return out;
  }
  /** Udělit permit; delší platnost vyhrává (echo `!permit` botem nezkrátí permit z nabídky). */
  grant(p: PermitGrant): void {
    for (const k of PermitStore.keys(p)) this.m.set(k, Math.max(this.m.get(k) ?? 0, p.until));
    if (this.m.size > 5000) this.prune(Date.now());
  }
  active(p: { channel: string; platform: string; userId?: string | null; login?: string | null }, now: number): boolean {
    return PermitStore.keys(p).some((k) => (this.m.get(k) ?? 0) > now);
  }
  prune(now: number): void { for (const [k, until] of this.m) if (until <= now) this.m.delete(k); }
  get size(): number { return this.m.size; }
  clear(): void { this.m.clear(); }
}

export const permits = new PermitStore();

/** Po startu serveru: platné permity z link_permits do paměti. */
export async function loadActivePermits(store: PermitStore = permits): Promise<number> {
  const rows = await db.select().from(linkPermits).where(gt(linkPermits.until, new Date()));
  for (const r of rows) store.grant({ channel: r.channel, platform: r.platform, userId: r.targetUserId || null, login: r.targetLogin || null, until: r.until.getTime() });
  return rows.length;
}

export type PermitRow = { channel: string; platform: Platform; targetUserId: string; targetLogin: string; until: Date; by: string };

/** Zápis permitů: nejdřív paměť (filtr platí hned, i když DB selže), pak link_permits. */
export async function storePermits(rows: PermitRow[], store: PermitStore = permits, insert: (rows: PermitRow[]) => Promise<void> = async (r) => { if (r.length) await db.insert(linkPermits).values(r); }): Promise<void> {
  for (const r of rows) store.grant({ channel: r.channel, platform: r.platform, userId: r.targetUserId || null, login: r.targetLogin || null, until: r.until.getTime() });
  await insert(rows);
}

// ---------------------------------------------------------------------------
// Napojení na ingest
// ---------------------------------------------------------------------------

export interface PermitTarget { platform: Platform; userId: string; login: string }

export interface LinkFilterDeps {
  /** Workspace kanálu synchronně z cache registru (workspaceForChannelSync). */
  workspaceFor: (platform: Platform, channel: string) => WorkspaceInfo | null;
  settingsFor: (slug: string) => LinkFilterSettings;
  isBotAuthor: BotCheck['isBotAuthor'];
  permits: PermitStore;
  /** publishDeleted (SSE message-deleted + chat.deleted). */
  publishDeleted: (p: { channel: string; platform: Platform; messageId: string; by: string; reason: 'link_filter' }) => Promise<void>;
  /** deletePlatformMessage s accountId null = bot workspace. */
  deletePlatform: (p: { accountId: null; channel: string; platform: Platform; messageId: string }) => Promise<string>;
  /** Cíl `!permit <login>`: všechny známé identity (resolveUserTargets), [] = v archivu kanálu není. */
  resolvePermitTarget: (ucChannel: string, platform: Platform, platformChannel: string, login: string) => Promise<PermitTarget[]>;
  storePermits: (rows: PermitRow[]) => Promise<void>;
  /** moderation_actions (audit); chyba se jen zaloguje. */
  recordAction?: (v: { channel: string; accountId: null; actor: string; action: string; platform: Platform; targetLogin: string | null; targetMessageId?: string | null; params: object; result: object }) => Promise<void>;
  now: () => number;
  log: Log;
}

export interface LinkVerdict { host: string; channel: string }

/**
 * Filtr pro ingest onLive. `check(m)` je synchronní: rozhodne, případně nastaví `m.deleted`
 * (toRow → deleted_* v archivu, toClientMessage → bez obsahu) a akce na platformě spustí na pozadí.
 * Vrací verdikt (smazat) nebo null. Nikdy nevyhodí.
 */
export function createLinkFilter(deps: LinkFilterDeps) {
  const handlePermit = async (m: IngestMessage, cmd: { login: string; durationSec: number }, ucChannel: string) => {
    const by = `${m.platform}:${m.username.toLowerCase()}`;
    const until = new Date(deps.now() + cmd.durationSec * 1000);
    let targets: PermitTarget[] = [];
    try { targets = await deps.resolvePermitTarget(ucChannel, m.platform, m.channel, cmd.login); }
    catch (e) { deps.log.warn({ err: (e as Error).message }, 'link filter: cíl !permit se nepodařilo dohledat'); }
    // Neznámý uživatel (ještě nepsal) → permit podle loginu na platformě příkazu.
    const rows: PermitRow[] = targets.length
      ? targets.map((t) => ({ channel: ucChannel, platform: t.platform, targetUserId: t.userId, targetLogin: t.login, until, by }))
      : [{ channel: ucChannel, platform: m.platform, targetUserId: '', targetLogin: cmd.login, until, by }];
    let permitResult = 'ok';
    try { await deps.storePermits(rows); }
    catch (e) { permitResult = 'error:db'; deps.log.warn({ err: (e as Error).message }, 'link filter: zápis permitu selhal (v paměti platí)'); }
    deps.log.info({ channel: ucChannel, platform: m.platform, by, target: cmd.login, durationSec: cmd.durationSec, identities: rows.length }, 'link filter: !permit z chatu');
    try {
      await deps.recordAction?.({ channel: ucChannel, accountId: null, actor: by, action: 'permit', platform: m.platform, targetLogin: cmd.login, params: { source: 'chat', durationSec: cmd.durationSec, targets: rows.map((r) => ({ platform: r.platform, userId: r.targetUserId, login: r.targetLogin })) }, result: { permit: permitResult } });
    } catch (e) { deps.log.warn({ err: (e as Error).message }, 'link filter: zápis do moderation_actions selhal'); }
  };

  const act = async (m: IngestMessage, ucChannel: string, host: string) => {
    try { await deps.publishDeleted({ channel: ucChannel, platform: m.platform, messageId: m.platformMessageId, by: 'filter', reason: 'link_filter' }); }
    catch (e) { deps.log.warn({ platform: m.platform, err: (e as Error).message }, 'link filter: publishDeleted selhalo'); }
    let result = 'error:exception';
    try { result = await deps.deletePlatform({ accountId: null, channel: ucChannel, platform: m.platform, messageId: m.platformMessageId }); }
    catch (e) { deps.log.warn({ platform: m.platform, err: (e as Error).message }, 'link filter: smazání na platformě vyhodilo výjimku'); }
    deps.log.info({ channel: ucChannel, platform: m.platform, host, result }, 'link filter: zpráva smazána');
    try {
      await deps.recordAction?.({ channel: ucChannel, accountId: null, actor: 'filter', action: 'delete', platform: m.platform, targetLogin: m.username.toLowerCase(), targetMessageId: m.platformMessageId, params: { reason: 'link_filter', host }, result: { [m.platform]: result } });
    } catch (e) { deps.log.warn({ err: (e as Error).message }, 'link filter: zápis do moderation_actions selhal'); }
  };

  return {
    check(m: IngestMessage): LinkVerdict | null {
      try {
        const ws = deps.workspaceFor(m.platform, m.channel);
        // UC kanál = Twitch login streamera (moderace hledá workspace podle Twitche); bez něj nic.
        const ucChannel = ws?.channels.twitch;
        if (!ws || !ucChannel) return null;
        const raw = (m.contentRaw || {}) as Record<string, unknown>;
        const roles = rolesFromBadges(m.platform, raw.badges, m.username, m.channel);
        const settings = deps.settingsFor(ws.slug);
        const bot = isKnownBot({ platform: m.platform, login: m.username, userId: m.platformUserId || null, ws, extraBots: settings.extraBots, isBotAuthor: deps.isBotAuthor });

        const cmd = parsePermitCommand(m.content);
        if (cmd) {
          // Echo `!permit` od našeho bota (POST /moderation/permit) už permit uložil — nepřepisovat.
          if ((roles.isMod || roles.isBroadcaster) && !bot) void handlePermit(m, cmd, ucChannel).catch(() => {});
          return null;
        }

        if (!settings.enabled) return null;
        const hosts = linkHosts(m.content);
        if (!hosts.length) return null;
        const permit = deps.permits.active({ channel: ucChannel, platform: m.platform, userId: m.platformUserId, login: m.username }, deps.now());
        const host = shouldFilter({ roles, hosts, allow: settings.allowDomains, permit, bot });
        if (!host) return null;
        m.deleted = { by: 'filter', reason: 'link_filter' };
        void act(m, ucChannel, host).catch(() => {});
        return { host, channel: ucChannel };
      } catch (e) {
        deps.log.warn({ err: (e as Error).message }, 'link filter: kontrola selhala (zpráva prošla)');
        return null;
      }
    },
  };
}

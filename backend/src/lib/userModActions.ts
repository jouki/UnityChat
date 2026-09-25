// Jádro akcí z kontextové nabídky moda (spec 2026-09-25 moderace, část 2) bez HTTP a auth:
// timeout / ban / unban (UC route i integrace Židolišty), varování, permit, přejmenování.
// Ověření moda / workspace dělá VOLAJÍCÍ (route) PŘED voláním — tady se nic nekontroluje.
// Pořadí: cíl v archivu kanálu → hierarchie rolí → platformy → SSE jen pro platformy, kde akce
// prošla → evidence. Chyba platformy nikdy nevyhodí (500), jen se promítne do výsledku.
import type { NewModerationAction } from '../db/schema.js';
import type { Platform } from './zidolista.js';
import type { ChatRole } from './chatRole.js';
import type { ResolvedTargets, UserTarget } from './moderationTargets.js';
import type { UserModAction, UserModeratedParams, BanRow, EchoKey } from './userModeration.js';
import { kickMinutes, type BanOutcome, type BanParams, type ModResult } from './modActions.js';
import type { WarningView } from './accountWarnings.js';

type Log = { warn: (o: object, m: string) => void; info: (o: object, m: string) => void };
export type Out = { status: number; body: Record<string, unknown> };

/** Povolené délky permitu (s). */
export const PERMIT_DURATIONS = [30, 60, 120, 300, 600] as const;
/** Vlastní délka permitu z nabídky moda / Chat Logu: 1 s až 24 h. */
export const MAX_PERMIT_SEC = 86_400;
/** Login do `!permit <login>` — nic, co by v chatu přidalo další argumenty / příkaz. */
export const PERMIT_LOGIN_RE = /^[\w.-]{1,60}$/;

const notFound: Out = { status: 404, body: { ok: false, error: 'not_found' } };
const self: Out = { status: 400, body: { ok: false, error: 'self' } };
const protectedTarget: Out = { status: 403, body: { ok: false, error: 'target_protected' } };

/** Úspěch akce na platformě (účtem moda nebo botem). */
export const succeeded = (r: ModResult | undefined): boolean => r === 'ok' || r === 'bot';

/** Skutečná délka timeoutu na platformě (Kick = celé minuty). */
export function effectiveDuration(platform: Platform, durationSec: number): number {
  return platform === 'kick' ? kickMinutes(durationSec) * 60 : durationSec;
}

const targetsParam = (all: UserTarget[]) => all.map((t) => ({ platform: t.platform, userId: t.userId, login: t.login }));

/** Role cíle v kanálu (chatRole přes platformní kanál jeho platformy). */
export type TargetRole = (channel: string, t: UserTarget) => Promise<ChatRole>;

/**
 * Hierarchie: broadcastera nemoderuje nikdo; moda jen broadcaster. Kontrolují se všechny známé
 * identity cíle (mod na Kicku je chráněný, i když se na něj klikne z Twitche). null = smí.
 */
export async function checkHierarchy(channel: string, targets: UserTarget[], callerIsBroadcaster: boolean, targetRole: TargetRole): Promise<Out | null> {
  for (const t of targets) {
    const role = await targetRole(channel, t);
    if (role === 'broadcaster') return protectedTarget;
    if (role === 'moderator' && !callerIsBroadcaster) return protectedTarget;
  }
  return null;
}

// ---- timeout / ban / unban ----
export interface UserActionInput {
  channel: string;
  /** UC účet moda; null = integrace (jen bot workspace). */
  accountId: number | null;
  by: string;
  /** Volající je broadcaster kanálu (smí i na mody). */
  callerIsBroadcaster: boolean;
  platform: Platform;
  userId: string;
  action: UserModAction;
  /** Jen timeout (validováno volajícím). */
  durationSec: number | null;
  reason: string | null;
}

export interface UserActionDeps {
  resolveTargets: (channel: string, platform: Platform, userId: string) => Promise<ResolvedTargets | null>;
  targetRole: TargetRole;
  publish: (p: UserModeratedParams) => Promise<unknown>;
  /** Ohlásit očekávané echo (CLEARCHAT) PŘED voláním platformy / zrušit ho po selhání (userModeration.ts). */
  expectEcho: (k: EchoKey) => void;
  forgetEcho: (k: EchoKey) => void;
  ban: (p: BanParams) => Promise<BanOutcome>;
  unban: (p: { accountId: number | null; channel: string; platform: Platform; userId: string; youtubeBanId: string | null }) => Promise<ModResult>;
  activeBan: (channel: string, platform: Platform, userId: string) => Promise<{ until: Date | null; youtubeBanId: string | null } | null>;
  recordBan: (r: BanRow) => Promise<void>;
  clearBan: (channel: string, platform: Platform, userId: string) => Promise<void>;
  recordAction: (v: NewModerationAction) => Promise<void>;
  now: () => number;
  log: Log;
}

export async function runUserAction(input: UserActionInput, deps: UserActionDeps): Promise<Out> {
  const targets = await deps.resolveTargets(input.channel, input.platform, input.userId);
  if (!targets) return notFound;
  if (input.accountId !== null && targets.accountId === input.accountId) return self;
  const denied = await checkHierarchy(input.channel, targets.all, input.callerIsBroadcaster, deps.targetRole);
  if (denied) return denied;
  const { channel, action, by } = input;
  const timeout = action === 'timeout';
  const dur = (t: UserTarget) => (timeout && input.durationSec ? effectiveDuration(t.platform, input.durationSec) : null);

  // Unban na YouTube potřebuje id banu z evidence.
  const banIds = new Map<Platform, string | null>();
  if (action === 'unban') {
    for (const t of targets.all) {
      try { banIds.set(t.platform, (await deps.activeBan(channel, t.platform, t.userId))?.youtubeBanId ?? null); }
      catch { banIds.set(t.platform, null); }
    }
  }

  const results: Partial<Record<Platform, ModResult>> = {};
  const ytBan = new Map<Platform, string | null>();
  await Promise.all(targets.all.map(async (t) => {
    // Echo z ingestu může přijít dřív než výsledek platformy — klíč musí existovat před voláním.
    const echo: EchoKey = { channel, platform: t.platform, userId: t.userId, action, durationSec: dur(t) };
    deps.expectEcho(echo);
    try {
      if (action === 'unban') {
        results[t.platform] = await deps.unban({ accountId: input.accountId, channel, platform: t.platform, userId: t.userId, youtubeBanId: banIds.get(t.platform) ?? null });
      } else {
        const r = await deps.ban({ accountId: input.accountId, channel, platform: t.platform, userId: t.userId, durationSec: timeout ? input.durationSec : null, reason: input.reason });
        results[t.platform] = r.result;
        if (r.youtubeBanId) ytBan.set(t.platform, r.youtubeBanId);
      }
    } catch (e) {
      deps.log.warn({ platform: t.platform, err: (e as Error).message }, 'user moderation: akce na platformě vyhodila výjimku');
      results[t.platform] = 'error:exception';
    }
    if (!succeeded(results[t.platform])) deps.forgetEcho(echo);
  }));

  // SSE a evidence jen tam, kde akce na platformě opravdu prošla (klient by jinak ukázal štítek,
  // který neplatí, a nabídka by nabízela Unban u neexistujícího banu).
  const done = targets.all.filter((t) => succeeded(results[t.platform]));
  for (const t of done) {
    try { await deps.publish({ channel, platform: t.platform, userId: t.userId, login: t.login, action, durationSec: dur(t), by, source: 'uc' }); }
    catch (e) { deps.log.warn({ err: (e as Error).message }, 'user moderation: SSE selhalo'); }
  }

  const now = deps.now();
  for (const t of done) {
    try {
      if (action === 'unban') await deps.clearBan(channel, t.platform, t.userId);
      else {
        const d = dur(t);
        await deps.recordBan({ channel, platform: t.platform, userId: t.userId, login: t.login, until: d ? new Date(now + d * 1000) : null, youtubeBanId: ytBan.get(t.platform) ?? null });
      }
    } catch (e) {
      deps.log.warn({ platform: t.platform, err: (e as Error).message }, 'user moderation: evidence banu selhala');
    }
  }

  try {
    await deps.recordAction({
      channel, accountId: input.accountId, actor: by, action, platform: input.platform,
      targetLogin: targets.primary.login,
      params: { userId: input.userId, durationSec: input.durationSec, reason: input.reason, targets: targetsParam(targets.all) },
      result: results,
    });
  } catch (e) {
    deps.log.warn({ err: (e as Error).message }, 'user moderation: zápis do moderation_actions selhal');
  }

  const notes: Partial<Record<Platform, string>> = {};
  if (timeout && input.durationSec && targets.all.some((t) => t.platform === 'kick') && input.durationSec % 60 !== 0) {
    notes.kick = `rounded_to_minutes:${kickMinutes(input.durationSec)}`;
  }
  const primaryDur = dur(targets.primary);
  return {
    status: 200,
    body: {
      ok: true,
      action,
      until: primaryDur && succeeded(results[targets.primary.platform]) ? now + primaryDur * 1000 : null,
      results,
      targets: targets.all.map((t) => ({ platform: t.platform, login: t.login })),
      ...(Object.keys(notes).length ? { notes } : {}),
    },
  };
}

// ---- varování ----
export interface WarnInput { channel: string; accountId: number | null; by: string; callerIsBroadcaster: boolean; platform: Platform; userId: string; reason: string }

export interface WarnDeps {
  resolveTargets: UserActionDeps['resolveTargets'];
  targetRole: TargetRole;
  warnTwitch: (p: { accountId: number | null; channel: string; platform: Platform; userId: string; reason: string }) => Promise<ModResult>;
  createWarning: (p: { accountId: number; channel: string; reason: string; by: string | null }) => Promise<WarningView>;
  /** SSE `account-warning` JEN streamům dotčeného účtu (lib/accountWarnings.ts). */
  sendToAccount: (accountId: number, event: string, data: object) => number;
  recordAction: UserActionDeps['recordAction'];
  log: Log;
}

/**
 * Twitch nativně (Helix warnings, jen má-li cíl Twitch identitu); uživatel UnityChatu navíc dostane
 * varování napříč platformami (account_warnings + SSE jen jemu). Divák mimo UC na Kicku/YT nic.
 */
export async function runWarn(input: WarnInput, deps: WarnDeps): Promise<Out> {
  const targets = await deps.resolveTargets(input.channel, input.platform, input.userId);
  if (!targets) return notFound;
  if (input.accountId !== null && targets.accountId === input.accountId) return self;
  const denied = await checkHierarchy(input.channel, targets.all, input.callerIsBroadcaster, deps.targetRole);
  if (denied) return denied;
  const results: Record<string, ModResult | 'no_account'> = {};

  const tw = targets.all.find((t) => t.platform === 'twitch');
  if (tw) {
    try { results.twitch = await deps.warnTwitch({ accountId: input.accountId, channel: input.channel, platform: 'twitch', userId: tw.userId, reason: input.reason }); }
    catch (e) { deps.log.warn({ err: (e as Error).message }, 'warn: Twitch vyhodilo výjimku'); results.twitch = 'error:exception'; }
  }

  if (targets.accountId === null) results.unitychat = 'no_account';
  else {
    try {
      const w = await deps.createWarning({ accountId: targets.accountId, channel: input.channel, reason: input.reason, by: input.by });
      deps.sendToAccount(targets.accountId, 'account-warning', w);
      results.unitychat = 'ok';
    } catch (e) {
      deps.log.warn({ err: (e as Error).message }, 'warn: zápis varování selhal');
      results.unitychat = 'error:db';
    }
  }

  try {
    await deps.recordAction({
      channel: input.channel, accountId: input.accountId, actor: input.by, action: 'warn', platform: input.platform,
      targetLogin: targets.primary.login, params: { userId: input.userId, reason: input.reason, targets: targetsParam(targets.all) }, result: results,
    });
  } catch (e) { deps.log.warn({ err: (e as Error).message }, 'warn: zápis do moderation_actions selhal'); }

  return { status: 200, body: { ok: true, results } };
}

// ---- permit ----
export interface PermitInput {
  /** null = integrace (Chat Log Židolišty) — bez účtu moda, jen bot. */
  channel: string; accountId: number | null; by: string; platform: Platform; userId: string; durationSec: number;
  /** Platformy, kde je mod modem (accountModIdentities) — tam se `!permit` posílá jeho účtem. */
  modPlatforms: Platform[];
}

export interface PermitDeps {
  resolveTargets: UserActionDeps['resolveTargets'];
  insertPermits: (rows: Array<{ channel: string; platform: Platform; targetUserId: string; targetLogin: string; until: Date; by: string }>) => Promise<void>;
  /** Odeslání účtem moda (sendAsAccount); vyhodí při chybě. */
  sendAsMod: (platform: Platform, text: string) => Promise<void>;
  /** Odeslání botem workspace (sendAsBot); vyhodí při chybě (err.code). */
  sendAsBot: (platform: Platform, text: string) => Promise<void>;
  recordAction: UserActionDeps['recordAction'];
  now: () => number;
  log: Log;
}

/** `!permit <skutečný login>` do chatu platformy zprávy (účtem moda, jinak botem) + náš permit na všech známých platformách. */
export async function runPermit(input: PermitInput, deps: PermitDeps): Promise<Out> {
  const targets = await deps.resolveTargets(input.channel, input.platform, input.userId);
  if (!targets) return notFound;
  if (input.accountId != null && targets.accountId === input.accountId) return self;
  const p = targets.primary;
  // Login jde doslova do chatu — nic mimo běžné znaky loginu (mezera by přidala další argumenty).
  if (!PERMIT_LOGIN_RE.test(p.login)) return { status: 400, body: { ok: false, error: 'bad_login' } };
  const until = new Date(deps.now() + input.durationSec * 1000);
  const results: Record<string, ModResult> = {};

  try {
    await deps.insertPermits(targets.all.map((t) => ({ channel: input.channel, platform: t.platform, targetUserId: t.userId, targetLogin: t.login, until, by: input.by })));
    results.permit = 'ok';
  } catch (e) {
    deps.log.warn({ err: (e as Error).message }, 'permit: zápis selhal');
    results.permit = 'error:db';
  }

  const text = `!permit ${p.login}`;
  let chat: ModResult | null = null;
  if (input.modPlatforms.includes(p.platform)) {
    try { await deps.sendAsMod(p.platform, text); chat = 'ok'; }
    catch (e) { deps.log.warn({ platform: p.platform, err: (e as Error).message }, 'permit: odeslání účtem moda selhalo → bot'); }
  }
  if (!chat) {
    try { await deps.sendAsBot(p.platform, text); chat = 'bot'; }
    catch (e) {
      const code = (e as { code?: string }).code || String((e as { status?: number }).status || 'failed');
      deps.log.warn({ platform: p.platform, code }, 'permit: odeslání botem selhalo');
      chat = `error:${code}`;
    }
  }
  results.chat = chat;

  try {
    await deps.recordAction({
      channel: input.channel, accountId: input.accountId, actor: input.by, action: 'permit', platform: input.platform,
      targetLogin: p.login, params: { userId: input.userId, durationSec: input.durationSec, targets: targetsParam(targets.all) }, result: results,
    });
  } catch (e) { deps.log.warn({ err: (e as Error).message }, 'permit: zápis do moderation_actions selhal'); }

  return { status: 200, body: { ok: true, until: until.getTime(), results } };
}

// ---- přejmenování (přezdívka v UnityChatu, globální — nicknames nemají kanál) ----
export interface RenameInput { channel: string; accountId: number; by: string; callerIsBroadcaster: boolean; platform: Platform; login: string; nickname: string | null; color: string | null }

export interface RenameDeps {
  /** Uživatel podle loginu v archivu kanálu (archivedUserByLogin přes platformní kanál). */
  findUser: (channel: string, platform: Platform, login: string) => Promise<UserTarget | null>;
  targetRole: TargetRole;
  /** Obsahuje přezdívka slovo z blacklistu kanálu (Židolišta)? */
  blacklisted: (channel: string, nickname: string) => Promise<boolean>;
  upsert: (platform: Platform, username: string, nickname: string, color: string | null) => Promise<void>;
  remove: (platform: Platform, username: string) => Promise<void>;
  recordAction: UserActionDeps['recordAction'];
  log: Log;
}

/** Mod nastaví / smaže přezdívku divákovi. SSE nickname-change/-delete rozešle trigger v DB (nicknames_notify). */
export async function runRename(input: RenameInput, deps: RenameDeps): Promise<Out> {
  const u = await deps.findUser(input.channel, input.platform, input.login);
  if (!u) return notFound;
  const denied = await checkHierarchy(input.channel, [u], input.callerIsBroadcaster, deps.targetRole);
  if (denied) return denied;
  if (input.nickname !== null && await deps.blacklisted(input.channel, input.nickname)) {
    return { status: 400, body: { ok: false, error: 'nickname_blacklisted' } };
  }
  if (input.nickname === null) await deps.remove(input.platform, u.login);
  else await deps.upsert(input.platform, u.login, input.nickname, input.color);
  try {
    await deps.recordAction({
      channel: input.channel, accountId: input.accountId, actor: input.by, action: 'rename', platform: input.platform,
      targetLogin: u.login, params: { userId: u.userId, nickname: input.nickname, color: input.color }, result: { unitychat: 'ok' },
    });
  } catch (e) { deps.log.warn({ err: (e as Error).message }, 'rename: zápis do moderation_actions selhal'); }
  return { status: 200, body: { ok: true, login: u.login, nickname: input.nickname } };
}

// Trvalé propojení účtu UnityChatu s ověřeným e-mailem v Židolištce (kontrakt 2026-09-29, pokyn usera:
// „když potvrdil e-mail, mají se platby s tímto e-mailem a jemu přidruženými přezdívkami spojit s účtem“).
//   POST   <ZIDOLISTA_API_BASE>/integrations/accounts/email-link
//          { ucAccountId, email, identities: [{ platform, userId, login }] (max 20), verifiedAt }
//          → { ok, identities, replacedEmail }; idempotentní — nahradí e-mail i celý seznam identit účtu.
//   DELETE <ZIDOLISTA_API_BASE>/integrations/accounts/email-link/:ucAccountId → { ok, removed }
// Globální (ne per workspace), X-Api-Key + podpis v2 (zidolistaFetch). Židolišta pak v
// GET /integrations/:slug/donations (a v roli Donátoři u sfx-state / gif-access) vrací pro identitu účtu
// i platby z té adresy (matchedBy 'email' = jistá shoda) a platby pod přezdívkami dárce (matchedBy 'nickname').
// Posílá se JEN e-mail ověřený kódem (account_emails). E-mail se NIKDY neloguje.
// Kdy: po ověření e-mailu, po připojení / odpojení platformy a při startu serveru (dorovnání, sám se opraví).
import { eq, isNotNull } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { accountEmails } from '../db/schema.js';
import { accountIdentities } from './moderationTargets.js';
import { zidolistaFetch, zidolistaBase, type Platform } from './zidolista.js';

export const EMAIL_LINK_MAX_IDENTITIES = 20;

type Log = { info?: (o: object, m: string) => void; warn: (o: object, m: string) => void };
export interface LinkIdentity { platform: Platform; userId: string; login: string }
export interface EmailLinkBody { ucAccountId: string; email: string; identities: LinkIdentity[]; verifiedAt: string }

/** Tělo POST (čistá funkce): e-mail malými písmeny po trimu, identity bez duplicit (platform + userId), max 20. */
export function emailLinkBody(accountId: number, email: string, identities: LinkIdentity[], verifiedAt: Date): EmailLinkBody | null {
  const e = String(email ?? '').trim().toLowerCase();
  if (!e) return null;
  const seen = new Set<string>();
  const ids: LinkIdentity[] = [];
  for (const i of identities) {
    const userId = String(i.userId ?? '').trim();
    const key = `${i.platform}:${userId}`;
    if (!userId || seen.has(key)) continue;
    seen.add(key);
    ids.push({ platform: i.platform, userId, login: String(i.login ?? '').trim().toLowerCase() });
    if (ids.length >= EMAIL_LINK_MAX_IDENTITIES) break;
  }
  if (!ids.length) return null;
  return { ucAccountId: String(accountId), email: e, identities: ids, verifiedAt: verifiedAt.toISOString() };
}

export interface EmailLinkDeps {
  emailOf?: (accountId: number) => Promise<{ email: string; verifiedAt: Date } | null>;
  identitiesOf?: (accountId: number) => Promise<LinkIdentity[]>;
  fetch?: typeof fetch; apiKey?: string; base?: string; signingKey?: string;
  log?: Log;
}

async function dbEmailOf(accountId: number): Promise<{ email: string; verifiedAt: Date } | null> {
  const [r] = await db.select({ email: accountEmails.email, verifiedAt: accountEmails.verifiedAt }).from(accountEmails).where(eq(accountEmails.accountId, accountId)).limit(1);
  return r?.email && r.verifiedAt ? { email: r.email, verifiedAt: r.verifiedAt } : null;
}

export type EmailLinkResult = 'linked' | 'removed' | 'skipped' | 'failed';

/**
 * Poslat Židolištce aktuální stav účtu: ověřený e-mail + identity → POST; bez ověřeného e-mailu nebo bez identit
 * → DELETE (propojení zrušit). Nikdy nevyhazuje — volá se na pozadí (`void`), chyba jde jen do logu.
 */
export async function syncEmailLink(accountId: number, deps: EmailLinkDeps = {}): Promise<EmailLinkResult> {
  const log = deps.log;
  try {
    const apiKey = deps.apiKey ?? config.ZIDOLISTA_API_KEY;
    if (!apiKey) return 'skipped';
    const base = (deps.base ?? zidolistaBase()).replace(/\/$/, '');
    const opts = { fetch: deps.fetch, apiKey, signingKey: deps.signingKey };
    const row = await (deps.emailOf ?? dbEmailOf)(accountId);
    const ids = row ? await (deps.identitiesOf ?? accountIdentities)(accountId) : [];
    const body = row ? emailLinkBody(accountId, row.email, ids, row.verifiedAt) : null;
    if (!body) {
      const r = await zidolistaFetch(`${base}/integrations/accounts/email-link/${encodeURIComponent(String(accountId))}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) }, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      log?.info?.({ accountId }, 'email-link: propojení zrušeno');
      return 'removed';
    }
    const r = await zidolistaFetch(`${base}/integrations/accounts/email-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    log?.info?.({ accountId, identities: body.identities.length }, 'email-link: účet propojen s ověřeným e-mailem');
    return 'linked';
  } catch (e) {
    log?.warn({ accountId, err: (e as Error).message }, 'email-link: Židolišta nepřijala propojení (zkusí se při dalším startu / změně)');
    return 'failed';
  }
}

/** Dorovnání při startu: všechny účty s ověřeným e-mailem, jeden po druhém (limit Židolišty). */
export async function syncAllEmailLinks(deps: EmailLinkDeps = {}, accountIds?: number[]): Promise<Record<EmailLinkResult, number>> {
  const out: Record<EmailLinkResult, number> = { linked: 0, removed: 0, skipped: 0, failed: 0 };
  try {
    const ids = accountIds ?? (await db.select({ id: accountEmails.accountId }).from(accountEmails).where(isNotNull(accountEmails.verifiedAt))).map((r) => r.id);
    for (const id of ids) out[await syncEmailLink(id, deps)]++;
    deps.log?.info?.({ ...out }, 'email-link: dorovnání účtů s ověřeným e-mailem');
  } catch (e) {
    deps.log?.warn({ err: (e as Error).message }, 'email-link: dorovnání selhalo');
  }
  return out;
}

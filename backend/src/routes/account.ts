// Účet UnityChatu: e-mail zadaný uživatelem a ověřený kódem + předvyplnění QR dona
// (spec docs/superpowers/specs/2026-09-25-qr-dono-v-unitychatu-design.md, sekce Identita).
//
//   GET  /account/profile            { email, verified, changeAllowedAt, lastNickname, ucNickname, mailEnabled }
//   POST /account/email/start {email} pošle 6místný kód (cooldown 2/5/15 min, denní limity)
//   POST /account/email/verify {code} ověří kód → e-mail patří účtu (všem propojeným identitám)
//
// Kvóta e-mailových služeb je malá (Brevo 300/den + Resend 100/den), proto kód jen pro
// přihlášeného, cooldown, denní strop na účet / adresu / IP a celkový rozpočet.
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { and, eq, gt, lt, or, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { accountDonatePrefs, accountEmails, emailSendLog, emailVerifications, nicknames } from '../db/schema.js';
import { listIdentities, requireWebSession } from '../lib/webAuth.js';
import { CODE_TTL_MS, EMAIL_RE, emailChangeAllowedAt, LIMITS, MAX_ATTEMPTS, cleanCode, codeHash, ipHash, newCode, nextAllowedAt, normEmail } from '../lib/emailVerify.js';
import { providersConfigured, sendMail, verificationMail } from '../lib/mailer.js';
import { RateLimiter } from './chat.js';

const DAY_MS = 24 * 60 * 60_000;
// Retence (zásady ochrany soukromí, bod 1f): log odeslaných e-mailů 30 dní (limity počítají 24 h),
// nedokončená / propadlá ověření po 1 dni od vypršení kódu.
export const SEND_LOG_RETENTION_MS = 30 * DAY_MS;
export const PENDING_RETENTION_MS = DAY_MS;

export async function purgeEmailData(now = Date.now()): Promise<{ log: number; pending: number }> {
  const log = await db.delete(emailSendLog).where(lt(emailSendLog.sentAt, new Date(now - SEND_LOG_RETENTION_MS))).returning({ id: emailSendLog.id });
  const pending = await db.delete(emailVerifications).where(lt(emailVerifications.expiresAt, new Date(now - PENDING_RETENTION_MS))).returning({ id: emailVerifications.accountId });
  return { log: log.length, pending: pending.length };
}

/** Ověřený e-mail účtu, nebo null. */
export async function verifiedEmail(accountId: number): Promise<string | null> {
  return (await verifiedEmailRow(accountId))?.email ?? null;
}

async function verifiedEmailRow(accountId: number): Promise<{ email: string; verifiedAt: Date } | null> {
  const [r] = await db.select({ email: accountEmails.email, verifiedAt: accountEmails.verifiedAt }).from(accountEmails).where(eq(accountEmails.accountId, accountId)).limit(1);
  return r ?? null;
}

export async function rememberDonateNickname(accountId: number, nickname: string): Promise<void> {
  await db.insert(accountDonatePrefs).values({ accountId, lastNickname: nickname, updatedAt: new Date() })
    .onConflictDoUpdate({ target: accountDonatePrefs.accountId, set: { lastNickname: nickname, updatedAt: new Date() } });
}

/** Vlastní přezdívka z UnityChatu u kterékoli identity účtu (sdílená tabulka nicknames). */
async function ucNickname(accountId: number): Promise<string | null> {
  const ids = await listIdentities(accountId);
  if (!ids.length) return null;
  const rows = await db.select({ nickname: nicknames.nickname, platform: nicknames.platform, username: nicknames.username }).from(nicknames)
    .where(or(...ids.map((i) => and(eq(nicknames.platform, i.platform), eq(nicknames.username, i.login.toLowerCase())))));
  return rows.find((r) => r.nickname?.trim())?.nickname.trim() ?? null;
}

const count = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0);

export default async function accountRoutes(app: FastifyInstance) {
  const limiter = new RateLimiter(10, 1);
  // Úklid 1× za hodinu (a hned po startu); běžící timer nesmí držet proces při vypínání.
  const purge = () => purgeEmailData().then((r) => { if (r.log || r.pending) app.log.info(r, 'account: email data purged'); })
    .catch((e) => app.log.warn({ err: (e as Error).message }, 'account: email purge failed'));
  app.addHook('onReady', async () => { void purge(); });
  const purgeTimer = setInterval(purge, 60 * 60_000);
  purgeTimer.unref();
  app.addHook('onClose', async () => clearInterval(purgeTimer));

  app.get('/account/profile', { preHandler: requireWebSession }, async (req) => {
    const id = req.webAccountId!;
    const [row, [prefs], uc] = await Promise.all([
      verifiedEmailRow(id),
      db.select({ lastNickname: accountDonatePrefs.lastNickname }).from(accountDonatePrefs).where(eq(accountDonatePrefs.accountId, id)).limit(1),
      ucNickname(id),
    ]);
    const email = row?.email ?? null;
    const changeAt = emailChangeAllowedAt(row?.verifiedAt ?? null);
    return { ok: true, email, verified: !!email, changeAllowedAt: changeAt ? new Date(changeAt).toISOString() : null, lastNickname: prefs?.lastNickname ?? null, ucNickname: uc, mailEnabled: providersConfigured().length > 0 };
  });

  app.post<{ Body: { email?: unknown } }>('/account/email/start', { preHandler: requireWebSession }, async (req, reply) => {
    if (!limiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const accountId = req.webAccountId!;
    const email = normEmail(String(req.body?.email ?? ''));
    if (!EMAIL_RE.test(email) || email.length > 120) return reply.code(400).send({ ok: false, error: 'bad_email' });
    if (!providersConfigured().length) return reply.code(503).send({ ok: false, error: 'mail_disabled' });
    const current = await verifiedEmailRow(accountId);
    if (current?.email === email) return { ok: true, alreadyVerified: true, email };
    // Změna ověřeného e-mailu jen 1× za 24 h (jinak by šlo rozesílat kódy na libovolné adresy).
    const changeAt = emailChangeAllowedAt(current?.verifiedAt ?? null);
    if (changeAt) return reply.code(429).send({ ok: false, error: 'change_cooldown', retryAt: new Date(changeAt).toISOString() });

    const now = Date.now();
    const [pending] = await db.select().from(emailVerifications).where(eq(emailVerifications.accountId, accountId)).limit(1);
    const sameRequest = pending && pending.email === email;
    // „Poslat znovu“ pro stejnou adresu: cooldown 2 → 5 → 15 min. Nová adresa začíná znovu.
    const sends = sameRequest ? pending.sends : 0;
    const allowedAt = sameRequest ? nextAllowedAt(pending.sends, pending.lastSentAt.getTime()) : 0;
    if (allowedAt > now) return reply.code(429).send({ ok: false, error: 'cooldown', retryAt: new Date(allowedAt).toISOString() });

    const since = new Date(now - DAY_MS);
    const ih = ipHash(req.ip);
    const [perAccount, perEmail, perIp, total] = await Promise.all([
      db.select({ n: sql<number>`count(*)` }).from(emailSendLog).where(and(eq(emailSendLog.accountId, accountId), gt(emailSendLog.sentAt, since))),
      db.select({ n: sql<number>`count(*)` }).from(emailSendLog).where(and(eq(emailSendLog.email, email), gt(emailSendLog.sentAt, since))),
      db.select({ n: sql<number>`count(*)` }).from(emailSendLog).where(and(eq(emailSendLog.ipHash, ih), gt(emailSendLog.sentAt, since))),
      db.select({ n: sql<number>`count(*)` }).from(emailSendLog).where(gt(emailSendLog.sentAt, since)),
    ]);
    if (count(perAccount) >= LIMITS.perAccountDay || count(perEmail) >= LIMITS.perEmailDay || count(perIp) >= LIMITS.perIpDay) {
      return reply.code(429).send({ ok: false, error: 'daily_limit' });
    }
    if (count(total) >= config.MAIL_DAILY_BUDGET) {
      req.log.warn({ total: count(total) }, 'account: mail daily budget exhausted');
      return reply.code(503).send({ ok: false, error: 'mail_budget' });
    }

    const code = newCode();
    const sent = await sendMail(verificationMail(email, code), req.log);
    if (!sent.ok) {
      req.log.warn({ err: sent.error }, 'account: verification mail failed');
      return reply.code(503).send({ ok: false, error: 'send_failed' });
    }
    const row = { email, codeHash: codeHash(code, accountId, email), expiresAt: new Date(now + CODE_TTL_MS), attempts: 0, sends: sends + 1, lastSentAt: new Date(now) };
    await db.insert(emailVerifications).values({ accountId, ...row }).onConflictDoUpdate({ target: emailVerifications.accountId, set: row });
    await db.insert(emailSendLog).values({ accountId, email, ipHash: ih, provider: sent.provider! });
    req.log.info({ accountId, provider: sent.provider, sends: row.sends }, 'account: verification code sent');
    return { ok: true, email, expiresAt: row.expiresAt.toISOString(), nextAt: new Date(nextAllowedAt(row.sends, now)).toISOString() };
  });

  app.post<{ Body: { code?: unknown } }>('/account/email/verify', { preHandler: requireWebSession }, async (req, reply) => {
    if (!limiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const accountId = req.webAccountId!;
    const code = cleanCode(req.body?.code);
    if (!code) return reply.code(400).send({ ok: false, error: 'bad_code' });
    const [v] = await db.select().from(emailVerifications).where(eq(emailVerifications.accountId, accountId)).limit(1);
    if (!v) return reply.code(404).send({ ok: false, error: 'no_pending' });
    if (v.expiresAt.getTime() < Date.now()) return reply.code(410).send({ ok: false, error: 'expired' });
    if (v.attempts >= MAX_ATTEMPTS) return reply.code(429).send({ ok: false, error: 'too_many' });
    const a = Buffer.from(codeHash(code, accountId, v.email), 'hex');
    const b = Buffer.from(v.codeHash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await db.update(emailVerifications).set({ attempts: v.attempts + 1 }).where(eq(emailVerifications.accountId, accountId));
      return reply.code(400).send({ ok: false, error: 'bad_code', left: Math.max(0, MAX_ATTEMPTS - v.attempts - 1) });
    }
    const current = await verifiedEmailRow(accountId);
    const changeAt = emailChangeAllowedAt(current && current.email !== v.email ? current.verifiedAt : null);
    if (changeAt) return reply.code(429).send({ ok: false, error: 'change_cooldown', retryAt: new Date(changeAt).toISOString() });
    const now = new Date();
    await db.insert(accountEmails).values({ accountId, email: v.email, verifiedAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: accountEmails.accountId, set: { email: v.email, verifiedAt: now, updatedAt: now } });
    await db.delete(emailVerifications).where(eq(emailVerifications.accountId, accountId));
    req.log.info({ accountId }, 'account: email verified');
    return { ok: true, email: v.email };
  });
}

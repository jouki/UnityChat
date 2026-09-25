// Udržovací e-mail pro klíče e-mailových služeb (pokyn usera 2026-09-25): Brevo API klíč
// „bez expirace" vyprší po 90 dnech bez použití. Když ověřování e-mailu nikdo delší dobu
// nepoužije, pošle backend přes každou nastavenou službu jednou za KEEPALIVE_DAYS krátký
// e-mail na MAIL_KEEPALIVE_TO — klíč zůstane aktivní a zároveň je to kontrola, že posílání funguje.
// Poslední odeslání se bere z email_send_log (drží 30 dní), keepalive se tam zapíše taky.
import { and, desc, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { emailSendLog } from '../db/schema.js';
import { providersConfigured, sendMail, type Mail, type Provider } from './mailer.js';

export const KEEPALIVE_DAYS = 25;          // < 30 dní retence email_send_log, hluboko pod 90 dny Breva
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 5 * 60 * 1000;      // po startu počkat (deploy, ať neposílá při každém restartu hned)
const DAY = 24 * 60 * 60 * 1000;

/** Služby, přes které se naposledy posílalo před víc než KEEPALIVE_DAYS (nebo nikdy). */
export function dueProviders(lastSent: Partial<Record<Provider, Date | null>>, providers: Provider[], now = Date.now()): Provider[] {
  return providers.filter((p) => { const t = lastSent[p]; return !t || now - t.getTime() > KEEPALIVE_DAYS * DAY; });
}

export function keepaliveMail(to: string, provider: Provider): Mail {
  const name = provider === 'brevo' ? 'Brevo' : 'Resend';
  const subject = `UnityChat — měsíční kontrola e-mailů (${name})`;
  const text = [
    `Tenhle e-mail posílá backend UnityChatu automaticky přes ${name}, když se ${KEEPALIVE_DAYS} dní neposlal žádný ověřovací kód.`,
    '',
    'Drží API klíč aktivní (Brevo ho po 90 dnech nečinnosti vypne) a potvrzuje, že odesílání funguje.',
    'Není potřeba nic dělat.',
  ].join('\n');
  const html = `<p>${text.split('\n').filter(Boolean).join('</p><p>')}</p>`;
  return { to, subject, text, html };
}

async function lastSentAt(p: Provider): Promise<Date | null> {
  const rows = await db.select({ at: emailSendLog.sentAt }).from(emailSendLog)
    .where(and(eq(emailSendLog.provider, p))).orderBy(desc(emailSendLog.sentAt)).limit(1);
  return rows[0]?.at ?? null;
}

type Log = { info: (o: object, msg: string) => void; warn: (o: object, msg: string) => void };

export async function runMailKeepalive(log: Log): Promise<void> {
  const to = config.MAIL_KEEPALIVE_TO;
  const providers = providersConfigured();
  if (!to || !providers.length) return;
  const last: Partial<Record<Provider, Date | null>> = {};
  for (const p of providers) last[p] = await lastSentAt(p);
  for (const p of dueProviders(last, providers)) {
    const r = await sendMail(keepaliveMail(to, p), log, [p]);   // jen tahle služba — udržuje její klíč
    if (r.ok) {
      await db.insert(emailSendLog).values({ accountId: null, email: to, ipHash: 'keepalive', provider: p });
      log.info({ provider: p }, 'mail keepalive: odesláno');
    } else {
      log.warn({ provider: p, err: r.error }, 'mail keepalive: odeslání selhalo');
    }
  }
}

export function startMailKeepalive(log: Log): void {
  const tick = () => { runMailKeepalive(log).catch((e) => log.warn({ err: (e as Error).message }, 'mail keepalive: chyba')); };
  setTimeout(tick, FIRST_CHECK_MS).unref?.();
  setInterval(tick, CHECK_EVERY_MS).unref?.();
}

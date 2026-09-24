// Posílání transakčních e-mailů (ověřovací kód QR dona, spec 2026-09-25-qr-dono-v-unitychatu-design.md).
// Primárně Brevo (EU, 300/den), záloha Resend (100/den) při chybě nebo vyčerpaném limitu.
// Obě přes HTTPS API: Hetzner blokuje odchozí SMTP 25/465 a jouki.cz vlastní mail server nemá.
// Klíče jen v env (Coolify), nikdy v gitu ani v logu.
import { config } from '../config.js';

export interface Mail { to: string; subject: string; text: string; html: string }
export type Provider = 'brevo' | 'resend';
export interface SendResult { ok: boolean; provider?: Provider; error?: string }

const FROM_NAME = 'UnityChat';
const fromEmail = () => config.MAIL_FROM;

export function providersConfigured(env = config): Provider[] {
  return [env.BREVO_API_KEY ? 'brevo' : null, env.RESEND_API_KEY ? 'resend' : null].filter(Boolean) as Provider[];
}

async function sendBrevo(m: Mail): Promise<void> {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': config.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: { name: FROM_NAME, email: fromEmail() }, to: [{ email: m.to }], subject: m.subject, textContent: m.text, htmlContent: m.html }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`brevo HTTP ${r.status}`);
}

async function sendResend(m: Mail): Promise<void> {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${FROM_NAME} <${fromEmail()}>`, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`resend HTTP ${r.status}`);
}

const SENDERS: Record<Provider, (m: Mail) => Promise<void>> = { brevo: sendBrevo, resend: sendResend };

/** Zkusí služby v pořadí; první úspěch vyhrává. Chyby jen do logu (bez adresy příjemce a obsahu). */
export async function sendMail(m: Mail, log?: { warn: (o: object, msg: string) => void }, order: Provider[] = providersConfigured()): Promise<SendResult> {
  if (!order.length) return { ok: false, error: 'no_provider' };
  let last = '';
  for (const p of order) {
    try { await SENDERS[p](m); return { ok: true, provider: p }; }
    catch (e) { last = (e as Error).message; log?.warn({ provider: p, err: last }, 'mailer: provider failed, trying next'); }
  }
  return { ok: false, error: last || 'send_failed' };
}

/** Ověřovací e-mail: plain text + jednoduché HTML, bez obrázků a odkazů (menší riziko spamu). */
export function verificationMail(to: string, code: string): Mail {
  const subject = `Tvůj ověřovací kód: ${code}`;
  const text = [
    `Tvůj ověřovací kód pro UnityChat je: ${code}`,
    '',
    'Kód platí 10 minut. Přepiš ho do UnityChatu, kde jsi o něj požádal.',
    '',
    'Pokud jsi o kód nežádal, e-mail ignoruj — bez kódu se nic nestane.',
    '',
    '—',
    'UnityChat (jouki.cz). Tenhle e-mail je automatický, neodpovídej na něj.',
  ].join('\n');
  const html = `<!doctype html><html lang="cs"><body style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;line-height:1.5">
<p>Tvůj ověřovací kód pro UnityChat je:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px;margin:12px 0">${code}</p>
<p>Kód platí 10 minut. Přepiš ho do UnityChatu, kde jsi o něj požádal.</p>
<p>Pokud jsi o kód nežádal, e-mail ignoruj — bez kódu se nic nestane.</p>
<p style="color:#666;font-size:12px">UnityChat (jouki.cz). Tenhle e-mail je automatický, neodpovídej na něj.</p>
</body></html>`;
  return { to, subject, text, html };
}

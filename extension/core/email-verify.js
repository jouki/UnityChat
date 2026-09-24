// Krok ověření e-mailu kódem (spec 2026-09-25-qr-dono-v-unitychatu-design.md, sekce Identita)
// — sdílí QR dono i párování e-mailu v nastavení (addon i web). Síť přes `api` hostitele
// (backend /account/email/start + /verify).
import { mountCodeInput } from './code-input.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Chybové kódy backendu → česky. */
export function emailErrorText(e) {
  switch (e?.error) {
    case 'bad_email': return 'E-mail nemá platný tvar.';
    case 'cooldown': return 'Kód jsme už poslali, další půjde poslat za chvíli.';
    case 'daily_limit': return 'Dnes už jsme ti poslali moc kódů, zkus to zítra.';
    case 'mail_budget': case 'send_failed': case 'mail_disabled': return 'E-mail se teď nepodařilo odeslat.';
    case 'bad_code': return e.left > 0 ? `Kód nesedí, zbývá ${e.left} ${e.left === 1 ? 'pokus' : e.left < 5 ? 'pokusy' : 'pokusů'}.` : 'Kód nesedí.';
    case 'expired': return 'Platnost kódu vypršela, pošli si nový.';
    case 'too_many': return 'Moc pokusů, pošli si nový kód.';
    case 'no_pending': return 'Nejdřív si nech poslat kód.';
    default: return e?.error || e?.message || 'Něco se nepovedlo.';
  }
}

/** Chyby, u kterých ověření teď nejde a QR dono má pokračovat bez něj (e-mail se pošle neověřený). */
export const cannotSend = (e) => ['mail_disabled', 'mail_budget', 'send_failed', 'daily_limit'].includes(e?.error);

const fmtLeft = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} s`; };

/**
 * Vykreslí krok „Na email jsme ti poslali 6místný kód…“ do `container` a pošle první kód.
 * @param {object} o
 * @param {HTMLElement} o.container
 * @param {{ emailStart(email: string): Promise<object>, emailVerify(code: string): Promise<object> }} o.api
 * @param {string} o.email
 * @param {(email: string) => void} o.onVerified   po animaci úspěchu
 * @param {(err: object) => void} [o.onCannotSend] odeslání teď nejde (limit / výpadek služeb)
 * @param {() => void} [o.onBack]
 * @param {(tag: string, text: string) => void} [o.log]
 * @returns {{ destroy(): void }}
 */
export function startEmailVerification({ container, api, email, onVerified, onCannotSend, onBack, log }) {
  const win = container.ownerDocument.defaultView;
  const L = (t) => log?.('EmailVerify', t);
  container.innerHTML = `
    <div class="uc-ev">
      <p class="uc-ev-t">Na email <b>${esc(email)}</b> jsme ti poslali 6místný kód, který přepiš sem:</p>
      <div class="uc-ev-code"></div>
      <p class="uc-ev-err" hidden></p>
      <div class="uc-ev-row">
        ${onBack ? '<button type="button" class="uc-ev-back">← Zpět</button>' : ''}
        <button type="button" class="uc-ev-resend" disabled>Poslat znovu</button>
      </div>
      <div class="uc-ev-ok" hidden><svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24"/><path d="M15 27l7 7 15-16"/></svg><span>E-mail ověřen</span></div>
    </div>`;
  const q = (s) => container.querySelector(s);
  const errEl = q('.uc-ev-err'), resend = q('.uc-ev-resend');
  let nextAt = 0, timer = null, alive = true;
  const setErr = (m) => { errEl.textContent = m || ''; errEl.hidden = !m; };

  function tick() {
    if (!alive) return;
    const left = nextAt - Date.now();
    resend.disabled = left > 0;
    resend.textContent = left > 0 ? `Poslat znovu (${fmtLeft(left)})` : 'Poslat znovu';
    if (left > 0) timer = win.setTimeout(tick, 500);
  }
  async function send() {
    resend.disabled = true;
    try {
      const r = await api.emailStart(email);
      if (r.alreadyVerified) { done(); return; }
      nextAt = Date.parse(r.nextAt) || Date.now() + 120_000;
      L('kód odeslán');
    } catch (e) {
      if (e?.error === 'cooldown') { nextAt = Date.parse(e.retryAt) || Date.now() + 60_000; }
      else if (cannotSend(e)) { L(`nelze poslat: ${e.error}`); onCannotSend?.(e); return; }
      else setErr(emailErrorText(e));
    }
    tick();
  }
  const code = mountCodeInput(q('.uc-ev-code'), {
    async onComplete(value) {
      setErr('');
      code.setBusy(true);
      try {
        await api.emailVerify(value);
        L('ověřeno');
        done();
      } catch (e) {
        code.setBusy(false);
        code.setError(true);
        setErr(emailErrorText(e));
        if (e?.error === 'expired' || e?.error === 'too_many') { nextAt = 0; tick(); }
        code.focus();
      }
    },
  });
  function done() {
    win.clearTimeout(timer);
    q('.uc-ev-code').hidden = true; q('.uc-ev-row').hidden = true; setErr('');
    q('.uc-ev-ok').hidden = false;
    // Animace potvrzení (kružnice + fajfka), pak dál.
    win.setTimeout(() => { if (alive) onVerified(email); }, 1100);
  }
  resend.addEventListener('click', () => { setErr(''); code.clear(); send(); });
  q('.uc-ev-back')?.addEventListener('click', () => onBack?.());
  send();
  code.focus();
  return { destroy() { alive = false; win.clearTimeout(timer); container.innerHTML = ''; } };
}

// Krok ověření e-mailu kódem (spec 2026-09-25-qr-dono-v-unitychatu-design.md, sekce Identita)
// — sdílí QR dono i párování e-mailu v nastavení (addon i web). Síť přes `api` hostitele
// (backend /account/email/start + /verify).
import { mountCodeInput } from './code-input.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Čas, od kdy půjde e-mail znovu změnit (backend drží změnu na 1× za 24 h). */
export function changeAllowedText(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return 'E-mail jde změnit jen jednou za 24 hodin.';
  const when = d.toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `E-mail jde změnit jen jednou za 24 hodin, znovu to půjde ${when}.`;
}

/** Chybové kódy backendu → česky. */
export function emailErrorText(e) {
  switch (e?.error) {
    case 'change_cooldown': return changeAllowedText(e.retryAt);
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
 * Blok „Email“ v nastavení UnityChatu (addon i web): zašedlé pole s ověřeným e-mailem a tlačítko
 * „Spárovat email“ (bez ověřeného) / „Změnit email“ (s ověřeným) → zadání adresy → kód.
 * @param {object} o
 * @param {HTMLElement} o.container
 * @param {{ profile(): Promise<object>, emailStart(email: string): Promise<object>, emailVerify(code: string): Promise<object> }} o.api
 * @param {(email: string) => void} [o.onChange]   po úspěšném ověření
 * @param {(tag: string, text: string) => void} [o.log]
 * @returns {{ refresh(): Promise<void>, destroy(): void }}
 */
export function createEmailSettings({ container, api, onChange, log }) {
  container.classList.add('uc-es');
  let verifier = null;
  const render = (p) => {
    const verified = !!p?.verified;
    container.innerHTML = `
      <label class="uc-es-l">Email</label>
      <div class="uc-es-row">
        <input class="uc-es-val" type="email" value="${esc(p?.email || '')}" placeholder="nespárovaný" readonly disabled>
        <button type="button" class="uc-es-btn">${verified ? 'Změnit email' : 'Spárovat email'}</button>
      </div>
      <div class="uc-es-new" hidden>
        <input class="uc-es-in" type="email" maxlength="120" autocomplete="email" placeholder="tvůj@email.cz">
        <button type="button" class="uc-es-send">Poslat kód</button>
      </div>
      <p class="uc-es-err" hidden></p>
      <div class="uc-es-verify" hidden></div>`;
    const q = (s) => container.querySelector(s);
    const err = (m) => { q('.uc-es-err').textContent = m || ''; q('.uc-es-err').hidden = !m; };
    if (p && p.mailEnabled === false) { q('.uc-es-btn').disabled = true; q('.uc-es-btn').title = 'Ověřování e-mailu je teď vypnuté.'; }
    else if (verified && p.changeAllowedAt && new Date(p.changeAllowedAt).getTime() > Date.now()) {
      q('.uc-es-btn').disabled = true; q('.uc-es-btn').title = changeAllowedText(p.changeAllowedAt);
    }
    q('.uc-es-btn').addEventListener('click', () => { q('.uc-es-new').hidden = false; q('.uc-es-in').focus(); });
    const go = () => {
      const email = q('.uc-es-in').value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err('Vyplň platný e-mail.'); return; }
      err('');
      q('.uc-es-new').hidden = true; q('.uc-es-verify').hidden = false;
      verifier?.destroy();
      verifier = startEmailVerification({
        container: q('.uc-es-verify'), api, email, log,
        onVerified: (em) => { verifier = null; onChange?.(em); refresh(); },
        onCannotSend: (e) => { verifier?.destroy(); verifier = null; q('.uc-es-verify').hidden = true; err(emailErrorText(e)); },
        onBack: () => { verifier?.destroy(); verifier = null; q('.uc-es-verify').hidden = true; q('.uc-es-new').hidden = false; },
      });
    };
    q('.uc-es-send').addEventListener('click', go);
    q('.uc-es-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  };
  async function refresh() {
    try { render(await api.profile()); }
    catch (e) { log?.('EmailVerify', `profile fail ${e?.error || e}`); render(null); }
  }
  refresh();
  return { refresh, destroy() { verifier?.destroy(); container.innerHTML = ''; } };
}

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

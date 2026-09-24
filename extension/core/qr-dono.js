// QR dono v UnityChatu (spec docs/superpowers/specs/2026-09-25-qr-dono-v-unitychatu-design.md)
// — sdílené addonem i webem. Předloha: dárcovský formulář Židolišty (RobJewsALot
// wrapper-service/donate.html, docs/fio-donations/03-donor-form.md), vzhled UnityChatu.
// Síť dělá hostitel přes `api` (backend UnityChatu /donate/*), DOM dostává zvenku.
// Přezdívka je vidět vždy (předvyplněná: UC přezdívka → poslední z dona → jméno z platformy).
// E-mail zadá divák sám, jen dokud účet nemá ověřený; ověření kódem (core/email-verify.js).
import { startEmailVerification } from './email-verify.js';

export const CONFIRM_TOOLTIP = 'Abychom mohli autorizovat, že jsou platby skutečně od tebe, potřebujeme ověřit tvůj email. V budoucnu díky tomu získáš přístup a výhodu pro nadcházející funkce.';

/** Předvyplnění přezdívky podle pořadí ze specu. */
export function prefillNickname(profile, identityName) {
  return (profile?.ucNickname || profile?.lastNickname || identityName || '').trim().slice(0, 40);
}

export const CURRENCIES = { CZK: { code: 'CZK', flag: 'CZ', sym: 'Kč', step: 1 }, EUR: { code: 'EUR', flag: 'SK', sym: '€', step: 0.01 } };
export const MSG_MAX = 300;
const PLATFORM_LABEL = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube' };
const TESTMODE = 'testmode';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Nastavení měny z configu Židolišty: `currencies.{EUR,CZK}`, starý tvar jen EUR. */
export function currencyConfig(cfg, cur) {
  if (!cfg) return null;
  if (cfg.currencies) return cfg.currencies[cur] || null;
  return cur === 'EUR' && cfg.enabled ? { minAmount: cfg.minAmount, iban: cfg.iban } : null;
}

/** Částka z pole: čárka i tečka, NaN = prázdná. */
export function parseAmount(v) {
  const n = parseFloat(String(v ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

/** „≈ N Kč“ u eur: dolů na celé Kč jako server (czkFromEur), jinak null. */
export function czkPreview(amount, rate) {
  return rate && rate.eurToCzk > 0 && amount > 0 ? Math.floor(amount * rate.eurToCzk + 1e-9) : null;
}

export function formatAmount(amount, cur) {
  return cur === 'CZK' ? String(Math.round(amount)) : Number(amount).toFixed(2);
}

/** Kontrola formuláře proti aktuální konfiguraci (jako validateForm na webu). */
export function validateDono({ amount, message, voice, nickname, email, needEmail }, cfg, cur) {
  const problems = [];
  if (nickname !== undefined && !String(nickname).trim()) problems.push({ field: 'nickname', msg: 'Vyplň přezdívku.' });
  if (needEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email ?? '').trim())) problems.push({ field: 'email', msg: 'Vyplň platný e-mail.' });
  const cc = currencyConfig(cfg, cur);
  const sym = CURRENCIES[cur].sym;
  const a = parseAmount(amount);
  const min = cc?.minAmount ?? (cur === 'CZK' ? 1 : 0.25);
  if (!(a > 0)) problems.push({ field: 'amount', msg: 'Vyplň částku.' });
  else if (a < min) problems.push({ field: 'amount', msg: `Minimum je ${min} ${sym}.` });
  else if (cur === 'CZK' && a !== Math.round(a)) problems.push({ field: 'amount', msg: 'V Kč zadej celou částku.' });
  if (String(message ?? '').length > MSG_MAX) problems.push({ field: 'message', msg: `Zpráva má max. ${MSG_MAX} znaků.` });
  const voices = cfg?.voices || [];
  if (voices.length && !voices.some((v) => v.id === voice)) problems.push({ field: 'voice', msg: 'Vybraný TTS hlas už není v nabídce, vyber jiný.' });
  return problems;
}

/** Chybové kódy serveru → česky (jako web Židolišty). */
export function donoErrorText(err, cur) {
  const sym = CURRENCIES[cur]?.sym || '';
  switch (err?.error) {
    case 'below_minimum': return `Minimum je ${err.minAmount} ${sym}.`;
    case 'czk_whole_amount': return 'V Kč zadej celou částku.';
    case 'czk_not_configured': return 'Platby v Kč zatím nejsou nastavené.';
    case 'donate_not_configured': return 'Donate zatím není nastavený.';
    case 'invalid_test_token': return 'Neplatný testovací token.';
    case 'platform_not_linked': return 'Na téhle platformě nejsi přihlášený.';
    case 'email_required': return 'Vyplň platný e-mail.';
    case 'rate_limited': return 'Moc pokusů za sebou, zkus to za chvíli.';
    case 'zidolista_unavailable': return 'Server donací je teď nedostupný, zkus to znovu.';
    default: return err?.error || err?.message || 'Něco se nepovedlo.';
  }
}

/**
 * Tajné gesto testovacího režimu: psaní „testmode“ do aktivního panelu mimo pole formuláře.
 * Vrací funkci (klávesa) → true, když se zrovna dopsalo „testmode“.
 */
export function makeTestmodeDetector(word = TESTMODE) {
  let buf = '';
  return (key) => {
    if (typeof key !== 'string' || key.length !== 1) return false;
    buf = (buf + key.toLowerCase()).slice(-word.length);
    return buf === word;
  };
}

const QR_SVG_ICON = '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M3 3h8v8H3V3Zm2 2v4h4V5H5Zm8-2h8v8h-8V3Zm2 2v4h4V5h-4ZM3 13h8v8H3v-8Zm2 2v4h4v-4H5Zm1-9h2v2H6V6Zm10 0h2v2h-2V6ZM6 16h2v2H6v-2Zm7-3h2v2h-2v-2Zm2 2h2v2h-2v-2Zm2-2h4v2h-2v2h-2v-4Zm-4 4h2v4h-2v-4Zm4 2h2v2h2v2h-4v-4Zm2-2h2v2h-2v-2Z"/></svg>';
/** SVG ikona QR kódu pro tlačítko (stejná v addonu i na webu). */
export const QR_DONO_BUTTON_SVG = QR_SVG_ICON;

/**
 * Panel QR dona. Tlačítko `button` ho otevírá, panel se vloží do `host` (kotví se nad něj).
 * @param {object} o
 * @param {HTMLElement} o.host
 * @param {HTMLElement} o.button
 * @param {{ config(): Promise<object>, testToken(t: string): Promise<{valid:boolean}>,
 *           createIntent(body: object): Promise<object>, intentStatus(id: string): Promise<object> }} o.api
 *           profile(): Promise<object>, emailStart(email: string): Promise<object>, emailVerify(code: string): Promise<object> }} o.api
 *        Chyby hází s `.error` / `.minAmount` z odpovědi serveru.
 * @param {() => ({ platform: string, name: string } | null)} o.identity  kdo tipuje (null = nepřihlášen)
 * @param {() => void} [o.onLogin]
 * @param {{ load(): string|null, save(v: string): void }} [o.currency]  poslední měna (CZK/EUR)
 * @param {(tag: string, text: string) => void} [o.log]
 */
export function createQrDono({ host, button, api, identity, onLogin, currency, log }) {
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  const L = (t) => log?.('QrDono', t);
  let cfg = null, cfgVersion = null, cur = 'CZK';
  try { const c = currency?.load?.(); if (c === 'CZK' || c === 'EUR') cur = c; } catch { /* ignore */ }
  let testMode = false, testValid = false, tokenTimer = null, tokenSeq = 0;
  let publicId = null, pollTimer = null, versionTimer = null, sampleAudio = null, paidShown = false;
  let ringRaf = null, ringStart = 0, ringPeriod = 0;
  let profile = null, verifier = null;
  const detectTestmode = makeTestmodeDetector();

  const panel = doc.createElement('div');
  panel.className = 'uc-qd hidden';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'QR dono');
  panel.tabIndex = -1;   // fokus na panel = místo pro tajné gesto „testmode“
  panel.innerHTML = `
    <div class="uc-qd-head">
      <span class="uc-qd-title">${QR_SVG_ICON} QR dono</span>
      <div class="uc-qd-cur" role="radiogroup" aria-label="Měna">
        <button type="button" data-cur="CZK" role="radio">CZ <small>Kč</small></button>
        <button type="button" data-cur="EUR" role="radio">SK <small>€</small></button>
      </div>
      <button type="button" class="uc-qd-x" data-act="close" aria-label="Zavřít">×</button>
    </div>
    <form class="uc-qd-form" novalidate>
      <div class="uc-qd-who"></div>
      <label class="uc-qd-f">
        <span class="uc-qd-l">Přezdívka</span>
        <input name="nickname" maxlength="40" autocomplete="off">
      </label>
      <div class="uc-qd-mail" hidden>
        <label class="uc-qd-f">
          <span class="uc-qd-l">E-mail</span>
          <input name="email" type="email" maxlength="120" autocomplete="email">
        </label>
        <label class="uc-qd-confirm"><input type="checkbox" name="confirm" checked> <span>Potvrdit email při první platbě</span><span class="uc-qd-tip" role="tooltip">${CONFIRM_TOOLTIP}</span></label>
      </div>
      <div class="uc-qd-row">
        <label class="uc-qd-f">
          <span class="uc-qd-l">Částka <em class="uc-qd-min"></em></span>
          <span class="uc-qd-amt"><input name="amount" inputmode="decimal" autocomplete="off"><b class="uc-qd-sym"></b></span>
          <span class="uc-qd-meta uc-qd-czk"></span>
        </label>
        <label class="uc-qd-f">
          <span class="uc-qd-l">TTS hlas <button type="button" class="uc-qd-sample" data-act="sample" hidden>▶ ukázka</button></span>
          <select name="voice"></select>
        </label>
      </div>
      <label class="uc-qd-f">
        <span class="uc-qd-l">Zpráva <em class="uc-qd-count">0 / ${MSG_MAX}</em></span>
        <textarea name="message" rows="3" maxlength="${MSG_MAX}"></textarea>
      </label>
      <div class="uc-qd-test" hidden>
        <input name="ttoken" placeholder="testovací token" autocomplete="off" spellcheck="false" maxlength="200">
        <label><input type="checkbox" name="marktest" checked> Mark as test</label>
        <label><input type="checkbox" name="markpaid" checked> Mark as paid</label>
      </div>
      <div class="uc-qd-notice" hidden></div>
      <div class="uc-qd-err" hidden></div>
      <button type="submit" class="uc-qd-go">Vytvořit QR kód</button>
    </form>
    <div class="uc-qd-verify" hidden></div>
    <div class="uc-qd-res" hidden>
      <button type="button" class="uc-qd-back" data-act="back">← Zpět</button>
      <p class="uc-qd-sub">Naskenuj QR kód mobilní aplikací banky</p>
      <div class="uc-qd-qr"></div>
      <div class="uc-qd-amount"></div>
      <p class="uc-qd-tiny">VS <b class="uc-qd-vs"></b> · IBAN <b class="uc-qd-iban"></b></p>
      <button type="button" class="uc-qd-dl" data-act="download">Stáhnout QR kód</button>
      <p class="uc-qd-tiny">Platíš přímo na účet streamera. UnityChat peníze nepřijímá ani nedrží.</p>
      <div class="uc-qd-notice uc-qd-notice2" hidden></div>
      <div class="uc-qd-status"><span class="uc-qd-st">Čekám na platbu…</span><span class="uc-qd-ring" hidden><i></i><em></em></span></div>
    </div>`;
  host.appendChild(panel);
  const $ = (sel) => panel.querySelector(sel);
  const form = $('.uc-qd-form');
  const f = { amount: form.elements.amount, voice: form.elements.voice, message: form.elements.message, ttoken: form.elements.ttoken, marktest: form.elements.marktest, markpaid: form.elements.markpaid,
    nickname: form.elements.nickname, email: form.elements.email, confirm: form.elements.confirm };
  const verifyEl = $('.uc-qd-verify');
  const submitBtn = $('.uc-qd-go');

  button.innerHTML = QR_SVG_ICON;
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  if (!button.title) button.title = 'QR dono';

  // ---- stav formuláře ----
  function setError(msg) { const e = $('.uc-qd-err'); e.textContent = msg || ''; e.hidden = !msg; }
  function setNotice(c) {
    const n = currencyConfig(c, cur)?.bankNotice?.text || '';
    for (const el of panel.querySelectorAll('.uc-qd-notice')) { el.textContent = n ? `⚠ ${n}` : ''; el.hidden = !n; }
  }
  function renderWho() {
    const id = identity?.();
    $('.uc-qd-who').innerHTML = id
      ? `Tipuješ jako <b>${esc(id.name)}</b> <span class="uc-qd-plat">(${esc(PLATFORM_LABEL[id.platform] || id.platform)})</span>`
      : 'Pro QR dono se přihlas k UnityChatu. <button type="button" data-act="login">Přihlásit</button>';
    submitBtn.disabled = !id || !currencyConfig(cfg, cur);
  }
  /** E-mail pole + checkbox jen dokud účet nemá ověřený e-mail (po ověření zmizí i po „Zpět“). */
  function renderMail() {
    const need = !!identity?.() && !profile?.verified;
    $('.uc-qd-mail').hidden = !need;
    // Bez funkčního posílání e-mailů checkbox nenabízet (ověření by stejně nešlo).
    $('.uc-qd-confirm').hidden = !need || profile?.mailEnabled === false;
  }
  async function loadProfile() {
    const id = identity?.();
    if (!id) { profile = null; renderMail(); return; }
    try { profile = await api.profile(); } catch (e) { L(`profile fail ${e?.error || e}`); }
    if (!f.nickname.value.trim()) f.nickname.value = prefillNickname(profile, id.name);
    renderMail();
  }

  function renderCurrency() {
    const c = CURRENCIES[cur];
    for (const b of panel.querySelectorAll('.uc-qd-cur button')) { const on = b.dataset.cur === cur; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
    $('.uc-qd-sym').textContent = c.sym;
    f.amount.step = String(c.step);
    const cc = currencyConfig(cfg, cur);
    $('.uc-qd-min').textContent = cc ? `min. ${cc.minAmount} ${c.sym}` : '';
    if (cfg && !cc) setError(cur === 'CZK' ? 'Platby v Kč zatím nejsou nastavené.' : 'Platby v € zatím nejsou nastavené.');
    else if ($('.uc-qd-err').textContent.includes('zatím nejsou nastavené')) setError('');
    updateCzk();
    setNotice(cfg);
    renderWho();
  }
  function updateCzk() {
    const n = cur === 'EUR' ? czkPreview(parseAmount(f.amount.value), cfg?.rate) : null;
    $('.uc-qd-czk').textContent = n ? `Zobrazí se jako ≈ ${n} Kč` : '';
  }
  function renderVoices() {
    const keep = f.voice.value;
    f.voice.textContent = '';
    const voices = cfg?.voices?.length ? cfg.voices : [{ id: '', name: 'Náhodný', isDefault: true }];
    for (const v of voices) {
      const o = new win.Option((v.isDefault ? '[Default] ' : '') + v.name, v.id);
      if (v.isDefault) o.selected = true;
      f.voice.appendChild(o);
    }
    if (keep && voices.some((v) => v.id === keep)) f.voice.value = keep;
    updateSampleBtn();
  }
  function selectedVoice() { return cfg?.voices?.find((v) => v.id === f.voice.value) || null; }
  function updateSampleBtn() {
    const v = selectedVoice();
    const btn = $('.uc-qd-sample');
    btn.hidden = !v?.sampleUrl;
    if (btn.hidden) stopSample();
  }
  function stopSample() {
    if (sampleAudio) { sampleAudio.pause(); sampleAudio = null; }
    const btn = $('.uc-qd-sample'); btn.textContent = '▶ ukázka'; btn.classList.remove('playing');
  }

  async function loadConfig() {
    try {
      const c = await api.config();
      const changed = cfgVersion !== null && c.version && c.version !== cfgVersion;
      cfg = c; cfgVersion = c.version || '';
      renderVoices(); renderCurrency();
      // Změna nastavení (dashboard / !mindono) během otevřeného formuláře: data zůstanou,
      // jen se přepočítá minimum a hlasy (web tu ukazuje overlay s reloadem, tady netřeba).
      if (changed) { L('config změněn'); setError('Nastavení donací se změnilo — zkontroluj částku a hlas.'); }
    } catch (e) {
      L(`config fail ${e?.error || e?.message || e}`);
      setError('Server donací je nedostupný, zkouším znovu…');
      win.setTimeout(() => { if (isOpen()) loadConfig(); }, 5000);
    }
  }

  // ---- testovací režim ----
  function revealTestMode() {
    if (testMode) return;
    testMode = true;
    $('.uc-qd-test').hidden = false;
    f.ttoken.focus();
    L('testmode odkryt');
  }
  function setTestValid(v) {
    testValid = v;
    f.ttoken.classList.toggle('valid', v);
    submitBtn.classList.toggle('test', v);
    submitBtn.textContent = v ? 'Testovací tip' : 'Vytvořit QR kód';
  }
  async function checkToken(t) {
    const seq = ++tokenSeq;
    try {
      const r = await api.testToken(t);
      if (seq !== tokenSeq || f.ttoken.value.trim() !== t) return;   // mezitím se psalo dál
      setTestValid(r?.valid === true);
      L(`token valid=${r?.valid === true}`);
    } catch (e) { if (seq === tokenSeq) setTestValid(false); L(`token check fail ${e?.error || e}`); }
  }

  // ---- odeslání a výsledek ----
  async function submit() {
    setError('');
    for (const el of form.querySelectorAll('.invalid')) el.classList.remove('invalid');
    const id = identity?.();
    if (!id) { onLogin?.(); return; }
    const needEmail = !profile?.verified;
    const values = { amount: f.amount.value, message: f.message.value, voice: f.voice.value, nickname: f.nickname.value, email: f.email.value, needEmail };
    const problems = validateDono(values, cfg, cur);
    if (problems.length) {
      for (const p of problems) f[p.field]?.classList.add('invalid');
      f[problems[0].field]?.focus();
      setError(problems.map((p) => p.msg).join(' '));
      return;
    }
    // Neověřený e-mail + zaškrtnuté „Potvrdit“: nejdřív kód, po ověření teprve QR.
    if (needEmail && f.confirm.checked && !$('.uc-qd-confirm').hidden) { askCode(values); return; }
    await createIntent(values);
  }

  function askCode(values) {
    const email = values.email.trim();
    form.hidden = true; verifyEl.hidden = false;
    verifier?.destroy();
    verifier = startEmailVerification({
      container: verifyEl, api, email, log,
      onVerified: (em) => { profile = { ...(profile || {}), email: em, verified: true }; renderMail(); closeVerify(); createIntent(values); },
      // Kód teď poslat nejde (limit / výpadek služeb): QR dono nezablokovat, e-mail se pošle neověřený.
      onCannotSend: () => { closeVerify(); setError('E-mail teď nejde ověřit, tip pošleme bez ověření.'); createIntent(values); },
      onBack: () => closeVerify(),
    });
  }
  function closeVerify() { verifier?.destroy(); verifier = null; verifyEl.hidden = true; form.hidden = false; }

  async function createIntent(values) {
    submitBtn.disabled = true;
    const body = {
      nickname: values.nickname.trim(), ...(profile?.verified ? {} : { email: values.email.trim() }),
      currency: cur, amount: parseAmount(values.amount), message: values.message.trim(), ttsVoice: values.voice,
      ttsLanguage: cfg?.languages?.[0]?.code || 'cs',
      ...(testMode && testValid ? { testToken: f.ttoken.value.trim(), markTest: f.marktest.checked, markPaid: f.markpaid.checked } : {}),
    };
    try {
      const res = await api.createIntent(body);
      if (profile) profile.lastNickname = body.nickname;
      showResult(res);
    } catch (e) {
      setError(donoErrorText(e, cur));
      L(`intent fail ${e?.error || e?.message || e}`);
    } finally { submitBtn.disabled = !identity?.(); }
  }

  function showResult(res) {
    form.hidden = true; $('.uc-qd-res').hidden = false;
    // SVG kreslí náš server (knihovna qrcode), vkládá se jako obsah z důvěryhodného zdroje.
    $('.uc-qd-qr').innerHTML = typeof res.qrSvg === 'string' && res.qrSvg.startsWith('<svg') ? res.qrSvg : '<p class="uc-qd-tiny">QR se nepodařilo vykreslit.</p>';
    $('.uc-qd-vs').textContent = res.vs || '';
    $('.uc-qd-iban').textContent = res.iban || '';
    const c = res.currency === 'CZK' ? 'Kč' : res.currency;
    $('.uc-qd-amount').textContent = `${formatAmount(res.amount, res.currency)} ${c}${res.czkPreview ? ` (≈ ${res.czkPreview} Kč)` : ''}`;
    const st = $('.uc-qd-status'); st.classList.remove('ok'); $('.uc-qd-st').textContent = 'Čekám na platbu…';
    publicId = res.publicId;
    paidShown = false;
    startRing();
    poll();
    L(`intent ${res.currency} ${res.amount} vs=${res.vs}`);
  }
  async function poll() {
    win.clearTimeout(pollTimer);
    if (!publicId || $('.uc-qd-res').hidden) return;
    const id = publicId;
    try {
      const s = await api.intentStatus(id);
      if (id !== publicId) return;
      if (s.status === 'paid') { markPaid(); return; }
      if (s.status === 'expired') { $('.uc-qd-st').textContent = 'Platnost QR vypršela'; stopRing(); return; }
      syncRing(s.bankPoll);
      pollTimer = win.setTimeout(poll, 3000);
    } catch { pollTimer = win.setTimeout(poll, 5000); }
  }
  function markPaid() {
    win.clearTimeout(pollTimer);
    stopRing();
    const st = $('.uc-qd-status');
    if (st.classList.contains('ok')) return;
    st.classList.add('ok'); $('.uc-qd-st').textContent = '✓ Zaplaceno';
    paidShown = true;
    L('zaplaceno');
  }
  function back() {
    win.clearTimeout(pollTimer); stopRing(); publicId = null;
    if (paidShown) { f.message.value = ''; $('.uc-qd-count').textContent = `0 / ${MSG_MAX}`; paidShown = false; }
    $('.uc-qd-res').hidden = true; form.hidden = false;
    renderWho(); renderMail();
  }
  function downloadQr() {
    const svg = $('.uc-qd-qr svg');
    if (!svg) return;
    // SVG → PNG přes canvas (banky i telefony PNG berou líp než SVG).
    const img = new win.Image();
    const data = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new win.XMLSerializer().serializeToString(svg))}`;
    img.onload = () => {
      const size = 660, cv = doc.createElement('canvas'); cv.width = size; cv.height = size;
      const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size); ctx.drawImage(img, 0, 0, size, size);
      const a = doc.createElement('a'); a.href = cv.toDataURL('image/png'); a.download = `qr-dono-${$('.uc-qd-vs').textContent || 'kod'}.png`;
      doc.body.appendChild(a); a.click(); a.remove();
    };
    img.src = data;
  }

  // ---- kolečko kontroly banky (jako web: fáze = čas do dalšího dotazu serveru na banku) ----
  function startRing() {
    stopRing();
    const cc = currencyConfig(cfg, cur);
    ringPeriod = ((cc && cc.pollIntervalS) || cfg?.pollIntervalS || 10) * 1000;
    ringStart = Date.now();
    $('.uc-qd-ring').hidden = false;
    ringLoop();
  }
  function syncRing(bp) {
    if (!bp || !bp.intervalS) { if (bp && !bp.active) $('.uc-qd-ring').hidden = true; return; }
    const next = typeof bp.nextInMs === 'number' && Number.isFinite(bp.nextInMs) ? Date.now() + bp.nextInMs : Date.parse(bp.nextAt || '');
    if (!Number.isFinite(next)) return;
    ringPeriod = bp.intervalS * 1000; ringStart = next - ringPeriod;
    $('.uc-qd-ring').hidden = false;
    ringLoop();
  }
  function ringLoop() {
    if (ringRaf) return;
    const ringEl = $('.uc-qd-ring i'), numEl = $('.uc-qd-ring em');
    const frame = () => {
      if (!ringRaf) return;
      const elapsed = Date.now() - ringStart, t = elapsed >= 0 ? elapsed % ringPeriod : 0;
      ringEl.style.setProperty('--deg', `${(360 * t / ringPeriod).toFixed(2)}deg`);
      const left = (ringPeriod - t) / 1000, sec = Math.ceil(left);
      numEl.textContent = sec <= 9 && sec >= 1 ? String(sec) : '';
      numEl.style.opacity = sec <= 9 ? String(Math.max(0.15, Math.min(0.75, 0.15 + (9 - left) / 8 * 0.6))) : '0';
      ringRaf = win.requestAnimationFrame(frame);
    };
    ringRaf = win.requestAnimationFrame(frame);
  }
  function stopRing() { if (ringRaf) win.cancelAnimationFrame(ringRaf); ringRaf = null; const r = panel.querySelector('.uc-qd-ring'); if (r) r.hidden = true; }

  // ---- otevření / zavření ----
  function open() {
    panel.classList.remove('hidden');
    button.classList.add('active');
    button.setAttribute('aria-expanded', 'true');
    renderCurrency();
    loadConfig();
    loadProfile();
    // Verze nastavení každých 10 s (jako web), dokud je panel otevřený.
    win.clearInterval(versionTimer);
    versionTimer = win.setInterval(() => { if (!form.hidden) loadConfig(); else setNotice(cfg); }, 10_000);
    panel.focus();
    if (!$('.uc-qd-res').hidden && publicId) poll();
  }
  function close() {
    if (panel.classList.contains('hidden')) return;
    panel.classList.add('hidden');
    button.classList.remove('active');
    button.setAttribute('aria-expanded', 'false');
    win.clearInterval(versionTimer);
    win.clearTimeout(pollTimer);
    stopRing();
    stopSample();
    if (verifier) closeVerify();
  }
  const isOpen = () => !panel.classList.contains('hidden');

  // ---- události ----
  button.addEventListener('click', (e) => { e.stopPropagation(); isOpen() ? close() : open(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  f.amount.addEventListener('input', () => { f.amount.classList.remove('invalid'); updateCzk(); });
  for (const k of ['nickname', 'email']) f[k].addEventListener('input', () => f[k].classList.remove('invalid'));
  f.message.addEventListener('input', () => { f.message.classList.remove('invalid'); $('.uc-qd-count').textContent = `${f.message.value.length} / ${MSG_MAX}`; });
  f.voice.addEventListener('change', () => { f.voice.classList.remove('invalid'); stopSample(); updateSampleBtn(); });
  f.ttoken.addEventListener('input', () => {
    win.clearTimeout(tokenTimer);
    const t = f.ttoken.value.trim();
    if (!t) { tokenSeq++; setTestValid(false); return; }
    tokenTimer = win.setTimeout(() => checkToken(t), 500);   // debounce jako web
  });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act], [data-cur]');
    if (!b) { if (!e.target.closest('input, textarea, select')) panel.focus(); return; }
    if (b.dataset.cur && b.dataset.cur !== cur) {
      cur = b.dataset.cur;
      try { currency?.save?.(cur); } catch { /* ignore */ }
      renderCurrency();
      L(`měna ${cur}`);
    }
    const act = b.dataset.act;
    if (act === 'close') close();
    else if (act === 'login') onLogin?.();
    else if (act === 'back') back();
    else if (act === 'download') downloadQr();
    else if (act === 'sample') {
      if (sampleAudio) { stopSample(); return; }
      const v = selectedVoice();
      if (!v?.sampleUrl) return;
      sampleAudio = new win.Audio(v.sampleUrl);
      sampleAudio.onended = stopSample;
      sampleAudio.onerror = () => { L(`ukázka ${v.id} selhala`); stopSample(); };
      b.textContent = '■ zastavit'; b.classList.add('playing');
      sampleAudio.play().catch(() => stopSample());
    }
  });
  // Tajné gesto: „testmode“ napsané do aktivního panelu mimo pole formuláře.
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    // preventDefault: poslední „e“ by jinak spadlo do pole tokenu, kam se po odkrytí přesune fokus.
    if (detectTestmode(e.key)) { e.preventDefault(); revealTestMode(); }
  });
  const onDocDown = (e) => { if (isOpen() && !panel.contains(e.target) && !button.contains(e.target)) close(); };
  doc.addEventListener('mousedown', onDocDown);

  return {
    open, close, isOpen,
    toggle: () => (isOpen() ? close() : open()),
    /** Změna přihlášení / platformy u hostitele → překreslit „Tipuješ jako…“ a načíst profil. */
    refreshIdentity: () => { renderWho(); if (isOpen()) loadProfile(); },
    destroy() {
      close();
      doc.removeEventListener('mousedown', onDocDown);
      panel.remove();
    },
  };
}

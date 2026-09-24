// Zadání 6místného ověřovacího kódu (QR dono + párování e-mailu v nastavení) — addon i web.
// 6 samostatných políček: číslice posune kurzor dál, Backspace maže poslední číslici (a vrací
// se zpět), Ctrl+V vloží celý kód. Po poslední číslici / vložení se hned volá onComplete.

export const CODE_LEN = 6;

/** Z libovolného vloženého textu vytáhne číslice (max CODE_LEN). */
export function digitsOf(text) {
  return String(text ?? '').replace(/\D/g, '').slice(0, CODE_LEN);
}

/**
 * @param {HTMLElement} el  kontejner (vyprázdní se)
 * @param {{ onComplete(code: string): void }} o
 * @returns {{ clear(): void, focus(): void, setBusy(b: boolean): void, setError(b: boolean): void, value(): string }}
 */
export function mountCodeInput(el, { onComplete }) {
  const doc = el.ownerDocument;
  el.textContent = '';
  el.classList.add('uc-code');
  const boxes = Array.from({ length: CODE_LEN }, (_, i) => {
    const b = doc.createElement('input');
    b.inputMode = 'numeric';
    b.autocomplete = i === 0 ? 'one-time-code' : 'off';
    b.maxLength = 1;
    b.setAttribute('aria-label', `Číslice ${i + 1}`);
    el.appendChild(b);
    return b;
  });
  const value = () => boxes.map((b) => b.value).join('');
  let fired = '';
  const check = () => {
    const v = value();
    if (v.length === CODE_LEN && v !== fired) { fired = v; onComplete(v); }
    if (v.length < CODE_LEN) fired = '';
  };
  const fill = (from, digits) => {
    for (let i = 0; i < digits.length && from + i < CODE_LEN; i++) boxes[from + i].value = digits[i];
    boxes[Math.min(from + digits.length, CODE_LEN - 1)].focus();
    check();
  };
  boxes.forEach((b, i) => {
    b.addEventListener('input', () => {
      el.classList.remove('bad');
      const d = digitsOf(b.value);
      if (d.length > 1) { b.value = ''; fill(i, d); return; }   // autofill z telefonu / víc znaků naráz
      b.value = d;
      if (d && i < CODE_LEN - 1) boxes[i + 1].focus();
      check();
    });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace') {
        e.preventDefault();
        el.classList.remove('bad');
        // Smaže poslední vyplněnou číslici (ne tu pod kurzorem) a kurzor dá na její místo.
        let last = -1;
        for (let k = CODE_LEN - 1; k >= 0; k--) if (boxes[k].value) { last = k; break; }
        if (last >= 0) { boxes[last].value = ''; boxes[last].focus(); }
        fired = '';
      } else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); boxes[i - 1].focus(); }
      else if (e.key === 'ArrowRight' && i < CODE_LEN - 1) { e.preventDefault(); boxes[i + 1].focus(); }
      else if (e.key.length === 1 && !/\d/.test(e.key) && !e.ctrlKey && !e.metaKey) e.preventDefault();
    });
    b.addEventListener('paste', (e) => {
      const d = digitsOf(e.clipboardData?.getData('text'));
      if (!d) return;
      e.preventDefault();
      el.classList.remove('bad');
      // Celý kód vždy od prvního políčka, ať nezáleží, kam bylo kliknuto.
      for (const x of boxes) x.value = '';
      fill(0, d);
    });
    b.addEventListener('focus', () => b.select());
  });
  return {
    value,
    clear() { for (const b of boxes) b.value = ''; fired = ''; boxes[0].focus(); },
    focus() { (boxes.find((b) => !b.value) || boxes[CODE_LEN - 1]).focus(); },
    setBusy(busy) { for (const b of boxes) b.disabled = busy; el.classList.toggle('busy', busy); },
    setError(bad) { el.classList.toggle('bad', bad); },
  };
}

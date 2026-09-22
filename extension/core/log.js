// Logování v core modulech. Core nesmí sahat na chrome.runtime, tak dostane
// log(tag, text, extra?) injektovaný od slupky: addon ho mapuje na UC_LOG
// (background _logs[] → 💾 dump), web na console / debug overlay.
export const noopLog = () => {};

/** Obal, který zaručí, že chyba v logování nikdy neshodí volajícího. */
export function makeLog(fn) {
  if (typeof fn !== 'function') return noopLog;
  return (tag, text, extra) => {
    try { fn(tag, text, extra); } catch { /* log nesmí shodit provider */ }
  };
}

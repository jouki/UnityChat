// Formát data pro tooltip u času zprávy (pokyn usera 2026-09-30): „út 30. 9. 2026, 11:33:05“. Sdílené addonem i webem.
const DAYS = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

/** @param {number|string|Date} ts */
export function formatDateTooltip(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${DAYS[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

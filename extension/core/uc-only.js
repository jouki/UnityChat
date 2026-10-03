// Zpráva jen přes UnityChat (pokyn usera 2026-10-02, backend lib/ucOnly.ts + POST /chat/uc-only).
// Když se vlastní zpráva na platformu nepošle (chyba) nebo ji YouTube přijme a nezobrazí, host ji AUTOMATICKY pošle
// přes náš server: uvidí ji všichni v UnityChatu (addon, web, OBS) s logem UnityChatu místo loga platformy.
// Commandy (`!`, `/`) a GIF odkazy ne — bot je přes UnityChat nevidí, GIFy mají vlastní schvalování.
import { hasGifLink } from './gif-links.js';

const NAMES = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' };
const MARKER = '⠀';

/** Text bez markeru UnityChatu. */
export const ucOnlyText = (text) => String(text || '').replaceAll(MARKER, '').replace(/\s+/g, ' ').trim();

/** Smí neodeslaná zpráva jít jen přes UnityChat? */
export function ucOnlyEligible(text) {
  const t = ucOnlyText(text);
  return !!t && !t.startsWith('!') && !t.startsWith('/') && !hasGifLink(t);
}

/** Tooltip loga u zprávy jen přes UnityChat. */
export const ucOnlyTooltip = (platform) => `Jen v UnityChatu — ${NAMES[platform] || 'platforma'} zprávu nezveřejnil${platform === 'youtube' ? ' (zadržel ji filtr nebo neprošla)' : ''}`;

/** Vzhled vykreslené zprávy: logo UnityChatu místo loga platformy (CSS .uc-only-msg) + tooltip. */
export function applyUcOnlyLook(el, platform) {
  if (!el) return;
  el.classList.add('uc-only-msg');
  const pi = el.querySelector(':scope > .pi');
  if (pi) pi.dataset.tooltip = ucOnlyTooltip(platform);
}

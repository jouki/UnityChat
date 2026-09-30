// Twitch přes API (Helix /chat/messages) odmítne úplně první zprávu účtu v kanálu (`msg_rejected`, obecné „try again
// later“); na twitch.tv tatáž zpráva projde jako „First message“ a pak už jde i z UnityChatu (ověřeno 2026-09-28 na
// čerstvém účtu). Twitch důvod neřekne → odvodíme ho: od uživatele v kanálu nemáme v archivu ani jednu zprávu.
// Pak dostane česky, co udělat; jinak zůstává hláška Twitche.

export const TWITCH_FIRST_MESSAGE_TEXT = 'Twitch zprávu odmítl. Úplně první zprávu v tomhle kanálu musíš poslat přímo v chatu na Twitchi, pak už to půjde i odsud.';

export interface FirstMessageDeps {
  /** Má uživatel (platformUserId) v archivu kanálu aspoň jednu zprávu? */
  hasMessage: (channel: string, userId: string) => Promise<boolean>;
}

/** Je chyba odeslání na Twitch obecné odmítnutí (`msg_rejected`)? */
export const isTwitchRejected = (message: string): boolean => /\[msg_rejected\]/.test(String(message || ''));

/** Odmítnutí nejspíš kvůli první zprávě v kanálu? Chyba dotazu = false (radši původní hláška než zavádějící rada). */
export async function looksLikeFirstMessage(p: { channel: string; userId: string }, deps: FirstMessageDeps): Promise<boolean> {
  if (!p.userId || !p.channel) return false;
  return !(await deps.hasMessage(p.channel, p.userId).catch(() => true));
}

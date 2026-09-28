// Twitch přes API (Helix /chat/messages) odmítne úplně první zprávu účtu v kanálu (`msg_rejected`, obecné „try again
// later“); na twitch.tv tatáž zpráva projde jako „First message“ a pak už jde i z UnityChatu (ověřeno 2026-09-28 na
// čerstvém účtu). Twitch důvod neřekne → odvodíme ho: od uživatele v kanálu nemáme v archivu ani jednu zprávu, nebo
// je jeho účet mladší než 24 h. Pak dostane česky, co udělat; jinak zůstává hláška Twitche.

export const TWITCH_FIRST_MESSAGE_TEXT = 'Twitch zprávu odmítl. Úplně první zprávu v tomhle kanálu musíš poslat přímo v chatu na Twitchi, pak už to půjde i odsud.';
export const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;

export interface FirstMessageDeps {
  /** Má uživatel (platformUserId) v archivu kanálu aspoň jednu zprávu? */
  hasMessage: (channel: string, userId: string) => Promise<boolean>;
  /** Kdy vznikl Twitch účet (ms) — null = nezjištěno. */
  createdAt: (userId: string) => Promise<number | null>;
  now?: () => number;
}

/** Je chyba odeslání na Twitch obecné odmítnutí (`msg_rejected`)? */
export const isTwitchRejected = (message: string): boolean => /\[msg_rejected\]/.test(String(message || ''));

/**
 * Odmítnutí nejspíš kvůli první zprávě v kanálu? Chyba dotazů = false (radši původní hláška než zavádějící rada).
 */
export async function looksLikeFirstMessage(p: { channel: string; userId: string }, deps: FirstMessageDeps): Promise<boolean> {
  if (!p.userId || !p.channel) return false;
  const [has, created] = await Promise.all([
    deps.hasMessage(p.channel, p.userId).catch(() => true),
    deps.createdAt(p.userId).catch(() => null),
  ]);
  if (!has) return true;
  const now = (deps.now ?? Date.now)();
  return created !== null && now - created < NEW_ACCOUNT_MS;
}

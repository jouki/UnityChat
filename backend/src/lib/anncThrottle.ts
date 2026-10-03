// Announcement bez spamu (pokyn usera 2026-10-03): když command spustí divák BEZ UnityChatu a od posledního
// zobrazeného announcementu téhož commandu v kanálu neproběhlo aspoň ANNC_MIN_GAP_MESSAGES zpráv, announcement se
// v UnityChatu nezobrazí (ani do historie) a nic se neschovává — vidí se běžná odpověď bota. Uživatel UnityChatu ho
// dostane vždy. Počítají se zprávy UC kanálu ze všech platforem (bez botů).

export const ANNC_MIN_GAP_MESSAGES = 10;
const UC_SEEN_MS = 120_000;

export class AnncThrottle {
  private count = new Map<string, number>();                       // UC kanál → počet zpráv od startu
  private lastShown = new Map<string, number>();                   // `${kanál}\n${command}` → počet při posledním zobrazení
  private ucAuthors = new Map<string, number>();                   // `${platforma}:${jméno}` → kdy psal přes UnityChat
  constructor(private now: () => number = Date.now) {}

  /** Každá živá zpráva (onLive): počítadlo kanálu + autor přes UnityChat. */
  onMessage(ucChannel: string, m: { platform: string; username: string; isUnitychatUser?: boolean; isBot?: boolean }): void {
    const ch = ucChannel.toLowerCase();
    if (!m.isBot) this.count.set(ch, (this.count.get(ch) ?? 0) + 1);
    if (m.isUnitychatUser) this.noteUc(m.platform, m.username);
  }

  /** Zpráva dodatečně označená jako z UnityChatu (markUc po hlášení klienta). */
  noteUc(platform: string, username: string): void {
    this.ucAuthors.set(`${platform}:${String(username || '').replace(/^@/, '').toLowerCase()}`, this.now());
    if (this.ucAuthors.size > 2000) this.ucAuthors.delete(this.ucAuthors.keys().next().value!);
  }

  /** Psal autor v posledních 2 min přes UnityChat? */
  isUcAuthor(platform: string | undefined, username: string | undefined): boolean {
    if (!username) return false;
    const u = String(username).replace(/^@/, '').toLowerCase();
    const plats = platform ? [platform] : ['twitch', 'kick', 'youtube'];
    return plats.some((p) => { const at = this.ucAuthors.get(`${p}:${u}`); return at !== undefined && this.now() - at < UC_SEEN_MS; });
  }

  /**
   * Zobrazit announcement? true = ano (a zapamatuje si ho jako zobrazený), false = potlačit (spouštěč bez UnityChatu
   * a od posledního zobrazení téhož commandu méně než ANNC_MIN_GAP_MESSAGES zpráv).
   */
  decide(ucChannel: string, command: string, trigger: { user?: string; platform?: string } | null): { show: boolean; since: number | null; uc: boolean } {
    const ch = ucChannel.toLowerCase();
    const key = `${ch}\n${String(command || '').toLowerCase()}`;
    const cur = this.count.get(ch) ?? 0;
    const last = this.lastShown.get(key);
    const since = last === undefined ? null : cur - last;
    const uc = this.isUcAuthor(trigger?.platform, trigger?.user);
    const show = uc || since === null || since >= ANNC_MIN_GAP_MESSAGES;
    if (show) this.lastShown.set(key, cur);
    return { show, since, uc };
  }

  /** Jen pro testy. */
  _reset(): void { this.count.clear(); this.lastShown.clear(); this.ucAuthors.clear(); }
}

export const anncThrottle = new AnncThrottle();

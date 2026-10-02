// Kolo štěstí pro podporovatele (spec docs/superpowers/specs/2026-10-02-kolo-stesti-design.md).
// Stavový automat: open → (draw) pending → confirm → confirmed | lhůta → expired; confirmed / expired → draw → pending;
// end → ended (s výherci) / cancelled (bez). Jeden nekončený na kanál. Losuje server, jména jsou veřejná, id účtů ne.
// Úložiště, čas, náhoda, bot a ověření dárce jsou injektované (testy bez DB).
import { randomInt } from 'node:crypto';

export type GwStatus = 'open' | 'pending' | 'confirmed' | 'expired' | 'ended' | 'cancelled';
export const ACTIVE_STATUSES: readonly GwStatus[] = ['open', 'pending', 'confirmed', 'expired'];
export const CONFIRM_DEFAULT_MIN = 15;
export const CONFIRM_MAX_MIN = 120;
export const PRIZE_MAX = 100;
export const WHEEL_MAX_NAMES = 80;
/** Ukončené kolo se ještě ukazuje (výsledek), pak `null`. */
export const SHOW_ENDED_MS = 60_000;

export interface GwRow {
  id: number; channel: string; prize: string; confirmMinutes: number; status: GwStatus;
  winnerAccountId: number | null; winnerName: string | null; winnerPlatform: string | null;
  deadline: Date | null; drawSeq: number; createdBy: string; createdAt: Date; updatedAt: Date;
}
export interface GwEntry { accountId: number; name: string; platform: string; joinedAt: Date; excluded: boolean; won: boolean }

export interface GwRepo {
  /** Poslední kolo kanálu (nejvyšší id), i ukončené. */
  latest(channel: string): Promise<GwRow | null>;
  insert(v: Omit<GwRow, 'id' | 'createdAt' | 'updatedAt' | 'drawSeq' | 'winnerAccountId' | 'winnerName' | 'winnerPlatform' | 'deadline'>): Promise<GwRow>;
  update(id: number, patch: Partial<Omit<GwRow, 'id'>>): Promise<GwRow>;
  entries(id: number): Promise<GwEntry[]>;
  /** false = účet už přihlášený. */
  addEntry(id: number, e: Omit<GwEntry, 'excluded' | 'won'>): Promise<boolean>;
  patchEntry(id: number, accountId: number, patch: Partial<Pick<GwEntry, 'excluded' | 'won'>>): Promise<void>;
}

export interface PublicState {
  id: number; channel: string; prize: string; status: GwStatus; count: number; names: string[];
  winner: { name: string; platform: string } | null; deadline: number | null; drawSeq: number;
  winners: Array<{ name: string; platform: string }>; confirmMinutes: number; updatedAt: number;
}

export class GiveawayError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}

export interface DonorCheck { ok: boolean; name: string; platform: string }

export interface GiveawayDeps {
  repo: GwRepo;
  now?: () => number;
  /** [0, n) */
  random?: (n: number) => number;
  /** Veřejný stav po každé změně (SSE `giveaway`). */
  onChange?: (channel: string, state: PublicState | null) => void;
  /** Zpráva bota do chatu kanálu (všechny platformy; chyba jen do logu). */
  bot?: (channel: string, text: string) => void;
  /** Je účet podporovatel za 30 dní? `refresh` = smí obnovit seznam dárců ze Židolišty. Jméno pro kolo. */
  donorCheck: (accountId: number, channel: string, refresh: boolean) => Promise<DonorCheck>;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
  /** Časovač lhůty (testy: ruční spouštění). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

const isActive = (s: GwStatus) => ACTIVE_STATUSES.includes(s);

export class GiveawayService {
  private now: () => number;
  private random: (n: number) => number;
  private timers = new Map<string, unknown>();
  /** Zámek per kanál — přechody za sebou (dvojklik „Losovat“, join během losování). */
  private chains = new Map<string, Promise<unknown>>();

  constructor(private d: GiveawayDeps) {
    this.now = d.now ?? Date.now;
    this.random = d.random ?? ((n) => randomInt(n));
  }

  private locked<T>(channel: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(channel) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.chains.set(channel, next.catch(() => {}));
    return next;
  }

  /** Aktivní kolo (s dorovnáním prošlé lhůty), jinak null. */
  private async active(channel: string): Promise<GwRow | null> {
    let row = await this.d.repo.latest(channel);
    if (!row || !isActive(row.status)) return null;
    if (row.status === 'pending' && row.deadline && row.deadline.getTime() <= this.now()) row = await this.expireRow(row);
    return row;
  }

  private async expireRow(row: GwRow): Promise<GwRow> {
    if (row.winnerAccountId != null) await this.d.repo.patchEntry(row.id, row.winnerAccountId, { excluded: true });
    const next = await this.d.repo.update(row.id, { status: 'expired', deadline: null, updatedAt: new Date(this.now()) });
    this.d.log?.info({ channel: row.channel, id: row.id, winner: row.winnerName }, 'giveaway: lhůta vypršela');
    this.d.bot?.(row.channel, `Lhůta na potvrzení vypršela (${row.winnerName}), losuje se znovu.`);
    return next;
  }

  async publicState(channel: string): Promise<PublicState | null> {
    const row = await this.active(channel) ?? await this.d.repo.latest(channel);
    if (!row) return null;
    if (!isActive(row.status) && this.now() - row.updatedAt.getTime() > SHOW_ENDED_MS) return null;
    return this.toPublic(row, await this.d.repo.entries(row.id));
  }

  toPublic(row: GwRow, entries: GwEntry[]): PublicState {
    const pool = entries.filter((e) => !e.excluded && !e.won);
    // Kolo v `pending` ukazuje pool, ze kterého se losovalo (výherce v něm je, dokud nepotvrdí / nevyprší).
    return {
      id: row.id, channel: row.channel, prize: row.prize, status: row.status,
      count: row.status === 'open' ? entries.length : pool.length,
      names: pool.slice(0, WHEEL_MAX_NAMES).map((e) => e.name),
      winner: row.winnerName && (row.status === 'pending' || row.status === 'confirmed') ? { name: row.winnerName, platform: row.winnerPlatform || '' } : null,
      deadline: row.status === 'pending' && row.deadline ? row.deadline.getTime() : null,
      drawSeq: row.drawSeq,
      winners: entries.filter((e) => e.won).map((e) => ({ name: e.name, platform: e.platform })),
      confirmMinutes: row.confirmMinutes, updatedAt: row.updatedAt.getTime(),
    };
  }

  private async emit(channel: string): Promise<PublicState | null> {
    const s = await this.publicState(channel);
    this.d.onChange?.(channel, s);
    return s;
  }

  async me(channel: string, accountId: number): Promise<{ joined: boolean; isWinner: boolean; eligible: boolean }> {
    const row = await this.active(channel);
    const entries = row ? await this.d.repo.entries(row.id) : [];
    const mine = entries.find((e) => e.accountId === accountId);
    const eligible = row?.status === 'open' && !mine ? (await this.d.donorCheck(accountId, channel, false)).ok : !!mine;
    return { joined: !!mine, isWinner: !!row && row.status === 'pending' && row.winnerAccountId === accountId, eligible };
  }

  start(channel: string, by: string, prize: string, confirmMinutes?: number): Promise<PublicState> {
    return this.locked(channel, async () => {
      const p = prize.trim().replace(/\s+/g, ' ').slice(0, PRIZE_MAX);
      if (!p) throw new GiveawayError('prize', 400);
      const m = Math.round(Number(confirmMinutes ?? CONFIRM_DEFAULT_MIN));
      if (!Number.isFinite(m) || m < 1 || m > CONFIRM_MAX_MIN) throw new GiveawayError('confirm_minutes', 400);
      if (await this.active(channel)) throw new GiveawayError('active', 409);
      await this.d.repo.insert({ channel, prize: p, confirmMinutes: m, status: 'open', createdBy: by });
      this.d.log?.info({ channel, by, prize: p, confirmMinutes: m }, 'giveaway: vyhlášeno');
      this.d.bot?.(channel, `Kolo štěstí: ${p}! Připojit se můžou podporovatelé z posledních 30 dní tlačítkem v UnityChatu.`);
      return (await this.emit(channel))!;
    });
  }

  join(channel: string, accountId: number): Promise<PublicState> {
    return this.locked(channel, async () => {
      const row = await this.active(channel);
      if (!row || row.status !== 'open') throw new GiveawayError('not_open', 409);
      if ((await this.d.repo.entries(row.id)).some((e) => e.accountId === accountId)) return (await this.publicState(channel))!;
      let dc = await this.d.donorCheck(accountId, channel, false);
      // Donate poslaný po vyhlášení: cache dárců je z pětiminutové obnovy → jednou obnovit a zkusit znovu.
      if (!dc.ok) dc = await this.d.donorCheck(accountId, channel, true);
      if (!dc.ok) { this.d.log?.info({ channel, id: row.id, accountId, name: dc.name }, 'giveaway: připojení odmítnuto (není podporovatel)'); throw new GiveawayError('not_donor', 403); }
      await this.d.repo.addEntry(row.id, { accountId, name: dc.name, platform: dc.platform, joinedAt: new Date(this.now()) });
      this.d.log?.info({ channel, id: row.id, accountId, name: dc.name }, 'giveaway: připojení');
      return (await this.emit(channel))!;
    });
  }

  draw(channel: string, by: string): Promise<PublicState> {
    return this.locked(channel, async () => {
      const row = await this.active(channel);
      if (!row) throw new GiveawayError('no_giveaway', 404);
      if (row.status === 'pending') throw new GiveawayError('pending', 409);
      const pool = (await this.d.repo.entries(row.id)).filter((e) => !e.excluded && !e.won);
      if (!pool.length) throw new GiveawayError('no_entries', 409);
      const w = pool[this.random(pool.length)];
      const deadline = new Date(this.now() + row.confirmMinutes * 60_000);
      await this.d.repo.update(row.id, { status: 'pending', winnerAccountId: w.accountId, winnerName: w.name, winnerPlatform: w.platform, deadline, drawSeq: row.drawSeq + 1, updatedAt: new Date(this.now()) });
      this.d.log?.info({ channel, id: row.id, by, pool: pool.length, winner: w.name }, 'giveaway: vylosováno');
      this.d.bot?.(channel, `Kolo štěstí vybralo: ${w.name}! Výhru (${row.prize}) je potřeba potvrdit v UnityChatu do ${row.confirmMinutes} min.`);
      this.schedule(channel, deadline.getTime() - this.now());
      return (await this.emit(channel))!;
    });
  }

  confirm(channel: string, accountId: number): Promise<PublicState> {
    return this.locked(channel, async () => {
      const row = await this.active(channel);
      if (!row || row.status !== 'pending' || row.winnerAccountId !== accountId) throw new GiveawayError('not_winner', 403);
      await this.d.repo.patchEntry(row.id, accountId, { won: true });
      await this.d.repo.update(row.id, { status: 'confirmed', deadline: null, updatedAt: new Date(this.now()) });
      this.clearSchedule(channel);
      this.d.log?.info({ channel, id: row.id, winner: row.winnerName }, 'giveaway: výhra potvrzena');
      this.d.bot?.(channel, `Výhra potvrzena: ${row.winnerName} (${row.prize}).`);
      return (await this.emit(channel))!;
    });
  }

  end(channel: string, by: string): Promise<PublicState | null> {
    return this.locked(channel, async () => {
      const row = await this.active(channel);
      if (!row) throw new GiveawayError('no_giveaway', 404);
      const won = (await this.d.repo.entries(row.id)).some((e) => e.won);
      await this.d.repo.update(row.id, { status: won ? 'ended' : 'cancelled', deadline: null, updatedAt: new Date(this.now()) });
      this.clearSchedule(channel);
      this.d.log?.info({ channel, id: row.id, by, won }, 'giveaway: ukončeno');
      return this.emit(channel);
    });
  }

  /** Po startu serveru: naplánovat lhůty rozběhnutých kol (prošlé dorovná první čtení). */
  async resume(channels: string[]): Promise<void> {
    for (const ch of channels) {
      const row = await this.d.repo.latest(ch);
      if (row?.status === 'pending' && row.deadline) this.schedule(ch, row.deadline.getTime() - this.now());
    }
  }

  /** Lhůta vypršela: přepnout a ohlásit (časovač). */
  async tick(channel: string): Promise<void> {
    await this.locked(channel, async () => {
      const row = await this.d.repo.latest(channel);
      if (row?.status === 'pending' && row.deadline && row.deadline.getTime() <= this.now()) { await this.expireRow(row); await this.emit(channel); }
    });
  }

  private schedule(channel: string, ms: number): void {
    this.clearSchedule(channel);
    const set = this.d.setTimer ?? ((fn: () => void, t: number) => { const h = setTimeout(fn, t); h.unref?.(); return h; });
    this.timers.set(channel, set(() => { this.timers.delete(channel); void this.tick(channel).catch((e) => this.d.log?.warn({ channel, err: (e as Error).message }, 'giveaway: lhůta selhala')); }, Math.max(0, ms) + 250));
  }

  private clearSchedule(channel: string): void {
    const t = this.timers.get(channel);
    if (t != null) (this.d.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(t);
    this.timers.delete(channel);
  }
}

/** Úložiště v paměti (testy). */
export function memoryRepo(): GwRepo & { rows: GwRow[]; ents: Map<number, GwEntry[]> } {
  const rows: GwRow[] = [];
  const ents = new Map<number, GwEntry[]>();
  return {
    rows, ents,
    async latest(channel) { return [...rows].reverse().find((r) => r.channel === channel) ?? null; },
    async insert(v) { const r: GwRow = { ...v, id: rows.length + 1, drawSeq: 0, winnerAccountId: null, winnerName: null, winnerPlatform: null, deadline: null, createdAt: new Date(), updatedAt: new Date() }; rows.push(r); ents.set(r.id, []); return { ...r }; },
    async update(id, patch) { const r = rows.find((x) => x.id === id)!; Object.assign(r, patch); return { ...r }; },
    async entries(id) { return (ents.get(id) || []).map((e) => ({ ...e })); },
    async addEntry(id, e) { const l = ents.get(id)!; if (l.some((x) => x.accountId === e.accountId)) return false; l.push({ ...e, excluded: false, won: false }); return true; },
    async patchEntry(id, accountId, patch) { const e = ents.get(id)?.find((x) => x.accountId === accountId); if (e) Object.assign(e, patch); },
  };
}

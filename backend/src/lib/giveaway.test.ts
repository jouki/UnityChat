import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GiveawayService, GiveawayError, memoryRepo, SHOW_ENDED_MS, type PublicState } from './giveaway.js';

function setup(opts: { donors?: number[]; lateDonors?: number[] } = {}) {
  let now = Date.parse('2026-10-02T18:00:00Z');
  const repo = memoryRepo();
  const bot: string[] = [];
  const states: Array<PublicState | null> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const refreshes: number[] = [];
  const donors = new Set(opts.donors ?? [1, 2, 3]);
  let pick = 0;
  const svc = new GiveawayService({
    repo,
    now: () => now,
    random: (n) => Math.min(pick, n - 1),
    bot: (_ch, t) => bot.push(t),
    onChange: (_ch, s) => states.push(s),
    donorCheck: async (acc, _ch, refresh) => {
      if (refresh) { refreshes.push(acc); for (const d of opts.lateDonors ?? []) donors.add(d); }
      return { ok: donors.has(acc), name: `User${acc}`, platform: 'twitch' };
    },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  return { svc, repo, bot, states, timers, refreshes, advance: (ms: number) => { now += ms; }, setPick: (i: number) => { pick = i; } };
}

const err = (code: string) => (e: unknown) => e instanceof GiveawayError && e.code === code;

test('giveaway: vyhlášení → přihlášky → losování → potvrzení → další výherce ze zbytku → konec', async () => {
  const t = setup();
  const s0 = await t.svc.start('rob', 'twitch:mod', '  Klíč   ke hře ', 10);
  assert.equal(s0.status, 'open');
  assert.equal(s0.prize, 'Klíč ke hře');
  assert.match(t.bot[0], /^Kolo štěstí: Klíč ke hře! Připojit se můžou podporovatelé/);
  await assert.rejects(t.svc.start('rob', 'x', 'jiné'), err('active'));
  for (const a of [1, 2, 3]) await t.svc.join('rob', a);
  await t.svc.join('rob', 1);   // podruhé = nic
  const open = await t.svc.publicState('rob');
  assert.equal(open?.count, 3);
  assert.deepEqual(open?.names, ['User1', 'User2', 'User3']);
  assert.equal(JSON.stringify(open).includes('accountId'), false, 'veřejný stav bez id účtů');

  t.setPick(1);
  const d1 = await t.svc.draw('rob', 'twitch:mod');
  assert.equal(d1.status, 'pending');
  assert.deepEqual(d1.winner, { name: 'User2', platform: 'twitch' });
  assert.equal(d1.drawSeq, 1);
  assert.equal(d1.deadline, Date.parse('2026-10-02T18:10:00Z'));
  assert.match(t.bot.at(-1)!, /vybralo: User2! .*do 10 min/);
  await assert.rejects(t.svc.join('rob', 4), err('not_open'), 'po losování přihlášky zavřené');
  await assert.rejects(t.svc.draw('rob', 'x'), err('pending'));
  await assert.rejects(t.svc.confirm('rob', 1), err('not_winner'));
  assert.deepEqual(await t.svc.me('rob', 2), { joined: true, isWinner: true, eligible: true });

  const c = await t.svc.confirm('rob', 2);
  assert.equal(c.status, 'confirmed');
  assert.deepEqual(c.winners, [{ name: 'User2', platform: 'twitch' }]);
  assert.match(t.bot.at(-1)!, /^Výhra potvrzena: User2 \(Klíč ke hře\)\.$/);

  t.setPick(0);
  const d2 = await t.svc.draw('rob', 'x');
  assert.equal(d2.winner?.name, 'User1', 'výherce už není v poolu');
  assert.deepEqual(d2.names, ['User1', 'User3']);
  assert.equal(d2.drawSeq, 2);
  await t.svc.confirm('rob', 1);
  const e = await t.svc.end('rob', 'x');
  assert.equal(e?.status, 'ended');
  t.advance(SHOW_ENDED_MS + 1);
  assert.equal(await t.svc.publicState('rob'), null, 'ukončené kolo po minutě zmizí');
  await t.svc.start('rob', 'x', 'další kolo');   // nové kolo jde
});

test('giveaway: jen podporovatel; donate po vyhlášení → obnova seznamu a připojení', async () => {
  const t = setup({ donors: [1], lateDonors: [5] });
  await t.svc.start('rob', 'x', 'Výhra');
  await assert.rejects(t.svc.join('rob', 9), err('not_donor'));
  assert.deepEqual(t.refreshes, [9], 'nedárce → jedna obnova');
  const t2 = setup({ donors: [1], lateDonors: [5] });
  await t2.svc.start('rob', 'x', 'Výhra');
  const s = await t2.svc.join('rob', 5);
  assert.equal(s.count, 1);
  assert.deepEqual(t2.refreshes, [5], 'donate po vyhlášení: ve staré cache ne → obnova → připojen');
  assert.deepEqual(await t.svc.me('rob', 9), { joined: false, isWinner: false, eligible: false });
});

test('giveaway: lhůta vyprší → výherce vyřazen, ohlášeno, losuje se znovu bez něj; prázdný pool = no_entries', async () => {
  const t = setup();
  await t.svc.start('rob', 'x', 'Výhra', 15);
  await t.svc.join('rob', 1);
  await t.svc.join('rob', 2);
  await t.svc.draw('rob', 'x');   // pick 0 → User1
  assert.equal(t.timers.at(-1)!.ms, 15 * 60_000 + 250);
  t.advance(15 * 60_000 + 1);
  t.timers.at(-1)!.fn();
  await new Promise((r) => setTimeout(r, 10));
  const s = await t.svc.publicState('rob');
  assert.equal(s?.status, 'expired');
  assert.equal(s?.winner, null);
  assert.deepEqual(s?.names, ['User2']);
  assert.match(t.bot.at(-1)!, /^Lhůta na potvrzení vypršela \(User1\), losuje se znovu\.$/);
  await assert.rejects(t.svc.confirm('rob', 1), err('not_winner'), 'po lhůtě už potvrdit nejde');
  const d = await t.svc.draw('rob', 'x');
  assert.equal(d.winner?.name, 'User2');
  t.advance(16 * 60_000);
  // Bez časovače (restart serveru): prošlou lhůtu dorovná čtení stavu.
  assert.equal((await t.svc.publicState('rob'))?.status, 'expired');
  await assert.rejects(t.svc.draw('rob', 'x'), err('no_entries'));
  const end = await t.svc.end('rob', 'x');
  assert.equal(end?.status, 'cancelled', 'bez potvrzeného výherce = zrušeno');
});

test('giveaway: validace vyhlášení, akce bez kola', async () => {
  const t = setup();
  await assert.rejects(t.svc.start('rob', 'x', '   '), err('prize'));
  await assert.rejects(t.svc.start('rob', 'x', 'a', 0), err('confirm_minutes'));
  await assert.rejects(t.svc.start('rob', 'x', 'a', 121), err('confirm_minutes'));
  await assert.rejects(t.svc.draw('rob', 'x'), err('no_giveaway'));
  await assert.rejects(t.svc.end('rob', 'x'), err('no_giveaway'));
  await assert.rejects(t.svc.join('rob', 1), err('not_open'));
  const s = await t.svc.start('rob', 'x', 'x'.repeat(300));
  assert.equal(s.prize.length, 100);
  assert.equal(s.confirmMinutes, 15);
});

test('giveaway: souběžné „Losovat“ (dvojklik) vylosuje jen jednou', async () => {
  const t = setup();
  await t.svc.start('rob', 'x', 'Výhra');
  await t.svc.join('rob', 1);
  await t.svc.join('rob', 2);
  const r = await Promise.allSettled([t.svc.draw('rob', 'a'), t.svc.draw('rob', 'b')]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal((await t.svc.publicState('rob'))?.drawSeq, 1);
});

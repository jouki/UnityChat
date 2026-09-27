// Test core/anniversary.js — texty výročí (tři tvary, převod měsíců na roky jako Twitch), výběr výzvy,
// pamatované zavření výročí předplatného (jen dané id), chybové hlášky, HTML události modiversary.
// Podklad: docs/superpowers/specs/2026-09-27-twitch-vyroci-research.md. Spuštění: node scripts/test-anniversary.js
const assert = require('assert');
const A = require('../extension/core/anniversary.js');

// ---- tři tvary ----
assert.equal(A.annivMonths(1), '1 měsíc');
assert.equal(A.annivMonths(3), '3 měsíce');
assert.equal(A.annivMonths(5), '5 měsíců');
assert.equal(A.annivMonths(22), '22 měsíců', 'čeština: 22 měsíců (ne „měsíce“) — pravidlo 2–4 jen pro 2, 3, 4');
assert.equal(A.annivYears(1), '1 rok');
assert.equal(A.annivYears(2), '2 roky');
assert.equal(A.annivYears(4), '4 roky');
assert.equal(A.annivYears(5), '5 let');

// ---- modiversary v chatu: months % 12 == 0 → roky, jinak měsíce (Twitch ModiversaryLine) ----
assert.equal(A.modiversaryDuration(12), '1 rok');
assert.equal(A.modiversaryDuration(24), '2 roky');
assert.equal(A.modiversaryDuration(60), '5 let');
assert.equal(A.modiversaryDuration(18), '18 měsíců');
assert.equal(A.modiversaryDuration(1), '1 měsíc');
assert.equal(A.modiversaryDuration(3), '3 měsíce');
assert.deepEqual(A.modiversaryParts(36), { lead: 'je už ', strong: '3 roky', tail: ' moderátorem!' });
assert.equal(A.modiversaryText('Pepa', 12), 'Pepa je už 1 rok moderátorem!');
assert.equal(A.modiversaryText('Pepa', 5), 'Pepa je už 5 měsíců moderátorem!');
assert.equal(A.modiversaryText('Pepa', 0), 'Pepa slaví moderátorské výročí!', 'bez počtu měsíců obecný text');

// ---- výzva nad polem ----
assert.equal(A.modiversaryCalloutTitle(12), 'Blahopřejeme k 1letému moderátorskému výročí!');
assert.equal(A.modiversaryCalloutTitle(36), 'Blahopřejeme k 3letému moderátorskému výročí!');
assert.equal(A.modiversaryCalloutTitle(6), 'Blahopřejeme k moderátorskému výročí: 6 měsíců!');
assert.equal(A.modiversaryCalloutTitle(14), 'Blahopřejeme k moderátorskému výročí: 1 rok a 2 měsíce!');
assert.equal(A.modiversarySharePrefill(24), 'Oslavuji 2leté moderátorské výročí!');
assert.equal(A.modiversarySharePrefill(7), 'Oslavuji moderátorské výročí: 7 měsíců!');
assert.equal(A.resubCalloutTitle(7), 'Předplatné: 7 měsíců!');
assert.equal(A.resubCalloutTitle(2), 'Předplatné: 2 měsíce!');
assert.equal(A.resubCalloutTitle(1), 'Předplatné: 1 měsíc!');
assert.equal(A.RESUB_CALLOUT_SUB, 'Sdílej to v chatu');
assert.equal(A.resubStreakLabel(5), 'Zobrazit v chatové zprávě mou 5měsíční sérii');
assert.equal(A.resubSharePrefill({ isGift: true, gifter: 'Dárce' }), 'Děkuji za dárek, @Dárce!');
assert.equal(A.resubSharePrefill({ isGift: false }), '');
assert.equal(A.resubSharePrefill({ isGift: true, gifter: '' }), '', 'anonymní dárce → bez předvyplnění');
assert.equal(A.ANNIV_MAX_LEN, 500);

// ---- výběr výzvy: resub má přednost, zavření resubu platí jen pro jeho id ----
const status = {
  ok: true, loggedIn: true, userId: '4242', channelId: '160028137',
  resub: { id: 'rn-7', months: 7, streak: 3, isGift: false, gifter: null },
  modiversary: { months: 24 },
};
assert.deepEqual(A.pickAnniversary(status, {}), { kind: 'resub', key: 'resub:rn-7', id: 'rn-7', months: 7, streak: 3, isGift: false, gifter: null });
assert.deepEqual(A.pickAnniversary(status, { 'resub:rn-7': { at: 1, type: 'dismissed' } }), { kind: 'mod', key: 'mod:4242:160028137:24', months: 24 },
  'zavřený resub → další výzva (mod)');
const nextMonth = { ...status, resub: { id: 'rn-8', months: 8, streak: 4, isGift: false, gifter: null }, modiversary: null };
assert.equal(A.pickAnniversary(nextMonth, { 'resub:rn-7': { at: 1, type: 'dismissed' } })?.key, 'resub:rn-8', 'nové výročí (jiné id) se ukáže, i když předchozí bylo zavřené');
assert.equal(A.pickAnniversary({ ...status, resub: null, modiversary: null }, {}), null);
assert.equal(A.pickAnniversary({ ...status, resub: null, modiversary: { months: 0 } }, {}), null, 'mod bez měsíců nic');
assert.equal(A.pickAnniversary({ ok: true, loggedIn: false }, {}), null);
assert.equal(A.pickAnniversary({ ok: false }, {}), null);
assert.equal(A.pickAnniversary(status, { 'resub:rn-7': {}, 'mod:4242:160028137:24': {} }), null);
// Úklid: záznamy starší než 400 dní pryč, ostatní zůstávají.
const now = Date.UTC(2026, 8, 27);
const pruned = A.annivPruneDismissed({ 'resub:old': { at: now - 401 * 864e5 }, 'resub:new': { at: now - 10 * 864e5 }, broken: null }, now);
assert.deepEqual(Object.keys(pruned), ['resub:new']);

// ---- chyby ----
assert.match(A.annivErrorText('ALREADY_SENT'), /už .*sdílen/i);
assert.match(A.annivErrorText('NOT_USER_MODIVERSARY'), /moderátorské výročí/);
assert.match(A.annivErrorText('integrity'), /zkus to přímo na Twitchi/);
assert.match(A.annivErrorText('not_logged_in'), /Twitch/);
assert.match(A.annivErrorText('whatever'), /nepovedlo/);
assert.equal(A.ANNIV_INTEGRITY_TEXT, 'Sdílet se teď nepovedlo, zkus to přímo na Twitchi.');

// ---- HTML události modiversary (web / OBS; addon staví DOM ze stejných částí) ----
const html = A.modiversaryEventHtml({ modMonths: 24 }, { nameHtml: '<span class="un">Pepa</span>', bodyHtml: 'dva roky <img class="emote">' });
assert.ok(html.includes('class="modiv-icon"') && html.includes('<svg'), 'ikona meče');
assert.ok(html.includes('<span class="un">Pepa</span> je už <strong>2 roky</strong> moderátorem!'), html);
assert.ok(html.includes('<div class="modiv-text tx">dva roky <img class="emote"></div>'), 'text uživatele pod tím');
assert.ok(!A.modiversaryEventHtml({ modMonths: 1 }, { nameHtml: 'X', bodyHtml: '' }).includes('modiv-text'), 'bez textu bez řádku');
assert.ok(A.modiversaryEventHtml({ modMonths: '<b>' }, { nameHtml: 'X', bodyHtml: '' }).includes('slaví'), 'nečíselné měsíce → obecný text, nic se neinterpoluje');

// ---- mod výzva: jiný Twitch účet = jiný klíč (zavření jednoho účtu neplatí pro druhý) ----
assert.equal(A.pickAnniversary({ ...status, userId: '999', resub: null }, { 'mod:4242:160028137:24': {} })?.key, 'mod:999:160028137:24');

// ---- karta sub / resub česky, tři tvary ----
assert.equal(A.subLineHtml({ subPlan: '1000', subMonths: 7, subStreak: 3 }),
  '<strong>Předplatné</strong> <strong class="sub-tier">Tier 1</strong>. Celkem <strong>7 měsíců</strong>, <strong>3 měsíce v řadě</strong>.');
assert.equal(A.subLineHtml({ subPlan: 'Prime', subMonths: 22, subStreak: 2 }),
  '<strong>Předplatné</strong> <strong class="sub-tier-prime">Prime</strong>. Celkem <strong>22 měsíců</strong>, <strong>2 měsíce v řadě</strong>.');
assert.equal(A.subLineHtml({ subPlan: '3000', subMonths: 1 }), '<strong>Předplatné</strong> <strong class="sub-tier">Tier 3</strong>.', 'první měsíc bez počtu');
assert.equal(A.subLineHtml({ subPlan: '2000', subMonths: 5, subStreak: 1 }), '<strong>Předplatné</strong> <strong class="sub-tier">Tier 2</strong>. Celkem <strong>5 měsíců</strong>.', 'série 1 se nevypisuje');

// ---- řádek výročí v Profilu ----
assert.equal(A.annivProfileLabel({ isSubEvent: true, subMonths: 7, subStreak: 3 }), 'Výročí předplatného: 7 měsíců (série 3)');
assert.equal(A.annivProfileLabel({ isSubEvent: true, subMonths: 2 }), 'Výročí předplatného: 2 měsíce');
assert.equal(A.annivProfileLabel({ isSubEvent: true, subMonths: 1 }), 'Nové předplatné');
assert.equal(A.annivProfileLabel({ isModiversary: true, modMonths: 24 }), 'Moderátorské výročí: 2 roky');
assert.equal(A.annivProfileLabel({ isModiversary: true, modMonths: 5 }), 'Moderátorské výročí: 5 měsíců');
assert.equal(A.annivProfileLabel({ message: 'ahoj' }), null);

// ---- czPlural z malého modulu, user-history ho re-exportuje (jeden zdroj) ----
const P = require('../extension/core/plural.js');
assert.equal(P.czPlural(3, 'a', 'b', 'c'), 'b');
assert.equal(require('../extension/core/user-history.js').czPlural, P.czPlural);

console.log('test-anniversary: OK');

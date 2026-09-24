// node scripts/test-soundboard.js — čisté funkce soundboardu (core/soundboard.js)
const assert = require('node:assert/strict');

(async () => {
  const sb = await import('../extension/core/soundboard.js');
  const T0 = Date.parse('2026-09-24T12:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const raw = (me, extra = {}) => ({
    channel: 'robdiesalot', platform: 'twitch', loggedIn: true, serverNow: iso(T0),
    tiers: [{ tier: 1, name: null }, { tier: 2, name: 'Speciální' }],
    sounds: [
      { id: 1, name: 'wololo', tier: 1, emoji: '🙏', url: 'https://z/1.mp3' },
      { id: 2, name: 'ahShit', tier: 1, emoji: null, url: 'https://z/2.mp3' },
      { id: 3, name: 'finishHim', tier: 2, emoji: null, url: 'https://z/3.mp3' },
    ],
    me, favorites: [3, 99], recent: [2], ...extra,
  });
  const meWith = (tiers, cooldown = {}) => ({ platform: 'twitch', userId: '42', login: 'jouki728', role: 'sub', tiers, cooldown });

  // normalize: posun hodin, oblíbené jen existující zvuky
  const s0 = sb.normalizeSoundboard(raw(null), T0 - 5000);
  assert.equal(s0.offsetMs, 5000, 'serverNow − klient');
  assert.deepEqual(s0.favorites, [3], 'neznámé id z oblíbených pryč');

  // stavy tlačítka
  assert.equal(sb.soundboardIconState(sb.normalizeSoundboard(raw(null, { sounds: [] })), T0).mode, 'hidden');
  assert.equal(sb.soundboardIconState(sb.normalizeSoundboard(raw(null, { loggedIn: false })), T0).mode, 'login');
  const link = sb.soundboardIconState(sb.normalizeSoundboard(raw(null, { platform: 'kick' })), T0);
  assert.equal(link.mode, 'link');
  assert.match(link.lines[0], /Kick/);
  assert.equal(sb.soundboardIconState(sb.normalizeSoundboard(raw(meWith([]))), T0).mode, 'locked');

  // odemčení: tier 1 na 10 min (od T0−4 min), tier 2 vypršel
  const st = sb.normalizeSoundboard(raw(meWith([
    { tier: 1, startedAt: iso(T0 - 240_000), expiresAt: iso(T0 + 360_000) },
    { tier: 2, startedAt: iso(T0 - 600_000), expiresAt: iso(T0 - 1) },
  ])), T0);
  const u = sb.unlockedTiers(st, T0);
  assert.deepEqual([...u.keys()], [1], 'vypršelý tier se nepočítá');
  const act = sb.soundboardIconState(st, T0);
  assert.equal(act.mode, 'active');
  assert.equal(act.remainingMs, 360_000);
  assert.ok(Math.abs(act.progress - 0.6) < 1e-9, 'progress = zbývá / celkem');
  assert.equal(sb.soundboardIconState(st, T0 + 360_000).mode, 'locked', 'po vypršení zamčeno');

  // neomezený tier → remaining null
  const un = sb.normalizeSoundboard(raw(meWith([{ tier: 2, startedAt: iso(T0), expiresAt: null }, { tier: 1, startedAt: iso(T0), expiresAt: iso(T0 + 60_000) }])), T0);
  const ua = sb.soundboardIconState(un, T0);
  assert.equal(ua.remainingMs, null);
  assert.equal(ua.rows.find((r) => r.tier === 2).name, 'Tier 2 · Speciální');

  // cooldown: delší z globálního a mého
  const cd = sb.normalizeSoundboard(raw(meWith([{ tier: 1, startedAt: iso(T0), expiresAt: null }], { globalReadyAt: iso(T0 + 4000), userReadyAt: iso(T0 + 12_000) })), T0);
  assert.equal(sb.cooldownLeft(cd, T0), 12_000);
  assert.equal(sb.cooldownLeft(cd, T0 + 20_000), 0);

  // SSE: cizí přehrání posune jen globální, moje i osobní + recent
  let e = sb.applySoundboardEvent(cd, 'soundboard-played', { platform: 'twitch', userId: '7', soundId: 1, globalReadyAt: iso(T0 + 10_000), userReadyAt: iso(T0 + 30_000) });
  assert.equal(e.me.cooldown.globalReadyAt, T0 + 10_000);
  assert.equal(e.me.cooldown.userReadyAt, T0 + 12_000, 'cizí nesahá na můj osobní');
  assert.deepEqual(e.recent, [2]);
  e = sb.applySoundboardEvent(cd, 'soundboard-played', { platform: 'twitch', userId: '42', soundId: 1, globalReadyAt: iso(T0 + 10_000), userReadyAt: iso(T0 + 30_000) });
  assert.equal(e.me.cooldown.userReadyAt, T0 + 30_000);
  assert.deepEqual(e.recent, [1, 2], 'moje přehrání nahoru do často používaných');
  e = sb.applySoundboardEvent(cd, 'soundboard-played', { platform: 'kick', userId: '42', soundId: 1, globalReadyAt: iso(T0 + 10_000), userReadyAt: iso(T0 + 30_000) });
  assert.equal(e.me.cooldown.userReadyAt, T0 + 12_000, 'stejné id na jiné platformě není moje');
  e = sb.applySoundboardEvent(cd, 'soundboard-denied', { platform: 'twitch', userId: '42', name: 'finishHim', reason: 'locked' });
  assert.equal(e.denied.reason, 'locked');
  assert.equal(sb.applySoundboardEvent(cd, 'soundboard-denied', { platform: 'twitch', userId: '7', reason: 'locked' }).denied, null, 'cizí zamítnutí ignorovat');

  // hledání: bez diakritiky a velikosti, začátek první
  assert.deepEqual(sb.searchSounds(st.sounds, 'SH').map((s) => s.name), ['ahShit', 'finishHim']);
  assert.deepEqual(sb.searchSounds(st.sounds, 'fin').map((s) => s.name), ['finishHim']);
  assert.deepEqual(sb.searchSounds(st.sounds, ''), []);

  // název tieru: nezdvojovat „Tier 1 · Tier 1“
  assert.equal(sb.tierLabel({ tiers: [{ tier: 1, name: 'Tier 1' }] }, 1), 'Tier 1');
  assert.equal(sb.tierLabel({ tiers: [{ tier: 1, name: 'tier 1 ' }] }, 1), 'Tier 1');
  assert.equal(sb.tierLabel({ tiers: [{ tier: 2, name: 'Speciální' }] }, 2), 'Tier 2 · Speciální');

  // display name + ikona
  assert.equal(sb.soundLabel({ name: 'cejtimPicu', displayName: 'Cejtím to' }), 'Cejtím to');
  assert.equal(sb.soundLabel({ name: 'boom', displayName: '  ' }), 'boom');
  assert.deepEqual(sb.searchSounds([{ name: 'cejtimPicu', displayName: 'Bulharský hymnus' }], 'bulhar').map((s) => s.name), ['cejtimPicu'], 'hledání i podle displayName bez diakritiky');
  assert.match(sb.soundIconHtml({ icon: { kind: '7tv', name: 'RAGEY', url: 'https://cdn.7tv.app/emote/01F7JCJ0D80007RBBSW6MHGEVC/2x.webp' } }), /<img class="uc-sb-img"/);
  assert.equal(sb.soundIconHtml({ icon: { kind: '7tv', url: 'https://evil.example/x.webp' } }), '', 'cizí host se nevykreslí');
  assert.match(sb.soundIconHtml({ emoji: '🍺' }), /🍺/, 'staré pole emoji');

  // kontrakt v1.1: zmrazený tier — čas stojí, přehrát nejde
  const pz = sb.normalizeSoundboard(raw(meWith([{ tier: 1, startedAt: iso(T0 - 60_000), expiresAt: iso(T0 + 999_999), paused: true, remainingMs: 272_000, totalMs: 600_000, available: false }])), T0);
  assert.equal(pz.me.tiers[0].expiresAt, null, 'u zmrazeného se expiresAt ignoruje');
  assert.deepEqual([...sb.unlockedTiers(pz, T0 + 3_600_000).keys()], [1], 'zmrazený nevyprší');
  assert.equal(sb.playableTiers(pz, T0).size, 0, 'zmrazený není hratelný');
  const pzs = sb.soundboardIconState(pz, T0 + 50_000);
  assert.equal(pzs.mode, 'paused');
  assert.equal(pzs.rows[0].remainingMs, 272_000, 'zamrzlý čas se neodpočítává');
  assert.ok(Math.abs(pzs.rows[0].progress - 272 / 600) < 1e-9);
  // jeden tier zmrazený, druhý běží → aktivní, hratelný jen běžící
  const mix = sb.normalizeSoundboard(raw(meWith([
    { tier: 1, startedAt: iso(T0), expiresAt: iso(T0 + 60_000) },
    { tier: 2, startedAt: iso(T0), paused: true, remainingMs: 30_000 },
  ])), T0);
  assert.equal(sb.soundboardIconState(mix, T0).mode, 'active');
  assert.deepEqual([...sb.playableTiers(mix, T0)], [1]);
  assert.equal(sb.tierTime(mix.me.tiers[1], T0).paused, true);

  // formát času
  assert.equal(sb.formatRemaining(12_300), '13 s');
  assert.equal(sb.formatRemaining(272_000), '4:32');
  assert.equal(sb.formatRemaining(3_730_000), '1:02:10');
  assert.equal(sb.formatRemaining(-5), '0 s');

  console.log('test-soundboard: OK');
})().catch((e) => { console.error(e); process.exit(1); });

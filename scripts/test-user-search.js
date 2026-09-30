// Testy core/user-search.js (`/user <jméno>` — našeptávač uživatelů kanálu pro moda):
// parsování příkazu, řazení, sloučení session + server, debounce, zrušení starého dotazu, cache.
// Spuštění: node scripts/test-user-search.js
import('../extension/core/user-search.js').then(async (us) => {
  let fails = 0;
  const check = (n, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !detail ? '' : ` — ${detail}`)); if (!ok) fails++; };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // --- příkaz ---
  check('parseUserCommand: /user @Zigi', eq(us.parseUserCommand('/user @Zigi '), { query: 'Zigi' }));
  check('parseUserCommand: jen /user', eq(us.parseUserCommand('/user'), { query: '' }) && eq(us.parseUserCommand('/USER '), { query: '' }));
  check('parseUserCommand: jiný text / /users / /uc', us.parseUserCommand('ahoj /user x') === null && us.parseUserCommand('/users x') === null && us.parseUserCommand('/uc raid') === null);
  check('parseUserCommand: max 40 znaků', us.parseUserCommand('/user ' + 'a'.repeat(60)).query.length === 40);

  // --- řazení ---
  const h = (login, lastSeen, extra = {}) => ({ platform: 'twitch', userId: login, login, displayName: login, lastSeen, count: 1, ...extra });
  check('userMatchRank: přesná / začátek / jinde, bez diakritiky', us.userMatchRank(h('zigi'), 'ZIGI') === 0 && us.userMatchRank(h('zigi2'), 'zigi') === 1 && us.userMatchRank(h('azigi'), 'zigi') === 2 && us.userMatchRank(h('x', 0, { nickname: 'Žigi' }), 'zigi') === 0);
  check('rankUserHits', eq(us.rankUserHits([h('azigi', 99), h('zigi187', 1), h('zigi2', 50), h('zigi', 0)], 'zigi').map((x) => x.login), ['zigi', 'zigi2', 'zigi187', 'azigi']));
  check('userMatches: prefix vs fulltext', us.userMatches(h('azig'), 'zig', false) === false && us.userMatches(h('azig'), 'zig', true) === true);

  // --- session + server ---
  const local = us.localUserHits([
    { platform: 'twitch', login: 'Tester', displayName: 'Tester', userId: null, color: '#123456' },
    { platform: 'twitch', login: 'tester', displayName: 'Tester' },
    { platform: 'kick', login: 'zed', displayName: 'Zed' },
  ], 'te', { nickname: (p, l) => (l === 'zed' ? 'Teodor' : null) });
  check('localUserHits: dedup platforma+login, přezdívka se hledá taky', eq(local.map((x) => `${x.platform}:${x.login}:${x.nickname || ''}`), ['twitch:tester:', 'kick:zed:Teodor']));
  const merged = us.mergeUserHits(local, [{ platform: 'twitch', userId: 'u1', login: 'tester', displayName: 'Tester', lastSeen: 5, count: 9 }], 'te');
  const t = merged.find((x) => x.login === 'tester');
  check('mergeUserHits: server doplní userId/počet, barva ze session zůstane, bez duplicit', merged.length === 2 && t.userId === 'u1' && t.count === 9 && t.color === '#123456', JSON.stringify(merged));
  check('mergeUserHits: limit', us.mergeUserHits([], [h('a1', 1), h('a2', 2), h('a3', 3)], 'a', 2).length === 2);

  // --- render ---
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = us.userSearchItemHtml({ platform: 'kick', login: 'azig', displayName: 'Azig', nickname: '<b>', color: '#0f0' }, { esc, platformIcon: (p) => `icons/platform/${p}.svg` });
  check('userSearchItemHtml: escapuje, logo, přezdívka + login', html.includes('&lt;b&gt;') && html.includes('icons/platform/kick.svg') && html.includes('es-login">Azig') && html.includes('background:#0f0'), html);

  // --- UserSearch: debounce, zrušení, cache ---
  const timers = [];
  const st = (fn) => { timers.push(fn); return timers.length; };
  const ct = (id) => { timers[id - 1] = null; };
  const flush = async () => { const fns = timers.splice(0).filter(Boolean); for (const f of fns) await f(); };
  const calls = [];
  const aborted = [];
  const results = [];
  const s = new us.UserSearch({
    api: async (path, { signal }) => { calls.push(path); signal?.addEventListener('abort', () => aborted.push(path)); return { ok: true, users: [{ platform: 'twitch', userId: 'u9', login: 'zigi187', displayName: 'Zigi187', lastSeen: 1, count: 1 }] }; },
    channel: () => 'robdiesalot',
    local: () => [],
    onResults: (r) => results.push(r),
    setTimeout: st, clearTimeout: ct,
  });
  s.query('z'); s.query('zi'); s.query('zig');
  check('debounce: lokální výsledky hned (loading), server až po čase', results.length === 3 && results.every((r) => r.loading) && calls.length === 0);
  await flush();
  check('debounce: jen jeden dotaz na poslední text', calls.length === 1 && /q=zig&fulltext=0/.test(calls[0]) && /channel=robdiesalot/.test(calls[0]), calls.join(' | '));
  check('výsledek ze serveru', results.at(-1).loading === false && results.at(-1).users[0]?.login === 'zigi187');
  const n = results.length;
  s.query('zig');
  check('cache: stejný dotaz bez serveru, hned', calls.length === 1 && results.length === n + 1 && results.at(-1).loading === false);
  s.query('zig', true);
  check('fulltext = jiný klíč cache', timers.filter(Boolean).length === 1);
  await flush();
  check('fulltext=1 v dotazu', /fulltext=1/.test(calls.at(-1)));
  // Pomalá odpověď: novější dotaz zruší starší (abort) a stará odpověď se nepoužije.
  let release;
  const slow = new us.UserSearch({
    api: (path, { signal }) => new Promise((res) => { signal?.addEventListener('abort', () => aborted.push(path)); if (path.includes('q=a&')) release = () => res({ ok: true, users: [h('stary', 1)] }); else res({ ok: true, users: [h('novy', 1)] }); }),
    channel: () => 'x', local: () => [], onResults: (r) => results.push(r), setTimeout: st, clearTimeout: ct,
  });
  const fire = () => { for (const f of timers.splice(0).filter(Boolean)) f(); };
  slow.query('a');
  fire();
  slow.query('ab');
  check('nový dotaz zruší běžící požadavek', aborted.some((p) => p.includes('q=a&')));
  fire();
  await new Promise((r) => setTimeout(r, 0));
  release();
  await new Promise((r) => setTimeout(r, 0));
  check('stará odpověď se nepoužije', results.at(-1).users[0]?.login === 'novy' && !results.some((r) => r.users[0]?.login === 'stary'));
  const errS = new us.UserSearch({ api: async () => { throw { error: 'not_mod', status: 403 }; }, channel: () => 'x', local: () => [h('lokal', 1)], onResults: (r) => results.push(r), setTimeout: st, clearTimeout: ct });
  errS.query('lok');
  await flush();
  check('chyba serveru: zůstanou lokální + error', results.at(-1).error?.status === 403 && results.at(-1).users[0]?.login === 'lokal');
  s.query('');
  check('prázdný dotaz = prázdný seznam', results.at(-1).users.length === 0 && !results.at(-1).loading);

  console.log(fails ? `\n${fails} FAIL` : '\nvše PASS');
  process.exit(fails ? 1 : 0);
});

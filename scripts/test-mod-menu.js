// Testy čistých částí nabídky moda (extension/core/mod-menu.js), štítku moderace uživatele
// (core/moderation.js) a varování účtu (core/account-warnings.js).
// Spuštění: node scripts/test-mod-menu.js
Promise.all([
  import('../extension/core/mod-menu.js'),
  import('../extension/core/moderation.js'),
  import('../extension/core/account-warnings.js'),
]).then(async ([mm, mod, aw]) => {
  let fails = 0;
  const check = (n, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !detail ? '' : ` — ${detail}`)); if (!ok) fails++; };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // --- délky ---
  check('TIMEOUT_OPTIONS dle specu', eq(mm.TIMEOUT_OPTIONS, [5, 30, 60, 300, 600, 1800, 3600, 7200]));
  check('PERMIT_OPTIONS dle specu', eq(mm.PERMIT_OPTIONS, [30, 60, 120, 300, 600]));
  const fmt = mm.TIMEOUT_OPTIONS.map(mod.fmtDuration);
  check('fmtDuration timeoutů', eq(fmt, ['5 s', '30 s', '1 min', '5 min', '10 min', '30 min', '1 h', '2 h']), fmt.join('|'));
  check('fmtDuration vlastní délky přesně', mod.fmtDuration(90) === '1 min 30 s' && mod.fmtDuration(9000) === '2 h 30 min' && mod.fmtDuration(90061) === '1 den 1 h', [90, 9000, 90061].map(mod.fmtDuration).join('|'));
  check('customDurationSec: jednotky, min 1, strop', mm.customDurationSec(3, 60, mm.MAX_TIMEOUT_SEC) === 180 && mm.customDurationSec(0, 1, 100) === null && mm.customDurationSec(25, 3600, mm.MAX_PERMIT_SEC) === null && mm.customDurationSec(24, 3600, mm.MAX_PERMIT_SEC) === 86400 && mm.customDurationSec('x', 1, 10) === null);
  check('menuModel: timeout i permit mají vlastní délku', mm.menuModel().filter((i) => i.custom).map((i) => i.id + ':' + i.custom.max).join(',') === 'timeout:1209600,permit:86400');
  check('fmtDuration 1 h 30 min / dny', mod.fmtDuration(5400) === '1 h 30 min' && mod.fmtDuration(86400) === '1 den' && mod.fmtDuration(3 * 86400) === '3 dny' && mod.fmtDuration(14 * 86400) === '14 dní');

  // --- štítek ---
  check('modTagText ban', mod.modTagText({ action: 'ban' }) === 'Zabanován');
  check('modTagText timeout durationSec', mod.modTagText({ action: 'timeout', durationSec: 300 }) === 'Timeout (5 min)');
  check('modTagText timeout until - at', mod.modTagText({ action: 'timeout', until: 1790000300000, at: 1790000000000 }) === 'Timeout (5 min)');
  check('modTagText timeout until - at (ISO)', mod.modTagText({ action: 'timeout', until: Date.parse('2026-09-25T10:01:00Z'), at: '2026-09-25T10:00:00Z' }) === 'Timeout (1 min)');
  check('modTagText timeout until bez at → now', mod.modTagText({ action: 'timeout', until: 1000 + 600_000, now: 1000 }) === 'Timeout (10 min)');
  check('modTagText timeout bez délky', mod.modTagText({ action: 'timeout' }) === 'Timeout');
  check('modTagText unban = null', mod.modTagText({ action: 'unban' }) === null);

  // --- normalizeUserModerated ---
  const ev = { channel: 'RobDiesALot', platform: 'kick', userId: 77, login: '@Spammer_K', action: 'timeout', until: 1790000060000, by: 'twitch:modik', at: 1790000000000 };
  const n = mod.normalizeUserModerated(ev, 'robdiesalot');
  check('normalize: kanál case-insensitive, userId string, login lowercase bez @', n && n.userId === '77' && n.login === 'spammer_k' && n.tag === 'Timeout (1 min)', JSON.stringify(n));
  check('normalize: cizí kanál → null', mod.normalizeUserModerated(ev, 'jiny') === null);
  check('normalize: bez kanálu v události → null (když host kanál zná)', mod.normalizeUserModerated({ ...ev, channel: undefined }, 'robdiesalot') === null);
  check('normalize: channel param vynechán → bez kontroly (lokální CLEARCHAT)', !!mod.normalizeUserModerated({ ...ev, channel: undefined }));
  check('normalize: neznámá akce → null', mod.normalizeUserModerated({ ...ev, action: 'nuke' }, 'robdiesalot') === null);
  check('normalize: bez userId i loginu → null', mod.normalizeUserModerated({ ...ev, userId: null, login: '' }, 'robdiesalot') === null);
  check('normalize: unban → tag null', mod.normalizeUserModerated({ ...ev, action: 'unban', until: null }, 'robdiesalot')?.tag === null);

  // --- chyby / výsledky ---
  check('modErrorText target_protected', mm.modErrorText({ error: 'target_protected', status: 403 }) === 'Na streamera nebo moda to nejde.');
  for (const code of ['not_mod', 'no_actor', 'bad_login', 'nickname_blacklisted', 'rate_limited', 'not_found', 'self']) {
    const t = mm.modErrorText({ error: code, status: 400 });
    check(`modErrorText ${code} česky`, !t.startsWith('Akce selhala') && t.endsWith('.'), t);
  }
  check('modErrorText 401 bez kódu', mm.modErrorText({ error: 'HTTP 401', status: 401 }).includes('Přihlášení vypršelo'));
  check('modErrorText neznámé', mm.modErrorText({ error: 'boom', status: 500 }) === 'Akce selhala (boom).');
  check('formatResults podle specu', mm.formatResults({ youtube: 'error:no_actor', kick: 'ok', twitch: 'ok' }) === 'Twitch ✓ · Kick ✓ · YouTube ✗ bot není mod',
    mm.formatResults({ youtube: 'error:no_actor', kick: 'ok', twitch: 'ok' }));
  check('formatResults bot + Kick zaokrouhlení + HTTP kód', mm.formatResults({ twitch: 'bot', kick: 'ok', youtube: 'error:403' }, { notes: { kick: 'rounded_to_minutes:1' } })
    === 'Twitch ✓ (bot) · Kick ✓ (zaokrouhleno na 1 min) · YouTube ✗ platforma odmítla (403)');
  check('formatResults varování', mm.formatResults({ unitychat: 'no_account', twitch: 'ok' }) === 'Twitch ✓ · UnityChat ✗ nemá účet UnityChatu');

  // --- validace ---
  check('validateNickname prázdná = smazat', mm.validateNickname('  ').nickname === null && !mm.validateNickname('').error);
  check('validateNickname trim', mm.validateNickname('  Pan Spam ').nickname === 'Pan Spam');
  check('validateNickname > 30', !!mm.validateNickname('x'.repeat(31)).error);
  check('validateWarnReason povinný', !!mm.validateWarnReason('   ').error && !mm.validateWarnReason(' ok ').error && mm.validateWarnReason(' ok ').reason === 'ok');
  check('validateWarnReason > 500', !!mm.validateWarnReason('x'.repeat(501)).error);

  // --- požadavky (kontrakt) ---
  const t = { channel: 'RobDiesALot', platform: 'twitch', userId: 123, login: 'spammer' };
  check('state GET', eq(mm.buildModRequest('state', t), { path: '/moderation/user-state?channel=robdiesalot&platform=twitch&userId=123', method: 'GET' }));
  check('timeout body', eq(mm.buildModRequest('timeout', t, { durationSec: 300 }), { path: '/moderation/user', method: 'POST', body: { channel: 'robdiesalot', platform: 'twitch', userId: '123', login: 'spammer', action: 'timeout', durationSec: 300 } }));
  check('ban body', eq(mm.buildModRequest('ban', t).body, { channel: 'robdiesalot', platform: 'twitch', userId: '123', login: 'spammer', action: 'ban' }));
  check('unban body', mm.buildModRequest('unban', t).body.action === 'unban');
  check('warn body', eq(mm.buildModRequest('warn', t, { reason: 'Nespamuj' }), { path: '/moderation/warn', method: 'POST', body: { channel: 'robdiesalot', platform: 'twitch', userId: '123', login: 'spammer', reason: 'Nespamuj' } }));
  check('permit body', eq(mm.buildModRequest('permit', t, { durationSec: 120 }).body, { channel: 'robdiesalot', platform: 'twitch', userId: '123', login: 'spammer', durationSec: 120 }));
  check('permit body s messageId (obnovení zprávy smazané filtrem)', eq(mm.buildModRequest('permit', { ...t, messageId: 'm9' }, { durationSec: 60 }).body, { channel: 'robdiesalot', platform: 'twitch', userId: '123', login: 'spammer', durationSec: 60, messageId: 'm9' }));
  check('rename PUT', eq(mm.buildModRequest('rename', t, { nickname: 'Pan Spam', color: '#ff8800' }), { path: '/moderation/nickname', method: 'PUT', body: { channel: 'robdiesalot', platform: 'twitch', login: 'spammer', nickname: 'Pan Spam', color: '#ff8800' } }));
  check('rename smazání → nickname null, color null', eq(mm.buildModRequest('rename', t, { nickname: null, color: '#ff8800' }).body, { channel: 'robdiesalot', platform: 'twitch', login: 'spammer', nickname: null, color: null }));

  // --- model nabídky ---
  const ids = (items) => items.map((i) => i.id).join(',');
  check('menuModel výchozí', ids(mm.menuModel({})) === 'delete,timeout,ban,rename,warn,permit');
  check('menuModel banned → Unban místo Timeout/Ban', ids(mm.menuModel({ banned: true })) === 'delete,unban,rename,warn,permit');
  check('menuModel bez zprávy → bez Smazat', ids(mm.menuModel({ canDelete: false })) === 'timeout,ban,rename,warn,permit');
  const noId = mm.menuModel({ hasUserId: false });
  check('menuModel bez userId → jen Přejmenovat a Smazat aktivní', noId.filter((i) => !i.disabled).map((i) => i.id).join(',') === 'delete,rename');
  check('menuModel podnabídka timeoutu', eq(mm.menuModel({})[1].sub.map((s) => s.label), fmt));
  check('menuModel podnabídka permitu', eq(mm.menuModel({}).find((i) => i.id === 'permit').sub.map((s) => s.durationSec), [30, 60, 120, 300, 600]));

  // --- Chat historie (core/user-history.js) ---
  check('menuModel s historií → Profil první', ids(mm.menuModel({ history: true })) === 'history,delete,timeout,ban,rename,warn,permit');
  check('menuModel smazaná zpráva → Odkrýt místo Smazat', ids(mm.menuModel({ history: true, deleted: true })) === 'history,restore,timeout,ban,rename,warn,permit'
    && mm.menuModel({ deleted: true })[0].label === 'Odkrýt zprávu');
  check('menuModel smazaná bez potvrzené zprávy → ani Odkrýt', !mm.menuModel({ deleted: true, canDelete: false }).some((i) => i.id === 'restore' || i.id === 'delete'));
  check('buildModRequest restore', eq(mm.buildModRequest('restore', { channel: 'RobDiesALot', platform: 'kick', login: 'x', messageId: 42 }), { path: '/moderation/restore', method: 'POST', body: { channel: 'robdiesalot', platform: 'kick', messageId: '42' } }));
  check('summarize restore ok / not_deleted', mm.summarizeModResult('restore', { login: 'spammer' }, { result: 'ok' }) === 'Zpráva od spammer odkryta v UnityChatu (na platformě zůstává smazaná).'
    && mm.summarizeModResult('restore', { login: 'spammer' }, { result: 'not_deleted' }) === 'Zpráva od spammer není v archivu smazaná ani skrytá.');
  check('modErrorText gif_pending', mm.modErrorText({ error: 'gif_pending', status: 409 }) === 'O zprávě s GIFem rozhoduje karta ke schválení.');
  {
    const calls = [];
    const menu = new mm.ModMenu({ doc: {}, api: async (path, o) => { calls.push([path, o]); const e = { error: 'not_found', status: 404 }; throw e; } });
    const texts = [];
    menu.notify = (t, info) => texts.push([t, info.ok]);
    await menu.run('restore', { platform: 'twitch', login: 'x', messageId: 'm1' });
    check('ModMenu.run restore 404 → „Zpráva v archivu chatu není.“', texts[0]?.[0] === 'Zpráva v archivu chatu není.' && texts[0][1] === false && calls[0][0] === '/moderation/restore');
    const m2 = new mm.ModMenu({ doc: {}, api: async () => ({}) });
    m2.target = { platform: 'twitch', login: 'x', messageId: 'm1', userId: '1', deleted: true };
    m2._state = { banned: false };
    check('ModMenu model: target.deleted → restore', m2._model().some((i) => i.id === 'restore') && !m2._model().some((i) => i.id === 'delete'));
  }
  check('menuModel historie bez userId → neaktivní', mm.menuModel({ history: true, hasUserId: false }).find((i) => i.id === 'history').disabled === true);
  {
    const uh = await import('../extension/core/user-history.js');
    check('czPlural / fmtMsgCount 3 tvary', [0, 1, 2, 4, 5, 22, 1234].map(uh.fmtMsgCount).join('|') === `0 zpráv|1 zpráva|2 zprávy|4 zprávy|5 zpráv|22 zpráv|${(1234).toLocaleString('cs-CZ')} zpráv`, [0, 1, 2, 4, 5, 22, 1234].map(uh.fmtMsgCount).join('|'));
    const at = new Date(2026, 8, 25, 14, 5).getTime();
    check('fmtDateTime', uh.fmtDateTime(at) === '25. 9. 2026 14:05' && uh.fmtDateTime(at, { withTime: false }) === '25. 9. 2026' && uh.fmtDateTime(null) === '');
    const ht = { channel: 'RobDiesALot', platform: 'twitch', userId: 123, login: 'spammer' };
    check('history summary GET', eq(uh.buildHistoryRequest('summary', ht), { path: '/moderation/user-history/summary?channel=robdiesalot&platform=twitch&userId=123&login=spammer', method: 'GET' }));
    check('history messages GET', uh.buildHistoryRequest('messages', ht, { inChannel: 'ArcadeBulls', before: '17:5', limit: 50 }).path === '/moderation/user-history/messages?channel=robdiesalot&platform=twitch&userId=123&login=spammer&inChannel=arcadebulls&before=17%3A5&limit=50');
    check('modActionLabel', [
      { action: 'timeout', params: { durationSec: 600 } }, { action: 'ban', params: {} }, { action: 'warn', params: { reason: 'x' } },
      { action: 'permit', params: { durationSec: 60 } }, { action: 'rename', params: { nickname: 'Pan' } }, { action: 'rename', params: { nickname: null } },
    ].map(uh.modActionLabel).join('|') === 'Timeout 10 min|Ban|Varování|Permit 1 min|Přezdívka „Pan“|Přezdívka smazána');
    check('actorLabel', uh.actorLabel('twitch:modik') === 'modik (Twitch)' && uh.actorLabel('zidolista:5') === 'Židolišta');
    check('statsText', uh.statsText({ firstSeen: at, lastSeen: at, total: 3 }) === 'Poprvé viděn 25. 9. 2026 · naposledy 25. 9. 2026 14:05 · celkem 3 zprávy');
    const s = uh.stripUcMarker({ message: 'ahoj ⠀', kickContent: 'ahoj ⠀' });
    check('stripUcMarker → bez markeru + uc', s.uc && s.msg.message === 'ahoj' && s.msg.kickContent === 'ahoj' && !uh.stripUcMarker({ message: 'x' }).uc);
    const opened = [];
    const menu = new mm.ModMenu({ doc: {}, api: async () => ({}), onHistory: (tt) => opened.push(tt) });
    menu.target = ht;
    check('ModMenu model s onHistory má položku', menu._model().some((i) => i.id === 'history') && !new mm.ModMenu({ doc: {}, api: async () => ({}) })._model.call({ target: ht, _state: {}, onHistory: undefined }).some((i) => i.id === 'history'));
    menu._activate({ id: 'history' });
    check('ModMenu „Profil" → onHistory(target)', opened[0] === ht);
    check('menuModel: položka se jmenuje „Profil"', mm.menuModel({ history: true }).find((i) => i.id === 'history').label === 'Profil');

    // --- Profil: formáty, požadavky, dona ---
    const NB = '\u00a0';
    check('fmtNumber / fmtAmount / fmtMoney', uh.fmtNumber(1250) === `1${NB}250` && uh.fmtNumber(12.5) === '12,5' && uh.fmtAmount(1250, 'CZK') === `1${NB}250${NB}Kč`
      && uh.fmtMoney({ czk: 1750, byCurrency: { EUR: 20, CZK: 1250 } }) === `1${NB}250${NB}Kč + 20${NB}€` && uh.fmtMoney({ czk: 150, byCurrency: {} }) === `150${NB}Kč`);
    check('fmtDay / fmtTime (oddělovač dnů + čas u zprávy)', uh.fmtDay(new Date(2026, 8, 24, 10, 0).getTime()) === 'čtvrtek 24. 9. 2026' && uh.fmtTime(at) === '14:05');
    check('dayKey stejný den / jiný den', uh.dayKey(new Date(2026, 8, 24, 0, 1).getTime()) === uh.dayKey(new Date(2026, 8, 24, 23, 59).getTime()) && uh.dayKey(new Date(2026, 8, 24).getTime()) !== uh.dayKey(new Date(2026, 8, 25).getTime()));
    const dm = uh.donationsSummary({ total: { czk: 1750, byCurrency: { CZK: 1250, EUR: 20 } }, count: 3, uc: { czk: 1500, count: 2 }, guess: { czk: 250, byCurrency: { CZK: 250 }, count: 1 } });
    check('donationsSummary mod: celkem + „z toho … jen podle jména"', dm.main === `Celkem darováno 1${NB}250${NB}Kč + 20${NB}€` && dm.sub === `z toho 250${NB}Kč jen podle jména`, JSON.stringify(dm));
    check('donationsSummary divák: jen ucNamed', uh.donationsSummary({ ucNamed: { czk: 1000, count: 1 } }).main === `Celkem darováno 1${NB}000${NB}Kč` && uh.donationsSummary({ ucNamed: { czk: 0, count: 0 } }) === null && uh.donationsSummary(undefined) === null && uh.donationsSummary({ count: 0, total: { czk: 0 } }) === null);
    check('donationLine', uh.donationLine({ amount: 150, currency: 'CZK', via: 'qr' }) === `poslal QR dono 150${NB}Kč` && uh.donationLine({ amount: 20, currency: 'EUR', via: 'fourthwall' }) === `poslal dono přes Fourthwall 20${NB}€`);
    check('statsText jen aktuální kanál (veřejný Profil)', uh.statsText({ firstSeen: at, lastSeen: at, total: 1 }, { channelOnly: true }) === 'V tomto kanálu: poprvé viděn 25. 9. 2026 · naposledy 25. 9. 2026 14:05 · celkem 1 zpráva');
    check('history summary jen podle loginu (bez userId)', uh.buildHistoryRequest('summary', { channel: 'robdiesalot', platform: 'kick', userId: null, login: 'Spam' }).path === '/moderation/user-history/summary?channel=robdiesalot&platform=kick&login=Spam');
    check('history donations GET', uh.buildHistoryRequest('donations', ht).path === '/moderation/user-history/donations?channel=robdiesalot&platform=twitch&userId=123&login=spammer');
    check('messageTarget z řádku Profilu', eq(uh.messageTarget({ platform: 'kick', id: 'm1', userId: 7, username: 'Spam' }, { channel: 'robdiesalot', login: 'x' }), { channel: 'robdiesalot', platform: 'kick', userId: '7', login: 'Spam', displayName: 'Spam', messageId: 'm1' }));
  }

  // --- moderace účtem: akce botem / no_actor + chybějící scopes → nabídka přihlášení ---
  check('modScopePlatforms: bot / no_actor jen s chybějícími scopes', eq(mm.modScopePlatforms({ twitch: 'error:no_actor', kick: 'bot', youtube: 'error:no_actor' }, { twitch: ['moderator:manage:chat_messages'], kick: [] }), ['twitch']));
  check('modScopePlatforms: ok / bez scopes info → nic', mm.modScopePlatforms({ twitch: 'ok' }, { twitch: ['x'] }).length === 0 && mm.modScopePlatforms({ twitch: 'bot' }, {}).length === 0);
  check('modScopePrompt Twitch = obnovení přihlášení, Kick = povolit moderaci', mm.modScopePrompt('twitch', 'error:no_actor').action === 'Obnovit přihlášení (moderace)' && mm.modScopePrompt('kick', 'bot').action === 'Povolit moderaci účtem'
    && mm.modScopePrompt('twitch', 'error:no_actor').text === 'Na Twitchi se akce nepovedla — tvůj účet nemá oprávnění moderovat.' && mm.modScopePrompt('kick', 'bot').text === 'Na Kicku akci provedl bot — tvůj účet nemá oprávnění moderovat.');
  check('buildModRequest delete', eq(mm.buildModRequest('delete', { channel: 'Rob', platform: 'twitch', messageId: 'abc', login: 'x' }), { path: '/moderation/delete', method: 'POST', body: { channel: 'rob', platform: 'twitch', messageId: 'abc' } }));
  check('summarize delete', mm.summarizeModResult('delete', { login: 'x', displayName: 'X', platform: 'twitch' }, { result: 'bot' }) === 'Zpráva od X smazána: Twitch ✓ (bot)');
  {
    const scopes = [], results = [];
    const menu = new mm.ModMenu({ doc: {}, api: async (path) => (path === '/moderation/delete' ? { ok: true, result: 'error:no_actor' } : { ok: true, results: { twitch: 'error:no_actor', kick: 'ok' } }),
      missingScopes: () => ({ twitch: ['moderator:manage:banned_users'] }), onModScopes: (p, prompt, info) => scopes.push(`${p}:${info.kind}:${prompt.action}`) });
    const off = menu.onResult((kind, tt) => results.push(`${kind}:${tt.messageId || tt.userId}`));
    await menu.run('timeout', { channel: 'rob', platform: 'twitch', userId: 'u1', login: 'x' }, { durationSec: 60 });
    await menu.run('delete', { channel: 'rob', platform: 'twitch', messageId: 'm9', login: 'x' });
    check('ModMenu: no_actor + chybějící scopes → onModScopes (timeout i mazání)', eq(scopes, ['twitch:timeout:Obnovit přihlášení (moderace)', 'twitch:delete:Obnovit přihlášení (moderace)']), JSON.stringify(scopes));
    check('ModMenu.onResult: odběratelé dostanou úspěšné akce', eq(results, ['timeout:u1', 'delete:m9']));
    off();
    await menu.run('timeout', { channel: 'rob', platform: 'twitch', userId: 'u2', login: 'y' }, { durationSec: 60 });
    check('ModMenu.onResult: odhlášení', results.length === 2);
  }

  // --- summarize ---
  check('summarize timeout', mm.summarizeModResult('timeout', { login: 'spammer', displayName: 'Spammer', platform: 'twitch' }, { results: { twitch: 'ok' } }, { durationSec: 300 }) === 'Timeout 5 min pro Spammer: Twitch ✓');
  check('summarize permit', mm.summarizeModResult('permit', { login: 'x', platform: 'kick' }, { results: { permit: 'ok', chat: 'bot' } }, { durationSec: 60 }) === 'Permit 1 min pro x: !permit v chatu (Kick) ✓ (bot) · UnityChat ✓');
  check('summarize permit + obnovená zpráva', mm.summarizeModResult('permit', { login: 'x', platform: 'kick' }, { results: { permit: 'ok', chat: 'bot', restore: 'ok' } }, { durationSec: 60 }) === 'Permit 1 min pro x: !permit v chatu (Kick) ✓ (bot) · UnityChat ✓ · zpráva obnovena');
  check('summarize permit, zpráva nebyla smazaná filtrem', mm.summarizeModResult('permit', { login: 'x', platform: 'kick' }, { results: { permit: 'ok', chat: 'bot', restore: 'not_found' } }, { durationSec: 60 }) === 'Permit 1 min pro x: !permit v chatu (Kick) ✓ (bot) · UnityChat ✓');
  check('summarize rename smazání', mm.summarizeModResult('rename', { login: 'x' }, { nickname: null }) === 'Přezdívka uživatele x smazána.');

  // --- ModMenu.run s mock api (bez DOM) ---
  {
    const calls = [], notes = [];
    const menu = new mm.ModMenu({ doc: {}, api: async (path, o) => { calls.push({ path, ...o }); if (o.body.action === 'ban') throw { error: 'target_protected', status: 403 }; return { ok: true, results: { twitch: 'ok' } }; }, notify: (text, info) => notes.push({ text, ok: info.ok }) });
    await menu.run('timeout', t, { durationSec: 60 });
    await menu.run('ban', t);
    check('ModMenu.run timeout → api + notify ok', calls[0]?.method === 'POST' && calls[0].body.durationSec === 60 && notes[0]?.ok && notes[0].text === 'Timeout 1 min pro spammer: Twitch ✓', JSON.stringify(notes[0]));
    check('ModMenu.run ban target_protected → česká hláška', notes[1]?.ok === false && notes[1].text === 'Na streamera nebo moda to nejde.', JSON.stringify(notes[1]));
  }

  // --- normalizeWarning + connectAccountStream (fake EventSource) ---
  check('normalizeWarning', eq(aw.normalizeWarning({ id: 5, channel: 'rob', reason: 'r', createdAt: 'x' }), { id: '5', channel: 'rob', reason: 'r', createdAt: 'x' }) && aw.normalizeWarning({}) === null);
  {
    const sources = [];
    class FakeES { constructor(url) { this.url = url; this.l = {}; this.closed = false; sources.push(this); } addEventListener(t, f) { (this.l[t] ||= []).push(f); } emit(t, data) { for (const f of this.l[t] || []) f({ data: data === undefined ? undefined : JSON.stringify(data) }); } close() { this.closed = true; } }
    let tickets = 0; const timers = [];
    const got = [], acks = [];
    const s = aw.connectAccountStream({ baseUrl: 'https://api', EventSource: FakeES, getTicket: async () => `t${++tickets}`, onWarning: (w) => got.push(w), onAck: (id) => acks.push(id), setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout: () => {} });
    await new Promise((r) => setTimeout(r, 0));
    check('stream: URL s ticketem', sources[0]?.url === 'https://api/account/stream?ticket=t1', sources[0]?.url);
    sources[0].emit('account-warning', { id: 9, channel: 'rob', reason: 'Nespamuj', createdAt: 'x' });
    sources[0].emit('account-warning-ack', { id: 9 });
    check('stream: account-warning + ack', got[0]?.id === '9' && got[0].reason === 'Nespamuj' && acks[0] === '9');
    sources[0].emit('error');
    check('stream: po chybě zavřeno + naplánováno', sources[0].closed && timers.length === 1);
    timers[0](); await new Promise((r) => setTimeout(r, 0));
    check('stream: reconnect s NOVÝM ticketem', sources[1]?.url.endsWith('ticket=t2'), sources[1]?.url);
    sources[1].emit('error', { error: 'too_many_streams' });
    check('stream: too_many_streams → bez obnovy', timers.length === 1);
    s.close();
  }

  // --- WarningModal fronta (bez DOM: doc s minimální implementací) ---
  {
    const mk = (tag) => { const el = { tag, children: [], dataset: {}, className: '', textContent: '', hidden: false, listeners: {}, setAttribute() {}, append(...c) { el.children.push(...c); }, appendChild(c) { el.children.push(c); return c; }, addEventListener(t, f) { el.listeners[t] = f; }, remove() { el.removed = true; }, focus() {} }; return el; };
    const body = mk('body');
    const doc = { body, createElement: mk };
    let changes = 0; const acked = [];
    const wm = new aw.WarningModal({ doc, onAck: async (id) => { acked.push(id); }, onChange: () => changes++ });
    wm.set([{ id: 1, channel: 'rob', reason: 'A' }, { id: 2, channel: 'rob', reason: 'B' }]);
    check('WarningModal: blocked + okno s prvním', wm.blocked && wm.el?.dataset.id === '1' && changes === 1);
    wm.add({ id: 2, reason: 'dup' });
    check('WarningModal: duplicitní add ignorován', wm.pending.length === 2);
    const btn = (function find(n) { if (n.tag === 'button') return n; for (const c of n.children || []) { const f = find(c); if (f) return f; } return null; })(wm.el);
    await btn.listeners.click();
    check('WarningModal: Rozumím → ack + další varování', acked[0] === '1' && wm.el?.dataset.id === '2' && wm.pending.length === 1);
    wm.remove('2');
    check('WarningModal: ack z jiného okna → zavřeno, neblokuje', !wm.blocked && wm.el === null);
  }

  console.log(fails ? `\n${fails} FAIL` : '\nvše PASS');
  process.exit(fails ? 1 : 0);
});

// ChatStore je ES modul v extension/core/ (sdílený s webem) → dynamický import.
import('../extension/core/chat-store.js').then(({ ChatStore }) => {
  let fails = 0;
  const check = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };
  const m = (id, ts, platform = 'twitch', extra = {}) => ({ id, timestamp: ts, platform, username: 'u', message: 'x', ...extra });

  const s = new ChatStore();
  check('add vrací added', s.add(m('a', 100)) === 'added');
  check('add stejné id → dup', s.add(m('a', 100)) === 'dup');
  check('stejné id jiná platforma není dup', s.add(m('a', 100, 'kick')) === 'added');
  s.add(m('b', 50)); s.add(m('c', 200)); s.add(m('d', 100));
  check('seřazeno podle času, tie podle id', s.slice(0, s.length).map((x) => x.platform + ':' + x.id).join(',') === 'twitch:b,twitch:a,kick:a,twitch:d,twitch:c');
  check('indexOf', s.indexOf('c') === 4 && s.indexOf('nope') === -1);

  check('prependOlder vrací počet nových a ignoruje duplicity', s.prependOlder([m('b', 50), m('z', 10), m('y', 20)]) === 2);
  check('nejstarší první', s.at(0).id === 'z' && s.at(1).id === 'y');

  const opt = m('sent-1', 300, 'twitch', { _optimistic: true, message: 'hello' });
  s.add(opt);
  check('upgrade nahradí id i timestamp a zachová pozici podle nového času',
    s.upgrade('sent-1', m('real', 299, 'twitch', { badgesRaw: 'moderator/1' })) === true
    && s.get('real').badgesRaw === 'moderator/1' && s.get('real').message === 'x'
    && s.get('sent-1') === null && s.at(s.length - 1).id === 'real');
  check('upgrade neznámého → false', s.upgrade('nope', m('q', 1)) === false);
  check('markFailed', s.add(m('sent-2', 400, 'twitch', { _optimistic: true })) === 'added' && s.markFailed('sent-2') && s.get('sent-2').sendFailed === true);
  check('remove', s.remove('sent-2') && s.get('sent-2') === null);
  check('slice mimo rozsah je bezpečný', s.slice(-5, 999).length === s.length && s.slice(3, 1).length === 0);
  check('add bez timestampu dostane Date.now()', s.add({ id: 'nt', platform: 'youtube' }) === 'added' && Math.abs(s.get('nt').timestamp - Date.now()) < 1000);
  process.exit(fails ? 1 : 0);
});

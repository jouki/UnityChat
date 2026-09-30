// node scripts/test-colon-emotes.js — „:jméno" spouštěč pro emote autocomplete (core/colon-emotes.js)
const assert = require('node:assert/strict');

(async () => {
  const { colonQuery } = await import('../extension/core/colon-emotes.js');

  // Základ — dvojtečka na začátku zprávy
  assert.deepEqual(colonQuery(':Pray', 5), { start: 0, query: 'Pray' }, 'dvojtečka na začátku zprávy');

  // Dvojtečka za mezerou uprostřed zprávy
  assert.deepEqual(colonQuery('ahoj :Pray', 10), { start: 5, query: 'Pray' }, 'dvojtečka za mezerou');

  // Kurzor uprostřed rozepsaného jména — bere jen text do kurzoru
  assert.deepEqual(colonQuery('ahoj :Pray svet', 10), { start: 5, query: 'Pray' }, 'ignoruje text za kurzorem');

  // Přesně 2 znaky za dvojtečkou — hraniční případ, ještě se počítá
  assert.deepEqual(colonQuery(':Pr', 3), { start: 0, query: 'Pr' }, 'přesně 2 znaky stačí');

  // Jen 1 znak za dvojtečkou — ještě se nenabízí
  assert.equal(colonQuery(':P', 2), null, '1 znak za dvojtečkou nestačí');

  // Samotná dvojtečka
  assert.equal(colonQuery(':', 1), null, 'jen dvojtečka');

  // Čas — dvojtečka uprostřed slova, ne na jeho začátku
  assert.equal(colonQuery('stream v 12:30', 14), null, 'čas 12:30 se nepočítá (dvojtečka není na začátku slova)');

  // URL — dvojtečka uprostřed slova
  assert.equal(colonQuery('koukni http://example.com', 26), null, 'URL se nepočítá (dvojtečka není na začátku slova)');
  assert.equal(colonQuery('wss://irc-ws.chat.twitch.tv', 27), null, 'wss:// se nepočítá');

  // Emote uprostřed zprávy, kurzor hned za dvojtečkou (0 znaků zatím)
  assert.equal(colonQuery('ahoj :', 6), null, '0 znaků za dvojtečkou');

  // Necitlivé na to, co následuje po kurzoru
  assert.deepEqual(colonQuery(':PogChamp', 4), { start: 0, query: 'Pog' }, 'query = jen text do kurzoru');

  // Neplatné vstupy
  assert.equal(colonQuery(null, 0), null, 'text musí být string');
  assert.equal(colonQuery(':abc', undefined), null, 'caret musí být číslo');

  console.log('colon-emotes: PASS');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });

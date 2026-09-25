// Smoke test sdíleného detektoru odkazů (extension/core/links.js).
// Úplná sada případů je v backend/src/lib/links.test.ts (pouští core i backend kopii).
// Spuštění: node scripts/test-links.js
import('../extension/core/links.js').then((l) => {
  let fails = 0;
  const check = (n, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) fails++; };
  check('bez schématu', l.tokenHost('neco.cz/x') === 'neco.cz');
  check('www', l.tokenHost('www.x.com') === 'www.x.com');
  check('verze není odkaz', l.tokenHost('v1.2') === null);
  check('čas není odkaz', l.tokenHost('12:30') === null);
  check('desetinné číslo není odkaz', l.tokenHost('1.5') === null);
  check('e-mail není odkaz', l.tokenHost('a@b.cz') === null);
  check('emote není odkaz', l.tokenHost('catJAM') === null);
  check('linkHosts', JSON.stringify(l.linkHosts('a neco.cz b https://youtu.be/x')) === '["neco.cz","youtu.be"]');
  check('hostAllowed subdoména', l.hostAllowed('m.youtube.com', ['youtube.com']));
  check('hostAllowed podvrh', !l.hostAllowed('evilyoutube.com', ['youtube.com']));
  if (fails) { console.log(`${fails} FAIL`); process.exit(1); }
  console.log('OK');
});

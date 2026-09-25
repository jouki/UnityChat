import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import * as ts from './links.js';

// [vstup, očekávaný host | null]
const TOKENS: Array<[string, string | null]> = [
  // odkazy se schématem
  ['https://youtu.be/abc', 'youtu.be'],
  ['https://www.youtube.com/watch?v=1', 'www.youtube.com'],
  ['HTTPS://EXAMPLE.COM', 'example.com'],
  ['http://neco.cz', 'neco.cz'],
  ['ftp://x.org/file', 'x.org'],
  ['https://1.2.3.4/x', '1.2.3.4'],
  ['https://localhost:3000', 'localhost'],
  ['https://user:pw@evil.example.com/x', 'evil.example.com'],
  ['https://neznama.tldxyzq/x', 'neznama.tldxyzq'],
  ['<https://x.com>', 'x.com'],
  // bez schématu
  ['neco.cz/x', 'neco.cz'],
  ['neco.cz', 'neco.cz'],
  ['www.x.com', 'www.x.com'],
  ['Seznam.CZ', 'seznam.cz'],
  ['bit.ly/abc', 'bit.ly'],
  ['discord.gg/xyz', 'discord.gg'],
  ['neco.cz:8080/x', 'neco.cz'],
  ['example.com.', 'example.com'],
  ['(example.com)', 'example.com'],
  ['„example.com“', 'example.com'],
  ['example.com!', 'example.com'],
  ['sub.domain.example.co.uk/path?q=1#h', 'sub.domain.example.co.uk'],
  ['čeština.cz', 'čeština.cz'],
  ['free-nitro.gift', 'free-nitro.gift'],
  // ne-odkazy
  ['v1.2', null],
  ['v1.2.3', null],
  ['1.2.3.4', null],
  ['1.5', null],
  ['0.5x', null],
  ['12:30', null],
  ['12:30:45', null],
  ['a@b.cz', null],
  ['mailto:a@b.cz', null],
  ['@jouki', null],
  ['@neco.cz', null],
  ['Kappa', null],
  ['catJAM', null],
  [':)', null],
  ['D:', null],
  ['ahoj.jak', null],
  ['no.thanks', null],
  ['x.c', null],
  ['...', null],
  ['a..b.cz', null],
  ['-x.com', null],
  ['.cz', null],
  ['cz.', null],
  ['', null],
  ['a:b.cz', null],
  ['[emote:123:Kappa]', null],
];

const TEXTS: Array<[string, string[]]> = [
  ['ahoj koukni na neco.cz/x a taky https://youtu.be/abc', ['neco.cz', 'youtu.be']],
  ['verze v1.2 vyšla ve 12:30, stojí 1.5 kč', []],
  ['napiš mi na a@b.cz nebo @jouki', []],
  ['neco.cz neco.cz NECO.cz', ['neco.cz']],
  ['Kappa catJAM PogU', []],
  ['multi\nline\twww.x.com', ['www.x.com']],
  ['', []],
];

const here = dirname(fileURLToPath(import.meta.url));
const corePath = resolve(here, '../../../extension/core/links.js');

type LinksModule = typeof ts;
async function implementations(): Promise<Array<[string, LinksModule]>> {
  const out: Array<[string, LinksModule]> = [['backend', ts]];
  // V Docker image (jen backend/) core není — tam se testuje jen kopie.
  if (existsSync(corePath)) out.push(['core', (await import(pathToFileURL(corePath).href)) as LinksModule]);
  return out;
}

test('tokenHost: odkazy vs. verze, čísla, časy, e-maily, emoty (backend i core)', async () => {
  for (const [name, m] of await implementations()) {
    for (const [input, want] of TOKENS) assert.equal(m.tokenHost(input), want, `${name}: ${JSON.stringify(input)}`);
  }
});

test('linkHosts: hosty ve větě, unikátní, pořadí výskytu', async () => {
  for (const [name, m] of await implementations()) {
    for (const [input, want] of TEXTS) assert.deepEqual(m.linkHosts(input), want, `${name}: ${JSON.stringify(input)}`);
  }
});

test('findLinks: ignore (jména emotů) se přeskočí', async () => {
  for (const [name, m] of await implementations()) {
    assert.deepEqual(m.findLinks('koukni neco.cz', { ignore: ['neco.cz'] }), [], name);
    assert.deepEqual(m.findLinks('koukni neco.cz/x'), [{ text: 'neco.cz/x', host: 'neco.cz' }], name);
  }
});

test('hostAllowed: doména i subdoména, normalizace seznamu', async () => {
  const allow = ['youtube.com', 'youtu.be', 'open.spotify.com', 'https://www.Twitch.tv/', '*.kick.com', '', 'nesmysl'];
  const cases: Array<[string, boolean]> = [
    ['youtube.com', true], ['www.youtube.com', true], ['m.youtube.com', true], ['youtu.be', true],
    ['open.spotify.com', true], ['spotify.com', false], ['evilyoutube.com', false], ['youtube.com.evil.cz', false],
    ['twitch.tv', true], ['clips.twitch.tv', true], ['kick.com', true], ['files.kick.com', true],
    ['neco.cz', false], ['', false],
  ];
  for (const [name, m] of await implementations()) {
    for (const [host, want] of cases) assert.equal(m.hostAllowed(host, allow), want, `${name}: ${host}`);
    assert.equal(m.hostAllowed('youtube.com', []), false, name);
    assert.equal(m.hostAllowed('youtube.com', null), false, name);
  }
});

test('normalizeDomain', async () => {
  for (const [name, m] of await implementations()) {
    assert.equal(m.normalizeDomain('HTTPS://www.YouTube.com/watch'), 'youtube.com', name);
    assert.equal(m.normalizeDomain('*.kick.com'), 'kick.com', name);
    assert.equal(m.normalizeDomain('localhost'), '', name);
    assert.equal(m.normalizeDomain('  '), '', name);
  }
});

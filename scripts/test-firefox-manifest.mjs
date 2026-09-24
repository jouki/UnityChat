// node scripts/test-firefox-manifest.mjs — převod Chrome manifestu na Firefox (build-firefox.mjs)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { toFirefoxManifest, GECKO_ID, DATA_COLLECTION } from './build-firefox.mjs';

const chrome = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const ff = toFirefoxManifest(chrome);
assert.deepEqual(ff.background, { scripts: ['background.js'] });
assert.equal(ff.side_panel, undefined);
assert.equal(ff.permissions.includes('sidePanel'), false);
assert.equal(ff.sidebar_action.default_panel, 'sidepanel.html');
assert.equal(ff.browser_specific_settings.gecko.id, GECKO_ID);
assert.deepEqual(ff.browser_specific_settings.gecko.data_collection_permissions, { required: DATA_COLLECTION });
assert.equal(ff.version, chrome.version);
assert.deepEqual(ff.content_scripts, chrome.content_scripts, 'content scripty beze změny');
assert.equal(chrome.background.service_worker, 'background.js', 'zdrojový manifest nezměněn');
console.log('firefox manifest: PASS');

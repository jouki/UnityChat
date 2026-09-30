// Test core/tool-dock.js — rozložení ikon v poli pro psaní a kdy QR ustoupí psaní (spec 2026-09-27 §3).
// Spuštění: node scripts/test-tool-dock.js
const assert = require('assert');
const { toolYields, layoutTools, toolsPadding, TOOL_STEP, TOOL_EDGE } = require('../extension/core/tool-dock.js');

// Desktop: jen text + pole užší než práh.
assert.equal(toolYields({ minWidth: 330, width: 300, hasText: true, focused: true, touch: false }), true, 'úzké pole + text → ustoupí');
assert.equal(toolYields({ minWidth: 330, width: 300, hasText: false, focused: true, touch: false }), false, 'úzké pole bez textu (i s fokusem) → zůstává');
assert.equal(toolYields({ minWidth: 330, width: 330, hasText: true, focused: true, touch: false }), false, 'pole přesně na prahu → zůstává');
assert.equal(toolYields({ minWidth: 330, width: 500, hasText: true, focused: true, touch: false }), false, 'široké pole + text → zůstává');
// Dotyk: fokus pole rozhoduje, šířka ani text ne.
assert.equal(toolYields({ minWidth: 330, width: 800, hasText: false, focused: true, touch: true }), true, 'dotyk + fokus → ustoupí');
assert.equal(toolYields({ minWidth: 330, width: 200, hasText: true, focused: false, touch: true }), false, 'dotyk bez fokusu → zůstává');
// Bez prahu (nota, smajlík) nikdy.
assert.equal(toolYields({ minWidth: undefined, width: 100, hasText: true, focused: true, touch: true }), false, 'bez prahu nikdy');

// Rozložení zprava doleva (QR, nota, smajlík).
assert.deepEqual(layoutTools([{ shown: true }, { shown: true }, { shown: true }]), { rights: [TOOL_EDGE + 2 * TOOL_STEP, TOOL_EDGE + TOOL_STEP, TOOL_EDGE], used: 3 }, 'všechny tři');
{
  const l = layoutTools([{ shown: true }, { shown: false }, { shown: true }]);
  assert.ok(l.rights[0] === TOOL_EDGE + TOOL_STEP && l.rights[2] === TOOL_EDGE && l.used === 2, 'bez noty QR dojede k smajlíku');
}
assert.deepEqual(layoutTools([{ shown: true, collapsed: true }, { shown: true }, { shown: true }]).used, 2, 'sbalený QR místo nezabírá');
assert.equal(layoutTools([{ shown: true, collapsed: true }, { shown: true }, { shown: true }]).rights[0], TOOL_EDGE + 2 * TOOL_STEP, 'sbalený QR se sbalí na svém místě');
assert.equal(toolsPadding(3), 90, 'tři ikony → rezerva 90 px');
assert.equal(toolsPadding(2), 62, 'dvě ikony → 62 px');
assert.equal(toolsPadding(1), 34, 'jedna ikona → 34 px');
assert.equal(toolsPadding(0), 8, 'žádná → 8 px');
console.log('test-tool-dock: OK');

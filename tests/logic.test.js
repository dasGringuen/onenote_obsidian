'use strict';
// Tests for the pure logic in main.js. Run with: node tests/logic.test.js
// main.js requires the 'obsidian' module, which only exists inside Obsidian, so it is stubbed here.

const assert = require('assert');
const path = require('path');
const Module = require('module');

class Stub {}
const obsidianStub = {
  Plugin: Stub, ItemView: Stub, Menu: Stub, Modal: Stub, Notice: Stub, TFile: Stub, TFolder: Stub,
  PluginSettingTab: Stub, Setting: Stub, TextFileView: Stub, MarkdownView: Stub, Component: Stub,
  MarkdownRenderer: {}, Keymap: {},
  normalizePath: (p) => p, debounce: (f) => f, setIcon: () => {},
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'obsidian') return obsidianStub;
  return realLoad.call(this, request, ...rest);
};

const L = require(path.join(__dirname, '..', 'main.js'))._logic;
const P = (name, order, level) => ({ path: name, name, order, level });
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('ok  ' + name); };

test('pages sort by order, then unordered ones by name', () => {
  const s = L.sortPages([P('b', NaN, 0), P('a', NaN, 0), P('z', 5, 0), P('y', 1, 0)]);
  assert.deepStrictEqual(s.map((x) => x.name), ['y', 'z', 'a', 'b']);
});

test('a page is at most one level deeper than the page above it', () => {
  const lv = (arr) => arr.map((l, i) => P('p' + i, i, l));
  assert.deepStrictEqual(L.effectiveLevels(lv([2, 1, 2, 2, 0, 2])), [0, 1, 2, 2, 0, 1]);
  assert.deepStrictEqual(L.effectiveLevels(lv([0, 1, 2, 3, 4, 9, 4, 2, 0, 4])), [0, 1, 2, 3, 4, 4, 4, 2, 0, 1]);
});

test('five indent levels', () => {
  assert.strictEqual(L.clampLevel(7), 4);
  assert.strictEqual(L.clampLevel(-1), 0);
  assert.strictEqual(L.clampLevel('x'), 0);
});

test('a page owns the deeper pages that follow it', () => {
  assert.strictEqual(L.subtreeEnd([0, 1, 2, 2, 0, 1], 0), 4);
  assert.strictEqual(L.subtreeEnd([0, 1, 2, 2, 0, 1], 1), 4);
  assert.strictEqual(L.subtreeEnd([0, 1, 2, 2, 0, 1], 5), 6);
  assert.strictEqual(L.subtreeEnd([0, 1, 2, 3, 4, 4, 1, 0], 1), 6);
});

test('a move changes only the moved pages when there is room', () => {
  assert.deepStrictEqual(L.planOrders([P('a', 100), P('x', 300), P('b', 200), P('c', 300)], new Set(['x'])), [100, 150, 200, 300]);
  assert.deepStrictEqual(L.planOrders([P('a', 100), P('b', 200), P('x', NaN)], new Set(['x'])), [100, 200, 300]);
  assert.deepStrictEqual(L.planOrders([P('x', NaN), P('a', 100), P('b', 200)], new Set(['x'])), [0, 100, 200]);
  assert.deepStrictEqual(L.planOrders([P('a', 100), P('x', 1), P('y', 2), P('b', 400)], new Set(['x', 'y'])), [100, 200, 300, 400]);
  assert.deepStrictEqual(L.planOrders([P('a', 3), P('b', 7)], new Set()), [3, 7]);
});

test('a note without an order, or out of order, does not renumber the rest', () => {
  // These used to rewrite every note in the section, which a sync client then had to carry.
  assert.deepStrictEqual(L.planOrders([P('a', 100), P('b', 300), P('c', NaN), P('d', 500)], new Set()), [100, 300, 400, 500]);
  assert.deepStrictEqual(L.planOrders([P('a', 100), P('b', 200), P('c', 900), P('d', 300), P('e', 400)], new Set()), [100, 200, 250, 300, 400]);
  assert.deepStrictEqual(L.planOrders([P('x', 1000), P('a', 100), P('b', 300), P('c', NaN)], new Set(['x'])), [0, 100, 300, 400]);
});

test('the section is renumbered when it has no order yet or no room is left', () => {
  assert.deepStrictEqual(L.planOrders([P('a', NaN), P('x', NaN), P('b', NaN)], new Set(['x'])), [100, 200, 300]);
  assert.deepStrictEqual(L.planOrders([P('a', NaN), P('b', NaN)], new Set()), [100, 200]);
  assert.deepStrictEqual(L.planOrders([P('a', 1), P('x', NaN), P('b', 1.001)], new Set(['x'])), [100, 200, 300]);
  assert.deepStrictEqual(L.planOrders([P('x', NaN)], new Set(['x'])), [100]);
});

test('saved paths follow renames and moves', () => {
  assert.strictEqual(L.remapPath('A/B/n.md', 'A/B', 'A/C'), 'A/C/n.md');
  assert.strictEqual(L.remapPath('A/Bx/n.md', 'A/B', 'A/C'), 'A/Bx/n.md');
});

test('names', () => {
  assert.ok(L.validName('Meeting notes'));
  assert.ok(!L.validName('a/b'));
  assert.ok(!L.validName(''));
});

test('properties block is split from the body', () => {
  assert.deepStrictEqual(L.splitFront('---\npage-type: freeform\n---\nbody'), ['---\npage-type: freeform\n---\n', 'body']);
  assert.deepStrictEqual(L.splitFront('no front'), ['', 'no front']);
  assert.deepStrictEqual(L.splitFront('---\na: 1\n---'), ['---\na: 1\n---', '']);
});

test('only a note marked freeform in its properties is a freeform page', () => {
  assert.strictEqual(L.isFreeformText('---\npage-type: freeform\npage-order: 100\n---\n\n%% box x=1 y=1 w=300 %%\n\nA\n'), true);
  assert.strictEqual(L.isFreeformText('---\npage-type: "freeform"\n---\n'), true);
  assert.strictEqual(L.isFreeformText('---\npage-order: 100\n---\ntext'), false);
  assert.strictEqual(L.isFreeformText('plain note\npage-type: freeform\n'), false);
  assert.strictEqual(L.isFreeformText(''), false);
});

test('boxes round-trip, in reading order, and the saved form is stable', () => {
  const boxes = [
    { x: 300, y: 200, w: 420, text: 'Second\n\n- a\n- b' },
    { x: 40, y: 60, w: 320, text: 'First **bold**' },
    { x: 10, y: 10, w: 200, text: '   ' },
  ];
  const body = L.serializeBoxes(boxes);
  assert.strictEqual(body, '\n%% box x=40 y=60 w=320 %%\n\nFirst **bold**\n\n%% box x=300 y=200 w=420 %%\n\nSecond\n\n- a\n- b\n');
  const back = L.parseBoxes(body);
  assert.deepStrictEqual(back, [{ x: 40, y: 60, w: 320, text: 'First **bold**' }, { x: 300, y: 200, w: 420, text: 'Second\n\n- a\n- b' }]);
  assert.strictEqual(L.serializeBoxes(back), body);
  assert.strictEqual(L.serializeBoxes([]), '');
});

test('box height is optional', () => {
  const body = '\n%% box x=10 y=20 w=300 h=180 %%\n\nTall\n';
  assert.deepStrictEqual(L.parseBoxes(body), [{ x: 10, y: 20, w: 300, h: 180, text: 'Tall' }]);
  assert.strictEqual(L.serializeBoxes(L.parseBoxes(body)), body);
  assert.strictEqual(L.serializeBoxes([{ x: 1, y: 2, w: 300, h: 0, text: 'A' }]), '\n%% box x=1 y=2 w=300 %%\n\nA\n');
});

test('a plain note becomes one box; odd values are tolerated', () => {
  assert.deepStrictEqual(L.parseBoxes('\nHello\n\nworld\n'), [{ x: 40, y: 20, w: 560, text: 'Hello\n\nworld' }]);
  assert.deepStrictEqual(L.parseBoxes('%% box x=-5 w=10 %%\nT'), [{ x: 0, y: 40, w: 120, text: 'T' }]);
  assert.deepStrictEqual(L.parseBoxes('%% box %%\nT'), [{ x: 40, y: 40, w: 420, text: 'T' }]);
  assert.deepStrictEqual(L.parseBoxes('%% box x=1 y=2 w=300 %%\r\n\r\nA\r\n%% note %%\r\nB\r\n'), [{ x: 1, y: 2, w: 300, text: 'A\n%% note %%\nB' }]);
});

test('a freeform page converts back to plain Markdown in reading order', () => {
  const body = '\n%% box x=300 y=200 w=420 %%\n\nSecond\n\n%% box x=40 y=60 w=320 %%\n\nFirst\n';
  assert.strictEqual(L.stripBoxMarkers(body), '\nFirst\n\nSecond\n');
  assert.strictEqual(L.stripBoxMarkers(''), '');
});

console.log('\n' + passed + ' tests passed');

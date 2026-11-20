// On-screen controls for touch screens: which keys a game's code checks, the layout they become, and gcp.json "controls".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildControls, detectKeys, layoutFor, parseControls, sanitizeControls } from '../web/src/touch-controls.ts';

const build = (files, extra = {}) => buildControls({ texts: new Map(Object.entries(files)), ...extra }).controls;
const KB = `const keys = {}; addEventListener('keydown', (e) => { keys[e.code] = true; }); addEventListener('keyup', (e) => { keys[e.code] = false; });`;

test('code strings, properties, object keys, key values and keyCodes are all found', () => {
  assert.deepEqual(detectKeys({ 'a.js': KB + `if (keys.KeyW) up(); if (keys['ArrowLeft']) left(); const map = { KeyE: 'use' };` }).keys.sort(), ['ArrowLeft', 'KeyE', 'KeyW']);
  assert.deepEqual(detectKeys({ 'b.js': `onkeydown = (e) => { if (e.key === ' ') jump(); switch (e.key) { case 'q': quit(); } }` }).keys.sort(), ['KeyQ', 'Space']);
  assert.deepEqual(detectKeys({ 'c.js': `document.addEventListener('keydown', (e) => { if (e.keyCode === 37) left(); if (e.which == 32) fire(); })` }).keys.sort(), ['ArrowLeft', 'Space']);
});

test('libraries are never read for keys', () => {
  const lib = KB + `'KeyW','KeyA','KeyS','KeyD','Space','Enter'`;
  assert.deepEqual(detectKeys({ 'vendor/engine.js': lib, 'lib/x.js': lib, 'three.module.js': lib, 'src/pixi.min.js': lib }).keys, []);
  assert.deepEqual(detectKeys({ 'src/main.js': lib }).keys.length, 6);
});

test('WASD and the arrows become a stick, other keys become buttons, most important first, Escape never', () => {
  const l = layoutFor(['KeyQ', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Escape', 'Space', 'KeyE', 'ArrowUp']);
  assert.equal(l.stick, 'wasd');
  assert.deepEqual(l.buttons.map((b) => b.code), ['Space', 'KeyE', 'KeyQ']);
  assert.deepEqual(l.buttons[0], { code: 'Space', key: ' ', keyCode: 32, label: 'Space' });
  assert.equal(layoutFor(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD']).stick, 'both');
  // left and right alone are buttons, after the actions
  assert.deepEqual(layoutFor(['ArrowLeft', 'ArrowRight', 'Space']).buttons.map((b) => b.code), ['Space', 'ArrowLeft', 'ArrowRight']);
  assert.equal(layoutFor('Space Enter ShiftLeft KeyE KeyF KeyJ KeyK KeyZ'.split(' ')).buttons.length, 6);
});

test('they show by themselves only for a keyboard game without touch controls of its own', () => {
  const kb = { 'main.js': KB + `if (keys.KeyW||keys.KeyA||keys.KeyS||keys.KeyD||keys.Space) {}` };
  const c = build(kb);
  assert.equal(c.show, true); assert.equal(c.stick, 'wasd'); assert.equal(c.source, 'detected');
  assert.equal(build({ ...kb, 'touch.js': `canvas.addEventListener('touchstart', f)` }).show, false);
  assert.equal(build({ ...kb, 'touch.js': `if (e.pointerType === 'touch') stick(e)` }).show, false);
  assert.equal(build({ ...kb, 'ui.js': `import { createInput } from '@gcp/input.js';` }).show, false);
  assert.equal(build(kb, { declaredInput: ['keyboard', 'touch'] }).show, false);
  // pointer events alone are no touch controls (a menu clicked with the mouse)
  assert.equal(build({ ...kb, 'menu.js': `btn.addEventListener('pointerdown', go)` }).show, true);
  assert.equal(build({ 'main.js': `canvas.onclick = go;` }).show, false);
});

test('a game that reads gamepads and no keys gets a gamepad', () => {
  const c = build({ 'main.js': `addEventListener('gamepadconnected', f); const p = navigator.getGamepads()[0];` });
  assert.equal(c.gamepad, true); assert.equal(c.show, true);
  assert.deepEqual(c.buttons.map((b) => b.label), ['A', 'B', 'X', 'Y']);
});

test('gcp.json controls overrides what was found', () => {
  const kb = { 'main.js': KB + `keys.KeyW; keys.KeyA; keys.KeyS; keys.KeyD; keys.Space;` };
  const own = build(kb, { declared: { touch: 'none' } });
  assert.equal(own.show, false); assert.equal(own.source, 'declared');
  const c = build({ ...kb, 't.js': `addEventListener('touchstart', f)` }, { declared: { touch: 'overlay', stick: 'arrows', buttons: [{ key: 'Space', label: 'Jump' }, 'KeyE', { key: 'x' }] } });
  assert.equal(c.show, true); assert.equal(c.stick, 'arrows');
  assert.deepEqual(c.buttons.map((b) => [b.code, b.label]), [['Space', 'Jump'], ['KeyE', 'E'], ['KeyX', 'X']]);
  assert.equal(build(kb, { declared: 'none' }).show, false);
});

test('a bad declaration is explained', () => {
  const r = parseControls({ touch: 'sometimes', stick: 'left', buttons: [{ key: 'Hyper' }, { key: 'Escape' }], extra: 1 });
  const fields = r.issues.map((i) => i.level + ':' + i.field);
  assert.ok(fields.includes('error:controls.touch'));
  assert.ok(fields.includes('error:controls.stick'));
  assert.ok(fields.includes('error:controls.buttons'));
  assert.ok(fields.includes('warning:controls.buttons'));   // Escape is the platform's
  assert.ok(fields.includes('warning:controls'));
  assert.equal(parseControls([1]).issues[0].level, 'error');
  assert.equal(parseControls(undefined).value, null);
});

test('a record from the API is checked before the game gets it', () => {
  assert.equal(sanitizeControls(null), null);
  assert.equal(sanitizeControls({ v: 2 }), null);
  const s = sanitizeControls({ v: 1, show: 1, stick: 'diagonal', buttons: [{ code: 'Space', label: 'Jump'.repeat(9) }, { code: 'Nope' }, { code: 'Pad1', label: 'B' }], evidence: 'x'.repeat(500) });
  assert.equal(s.stick, null); assert.equal(s.show, true);
  assert.deepEqual(s.buttons.map((b) => b.code), ['Space', 'Pad1']);
  assert.equal(s.buttons[0].label.length, 12); assert.equal(s.evidence.length, 200);
});

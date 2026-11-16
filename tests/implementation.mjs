// The open-implementation analyzer: facts about how a game is built, never its code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { READABLE, aggregate, analyzeBundle, isVendor, ruleSummary, scrubSummary } from '../src/implementation.js';

const dir = new URL('../web/public/templates/', import.meta.url), index = JSON.parse(readFileSync(new URL('index.json', dir), 'utf8'));
const bundle = (name) => index.templates.find((t) => t.name === name).files.map((f) => {
  const buf = readFileSync(new URL(`${name}/${f.path}`, dir));
  return { path: f.path, size: buf.length, text: READABLE(f.path) ? buf.toString('utf8') : null };
});
const report = { playthrough: { ok: true, steps: ['start', 'collect a beacon', 'x = () => {}'] }, metrics: { loadMs: 420, fps: 30, canvas: { w: 1280, h: 720 } } };

test('a three.js game reads as three.js on WebGL with keyboard input', () => {
  const f = analyzeBundle(bundle('three-explorer'), report);
  assert.equal(f.engine, 'three.js');
  assert.ok(f.rendering.includes('WebGL'), f.rendering.join());
  assert.ok(f.input.includes('keyboard'), f.input.join());
  assert.ok(f.loop_and_performance.includes('requestAnimationFrame loop') || f.loop_and_performance.length, f.loop_and_performance.join());
  assert.ok(f.keywords.includes('3d'));
  assert.deepEqual(f.gameplay.playthrough_steps, ['start', 'collect a beacon']);   // code-like labels are dropped
  assert.equal(f.verified.canvas, '1280x720');
});

test('a canvas game reads as hand-written Canvas 2D', () => {
  const f = analyzeBundle(bundle('canvas2d-arcade'), report);
  assert.match(f.engine, /^none/);
  assert.ok(f.rendering.includes('Canvas 2D'), f.rendering.join());
});

test('a multiplayer game shows the platform services it uses', () => {
  const f = analyzeBundle(bundle('homestead-2d'), report);
  assert.ok(f.platform_services.includes('multiplayer rooms'), f.platform_services.join());
  assert.ok(f.keywords.includes('multiplayer'));
});

test('no source text ever reaches the facts or the summary', () => {
  const files = bundle('three-explorer'), f = analyzeBundle(files, report), out = JSON.stringify(f) + ruleSummary({ title: 'X', tags: ['test'] }, f);
  for (const file of files.filter((x) => x.text)) {
    for (const line of file.text.split('\n').map((l) => l.trim()).filter((l) => l.length > 24)) assert.ok(!out.includes(line), `leaked from ${file.path}: ${line}`);
  }
});

test('engine bundles are told apart from the game\'s own code', () => {
  assert.ok(isVendor('vendor/three.module.js', 'x'));
  assert.ok(isVendor('js/phaser.min.js', 'x'));
  assert.ok(isVendor('Build/game.framework.js', 'x'));
  assert.ok(!isVendor('src/main.js', 'const a = 1;\n'));
  assert.ok(isVendor('src/big.js', 'a'.repeat(200_000)));
  const f = analyzeBundle([{ path: 'index.html', size: 50, text: '<script src="lib/phaser.min.js"></script><script src="game.js"></script>' }, { path: 'lib/phaser.min.js', size: 9, text: 'Phaser.Game;touchstart;gamepadconnected' }, { path: 'game.js', size: 9, text: "addEventListener('keydown', f)" }], {});
  assert.equal(f.engine, 'Phaser');
  assert.deepEqual(f.input, ['keyboard']);   // the engine's own event names do not count
});

test('model output is scrubbed of code', () => {
  const s = scrubSummary('It is built with three.js.\n```js\nconst x = 1;\n```\nUse `requestAnimationFrame()` for the loop.\nfunction f() { return a[b] = (c); }\n## Heading\nDone.');
  assert.ok(!/```|const x|function f/.test(s), s);
  assert.match(s, /three\.js/);
  assert.match(s, /requestAnimationFrame/);
});

test('patterns across games', () => {
  const a = analyzeBundle(bundle('three-explorer'), report), b = analyzeBundle(bundle('canvas2d-arcade'), report);
  const p = aggregate([a, b]);
  assert.equal(p.games, 2);
  assert.ok(p.engine.some((e) => e.name === 'three.js' && e.share === 50));
  assert.ok(p.input.some((e) => e.name === 'keyboard' && e.games === 2));
});

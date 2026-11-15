// The duplication check's rules: fingerprints that survive renaming, containment, the copy verdict, looks and "is it a game".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundlePrints, compare, containment, distinctFile, fingerprints, gameness, inlineScripts, lookDistance, lookOf, tokens } from '../src/originality.js';
import { analyzeBundle } from '../src/implementation.js';

const tpl = (name, path) => readFileSync(new URL(`../web/public/templates/${name}/${path}`, import.meta.url), 'utf8');
const game = tpl('canvas2d-arcade', 'src/main.js');
// the same game with every name changed, numbers tweaked and comments and layout rewritten
const renamed = game.replace(/\b(score|lives|moth|mote|wisp|player|enemies|reset|update|view|ctx|cam)\b/g, (w) => 'q_' + w.split('').reverse().join('')).replace(/\/\/.*$/gm, '').replace(/\b(\d+)\.(\d+)\b/g, '$1.$29').replace(/\n\s+/g, '\n');
const P = (src) => ({ prints: bundlePrints([{ path: 'src/main.js', text: src }]), files: [], assets: [], look: null });

test('tokens fold names, strings and numbers', () => {
  assert.deepEqual(tokens('let a = foo(1, "x");'), tokens('let zz = barBaz(42, \'yy\');'));
  assert.notDeepEqual(tokens('if (a) b();'), tokens('while (a) b();'));
});

test('renaming and reformatting do not hide a copy', () => {
  const a = P(renamed), b = P(game);
  assert.ok(a.prints.length > 100, String(a.prints.length));
  assert.ok(containment(a.prints, b.prints) > 0.8, String(containment(a.prints, b.prints)));
  assert.equal(compare(a, b).verdict, 'copy');
});

test('different games do not match', () => {
  const a = P(game), b = P(tpl('three-explorer', 'src/main.js'));
  assert.ok(containment(a.prints, b.prints) < 0.1);
  assert.equal(compare(a, b).verdict, 'different');
});

test('code everyone starts from is ignored', () => {
  const base = new Set(fingerprints(game));
  const left = bundlePrints([{ path: 'src/main.js', text: game }], base);
  assert.equal(left.length, 0);
  const own = bundlePrints([{ path: 'src/main.js', text: game + '\n' + tpl('three-explorer', 'src/main.js') }], base);
  assert.ok(own.length > 50);
});

test('a template file copied in unchanged is not a distinct file', () => {
  const base = new Set(fingerprints(game));
  assert.equal(distinctFile('src/main.js', game, base), false);
  assert.equal(distinctFile('src/main.js', game, new Set()), true);
  assert.equal(distinctFile('src/tiny.js', 'let a = 1;', new Set()), false);
});

test('inline scripts of a page are read, the import map is not', () => {
  const s = inlineScripts('<script type="importmap">{ "imports": {} }</script><script src="a.js"></script><script>let x = 1;</script>');
  assert.deepEqual(s, ['let x = 1;']);
});

test('a few lines of shared code are not enough to call a copy', () => {
  const tiny = 'function f(a){return a+1}';
  assert.equal(compare(P(tiny), P(tiny)).verdict, 'different');
});

test('looks: the same picture matches, a different one does not', () => {
  const img = (fn) => { const w = 90, h = 80, px = new Uint8Array(w * h * 3); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y); px.set([r, g, b], (y * w + x) * 3); } return { w, h, bpp: 3, stride: w * 3, px }; };
  const a = lookOf(img((x, y) => [x * 2, y * 3, 80])), b = lookOf(img((x, y) => [x * 2 + 3, y * 3, 82])), c = lookOf(img((x, y) => [255 - x * 2, (x * y) % 255, 10]));
  assert.ok(lookDistance(a, b) <= 4, String(lookDistance(a, b)));
  assert.ok(lookDistance(a, c) > 20, String(lookDistance(a, c)));
});

test('shared asset files and the same look make a copy even with new code', () => {
  const assets = ['a1', 'a2', 'a3', 'a4', 'a5'], look = { dhash: '0f0f0f0f0f0f0f0f', palette: [1, 2, 3, 4] };
  assert.equal(compare({ prints: [], files: [], assets, look }, { prints: [], files: [], assets, look }).verdict, 'copy');
  assert.equal(compare({ prints: [], files: [], assets: assets.slice(0, 3), look: null }, { prints: [], files: [], assets, look: null }).verdict, 'similar');
});

test('is it a game', () => {
  const facts = (files) => analyzeBundle(files.map(([path, text]) => ({ path, size: text.length, text })), {});
  const page = '<html><body><h1>Our app</h1><p>Download it today.</p></body></html>';
  assert.equal(gameness(facts([['index.html', page]]), {}, page).verdict, 'not_game');
  const form = '<form><input type="email"><button>Join</button></form>';
  assert.equal(gameness(facts([['index.html', form]]), {}, form).verdict, 'unsure');
  const g = '<canvas></canvas><script>addEventListener("keydown", f); requestAnimationFrame(loop); c.getContext("2d")</script>';
  assert.equal(gameness(facts([['index.html', g]]), {}, g).verdict, 'game');
  assert.equal(gameness(facts([['index.html', page]]), { playthrough: { ok: true } }, page).verdict, 'game');
  for (const t of ['blank', 'canvas2d-arcade', 'three-explorer']) {
    const html = tpl(t, 'index.html'), files = [['index.html', html], ['src/main.js', tpl(t, 'src/main.js')]];
    assert.equal(gameness(facts(files), {}, html).verdict, 'game', t);
  }
});

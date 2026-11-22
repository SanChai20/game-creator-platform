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
  // a page nobody can act on is not a game even when its own play-through hook says it passed
  assert.equal(gameness(facts([['index.html', page]]), { playthrough: { ok: true, steps: ['x'] } }, page).verdict, 'not_game');
  // canvas + loop + input is only a lean: landing pages and tools do that too, so the AI step decides
  assert.equal(gameness(facts([['index.html', g]]), {}, g).sure, false);
  for (const t of ['blank', 'canvas2d-arcade', 'three-explorer']) {
    const html = tpl(t, 'index.html'), files = [['index.html', html], ['src/main.js', tpl(t, 'src/main.js')]];
    assert.equal(gameness(facts(files), {}, html).verdict, 'game', t);
  }
  const engine = facts([['index.html', '<script src="phaser.min.js"></script>'], ['phaser.min.js', '/* Phaser v3.80 */ var Phaser={};']]);
  if (engine.engine === 'Phaser') assert.equal(gameness(engine, {}, '').sure, true);
  {
  }
});

// ---- identity: a rebuild from a description shares no code, but keeps the name, the tagline and the names in it ----
import { contentNames, identityKeys, kinship, normText, textSim, titleSkeleton } from '../src/originality.js';
const SRC = (names) => [{ path: 'src/cards.js', text: `export const CARDS = [${names.map((n) => `{ name: ${JSON.stringify(n)}, cost: 1 }`).join(', ')}];` }];
const HEROES = ['Vesper Dusk', 'Hollow Mite', 'Ash Hound', 'Grave Warden', 'The Void Echo', 'Kindle', 'Nightfall', 'Riposte', 'Second Wind', 'Vigil'];

test('titles and taglines are compared without case, accents, punctuation or a leading "the"', () => {
  assert.equal(normText('The  Void-Échoes!'), 'void echoes');
  assert.equal(textSim('void echoes', 'void echoes'), 1);
  assert.ok(textSim('void echoes', 'void echos') > 0.75);
  assert.ok(textSim('void echoes', 'star miner') < 0.3);
});

test('content names are Title Case strings of the game, without menu words or keys', () => {
  const n = contentNames([{ path: 'a.js', text: 'const a = ["Hollow Mite", "Play", "New Game", "Escape", "ArrowUp", "hello world", "x", "Second Wind", `Grave Warden`];' }]);
  assert.deepEqual(n, ['grave warden', 'hollow mite', 'second wind']);
  assert.deepEqual(contentNames([{ path: 'index.html', text: '<script>let k = "Ash Hound"</script><p>Not Here</p>' }]), ['ash hound']);
});




test('the same genre and mechanics are allowed; built the same way too is only a closer look', () => {
  const a = { title: 'Star Miner', tagline: 'Dig through asteroids for ore and glory.', tags: ['roguelike', 'deck-building', 'space'], traits: ['engine:PixiJS', 'render:WebGL', 'input:mouse'] };
  const b = { title: 'Void Echoes', tagline: 'A roguelike deckbuilder about the last day of a city.', tags: ['roguelike', 'deck-building', 'fantasy'], traits: ['engine:PixiJS', 'render:WebGL', 'input:mouse', 'input:touch'] };
  assert.equal(kinship({ ...a, traits: [] }, b).verdict, 'different');
  assert.equal(kinship(a, b).verdict, 'similar');
});

test('identity keys meet for the same or a near title, the same tagline and shared names', () => {
  assert.equal(titleSkeleton('Void Echoes'), titleSkeleton('The Void Echos'));
  const a = identityKeys({ title: 'Void Echoes', tagline: 'A roguelike deckbuilder about the last day.', names: contentNames(SRC(HEROES)) });
  const b = identityKeys({ title: 'Voyd Echoes', tagline: 'Something new and different from it.', names: contentNames(SRC([...HEROES, 'Lantern'])) });
  assert.ok(a.strong.some((h) => b.strong.includes(h)), 'skeleton meets');
  assert.ok(a.names.filter((h) => b.names.includes(h)).length >= 8, 'name sketches meet');
  const c = identityKeys({ title: 'Star Miner', tagline: 'Dig through asteroids for ore and glory.', names: contentNames(SRC(['Ore Golem', 'Drill Bot'])) });
  assert.equal(a.strong.filter((h) => c.strong.includes(h)).length + a.names.filter((h) => c.names.includes(h)).length, 0);
  assert.ok(identityKeys({ title: 'X', names: contentNames(SRC(Array.from({ length: 200 }, (_, i) => 'Card Number ' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i % 26] + 'abcdefghij'[i % 10] + 'x'.repeat(1 + (i % 7))))) }).names.length <= 600);
});

test('pictures that look alike share screenshot bands in the identity index', () => {
  const a = identityKeys({ title: 'A', look: { dhash: '0123456789abcdef' } }), b = identityKeys({ title: 'B', look: { dhash: '0123456789abcdee' } }), c = identityKeys({ title: 'C', look: { dhash: 'fedcba9876543210' } });
  assert.equal(a.look.filter((h) => b.look.includes(h)).length, 3);
  assert.equal(a.look.filter((h) => c.look.includes(h)).length, 0);
  assert.deepEqual(identityKeys({ title: 'A', look: null }).look, []);
});

test('names that come from a template are not counted', () => {
  assert.deepEqual(contentNames(SRC(['Hollow Mite', 'Ash Hound']), new Set(['hollow mite'])), ['ash hound']);
});

test('a rebuild that only changed its title still gets a closer look for its names', () => {
  const ours = contentNames(SRC([...HEROES.slice(0, 7), ...Array.from({ length: 30 }, (_, i) => 'Rune ' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZABCD'[i] + 'aeiou'[i % 5] + 'lmn'[i % 3])]));
  const k = kinship({ title: 'Ember Requiem', tagline: 'A new deckbuilder of ash and bells.', names: ours }, { title: 'Void Echoes', tagline: 'A roguelike deckbuilder about the last day.', names: contentNames(SRC(HEROES)) });
  assert.ok(k.names_share < 20 && k.shared_names >= 6);
  assert.equal(k.verdict, 'similar');
});

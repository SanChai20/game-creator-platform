// Builds the generated part of the moderation corpus: sprite art, cases taken from the platform's templates and
// fixtures, and the violating copies, which are derived from the legitimate games by the transformations a copier
// would use (renaming, recolouring, minifying, splitting files, swapping art). Hand-written cases live in corpus/
// as plain files. Run after changing an original: node tests/moderation/make-corpus.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = join(ROOT, 'tests/moderation/corpus');

// ---------------------------------------------------------------------------------------------- PNG art
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, fn) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const [r, g, b, a = 255] = fn(x, y); raw.set([r, g, b, a], y * (w * 4 + 1) + 1 + x * 4); } }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
let seed = 1; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
/** A set of sprites in one palette; `shift` gives a different art set for the same game (new art, same code). */
function art(dir, hue) {
  mkdirSync(dir, { recursive: true });
  const j = (v) => Math.max(0, Math.min(255, v + (rnd() * 24 | 0) - 12)), tint = (r, g, b) => (hue ? [j(b), j(r), j(g)] : [j(r), j(g), j(b)]);
  seed = hue ? 99 : 7;
  writeFileSync(join(dir, 'player.png'), png(64, 64, (X, Y, x = X / 2, y = Y / 2) => { const d = Math.hypot(x - 16, y - 16); return d < 12 ? tint(90 + (rnd() * 40 | 0), 200, 120) : d < 14 ? tint(30, 60, 30) : [0, 0, 0, 0]; }));
  writeFileSync(join(dir, 'spore.png'), png(64, 64, (X, Y, x = X / 2, y = Y / 2) => { const d = Math.hypot(x - 16, y - 16); return d < 10 ? tint(240, 240 - d * 8 | 0, 120 + (rnd() * 60 | 0)) : [0, 0, 0, 0]; }));
  writeFileSync(join(dir, 'spike.png'), png(64, 64, (X, Y, x = X / 2, y = Y / 2) => (Math.abs(x % 16 - 8) < (y - 8) / 3 ? tint(180 + (rnd() * 40 | 0), 180, 190) : [0, 0, 0, 0])));
  writeFileSync(join(dir, 'tile.png'), png(64, 64, (X, Y, x = X / 2, y = Y / 2) => (y < 6 ? tint(60, 150 + (rnd() * 50 | 0), 50) : tint(90 + (rnd() * 30 | 0), 60 + (rnd() * 20 | 0), 40))));
  writeFileSync(join(dir, 'sky.png'), png(96, 54, (x, y) => tint(20 + y, 40 + y * 2 + (rnd() * 6 | 0), 50 + y)));
}

// ---------------------------------------------------------------------------------------------- helpers
const caseJson = (id, meta) => writeFileSync(join(CORPUS, id, 'case.json'), JSON.stringify(meta, null, 2) + '\n');
function fresh(id) { const d = join(CORPUS, id); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; }
function copyDir(from, to, skip = () => false) {
  for (const f of readdirSync(from)) { const p = join(from, f); if (skip(f)) continue; if (statSync(p).isDirectory()) { mkdirSync(join(to, f), { recursive: true }); copyDir(p, join(to, f), skip); } else cpSync(p, join(to, f)); }
}
const read = (id, p) => readFileSync(join(CORPUS, id, p), 'utf8');
const write = (id, p, s) => { mkdirSync(dirname(join(CORPUS, id, p)), { recursive: true }); writeFileSync(join(CORPUS, id, p), s); };
/** Renames identifiers the way a copier does by hand: every word in the list gets a new name. */
/** Renames identifiers outside string literals (so sprite paths and labels keep working) */
const rename = (src, words, prefix) => {
  const re = new RegExp(`\\b(${words.join('|')})\\b`, 'g'), out = [];
  // split into code and string/comment pieces; template literals keep their ${} parts renamed
  const parts = src.split(/('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|\/\/[^\n]*)/);
  for (let i = 0; i < parts.length; i++) out.push(i % 2 ? parts[i] : parts[i].replace(re, (w) => prefix + w.split('').reverse().join('')));
  return out.join('');
};
/** Shifts every hex colour so the copy looks recoloured. */
const recolor = (src) => src.replace(/#([0-9a-f]{6})\b/gi, (_, h) => '#' + h.slice(2) + h.slice(0, 2));
const minify = (src) => require('esbuild').transformSync(src, { minify: true, loader: 'js' }).code;

// ---------------------------------------------------------------------------------------------- legitimate games from the repo
art(join(CORPUS, 'g-platformer/art'), 0);

for (const [id, tpl, title, kind, extra] of [
  ['tpl-arcade', 'canvas2d-arcade', 'Lantern Moths', 'legit:template-canvas2d', {}],
  ['tpl-explorer', 'three-explorer', 'Crystal Meadow', 'legit:template-three', {}],
  ['tpl-homestead3d', 'homestead-3d', 'Riverside Homestead', 'legit:template-three-heavy-multiplayer', {}],
]) {
  const d = fresh(id); copyDir(join(ROOT, 'web/public/templates', tpl), d, (f) => f === 'template.json');
  caseJson(id, { expect: 'publish', kind, owner: 'tpl-' + id, listing: { title, tagline: `A game started from the ${tpl} template.`, description: 'Built from a platform template with the creator\'s own tuning.', tags: ['template'] }, why: 'Unchanged platform template: templates are meant to be started from, so publishing one is not copying.', ...extra });
}
{
  const d = fresh('comet-herder'); copyDir(join(ROOT, 'tests/fixtures/comet-herder'), d);
  caseJson('comet-herder', { expect: 'publish', kind: 'legit:canvas2d', live: true, owner: 'cora', listing: { title: 'Comet Herder', tagline: 'Herd comets into the dock.', description: 'Steer a little ship and nudge comets into the dock before they burn out.', tags: ['arcade', 'space'] }, why: 'Repository fixture game.' });
}
const BG = '/mnt/project-files/bloomguard/game';
if (existsSync(BG)) {
  const d = fresh('bloomguard'); copyDir(BG, d);
  caseJson('bloomguard', { expect: 'publish', kind: 'legit:webgl2-heavy-multiplayer', live: true, owner: 'bea', listing: { title: 'Bloomguard', tagline: 'Guard the last garden from the blight.', description: 'A co-op survival game: grow defensive blooms, level up and hold off waves of blight together. Heavy WebGL 2 renderer with its own shaders.', tags: ['survival', 'co-op', '3d'] }, why: 'Heavy custom WebGL 2 game with rooms; at first it reached 1 fps on the software GPU.' });
}

// ---------------------------------------------------------------------------------------------- violating copies
const PLAT_WORDS = ['canvas', 'ctx', 'hud', 'TILE', 'GRAVITY', 'JUMP', 'SPEED', 'LEVELS', 'sprites', 'loaded', 'keys', 'touchX', 'touchJump', 'state', 'load', 'solid', 'cell', 'draw', 'resize', 'frame', 'start', 'spores', 'total', 'camX', 'won', 'dead', 'level', 'face', 'ground', 'dir', 'here', 'viewW'];
const platListing = (title) => ({ title, tagline: 'Leap between ledges and gather the glowing seeds.', description: 'A side-scrolling platformer. Jump over spikes, collect every seed before time runs out and clear all the levels.', tags: ['platformer', '2d'] });
{ // same code renamed and reformatted, same art
  const d = fresh('c-platformer-reskin'); copyDir(join(CORPUS, 'g-platformer'), d, (f) => f === 'case.json');
  write('c-platformer-reskin', 'game.js', rename(read('g-platformer', 'game.js'), PLAT_WORDS, 'z').replace(/\/\/.*$/gm, '').replace(/\n\s+/g, '\n').replace(/Moss Hopper|forest|Spores?/g, (w) => ({ 'Moss Hopper': 'Seed Leaper', forest: 'valley', Spores: 'Seeds', Spore: 'Seed' })[w] || w));
  write('c-platformer-reskin', 'index.html', recolor(read('g-platformer', 'index.html')).replace('Moss Hopper', 'Seed Leaper'));
  caseJson('c-platformer-reskin', { expect: 'block', kind: 'copy:renamed-same-art', gate: 'original', copy_of: 'g-platformer', owner: 'xavier', listing: platListing('Seed Leaper'), why: 'Another creator\'s game with every name changed, comments stripped and the HUD recoloured; same sprites.' });
}
{ // same code, all-new art and title: a reskin
  const d = fresh('c-platformer-newart'); copyDir(join(CORPUS, 'g-platformer'), d, (f) => f === 'case.json' || f === 'art');
  art(join(d, 'art'), 1);
  write('c-platformer-newart', 'game.js', rename(read('g-platformer', 'game.js'), PLAT_WORDS.slice(0, 20), 'k'));
  write('c-platformer-newart', 'index.html', recolor(read('g-platformer', 'index.html')).replace('Moss Hopper', 'Frost Jumper'));
  caseJson('c-platformer-newart', { expect: 'block', kind: 'copy:reskin-new-art', gate: 'original', copy_of: 'g-platformer', owner: 'xavier2', listing: platListing('Frost Jumper'), why: 'The same code with new sprites, colours and title: a reskin.' });
}
{ // the code minified into one line
  const d = fresh('c-platformer-minified'); copyDir(join(CORPUS, 'g-platformer'), d, (f) => f === 'case.json');
  write('c-platformer-minified', 'game.js', minify(read('g-platformer', 'game.js')).replace(/Moss Hopper/g, 'Cave Bounder'));
  write('c-platformer-minified', 'index.html', read('g-platformer', 'index.html').replace('Moss Hopper', 'Cave Bounder'));
  caseJson('c-platformer-minified', { expect: 'block', kind: 'copy:minified', gate: 'original', copy_of: 'g-platformer', owner: 'yuri', listing: platListing('Cave Bounder'), why: 'Another creator\'s game run through a minifier.' });
}
{ // a near copy: 2 new levels, retuned constants, a new enemy, but the engine is the original's
  const d = fresh('c-platformer-near'); copyDir(join(CORPUS, 'g-platformer'), d, (f) => f === 'case.json');
  let s = read('g-platformer', 'game.js').replace('GRAVITY = 1800, JUMP = 640, SPEED = 220', 'GRAVITY = 1650, JUMP = 700, SPEED = 240');
  s = s.replace("  const sprites = {};", `  const bats = [{ x: 400, y: 120, t: 0 }, { x: 900, y: 80, t: 2 }];
  function moveBats(dt) { for (const b of bats) { b.t += dt; b.x += Math.cos(b.t) * 40 * dt; b.y += Math.sin(b.t * 2) * 30 * dt; } }
  function drawBats(g) { g.fillStyle = '#402050'; for (const b of bats) { g.beginPath(); g.ellipse(b.x, b.y, 12, 6, 0, 0, Math.PI * 2); g.fill(); } }
  const sprites = {};`).replace('    state.time -= dt;', '    moveBats(dt);\n    state.time -= dt;').replace('    const p = state.player;\n    ctx.save(); ctx.translate(p.x', '    drawBats(ctx);\n    const p = state.player;\n    ctx.save(); ctx.translate(p.x');
  s = rename(s, PLAT_WORDS.slice(0, 12), 'n');
  write('c-platformer-near', 'game.js', s.replace(/Moss Hopper/g, 'Bat Cavern'));
  write('c-platformer-near', 'index.html', read('g-platformer', 'index.html').replace('Moss Hopper', 'Bat Cavern'));
  caseJson('c-platformer-near', { expect: 'block', kind: 'copy:near-copy', gate: 'original', copy_of: 'g-platformer', owner: 'zoe', listing: { title: 'Bat Cavern', tagline: 'Dodge bats, jump spikes, grab spores.', description: 'A cave platformer with flapping bats.', tags: ['platformer'] }, why: 'The original engine, levels and art with bats bolted on and constants retuned: still the other creator\'s game.' });
}
{ // the code split across files, functions in a new order
  const d = fresh('c-platformer-split'); copyDir(join(CORPUS, 'g-platformer'), d, (f) => f === 'case.json' || f === 'game.js');
  const s = read('g-platformer', 'game.js');
  const cut = s.indexOf('  function step(dt)'), cut2 = s.indexOf('  function resize()');
  write('c-platformer-split', 'src/setup.js', '// setup\n' + s.slice(0, cut).replace('(function () {\n', 'window.G = {};\n').replace(/\n  const /g, '\n  var ') + '\n');
  write('c-platformer-split', 'src/loop.js', '// loop\n' + s.slice(cut2).replace(/\}\)\(\);\s*$/, '') + '\n' + s.slice(cut, cut2));
  write('c-platformer-split', 'index.html', read('g-platformer', 'index.html').replace('<script src="game.js"></script>', '<script src="src/setup.js"></script><script src="src/loop.js"></script>').replace('Moss Hopper', 'Spore Run'));
  caseJson('c-platformer-split', { expect: 'block', kind: 'copy:split-reordered', gate: 'original', copy_of: 'g-platformer', owner: 'yan', listing: platListing('Spore Run'), why: 'The same code cut into two files with the functions in a different order.' });
}
{
  const d = fresh('c-comet-renamed'); copyDir(join(CORPUS, 'comet-herder'), d, (f) => f === 'case.json');
  const words = [...new Set((read('comet-herder', 'game.js').match(/\b(?:const|let|function)\s+([A-Za-z_]\w{2,})/g) || []).map((m) => m.split(/\s+/)[1]))];
  write('c-comet-renamed', 'game.js', recolor(rename(read('comet-herder', 'game.js'), words, 'q')));
  write('c-comet-renamed', 'index.html', recolor(read('comet-herder', 'index.html')).replace(/Comet Herder/gi, 'Star Shepherd'));
  caseJson('c-comet-renamed', { expect: 'block', kind: 'copy:renamed-recoloured', gate: 'original', copy_of: 'comet-herder', owner: 'quinn', listing: { title: 'Star Shepherd', tagline: 'Guide falling stars home.', description: 'Fly a tiny ship and push stars into the harbour.', tags: ['arcade', 'space'] }, why: 'Every declared name changed and every colour shifted.' });
}
if (existsSync(BG)) {
  const d = fresh('c-bloomguard-retitle'); copyDir(BG, d);
  write('c-bloomguard-retitle', 'index.html', recolor(read('c-bloomguard-retitle', 'index.html')).replace(/Bloomguard/g, 'Petal Keepers'));
  caseJson('c-bloomguard-retitle', { expect: 'block', kind: 'copy:retitled-heavy', gate: 'original', copy_of: 'bloomguard', owner: 'pat', listing: { title: 'Petal Keepers', tagline: 'Protect the garden together.', description: 'Grow flowers, level up and fight off the rot with friends.', tags: ['survival', 'co-op'] }, why: 'A large game re-uploaded with a new title and recoloured menus.' });
}
for (const [id, from, words, title, owner, kind] of [
  ['c-snake-minified', 'g-snake', null, 'Serpent Dash', 'sam', 'copy:minified'],
  ['c-memory-reskin', 'g-memory', ['deck', 'flip', 'board', 'cards', 'moves', 'matched', 'first', 'second', 'lock', 'shuffle', 'render'], 'Fruit Pairs', 'mia', 'copy:renamed-dom'],
  ['c-shader-copy', 'g-shader-orb', ['gl', 'prog', 'uTime', 'uOrb', 'orbs', 'score', 'compile', 'loop', 'player'], 'Neon Drift', 'nik', 'copy:renamed-webgl'],
  ['c-chess-renamed', 'g-chess', ['board', 'sel', 'turn', 'moves', 'draw', 'legal', 'pieces', 'ai', 'click'], 'Tiny Tactics', 'kai', 'copy:renamed-turn-based'],
]) {
  if (!existsSync(join(CORPUS, from))) continue;
  const d = fresh(id); copyDir(join(CORPUS, from), d, (f) => f === 'case.json');
  const meta = JSON.parse(read(from, 'case.json'));
  for (const f of readdirSync(d)) if (/\.(js|html)$/.test(f)) {
    let s = read(id, f);
    if (/\.js$/.test(f)) s = words ? rename(s, words, 'w') : minify(s);
    else s = recolor(s).replace(new RegExp(meta.listing.title, 'g'), title);
    if (/\.html$/.test(f) && words) s = rename(s, words, 'w');
    if (/\.html$/.test(f) && !words) s = s.replace(/<script>([\s\S]*?)<\/script>/g, (m, js) => (js.trim() && !js.includes('importmap') ? `<script>${minify(js)}</script>` : m));
    write(id, f, s);
  }
  caseJson(id, { expect: 'block', kind, gate: 'original', copy_of: from, owner, listing: { ...meta.listing, title, tagline: meta.listing.tagline.replace(/\w+$/, 'fun') }, why: `${meta.listing.title} by another creator, ${words ? 'with its names changed and colours shifted' : 'minified'}.` });
}
// the abusive cases share one real game as their carrier
for (const id of readdirSync(CORPUS)) if (id.startsWith('m-')) cpSync(join(ROOT, 'tests/moderation/carrier.js'), join(CORPUS, id, 'game.js'));
console.log('corpus generated');

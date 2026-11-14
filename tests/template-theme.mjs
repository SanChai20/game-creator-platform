// The theme generator of the homestead templates (src/template-theme.js): every setting and every feature a brief can
// ask for must give a theme that loads and whose tables agree with each other, and the theme files in the repository
// must be exactly what the generator writes for the default plan.   node tests/template-theme.mjs [--write]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { pathToFileURL, fileURLToPath } from 'node:url';
import { themeSpec, renderTheme, themeFor, themeNotes, themeAsWritten, specAsWritten, themeEdits, THEME_SETTINGS, DEFAULT_PLAN } from '../src/template-theme.js';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-')); let n = 0, failed = 0;
const fail = (m) => { failed++; console.error('✗ ' + m); };
const load = async (text) => { const f = path.join(tmp, `t${n++}.mjs`); fs.writeFileSync(f, text); return import(pathToFileURL(f).href); };
const TREES = ['oak', 'birch', 'pine', 'palm', 'maple', 'blossom', 'willow', 'dead', 'cactus', 'mushroom'], SPRITES = ['tree', 'rock', 'bush', 'flower', 'reeds', 'mushrooms', 'log', 'stump', 'crystal', 'chest', 'barrel'], COVERS = ['flower', 'tuft', 'fern', 'reeds', 'mushrooms', 'stones', 'log', 'stump', 'crystal'];
const ENGINE = { '2d': fs.readFileSync(path.join(root, 'web/public/templates/homestead-2d/src/main.js'), 'utf8'), '3d': fs.readFileSync(path.join(root, 'web/public/templates/homestead-3d/src/main.js'), 'utf8') };
async function check(label, dim, plan, brief, edited) {
  const spec = themeSpec(dim, plan, brief); let text = renderTheme(spec), T;
  if (edited) {   // the first edits the platform hands out (themeEdits): each must apply exactly once, and the theme they give must still be a whole game
    const made = specAsWritten('homestead-' + dim, text); if (!made || JSON.stringify(themeEdits(made)) !== JSON.stringify(themeEdits(spec))) fail(`${label}: the edits read back from the mark line are not the edits of the brief`);
    const edits = themeEdits(spec); if (edits.length < 3 || edits.length > 5) fail(`${label}: ${edits.length} first edits, wanted 3 to 5`);
    for (const e of edits) for (const c of e.edit_file) { const src = c.path === 'src/main.js' ? ENGINE[dim] : text, hits = src.split(c.old_string).length - 1;
      if (hits !== 1) fail(`${label}: edit ${e.step} looks for text that is in ${c.path} ${hits} times: ${c.old_string.slice(0, 80)}`); else if (c.path !== 'src/main.js') text = text.replace(c.old_string, () => c.new_string); }
  }
  try { T = await load(text); } catch (e) { return fail(`${label}: the theme does not load: ${e.message}`); }
  const bad = (m) => fail(`${label}: ${m}`), item = (id, where) => { if (!T.ITEMS[id]) bad(`${where} names the item "${id}", which ITEMS lacks`); };
  for (const k of ['TITLE', 'TAGLINE', 'SEED', 'SAVE_KEY', 'SAVE', 'HERO', 'FRIENDS', 'LOOK', 'SOUND', 'DAY', 'NEEDS', 'ITEMS', 'START', 'PAIL', 'RECIPES', 'CROPS', 'PIECES', 'THINGS', 'REGIONS', 'FOES', 'HOME', 'STEPS', 'CONTROLS', 'HINT']) if (!(k in T)) bad('no export ' + k);
  for (const r of T.RECIPES) { item(r.makes, 'a recipe'); for (const id in r.needs) item(id, 'the recipe of ' + r.makes); if (r.station && !(T.PIECES[r.station] && T.PIECES[r.station].station)) bad(`recipe ${r.makes} needs the station ${r.station}, which is no station piece`); }
  for (const [id, d] of Object.entries(T.ITEMS)) { if (d.plant && !T.CROPS[d.plant]) bad(`${id} plants ${d.plant}, no such crop`); if (d.place && !T.PIECES[d.place]) bad(`${id} places ${d.place}, no such piece`); if ('icon' in d && typeof d.icon !== 'function') bad(`${id} has no drawable icon`); }
  for (const [id, c] of Object.entries(T.CROPS)) { item(c.seed, 'crop ' + id); for (const y in c.yields) item(y, 'crop ' + id); }
  for (const [k, p] of Object.entries(T.PIECES)) for (const id in p.cost || {}) item(id, 'piece ' + k);
  for (const [k, th] of Object.entries(T.THINGS)) { for (const id in (th.node && th.node.drops) || {}) item(id, 'thing ' + k);
    const [block, o] = th.sprite || th.art || []; if (dim === '2d' ? !SPRITES.includes(block) || (block === 'tree' && !TREES.includes(o.species)) : !['tree', 'rock', 'bush', 'cover', 'prop'].includes(block) || (block === 'cover' && !COVERS.includes(o.type))) bad(`thing ${k} has art the ${dim} kit cannot draw: ${JSON.stringify(th.sprite || th.art)}`); }
  for (const r of T.REGIONS) for (const k of [...r.trees, ...r.cover]) if (!T.THINGS[k]) bad(`region ${r.name} names the thing "${k}", which THINGS lacks`);
  if (!T.REGIONS.some((r) => r.far === 0)) bad('no home region');
  if (T.FOES) { for (const id in T.FOES.loot) item(id, 'foe loot'); if (!Object.values(T.ITEMS).some((d) => d.weapon)) bad('foes but no weapon'); }
  for (const s of T.STEPS) if (typeof s.when !== 'function') bad(`step ${s.id} has no condition`);
  for (const id of ['hoe', 'wheat_seed', 'wheat', 'campfire', 'bread', 'stairs', 'deck', 'fence', 'wood', 'stone', 'pail', 'coin']) item(id, 'the play-through');
  themeNotes(spec); if (!edited && themeAsWritten('homestead-' + dim, text) !== text) bad('the mark line does not give the same theme back');
  if (edited && !(T.ITEMS.pie && T.THINGS.cache && T.REGIONS[1].cover.includes('cache') && T.STEPS[T.STEPS.length - 1].id === 'pie' && T.TAGLINE !== spec.tagline)) bad('the first edits did not all arrive in the theme');
  return { spec, T, text };
}
const ALL = 'a farm with smelting, food and water, combat where enemies drop loot, corn, saved on the host’s local device, up to four players in multiplayer, with wolves and cows';
for (const dim of ['2d', '3d']) for (const s of THEME_SETTINGS) { await check(`${dim} ${s} edited`, dim, { title: 'Edit ' + s, setting: s }, s === 'forest' ? '' : ALL + ' ' + s, true); await check(`${dim} ${s} plain`, dim, { title: 'Test ' + s, setting: s, stage: { mood: 'clear-day', weather: 'none' }, ground: { palette: 'temperate' }, hero: { preset: 'farmer' } }, ''); await check(`${dim} ${s} everything`, dim, { title: "It's " + s, setting: s }, ALL); }
const full = await check('2d everything', '2d', { title: 'Mistbound', setting: 'village', stage: { mood: 'misty-dawn' } }, ALL);
if (full) { const { spec, T } = full; if (!(spec.features.smelting && spec.features.thirst && spec.features.combat && spec.features.corn && spec.features.local_save && spec.features.players === 4)) fail('a brief that names everything turns everything on: ' + JSON.stringify(spec.features));
  if (!(T.NEEDS.water > 0 && T.PIECES.furnace && T.ITEMS.ingot && T.FOES.kinds[0] === 'wolf' && T.SAVE.cloud === false && T.CROPS.corn && T.REGIONS[0].animals.includes('cow') && T.LOOK.mood === 'misty-dawn' && T.TITLE === 'Mistbound')) fail('the generated theme holds what the brief asked for'); }
const plain = await check('3d plain', '3d', { title: 'Quiet Farm', setting: 'forest' }, 'a calm farm'); if (plain && (plain.T.FOES || plain.T.NEEDS.water || plain.T.PIECES.furnace || plain.T.SAVE.cloud !== true)) fail('a brief that asks for nothing extra gets nothing extra');
// two briefs never get the same theme, and one brief always gets the same one: its own name (when it gives none), wording, regions and almanac
{ const A = 'A farming and building game with procedural generation, smelting, food, water and combat where enemies drop loot. Up to four players. A robust building system.', B = A + ' Make it cosy, with sheep.', P = (extra) => ({ title: 'Millbrook', title_from: 'setting', mood_from: 'setting', setting: 'village', stage: { mood: 'clear-day' }, ...extra });
  const a2 = await check('brief A 2d', '2d', P(), A), a3 = await check('brief A 3d', '3d', P(), A), b2 = await check('brief B 2d', '2d', P(), B), again = themeFor('homestead-2d', P(), A);
  if (a2 && a3 && b2) {
    if (a2.text !== again) fail('one brief gives one theme, every time');
    if (a2.T.TITLE === 'Millbrook' || a3.T.TITLE === 'Millbrook' || a2.T.TITLE === a3.T.TITLE || a2.T.TITLE === b2.T.TITLE) fail(`a brief without a name gets its own, and not the setting's: ${a2.T.TITLE}, ${a3.T.TITLE}, ${b2.T.TITLE}`);
    const same = (x, y) => ['TAGLINE', 'REGIONS', 'STEPS', 'LOOK'].filter((k) => JSON.stringify(x.T[k].map ? x.T[k].map((r) => r.name || r.text) : x.T[k]) === JSON.stringify(y.T[k].map ? y.T[k].map((r) => r.name || r.text) : y.T[k]));
    if (same(a2, b2).length > 2) fail('two briefs share too much: ' + same(a2, b2).join(', '));
    if (!(a2.T.PIECES.pillar && a3.T.PIECES.wall && a2.T.STEPS.some((s) => s.id === 'build'))) fail('a brief that asks for a building system gets walls to build');
    if (await check('named', '2d', P({ title: 'Fernreach', title_from: 'brief' }), A).then((r) => r.T.TITLE) !== 'Fernreach') fail('a name the brief gives is kept');
    const state = { tilled: 0, planted: 0, watered: 0, harvested: 0, meals: 0, cooked: 0, sold: 0, climbed: 0, drinks: 0, slain: 0, charted: 0 }, inv = { has: () => false };
    for (const t of [a2, a3, b2]) for (const s of t.T.STEPS) if (s.when(state, inv)) fail(`step ${s.id} is done before anything was`);
  } }
for (const dim of ['2d', '3d']) { const f = path.join(root, `web/public/templates/homestead-${dim}/src/theme.js`), want = themeFor('homestead-' + dim, DEFAULT_PLAN[dim], '');
  if (process.argv.includes('--write')) { fs.writeFileSync(f, want); console.log('wrote ' + f); } else if (fs.readFileSync(f, 'utf8') !== want) fail(`${f} is not what the generator writes for the default plan: run node tests/template-theme.mjs --write`); }
fs.rmSync(tmp, { recursive: true, force: true });
if (failed) { console.error(`${failed} problem(s)`); process.exit(1); } else console.log(`✓ template themes: ${n} generated themes load and agree with themselves; the repository themes match the generator`);

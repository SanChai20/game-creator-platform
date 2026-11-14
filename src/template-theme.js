// Writes src/theme.js of the homestead templates (web/public/templates/homestead-2d and homestead-3d) from a plan and
// the brief, so the game a brief gets is that brief's game before anyone edits it: its name, its place (palette, mood,
// regions, trees, animals), what it asks for beyond the base loop (thirst, smelting, foes with loot, extra crops) and
// an almanac that speaks of it. The engine (src/main.js of each template) reads only the theme.
//
//   themeFor('homestead-2d', plan, brief)  -> the text of src/theme.js        (plan: what designScene returns as .plan)
//   themeSpec('2d', plan, brief)           -> the same as plain data, for tests and for the notes
//   renderTheme(spec)                      -> text from that data
//
// The theme files in the repository are renderTheme(themeSpec(dim, DEFAULT_PLAN[dim], '')): tests/template-theme.mjs
// checks that and `node tests/template-theme.mjs --write` rewrites them after a change here.

/* ===== places. One row per setting design_scene knows. Region rows: [name, trees and rocks, ground cover, animals].
   Names in the lists: any tree species (a trailing 2 is a second individual), rock, mossy, ore (only with smelting,
   otherwise a rock), gemrock, and the covers bush, berries, mushrooms, flower, flower2, fern, reeds, log, stump, stones, crystal. ===== */
const PLACES = {
  forest: { accent: '#f0b64a', gem: 'Fen crystal', relief: 8, ambience: 'forest', music: 'calm', foes: ['wolf', 'boar'],
    regions: [['Home meadow', ['oak', 'oak2', 'birch', 'rock'], ['bush', 'berries', 'flower', 'flower2', 'log'], ['rabbit', 'chicken']],
      ['The Pinewood', ['pine', 'pine2', 'pine', 'mossy', 'oak'], ['mushrooms', 'fern', 'log', 'stump', 'bush'], ['deer', 'fox']],
      ['Maple Rise', ['maple', 'birch', 'maple', 'rock', 'willow'], ['berries', 'flower', 'bush', 'reeds', 'stones'], ['deer', 'rabbit']],
      ['The Stonefield', ['rock', 'mossy', 'ore', 'gemrock', 'dead'], ['crystal', 'stump', 'stones', 'bush'], ['boar']]] },
  village: { accent: '#f0b64a', gem: 'Mill crystal', relief: 6, ambience: 'forest', music: 'calm', foes: ['wolf', 'boar'],
    regions: [['Home pasture', ['oak', 'blossom', 'birch', 'rock'], ['bush', 'berries', 'flower', 'flower2', 'log'], ['chicken', 'sheep']],
      ['The Orchard', ['blossom', 'blossom2', 'maple', 'oak', 'rock'], ['berries', 'flower', 'flower2', 'bush', 'stump'], ['sheep', 'cow']],
      ['Oakshade', ['oak', 'oak2', 'birch', 'mossy', 'willow'], ['mushrooms', 'fern', 'log', 'bush', 'reeds'], ['deer', 'pig']],
      ['The Old Quarry', ['rock', 'mossy', 'ore', 'gemrock', 'dead'], ['crystal', 'stones', 'stump', 'bush'], ['fox']]] },
  island: { accent: '#ffd23f', gem: 'Sea pearl', relief: 7, sea: 0x3fb8c8, ambience: 'ocean', music: 'adventure', foes: ['boar', 'bat'],
    regions: [['Home cove', ['palm', 'palm2', 'oak', 'rock'], ['bush', 'berries', 'flower', 'reeds', 'log'], ['chicken', 'pig']],
      ['The Palm Coast', ['palm', 'palm2', 'palm', 'rock', 'blossom'], ['reeds', 'flower', 'bush', 'stones', 'log'], ['bird', 'pig']],
      ['Blossom Hills', ['blossom', 'oak', 'blossom2', 'mossy', 'palm'], ['berries', 'flower', 'flower2', 'fern', 'bush'], ['rabbit', 'deer']],
      ['The Reef Stones', ['rock', 'mossy', 'ore', 'gemrock', 'palm'], ['crystal', 'stones', 'reeds', 'stump'], ['boar']]] },
  desert: { accent: '#ffc46a', gem: 'Sun glass', relief: 6, rock: { color: 0xb8865a }, ambience: 'wind', music: 'mystery', foes: ['wolf', 'bat'],
    regions: [['Home oasis', ['palm', 'palm2', 'cactus', 'rock'], ['bush', 'berries', 'reeds', 'flower', 'log'], ['chicken', 'horse']],
      ['The Cactus Flats', ['cactus', 'cactus2', 'cactus', 'rock', 'dead'], ['stones', 'stump', 'bush', 'flower'], ['rabbit', 'horse']],
      ['Palm Wells', ['palm', 'palm2', 'cactus', 'rock', 'palm'], ['reeds', 'berries', 'bush', 'flower', 'log'], ['sheep', 'bird']],
      ['The Red Mesa', ['rock', 'rock', 'ore', 'gemrock', 'dead'], ['crystal', 'stones', 'stump'], ['boar']]] },
  snow: { accent: '#9fd8ff', gem: 'Ice shard', relief: 8, tree: { snow: true }, rock: { snow: true }, sea: 0x7fb4d6, ambience: 'wind', music: 'calm', foes: ['wolf', 'bear'],
    regions: [['Home hollow', ['pine', 'pine2', 'birch', 'rock'], ['bush', 'berries', 'log', 'stump', 'stones'], ['rabbit', 'sheep']],
      ['The Frostwood', ['pine', 'pine2', 'pine', 'rock', 'dead'], ['mushrooms', 'log', 'stump', 'bush'], ['deer', 'fox']],
      ['Birch Drifts', ['birch', 'birch2', 'pine', 'rock', 'dead'], ['berries', 'bush', 'stones', 'log'], ['deer', 'rabbit']],
      ['The Ice Field', ['rock', 'rock', 'ore', 'gemrock', 'dead'], ['crystal', 'stones', 'stump'], ['fox']]] },
  volcanic: { accent: '#ff8a4a', gem: 'Fire opal', relief: 9, rock: { color: 0x4a4444 }, sea: 0x8a4a3a, ambience: 'fire', music: 'tense', foes: ['bat', 'boar'],
    regions: [['Home ledge', ['dead', 'oak', 'birch', 'rock'], ['bush', 'berries', 'stones', 'stump', 'log'], ['chicken', 'pig']],
      ['The Ashwood', ['dead', 'dead2', 'pine', 'rock', 'dead'], ['stump', 'log', 'mushrooms', 'stones'], ['fox']],
      ['Cinder Groves', ['oak', 'maple', 'dead', 'rock', 'maple2'], ['berries', 'bush', 'flower', 'stones'], ['deer', 'rabbit']],
      ['The Black Flow', ['rock', 'rock', 'ore', 'gemrock', 'dead'], ['crystal', 'stones', 'stump'], ['boar']]] },
  alien: { accent: '#c88aff', gem: 'Star shard', relief: 8, sea: 0x6a4ab8, ambience: 'space', music: 'mystery', foes: ['slime', 'bat'],
    regions: [['Home crater', ['mushroom', 'mushroom2', 'blossom', 'rock'], ['bush', 'berries', 'mushrooms', 'flower', 'crystal'], ['rabbit', 'chicken']],
      ['The Spore Forest', ['mushroom', 'mushroom2', 'mushroom', 'rock', 'willow'], ['mushrooms', 'fern', 'bush', 'stump'], ['deer', 'fox']],
      ['Violet Groves', ['blossom', 'blossom2', 'willow', 'rock', 'mushroom'], ['flower', 'flower2', 'berries', 'reeds', 'bush'], ['sheep', 'bird']],
      ['The Glass Field', ['rock', 'gemrock', 'ore', 'gemrock', 'dead'], ['crystal', 'stones', 'crystal', 'stump'], ['pig']]] },
  haunted: { accent: '#b8e08a', gem: 'Grave amber', relief: 7, ambience: 'night', music: 'mystery', foes: ['ghost', 'bat'],
    regions: [['Home clearing', ['oak', 'willow', 'birch', 'rock'], ['bush', 'berries', 'mushrooms', 'flower', 'log'], ['rabbit', 'chicken']],
      ['The Witherwood', ['dead', 'dead2', 'willow', 'mossy', 'oak'], ['mushrooms', 'stump', 'log', 'fern'], ['fox', 'bird']],
      ['Willow Mere', ['willow', 'willow2', 'birch', 'mossy', 'oak'], ['reeds', 'mushrooms', 'bush', 'berries'], ['deer', 'rabbit']],
      ['The Barrow Stones', ['rock', 'mossy', 'ore', 'gemrock', 'dead'], ['crystal', 'stones', 'stump'], ['boar']]] },
  autumn: { accent: '#f0a04a', gem: 'Amber', relief: 8, ambience: 'forest', music: 'calm', foes: ['wolf', 'boar'],
    regions: [['Home orchard', ['maple', 'oak', 'birch', 'rock'], ['bush', 'berries', 'flower', 'mushrooms', 'log'], ['rabbit', 'chicken']],
      ['The Russet Wood', ['maple', 'maple2', 'oak', 'mossy', 'birch'], ['mushrooms', 'fern', 'log', 'stump', 'bush'], ['deer', 'fox']],
      ['Birch Hollow', ['birch', 'birch2', 'maple', 'rock', 'willow'], ['berries', 'flower', 'bush', 'reeds', 'stones'], ['deer', 'pig']],
      ['The Stonefield', ['rock', 'mossy', 'ore', 'gemrock', 'dead'], ['crystal', 'stump', 'stones', 'bush'], ['boar']]] },
  mountains: { accent: '#d8e6f0', gem: 'Tarn crystal', relief: 12, ambience: 'wind', music: 'adventure', foes: ['wolf', 'bear'],
    regions: [['Home shelf', ['pine', 'birch', 'pine2', 'rock'], ['bush', 'berries', 'flower', 'stones', 'log'], ['sheep', 'rabbit']],
      ['The High Pines', ['pine', 'pine2', 'pine', 'mossy', 'dead'], ['mushrooms', 'fern', 'log', 'stump'], ['deer', 'fox']],
      ['Birch Terraces', ['birch', 'birch2', 'oak', 'rock', 'pine'], ['berries', 'flower', 'bush', 'stones'], ['sheep', 'horse']],
      ['The Scree', ['rock', 'rock', 'ore', 'gemrock', 'mossy'], ['crystal', 'stones', 'stump'], ['boar']]] },
  swamp: { accent: '#a8d86a', gem: 'Bog pearl', relief: 5, sea: 0x4a6a4a, ambience: 'rain', music: 'mystery', foes: ['slime', 'bat'],
    regions: [['Home bank', ['willow', 'oak', 'birch', 'rock'], ['bush', 'berries', 'reeds', 'mushrooms', 'log'], ['chicken', 'pig']],
      ['The Willow Fen', ['willow', 'willow2', 'willow', 'mossy', 'dead'], ['reeds', 'mushrooms', 'fern', 'log'], ['bird', 'pig']],
      ['Mossy Rise', ['oak', 'birch', 'willow', 'mossy', 'oak2'], ['berries', 'fern', 'bush', 'mushrooms', 'stump'], ['deer', 'rabbit']],
      ['The Sunk Stones', ['mossy', 'rock', 'ore', 'gemrock', 'dead'], ['crystal', 'reeds', 'stones', 'stump'], ['boar']]] },
  city: { accent: '#ff7ad8', gem: 'Neon shard', relief: 5, ambience: 'city', music: 'retro', foes: ['slime', 'bat'],
    regions: [['Home lot', ['oak', 'birch', 'blossom', 'rock'], ['bush', 'berries', 'flower', 'log', 'stump'], ['chicken', 'rabbit']],
      ['The Old Park', ['oak', 'oak2', 'maple', 'rock', 'birch'], ['flower', 'flower2', 'bush', 'berries', 'log'], ['fox', 'bird']],
      ['Blossom Row', ['blossom', 'blossom2', 'birch', 'rock', 'willow'], ['flower', 'bush', 'berries', 'reeds'], ['rabbit', 'pig']],
      ['The Rubble Field', ['rock', 'rock', 'ore', 'gemrock', 'dead'], ['crystal', 'stones', 'stump'], ['boar']]] },
};
export const THEME_SETTINGS = Object.keys(PLACES);
const TREES_2D = ['oak', 'birch', 'pine', 'palm', 'maple', 'blossom', 'willow', 'dead', 'cactus', 'mushroom'];
const TAME = ['deer', 'fox', 'sheep', 'pig', 'cow', 'horse', 'rabbit', 'chicken', 'bird'], WILD = ['wolf', 'boar', 'bear', 'slime', 'ghost', 'bat'];   // kinds both actor2d and animal() draw
const HEROES = ['villager', 'explorer', 'farmer', 'knight', 'wizard', 'ninja', 'pirate', 'astronaut', 'robot', 'skeleton', 'zombie', 'king', 'child'];
const MOODS = ['clear-day', 'golden-hour', 'misty-dawn', 'overcast', 'storm', 'dusk', 'night', 'desert', 'arctic', 'autumn', 'volcanic', 'alien', 'neon-night', 'indoor'];
const AIRS = ['rain', 'snow', 'motes', 'fireflies', 'embers', 'leaves', 'dust', 'sandstorm'], PALETTES = ['temperate', 'autumn', 'desert', 'snow', 'volcanic', 'alien', 'tropical'];
/** What each template is when nothing is asked of it: the plans the files in the repository are written from. */
export const DEFAULT_PLAN = {
  '2d': { title: 'Brackenfold', seed: 'bracken-7', setting: 'forest', stage: { mood: 'clear-day', weather: 'motes' }, ground: { palette: 'temperate' }, hero: { preset: 'farmer' } },
  '3d': { title: 'Highfallow', seed: 'fallow-3', setting: 'forest', stage: { mood: 'clear-day', weather: 'motes' }, ground: { palette: 'temperate' }, hero: { preset: 'farmer' } },
};

const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'homestead';
const has = (text, re) => re.test(text);

/**
 * The theme as data. plan is designScene(...).plan (title, seed, setting, stage.mood, stage.weather, ground.palette,
 * hero.preset); brief is the description it was planned from. Everything not named falls back to the template's own.
 */
export function themeSpec(dim, plan = {}, brief = '') {
  const text = String(brief || '').toLowerCase(), base = DEFAULT_PLAN[dim], P = PLACES[plan.setting] || PLACES.forest, d3 = dim === '3d';
  const title = String(plan.title || base.title).replace(/[\n\r]/g, ' ').slice(0, 60), slug = slugOf(title);
  // what the brief asks for beyond the base loop
  const smelting = has(text, /\bsmelt|\bfurnace|\bforge\b|\bingots?\b|\bores?\b/), thirst = has(text, /\bthirst|\bdrink|food,? (and )?water\b|water,? (and )?food\b|\bhydrat/);
  const combat = has(text, /\bcombat\b|\benem(y|ies)\b|\bmonsters?\b|\bfight|\bloot\b|\bweapons?\b|\bmobs?\b/), corn = has(text, /\bcorn\b|\bmaize\b/);
  const local = has(text, /host(['’]s)? (own |local )?(device|machine|computer|browser)|saved? (automatically )?(locally|on the host|on (the|their) device)|local save|no cloud|(not?|n['’]t) (want )?(the )?(game )?(data )?(be )?stored on (my|the|a|our) server/);
  const many = has(text, /multi.?player|co-?op\b|\bfriends\b|\bplayers\b|\bhost(s|ed|ing)?\b|\blobby\b/), four = has(text, /(up to|max(imum)?( of)?) (four|4) players|\b(four|4)[- ]players?\b/);
  const named = (list) => list.filter((n) => new RegExp('\\b' + n + 's?\\b').test(text));
  const mood = MOODS.includes(plan.stage && plan.stage.mood) ? plan.stage.mood : 'clear-day', w = plan.stage && plan.stage.weather;
  const weather = AIRS.includes(w) ? w : ['clear-day', 'golden-hour', 'autumn'].includes(mood) ? 'motes' : null;
  const palette = PALETTES.includes(plan.ground && plan.ground.palette) ? plan.ground.palette : 'temperate';
  const hero = HEROES.includes(plan.hero && plan.hero.preset) ? plan.hero.preset : 'farmer';
  // regions: the setting's, with the animals the brief names living at home and its beasts as the foes
  const regions = P.regions.map(([name, trees, cover, animals], i) => ({ name, far: [0, 2, 2, 3][i], trees: trees.map((t) => (t === 'ore' && !smelting ? 'rock' : t)), cover: [...cover], animals: [...animals] }));
  const tame = named(TAME), wild = named(WILD);
  regions[0].animals = [...new Set([...tame, ...regions[0].animals])].slice(0, 3);
  const foes = combat ? { kinds: [...new Set([...wild, ...P.foes])].slice(0, 3), hp: 4, hit: 9, count: 3, every: 7 } : null;
  if (foes) foes.loot = foes.kinds.some((k) => ['slime', 'ghost'].includes(k)) ? { coin: [1, 4], crystal: [0, 1] } : { meat: [1, 2], coin: [1, 3] };
  const far = regions[1].name, deep = regions[3].name, crops = ['wheat', 'carrot', 'pumpkin', ...(corn ? ['corn'] : [])];
  const tagline = [
    combat ? 'Farm, build and hold out through the nights on land that never ends.' : 'Till a plot, tend it, and walk a little further every day.',
    smelting && thirst ? 'Cut wood, break stone, smelt ore, and keep fed and watered.' : smelting ? 'Cut wood, break stone and smelt what you dig up.' : thirst ? 'Keep fed and watered.' : '',
    many ? (four ? 'Alone, or with up to four in one world.' : 'Alone or with friends in one world.') : 'Alone or with a friend.',
  ].filter(Boolean).join(' ');
  const steps = [
    ['gather', 'Chop a tree and break a rock: 3 wood, 1 stone'], ['hoe', 'Open the backpack and craft a hoe'], ['till', 'Hold the hoe and till a plot, then plant wheat seeds on it'],
    ['water', 'Fill the pail at the well and water the crop'], ...(thirst ? [['drink', 'Drink at the well: the blue bar is your thirst']] : []),
    ['harvest', 'Keep it watered and harvest it when it is ripe'], ['explore', `Walk out and chart ${d3 ? 8 : 12} new pieces of land: ${far} lies beyond`],
    ['cook', 'Build a campfire, bake bread and eat it'], ...(smelting ? [['smelt', `Break ore rock in ${deep}, build a furnace and smelt an ingot`]] : []),
    ['sell', 'Sell a harvest at the trading post'], ...(combat ? [['fight', `Craft a sword and see off ${plural(foes.kinds[0])} that come at night`]] : []), ['climb', 'Craft stairs and a lookout deck, and climb up'],
  ];
  return { dim, title, tagline, seed: String(plan.seed || slug).slice(0, 40), saveKey: slug + '-1', hero, setting: PLACES[plan.setting] ? plan.setting : 'forest',
    look: { mood, palette, weather, accent: P.accent, relief: P.relief, sea: P.sea || null }, sound: { ambience: P.ambience, nightAmbience: 'night', music: P.music },
    gem: P.gem, treeOpt: P.tree || {}, rockOpt: P.rock || {}, regions, crops, foes, needs: { food: 1.4, ...(thirst ? { water: 1 } : {}) }, save: { cloud: !local },
    features: { smelting, thirst, combat, corn, local_save: local, players: four ? 4 : many ? 'several' : 2 }, named: [...tame, ...wild], steps };
}
const plural = (kind) => ({ wolf: 'the wolves', boar: 'the boars', bear: 'the bears', slime: 'the slimes', ghost: 'the ghosts', bat: 'the bats' }[kind] || 'what comes');

/* ===== writing it out ===== */
const js = (v) => {   // a value as source: single quotes, bare keys, colours in hex
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) && v > 0xffff ? '0x' + v.toString(16) : String(v);
  if (typeof v === 'string') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ') + "'";
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map(js).join(', ') + ']';
  const keys = Object.keys(v); return keys.length ? '{ ' + keys.map((k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : js(k)) + ': ' + js(v[k])).join(', ') + ' }' : '{}';
};
const rows = (obj) => Object.entries(obj).map(([k, v]) => `  ${k}: ${js(v)},`).join('\n');

// the things of the land for one dimension: 2D names a sprite2d kind, 3D a craft block
function things(spec) {
  const d3 = spec.dim === '3d', T = {}, art = (block, o) => (d3 ? { art: [block, o] } : { sprite: [block, o] }), cover = (type, o = {}) => (d3 ? { art: ['cover', { type, ...o }] } : { sprite: [type, o] });
  const tree = (key) => { const m = /^([a-z]+?)(2?)$/.exec(key), sp = m[1], seed = m[2] ? (sp === 'pine' ? 4 : 2) : 1, o = { species: sp, seed, ...(sp === 'dead' ? {} : spec.treeOpt) };
    const label = sp === 'dead' ? 'Break the dead tree' : sp === 'mushroom' ? 'Chop the giant mushroom' : 'Chop the ' + sp, drops = sp === 'dead' ? { wood: [1, 2] } : sp === 'mushroom' ? { wood: [1, 2], mushroom: [1, 2] } : sp === 'cactus' ? { wood: [1, 2], fiber: [1, 2] } : { wood: m[2] ? [2, 4] : [2, 3] };
    return { ...art('tree', o), node: { label, hp: sp === 'dead' ? 2 : 4, best: 'axe', drops } }; };
  const make = {
    rock: () => ({ ...art('rock', { ...spec.rockOpt }), node: { label: 'Break the rock', hp: 4, best: 'pickaxe', drops: { stone: [2, 3] } } }),
    mossy: () => ({ ...art('rock', { seed: 3, moss: true }), node: { label: 'Break the rock', hp: 4, best: 'pickaxe', drops: { stone: [2, 4] } } }),
    ore: () => ({ ...art('rock', { seed: 7, ore: 0xc8763a }), node: { label: 'Break the ore rock', hp: 5, best: 'pickaxe', drops: { stone: [1, 2], ore: [1, 2] } } }),
    gemrock: () => ({ ...art('rock', { seed: 5, ore: 0x7fe6ee }), node: { label: 'Break the crystal rock', hp: 6, best: 'pickaxe', drops: { stone: [1, 2], crystal: [1, 2] } } }),
    crystal: () => ({ ...cover('crystal'), node: { label: 'Take the ' + spec.gem.toLowerCase(), drops: { crystal: 1 } } }),
    bush: () => ({ ...art('bush', {}), node: { label: 'Pick the bush', drops: { fiber: [1, 2] }, respawn: 70 } }),
    berries: () => ({ ...art('bush', { seed: 2, berries: 0xd83a4a }), node: { label: 'Pick the berries', drops: { berry: [2, 3], fiber: [0, 1] }, respawn: 90 } }),
    mushrooms: () => ({ ...cover('mushrooms'), node: { label: 'Pick the mushrooms', drops: { mushroom: [1, 2] }, respawn: 120 } }),
    flower: () => cover('flower'), flower2: () => (d3 ? cover('fern') : cover('flower', { seed: 2 })), fern: () => (d3 ? cover('fern') : cover('flower', { seed: 2 })),
    reeds: () => cover('reeds'), log: () => cover('log'), stump: () => cover('stump'), stones: () => (d3 ? cover('stones') : cover('stump')),
  };
  const alias = d3 ? { flower2: 'fern' } : { fern: 'flower2', stones: 'stump' }, name = (k) => alias[k] || k;
  const regions = spec.regions.map((r, i) => { const trees = r.trees.map(name), cov = [...new Set(r.cover.map(name))];
    for (const k of [...trees, ...cov]) if (!T[k]) T[k] = make[k] ? make[k]() : tree(k);
    return { name: r.name, far: r.far, trees, count: [12, 19, 14, 13][i] + (d3 ? 1 : 0), cover: cov, coverCount: [11, 12, 13, 7][i] + (d3 ? 1 : 0), animals: r.animals, chest: [d3 ? 0.15 : 0.12, 0.3, 0.25, 0.4][i] }; });
  T.chest = { ...(d3 ? { art: ['prop', { kind: 'chest' }] } : { sprite: ['chest', {}] }), node: { label: 'Open the chest', drops: { coin: [4, 9], carrot_seed: [1, 3], pumpkin_seed: [0, 2] } } };
  return { T, regions };
}

const ICONS = `const O = '#1d2420';
const ell = (c, x, y, rx, ry, fill) => { c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 6.2832); c.fillStyle = fill; c.fill(); c.lineWidth = 0.05; c.strokeStyle = O; c.stroke(); };
const poly = (c, pts, fill) => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fillStyle = fill; c.fill(); c.lineWidth = 0.05; c.strokeStyle = O; c.stroke(); };
const seeds = (col) => (c) => { poly(c, [[0.2, 0.3], [0.8, 0.3], [0.74, 0.86], [0.26, 0.86]], '#d8c8a0'); poly(c, [[0.2, 0.3], [0.8, 0.3], [0.7, 0.16], [0.3, 0.16]], '#b8a070'); for (const [x, y] of [[0.4, 0.5], [0.6, 0.56], [0.48, 0.7]]) ell(c, x, y, 0.08, 0.055, col); };
const ICON = {
  carrot: (c) => { poly(c, [[0.3, 0.34], [0.62, 0.3], [0.72, 0.5], [0.3, 0.9]], '#f08a2a'); for (const x of [0.34, 0.5, 0.66]) poly(c, [[0.48, 0.34], [x - 0.08, 0.1], [x + 0.06, 0.12]], '#4f9e3c'); },
  pumpkin: (c) => { ell(c, 0.32, 0.58, 0.2, 0.26, '#e8832a'); ell(c, 0.68, 0.58, 0.2, 0.26, '#e8832a'); ell(c, 0.5, 0.58, 0.2, 0.28, '#f59a3a'); poly(c, [[0.46, 0.32], [0.5, 0.14], [0.6, 0.16], [0.56, 0.32]], '#4f7e3c'); },
  corn: (c) => { poly(c, [[0.3, 0.86], [0.2, 0.4], [0.42, 0.62]], '#4f9e3c'); poly(c, [[0.7, 0.86], [0.8, 0.4], [0.58, 0.62]], '#4f9e3c'); ell(c, 0.5, 0.5, 0.16, 0.36, '#f2cc3a'); for (const y of [0.3, 0.44, 0.58, 0.72]) { c.strokeStyle = '#b8902a'; c.lineWidth = 0.035; c.beginPath(); c.moveTo(0.38, y); c.lineTo(0.62, y); c.stroke(); } },
  bread: (c) => { ell(c, 0.5, 0.56, 0.38, 0.24, '#d8a058'); for (const x of [0.34, 0.5, 0.66]) { c.strokeStyle = '#8a5a2a'; c.lineWidth = 0.05; c.beginPath(); c.moveTo(x - 0.04, 0.42); c.lineTo(x + 0.04, 0.62); c.stroke(); } },
  stew: (c) => { ell(c, 0.5, 0.48, 0.36, 0.14, '#c8683a'); poly(c, [[0.14, 0.5], [0.86, 0.5], [0.72, 0.84], [0.28, 0.84]], '#8a6a4a'); ell(c, 0.42, 0.46, 0.06, 0.04, '#f59a3a'); ell(c, 0.6, 0.5, 0.06, 0.04, '#8fd16a'); },
  pail: (c) => { poly(c, [[0.22, 0.36], [0.78, 0.36], [0.7, 0.86], [0.3, 0.86]], '#9aa8b4'); ell(c, 0.5, 0.36, 0.28, 0.09, '#4aa6e8'); c.strokeStyle = O; c.lineWidth = 0.05; c.beginPath(); c.arc(0.5, 0.36, 0.28, Math.PI, 0); c.stroke(); },
  stairs: (c) => { for (let i = 0; i < 4; i++) poly(c, [[0.14 + i * 0.18, 0.86], [0.14 + i * 0.18, 0.7 - i * 0.17], [0.32 + i * 0.18, 0.7 - i * 0.17], [0.32 + i * 0.18, 0.86]], i % 2 ? '#c89858' : '#b88848'); },
  deck: (c) => { poly(c, [[0.1, 0.3], [0.9, 0.3], [0.9, 0.5], [0.1, 0.5]], '#c89858'); for (const x of [0.16, 0.74]) poly(c, [[x, 0.5], [x + 0.1, 0.5], [x + 0.1, 0.88], [x, 0.88]], '#8a5a34'); },
  furnace: (c) => { poly(c, [[0.4, 0.36], [0.4, 0.1], [0.6, 0.1], [0.6, 0.36]], '#6f6a64'); poly(c, [[0.14, 0.9], [0.14, 0.34], [0.86, 0.34], [0.86, 0.9]], '#8c867e'); poly(c, [[0.34, 0.9], [0.34, 0.6], [0.5, 0.5], [0.66, 0.6], [0.66, 0.9]], '#2a1a12'); ell(c, 0.5, 0.8, 0.1, 0.07, '#ff9a3a'); },
};`;

/** The text of src/theme.js for a spec from themeSpec(). */
export function renderTheme(spec) {
  const d3 = spec.dim === '3d', F = spec.features, { T, regions } = things(spec), L = [];
  const look = d3 ? { mood: spec.look.mood, palette: spec.look.palette, weather: spec.look.weather, relief: spec.look.relief, sea: spec.look.sea, accent: spec.look.accent, ink: '#f1e6cf', panel: 'rgba(26,22,16,.8)', soil: [0x7a5434, 0x46301e] }
    : { mood: spec.look.mood, palette: spec.look.palette, weather: spec.look.weather, water: 0.27, accent: spec.look.accent, ink: '#f1e6cf', panel: 'rgba(26,22,16,.8)', wood: [0xb88848, 0xcfa060] };
  const items = {
    wood: { about: 'from trees' }, stone: { about: 'from rocks' }, fiber: { about: 'from bushes' },
    berry: { name: 'Berries', food: 10, sell: 1, ...(F.thirst ? { drink: 6 } : {}), about: 'a little food' }, mushroom: { name: 'Mushroom', food: 8, color: '#c8584a', about: 'a little food' },
    crystal: { name: spec.gem, like: 'gem', sell: 18, about: 'found far from home; the trader pays well' }, coin: { name: 'Coins', about: 'earned at the trading post' },
    wheat: { sell: 3, about: 'bake it into bread at a fire' }, wheat_seed: { name: 'Wheat seeds', plant: 'wheat', buy: 2, icon: 'seeds #e8c040' },
    carrot: { food: 14, sell: 5, icon: 'carrot', about: 'food, or stew' }, carrot_seed: { name: 'Carrot seeds', plant: 'carrot', buy: 6, icon: 'seeds #f08a2a' },
    pumpkin: { food: 18, sell: 11, icon: 'pumpkin', about: 'food, or stew' }, pumpkin_seed: { name: 'Pumpkin seeds', plant: 'pumpkin', buy: 12, icon: 'seeds #f4ecd0' },
    ...(F.corn ? { corn: { food: 16, sell: 7, icon: 'corn', about: 'food, and it sells well' }, corn_seed: { name: 'Corn seeds', plant: 'corn', buy: 8, icon: 'seeds #f2cc3a' } } : {}),
    bread: { food: 42, heal: 8, sell: 10, icon: 'bread', about: 'a real meal' }, stew: { name: 'Harvest stew', food: 75, heal: 25, ...(F.thirst ? { drink: 30 } : {}), icon: 'stew', about: 'the best meal there is' },
    ...(spec.foes && spec.foes.loot.meat ? { meat: { name: 'Raw meat', food: 8, about: 'from a beast; roast it at a fire' }, cooked_meat: { name: 'Roast meat', food: 38, heal: 10, sell: 8, about: 'a good meal' } } : {}),
    ...(F.smelting ? { ore: { name: 'Ore', about: 'from ore rock, far from home' }, ingot: { name: 'Ingot', sell: 9, about: 'smelted from ore at a furnace' } } : {}),
    axe: { tool: 'axe', stack: 1, about: 'fells a tree in half the blows' }, pickaxe: { tool: 'pickaxe', stack: 1, about: 'breaks a rock in half the blows' },
    hoe: { tool: 'hoe', stack: 1, about: 'tills the ground in front of you' }, pail: { name: 'Watering pail', tool: 'pail', stack: 1, icon: 'pail', about: F.thirst ? 'fill it at the well or a shore: water for crops, and a drink' : 'fill it at the well or a shore, then water crops' },
    ...(F.combat ? { sword: { name: F.smelting ? 'Iron sword' : 'Stone sword', weapon: 3, stack: 1, about: 'three times the blow of a bare hand' } } : {}),
    campfire: { place: 'campfire', about: 'light, and a place to cook' }, torch: { place: 'torch', about: 'a light that stays' }, fence: { place: 'fence', about: 'blocks the way' },
    ...(F.smelting ? { furnace: { place: 'furnace', icon: 'furnace', about: 'smelts ore into ingots' }, lamp: { name: 'Iron lamp', like: 'torch', place: 'lamp', about: 'a bright light on a post' } } : {}),
    bed: { name: 'Bedroll', like: 'tent', place: 'bed', about: 'sleep through the night' },
    stairs: { place: 'stairs', icon: 'stairs', about: 'climb to a deck; they rise the way you face' }, deck: { name: 'Lookout deck', place: 'deck', icon: 'deck', about: 'a raised floor, reached by stairs' },
  };
  const recipes = [
    { makes: 'hoe', needs: { wood: 2, stone: 1 } }, { makes: 'axe', needs: { wood: 3, stone: 2 } }, { makes: 'pickaxe', needs: { wood: 2, stone: 3 } },
    ...(F.combat ? [{ makes: 'sword', needs: F.smelting ? { ingot: 2, wood: 1 } : { wood: 2, stone: 3 } }] : []),
    { makes: 'campfire', needs: { wood: 4, stone: 3 } }, { makes: 'torch', needs: { wood: 1, fiber: 1 } }, { makes: 'fence', n: 2, needs: { wood: 2 } },
    ...(F.smelting ? [{ makes: 'furnace', needs: { stone: 8, wood: 2 } }, { makes: 'ingot', needs: { ore: 2, wood: 1 }, station: 'furnace' }, { makes: 'lamp', needs: { ingot: 1, fiber: 1 } }] : []),
    { makes: 'bed', needs: { wood: 4, fiber: 4 } }, { makes: 'stairs', needs: { wood: 6 } }, { makes: 'deck', n: 2, needs: { wood: 4 } },
    { makes: 'bread', needs: { wheat: 3 }, station: 'campfire' }, { makes: 'stew', needs: { carrot: 2, pumpkin: 1 }, station: 'campfire' },
    ...(items.meat ? [{ makes: 'cooked_meat', needs: { meat: 1 }, station: 'campfire' }] : []),
  ];
  const crops = { wheat: { seed: 'wheat_seed', grow: 80, yields: { wheat: [2, 3], wheat_seed: [1, 2] } }, carrot: { seed: 'carrot_seed', grow: 110, yields: { carrot: [2, 3], carrot_seed: [1, 2] } },
    pumpkin: { seed: 'pumpkin_seed', grow: 150, yields: { pumpkin: [1, 2], pumpkin_seed: [1, 2] } }, ...(F.corn ? { corn: { seed: 'corn_seed', grow: 130, yields: { corn: [2, 3], corn_seed: [1, 2] } } } : {}) };
  const art = d3 ? 'model' : 'sprite', pieces = {
    plot: { shape: 'plot' }, stairs: { shape: 'stairs', cost: { stairs: 1 } }, deck: { shape: 'deck', cost: { deck: 1 }, level: 1 },
    campfire: { [art]: 'campfire', cost: { campfire: 1 }, solid: d3 ? 0.9 : 0.4, station: true, use: 'cook', label: 'Cook at the fire' },
    ...(F.smelting ? { furnace: { shape: 'furnace', cost: { furnace: 1 }, solid: d3 ? 1.1 : 0.5, station: true, use: 'cook', label: 'Smelt at the furnace' }, lamp: { [art]: 'lamp', cost: { lamp: 1 }, solid: d3 ? 0.4 : 0.2 } } : {}),
    torch: { [art]: 'torch', cost: { torch: 1 } }, fence: { [art]: 'fence', cost: { fence: 1 }, solid: d3 ? 1 : 0.5 },
    bed: { [art]: 'tent', cost: { bed: 1 }, solid: d3 ? 1.5 : 0.7, use: 'sleep', label: 'Sleep until morning' },
  };
  const home = d3 ? "{ well: [-6, -5], post: [7, -5], decor: [['stall', 7, -6.6, 0, 1.8], ['crate', 9.4, -5.6, 0.4, 0.6], ['barrel', 4.9, -6.2, 0, 0.5], ['lantern', 3, -3, 0, 0], ['haystack', -8.5, 3, 0.3, 1.1], ['signpost', 2.2, 5.5, 0.4, 0.2]], flat: 16, clear: 12 }"
    : "{ well: [-3.5, -2.5], post: [4.5, -2.5], decor: [['crate', 5.6, -2.2], ['barrel', 3.4, -2.3], ['lantern', 2.2, -1.2], ['log', -1.5, 2.5]], clear: 6.5 }";
  const use = 'Use what you hold: till, sow, water, eat, place' + (F.combat ? ', strike' : '');
  const controls = d3 ? [['WASD', 'Move'], ['Drag', 'Look around'], ['Shift', 'Run'], ['Space', 'Jump'], ['E', 'Gather, harvest, open'], ['F / right click', use], ['1 to 8', 'Pick a slot'], ['Tab', 'Backpack and crafting'], ['X', 'Take back the piece in front'], ['M', 'Sound on / off']]
    : [['WASD', 'Move'], ['Shift', 'Run'], ['E', 'Gather, harvest, open'], ['Space / click', use], ['1 to 8', 'Pick a slot'], ['Tab', 'Backpack and crafting'], ['X', 'Take back the piece in front'], ['M', 'Sound on / off']];
  L.push(`// ${spec.title} — THEME. Everything in this file is what makes the game *this* game: its name, its look, the things`,
    '// in it, what grows, what can be built, what the land is like as you walk outwards, and the steps that teach it.',
    '// src/main.js is the ENGINE: it reads these tables and never names an item itself. To make another game on the same',
    '// engine (a moon farm, a pirate cove, a mushroom kingdom), rewrite this file and leave main.js alone.',
    THEME_MARK + themeMark(spec),
    '', '/* ===== names, look and sound ===== */',
    `export const TITLE = ${js(spec.title)};`, `export const TAGLINE = ${js(spec.tagline)};`,
    `export const SEED = ${js(spec.seed)};            // one seed: the same endless land for every player, on every visit`,
    `export const SAVE_KEY = ${js(spec.saveKey)};`,
    `export const SAVE = ${js(spec.save)};            // cloud: false keeps the world in the browser of whoever hosts it, and nowhere else`,
    `export const HERO = ${js(spec.hero)}, FRIENDS = [0x3f7fbf, 0x7a4ab8, 0x2f9a6a, 0xd8904a];   // ${d3 ? 'humanoid' : 'actor2d'} preset; shirt colours of other players`,
    `export const LOOK = ${js(look)};   // weather: what drifts in the air by day (null: clear)${d3 ? '; relief: metres of hills; sea: water colour; soil: dry, watered' : ''}`,
    `export const SOUND = ${js(spec.sound)};`,
    `export const DAY = ${d3 ? 360 : 300};                      // seconds in a full day`,
    `export const NEEDS = ${js(spec.needs)};            // days a full bar lasts. Add water: 1 for thirst (drink at the well or a shore)`,
    '', '/* ===== icons for the things the kit has no picture of (drawn in a 1 × 1 square) ===== */', ICONS,
    '', '/* ===== things: anything written here is read back with inv.def(id) =====',
    '   food / heal / drink: eaten from the hand.   tool: what it does in the hand (axe, pickaxe, hoe, pail).   weapon: blows it deals.   plant: the crop a seed grows.',
    "   place: the piece it puts in the world.   sell / buy: its price in coins at the trading post.   icon: a name in ICON above, or 'seeds <colour>'. */",
    'export const ITEMS = {', rows(items), '};',
    "for (const d of Object.values(ITEMS)) if (typeof d.icon === 'string') d.icon = d.icon.startsWith('seeds ') ? seeds(d.icon.slice(6)) : ICON[d.icon];",
    `export const START = { wheat_seed: 4, berry: 4, pail: 1 };`, 'export const PAIL = 6;                       // waterings in a full pail',
    '', '/* ===== recipes: station names a piece (PIECES) the player must stand beside ===== */', 'export const RECIPES = [', recipes.map((r) => '  ' + js(r) + ',').join('\n'), '];',
    '', '/* ===== crops: grow is seconds from seed to ripe, in three waterings (each new stage dries the soil again) ===== */', 'export const CROPS = {', rows(crops), '};',
    '', `/* ===== pieces: what stands where. ${art} is a ${d3 ? 'prop()' : 'sprite2d'} kind; shape marks the ones the engine draws and gives rules to: a tilled plot, stairs, a raised deck, a furnace =====`,
    '   solid: collision radius.  station: recipes that need it work beside it.  level: the storey it is built on.  use: what E does at it. */',
    'export const PIECES = {', rows(pieces), '};',
    '', '/* ===== the land. Every chunk belongs to a region; a region decides what stands in it and what lives there. =====',
    d3 ? '   art: [block, options] with block one of tree | rock | bush | cover (groundCover: options.type) | prop (options.kind).' : '   sprite: [sprite2d kind, options].',
    '   node: what the player gets (see createNodes): hp blows, best tool, drops, respawn seconds (none: gone for good). */',
    'export const THINGS = {', rows(T), '};',
    '// far: how many chunks from home a region can first appear. chest: the chance a chunk of it hides one.', 'export const REGIONS = [', regions.map((r) => '  ' + js(r) + ',').join('\n'), '];',
    '', '/* ===== foes: what comes out after dark (null: nothing does). kinds, hp (blows of a bare hand), hit (health lost), count at once, every (seconds between), loot ===== */',
    `export const FOES = ${js(spec.foes)};`,
    '', `/* ===== home: what stands at the start, the same for every player (${d3 ? '[prop kind, x, z, turn, collision radius]' : 'x, y from the spawn'}) ===== */`, `export const HOME = ${home};`,
    '', '/* ===== the almanac: steps that teach the loop, checked in order. WHEN reads the counters the engine keeps and the backpack. ===== */',
    'const WHEN = {',
    "  gather: (s, inv) => inv.has('wood', 3) && inv.has('stone', 1) || inv.has('hoe'), hoe: (s, inv) => inv.has('hoe') || s.tilled > 0, till: (s) => s.planted > 0, water: (s) => s.watered > 0,",
    `  drink: (s) => s.drinks > 0, harvest: (s) => s.harvested > 0, explore: (s) => s.charted >= ${d3 ? 8 : 12}, cook: (s) => s.meals > 0 && s.cooked > 0, smelt: (s, inv) => inv.has('ingot') || inv.has('lamp') || inv.has('sword'),`,
    '  sell: (s) => s.sold > 0, fight: (s) => s.slain > 0, climb: (s) => s.climbed > 0,', '};',
    'export const STEPS = [', spec.steps.map((s) => '  ' + js(s) + ',').join('\n'), '].map(([id, text]) => ({ id, text, when: WHEN[id] }));',
    `export const CONTROLS = ${js(controls)};`,
    `export const HINT = ${js(d3 ? 'WASD move · drag to look · E gather · F use what you hold · Tab backpack' : 'WASD move · E gather · Space use what you hold · Tab backpack')};`, '');
  return L.join('\n');
}

// One comment line in the theme says what it was written from, so the report can tell later how much of it is still
// what the platform wrote (own_work). It holds the plan's few values and the brief's cues as plain words.
export const THEME_MARK = '// Written for this brief by design_scene. Theme-Plan: ';
const themeMark = (spec) => { const F = spec.features; return JSON.stringify({ plan: { title: spec.title, seed: spec.seed, setting: spec.setting, stage: { mood: spec.look.mood, weather: spec.look.weather || 'none' }, ground: { palette: spec.look.palette }, hero: { preset: spec.hero } },
  brief: [F.smelting && 'smelting', F.thirst && 'thirst', F.combat && 'combat', F.corn && 'corn', F.local_save && 'local save', F.players === 4 ? 'up to four players' : F.players === 'several' && 'multiplayer', ...spec.named].filter(Boolean).join(', ') }); };
/** The theme text the platform wrote for the theme a project now has (read from its mark line), or null without one. */
export function themeAsWritten(name, text) {
  const i = String(text || '').indexOf(THEME_MARK); if (i < 0) return null;
  try { const m = JSON.parse(text.slice(i + THEME_MARK.length).split('\n')[0]); return themeFor(name, m.plan, m.brief); } catch { return null; }
}

/** src/theme.js for a template ('homestead-2d' | 'homestead-3d'), a plan and the brief it came from. */
export function themeFor(name, plan, brief) { return renderTheme(themeSpec(/3d$/.test(name) ? '3d' : '2d', plan, brief)); }

/** In a sentence each: what the generated theme already holds for this brief, and what is left to the agent. */
export function themeNotes(spec) {
  const F = spec.features, got = [`the title "${spec.title}" and its tagline`, `the ${spec.setting} setting (mood ${spec.look.mood}, palette ${spec.look.palette}${spec.look.weather ? ', ' + spec.look.weather + ' in the air' : ''}) with the regions ${spec.regions.map((r) => r.name).join(', ')}`,
    `crops: ${spec.crops.join(', ')}`, ...(F.thirst ? ['thirst (a water bar, filled at the well or a shore)'] : []), ...(F.smelting ? ['smelting (ore rock, a furnace, ingots, an iron lamp' + (F.combat ? ', an iron sword)' : ')')] : []),
    ...(F.combat ? [`combat (${spec.foes.kinds.join(' and ')} at night, a sword, loot: ${Object.keys(spec.foes.loot).join(', ')})`] : []), ...(F.local_save ? ['saving on the host\'s device only (SAVE.cloud false)'] : []),
    `an almanac of ${spec.steps.length} steps that teaches all of it`];
  const left = ['the theme is a competent default, not a design: give the regions things worth the walk, name the items and write the almanac in the voice of your game',
    ...(F.combat ? ['foes are simple chasers and each player meets their own: a boss, ranged attacks or foes shared in the room are yours to add'] : []),
    ...(F.players === 4 ? ['four players can join one room; only two are proved by the play-through'] : []),
    'anything else the brief asks for that is not in the list above'];
  return { already_in_the_theme: got, left_for_you: left };
}

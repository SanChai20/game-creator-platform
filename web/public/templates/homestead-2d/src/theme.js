// Brackenfold — THEME. Everything in this file is what makes the game *this* game: its name, its look, the things
// in it, what grows, what can be built, what the land is like as you walk outwards, and the steps that teach it.
// src/main.js is the ENGINE: it reads these tables and never names an item itself. To make another game on the same
// engine (a moon farm, a pirate cove, a mushroom kingdom), rewrite this file and leave main.js alone.
// Written for this brief by design_scene. Theme-Plan: {"plan":{"title":"Brackenfold","seed":"bracken-7","setting":"forest","stage":{"mood":"clear-day","weather":"motes"},"ground":{"palette":"temperate"},"hero":{"preset":"farmer"}},"brief":""}

/* ===== names, look and sound ===== */
export const TITLE = 'Brackenfold';
export const TAGLINE = 'Till a plot, tend it, and walk a little further every day. Alone or with a friend.';
export const SEED = 'bracken-7';            // one seed: the same endless land for every player, on every visit
export const SAVE_KEY = 'brackenfold-1';
export const SAVE = { cloud: true };            // cloud: false keeps the world in the browser of whoever hosts it, and nowhere else
export const HERO = 'farmer', FRIENDS = [0x3f7fbf, 0x7a4ab8, 0x2f9a6a, 0xd8904a];   // actor2d preset; shirt colours of other players
export const LOOK = { mood: 'clear-day', palette: 'temperate', weather: 'motes', water: 0.27, accent: '#f0b64a', ink: '#f1e6cf', panel: 'rgba(26,22,16,.8)', wood: [0xb88848, 0xcfa060] };   // weather: what drifts in the air by day (null: clear)
export const SOUND = { ambience: 'forest', nightAmbience: 'night', music: 'calm' };
export const DAY = 300;                      // seconds in a full day
export const NEEDS = { food: 1.4 };            // days a full bar lasts. Add water: 1 for thirst (drink at the well or a shore)

/* ===== icons for the things the kit has no picture of (drawn in a 1 × 1 square) ===== */
const O = '#1d2420';
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
};

/* ===== things: anything written here is read back with inv.def(id) =====
   food / heal / drink: eaten from the hand.   tool: what it does in the hand (axe, pickaxe, hoe, pail).   weapon: blows it deals.   plant: the crop a seed grows.
   place: the piece it puts in the world.   sell / buy: its price in coins at the trading post.   icon: a name in ICON above, or 'seeds <colour>'. */
export const ITEMS = {
  wood: { about: 'from trees' },
  stone: { about: 'from rocks' },
  fiber: { about: 'from bushes' },
  berry: { name: 'Berries', food: 10, sell: 1, about: 'a little food' },
  mushroom: { name: 'Mushroom', food: 8, color: '#c8584a', about: 'a little food' },
  crystal: { name: 'Fen crystal', like: 'gem', sell: 18, about: 'found far from home; the trader pays well' },
  coin: { name: 'Coins', about: 'earned at the trading post' },
  wheat: { sell: 3, about: 'bake it into bread at a fire' },
  wheat_seed: { name: 'Wheat seeds', plant: 'wheat', buy: 2, icon: 'seeds #e8c040' },
  carrot: { food: 14, sell: 5, icon: 'carrot', about: 'food, or stew' },
  carrot_seed: { name: 'Carrot seeds', plant: 'carrot', buy: 6, icon: 'seeds #f08a2a' },
  pumpkin: { food: 18, sell: 11, icon: 'pumpkin', about: 'food, or stew' },
  pumpkin_seed: { name: 'Pumpkin seeds', plant: 'pumpkin', buy: 12, icon: 'seeds #f4ecd0' },
  bread: { food: 42, heal: 8, sell: 10, icon: 'bread', about: 'a real meal' },
  stew: { name: 'Harvest stew', food: 75, heal: 25, icon: 'stew', about: 'the best meal there is' },
  axe: { tool: 'axe', stack: 1, about: 'fells a tree in half the blows' },
  pickaxe: { tool: 'pickaxe', stack: 1, about: 'breaks a rock in half the blows' },
  hoe: { tool: 'hoe', stack: 1, about: 'tills the ground in front of you' },
  pail: { name: 'Watering pail', tool: 'pail', stack: 1, icon: 'pail', about: 'fill it at the well or a shore, then water crops' },
  campfire: { place: 'campfire', about: 'light, and a place to cook' },
  torch: { place: 'torch', about: 'a light that stays' },
  fence: { place: 'fence', about: 'blocks the way' },
  bed: { name: 'Bedroll', like: 'tent', place: 'bed', about: 'sleep through the night' },
  stairs: { place: 'stairs', icon: 'stairs', about: 'climb to a deck; they rise the way you face' },
  deck: { name: 'Lookout deck', place: 'deck', icon: 'deck', about: 'a raised floor, reached by stairs' },
};
for (const d of Object.values(ITEMS)) if (typeof d.icon === 'string') d.icon = d.icon.startsWith('seeds ') ? seeds(d.icon.slice(6)) : ICON[d.icon];
export const START = { wheat_seed: 4, berry: 4, pail: 1 };
export const PAIL = 6;                       // waterings in a full pail

/* ===== recipes: station names a piece (PIECES) the player must stand beside ===== */
export const RECIPES = [
  { makes: 'hoe', needs: { wood: 2, stone: 1 } },
  { makes: 'axe', needs: { wood: 3, stone: 2 } },
  { makes: 'pickaxe', needs: { wood: 2, stone: 3 } },
  { makes: 'campfire', needs: { wood: 4, stone: 3 } },
  { makes: 'torch', needs: { wood: 1, fiber: 1 } },
  { makes: 'fence', n: 2, needs: { wood: 2 } },
  { makes: 'bed', needs: { wood: 4, fiber: 4 } },
  { makes: 'stairs', needs: { wood: 6 } },
  { makes: 'deck', n: 2, needs: { wood: 4 } },
  { makes: 'bread', needs: { wheat: 3 }, station: 'campfire' },
  { makes: 'stew', needs: { carrot: 2, pumpkin: 1 }, station: 'campfire' },
];

/* ===== crops: grow is seconds from seed to ripe, in three waterings (each new stage dries the soil again) ===== */
export const CROPS = {
  wheat: { seed: 'wheat_seed', grow: 80, yields: { wheat: [2, 3], wheat_seed: [1, 2] } },
  carrot: { seed: 'carrot_seed', grow: 110, yields: { carrot: [2, 3], carrot_seed: [1, 2] } },
  pumpkin: { seed: 'pumpkin_seed', grow: 150, yields: { pumpkin: [1, 2], pumpkin_seed: [1, 2] } },
};

/* ===== pieces: what stands where. sprite is a sprite2d kind; shape marks the ones the engine draws and gives rules to: a tilled plot, stairs, a raised deck, a furnace =====
   solid: collision radius.  station: recipes that need it work beside it.  level: the storey it is built on.  use: what E does at it. */
export const PIECES = {
  plot: { shape: 'plot' },
  stairs: { shape: 'stairs', cost: { stairs: 1 } },
  deck: { shape: 'deck', cost: { deck: 1 }, level: 1 },
  campfire: { sprite: 'campfire', cost: { campfire: 1 }, solid: 0.4, station: true, use: 'cook', label: 'Cook at the fire' },
  torch: { sprite: 'torch', cost: { torch: 1 } },
  fence: { sprite: 'fence', cost: { fence: 1 }, solid: 0.5 },
  bed: { sprite: 'tent', cost: { bed: 1 }, solid: 0.7, use: 'sleep', label: 'Sleep until morning' },
};

/* ===== the land. Every chunk belongs to a region; a region decides what stands in it and what lives there. =====
   sprite: [sprite2d kind, options].
   node: what the player gets (see createNodes): hp blows, best tool, drops, respawn seconds (none: gone for good). */
export const THINGS = {
  oak: { sprite: ['tree', { species: 'oak', seed: 1 }], node: { label: 'Chop the oak', hp: 4, best: 'axe', drops: { wood: [2, 3] } } },
  oak2: { sprite: ['tree', { species: 'oak', seed: 2 }], node: { label: 'Chop the oak', hp: 4, best: 'axe', drops: { wood: [2, 4] } } },
  birch: { sprite: ['tree', { species: 'birch', seed: 1 }], node: { label: 'Chop the birch', hp: 4, best: 'axe', drops: { wood: [2, 3] } } },
  rock: { sprite: ['rock', {}], node: { label: 'Break the rock', hp: 4, best: 'pickaxe', drops: { stone: [2, 3] } } },
  bush: { sprite: ['bush', {}], node: { label: 'Pick the bush', drops: { fiber: [1, 2] }, respawn: 70 } },
  berries: { sprite: ['bush', { seed: 2, berries: 0xd83a4a }], node: { label: 'Pick the berries', drops: { berry: [2, 3], fiber: [0, 1] }, respawn: 90 } },
  flower: { sprite: ['flower', {}] },
  flower2: { sprite: ['flower', { seed: 2 }] },
  log: { sprite: ['log', {}] },
  pine: { sprite: ['tree', { species: 'pine', seed: 1 }], node: { label: 'Chop the pine', hp: 4, best: 'axe', drops: { wood: [2, 3] } } },
  pine2: { sprite: ['tree', { species: 'pine', seed: 4 }], node: { label: 'Chop the pine', hp: 4, best: 'axe', drops: { wood: [2, 4] } } },
  mossy: { sprite: ['rock', { seed: 3, moss: true }], node: { label: 'Break the rock', hp: 4, best: 'pickaxe', drops: { stone: [2, 4] } } },
  mushrooms: { sprite: ['mushrooms', {}], node: { label: 'Pick the mushrooms', drops: { mushroom: [1, 2] }, respawn: 120 } },
  stump: { sprite: ['stump', {}] },
  maple: { sprite: ['tree', { species: 'maple', seed: 1 }], node: { label: 'Chop the maple', hp: 4, best: 'axe', drops: { wood: [2, 3] } } },
  willow: { sprite: ['tree', { species: 'willow', seed: 1 }], node: { label: 'Chop the willow', hp: 4, best: 'axe', drops: { wood: [2, 3] } } },
  reeds: { sprite: ['reeds', {}] },
  gemrock: { sprite: ['rock', { seed: 5, ore: 0x7fe6ee }], node: { label: 'Break the crystal rock', hp: 6, best: 'pickaxe', drops: { stone: [1, 2], crystal: [1, 2] } } },
  dead: { sprite: ['tree', { species: 'dead', seed: 1 }], node: { label: 'Break the dead tree', hp: 2, best: 'axe', drops: { wood: [1, 2] } } },
  crystal: { sprite: ['crystal', {}], node: { label: 'Take the fen crystal', drops: { crystal: 1 } } },
  chest: { sprite: ['chest', {}], node: { label: 'Open the chest', drops: { coin: [4, 9], carrot_seed: [1, 3], pumpkin_seed: [0, 2] } } },
};
// far: how many chunks from home a region can first appear. chest: the chance a chunk of it hides one.
export const REGIONS = [
  { name: 'Home meadow', far: 0, trees: ['oak', 'oak2', 'birch', 'rock'], count: 12, cover: ['bush', 'berries', 'flower', 'flower2', 'log'], coverCount: 11, animals: ['rabbit', 'chicken'], chest: 0.12 },
  { name: 'The Pinewood', far: 2, trees: ['pine', 'pine2', 'pine', 'mossy', 'oak'], count: 19, cover: ['mushrooms', 'flower2', 'log', 'stump', 'bush'], coverCount: 12, animals: ['deer', 'fox'], chest: 0.3 },
  { name: 'Maple Rise', far: 2, trees: ['maple', 'birch', 'maple', 'rock', 'willow'], count: 14, cover: ['berries', 'flower', 'bush', 'reeds', 'stump'], coverCount: 13, animals: ['deer', 'rabbit'], chest: 0.25 },
  { name: 'The Stonefield', far: 3, trees: ['rock', 'mossy', 'rock', 'gemrock', 'dead'], count: 13, cover: ['crystal', 'stump', 'bush'], coverCount: 7, animals: ['boar'], chest: 0.4 },
];

/* ===== foes: what comes out after dark (null: nothing does). kinds, hp (blows of a bare hand), hit (health lost), count at once, every (seconds between), loot ===== */
export const FOES = null;

/* ===== home: what stands at the start, the same for every player (x, y from the spawn) ===== */
export const HOME = { well: [-3.5, -2.5], post: [4.5, -2.5], decor: [['crate', 5.6, -2.2], ['barrel', 3.4, -2.3], ['lantern', 2.2, -1.2], ['log', -1.5, 2.5]], clear: 6.5 };

/* ===== the almanac: steps that teach the loop, checked in order. WHEN reads the counters the engine keeps and the backpack. ===== */
const WHEN = {
  gather: (s, inv) => inv.has('wood', 3) && inv.has('stone', 1) || inv.has('hoe'), hoe: (s, inv) => inv.has('hoe') || s.tilled > 0, till: (s) => s.planted > 0, water: (s) => s.watered > 0,
  drink: (s) => s.drinks > 0, harvest: (s) => s.harvested > 0, explore: (s) => s.charted >= 12, cook: (s) => s.meals > 0 && s.cooked > 0, smelt: (s, inv) => inv.has('ingot') || inv.has('lamp') || inv.has('sword'),
  sell: (s) => s.sold > 0, fight: (s) => s.slain > 0, climb: (s) => s.climbed > 0,
};
export const STEPS = [
  ['gather', 'Chop a tree and break a rock: 3 wood, 1 stone'],
  ['hoe', 'Open the backpack and craft a hoe'],
  ['till', 'Hold the hoe and till a plot, then plant wheat seeds on it'],
  ['water', 'Fill the pail at the well and water the crop'],
  ['harvest', 'Keep it watered and harvest it when it is ripe'],
  ['explore', 'Walk out and chart 12 new pieces of land: The Pinewood lies beyond'],
  ['cook', 'Build a campfire, bake bread and eat it'],
  ['sell', 'Sell a harvest at the trading post'],
  ['climb', 'Craft stairs and a lookout deck, and climb up'],
].map(([id, text]) => ({ id, text, when: WHEN[id] }));
export const CONTROLS = [['WASD', 'Move'], ['Shift', 'Run'], ['E', 'Gather, harvest, open'], ['Space / click', 'Use what you hold: till, sow, water, eat, place'], ['1 to 8', 'Pick a slot'], ['Tab', 'Backpack and crafting'], ['X', 'Take back the piece in front'], ['M', 'Sound on / off']];
export const HINT = 'WASD move · E gather · Space use what you hold · Tab backpack';

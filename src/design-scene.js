// Scene planner behind the design_scene tool. It turns a short description into (1) a plan that names the building
// blocks for every part of a 3D game and (2) a complete starting game that calls only those blocks. Plain keyword
// rules, no AI: the same description and seed always give the same plan. Nothing here is a house style: every choice
// is an argument the caller can override, and the code it returns is ordinary code the agent keeps editing.

import { write2d, PLAY_SYSTEMS, PLAY_INTERFACE } from './design-scene-2d.js';
import { PLAY_IMPORTS, playBind, homesteadRules } from './design-scene-play.js';

const K = (code, r = 0) => ({ code, r });   // a landmark: code of the kind, radius of its footprint (0 = walk through)

// One row per setting. `words` decide which row a description lands on. Kinds are written as code so the result reads
// like something a person would type.
const SETTINGS = {
  forest: {
    words: /forest|wood|grove|glade|ranger|camp|hike|trail|deer|ember/, title: 'Ember Wood', mood: 'clear-day', weather: 'motes', shape: 'hills', palette: 'temperate', amplitude: 9,
    big: ["tree({ species: 'oak' })", "tree({ species: 'oak', seed: 2 })", "tree({ species: 'pine' })", "tree({ species: 'birch' })", "tree({ species: 'maple' })", 'rock()', 'rock({ seed: 3, moss: true })'],
    small: ['bush()', 'bush({ seed: 2, berries: 0xd83a4a })', "groundCover('fern')", "groundCover('flower')", "groundCover('flower', { seed: 2 })", "groundCover('mushrooms')", "groundCover('stones')", "groundCover('log')"],
    grass: '', camp: [K("prop('hut')", 3), K("'campfire'"), K("'tent'", 1.8), K("'signpost'"), K("'crate'"), K("'barrel'"), K("'bench'"), K("'lantern'")],
    animals: ['deer', 'deer', 'rabbit', 'rabbit', 'fox', 'bird', 'bird'], foes: ['wolf', 'wolf', 'boar', 'bear'], hero: 'explorer', pickup: ['gem', '0xff7a3a', 'Embers', 'ember gems'],
    ambience: 'forest', music: 'adventure', accent: '#ffb347',
  },
  island: {
    words: /island|isle|beach|tropic|ocean|sea\b|shore|pirate|lagoon|palm|castaway|treasure/, title: 'Coral Cay', mood: 'clear-day', weather: null, shape: 'island', palette: 'tropical', amplitude: 11,
    big: ["tree({ species: 'palm' })", "tree({ species: 'palm', seed: 2 })", "tree({ species: 'palm', seed: 3 })", "tree({ species: 'oak' })", "tree({ species: 'blossom' })", 'rock({ color: 0x9a9488 })', 'rock({ seed: 4, moss: true })'],
    small: ['bush({ flowers: 0xff6aa0 })', 'bush({ seed: 2 })', "groundCover('fern')", "groundCover('flower', { color: 0xffd23f })", "groundCover('reeds')", "groundCover('stones')", "groundCover('log')", "groundCover('tuft')"],
    grass: '', camp: [K("prop('hut')", 3), K("'campfire'"), K("'boat'", 2), K("'signpost'"), K("'chest'"), K("'barrel'"), K("'crate'"), K("'torch'")],
    animals: ['bird', 'bird', 'bird', 'pig', 'goat', 'rabbit', 'chicken'], foes: ['boar', 'boar', 'wolf', 'bat'], hero: 'pirate', pickup: ['coin', '0xffc83a', 'Doubloons', 'gold doubloons'],
    ambience: 'ocean', music: 'adventure', accent: '#ffd23f',
  },
  desert: {
    words: /desert|dune|sand|oasis|canyon|mesa|cactus|pyramid|nomad|wasteland/, title: 'Sunken Dunes', mood: 'desert', weather: 'dust', shape: 'dunes', palette: 'desert', amplitude: 8,
    big: ["tree({ species: 'cactus' })", "tree({ species: 'cactus', seed: 2 })", "tree({ species: 'palm' })", "tree({ species: 'dead' })", 'rock({ color: 0xb8865a })', 'rock({ seed: 2, color: 0xa8754a, size: 1.6 })'],
    small: ["groundCover('stones')", "groundCover('stones', { seed: 2 })", "groundCover('tuft', { color: 0xb8a060 })", "groundCover('stump')", "groundCover('log')", 'bush({ color: 0x8a8a4a })', "groundCover('flower', { color: 0xff8a3a })"],
    grass: '', grassOpt: ', count: 4500', camp: [K("'ruin'", 2.5), K("'well'", 1.3), K("'tent'", 1.8), K("'pillar'", 0.6), K("'arch'", 0.8), K("'crate'"), K("'cart'", 1.2), K("'torch'")],
    animals: ['goat', 'goat', 'horse', 'bird', 'bird', 'rabbit'], foes: ['wolf', 'wolf', 'boar', 'bat'], hero: 'explorer', pickup: ['orb', '0x40d0ff', 'Relics', 'water relics'],
    ambience: 'wind', music: 'mystery', accent: '#ffc46a',
  },
  snow: {
    words: /snow|ice\b|icy|arctic|winter|frozen|frost|tundra|glacier|blizzard|polar/, title: 'Frostfall', mood: 'arctic', weather: 'snow', shape: 'hills', palette: 'snow', amplitude: 9, water: '0x7fb4d6',
    big: ["tree({ species: 'pine', snow: true })", "tree({ species: 'pine', seed: 2, snow: true })", "tree({ species: 'pine', seed: 3, snow: true })", "tree({ species: 'dead' })", "tree({ species: 'birch', snow: true })", 'rock({ snow: true })', 'rock({ seed: 2, snow: true, size: 1.5 })'],
    small: ["groundCover('stones')", "groundCover('stump')", "groundCover('log')", 'bush({ color: 0x9ab8a8 })', "groundCover('crystal', { color: 0x9adfff })", "groundCover('tuft', { color: 0xc8d8dc })"],
    grass: '', grassOpt: ', count: 8000', smallCount: 380, camp: [K("prop('hut')", 3), K("'campfire'"), K("'lantern'"), K("'signpost'"), K("'crate'"), K("'barrel'"), K("'bench'"), K("'flag'")],
    animals: ['deer', 'rabbit', 'rabbit', 'fox', 'bird', 'goat'], foes: ['wolf', 'wolf', 'wolf', 'bear'], hero: 'explorer', pickup: ['star', '0xffe45a', 'Stars', 'fallen stars'],
    ambience: 'wind', music: 'calm', accent: '#8fd3ff',
  },
  volcanic: {
    words: /volcan|lava|magma|ash\b|ashen|inferno|hell|fire\s?land|scorch|dragon/, title: 'Cinder Reach', mood: 'volcanic', weather: 'embers', shape: 'hills', palette: 'volcanic', amplitude: 10, water: '0xd8431a',
    big: ["tree({ species: 'dead' })", "tree({ species: 'dead', seed: 2 })", "tree({ species: 'dead', seed: 3, size: 1.3 })", 'rock({ color: 0x5a4a42 })', 'rock({ seed: 2, color: 0x4a3e3a, ore: 0xff6a2a })', 'rock({ seed: 3, color: 0x6a5248, size: 1.8 })', "prop('torch')"],
    small: ["groundCover('stones', { color: 0x5a4a42 })", "groundCover('crystal', { color: 0xff6a2a })", "groundCover('stump')", "groundCover('log')", "groundCover('stones', { seed: 2 })", "groundCover('mushrooms', { color: 0xd8431a })"],
    grass: '', grassOpt: ', count: 6000', camp: [K("'ruin'", 2.5), K("'beacon'", 0.7), K("'pillar'", 0.6), K("'torch'"), K("'arch'", 0.8), K("'spikes'"), K("'statue'", 0.8), K("'torch'")],
    animals: ['bat', 'bat', 'goat', 'bird'], foes: ['slime', 'slime', 'bat', 'wolf'], hero: 'knight', pickup: ['gem', '0xffb03a', 'Sunstones', 'sunstones'],
    ambience: 'fire', music: 'tense', accent: '#ff8a3a',
  },
  alien: {
    words: /alien|planet|space|moon\b|mars|sci-?fi|astronaut|robot|colony|crater|nebula|space station|futur/, title: 'Violet Drift', mood: 'alien', weather: 'fireflies', shape: 'hills', palette: 'alien', amplitude: 9, water: '0x7a4ad8',
    big: ["tree({ species: 'mushroom' })", "tree({ species: 'mushroom', seed: 2, leaf: 0x6ad8c8 })", "tree({ species: 'mushroom', seed: 3, leaf: 0xc86ad8 })", "tree({ species: 'cypress', leaf: 0x5a3a9a })", 'rock({ color: 0x4a3a6a, ore: 0x6ef0ff })', 'rock({ seed: 2, color: 0x3a3a5a, size: 1.6 })'],
    small: ["groundCover('crystal', { color: 0x6ef0ff })", "groundCover('crystal', { seed: 2, color: 0xff6ad8 })", "groundCover('mushrooms', { color: 0x6ad8c8 })", "groundCover('fern', { color: 0x7a4aa8 })", "groundCover('stones', { color: 0x4a3a6a })", 'bush({ color: 0x3f9a8a, berries: 0xff6ad8 })'],
    grass: '', camp: [K("'container'", 2.2), K("'antenna'", 0.6), K("'console'", 0.9), K("'beacon'", 0.7), K("'drum'", 0.5), K("'drum'", 0.5), K("'pipe'", 0.6), K("'barrier'", 0.9)],
    animals: ['slime', 'slime', 'bird', 'bat', 'rabbit'], foes: ['slime', 'slime', 'ghost', 'bat'], hero: 'astronaut', pickup: ['orb', '0x6ef0ff', 'Cores', 'energy cores'],
    ambience: 'space', music: 'mystery', accent: '#6ef0ff',
  },
  village: {
    words: /village|town|farm|market|hamlet|cottage|harvest|shepherd|medieval|kingdom|castle|king\b|villager/, title: 'Millbrook', mood: 'clear-day', weather: null, shape: 'plains', palette: 'temperate', amplitude: 8,
    big: ["tree({ species: 'oak' })", "tree({ species: 'birch' })", "tree({ species: 'blossom' })", "tree({ species: 'maple' })", "prop('haystack')", "prop('fence')", 'rock()'],
    small: ['bush({ flowers: 0xffffff })', 'bush({ seed: 2, berries: 0xd83a4a })', "groundCover('flower')", "groundCover('flower', { seed: 2, color: 0xffd23f })", "groundCover('flower', { seed: 3, color: 0xc86ad8 })", "groundCover('tuft')", "groundCover('stones')", "groundCover('stump')"],
    grass: '', camp: [K("prop('house', { roof: 'rooftile', seed: 3 })", 4), K("'well'", 1.3), K("prop('house', { roof: 'thatch', seed: 5 })", 4), K("'stall'", 1.6), K("'cart'", 1.2), K("'windmill'", 2.6), K("'lamp'"), K("'bench'")],
    animals: ['chicken', 'chicken', 'sheep', 'sheep', 'cow', 'pig', 'dog', 'cat'], foes: ['wolf', 'wolf', 'boar', 'fox'], hero: 'villager', pickup: ['coin', '0xffc83a', 'Coins', 'lost coins'],
    ambience: 'wind', music: 'happy', accent: '#ffd23f',
  },
  haunted: {
    words: /haunt|ghost|grave|cemetery|spooky|horror|witch|undead|zombie|skeleton|cursed|crypt|halloween|vampire/, title: 'Hollow Barrow', mood: 'night', weather: 'fireflies', shape: 'hills', palette: 'autumn', amplitude: 7, water: '0x2a3a4a',
    big: ["tree({ species: 'dead' })", "tree({ species: 'dead', seed: 2 })", "tree({ species: 'willow' })", "tree({ species: 'cypress' })", "prop('gravestone')", "prop('gravestone', { seed: 2 })", 'rock({ moss: true })'],
    small: ["groundCover('mushrooms')", "groundCover('stones')", "groundCover('stump')", "groundCover('log')", "groundCover('fern', { color: 0x4a6a4a })", "groundCover('tuft', { color: 0x6a7a4a })", 'bush({ color: 0x3a5a3a })'],
    grass: '', grassOpt: ', count: 8000', camp: [K("'ruin'", 2.5), K("'statue'", 0.8), K("'lantern'"), K("'gate'", 1), K("'gravestone'", 0.4), K("'gravestone'", 0.4), K("'torch'"), K("'well'", 1.3)],
    animals: ['bat', 'bat', 'cat', 'rabbit'], foes: ['ghost', 'ghost', 'wolf', 'bat'], hero: 'wizard', pickup: ['orb', '0x9affc8', 'Wisps', 'lost wisps'],
    ambience: 'night', music: 'mystery', accent: '#9affc8',
  },
  autumn: {
    words: /autumn|fall\s|harvest|maple|orchard|october/, title: 'Russet Vale', mood: 'autumn', weather: 'leaves', shape: 'valley', palette: 'autumn', amplitude: 8,
    big: ["tree({ species: 'maple' })", "tree({ species: 'maple', seed: 2, leaf: 0xe8a82a })", "tree({ species: 'oak', leaf: 0xc8882a })", "tree({ species: 'birch', leaf: 0xe8c83a })", "tree({ species: 'pine' })", 'rock({ moss: true })', 'rock({ seed: 2 })'],
    small: ['bush({ color: 0xa86a2a })', 'bush({ seed: 2, berries: 0xd83a4a })', "groundCover('mushrooms')", "groundCover('log')", "groundCover('stump')", "groundCover('fern', { color: 0xa88a3a })", "groundCover('stones')", "groundCover('flower', { color: 0xe8882a })"],
    grass: '', camp: [K("prop('house', { roof: 'thatch' })", 4), K("'campfire'"), K("'haystack'", 1), K("'signpost'"), K("'cart'", 1.2), K("'barrel'"), K("'bench'"), K("'lantern'")],
    animals: ['deer', 'deer', 'fox', 'rabbit', 'bird', 'bird', 'boar'], foes: ['wolf', 'wolf', 'boar', 'bear'], hero: 'farmer', pickup: ['gem', '0xe8882a', 'Acorns', 'golden acorns'],
    ambience: 'wind', music: 'calm', accent: '#e8a82a',
  },
  mountains: {
    words: /mountain|peak|summit|alpine|highland|cliff|climb|ridge/, title: 'High Tarn', mood: 'misty-dawn', weather: null, shape: 'mountains', palette: 'temperate', amplitude: 9,
    big: ["tree({ species: 'pine' })", "tree({ species: 'pine', seed: 2 })", "tree({ species: 'cypress' })", "tree({ species: 'birch' })", 'rock({ size: 1.8 })', 'rock({ seed: 2, moss: true })', 'rock({ seed: 3, size: 2.4 })'],
    small: ["groundCover('stones')", "groundCover('stones', { seed: 2 })", "groundCover('fern')", "groundCover('flower', { color: 0x9ab8ff })", "groundCover('tuft')", "groundCover('log')", 'bush()'],
    grass: '', camp: [K("'tower'", 2.6), K("'campfire'"), K("'tent'", 1.8), K("'signpost'"), K("'flag'"), K("'crate'"), K("'bench'"), K("'lantern'")],
    animals: ['goat', 'goat', 'goat', 'deer', 'bird', 'bird', 'rabbit'], foes: ['wolf', 'wolf', 'bear', 'bear'], hero: 'explorer', pickup: ['star', '0xffe45a', 'Edelweiss', 'edelweiss stars'],
    ambience: 'wind', music: 'calm', accent: '#b8d8ff',
  },
  swamp: {
    words: /swamp|marsh|bog|bayou|rain|storm|mud|mangrove|wetland/, title: 'Mirewater', mood: 'overcast', weather: 'rain', shape: 'plains', palette: 'temperate', amplitude: 9, water: '0x4a6a4a',
    big: ["tree({ species: 'willow' })", "tree({ species: 'willow', seed: 2 })", "tree({ species: 'cypress' })", "tree({ species: 'dead' })", "tree({ species: 'oak', leaf: 0x4a7a3a })", 'rock({ moss: true })', 'rock({ seed: 2, moss: true })'],
    small: ["groundCover('reeds')", "groundCover('reeds', { seed: 2 })", "groundCover('mushrooms')", "groundCover('fern')", "groundCover('log')", "groundCover('stump')", 'bush({ color: 0x3a6a3a })', "groundCover('stones')"],
    grass: '', camp: [K("prop('hut')", 3), K("'boat'", 2), K("'lantern'"), K("'bridge'", 1), K("'crate'"), K("'barrel'"), K("'signpost'"), K("'torch'")],
    animals: ['bird', 'bird', 'rabbit', 'pig', 'bat'], foes: ['slime', 'slime', 'boar', 'wolf'], hero: 'explorer', pickup: ['potion', '0x6ad86a', 'Remedies', 'marsh remedies'],
    ambience: 'rain', music: 'mystery', accent: '#8ad86a',
  },
  city: {
    words: /city|street|neon|cyber|urban|downtown|rooftop|alley|ninja|heist/, title: 'Neon Quarter', mood: 'neon-night', weather: 'rain', shape: 'flat', palette: '{ low: 0x70758a, high: 0x8a90a4, steep: 0x4a4e5c, peak: 0x8a90a4, shore: 0x70758a, detail: \'asphalt\' }', amplitude: 12, flat: true,
    big: ["prop('container')", "prop('container', { color: 0x3a6ad8 })", "prop('container', { color: 0xd8a83a })", "prop('barrier')", "prop('lamp')", "prop('drum')", "prop('antenna')", "prop('console')", "prop('beacon', { color: 0xff4ad8 })"],
    small: ["prop('barrel')", "prop('crate')", "prop('pipe')", "groundCover('stones', { color: 0x5a5e68 })", "prop('drum', { color: 0xd8a83a })", "prop('barrier', { seed: 2 })"],
    smallCount: 90, bigCount: 70, grass: null, camp: [K("prop('house', { walls: 'brick', roof: 'corrugated', seed: 2 })", 4), K("'lamp'"), K("prop('house', { walls: 'concrete', roof: 'metal', seed: 4 })", 4), K("'console'", 0.9), K("'stall'", 1.6), K("'beacon'", 0.7), K("'bench'"), K("'lamp'")],
    animals: ['cat', 'cat', 'dog', 'bird', 'bird'], foes: ['slime', 'slime', 'bat', 'wolf'], hero: 'ninja', pickup: ['orb', '0xff4ad8', 'Chips', 'data chips'],
    ambience: 'city', music: 'retro', accent: '#ff4ad8',
  },
};
const ORDER = ['haunted', 'volcanic', 'snow', 'desert', 'alien', 'city', 'island', 'swamp', 'mountains', 'autumn', 'village', 'forest'];
const CAMP_SPOTS = [[6, -6, -0.5], [-1.5, 2.5, 0], [-6.5, -3, 0.6], [2.5, 5.5, 0.4], [3.4, -1.2, 0.3], [4.4, 0.2, 0], [-3.5, 4.8, 2.2], [1, -8, 1]];
// every pattern below is matched at the start of a word (see startsWord), so "device" is not ice and "terrain" is not rain
const MOOD_WORDS = [[/night|midnight|moonlit|dark\b/, 'night'], [/sunset|dusk|twilight|evening/, 'dusk'], [/dawn|sunrise|morning|mist|fog/, 'misty-dawn'], [/storm|thunder|lightning/, 'storm'], [/overcast|gloomy|grey sky|gray sky/, 'overcast'], [/golden|afternoon/, 'golden-hour'], [/noon|midday|sunny|bright day/, 'clear-day']];
// the first row that matches wins, so the specific storms come before the plain one
const WEATHER_WORDS = [[/sand.?storm|dust.?storm/, 'sandstorm'], [/snow|blizzard/, 'snow'], [/dust/, 'dust'], [/firefl/, 'fireflies'], [/ember|spark|ash\b/, 'embers'], [/falling leaves|leaf fall/, 'leaves'], [/rain|storm|drizzle/, 'rain']];
const DRIFT = { 'clear-day': 'golden-hour', 'golden-hour': 'dusk', 'misty-dawn': 'clear-day', dusk: 'night', autumn: 'dusk', desert: 'dusk', overcast: 'storm' };
const PREDATORS = ['wolf', 'bear', 'boar', 'slime', 'ghost', 'bat'];
const GOALS = {
  collect: { words: /collect|gather|find|pick up|hunt for|treasure|coins?|gems?|scaveng/, summary: 'Collect every pickup before the time runs out.' },
  survive: { words: /surviv|chase|hunted|enem|monster|attack|defend|escape from|avoid|flee|zombie|wolves|horde/, summary: 'Stay alive until the clock runs out while hunters chase the hero.' },
  homestead: { words: /\bcraft(ing)?\b|\bbuild(ing)? (a |an |your |the |my )?(base|shelter|camp|home|house|hut|fire|farm)|base.?building|\bharvest|\bchop|\bmining\b|\bfarm(ing)?\b|homestead|survival (craft|game|sandbox|sim)|\binventory\b|gather (wood|resources|materials)|day.?night|\bhunger\b|\bsandbox\b/, summary: 'Gather wood and stone, craft tools, build a fire and live through the night: inventory, crafting, needs, a day clock, building, quests and saving.' },
  reach: { words: /reach|escape|portal|exit|gate|get to|find the way|unlock|keys?\b|deliver/, summary: 'Find the keys, then reach the portal before the time runs out.' },
};
// a flat world to walk around in (the planner writes it) against games that are not a world at all (it does not)
const WORLD_2D = /(^|[^\w.])(2d|2-d|2\.5d|pixel|isometric|sprites?|stardew|zelda)\b/, NOT_A_WORLD = /\b(platformer|side.?scroll|puzzle|card|board|match.?3|tetris|snake|pong|breakout|chess|sudoku|word game|clicker|idle game|text adventure)\b/;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const startsWord = (re) => new RegExp('\\b(?:' + re.source + ')');   // a cue counts only where a word begins
for (const S of Object.values(SETTINGS)) S.words = startsWord(S.words);
for (const row of [...MOOD_WORDS, ...WEATHER_WORDS]) row[0] = startsWord(row[0]);
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const pick = (v, list, fallback) => (v != null && list.includes(String(v)) ? String(v) : fallback);

/**
 * args: description (required), setting, mood, weather ('none' for clear air), terrain, palette, hero, goal, camera
 * ('third' | 'top' | '2d': a flat, painted top-down world), title, seed, pickups, time_limit. values: the lists from the block catalog (moods, props, …).
 */
const ARGS = ['description', 'setting', 'mood', 'weather', 'terrain', 'palette', 'hero', 'goal', 'camera', 'title', 'seed', 'pickups', 'time_limit'];
const READ = 4000;   // characters of the description the planner reads (a whole brief); it also bounds the plan line written into the game
const PLAN_MARK = '// Starting point written by design_scene. Plan: ';
const planArgs = (args) => Object.fromEntries(ARGS.filter((k) => args[k] != null && args[k] !== '').map((k) => [k, typeof args[k] === 'number' ? args[k] : String(args[k]).slice(0, k === 'description' ? READ : 60)]));

// Cues the planner looks for anywhere in the brief. Each says what it changed or which blocks cover it, and the plan
// lists the ones it found (plan.read_from_brief), so an agent can see what was understood and what is still its to do.
const CUES = [
  ['2D or 2.5D', WORLD_2D, 'camera "2d": a painted top-down world on @gcp/craft2d.js'],
  ['several players', /multi.?player|co-?op\b|\bonline\b|friends|\bplayers\b|\brooms?\b|\bhost(s|ed|ing)?\b|join|lobby|together/, 'lobbyUI (host, join by code, solo), GCP.room, and createWorldSync from @gcp/play.js: the host owns placed pieces, harvested nodes and crops and every client sees the same world. Rules in the multiplayer guide.'],
  ['saves on the host', /host(['’]s)? (own |local )?(device|machine|computer|browser)|saved? (automatically )?(locally|on the host|on (the|their) device)|local save|no cloud|(not?|n['’]t) (want )?(the )?(game )?(data )?(be )?stored on (my|the|a|our) server/, "createSave(key, parts, { cloud: false }) keeps the world in the host's browser"],
  ['farming', /\bfarm(s|ing)?\b|\bcrops?\b|\bplant(s|ing)?\b|\bseeds?\b|\bharvest|\btill/, 'createCrops from @gcp/play.js: plant seeds, crops grow in stages (watering optional) and are harvested through the same prompt as trees and rocks'],
  ['a world that grows', /expand|endless|infinite|procedural(ly)? (map|world)|grows? in (random )?directions|unexplored|explore (further|beyond)|new (land|areas?) appears?|chunks?/, 'the world streams in chunks as the player explores: chunks2d({ fill }) with ground2d({ size: Infinity }) in 2D, terrainChunks({ fill }) in 3D'],
  ['building', /\bbuild(s|ing)?\b|\bbase\b|\bwalls?\b|\bhouse\b|\bshelter|\bstor(e)?ys?\b|\bstairs/, 'createBuilder with layers, storeys, stairsPiece and rampPiece'],
  ['crafting', /\bcraft/, 'createCrafting with stations, inventoryUI shows the recipes'],
  ['smelting', /\bsmelt|\bfurnace|\bforge\b|\bingots?\b|\bores?\b/, 'a furnace piece that is a crafting station, ore from rocks and ingot recipes with station: "furnace"'],
  ['thirst', /\bthirst|\bdrink|food,? (and )?water\b|water,? (and )?food\b|\bhydrat/, 'a water need in createNeeds that drains like food and is filled by drinking at a well or a shore'],
  ['combat', /\bcombat\b|\benem(y|ies)\b|\bmonsters?\b|\bfight|\bloot\b|\bweapons?\b|\bmobs?\b/, 'foes that come at night and chase the hero (wander with chase and onReach), a weapon in the hand, and loot when one falls'],
  ['day and night', /day.?night|\bnights?\b|\bdawn\b|\bdusk\b/, 'createClock({ stage }) drives the light; clock.onPhase for night events'],
];
// The game's name when the brief gives one: "called Mistbound", "Title: Mistbound", or a brief that opens with it ("Mistbound: a farm …",
// "Mistbound (2.5D) …", "Mistbound is a …", "# Mistbound"). Otherwise null, and the title comes from the setting.
const NAME = "([A-Z][\\w'’-]*(?:\\s+(?:(?:of|the|and)\\s+)?[A-Z][\\w'’-]*){0,3})", NOT_NAMES = /^(I|I'd|I’d|A|An|The|This|Make|Build|Create|Please|Game|My|We|It|In|You|Use|Using|Design)\b/;
const titleFrom = (raw) => {
  const m = new RegExp("(?:called|titled|named|\\b[Tt]itle\\s*[:=]|\\b[Nn]ame\\s*[:=])\\s+[\"“'‘]?" + NAME).exec(raw);
  if (m) return m[1].trim();
  const o = new RegExp('^\\s*(?:#+\\s*)?["“]?' + NAME + '["”]?\\s*(?:[:—–(]|\\s-\\s|\\n|,?\\s+is\\s+an?\\b|$)').exec(raw), t = o ? o[1].trim() : null;
  return t && !NOT_NAMES.test(t) ? t : null;
};

export function designScene(args, V) {
  const r = planScene(args, V); if (!r || !r.plan) return r;
  const text = String(args.description || '').slice(0, READ).toLowerCase(), found = CUES.filter(([, re]) => re.test(text)).map(([cue, , how]) => ({ cue, how }));
  if (found.length) r.plan.read_from_brief = found;
  // where the name and the place came from, so nobody mistakes a default for something the brief said
  if (r.plan.title) r.plan.title_from = args.title ? 'argument' : titleFrom(String(args.description || '')) ? 'brief' : 'setting';
  if (r.plan.setting) r.plan.setting_from = args.setting && SETTINGS[args.setting] ? 'argument' : ORDER.some((k) => SETTINGS[k].words.test(text)) ? 'brief' : 'default (nothing in the brief names a place)';
  return r;
}

function planScene(args, V) {
  const text = String(args.description || '').slice(0, READ).toLowerCase();
  const explicit3d = /\b3d\b|three\.?js|third.?person|first.?person/.test(text) || args.camera === 'third' || args.camera === 'top';
  if (NOT_A_WORLD.test(text) && !explicit3d && !args.setting && args.camera !== '2d') return twoD(args);

  const id = pick(args.setting, Object.keys(SETTINGS), ORDER.find((k) => SETTINGS[k].words.test(text)) || 'forest'), S = SETTINGS[id], notes = [];
  if (String(args.description || '').length > READ) notes.push(`The planner reads the first ${READ} characters of the description. Put the setting, the hero, the goal and the things you want in it first, or pass them as arguments.`);
  const fromWords = (table) => { const hit = table.find(([re]) => re.test(text)); return hit ? hit[1] : null; };
  let mood = pick(args.mood, V.moods, fromWords(MOOD_WORDS) || S.mood);
  const weather = args.weather === 'none' ? null : pick(args.weather, V.weather, fromWords(WEATHER_WORDS) || S.weather);
  const shape = pick(args.terrain, V.terrain_shapes, S.shape), flat = shape === 'flat';
  const palette = args.palette && V.terrain_palettes.includes(args.palette) ? q(args.palette) : S.flat ? S.palette : q(S.palette);
  const hero = pick(args.hero, V.humanoids, V.humanoids.find((h) => new RegExp(`\\b${h}`).test(text)) || S.hero);
  const goal = pick(args.goal, Object.keys(GOALS), ['homestead', 'survive', 'reach', 'collect'].find((g) => GOALS[g].words.test(text)) || 'collect');
  // a homestead has its own day and night, so it starts in daylight whatever the description says about the dark
  const DARK = ['night', 'neon-night', 'dusk', 'storm', 'indoor'], byDay = (m) => (goal === 'homestead' && !args.mood && DARK.includes(m) ? (DARK.includes(S.mood) ? 'clear-day' : S.mood) : m);
  mood = byDay(mood);
  const camera = pick(args.camera, ['third', 'top', '2d'], WORLD_2D.test(text) && !explicit3d ? '2d' : /top.?down|bird'?s.?eye|overhead/.test(text) ? 'top' : 'third');
  const seed = String(args.seed || id).slice(0, 40), title = String(args.title || titleFrom(String(args.description || '')) || S.title).slice(0, 60);
  for (const [k, list] of [['setting', Object.keys(SETTINGS)], ['mood', V.moods], ['weather', [...V.weather, 'none']], ['terrain', V.terrain_shapes], ['palette', V.terrain_palettes], ['hero', V.humanoids], ['goal', Object.keys(GOALS)], ['camera', ['third', 'top', '2d']]]) {
    if (args[k] != null && !list.includes(String(args[k]))) notes.push(`"${args[k]}" is not a ${k} this tool knows, so the default was used. Valid: ${list.join(', ')}.`);
  }

  // things the description names are added to the plan
  const named = (list) => list.filter((n) => new RegExp(`\\b${n}s?\\b`).test(text));
  const big = [...S.big], small = [...S.small], camp = S.camp.map((c) => ({ ...c }));
  for (const t of named(V.trees)) if (!big.some((b) => b.includes(`'${t}'`))) big.unshift(`tree({ species: '${t}' })`);
  const landmarks = named(V.props).filter((p) => !['coin', 'gem', 'heart', 'star', 'key', 'orb', 'potion', 'portal'].includes(p) && !camp.some((c) => c.code.includes(`'${p}'`)));
  landmarks.slice(0, 4).forEach((p, i) => { camp[camp.length - 1 - i] = K(`'${p}'`, ['house', 'hut', 'tower', 'windmill', 'container'].includes(p) ? 3.5 : ['well', 'tent', 'boat', 'cart', 'stall', 'statue', 'ruin'].includes(p) ? 1.5 : 0); });
  const namedAnimals = named(V.animals).filter((a) => a !== 'fish');
  const foes = [...new Set([...namedAnimals.filter((a) => PREDATORS.includes(a)), ...S.foes])].slice(0, 3);
  const animals = goal === 'survive' || goal === 'homestead' ? [...namedAnimals.filter((a) => !PREDATORS.includes(a)), ...S.animals.filter((a) => !foes.includes(a))].slice(0, 6)
    : [...namedAnimals.flatMap((a) => [a, a]), ...S.animals].slice(0, 8);
  const pk = [...S.pickup]; const namedPickup = ['coin', 'gem', 'heart', 'star', 'key', 'orb', 'potion'].find((p) => new RegExp(`\\b${p}s?\\b`).test(text));
  if (namedPickup && goal === 'collect' && namedPickup !== pk[0]) { pk[0] = namedPickup; pk[2] = cap(namedPickup) + 's'; pk[3] = namedPickup + 's'; }
  const count = Math.max(3, Math.min(30, Math.round(Number(args.pickups) || 10)));
  const time = Math.max(20, Math.min(1800, Math.round(Number(args.time_limit) || (goal === 'survive' ? 90 : goal === 'homestead' ? 300 : 240))));
  const drift = DRIFT[mood] || null, water = !flat, waterOpt = S.water && water ? `, color: ${S.water}` : '';
  const objective = goal === 'homestead' ? 'Gather, craft and build a fire, then live through the night' : goal === 'collect' ? `Find the ${count} ${pk[3]} before time runs out` : goal === 'survive' ? `Stay alive for ${time} seconds` : 'Find the three keys, then reach the portal';
  if (camera === '2d') return write2d({ args, V, id, S, mood: byDay(pick(args.mood, V.moods2d, fromWords(MOOD_WORDS) || S.mood)), weather: weather && V.weather2d.includes(weather) ? weather : null, hero: pick(hero, V.actors2d, 'explorer'), goal, goalSummary: GOALS[goal].summary, seed, title, count, time, pk, objective, notes, drift, big, small, camp, animals, foes, planLine: `${PLAN_MARK}${JSON.stringify(planArgs(args))}` });
  const play = goal === 'homestead';
  if (play) { if (!big.some((c) => c.startsWith('tree('))) big.push("tree({ species: 'oak' })"); if (!big.some((c) => c.startsWith('rock('))) big.push('rock()'); if (![...big, ...small].some((c) => c.startsWith('bush('))) big.push('bush({ berries: 0xd83a4a })'); }
  const moveHint = camera === 'top' ? 'WASD or arrows to move · Shift to run · Space to jump' : 'WASD or arrows to move · drag to look · Shift to run · Space to jump';

  const used = new Set(['run', 'createStage', 'terrain', 'scatter', 'place', 'prop', 'humanoid', 'animal', 'control', 'wander', 'createFx', 'createHud', 'createSound', 'createInput', 'rng']);
  if (water) used.add('water'); if (S.grass != null) used.add('grassField');
  for (const c of [...big, ...small]) { const m = /^(tree|rock|bush|groundCover)\(/.exec(c); if (m) used.add(m[1]); }
  const order = ['run', 'createStage', 'terrain', 'water', 'tree', 'rock', 'bush', 'groundCover', 'scatter', 'grassField', 'place', 'prop', 'humanoid', 'animal', 'control', 'wander', 'createFx', 'createHud', 'createSound', 'createInput', 'rng'];
  const L = [];
  L.push(`// ${title}: ${objective.toLowerCase()}.`,
    '// Every call below is a building block from @gcp/craft.js; get_block {name} lists the options of any of them.',
    '// The numbered sections are independent: change the kinds, the counts, the seed and above all the rules in section 7.',
    `${PLAN_MARK}${JSON.stringify(planArgs(args))}`,
    `import { ${order.filter((n) => used.has(n)).join(', ')} } from '@gcp/craft.js';`,
    ...(play ? [`import { ${PLAY_IMPORTS.join(', ')} } from '@gcp/craft.js';`] : []), '',
    `const SEED = ${q(seed)};   // a different seed gives a different world with the same rules`, '',
    'run(async (boot) => {',
    '  // 1. Stage: the sky, sun, fog, shadows and weather all follow one mood.',
    "  await boot.step(0.1, 'Setting the stage');",
    `  const stage = createStage('#view', { mood: ${q(mood)}${weather ? `, weather: ${q(weather)}` : ''} });`, '',
    '  // 2. Ground. land.heightAt(x, z) is the height everything else stands on.',
    `  const land = terrain({ shape: ${q(shape)}, palette: ${palette}, seed: SEED, size: 240, amplitude: ${S.amplitude}, ${flat ? 'waterLevel: -2' : 'clearing: { x: 0, z: 0, r: 10 }'}${weather === 'rain' ? ', wet: 0.7' : ''} });`);
  if (water) L.push(`  water({ level: 0${waterOpt} });`, '  const open = (x, z, y, slope) => y > 1 && slope < 0.8;   // where things may stand: out of the water, off the cliffs');
  else L.push('  const open = () => true;   // where things may stand');
  L.push('', '  // 3. Scenery. scatter() draws hundreds of copies in a few draw calls and returns the solid ones for collision.',
    "  await boot.step(0.35, 'Growing the world');", '  const scenery = scatter([', ...big.map((c) => `    ${c},`),
    `  ], { count: ${S.bigCount || 380}, radius: 105, scale: [1.1, 1.9], heightAt: land.heightAt, where: open, minDistance: 4, avoid: [{ x: 0, z: 0, r: 11 }], seed: SEED });`,
    `  ${play ? 'const cover = ' : ''}scatter([`, ...small.map((c) => `    ${c},`),
    `  ], { count: ${S.smallCount || 520}, radius: 90, heightAt: land.heightAt, where: open, avoid: [{ x: 0, z: 0, r: 4 }], seed: SEED + '-cover' });`);
  if (S.grass != null) L.push(`  grassField({ land, radius: ${S.grassRadius || 48}, where: open${S.grassOpt || ''} });   // tufts take the colour of the ground they stand on`);
  L.push('', '  // 4. Landmarks around the start, placed by hand.', "  await boot.step(0.6, 'Building');",
    '  const at = (kind, x, z, rotY = 0) => place(kind, x, land.heightAt(x, z), z, { rotY });');
  const solids = [];
  // two tall trees over the start: the opening view gets a crown overhead and shade and light across the ground
  const trees = big.filter((c) => c.startsWith('tree(')), good = trees.filter((c) => !/cactus|dead/.test(c)), kindOf = (c) => (/species: '(\w+)'/.exec(c) || [])[1];
  const first = good[0] || trees[0], tall = first ? [first, good.find((c) => kindOf(c) !== kindOf(first)) || first] : [];
  if (tall.length && camera === 'third') {   // from above they would only hide the play area
    const grown = (c, size, sd) => c.replace(/,? ?seed: \d+/, '').replace(/,? ?size: [\d.]+/, '').replace(/\{\s*,\s*/, '{ ').replace(/ ?\}\)$/, `, size: ${size}, seed: ${sd} })`);
    L.push('  // Tall trees stand over the start, so the opening view has a crown overhead and shade and light across the ground.',
      `  at(${grown(tall[0], 2.3, 11)}, 9.5, 4.5); at(${grown(tall[1], 2, 12)}, -11.5, 10, 2);`);
    solids.push('{ x: 9.5, z: 4.5, r: 0.9 }', '{ x: -11.5, z: 10, r: 0.8 }');
  }
  camp.forEach((c, i) => { if (play && /'(campfire|tent)'/.test(c.code)) return; const [x, z, r] = CAMP_SPOTS[i]; L.push(`  at(${c.code}, ${x}, ${z}${r ? `, ${r}` : ''});`); if (c.r) solids.push(`{ x: ${x}, z: ${z}, r: ${c.r} }`); });
  L.push(`  const solids = [...scenery.solids${solids.length ? ', ' + solids.join(', ') : ''}];`, '',
    '  // 5. The hero, input (keyboard, pointer and an on-screen stick on phones), sound, effects, interface, camera.',
    "  await boot.step(0.8, 'Waking the world');",
    `  const hero = humanoid({ preset: ${q(hero)} });`, '  stage.scene.add(hero);',
    `  const input = createInput(stage.renderer.domElement), sound = createSound(), fx = createFx(), hud = createHud({ accent: ${q(S.accent)} });`,
    ...(play ? playBind('3d') : []),
    `  const player = control(hero, { input, mode: ${q(camera)}, heightAt: land.heightAt, solids, ${water ? 'minY: 0.3, ' : ''}bounds: 105,${camera === 'third' ? ' distance: 6.5, pitch: 0.2,' : ''}${play ? " canRun: () => needs.get('stamina') > 3," : ''}`,
    "    onStep: () => sound.play('step'), onJump: () => sound.play('jump'), onLand: () => sound.play('land') });", '',
    '  // 6. Life: creatures that wander on their own and run from the hero.',
    `  const rand = rng(SEED + '-life');`,
    `  for (const kind of [${animals.map(q).join(', ')}]) {`,
    '    const p = land.randomPoint(rand, { minRadius: 12, maxRadius: 70 }), a = animal(kind);',
    '    a.position.copy(p); stage.scene.add(a);',
    '    wander(a, { heightAt: land.heightAt, radius: 18, flee: a.flies ? null : hero });', '  }', '');

  const end = (winTitle, loseTitle, stats) => [
    '  function finish(win) {', '    if (state.over) return;',
    '    state.over = true; state.playing = false; player.enabled = false; clock.stop();',
    "    sound.play(win ? 'win' : 'lose');",
    "    if (win) { fx.confetti(hero); hero.play('cheer'); } else { hero.animate('dead', 0); stage.setMood('night', 3); }",
    `    hud.end({ win, title: win ? ${q(winTitle)} : ${q(loseTitle)}, stats: ${stats}, onRestart: () => location.reload() });`, '  }', ''];
  const startScreen = (extra = '') => [
    '  // 10. Start screen. Sound starts on the first press (browsers block it before that).',
    '  player.enabled = false;',
    `  hud.title({ title: ${q(title)}, subtitle: ${q(objective)}, controls: ${q(moveHint)}, onStart: () => {`,
    '    state.playing = true; player.enabled = true; clock.start();',
    `    sound.ambience(${q(S.ambience)}); sound.music(${q(goal === 'survive' ? 'tense' : S.music)});`,
    `    hud.objective(${q(objective)}); hud.hint(${q(moveHint)}, 8);${extra}`,
    ...(drift ? [`    stage.setMood(${q(drift)}, TIME);   // the light changes as the time runs out`] : []),
    '  } });', ''];
  const loopTop = ['  // 9. The frame loop. stage.run() updates and draws the stage and calls GCP.ready() after the first frames.', '  stage.run((dt) => {', '    player.update(dt);'];
  const loopEnd = ['    input.endFrame();', '  });', '  boot.done();', ''];
  const proofTop = ['  // 11. Proof. The verification browser runs this to check the rules work from start to end.', '  GCP.test.onAutostart(() => hud.start());', '  GCP.test.onPlaythrough(async (t) => {',
    "    t.step('start the game'); if (hud.screenOpen) hud.start(); await t.frames(3); t.assert(state.playing, 'the game is running');"];

  if (play) L.push(...homesteadRules({ dim: '3d', n: 7, S, title, objective, day: time, foes: (foes.length ? foes : ['wolf']).slice(0, 3), water }));
  else if (goal === 'collect') {
    L.push(`  // 7. Rules: collect every pickup before the time runs out. This is the part to make your own.`,
      `  const GOAL = ${count}, TIME = ${time}, state = { playing: false, over: false, found: 0 }, pickups = [];`,
      '  for (let i = 0; i < GOAL; i++) {',
      '    const p = land.randomPoint(rand, { minRadius: 14 + i * 3, maxRadius: 30 + i * 5 });',
      `    pickups.push(place(prop(${q(pk[0])}, { color: ${pk[1]}, light: i < 2 }), p.x, p.y + 0.3, p.z));`, '  }', '',
      '  // 8. Interface: the goal, the progress and the time are always on screen.',
      `  const counter = hud.counter(${q(pk[2])}, { icon: '◆', value: 0 });`,
      '  const clock = hud.timer({ seconds: TIME, onEnd: () => finish(false) }).stop();',
      "  hud.button('Sound', () => sound.mute());",
      ...end('Every one found', 'Out of time', `{ ${q(pk[2])}: state.found + ' / ' + GOAL, 'Time left': Math.ceil(clock.time) + ' s' }`),
      ...loopTop,
      '    if (state.playing) for (const g of pickups) {',
      '      if (!g.visible || Math.hypot(g.position.x - hero.position.x, g.position.z - hero.position.z) > 1.5) continue;',
      '      g.visible = false; state.found++; counter.set(state.found);',
      `      fx.sparkle(g, ${pk[1]}).floatText(g, '+1', { color: ${q(S.accent)} }); sound.play('pickup');`,
      "      hud.toast(state.found < GOAL ? (GOAL - state.found) + ' left' : 'All found');",
      '      if (state.found === GOAL) finish(true);', '    }',
      ...loopEnd, ...startScreen(), ...proofTop,
      "    t.step('walk to the first pickup'); player.teleport(pickups[0].position.x + 1.8, pickups[0].position.z); await player.moveTo(pickups[0].position.x, pickups[0].position.z, 6); await t.frames(2);",
      "    t.assert(state.found === 1, 'walking onto a pickup collects it, found ' + state.found);",
      "    t.step('collect two more'); for (const g of pickups.slice(1, 3)) { player.teleport(g.position.x, g.position.z); await t.frames(2); }",
      "    t.assert(state.found === 3, 'three collected, found ' + state.found);",
      "    t.step('collect the rest'); for (const g of pickups.slice(3)) { player.teleport(g.position.x, g.position.z); await t.frames(2); }",
      "    t.assert(state.found === GOAL, 'all collected, found ' + state.found);",
      "    t.step('the win screen shows'); await t.until(() => state.over && hud.screenOpen, 5000); t.assert(state.over && hud.screenOpen, 'the end screen is open');",
      '  });', '});');
  } else if (goal === 'survive') {
    L.push('  // 7. Rules: stay alive until the clock runs out. Hunters chase the hero when it comes near; hearts heal. Make this part your own.',
      `  const TIME = ${time}, state = { playing: false, over: false, health: 100, safeUntil: 0 }, hunters = [], hearts = [];`,
      `  for (const kind of [${[...foes, ...foes].slice(0, 5).map(q).join(', ')}]) {`,
      '    const p = land.randomPoint(rand, { minRadius: 28, maxRadius: 75 }), a = animal(kind);',
      '    a.position.copy(p); stage.scene.add(a); hunters.push(a);',
      '    wander(a, { heightAt: land.heightAt, radius: 26, speed: 1.6, chase: hero, range: 16, onReach: () => hurt(20) });', '  }',
      '  for (let i = 0; i < 5; i++) {',
      '    const p = land.randomPoint(rand, { minRadius: 12 + i * 6, maxRadius: 30 + i * 8 });',
      "    hearts.push(place(prop('heart'), p.x, p.y + 0.3, p.z));", '  }',
      '  function hurt(amount) {',
      '    if (!state.playing || performance.now() < state.safeUntil) return;',
      '    state.safeUntil = performance.now() + 1200; state.health = Math.max(0, state.health - amount); health.set(state.health);',
      "    hud.damage(0.7); stage.shake(0.4); sound.play('hurt'); hero.play('hurt');",
      '    if (state.health <= 0) finish(false);', '  }', '',
      '  // 8. Interface: health and time are always on screen.',
      "  const health = hud.bar('Health', { value: 100, max: 100, color: '#e5484d' });",
      '  const clock = hud.timer({ seconds: TIME, onEnd: () => finish(true) }).stop();',
      "  hud.button('Sound', () => sound.mute());",
      ...end('You made it', 'Caught', "{ Health: state.health, 'Time left': Math.ceil(clock.time) + ' s' }"),
      ...loopTop,
      '    if (state.playing) for (const h of hearts) {',
      '      if (!h.visible || state.health >= 100 || Math.hypot(h.position.x - hero.position.x, h.position.z - hero.position.z) > 1.5) continue;',
      "      h.visible = false; state.health = Math.min(100, state.health + 30); health.set(state.health); fx.sparkle(h, 0xff5a7a); sound.play('heal'); hud.toast('Healed');", '    }',
      ...loopEnd, ...startScreen(" hud.toast('They hunt by sight: keep your distance');"), ...proofTop,
      "    t.step('a hunter reaches the hero'); player.teleport(hunters[0].position.x + 1, hunters[0].position.z); await t.until(() => state.health < 100, 8000);",
      "    t.assert(state.health === 80, 'one hit costs 20 health, health is ' + state.health);",
      "    t.step('a heart heals'); player.teleport(hearts[0].position.x, hearts[0].position.z); await t.until(() => !hearts[0].visible, 4000); t.assert(state.health > 80, 'health went up to ' + state.health);",
      "    t.step('the clock runs out'); player.teleport(0, 0); clock.reset(1); await t.until(() => state.over, 6000); t.assert(state.over && state.health > 0, 'surviving until the end wins');",
      "    t.step('the end screen shows'); await t.until(() => hud.screenOpen, 3000); t.assert(hud.screenOpen, 'the end screen is open');",
      '  });', '});');
  } else {
    L.push('  // 7. Rules: find the three keys, then reach the portal before the time runs out. Make this part your own.',
      `  const KEYS = 3, TIME = ${time}, state = { playing: false, over: false, keys: 0, told: 0 }, keys = [];`,
      '  for (let i = 0; i < KEYS; i++) {',
      '    const p = land.randomPoint(rand, { minRadius: 22 + i * 10, maxRadius: 40 + i * 14 });',
      "    keys.push(place(prop('key', { size: 1.6 }), p.x, p.y + 0.3, p.z));", '  }',
      '  const gate = land.randomPoint(rand, { minRadius: 55, maxRadius: 80, maxSlope: 0.5 });',
      "  const portal = place(prop('portal'), gate.x, gate.y, gate.z);",
      "  place(prop('beacon'), gate.x + 3, land.heightAt(gate.x + 3, gate.z), gate.z);", '',
      '  // 8. Interface: the keys and the time are always on screen.',
      "  const counter = hud.counter('Keys', { icon: '◆', value: '0 / ' + KEYS });",
      '  const clock = hud.timer({ seconds: TIME, onEnd: () => finish(false) }).stop();',
      "  hud.button('Sound', () => sound.mute());",
      ...end('Through the portal', 'Out of time', "{ Keys: state.keys + ' / ' + KEYS, 'Time left': Math.ceil(clock.time) + ' s' }"),
      ...loopTop,
      '    if (state.playing) {',
      '      for (const k of keys) {',
      '        if (!k.visible || Math.hypot(k.position.x - hero.position.x, k.position.z - hero.position.z) > 1.5) continue;',
      "        k.visible = false; state.keys++; counter.set(state.keys + ' / ' + KEYS); fx.sparkle(k, 0xffc83a); sound.play('unlock');",
      "        hud.toast(state.keys < KEYS ? (KEYS - state.keys) + ' keys to go' : 'The portal is open'); if (state.keys === KEYS) hud.objective('Reach the portal');", '      }',
      '      if (Math.hypot(portal.position.x - hero.position.x, portal.position.z - hero.position.z) < 2.2) {',
      '        if (state.keys === KEYS) finish(true);',
      "        else if (performance.now() > state.told) { state.told = performance.now() + 3000; hud.toast('The portal needs ' + (KEYS - state.keys) + ' more keys'); sound.play('error'); }", '      }', '    }',
      ...loopEnd, ...startScreen(), ...proofTop,
      "    t.step('walk to the first key'); player.teleport(keys[0].position.x + 1.8, keys[0].position.z); await player.moveTo(keys[0].position.x, keys[0].position.z, 6); await t.frames(2);",
      "    t.assert(state.keys === 1, 'walking onto a key collects it, keys ' + state.keys);",
      "    t.step('the portal stays shut without all keys'); player.teleport(portal.position.x, portal.position.z); await t.frames(3); t.assert(!state.over, 'the portal refused');",
      "    t.step('collect the other keys'); for (const k of keys.slice(1)) { player.teleport(k.position.x, k.position.z); await t.frames(2); } t.assert(state.keys === KEYS, 'all keys, got ' + state.keys);",
      "    t.step('enter the portal'); player.teleport(portal.position.x, portal.position.z); await t.until(() => state.over, 5000); t.assert(state.over && hud.screenOpen, 'the win screen is open');",
      '  });', '});');
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<title>${title.replace(/[<&]/g, '')}</title>
<style>html, body { height: 100%; margin: 0; background: #0b0d0f; overflow: hidden; } #view { position: fixed; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }</style>
</head>
<body>
<canvas id="view"></canvas>
<script type="module" src="src/main.js"></script>
</body>
</html>
`;
  const strip = (c) => c.replace(/^prop\('([a-z]+)'.*$/, '$1').replace(/^'|'$/g, '');
  return {
    dimension: '3d',
    plan: {
      setting: id, title, objective, goal: `${goal}: ${GOALS[goal].summary}`, camera,
      stage: { block: 'createStage', mood, weather: weather || 'none', drifts_to: drift || 'stays' },
      ground: { block: water ? 'terrain + water' : 'terrain', shape, palette: palette.replace(/'/g, ''), seed },
      scenery: { block: 'scatter + grassField', large: big, small, grass: S.grass != null },
      landmarks: { block: 'place + prop', props: camp.map((c) => strip(c.code)) },
      hero: { block: 'humanoid + control + createInput', preset: hero },
      creatures: { block: 'animal + wander', friendly: animals, hunters: goal === 'survive' || play ? foes : [] },
      ...(play ? { systems: PLAY_SYSTEMS, controls: 'input.bind: named actions for keyboard, mouse, touch buttons and gamepad', day_and_night: 'createClock drives stage.setTime' } : {}),
      sound: { block: 'createSound', ambience: S.ambience, music: goal === 'survive' ? 'tense' : S.music, effects: ['step', 'jump', 'land', 'pickup', 'win', 'lose'] },
      interface: play ? PLAY_INTERFACE : { block: 'createHud', widgets: goal === 'survive' ? ['bar', 'timer', 'objective', 'hint', 'toast', 'title', 'end'] : ['counter', 'timer', 'objective', 'hint', 'toast', 'title', 'end'] },
      proof: play ? 'GCP.test.onPlaythrough with ten steps: gather, craft, build, eat, night, fight, cook, dawn, win' : 'GCP.test.onPlaythrough with five steps that play the rules to the end screen',
    },
    files: { 'index.html': html, 'src/main.js': L.join('\n') + '\n' },
    notes,
  };
}

function twoD(args) {
  return {
    dimension: '2d',
    plan: {
      note: 'This reads as a 2D game that is not a world to walk around in (a puzzle, a board, a platformer). The scene planner writes worlds: 3D ones, and flat painted top-down ones with camera "2d". For this kind you draw with the canvas yourself and still use the blocks below.',
      world_blocks: 'If the game does have a top-down world, call design_scene again with camera: "2d": it returns a complete game on @gcp/craft2d.js (createStage2d, ground2d, sprite2d, scatter2d, actor2d, control2d, wander2d).',
      loop_and_boot: 'run(main) and createLoop from @gcp/core.js',
      drawing: 'setupCanvas, bake (paint each sprite or tile once on an off-screen canvas), Camera2D, drawSorted, ChunkCache from @gcp/canvas2d.js',
      textures: "paint(kind, { seed, color }).toCanvas() from @gcp/procgen.js gives any of the painted textures (grass, brick, planks, stonewall, …) as a canvas to use as a tile or a pattern; noise({ seed, scale }) gives terrain, clouds and variation; rng(seed) gives repeatable randomness",
      interface: 'createHud() from @gcp/hud.js: counters, bars, timer, objective, hints, title and end screens (plain DOM, works over any canvas)',
      sound: 'createSound() from @gcp/sound.js: effects, ambience and music with no audio files',
      input: 'createInput(canvas) from @gcp/input.js: keyboard, pointer and an on-screen stick',
      start_from: 'create_project with template "canvas2d-arcade" (a complete small 2D game) or "blank", then add the blocks above',
    },
    files: null,
    notes: [args.description ? 'Pass camera: "2d" for a flat top-down world, or setting (for example "forest") for a 3D world.' : 'No description given.'],
  };
}

/**
 * How far a game has moved from the starting point design_scene wrote for it. The generated file records the
 * arguments of its plan in one comment line; the same arguments always give the same file, so the plan can be written
 * again and compared line by line (comments and blank lines aside). Returns null when the file carries no plan line.
 * @returns {{ planned: number, kept: number, changed: number, added: number } | null}
 */
export function planDistance(src, V) {
  const at = src.indexOf(PLAN_MARK); if (at < 0) return null;
  let r; try { r = designScene(JSON.parse(src.slice(at + PLAN_MARK.length).split('\n')[0]), V); } catch { return null; }
  if (!r || !r.files) return null;
  const code = (s) => s.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
  const planned = code(r.files['src/main.js']), mine = code(src), have = new Map();
  for (const l of mine) have.set(l, (have.get(l) || 0) + 1);
  let kept = 0;
  for (const l of planned) { const n = have.get(l) || 0; if (n) { kept++; have.set(l, n - 1); } }
  return { planned: planned.length, kept, changed: planned.length - kept, added: mine.length - kept };
}

export const DESIGN_SETTINGS = Object.keys(SETTINGS);
export const DESIGN_GOALS = Object.keys(GOALS);

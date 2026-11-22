// The duplication check's AI stages measured on a labelled set of mock game pairs: copies (identity taken, code rebuilt),
// derivatives (the same kind of game with its own identity) and independent games (only the title shared). It calls
// Workers AI with the same question and state the platform uses (src/originality.js JUDGE_QUESTIONS, judgeState) and
// prints how each threshold would decide. About $0.01 per run of both models on the 60 pairs (80 with SHIFT set).
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/dup-eval.mjs [clef-flash] [clef]   (SHIFT=4: held-out set)
import { kinship, JUDGE_QUESTIONS, judgeState, FLASH_SURE, CLEF_COPY } from '../src/originality.js';
// A labelled set of game pairs as the AI review sees them (listing, build facts, measurements), built from mock games.

const F = (engine, rendering, input, extra = {}) => ({ engine, libraries: [], platform_kits: [], rendering, graphics: extra.graphics || ['particles', 'tweening'], input, audio: ['Web Audio'], assets: { approach: extra.art || 'procedural' }, platform_services: ['cloud saves'], loop: extra.loop || ['requestAnimationFrame loop', 'delta-time movement'], play_through: extra.steps || 6, own_code_lines: extra.lines || 6000 });
const BASES = [
  { title: 'Void Echoes', tagline: 'A roguelike deckbuilder about the last day of a city that refuses to end.', tags: ['roguelike', 'deck-building', 'fantasy', 'dark'], facts: F('PixiJS', ['WebGL'], ['mouse', 'touch'], { loop: ['seeded randomness', 'Web Workers'] }), names: ['Vesper Dusk', 'Hollow Mite', 'Ash Hound', 'Grave Warden', 'Kindle', 'Nightfall', 'Riposte', 'Second Wind', 'Vigil', 'Whetstone', 'Mire Queen', 'Cinder Saint'] },
  { title: 'Star Miner', tagline: 'Drill through a living asteroid for ore, relics and a way home.', tags: ['arcade', 'space', 'upgrades', '2d'], facts: F('none', ['Canvas 2D'], ['keyboard', 'touch']), names: ['Ore Golem', 'Drill Bot', 'Quartz Moth', 'Magma Vent', 'Gem Beetle', 'Rust King', 'Comet Shard', 'Pilot Juno', 'Cobalt Vein', 'Hull Patch'] },
  { title: 'Tide Pool Tycoon', tagline: 'Run a seaside aquarium shop and breed the rarest reef fish.', tags: ['simulation', 'management', 'ocean', 'cozy'], facts: F('three.js', ['WebGL'], ['mouse', 'touch'], { graphics: ['procedural 3D scenery', 'shadows'] }), names: ['Clown Loach', 'Coral Reef', 'Tide Pump', 'Kelp Garden', 'Harbor Mae', 'Glass Tank', 'Moon Jelly', 'Reef Permit', 'Salt Lamp', 'Captain Ode'] },
  { title: 'Bloomguard', tagline: 'Guard the Heartbloom through endless nights with up to three friends.', tags: ['survival', 'co-op', 'cozy', '3d'], facts: F('none', ['WebGL'], ['keyboard', 'mouse', 'gamepad'], { graphics: ['deferred toon renderer', 'procedural 3D scenery'], loop: ['host-authoritative snapshots with interpolation'] }), names: ['Heartbloom', 'Thornling', 'Ember Fox', 'Moss Golem', 'Petal Lance', 'Gloom Moth', 'Lamplighter', 'Seed Vault', 'Rootwall', 'Dusk Hollow'] },
  { title: 'Neon Drift', tagline: 'Slide through a rain-soaked megacity in a stolen hover car.', tags: ['racing', 'cyberpunk', 'fast-paced', 'neon'], facts: F('Babylon.js', ['WebGL'], ['keyboard', 'gamepad']), names: ['Hover Kite', 'Rain Lane', 'Volt Sister', 'Chrome Bay', 'Nitro Cell', 'Skyline Loop', 'Ghost Taxi', 'Arc Tunnel', 'Neon Saint', 'Pulse Gate'] },
  { title: 'Word Garden', tagline: 'Grow a garden by spelling words from falling seed letters.', tags: ['word', 'relaxing', 'casual', '2d'], facts: F('none', ['DOM and CSS', 'Canvas 2D'], ['keyboard', 'touch'], { steps: 3, lines: 1800 }), names: ['Sunflower Bed', 'Letter Seed', 'Rain Barrel', 'Gardener Pim', 'Ivy Trellis', 'Compost Heap', 'Bee Hive', 'Tulip Row', 'Moss Stone', 'Garden Gnome'] },
  { title: 'Hollow Keep', tagline: 'Climb a crumbling castle tower one deadly jump at a time.', tags: ['platformer', 'challenging', 'pixel-art', 'medieval'], facts: F('Phaser', ['WebGL'], ['keyboard', 'gamepad'], { art: 'pixel sprites' }), names: ['Sir Pell', 'Bone Bat', 'Spike Pit', 'Crumble Ledge', 'Torch Hall', 'Gargoyle Ark', 'Chain Lift', 'Iron Maw', 'Crypt Door', 'Tower Crown'] },
  { title: 'Pocket Tactics', tagline: 'Small squads, short battles, one clever move decides it.', tags: ['strategy', 'tactics', 'turn-based', 'minimalist'], facts: F('none', ['SVG'], ['mouse', 'touch'], { lines: 3000 }), names: ['Shield Pawn', 'Lancer Ivo', 'Archer Nell', 'Siege Ram', 'Fog Tile', 'Banner Hill', 'Captain Roe', 'Flank Gate', 'Ward Tower', 'River Ford'] },
  { title: 'Sky Bakery', tagline: 'Bake pastries on a floating island and feed the cloud folk.', tags: ['idle', 'cozy', 'cooking', 'cute'], facts: F('none', ['Canvas 2D'], ['mouse', 'touch'], { lines: 2500 }), names: ['Cloud Bun', 'Sugar Mill', 'Baker Lumi', 'Honey Oven', 'Wind Whisk', 'Star Tart', 'Puff Cart', 'Isle Market', 'Dough Golem', 'Cinnamon Kite'] },
  { title: 'Grave Run', tagline: 'Outrun the reaper through an endless haunted graveyard.', tags: ['endless', 'spooky', 'arcade', 'one-button'], facts: F('none', ['Canvas 2D'], ['keyboard', 'touch'], { lines: 1500 }), names: ['Reaper Moss', 'Tomb Hop', 'Wisp Lantern', 'Bone Fence', 'Ghoul Hound', 'Coffin Cart', 'Raven Gate', 'Lich Bell', 'Mourn Well', 'Crow Widow'] },
];
const nm = (l) => l.map((n) => n.toLowerCase());
const fresh = (b, i) => b.names.map((n, j) => `${['Amber', 'Brine', 'Cobalt', 'Dune', 'Ember', 'Frost', 'Gale', 'Haze', 'Iris', 'Jade'][(i + j) % 10]} ${['Warden', 'Moth', 'Lance', 'Hound', 'Bell', 'Saint', 'Gate', 'Crown', 'Kite', 'Well', 'Vane', 'Rook'][j % 12]}`);
const T = ['Ember Requiem', 'Night Ledger', 'Ashen Bells', 'Copper Sky', 'Lantern Hymn', 'Rust Psalm', 'Velvet Ruin', 'Grey Harbor', 'Moth Chapel', 'Salt Crown'];
const pair = (label, kind, a, b, code) => {
  const k = kinship({ ...a, names: nm(a.names), traits: [] }, { ...b, names: nm(b.names), traits: [] });
  const L = (g) => ({ title: g.title, tagline: g.tagline, description: '', tags: g.tags });
  return { label, kind, verdict: k.verdict, state: { new_game: { listing: L(a), facts: a.facts }, existing_game: { listing: L(b), facts: b.facts }, measurements: { code, same_files: 0, assets: 0, look_distance: kind.includes('reskin') ? 8 : 30, palette_overlap: 40, looks_alike: false, title_sim: k.title_sim, tagline_sim: k.tagline_sim, same_genre: k.same_genre, tags_overlap: k.tags_overlap, shared_names: k.shared_names, names_share: k.names_share, name_examples: k.name_examples, traits_overlap: 80 } } };
};
export const PAIRS = [];
const SH = Number(process.env.SHIFT || 0);
BASES.forEach((b, i0) => {
  const i = i0 + SH;
  const other = BASES[(i0 + 3 + SH) % BASES.length];
  // copies: the game's identity taken, the code rebuilt
  PAIRS.push(pair('copy', 'retitled, whole cast kept', { ...b, title: T[i % 10], tagline: `A new story told in ${T[i % 10].toLowerCase()}.` }, b, 14));
  PAIRS.push(pair('copy', 'same tagline, most of the cast', { ...b, title: T[(i + 1) % 10], names: [...b.names.slice(0, 7), ...fresh(b, i).slice(7)] }, b, 18));
  PAIRS.push(pair('copy', 'retitled reskin, code half shared', { ...b, title: T[(i + 2) % 10], tagline: 'Same nights, new paint.', names: b.names.slice(0, 8) }, b, 55));
  // derivatives: the same kind of game with its own identity
  PAIRS.push(pair('derivative', 'same genre, own cast and title', { ...b, title: T[(i + 3) % 10], tagline: `Another take on the ${b.tags[0]} idea, with its own world.`, names: fresh(b, i) }, b, 9));
  PAIRS.push(pair('derivative', 'same genre, a couple of common names', { ...b, title: T[(i + 4) % 10], tagline: `A ${b.tags[0]} game about different people in a different place.`, names: [...fresh(b, i + 1).slice(0, 8), ...b.names.slice(0, 2)] }, b, 12));
  // independent: only the name is shared, the game is unrelated
  if (SH) {
    PAIRS.push(pair('derivative', 'same title and genre, own content', { ...b, tagline: `A fresh ${b.tags[0]} game with a world of its own.`, names: fresh(b, i + 2) }, b, 8));
    PAIRS.push(pair('copy', 'whole cast kept, new title and tagline, code mostly new', { ...b, title: T[(i + 5) % 10], tagline: 'Everything you loved, rebuilt from scratch.', names: [...b.names.slice(0, 10)] }, b, 25));
  }
  PAIRS.push(pair('independent', 'same title, unrelated game', { ...other, title: b.title, names: other.names }, b, 4));
});

const ACC = process.env.CLOUDFLARE_ACCOUNT_ID, TOK = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_ACCOUNT_API_TOKEN;
const PRICE = { 'clef-flash': 0.038, clef: 0.24 }, CAP = Number(process.env.MAX_USD || 0.25);
let spent = 0;
async function ask(model, state) {
  for (let t = 0; t < 3; t++) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/ai/run/@cf/cloudflare/${model}`, { method: 'POST', headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, state: judgeState(state), questions: JUDGE_QUESTIONS }) });
    const j = await r.json().catch(() => null);
    if (j?.success) { spent += (j.result.usage?.input_tokens || 0) * PRICE[model] / 1e6; const a = j.result.answers.verdict; return { choice: a.choice, p: a.probabilities }; }
    await new Promise((s) => setTimeout(s, 1000 * (t + 1)));
  }
  return null;
}
if (!ACC || !TOK) { console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.'); process.exit(1); }
const models = process.argv.slice(2).length ? process.argv.slice(2) : ['clef-flash', 'clef'];
const rows = [];
for (let i = 0; i < PAIRS.length && spent < CAP; i += 4) rows.push(...await Promise.all(PAIRS.slice(i, i + 4).map(async (x) => { const r = { label: x.label, kind: x.kind }; for (const m of models) r[m] = await ask(m, x.state); return r; })));
const isCopy = (r) => r.label === 'copy';
if (rows[0]?.['clef-flash']) for (const t of [0.65, 0.7, FLASH_SURE, 0.8]) {
  const fin = rows.filter((r) => r['clef-flash'] && r['clef-flash'].choice !== 'copy' && r['clef-flash'].p[r['clef-flash'].choice] >= t);
  console.log(`clef-flash final at ${t}${t === FLASH_SURE ? ' (in use)' : ''}: ${fin.length}/${rows.length} pairs, copies let through ${fin.filter(isCopy).length}`);
}
if (rows[0]?.clef) for (const t of [0.2, CLEF_COPY, 0.5]) {
  const bad = rows.filter((r) => r.clef && (r.clef.p.copy >= t) !== isCopy(r));
  console.log(`clef refusing from ${t}${t === CLEF_COPY ? ' (in use)' : ''}: ${bad.length}/${rows.length} wrong`, bad.map((r) => `${r.label}/${r.kind} ${r.clef.p.copy.toFixed(2)}`).slice(0, 5));
}
console.log(`spent about $${spent.toFixed(4)}`);

// Step 1 of the duplication check, the rules: they refuse only games that are essentially the same one (two of the same
// title, the same tagline and many of the same names) and send anything near to the AI review. Mock games, no Worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentNames, identityKeys, kinship } from '../src/originality.js';

const names = (list, base) => contentNames([{ path: 'src/data.js', text: `export const D = ${JSON.stringify(list.map((n) => ({ name: n })))};` }], base);
const VOID = ['Vesper Dusk', 'Hollow Mite', 'Ash Hound', 'Grave Warden', 'The Void Echo', 'Kindle', 'Nightfall', 'Riposte', 'Second Wind', 'Vigil', 'Whetstone', 'Lantern Ward', 'Mire Queen', 'Bell Tower', 'Cinder Saint', 'Hush Knight'];
const ORE = ['Ore Golem', 'Drill Bot', 'Quartz Moth', 'Magma Vent', 'Deep Shaft', 'Gem Beetle', 'Rust King'];
const TAG = 'A roguelike deckbuilder about the last day of a city that refuses to end.';
const void0 = { title: 'Void Echoes', tagline: TAG, tags: ['roguelike', 'deck-building', 'fantasy'], names: names(VOID), traits: ['engine:PixiJS', 'render:WebGL', 'input:mouse', 'input:touch'] };
const g = (over) => ({ ...void0, ...over });

// [what it is, the new game, expected verdict against Void Echoes]
const CASES = [
  ['an exact clone', g({}), 'copy'],
  ['same title and tagline, all new content', g({ names: names(ORE) }), 'copy'],
  ['same title and the same cast, a new tagline', g({ tagline: 'Fight the night with borrowed hymns and old bells.' }), 'copy'],
  ['a retitled clone: new title, same tagline and cast', g({ title: 'Ember Requiem' }), 'copy'],
  ['the same title written differently', g({ title: 'The VOID-echoes!', tagline: 'Something else entirely, with new words.', names: names(ORE) }), 'similar'],
  ['the same title only (two games called the same)', g({ tagline: 'Mine the asteroid belt for ore and glory.', names: names(ORE), tags: ['arcade', 'space'] }), 'similar'],
  ['the same tagline only', g({ title: 'Star Miner', names: names(ORE) }), 'similar'],
  ['retitled with a new tagline, the cast kept', g({ title: 'Ember Requiem', tagline: 'Fight the night with borrowed hymns and old bells.' }), 'similar'],
  ['a misspelt title', g({ title: 'Void Echos', tagline: 'Fight the night with borrowed hymns and old bells.', names: names(ORE) }), 'similar'],
  ['a sequel-like title', g({ title: 'Void Echoes II', tagline: 'Fight the night with borrowed hymns and old bells.', names: names(ORE) }), 'similar'],
  ['six of the same names, nothing else', g({ title: 'Ember Requiem', tagline: 'Fight the night with borrowed hymns and old bells.', names: names([...VOID.slice(0, 6), ...ORE, ...ORE.map((n) => n + ' Prime'), 'Ash Moth', 'Gravel Imp', 'Coal Wyrm']) }), 'similar'],
  ['three shared names, nothing else', g({ title: 'Ember Requiem', tagline: 'Fight the night with borrowed hymns and old bells.', names: names([...VOID.slice(0, 3), ...ORE]), traits: ['engine:none', 'render:Canvas 2D'] }), 'similar'],
  ['two shared names, nothing else', g({ title: 'Ember Requiem', tagline: 'Fight the night with borrowed hymns and old bells.', names: names([...VOID.slice(0, 2), ...ORE]), traits: ['engine:none', 'render:Canvas 2D'] }), 'different'],
  ['retitled, the same tagline and a few names', g({ title: 'Ember Requiem', names: names([...VOID.slice(0, 4), ...ORE]), traits: ['engine:none', 'render:Canvas 2D'] }), 'similar'],
  ['retitled, the same tagline and nothing else', g({ title: 'Ember Requiem', names: names(ORE), traits: ['engine:none', 'render:Canvas 2D'], tags: ['arcade'] }), 'similar'],
  ['three shared names, built the same way', g({ title: 'Ember Requiem', tagline: 'Fight the night with borrowed hymns and old bells.', names: names([...VOID.slice(0, 3), ...ORE]) }), 'similar'],
  ['the same genre and build, its own identity', g({ title: 'Star Miner', tagline: 'Mine the asteroid belt for ore and glory.', names: names(ORE) }), 'similar'],
  ['the same genre, built differently, its own identity', g({ title: 'Star Miner', tagline: 'Mine the asteroid belt for ore and glory.', names: names(ORE), traits: ['engine:none', 'render:Canvas 2D', 'input:keyboard'] }), 'different'],
  ['an unrelated game', { title: 'Tide Pool Tycoon', tagline: 'Run an aquarium shop by the sea.', tags: ['simulation', 'cozy'], names: names(['Clown Loach', 'Coral Reef', 'Tide Pump']), traits: ['engine:three.js', 'render:WebGL'] }, 'different'],
  ['the same short tagline only', g({ title: 'Star Miner', tagline: 'Fun!', names: names(ORE), tags: ['arcade'] }), 'different'],
  ['a title in another script, the same', { ...void0, title: '虚空回响', tagline: '新的故事，新的角色，新的城市。', names: names(ORE), tags: ['puzzle'] }, 'different'],
];

for (const [what, a, want] of CASES) {
  test(`rules: ${what} → ${want}`, () => {
    const k = kinship(a, void0);
    assert.equal(k.verdict, want, JSON.stringify(k));
    if (want !== 'different') assert.ok(k.why.length > 0, 'says what matched');
  });
}

test('rules: the same title in another script is the same title', () => {
  const zh = { title: '虚空回响', tagline: '一座不肯结束的城市的最后一天。', names: [] };
  assert.equal(kinship(zh, { ...zh }).verdict, 'copy');
  assert.equal(kinship({ ...zh, tagline: '完全不同的一句话，讲别的事情。' }, zh).verdict, 'similar');
});

test('rules: names that come from a template are not shared names', () => {
  const base = new Set(names(VOID));
  assert.deepEqual(names(VOID, base), []);
  assert.equal(kinship(g({ title: 'Ember Requiem', tagline: 'Fight the night with borrowed hymns and old bells.', names: names(VOID, base) }), void0).verdict, 'similar'); // only the build is alike
});

test('rules: menu words, key names and short strings are never names', () => {
  assert.deepEqual(names(['Play', 'New Game', 'Settings', 'Escape', 'ArrowLeft', 'Score', 'OK', 'Hp', 'Continue', 'Game Over']), []);
});

test('rules: every refusal and every closer look says exactly what matched', () => {
  const k = kinship(g({ title: 'Ember Requiem' }), void0);
  assert.match(k.why.join('; '), /the same tagline/);
  assert.match(k.why.join('; '), /16 of the same names \(ash hound/);
  assert.equal(k.name_examples.length, 12);
});

test('the judge reads the pair in plain sentences', async () => {
  const { judgeState } = await import('../src/originality.js');
  const st = judgeState({ new_game: { listing: { title: 'Ember Requiem', tagline: 'x', tags: ['roguelike'] }, facts: { engine: 'PixiJS', rendering: ['WebGL'], input: ['mouse'] } }, existing_game: { listing: { title: 'Void Echoes', tagline: 'y', tags: ['roguelike'] }, facts: null }, measurements: { code: 12, title_sim: 20, tagline_sim: 10, shared_names: 9, names_share: 18, name_examples: ['kindle', 'vigil'], same_genre: true, looks_alike: false } });
  assert.match(st.comparison, /The titles are different\..*9 named characters.*18% of the new game's names\): kindle, vigil\..*Their code is different \(12% alike/);
  assert.equal(st.existing_game.built_with, null);
});

test('rules: the index finds what the rules would look at, and nothing for an unrelated game', () => {
  const hit = (a) => { const x = identityKeys(a), y = identityKeys(void0); return x.strong.filter((h) => y.strong.includes(h)).length * 10 + x.names.filter((h) => y.names.includes(h)).length; };
  for (const [what, a, want] of CASES) if (want === 'copy') assert.ok(hit(a) >= 3, what);
  assert.equal(hit(CASES.find((c) => c[0] === 'an unrelated game')[1]), 0);
});

test('rules: the same tagline or 3+ shared names always goes to clef, never settled by the cheap model', () => {
  const other = { title: 'Ember Requiem', tagline: 'Fight the night with borrowed hymns and old bells.', traits: ['engine:none', 'render:Canvas 2D'] };
  const k = (over) => kinship(g({ ...other, ...over }), void0);
  const few = k({ tagline: TAG, names: names([...VOID.slice(0, 4), ...ORE]) });
  assert.equal(few.verdict, 'similar');
  assert.equal(few.clef_only, true);
  assert.match(few.why.join('; '), /the same tagline; 4 of the same names \(/);
  assert.equal(k({ tagline: TAG, names: names(ORE) }).clef_only, true, 'the same tagline alone');
  assert.equal(k({ names: names([...VOID.slice(0, 3), ...ORE]) }).clef_only, true, 'three shared names alone');
  assert.equal(k({ names: names([...VOID.slice(0, 2), ...ORE]) }).clef_only, false, 'two shared names are not enough');
  assert.equal(k({ names: names(ORE), title: 'Void Echoes II' }).clef_only, false, 'a close title alone may be settled by the cheap model');
  assert.equal(k({ tagline: 'Fun!', names: names(ORE) }).clef_only, false, 'a short tagline is not a tagline match');
});

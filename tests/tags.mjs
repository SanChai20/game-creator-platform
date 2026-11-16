// The platform tag list: what agents can choose, how old free tags map onto it, and what publishing needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GENRES } from '../web/src/gamemeta.ts';
import { missingTags, normalizeStoredTags, normTag, parseTags, suggestTags, tagGroup, TAG_GROUPS, TAGS } from '../web/src/tags.ts';

test('the list is unique, kebab-case, and never repeats a genre', () => {
  assert.equal(new Set(TAGS).size, TAGS.length);
  for (const t of TAGS) assert.match(t, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, t);
  for (const g of GENRES) assert.equal(TAGS.includes(g), false, g);
  assert.deepEqual(Object.keys(TAG_GROUPS), ['theme', 'mood', 'gameplay', 'players', 'style']);
});

test('every tag and group has a name in the web app, so all six languages can show it', () => {
  const lib = readFileSync(new URL('../web/src/lib.tsx', import.meta.url), 'utf8');
  for (const t of TAGS) assert.ok(new RegExp(`(?:^|[\\s{,])(?:'${t}'|${t}): \\(\\) => t\\(`).test(lib), `no name for ${t}`);
  for (const g of Object.keys(TAG_GROUPS)) assert.ok(lib.includes(`${g}: t(`), `no name for group ${g}`);
});

test('agents choose from the list: aliases map, genres are set apart, anything else is refused with a hint', () => {
  assert.equal(normTag('Sci Fi'), 'sci-fi');
  assert.equal(normTag('PIXEL'), 'pixel-art');
  assert.equal(normTag('side_scroller'), 'side-view');
  assert.equal(normTag('zombie'), 'zombies');
  assert.equal(normTag('puzzle'), null);   // a genre, not a tag
  const r = parseTags(['cute', 'Puzzle', 'roguelite', 'spaceship', 'cute', 'coop']);
  assert.deepEqual(r.tags, ['cute', 'co-op']);
  assert.deepEqual(r.genres, ['puzzle', 'roguelike']);
  assert.equal(r.unknown.length, 1);
  assert.ok(r.unknown[0].suggestions.includes('space'), JSON.stringify(r.unknown));
  assert.deepEqual(suggestTags(''), []);
  assert.equal(tagGroup('pixel-art'), 'style');
  assert.equal(tagGroup('action'), 'genre');
  assert.equal(tagGroup('banana'), null);
});

test('tags stored before the list are mapped or dropped, genres first', () => {
  assert.deepEqual(normalizeStoredTags(['co-op', 'survival', 'roguelite', 'cozy', 'multiplayer', '3d']), ['survival', 'roguelike', 'co-op', 'cozy', 'multiplayer', '3d']);
  assert.deepEqual(normalizeStoredTags(['adventure', 'two words', 'x', 'a']), ['adventure']);
  assert.deepEqual(normalizeStoredTags(['test', 'probe']), []);
  assert.deepEqual(normalizeStoredTags(null), []);
});

test('publishing needs at least two tags from the list and none off it', () => {
  assert.match(missingTags(['puzzle', 'cute']), /at least 2/);
  assert.equal(missingTags(['puzzle', 'cute', 'pixel-art']), null);
  assert.match(missingTags(['puzzle', 'cute', 'pixel-art', 'banana']), /"banana" is not on the platform list/);
});

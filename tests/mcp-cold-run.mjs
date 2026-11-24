// What the cold-start agent run (Haiku 5.5, connected with nothing but the MCP) found, each held in place: a stacking game
// whose every press started and ended a short run failed input_handled although it scored and ended 53 runs under input;
// the failing check had no entry in the versions guide; "gcp.json" warnings read as if the agent had to write that file;
// declaring build fields did not say to deploy again before publishing; flashing_lights had no definition; and the
// debug_preview presets did not say which way up they are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { outcomeReaction } = await import('../src/verify-core.js');
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('input that makes the game score and end runs counts as reacting, time alone does not', () => {
  // the cold-run game: nothing reported in the still moment, many score and gameOver calls during each burst
  assert.equal(outcomeReaction([{ idle: [0, 0], input: [0, 12] }, { idle: [12, 12], input: [12, 30] }]).ok, true);
  // a game that scores by itself over time, as much with nothing pressed
  assert.equal(outcomeReaction([{ idle: [0, 5], input: [5, 10] }, { idle: [10, 15], input: [15, 20] }]).ok, false);
  // one stray call is not enough
  assert.equal(outcomeReaction([{ idle: [0, 0], input: [0, 1] }]).ok, false);
  assert.deepEqual(outcomeReaction([]), { idle: 0, input: 0, ok: false });
  assert.equal(outcomeReaction([null, { idle: [3, 3] }]).ok, false);
});

test('the verifier uses what the game reports, and says so', () => {
  const v = read('src/verify-core.js');
  assert.match(v, /byOutcome = playReport\.ok/);
  assert.match(v, /byPicture \|\| byPage \|\| byState \|\| byOutcome/);
  assert.match(v, /outcomeIdle: playReport\.idle, outcomeInput: playReport\.input/);
});

test('every check the verifier can report has an entry in the versions guide', () => {
  const v = read('src/verify-core.js'), guide = read('web/public/guides/troubleshooting.md');
  const ids = [...new Set([...v.matchAll(/add\('([a-z_]+)'/g)].map((m) => m[1]))].filter((id) => id !== 'deployed');
  for (const id of ids) assert.match(guide, new RegExp(`^## ${id}[:,]`, 'm'), id);
  assert.match(guide, /^## device_iphone, device_ipad:/m);
});

test('declaring answers say what to do next, and words are defined', () => {
  const t = read('src/mcp/tools.ts');
  assert.match(t, /call deploy_preview \{project\} next and publish the version it makes/);
  assert.match(t, /flashing_lights is true when the game flashes or strobes/);
  assert.match(t, /landscape' : ' portrait'/);
  for (const f of ['web/src/compat.ts', 'web/src/languages.ts']) assert.match(read(f), /you never need to create it/, f);
  assert.match(read('src/cover-spec.js'), /gcp:\/\/templates\/cover/);
});

// What the second end-to-end agent run (Haiku 5.5, MCP test run 2) found, each held in place: the tools say what they
// stored, refuse what they cannot do, and say what a version's outcome was. Each was also confirmed with live MCP calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fleetRequest } from '../src/bots-core.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const tools = read('src/mcp/tools.ts');
const entry = (name) => { const i = tools.indexOf(`name: '${name}'`); assert.ok(i > 0, name); const j = tools.indexOf("\n    name: '", i + 10); return tools.slice(i, j > 0 ? j : undefined); };

test('#1 create_project checks tags like game_metadata, keeps genres among them, and reports how each word was read', () => {
  const create = entry('create_project');
  assert.match(create, /if \(a\.tags !== undefined\) chooseTags\(a\.tags\);/, 'refused before the project exists');
  assert.match(create, /updateProjectMeta\(c\.env, p, \{ genre: a\.genre, \.\.\.\(a\.tags !== undefined \? \{ tags: a\.tags \} : \{\}\) \}\)/, 'genre and tags set together, so a genre among the tags becomes a secondary genre');
  assert.match(create, /\.\.\.tagAnswer\(p, a\.tags\)/);
  assert.match(entry('update_project'), /tagAnswer\(q, a\.tags\)/);
  assert.match(entry('game_metadata'), /tag_notes: t\.tag_notes/);
});

test('#2 compatibility writes and shows orientation "both", never the internal "any"', () => {
  const c = entry('compatibility');
  assert.match(c, /check\.value\.orientation === 'any' \? \{ orientation: 'both' \}/);
  assert.match(c, /declared: cp\.declared \? bothNotAny\(/);
});

test('#3 the bot fleet reports the preview version it plays, apart from its update counter', () => {
  const bots = read('src/bots.ts');
  assert.match(bots, /game_version: info\.version, updates: this\.version/);
  assert.doesNotMatch(bots, /fleet: info\.fleet, version: this\.version/);
});

test('#4 a queue fleet without players says players is required and has no default', () => {
  const L = { maxBots: 15, maxMinutes: 30 };
  assert.match(fleetRequest({ target: 'queue' }, L).error, /target "queue" needs players/);
  assert.match(fleetRequest({ target: 'queue' }, L).error, /no default/);
  assert.ok(fleetRequest({ target: 'queue', players: 2 }, L).ok);
  assert.match(entry('preview_bots'), /target queue \(required, no default\)/);
});

test('#5 upload_files refuses a delete of a path that is not there, before anything is saved', () => {
  const u = entry('upload_files');
  const refuse = u.indexOf('not in the workspace, so nothing in this call was saved'), write = u.indexOf('for (const [path, bytes] of pending) rows.set');
  assert.ok(refuse > 0 && write > refuse, 'the refusal comes before the first write');
});

test('#6 a deploy answer leads with the verification outcome; a failed version says it stays on the preview', () => {
  const vr = tools.slice(tools.indexOf('async function versionReport'), tools.indexOf('/**', tools.indexOf('async function versionReport')));
  assert.match(vr, /const verification = running \? 'running' : v\.status === 'verified' \? 'passed' : v\.status === 'failed' \? 'failed'/);
  assert.match(vr, /verification_failed: `Version \$\{n\} was deployed but failed verification/);
  assert.match(entry('deploy_preview'), /deployed: true only means the files went out/);
});

test('#7 scores a debug_preview session submits are kept on the preview boards, the verifier\'s are not', () => {
  const rt = read('src/routes/rt.ts'), debug = read('src/debug.ts');
  assert.match(debug, /n: 'Debugger', k: 'verify', s: sid, x, dbg: 1 \}/);
  assert.match(rt, /const keeps = tok\.k !== 'verify' \|\| \(!!tok\.dbg && tok\.e === 'preview'\);/);
  assert.match(rt, /if \(keeps\) await c\.env\.DB\.prepare\(`INSERT INTO scores/);
  assert.match(rt, /\.\.\.\(tok\.dbg \? \{ dbg: 1 \} : \{\}\)/, 'a refreshed debug token stays a debug token');
  assert.match(read('src/player-data.js'), /DELETE FROM scores WHERE user_id >= 'verify:'/, 'and they are cleaned up daily');
  // the game's own calls to the platform and console.warn lines reach debug_preview's state
  const sdk = read('web/public/sdk/gcp.js'), core = read('src/debug-core.js');
  assert.match(sdk, /noteCall\(path, body, r\.status/);
  assert.match(sdk, /console\.warn = function/);
  assert.ok(sdk.includes("['errors', 'warnings', 'missing', 'warns', 'calls'].forEach"), 'the verifier\'s read-only view carries them');
  assert.match(core, /console_warnings: \(s\.warns \|\| \[\]\)\.slice\(-10\), platform_calls: \(s\.calls \|\| \[\]\)\.slice\(-10\)/);
});

test('#8 debug_preview states its wait limits up front, not only in an error', () => {
  assert.match(entry('debug_preview'), /waits adding up to \$\{DEBUG_LIMITS\.wait_ms \/ 1000\} seconds/);
  assert.match(tools, /a 60-second round takes three or more act calls/);
});

test('#9 deploy_preview and list_versions can wait for the result in one call', async () => {
  assert.match(entry('deploy_preview'), /wait_seconds: WAIT_SCHEMA\(DEPLOY_WAIT_MS\)/);
  assert.match(entry('list_versions'), /wait_seconds: WAIT_SCHEMA\(LIST_WAIT_MS\)/);
  assert.match(entry('list_versions'), /waitMs\(a\.wait_seconds, LIST_WAIT_MS\)/);
  assert.match(tools, /export const MAX_WAIT_S = 150;/);
});

test('#11 a refused token gets the short refresh answer; no token gets the sign-in steps', () => {
  const idx = read('src/index.ts');
  const fn = idx.slice(idx.indexOf('function accessHelp'), idx.indexOf('function isolated'));
  const short = fn.slice(fn.indexOf('if (hadToken) return {'), fn.indexOf('};', fn.indexOf('if (hadToken) return {')));
  assert.doesNotMatch(short, /how_to_connect: \{/);
  assert.match(short, /refresh: refresh/);
});

test('#12 a capture difference caused by page elements is called expected, and the detail says it is advice', () => {
  const v = read('src/verify-core.js');
  assert.match(v, /which is expected while those page elements cover the game/);
  assert.match(v, /'Advice, not a fault \(it does not stop the version\): '/);
});

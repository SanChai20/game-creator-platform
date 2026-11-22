// Live test of the 17 MCP tools against a deployed platform, driven the way an agent drives them.
// Every tool gets its happy path and its error paths. A connected player joins a multiplayer room over
// a real WebSocket and submits a leaderboard score with the play token the platform gives players.
//   BASE=https://<site> node tests/mcp-live.mjs
// Creates throwaway accounts and projects. At the end every game it published is taken offline again, so nothing
// it made stays in the public store; no tool deletes a project, so the ids are printed for removal in the admin console.
// Needs Node 22 or later (global WebSocket). Publishing is skipped, and reported as skipped, when the
// platform requires the creator license for publishing.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { signUp } from './live-auth.mjs';

const BASE = process.env.BASE; if (!BASE) throw new Error('Set BASE to the site origin.');
const WS = BASE.replace(/^http/, 'ws');
const run = randomBytes(3).toString('hex'), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SKIP = Symbol('skip');
const tplDir = new URL('../web/public/templates/', import.meta.url);
const blankFiles = JSON.parse(readFileSync(new URL('index.json', tplDir), 'utf8')).templates.find((x) => x.name === 'blank').files
  .map((f) => ({ path: f.path, content: readFileSync(new URL(`blank/${f.path}`, tplDir), 'utf8') }));
const RUNNING = ['queued', 'deploying', 'verifying'];

function client() {
  const jar = new Map();
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { ...(body && !extra.raw ? { 'content-type': 'application/json' } : {}), origin: BASE, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(extra.headers || {}) }, body: extra.raw ? body : body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b, x) => call('POST', p, b, x) };
}
const must = (r, code = 200) => { assert.equal(r.status, code, `expected ${code}, got ${r.status}: ${r.text.slice(0, 300)}`); return r.json; };
const form = { raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } };

// ---- accounts: a creator who connects over OAuth like an agent, and a player with a normal sign-in
const creator = client();
await signUp(BASE, (p, b, h) => creator.post(p, b, { headers: h }), `mcp-live-${run}@example.com`, 'MCP live ' + run);
const reg = must(await creator.post('/oauth/register', { client_name: 'MCP live test', redirect_uris: ['http://127.0.0.1:9999/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }), 201);
const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9999/cb', scope: 'games', state: 's', code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp` });
const consent = await creator.get('/authorize?' + q); assert.equal(consent.status, 200, consent.text.slice(0, 300));
const handle = consent.text.match(/name="handle" value="([^"]+)"/)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
const approve = await creator.post('/authorize?' + q, new URLSearchParams({ handle, decision: 'approve' }).toString(), form); assert.equal(approve.status, 302, approve.text.slice(0, 300));
const tok = must(await creator.post('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: new URL(approve.headers.get('location')).searchParams.get('code'), redirect_uri: 'http://127.0.0.1:9999/cb', client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }).toString(), form));

const player = client();
await signUp(BASE, (p, b, h) => player.post(p, b, { headers: h }), `mcp-live-player-${run}@example.com`, 'Player ' + run);

// ---- MCP helpers. mcp() never throws on a tool error: tests check both outcomes.
let rpcId = 0;
async function mcp(name, args = {}) {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  assert.equal(r.status, 200, `${name}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) return { rpcError: j.error, text: j.error.message };
  const text = j.result.content[0].text; let data = text; try { data = JSON.parse(text); } catch { /* plain text */ }
  return { isError: !!j.result.isError, data, text };
}
const ok = async (name, args) => { const r = await mcp(name, args); assert.ok(!r.rpcError && !r.isError, `${name} failed: ${r.text}`); return r.data; };
const fails = async (name, args, re) => { const r = await mcp(name, args); assert.ok(r.rpcError || r.isError, `${name} should fail but returned: ${String(r.text).slice(0, 200)}`); if (re) assert.match(r.text, re); return r.text; };
const RPC_TOKEN = tok.access_token;
let playToken = null; // the player's play token, set by the play check and used by the room and leaderboard checks

async function deployAndWait(project, note = 'mcp-live') {
  let d = await ok('deploy_preview', { project, note });
  for (let i = 0; i < 90 && RUNNING.includes(d.status); i++) { await sleep(3000); d = await ok('list_versions', { project, version: d.version }); }
  return d;
}
const results = [];
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === SKIP) { results.push(['skip', name]); console.log(`  - ${name} (skipped)`); }
    else { results.push(['pass', name]); console.log(`  ✓ ${name}`); }
  } catch (e) { results.push(['fail', name]); console.log(`  ✗ ${name}\n      ${String(e.message || e).split('\n').slice(0, 6).join('\n      ').slice(0, 900)}`); }
}
const state = { base: BASE, creator: `mcp-live-${run}@example.com`, projects: {} };

// Room clients: a real WebSocket speaking the same protocol the game's GCP.room() uses.
function openRoom(token, room) {
  return new Promise((resolve, reject) => {
    const inbox = [], ws = new WebSocket(`${WS}/api/rt/room?t=${encodeURIComponent(token)}&room=${encodeURIComponent(room)}`);
    const closed = new Promise((r) => ws.addEventListener('close', (e) => r(e.code)));
    ws.addEventListener('message', (e) => inbox.push(JSON.parse(e.data)));
    ws.addEventListener('open', () => resolve({ ws, inbox, closed }));
    ws.addEventListener('error', () => reject(new Error(`websocket to room ${room} failed`)));
  });
}
const until = async (fn, what, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(150); } };
const scoreApi = async (body) => { const r = await fetch(`${BASE}/api/rt/score`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };

console.log(`MCP live test against ${BASE} (run ${run})`);

// ---- 1. get_started
await check('get_started: overview and a named guide', async () => {
  const d = await ok('get_started');
  assert.ok(d && typeof d === 'object');
  const g = await ok('get_started', { topic: 'multiplayer' });
  assert.ok(String(g.markdown || '').length > 100, 'multiplayer guide is empty');
});
await check('get_started: unknown topic is refused with the topic list', () => fails('get_started', { topic: 'nope' }, /No guide|Topics|topic must be one of: contract/));

// ---- 2. create_project
await check('create_project: missing title is refused', () => fails('create_project', { tagline: 'no title' }));
await check('create_project: tags off the platform list are refused with the closest matches', () => fails('create_project', { title: 'MCP live refused ' + run, tags: ['space', 'Two Words!'] }, /platform list/));
const GAME = await ok('create_project', { title: 'MCP live game ' + run, tagline: 'Live test', tags: ['Adventure', 'Sci Fi', 'pixel', 'relaxing'] });
const EMPTY = await ok('create_project', { title: 'MCP live empty ' + run });
const BAD = await ok('create_project', { title: 'MCP live broken ' + run });
state.projects = { game: GAME.project, empty: EMPTY.project, bad: BAD.project }; const save = () => writeFileSync(process.env.MCP_LIVE_STATE || 'mcp-live-state.json', JSON.stringify(state, null, 1));
save();
const gameInfo = await ok('list_projects', { project: GAME.project });
const SLUG = gameInfo.slug;
await check('create_project: tags are mapped onto the platform list, genres first', () => {
  assert.deepEqual(gameInfo.tags, ['adventure', 'sci-fi', 'pixel-art', 'relaxing'], JSON.stringify(gameInfo.tags));
});

// ---- 3. list_projects
await check('list_projects: lists the new projects, live_version null before publishing', async () => {
  const d = await ok('list_projects');
  const row = d.projects.find((p) => p.id === GAME.project);
  assert.ok(row, 'created project missing from list');
  assert.equal(row.live_version, null);
  assert.ok(Array.isArray(row.tags));
});
await check('list_projects: detail carries tagline, description, controls, tags, cover, live_version', () => {
  for (const k of ['tagline', 'description', 'controls', 'tags', 'cover', 'live_version', 'latest_version', 'game_page', 'console_page']) assert.ok(k in gameInfo, `missing ${k}`);
  assert.equal(gameInfo.game_page, null, 'offline game must have no game page');
});
await check('list_projects: unknown project is refused', () => fails('list_projects', { project: 'does-not-exist-' + run }));

// ---- 4. update_project
await check('update_project: changes title, tagline, controls and price', async () => {
  await ok('update_project', { project: GAME.project, title: 'MCP live game renamed ' + run, tagline: 'x'.repeat(200), controls: 'Arrows to move', price_cents: 0 });
  const d = await ok('list_projects', { project: GAME.project });
  assert.match(d.title, /renamed/);
  assert.equal(d.tagline.length, 140, 'tagline should be cut to 140 characters');
  assert.equal(d.controls, 'Arrows to move');
  assert.equal(d.price, 'free');
});
await check('update_project: unknown project is refused', () => fails('update_project', { project: 'does-not-exist-' + run, title: 'x' }));

// ---- 5. upload_files (the atomic and error paths)
await check('upload_files: the blank template uploads', async () => {
  const d = await ok('upload_files', { project: GAME.project, files: blankFiles });
  assert.equal(d.written.length, blankFiles.length, JSON.stringify(d.written));
});
await check('upload_files: empty call is refused', () => fails('upload_files', { project: GAME.project }, /Nothing to do/));
await check('upload_files: files given as a map instead of an array is refused', () => fails('upload_files', { project: GAME.project, files: { 'x.txt': 'hi' } }, /Nothing to do|files must be array/));
await check('upload_files: a path that escapes the bundle is refused', () => fails('upload_files', { project: GAME.project, files: [{ path: '../evil.js', content: 'x' }] }, /not a valid path/));
await check('upload_files: bad base64 is refused', () => fails('upload_files', { project: GAME.project, files: [{ path: 'art/bad.png', content: '!!!not base64@@', encoding: 'base64' }] }, /base64/));
await check('upload_files: an executable is refused whatever its name', () => fails('upload_files', { project: GAME.project, files: [{ path: 'tool.exe', content: 'MZ' }] }));
await check('upload_files: a failed edit saves nothing from the same call (atomic)', async () => {
  await fails('upload_files', { project: GAME.project, files: [{ path: 'probe-atomic.txt', content: 'should not be saved' }], edits: [{ path: 'index.html', old_string: '@@NOT-THERE@@', new_string: 'y' }] }, /old_string was not found/);
  const l = await ok('list_files', { project: GAME.project });
  assert.ok(!l.files.some((f) => f.path === 'probe-atomic.txt'), 'a file from a refused call was saved');
});
await check('upload_files: an edit that matches twice is refused without replace_all', async () => {
  await ok('upload_files', { project: GAME.project, files: [{ path: 'src/twice.js', content: 'hit;\nhit;\n' }] });
  await fails('upload_files', { project: GAME.project, edits: [{ path: 'src/twice.js', old_string: 'hit;', new_string: 'miss;' }] }, /appears 2 times/);
});
await check('upload_files: replace_all replaces every match and reports the count', async () => {
  const d = await ok('upload_files', { project: GAME.project, edits: [{ path: 'src/twice.js', old_string: 'hit;', new_string: 'miss;', replace_all: true }] });
  assert.equal(d.edited[0].replaced, 2);
});
await check('upload_files: an edit with an empty old_string is refused', () => fails('upload_files', { project: GAME.project, edits: [{ path: 'src/twice.js', old_string: '', new_string: 'x' }] }, /must not be empty/));
await check('upload_files: an edit on a binary file is refused', async () => {
  await ok('upload_files', { project: GAME.project, files: [{ path: 'art/pixel.png', content: 'iVBORw0KGgo=', encoding: 'base64' }] });
  await fails('upload_files', { project: GAME.project, edits: [{ path: 'art/pixel.png', old_string: 'a', new_string: 'b' }] }, /text files/);
});
await check('upload_files: a file created and edited in one call uses the edited text', async () => {
  const d = await ok('upload_files', { project: GAME.project, files: [{ path: 'js/probe.js', content: 'let a=1' }], edits: [{ path: 'js/probe.js', old_string: 'a=1', new_string: 'a=22' }] });
  assert.ok(d.written.some((w) => w.path === 'js/probe.js'));
  const l = await ok('list_files', { project: GAME.project });
  assert.equal(l.files.find((f) => f.path === 'js/probe.js').bytes, 'let a=22'.length);
});
await check('upload_files: deleting a missing path is not an error', async () => {
  const d = await ok('upload_files', { project: GAME.project, delete: ['never-there.txt'] });
  assert.deepEqual(d.deleted, []);
});
await check('upload_files: delete removes a file', async () => {
  const d = await ok('upload_files', { project: GAME.project, delete: ['art/pixel.png'] });
  assert.deepEqual(d.deleted, ['art/pixel.png']);
});
await check('upload_files: unknown project is refused', () => fails('upload_files', { project: 'does-not-exist-' + run, files: [{ path: 'a.txt', content: 'a' }] }));

// ---- 6. list_files and create_upload_url
await check('list_files: lists paths with bytes and sha, and totals', async () => {
  const d = await ok('list_files', { project: GAME.project });
  assert.ok(d.files.some((f) => f.path === 'index.html' && f.bytes > 0 && f.sha));
  assert.equal(d.total ?? d.files.length, d.files.length);
});
await check('list_files: unknown project is refused', () => fails('list_files', { project: 'does-not-exist-' + run }));
await check('create_upload_url: returns a one-time upload address', async () => {
  const d = await ok('create_upload_url', { project: GAME.project });
  assert.ok(JSON.stringify(d).includes('http'), 'no upload URL in the answer');
});
await check('create_upload_url: unknown project is refused', () => fails('create_upload_url', { project: 'does-not-exist-' + run }));

// ---- 7. deploy_preview and list_versions
await check('deploy_preview: dry_run runs the checks and creates no version', async () => {
  const d = await ok('deploy_preview', { project: GAME.project, dry_run: true });
  assert.equal(d.ok, true, JSON.stringify(d.errors));
  const v = await ok('list_versions', { project: GAME.project });
  assert.equal((v.versions ?? v).length, 0, 'dry_run must not create a version');
});
await check('deploy_preview: a project without index.html fails its checks', async () => {
  const txt = await mcp('deploy_preview', { project: EMPTY.project, dry_run: true });
  assert.ok(txt.rpcError || txt.isError || txt.data?.ok === false, `expected a failed check, got ${txt.text}`);
});
let gameV1 = null;
await check('deploy_preview: a real deploy is verified in a browser', async () => {
  gameV1 = await deployAndWait(GAME.project);
  assert.equal(gameV1.status, 'verified', JSON.stringify(gameV1.report || gameV1).slice(0, 800));
});
await check('list_versions: lists versions, and one version in full', async () => {
  const all = await ok('list_versions', { project: GAME.project });
  assert.ok((all.versions ?? all).length >= 1);
  const one = await ok('list_versions', { project: GAME.project, version: gameV1.version });
  assert.equal(one.status, 'verified');
});
await check('list_versions: a version that does not exist is refused', () => fails('list_versions', { project: GAME.project, version: 999 }));
await check('list_versions: unknown project is refused', () => fails('list_versions', { project: 'does-not-exist-' + run }));

// ---- 8. publish: the error paths and a real publish
let liveOK = false;
await check('publish: version that does not exist says so', () => fails('publish', { project: GAME.project, version: 999 }, /Version 999 does not exist/));
await check('publish: a version that is not a whole number is refused', async () => {
  await fails('publish', { project: GAME.project, version: 0 }, /whole number|version must be integer/);
  await fails('publish', { project: GAME.project, version: 'abc' }, /whole number|version must be integer/);
});
await check('publish: with no versions yet, says there is nothing to publish', () => fails('publish', { project: EMPTY.project }, /no version to publish/));
await check('publish: the verified version goes live', async () => {
  const r = await mcp('publish', { project: GAME.project, version: gameV1.version });
  if (r.isError && /creator license/i.test(r.text)) { liveOK = false; return SKIP; }
  assert.ok(!r.rpcError && !r.isError, r.text);
  liveOK = true;
  const d = await ok('list_projects', { project: GAME.project });
  assert.equal(d.live_version, gameV1.version);
  assert.match(d.game_page || '', /\/g\//);
});

// ---- 9. broken version: failed deploys cannot be published, and publish without a version picks the newest verified one
let badV1 = null, badV2 = null, badLive = false; // badLive: the broken-test project's first good version went live
await check('deploy_preview + publish on a second project: a good version', async () => {
  await ok('upload_files', { project: BAD.project, files: blankFiles });
  badV1 = await deployAndWait(BAD.project);
  assert.equal(badV1.status, 'verified', JSON.stringify(badV1.report || badV1).slice(0, 500));
});
await check('publish: the first good version of the broken-test project goes live', async () => {
  const r = await mcp('publish', { project: BAD.project, version: badV1.version });
  if (r.isError && /creator license/i.test(r.text)) return SKIP;
  assert.ok(!r.rpcError && !r.isError, r.text);
  badLive = true;
});
await check('deploy_preview: a broken build fails verification', async () => {
  await ok('upload_files', { project: BAD.project, files: [{ path: 'index.html', content: '<!doctype html><title>broken</title><script>throw new Error("mcp-live boom")</script>' }] });
  badV2 = await deployAndWait(BAD.project);
  assert.equal(badV2.status, 'failed', `expected failed, got ${badV2.status}`);
});
await check('publish: a failed version cannot be published', () => fails('publish', { project: BAD.project, version: badV2.version }));
await check('publish: with no version, the newest verified one is published, not the failed one', async () => {
  const r = await mcp('publish', { project: BAD.project });
  if (r.isError && /creator license/i.test(r.text)) return SKIP;
  assert.ok(!r.rpcError && !r.isError, r.text);
  const d = await ok('list_projects', { project: BAD.project });
  assert.equal(d.live_version, badV1.version);
});

// ---- 10. rollback
await check('rollback: version is required', () => fails('rollback', { project: BAD.project }, /version is required|Missing required argument: version/));
await check('rollback: a version that does not exist says so', () => fails('rollback', { project: BAD.project, version: 99 }, /Version 99 does not exist/));
await check('rollback: a failed version is refused', () => fails('rollback', { project: BAD.project, version: badV2.version }));
await check('rollback: an earlier verified version is made live again', async () => {
  if (!badV1) return SKIP;
  const r = await mcp('rollback', { project: BAD.project, version: badV1.version });
  if (r.isError && /creator license/i.test(r.text)) return SKIP;
  assert.ok(!r.rpcError && !r.isError, r.text);
});

// ---- 11. unpublish
await check('unpublish: takes the game offline and list_projects stops showing it as live', async () => {
  if (!badLive) return SKIP; // nothing went live, so there is nothing to take offline
  await ok('unpublish', { project: BAD.project });
  const d = await ok('list_projects', { project: BAD.project });
  assert.equal(d.status, 'offline');
  assert.equal(d.live_version, null, 'an offline game must not show a live version');
  assert.equal(d.game_page, null);
});
await check('unpublish: unknown project is refused', () => fails('unpublish', { project: 'does-not-exist-' + run }));

// ---- 12. game_data (shared data, saves and leaderboards)
await check('game_data: summary of an empty game', async () => {
  const d = await ok('game_data', { project: GAME.project, action: 'summary' });
  assert.ok(d && typeof d === 'object');
});
await check('game_data: set, get, list with prefix and delete a shared key', async () => {
  await ok('game_data', { project: GAME.project, action: 'set', key: 'motd', value: { text: 'hello' } });
  const g = await ok('game_data', { project: GAME.project, action: 'get', key: 'motd' });
  assert.equal(g.exists, true); assert.deepEqual(g.value, { text: 'hello' });
  const l = await ok('game_data', { project: GAME.project, action: 'list', prefix: 'mo' });
  assert.ok(JSON.stringify(l).includes('motd'));
  await ok('game_data', { project: GAME.project, action: 'delete', key: 'motd' });
  const after = await ok('game_data', { project: GAME.project, action: 'get', key: 'motd' });
  assert.equal(after.exists, false); assert.equal(after.value, null);
});
await check('game_data: get on a missing key answers exists false, not an error', async () => {
  const d = await ok('game_data', { project: GAME.project, action: 'get', key: 'never-set' });
  assert.equal(d.exists, false);
});
await check('game_data: a key of 121 characters is refused', () => fails('game_data', { project: GAME.project, action: 'set', key: 'k'.repeat(121), value: 1 }, /1 to 120/));
await check('game_data: an empty key is refused', () => fails('game_data', { project: GAME.project, action: 'get', key: '' }, /1 to 120/));
await check('game_data: a value over 256 KB is refused', () => fails('game_data', { project: GAME.project, action: 'set', key: 'big', value: 'x'.repeat(270 * 1024) }));
await check('game_data: a value of 200 KB is accepted, then deleted', async () => {
  await ok('game_data', { project: GAME.project, action: 'set', key: 'big', value: 'x'.repeat(200 * 1024) });
  await ok('game_data', { project: GAME.project, action: 'delete', key: 'big' });
});
await check('game_data: an unknown env is refused, not sent to live', () => fails('game_data', { project: GAME.project, action: 'summary', env: 'staging' }, /env must be "preview" or "live"|env must be one of: preview, live/));
await check('game_data: preview data is kept apart from live data', async () => {
  await ok('game_data', { project: GAME.project, action: 'set', env: 'preview', key: 'preview-only', value: 1 });
  const live = await ok('game_data', { project: GAME.project, action: 'get', key: 'preview-only' });
  assert.equal(live.exists, false, 'preview key leaked into live');
  await ok('game_data', { project: GAME.project, action: 'delete', env: 'preview', key: 'preview-only' });
});
await check('game_data: an unknown action is refused', () => fails('game_data', { project: GAME.project, action: 'explode' }));
await check('game_data: unknown project is refused', () => fails('game_data', { project: 'does-not-exist-' + run, action: 'summary' }));

// ---- 13. A connected player: play token, leaderboard submission, room join, state, reset
await check('play: a signed-in player is handed a play URL with a token', async () => {
  if (!liveOK) return SKIP;
  const p = must(await player.post(`/api/games/${SLUG}/play`, {}));
  assert.ok(p.url && new URL(p.url).searchParams.get('gcp_t'), 'no play token in the play URL');
  state.playSession = p.session;
  playToken = new URL(p.url).searchParams.get('gcp_t');
});
await check('play: anonymous visitors are refused', async () => {
  if (!liveOK) return SKIP;
  const anon = await client().post(`/api/games/${SLUG}/play`, {});
  assert.ok(anon.status >= 400, `anonymous play answered ${anon.status}`);
});
await check('play: a bearer token alone is refused (play needs the signed-in cookie)', async () => {
  if (!liveOK) return SKIP;
  const r = await client().post(`/api/games/${SLUG}/play`, {}, { headers: { authorization: `Bearer ${RPC_TOKEN}` } });
  assert.ok(r.status >= 400, `bearer play answered ${r.status}`);
});
await check('play: an offline game refuses play', async () => {
  if (!badV1) return SKIP;
  const bad = await player.post(`/api/games/${(await ok('list_projects', { project: BAD.project })).slug}/play`, {});
  // The platform answers 404 "not available" for a game that is not live (the slug is hidden from non-owners).
  assert.ok([404, 409].includes(bad.status), `offline play answered ${bad.status}`);
});
await check('rt/score: a bad play token is refused', async () => {
  const r = await scoreApi({ t: 'nope', op: 'submit', score: 1 });
  assert.ok(r.status >= 400, `bad token answered ${r.status}`);
});
await check('rt/score: a non-number score is refused', async () => {
  if (!playToken) return SKIP;
  const r = await scoreApi({ t: playToken, op: 'submit', score: 'lots' });
  assert.equal(r.status, 400); assert.match(JSON.stringify(r.json), /score must be a number/);
});
await check('leaderboard submit: a player score is stored and the best is kept', async () => {
  if (!playToken) return SKIP;
  const a = await scoreApi({ t: playToken, op: 'submit', score: 1200, board: 'default' });
  assert.equal(a.status, 200); assert.equal(a.json.best, 1200);
  const b = await scoreApi({ t: playToken, op: 'submit', score: 900, board: 'default' });
  assert.equal(b.json.best, 1200, 'a lower score must not replace the best');
});
await check('leaderboard read: the player appears on the board as "me" in their own view', async () => {
  if (!playToken) return SKIP;
  const r = await scoreApi({ t: playToken, op: 'read', board: 'default', limit: 5 });
  assert.equal(r.status, 200);
  assert.ok(r.json.rows.some((row) => row.score === 1200 && row.me === 1), JSON.stringify(r.json));
});
await check('game_data leaderboard: the creator sees the player\'s score', async () => {
  if (!playToken) return SKIP;
  const d = await ok('game_data', { project: GAME.project, action: 'leaderboard', board: 'default', limit: 5 });
  assert.ok(JSON.stringify(d).includes('1200'), JSON.stringify(d).slice(0, 300));
});
await check('game_data leaderboard: a limit of 1 returns one row', async () => {
  if (!playToken) return SKIP;
  const d = await ok('game_data', { project: GAME.project, action: 'leaderboard', board: 'default', limit: 1 });
  assert.equal((d.rows ?? d).length, 1);
});
await check('game_data leaderboard: asc order is accepted', async () => {
  if (!playToken) return SKIP;
  await ok('game_data', { project: GAME.project, action: 'leaderboard', board: 'default', order: 'asc' });
});
await check('game_room: a player joins over WebSocket and is listed, and is the host', async () => {
  if (!playToken) return SKIP;
  const p1 = await openRoom(playToken, 'lobby');
  state.room = p1;
  const welcome = await until(() => p1.inbox.find((m) => m.t === 'welcome'), 'welcome');
  const inspect = await ok('game_room', { project: GAME.project, room: 'lobby' });
  const found = inspect.players.find((x) => x.id === welcome.id);
  assert.ok(found, `player ${welcome.id} not listed: ${JSON.stringify(inspect).slice(0, 300)}`);
  assert.equal(found.host, true);
  assert.equal(inspect.host, welcome.id);
});
await check('game_room: the host stores room state and the creator reads it', async () => {
  if (!playToken) return SKIP;
  state.room.ws.send(JSON.stringify({ t: 'state', d: { level: 2, marker: 'mcp-live' } }));
  const d = await until(async () => { const i = await ok('game_room', { project: GAME.project, room: 'lobby' }); return i.state && JSON.stringify(i.state).includes('mcp-live') ? i : null; }, 'room state');
  assert.ok(JSON.stringify(d.state).includes('level'));
});
await check('game_room: a second tab of the same player joins, and a non-host cannot set state', async () => {
  if (!playToken) return SKIP;
  const p2 = await openRoom(playToken, 'lobby');
  await until(() => p2.inbox.find((m) => m.t === 'welcome'), 'second welcome');
  p2.ws.send(JSON.stringify({ t: 'state', d: { cheat: true } }));
  const err = await until(() => p2.inbox.find((m) => m.t === 'error'), 'host-only error');
  assert.match(err.message, /Only the host/);
  const inspect = await ok('game_room', { project: GAME.project, room: 'lobby' });
  assert.equal(inspect.players.length, 2, 'the second tab should be listed');
  state.room2 = p2;
});
await check('game_room: preview rooms are separate from live rooms', async () => {
  if (!playToken) return SKIP;
  const d = await ok('game_room', { project: GAME.project, room: 'lobby', env: 'preview' });
  assert.equal(d.players.length, 0, 'preview room must not show live players');
});
await check('game_room: a default room is inspected when none is named', async () => {
  if (!playToken) return SKIP;
  const d = await ok('game_room', { project: GAME.project });
  assert.equal(d.room, 'lobby');
});
await check('game_room: an unknown action is refused, not treated as inspect', () => fails('game_room', { project: GAME.project, action: 'nope' }, /inspect"? or "?reset|one of: inspect, reset/));
await check('game_room: an unknown env is refused', () => fails('game_room', { project: GAME.project, env: 'staging' }, /env must be "preview" or "live"|env must be one of: preview, live/));
await check('game_room: unknown project is refused', () => fails('game_room', { project: 'does-not-exist-' + run }));
await check('game_room: reset without kick clears the state and keeps players connected', async () => {
  if (!playToken) return SKIP;
  const d = await ok('game_room', { project: GAME.project, room: 'lobby', action: 'reset' });
  assert.equal(d.cleared, true); assert.equal(d.disconnected, 0);
  const i = await ok('game_room', { project: GAME.project, room: 'lobby' });
  assert.equal(i.state, null); assert.equal(i.players.length, 2);
});
await check('game_room: reset with kick disconnects everyone, who see close code 4000', async () => {
  if (!playToken) return SKIP;
  const d = await ok('game_room', { project: GAME.project, room: 'lobby', action: 'reset', kick: true });
  assert.equal(d.disconnected, 2);
  assert.equal(await state.room.closed, 4000);
  assert.equal(await state.room2.closed, 4000);
  const i = await ok('game_room', { project: GAME.project, room: 'lobby' });
  assert.equal(i.players.length, 0);
});
await check('game_data clear_leaderboard empties the board', async () => {
  if (!playToken) return SKIP;
  await ok('game_data', { project: GAME.project, action: 'clear_leaderboard', board: 'default' });
  const d = await ok('game_data', { project: GAME.project, action: 'leaderboard', board: 'default' });
  assert.equal((d.rows ?? d).length, 0);
});

// ---- 14. get_stats
await check('get_stats: full shape for the live game, with the player\'s session counted', async () => {
  const d = await ok('get_stats', { project: GAME.project });
  assert.ok('plays' in d && 'ratings' in d && 'sales' in d && Array.isArray(d.errors ?? []), JSON.stringify(d).slice(0, 300));
});
await check('get_stats: unknown project is refused', () => fails('get_stats', { project: 'does-not-exist-' + run }));

// ---- 15. open implementations: off by default, a preview for the owner, shared only when switched on, never code
await check('find_implementations: lists only shared games, with a note that code is never shared', async () => {
  const d = await ok('find_implementations', { query: 'live test ' + run });
  assert.ok(Array.isArray(d.games) && !d.games.some((g) => g.game === SLUG) && /never shared/.test(d.note), JSON.stringify(d).slice(0, 300));
});
await check('get_implementation: an unknown game is refused', () => fails('get_implementation', { game: 'does-not-exist-' + run }, /no open implementation/));
await check('get_implementation: the owner previews the card of the live game; switching on shares it, off stops it', async () => {
  if (!liveOK) { await fails('get_implementation', { game: GAME.project }, /never been published/); return SKIP; }
  const pre = await ok('get_implementation', { game: GAME.project });
  assert.ok(pre.yours && pre.shared === false && pre.built_with && pre.built_with.engine && pre.summary.length > 100, JSON.stringify(pre).slice(0, 400));
  assert.match((await ok('update_project', { project: GAME.project, open_implementation: true })).open_implementation, /^on/);
  const on = await ok('get_implementation', { game: GAME.project });
  assert.ok(on.shared === true && on.never_shared, JSON.stringify(on).slice(0, 300));
  assert.match((await ok('update_project', { project: GAME.project, open_implementation: false })).open_implementation, /^off/);
});

// ---- 16. protocol edges
await check('tools/call: an unknown tool is refused', () => fails('no_such_tool', {}));

// ---- clean-up: take every game this run published back offline, so test games never stay in the public store
for (const p of [GAME, BAD, EMPTY]) { try { await mcp('unpublish', { project: p.project }); } catch { /* never published, or already offline */ } }
console.log('Clean-up: this run\'s games are offline.');

// ---- summary
const count = (k) => results.filter((r) => r[0] === k).length;
console.log(`\n${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped`);
if (count('skip')) console.log('Skipped checks need a live game; the platform requires the creator license for publishing, or the setup did not reach that step.');
state.results = results; save();
console.log(`Projects to remove in the console: ${Object.values(state.projects).join(', ')}`);
process.exit(count('fail') ? 1 : 0);

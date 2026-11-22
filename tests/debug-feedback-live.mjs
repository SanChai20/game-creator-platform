// Live test of agent debugging (debug_preview) and the creator feedback queue (creator_feedback and the console routes),
// against a running platform: locally `wrangler dev` with scripts/local-verifier.mjs, or a deployed site.
//   BASE=http://127.0.0.1:8787 node tests/debug-feedback-live.mjs
// Creates a throwaway creator, a second account and a draft project with the blank template.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { signUp } from './live-auth.mjs';

const BASE = process.env.BASE; if (!BASE) throw new Error('Set BASE to the site origin.');
const run = randomBytes(3).toString('hex'), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tplDir = new URL('../web/public/templates/', import.meta.url);
const blankFiles = JSON.parse(readFileSync(new URL('index.json', tplDir), 'utf8')).templates.find((x) => x.name === 'blank').files
  .map((f) => ({ path: f.path, content: readFileSync(new URL(`blank/${f.path}`, tplDir), 'utf8') }));

function client() {
  const jar = new Map();
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { ...(body && !extra.raw ? { 'content-type': 'application/json' } : {}), origin: BASE, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(extra.headers || {}) }, body: extra.raw ? body : body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b, x) => call('POST', p, b, x), del: (p) => call('DELETE', p) };
}
const must = (r, code = 200) => { assert.equal(r.status, code, `expected ${code}, got ${r.status}: ${r.text.slice(0, 300)}`); return r.json; };
const form = { raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } };

// ---- a creator who connects over OAuth like an agent
const creator = client();
await signUp(BASE, (p, b, h) => creator.post(p, b, { headers: h }), `mcp-live-${run}@example.com`, 'MCP live ' + run);
const reg = must(await creator.post('/oauth/register', { client_name: 'MCP live test', redirect_uris: ['http://127.0.0.1:9999/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }), 201);
const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9999/cb', scope: 'games', state: 's', code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp` });
const consent = await creator.get('/authorize?' + q); assert.equal(consent.status, 200, consent.text.slice(0, 300));
const handle = consent.text.match(/name="handle" value="([^"]+)"/)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
const approve = await creator.post('/authorize?' + q, new URLSearchParams({ handle, decision: 'approve' }).toString(), form); assert.equal(approve.status, 302, approve.text.slice(0, 300));
const tok = must(await creator.post('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: new URL(approve.headers.get('location')).searchParams.get('code'), redirect_uri: 'http://127.0.0.1:9999/cb', client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }).toString(), form));


// ---- MCP helpers. mcp() never throws on a tool error: tests check both outcomes.
let rpcId = 0;
async function mcp(name, args = {}) {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  assert.equal(r.status, 200, `${name}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) return { rpcError: j.error, text: j.error.message };
  const text = j.result.content[0].text; let data = text; try { data = JSON.parse(text); } catch { /* plain text */ }
  return { isError: !!j.result.isError, data, text, images: j.result.content.filter((x) => x.type === 'image') };
}

const ok = async (name, args) => { const r = await mcp(name, args); assert.ok(!r.rpcError && !r.isError, `${name} failed: ${r.text}`); return r; };
const fails = async (name, args, re) => { const r = await mcp(name, args); assert.ok(r.rpcError || r.isError, `${name} should fail but returned: ${String(r.text).slice(0, 200)}`); if (re) assert.match(r.text, re); return r.text; };
const step = (m) => console.log('  ✓ ' + m);

// ---- a preview to debug
const { data: proj } = await ok('create_project', { title: 'Debug live ' + run });
const pid = proj.project?.id || proj.id || proj.project;
await ok('upload_files', { project: pid, files: blankFiles });
let { data: dep } = await ok('deploy_preview', { project: pid, note: 'debug test' });
for (let i = 0; i < 20 && dep.not_finished; i++) { await sleep(3000); dep = (await ok('list_versions', { project: pid, version: dep.version })).data; }
assert.equal(dep.status, 'verified', JSON.stringify(dep).slice(0, 400));
step(`preview v${dep.version} verified`);

// ---- debug_preview
const tools = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }) }).then((r) => r.json());
assert.ok(tools.result.tools.some((t) => t.name === 'debug_preview') && tools.result.tools.some((t) => t.name === 'creator_feedback'));
const gs = (await ok('get_started')).data;
assert.match(gs.debugging.creator_feedback, /creator_feedback/);
await fails('debug_preview', { project: pid, action: 'act', steps: [{ do: 'wait', ms: 1 }] }, /No open debug session/);
const open = await ok('debug_preview', { project: pid, action: 'open', viewport: 'phone-landscape' });
assert.equal(open.images.length, 1); assert.equal(open.images[0].mimeType, 'image/jpeg');
assert.ok(Buffer.from(open.images[0].data, 'base64').length > 1000);
assert.match(open.data.opened, /GCP.ready/); assert.equal(open.data.state.ready, true); assert.match(open.data.viewport, /844 × 390 \(touch\)/);
step('open: a screenshot and the game state');
const act = await ok('debug_preview', { project: pid, action: 'act', steps: [
  { do: 'tap', x: 400, y: 200 }, { do: 'key', key: 'ArrowRight', hold_ms: 300 }, { do: 'screenshot', label: 'mid' }, { do: 'eval', js: 'document.title' }, { do: 'wait_for', until: 'frames', frames: 3 },
] });
assert.equal(act.images.length, 2); assert.ok(act.data.steps.every((s) => s.ok), JSON.stringify(act.data.steps));
assert.deepEqual(act.data.screenshots, ['image 1: mid', 'image 2: now']);
step('act: taps, keys, eval and two screenshots');
await fails('debug_preview', { project: pid, action: 'act', steps: [{ do: 'click', x: 5000, y: 1 }] }, /outside/);
await fails('debug_preview', { project: pid, action: 'act', steps: [{ do: 'goto', url: 'https://example.com' }] }, /needs "do"/);
const shot = await ok('debug_preview', { project: pid, action: 'screenshot' });
assert.equal(shot.images.length, 1);
step('bad steps refused before the browser; screenshot');

// another account cannot debug or read this game
const other = client();
await signUp(BASE, (p, b, h) => other.post(p, b, { headers: h }), `debug-other-${run}@example.com`, 'Other ' + run);
const reg2 = must(await other.post('/oauth/register', { client_name: 'Other agent', redirect_uris: ['http://127.0.0.1:9999/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }), 201);
const v2 = randomBytes(32).toString('base64url'), q2 = new URLSearchParams({ response_type: 'code', client_id: reg2.client_id, redirect_uri: 'http://127.0.0.1:9999/cb', scope: 'games', state: 's', code_challenge: createHash('sha256').update(v2).digest('base64url'), code_challenge_method: 'S256', resource: `${BASE}/mcp` });
const c2 = await other.get('/authorize?' + q2), h2 = c2.text.match(/name="handle" value="([^"]+)"/)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
const a2 = await other.post('/authorize?' + q2, new URLSearchParams({ handle: h2, decision: 'approve' }).toString(), form);
const tok2 = must(await other.post('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: new URL(a2.headers.get('location')).searchParams.get('code'), redirect_uri: 'http://127.0.0.1:9999/cb', client_id: reg2.client_id, code_verifier: v2, resource: `${BASE}/mcp` }).toString(), form));
const mcp2 = (name, args) => fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok2.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }).then((r) => r.json());
for (const [name, args] of [['debug_preview', { project: pid, action: 'open' }], ['creator_feedback', { project: pid }]]) {
  const r = await mcp2(name, args); assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /belongs to someone else|Only the game/);
}
assert.equal((await other.get(`/api/console/projects/${pid}/feedback`)).status, 403);
step('another account can neither debug the preview nor see its feedback');
assert.equal((await ok('debug_preview', { project: pid, action: 'close' })).data.closed, true);
await fails('debug_preview', { project: pid, action: 'screenshot' }, /No open debug session/);
step('close');

// ---- the feedback queue, filled from the console the way the editor does
const jpg = open.images[0].data;   // the debug screenshot stands in for the console's capture
const empty = (await ok('creator_feedback', { project: pid })).data; assert.equal(empty.taken, 0); assert.match(empty.next, /Nothing waiting/);
const add = (note, extra = {}) => creator.post(`/api/console/projects/${pid}/feedback`, { image: 'data:image/jpeg;base64,' + jpg, note, version: dep.version, marks: [{ type: 'circle', x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: 'this button' }, { type: 'arrow', x1: 0.9, y1: 0.9, x2: 0.5, y2: 0.5 }], context: { method: 'game', viewport: { width: 844, height: 390 }, frames: 10, state: '{"level":1}', url: 'https://x/?gcp_t=SECRET' }, ...extra });
must(await add('The jump button is too small'));
must(await add('Second note'));
assert.equal((await creator.post(`/api/console/projects/${pid}/feedback`, { image: 'data:image/jpeg;base64,' + Buffer.from('<html>').toString('base64'), note: 'x' })).status, 400);
assert.equal((await creator.post(`/api/console/projects/${pid}/feedback`, { image: 'data:image/jpeg;base64,' + jpg })).status, 400);   // nothing said
assert.equal((await other.post(`/api/console/projects/${pid}/feedback`, { image: 'data:image/jpeg;base64,' + jpg, note: 'x' })).status, 403);
const list = must(await creator.get(`/api/console/projects/${pid}/feedback`));
assert.equal(list.items.length, 2); assert.equal(JSON.stringify(list).includes('SECRET'), false);
const img = await fetch(`${BASE}/api/console/projects/${pid}/feedback/${list.items[0].id}/image`, { headers: { cookie: '' } });
assert.equal(img.status, 401);
step('console: two items added; bad pictures, empty items and other accounts refused');
const hint = (await ok('list_versions', { project: pid, version: dep.version })).data;
assert.match(hint.creator_feedback, /2 feedback items/);
const peek = (await ok('creator_feedback', { project: pid, peek: true })).data;
assert.equal(peek.waiting, 2); assert.equal(peek.items[0].note, 'The jump button is too small');
const read = await ok('creator_feedback', { project: pid, limit: 1 });
assert.equal(read.data.taken, 1); assert.equal(read.data.still_waiting, 1); assert.equal(read.images.length, 1);
assert.match(read.data.items[0].marks[0], /^1\. circle around \(\d+, \d+\).*"this button"/);
assert.equal(read.data.items[0].game_state, '{"level":1}');
const again = await ok('creator_feedback', { project: pid, limit: 5 });
assert.equal(again.data.taken, 1); assert.equal(again.data.items[0].note, 'Second note');
assert.equal((await ok('creator_feedback', { project: pid })).data.taken, 0);
// the marks also say where they are in the game, and read items can be read again (an answer that never arrived)
assert.match(read.data.items[0].marks[0], /\[game \(169, 78\)\]/);
const recent = await ok('creator_feedback', { project: pid, recent: true });
assert.equal(recent.data.read_again, 2); assert.equal(recent.images.length, 2); assert.equal(recent.data.items[0].note, 'Second note');
assert.equal((await ok('creator_feedback', { project: pid })).data.taken, 0);
assert.equal(must(await creator.get(`/api/console/projects/${pid}/feedback`)).items.length, 0);
step('creator_feedback: hint in list_versions, peek, read once with the picture, never twice, read again with recent');
const third = must(await add('Remove me'));
must(await creator.del(`/api/console/projects/${pid}/feedback/${third.id}`));
assert.equal(must(await creator.get(`/api/console/projects/${pid}/feedback`)).items.length, 0);
step('the creator removes an item by hand');

// ---- pictures of the creator's own beside the screenshot, each with its marks, read together with their item
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// a large photo-sized JPEG: the debug screenshot's bytes padded after its end, as a camera's extra data would be
const big = (n) => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from(jpg, 'base64'), randomBytes(n)]).toString('base64');
const withPics = must(await add('Make the menu look like my mockup', { attachments: [
  { image: 'data:image/png;base64,' + PNG1, name: 'menu-mockup.png', marks: [{ type: 'box', x: 0.2, y: 0.2, w: 0.6, h: 0.3, label: 'this panel' }] },
  { image: big(1_300_000), name: 'C:\\fakepath\\photo.jpg' },
] }));
// over the item's total: refused by its pictures' bytes (400), or before reading the body when it is far over (413)
const over = await creator.post(`/api/console/projects/${pid}/feedback`, { image: big(1_050_000), note: 'too much', attachments: [{ image: big(1_050_000) }, { image: big(1_050_000) }] });
assert.equal(over.status, 400); assert.match(over.json.error, /add up to/);
assert.equal((await creator.post(`/api/console/projects/${pid}/feedback`, { image: big(1_400_000), note: 'far too much', attachments: [{ image: big(1_400_000) }, { image: big(1_400_000) }] })).status, 413);
assert.equal((await creator.post(`/api/console/projects/${pid}/feedback`, { image: 'data:image/jpeg;base64,' + jpg, note: 'svg', attachments: [{ image: 'data:image/png;base64,' + Buffer.from('<svg/>' + 'x'.repeat(40)).toString('base64') }] })).status, 400);
assert.equal((await creator.post(`/api/console/projects/${pid}/feedback`, { image: 'data:image/jpeg;base64,' + jpg, note: 'five', attachments: Array.from({ length: 5 }, () => ({ image: 'data:image/png;base64,' + PNG1 })) })).status, 400);
const listed = must(await creator.get(`/api/console/projects/${pid}/feedback`)).items;
assert.equal(listed.length, 1); assert.equal(listed[0].id, withPics.id);
assert.deepEqual(listed[0].attachments.map((x) => x.name), ['menu-mockup.png', 'photo.jpg']);
const pic2 = await creator.get(`/api/console/projects/${pid}/feedback/${withPics.id}/image?n=2`);
assert.equal(pic2.status, 200); assert.equal(pic2.headers.get('content-type'), 'image/jpeg');
assert.equal((await creator.get(`/api/console/projects/${pid}/feedback/${withPics.id}/image?n=1`)).headers.get('content-type'), 'image/png');
assert.equal((await creator.get(`/api/console/projects/${pid}/feedback/${withPics.id}/image?n=3`)).status, 404);
step('console: an item with two pictures of the creator\'s own; too large together, not a picture, or too many refused');
must(await add('Next item waits for its own answer', { attachments: [{ image: big(1_200_000) }, { image: big(1_000_000) }] }));
const both = await ok('creator_feedback', { project: pid, limit: 5 });
assert.equal(both.data.taken, 1); assert.equal(both.data.still_waiting, 1);   // the second would make the answer too large
assert.equal(both.images.length, 3); assert.deepEqual(both.images.map((x) => x.mimeType), ['image/jpeg', 'image/png', 'image/jpeg']);
const [it] = both.data.items;
assert.match(it.picture, /image 1\b/); assert.equal(it.attached_pictures.length, 2);
assert.equal(it.attached_pictures[0].file, 'menu-mockup.png'); assert.match(it.attached_pictures[0].picture, /image 2\b/);
assert.match(it.attached_pictures[0].marks[0], /^1\. box .*"this panel"$/); assert.match(it.attached_pictures[1].picture, /image 3\b/);
const rest = await ok('creator_feedback', { project: pid });
assert.equal(rest.data.taken, 1); assert.equal(rest.images.length, 3);
step('creator_feedback: an item\'s attached pictures come right after its screenshot, numbered, in one answer');
console.log(`OK (project ${pid})`);

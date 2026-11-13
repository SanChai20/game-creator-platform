// End-to-end test against a running dev server (npm run dev + scripts/local-verifier.mjs).
// Walks the whole product: accounts, OAuth, MCP authoring, static checks, deploy, browser verification,
// publish, play counting, reviews, paid games through a mock Stripe, earnings, withdrawal, rooms.
//   node tests/e2e.mjs            (expects http://127.0.0.1:8787)
import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const run = randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2)} ${msg}`);

// ----- mock Stripe -------------------------------------------------------------------------------
const stripeCalls = [], sessions = new Map();
const mock = createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const p = Object.fromEntries(new URLSearchParams(body)), url = new URL(req.url, 'http://x');
  stripeCalls.push({ method: req.method, path: url.pathname, p });
  const send = (j) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
    const id = 'cs_test_' + randomBytes(6).toString('hex');
    const s = { id, url: `https://checkout.stripe.test/${id}`, payment_status: 'paid', payment_intent: 'pi_' + id, client_reference_id: p.client_reference_id, amount_total: Number(p['line_items[0][price_data][unit_amount]']),
      metadata: Object.fromEntries(Object.entries(p).filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v])) };
    sessions.set(id, s); return send(s);
  }
  if (req.method === 'GET' && url.pathname.startsWith('/v1/checkout/sessions/')) return send(sessions.get(url.pathname.split('/').pop()));
  if (url.pathname === '/v1/accounts') return send({ id: 'acct_test1' });
  if (url.pathname === '/v1/accounts/acct_test1') return send({ id: 'acct_test1', payouts_enabled: true, capabilities: { transfers: 'active' } });
  if (url.pathname === '/v1/account_links') return send({ url: 'https://connect.stripe.test/onboard' });
  if (url.pathname === '/v1/transfers') return send({ id: 'tr_test1', amount: Number(p.amount) });
  if (url.pathname === '/v1/refunds') return send({ id: 're_test1' });
  res.writeHead(404); res.end('{}');
}).listen(8798, '127.0.0.1');

// ----- http helpers ------------------------------------------------------------------------------
function client() {
  const jar = new Map();
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { ...(body && !extra.raw ? { 'content-type': 'application/json' } : {}), origin: BASE, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(extra.headers || {}) }, body: extra.raw ? body : body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b, x) => call('POST', p, b, x), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}
const must = (r, code = 200) => { assert.equal(r.status, code, `expected ${code}, got ${r.status}: ${r.text.slice(0, 300)}`); return r.json; };

async function main() {
  console.log(`E2E against ${BASE}`);
  const A = client(), B = client();
  // accounts
  must(await A.post('/api/auth/signup', { email: `creator-${run}@example.com`, name: 'Creator ' + run, password: 'correct horse' }));
  must(await B.post('/api/auth/signup', { email: `player-${run}@example.com`, name: 'Player ' + run, password: 'correct horse' }));
  assert.equal((await A.post('/api/auth/login', { email: `creator-${run}@example.com`, password: 'nope' })).status, 401);
  ok('sign up, wrong password refused');
  const claim = await A.post('/api/claim-admin', { token: 'dev-claim' });
  const isAdmin = claim.status === 200;
  assert.ok(isAdmin || claim.status === 403);
  let ADM = A;
  if (!isAdmin) { // an admin exists from an earlier run: reuse it
    ADM = client(); const l = await ADM.post('/api/auth/login', { email: process.env.ADMIN_EMAIL || 'admin@example.com', password: 'correct horse' });
    assert.equal(l.status, 200, 'an admin from an earlier run exists; start from a clean local database (rm -rf .wrangler/state) or set ADMIN_EMAIL');
  }
  assert.equal((await B.get('/api/admin/overview')).status, 403);
  must(await ADM.put('/api/admin/settings', { play_min_seconds: 2, verify_human_min_seconds: 2, earnings_hold_days: 0, withdraw_min_cents: 300 }));
  ok('first admin claimed; non-admin blocked; settings changed');

  // OAuth: dynamic registration + PKCE authorization code
  const reg = must(await A.post('/oauth/register', { client_name: 'E2E Agent', redirect_uris: ['http://127.0.0.1:9999/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }), 201);
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9999/cb', scope: 'games', state: 'xyz', code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp` });
  const anon = await client().get('/authorize?' + q);
  assert.equal(anon.status, 302); assert.match(anon.headers.get('location'), /^\/login\?next=/);
  const consent = await A.get('/authorize?' + q);
  assert.equal(consent.status, 200, consent.text.slice(0, 300)); assert.match(consent.text, /E2E Agent/);
  const handle = consent.text.match(/name="handle" value="([^"]+)"/)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
  const approve = await A.post('/authorize?' + q, new URLSearchParams({ handle, decision: 'approve' }).toString(), { raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(approve.status, 302, approve.text.slice(0, 300));
  const code = new URL(approve.headers.get('location')).searchParams.get('code');
  const tok = must(await A.post('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:9999/cb', client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }).toString(), { raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } }));
  assert.ok(tok.access_token && tok.refresh_token && tok.expires_in <= 3600);
  ok(`OAuth: register, consent, code + PKCE, token (expires in ${tok.expires_in}s, refresh token issued)`);

  let rpcId = 0;
  const rpc = async (method, params) => {
    const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    assert.equal(r.status, 200, `${method} -> ${r.status}`);
    const j = await r.json(); assert.ok(!j.error, JSON.stringify(j.error)); return j.result;
  };
  const tool = async (name, args = {}, expectError = false) => {
    const r = await rpc('tools/call', { name, arguments: args });
    assert.equal(!!r.isError, expectError, `${name}: ${r.content[0].text.slice(0, 600)}`);
    try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; }
  };
  assert.equal((await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: '{}' })).status, 401);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  assert.equal(init.protocolVersion, '2025-06-18');
  const tools = (await rpc('tools/list')).tools;
  assert.ok(tools.length >= 20 && tools.every((t) => t.description.length > 40 && t.inputSchema.type === 'object'));
  const started = await tool('get_started');
  assert.ok(started.workflow.length >= 5 && started.templates.length === 4 && started.what_to_read.always.length === 1 && started.kits.length === 10 && started.quality.target && started.building_blocks.tools.length === 3);
  const rec = await tool('recommend_pipeline', { description: 'An open world survival game on an island with torches at night', dynamic_lights: 3 });
  assert.match(rec.pipeline, /three-forward/);
  assert.equal((await tool('recommend_pipeline', { description: 'a top-down pixel puzzle' })).pipeline, 'canvas2d');
  ok(`MCP: initialize, ${tools.length} tools, get_started, recommend_pipeline; bad token gets 401`);

  // authoring help is readable
  const guides = (await tool('list_guides')).guides;
  if (guides.length) { const g = await tool('get_guide', { topic: guides[0].topic }); assert.ok(g.markdown.length > 500); }
  assert.ok((await tool('get_kit_file', { file: 'three-kit.js' })).source.includes('mergeParts'));
  assert.ok((await tool('get_kit_file', { file: 'craft/props.js' })).source.includes('campfire') && (await tool('get_kit_file', { file: 'procgen/noise.js' })).source.includes('export function pcg'));
  assert.equal((await rpc('tools/call', { name: 'get_kit_file', arguments: { file: '../sdk/gcp.js' } })).isError, true);
  for (const topic of ['building-blocks', 'procedural-generation']) { const g = await tool('get_guide', { topic }); assert.ok(g.markdown.length > 3000 && !g.markdown.includes('{{'), topic); }
  ok(`${guides.length} guides and kit sources readable`);

  // building blocks: the catalog, one block in full, and the scene planner
  const blocks = await tool('list_blocks');
  assert.ok(blocks.craft_blocks.length >= 8 && blocks.valid_names.props.includes('campfire') && blocks.valid_names.surfaces.length >= 39 && blocks.valid_names.moods.includes('golden-hour') && blocks.procedural_core.groups.length === 5);
  assert.ok((await tool('list_blocks', { group: 'noise' })).blocks.some((b) => b.name === 'fbm2' && /GLSL/.test(b.doc)));
  const sc = await tool('get_block', { name: 'scatter' });
  assert.ok(/minDistance/.test(sc.doc) && sc.import.includes('@gcp/craft.js') && sc.valid_names.trees.includes('oak'));
  assert.equal((await tool('get_block', { name: 'hud.title' })).name, 'createHud');
  const camp = await tool('get_block', { name: 'campfire' });
  assert.ok(camp.name === 'prop' && /lab\?kind=prop/.test(camp.preview) && camp.as_recipe.params.prop);
  assert.equal((await rpc('tools/call', { name: 'get_block', arguments: { name: 'zzzz-nothing' } })).isError, true);
  const flat = await tool('design_scene', { description: 'a match-3 puzzle with gems' });
  assert.ok(flat.dimension === '2d' && !flat.files);
  const same = await tool('design_scene', { description: 'A knight explores a haunted graveyard at night while ghosts chase him' });
  assert.ok(same.plan.setting === 'haunted' && same.plan.hero.preset === 'knight' && /^survive/.test(same.plan.goal) && same.plan.creatures.hunters.includes('ghost'));
  assert.deepEqual(same.files, (await tool('design_scene', { description: 'A knight explores a haunted graveyard at night while ghosts chase him' })).files);   // no randomness
  const plan = await tool('design_scene', { description: 'a pirate collects doubloons on a tropical island', title: `Planned ${run}`, seed: 'e2e' });
  assert.ok(plan.plan.setting === 'island' && plan.plan.hero.preset === 'pirate' && plan.files['index.html'] && plan.files['src/main.js'].includes("from '@gcp/craft.js'"));
  const planned = await tool('create_project', { title: `Planned ${run}`, tagline: 'Built from blocks' });
  await tool('put_files', { project: planned.project, files: Object.entries(plan.files).map(([path, content]) => ({ path, content })) });
  const pc = await tool('check_project', { project: planned.project });
  assert.equal(pc.ok, true, pc.errors.join('\n'));
  let pd = await tool('deploy_preview', { project: planned.project, note: 'from design_scene' });
  for (let i = 0; i < 60 && ['queued', 'deploying', 'verifying'].includes(pd.status); i++) { await sleep(2000); pd = await tool('get_version', { project: planned.project, version: pd.version }); }
  assert.equal(pd.status, 'verified', JSON.stringify(pd.report, null, 1).slice(0, 2000));
  assert.ok(pd.report.playthrough.steps.length === 5 && pd.quality.craft_score >= pd.quality.target && pd.quality.meets_target && /craft score/.test(pd.next), JSON.stringify(pd.quality));
  // an unedited plan is named as such, with ideas; the advice names a measured value even above the target
  assert.ok(pd.quality.own_work.still_the_plan && pd.quality.own_work.unchanged === pd.quality.own_work.planned_lines && pd.quality.own_work.ideas.length && /own_work/.test(pd.next) && !/Tell the user/.test(pd.next), JSON.stringify(pd.quality.own_work));
  assert.ok(Array.isArray(pd.quality.improve) && pd.quality.improve.every((l) => /full marks/.test(l) || /\d/.test(l)), JSON.stringify(pd.quality.improve));
  assert.ok(/refresh_token/.test((await tool('get_started', {})).session));
  ok(`building blocks: catalog, get_block by name, method and value, design_scene is deterministic; its game verified with a ${pd.report.playthrough.steps.length}-step play-through, craft ${pd.quality.craft_score}/100 (${pd.quality.level}), ${pd.report.metrics.fps} fps`);

  // a broken game is caught statically, with a line number and a fix
  const bad = await tool('create_project', { title: `Broken ${run}` });
  await tool('put_files', { project: bad.project, files: [{ path: 'index.html', content: '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><canvas></canvas><script type="module" src="main.js"></script></body></html>' }, { path: 'main.js', content: "import * as THREE from 'three';\nimport { nope } from './missing.js';\nimport x from 'lodash';\nconst a = ;\n" }] });
  let chk = await tool('check_project', { project: bad.project });
  assert.equal(chk.ok, false); assert.ok(chk.errors.some((e) => /syntax error/i.test(e) && /main\.js:4/.test(e)), chk.errors.join('\n'));
  await tool('edit_file', { project: bad.project, path: 'main.js', old_string: 'const a = ;', new_string: 'const a = 1;' });
  chk = await tool('check_project', { project: bad.project });
  assert.ok(chk.errors.some((e) => /missing\.js/.test(e)) && chk.errors.some((e) => /lodash/.test(e)) && chk.errors.some((e) => /GCP\.ready/.test(e)), chk.errors.join('\n'));
  const refused = await tool('deploy_preview', { project: bad.project });
  assert.equal(refused.deployed, false);
  ok('static checks: syntax error with line, missing import, unmapped bare import, missing GCP.ready(); deploy refused');

  // a game that passes static checks but throws at runtime fails browser verification
  await tool('put_files', { project: bad.project, files: [{ path: 'main.js', content: "const c = document.querySelector('canvas').getContext('2d');\nfunction frame(t){ c.fillStyle = 'hsl(' + (t / 10 % 360) + ' 70% 50%)'; c.fillRect(0, 0, 300, 150); c.fillStyle='#fff'; c.fillRect(20,20,40,40); requestAnimationFrame(frame); }\nrequestAnimationFrame(frame);\nGCP.ready();\nsetTimeout(() => { undefinedFunctionCall(); }, 300);\n" }] });
  let dep = await tool('deploy_preview', { project: bad.project, note: 'throws' });
  for (let i = 0; i < 30 && ['queued', 'deploying', 'verifying'].includes(dep.status); i++) { await sleep(2000); dep = await tool('get_version', { project: bad.project, version: dep.version }); }
  assert.equal(dep.status, 'failed', JSON.stringify(dep).slice(0, 800)); assert.equal(dep.can_publish, false);
  assert.ok(dep.report.errors.some((e) => /undefinedFunctionCall/.test(e)), JSON.stringify(dep.report.errors));
  assert.equal((await rpc('tools/call', { name: 'publish', arguments: { project: bad.project } })).isError, true);
  ok('runtime error caught by the browser check; publish refused');

  // a game that boots and renders but whose rules are broken is caught by its own play-through
  const broken = await tool('create_project', { title: `Broken rules ${run}`, template: 'three-blank' });
  const src = (await tool('read_file', { project: broken.project, path: 'src/main.js' }));
  const text = typeof src === 'string' ? src : src.content;
  assert.ok(text.includes("score++; hud.textContent = 'Beacons: ' + score; placeBeacon();"));
  await tool('put_files', { project: broken.project, files: [{ path: 'src/main.js', content: text.replace("score++; hud.textContent = 'Beacons: ' + score; placeBeacon();", "score++; placeBeacon();") }] });   // the HUD never updates
  let bd = await tool('deploy_preview', { project: broken.project, note: 'hud bug' });
  for (let i = 0; i < 40 && ['queued', 'deploying', 'verifying'].includes(bd.status); i++) { await sleep(2000); bd = await tool('get_version', { project: broken.project, version: bd.version }); }
  assert.equal(bd.status, 'failed', JSON.stringify(bd.report, null, 1).slice(0, 1500));
  const bp = bd.report.checks.find((c) => c.id === 'playthrough');
  assert.ok(bp && !bp.ok && /HUD says "Beacons: 0"/.test(bp.detail) && /during step 3/.test(bp.detail), JSON.stringify(bp));
  assert.ok(bd.report.checks.filter((c) => !c.ok).length === 1);                 // everything else about it is fine
  ok('broken game rules caught by the play-through: boots and renders, but the failed step is named and publish is blocked');

  // every template deploys and verifies
  const projects = {};
  for (const t of ['blank', 'three-blank', 'canvas2d-arcade', 'three-explorer']) {
    const p = await tool('create_project', { title: `${t} ${run}`, template: t, tagline: 'An e2e game', tags: ['test', t] });
    const c = await tool('check_project', { project: p.project });
    assert.equal(c.ok, true, c.errors.join('\n'));
    let d = await tool('deploy_preview', { project: p.project, note: 'first' });
    for (let i = 0; i < 40 && ['queued', 'deploying', 'verifying'].includes(d.status); i++) { await sleep(2000); d = await tool('get_version', { project: p.project, version: d.version }); }
    assert.equal(d.status, 'verified', `${t}: ${JSON.stringify(d.report, null, 1).slice(0, 1500)}`);
    assert.ok(d.screenshot && d.can_publish);
    const play = d.report.checks.find((c) => c.id === 'playthrough');
    if (t === 'blank') { assert.ok(!play && d.report.playthrough === null && /no play-through/.test(d.report.summary) && d.report.notes.length === 1); }
    else { assert.ok(play && play.ok && d.report.playthrough.steps.length >= 3, `${t}: ${JSON.stringify(play)}`); assert.match(d.report.summary, /play-through of \d+ step/); }
    projects[t] = p.project;
    ok(`template ${t}: checks clean, deployed, verified (${d.report.metrics.loadMs} ms load, ${d.report.metrics.fps} fps, ${d.report.metrics.colors} colours, ${play ? `play-through of ${d.report.playthrough.steps.length} steps in ${(d.report.playthrough.ms / 1000).toFixed(1)} s` : 'no play-through'})`);
  }
  const pid = projects['three-explorer'];

  // upload URL (curl path): single file and zip
  const up = await tool('create_upload_url', { project: projects.blank });
  const upUrl = up.one_file.match(/"(http[^"?]+)\?path/)[1];
  assert.equal((await fetch(`${upUrl}?path=notes.txt`, { method: 'PUT', body: 'hello' })).status, 200);
  const zip = zipSync({ 'game/index.html': strToU8('<!doctype html><meta name="viewport" content="width=device-width"><canvas></canvas><script>requestAnimationFrame(function f(){requestAnimationFrame(f)});GCP.ready()</script>'), 'game/data/level.json': strToU8('{"a":1}') });
  const z = await (await fetch(`${upUrl}/zip?clean=1`, { method: 'POST', body: zip })).json();
  assert.deepEqual(z.written.sort(), ['data/level.json', 'index.html']); assert.ok(z.removed.includes('notes.txt'));
  assert.equal((await fetch(`${BASE}/api/upload/bogus?path=a.txt`, { method: 'PUT', body: 'x' })).status, 401);
  ok('direct upload: single file, zip with folder stripping and clean, bad token refused');

  // publish needs the license (A is admin => creator). Check the gate with a fresh non-creator through the console API later.
  const pub = await tool('publish', { project: pid });
  assert.equal(pub.live, true, JSON.stringify(pub));
  await tool('update_project', { project: pid, description: 'Find every shard on a procedurally generated island.', controls: 'WASD, drag, Space' });
  const list = must(await B.get('/api/games'));
  assert.ok(list.games.some((g) => g.id === pid && g.cover));
  const slug = list.games.find((g) => g.id === pid).slug;
  ok('published; visible in the marketplace with a cover');

  // play: login required, session token, document gated, play time counted, review gated on play
  assert.equal((await client().post(`/api/games/${slug}/play`)).status, 401);
  const play = must(await B.post(`/api/games/${slug}/play`));
  const doc = await fetch(play.url);
  assert.equal(doc.status, 200); const html = await doc.text(); assert.ok(html.includes('/sdk/gcp.js') && html.includes('importmap'));
  assert.equal((await fetch(play.url.split('?')[0])).status, 401);
  const t = new URL(play.url).searchParams.get('gcp_t');
  assert.equal((await B.post(`/api/games/${slug}/reviews`, { rating: 5, body: 'too early' })).status, 403);
  const beat = (body) => fetch(`${BASE}/api/rt/beat`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ t, ...body }) }).then((r) => r.json());
  await beat({ frames: 10, active: false, first: true });
  await sleep(2600);
  const b2 = await beat({ frames: 200, active: true, errors: ['TypeError: demo error'] });
  assert.ok(b2.seconds >= 2);
  must(await B.post(`/api/games/${slug}/reviews`, { rating: 4, body: 'Lovely island.' }));
  must(await B.post(`/api/games/${slug}/reviews`, { rating: 5, body: 'Lovely island, even better.' }));
  const detail = must(await B.get(`/api/games/${slug}`));
  assert.equal(detail.game.plays, 1); assert.equal(detail.game.rating, 5); assert.equal(detail.game.rating_count, 1); assert.equal(detail.played, true);
  assert.equal((await A.post(`/api/games/${slug}/reviews`, { rating: 5 })).status, 403);
  ok('play session: login required, document gated by token, play counted after the minimum, review updates rating, own-game review refused');

  // game services: saves, leaderboard, room
  const svc = (path, body) => fetch(`${BASE}/api/rt/${path}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ t, ...body }) }).then((r) => r.json());
  await svc('save', { op: 'set', key: 'slot1', value: { level: 3 } });
  assert.deepEqual((await svc('save', { op: 'get', key: 'slot1' })).value, { level: 3 });
  await svc('score', { op: 'submit', board: 'time', score: 42.5, order: 'asc' }); await svc('score', { op: 'submit', board: 'time', score: 50, order: 'asc' });
  assert.equal((await svc('score', { op: 'top', board: 'time', order: 'asc' })).rows[0].score, 42.5);
  const play2 = must(await A.post(`/api/games/${slug}/play`)), t2 = new URL(play2.url).searchParams.get('gcp_t');
  const wsUrl = (tk) => `${BASE.replace('http', 'ws')}/api/rt/room?room=test&t=${tk}`;
  const got = { a: [], b: [] };
  const wa = new WebSocket(wsUrl(t)); wa.onmessage = (e) => got.a.push(JSON.parse(e.data));
  await sleep(500);
  const wb = new WebSocket(wsUrl(t2)); wb.onmessage = (e) => got.b.push(JSON.parse(e.data));
  await sleep(600);
  wb.send(JSON.stringify({ t: 'msg', d: { hi: 1 } })); wa.send(JSON.stringify({ t: 'state', d: { round: 2 } }));
  await sleep(500);
  assert.equal(got.a[0].t, 'welcome'); assert.equal(got.a[0].host, got.a[0].id); assert.ok(got.a.some((m) => m.t === 'join')); assert.ok(got.a.some((m) => m.t === 'msg' && m.d.hi === 1));
  assert.equal(got.b[0].host, got.a[0].id); assert.ok(got.b.some((m) => m.t === 'state' && m.d.round === 2));
  wa.close(); await sleep(500);
  assert.ok(got.b.some((m) => m.t === 'leave' && m.host === got.b[0].id));
  wb.close();
  ok('game services: cloud save, leaderboard keeps best, room relay with host and host migration');

  // paid game: purchase required, checkout, webhook, split, refund path
  const priced = await tool('update_project', { project: pid, price_cents: 499 });
  assert.equal(priced.creator_receives_per_sale, '$4.49');
  await tool('update_project', { project: pid, price_cents: 50 }, true);
  assert.equal((await B.post(`/api/games/${slug}/play`)).status, 402);
  const buy = must(await B.post(`/api/games/${slug}/buy`));
  const sid = buy.url.split('/').pop(), session = sessions.get(sid);
  assert.equal(session.amount_total, 499);
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: session } }), ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', 'whsec_local').update(`${ts}.${payload}`).digest('hex');
  assert.equal((await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': `t=${ts},v1=deadbeef` }, body: payload })).status, 400);
  assert.equal((await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': `t=${ts},v1=${sig}` }, body: payload })).status, 200);
  assert.equal((await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': `t=${ts},v1=${sig}` }, body: payload })).status, 200); // replay is harmless
  must(await B.post('/api/billing/confirm', { session_id: sid }));
  assert.equal(must(await B.get(`/api/games/${slug}`)).owned, true);
  must(await B.post(`/api/games/${slug}/play`));
  let earn = must(await A.get('/api/console/earnings'));
  assert.equal(earn.balance.available, 449); assert.equal(earn.by_game[0].n, 1); assert.equal(earn.by_game[0].fees, 50);
  ok('paid game: play blocked, checkout for $4.99, signed webhook (bad signature refused, replay harmless), creator credited $4.49, platform keeps $0.50');

  // withdrawal through Stripe Connect
  assert.equal((await A.post('/api/billing/withdraw', { method: 'stripe' })).status, 400); // no payout account yet
  must(await A.post('/api/billing/payout-account', { country: 'US' }));
  assert.equal(must(await A.post('/api/billing/payout-account/refresh')).payouts_enabled, true);
  const wd = must(await A.post('/api/billing/withdraw', { method: 'stripe' }));
  assert.equal(wd.amount_cents, 449);
  const tr = stripeCalls.find((c) => c.path === '/v1/transfers');
  assert.equal(tr.p.amount, '449'); assert.equal(tr.p.destination, 'acct_test1');
  earn = must(await A.get('/api/console/earnings'));
  assert.equal(earn.balance.available, 0); assert.equal(earn.withdrawals[0].status, 'paid');
  assert.equal((await A.post('/api/billing/withdraw', { method: 'stripe' })).status, 400); // nothing left
  ok('withdrawal: payout account onboarding, transfer of the full available balance, balance back to zero, second attempt refused');

  // refund takes the credit back and revokes access
  const money = must(await ADM.get('/api/admin/money'));
  must(await ADM.post(`/api/admin/purchases/${money.purchases[0].id}/refund`));
  assert.equal(must(await B.get(`/api/games/${slug}`)).owned, false);
  assert.equal(must(await A.get('/api/console/earnings')).balance.total, -449);
  ok('refund: access revoked, creator credit reversed');

  // versions: a second version, rollback, unpublish, console views, admin views
  await tool('edit_file', { project: pid, path: 'index.html', old_string: '<title>Shard Island</title>', new_string: '<title>Shard Island II</title>' });
  let d2 = await tool('deploy_preview', { project: pid, note: 'second' });
  for (let i = 0; i < 40 && ['queued', 'deploying', 'verifying'].includes(d2.status); i++) { await sleep(2000); d2 = await tool('get_version', { project: pid, version: d2.version }); }
  assert.equal(d2.status, 'verified'); assert.equal(d2.version, 2);
  assert.equal((await tool('publish', { project: pid })).version, 2);
  assert.equal((await tool('rollback', { project: pid, version: 1 })).version, 1);
  const vs = await tool('list_versions', { project: pid });
  assert.equal(vs.live_version, 1); assert.equal(vs.versions.length, 2);
  const stats = await tool('get_stats', { project: pid });
  assert.equal(stats.plays, 1); assert.ok(stats.runtime_errors.some((e) => /demo error/.test(e.message)));
  const con = must(await A.get(`/api/console/projects/${pid}`));
  assert.equal(con.versions.length, 2); assert.ok(con.events.length >= 6); assert.ok(con.daily.length >= 1);
  const prev = must(await A.post(`/api/console/projects/${pid}/preview`));
  assert.equal((await fetch(prev.url)).status, 200);
  assert.equal((await B.post(`/api/console/projects/${pid}/preview`)).status, 403);
  await tool('unpublish', { project: pid });
  assert.ok(!must(await B.get('/api/games')).games.some((g) => g.id === pid));
  must(await A.post(`/api/console/projects/${pid}/online`));
  for (let i = 0; i < 20 && !must(await B.get('/api/games')).games.some((g) => g.id === pid); i++) await sleep(1000);
  assert.ok(must(await B.get('/api/games')).games.some((g) => g.id === pid));
  ok('versions: v2 verified and published, rollback to v1, stats with real-player errors, owner-only preview, offline and back online');

  const over = must(await ADM.get('/api/admin/overview'));
  assert.ok(over.users.n >= 2 && over.games.n >= 4);
  assert.ok(must(await ADM.get('/api/admin/users')).users.length >= 2); assert.ok(must(await ADM.get('/api/admin/games')).games.length >= 4);
  must(await ADM.patch(`/api/admin/games/${pid}`, { featured: true }));
  must(await ADM.patch(`/api/admin/games/${projects.blank}`, { action: 'remove', reason: 'test' }));
  await tool('get_project', { project: projects.blank }, !isAdmin ? true : false);
  ok('admin: overview, users, games, feature, remove');

  // license gate for a brand-new creator
  const C = client();
  must(await C.post('/api/auth/signup', { email: `new-${run}@example.com`, name: 'Newbie ' + run, password: 'correct horse' }));
  const fee = must(await C.post('/api/billing/creator-fee'));
  const fs = sessions.get(fee.url.split('/').pop());
  assert.equal(fs.amount_total, 3000); assert.equal(fs.metadata.kind, 'creator_fee');
  must(await C.post('/api/billing/confirm', { session_id: fs.id }));
  assert.equal(must(await C.get('/api/me')).user.creator, true);
  ok('creator license: $30 checkout, confirmed, account can publish');

  // device sign-in: an agent with no browser and no token works out how to connect from the 401 alone
  const agent = async (path, form) => { const r = await fetch(BASE + path, { method: 'POST', headers: form ? { 'content-type': 'application/x-www-form-urlencoded' } : { 'content-type': 'application/json' }, body: form ? new URLSearchParams(form).toString() : '{"jsonrpc":"2.0","id":1,"method":"initialize"}' }); return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) }; };
  const noTok = await agent('/mcp');
  assert.equal(noTok.status, 401); assert.match(noTok.headers.get('www-authenticate'), /resource_metadata=/);
  assert.match(noTok.json.how_to_connect.if_you_cannot_open_a_browser[0], /\/oauth\/device/);
  const meta = must(await client().get('/.well-known/oauth-authorization-server'));
  assert.equal(meta.device_authorization_endpoint, `${BASE}/oauth/device`); assert.ok(meta.grant_types_supported.includes('urn:ietf:params:oauth:grant-type:device_code') && meta.grant_types_supported.includes('authorization_code'));
  const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
  const dev = (await agent('/oauth/device', { client_name: 'Headless <b>Agent</b>' })).json;
  assert.match(dev.user_code, /^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/); assert.equal(dev.verification_uri_complete, `${BASE}/device?code=${dev.user_code}`); assert.equal(dev.interval, 5);
  const poll = () => agent('/oauth/token', { grant_type: GRANT, device_code: dev.device_code });
  const p1 = await poll(); assert.equal(p1.status, 400); assert.equal(p1.json.error, 'authorization_pending');
  assert.equal((await poll()).json.error, 'slow_down');
  assert.equal((await agent('/oauth/token', { grant_type: GRANT, device_code: 'made-up' })).json.error, 'expired_token');
  assert.equal((await client().get(`/api/device/${dev.user_code}`)).status, 401);                    // approving needs a signed-in person
  assert.equal((await C.get('/api/device/BBBB-BBBB')).status, 404);
  const seen = must(await C.get(`/api/device/${dev.user_code.replace('-', '').toLowerCase()}`));     // typed sloppily, still found
  assert.equal(seen.client_name, 'Headless bAgent/b'); assert.equal(seen.grant_days, 30);
  must(await C.post(`/api/device/${dev.user_code}`, { decision: 'approve' }));
  assert.equal((await C.post(`/api/device/${dev.user_code}`, { decision: 'approve' })).status, 404);  // a code is decided once
  const dtok = await poll(); assert.equal(dtok.status, 200, JSON.stringify(dtok.json));
  assert.ok(dtok.json.access_token && dtok.json.refresh_token && dtok.json.client_id && dtok.json.expires_in <= 3600 && dtok.json.mcp_url === `${BASE}/mcp`);
  assert.equal((await poll()).json.error, 'expired_token');                                          // and exchanged once
  const drpc = async (bearer, method, params) => { const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const mine = await drpc(dtok.json.access_token, 'tools/call', { name: 'list_projects', arguments: {} });
  assert.equal(mine.status, 200); assert.ok(!mine.json.result.isError, JSON.stringify(mine.json));
  const fresh = await agent('/oauth/token', { grant_type: 'refresh_token', refresh_token: dtok.json.refresh_token, client_id: dtok.json.client_id });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.json)); assert.ok(fresh.json.access_token && fresh.json.access_token !== dtok.json.access_token);
  const cAgents = must(await C.get('/api/console/agents')).agents;
  assert.equal(cAgents.length, 1); assert.equal(cAgents[0].client, 'Headless bAgent/b');
  must(await C.del(`/api/console/agents/${cAgents[0].id}`));
  assert.equal((await drpc(fresh.json.access_token, 'ping')).status, 401);
  const dev2 = (await agent('/oauth/device', { client_name: 'Unwanted' })).json;
  must(await C.post(`/api/device/${dev2.user_code}`, { decision: 'deny' }));
  assert.equal((await agent('/oauth/token', { grant_type: GRANT, device_code: dev2.device_code })).json.error, 'access_denied');
  ok('device sign-in: 401 explains how to connect, code approved in the console, expiring tokens, refresh, single use, revoke, denial');

  // agents list + revoke ends access
  const agents = must(await A.get('/api/console/agents')).agents;
  assert.ok(agents.length >= 1 && agents[0].client === 'E2E Agent');
  must(await A.del(`/api/console/agents/${agents[0].id}`));
  assert.equal((await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })).status, 401);
  ok('console lists connected agents; revoking one ends its access at once');

  console.log(`\nAll ${step} steps passed.`);
}

main().then(() => { mock.close(); process.exit(0); }).catch((e) => { console.error('\nFAILED:', e.message, '\n', e.stack.split('\n').slice(1, 4).join('\n')); mock.close(); process.exit(1); });

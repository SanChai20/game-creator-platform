// End-to-end test against a running dev server (npm run dev + scripts/local-verifier.mjs).
// Walks the whole product: accounts, OAuth, MCP authoring, static checks, deploy, browser verification,
// publish, play counting, reviews, paid games through a mock Stripe, earnings, withdrawal, rooms.
//   node tests/e2e.mjs            (expects http://127.0.0.1:8787)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
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
  if (url.pathname === '/v2/core/accounts') return send({ id: 'acct_test1' });
  if (url.pathname === '/v2/core/accounts/acct_test1') return send({ id: 'acct_test1', configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: 'active' } } } } } });
  if (url.pathname === '/v2/core/account_links') return send({ url: 'https://connect.stripe.test/onboard' });
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
  must(await ADM.put('/api/admin/settings', { play_min_seconds: 2, verify_human_min_seconds: 2, earnings_hold_days: 0, refund_window_hours: 0, withdraw_min_cents: 300, new_creator_days: 0 }));
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
  assert.equal(tools.length, 21, tools.map((t) => t.name).join(', '));
  assert.ok(tools.every((t) => t.description.length > 40 && t.inputSchema.type === 'object'));
  assert.match(init.instructions, /web games only/);
  const started = await tool('get_started');
  assert.ok(/web games only/.test(started.web_games_only) && started.workflow.length >= 5 && started.rules.length === 5 && started.services.multiplayer && started.account && started.guides.length === 8 && /Web \/ HTML5/.test(started.engines), JSON.stringify(started).slice(0, 600));
  assert.ok(!JSON.stringify(started).match(/design_scene|list_blocks|recommend_pipeline|craft score/), 'get_started must not teach how to make a game');
  for (const topic of ['contract', 'metadata', 'versions', 'saves', 'multiplayer', 'storage', 'services']) { const g = await tool('get_started', { topic }); assert.ok(g.markdown.length > 1000 && !g.markdown.includes('{{'), topic); }
  assert.equal((await rpc('resources/list')).resources.length, 9);
  const catalog = await tool('platform_services');
  assert.ok(catalog.services.length >= 20 && catalog.not_provided.length >= 10 && catalog.services.some((x) => x.id === 'multiplayer'), JSON.stringify(catalog).slice(0, 400));
  assert.equal((await tool('platform_services', { service: 'saves' })).service.id, 'saves');
  assert.ok(JSON.parse((await rpc('resources/read', { uri: 'gcp://services' })).contents[0].text).services.length === catalog.services.length);
  ok(`MCP: initialize says web games only, ${tools.length} tools, get_started and its 7 platform guides, platform_services; bad token gets 401`);

  // a project made from one of the platform's starter folders, uploaded the way an agent uploads its own files
  const tplDir = new URL('../web/public/templates/', import.meta.url), tplIndex = JSON.parse(readFileSync(new URL('index.json', tplDir), 'utf8'));
  const fromTemplate = async (name, args) => {
    const p = await tool('create_project', args);
    const files = [];
    for (const f of tplIndex.templates.find((t) => t.name === name).files) {
      const buf = readFileSync(new URL(`${name}/${f.path}`, tplDir));
      files.push(/\.(html|js|mjs|css|json|txt|md|svg)$/.test(f.path) ? { path: f.path, content: new TextDecoder().decode(buf) } : { path: f.path, content: Buffer.from(buf).toString('base64'), encoding: 'base64' });
    }
    await tool('upload_files', { project: p.project, files });
    return p;
  };
  // the store metadata publishing needs, declared the way an agent follows the checklist: detected suggestions confirmed, the rest answered
  const declareMeta = async (call, project, extra = {}) => {
    const chk = await call('game_metadata', { project }), step = (f) => chk.checklist.find((x) => x.field === f);
    return call('game_metadata', { project, action: 'declare', requirements: step('requirements').suggestion, languages: step('languages').suggestion, players: step('players').suggestion, content: {}, ...extra });
  };

  // web games only: programs and archives are refused whatever their name, and so are pages that lead to a download, a store or another site
  const web = await tool('create_project', { title: `Native ${run}` });
  const exe = await rpc('tools/call', { name: 'upload_files', arguments: { project: web.project, files: [{ path: 'game.bin', content: Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]).toString('base64'), encoding: 'base64' }] } });
  assert.ok(exe.isError && /Windows program/.test(exe.content[0].text) && /web games only/.test(exe.content[0].text) && /Web \/ HTML5 \/ WebGL export/.test(exe.content[0].text), exe.content[0].text);
  assert.equal((await rpc('tools/call', { name: 'upload_files', arguments: { project: web.project, files: [{ path: 'game.exe', content: 'x' }] } })).isError, true);
  await tool('upload_files', { project: web.project, files: [{ path: 'index.html', content: '<!doctype html><meta name="viewport" content="width=device-width"><canvas></canvas><a href="https://play.google.com/store/apps/details?id=x.y">Get it</a><a href="dl/game-setup.exe">PC</a><script>requestAnimationFrame(function f(){requestAnimationFrame(f)});GCP.ready()</script>' }, { path: 'Build/game.data', content: Buffer.from('UnityWebData1.0\0').toString('base64'), encoding: 'base64' }] });
  const nat = await tool('deploy_preview', { project: web.project, dry_run: true });
  assert.ok(!nat.ok && nat.errors.some((e) => /native download: dl\/game-setup\.exe/.test(e)) && nat.errors.some((e) => /app-store/.test(e)), nat.errors.join('\n'));
  assert.equal((await tool('deploy_preview', { project: web.project })).deployed, false);
  ok('web games only: an exe named .bin and an .exe are refused at upload, store and download links fail the checks, a Unity .data file is accepted');

  // a broken game is caught statically, with a line number and a fix
  const bad = await tool('create_project', { title: `Broken ${run}` });
  await tool('upload_files', { project: bad.project, files: [{ path: 'index.html', content: '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><canvas></canvas><script type="module" src="main.js"></script></body></html>' }, { path: 'main.js', content: "import * as THREE from 'three';\nimport { nope } from './missing.js';\nimport x from 'lodash';\nconst a = ;\n" }] });
  let chk = await tool('deploy_preview', { project: bad.project, dry_run: true });
  assert.equal(chk.ok, false); assert.ok(chk.errors.some((e) => /syntax error/i.test(e) && /main\.js:4/.test(e)), chk.errors.join('\n'));
  await tool('upload_files', { project: bad.project, edits: [{ path: 'main.js', old_string: 'const a = ;', new_string: 'const a = 1;' }] });
  chk = await tool('deploy_preview', { project: bad.project, dry_run: true });
  assert.ok(chk.errors.some((e) => /missing\.js/.test(e)) && chk.errors.some((e) => /lodash/.test(e)) && chk.errors.some((e) => /GCP\.ready/.test(e)), chk.errors.join('\n'));
  const refused = await tool('deploy_preview', { project: bad.project });
  assert.equal(refused.deployed, false);
  ok('static checks: syntax error with line, missing import, unmapped bare import, missing GCP.ready(); deploy refused');

  // a game that passes static checks but throws at runtime fails browser verification
  await tool('upload_files', { project: bad.project, files: [{ path: 'main.js', content: "const c = document.querySelector('canvas').getContext('2d');\nfunction frame(t){ c.fillStyle = 'hsl(' + (t / 10 % 360) + ' 70% 50%)'; c.fillRect(0, 0, 300, 150); c.fillStyle='#fff'; c.fillRect(20,20,40,40); requestAnimationFrame(frame); }\nrequestAnimationFrame(frame);\nGCP.ready();\nsetTimeout(() => { undefinedFunctionCall(); }, 300);\n" }] });
  let dep = await tool('deploy_preview', { project: bad.project, note: 'throws' });
  for (let i = 0; i < 30 && ['queued', 'deploying', 'verifying'].includes(dep.status); i++) { await sleep(2000); dep = await tool('list_versions', { project: bad.project, version: dep.version }); }
  assert.equal(dep.status, 'failed', JSON.stringify(dep).slice(0, 800)); assert.equal(dep.can_publish, false);
  assert.ok(dep.report.errors.some((e) => /undefinedFunctionCall/.test(e)), JSON.stringify(dep.report.errors));
  assert.equal((await rpc('tools/call', { name: 'publish', arguments: { project: bad.project } })).isError, true);
  ok('runtime error caught by the browser check; publish refused');

  // a game that boots and renders but whose rules are broken is caught by its own play-through
  const broken = await fromTemplate('three-blank', { title: `Broken rules ${run}` });
  await tool('upload_files', { project: broken.project, edits: [{ path: 'src/main.js', old_string: "score++; hud.textContent = 'Beacons: ' + score; placeBeacon();", new_string: 'score++; placeBeacon();' }] });   // the HUD never updates
  let bd = await tool('deploy_preview', { project: broken.project, note: 'hud bug' });
  for (let i = 0; i < 40 && ['queued', 'deploying', 'verifying'].includes(bd.status); i++) { await sleep(2000); bd = await tool('list_versions', { project: broken.project, version: bd.version }); }
  assert.equal(bd.status, 'failed', JSON.stringify(bd, null, 1).slice(0, 1500));
  const bp = bd.report.checks.find((c) => c.id === 'playthrough');
  assert.ok(bp && !bp.ok && /HUD says "Beacons: 0"/.test(bp.detail) && /during step 3/.test(bp.detail), JSON.stringify(bp));
  assert.ok(bd.report.checks.filter((c) => !c.ok).length === 1);                 // everything else about it is fine
  ok('broken game rules caught by the play-through: boots and renders, but the failed step is named and publish is blocked');

  // every template deploys and verifies
  const projects = {};
  for (const t of ['blank', 'three-blank', 'canvas2d-arcade', 'three-explorer']) {
    const p = await fromTemplate(t, { title: `${t} ${run}`, tagline: 'An e2e game', tags: ['minimalist', 'short-sessions'] });
    if (t !== 'canvas2d-arcade') await declareMeta(tool, p.project, { genre: t === 'three-explorer' ? 'adventure' : 'casual' });   // the arcade declares its own below
    const c = await tool('deploy_preview', { project: p.project, dry_run: true });
    assert.equal(c.ok, true, c.errors.join('\n'));
    let d = await tool('deploy_preview', { project: p.project, note: 'first' });
    for (let i = 0; i < 40 && ['queued', 'deploying', 'verifying'].includes(d.status); i++) { await sleep(2000); d = await tool('list_versions', { project: p.project, version: d.version }); }
    assert.equal(d.status, 'verified', `${t}: ${JSON.stringify(d.report, null, 1).slice(0, 1500)}`);
    assert.ok(d.screenshot && d.can_publish && d.report.craft === undefined && !('quality' in d));
    const play = d.report.checks.find((c) => c.id === 'playthrough');
    if (t === 'blank') { assert.ok(!play && d.report.playthrough === null && /no play-through/.test(d.report.summary) && d.report.notes.length === 1); }
    else { assert.ok(play && play.ok && d.report.playthrough.steps.length >= 3, `${t}: ${JSON.stringify(play)}`); assert.match(d.report.summary, /play-through of \d+ step/); }
    projects[t] = p.project;
    ok(`template ${t}: checks clean, deployed, verified (${d.report.metrics.loadMs} ms load, ${d.report.metrics.fps} fps, ${d.report.metrics.colors} colours, ${play ? `play-through of ${d.report.playthrough.steps.length} steps in ${(d.report.playthrough.ms / 1000).toFixed(1)} s` : 'no play-through'})`);
  }
  const pid = projects['three-explorer'];

  // compatibility requirements: detected, declared through MCP, frozen with the version
  const arcade = projects['canvas2d-arcade'];
  let cc = await tool('compatibility', { project: arcade });
  assert.equal(cc.declared, null);
  assert.equal(cc.detected.graphics, 'canvas', JSON.stringify(cc.detected));
  assert.ok(cc.suggested && cc.store_page_will_show.length >= 3 && cc.issues.some((i) => /No requirements are declared/.test(i)));
  assert.equal((await rpc('tools/call', { name: 'compatibility', arguments: { project: arcade, action: 'declare', requirements: { features: ['wasm-threads'] } } })).isError, true);
  assert.equal((await rpc('tools/call', { name: 'compatibility', arguments: { project: arcade, action: 'declare', requirements: { graphics: 'opengl' } } })).isError, true);
  cc = await tool('compatibility', { project: arcade, action: 'declare', use_detected: true, requirements: { gpu: 'hardware', devices: ['desktop', 'tablet', 'mobile'], notes: 'Plays best with a keyboard.' } });
  assert.equal(cc.written, 'gcp.json');
  assert.equal(cc.declared.gpu, 'hardware');
  assert.ok(!cc.issues.some((i) => i.startsWith('ERROR')), cc.issues.join('\n'));
  let cvr = await tool('deploy_preview', { project: arcade, note: 'requirements' });
  for (let i = 0; i < 40 && ['queued', 'deploying', 'verifying'].includes(cvr.status); i++) { await sleep(2000); cvr = await tool('list_versions', { project: arcade, version: cvr.version }); }
  assert.equal(cvr.status, 'verified', JSON.stringify(cvr.report).slice(0, 800));
  assert.equal(cvr.compatibility.declared, true);
  assert.equal(cvr.compatibility.requirements.gpu, 'hardware');
  assert.ok(cvr.compatibility.store_page_shows.some((l) => /hardware GPU/.test(l)));
  assert.equal((await tool('compatibility', { project: arcade, version: 1 })).declared, false);   // the earlier version keeps what it went out with
  ok('compatibility: detected from the code, bad declarations refused, declared into gcp.json, frozen with the next version');

  // multiplayer service: two real pages meet in one platform room and end with the same world (GCP.test.onTwoPlayers)
  const mp = await fromTemplate('homestead-2d', { title: `Two players ${run}`, tagline: 'Farm with a friend' });
  let mv = await tool('deploy_preview', { project: mp.project, note: 'two players' });
  for (let i = 0; i < 60 && ['queued', 'deploying', 'verifying'].includes(mv.status); i++) { await sleep(2000); mv = await tool('list_versions', { project: mp.project, version: mv.version }); }
  assert.equal(mv.status, 'verified', JSON.stringify(mv.report, null, 1).slice(0, 1500));
  assert.ok(mv.report.two_players && mv.report.two_players.ok && mv.report.two_players.host.players === 2 && mv.report.two_players.guest.players === 2, JSON.stringify(mv.report.two_players || mv.report.notes).slice(0, 800));
  ok('multiplayer: the two-player check met two pages in one platform room and both ended with the same world');

  // server-run matches: the two verifier pages are two players (one verifier identity each), so both are listed in the
  // private lobby on twoPlayers.code and the matchmaker starts their match (the local driver has no GameMatch, so the check
  // ends at the found match)
  const mg = await tool('create_project', { title: `Match duel ${run}`, tagline: 'Duel' });
  const duel = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Duel</title></head><body><canvas id="c" width="320" height="180"></canvas><script>
const cv = document.getElementById('c'), g = cv.getContext('2d'); let t = 0; (function f() { t++; g.fillStyle = 'hsl(' + (t % 360) + ',60%,50%)'; g.fillRect(0, 0, 320, 180); requestAnimationFrame(f); })();
let found = null; const two = GCP.test.twoPlayers;
GCP.test.onAutostart(() => { if (two) GCP.match.find({ code: two.code, players: 2 }).on('found', (f) => { found = f; }); });
GCP.test.onTwoPlayers(async (t) => { t.step('the other player to appear'); await t.until(() => found, 30000, 'the other player to appear'); return { players: found.players.length, world: found.match }; });
GCP.ready();
</script></body></html>`;
  await tool('upload_files', { project: mg.project, files: [{ path: 'index.html', content: duel }, { path: 'server/match.js', content: 'export default { tickRate: 20, init() { return { players: {} }; }, input() {}, tick() {} };\n' }] });
  let gv = await tool('deploy_preview', { project: mg.project, note: 'match' });
  for (let i = 0; i < 60 && ['queued', 'deploying', 'verifying'].includes(gv.status); i++) { await sleep(2000); gv = await tool('list_versions', { project: mg.project, version: gv.version }); }
  assert.ok(gv.report && gv.report.two_players && gv.report.two_players.ok, JSON.stringify(gv.report && gv.report.two_players || gv).slice(0, 1500));
  assert.notEqual(gv.report.two_players.host.match.you, gv.report.two_players.guest.match.you);
  assert.equal((await tool('game_metadata', { project: mg.project })).detected.online_play, true);
  ok('matches: the two-player check met two verifier players in one private lobby; GCP.match.find counts as online play');

  // the platform database and multiplayer rooms, managed through MCP
  assert.ok((await tool('game_data', { project: mp.project, action: 'set', env: 'preview', key: 'motd', value: { text: 'hello' } })).ok);
  assert.deepEqual((await tool('game_data', { project: mp.project, action: 'get', env: 'preview', key: 'motd' })).value, { text: 'hello' });
  assert.ok((await tool('game_data', { project: mp.project, action: 'list', env: 'preview', prefix: 'mo' })).keys.some((k) => k.key === 'motd'));
  assert.ok((await tool('game_data', { project: mp.project, action: 'summary', env: 'preview' })).shared_data.keys >= 1);
  assert.equal((await tool('game_data', { project: mp.project, action: 'get', key: 'motd' })).exists, false);   // live data is kept apart from preview
  assert.equal((await tool('game_data', { project: mp.project, action: 'delete', env: 'preview', key: 'motd' })).deleted, true);
  assert.ok(Array.isArray((await tool('game_data', { project: mp.project, action: 'leaderboard', env: 'preview' })).rows));
  const room = await tool('game_room', { project: mp.project, env: 'preview', room: 'e2e-empty' });
  assert.ok(Array.isArray(room.players) && room.players.length === 0 && room.state === null && room.limits.players_per_room > 1, JSON.stringify(room));
  assert.equal((await tool('game_room', { project: mp.project, env: 'preview', room: 'e2e-empty', action: 'reset', kick: true })).cleared, true);
  assert.equal((await rpc('tools/call', { name: 'game_data', arguments: { project: mp.project, action: 'set', key: 'x' } })).isError, true);   // no value
  ok('game data and rooms: shared data set, read, listed and deleted per environment, leaderboard read, a room inspected and reset');

  // upload URL (curl path): single file and zip
  const up = await tool('create_upload_url', { project: projects.blank });
  const upUrl = up.one_file.match(/"(http[^"?]+)\?path/)[1];
  assert.equal((await fetch(`${upUrl}?path=notes.txt`, { method: 'PUT', body: 'hello' })).status, 200);
  const zip = zipSync({ 'game/index.html': strToU8('<!doctype html><meta name="viewport" content="width=device-width"><canvas></canvas><script>requestAnimationFrame(function f(){requestAnimationFrame(f)});GCP.ready()</script>'), 'game/data/level.json': strToU8('{"a":1}') });
  const z = await (await fetch(`${upUrl}/zip?clean=1`, { method: 'POST', body: zip })).json();
  assert.deepEqual(z.written.sort(), ['data/level.json', 'index.html']); assert.ok(z.removed.includes('notes.txt'));
  assert.equal((await fetch(`${BASE}/api/upload/bogus?path=a.txt`, { method: 'PUT', body: 'x' })).status, 401);
  ok('direct upload: single file, zip with folder stripping and clean, bad token refused');

  // server code runs in the game's Worker and is never served as a file, under any spelling of the path, with or without a play session
  const srv = await fromTemplate('canvas2d-arcade', { title: `Vault ${run}` });
  await tool('upload_files', { project: srv.project, files: [
    { path: 'server/index.js', content: "import { KEY } from './secret.js';\nexport default { async fetch(request, env) { return Response.json({ ok: true, keyLength: KEY.length, player: env.player && env.player.id, guest: env.player && env.player.guest }); } };\n" },
    { path: 'server/secret.js', content: "export const KEY = 'sk_live_e2e_do_not_leak_0123456789';\n" },
  ] });
  let sv = await tool('deploy_preview', { project: srv.project, note: 'server code' });
  for (let i = 0; i < 60 && ['queued', 'deploying', 'verifying'].includes(sv.status); i++) { await sleep(2000); sv = await tool('list_versions', { project: srv.project, version: sv.version }); }
  assert.notEqual(sv.status, 'failed', JSON.stringify(sv).slice(0, 600));
  const sprev = must(await A.post(`/api/console/projects/${srv.project}/preview`)), sbase = sprev.url.split('?')[0], stok = new URL(sprev.url).searchParams.get('gcp_t');
  assert.equal((await fetch(sprev.url)).status, 200);
  const leaks = ['server/index.js', 'server/secret.js', 'server/', 'server', './server/secret.js', 'x/../server/secret.js', '%73erver/secret.js', 'server%2Fsecret.js', './/server/secret.js', 'Server/secret.js'];
  for (const path of leaks) {
    for (const withTok of [false, true]) {
      const u = `${sbase}${path}${withTok ? `?gcp_t=${stok}` : ''}`;
      for (const method of ['GET', 'HEAD']) {
        const r = await fetch(u, { method, headers: { cookie: `gcp_t=${stok}`, range: 'bytes=0-10' } });
        const body = method === 'GET' ? await r.text() : '';
        assert.ok(r.status === 404 || r.status === 401 || r.status === 400, `${method} ${path}${withTok ? ' (token)' : ''} answered ${r.status}`);
        assert.ok(!body.includes('sk_live_e2e') && !body.includes('export default'), `${method} ${path} leaked server code`);
      }
    }
  }
  const sres = await fetch(`${sbase}api/hello`, { headers: { 'x-gcp-token': stok } });
  if (sbase.includes('/__game/')) assert.equal(sres.status, 404);   // the local driver cannot load a game's server modules; tests/server-code.mjs runs them
  else { assert.equal(sres.status, 200); const sj = await sres.json(); assert.ok(sj.ok && sj.keyLength === 34 && sj.player && sj.guest === false, JSON.stringify(sj)); }
  const sfiles = await tool('list_files', { project: srv.project });
  assert.ok(JSON.stringify(sfiles).includes('server/secret.js'));   // the creator still sees their own server files through MCP
  ok('server code: never served as a file (10 path spellings, GET and HEAD, with and without a play session), deploys, still listed for its creator');

  // publish needs the license (A is admin => creator). Check the gate with a fresh non-creator through the console API later.
  const pub = await tool('publish', { project: pid });
  assert.equal(pub.live, true, JSON.stringify(pub));
  await tool('update_project', { project: pid, description: 'Find every shard on a procedurally generated island.', controls: 'WASD, drag, Space' });
  const list = must(await B.get('/api/games'));
  assert.ok(list.games.some((g) => g.id === pid && g.cover));
  const slug = list.games.find((g) => g.id === pid).slug;
  const gp = must(await B.get(`/api/games/${slug}`));
  assert.ok(gp.compat && gp.compat.declared === true && gp.compat.requirements.graphics === 'webgl2' && gp.compat.download_bytes > 0, JSON.stringify(gp.compat));
  assert.ok(gp.meta && gp.meta.rating.age === 3 && gp.meta.players.max === 1 && gp.meta.languages_declared && gp.meta.languages.supported.length >= 1 && gp.game.tags[0] === 'adventure', JSON.stringify(gp.meta));
  // a translated listing is served with the game and its card
  await tool('game_metadata', { project: pid, action: 'declare', listing_translations: { ja: { title: 'シャード島', tagline: '島のかけらを集めよう' } } });
  const gpj = must(await B.get(`/api/games/${slug}`));
  assert.equal(gpj.game.listing_i18n.ja.title, 'シャード島');
  assert.equal(must(await B.get('/api/games')).games.find((g) => g.id === pid).i18n.ja.tagline, '島のかけらを集めよう');
  assert.equal((await rpc('tools/call', { name: 'game_metadata', arguments: { project: pid, action: 'declare', listing_translations: { fr: { title: 'x' } } } })).isError, true);
  ok('published; visible in the marketplace with a cover, its declared requirements, metadata (age 3+, players, languages, genre) and a Japanese listing');

  // play: playable at once for a signed-in player, session token, document gated, play time counted, review gated on play
  assert.equal(must(await client().get('/api/config')).settings.require_login_to_play, true, 'every game needs an account by default (guest play is checked below)');
  const play = must(await B.post(`/api/games/${slug}/play`));
  const doc = await fetch(play.url);
  assert.equal(doc.status, 200); const html = await doc.text(); assert.ok(html.includes('/sdk/gcp.js') && html.includes('importmap'));
  assert.equal((await fetch(play.url.split('?')[0])).status, 401);
  const t = new URL(play.url).searchParams.get('gcp_t');
  assert.equal((await B.post(`/api/games/${slug}/reviews`, { rating: 5, body: 'too early' })).status, 403);
  const beat = (body) => fetch(`${BASE}/api/rt/beat`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ t, ...body }) }).then((r) => r.json());
  // the store page's check-ins are the platform's play clock; the game's heartbeats, however active they claim to be, count nothing
  const checkin = (ms) => B.post(`/api/plays/${play.session}/seen`, { visible_ms: ms });
  must(await checkin(0));
  await beat({ frames: 10, active: false, first: true });
  await sleep(2600);
  const b2 = await beat({ frames: 200, active: true, errors: ['TypeError: demo error'] });
  assert.equal(b2.seconds, 0, 'heartbeats alone credit no play time');
  assert.equal((await B.post(`/api/games/${slug}/reviews`, { rating: 4, body: 'not yet' })).status, 403, 'nor count a play');
  assert.equal((await fetch(`${BASE}/api/plays/${play.session}/seen`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://game.example' }, body: '{"visible_ms":9999}' })).status, 403, 'another origin (the game) cannot check in');
  assert.equal(must(await A.post(`/api/plays/${play.session}/seen`, { visible_ms: 9999 })).ok, false, 'nor can another account');
  const c2 = must(await checkin(3_600_000));
  assert.ok(c2.ok && c2.seconds >= 2 && c2.seconds <= 4 && c2.counted, JSON.stringify(c2));   // capped by the server's clock
  must(await B.post(`/api/games/${slug}/reviews`, { rating: 4, body: 'Lovely island.' }));
  must(await B.post(`/api/games/${slug}/reviews`, { rating: 5, body: 'Lovely island, even better.' }));
  const detail = must(await B.get(`/api/games/${slug}`));
  assert.equal(detail.game.plays, 1); assert.equal(detail.game.rating, 5); assert.equal(detail.game.rating_count, 1); assert.equal(detail.played, true);
  assert.equal((await A.post(`/api/games/${slug}/reviews`, { rating: 5 })).status, 403);
  ok('play session: signed-in players play at once, document gated by token, play counted by the platform\'s clock (not the game\'s heartbeats) after the minimum, review updates rating, own-game review refused');

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
  const inRooms = await tool('get_stats', { project: pid, only_now: true });   // the room reports its own occupancy
  assert.ok(inRooms.rooms.players_in_rooms === 2 && inRooms.rooms.busiest.some((r) => r.room === 'test' && r.players === 2 && r.env === 'live') && inRooms.online.live >= 1, JSON.stringify(inRooms));
  wa.close(); await sleep(500);
  assert.ok(got.b.some((m) => m.t === 'leave' && m.host === got.b[0].id));
  wb.close(); await sleep(500);
  assert.equal((await tool('get_stats', { project: pid, only_now: true })).rooms.players_in_rooms, 0);
  ok('game services: cloud save, leaderboard keeps best, room relay with host and host migration');

  // per-player progress: two players of one game never see each other's saves, stats or record
  const svcA = (path, body) => fetch(`${BASE}/api/rt/${path}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ t: t2, ...body }) }).then((r) => r.json());
  assert.equal((await svcA('save', { op: 'get', key: 'slot1' })).value, null);
  await svcA('save', { op: 'set', key: 'slot1', value: { level: 9 }, user: 'whoever', player: 'whoever' });
  assert.deepEqual((await svc('save', { op: 'get', key: 'slot1' })).value, { level: 3 });
  assert.deepEqual((await svcA('save', { op: 'get', key: 'slot1' })).value, { level: 9 });
  assert.equal((await svc('stats', { op: 'add', name: 'coins', value: 5 })).value, 5);
  assert.equal((await svc('stats', { op: 'add', name: 'coins' })).value, 6);
  assert.deepEqual((await svcA('stats', { op: 'all' })).stats, {});
  assert.equal((await fetch(`${BASE}/api/rt/save`, { method: 'POST', body: JSON.stringify({ t: t.slice(0, -2) + 'xx', op: 'get', key: 'slot1' }) })).status, 401);
  const rec = await svc('record', {});
  assert.ok(rec.sessions === 1 && rec.seconds >= 2 && rec.stats.coins === 6 && rec.best.time === 42.5 && rec.saves.keys === 1, JSON.stringify(rec));
  const myProgress = must(await B.get(`/api/games/${slug}/progress`));
  assert.deepEqual(myProgress.stats, { coins: 6 });
  assert.deepEqual(must(await A.get(`/api/games/${slug}/progress`)).stats, {});
  assert.equal((await client().get(`/api/games/${slug}/progress`)).status, 401);
  must(await B.del(`/api/games/${slug}/progress`));
  assert.equal((await svc('save', { op: 'get', key: 'slot1' })).value, null);
  assert.deepEqual((await svcA('save', { op: 'get', key: 'slot1' })).value, { level: 9 }, 'resetting one player leaves the other alone');
  const agg = await tool('game_data', { project: pid, action: 'summary' });
  assert.ok(agg.player_records.players >= 1 && !JSON.stringify(agg).includes('level'), JSON.stringify(agg));
  ok('per-player progress: saves and stats kept apart per player, forged token refused, own progress readable and resettable, creator sees only totals');

  // analytics: players online, rooms, sessions, new and returning players, versions, devices, for the agent and in the console
  const an = (await tool('get_stats', { project: pid, days: 7 })).analytics;
  assert.ok(an.totals.sessions >= 1 && an.totals.players === 1 && an.totals.new_players === 1 && an.daily.length === 7 && an.daily[6].players === 1 && an.last_24_hours.length === 24 && an.devices.length >= 1 && an.versions[0].version === 1 && an.session_lengths.length === 6, JSON.stringify(an.totals));
  const ca = must(await A.get(`/api/console/projects/${pid}/analytics?days=30`));
  assert.ok(ca.daily.length === 30 && ca.now.online && ca.project.id === pid);
  assert.ok(must(await A.get(`/api/console/projects/${pid}/online`)).rooms);
  assert.ok([403, 404].includes((await B.get(`/api/console/projects/${pid}/analytics`)).status));
  ok(`analytics: ${an.totals.sessions} session(s) by ${an.totals.players} player, rooms counted while players were in them, daily, hourly, version and device breakdowns; another account is refused`);

  // "Require login to play": on (the default) a visitor without an account gets no play session; off, free games open to
  // guests with their own id, paid games still need an account, and switching it back on ends guest access to every service
  const G = client();
  must(await ADM.put('/api/admin/settings', { require_login_to_play: true }));
  await sleep(16000);   // settings are cached for 15 s per isolate
  assert.equal((await G.post(`/api/games/${slug}/play`)).status, 401);
  must(await ADM.put('/api/admin/settings', { require_login_to_play: false }));
  await sleep(16000);
  const gpl = must(await G.post(`/api/games/${slug}/play`)), gt = new URL(gpl.url).searchParams.get('gcp_t');
  const gdoc = await (await fetch(gpl.url)).text();
  assert.ok(/"guest":true/.test(gdoc) && /"id":"guest_[a-z0-9]{20}"/.test(gdoc), 'the game is told it has a guest');
  const gsvc = (path, body) => fetch(`${BASE}/api/rt/${path}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ t: gt, ...body }) });
  assert.equal((await gsvc('save', { op: 'set', key: 'slot1', value: { guest: 1 } })).status, 200);
  assert.deepEqual((await (await gsvc('save', { op: 'get', key: 'slot1' })).json()).value, { guest: 1 });
  assert.equal((await gsvc('beat', { frames: 5, active: false, first: true })).status, 200);
  const gp2 = must(await G.post(`/api/games/${slug}/play`));   // the same browser keeps the same guest id, and with it the save
  assert.equal(JSON.parse(atob(new URL(gp2.url).searchParams.get('gcp_t').split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).u, JSON.parse(atob(gt.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).u);
  const gtok = JSON.parse(atob(gt.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
  assert.ok(gtok.x - Date.now() / 1000 <= 3600 + 5, 'guest sessions are short');
  assert.equal((await G.post(`/api/games/${slug}/reviews`, { rating: 5 })).status, 401);   // reviews need an account
  assert.equal((await G.get(`/api/games/${slug}/progress`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/games/${slug}/play`, { method: 'POST', headers: { origin: BASE } })).status, 200);   // a brand-new visitor too

  // Binding: every session belongs to the identity that started it. An account's session ends with its sign-in.
  const BC = client(), cmail = `binder-${run}@example.com`;
  must(await BC.post('/api/auth/signup', { email: cmail, name: 'Binder ' + run, password: 'correct horse' }));
  const cpl = must(await BC.post(`/api/games/${slug}/play`)), ct = new URL(cpl.url).searchParams.get('gcp_t');
  assert.equal(cpl.player.guest, false); assert.equal(cpl.player.name, 'Binder ' + run);
  const rtc = (tk, path, body) => fetch(`${BASE}/api/rt/${path}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ t: tk, ...body }) });
  assert.equal((await rtc(ct, 'save', { op: 'set', key: 'slot1', value: { mine: 'binder' } })).status, 200);
  assert.equal((await rtc(ct, 'check', {})).status, 200);
  const rn = await (await rtc(ct, 'renew', {})).json();
  assert.equal(rn.token, null, 'a fresh token is not renewed early');
  // the same browser signs in as someone else: the first account's game stops at its next call, in every tab
  must(await BC.post('/api/auth/login', { email: `creator-${run}@example.com`, password: 'correct horse' }));
  const ended = await rtc(ct, 'save', { op: 'set', key: 'slot1', value: { mine: 'creator?' } });
  assert.equal(ended.status, 401); const ej = await ended.json(); assert.equal(ej.code, 'session_ended'); assert.equal(ej.hint, 'signed_out');
  for (const path of ['beat', 'stats', 'score', 'record', 'renew']) assert.equal((await rtc(ct, path, { op: 'all', board: 'b' })).status, 401, `${path} still open after switching accounts`);
  // ...and reopening the game page from the token its origin kept shows the gate instead of the previous player
  const stale = await fetch(cpl.url.split('?')[0], { headers: { cookie: `gcp_t=${ct}` } });
  assert.equal(stale.status, 401); assert.ok(!(await stale.text()).includes('Binder'));
  // sign out ends the new sign-in's games too
  const cpl2 = must(await BC.post(`/api/games/${slug}/play`)), ct2 = new URL(cpl2.url).searchParams.get('gcp_t');
  assert.equal((await rtc(ct2, 'save', { op: 'get', key: 'slot1' })).status, 200);
  must(await BC.post('/api/auth/logout'));
  assert.equal((await rtc(ct2, 'save', { op: 'get', key: 'slot1' })).status, 401);
  // the binder's save never moved anywhere: signing back in finds it
  must(await BC.post('/api/auth/login', { email: cmail, password: 'correct horse' }));
  const ct3 = new URL(must(await BC.post(`/api/games/${slug}/play`)).url).searchParams.get('gcp_t');
  assert.deepEqual((await (await rtc(ct3, 'save', { op: 'get', key: 'slot1' })).json()).value, { mine: 'binder' });
  ok('binding: an account session ends when the browser signs out or switches accounts (every service and a reopened page); progress stays with its own account');

  // Guest to account: offered, moved only on a yes, once; the guest session then ends and the browser gets a new guest id.
  const H = client();
  const hpl = must(await H.post(`/api/games/${slug}/play`)), ht = new URL(hpl.url).searchParams.get('gcp_t'), hid = hpl.player.id;
  assert.equal((await rtc(ht, 'save', { op: 'set', key: 'slot9', value: { guestRun: 7 } })).status, 200);
  assert.equal((await rtc(ht, 'beat', { frames: 5, active: false, first: true })).status, 200);
  must(await H.post('/api/auth/signup', { email: `guest-${run}@example.com`, name: 'Was Guest ' + run, password: 'correct horse' }));
  assert.equal((await rtc(ht, 'save', { op: 'get', key: 'slot9' })).status, 200, 'nothing moves before the player says so');
  const offer = must(await H.get('/api/guest-progress'));
  assert.ok(offer.games.length === 1 && offer.games[0].slug === slug && offer.games[0].kept === false, JSON.stringify(offer));
  const gmv = must(await H.post('/api/guest-progress', { move: true }));
  assert.equal(gmv.moved, 1);
  const hend = await rtc(ht, 'save', { op: 'get', key: 'slot9' });
  assert.equal(hend.status, 401); assert.equal((await hend.json()).hint, 'signed_in');
  const ht2 = new URL(must(await H.post(`/api/games/${slug}/play`)).url).searchParams.get('gcp_t');
  assert.deepEqual((await (await rtc(ht2, 'save', { op: 'get', key: 'slot9' })).json()).value, { guestRun: 7 }, 'the guest save is on the account');
  assert.deepEqual(must(await H.get('/api/guest-progress')).games, [], 'offered once');
  must(await H.post('/api/auth/logout'));
  const hpl3 = must(await H.post(`/api/games/${slug}/play`));
  assert.ok(hpl3.player.guest && hpl3.player.id !== hid, 'after signing out the browser plays under a new guest id');
  const ht3 = new URL(hpl3.url).searchParams.get('gcp_t');
  assert.equal((await (await rtc(ht3, 'save', { op: 'get', key: 'slot9' })).json()).value, null, 'the next guest on this computer starts clean');
  ok('guest progress: offered after sign-up, moved only when asked, once; the old guest session ends and the next guest on the computer starts clean');
  must(await ADM.put('/api/admin/settings', { require_login_to_play: true }));
  await sleep(16000);
  assert.equal((await G.post(`/api/games/${slug}/play`)).status, 401);
  assert.equal((await fetch(gpl.url)).status, 401, 'a guest link signed before the switch no longer opens the game');
  for (const path of ['save', 'stats', 'score', 'record', 'beat']) assert.equal((await gsvc(path, { op: 'get', key: 'slot1', name: 'x', board: 'b' })).status, 401, `${path} still open to a guest`);
  const gws = await new Promise((res) => { const w = new WebSocket(`${BASE.replace('http', 'ws')}/api/rt/room?room=g&t=${gt}`); w.onopen = () => { w.close(); res('open'); }; w.onerror = () => res('refused'); w.onclose = () => res('refused'); });
  assert.equal(gws, 'refused');
  assert.equal((await svc('save', { op: 'set', key: 'acct', value: 1 })).ok, true);   // accounts are not affected
  ok('require login to play: on refuses visitors; off lets guests play free games with their own saves, short sessions, no reviews; back on ends every guest service at once');

  // paid game: purchase required, checkout, webhook, split, refund path
  const priced = await tool('update_project', { project: pid, price_cents: 499 });
  assert.equal(priced.creator_receives_per_sale, '$4.49');
  await tool('update_project', { project: pid, price_cents: 50 }, true);
  assert.equal((await B.post(`/api/games/${slug}/play`)).status, 402);
  ok('paid game: playing without buying is refused');

  // free trial: per account, enforced on the server, reloading costs time, services refused once it is used
  assert.equal((await A.patch(`/api/console/projects/${pid}`, { trial_minutes: 9999 })).status, 400);
  const trialSet = await tool('update_project', { project: pid, trial_minutes: 1 });
  assert.ok(String(trialSet.free_trial).startsWith('1 min'), JSON.stringify(trialSet));
  assert.equal(must(await B.get(`/api/games/${slug}`)).trial.remaining_seconds, 60);
  assert.equal(must(await B.get('/api/games?price=trial')).games.some((x) => x.slug === slug && x.trial_minutes === 1), true);
  const tp1 = must(await B.post(`/api/games/${slug}/play`));
  assert.equal(tp1.trial.remaining_seconds, 60);
  const tt1 = new URL(tp1.url).searchParams.get('gcp_t'), tbody = JSON.parse(Buffer.from(tt1.split('.')[0], 'base64url').toString());
  assert.ok(tbody.tr === 1 && tbody.x <= Math.floor(Date.now() / 1000) + 81, JSON.stringify(tbody));   // the token ends with the trial
  assert.equal((await fetch(tp1.url)).status, 200);
  const tsvc = (tk, path, body) => fetch(`${BASE}/api/rt/${path}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ t: tk, ...body }) });
  assert.equal((await tsvc(tt1, 'save', { op: 'set', key: 'trial', value: 1 })).status, 200);
  const tb1 = await (await tsvc(tt1, 'beat', { frames: 5, active: true, first: true })).json();
  assert.ok(tb1.trial && tb1.trial.over === false && tb1.trial.remaining_seconds >= 58, JSON.stringify(tb1));   // the 30 s charged up front is still this session's to play
  let tdetail = must(await B.get(`/api/games/${slug}`));
  assert.equal(tdetail.trial.used_seconds, 30); assert.equal(tdetail.owned, false);
  const tp2 = must(await B.post(`/api/games/${slug}/play`)), tt2 = new URL(tp2.url).searchParams.get('gcp_t');   // a reload, or another device
  assert.equal(tp2.trial.remaining_seconds, 30);
  const tb2 = await (await tsvc(tt2, 'beat', { frames: 5, active: true, first: true })).json();
  assert.ok(tb2.trial.over === false && tb2.trial.remaining_seconds >= 28, JSON.stringify(tb2));   // the new session keeps the 30 s it was charged
  const tp3 = await B.post(`/api/games/${slug}/play`);
  assert.equal(tp3.status, 402); assert.equal(tp3.json.code, 'trial_over');   // but no further session starts
  await sleep(31000);
  const tb3 = await (await tsvc(tt2, 'beat', { frames: 9, active: true })).json();
  assert.ok(tb3.trial.over === true && tb3.trial.remaining_seconds === 0, JSON.stringify(tb3));
  assert.equal((await tsvc(tt1, 'save', { op: 'get', key: 'trial' })).status, 402);
  assert.equal((await tsvc(tt2, 'score', { op: 'submit', board: 'x', score: 1 })).status, 402);
  tdetail = must(await B.get(`/api/games/${slug}`));
  assert.equal(tdetail.trial.over, true);
  const cons = must(await A.get(`/api/console/projects/${pid}`));
  assert.ok(cons.trial.minutes === 1 && cons.trial.active && cons.trial.players === 1 && cons.trial.bought === 0, JSON.stringify(cons.trial));
  assert.equal((await tool('get_stats', { project: pid })).free_trial.players, 1);
  ok('free trial: creator sets it from the console or the agent, a player plays it, each session costs at least 30 s, the time is shared across sessions, saves and scores refused and no new session once it is used');

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
  const bought = must(await B.post(`/api/games/${slug}/play`));
  assert.equal(bought.trial, undefined); assert.equal(must(await B.get(`/api/games/${slug}`)).trial, null);
  assert.equal(must(await A.get(`/api/console/projects/${pid}`)).trial.bought, 1);
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
  await tool('upload_files', { project: pid, edits: [{ path: 'index.html', old_string: '<title>Shard Island</title>', new_string: '<title>Shard Island II</title>' }] });
  let d2 = await tool('deploy_preview', { project: pid, note: 'second' });
  for (let i = 0; i < 40 && ['queued', 'deploying', 'verifying'].includes(d2.status); i++) { await sleep(2000); d2 = await tool('list_versions', { project: pid, version: d2.version }); }
  assert.equal(d2.status, 'verified'); assert.equal(d2.version, 2);
  assert.equal((await tool('publish', { project: pid })).version, 2);
  assert.equal((await tool('rollback', { project: pid, version: 1 })).version, 1);
  const vs = await tool('list_versions', { project: pid });
  assert.equal(vs.live_version, 1); assert.equal(vs.versions.length, 2);
  const stats = await tool('get_stats', { project: pid });
  assert.equal(stats.plays, 1); assert.ok(stats.runtime_errors.some((e) => /demo error/.test(e.message)));   // plays: the first play; the same player's free-trial session within the hour adds none
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
  await tool('list_projects', { project: projects.blank }, !isAdmin ? true : false);
  ok('admin: overview, users, games, feature, remove');

  // license gate for a brand-new creator
  const C = client();
  must(await C.post('/api/auth/signup', { email: `new-${run}@example.com`, name: 'Newbie ' + run, password: 'correct horse' }));
  let me = must(await C.get('/api/me')).user;
  assert.equal(me.creator, false); assert.equal(me.license.active, false);
  assert.equal((await C.post('/api/billing/license', { plan: 'monthly' })).status, 400);
  const term = must(await C.post('/api/billing/license', { plan: 'term' }));
  const termSess = sessions.get(term.url.split('/').pop());
  assert.equal(termSess.amount_total, 1000); assert.equal(termSess.metadata.kind, 'creator_fee'); assert.equal(termSess.metadata.plan, 'term');
  const life = must(await C.post('/api/billing/license', { plan: 'lifetime' }));          // a second checkout opened before paying
  const lsess = sessions.get(life.url.split('/').pop());
  assert.equal(lsess.amount_total, 5000); assert.equal(lsess.metadata.plan, 'lifetime');
  assert.equal(must(await C.post('/api/billing/confirm', { session_id: termSess.id })).result, 'creator_fee');
  me = must(await C.get('/api/me')).user;
  assert.equal(me.creator, true); assert.equal(me.license.plan, 'term');
  assert.ok(Math.abs(me.license.until - (Date.now() + 365 * 86400000)) < 120000);
  assert.equal((await C.post('/api/billing/license', { plan: 'lifetime' })).status, 409);   // no other license while one is valid
  const refunds = stripeCalls.filter((x) => x.path === '/v1/refunds').length;
  assert.equal(must(await C.post('/api/billing/confirm', { session_id: lsess.id })).result, 'duplicate_refunded');   // paid the other tab anyway: given back
  assert.equal(stripeCalls.filter((x) => x.path === '/v1/refunds').length, refunds + 1);
  assert.equal(must(await C.get('/api/me')).user.license.plan, 'term');
  ok('creator license: time-limited $10 for a year by checkout, the lifetime one refused and refunded while it is valid');

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

  // open implementation: another creator's agent learns how a live game is built only when its creator opts in, never its code
  const ctool = async (name, args, expectError = false) => { const r = await drpc(dtok.json.access_token, 'tools/call', { name, arguments: args }); assert.equal(r.status, 200); const x = r.json.result; assert.equal(!!x.isError, expectError, `${name}: ${x.content[0].text.slice(0, 400)}`); try { return JSON.parse(x.content[0].text); } catch { return x.content[0].text; } };
  assert.match(await ctool('get_implementation', { game: slug }, true), /no open implementation/);
  assert.ok(!(await ctool('find_implementations', {})).games.some((g) => g.game === slug));
  const own = await tool('get_implementation', { game: slug });
  assert.ok(own.yours && own.shared === false && /Preview only/.test(own.not_shared) && own.built_with.engine === 'three.js' && own.built_with.rendering.includes('WebGL'), JSON.stringify(own).slice(0, 600));
  assert.match((await tool('update_project', { project: pid, open_implementation: true })).open_implementation, /^on/);
  const found = await ctool('find_implementations', { query: 'island', uses: ['WebGL'] });
  const hit = found.games.find((g) => g.game === slug);
  assert.ok(hit && hit.engine === 'three.js' && hit.summary.length > 40 && /never shared/.test(found.note), JSON.stringify(found).slice(0, 600));
  assert.equal((await ctool('find_implementations', { engine: 'phaser' })).games.some((g) => g.game === slug), false);
  const icard = await ctool('get_implementation', { game: `${BASE}/g/${slug}` });
  assert.ok(icard.game.slug === slug && icard.built_with.engine === 'three.js' && icard.built_with.input.length && icard.summary.length > 200 && /never shared/.test(icard.never_shared) && !icard.yours, JSON.stringify(icard).slice(0, 600));
  const src = readFileSync(new URL('three-explorer/src/main.js', tplDir), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.length > 30);
  const cardText = JSON.stringify(icard);
  assert.ok(src.every((l) => !cardText.includes(l)), 'the card must not contain source code');
  const conImpl = must(await A.get(`/api/console/projects/${pid}`));
  assert.ok(conImpl.project.open_implementation === true && conImpl.implementation.reads >= 1 && conImpl.implementation.version === 1, JSON.stringify(conImpl.implementation));
  assert.equal(must(await A.get(`/api/console/projects/${pid}/implementation`)).card.shared, true);
  assert.ok([403, 404].includes((await B.get(`/api/console/projects/${pid}/implementation`)).status));
  assert.equal(must(await B.get(`/api/games/${slug}`)).game.open_implementation, true);
  must(await A.patch(`/api/console/projects/${pid}`, { open_implementation: false }));
  assert.match(await ctool('get_implementation', { game: slug }, true), /no open implementation/);
  assert.ok(!(await ctool('find_implementations', { query: 'island' })).games.some((g) => g.game === slug));
  const repub = await tool('publish', { project: pid, version: 1, open_implementation: true });
  assert.match(repub.open_implementation, /^on/);
  assert.equal((await ctool('get_implementation', { game: slug })).version, 1);
  ok(`open implementation: hidden until the creator opts in, then found by kind and technique and read as a card with no code (${icard.built_with.engine}, ${icard.built_with.input.join(', ')}), counted, and gone again when switched off; publish can opt in`);

  // duplication check: a renamed copy of another creator's live game and a page that is not a game are refused before publishing
  const fix = (f) => readFileSync(new URL(`fixtures/comet-herder/${f}`, import.meta.url), 'utf8');
  const waitV = async (call, project, d) => { for (let i = 0; i < 60 && ['queued', 'deploying', 'verifying'].includes(d.status); i++) { await sleep(2000); d = await call('list_versions', { project, version: d.version }); } return d; };
  const orig = await tool('create_project', { title: `Comet Herder ${run}`, tagline: 'Herd comets into the corral', tags: ['arcade', 'space'] });   // one tag besides the genre: publishing asks for a second
  await tool('upload_files', { project: orig.project, files: [{ path: 'index.html', content: fix('index.html') }, { path: 'game.js', content: fix('game.js') }] });
  const ov = await waitV(tool, orig.project, await tool('deploy_preview', { project: orig.project, note: 'original' }));
  assert.equal(ov.status, 'verified', JSON.stringify(ov.report, null, 1).slice(0, 1500));
  assert.ok(ov.report.checks.find((c) => c.id === 'original').ok && ov.report.checks.find((c) => c.id === 'is_game').ok, JSON.stringify(ov.report.checks));
  // publishing is refused until the store metadata is complete; the checklist walks through it, and the next version publishes
  const refusedMeta = await rpc('tools/call', { name: 'publish', arguments: { project: orig.project } });
  assert.ok(refusedMeta.isError && /store metadata is complete/.test(refusedMeta.content[0].text) && /languages/.test(refusedMeta.content[0].text) && /at least 2 from the platform list/.test(refusedMeta.content[0].text) && !/Missing: genre/.test(refusedMeta.content[0].text), refusedMeta.content[0].text.slice(0, 800));
  const mchk = await tool('game_metadata', { project: orig.project });
  assert.equal(mchk.checklist.length, 11);
  assert.deepEqual(mchk.checklist.filter((x) => x.required && x.status === 'missing').map((x) => x.field), ['tags', 'requirements', 'languages', 'players', 'content']);
  assert.ok(mchk.checklist.find((x) => x.field === 'tags').suggestion.includes('2d') && mchk.checklist.find((x) => x.field === 'tags').allowed.style.includes('pixel-art'), JSON.stringify(mchk.checklist[1]));
  // tags come only from the platform list: other words are refused with the closest ones, aliases are mapped
  const offList = await rpc('tools/call', { name: 'game_metadata', arguments: { project: orig.project, action: 'declare', tags: ['spaceship', 'retro'] } });
  assert.ok(offList.isError && /platform list/.test(offList.content[0].text) && /space/.test(offList.content[0].text), offList.content[0].text.slice(0, 400));
  assert.deepEqual((await tool('game_metadata', { project: orig.project, action: 'declare', tags: ['Space', 'pixel', 'chill'] })).listing.tags, ['space', 'pixel-art', 'relaxing']);
  assert.ok(mchk.checklist.every((x) => x.status === 'done' || (x.call && x.ask && x.allowed)), JSON.stringify(mchk.checklist).slice(0, 800));
  assert.equal((await rpc('tools/call', { name: 'game_metadata', arguments: { project: orig.project, action: 'declare', players: { min: 0, max: 1, modes: ['solo'] }, content: { violence: 'extreme' } } })).isError, true);
  const decl = await declareMeta(tool, orig.project, { content: { violence: 'cartoon' }, session_minutes: 5, accessibility: ['pause-anytime'] });
  assert.ok(decl, JSON.stringify(decl).slice(0, 400));
  const ov2 = await waitV(tool, orig.project, await tool('deploy_preview', { project: orig.project, note: 'with metadata' }));
  assert.equal(ov2.status, 'verified', JSON.stringify(ov2.report?.checks || ov2).slice(0, 800));
  assert.equal((await tool('publish', { project: orig.project })).live, true);
  const origSlug = (await tool('list_projects', { project: orig.project })).slug;
  const renamed = fix('game.js').replace(/\b(tug|comets|debris|herded|hull|corral|steer|advance|paint|newRound|chance|pen|stars|flash|held)\b/g, (w) => 'my' + w[0].toUpperCase() + w.slice(1)).replace(/^\s*\/\/.*$/gm, '').replace(/0\.(\d)\b/g, '0.$15');
  const cp = await ctool('create_project', { title: `Star Wrangler ${run}`, tagline: 'Totally new' });
  await ctool('upload_files', { project: cp.project, files: [{ path: 'index.html', content: fix('index.html').replace('Comet Herder', 'Star Wrangler') }, { path: 'game.js', content: renamed }] });
  const cv = await waitV(ctool, cp.project, await ctool('deploy_preview', { project: cp.project, note: 'copy' }));
  const orc = cv.report.checks.find((c) => c.id === 'original');
  assert.ok(cv.status === 'failed' && orc && !orc.ok && orc.detail.includes(origSlug) && cv.report.checks.filter((c) => !c.ok).length === 1, JSON.stringify(cv.report.checks || cv.report).slice(0, 1500));
  assert.match(await ctool('publish', { project: cp.project }, true), /not passed verification|matches/i);
  const page = '<!doctype html><html><body style="margin:0;background:#111;color:#eee;font:16px sans-serif"><canvas id="c" width="640" height="200"></canvas><h1>Get the Comet app</h1><p>Our new app is coming soon to phones.</p><script>const c = document.getElementById("c").getContext("2d"); let t = 0; function f() { t += 0.02; c.fillStyle = "#123"; c.fillRect(0, 0, 640, 200); for (let i = 0; i < 12; i++) { c.fillStyle = `hsl(${i * 30 + t * 50},80%,60%)`; c.beginPath(); c.arc(320 + Math.cos(t + i) * 200, 100 + Math.sin(t * 2 + i) * 60, 14, 0, 7); c.fill(); } requestAnimationFrame(f); } f(); GCP.ready();</script></body></html>';
  const ng = await ctool('create_project', { title: `Comet app ${run}` });
  await ctool('upload_files', { project: ng.project, files: [{ path: 'index.html', content: page }] });
  const nv = await waitV(ctool, ng.project, await ctool('deploy_preview', { project: ng.project, note: 'not a game' }));
  const ig = nv.report.checks.find((c) => c.id === 'is_game');
  assert.ok(nv.status === 'failed' && ig && !ig.ok && nv.report.checks.find((c) => c.id === 'original').ok, JSON.stringify(nv.report.checks || nv.report).slice(0, 1500));
  // the same platform template published by two creators is not a copy: template and kit code is left out
  const tp = await ctool('create_project', { title: `My explorer ${run}` });
  await ctool('upload_files', { project: tp.project, files: tplIndex.templates.find((x) => x.name === 'three-explorer').files.map((f) => ({ path: f.path, content: readFileSync(new URL(`three-explorer/${f.path}`, tplDir), 'utf8') })) });
  const tv = await waitV(ctool, tp.project, await ctool('deploy_preview', { project: tp.project, note: 'from the template' }));
  assert.ok(tv.status === 'verified' && tv.report.checks.find((c) => c.id === 'original').ok, JSON.stringify(tv.report.checks || tv.report).slice(0, 1500));
  const flagged = must(await ADM.get('/api/admin/overview')).flags;
  assert.ok(flagged.some((f) => f.kind === 'copy_flagged' && f.id === cp.project) && flagged.some((f) => f.kind === 'not_game_flagged' && f.id === ng.project), JSON.stringify(flagged).slice(0, 600));
  ok(`duplication check: an original game passes and so does another creator's game built on the same template as a live one; a renamed copy by another creator fails "${orc.label}" (${cv.report.originality.matches[0].code}% of its code) and cannot be published; a page that is not a game fails "${ig.label}"; both show up for the admin`);

  // adult games: allowed when declared, refused when the review sees what the version does not declare, blurred and confirmed in the store
  const adult = await tool('create_project', { title: `After Dark ${run}`, tagline: 'An NSFW arcade for adults', tags: ['arcade'] });
  await tool('upload_files', { project: adult.project, files: [{ path: 'index.html', content: fix('index.html') }, { path: 'game.js', content: fix('game.js') }] });
  await declareMeta(tool, adult.project, { content: {}, tags: ['space', 'pixel-art'] });
  const av1 = await waitV(tool, adult.project, await tool('deploy_preview', { project: adult.project, note: 'undeclared' }));
  const und = av1.report.checks.find((c) => c.id === 'content');
  assert.ok(av1.status === 'failed' && und && !und.ok && und.label === 'Content is declared' && /content\.sexual "none"/.test(und.detail) && /game_metadata/.test(und.hint) && av1.report.content.undeclared, JSON.stringify(av1.report.checks).slice(0, 1500));
  assert.ok(av1.report.frames.length >= 3, `review frames: ${JSON.stringify(av1.report.frames)}`);
  assert.match(await tool('publish', { project: adult.project }, true), /not passed verification|cannot be published/i);
  await tool('game_metadata', { project: adult.project, action: 'declare', content: { sexual: 'explicit', violence: 'cartoon' } });
  const am = await tool('game_metadata', { project: adult.project });
  const av2 = await waitV(tool, adult.project, await tool('deploy_preview', { project: adult.project, note: 'declared' }));
  assert.equal(av2.status, 'verified', JSON.stringify(av2.report?.checks || av2).slice(0, 1200));
  assert.ok(/18\+/.test(JSON.stringify(am)), JSON.stringify(am).slice(0, 600));
  assert.equal((await tool('publish', { project: adult.project })).live, true);
  const aslug = (await tool('list_projects', { project: adult.project })).slug;
  for (let i = 0; i < 30 && !(must(await B.get(`/api/games/${aslug}`)).game.status === 'live'); i++) await sleep(1000);
  const ag = must(await B.get(`/api/games/${aslug}`));
  assert.deepEqual(ag.mature, ['sexual']); assert.equal(ag.meta.rating.age, 18); assert.deepEqual(ag.game.mature, ['sexual']); assert.equal(ag.game.age, 18);
  const listed = must(await B.get(`/api/games?q=${encodeURIComponent('After Dark ' + run)}`)).games;
  assert.deepEqual(listed[0].mature, ['sexual']);
  assert.deepEqual(must(await B.get(`/api/games?q=${encodeURIComponent('Comet Herder ' + run)}`)).games[0].mature, []);
  const noConfirm = await B.post(`/api/games/${aslug}/play`);
  assert.ok(noConfirm.status === 428 && noConfirm.json.code === 'mature_confirm', noConfirm.text);
  assert.equal((await B.post(`/api/games/${aslug}/play`, { confirm_mature: false })).status, 428);
  assert.ok(must(await B.post(`/api/games/${aslug}/play`, { confirm_mature: true })).url);
  assert.ok(must(await B.post(`/api/games/${origSlug}/play`)).url, 'a game for everyone needs no confirmation');
  // the admin can switch adult games off: a version that declares them is refused
  must(await ADM.put('/api/admin/settings', { mature_allowed: false }));
  const av3 = await waitV(tool, adult.project, await tool('deploy_preview', { project: adult.project, note: 'adult games off' }));
  assert.ok(av3.status === 'failed' && /does not take adult games/.test(av3.report.checks.find((c) => c.id === 'content').detail), JSON.stringify(av3.report.checks).slice(0, 800));
  must(await ADM.put('/api/admin/settings', { mature_allowed: true }));
  ok(`adult games: undeclared sexual content fails "${und.label}" (reviewed from ${av1.report.frames.length} frames of play), declared it verifies and publishes as 18+ (sexual), listings mark it, play needs the player's confirmation (428 without), and the admin can switch adult games off`);
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

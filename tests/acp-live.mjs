// The ACP workbench end to end against a running Worker (local: npm run build && npx wrangler dev, DEV_MAIL=1):
// the real bridge CLI pairs a machine, starts the mock ACP agent, relays through the AcpHub, and its MCP proxy reaches
// /mcp with the grant it was given. Two console pages watch at once. Then the security edges: another site's page, a
// player without a creator license, a wrong secret, a removed machine, a stopped run, and a burst of traffic.
//   node tests/acp-live.mjs            (BASE defaults to http://127.0.0.1:8787)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
const run = randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2)} ${msg}`);
const BRIDGE = fileURLToPath(new URL('../acp-bridge/bin/hearthcade-acp.mjs', import.meta.url));
const MOCK = fileURLToPath(new URL('./acp-mock-agent.mjs', import.meta.url));

function client() {
  const jar = new Map();
  const call = async (method, path, body) => {
    const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), origin: BASE, cookie: cookie() }, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, json, text };
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p), call, cookie };
}
const must = (r, code = 200) => { assert.equal(r.status, code, `expected ${code}, got ${r.status}: ${r.text.slice(0, 300)}`); return r.json; };
async function lastMail(to, kind) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${BASE}/api/dev/mail?to=${encodeURIComponent(to)}`);
    const m = (await r.json()).mail.filter((x) => kind.test(x.text)).pop();
    if (m) return m; await sleep(100);
  }
  throw new Error('no mail to ' + to);
}
async function signUp(cl, email, name) {
  must(await cl.post('/api/auth/signup', { email, name }));
  const token = (await lastMail(email, /\/verify\?token=/)).text.match(/\/verify\?token=([\w-]+)/)[1];
  return must(await cl.post('/api/auth/signup/confirm', { token }));
}

/** A console page: the workbench's WebSocket, with a log of everything it received. */
function view(cl, origin = BASE) {
  const ws = new WebSocket(`${WS_BASE}/api/acp/ws`, { headers: { cookie: cl.cookie(), origin } });
  const got = []; let rid = 0;
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  const until = async (pred, ms = 15000) => { const end = Date.now() + ms; for (;;) { const i = got.findIndex(pred); if (i >= 0) return got[i]; if (Date.now() > end) throw new Error('timed out; last: ' + JSON.stringify(got.slice(-4)).slice(0, 900)); await sleep(10); } };
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); ws.onclose = (e) => rej(new Error('closed ' + e.code)); });
  const send = (m) => ws.send(JSON.stringify(m));
  const rpc = async (b, method, params) => { const id = 'r' + ++rid + Math.random(); send({ b, type: 'rpc', id, method, params }); return until((m) => m.type === 'rpc_result' && m.id === id, 30000); };
  return { ws, got, until, opened, send, rpc };
}

// the catalog the bridges see: one known agent, the mock, so "Add an agent" can start it from a page
const CATALOG_FILE = join(mkdtempSync(join(tmpdir(), 'acp-cat-')), 'agents.json');
writeFileSync(CATALOG_FILE, JSON.stringify({ agents: [{ id: 'mock2', name: 'Mock Two', description: 'test', launch: { bin: process.execPath, args: [MOCK] } }] }));

function startBridge(home, extra = []) {
  const out = [];
  const p = spawn(process.execPath, [BRIDGE, '--server', BASE, ...extra, '--', process.execPath, MOCK], { env: { ...process.env, HOME: home, USERPROFILE: home, HEARTHCADE_NO_BROWSER: '1', NO_COLOR: '1', HEARTHCADE_ACP_AGENTS: CATALOG_FILE }, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
  p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => out.push(d));
  const text = () => out.join('');
  const wait = async (re, ms = 20000) => { const end = Date.now() + ms; for (;;) { const m = text().match(re); if (m) return m; if (Date.now() > end) throw new Error(`bridge never printed ${re}:\n${text()}`); await sleep(50); } };
  const exited = new Promise((res) => p.on('exit', (code) => res(code)));
  return { p, text, wait, exited };
}

async function main() {
  console.log(`ACP workbench against ${BASE}`);
  const owner = client();
  await signUp(owner, `acp-${run}@example.com`, `Acp ${run}`);
  // a creator: the first admin is one (local dev); otherwise this test needs a licensed account
  const claim = await owner.post('/api/claim-admin', { token: process.env.ADMIN_CLAIM_TOKEN || 'dev-claim' });
  let me = must(await owner.get('/api/me')).user;
  if (!me.creator && process.env.ADMIN_EMAIL) {
    // the admin was claimed already (a reused local D1): sign the admin in with an email code and grant a license
    const admin = client();
    const { challenge } = must(await admin.post('/api/auth/login', { email: process.env.ADMIN_EMAIL }));
    const code = (await lastMail(process.env.ADMIN_EMAIL, /sign-in code is \d{6}/)).text.match(/sign-in code is (\d{6})/)[1];
    must(await admin.post('/api/auth/login/verify', { challenge, code }));
    must(await admin.call('PATCH', `/api/admin/users/${me.id}`, { license: 'lifetime' }));
    me = must(await owner.get('/api/me')).user;
  }
  if (!me.creator) { console.log('  (this account is not a creator: use a fresh local D1, or set ADMIN_EMAIL to an admin account)', claim.status); process.exit(2); }
  ok('signed up a creator');

  // ---- pairing a machine ----------------------------------------------------------------------------------------------
  const home = mkdtempSync(join(tmpdir(), 'acp-home-'));
  const b1 = startBridge(home);
  const [, code] = await b1.wait(/code is ([A-Z]{4}-[A-Z]{4})/);
  const info = must(await owner.get(`/api/acp/pair/${code}`));
  assert.equal(info.agent, process.execPath.split(/[\\/]/).pop());   // a custom agent is named after its program
  assert.ok(info.host);
  // another creator cannot see or approve it, a stranger's code guess is refused
  const other = client(); await signUp(other, `acp2-${run}@example.com`, `Other ${run}`);
  assert.equal((await other.get(`/api/acp/pair/${code}`)).status, 403, 'a player without a creator license cannot pair');
  must(await owner.get('/api/acp/pair/ABCD-EFGH'), 404);
  must(await owner.post(`/api/acp/pair/${code}`, { decision: 'approve' }));
  await b1.wait(/Connected as/);
  const cred = JSON.parse(readFileSync(join(home, '.hearthcade', 'workbench.json'), 'utf8'))[BASE];
  assert.ok(cred.secret.startsWith('hcw_'));
  must(await owner.post(`/api/acp/pair/${code}`, { decision: 'approve' }), 404);   // a code works once
  ok('paired a machine with a code approved in the console');

  // ---- a page joins and drives the agent ----------------------------------------------------------------------------
  await b1.wait(/Connected to the console/);
  const v1 = view(owner); await v1.opened;
  const welcome = await v1.until((m) => m.type === 'welcome' || m.type === 'bridges');
  void welcome;
  const bridges = (await v1.until((m) => (m.type === 'bridges' || m.type === 'welcome') && m.bridges.some((b) => b.agent))).bridges;
  const B = bridges.find((b) => b.agent).id;
  v1.send({ b: B, type: 'hello' });
  const st = await v1.until((m) => m.type === 'state' && m.status === 'ready', 20000).catch(async () => { v1.send({ b: B, type: 'hello' }); return v1.until((m) => m.type === 'state' && m.status === 'ready', 20000); });
  assert.equal(st.init.agentInfo.name, 'mock-agent');
  assert.equal(st.b, B);
  ok('a console page sees the bridge and the agent is ready');

  const s = await v1.rpc(B, 'session/new', {});
  const sid = s.result.sessionId;
  assert.ok(sid);
  assert.equal(s.result._seen.mcpServers[0].name, 'hearthcade');
  assert.match(s.result._seen.mcpServers[0].url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\//);
  assert.deepEqual(s.result._seen.mcpServers[0].headers, [], 'the access token never reaches the agent');
  assert.match(s.result._seen.systemPrompt.content[0].text, /HearthCade workbench/);
  const hi = await v1.rpc(B, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hello' }] });
  assert.equal(hi.result.stopReason, 'end_turn');
  const streamed = v1.got.filter((m) => m.type === 'update' && m.sessionId === sid && m.entry.sessionUpdate === 'agent_message_chunk').map((m) => m.entry.content.text).join('');
  assert.equal(streamed, 'You said: hello');
  ok('session, prompt and a streamed answer through the relay');

  // the agent calls HearthCade's MCP server through the bridge's local proxy, with the grant it was given
  const mcp = await v1.rpc(B, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'mcp' }] });
  assert.equal(mcp.result.stopReason, 'end_turn');
  const said = v1.got.filter((m) => m.type === 'update' && m.entry.sessionUpdate === 'agent_message_chunk').map((m) => m.entry.content.text).join('');
  assert.match(said, /http 200 .*"serverInfo"/s, said.slice(-400));
  ok('the agent reaches the HearthCade MCP server through the local proxy (http 200)');
  // workbench grants stay off the "Connected agents" list
  const agents = must(await owner.get('/console/agents'.replace(/^/, '/api')));
  assert.ok(!agents.agents.some((a) => /^Workbench/.test(a.client)));
  ok('the bridge\'s own grant is not listed under Connected agents');

  // ---- two pages: both see a permission request, one answer wins ------------------------------------------------
  const v2 = view(owner); await v2.opened;
  v2.send({ b: B, type: 'hello' });
  const tr = await v2.until((m) => m.type === 'transcript' && m.sessionId === sid && m.done);
  assert.ok(tr.entries.length >= 4);
  const pid = 'p' + Math.random(); v1.send({ b: B, type: 'rpc', id: pid, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'edit' }] } });
  const a1 = await v1.until((m) => m.type === 'ask'), a2 = await v2.until((m) => m.type === 'ask' && m.key === a1.key);
  v2.send({ b: B, type: 'answer', key: a2.key, optionId: 'allow' });
  v1.send({ b: B, type: 'answer', key: a1.key, optionId: 'reject' });
  const ans1 = await v1.until((m) => m.type === 'answered' && m.key === a1.key);
  assert.equal(ans1.optionId, 'allow');
  const end = await v1.until((m) => m.type === 'rpc_result' && m.id === pid);
  assert.equal(end.result.stopReason, 'end_turn');
  assert.ok(v2.got.some((m) => m.type === 'update' && m.entry.sessionUpdate === 'tool_call_update' && m.entry.status === 'completed'));
  assert.ok(!v2.got.some((m) => m.type === 'rpc_result' && m.id === pid), 'answers go only to the page that asked');
  ok('two pages: both see the request, the first answer wins, results go to the asker');

  // ---- security edges ---------------------------------------------------------------------------------------------
  const evil = view(owner, 'https://evil.example');
  await assert.rejects(evil.opened);
  const player = view(other); await assert.rejects(player.opened);
  const bad = await fetch(`${BASE}/acp/v1/bridges`, { method: 'POST', headers: { authorization: 'Bearer hcw_wrong', 'content-type': 'application/json' }, body: '{"bridge":"aaaaaaaaaa"}' });
  assert.equal(bad.status, 401);
  const badWs = new WebSocket(`${WS_BASE}/acp/v1/ws?bridge=aaaaaaaaaa`, { headers: { authorization: `Bearer ${cred.secret}` } });
  await new Promise((res) => { badWs.onclose = res; badWs.onerror = res; });
  // a bridge whose socket would not open asks over plain HTTP why: an ended run, a wrong secret, or just not a socket
  assert.equal((await fetch(`${BASE}/acp/v1/ws?bridge=aaaaaaaaaa`, { headers: { authorization: `Bearer ${cred.secret}` } })).status, 410);
  assert.equal((await fetch(`${BASE}/acp/v1/ws?bridge=aaaaaaaaaa`, { headers: { authorization: 'Bearer hcw_wrong' } })).status, 401);
  // a page cannot reach a bridge of another account (the hub is per account) or send what the agent does not allow
  const fsr = await v1.rpc(B, 'fs/write_text_file', { path: '/etc/passwd', content: 'x' });
  assert.equal(fsr.error.code, -32601);
  ok('refused: another site\'s page, a player, a wrong secret, an unknown run, fs and terminal calls');

  // ---- stress: 6 sessions at once and 200 quick turns, a 3 MB answer --------------------------------------------
  const t0 = Date.now();
  const sids = [];
  for (let i = 0; i < 6; i++) sids.push((await v1.rpc(B, 'session/new', {})).result.sessionId);
  const res = await Promise.all(sids.map((x, i) => (i % 2 ? v1 : v2).rpc(B, 'session/prompt', { sessionId: x, prompt: [{ type: 'text', text: i === 0 ? 'big 3072' : 'plan' }] })));
  assert.ok(res.every((r) => r.result?.stopReason === 'end_turn'));
  for (let n = 0; n < 200; n++) assert.equal((await v2.rpc(B, 'session/prompt', { sessionId: sids[1], prompt: [{ type: 'text', text: 'n' + n }] })).result.stopReason, 'end_turn');
  ok(`stress: 6 parallel sessions, a 3 MB answer and 200 turns in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // ---- Add an agent: a page starts another known agent in the same folder; one of each; the page can stop it ------
  assert.equal(bridges.find((b) => b.id === B).launch, true, 'the first bridge in a folder can start others');
  v1.send({ b: B, type: 'launch', id: 'L1', agentId: 'mock2' });
  assert.equal((await v1.until((m) => m.type === 'launch_result' && m.id === 'L1')).ok, true);
  const two = (await v1.until((m) => m.type === 'bridges' && m.bridges.some((b) => b.agentId === 'mock2'), 20000)).bridges;
  const C = two.find((b) => b.agentId === 'mock2');
  assert.equal(C.child, true); assert.ok(!C.launch); assert.equal(C.cwd, two.find((b) => b.id === B).cwd);
  v1.send({ b: C.id, type: 'hello' });
  await v1.until((m) => m.type === 'state' && m.b === C.id && m.status === 'ready', 20000).catch(async () => { v1.send({ b: C.id, type: 'hello' }); return v1.until((m) => m.b === C.id && m.type === 'status' && m.status === 'ready', 20000); });
  const cs = await v1.rpc(C.id, 'session/new', {});
  assert.equal((await v1.rpc(C.id, 'session/prompt', { sessionId: cs.result.sessionId, prompt: [{ type: 'text', text: 'hi' }] })).result.stopReason, 'end_turn');
  v1.send({ b: B, type: 'launch', id: 'L2', agentId: 'mock2' });
  assert.match((await v1.until((m) => m.type === 'launch_result' && m.id === 'L2')).error, /already running/);
  v1.send({ b: B, type: 'launch', id: 'L3', agentId: 'not-in-the-list' });
  assert.match((await v1.until((m) => m.type === 'launch_result' && m.id === 'L3')).error, /Unknown agent/);
  v1.send({ b: C.id, type: 'launch', id: 'L4', agentId: 'mock2' });
  assert.equal((await v1.until((m) => m.type === 'launch_result' && m.id === 'L4')).ok, false, 'a started agent does not start others');
  v1.send({ b: B, type: 'quit' });   // the first one ignores it: it stops only from its terminal
  v1.send({ b: C.id, type: 'quit' });
  await v1.until((m) => m.type === 'bridges' && !m.bridges.some((b) => b.agentId === 'mock2'), 20000);
  await b1.wait(/Mock Two stopped/);
  assert.ok(v1.got.filter((m) => m.type === 'bridges').at(-1).bridges.some((b) => b.id === B), 'the first agent keeps running');
  ok('a page starts another known agent in the same folder, one of each, and stops it');

  // ---- a second agent on the same machine, then removing the machine --------------------------------------------
  const b2 = startBridge(home);
  await b2.wait(/Connected to the console/);
  const both = await v1.until((m) => m.type === 'bridges' && m.bridges.filter((b) => b.agent).length === 2);
  assert.equal(both.bridges.length, 2);
  ok('a second agent joins without pairing again (the machine is remembered)');
  const links = must(await owner.get('/api/acp/overview')).links;
  assert.equal(links.length, 1);
  must(await owner.del(`/api/acp/links/${links[0].id}`));
  const [c1, c2] = await Promise.all([b1.exited, b2.exited]);
  assert.equal(c1, 1); assert.equal(c2, 1);
  assert.match(b1.text(), /disconnected in the console/);
  assert.ok(!existsSync(join(home, '.hearthcade', 'workbench.json')), 'the bridge forgets a removed machine');
  await v1.until((m) => m.type === 'bridges' && m.bridges.length === 0);
  const gone = await fetch(`${BASE}/acp/v1/bridges`, { method: 'POST', headers: { authorization: `Bearer ${cred.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ bridge: 'zzzzzzzzzz' }) });
  assert.equal(gone.status, 401);
  ok('removing the machine stops its agents at once, and its secret stops working');

  // ---- Ctrl+C: the run's grant is revoked -------------------------------------------------------------------------
  const home2 = mkdtempSync(join(tmpdir(), 'acp-home-'));
  const b3 = startBridge(home2);
  const [, code3] = await b3.wait(/code is ([A-Z]{4}-[A-Z]{4})/);
  must(await owner.post(`/api/acp/pair/${code3}`, { decision: 'approve', project_scope: 'all' }));
  await b3.wait(/Connected to the console/);
  b3.p.kill('SIGINT');
  assert.equal(await b3.exited, 0);
  ok('a bridge stopped with Ctrl+C exits cleanly');
  // a declined code
  const b4 = startBridge(mkdtempSync(join(tmpdir(), 'acp-home-')));
  const [, code4] = await b4.wait(/code is ([A-Z]{4}-[A-Z]{4})/);
  must(await owner.post(`/api/acp/pair/${code4}`, { decision: 'deny' }));
  assert.equal(await b4.exited, 1);
  assert.match(b4.text(), /declined/);
  ok('a declined code ends the bridge with a clear message');

  v1.ws.close(); v2.ws.close();
  console.log(`\nACP workbench: ${step} checks passed`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

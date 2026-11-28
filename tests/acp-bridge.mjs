// The workbench bridge's ACP client (acp-bridge/core.mjs) against a real ACP agent process (tests/acp-mock-agent.mjs):
// initialize, sessions, streaming, permission requests answered from several pages at once, cancelling, the method
// allow-list, transcript replay, crashes and restarts, and a burst of traffic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { bundledRegistry, findAgent, installBinary, launchPlan, platformKey, unzip } from '../acp-bridge/registry.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { estimateSize, watchNpxDownload } from '../acp-bridge/download.mjs';
import { BridgeCore, VIEW_METHODS, agentError, splitCommand, systemFolder, winCommandLine } from '../acp-bridge/core.mjs';

const MOCK = fileURLToPath(new URL('./acp-mock-agent.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness(env = {}, extra = {}) {
  const out = [];
  const cwd = mkdtempSync(join(tmpdir(), 'acp-'));
  const core = new BridgeCore({
    agent: { id: 'mock', name: 'Mock', command: process.execPath, args: [MOCK], env },
    cwd, send: (m) => out.push(structuredClone(m)), systemPrompt: 'You are in the test workbench.',
    mcp: { http: 'http://127.0.0.1:9/mcp/x', stdio: { command: process.execPath, args: ['-e', '0'] } }, ...extra,
  });
  const until = async (pred, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) { const hit = out.find(pred); if (hit) return hit; if (Date.now() > end) throw new Error('timed out; got ' + JSON.stringify(out.slice(-5)).slice(0, 800)); await sleep(5); }
  };
  let rid = 0;
  const rpc = async (from, method, params) => {
    const id = ++rid; core.onView({ type: 'rpc', from, id, method, params });
    const r = await until((m) => m.type === 'rpc_result' && m.id === id && m.to === from, 10000);
    return r;
  };
  return { core, out, until, rpc, cwd };
}

// a .zip with the given files (deflated), as the registry's archives are
function makeZip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, text, mode = 0o644] of files) {
    const raw = Buffer.from(text), data = deflateRawSync(raw), n = Buffer.from(name);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x031e, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); c.writeUInt32LE(off, 42);
    locals.push(l, n, data); centrals.push(c, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

test('registry: the official ACP Registry, every agent starts somewhere; commands split like a shell', () => {
  const cat = bundledRegistry();
  assert.ok(cat.length >= 40);
  const ids = new Set();
  for (const a of cat) {
    assert.ok(!ids.has(a.id), 'duplicate id ' + a.id); ids.add(a.id);
    assert.ok(a.name && a.version && a.description, a.id);
    const ok = ['darwin', 'linux', 'win32'].some((p) => ['x64', 'arm64'].some((c) => !launchPlan(a, { platform: p, arch: c, musl: false }).error));
    assert.ok(ok, a.id + ' starts on no platform');
  }
  assert.ok(!ids.has('github-copilot'), 'the registry leaves the older Copilot entry out');
  for (const id of ['claude-acp', 'codex-acp', 'gemini', 'github-copilot-cli', 'cursor', 'opencode', 'qwen-code', 'goose']) assert.ok(ids.has(id), id);
  const claude = launchPlan(findAgent(cat, 'claude'));
  assert.equal(claude.kind, 'npx');
  assert.match(claude.args[1], /^@agentclientprotocol\/claude-agent-acp@\d/, 'pinned to the registry version');
  assert.equal(findAgent(cat, 'nope'), null);
  // binaries: this platform's build, a musl Linux falls back to glibc, otherwise a clear error
  const bin = { id: 'b', name: 'B', distribution: { binary: { 'linux-x86_64': { archive: 'https://x.test/b.tar.gz', cmd: './b', args: ['acp'] } } } };
  assert.equal(launchPlan(bin, { platform: 'linux', arch: 'x64', musl: true }).kind, 'binary');
  assert.match(launchPlan(bin, { platform: 'win32', arch: 'x64' }).error, /no build for this computer \(windows-x86_64\).*linux-x86_64/);
  assert.equal(platformKey('darwin', 'arm64'), 'darwin-aarch64');
  assert.equal(launchPlan({ distribution: { uvx: { package: 'a==1' } } }).command, 'uvx');
  assert.deepEqual(splitCommand(`my-agent --flag "two words" 'x y' ""`), ['my-agent', '--flag', 'two words', 'x y', '']);
});

test('registry: a binary agent is downloaded once, checked against its SHA-256 and unpacked', async () => {
  const home = mkdtempSync(join(tmpdir(), 'acp-agents-'));
  const zip = makeZip([['dist/agent', '#!/bin/sh\necho hi\n', 0o755], ['dist/README', 'x']]);
  const sha = createHash('sha256').update(zip).digest('hex');
  let gets = 0;
  const fetchImpl = async () => { gets++; return new Response(zip, { headers: { 'content-length': String(zip.length) } }); };
  const entry = { id: 'zipped', name: 'Zipped', version: '1.2.3' };
  const plan = { kind: 'binary', url: 'https://x.test/agent.zip', sha256: sha, cmd: './dist/agent', args: ['acp'], env: {}, platform: 'linux-x86_64' };
  const seen = [];
  const r = await installBinary(entry, plan, { home, fetchImpl, onProgress: (p) => seen.push(p) });
  assert.equal(readFileSync(r.command, 'utf8'), '#!/bin/sh\necho hi\n');
  assert.deepEqual(r.args, ['acp']);
  assert.equal(seen.at(-1).bytes, zip.length);
  if (process.platform !== 'win32') assert.ok(statSync(r.command).mode & 0o100, 'executable');
  await installBinary(entry, plan, { home, fetchImpl });
  assert.equal(gets, 1, 'kept after the first download');
  // a download that does not match the registry is not unpacked
  await assert.rejects(installBinary({ ...entry, version: '2' }, { ...plan, sha256: 'ab'.repeat(32) }, { home, fetchImpl }), /does not match the registry's checksum/);
  assert.ok(!existsSync(join(home, 'zipped', '2', 'linux-x86_64', 'dist')));
  // an archive cannot write outside its folder, nor a command point outside it
  assert.throws(() => unzip(makeZip([['../evil', 'x']]), mkdtempSync(join(tmpdir(), 'acp-z-'))), /outside its folder/);
  await assert.rejects(installBinary(entry, { ...plan, cmd: '../../x' }, { home, fetchImpl }), /outside its folder/);
});

test('initialize, a session with the platform tools, streaming and the transcript', async () => {
  const h = harness();
  await h.core.start();
  assert.equal(h.core.status, 'ready');
  assert.equal(h.core.init.agentInfo.name, 'mock-agent');
  const s = await h.rpc('v1', 'session/new', { cwd: '/etc', mcpServers: [{ name: 'evil', command: '/bin/sh', args: [] }] });
  assert.ok(s.result.sessionId);
  // the page cannot choose the folder or the MCP servers: the bridge's own are used
  assert.equal(s.result._seen.cwd, h.cwd);
  assert.deepEqual(s.result._seen.mcpServers, [{ type: 'http', name: 'hearthcade', url: 'http://127.0.0.1:9/mcp/x', headers: [] }]);
  assert.equal(s.result._seen.systemPrompt.mode, 'append');
  const sid = s.result.sessionId;
  await h.until((m) => m.type === 'session' && m.session.sessionId === sid && m.session.commands.length === 2);
  const r = await h.rpc('v1', 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hello there' }] });
  assert.equal(r.result.stopReason, 'end_turn');
  // the transcript: the user's message (recorded by the bridge), a thought, the answer merged into one entry, the end
  const s2 = h.core.sessions.get(sid);
  const kinds = s2.entries.map((e) => e.sessionUpdate);
  assert.deepEqual(kinds, ['user_message_chunk', 'agent_thought_chunk', 'agent_message_chunk', '_turn_end']);
  assert.equal(s2.entries[2].content.text, 'You said: hello there');
  assert.equal(s2.title, 'hello there');
  // a page that joins later gets the state and the whole transcript
  h.out.length = 0;
  h.core.onView({ type: 'hello', from: 'v2' });
  const st = await h.until((m) => m.type === 'state' && m.to === 'v2');
  assert.equal(st.sessions.length, 1);
  const tr = await h.until((m) => m.type === 'transcript' && m.to === 'v2');
  assert.equal(tr.entries.length, 4); assert.ok(tr.done);
  h.core.stop();
});

test('stdio fallback when the agent cannot reach MCP over HTTP', async () => {
  const h = harness({ MOCK_NO_HTTP: '1' });
  await h.core.start();
  const s = await h.rpc('v1', 'session/new', {});
  assert.deepEqual(s.result._seen.mcpServers, [{ name: 'hearthcade', command: process.execPath, args: ['-e', '0'], env: [] }]);
  h.core.stop();
});

test('permission requests: every page sees them, the first answer wins, others are ignored', async () => {
  const h = harness();
  await h.core.start();
  const sid = (await h.rpc('v1', 'session/new', {})).result.sessionId;
  const id = 99; h.core.onView({ type: 'rpc', from: 'v1', id, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'edit' }] } });
  const askMsg = await h.until((m) => m.type === 'ask');
  assert.equal(askMsg.to, undefined, 'broadcast to every page');
  assert.equal(askMsg.params.options.length, 3);
  // an option the agent did not offer is refused
  h.core.answer(askMsg.key, 'made-up', 'v2');
  assert.ok(h.core.asks.has(askMsg.key));
  // two pages answer at once
  h.core.onView({ type: 'answer', from: 'v2', key: askMsg.key, optionId: 'allow' });
  h.core.onView({ type: 'answer', from: 'v1', key: askMsg.key, optionId: 'reject' });
  const answered = h.out.filter((m) => m.type === 'answered');
  assert.equal(answered.length, 1); assert.equal(answered[0].by, 'v2'); assert.equal(answered[0].optionId, 'allow');
  const done = await h.until((m) => m.type === 'rpc_result' && m.id === id);
  assert.equal(done.result.stopReason, 'end_turn');
  const entries = h.core.sessions.get(sid).entries;
  const diff = entries.find((e) => e.sessionUpdate === 'tool_call_update' && e.status === 'completed');
  assert.equal(diff.content[0].type, 'diff');
  h.core.stop();
});

test('cancel: the turn stops and its open permission request is answered "cancelled"', async () => {
  const h = harness();
  await h.core.start();
  const sid = (await h.rpc('v1', 'session/new', {})).result.sessionId;
  h.core.onView({ type: 'rpc', from: 'v1', id: 7, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'edit' }] } });
  const a = await h.until((m) => m.type === 'ask');
  h.core.onView({ type: 'cancel', from: 'v2', sessionId: sid });
  const ans = await h.until((m) => m.type === 'answered' && m.key === a.key);
  assert.equal(ans.optionId, null);
  const r = await h.until((m) => m.type === 'rpc_result' && m.id === 7);
  assert.equal(r.result.stopReason, 'cancelled');
  assert.equal(h.core.sessions.get(sid).running, false);
  // a long stream is cancelled too
  h.core.onView({ type: 'rpc', from: 'v1', id: 8, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'slow' }] } });
  await sleep(80);
  // a second message while it works is refused, not queued behind it
  const busy = await h.rpc('v2', 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] });
  assert.match(busy.error.message, /still working/);
  h.core.onView({ type: 'cancel', from: 'v1', sessionId: sid });
  const r2 = await h.until((m) => m.type === 'rpc_result' && m.id === 8);
  assert.equal(r2.result.stopReason, 'cancelled');
  h.core.stop();
});

test('only the allowed methods reach the agent', async () => {
  const h = harness();
  await h.core.start();
  for (const m of ['initialize', 'fs/write_text_file', 'terminal/create', '_x/anything', 'session/update']) {
    assert.ok(!VIEW_METHODS.has(m));
    const r = await h.rpc('v1', m, {});
    assert.equal(r.error.code, -32601, m);
  }
  const r = await h.rpc('v1', 'session/prompt', { sessionId: 'nope', prompt: [{ type: 'text', text: 'x' }] });
  assert.match(r.error.message, /Unknown session/);
  const e = await h.rpc('v1', 'session/prompt', { sessionId: 'nope', prompt: [] });
  assert.ok(e.error);
  h.core.stop();
});

test('modes, config options and slash commands follow the agent', async () => {
  const h = harness();
  await h.core.start();
  const sid = (await h.rpc('v1', 'session/new', {})).result.sessionId;
  await h.rpc('v1', 'session/set_mode', { sessionId: sid, modeId: 'code' });
  assert.equal(h.core.sessions.get(sid).modes.currentModeId, 'code');
  const r = await h.rpc('v1', 'session/set_config_option', { sessionId: sid, configId: 'model', value: 'smart' });
  assert.equal(r.result.configOptions[0].currentValue, 'smart');
  assert.equal(h.core.sessions.get(sid).configOptions[0].currentValue, 'smart');
  const plan = await h.rpc('v1', 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'plan' }] });
  assert.equal(plan.result.stopReason, 'end_turn');
  const plans = h.core.sessions.get(sid).entries.filter((e) => e.sessionUpdate === 'plan');
  assert.equal(plans.at(-1).entries.every((x) => x.status === 'completed'), true);
  h.core.stop();
});

test('authentication: session/new reports auth_required until the page calls authenticate', async () => {
  const h = harness({ MOCK_AUTH: '1' });
  await h.core.start();
  assert.equal(h.core.init.authMethods[0].id, 'mock-login');
  const a = await h.rpc('v1', 'session/new', {});
  assert.equal(a.error.code, -32000);
  assert.ok((await h.rpc('v1', 'authenticate', { methodId: 'mock-login' })).result);
  assert.ok((await h.rpc('v1', 'session/new', {})).result.sessionId);
  h.core.stop();
});

test('a crash: pages are told, the turn ends, and the agent restarts with its sessions loadable', async () => {
  const h = harness();
  await h.core.start();
  const sid = (await h.rpc('v1', 'session/new', {})).result.sessionId;
  await h.rpc('v1', 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] });
  const r = await h.rpc('v1', 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'crash' }] });
  assert.ok(r.error);
  await h.until((m) => m.type === 'status' && m.status === 'exited');
  assert.equal(h.core.sessions.get(sid).running, false);
  const off = await h.rpc('v1', 'session/new', {});
  assert.match(off.error.message, /not running/);
  h.core.onView({ type: 'restart', from: 'v1' });
  await h.until((m) => m.type === 'status' && m.status === 'ready' && h.core.init);
  // loading replays the conversation from the agent, replacing what the bridge had
  const l = await h.rpc('v1', 'session/load', { sessionId: sid });
  assert.ok(l.result);
  const e = h.core.sessions.get(sid).entries;
  assert.deepEqual(e.map((x) => x.content?.text), ['replayed question', 'replayed answer']);
  h.core.stop();
});

test('an agent that is not installed fails clearly', async () => {
  const out = [];
  const core = new BridgeCore({ agent: { id: 'x', name: 'X', command: 'definitely-not-an-agent-' + Date.now(), args: [] }, cwd: tmpdir(), send: (m) => out.push(m) });
  await core.start();
  await sleep(100);
  assert.equal(core.status, 'failed');
  assert.match(core.statusDetail, /not found|ENOENT|did not start/i);
});

test('Windows: one quoted command line through the shell, a slow first start, and the whole tree stopped', async () => {
  assert.equal(winCommandLine('npx', ['-y', '@agentclientprotocol/codex-acp']), 'npx -y @agentclientprotocol/codex-acp');
  assert.equal(winCommandLine('C:\\Program Files\\nodejs\\node.exe', ['a b', 'x"y', 'a&b', '']), '"C:\\Program Files\\nodejs\\node.exe" "a b" "x\\"y" "a&b" ""');
  // the Windows branch, run here through /bin/sh: the agent sits in a folder with a space and answers initialize late
  const calls = [];
  const spy = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return spawn(cmd, args, opts); };
  const dir = mkdtempSync(join(tmpdir(), 'acp win '));
  const { core, until } = harness({ MOCK_INIT_DELAY: '1500' }, { platform: 'win32', spawn: spy, cwd: dir });
  const t0 = Date.now();
  await core.start();
  assert.equal(core.status, 'ready');
  assert.ok(Date.now() - t0 >= 1400, 'it waited for the late answer');
  assert.equal(calls[0].opts.shell, true);
  assert.deepEqual(calls[0].args, []);
  assert.match(calls[0].cmd, /acp-mock-agent\.mjs/);
  await until((m) => m.type === 'status' && m.status === 'starting' && typeof m.since === 'number');
  core.stop();
  await sleep(50);
  assert.ok(calls.some((c) => c.cmd === 'taskkill' && c.args.includes('/T')), 'stops the process tree');
});

test('first download: the npx folder size against the registry estimate', async () => {
  // the estimate: the package, its dependencies, and the optional binary for this platform (an npm: alias)
  const docs = {
    'agent/latest': { dist: { unpackedSize: 1_000 }, dependencies: { tool: '^1.0.0', small: '2.0.0' } },
    'tool/latest': { dist: { unpackedSize: 2_000 }, optionalDependencies: { 'tool-linux-x64': 'npm:tool@1.0.0-linux-x64', 'tool-win32-x64': 'npm:tool@1.0.0-win32-x64', 'tool-linux-x64-musl': 'npm:tool@1.0.0-linux-x64-musl' } },
    'small/2.0.0': { dist: { unpackedSize: 300 } },
    'tool/1.0.0-win32-x64': { dist: { unpackedSize: 500_000_000 } },
    'tool/1.0.0-linux-x64': { dist: { unpackedSize: 400_000_000 } },
  };
  const fetchImpl = async (url) => { const k = decodeURIComponent(url.replace('https://r.test/', '')); return docs[k] ? { ok: true, json: async () => docs[k] } : { ok: false }; };
  assert.equal(await estimateSize('agent', { registry: 'https://r.test', platform: 'win32', arch: 'x64', fetchImpl }), 500_003_300);
  assert.equal(await estimateSize('agent', { registry: 'https://r.test', platform: 'linux', arch: 'x64', fetchImpl }), 400_003_300);
  assert.equal(await estimateSize('nothing', { registry: 'https://r.test', fetchImpl }), null);

  // the watch: an npx folder made after the start that grows is a download; one that does not grow is not
  const cache = mkdtempSync(join(tmpdir(), 'npm-cache-'));
  mkdirSync(join(cache, '_npx', 'old', 'node_modules'), { recursive: true });
  writeFileSync(join(cache, '_npx', 'old', 'node_modules', 'a'), Buffer.alloc(5000));
  const got = [];
  const w = watchNpxDownload({ spec: 'agent', cacheDir: cache, since: Date.now(), every: 60, onUpdate: (u) => got.push(u), estimate: async () => 50_000 });
  await sleep(250);
  assert.equal(got.length, 0, 'an agent npx already has is not a download');
  const dir = join(cache, '_npx', 'new', 'node_modules', 'pkg');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 4; i++) { writeFileSync(join(dir, 'f' + i), Buffer.alloc(10_000)); await sleep(150); }
  w.stop();
  assert.ok(got.length >= 2, 'reports as it grows');
  assert.equal(got.at(-1).total, 50_000);
  assert.ok(got.at(-1).bytes >= 30_000 && got.at(-1).bytes <= 40_000);
});

test('starting: download progress, a stall offers Retry, a forced retry, a failed download says why', async (t) => {
  const cores = [];
  t.after(() => { for (const c of cores) { try { c.stop(); } catch {} } });
  // an npx agent (the mock stands in): the watch reports a download, then nothing happens long enough to stall
  let w = null;
  const fakeWatch = (o) => { w = o; return { stop() { w = null; } }; };
  const asMock = (cmd, args, opts) => spawn(process.execPath, [MOCK], opts);
  const h = harness({ MOCK_INIT_DELAY: '3000' }, { agent: { id: 'x', name: 'X', command: 'npx', args: ['-y', '@x/agent-acp'], env: { MOCK_INIT_DELAY: '3000' } }, spawn: asMock, watchDownload: fakeWatch, stallMs: 1000 });
  cores.push(h.core);
  const started = h.core.start();
  await sleep(50);
  assert.equal(w.spec, '@x/agent-acp');
  w.onUpdate({ bytes: 120e6, total: 550e6 });
  const p1 = await h.until((m) => m.type === 'progress' && m.progress.phase === 'downloading');
  assert.equal(p1.progress.bytes, 120e6); assert.equal(p1.progress.total, 550e6); assert.equal(p1.progress.stalled, false);
  await h.until((m) => m.type === 'progress' && m.progress.stalled === true, 5000);
  await started;
  assert.equal(h.core.status, 'ready');
  assert.equal(h.core.progress, null, 'ready clears the progress');
  assert.equal(w, null, 'the watch stops once the agent is ready');

  // Retry while it starts: the stuck process is replaced and the agent comes up
  const r = harness({ MOCK_INIT_DELAY: '60000' }, { watchDownload: null, stallMs: 300 });
  cores.push(r.core);
  void r.core.start();
  await r.until((m) => m.type === 'status' && m.status === 'starting');
  const first = r.core.proc;
  r.core.agent.env = {};
  await r.core.onView({ type: 'restart', force: true, from: 'v1' });
  assert.notEqual(r.core.proc, first);
  assert.equal(r.core.status, 'ready');
  r.core.stop();

  // a download that fails: npx exits before the agent is ready, and the console gets the reason
  const f = harness({}, { agent: { id: 'y', name: 'Y', command: process.execPath, args: ['-e', 'console.error("npm warn something"); console.error("npm error code ETIMEDOUT"); console.error("npm error network request failed"); process.exit(1)'] }, watchDownload: null });
  cores.push(f.core);
  await f.core.start();
  const st = await f.until((m) => m.type === 'status' && m.status === 'failed');
  assert.match(st.detail, /exited \(code 1\) before it was ready/);
  assert.match(st.detail, /npm error network request failed/);
  assert.ok(st.stderr.some((l) => /ETIMEDOUT/.test(l)));
  h.core.stop();
});

test('errors: the agent\'s real reason reaches the page, with what it printed', async (t) => {
  // the shapes agents send
  assert.equal(agentError({ code: -32603, message: 'Internal error', data: { details: 'Query closed before response received' } }).message, 'Internal error: Query closed before response received');
  assert.equal(agentError({ code: -32603, message: 'Internal error: Invalid API key · Fix external API key' }).message, 'Internal error: Invalid API key · Fix external API key');
  assert.equal(agentError({ code: -32603, message: 'Internal error', data: 'spawn EPERM' }).message, 'Internal error: spawn EPERM');
  assert.equal(agentError({ code: -32603, message: 'Internal error' }, ['loading', 'Error: EACCES: permission denied']).message, 'Internal error: Error: EACCES: permission denied');
  assert.equal(agentError({ code: -32000, message: 'Authentication required' }).code, -32000);
  assert.ok(systemFolder('C:\\Windows\\System32') && systemFolder('C:\\Windows') && systemFolder('/') && systemFolder('/usr/bin'));
  assert.ok(!systemFolder('C:\\Users\\me\\games\\star') && !systemFolder('/home/me/game'));

  // session/new fails with "Internal error" and the reason in data: the page gets the reason and the log
  const h = harness({ MOCK_NEW_ERROR: 'Claude Code process exited with code 1' });
  t.after(() => h.core.stop());
  await h.core.start();
  const r = await h.rpc('v1', 'session/new', {});
  assert.equal(r.error.code, -32603);
  assert.equal(r.error.message, 'Internal error: Claude Code process exited with code 1');
  assert.ok(r.error.log.some((l) => /spawn failed/.test(l)), 'what the agent printed comes along');

  // a turn that fails with a bare "Internal error": the stderr line becomes the reason, in the transcript as well
  const g = harness();
  t.after(() => g.core.stop());
  await g.core.start();
  const sid = (await g.rpc('v1', 'session/new', {})).result.sessionId;
  const p = await g.rpc('v1', 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'fail' }] });
  assert.match(p.error.message, /^Internal error: Error: EPERM: operation not permitted/);
  assert.equal(p.error.recorded, true, 'the page knows the transcript shows it');
  const end = g.out.find((m) => m.type === 'update' && m.entry.sessionUpdate === '_turn_end');
  assert.equal(end.entry.stopReason, 'error');
  assert.match(end.entry.error, /EPERM/);
  assert.ok(end.entry.log.length >= 1);
});

test('stress: 8 sessions in parallel, a 2 MB answer, 500 quick prompts in a row', async () => {
  const h = harness();
  await h.core.start();
  const ids = [];
  for (let i = 0; i < 8; i++) ids.push((await h.rpc('v' + i, 'session/new', {})).result.sessionId);
  const t0 = Date.now();
  const results = await Promise.all(ids.map((sid, i) => h.rpc('v' + i, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: i === 0 ? 'big 2048' : 'plan' }] })));
  assert.ok(results.every((r) => r.result?.stopReason === 'end_turn'), JSON.stringify(results.map((r) => r.error)));
  const big = h.core.sessions.get(ids[0]).entries.find((e) => e.sessionUpdate === 'agent_message_chunk');
  assert.equal(big.content.text.length, 2048 * 1024, 'chunks of one message merge into one entry');
  for (let n = 0; n < 500; n++) {
    const r = await h.rpc('v1', 'session/prompt', { sessionId: ids[1], prompt: [{ type: 'text', text: 'n' + n }] });
    assert.equal(r.result.stopReason, 'end_turn');
  }
  const s = h.core.sessions.get(ids[1]);
  assert.ok(!s.running);
  assert.ok(s.entries.length > 1500);
  // a late page receives the long transcript in batches that end with done
  h.out.length = 0;
  h.core.sendTranscript('late', ids[1]);
  const parts = h.out.filter((m) => m.type === 'transcript' && m.to === 'late');
  assert.ok(parts.length > 1 && parts.at(-1).done && parts[0].first);
  assert.equal(parts.reduce((a, p) => a + p.entries.length, 0), s.entries.length);
  console.log(`  stress took ${Date.now() - t0} ms`);
  h.core.stop();
});

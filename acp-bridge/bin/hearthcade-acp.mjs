#!/usr/bin/env node
// HearthCade workbench bridge: connects an Agent Client Protocol (ACP) agent on this machine to the HearthCade console.
//
//   npx -y <site>/acp/hearthcade-acp.tgz claude          start Claude Agent here and open it in the console
//   npx -y <site>/acp/hearthcade-acp.tgz codex --cwd ~/games/star-keeper
//   npx -y <site>/acp/hearthcade-acp.tgz -- my-agent --acp   any other ACP agent, by its command
//   … list                                                    the agents it knows
//   … logout                                                  forget this machine's connection
//
// What it does: starts the agent in this folder, speaks ACP with it, and relays the conversation to the workbench in your
// console over an encrypted WebSocket to the site. The agent works on this machine with its own tools and asks you (in
// the console) before it acts, the way it would in an editor. It also gets the HearthCade tools (MCP) for your account,
// through a local proxy that holds the access token, so the token never reaches the agent or its logs.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, statSync, realpathSync } from 'node:fs';
import { homedir, hostname, platform, release } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BridgeCore, launchOf, splitCommand } from '../core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
const CATALOG = JSON.parse(readFileSync(join(HERE, '..', 'agents.json'), 'utf8')).agents;
const DEFAULT_SERVER = PKG.hearthcade?.server || 'https://hearthcade.com';
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s), dim = (s) => c(2, s), red = (s) => c(31, s), green = (s) => c(32, s), accent = (s) => c(35, s);
const say = (...a) => console.log(...a);
const die = (msg, code = 1) => { console.error(red('✗ ') + msg); process.exit(code); };

// ----- the internal MCP stdio mode: an agent that cannot reach MCP over HTTP runs this as a stdio server ------------
if (process.argv[2] === '--mcp-stdio') await mcpStdio(process.argv[3]);

const major = Number(process.versions.node.split('.')[0]);
if (major < 22 || typeof WebSocket !== 'function') die(`Node.js 22 or newer is needed (this is ${process.version}). Get it at https://nodejs.org`);

// ----- arguments -------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const custom = dash >= 0 ? argv.slice(dash + 1) : null;
const args = dash >= 0 ? argv.slice(0, dash) : argv;
const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v ?? ''; };
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
if (flag('--help') || flag('-h')) { help(); process.exit(0); }
if (flag('--version') || flag('-v')) { say(PKG.version); process.exit(0); }
const server = (opt('--server') || process.env.HEARTHCADE_SERVER || DEFAULT_SERVER).replace(/\/+$/, '');
const cwdArg = opt('--cwd');
const fresh = flag('--new');
const verbose = flag('--verbose');
const cmd = args[0] || '';

if (cmd === 'list') { listAgents(); process.exit(0); }
if (cmd === 'logout') { forget(); say(green('✓ ') + `This machine is no longer connected to ${server}.`); process.exit(0); }

let agent;
if (custom && custom.length) {
  const parts = custom.length === 1 ? splitCommand(custom[0]) : custom;
  agent = { id: 'custom', name: cmd && cmd !== 'custom' ? cmd : parts[0], command: parts[0], args: parts.slice(1) };
} else {
  if (!cmd) { help(); process.exit(1); }
  const e = CATALOG.find((a) => a.id === cmd.toLowerCase() || a.registry === cmd.toLowerCase());
  if (!e) die(`Unknown agent "${cmd}". Run with "list" to see them, or start any ACP agent with: -- <its command>`);
  agent = { id: e.id, name: e.name, website: e.website, ...launchOf(e) };
}
let cwd;
try { cwd = realpathSync(resolve(cwdArg || process.cwd())); if (!statSync(cwd).isDirectory()) throw new Error(); } catch { die(`Not a folder: ${cwdArg}`); }

// ----- this machine's connection to the site ----------------------------------------------------------------------------
const CRED_FILE = join(homedir(), '.hearthcade', 'workbench.json');
function creds() { try { return JSON.parse(readFileSync(CRED_FILE, 'utf8')); } catch { return {}; } }
function saveCred(v) {
  const all = creds(); all[server] = v;
  mkdirSync(dirname(CRED_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(CRED_FILE, JSON.stringify(all, null, 1), { mode: 0o600 });
}
function forget() { const all = creds(); delete all[server]; try { if (Object.keys(all).length) writeFileSync(CRED_FILE, JSON.stringify(all, null, 1), { mode: 0o600 }); else if (existsSync(CRED_FILE)) unlinkSync(CRED_FILE); } catch { /* fine */ } }

const UA = `hearthcade-acp/${PKG.version} (${platform()} ${release()}; node ${process.versions.node})`;
async function call(path, body, secret) {
  const r = await fetch(server + path, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body || {}) });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, json: j || {} };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = hostname().replace(/\.local$/, '').slice(0, 60);

async function pair() {
  const r = await call('/acp/v1/pair', { host, agent: agent.name, cwd, os: platform() });
  if (r.status !== 200) die(r.json.error || `The site answered ${r.status}.`);
  const { code, poll, url, interval = 3, expires_in = 900 } = r.json;
  say('');
  say(`  ${bold('Connect this machine to HearthCade')}`);
  say(`  Open ${accent(url)}`);
  say(`  and check that the code is ${bold(code)}.`);
  say('');
  openBrowser(url);
  const end = Date.now() + expires_in * 1000;
  while (Date.now() < end) {
    await sleep(interval * 1000);
    const t = await call('/acp/v1/pair/token', { poll });
    if (t.status === 200 && t.json.secret) { saveCred({ link: t.json.link, secret: t.json.secret }); say(green('✓ ') + `Connected as ${bold(t.json.user || 'you')}. This machine stays connected until you remove it in the console or run "logout".`); return t.json.secret; }
    if (t.json.error === 'access_denied') die('The request was declined in the console.');
    if (t.json.error === 'expired_token') break;
  }
  die('The code expired. Run the command again.');
}

function openBrowser(url) {
  if (process.env.HEARTHCADE_NO_BROWSER || !process.stdout.isTTY) return;
  const [cmd, ...a] = platform() === 'darwin' ? ['open', url] : platform() === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  try { const p = spawn(cmd, a, { stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); } catch { /* print only */ }
}

// ----- start ------------------------------------------------------------------------------------------------------------
if (fresh) forget();
let secret = creds()[server]?.secret || await pair();
const bridgeId = randomUUID();
let started = await call('/acp/v1/bridges', { bridge: bridgeId, agent: agent.name, agent_id: agent.id, host, cwd, os: platform(), version: PKG.version }, secret);
if (started.status === 401) { forget(); secret = await pair(); started = await call('/acp/v1/bridges', { bridge: bridgeId, agent: agent.name, agent_id: agent.id, host, cwd, os: platform(), version: PKG.version }, secret); }
if (started.status !== 200) die(started.json.error || `The site answered ${started.status}.`);
const S = started.json;   // { ws, user, workbench, mcp: { url, access_token, refresh_token, client_id, token_endpoint, expires_in }, system_prompt, scope }

// The local MCP proxy: the agent talks to 127.0.0.1, the proxy adds the access token and refreshes it when it expires.
const mcpState = S.mcp ? { ...S.mcp, expiresAt: Date.now() + (S.mcp.expires_in || 3600) * 1000 } : null;
const proxyPath = '/mcp/' + randomBytes(18).toString('base64url');
let proxyUrl = null;
if (mcpState) proxyUrl = await startProxy();

async function refreshToken() {
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: mcpState.refresh_token, client_id: mcpState.client_id });
  const r = await fetch(mcpState.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j.error_description || 'refresh refused');
  mcpState.access_token = j.access_token; if (j.refresh_token) mcpState.refresh_token = j.refresh_token;
  mcpState.expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
}
let refreshing = null;
const fresher = () => (refreshing ||= refreshToken().finally(() => { refreshing = null; }));

function startProxy() {
  return new Promise((ok) => {
    const srv = createServer(async (req, res) => {
      if (!req.url || req.url.split('?')[0] !== proxyPath) { res.writeHead(404).end(); return; }
      const chunks = []; for await (const ch of req) chunks.push(ch);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const pass = {};
      for (const h of ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) if (req.headers[h]) pass[h] = String(req.headers[h]);
      const go = () => fetch(mcpState.url, { method: req.method, headers: { ...pass, 'user-agent': `${UA} via ${agent.name}`, authorization: `Bearer ${mcpState.access_token}` }, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body });
      try {
        if (Date.now() > mcpState.expiresAt - 60_000) await fresher().catch(() => {});
        let r = await go();
        if (r.status === 401) { await fresher(); r = await go(); }
        const out = {};
        r.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) out[k] = v; });
        res.writeHead(r.status, out);
        if (r.body) for await (const ch of r.body) res.write(ch);
        res.end();
      } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: `HearthCade is not reachable: ${e?.message || e}` } }));
      }
    });
    srv.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${srv.address().port}${proxyPath}`));
  });
}

// ----- the agent and the relay ------------------------------------------------------------------------------------------
let ws = null, wsOpen = false;
const core = new BridgeCore({
  agent, cwd, systemPrompt: S.system_prompt || '',
  mcp: proxyUrl ? { http: proxyUrl, stdio: { command: process.execPath, args: [fileURLToPath(import.meta.url), '--mcp-stdio', proxyUrl] } } : null,
  clientInfo: { name: 'hearthcade-workbench', title: 'HearthCade Workbench', version: PKG.version },
  send: (m) => { if (wsOpen) { try { ws.send(JSON.stringify(m)); } catch { /* reconnecting */ } } },
  log: (who, line) => { if (who === 'agent' && !verbose) return; say(dim(`${who === 'agent' ? agent.name : 'bridge'} │ `) + line); },
});

say('');
say(`  ${bold('HearthCade workbench')} ${dim('v' + PKG.version)}`);
say(`  ${dim('agent ')} ${agent.name} ${dim('(' + [agent.command, ...agent.args].join(' ') + ')')}`);
say(`  ${dim('folder')} ${cwd}`);
say(`  ${dim('tools ')} ${proxyUrl ? 'HearthCade MCP' + (S.scope ? dim(' · ' + S.scope) : '') : 'none'}`);
say(`  ${dim('open  ')} ${accent(S.workbench)}`);
say('');

let attempt = 0, stopping = false;
function connect() {
  // Node's WebSocket fires only "error", never "close", when the connection cannot open (server down or restarting),
  // so both handlers lead here and each socket schedules its retry once.
  const sock = new WebSocket(S.ws, { headers: { authorization: `Bearer ${secret}`, 'user-agent': UA } });
  let retried = false;
  const retry = (code) => {
    if (retried || stopping) return; retried = true;
    const was = wsOpen && ws === sock; if (ws === sock) wsOpen = false;
    if (code === 4410) { say(red('✗ ') + 'This run of the bridge has ended. Run the command again to start it.'); shutdown(1); return; }
    if (code === 4401 || code === 4403) { forget(); say(red('✗ ') + 'This machine was disconnected in the console. Run the command again to connect it.'); shutdown(1); return; }
    const wait = Math.min(30_000, 500 * 2 ** attempt++) + Math.random() * 500;
    if (was || attempt === 1) say(dim('bridge │ ') + `Lost the connection to the console; reconnecting…`);
    setTimeout(connect, wait);
  };
  ws = sock;
  ws.onopen = () => {
    wsOpen = true; attempt = 0;
    ws.send(JSON.stringify({ type: 'meta', meta: { agent: agent.name, agentId: agent.id, host, cwd, os: platform(), version: PKG.version, startedAt } }));
    core.send(core.state());
    say(green('✓ ') + 'Connected to the console. Leave this running while you work; press Ctrl+C to stop.');
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.type === 'ping') return;
    if (m.type === 'view_open') { if (verbose) say(dim('bridge │ a console page joined')); return; }
    if (m.type === 'view_close') return;
    if (m.type === 'rpc' && m.method === 'session/prompt') say(dim('bridge │ ') + 'Message from the console');
    core.onView(m).catch((e) => say(dim('bridge │ ') + red(String(e?.message || e))));
  };
  ws.onclose = (ev) => retry(ev.code);
  // an error on an open socket is followed by "close" (which may carry 4401); one that never opened gets no "close"
  ws.onerror = () => {
    if (sock.readyState === WebSocket.OPEN) return;
    // ask over plain HTTP why: 401/403 means this machine was disconnected; anything else (or no answer) is temporary
    fetch(S.ws.replace(/^ws/, 'http'), { headers: { authorization: `Bearer ${secret}`, 'user-agent': UA }, signal: AbortSignal.timeout(10_000) })
      .then((r) => retry(r.status === 401 || r.status === 403 ? 4401 : r.status === 410 ? 4410 : 0), () => retry(0));
  };
}
const startedAt = Date.now();
connect();
setInterval(() => { if (wsOpen) try { ws.send('{"type":"ping"}'); } catch { /* ignore */ } }, 25_000).unref();
// the first run of an npx or uvx agent downloads it first, silently: say so, so a long wait does not look stuck
const slow = setInterval(() => {
  if (core.status !== 'starting') { clearInterval(slow); return; }
  const min = Math.round((Date.now() - core.startedAt) / 60_000);
  say(dim('bridge │ ') + `Still starting ${agent.name}${min ? ` (${min} min)` : ''}. The first run downloads it, which can take several minutes for a large agent.`);
}, 20_000);
slow.unref();
core.start().then(() => {
  clearInterval(slow);
  if (core.status === 'ready') say(green('✓ ') + `${core.init?.agentInfo?.title || core.init?.agentInfo?.name || agent.name} is ready.`);
  else {
    say(red('✗ ') + core.statusDetail);
    if (core.status === 'failed' && agent.website && /not found/i.test(core.statusDetail)) say(`  Install ${agent.name} first: ${agent.website}`);
  }
});

async function shutdown(code = 0) {
  if (stopping) return; stopping = true;
  core.stop();
  try { ws?.close(1000, 'bye'); } catch { /* fine */ }
  await call(`/acp/v1/bridges/${bridgeId}/stop`, {}, secret).catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => { say(''); say('Stopping…'); shutdown(0); });
process.on('SIGTERM', () => shutdown(0));

// ----- helpers ------------------------------------------------------------------------------------------------------------
function help() {
  say(`${bold('hearthcade-acp')} ${PKG.version}: use your own coding agent in the HearthCade console (Agent Client Protocol).

  hearthcade-acp <agent> [--cwd <folder>]       start a known agent (see "list")
  hearthcade-acp -- <command…>                   start any ACP agent by its command
  hearthcade-acp list                            the agents it knows
  hearthcade-acp logout                          forget this machine's connection
  options: --server <url>  --new (connect again)  --verbose (show the agent's log)`);
}
function listAgents() {
  for (const a of CATALOG) { const l = launchOf(a); say(`  ${bold(a.id.padEnd(12))} ${a.name.padEnd(18)} ${dim([l.command, ...l.args].join(' '))}`); }
  say(dim(`\n  From the ACP registry (agentclientprotocol.com). Any other ACP agent: hearthcade-acp -- <its command>`));
}

async function mcpStdio(url) {
  // newline-delimited JSON-RPC on stdin/stdout ↔ Streamable HTTP on the local proxy
  if (!url) process.exit(2);
  let session = null, buf = '';
  const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const handle = async (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: line });
      session = r.headers.get('mcp-session-id') || session;
      if (r.status === 202 || r.status === 204) return;
      const type = r.headers.get('content-type') || '';
      if (type.includes('text/event-stream')) {
        const text = await r.text();
        for (const block of text.split(/\r?\n\r?\n/)) { const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n'); if (data) { try { out(JSON.parse(data)); } catch { /* skip */ } } }
      } else {
        const j = await r.json().catch(() => null);
        if (Array.isArray(j)) j.forEach(out); else if (j) out(j);
        else if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `HTTP ${r.status}` } });
      }
    } catch (e) { if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e?.message || e) } }); }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) void handle(l); } });
  process.stdin.on('end', () => setTimeout(() => process.exit(0), 200));
  await new Promise(() => {});
}

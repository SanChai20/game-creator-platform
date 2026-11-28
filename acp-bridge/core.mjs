// The ACP client that runs on the creator's machine.
//
// HearthCade's workbench is an Agent Client Protocol (ACP) client whose screen is a page of the console and whose body is
// this bridge. The bridge starts the creator's own agent (Claude Agent, Codex, Gemini CLI, Copilot, OpenCode, …) as a
// subprocess, speaks ACP v1 to it over stdio (newline-delimited JSON-RPC 2.0), and relays the conversation to every
// console page the creator has open, through the platform's relay. It owns everything that must happen once per agent
// process: `initialize`, the id space of requests, the transcript of each session, and the answers to the agent's own
// requests. Pages are views: any number can watch, and the first answer to a permission request wins.
//
// The protocol between views and the bridge (all JSON, one object per WebSocket message):
//   view → bridge   { type: 'hello' }                          the full state, then each session's transcript
//                   { type: 'rpc', id, method, params }       an ACP request (only the methods in VIEW_METHODS)
//                   { type: 'cancel', sessionId }              session/cancel, and every open permission request of it
//                   { type: 'answer', key, optionId | null }   the answer to a permission request (null: cancelled)
//                   { type: 'restart' }                        start the agent again (after it exited)
//   bridge → views  { type: 'state', … }                       agent, capabilities, sessions, open requests
//                   { type: 'rpc_result', id, result | error } sent only to the view that asked
//                   { type: 'update', sessionId, seq, entry }  one transcript entry (also replayed by 'transcript')
//                   { type: 'transcript', sessionId, entries, done }
//                   { type: 'ask', key, sessionId, params } / { type: 'answered', key, optionId, by }
//                   { type: 'session', session }                a session's summary changed
//                   { type: 'status', status, detail }          starting | ready | exited | failed
// Every message from a view carries `from` (its connection id, set by the relay, never by the page).
import { spawn as nodeSpawn } from 'node:child_process';
import { watchNpxDownload } from './download.mjs';

export const INIT_TIMEOUT = 30 * 60_000;
/** While starting, no new bytes and no output for this long: the console says it looks stuck and offers Retry. */
export const STALL_MS = 120_000;
export const PROTOCOL_VERSION = 1;
/** What a page may ask the agent to do. Everything else (fs, terminals, raw initialize) is refused. */
export const VIEW_METHODS = new Set(['session/new', 'session/load', 'session/resume', 'session/prompt', 'session/set_mode', 'session/set_config_option', 'session/set_model', 'session/list', 'session/close', 'authenticate', 'logout']);
const CHUNKS = new Set(['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk']);
const MAX_ENTRIES = 20000, MAX_CHARS = 24_000_000, MAX_LINE = 64 * 1024 * 1024;
const TRANSCRIPT_BATCH = 400;

/** One agent subprocess and the ACP client state around it. */
export class BridgeCore {
  constructor(o) {
    this.agent = o.agent;                 // { id, name, command, args, env? }
    this.cwd = o.cwd;
    this.mcp = o.mcp || null;             // { http: url } and/or { stdio: { command, args } }: the platform's tools
    this.systemPrompt = o.systemPrompt || '';
    this.send = o.send;                   // (msg) => void, to the relay
    this.log = o.log || (() => {});
    this.spawn = o.spawn || nodeSpawn;
    this.platform = o.platform || process.platform;
    this.watchDownload = o.watchDownload === undefined ? watchNpxDownload : o.watchDownload;   // null: no download watch
    this.stallMs = o.stallMs || STALL_MS;
    this.progress = null;                 // while starting: { phase, bytes, total, line, stalled }
    this.clientInfo = o.clientInfo || { name: 'hearthcade-workbench', title: 'HearthCade Workbench', version: '1.0.3' };
    this.status = 'idle'; this.statusDetail = '';
    this.init = null;                     // the agent's initialize result
    this.sessions = new Map();            // sessionId → session
    this.pending = new Map();             // our request id → { resolve, reject, view?, viewId? }
    this.asks = new Map();                // key → { agentId, sessionId, params, at }
    this.nextId = 1; this.nextAsk = 1; this.seq = 0;
    this.stderr = [];
    this.proc = null; this.buf = '';
    this.closed = false;
  }

  // ----- the agent process -------------------------------------------------------------------------
  async start() {
    this.startedAt = Date.now();
    this.progress = { phase: 'starting', bytes: 0, total: null, line: '', stalled: false };
    this.setStatus('starting', `${this.agent.command} ${(this.agent.args || []).join(' ')}`.trim());
    let proc;
    try {
      const env = { ...process.env, ...(this.agent.env || {}) };
      // Windows runs npx, uvx and most agents as .cmd scripts, which only start through the shell (cmd.exe). Node
      // joins arguments for the shell without quoting them, so the command line is built here, quoted for cmd.
      proc = this.platform === 'win32'
        ? this.spawn(winCommandLine(this.agent.command, this.agent.args || []), [], { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: true, windowsHide: true })
        : this.spawn(this.agent.command, this.agent.args || [], { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { this.failAll(e); this.setStatus('failed', String(e?.message || e)); return; }
    this.proc = proc; this.buf = '';
    const gen = proc;
    this.watchStart(gen);
    proc.on('error', (e) => { if (this.proc !== gen) return; this.setStatus('failed', e.code === 'ENOENT' ? `Command not found: ${this.agent.command}` : String(e.message || e)); this.failAll(e); });
    proc.on('exit', (code, signal) => {
      if (this.proc !== gen) return;
      this.proc = null;
      this.failAll(new Error('The agent exited.'));
      for (const [key, a] of this.asks) { this.asks.delete(key); this.send({ type: 'answered', key, optionId: null, by: null }); void a; }
      for (const s of this.sessions.values()) if (s.running) { s.running = false; this.emitSession(s); }
      if (this.closed || this.status === 'failed') return;
      if (this.status === 'starting') {
        // it ended before it was ready: a failed download or install, a missing command, a crash at start
        const why = [...this.stderr].reverse().find((l) => /\b(err|error|fail|failed|not found|not recognized|denied|ETIMEDOUT|ECONN\w*|ENOTFOUND|E\d{3})\b/i.test(l)) || this.stderr[this.stderr.length - 1];
        this.setStatus('failed', `${signal ? `It was stopped by ${signal}` : `It exited (code ${code})`} before it was ready.${why ? ' ' + why.trim().slice(0, 300) : ''}`);
      } else this.setStatus('exited', signal ? `Stopped by ${signal}` : `Exit code ${code}`);
    });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => this.onStdout(d, gen));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) if (line.trim()) { this.stderr.push(line.slice(0, 2000)); this.log('agent', line); if (this.proc === gen && this.status === 'starting') this.bumpProgress({ line: line.trim().slice(0, 300) }); }
      if (this.stderr.length > 200) this.stderr.splice(0, this.stderr.length - 200);
    });
    proc.stdin.on('error', () => {});
    try {
      const r = await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        // The agent works in the creator's folder with its own tools; the console is a window onto it. So no client
        // file system or terminals: the agent's file edits and commands stay on the machine, under its own permissions.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: this.clientInfo,
        // No short limit: the first run of an npx or uvx agent downloads it before it can answer, and some are large
        // (Codex brings a ~550 MB binary on Windows). While the process lives, it is still starting.
      }, INIT_TIMEOUT);
      if (r?.protocolVersion !== PROTOCOL_VERSION) {
        this.setStatus('failed', `The agent speaks ACP version ${r?.protocolVersion}; the workbench speaks version ${PROTOCOL_VERSION}.`);
        this.kill(); return;
      }
      this.init = r;
      this.setStatus('ready', '');
    } catch (e) {
      if (this.proc === gen) { this.setStatus('failed', `The agent did not start: ${e?.message || e}`); this.kill(); }
    }
  }

  // ----- while starting: the first download, its log, and stalls ---------------------------------------------------
  watchStart(gen) {
    this.endWatch();
    let lastChange = Date.now();
    const npx = this.agent.command === 'npx' ? (this.agent.args || []).find((a) => !String(a).startsWith('-')) : null;
    if (npx && this.watchDownload) {
      this.watch = this.watchDownload({
        spec: npx, since: this.startedAt,
        onUpdate: ({ bytes, total }) => { if (this.proc === gen && this.status === 'starting') this.bumpProgress({ phase: 'downloading', bytes, total }); },
      });
    }
    this.onChange = () => { lastChange = Date.now(); };
    this.stallTimer = setInterval(() => {
      if (this.proc !== gen || this.status !== 'starting' || !this.progress) return;
      const stalled = Date.now() - lastChange > this.stallMs;
      if (stalled !== this.progress.stalled) this.bumpProgress({ stalled }, true);
    }, Math.min(5000, this.stallMs / 2));
    this.stallTimer.unref?.();
  }
  endWatch() {
    this.watch?.stop(); this.watch = null;
    clearInterval(this.stallTimer); this.stallTimer = null;
    clearTimeout(this.progressTimer); this.progressTimer = null;
  }
  bumpProgress(patch, quiet = false) {
    if (!this.progress) return;
    Object.assign(this.progress, patch);
    if (!quiet) { this.progress.stalled = false; this.onChange?.(); }
    // at most a few messages a second, whatever the agent prints
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      if (this.status === 'starting' && this.progress) this.send({ type: 'progress', progress: this.progress, stderr: this.stderr.slice(-40) });
    }, 400);
    this.progressTimer.unref?.();
  }

  kill() {
    const p = this.proc; this.proc = null;
    if (!p) return;
    // on Windows the process is cmd.exe; the agent under it (and what the agent started) only stops with its tree
    if (this.platform === 'win32' && p.pid) { try { this.spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on?.('error', () => {}); } catch { /* gone */ } }
    try { p.kill(); } catch { /* gone */ }
  }
  stop() { this.closed = true; this.endWatch(); this.kill(); }
  /** Start again; with force, also when the agent is still running (a start that looks stuck). */
  async restart(force = false) {
    if (this.proc && !force) return;
    if (this.proc) { this.endWatch(); this.kill(); this.failAll(new Error('Restarted.')); }
    this.init = null; this.stderr = [];
    // the sessions stay listed: an agent that can load sessions picks them up again (session/load)
    for (const s of this.sessions.values()) { s.attached = false; s.running = false; this.emitSession(s); }
    await this.start();
  }

  onStdout(d, gen) {
    if (this.proc !== gen) return;
    this.buf += d;
    if (this.buf.length > MAX_LINE) { this.log('bridge', 'The agent sent a line over 64 MB; dropped.'); this.buf = ''; return; }
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { this.log('agent', line.slice(0, 500)); continue; }   // agents that print to stdout by mistake
      try { this.onAgent(msg); } catch (e) { this.log('bridge', `Could not handle a message from the agent: ${e?.message || e}`); }
    }
  }

  write(msg) {
    if (!this.proc) throw new Error('The agent is not running.');
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method, params, timeout = 0) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      let timer = null;
      if (timeout) timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); }, method, params });
      try { this.write({ jsonrpc: '2.0', id, method, params }); } catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  failAll(e) {
    for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(e); }
  }

  onAgent(msg) {
    if (msg.id !== undefined && msg.id !== null && !msg.method) {          // a response to one of ours
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'Agent error'), { rpc: msg.error }));
      else p.resolve(msg.result ?? null);
      return;
    }
    if (msg.method && msg.id !== undefined && msg.id !== null) return this.onAgentRequest(msg);
    if (msg.method === 'session/update') return this.onUpdate(msg.params || {});
    // other notifications are ignored, as the protocol asks
  }

  onAgentRequest(msg) {
    const reply = (result, error) => { try { this.write(error ? { jsonrpc: '2.0', id: msg.id, error } : { jsonrpc: '2.0', id: msg.id, result }); } catch { /* gone */ } };
    if (msg.method === 'session/request_permission') {
      const params = msg.params || {};
      const key = 'a' + this.nextAsk++;
      this.asks.set(key, { agentId: msg.id, sessionId: params.sessionId, params, at: Date.now(), reply });
      // the tool call it is about shows up in the transcript as well, with its title and content
      if (params.toolCall?.toolCallId) this.record(params.sessionId, { sessionUpdate: 'tool_call_update', ...params.toolCall });
      this.send({ type: 'ask', key, sessionId: params.sessionId, params });
      return;
    }
    // fs/*, terminal/*, elicitation and anything newer: not offered in initialize, so refused
    reply(undefined, { code: -32601, message: `Method not supported by the HearthCade workbench: ${msg.method}` });
  }

  // ----- sessions and transcripts ----------------------------------------------------------------
  session(id, init) {
    let s = this.sessions.get(id);
    if (!s) {
      s = { sessionId: id, title: '', cwd: this.cwd, createdAt: Date.now(), updatedAt: Date.now(), running: false, attached: true, stopReason: null,
        modes: null, configOptions: null, models: null, commands: [], usage: null, entries: [], chars: 0, ...init };
      this.sessions.set(id, s);
    }
    return s;
  }

  summary(s) {
    const { entries, chars, ...rest } = s; void entries; void chars;
    return rest;
  }

  emitSession(s) { this.send({ type: 'session', session: this.summary(s) }); }

  onUpdate(params) {
    const id = params.sessionId, u = params.update;
    if (!id || !u || typeof u.sessionUpdate !== 'string') return;
    const s = this.session(id);
    let meta = false;
    switch (u.sessionUpdate) {
      case 'current_mode_update': if (s.modes) { s.modes = { ...s.modes, currentModeId: u.currentModeId }; meta = true; } break;
      case 'config_option_update': s.configOptions = u.configOptions || null; meta = true; break;
      case 'available_commands_update': s.commands = Array.isArray(u.availableCommands) ? u.availableCommands : []; meta = true; break;
      case 'session_info_update': if (typeof u.title === 'string') { s.title = u.title.slice(0, 200); meta = true; } break;
      case 'usage_update': s.usage = { used: u.used, size: u.size, cost: u.cost || null }; meta = true; break;
    }
    if (meta) { s.updatedAt = Date.now(); this.emitSession(s); }
    // commands, config and usage are state, not conversation
    if (u.sessionUpdate === 'available_commands_update' || u.sessionUpdate === 'config_option_update' || u.sessionUpdate === 'usage_update' || u.sessionUpdate === 'session_info_update') return;
    this.record(id, u);
  }

  /** Adds an entry to a session's transcript and sends it to every view. Text chunks of one message are merged. */
  record(sessionId, entry) {
    const s = this.session(sessionId);
    const seq = ++this.seq;
    const last = s.entries[s.entries.length - 1];
    if (last && CHUNKS.has(entry.sessionUpdate) && last.sessionUpdate === entry.sessionUpdate && entry.content?.type === 'text' && last.content?.type === 'text'
        && (last.messageId ?? null) === (entry.messageId ?? null) && !last._final) {
      last.content = { ...last.content, text: last.content.text + entry.content.text };
      s.chars += entry.content.text.length;
    } else {
      s.entries.push({ ...entry, _seq: seq });
      s.chars += JSON.stringify(entry).length;
    }
    // keep a transcript bounded: drop the oldest entries (the page says the start was trimmed)
    while (s.entries.length > MAX_ENTRIES || s.chars > MAX_CHARS) {
      const gone = s.entries.shift(); if (!gone) break;
      s.chars -= JSON.stringify(gone).length; s.trimmed = true;
    }
    s.updatedAt = Date.now();
    this.send({ type: 'update', sessionId, seq, entry });
  }

  // ----- the views -------------------------------------------------------------------------------
  state() {
    return {
      type: 'state', status: this.status, detail: this.statusDetail, since: this.startedAt || null, progress: this.progress,
      agent: { id: this.agent.id, name: this.agent.name, command: [this.agent.command, ...(this.agent.args || [])].join(' ') },
      cwd: this.cwd, init: this.init, stderr: this.stderr.slice(-40), mcp: !!this.mcp,
      sessions: [...this.sessions.values()].map((s) => this.summary(s)),
      asks: [...this.asks].map(([key, a]) => ({ key, sessionId: a.sessionId, params: a.params })),
    };
  }

  setStatus(status, detail) {
    this.status = status; this.statusDetail = detail || '';
    if (status !== 'starting') { this.endWatch(); if (status === 'ready') this.progress = null; }
    this.send({ type: 'status', status, detail: this.statusDetail, since: this.startedAt || null, progress: this.progress, init: this.init, stderr: status === 'failed' || status === 'exited' ? this.stderr.slice(-40) : undefined });
  }

  sendTranscript(to, sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const all = s.entries;
    if (!all.length) return this.send({ type: 'transcript', to, sessionId, entries: [], done: true, trimmed: !!s.trimmed });
    for (let i = 0; i < all.length; i += TRANSCRIPT_BATCH) {
      const part = all.slice(i, i + TRANSCRIPT_BATCH);
      this.send({ type: 'transcript', to, sessionId, entries: part, first: i === 0, done: i + TRANSCRIPT_BATCH >= all.length, trimmed: !!s.trimmed });
    }
  }

  /** A message from a view, through the relay. */
  async onView(m) {
    const from = m.from;
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'hello': {
        this.send({ ...this.state(), to: from });
        for (const s of this.sessions.values()) this.sendTranscript(from, s.sessionId);
        return;
      }
      case 'transcript': return this.sendTranscript(from, String(m.sessionId || ''));
      case 'restart': return this.restart(!!m.force);
      case 'cancel': return this.cancel(String(m.sessionId || ''));
      case 'answer': return this.answer(String(m.key || ''), m.optionId ?? null, from);
      case 'rpc': return this.rpc(m, from);
    }
  }

  answer(key, optionId, by) {
    const a = this.asks.get(key);
    if (!a) return;                     // someone else answered first
    const opts = Array.isArray(a.params?.options) ? a.params.options : [];
    if (optionId !== null && !opts.some((o) => o.optionId === optionId)) return;   // only an option the agent offered
    this.asks.delete(key);
    a.reply({ outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } });
    this.send({ type: 'answered', key, optionId, by: by || null });
  }

  cancel(sessionId) {
    if (!sessionId) return;
    try { this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }); } catch { /* not running */ }
    // the protocol: every open permission request of the turn is answered "cancelled"
    for (const [key, a] of this.asks) if (a.sessionId === sessionId) this.answer(key, null, null);
  }

  withPlatform(params) {
    const p = { ...(params || {}) };
    // the session works in the folder the bridge was started in: a page cannot point the agent elsewhere
    p.cwd = this.cwd;
    const servers = [];
    const caps = this.init?.agentCapabilities || {};
    if (this.mcp?.http && caps.mcpCapabilities?.http) servers.push({ type: 'http', name: 'hearthcade', url: this.mcp.http, headers: [] });
    else if (this.mcp?.stdio) servers.push({ name: 'hearthcade', command: this.mcp.stdio.command, args: this.mcp.stdio.args, env: [] });
    p.mcpServers = servers;
    if (this.systemPrompt && caps.sessionCapabilities?.systemPrompt) p.systemPrompt = { mode: 'append', content: [{ type: 'text', text: this.systemPrompt }] };
    else delete p.systemPrompt;
    delete p.additionalDirectories;
    return p;
  }

  async rpc(m, from) {
    const id = m.id, method = String(m.method || '');
    const done = (result, error) => this.send({ type: 'rpc_result', to: from, id, ...(error ? { error } : { result }) });
    if (!VIEW_METHODS.has(method)) return done(undefined, { code: -32601, message: `Not allowed from the workbench: ${method}` });
    if (!this.proc || !this.init) return done(undefined, { code: -32603, message: 'The agent is not running.' });
    let params = m.params && typeof m.params === 'object' ? m.params : {};
    const sid = typeof params.sessionId === 'string' ? params.sessionId : '';
    if (method === 'session/new' || method === 'session/load' || method === 'session/resume') params = this.withPlatform(params);
    if (method === 'session/load') {
      if (!this.init.agentCapabilities?.loadSession) return done(undefined, { code: -32601, message: 'This agent cannot load sessions.' });
      const s = this.sessions.get(sid);
      if (s) { s.entries = []; s.chars = 0; this.send({ type: 'transcript', sessionId: sid, entries: [], first: true, done: true }); }   // the agent replays it
    }
    if (method === 'session/prompt') {
      const s = this.sessions.get(sid);
      if (!s) return done(undefined, { code: -32602, message: 'Unknown session.' });
      if (s.running) return done(undefined, { code: -32603, message: 'The agent is still working on the last message. Stop it or wait.' });
      const prompt = Array.isArray(params.prompt) ? params.prompt : [];
      if (!prompt.length) return done(undefined, { code: -32602, message: 'Empty message.' });
      // the agent does not echo a live prompt back, so the bridge records it for every view
      for (const block of prompt) this.record(sid, { sessionUpdate: 'user_message_chunk', content: block, _by: from, _final: true });
      if (!s.title) { const first = prompt.find((b) => b?.type === 'text'); if (first) s.title = String(first.text).replace(/[*_`#>~]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80); }
      s.running = true; s.stopReason = null; s.updatedAt = Date.now(); this.emitSession(s);
    }
    try {
      const result = await this.request(method, params);
      this.after(method, params, result);
      done(result);
    } catch (e) {
      if (method === 'session/prompt') {
        const s = this.sessions.get(sid);
        if (s) { s.running = false; s.stopReason = 'error'; this.record(sid, { sessionUpdate: '_turn_end', stopReason: 'error', error: e?.rpc?.message || String(e?.message || e) }); this.emitSession(s); }
      }
      done(undefined, e?.rpc || { code: -32603, message: String(e?.message || e) });
    }
  }

  after(method, params, result) {
    if (method === 'session/new' || method === 'session/load' || method === 'session/resume') {
      const id = method === 'session/new' ? result?.sessionId : params.sessionId;
      if (!id) return;
      const s = this.session(id, method === 'session/new' ? {} : {});
      s.attached = true;
      if (result?.modes) s.modes = result.modes;
      if (result?.configOptions) s.configOptions = result.configOptions;
      if (result?.models) s.models = result.models;
      this.emitSession(s);
    } else if (method === 'session/prompt') {
      const s = this.sessions.get(params.sessionId);
      if (!s) return;
      s.running = false; s.stopReason = result?.stopReason || 'end_turn';
      this.record(s.sessionId, { sessionUpdate: '_turn_end', stopReason: s.stopReason, usage: result?.usage || null });
      this.emitSession(s);
    } else if (method === 'session/set_mode') {
      const s = this.sessions.get(params.sessionId);
      if (s?.modes) { s.modes = { ...s.modes, currentModeId: params.modeId }; this.emitSession(s); }
    } else if (method === 'session/set_config_option') {
      const s = this.sessions.get(params.sessionId);
      if (s && Array.isArray(result?.configOptions)) { s.configOptions = result.configOptions; this.emitSession(s); }
    } else if (method === 'session/set_model') {
      const s = this.sessions.get(params.sessionId);
      if (s?.models) { s.models = { ...s.models, currentModelId: params.modelId }; this.emitSession(s); }
    } else if (method === 'session/close') {
      const s = this.sessions.get(params.sessionId);
      if (s) { this.sessions.delete(s.sessionId); this.send({ type: 'session_closed', sessionId: s.sessionId }); }
    }
  }
}

/** Splits a command line the way a shell would for simple cases: spaces, and single or double quotes. */
/** One command line for cmd.exe: arguments with spaces or cmd's special characters are quoted. */
export function winCommandLine(command, args) {
  const q = (a) => {
    a = String(a);
    if (a && !/[\s"&|<>^!()]/.test(a)) return a;
    return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  };
  return [q(command), ...args.map(q)].join(' ');
}

export function splitCommand(s) {
  const out = []; let cur = '', q = null, any = false;
  for (const ch of String(s)) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

/** The command that starts an agent from the catalog (agents.json), or null when the id is unknown. */
export function launchOf(entry) {
  const l = entry?.launch;
  if (!l) return null;
  if (l.npx) return { command: 'npx', args: ['-y', l.npx, ...(l.args || [])] };
  if (l.uvx) return { command: 'uvx', args: [l.uvx, ...(l.args || [])] };
  if (l.bin) return { command: l.bin, args: [...(l.args || [])] };
  return null;
}

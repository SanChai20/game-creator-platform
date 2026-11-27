#!/usr/bin/env node
// A small ACP v1 agent for the workbench tests: it speaks the protocol over stdio the way real agents do.
// Prompts it understands (anything else is echoed back):
//   "edit"      asks permission to write a file, then reports a diff (or a rejection)
//   "plan"      sends a three-step plan and works through it
//   "slow"      streams for ~3 s (to test cancelling)
//   "mcp"       calls the MCP server it was given (http) and reports the answer to initialize
//   "crash"     exits with code 3
//   "big N"     streams N KB of text in 1 KB chunks
// MOCK_NO_HTTP=1: does not offer HTTP MCP servers (tests the stdio proxy). MOCK_AUTH=1: session/new needs authenticate.
import { spawn } from 'node:child_process';

let buf = '', authed = !process.env.MOCK_AUTH, nextReq = 1;
const sessions = new Map(), waiting = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const ask = (method, params) => new Promise((resolve) => { const id = nextReq++; waiting.set(id, resolve); send({ id, method, params }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) handle(JSON.parse(l)); }
});
process.stdin.on('end', () => process.exit(0));

async function handle(m) {
  if (m.id !== undefined && !m.method) { const w = waiting.get(m.id); waiting.delete(m.id); w?.(m.result ?? { error: m.error }); return; }
  const { id, method, params = {} } = m;
  const ok = (result) => send({ id, result }), fail = (code, message) => send({ id, error: { code, message } });
  try {
    switch (method) {
      case 'initialize':
        return ok({ protocolVersion: 1, agentInfo: { name: 'mock-agent', title: 'Mock Agent', version: '0.1.0' }, authMethods: process.env.MOCK_AUTH ? [{ id: 'mock-login', name: 'Log in to Mock' }] : [],
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: !process.env.MOCK_NO_HTTP }, sessionCapabilities: { systemPrompt: {} } }, _client: params });
      case 'authenticate': authed = true; return ok({});
      case 'session/new': {
        if (!authed) return fail(-32000, 'Authentication required');
        const sid = 'sess_' + Math.random().toString(36).slice(2, 10);
        sessions.set(sid, { cwd: params.cwd, mcp: params.mcpServers, system: params.systemPrompt, cancel: false, mode: 'ask' });
        setTimeout(() => update(sid, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'test', description: 'Run the tests' }, { name: 'plan', description: 'Make a plan', input: { hint: 'what to plan' } }] }), 5);
        return ok({ sessionId: sid, modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }] },
          configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fast', options: [{ value: 'fast', name: 'Fast' }, { value: 'smart', name: 'Smart' }] }], _seen: { cwd: params.cwd, mcpServers: params.mcpServers, systemPrompt: params.systemPrompt } });
      }
      case 'session/load': {
        const s = sessions.get(params.sessionId) || { cwd: params.cwd };
        sessions.set(params.sessionId, { ...s, cancel: false });
        update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed question' } });
        update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed answer' } });
        return ok({});
      }
      case 'session/set_mode': { const s = sessions.get(params.sessionId); if (s) s.mode = params.modeId; return ok({}); }
      case 'session/set_config_option':
        return ok({ configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: params.value, options: [{ value: 'fast', name: 'Fast' }, { value: 'smart', name: 'Smart' }] }] });
      case 'session/cancel': { const s = sessions.get(params.sessionId); if (s) s.cancel = true; return; }
      case 'session/prompt': return ok(await prompt(params));
      default: if (id !== undefined) return fail(-32601, 'Method not found: ' + method);
    }
  } catch (e) { if (id !== undefined) fail(-32603, String(e?.message || e)); }
}

async function prompt({ sessionId, prompt: blocks }) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Unknown session');
  s.cancel = false;
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  const say = async (t, msgId = 'm' + Date.now()) => { for (const part of t.match(/.{1,7}/gs) || []) { update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: msgId, content: { type: 'text', text: part } }); await sleep(1); } };
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking about it.' } });
  if (text === 'crash') { setTimeout(() => process.exit(3), 10); return new Promise(() => {}); }
  if (text === 'edit') {
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Write index.html', kind: 'edit', status: 'pending', locations: [{ path: s.cwd + '/index.html' }] });
    const r = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 'call_1', title: 'Write index.html', kind: 'edit' }, options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always allow edits', kind: 'allow_always' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] });
    if (r?.outcome?.outcome === 'cancelled') return { stopReason: 'cancelled' };
    if (r?.outcome?.optionId === 'reject') { update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'failed' }); await say('OK, I left it alone.'); return { stopReason: 'end_turn' }; }
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed', content: [{ type: 'diff', path: s.cwd + '/index.html', oldText: null, newText: '<!doctype html>\n<title>Star Keeper</title>' }] });
    await say('Wrote index.html.');
    return { stopReason: 'end_turn' };
  }
  if (text === 'plan') {
    const steps = ['Sketch the game', 'Build it', 'Deploy a preview'];
    for (let i = 0; i <= steps.length; i++) {
      update(sessionId, { sessionUpdate: 'plan', entries: steps.map((c, j) => ({ content: c, priority: 'medium', status: j < i ? 'completed' : j === i ? 'in_progress' : 'pending' })) });
      await sleep(5);
    }
    await say('All three steps are done.');
    return { stopReason: 'end_turn' };
  }
  if (text === 'slow') {
    for (let i = 0; i < 300; i++) { if (s.cancel) return { stopReason: 'cancelled' }; update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${i} ` } }); await sleep(10); }
    return { stopReason: 'end_turn' };
  }
  if (text.startsWith('big ')) {
    const n = Number(text.slice(4)) || 1, chunk = 'x'.repeat(1023) + '\n';
    for (let i = 0; i < n; i++) update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'big', content: { type: 'text', text: chunk } });
    return { stopReason: 'end_turn' };
  }
  if (text === 'mcp') {
    const http = (s.mcp || []).find((x) => x.type === 'http'), stdio = (s.mcp || []).find((x) => !x.type && x.command);
    const body = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mock', version: '1' } } };
    let answer = 'no MCP server';
    if (http) {
      const r = await fetch(http.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...Object.fromEntries((http.headers || []).map((h) => [h.name, h.value])) }, body: JSON.stringify(body) });
      answer = `http ${r.status} ${(await r.text()).slice(0, 300)}`;
    } else if (stdio) {
      answer = await new Promise((resolve) => {
        const p = spawn(stdio.command, stdio.args, { stdio: ['pipe', 'pipe', 'inherit'] });
        let out = ''; p.stdout.on('data', (d) => { out += d; if (out.includes('\n')) { p.kill(); resolve('stdio ' + out.split('\n')[0].slice(0, 300)); } });
        p.stdin.write(JSON.stringify(body) + '\n');
        setTimeout(() => { p.kill(); resolve('stdio timeout'); }, 15000);
      });
    }
    await say(answer);
    return { stopReason: 'end_turn' };
  }
  await say(`You said: ${text}`);
  return { stopReason: 'end_turn' };
}

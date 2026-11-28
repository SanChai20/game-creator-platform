// The workbench's live connection: one WebSocket to the account's relay (src/acp.ts, AcpHub), through which every
// connected bridge (an agent on one of the creator's machines, acp-bridge/core.mjs) is reached. The bridge owns the
// agent's state; this keeps a copy for the page: each bridge's status, its sessions, their transcripts and the permission
// requests waiting for an answer.
import { useSyncExternalStore } from 'react';

export interface BridgeInfo { id: string; link?: string; at: number; agent?: string; agentId?: string; host?: string; cwd?: string; os?: string; version?: string; startedAt?: number; launch?: boolean; child?: boolean }
export interface SessionInfo {
  sessionId: string; title: string; cwd: string; createdAt: number; updatedAt: number; running: boolean; attached: boolean; stopReason: string | null; trimmed?: boolean;
  modes: { currentModeId: string; availableModes: { id: string; name: string; description?: string }[] } | null;
  configOptions: ConfigOption[] | null;
  models: { currentModelId: string; availableModels: { modelId: string; name: string; description?: string }[] } | null;
  commands: { name: string; description: string; input?: { hint?: string } | null }[];
  usage: { used: number; size: number; cost?: { amount: number; currency: string } | null } | null;
}
/** While an agent starts: its first download (npx), the last line it printed, and whether it looks stuck. */
export interface StartProgress { phase: 'starting' | 'downloading'; bytes: number; total: number | null; line: string; stalled: boolean }
export interface ConfigOption { id: string; name: string; description?: string; category?: string; type: string; currentValue: string | boolean; options?: ({ value: string; name: string; description?: string } | { group: string; name: string; options: { value: string; name: string; description?: string }[] })[] }
export interface Ask { key: string; sessionId: string; params: { toolCall?: Record<string, any>; options: { optionId: string; name: string; kind: string }[] } }
export interface Entry { sessionUpdate: string; [k: string]: any }
export interface AgentInit {
  protocolVersion: number; agentInfo?: { name: string; title?: string; version?: string };
  agentCapabilities?: { loadSession?: boolean; promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }; mcpCapabilities?: { http?: boolean; sse?: boolean }; sessionCapabilities?: Record<string, unknown> };
  authMethods?: { id: string; name: string; description?: string; type?: string }[];
}
export interface BridgeState {
  info: BridgeInfo; ready: boolean;   // ready: the bridge answered hello
  status: string; detail: string; since: number | null; progress: StartProgress | null; init: AgentInit | null; cwd: string; stderr: string[]; mcp: boolean;
  agent: { id: string; name: string; command: string } | null;
  sessions: Map<string, SessionInfo>; transcripts: Map<string, Entry[]>; asks: Map<string, Ask>;
  answered: Map<string, string | null>;
}
export type Conn = 'connecting' | 'open' | 'closed' | 'unavailable';

type Listener = () => void;
let ws: WebSocket | null = null, conn: Conn = 'closed', attempt = 0, users = 0, timer = 0, rid = 0, ver = 0, frame = 0;
const bridges = new Map<string, BridgeState>();
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
const listeners = new Set<Listener>();
let snapshot: { ver: number; conn: Conn; bridges: Map<string, BridgeState> } = { ver: 0, conn, bridges };

function changed() {
  if (frame) return;
  // a fast stream sends hundreds of chunks a second: the page draws them once a frame
  frame = requestAnimationFrame(() => { frame = 0; ver++; snapshot = { ver, conn, bridges }; listeners.forEach((f) => f()); });
}
const send = (m: unknown) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

function bridge(id: string): BridgeState {
  let b = bridges.get(id);
  if (!b) {
    b = { info: { id, at: Date.now() }, ready: false, status: 'connecting', detail: '', since: null, progress: null, init: null, cwd: '', stderr: [], mcp: false, agent: null, sessions: new Map(), transcripts: new Map(), asks: new Map(), answered: new Map() };
    bridges.set(id, b);
  }
  return b;
}

function onList(list: BridgeInfo[]) {
  const seen = new Set<string>();
  for (const info of list) {
    seen.add(info.id);
    const b = bridge(info.id), fresh = !b.info.agent && info.agent;
    b.info = info;
    if (fresh || !b.ready) send({ b: info.id, type: 'hello' });
  }
  for (const id of [...bridges.keys()]) if (!seen.has(id)) {
    bridges.delete(id);
    for (const [k, p] of pending) if (k.startsWith(id + '|')) { pending.delete(k); p.reject(new Error('The agent disconnected.')); }
  }
}

function onMessage(m: any) {
  if (m.type === 'welcome' || m.type === 'bridges') return onList(m.bridges || []);
  if (m.type === 'pong') return;
  const id = m.b as string;
  if (!id) return;
  if (m.type === 'rpc_result') {
    const p = pending.get(id + '|' + m.id);
    if (p) { pending.delete(id + '|' + m.id); m.error ? p.reject(Object.assign(new Error(m.error.message || 'Error'), { code: m.error.code, data: m.error.data, log: m.error.log || [], recorded: !!m.error.recorded })) : p.resolve(m.result); }
    return;
  }
  if (m.type === 'launch_result') {
    const p = pending.get(id + '|' + m.id);
    if (p) { pending.delete(id + '|' + m.id); m.ok ? p.resolve(undefined) : p.reject(new Error(m.error || 'Could not start it.')); }
    return;
  }
  if (!bridges.has(id)) return;
  const b = bridge(id);
  switch (m.type) {
    case 'state':
      b.ready = true; b.status = m.status; b.detail = m.detail || ''; b.since = m.since ?? null; b.progress = m.progress ?? null; b.init = m.init; b.cwd = m.cwd; b.stderr = m.stderr || []; b.mcp = !!m.mcp; b.agent = m.agent;
      b.sessions = new Map((m.sessions || []).map((s: SessionInfo) => [s.sessionId, s]));
      b.asks = new Map((m.asks || []).map((a: Ask) => [a.key, a]));
      for (const sid of [...b.transcripts.keys()]) if (!b.sessions.has(sid)) b.transcripts.delete(sid);
      break;
    case 'status':
      b.status = m.status; b.detail = m.detail || ''; b.since = m.since ?? b.since; b.progress = m.progress ?? null; if (m.init !== undefined) b.init = m.init; if (m.stderr) b.stderr = m.stderr;
      break;
    case 'progress': b.progress = m.progress ?? null; if (m.stderr) b.stderr = m.stderr; break;
    case 'session': b.sessions.set(m.session.sessionId, m.session); break;
    case 'session_closed': b.sessions.delete(m.sessionId); b.transcripts.delete(m.sessionId); break;
    case 'transcript': {
      const cur = m.first || !b.transcripts.has(m.sessionId) ? [] : b.transcripts.get(m.sessionId)!;
      b.transcripts.set(m.sessionId, cur.concat(m.entries || []));
      break;
    }
    case 'update': {
      const list = b.transcripts.get(m.sessionId) || [];
      list.push(m.entry); b.transcripts.set(m.sessionId, list);
      break;
    }
    case 'ask': b.asks.set(m.key, { key: m.key, sessionId: m.sessionId, params: m.params }); break;
    case 'answered': b.asks.delete(m.key); b.answered.set(m.key, m.optionId); break;
    default: return;
  }
  changed();
}

function open() {
  if (ws || !users) return;
  conn = 'connecting'; changed();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/api/acp/ws`);
  ws = sock;
  sock.onopen = () => { conn = 'open'; attempt = 0; changed(); };
  sock.onmessage = (e) => { try { onMessage(JSON.parse(String(e.data))); } catch { /* ignore */ } };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    for (const [k, p] of pending) { pending.delete(k); p.reject(new Error('The connection to the workbench dropped.')); }
    for (const b of bridges.values()) b.ready = false;
    conn = 'closed';
    changed();
    if (!users) return;
    const wait = Math.min(20_000, 600 * 2 ** attempt++) + Math.random() * 400;
    timer = window.setTimeout(open, wait);
  };
}

let ping = 0, closer = 0;
function subscribe(f: Listener) {
  listeners.add(f); users++;
  clearTimeout(closer);
  if (!ws) { clearTimeout(timer); open(); }
  if (!ping) ping = window.setInterval(() => send({ type: 'ping' }), 25_000);
  return () => {
    listeners.delete(f); users--;
    if (users) return;
    // a page that re-renders or moves between console tabs comes straight back: close only when it stays away
    closer = window.setTimeout(() => {
      if (users) return;
      clearTimeout(timer); clearInterval(ping); ping = 0;
      const s = ws; ws = null; try { s?.close(); } catch { /* closed */ }
      bridges.clear(); conn = 'closed';
    }, 3000);
  };
}
const getSnapshot = () => snapshot;
/** Pages use the connection while they are open; it closes a moment after the last one leaves. */
export function useWorkbench() { return useSyncExternalStore(subscribe, getSnapshot); }

export function rpc<T = any>(b: string, method: string, params: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) { reject(new Error('Not connected to the workbench.')); return; }
    const id = 'q' + ++rid;
    pending.set(b + '|' + id, { resolve, reject });
    send({ b, type: 'rpc', id, method, params });
  });
}
/** Starts another agent from the catalog in the same folder, on the computer that runs bridge `b`. */
export function launchAgent(b: string, agentId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) { reject(new Error('Not connected to the workbench.')); return; }
    const id = 'l' + ++rid, key = b + '|' + id;
    pending.set(key, { resolve, reject });
    send({ b, type: 'launch', id, agentId });
    setTimeout(() => { if (pending.delete(key)) reject(new Error('That computer did not answer.')); }, 15_000);
  });
}
/** Stops an agent that was started from the console. */
export const quitAgent = (b: string) => send({ b, type: 'quit' });
export const answer = (b: string, key: string, optionId: string | null) => send({ b, type: 'answer', key, optionId });
export const cancel = (b: string, sessionId: string) => send({ b, type: 'cancel', sessionId });
export const restart = (b: string, force = false) => send({ b, type: 'restart', ...(force ? { force: true } : {}) });
export const reconnectNow = () => { if (!ws && users) { clearTimeout(timer); attempt = 0; open(); } };

// ----- turning a transcript into what the page shows ----------------------------------------------------------------
export type Item =
  | { kind: 'user'; key: string; blocks: any[] }
  | { kind: 'agent'; key: string; text: string; blocks: any[] }
  | { kind: 'thought'; key: string; text: string }
  | { kind: 'tool'; key: string; call: ToolCall }
  | { kind: 'end'; key: string; stopReason: string; error?: string; code?: number | null; log?: string[] }
  | { kind: 'notice'; key: string; text: string };
export interface ToolCall { toolCallId: string; title: string; kind: string; status: string; content: any[]; locations: { path: string; line?: number }[]; rawInput?: unknown; rawOutput?: unknown }
export type Plan = { content: string; priority: string; status: string }[] | { markdown: string };

const textOf = (c: any) => (c && c.type === 'text' ? String(c.text ?? '') : '');

/** Folds a transcript (the agent's session/update stream plus the bridge's own records) into items. */
export function fold(entries: Entry[]): { items: Item[]; plan: Plan | null; files: Map<string, string> } {
  const items: Item[] = [], tools = new Map<string, number>(), files = new Map<string, string>();
  let plan: Plan | null = null;
  const plans = new Map<string, Plan>();
  entries.forEach((e, i) => {
    const last = items[items.length - 1];
    switch (e.sessionUpdate) {
      case 'user_message_chunk':
        // a message the bridge recorded (_final: one block each) or one the agent replays in chunks
        if (last?.kind === 'user') {
          const lb = last.blocks[last.blocks.length - 1];
          if (!e._final && lb?.type === 'text' && e.content?.type === 'text') last.blocks[last.blocks.length - 1] = { ...lb, text: lb.text + e.content.text };
          else last.blocks.push(e.content);
        } else items.push({ kind: 'user', key: 'u' + i, blocks: [e.content] });
        break;
      case 'agent_message_chunk':
        if (last?.kind === 'agent' && (last as any).mid === (e.messageId ?? null)) { last.text += textOf(e.content); if (e.content?.type !== 'text') last.blocks.push(e.content); }
        else items.push({ kind: 'agent', key: 'a' + i, text: textOf(e.content), blocks: e.content?.type !== 'text' ? [e.content] : [], mid: e.messageId ?? null } as Item);
        break;
      case 'agent_thought_chunk':
        if (last?.kind === 'thought') last.text += textOf(e.content);
        else items.push({ kind: 'thought', key: 't' + i, text: textOf(e.content) });
        break;
      case 'tool_call':
      case 'tool_call_update': {
        const id = String(e.toolCallId || '');
        let at = tools.get(id);
        if (at === undefined) {
          at = items.length; tools.set(id, at);
          items.push({ kind: 'tool', key: 'c' + id + i, call: { toolCallId: id, title: '', kind: 'other', status: 'pending', content: [], locations: [] } });
        }
        const c = (items[at] as Extract<Item, { kind: 'tool' }>).call;
        if (e.title) c.title = e.title;
        if (e.kind) c.kind = e.kind;
        if (e.status) c.status = e.status;
        if (Array.isArray(e.content)) c.content = e.content;
        if (Array.isArray(e.locations)) c.locations = e.locations;
        if (e.rawInput != null) c.rawInput = e.rawInput;
        if (e.rawOutput != null) c.rawOutput = e.rawOutput;
        for (const l of c.locations) if (l?.path) files.set(l.path, c.kind);
        for (const x of c.content) if (x?.type === 'diff' && x.path) files.set(x.path, 'edit');
        break;
      }
      case 'plan': plan = Array.isArray(e.entries) ? e.entries : null; break;
      case 'plan_update': if (e.plan?.planId) { plans.set(e.plan.planId, e.plan.type === 'markdown' ? { markdown: String(e.plan.content || '') } : (e.plan.entries || [])); plan = plans.get(e.plan.planId)!; } break;
      case 'plan_removed': plans.delete(e.planId); plan = [...plans.values()].pop() || null; break;
      case '_turn_end': items.push({ kind: 'end', key: 'e' + i, stopReason: e.stopReason, error: e.error, code: e.code ?? null, log: e.log || [] }); break;
      case 'current_mode_update': break;
      default: break;
    }
  });
  return { items, plan, files };
}

/** The agent's name for people: what it reports, else the catalog's. */
// a custom agent keeps the name the creator gave it; a listed one shows what the agent calls itself
export const agentTitle = (b: BridgeState) => (b.info.agentId === 'custom' && b.info.agent) || b.init?.agentInfo?.title || b.info.agent || b.agent?.name || b.init?.agentInfo?.name || 'Agent';

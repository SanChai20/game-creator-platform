// Realtime rooms for multiplayer games: a WebSocket relay with presence, a host, and a small shared
// snapshot. One Durable Object per (game, environment, room code). Uses WebSocket hibernation, so an
// idle room costs nothing. The first player in is the host; if the host leaves, the oldest peer takes over.
// Messages are JSON text frames, or binary frames in a small envelope (src/room-wire.ts) for games that pack their own
// data. Every socket has a message and byte budget, so one player (or one buggy loop) cannot flood the others.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
// @ts-ignore plain JS module
import { bindingProblem } from './session-binding.js';
import { RateBudget, decodeClientFrame, encodeRelayFrame } from './room-wire';

interface Peer { id: string; name: string; at: number; g?: string; e?: string; r?: string; uid?: string; s?: string; k?: string; x?: number; tr?: boolean; mr?: number }
const RECHECK_MS = 10_000;   // how often open sockets are checked against their play session (sign-out, trial end)
const MAX_MSG = 64 * 1024, MAX_STATE = 256 * 1024;
const DEFAULT_RATE = 60;          // messages per second per socket, sustained; bursts of twice that are allowed
const BYTES_PER_SECOND = 256 * 1024;

export class GameRoom extends DurableObject<Env> {
  // Per-socket budgets. In memory only: a room that hibernates has been idle, so a fresh budget on wake is right.
  private budgets = new Map<WebSocket, RateBudget>();
  private budget(ws: WebSocket, p: Peer): RateBudget {
    let b = this.budgets.get(ws);
    if (!b) this.budgets.set(ws, (b = new RateBudget(p.mr || DEFAULT_RATE, BYTES_PER_SECOND)));
    return b;
  }
  private peers(): { ws: WebSocket; p: Peer }[] {
    return this.ctx.getWebSockets().map((ws) => ({ ws, p: ws.deserializeAttachment() as Peer })).filter((x) => x.p).sort((a, b) => a.p.at - b.p.at);
  }
  private host(): string | null { return this.peers()[0]?.p.id ?? null; }
  private send(ws: WebSocket, m: unknown) { try { ws.send(JSON.stringify(m)); } catch { /* closing */ } }
  /** Keeps room_presence in step with who is connected, so the console can show room occupancy. Never fails a join or leave. */
  private async presence(p: Peer | null | undefined, players: number) {
    if (!p?.g || !p.e || !p.r) return;
    try {
      if (players > 0) await this.env.DB.prepare('INSERT INTO room_presence (project_id, env, room, players, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, env, room) DO UPDATE SET players = excluded.players, updated_at = excluded.updated_at').bind(p.g, p.e, p.r, players, Date.now()).run();
      else await this.env.DB.prepare('DELETE FROM room_presence WHERE project_id = ? AND env = ? AND room = ?').bind(p.g, p.e, p.r).run();
    } catch (e) { console.error('room presence', e); }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    // The room's size is fixed by whoever opens it, so a later joiner cannot raise it by asking for more.
    const asked = Math.max(2, Math.min(Number(url.searchParams.get('cap')) || 16, 64));
    let max = await this.ctx.storage.get<number>('cap');
    if (!max || !this.peers().length) { max = asked; await this.ctx.storage.put('cap', max); }
    const pair = new WebSocketPair();
    const existing = this.peers();
    this.ctx.acceptWebSocket(pair[1]);
    if (existing.length >= max) { pair[1].close(4003, 'Room is full'); return new Response(null, { status: 101, webSocket: pair[0] }); }
    const base = url.searchParams.get('uid') || 'p';
    // The same account may join from two tabs; give each connection its own peer id.
    let id = base, i = 2;
    while (existing.some((e) => e.p.id === id)) id = `${base}#${i++}`;
    const q = url.searchParams;
    const peer: Peer = { id, name: (q.get('name') || 'Player').slice(0, 40), at: Date.now() + existing.length / 1000, g: q.get('g') || undefined, e: q.get('e') || undefined, r: q.get('r') || undefined,
      uid: q.get('uid') || undefined, s: q.get('s') || undefined, k: q.get('k') || undefined, x: Number(q.get('x')) || undefined, tr: q.get('tr') === '1',
      mr: Math.max(5, Math.min(Number(q.get('mr')) || DEFAULT_RATE, 240)) };
    pair[1].serializeAttachment(peer);
    for (const e of existing) this.send(e.ws, { t: 'join', peer: { id: peer.id, name: peer.name } });
    const state = await this.ctx.storage.get<string>('state');
    this.send(pair[1], { t: 'welcome', id: peer.id, host: existing[0]?.p.id ?? peer.id, peers: existing.map((e) => ({ id: e.p.id, name: e.p.name })), state: state ? JSON.parse(state) : null });
    await this.presence(peer, existing.length + 1);
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + RECHECK_MS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Closes sockets whose play session ended after they joined: signed out, switched account, suspended, a claimed
      guest, or a free trial that ran out. The check at join time alone would let them keep relaying for hours. */
  async alarm(): Promise<void> {
    const peers = this.peers(), t = Date.now();
    for (const { ws, p } of peers) {
      if (!p.s || !p.g || !p.e || !p.uid) continue;
      let reason: string | null = null;
      if (p.tr && p.x && t / 1000 > p.x) reason = 'The free trial is over.';
      else {
        const problem = await bindingProblem(this.env.DB, { g: p.g, e: p.e, u: p.uid, k: p.k || 'player', s: p.s }, t).catch(() => null);
        if (problem) reason = problem.message;
      }
      if (reason) { this.send(ws, { t: 'error', code: 'session_ended', message: reason }); try { ws.close(4001, 'Session ended'); } catch { /* closing */ } await this.left(ws); }
    }
    if (this.peers().length) await this.ctx.storage.setAlarm(Date.now() + RECHECK_MS);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const me = ws.deserializeAttachment() as Peer;
    if (!me) return;
    const size = typeof raw === 'string' ? raw.length : raw.byteLength;
    const verdict = this.budget(ws, me).take(size, Date.now());
    if (verdict !== 'ok') {
      if (verdict === 'close') { this.send(ws, { t: 'error', code: 'rate_limited', message: 'Too many messages: the room closed this connection.' }); try { ws.close(4008, 'Too many messages'); } catch { /* closing */ } await this.left(ws); }
      else if (verdict === 'warn') this.send(ws, { t: 'error', code: 'rate_limited', message: `Too many messages: at most ${me.mr || DEFAULT_RATE} a second (and ${BYTES_PER_SECOND / 1024} KB a second) per player. Extra messages are dropped.` });
      return;
    }
    if (typeof raw !== 'string') return this.relayBinary(ws, me, raw);
    if (raw.length > MAX_STATE + 64) return;
    let m: { t?: string; to?: string; d?: unknown; at?: unknown; n?: unknown };
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'msg') {
      if (raw.length > MAX_MSG) return this.send(ws, { t: 'error', message: 'Message too large (64 KB max).' });
      // `at` is the sender's clock when it sent the message; receivers use it to play movement back smoothly (GCP.smooth)
      const out = JSON.stringify(typeof m.at === 'number' && Number.isFinite(m.at) ? { t: 'msg', from: me.id, d: m.d, at: m.at } : { t: 'msg', from: me.id, d: m.d });
      const to = m.to === 'host' ? this.host() : typeof m.to === 'string' ? m.to : null;
      for (const e of this.peers()) { if (e.ws !== ws && (!to || e.p.id === to)) { try { e.ws.send(out); } catch { /* closing */ } } }
    } else if (m.t === 'state') {
      if (this.host() !== me.id) return this.send(ws, { t: 'error', message: 'Only the host can set room state.' });
      const s = JSON.stringify(m.d ?? null);
      if (s.length > MAX_STATE) return this.send(ws, { t: 'error', message: 'Room state too large (256 KB max).' });
      // allowUnconfirmed: without it the Durable Object's output gate holds every outgoing message, the realtime relay
      // included, until the write is durable, so each setState put a hitch into everyone's movement stream.
      // The snapshot is only for late joiners; losing the last one in a crash is harmless.
      await this.ctx.storage.put('state', s, { allowUnconfirmed: true });
      for (const e of this.peers()) if (e.ws !== ws) this.send(e.ws, { t: 'state', d: m.d });
    } else if (m.t === 'ping') this.send(ws, typeof m.n === 'number' && Number.isFinite(m.n) ? { t: 'pong', now: Date.now(), n: m.n } : { t: 'pong', now: Date.now() });
  }

  /** A binary frame: the envelope names the target and the send time; receivers get the sender's id in front of the payload. */
  private relayBinary(ws: WebSocket, me: Peer, raw: ArrayBuffer): void {
    if (raw.byteLength > MAX_MSG) return this.send(ws, { t: 'error', message: 'Message too large (64 KB max).' });
    const f = decodeClientFrame(raw);
    if (!f) return this.send(ws, { t: 'error', message: 'Malformed binary message: send binary data with room.send(arrayBuffer).' });
    const to = f.to === 'host' ? this.host() : f.to;
    const out = encodeRelayFrame(me.id, f.at, f.payload);
    for (const e of this.peers()) { if (e.ws !== ws && (!to || e.p.id === to)) { try { e.ws.send(out); } catch { /* closing */ } } }
  }

  /** For the game's creator (MCP game_room): who is here, who hosts, and the stored snapshot. Called over RPC only, never from a player's request. */
  async inspect(): Promise<{ players: { id: string; name: string; host: boolean; joined_at: string }[]; host: string | null; state_json: string | null }> {
    const peers = this.peers(), raw = await this.ctx.storage.get<string>('state');
    return { players: peers.map((e, i) => ({ id: e.p.id, name: e.p.name, host: i === 0, joined_at: new Date(Math.floor(e.p.at)).toISOString() })), host: peers[0]?.p.id ?? null, state_json: raw ?? null };
  }

  /** Clears a stuck room: drops the snapshot and, with kick, disconnects everyone (they can rejoin at once). */
  async reset(kick: boolean): Promise<{ cleared: boolean; disconnected: number }> {
    await this.ctx.storage.deleteAll();
    const peers = this.peers();
    for (const e of peers) { this.send(e.ws, { t: 'state', d: null }); if (kick) try { e.ws.close(4000, 'Room reset by the game creator'); } catch { /* closing */ } }
    if (kick && peers.length) await this.presence(peers[0].p, 0);
    return { cleared: true, disconnected: kick ? peers.length : 0 };
  }

  async webSocketClose(ws: WebSocket): Promise<void> { await this.left(ws); }
  async webSocketError(ws: WebSocket): Promise<void> { await this.left(ws); }

  private async left(ws: WebSocket): Promise<void> {
    this.budgets.delete(ws);
    const me = ws.deserializeAttachment() as Peer | null;
    // Once only per socket: a socket the room closed itself (session ended, flooding) also gets webSocketClose later,
    // and announcing the same leave twice would make clients see a second, wrong host change.
    if (!me) return;
    try { ws.serializeAttachment(null); } catch { /* closed */ }
    try { ws.close(1000); } catch { /* already closed */ }
    const rest = this.peers().filter((e) => e.ws !== ws);
    for (const e of rest) this.send(e.ws, { t: 'leave', id: me.id, host: rest[0]?.p.id ?? null });
    await this.presence(me, rest.length);
    if (!rest.length) { await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); } // empty rooms keep nothing
  }
}

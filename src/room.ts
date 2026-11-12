// Realtime rooms for multiplayer games: a WebSocket relay with presence, a host, and a small shared
// snapshot. One Durable Object per (game, environment, room code). Uses WebSocket hibernation, so an
// idle room costs nothing. The first player in is the host; if the host leaves, the oldest peer takes over.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

interface Peer { id: string; name: string; at: number }
const MAX_MSG = 64 * 1024, MAX_STATE = 256 * 1024;

export class GameRoom extends DurableObject<Env> {
  private peers(): { ws: WebSocket; p: Peer }[] {
    return this.ctx.getWebSockets().map((ws) => ({ ws, p: ws.deserializeAttachment() as Peer })).filter((x) => x.p).sort((a, b) => a.p.at - b.p.at);
  }
  private host(): string | null { return this.peers()[0]?.p.id ?? null; }
  private send(ws: WebSocket, m: unknown) { try { ws.send(JSON.stringify(m)); } catch { /* closing */ } }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const max = Math.max(2, Math.min(Number(url.searchParams.get('cap')) || 16, 64));
    const pair = new WebSocketPair();
    const existing = this.peers();
    this.ctx.acceptWebSocket(pair[1]);
    if (existing.length >= max) { pair[1].close(4003, 'Room is full'); return new Response(null, { status: 101, webSocket: pair[0] }); }
    const base = url.searchParams.get('uid') || 'p';
    // The same account may join from two tabs; give each connection its own peer id.
    let id = base, i = 2;
    while (existing.some((e) => e.p.id === id)) id = `${base}#${i++}`;
    const peer: Peer = { id, name: (url.searchParams.get('name') || 'Player').slice(0, 40), at: Date.now() + existing.length / 1000 };
    pair[1].serializeAttachment(peer);
    for (const e of existing) this.send(e.ws, { t: 'join', peer: { id: peer.id, name: peer.name } });
    const state = await this.ctx.storage.get<string>('state');
    this.send(pair[1], { t: 'welcome', id: peer.id, host: existing[0]?.p.id ?? peer.id, peers: existing.map((e) => ({ id: e.p.id, name: e.p.name })), state: state ? JSON.parse(state) : null });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > MAX_STATE + 64) return;
    const me = ws.deserializeAttachment() as Peer;
    let m: { t?: string; to?: string; d?: unknown };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'msg') {
      if (raw.length > MAX_MSG) return this.send(ws, { t: 'error', message: 'Message too large (64 KB max).' });
      const out = JSON.stringify({ t: 'msg', from: me.id, d: m.d });
      const to = m.to === 'host' ? this.host() : m.to;
      for (const e of this.peers()) { if (e.ws !== ws && (!to || e.p.id === to)) { try { e.ws.send(out); } catch { /* closing */ } } }
    } else if (m.t === 'state') {
      if (this.host() !== me.id) return this.send(ws, { t: 'error', message: 'Only the host can set room state.' });
      const s = JSON.stringify(m.d ?? null);
      if (s.length > MAX_STATE) return this.send(ws, { t: 'error', message: 'Room state too large (256 KB max).' });
      await this.ctx.storage.put('state', s);
      for (const e of this.peers()) if (e.ws !== ws) this.send(e.ws, { t: 'state', d: m.d });
    } else if (m.t === 'ping') this.send(ws, { t: 'pong' });
  }

  async webSocketClose(ws: WebSocket): Promise<void> { await this.left(ws); }
  async webSocketError(ws: WebSocket): Promise<void> { await this.left(ws); }

  private async left(ws: WebSocket): Promise<void> {
    const me = ws.deserializeAttachment() as Peer | null;
    try { ws.close(1000); } catch { /* already closed */ }
    const rest = this.peers().filter((e) => e.ws !== ws);
    if (me) for (const e of rest) this.send(e.ws, { t: 'leave', id: me.id, host: rest[0]?.p.id ?? null });
    if (!rest.length) await this.ctx.storage.deleteAll(); // empty rooms keep nothing
  }
}

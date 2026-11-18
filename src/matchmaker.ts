// The matchmaker for server-run matches (GCP.match.find). One Durable Object per game, environment and queue shape
// (queue, players, min, teams, mode), or per private code. Players wait on a WebSocket; once a group is formed the
// matchmaker records the match, signs one ticket per player (src/runtime/game-worker.js verifies it), sends each player
// their ticket and closes the socket. The match itself runs in the game's own Worker (GameMatch), not here.
// Uses WebSocket hibernation: everything about a waiting player lives in its socket's attachment.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
// @ts-ignore plain JS module
import { bindingProblem } from './session-binding.js';
// @ts-ignore plain JS module
import { signPlayToken } from './runtime/game-worker.js';
import { playKey } from './deploy';
import { hmacHex } from './util';
import { groupHint, isRegionHint, type RegionHint } from './placement';
import { assignTeams, formGroups, type Waiting } from './match-making';

/** What a waiting socket carries (set by the /api/rt/match route from the verified play token). */
export interface Seat {
  u: string; n: string; s: string; k: string; px: number; tr: boolean;   // the player and their play session
  g: string; e: string; q: string; size: number; min: number; teams: number; mode: string; code: string | null;
  region: RegionHint | null; rating: number; at: number;
}

const TICKET_TTL_S = 2 * 3600;
const TICK_MS = 1000, RECHECK_MS = 10_000, MAX_WAITING = 2000;

export const matchTicketKey = async (env: Env, g: string) => hmacHex(await playKey(env, g), 'match-ticket');

export class Matchmaker extends DurableObject<Env> {
  private seats(): { ws: WebSocket; s: Seat }[] {
    // in the order they joined (the runtime does not keep it): a lobby's owner is the first one in
    return this.ctx.getWebSockets().map((ws) => ({ ws, s: ws.deserializeAttachment() as Seat })).filter((x) => x.s && x.s.u)
      .sort((a, b) => a.s.at - b.s.at);
  }
  private send(ws: WebSocket, m: unknown) { try { ws.send(JSON.stringify(m)); } catch { /* closing */ } }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const seat = JSON.parse(new URL(request.url).searchParams.get('seat') || 'null') as Seat | null;
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    if (!seat || !seat.u) { pair[1].close(4000, 'Bad request'); return new Response(null, { status: 101, webSocket: pair[0] }); }
    const all = this.seats();
    if (all.length >= MAX_WAITING) { pair[1].close(4003, 'The queue is full. Try again in a moment.'); return new Response(null, { status: 101, webSocket: pair[0] }); }
    // one place in the queue per player: a second tab takes it over
    for (const x of all) if (x.s.u === seat.u) {
      x.ws.serializeAttachment(null);
      this.send(x.ws, { t: 'error', code: 'replaced', message: 'Searching in another tab.' });
      try { x.ws.close(4002, 'Searching in another tab'); } catch { /* closed */ }
    }
    pair[1].serializeAttachment({ ...seat, at: Date.now() });
    this.send(pair[1], { t: 'queued', queue: seat.q, players: seat.size, code: seat.code, waiting: this.seats().length });
    if (seat.code) this.lobby();
    else await this.match();
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const me = ws.deserializeAttachment() as Seat | null;
    if (!me || typeof raw !== 'string' || raw.length > 200) return;
    let m: { t?: string };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'cancel') { ws.serializeAttachment(null); try { ws.close(1000, 'Cancelled'); } catch { /* closed */ } if (me.code) this.lobby(); }
    // a private lobby starts early when its first player says so and at least `min` are there
    else if (m.t === 'start' && me.code) {
      const here = this.seats();
      if (here[0]?.s.u === me.u && here.length >= me.min) await this.launch(here.slice(0, me.size));
      else this.send(ws, { t: 'error', code: 'cannot_start', message: here[0]?.s.u === me.u ? `At least ${me.min} players are needed.` : 'Only the player who opened the lobby can start it.' });
    }
  }
  async webSocketClose(ws: WebSocket): Promise<void> { this.gone(ws); }
  async webSocketError(ws: WebSocket): Promise<void> { this.gone(ws); }
  private gone(ws: WebSocket) {
    const me = ws.deserializeAttachment() as Seat | null;
    if (!me) return;
    try { ws.serializeAttachment(null); } catch { /* closed */ }
    if (me.code) this.lobby();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    // sessions that ended while waiting (signed out, trial over) leave the queue
    const last = (await this.ctx.storage.get<number>('recheck')) || 0;
    if (now - last >= RECHECK_MS) {
      await this.ctx.storage.put('recheck', now);
      for (const { ws, s } of this.seats()) {
        let reason: string | null = null;
        if (s.tr && s.px && now / 1000 > s.px) reason = 'The free trial is over.';
        else { const p = await bindingProblem(this.env.DB, { g: s.g, e: s.e, u: s.u, k: s.k, s: s.s }, now).catch(() => null); if (p) reason = p.message; }
        if (reason) { ws.serializeAttachment(null); this.send(ws, { t: 'error', code: 'session_ended', message: reason }); try { ws.close(4001, 'Session ended'); } catch { /* closed */ } }
      }
    }
    const left = this.seats();
    if (!left.length) return;
    if (left[0].s.code) this.lobby(); else await this.match();
    const still = this.seats();
    for (const { ws, s } of still) this.send(ws, { t: 'queued', queue: s.q, players: s.size, code: s.code, waiting: still.length, waited: Math.round((now - s.at) / 1000) });
    if (still.length) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  /** Public queue: form every group the rules allow now. */
  private async match(): Promise<void> {
    const here = this.seats();
    if (!here.length || here.length < Math.min(2, here[0].s.min)) return;
    const shape = here[0].s;
    const groups = formGroups(here.map(({ s }) => ({ u: s.u, n: s.n, region: s.region, rating: s.rating, at: s.at } as Waiting)), Date.now(), shape.size, shape.min);
    for (const g of groups) await this.launch(g.map((w) => here.find((x) => x.s.u === w.u)!));
  }

  /** Private lobby: everyone sees who is in; it starts by itself when full. */
  private lobby(): void {
    const here = this.seats();
    if (!here.length) return;
    const size = here[0].s.size;
    if (here.length >= size) { void this.launch(here.slice(0, size)); return; }
    const players = here.map(({ s }) => ({ id: s.u, name: s.n }));
    for (const { ws } of here) this.send(ws, { t: 'lobby', code: here[0].s.code, players, owner: players[0].id, need: size });
  }

  /** Records the match, gives each player a signed ticket, and lets them go. */
  private async launch(group: { ws: WebSocket; s: Seat }[]): Promise<void> {
    const live = group.filter((x) => x.ws.deserializeAttachment());
    // a queue or lobby with min 1 may start with one player (the game fills the empty seats); any other needs two
    if (!live.length || live.length < Math.min(2, live[0].s.min)) return;
    for (const x of live) x.ws.serializeAttachment(null);   // taken: nobody else can match them while this runs
    const first = live[0].s, id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const roster = assignTeams(live.map(({ s }) => ({ id: s.u, name: s.n, rating: Math.round(s.rating) })), first.teams);
    const hint = groupHint(live.map((x) => x.s.region));
    const seed = (Math.random() * 2 ** 32) >>> 0;
    try {
      await this.env.DB.prepare('INSERT INTO matches (id, project_id, env, queue, mode, roster, region, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, first.g, first.e, first.q, first.mode, JSON.stringify(roster.map((r) => ({ id: r.id, name: r.name, team: r.team, rating: r.rating, k: live.find((x) => x.s.u === r.id)!.s.k }))), hint, Date.now()).run();
    } catch (e) {
      console.error('match record failed', e);
      for (const { ws } of live) { this.send(ws, { t: 'error', code: 'match_failed', message: 'Could not start the match. Try again.' }); try { ws.close(1011, 'Match failed'); } catch { /* closed */ } }
      return;
    }
    const key = await matchTicketKey(this.env, first.g), x = Math.floor(Date.now() / 1000) + TICKET_TTL_S;
    const r = roster.map((p) => ({ id: p.id, name: p.name, team: p.team }));
    for (const { ws, s } of live) {
      const ticket = await signPlayToken({ typ: 'match', g: s.g, e: s.e, m: id, u: s.u, n: s.n, s: s.s, k: s.k, px: s.px, tr: s.tr ? 1 : 0, x, h: hint, q: s.q, seed, min: s.min, r, o: s.mode ? { mode: s.mode } : {} }, key);
      this.send(ws, { t: 'found', match: id, ticket, region: hint, players: r });
      try { ws.close(1000, 'Match found'); } catch { /* closed */ }
    }
  }
}

/** The placement hint a request carries, when it is one Durable Objects accept. */
export const seatRegion = (h: unknown): RegionHint | null => (isRegionHint(h) ? h : null);

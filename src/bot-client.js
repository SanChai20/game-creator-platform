// One preview test bot: a remote client of the game that speaks the SDK's protocols (web/public/sdk/gcp.js) over real
// WebSockets. Pure apart from the io it is given, so tests/bots.mjs drives it in Node against the real Durable Objects
// (wrangler dev) or a fake, and src/bots.ts (BotFleet) runs it in a Durable Object with fetch() upgrades.
//
// io: {
//   now(): ms
//   open(url, { message(data), close(code, reason) }): Promise<{ send(data), close(code, reason) }>   (a WebSocket)
//   api(path, body): Promise<json>                 (a POST to the platform's /api/rt/…)
//   think(call): Promise<{ input?, send?, memory?, error? }>    (the game's server/bot.js, src/runtime/bot-runner.js)
//   log(text), changed()                           (something worth showing happened)
// }
import { BOT_LIMITS, NetLink, NetStats, patch } from './bots-core.js';

// close codes after which the SDK does not try again (the match is over or this player is out of it for good)
const FINAL = new Set([1000, 4001, 4002, 4003, 4004, 4009, 4500]);

export class BotClient {
  /** o: { id, name, token, platform (origin), game (the game's origin), net, skill, seed, thinkMs } */
  constructor(o, io) {
    this.id = o.id; this.name = o.name; this.token = o.token; this.platform = o.platform.replace(/\/$/, ''); this.game = o.game.replace(/\/$/, '');
    this.io = io; this.skill = o.skill ?? 1; this.seed = o.seed >>> 0; this.thinkMs = o.thinkMs || 250;
    this.up = new NetLink(o.net, rand(this.seed ^ 0x51ed)); this.down = new NetLink(o.net, rand(this.seed ^ 0xa3b1));
    this.stats = new NetStats();
    this.phase = 'idle'; this.detail = null; this.target = null;
    this.mm = null; this.ws = null; this.ticket = null; this.match = null; this.me = null; this.players = [];
    this.view = undefined; this.tick = 0; this.n = 0; this.acked = 0; this.events = []; this.memory = {}; this.calls = 0;
    this.joinedAt = 0; this.pingN = 0; this.pings = new Map(); this.timers = new Set(); this.thinking = false; this.lastThink = 0;
    this.tries = 0; this.stopped = false; this.results = 0; this.room = null; this.inbox = []; this.roomState = null; this.peers = []; this.host = null;
    this.brain = { last: null, errors: 0, ms: 0 };
  }

  // ----- timers that all stop with the bot --------------------------------------------------------------------------
  later(ms, fn) { const t = setTimeout(() => { this.timers.delete(t); if (!this.stopped) fn(); }, Math.max(0, ms)); this.timers.add(t); return t; }
  every(ms, fn) { const t = setInterval(() => { if (!this.stopped) fn(); }, ms); this.timers.add(t); return t; }
  clear(t) { if (t) { clearTimeout(t); clearInterval(t); this.timers.delete(t); } }
  set(phase, detail = null) { this.phase = phase; this.detail = detail; this.io.changed(); }

  // ----- the last mile: everything in and out goes through the bot's links ----------------------------------------
  out(sock, text) {
    if (!sock) return;
    const now = this.io.now(), at = this.up.schedule(now), size = typeof text === 'string' ? text.length : text.byteLength;
    this.stats.outBytes(now, size);
    const go = () => { try { sock.send(text); } catch { /* closing */ } };
    if (at <= now) go(); else this.later(at - now, go);
  }
  in(fn) {
    return (data) => {
      const now = this.io.now(), at = this.down.schedule(now);
      if (at <= now) fn(data); else this.later(at - now, () => fn(data));
    };
  }

  // ----- finding a match ----------------------------------------------------------------------------------------------
  /** target: { kind: 'match', query } (the matchmaker query string after the token) or { kind: 'room', room, max } */
  async go(target) {
    this.target = target;
    if (target.kind === 'room') return this.joinRoom(target);
    this.closeAll();
    this.set('searching');
    const url = `${this.platform.replace(/^http/, 'ws')}/api/rt/match?t=${encodeURIComponent(this.token)}&${target.query}`;
    let sock;
    try {
      sock = await this.io.open(url, {
        message: this.in((data) => this.onQueue(sock, data)),
        close: (code, reason) => { if (this.mm === sock) { this.mm = null; if (this.phase === 'searching') { this.stats.closed(code, reason); this.set('idle', reason || `closed ${code}`); } } },
      });
    } catch (e) { this.stats.error(`matchmaker: ${e.message || e}`); this.set('idle', 'could not reach the matchmaker'); return; }
    if (this.stopped) { try { sock.close(1000, 'stopped'); } catch { /* closed */ } return; }
    this.mm = sock;
  }
  onQueue(sock, data) {
    if (typeof data !== 'string') return;
    let m; try { m = JSON.parse(data); } catch { return; }
    this.stats.inBytes(this.io.now(), data.length);
    if (m.t === 'queued') this.set('searching', m.code ? `lobby ${m.code}` : `queue ${m.queue}, ${m.waiting} waiting`);
    else if (m.t === 'lobby') this.set('searching', `lobby: ${(m.players || []).length} of ${m.need}`);
    else if (m.t === 'found') { this.ticket = m.ticket; this.match = m.match; this.players = m.players || []; this.mm = null; try { sock.close(1000, 'found'); } catch { /* closed */ } this.io.log(`${this.name}: found match ${m.match.slice(0, 8)} (${this.players.length} players)`); this.connectMatch(); }
    else if (m.t === 'error') { this.stats.error(m.message || m.code); this.io.log(`${this.name}: matchmaker said ${m.code || ''} ${m.message || ''}`); }
  }

  // ----- the match ------------------------------------------------------------------------------------------------------
  async connectMatch() {
    if (!this.ticket || this.stopped) return;
    this.set(this.tries ? 'reconnecting' : 'connecting');
    const url = `${this.game.replace(/^http/, 'ws')}/__gcp/match?t=${encodeURIComponent(this.ticket)}`;
    let sock, opened = false;
    try {
      sock = await this.io.open(url, {
        message: this.in((data) => { if (this.ws === sock) this.onMatch(data); }),
        close: (code, reason) => { if (this.ws === sock) this.onMatchClose(code, reason, opened); },
      });
    } catch (e) { this.stats.error(`match: ${e.message || e}`); return this.retry(0, String(e.message || e)); }
    if (this.stopped) { try { sock.close(1000, 'stopped'); } catch { /* closed */ } return; }
    opened = true; this.ws = sock; this.joinedAt = this.joinedAt || this.io.now();
    this.clear(this.pinger); this.pinger = this.every(BOT_LIMITS.pingMs, () => this.ping());
    this.clear(this.thinker); this.thinker = this.every(Math.max(50, Math.min(this.thinkMs, 10_000)), () => this.think());
  }
  ping() {
    const sock = this.ws || this.room; if (!sock) return;
    const n = ++this.pingN; this.pings.set(n, this.io.now());
    if (this.pings.size > 20) this.pings.delete(this.pings.keys().next().value);
    this.out(sock, JSON.stringify(this.room ? { t: 'ping', n } : { t: 'p', n }));
  }
  pong(n) { const at = this.pings.get(n); if (at != null) { this.pings.delete(n); this.stats.rtt(this.io.now(), this.io.now() - at); } }
  onMatch(data) {
    const now = this.io.now();
    if (typeof data !== 'string') { this.stats.inBytes(now, data.byteLength || 0); return; }
    this.stats.inBytes(now, data.length);
    let m; try { m = JSON.parse(data); } catch { return; }
    switch (m.t) {
      case 'hello':
        this.tries = 0; this.me = m.you; this.players = m.players || this.players;
        // inputs are numbered on from where the match is (a bot that came back must not start at zero again)
        this.n = Math.max(this.n, m.n != null ? Number(m.n) : Number(m.ack) || 0);
        this.set(m.phase === 'running' ? 'playing' : 'waiting', `${(m.players || []).filter((p) => p.connected).length} of ${(m.players || []).length} here`);
        break;
      case 'wait': this.players = m.players || this.players; this.set('waiting', `${this.players.filter((p) => p.connected).length} of ${this.players.length} here`); break;
      case 'start': this.players = m.players || this.players; this.set('playing'); this.io.log(`${this.name}: match started`); break;
      case 'players': this.players = m.players || this.players; break;
      case 's':
        this.view = m.f ? m.d : patch(this.view, m.d); this.tick = m.k; this.acked = Math.max(this.acked, Number(m.a) || 0);
        this.stats.snapshot(now); this.stats.ackLag(now, Math.max(0, this.n - this.acked));
        if (this.phase !== 'playing') this.set('playing');
        break;
      case 'e': this.events.push(m.d); if (this.events.length > BOT_LIMITS.maxEvents) this.events.shift(); break;
      case 'po': this.pong(Number(m.n)); break;
      case 'end': this.results++; this.set('ended', m.result && m.result.ranking ? `place ${1 + m.result.ranking.findIndex((pl) => pl.includes(this.me))}` : (m.result && m.result.reason) || 'match over'); this.io.log(`${this.name}: match ended (${this.detail})`); break;
      case 'error': this.stats.error(m.message || m.code); this.io.log(`${this.name}: match error ${m.code || ''} ${m.message || ''}`); break;
    }
  }
  onMatchClose(code, reason, opened) {
    this.ws = null; this.clear(this.pinger); this.clear(this.thinker);
    this.stats.closed(code, reason);
    if (this.dropping) return;   // a drop the creator asked for: it comes back by itself (drop())
    if (FINAL.has(code) || this.phase === 'ended') { this.ticket = null; if (this.phase !== 'ended') this.set('out', reason || `closed ${code}`); this.io.changed(); return; }
    this.retry(code, reason, opened);
  }
  retry(code, reason) {
    const waits = BOT_LIMITS.reconnectMs;
    if (this.tries >= waits.length + 4) { this.ticket = null; return this.set('out', `gave up reconnecting (${reason || code})`); }
    const ms = waits[Math.min(this.tries, waits.length - 1)]; this.tries++;
    this.stats.reconnects++;
    this.set('reconnecting', `try ${this.tries} in ${ms} ms`);
    this.later(ms, () => this.connectMatch());
  }

  /** Asks the game's server/bot.js what to do, and sends it as an input, exactly as a page's match.input() would. */
  async think() {
    if (this.thinking || !this.ws || this.phase !== 'playing' || this.view === undefined) return;
    this.thinking = true;
    const events = this.events; this.events = [];
    try {
      const t0 = this.io.now();
      const r = await this.io.think({ kind: 'match', bot: this.id, view: this.view, me: this.me, tick: this.tick, phase: this.phase, players: this.players, events,
        elapsed: t0 - this.joinedAt, memory: this.memory, skill: this.skill, name: this.name, seed: this.seed, calls: this.calls++ });
      this.brain.ms = r.ms ?? (this.io.now() - t0);
      if (r.memory) this.memory = r.memory;
      if (r.error) { this.brain.errors++; this.brain.last = r.error; this.stats.error(`bot.js: ${r.error}`); }
      else if (r.input !== null && r.input !== undefined && this.ws) {
        this.n++;
        this.out(this.ws, JSON.stringify({ t: 'i', n: this.n, v: this.tick, d: r.input }));
      }
    } catch (e) { this.brain.errors++; this.brain.last = String(e.message || e); }
    finally { this.thinking = false; }
  }

  // ----- a realtime room (GCP.room) -------------------------------------------------------------------------------------
  async joinRoom(target) {
    this.closeAll();
    this.welcomed = false;
    this.set('connecting', `room ${target.room}`);
    const url = `${this.platform.replace(/^http/, 'ws')}/api/rt/room?room=${encodeURIComponent(target.room)}&t=${encodeURIComponent(this.token)}${target.max ? `&max=${target.max}` : ''}`;
    let sock;
    try {
      sock = await this.io.open(url, {
        message: this.in((data) => { if (this.room === sock) this.onRoom(data); }),
        close: (code, reason) => {
          if (this.room !== sock) return;
          this.room = null; this.clear(this.pinger); this.clear(this.thinker); this.stats.closed(code, reason);
          if (this.dropping) return;
          if (code === 4000 || code === 4003 || code === 4001 || code === 4008 || this.stopped) return this.set('out', reason || `closed ${code}`);
          this.stats.reconnects++; this.set('reconnecting'); this.later(1500, () => this.joinRoom(target));
        },
      });
    } catch (e) { this.stats.error(`room: ${e.message || e}`); return this.set('idle', 'could not reach the room'); }
    if (this.stopped) { try { sock.close(1000, 'stopped'); } catch { /* closed */ } return; }
    this.room = sock; this.joinedAt = this.joinedAt || this.io.now();
    this.clear(this.pinger); this.pinger = this.every(BOT_LIMITS.pingMs, () => this.ping());
    this.clear(this.thinker); this.thinker = this.every(Math.max(50, Math.min(this.thinkMs, 10_000)), () => this.thinkRoom());
  }
  onRoom(data) {
    const now = this.io.now();
    if (typeof data !== 'string') { this.stats.inBytes(now, data.byteLength || 0); this.stats.snapshot(now); return; }
    this.stats.inBytes(now, data.length);
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.t === 'welcome') { this.welcomed = true; this.fresh = true; this.me = m.id; this.host = m.host; this.peers = m.peers || []; this.roomState = m.state; this.set('in room', `${this.target.room}: ${this.peers.length + 1} here`); }
    else if (m.t === 'join') { this.peers.push(m.peer); this.detail = `${this.target.room}: ${this.peers.length + 1} here`; this.io.changed(); }
    else if (m.t === 'leave') { this.peers = this.peers.filter((p) => p.id !== m.id); this.host = m.host; this.detail = `${this.target.room}: ${this.peers.length + 1} here`; this.io.changed(); }
    else if (m.t === 'msg') { this.stats.snapshot(now); this.inbox.push({ from: m.from, d: m.d }); if (this.inbox.length > BOT_LIMITS.maxEvents) this.inbox.shift(); }
    else if (m.t === 'state') this.roomState = m.d;
    else if (m.t === 'pong') this.pong(Number(m.n));
    else if (m.t === 'error') { this.stats.error(m.message || m.code); this.io.log(`${this.name}: room error ${m.code || ''} ${m.message || ''}`); }
  }
  async thinkRoom() {
    if (this.thinking || !this.room || !this.welcomed) return;
    this.thinking = true;
    const messages = this.inbox, joined = !!this.fresh; this.inbox = []; this.fresh = false;
    try {
      const r = await this.io.think({ kind: 'room', bot: this.id, me: this.me, room: this.target && this.target.room, joined, messages, state: this.roomState, peers: this.peers, host: this.host, elapsed: this.io.now() - this.joinedAt, memory: this.memory, skill: this.skill, name: this.name, seed: this.seed, calls: this.calls++ });
      if (r.memory) this.memory = r.memory;
      if (r.error) { this.brain.errors++; this.brain.last = r.error; this.stats.error(`bot.js: ${r.error}`); }
      for (const m of r.send || []) if (this.room) this.out(this.room, JSON.stringify({ t: 'msg', d: m.d, ...(m.to ? { to: m.to } : {}), at: this.io.now() }));
    } catch (e) { this.brain.errors++; this.brain.last = String(e.message || e); }
    finally { this.thinking = false; }
  }

  // ----- what the creator can do to a bot ----------------------------------------------------------------------------
  setNet(shape) { this.up.set(shape); this.down.set(shape); this.io.changed(); }
  spike(ms, extra) { const now = this.io.now(); this.up.spike(now, ms, extra); this.down.spike(now, ms, extra); this.io.log(`${this.name}: lag spike +${extra} ms for ${ms} ms`); }
  outage(ms) { const now = this.io.now(); this.up.outage(now, ms); this.down.outage(now, ms); this.io.log(`${this.name}: no connection for ${ms} ms`); }
  /**
   * The connection drops (Wi-Fi lost, the app sent to the background). reload false: the bot comes back with the
   * ticket it holds, like the SDK's own reconnect. reload true: it comes back like a reloaded page, through
   * GCP.match.rejoin's path (/api/rt/match-current, a fresh ticket for the match it was in).
   */
  drop(ms, reload = false) {
    const sock = this.ws || this.room; if (!sock) return false;
    this.dropping = true; this.stats.drops++;
    try { sock.close(4000, 'connection lost'); } catch { /* closed */ }
    if (this.ws === sock) this.onMatchClose(1006, 'dropped', true); else { this.room = null; this.clear(this.pinger); this.clear(this.thinker); }
    this.dropping = false;
    this.set('away', `${reload ? 'reloads' : 'back'} in ${Math.round(ms / 100) / 10} s`);
    this.io.log(`${this.name}: connection dropped${reload ? ' (page reload)' : ''}, back in ${ms} ms`);
    this.later(ms, async () => {
      this.stats.reconnects++;
      if (this.target && this.target.kind === 'room') return this.joinRoom(this.target);
      if (reload) {
        this.ticket = null; this.n = 0; this.view = undefined;
        try {
          const j = await this.io.api('match-current', { t: this.token });
          if (!j || !j.ticket) { this.set('out', 'nothing to go back to (match-current had no match)'); return; }
          this.ticket = j.ticket; this.match = j.match;
        } catch (e) { this.stats.error(`match-current: ${e.message || e}`); this.set('out', 'rejoin failed'); return; }
      }
      this.connectMatch();
    });
    return true;
  }
  /** Leaves on purpose, for good (the page's match.cancel()). */
  leave() {
    if (this.mm) { try { this.mm.send(JSON.stringify({ t: 'cancel' })); this.mm.close(1000, 'cancel'); } catch { /* closed */ } this.mm = null; }
    if (this.ws) { this.out(this.ws, JSON.stringify({ t: 'bye' })); }
    if (this.room) { try { this.room.close(1000, 'left'); } catch { /* closed */ } this.room = null; }
    this.set('left');
  }
  closeAll() {
    for (const k of ['mm', 'ws', 'room']) { const s = this[k]; this[k] = null; if (s) try { s.close(1000, 'bye'); } catch { /* closed */ } }
    this.clear(this.pinger); this.clear(this.thinker);
    this.view = undefined; this.tick = 0; this.events = []; this.joinedAt = 0; this.tries = 0; this.inbox = [];
  }
  stop() { this.closeAll(); this.stopped = true; for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers.clear(); this.phase = 'stopped'; }

  /** What the creator's panel shows for this bot. */
  status(now) {
    const s = this.up.shape;
    return { id: this.id, name: this.name, player_id: this.me || this.id, phase: this.phase, detail: this.detail, match: this.match, tick: this.tick, inputs_sent: this.n,
      net: { profile: s.profile, latency_ms: s.latency, jitter_ms: s.jitter, loss_percent: s.loss, spike: now < this.up.spikeUntil, down: now < this.up.downUntil },
      stats: this.stats.view(now), brain: { errors: this.brain.errors, last_error: this.brain.last, think_ms: Math.round(this.brain.ms) }, matches_finished: this.results };
  }
}

function rand(seed) { let a = (seed >>> 0) || 1; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

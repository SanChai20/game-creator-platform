// The authoritative match loop for server-run matches (GCP.match). It runs inside the game's own Worker, in the
// GameMatch Durable Object (game-worker.js), and drives the creator's server/match.js:
//
//   export default {
//     tickRate: 30,                       // simulation steps a second, 10 to 60
//     snapshotRate: 30,                   // snapshots a second (a divisor of tickRate is best), at most tickRate
//     maxRewindMs: 200,                   // how far back hit checks may look (lag compensation), at most 400
//     init(ctx) { return state },         // the match starts: ctx.players are the players present
//     rejoinMs: 0,                        // how long a player who went away may still come back (see below), default 0
//     join(state, player, ctx) {},        // optional: a player of the match arrives after the start, or comes back
//     leave(state, player, ctx) {},       // optional: a player left, or was away longer than the grace time
//     input(state, player, input, ctx) {},// one input of one player, in the order they were sent; validate everything
//     tick(state, ctx) {},                // one step of ctx.dt seconds; ctx.end(result) finishes the match
//     hitboxes(state) { return [] },      // optional: [{ id, x, y, z?, r }] or [{ id, min: [..], max: [..] }] for hit checks
//     view(state, player) { return state }// optional: what this player may see (hide what they must not know)
//   };
//
// Coming back. A player whose connection drops keeps their place for the grace time (LIMITS.graceMs). After it leave()
// runs. With rejoinMs 0 (the default) that is for good, as it always was. With rejoinMs above 0 the player may still
// come back for that long (a page reload, a closed browser opened again: GCP.match.rejoin), and the game decides what
// happens to their things meanwhile: leave() gets player.final false, join() runs with player.back true when they
// return, and leave() runs once more with player.final true when they cannot return any more (the time is up, they
// were removed). A player who leaves on purpose (match.cancel() in the page) is gone at once and for good, whatever
// rejoinMs says. While anyone may still come back the match is not ended for being empty, so the game should end it
// itself when it has no reason to go on.
//
// Pure: no platform imports, no I/O. The Durable Object hands in a clock and the means to send, close and report, so
// tests (tests/match-core.mjs) run the very same loop in Node with a fake clock.

export const LIMITS = Object.freeze({
  minTickRate: 10, maxTickRate: 60, defaultTickRate: 30,
  maxPlayers: 64,
  inputBytes: 2048,              // one input message
  queuedInputs: 8,               // a player's inputs waiting to be applied; older ones are dropped past this
  defaultRewindMs: 200, maxRewindMs: 400,
  snapshotBytes: 64 * 1024,      // one player's snapshot as JSON (full or delta)
  fullEveryMs: 5000,             // a full snapshot now and then, whatever the deltas did
  graceMs: 20_000,               // a disconnected player keeps their place this long
  maxRejoinMs: 60 * 60 * 1000,   // the longest a game may let a player who went away come back (rejoinMs)
  startWaitMs: 15_000,           // how long the match waits for everyone before it starts with who is there
  maxDurationMs: 60 * 60 * 1000, // a match ends by itself after an hour
  errorBudget: 10,               // creator code errors tolerated in any 100 ticks before the match is stopped
  messagesPerTick: 3,            // per player, averaged; bursts of twice that
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

/** Checks a server/match.js module and fills in defaults. Throws an Error that says what is wrong. */
export function normalizeDef(def) {
  if (!def || typeof def !== 'object') throw new Error('server/match.js must export default an object with init, input and tick.');
  for (const k of ['init', 'tick']) if (typeof def[k] !== 'function') throw new Error(`server/match.js: ${k}(…) is missing.`);
  for (const k of ['input', 'join', 'leave', 'hitboxes', 'view']) if (def[k] != null && typeof def[k] !== 'function') throw new Error(`server/match.js: ${k} must be a function.`);
  const tickRate = Math.round(clampN(def.tickRate, LIMITS.minTickRate, LIMITS.maxTickRate, LIMITS.defaultTickRate));
  const snapshotRate = clampN(def.snapshotRate, 1, tickRate, tickRate);
  return {
    tickRate, snapEvery: Math.max(1, Math.round(tickRate / snapshotRate)),
    maxRewindMs: Math.round(clampN(def.maxRewindMs, 0, LIMITS.maxRewindMs, LIMITS.defaultRewindMs)),
    rejoinMs: Math.round(clampN(def.rejoinMs, 0, LIMITS.maxRejoinMs, 0)),
    init: def.init, tick: def.tick, input: def.input || null, join: def.join || null, leave: def.leave || null,
    hitboxes: def.hitboxes || null, view: def.view || null,
  };
}

// ----- deltas: the part of a snapshot that changed since the previous one sent on the same connection ---------------
// A node is { v: value } (replace) or { o: { key: node }, x: [removed keys] } (an object changed in place). WebSockets are
// ordered and reliable, so the previous snapshot on a connection is always what the client holds.
export function diff(a, b) {
  if (a === b) return undefined;
  if (isObj(a) && isObj(b)) {
    let o = null, x = null;
    for (const k in b) { const d = diff(a[k], b[k]); if (d !== undefined) (o ||= {})[k] = d; }
    for (const k in a) if (!(k in b)) (x ||= []).push(k);
    if (!o && !x) return undefined;
    const n = {}; if (o) n.o = o; if (x) n.x = x; return n;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    let same = true;
    for (let i = 0; i < a.length && same; i++) same = diff(a[i], b[i]) === undefined;
    if (same) return undefined;
  } else if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return undefined;
  return { v: b };
}
/** Applies a diff node to a value and returns the new value (the SDK has the same function). */
export function patch(a, n) {
  if (n === undefined || n === null) return a;
  if ('v' in n) return n.v;
  const out = isObj(a) ? { ...a } : {};
  if (n.x) for (const k of n.x) delete out[k];
  if (n.o) for (const k in n.o) out[k] = patch(out[k], n.o[k]);
  return out;
}

// ----- seeded randomness, so a match can be replayed from its seed and inputs -----------------------------------------
export function rng(seed) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ----- hit checks against hitboxes rewound to what the shooter saw -----------------------------------------------------
const vec = (p) => Array.isArray(p) ? p.map(Number) : isObj(p) ? ('z' in p ? [+p.x, +p.y, +p.z] : [+p.x, +p.y]) : null;
function boxOf(h) {
  if (!isObj(h) || h.id == null) return null;
  if (Array.isArray(h.min) && Array.isArray(h.max)) return { id: String(h.id), min: h.min.map(Number), max: h.max.map(Number) };
  const r = Number(h.r);
  if (!(r > 0)) return null;
  return { id: String(h.id), c: 'z' in h ? [+h.x, +h.y, +h.z] : [+h.x, +h.y], r };
}
function lerpBox(a, b, k) {
  if (!b || k <= 0) return a; if (k >= 1) return b;
  const L = (p, q) => p.map((v, i) => v + ((q[i] ?? v) - v) * k);
  if (a.c && b.c) return { id: a.id, c: L(a.c, b.c), r: a.r + (b.r - a.r) * k };
  if (a.min && b.min) return { id: a.id, min: L(a.min, b.min), max: L(a.max, b.max) };
  return a;
}
/** Distance along a ray to a sphere/circle or an axis-aligned box, or null. dir must be unit length. */
export function rayHit(o, d, box) {
  if (box.c) {
    const n = Math.min(o.length, box.c.length), m = [];
    for (let i = 0; i < n; i++) m.push(o[i] - box.c[i]);
    let b = 0, c = -box.r * box.r;
    for (let i = 0; i < n; i++) { b += m[i] * d[i]; c += m[i] * m[i]; }
    if (c > 0 && b > 0) return null;
    const disc = b * b - c; if (disc < 0) return null;
    return Math.max(0, -b - Math.sqrt(disc));
  }
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < Math.min(o.length, box.min.length); i++) {
    if (Math.abs(d[i]) < 1e-12) { if (o[i] < box.min[i] || o[i] > box.max[i]) return null; continue; }
    let a = (box.min[i] - o[i]) / d[i], b = (box.max[i] - o[i]) / d[i];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0;
}

// ----- the match ----------------------------------------------------------------------------------------------------
/**
 * io: { now(): ms, send(playerId, text), close(playerId, code, reason), report(result) -> void, log(msg) }
 * setup: { id, roster: [{ id, name, team? }], seed, queue, options, minPlayers }
 */
export class MatchCore {
  constructor(def, setup, io) {
    this.def = normalizeDef(def);
    this.io = io;
    this.id = String(setup.id);
    this.seed = Number(setup.seed) >>> 0;
    this.queue = String(setup.queue || ''); this.options = isObj(setup.options) ? setup.options : {};
    this.random = rng(this.seed);
    this.tickMs = 1000 / this.def.tickRate;
    this.players = new Map();
    for (const r of (setup.roster || []).slice(0, LIMITS.maxPlayers)) {
      const id = String(r.id);
      this.players.set(id, { id, name: String(r.name || 'Player').slice(0, 40), team: r.team ?? null, connected: false, joined: false, left: false, leftAt: 0, final: false, goneAt: 0, queue: [], lastN: 0, ack: 0, view: null, prev: null, prevAt: 0, budget: LIMITS.messagesPerTick * this.def.tickRate * 2, budgetAt: 0, errors: [] });
    }
    this.minPlayers = Math.max(1, Math.min(this.players.size, Number(setup.minPlayers) || this.players.size));
    this.phase = 'waiting'; this.createdAt = io.now(); this.startedAt = 0; this.tick = 0; this.next = 0;
    this.state = null; this.history = []; this.errors = []; this.events = []; this.result = null;
    this.shared = null;   // the last shared view (no def.view): sent once as text to everyone on the same baseline
  }

  get ended() { return this.phase === 'ended'; }
  roster() { return [...this.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, connected: p.connected })); }
  info(p) { return { id: p.id, name: p.name, team: p.team, connected: p.connected }; }
  sendTo(p, m) { if (p.connected) this.io.send(p.id, typeof m === 'string' ? m : JSON.stringify(m)); }
  broadcast(m) { const s = JSON.stringify(m); for (const p of this.players.values()) this.sendTo(p, s); }

  /** A player of the roster opened a connection (first time or again). False for anyone else. */
  connect(id) {
    const p = this.players.get(String(id));
    if (!p || p.final || this.phase === 'ended') return false;
    const back = p.left && p.joined;   // away past the grace time, and back within the game's rejoinMs
    p.connected = true; p.goneAt = 0; p.left = false; p.leftAt = 0; p.prev = null; p.queue = [];   // a fresh connection gets a full snapshot
    this.sendTo(p, { t: 'hello', you: p.id, match: this.id, tickRate: this.def.tickRate, snapshotRate: this.def.tickRate / this.def.snapEvery, maxRewindMs: this.def.maxRewindMs, phase: this.phase, k: this.tick, players: this.roster(), ack: p.ack, n: p.lastN });   // n: the page numbers its inputs on from here (a reloaded page would start at zero and be ignored)
    if (this.phase === 'waiting') { this.broadcast({ t: 'wait', players: this.roster() }); this.maybeStart(); }
    else if (this.phase === 'running') {
      this.broadcast({ t: 'players', players: this.roster() });
      if (!p.joined || back) { p.joined = true; this.call('join', (c) => this.def.join && this.def.join(this.state, { ...this.info(p), back }, c)); }
    }
    return true;
  }

  /**
   * A player is away past the grace time, or gone for good (final). leave() runs when they go away, and once more when
   * a player who could still come back (def.rejoinMs) no longer can; player.final tells the two apart.
   */
  drop(p, final) {
    if (p.final || (p.left && !final)) return;
    if (!p.left) { p.left = true; p.leftAt = this.io.now(); }
    p.final = !!final; p.queue = [];
    if (p.joined && this.phase === 'running') this.call('leave', (c) => this.def.leave && this.def.leave(this.state, { ...this.info(p), final: p.final }, c));
  }

  /** The player chose to leave (match.cancel() in the page): no grace time, and no way back. */
  quit(p) {
    if (p.final) return;
    if (p.connected) this.io.close(p.id, 1000, 'Left the match');
    p.connected = false; p.goneAt = this.io.now();
    this.drop(p, true);
    if (this.phase !== 'ended') this.broadcast({ t: 'players', players: this.roster() });
  }

  /** Removes a player for good (their inputs kept failing). */
  kick(p, why) {
    if (p.final) return;
    this.sendTo(p, { t: 'error', code: 'kicked', message: why });
    if (p.connected) this.io.close(p.id, 4009, 'Removed from the match');
    p.connected = false;
    this.drop(p, true);
    this.broadcast({ t: 'players', players: this.roster() });
  }

  disconnect(id) {
    const p = this.players.get(String(id));
    if (!p || !p.connected) return;
    p.connected = false; p.goneAt = this.io.now(); p.queue = [];
    if (this.phase !== 'ended') this.broadcast({ t: 'players', players: this.roster() });
  }

  /** One text message from a player. */
  message(id, raw) {
    const p = this.players.get(String(id));
    if (!p || !p.connected || this.phase === 'ended') return;
    // flood budget: a few messages per tick on average
    const now = this.io.now(), rate = LIMITS.messagesPerTick * this.def.tickRate;
    if (p.budgetAt) p.budget = Math.min(rate * 2, p.budget + (now - p.budgetAt) / 1000 * rate);
    p.budgetAt = now;
    if (p.budget < 1) return; p.budget -= 1;
    if (typeof raw !== 'string' || raw.length > LIMITS.inputBytes + 64) return this.sendTo(p, { t: 'error', code: 'too_large', message: `Inputs are limited to ${LIMITS.inputBytes} bytes.` });
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!isObj(m)) return;
    if (m.t === 'i') {
      const n = Number(m.n);
      if (!Number.isSafeInteger(n) || n <= p.lastN) return;   // numbers only go up: a replay or a stale input is ignored
      p.lastN = n;
      const v = m.v == null ? NaN : Number(m.v);
      p.queue.push({ n, v: Number.isFinite(v) ? v : null, d: m.d === undefined ? null : m.d });
      if (p.queue.length > LIMITS.queuedInputs) p.queue.splice(0, p.queue.length - LIMITS.queuedInputs);
    } else if (m.t === 'p') this.sendTo(p, { t: 'po', n: Number(m.n) || 0, k: this.tick });
    else if (m.t === 'bye') this.quit(p);
  }

  maybeStart() {
    const here = [...this.players.values()].filter((p) => p.connected).length;
    const waited = this.io.now() - this.createdAt;
    if (here >= this.players.size || (here >= this.minPlayers && waited >= LIMITS.startWaitMs)) this.start();
  }

  start() {
    this.phase = 'running'; this.startedAt = this.io.now(); this.next = this.startedAt;
    const present = [...this.players.values()].filter((p) => p.connected);
    for (const p of present) p.joined = true;
    const ok = this.call('init', (c) => { this.state = this.def.init({ ...c, players: present.map((p) => this.info(p)) }); });
    if (!ok || this.state === undefined) return this.finish({ aborted: true, reason: 'server_error', message: ok ? 'init() returned nothing: it must return the match state.' : 'init() failed' });
    this.broadcast({ t: 'start', k: 0, players: this.roster() });
  }

  /** Runs every tick that is due. Returns the ms until the next one is due (Infinity once ended). */
  step() {
    const now = this.io.now();
    if (this.phase === 'ended') return Infinity;
    // players gone longer than the grace time leave: for good, or for as long as the game lets them come back (rejoinMs).
    // A match nobody is connected to and nobody can come back to ends.
    for (const p of this.players.values()) {
      if (p.connected || p.final) continue;
      if (!p.left && p.goneAt && now - p.goneAt > LIMITS.graceMs) this.drop(p, !this.def.rejoinMs);
      if (p.left && !p.final && now - p.leftAt > this.def.rejoinMs) this.drop(p, true);
    }
    if (![...this.players.values()].some((p) => p.connected)) {
      if (this.phase === 'running' && [...this.players.values()].every((p) => p.final)) return this.finish({ aborted: true, reason: 'everyone_left' }), Infinity;
      if (this.phase === 'waiting' && now - this.createdAt > LIMITS.startWaitMs * 2) return this.finish({ aborted: true, reason: 'nobody_came' }), Infinity;
    }
    if (this.phase === 'waiting') {
      this.maybeStart();
      if (this.phase === 'waiting') {
        if (now - this.createdAt > LIMITS.startWaitMs * 2) this.finish({ aborted: true, reason: 'not_enough_players' });
        return this.phase === 'ended' ? Infinity : 250;
      }
    }
    if (now - this.startedAt > LIMITS.maxDurationMs) { this.finish({ reason: 'time_limit' }); return Infinity; }
    // Fixed steps on a fixed timeline. A Worker that fell far behind (a long pause) skips ahead instead of spiralling.
    if (now - this.next > this.tickMs * 8) this.next = now - this.tickMs;
    let ran = 0;
    while (this.next <= now && this.phase === 'running' && ran < 8) { this.runTick(); this.next += this.tickMs; ran++; }
    return this.phase === 'ended' ? Infinity : Math.max(0, this.next - this.io.now());
  }

  ctx() {
    const self = this;
    return {
      tick: this.tick, dt: 1 / this.def.tickRate, time: this.tick * this.tickMs, seed: this.seed, queue: this.queue, options: this.options,
      players: this.roster(), random: this.random,
      emit(data, to) { self.events.push({ d: data, to: to == null ? null : String(to) }); },
      end(result) { self.result = isObj(result) ? result : {}; },
      hitscan(shooter, ray) { return self.hitscan(shooter, ray); },
      rewind(playerId) { return self.rewound(playerId); },
      log(...a) { self.io.log(a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ').slice(0, 500)); },
    };
  }
  /**
   * Calls the creator's code, counts its errors, and stops a match whose code keeps failing. Errors while applying one
   * player's input count against that player instead: a player whose inputs keep breaking the code (a cheat, or a bad
   * client) is removed from the match, so they cannot stop it for everyone.
   */
  call(what, fn, from = null) {
    try { fn(this.ctx()); return true; } catch (e) {
      const msg = `${what}: ${String(e && e.message || e)}`.slice(0, 300);
      this.io.log(msg);
      if (from) {
        from.errors.push(this.tick);
        while (from.errors.length && from.errors[0] < this.tick - 100) from.errors.shift();
        if (from.errors.length > LIMITS.errorBudget) this.kick(from, 'Your inputs were rejected by the game server.');
        return false;
      }
      this.errors.push(this.tick);
      while (this.errors.length && this.errors[0] < this.tick - 100) this.errors.shift();
      if (this.errors.length > LIMITS.errorBudget && this.phase !== 'ended') this.finish({ aborted: true, reason: 'server_error', message: msg });
      return false;
    }
  }

  runTick() {
    this.tick++;
    // inputs: one per player per tick, two when more are waiting (a burst after a hiccup, or a client clock a little
    // fast), in the order sent. The queue stays short, so an input waits at most about a tick before it is applied.
    for (const p of this.players.values()) {
      if (!p.joined || p.left) continue;   // (a player who is away has no connection, so no inputs either)
      const take = p.queue.length >= 2 ? 2 : p.queue.length ? 1 : 0;
      for (let i = 0; i < take; i++) {
        const inp = p.queue.shift();
        p.ack = inp.n; p.view = inp.v;
        if (this.def.input && !this.call('input', (c) => this.def.input(this.state, this.info(p), inp.d, c), p)) {
          if (p.final) break;
        }
        if (this.phase === 'ended') return;
      }
    }
    this.call('tick', (c) => this.def.tick(this.state, c));
    if (this.phase === 'ended') return;
    this.record();
    if (this.tick % this.def.snapEvery === 0 || this.result) this.snapshot();
    if (this.events.length) {
      const ev = this.events; this.events = [];
      for (const e of ev) {
        const s = JSON.stringify({ t: 'e', k: this.tick, d: e.d });
        if (s.length > LIMITS.snapshotBytes) { this.io.log('emit: event too large'); continue; }
        for (const p of this.players.values()) if (!e.to || e.to === p.id) this.sendTo(p, s);
      }
    }
    if (this.result) this.finish(this.result);
  }

  record() {
    if (!this.def.hitboxes) return;
    let list = null;
    this.call('hitboxes', () => { list = this.def.hitboxes(this.state); });
    const boxes = new Map();
    if (Array.isArray(list)) for (const h of list.slice(0, 512)) { const b = boxOf(h); if (b) boxes.set(b.id, b); }
    this.history.push({ k: this.tick, boxes });
    const keep = Math.ceil(this.def.maxRewindMs / this.tickMs) + 2;
    while (this.history.length > keep) this.history.shift();
  }

  /** The hitboxes as the given player saw them when they sent the input being applied (now, if unknown). */
  rewound(playerId) {
    if (!this.history.length) return [];
    const p = this.players.get(String(playerId));
    const last = this.history[this.history.length - 1];
    const oldest = last.k - this.def.maxRewindMs / this.tickMs;
    let at = p && p.view != null ? p.view : last.k;
    at = Math.max(oldest, Math.min(last.k, at), this.history[0].k);
    let i = this.history.length - 1;
    while (i > 0 && this.history[i].k > at) i--;
    const A = this.history[i], B = this.history[Math.min(i + 1, this.history.length - 1)];
    const k = B.k > A.k ? (at - A.k) / (B.k - A.k) : 0;
    const out = [];
    for (const [id, a] of A.boxes) out.push(lerpBox(a, B.boxes.get(id), k));
    return out;
  }

  /** The nearest hitbox along a ray, as the shooter saw the world. ray: { origin, dir, range?, ignore? }. */
  hitscan(shooter, ray) {
    const o = vec(ray && ray.origin), d0 = vec(ray && ray.dir);
    if (!o || !d0 || o.some((v) => !Number.isFinite(v)) || d0.some((v) => !Number.isFinite(v))) return null;
    const len = Math.hypot(...d0); if (!(len > 0)) return null;
    const d = d0.map((v) => v / len), range = Number(ray.range) > 0 ? Number(ray.range) : Infinity;
    const skip = new Set([String(shooter), ...(Array.isArray(ray.ignore) ? ray.ignore.map(String) : [])]);
    let best = null;
    for (const b of this.rewound(shooter)) {
      if (skip.has(b.id)) continue;
      const t = rayHit(o, d, b);
      if (t != null && t <= range && (!best || t < best.distance)) best = { id: b.id, distance: t, point: o.map((v, i) => v + d[i] * t) };
    }
    return best;
  }

  snapshot() {
    const now = this.io.now();
    let sharedText = null, sharedFull = null;
    if (!this.def.view) {
      // one view for everyone: serialise once, and diff once against the view everyone on the same baseline holds
      const text = JSON.stringify(this.state ?? null);
      if (text.length > LIMITS.snapshotBytes * 4) { this.io.log('snapshot too large'); return; }
      const cur = JSON.parse(text);
      const d = this.shared ? diff(this.shared.v, cur) : null;
      sharedFull = text; sharedText = this.shared ? JSON.stringify(d === undefined ? null : d) : null;
      const base = this.shared; this.shared = { v: cur, k: this.tick };
      for (const p of this.players.values()) {
        if (!p.connected || !p.joined) continue;
        const full = !base || p.prev !== base || now - p.prevAt > LIMITS.fullEveryMs;
        const body = full ? sharedFull : sharedText;
        const big = !full && body.length > LIMITS.snapshotBytes;   // a delta bigger than the limit: try the whole view
        if (this.sendSnap(p, big ? sharedFull : body, full || big)) { p.prev = this.shared; if (full || big) p.prevAt = now; }
      }
      return;
    }
    for (const p of this.players.values()) {
      if (!p.connected || !p.joined) continue;
      let v;
      if (!this.call('view', () => { v = this.def.view(this.state, this.info(p)); })) continue;
      const text = JSON.stringify(v ?? null);
      const cur = JSON.parse(text);
      const full = !p.prev || now - p.prevAt > LIMITS.fullEveryMs;
      const d = full ? null : diff(p.prev.v, cur);
      const body = full ? text : JSON.stringify(d === undefined ? null : d);
      const big = !full && body.length > LIMITS.snapshotBytes;
      if (this.sendSnap(p, big ? text : body, full || big)) { p.prev = { v: cur }; if (full || big) p.prevAt = now; }
    }
  }
  sendSnap(p, body, full) {
    if (body.length > LIMITS.snapshotBytes) {
      this.io.log(`snapshot for ${p.id} is ${body.length} bytes, over ${LIMITS.snapshotBytes}: not sent (keep views small, or use view() to send each player only what is near them)`);
      p.prev = null; return false;
    }
    this.io.send(p.id, `{"t":"s","k":${this.tick},"a":${p.ack},"f":${full ? 1 : 0},"d":${body}}`);
    return true;
  }

  /** Ends the match: tells everyone, reports the result once, and closes the connections a moment later. */
  finish(result) {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    const r = sanitizeResult(result, this.players);
    this.broadcast({ t: 'end', k: this.tick, result: r });
    try { this.io.report(r); } catch (e) { this.io.log('report failed: ' + (e && e.message)); }
    for (const p of this.players.values()) if (p.connected) this.io.close(p.id, 1000, 'Match over');
  }
}

/** Keeps what the platform understands from a result: a ranking of players (best first; ties share a place). */
export function sanitizeResult(result, players) {
  const r = isObj(result) ? result : {};
  const out = {};
  if (r.aborted) out.aborted = true;
  if (typeof r.reason === 'string') out.reason = r.reason.slice(0, 60);
  if (typeof r.message === 'string') out.message = r.message.slice(0, 300);
  if (Array.isArray(r.ranking)) {
    const seen = new Set(), ranking = [];
    for (const place of r.ranking.slice(0, LIMITS.maxPlayers)) {
      const ids = (Array.isArray(place) ? place : [place]).map(String).filter((id) => players.has(id) && !seen.has(id));
      ids.forEach((id) => seen.add(id));
      if (ids.length) ranking.push(ids);
    }
    if (ranking.length) out.ranking = ranking;
  }
  if (isObj(r.scores)) {
    const scores = {};
    for (const [id, v] of Object.entries(r.scores)) if (players.has(id) && Number.isFinite(Number(v))) scores[id] = Number(v);
    out.scores = scores;
  }
  if (r.data !== undefined) { const s = JSON.stringify(r.data); if (s && s.length <= 4096) out.data = JSON.parse(s); }
  return out;
}

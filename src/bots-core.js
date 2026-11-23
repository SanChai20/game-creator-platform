// Preview test bots: the parts with no bindings, so tests/bots.mjs runs them in Node. The Durable Object around them is
// src/bots.ts (BotFleet).
//
// A bot is a remote client of the game like any player's page: it signs in with a play token of its own (kind "bot",
// preview only), waits in the platform's matchmaker over a WebSocket (/api/rt/match), and plays the match over a second
// WebSocket to the game's own Worker (/__gcp/match), speaking the same protocol as the SDK (web/public/sdk/gcp.js). Or it
// joins a realtime room (/api/rt/room). Its connections leave the fleet's Durable Object through the public front door of
// the platform, so they cross the same edge, routing and Durable Objects a player's do, from the region the creator
// picked for the fleet.
//
// On top of that real path each bot can put a last mile of its own between itself and the game (NetLink): added
// latency, jitter, packet loss (a lost packet on a WebSocket is a TCP retransmission: it arrives late and holds up
// everything behind it), lag spikes and outages. Every message in and out goes through it, so what the game sees from
// a bot on "3G" is what it would see from a player on a poor phone network.

export const NET_PROFILES = Object.freeze({
  // one-way added delay (ms), its jitter (ms, about one standard deviation) and packet loss (percent)
  none: { label: 'No added delay', latency: 0, jitter: 0, loss: 0 },
  fiber: { label: 'Fibre', latency: 5, jitter: 2, loss: 0 },
  wifi: { label: 'Home Wi-Fi', latency: 15, jitter: 6, loss: 0.2 },
  '4g': { label: '4G phone', latency: 35, jitter: 15, loss: 0.5 },
  '3g': { label: '3G / weak signal', latency: 90, jitter: 40, loss: 1.5 },
  poor: { label: 'Poor connection', latency: 160, jitter: 80, loss: 4 },
  far: { label: 'Other continent', latency: 110, jitter: 10, loss: 0.3 },
});

// Durable Object location hints: where the fleet runs, so its bots really connect from there
export const BOT_REGIONS = Object.freeze({ auto: 'Near you', wnam: 'Western North America', enam: 'Eastern North America', sam: 'South America', weur: 'Western Europe', eeur: 'Eastern Europe', apac: 'Asia-Pacific', oc: 'Oceania', afr: 'Africa', me: 'Middle East' });

export const BOT_LIMITS = Object.freeze({
  maxNet: { latency: 2000, jitter: 1000, loss: 30 },
  pingMs: 2000,            // how often each bot measures its round trip
  statsWindowMs: 10_000,   // rates and percentiles are over this window
  reconnectMs: [500, 1500, 4000, 8000],   // the SDK's own backoff for a dropped match connection
  maxEvents: 40,           // match events handed to think() at a time
  maxLog: 60,              // lines kept in the fleet's log
});

const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

/** A network shape from a profile name and/or numbers. Returns { latency, jitter, loss, profile }. */
export function netShape(o) {
  const base = NET_PROFILES[o && o.profile] || NET_PROFILES.none;
  const L = BOT_LIMITS.maxNet;
  return {
    profile: NET_PROFILES[o && o.profile] ? o.profile : (o && (o.latency != null || o.jitter != null || o.loss != null)) ? 'custom' : 'none',
    latency: Math.round(clampN(o && o.latency, 0, L.latency, base.latency)),
    jitter: Math.round(clampN(o && o.jitter, 0, L.jitter, base.jitter)),
    loss: clampN(o && o.loss, 0, L.loss, base.loss),
  };
}

/**
 * One direction of a bot's last mile. schedule(now) says when a message handed over now arrives at the other end.
 * Messages stay in order (a WebSocket is a TCP stream): one that is late holds up the ones behind it.
 */
export class NetLink {
  constructor(shape, random = Math.random) { this.set(shape); this.random = random; this.last = 0; this.spikeUntil = 0; this.spikeMs = 0; this.downUntil = 0; }
  set(shape) { this.shape = netShape(shape); }
  /** For `ms` from now every message takes `extra` ms longer (a lag spike: a congested cell, a microwave oven). */
  spike(now, ms, extra) { this.spikeUntil = now + Math.max(0, ms); this.spikeMs = Math.max(0, extra); }
  /** For `ms` from now nothing gets through; everything sent meanwhile arrives together afterwards (a tunnel). */
  outage(now, ms) { this.downUntil = Math.max(this.downUntil, now + Math.max(0, ms)); }
  gauss() { let u = 0, v = 0; while (!u) u = this.random(); while (!v) v = this.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  schedule(now) {
    const s = this.shape;
    let at = now + s.latency + Math.max(-s.latency, s.jitter * this.gauss());
    if (s.loss > 0 && this.random() * 100 < s.loss) at += Math.max(200, s.latency * 3);   // retransmitted after a timeout
    if (now < this.spikeUntil) at += this.spikeMs;
    if (now < this.downUntil) at = Math.max(at, this.downUntil + s.latency);
    at = Math.max(at, this.last, now);   // in order
    this.last = at;
    return at;
  }
  /** True when this link adds nothing: messages can go straight through. */
  get clear() { const s = this.shape; return !s.latency && !s.jitter && !s.loss && !this.spikeUntil && !this.downUntil; }
}

/** Round trips, snapshot spacing and traffic of one bot, over a sliding window. */
export class NetStats {
  constructor() { this.reset(); this.reconnects = 0; this.drops = 0; this.errors = 0; this.lastError = null; this.closes = []; }
  reset() { this.rtts = []; this.snaps = []; this.bytesIn = []; this.bytesOut = []; this.lastSnap = 0; this.gapMax = []; this.acks = []; }
  trim(now) {
    const from = now - BOT_LIMITS.statsWindowMs;
    for (const k of ['rtts', 'snaps', 'bytesIn', 'bytesOut', 'gapMax', 'acks']) { const a = this[k]; let i = 0; while (i < a.length && a[i][0] < from) i++; if (i) a.splice(0, i); }
  }
  rtt(now, ms) { this.rtts.push([now, ms]); this.trim(now); }
  snapshot(now) { if (this.lastSnap) this.gapMax.push([now, now - this.lastSnap]); this.lastSnap = now; this.snaps.push([now, 1]); this.trim(now); }
  ackLag(now, n) { this.acks.push([now, n]); }
  inBytes(now, n) { this.bytesIn.push([now, n]); }
  outBytes(now, n) { this.bytesOut.push([now, n]); }
  error(msg) { this.errors++; this.lastError = String(msg).slice(0, 300); }
  closed(code, reason) { this.closes.push({ code, reason: String(reason || '').slice(0, 120) }); if (this.closes.length > 5) this.closes.shift(); }
  view(now) {
    this.trim(now);
    const secs = BOT_LIMITS.statsWindowMs / 1000, r = this.rtts.map((x) => x[1]).sort((a, b) => a - b);
    const gaps = this.gapMax.map((x) => x[1]), mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    const sd = gaps.length > 1 ? Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length) : 0;
    const sum = (a) => a.reduce((t, x) => t + x[1], 0), pct = (p) => r.length ? r[Math.min(r.length - 1, Math.floor(p * r.length))] : null;
    return {
      rtt_ms: r.length ? Math.round(this.rtts[this.rtts.length - 1][1]) : null, rtt_p50_ms: pct(0.5) == null ? null : Math.round(pct(0.5)), rtt_p95_ms: pct(0.95) == null ? null : Math.round(pct(0.95)),
      snapshots_per_s: Math.round((this.snaps.length / secs) * 10) / 10,
      snapshot_gap_ms: gaps.length ? Math.round(mean) : null, snapshot_jitter_ms: gaps.length ? Math.round(sd) : null, snapshot_gap_max_ms: gaps.length ? Math.round(Math.max(...gaps)) : null,
      since_snapshot_ms: this.lastSnap ? Math.round(now - this.lastSnap) : null,
      inputs_unacked: this.acks.length ? this.acks[this.acks.length - 1][1] : 0,
      kb_in_per_s: Math.round((sum(this.bytesIn) / 1024 / secs) * 10) / 10, kb_out_per_s: Math.round((sum(this.bytesOut) / 1024 / secs) * 10) / 10,
      reconnects: this.reconnects, drops: this.drops, errors: this.errors, last_error: this.lastError, closes: this.closes.slice(),
    };
  }
}

// ----- the diff format of match snapshots (the same as match-core.js and the SDK) -----------------------------------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export function patch(a, n) {
  if (n === undefined || n === null) return a;
  if ('v' in n) return n.v;
  const out = isObj(a) ? { ...a } : {};
  if (n.x) for (const k of n.x) delete out[k];
  if (n.o) for (const k in n.o) out[k] = patch(out[k], n.o[k]);
  return out;
}

// ----- what a creator asks for -------------------------------------------------------------------------------------
/**
 * Checks a fleet request against the platform's limits. Returns { ok: true, cfg } or { ok: false, error }.
 *   bots: how many (1 to max), target: 'follow' (go where the creator searches or opens a room in the preview, the
 *   default; a private lobby only by invite), 'invite' (go nowhere until the creator invites them as friends from the
 *   game), 'queue' (a public queue: queue, players, min, teams, mode), 'code' (a private lobby code), 'room' (a room
 *   code), region, net (a profile name or { latency, jitter, loss }; per bot in nets[]), names, skill (0 to 1).
 */
export function fleetRequest(b, limits) {
  const max = Math.max(1, Math.min(63, Math.round(Number(limits.maxBots) || 15)));
  const bots = Math.round(Number(b.bots ?? 3));
  if (!(bots >= 1 && bots <= max)) return { ok: false, error: `bots must be between 1 and ${max}.` };
  const target = String(b.target || 'follow');
  if (!['follow', 'invite', 'queue', 'code', 'room'].includes(target)) return { ok: false, error: 'target must be follow, invite, queue, code or room.' };
  const region = String(b.region || 'auto');
  if (!(region in BOT_REGIONS)) return { ok: false, error: `region must be one of ${Object.keys(BOT_REGIONS).join(', ')}.` };
  const cfg = { bots, target, region, skill: clampN(b.skill, 0, 1, 1), minutes: Math.round(clampN(b.minutes, 1, limits.maxMinutes || 30, Math.min(15, limits.maxMinutes || 30))) };
  if (target === 'queue') {
    if (b.players == null || b.players === '') return { ok: false, error: 'target "queue" needs players: the match size the game passes to GCP.match.find({ players }), 2 to 64. It has no default, because the bots must ask for the same match size as the game or they wait in a different queue.' };
    const players = Math.round(Number(b.players));
    if (!(players >= 2 && players <= 64)) return { ok: false, error: `players (the match size the game asks the matchmaker for) must be between 2 and 64, not ${String(b.players).slice(0, 20)}.` };
    cfg.queue = { queue: String(b.queue || 'default'), players, min: b.min == null ? null : Math.round(Number(b.min)), teams: b.teams == null ? null : Math.round(Number(b.teams)), mode: b.mode == null ? '' : String(b.mode) };
    if (!/^[a-z0-9_-]{1,32}$/.test(cfg.queue.queue)) return { ok: false, error: 'queue must be 1 to 32 characters: a-z, 0-9, _ or -.' };
    if (!/^[a-z0-9_-]{0,32}$/.test(cfg.queue.mode)) return { ok: false, error: 'mode must be up to 32 characters: a-z, 0-9, _ or -.' };
  }
  if (target === 'code') { cfg.code = String(b.code || '').toUpperCase(); if (!/^[A-Z0-9]{3,12}$/.test(cfg.code)) return { ok: false, error: 'code must be 3 to 12 letters or digits (the private lobby code the game passes to GCP.match.find).' }; }
  if (target === 'room') { cfg.room = String(b.room || 'lobby').slice(0, 40); }
  const one = (n) => typeof n === 'string' ? netShape({ profile: n }) : netShape(n || {});
  cfg.net = one(b.net);
  cfg.nets = Array.from({ length: bots }, (_, i) => (Array.isArray(b.nets) && b.nets[i] != null ? one(b.nets[i]) : cfg.net));
  cfg.names = Array.from({ length: bots }, (_, i) => (Array.isArray(b.names) && typeof b.names[i] === 'string' && b.names[i].trim() ? b.names[i].trim().slice(0, 40) : `Test Bot ${i + 1}`));
  return { ok: true, cfg };
}

/** The bot-minutes a fleet of `bots` running `ms` uses (what the daily allowance counts). */
export const botMinutes = (bots, ms) => Math.ceil((Math.max(0, ms) / 60_000) * bots);

/** A short, readable id for a bot. */
export const botId = (fleet, i) => `bot_${fleet.slice(0, 8)}_${i + 1}`;

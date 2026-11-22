// Runs a game's own bot logic (server/bot.js) for the preview test bots (src/bots.ts). The platform loads this module
// with the game's server/ and shared/ modules into a Dynamic Worker of its own, with no network at all (globalOutbound
// null) and none of the platform's bindings, so the creator's code decides what a bot does and nothing more. The bots'
// connections, the network conditions and the stats stay in the platform's BotFleet Durable Object: this module only
// answers "here is what each bot sees, what does it do?".
//
// server/bot.js (all optional; without the file, bots join and stay connected but send nothing):
//
//   export default {
//     thinkMs: 500,                          // how often think() runs for each bot, 50 to 10000 ms (default 250)
//     think(view, me, ctx) { return input }, // a match: view is what match.state is in the page (the bot's own view
//                                            // from server/match.js), me the bot's player id. Return one input (what
//                                            // the page would pass to match.input), or null/undefined to send nothing.
//     actions(view, me, ctx) { return [] },  // instead of think: the inputs that are valid now; the bot sends one of
//                                            // them, picked at random (the generic bot)
//     room(ctx) { return [{ d, to }] },      // a room (GCP.room): messages to send now; ctx.messages are the ones
//                                            // received since the last call, ctx.state the room's snapshot
//   };
//
// ctx: { tick, phase, players, events (match events since the last call), elapsed (ms since the bot joined), random()
// (seeded per bot), memory (an object kept for this bot between calls, at most 8 KB as JSON), skill (0 to 1, set by the
// creator for each bot), name }.
import bot from './server/bot.js';

const MEM_MAX = 8 * 1024;
const rngOf = (seed) => { let a = (Number(seed) >>> 0) || 0x9e3779b9; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

/** What the module offers, so the fleet can show it ("game bot", "generic bot", "connected only"). */
export function describe(def) {
  const d = def && typeof def === 'object' ? def : null;
  return {
    think: !!d && typeof d.think === 'function', actions: !!d && typeof d.actions === 'function', room: !!d && typeof d.room === 'function',
    thinkMs: d && Number.isFinite(Number(d.thinkMs)) ? Math.max(50, Math.min(10_000, Math.round(Number(d.thinkMs)))) : 250,
  };
}

/** Runs one call for one bot. Never throws: an error comes back as { error }. */
export function runOne(def, c) {
  const d = describe(def);
  const mem = c.memory && typeof c.memory === 'object' ? c.memory : {};
  const random = rngOf((Number(c.seed) >>> 0) + (Number(c.calls) || 0) * 7919);
  const ctx = { tick: c.tick ?? null, phase: c.phase || null, players: Array.isArray(c.players) ? c.players : [], events: Array.isArray(c.events) ? c.events : [],
    elapsed: Number(c.elapsed) || 0, random, memory: mem, skill: Number.isFinite(Number(c.skill)) ? Number(c.skill) : 1, name: String(c.name || ''),
    messages: Array.isArray(c.messages) ? c.messages : [], state: c.state === undefined ? null : c.state, peers: Array.isArray(c.peers) ? c.peers : [], host: c.host ?? null };
  const keep = () => { try { const s = JSON.stringify(ctx.memory ?? {}); return s.length <= MEM_MAX ? JSON.parse(s) : { _dropped: 'memory over 8 KB' }; } catch { return {}; } };
  try {
    if (c.kind === 'room') {
      if (!d.room) return { send: [] };
      const out = def.room(ctx);
      const list = Array.isArray(out) ? out : out == null ? [] : [out];
      return { send: list.slice(0, 20).map((m) => (m && typeof m === 'object' && 'd' in m ? { d: m.d, to: m.to == null ? null : String(m.to) } : { d: m, to: null })), memory: keep() };
    }
    if (d.think) { const input = def.think(c.view, c.me, ctx); return { input: input === undefined ? null : input, memory: keep() }; }
    if (d.actions) {
      const list = def.actions(c.view, c.me, ctx);
      if (!Array.isArray(list) || !list.length) return { input: null, memory: keep() };
      return { input: list[Math.floor(random() * list.length)], memory: keep() };
    }
    return { input: null };
  } catch (e) {
    return { error: String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ').slice(0, 400), memory: keep() };
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/describe') return Response.json(describe(bot));
    let body;
    try { body = await request.json(); } catch { return Response.json({ error: 'bad body' }, { status: 400 }); }
    const calls = Array.isArray(body && body.calls) ? body.calls.slice(0, 64) : [];
    const results = calls.map((c) => {
      const t0 = Date.now(), r = runOne(bot, c);
      // the input must survive the trip as JSON, as a page's would
      if (r.input !== undefined && r.input !== null) { try { r.input = JSON.parse(JSON.stringify(r.input)); } catch { return { error: 'think() returned something that is not JSON', ms: Date.now() - t0 }; } }
      r.ms = Date.now() - t0;
      return r;
    });
    return Response.json({ results });
  },
};

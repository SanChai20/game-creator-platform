// A room game's server/bot.js for tests/bots-live.mjs, in the shape of a co-op lobby (a host page keeps the roster in
// the room state, guests say hello, then ready; during a run guests stream their position):
//   - on entering the room: a hello; in the lobby: ready whenever the roster shows the bot not ready
//   - during a run: walk around the start area ({ t: 'in' } about 10 times a second)
//   - an accepted invite: the room code is the game's prefix + data.room
const PREFIX = 'mygame-';
const LOOK = { hero: 'pip', hat: 'none', skin: 'classic', acc: 'none' };
const hello = (name) => ({ d: { t: 'hello', name: String(name || 'Test Bot').slice(0, 24), ...LOOK, gh: {}, renew: 0 } });

export default {
  thinkMs: 100,

  invite(join) {
    const r = join && join.data && join.data.room;
    return typeof r === 'string' && /^f[a-z0-9]{8,24}$/.test(r) ? { room: PREFIX + r } : null;
  },

  room(ctx) {
    const out = [], m = ctx.memory, st = ctx.state, me = ctx.me;
    if (ctx.joined) { m.readyAt = -1e9; m.runId = null; out.push(hello(ctx.name)); }
    // a bot never hosts a night (the host's page runs the simulation): with no state yet, or as host, it waits
    if (!st || !me || ctx.isHost) return out;
    if (st.phase === 'lobby') {
      const mine = st.players && st.players[me];
      if ((!mine || !mine.ready) && ctx.elapsed - m.readyAt > 1500) { m.readyAt = ctx.elapsed; out.push({ d: { t: 'me', ready: true, ...LOOK } }); }
    } else if (st.phase === 'run') {
      if (m.runId !== st.runId) { m.runId = st.runId; m.t0 = ctx.elapsed; m.a = ctx.random() * Math.PI * 2; out.push(hello(ctx.name)); }
      const t = (ctx.elapsed - m.t0) / 1000, r = 2.5, w = 0.5 + 0.4 * ctx.skill, a = m.a + t * w;
      const vx = -Math.sin(a) * r * w, vz = Math.cos(a) * r * w;
      out.push({ d: { t: 'in', ms: Math.round(ctx.elapsed), x: +(Math.cos(a) * r).toFixed(2), z: +(6 + Math.sin(a) * r).toFixed(2), vx: +vx.toFixed(2), vz: +vz.toFixed(2), f: +Math.atan2(vz, vx).toFixed(2), m: 1, d: 0 } });
    }
    return out;
  },
};

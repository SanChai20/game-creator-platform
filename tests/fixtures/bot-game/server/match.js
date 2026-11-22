import { OFFER, card, buy } from '../shared/rules.js';
export default {
  tickRate: 10, snapshotRate: 10, rejoinMs: 10 * 60 * 1000,
  init(ctx) { const s = { t: 0, pl: {} }; for (const p of ctx.players) s.pl[p.id] = { gold: 3, score: 0, bought: 0, ack: 0, offer: [], away: false }; return s; },
  join(s, p) { s.pl[p.id] = s.pl[p.id] || { gold: 3, score: 0, bought: 0, ack: 0, offer: [], away: false }; s.pl[p.id].away = false; },
  leave(s, p) { if (s.pl[p.id]) s.pl[p.id].away = true; },
  input(s, p, inp) {
    const P = s.pl[p.id]; if (!P || !inp || !Array.isArray(inp.c)) return;
    for (const c of inp.c.slice(0, 10)) { const n = Number(c[0]); if (!(n > P.ack)) continue; P.ack = n; if (c[1] === 'buy') buy(P, Math.floor(Number(c[2]))); }
  },
  tick(s, ctx) {
    s.t++;
    if (s.t % 10 === 0) for (const id in s.pl) { const P = s.pl[id]; P.gold += 2; P.offer = Array.from({ length: OFFER }, (_, i) => card(ctx.seed, s.t + i + id.length)); }
    if (s.t >= 10 * 600) ctx.end({ ranking: Object.keys(s.pl).sort((a, b) => s.pl[b].score - s.pl[a].score).map((id) => [id]) });
  },
  view(s, player) { const out = { t: s.t, pl: {} }; for (const id in s.pl) { const P = s.pl[id]; out.pl[id] = id === player.id ? P : { score: P.score, bought: P.bought, away: P.away }; } return out; },
};

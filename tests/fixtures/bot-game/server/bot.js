// The test game's bot: buys the dearest card it can pay for, through the same input a page sends.
import { buy } from '../shared/rules.js';
export default {
  thinkMs: 300,
  think(view, me, ctx) {
    const P = view.pl[me]; if (!P || !P.offer) return null;
    const m = ctx.memory; m.n = Math.max(m.n || 0, P.ack || 0); m.pending = (m.pending || []).filter((c) => c[0] > (P.ack || 0));
    const copy = JSON.parse(JSON.stringify(P));
    const order = copy.offer.map((c, i) => [c, i]).filter((x) => x[0] != null).sort((a, b) => b[0] - a[0]);
    for (const [, i] of order) if (buy(copy, i)) m.pending.push([++m.n, 'buy', i]);
    return m.pending.length ? { c: m.pending } : null;
  },
};

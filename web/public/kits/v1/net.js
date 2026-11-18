// @gcp/net.js — host-authoritative multiplayer on top of GCP.room.
// The model (verified in shipped co-op games): one player, the host, owns the world. Guests send their
// inputs; the host simulates and broadcasts snapshots a few times a second; everyone renders by interpolating
// between snapshots. If the host leaves, the platform promotes the next player, who continues from the last snapshot.

/**
 * joinSession(code, handlers) -> session
 *   handlers.snapshot()            host: return the whole shared state as plain JSON (keep it small)
 *   handlers.apply(state, isFirst, meta) everyone else: receive the host's state (meta.at: when the host sent it; meta.ack:
 *                                  the number of the last of your inputs the host had applied, see session.pending)
 *   handlers.input(peerId, data)   host: a guest's input arrived
 *   handlers.event(data, from)     everyone: a one-off message sent with session.emit()
 *   handlers.open(session)         connected; session.isHost tells you which side you are
 *   handlers.players(list)         someone joined or left
 */
// The send time of the snapshot being applied right now, so Interpolator.push(state) inside handlers.apply picks it up by itself.
let sentAt;

export function joinSession(code, handlers = {}, { hz = 10, max } = {}) {
  const room = window.GCP.room(code, { max });
  const s = {
    room, id: null, get isHost() { return room.isHost; }, get players() { return [{ id: room.id, name: window.GCP.player.name, me: true }, ...room.peers]; },
    /** Guest → host. On the host it is delivered locally, so game code does not need two paths. Each input is numbered;
        the host's snapshots say which one it applied last, so a guest can redo the newer ones on top (reconciliation). */
    sendInput(data) {
      if (room.isHost) { handlers.input && handlers.input(room.id, data, ++seq); return seq; }
      pending.push({ n: ++seq, d: data }); if (pending.length > 240) pending.shift();
      room.send({ k: 'i', d: data, n: seq }, 'host');
      return seq;
    },
    /** Guest: inputs sent that the newest snapshot had not applied yet, oldest first ({ n, d }). Re-apply them to the
        snapshot's position of your own player to predict where you are now. Empty on the host. */
    get pending() { return room.isHost ? [] : pending.filter((p) => p.n > acked); },
    /** Guest: the number of the last input the host had applied in the newest snapshot (0 before any). */
    get acked() { return acked; },
    /** Reliable one-off message to everyone else (chat, effects). */
    emit(data) { room.send({ k: 'e', d: data }); },
    leave() { clearInterval(timer); room.leave(); },
  };
  let timer = 0, n = 0, seq = 0, acked = 0;
  const pending = [];
  const acks = {};   // host: peer id -> number of the last input applied from that peer
  const startHost = () => {
    clearInterval(timer);
    timer = setInterval(() => {
      if (!room.isHost || !handlers.snapshot) return;
      const snap = handlers.snapshot();
      room.send({ k: 's', d: snap, a: acks });
      if (++n % (hz * 5) === 0) room.setState(snap); // every ~5 s keep a copy for late joiners and host migration
    }, 1000 / hz);
  };
  room.on('open', (info) => {
    s.id = info.id;
    if (info.state && handlers.apply) handlers.apply(info.state, true);
    if (info.host) startHost();
    handlers.open && handlers.open(s); handlers.players && handlers.players(s.players);
  });
  room.on('message', (m, from, meta) => {
    if (!m) return;
    if (m.k === 's' && !room.isHost) {
      const a = m.a && typeof m.a === 'object' ? Number(m.a[room.id]) : NaN;
      if (Number.isFinite(a) && a > acked) { acked = a; while (pending.length && pending[0].n <= acked) pending.shift(); }
      sentAt = meta && meta.at;
      try { handlers.apply && handlers.apply(m.d, false, { ...meta, ack: acked }); } finally { sentAt = undefined; }
    }
    else if (m.k === 'i' && room.isHost) {
      // numbers only ever go up per peer; an old or repeated input is still delivered (games decide), but never lowers the ack
      const k = Number(m.n);
      if (Number.isFinite(k) && k > (acks[from] || 0)) acks[from] = k;
      handlers.input && handlers.input(from, m.d, Number.isFinite(k) ? k : undefined);
    }
    else if (m.k === 'e') handlers.event && handlers.event(m.d, from);
  });
  room.on('join', () => handlers.players && handlers.players(s.players));
  room.on('leave', (id) => { delete acks[id]; handlers.players && handlers.players(s.players); });
  room.on('host', () => { if (room.isHost) startHost(); handlers.host && handlers.host(room.isHost); });
  return s;
}

/**
 * Smooths movement between snapshots. push(state) on every snapshot; sample() each frame returns positions
 * blended a little in the past. Entities are matched by id: state = { [id]: { x, y, z?, ... } }.
 * Uses the platform's GCP.smooth: snapshots are placed by the time the host sent them, not when they arrived, and the
 * delay adapts to the connection (delayMs is the least it waits), so late messages no longer make movement stutter.
 */
export class Interpolator {
  constructor(delayMs = 120) {
    this.delay = delayMs; this.buf = [];
    this.smooth = window.GCP && window.GCP.smooth ? window.GCP.smooth({ minDelay: Math.min(delayMs, 200) }) : null;
  }
  push(state, at = sentAt) { if (this.smooth) return this.smooth.push(state, at); this.buf.push({ t: performance.now(), s: state }); if (this.buf.length > 20) this.buf.shift(); }
  sample() {
    if (this.smooth) { const r = this.smooth.sample(); return r ? blend(r.a, r.b, Math.min(r.k, 1.5)) : {}; }
    const b = this.buf; if (!b.length) return {};
    const t = performance.now() - this.delay;
    let i = b.length - 1; while (i > 0 && b[i].t > t) i--;
    const a = b[i], c = b[Math.min(i + 1, b.length - 1)], k = c.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (c.t - a.t))) : 1;
    return blend(a.s, c.s, k);
  }
}

function blend(A, B, k) {
  const out = {};
  for (const id in B) {
    const p = A && A[id], q = B[id];
    if (!p || !q || typeof q !== 'object') { out[id] = q; continue; }
    const o = out[id] = { ...q };
    for (const f of ['x', 'y', 'z']) if (typeof q[f] === 'number' && typeof p[f] === 'number') o[f] = p[f] + (q[f] - p[f]) * k;
  }
  return out;
}

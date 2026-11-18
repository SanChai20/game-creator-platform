// The authoritative match loop (src/runtime/match-core.js) with a fake clock: ticks, inputs, acks, deltas, lag-compensated
// hit checks, per-player views, limits, errors, departures and results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, MatchCore, diff, normalizeDef, patch, rayHit, sanitizeResult } from '../src/runtime/match-core.js';

// A small arena shooter: players move from inputs, fire hitscan shots, first to 3 hits wins.
const arena = (over = {}) => ({
  tickRate: 30, maxRewindMs: 200,
  init(ctx) { const s = { players: {}, hits: [] }; ctx.players.forEach((p, i) => { s.players[p.id] = { x: i * 10, y: 0, score: 0 }; }); return s; },
  join(s, p) { s.players[p.id] = { x: 0, y: 0, score: 0 }; },
  leave(s, p) { delete s.players[p.id]; },
  input(s, p, inp, ctx) {
    const me = s.players[p.id]; if (!me || !inp) return;
    const mx = Math.max(-1, Math.min(1, Number(inp.mx) || 0));
    me.x += mx * 6 * ctx.dt;
    if (inp.fire) {
      const hit = ctx.hitscan(p.id, { origin: [me.x, me.y], dir: [Number(inp.dx) || 1, Number(inp.dy) || 0], range: 100 });
      if (hit) { s.players[p.id].score++; s.hits.push({ by: p.id, on: hit.id, k: ctx.tick }); ctx.emit({ hit: hit.id }, p.id); }
    }
  },
  tick(s, ctx) { const win = Object.entries(s.players).find(([, v]) => v.score >= 3); if (win) ctx.end({ ranking: [[win[0]], Object.keys(s.players).filter((id) => id !== win[0])] }); },
  hitboxes(s) { return Object.entries(s.players).map(([id, p]) => ({ id, x: p.x, y: p.y, r: 0.5 })); },
  ...over,
});

function harness(def, roster = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], extra = {}) {
  let t = 1_000_000;
  const sent = new Map(), closed = [], reports = [], logs = [];
  const io = { now: () => t, send: (id, text) => { if (!sent.has(id)) sent.set(id, []); sent.get(id).push(JSON.parse(text)); }, close: (id, code) => closed.push({ id, code }), report: (r) => reports.push(r), log: (m) => logs.push(m) };
  const core = new MatchCore(def, { id: 'm1', roster, seed: 42, queue: 'q', ...extra }, io);
  const views = new Map();   // what each client holds after applying full and delta snapshots
  const drain = () => {
    for (const [id, list] of sent) for (const m of list.splice(0)) {
      (drain.log[id] ||= []).push(m);
      if (m.t === 's') views.set(id, m.f ? m.d : patch(views.get(id), m.d));
    }
  };
  drain.log = {};
  // the Durable Object calls step() again when it says the next tick is due; advance() does the same
  const advance = (ms) => { const end = t + ms; for (;;) { const wait = core.step(); drain(); if (!(t + Math.max(1, wait) <= end)) break; t += Math.max(1, wait); } t = end; core.step(); drain(); };
  return { core, advance, jump: (ms) => { t += ms; core.step(); drain(); }, at: () => t, views, log: drain.log, closed, reports, logs, drain, input: (id, n, d, v = null) => core.message(id, JSON.stringify({ t: 'i', n, d, v })) };
}

test('a match file is checked, and its numbers are clamped to the limits', () => {
  assert.throws(() => normalizeDef(null), /export default/);
  assert.throws(() => normalizeDef({ init() {} }), /tick/);
  assert.throws(() => normalizeDef({ init() {}, tick() {}, view: 3 }), /view must be a function/);
  const d = normalizeDef({ init() {}, tick() {}, tickRate: 500, snapshotRate: 20, maxRewindMs: 9999 });
  assert.equal(d.tickRate, LIMITS.maxTickRate); assert.equal(d.snapEvery, 3); assert.equal(d.maxRewindMs, LIMITS.maxRewindMs);
  assert.equal(normalizeDef({ init() {}, tick() {}, tickRate: 1 }).tickRate, LIMITS.minTickRate);
});

test('deltas rebuild exactly the state they describe', () => {
  let r = 7; const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
  const gen = (d) => { if (d > 3 || rnd() < 0.3) return rnd() < 0.5 ? Math.round(rnd() * 100) / 10 : rnd() < 0.5 ? 'x' + Math.floor(rnd() * 5) : rnd() < 0.5 ? null : [1, Math.floor(rnd() * 3)]; const o = {}; for (let i = 0; i < 1 + rnd() * 5; i++) o['k' + Math.floor(rnd() * 8)] = gen(d + 1); return o; };
  let a = gen(0);
  for (let i = 0; i < 500; i++) {
    const b = gen(0), d = diff(a, b);
    assert.deepEqual(d === undefined ? a : patch(a, d), b);
    a = b;
  }
  assert.equal(diff({ x: 1, y: [1, 2] }, { x: 1, y: [1, 2] }), undefined);
  assert.deepEqual(diff({ x: 1, y: 2 }, { x: 1 }), { x: ['y'] });
});

test('the match waits for its players, then ticks at a fixed rate; inputs apply in order and come back as acks', () => {
  const h = harness(arena());
  assert.equal(h.core.connect('zed'), false, 'someone not in the roster cannot join');
  h.core.connect('a'); h.advance(10);
  assert.equal(h.core.phase, 'waiting');
  h.core.connect('b'); h.advance(0);
  assert.equal(h.core.phase, 'running');
  assert.ok(h.log.a.some((m) => m.t === 'start'));
  for (let n = 1; n <= 10; n++) h.input('a', n, { mx: 1 });
  h.input('a', 5, { mx: -1 });                       // a replayed number is ignored
  h.advance(1000);
  assert.equal(h.core.tick, 30);
  const snaps = h.log.a.filter((m) => m.t === 's');
  assert.equal(snaps.length, 30);
  assert.equal(snaps.at(-1).a, 10, 'the queue keeps the newest 8 inputs; the last applied is acknowledged');
  assert.ok(Math.abs(h.views.get('a').players.a.x - 8 * 6 / 30) < 1e-9, JSON.stringify(h.views.get('a').players.a));
  assert.deepEqual(h.views.get('b'), h.core.state, 'what the client rebuilt from deltas equals the server state');
  assert.ok(snaps.filter((m) => m.f === 0).length >= 28, 'after the first, snapshots are deltas');
});

test('a long pause does not make the loop run thousands of ticks to catch up', () => {
  const h = harness(arena());
  h.core.connect('a'); h.core.connect('b'); h.advance(0);
  h.jump(60_000);
  assert.ok(h.core.tick < 20, `tick ${h.core.tick}`);
});

test('hits are judged where the target was when the shooter saw it (rewind), within the limit', () => {
  // b runs to the right at 30 units/s; a shoots straight along +y at x = b's position of 150 ms earlier
  const def = arena({ input(s, p, inp, ctx) {
    if (p.id === 'b') s.players.b.x += 1;           // 1 unit per tick
    if (p.id === 'a' && inp && inp.fire) { const hit = ctx.hitscan('a', { origin: [inp.at, -5], dir: [0, 1] }); if (hit) s.hits.push(hit.id); }
  }, init(ctx) { return { players: { a: { x: 0, y: -5, score: 0 }, b: { x: 0, y: 0, score: 0 } }, hits: [] }; } });
  const h = harness(def);
  h.core.connect('a'); h.core.connect('b'); h.advance(0);
  let nb = 0;
  for (let i = 0; i < 20; i++) { h.input('b', ++nb, {}); h.advance(1000 / 30); }
  const bx = h.core.state.players.b.x, k = h.core.tick;
  // a saw b 4.5 ticks ago (150 ms at 30 Hz)
  h.input('a', 1, { fire: 1, at: bx - 4.5 }, k - 4.5); h.input('b', ++nb, {}); h.advance(1000 / 30);
  assert.deepEqual(h.core.state.hits, ['b'], 'hit at the rewound position');
  // the same shot judged at the present misses
  h.input('a', 2, { fire: 1, at: bx - 4.5 }, null); h.input('b', ++nb, {}); h.advance(1000 / 30);
  assert.deepEqual(h.core.state.hits, ['b']);
  // a claim of having seen the world 2 s ago is clamped to maxRewindMs (200 ms = 6 ticks), so it misses
  const k2 = h.core.tick, bx2 = h.core.state.players.b.x;
  h.input('a', 3, { fire: 1, at: bx2 - 60 }, k2 - 60); h.input('b', ++nb, {}); h.advance(1000 / 30);
  assert.deepEqual(h.core.state.hits, ['b']);
});

test('rayHit: circles, spheres and boxes', () => {
  assert.equal(rayHit([0, 0], [1, 0], { c: [5, 0], r: 1 }), 4);
  assert.equal(rayHit([0, 0], [1, 0], { c: [5, 3], r: 1 }), null);
  assert.equal(rayHit([0, 0], [1, 0], { c: [-5, 0], r: 1 }), null, 'behind the shooter');
  assert.ok(Math.abs(rayHit([0, 0, 0], [0, 0, 1], { c: [0, 0.5, 10], r: 1 }) - (10 - Math.sqrt(0.75))) < 1e-9);
  assert.equal(rayHit([0, 0, 0], [1, 0, 0], { min: [2, -1, -1], max: [3, 1, 1] }), 2);
  assert.equal(rayHit([0, 5, 0], [1, 0, 0], { min: [2, -1, -1], max: [3, 1, 1] }), null);
});

test('view() lets each player see only what they may; events go to their target; the result is reported once', () => {
  const def = arena({ view(s, p) { return { me: s.players[p.id], count: Object.keys(s.players).length }; } });
  const h = harness(def);
  h.core.connect('a'); h.core.connect('b'); h.advance(0);
  h.advance(100);
  assert.deepEqual(Object.keys(h.views.get('a')), ['me', 'count']);
  assert.equal(h.views.get('a').me.x, 0); assert.equal(h.views.get('b').me.x, 10);
  // three hits for a end the match
  for (let n = 1; n <= 3; n++) h.input('a', n, { fire: 1, dx: 1 });
  h.advance(200);
  assert.equal(h.core.phase, 'ended');
  assert.equal(h.log.a.filter((m) => m.t === 'e').length, 3); assert.equal((h.log.b || []).filter((m) => m.t === 'e').length, 0);
  assert.deepEqual(h.reports, [{ ranking: [['a'], ['b']] }]);
  assert.ok(h.log.b.some((m) => m.t === 'end'));
  assert.deepEqual(h.closed.map((c) => c.id).sort(), ['a', 'b']);
  h.advance(1000); h.core.finish({}); assert.equal(h.reports.length, 1);
});

test('floods, oversized inputs and junk are refused; a player away past the grace time leaves; an empty match ends', () => {
  const h = harness(arena());
  h.core.connect('a'); h.core.connect('b'); h.advance(0);
  for (let n = 1; n <= 1000; n++) h.input('a', n, { mx: 1 });
  assert.ok(h.core.players.get('a').lastN < 400, 'the flood budget cut the burst short');
  h.core.message('b', 'x'.repeat(LIMITS.inputBytes + 100)); h.drain();
  assert.ok(h.log.b.some((m) => m.t === 'error' && m.code === 'too_large'));
  h.core.message('b', '{"t":"i","n":"1e400"}'); h.core.message('b', '[1,2]'); h.core.message('b', 'null');
  h.core.disconnect('b'); h.advance(LIMITS.graceMs - 1000);
  assert.ok(h.core.state.players.b, 'still in the match during the grace time');
  h.advance(2000);
  assert.equal(h.core.state.players.b, undefined, 'leave() ran');
  assert.equal(h.core.connect('b'), false, 'and the place is gone');
  h.core.disconnect('a'); h.advance(LIMITS.graceMs + 1000);
  assert.equal(h.core.phase, 'ended');
  assert.equal(h.reports[0].reason, 'everyone_left');
});

test('a reconnecting player gets a full snapshot and keeps their acks', () => {
  const h = harness(arena());
  h.core.connect('a'); h.core.connect('b'); h.advance(0);
  h.input('a', 1, { mx: 1 }); h.advance(100);
  h.core.disconnect('a'); h.advance(500);
  h.core.connect('a'); h.advance(40);
  const i = h.log.a.findLastIndex((m) => m.t === 'hello'), hello = h.log.a[i], snap = h.log.a.slice(i).find((m) => m.t === 's');
  assert.equal(hello.ack, 1); assert.equal(snap.f, 1);
  assert.deepEqual(h.views.get('a'), h.core.state);
});

test('a player whose inputs keep breaking the code is removed; the match goes on', () => {
  const h = harness(arena({ input(s, p, inp) { if (inp && inp.boom) throw new Error('bad input'); } }));
  h.core.connect('a'); h.core.connect('b'); h.advance(0);
  for (let n = 1; n <= 40; n++) { h.input('a', n, { boom: 1 }); h.input('b', n, {}); h.advance(1000 / 30); }
  assert.equal(h.core.phase, 'running');
  assert.equal(h.core.players.get('a').left, true);
  assert.ok(h.closed.some((c) => c.id === 'a' && c.code === 4009));
  assert.equal(h.core.state.players.a, undefined, 'leave() ran for them');
});

test('creator code that keeps throwing stops the match with a reason; a single throw does not', () => {
  let calls = 0;
  const h = harness(arena({ tick() { calls++; if (calls === 3) throw new Error('once'); } }));
  h.core.connect('a'); h.core.connect('b'); h.advance(0); h.advance(500);
  assert.equal(h.core.phase, 'running');
  const bad = harness(arena({ tick() { throw new Error('always'); } }));
  bad.core.connect('a'); bad.core.connect('b'); bad.advance(0); bad.advance(1000);
  assert.equal(bad.core.phase, 'ended');
  assert.equal(bad.reports[0].reason, 'server_error'); assert.match(bad.reports[0].message, /always/);
  const none = harness(arena({ init() {} }));
  none.core.connect('a'); none.core.connect('b'); none.advance(0);
  assert.match(none.reports[0].message, /init\(\) returned nothing/);
});

test('without everyone, the match starts with the minimum after the wait, or gives up', () => {
  const h = harness(arena(), [{ id: 'a' }, { id: 'b' }, { id: 'c' }], { minPlayers: 2 });
  h.core.connect('a'); h.core.connect('b'); h.advance(1000);
  assert.equal(h.core.phase, 'waiting');
  h.advance(LIMITS.startWaitMs);
  assert.equal(h.core.phase, 'running');
  h.core.connect('c'); h.advance(50);
  assert.ok(h.core.state.players.c, 'a late player joins through join()');
  const lone = harness(arena(), [{ id: 'a' }, { id: 'b' }]);
  lone.core.connect('a'); lone.advance(LIMITS.startWaitMs * 2 + 1000);
  assert.equal(lone.core.phase, 'ended'); assert.equal(lone.reports[0].aborted, true);
});

test('snapshots over the size limit are not sent, and the next one is full', () => {
  let big = false;
  const h = harness(arena({ view(s) { return big ? { pad: 'x'.repeat(LIMITS.snapshotBytes + 10) } : { ok: s.players.a.x }; } }));
  h.core.connect('a'); h.core.connect('b'); h.advance(0); h.advance(100);
  big = true; h.advance(40); big = false; h.advance(40);
  assert.ok(h.logs.some((l) => /over/.test(l)));
  assert.equal(h.log.a.filter((m) => m.t === 's').at(-1).f, 1);
});

test('results keep only players of the match', () => {
  const players = new Map([['a', 1], ['b', 1]]);
  assert.deepEqual(sanitizeResult({ ranking: [['a', 'zz'], 'b', ['a']], scores: { a: 3, zz: 9, b: 'x' }, reason: 'x'.repeat(100) }, players), { reason: 'x'.repeat(60), ranking: [['a'], ['b']], scores: { a: 3 } });
  assert.deepEqual(sanitizeResult(null, players), {});
});

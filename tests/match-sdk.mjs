// GCP.match in the SDK (web/public/sdk/gcp.js) against a fake network: the matchmaker, the match connection, inputs at
// the tick rate, deltas built by the server's own diff, prediction and reconciliation, reconnects and when not to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { MatchCore, diff } from '../src/runtime/match-core.js';

function loadSdk(config = { api: 'https://p.example', token: 'tok', gameId: 'g', version: 1, env: 'live', base: '/play/g', player: { id: 'me', name: 'Me' }, kind: 'player', session: 's' }) {
  let now = 0; const noop = () => {};
  const sockets = [], intervals = new Map(), timeouts = []; let ids = 1;
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(t) { this.sent.push(JSON.parse(t)); }
    close(code) { this.readyState = 3; this.closedWith = code; }
    open() { this.readyState = 1; this.onopen && this.onopen({}); }
    recv(m) { this.onmessage({ data: JSON.stringify(m) }); }
    drop(code = 1006, reason = '') { this.readyState = 3; this.onclose && this.onclose({ code, reason }); }
  }
  const win = { addEventListener: noop, requestAnimationFrame: () => 0, location: { search: '', pathname: '/', hash: '', origin: 'https://g.example' }, history: { replaceState: noop }, __GCP_CONFIG: config };
  const ctx = {
    window: win, location: win.location, history: win.history, URLSearchParams, console: { ...console, error: noop, log: noop }, navigator: {},
    document: { addEventListener: noop, createElement: () => ({ getContext: () => null, style: {} }), documentElement: { style: {} }, head: { appendChild: noop }, body: null, querySelector: () => null },
    performance: { now: () => now, timeOrigin: 1.7e12 },
    setTimeout: (fn, ms) => { timeouts.push({ fn, at: now + (ms || 0) }); return 0; }, clearTimeout: noop,
    setInterval: (fn) => { const id = ids++; intervals.set(id, fn); return id; }, clearInterval: (id) => intervals.delete(id),
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, fetch: () => Promise.reject(new Error('offline')), Promise, JSON, Math, Object, Array, Date, Number, String, isFinite, Error, Blob: class {}, Uint8Array, Float32Array, ArrayBuffer,
    WebSocket: FakeWS, encodeURIComponent,
  };
  win.window = win; Object.assign(win, ctx);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url), 'utf8'), ctx);
  const runTimers = () => { for (const t of timeouts.splice(0)) if (t.at <= now) t.fn(); else timeouts.push(t); };
  return { GCP: win.GCP, sockets, at: () => now, advance: (ms, step = 4) => { const end = now + ms; while (now < end) { now = Math.min(end, now + step); for (const fn of [...intervals.values()]) fn(); runTimers(); } } };
}

const move = (me, inp, dt) => ({ ...me, x: me.x + (Number(inp.mx) || 0) * 6 * dt });

function found(sdk, m) {
  const mm = sdk.sockets[0]; mm.open();
  mm.recv({ t: 'queued', waiting: 1 });
  mm.recv({ t: 'found', match: 'abc', ticket: 'TICKET', region: 'weur', players: [{ id: 'me' }, { id: 'op' }] });
  const ws = sdk.sockets[1]; ws.open();
  ws.recv({ t: 'hello', you: 'me', match: 'abc', tickRate: 30, maxRewindMs: 200, phase: 'running', k: 0, players: [], ack: 0 });
  return ws;
}

test('find() waits in the matchmaker, then connects to the match with its ticket', () => {
  const sdk = loadSdk(); const seen = [];
  const m = sdk.GCP.match.find({ queue: 'duel', players: 2, code: 'abc12' });
  for (const e of ['queued', 'found', 'start']) m.on(e, (x) => seen.push(e));
  assert.match(sdk.sockets[0].url, /^wss:\/\/p\.example\/api\/rt\/match\?t=tok&queue=duel&players=2&code=abc12$/);
  found(sdk, m);
  assert.equal(sdk.sockets[1].url, 'wss://g.example/play/g/__gcp/match?t=TICKET');
  assert.deepEqual(seen, ['queued', 'found', 'start']);
  assert.equal(m.phase, 'running');
});

test('inputs go out at the tick rate, numbered, with one-off presses sent once', () => {
  const sdk = loadSdk();
  const m = sdk.GCP.match.find({});
  const ws = found(sdk, m);
  m.input({ mx: 1 }); m.press('fire');
  sdk.advance(1000);
  const inputs = ws.sent.filter((x) => x.t === 'i');
  assert.ok(inputs.length >= 29 && inputs.length <= 31, `${inputs.length} inputs in a second`);
  assert.deepEqual(inputs.map((x) => x.n), inputs.map((_, i) => i + 1));
  assert.equal(inputs.filter((x) => x.d.fire).length, 1);
  assert.ok(inputs.every((x) => x.d.mx === 1));
});

test('deltas made by the server rebuild its state; acknowledged inputs are dropped; your entity is predicted ahead', () => {
  const sdk = loadSdk();
  const m = sdk.GCP.match.find({ predict: move });
  const ws = found(sdk, m);
  let server = { players: { me: { x: 0 }, op: { x: 5, hp: 3 } }, t: 0 }, prev = null, k = 0;
  const snap = (ack) => { k++; const d = prev ? diff(prev, server) : server; ws.recv({ t: 's', k, a: ack, f: prev ? 0 : 1, d: d === undefined ? null : d }); prev = JSON.parse(JSON.stringify(server)); };
  snap(0);
  m.input({ mx: 1 });
  sdk.advance(200);                                       // ~6 inputs out, none applied yet
  const sent = ws.sent.filter((x) => x.t === 'i');
  assert.ok(sent.length >= 5);
  const ahead = m.view().me.x;
  assert.ok(Math.abs(ahead - sent.length * 6 / 30) <= 6 / 30 + 1e-9, `predicted ${ahead}`);   // drawn between the last two predicted steps
  // the server applies 3 of them; its state agrees with the prediction, so nothing jumps
  server = { players: { me: { x: 3 * 6 / 30 }, op: { x: 6 } }, t: 1 };
  snap(3);
  assert.deepEqual(JSON.parse(JSON.stringify(m.state)), server, 'the SDK rebuilt the server state from a delta (op.hp removed, op.x changed)');
  assert.equal(m.ack, 3);
  assert.ok(Math.abs(m.view().me.x - ahead) < 1e-6, `after reconciling ${m.view().me.x} vs ${ahead}`);
  // the server disagrees (we hit a wall at 0.1): the correction is applied gradually, not as a jump
  server = { players: { me: { x: 0.1 }, op: { x: 6 } }, t: 2 };
  snap(sent.length);
  const right = 0.1, first = m.view().me.x;
  assert.ok(first > right, 'not snapped at once');
  sdk.advance(600);
  const later = m.view().me.x - (m.ack < ws.sent.filter((x) => x.t === 'i').length ? 0 : 0);
  assert.ok(Math.abs(later - (right + (ws.sent.filter((x) => x.t === 'i').length - m.ack) * 6 / 30)) < 0.05, `converged ${later}`);
});

test('the SDK and a real match core stay in sync over a lossless link', () => {
  const sdk = loadSdk();
  const m = sdk.GCP.match.find({ predict: move });
  const ws = found(sdk, m);
  const core = new MatchCore({ tickRate: 30, init: (c) => ({ players: Object.fromEntries(c.players.map((p) => [p.id, { x: 0 }])) }), input: (s, p, inp, c) => { s.players[p.id].x += (Number(inp.mx) || 0) * 6 * c.dt; }, tick() {} },
    { id: 'abc', roster: [{ id: 'me' }, { id: 'op' }], seed: 1 }, { now: () => sdk.at(), send: (id, t) => { if (id === 'me') ws.recv(JSON.parse(t)); }, close() {}, report() {}, log() {} });
  core.connect('me'); core.connect('op');
  let read = 0;
  m.input({ mx: 1 });
  for (let i = 0; i < 60; i++) {
    sdk.advance(1000 / 60);
    for (const x of ws.sent.slice(read)) core.message('me', JSON.stringify(x)); read = ws.sent.length;
    core.step();
  }
  assert.deepEqual(JSON.parse(JSON.stringify(m.state)), core.state);
  assert.ok(m.ack > 20);
  const pending = ws.sent.filter((x) => x.t === 'i').length - m.ack;
  assert.ok(Math.abs(m.view().me.x - (core.state.players.me.x + pending * 6 / 30)) <= 6 / 30 + 1e-6);
  // each input told the server which moment its sender was looking at
  const vs = ws.sent.filter((x) => x.t === 'i').slice(-5).map((x) => x.v);   // a little behind the newest tick: what is drawn
  assert.ok(vs.every((v) => typeof v === 'number' && v <= core.tick && v > core.tick - 10), JSON.stringify({ vs, tick: core.tick }));
});

test('a dropped connection reconnects with the same ticket; a removal, the end or a second tab do not', () => {
  for (const [code, again] of [[1006, true], [4009, false], [4002, false], [1000, false]]) {
    const sdk = loadSdk();
    const m = sdk.GCP.match.find({});
    const ws = found(sdk, m);
    ws.drop(code);
    sdk.advance(5000);
    assert.equal(sdk.sockets.length === 3, again, `close ${code}`);
    if (again) assert.equal(sdk.sockets[2].url, ws.url);
  }
});

test('opened outside the platform, find() says so instead of hanging', () => {
  const sdk = loadSdk(null); const errors = [];
  const m = sdk.GCP.match.find({}); m.on('error', (e) => errors.push(e.code));
  sdk.advance(10);
  assert.deepEqual(errors, ['standalone']); assert.equal(sdk.sockets.length, 0);
});

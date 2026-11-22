// GCP.match in the SDK (web/public/sdk/gcp.js) against a fake network: the matchmaker, the match connection, inputs at
// the tick rate, deltas built by the server's own diff, prediction and reconciliation, reconnects and when not to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { MatchCore, diff } from '../src/runtime/match-core.js';

function loadSdk(config = { api: 'https://p.example', token: 'tok', gameId: 'g', version: 1, env: 'live', base: '/play/g', player: { id: 'me', name: 'Me' }, kind: 'player', session: 's' }, over = {}) {
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
    WebSocket: FakeWS, encodeURIComponent, ...over,
  };
  win.window = win; Object.assign(win, ctx);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url), 'utf8'), ctx);
  const runTimers = () => { for (const t of timeouts.splice(0)) if (t.at <= now) t.fn(); else timeouts.push(t); };
  return { GCP: win.GCP, win, sockets, at: () => now, advance: (ms, step = 4) => { const end = now + ms; while (now < end) { now = Math.min(end, now + step); for (const fn of [...intervals.values()]) fn(); runTimers(); } } };
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

test('matchInfo() tells the verifier who this page is, who the lobby listed and how far the match got', () => {
  const sdk = loadSdk();
  const m = sdk.GCP.match.find({ code: 'VABCDE', players: 2 });
  const globalThisInfo = () => sdk.win.__GCP.matchInfo();
  const mm = sdk.sockets[0]; mm.open();
  mm.recv({ t: 'lobby', code: 'VABCDE', players: [{ id: 'me', name: 'Me' }], owner: 'me', need: 2 });
  let i = globalThisInfo();
  assert.equal(i.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(i[0])), { code: 'VABCDE', phase: 'searching', you: 'me', match: null, lobby: ['me'], players: [], snapshots: 0, closes: 0, error: '' });
  mm.recv({ t: 'found', match: 'abc', ticket: 'T', region: 'weur', players: [{ id: 'me' }, { id: 'op' }] });
  const ws = sdk.sockets[1]; ws.open();
  ws.recv({ t: 'hello', you: 'me', match: 'abc', tickRate: 30, maxRewindMs: 200, phase: 'running', k: 0, players: [{ id: 'me' }, { id: 'op' }], ack: 0 });
  ws.recv({ t: 's', k: 1, f: 1, a: 0, d: { players: { me: { x: 0 }, op: { x: 1 } } } });
  i = JSON.parse(JSON.stringify(globalThisInfo()[0]));
  assert.equal(i.phase, 'running'); assert.equal(i.match, 'abc'); assert.deepEqual(i.players, ['me', 'op']); assert.equal(i.snapshots, 1);
  m.leave();
});

// ----- coming back after a reload (GCP.match.rejoin) ------------------------------------------------------------------
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
/** A platform that answers /api/rt/match-current with `answer` (null: nothing to go back to), and a page store. */
function platform(answer) {
  const asked = [], store = new Map();
  const fetch = (url, init) => { asked.push({ url, body: JSON.parse(init.body) }); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer || { match: null }) }); };
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  return { asked, store, over: { fetch, localStorage } };
}
const RUNNING = { match: 'abc', ticket: 'AGAIN', queue: 'ranked', mode: 'hard', region: 'weur', players: [{ id: 'me' }, { id: 'op' }] };

test('rejoin() asks the platform for the match this player was in and goes straight back into it', async () => {
  const p = platform(RUNNING), sdk = loadSdk(undefined, p.over), seen = [];
  const m = sdk.GCP.match.rejoin({ predict: move });
  for (const e of ['found', 'start', 'none', 'close', 'error']) m.on(e, (x) => seen.push([e, x]));
  assert.equal(m.phase, 'rejoining'); assert.equal(sdk.sockets.length, 0, 'no matchmaker: nothing is searched');
  await settle();
  assert.equal(p.asked.length, 1);
  assert.equal(p.asked[0].url, 'https://p.example/api/rt/match-current'); assert.deepEqual(p.asked[0].body, { t: 'tok' });
  assert.equal(sdk.sockets.length, 1);
  assert.equal(sdk.sockets[0].url, 'wss://g.example/play/g/__gcp/match?t=AGAIN');
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [['found', { match: 'abc', players: [{ id: 'me' }, { id: 'op' }], region: 'weur', queue: 'ranked', mode: 'hard', rejoin: true }]]);
  assert.equal(m.queue, 'ranked'); assert.equal(m.mode, 'hard'); assert.equal(m.rejoined, true);
  const ws = sdk.sockets[0]; ws.open();
  ws.recv({ t: 'hello', you: 'me', match: 'abc', tickRate: 10, maxRewindMs: 0, phase: 'running', k: 420, players: RUNNING.players, ack: 0 });
  ws.recv({ t: 's', k: 421, f: 1, a: 0, d: { players: { me: { x: 2 }, op: { x: 5 } }, round: 7 } });
  assert.equal(m.phase, 'running'); assert.equal(m.state.round, 7); assert.equal(seen.at(-1)[0], 'start');
  m.input({ mx: 1 }); sdk.advance(500);
  assert.ok(ws.sent.filter((x) => x.t === 'i').length >= 4, 'inputs go out as after find()');
  assert.ok(!seen.some(([e]) => e === 'none' || e === 'error'));
});

test('rejoin() answers none when there is nothing to go back to: no match, the match is over, or the place is gone', async () => {
  // the platform knows no running match
  let p = platform(null), sdk = loadSdk(undefined, p.over), seen = [];
  let m = sdk.GCP.match.rejoin({}); for (const e of ['found', 'start', 'none', 'close', 'error']) m.on(e, (...a) => seen.push([e, ...a.filter((x) => x !== undefined)]));
  await settle();
  assert.deepEqual(seen, [['none'], ['close', 0, 'none']]); assert.equal(m.phase, 'closed'); assert.equal(sdk.sockets.length, 0);
  // the platform cannot be reached, or the game runs from a file: the same quiet answer, never an error
  for (const sdk2 of [loadSdk(), loadSdk(null)]) {
    const got = []; const m2 = sdk2.GCP.match.rejoin({}); for (const e of ['none', 'close', 'error']) m2.on(e, () => got.push(e));
    await settle(); sdk2.advance(10);
    assert.deepEqual(got, ['none', 'close']);
  }
  // the match ended meanwhile (4004), or this player left it or was away too long (4003): not retried
  for (const code of [4004, 4003]) {
    p = platform(RUNNING); sdk = loadSdk(undefined, p.over); seen = [];
    m = sdk.GCP.match.rejoin({}); for (const e of ['start', 'none', 'close']) m.on(e, (...a) => seen.push([e, ...a.filter((x) => x !== undefined)]));
    await settle();
    sdk.sockets[0].open(); sdk.sockets[0].drop(code, 'over');
    sdk.advance(5000);
    assert.deepEqual(seen, [['none'], ['close', code, 'over']]); assert.equal(sdk.sockets.length, 1);
  }
});

test('leaving a match on purpose tells the match, and rejoin() does not lead back into it', async () => {
  const p = platform(RUNNING), sdk = loadSdk(undefined, p.over);
  const m = sdk.GCP.match.find({});
  const ws = found(sdk, m);
  m.leave();
  assert.deepEqual(ws.sent.at(-1), { t: 'bye' }); assert.equal(ws.closedWith, 1000);
  // the same browser opens the game again: the platform may still list the match (it has not reported its end)
  const again = loadSdk(undefined, p.over), seen = [];
  const r = again.GCP.match.rejoin({}); for (const e of ['found', 'none']) r.on(e, () => seen.push(e));
  await settle();
  assert.deepEqual(seen, ['none']); assert.equal(again.sockets.length, 0);
  // a later match is another match
  const next = platform({ ...RUNNING, match: 'def' }); next.over.localStorage = p.over.localStorage;
  const third = loadSdk(undefined, next.over), seen3 = [];
  third.GCP.match.rejoin({}).on('found', () => seen3.push('found'));
  await settle();
  assert.deepEqual(seen3, ['found']);
  // a match that closed for good (the connection was lost, another tab took it over) is not left by tidying up afterwards
  for (const code of [1006, 4002]) {
    const lost = platform(RUNNING), sdk5 = loadSdk(undefined, lost.over), m5 = sdk5.GCP.match.find({});
    const ws5 = found(sdk5, m5);
    ws5.drop(code);
    for (let i = 0; i < 8 && m5.phase !== 'closed'; i++) { sdk5.advance(10_000); const s = sdk5.sockets.at(-1); if (s.readyState !== 3) s.drop(1006); }   // every retry fails
    assert.equal(m5.phase, 'closed', `close ${code}`);
    m5.leave();
    assert.equal(lost.store.size, 0, `close ${code}: nothing marked`);
  }
  // a page that was only closed sends no goodbye: nothing is marked, the player may come back
  const q = platform(RUNNING), sdk4 = loadSdk(undefined, q.over);
  found(sdk4, sdk4.GCP.match.find({}));
  assert.equal(q.store.size, 0);
});

test('a page that comes back after a reload numbers its inputs on from the match, so they count at once', async () => {
  // a real match core that has already taken 400 inputs from this player's first page
  const got = []; let ws = null, clock = 0;
  const core = new MatchCore({ tickRate: 10, rejoinMs: 600000, init: (c) => ({ players: Object.fromEntries(c.players.map((p) => [p.id, { x: 0 }])) }), input: (s, p, inp) => { s.players[p.id].x += Number(inp.mx) || 0; }, tick() {} },
    { id: 'abc', roster: [{ id: 'me' }, { id: 'op' }], seed: 1 }, { now: () => clock, send: (id, t) => { if (id === 'me') { got.push(JSON.parse(t)); if (ws) ws.recv(JSON.parse(t)); } }, close() {}, report() {}, log() {} });
  core.connect('me'); core.connect('op');
  for (let i = 1; i <= 400; i++) { clock += 100; core.message('me', JSON.stringify({ t: 'i', n: i, d: { mx: 1 } })); core.step(); }
  assert.equal(core.state.players.me.x, 400);
  core.disconnect('me');
  // the page is reloaded: a new SDK, which knows nothing of the old page's count
  const p = platform(RUNNING), sdk = loadSdk(undefined, p.over), m = sdk.GCP.match.rejoin({});
  await settle(); ws = sdk.sockets[0]; ws.open(); got.length = 0; core.connect('me');
  assert.equal(got[0].t, 'hello'); assert.equal(got[0].n, 400, 'the match says where its count is');
  m.input({ mx: 1 }); let read = 0;
  for (let i = 0; i < 10; i++) { sdk.advance(100); clock += 100; for (const x of ws.sent.slice(read)) if (x.t === 'i') core.message('me', JSON.stringify(x)); read = ws.sent.length; core.step(); }
  const sent = ws.sent.filter((x) => x.t === 'i');
  assert.ok(sent[0].n === 401, 'the first input after the reload is number ' + sent[0].n);
  assert.ok(core.state.players.me.x >= 408, 'the inputs of the new page are applied within the second: x is ' + core.state.players.me.x);
});

test('against a match built before it said its count, a page that comes back steps past what the match applied', async () => {
  const p = platform(RUNNING), sdk = loadSdk(undefined, p.over), m = sdk.GCP.match.rejoin({});
  await settle(); const ws = sdk.sockets[0]; ws.open();
  ws.recv({ t: 'hello', you: 'me', match: 'abc', tickRate: 10, maxRewindMs: 0, phase: 'running', k: 3000, players: RUNNING.players, ack: 2990 });
  m.input({ mx: 1 }); sdk.advance(300);
  const sent = ws.sent.filter((x) => x.t === 'i');
  assert.ok(sent.length >= 2 && sent[0].n > 2990 + 100, 'numbered past the old page: ' + sent[0].n);
  // a connection that merely dropped and came back keeps counting upward (never back)
  ws.recv({ t: 'hello', you: 'me', match: 'abc', tickRate: 10, maxRewindMs: 0, phase: 'running', k: 3010, players: RUNNING.players, ack: 2995 });
  sdk.advance(300); const all = ws.sent.filter((x) => x.t === 'i').map((x) => x.n);
  assert.ok(all.every((n, i) => i === 0 || n > all[i - 1]), 'numbers only go up');
});

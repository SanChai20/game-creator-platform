// Friends in the SDK (web/public/sdk/gcp.js): private matches that only invites enter, GCP.match.join, GCP.launch.join,
// GCP.friends and GCP.presence, and what guests and pages outside the platform get. Against a fake network and parent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadSdk(config = { api: 'https://p.example', token: 'tok', gameId: 'g', version: 1, env: 'live', base: '/play/g', player: { id: 'me', name: 'Me' }, kind: 'player', session: 's' }, over = {}) {
  let now = 0; const noop = () => {}; const listeners = {};
  const sockets = [], intervals = new Map(), timeouts = []; let ids = 1;
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(t) { this.sent.push(JSON.parse(t)); }
    close(code) { this.readyState = 3; this.closedWith = code; }
    open() { this.readyState = 1; this.onopen && this.onopen({}); }
    recv(m) { this.onmessage({ data: JSON.stringify(m) }); }
    drop(code = 1006, reason = '') { this.readyState = 3; this.onclose && this.onclose({ code, reason }); }
  }
  const win = { addEventListener: (type, fn) => { if (type === 'message') (listeners.message ||= []).push(fn); }, parent: over.parent || null, requestAnimationFrame: () => 0, location: { search: over.search || '', pathname: '/', hash: '', origin: 'https://g.example' }, history: { replaceState: noop }, __GCP_CONFIG: config };
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
  return { GCP: win.GCP, win, listeners, sockets, at: () => now, advance: (ms, step = 4) => { const end = now + ms; while (now < end) { now = Math.min(end, now + step); for (const fn of [...intervals.values()]) fn(); runTimers(); } } };
}


const CFG = { api: 'https://p.example', token: 'tok', gameId: 'g', version: 1, env: 'live', base: '/play/g', player: { id: 'u_me', name: 'Me' }, kind: 'player', session: 's' };
function framed(cfg = CFG, extra = {}) {
  const posted = [], parent = { postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) };
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) });  const b = JSON.parse(init.body); return { ok: true, status: 200, json: async () => (b.op === 'list' ? { ok: true, friends: [{ id: 'u_ben', name: 'Ben', status: 'busy', invitable: true }] } : { ok: true, id: 'inv_1', status: 'busy' }) }; };
  const sdk = loadSdk(cfg, { parent, fetch, URL, ...extra });
  return { ...sdk, posted, calls, parent };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('find({ private: true }) asks for an invite-only lobby (no code goes out) and keeps the lobby the game invites into', () => {
  const sdk = framed();
  const m = sdk.GCP.match.find({ private: true, players: 4, code: 'IGNORED', queue: 'court' });
  const url = sdk.sockets[0].url;
  assert.match(url, /\/api\/rt\/match\?t=tok&private=1/);
  assert.doesNotMatch(url, /code=/);
  assert.match(url, /players=4/); assert.match(url, /queue=court/);
  assert.equal(m.private, true);
  const seen = []; m.on('lobby', (l) => seen.push(l));
  sdk.sockets[0].open();
  sdk.sockets[0].recv({ t: 'lobby', code: null, private: true, lobby: 'LOBBYTOKEN', players: [{ id: 'u_me' }], owner: 'u_me', need: 4 });
  assert.equal(m.lobby, 'LOBBYTOKEN');
  assert.equal(seen[0].private, true);
  sdk.GCP.friends.open({ match: m, label: 'Private court', data: { side: 1 } });
  assert.deepEqual(sdk.posted.find((p) => p.gcp === 'friends_open'), { gcp: 'friends_open', lobby: 'LOBBYTOKEN', label: 'Private court', data: { side: 1 } });
  sdk.GCP.presence.set({ detail: 'Private court, 1 of 4', joinable: m });
  assert.deepEqual(sdk.posted.find((p) => p.gcp === 'presence'), { gcp: 'presence', detail: 'Private court, 1 of 4', lobby: 'LOBBYTOKEN', label: '' });
  sdk.GCP.presence.clear();
  assert.deepEqual(sdk.posted.filter((p) => p.gcp === 'presence').pop(), { gcp: 'presence', detail: '', lobby: null });
});

test('a friend arrives with GCP.launch.join and GCP.match.join enters the lobby through the invite, never a lobby or code', () => {
  const join = { id: 'inv_0123456789abcdef0123', kind: 'match', from: { id: 'u_ann', name: 'Ann' }, match: true, label: 'Court' };
  const b64 = Buffer.from(JSON.stringify(join)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sdk = framed(CFG, { search: '?gcp_join=' + b64, atob: (s) => Buffer.from(s, 'base64').toString('binary') });
  assert.deepEqual(JSON.parse(JSON.stringify(sdk.GCP.launch.join)), join);
  const m = sdk.GCP.match.join(sdk.GCP.launch.join);
  assert.match(sdk.sockets[0].url, /&invite=inv_0123456789abcdef0123$/);
  const closes = []; m.on('close', (c) => closes.push(c)); m.on('error', () => {});
  sdk.sockets[0].open();
  sdk.sockets[0].recv({ t: 'error', code: 'lobby_gone', message: 'That match has started or ended.' });
  assert.equal(m.phase, 'closed'); assert.equal(closes.length, 1);
});

test('friends from the game: list and invite go to the platform with the play token; events come only from the platform page', async () => {
  const sdk = framed();
  assert.equal(sdk.GCP.friends.available, true);
  const list = await sdk.GCP.friends.list();
  assert.equal(list[0].status, 'busy');
  const r = await sdk.GCP.friends.invite('u_ben', { label: 'x'.repeat(100), data: { room: 'r1' } });
  assert.equal(r.status, 'busy');
  assert.deepEqual(sdk.calls.map((c) => c.url), ['https://p.example/api/rt/friends', 'https://p.example/api/rt/friends']);
  assert.deepEqual(sdk.calls[1].body, { t: 'tok', op: 'invite', to: 'u_ben', label: 'x'.repeat(60), data: { room: 'r1' } });
  const joins = []; sdk.GCP.friends.on('join', (j) => joins.push(j));
  assert.deepEqual(sdk.posted.find((p) => p.gcp === 'social_hooks'), { gcp: 'social_hooks', join: true });
  const fire = (data, source = sdk.parent, origin = 'https://p.example') => sdk.listeners.message.forEach((fn) => fn({ data, source, origin }));
  fire({ gcp: 'friends_join', join: { id: 'inv_x' } }, sdk.parent, 'https://evil.example');
  fire({ gcp: 'friends_join', join: { id: 'inv_x' } }, {}, 'https://p.example');
  assert.equal(joins.length, 0, 'only the platform page around the game');
  fire({ gcp: 'friends_join', join: { id: 'inv_x' } });
  assert.deepEqual(joins.map((j) => j.id), ['inv_x']);
});

test('guests, the verifier and a page outside the platform have no friends and cannot open a private match', async () => {
  for (const cfg of [{ ...CFG, player: { id: 'guest_abc', name: 'Guest', guest: true } }, { ...CFG, kind: 'verify' }]) {
    const sdk = framed(cfg);
    assert.equal(sdk.GCP.friends.available, false);
    assert.deepEqual(JSON.parse(JSON.stringify(await sdk.GCP.friends.list())), []);
    const r = await sdk.GCP.friends.invite('u_ben');
    assert.equal(r.ok, false); assert.match(r.code, /^(guest|verify)$/);
    assert.equal(sdk.calls.length, 0, 'nothing is sent');
    const m = sdk.GCP.match.find({ private: true }), errs = [];
    m.on('error', (e) => errs.push(e.code));
    sdk.advance(10);
    assert.deepEqual(errs, ['guest']);
    assert.equal(sdk.sockets.length, 0);
  }
  const alone = loadSdk(null);
  assert.equal(alone.GCP.friends.available, false);
  assert.equal(alone.GCP.launch.join, null);
});

test('typed codes still work for older games', () => {
  const sdk = framed();
  sdk.GCP.match.find({ code: 'abc12', players: 2 });
  assert.match(sdk.sockets[0].url, /code=abc12/);
  assert.doesNotMatch(sdk.sockets[0].url, /private=1/);
});

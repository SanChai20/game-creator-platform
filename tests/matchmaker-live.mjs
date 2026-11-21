// The matchmaker Durable Object (src/matchmaker.ts) in the real Workers runtime with a local D1: public queues, private
// lobbies, a second tab, sessions that end while waiting, and tickets the game Worker accepts.
//   node --test tests/matchmaker-live.mjs     (npm run test:matches; starts its own wrangler dev on port 8792)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { verifyTicket } from '../src/runtime/game-worker.js';

const PORT = Number(process.env.MM_PORT || 8792), BASE = `ws://127.0.0.1:${PORT}`, HTTP = `http://127.0.0.1:${PORT}`;
const CONFIG = 'tests/rt/wrangler.matchmaker.jsonc', SECRET = 'test-session-secret';
const PLAY_KEY = createHmac('sha256', SECRET).update('play:g1').digest('hex');   // what playKey(env, 'g1') gives
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = new URL('..', import.meta.url);
let dev;

before(async () => {
  const persist = mkdtempSync(join(tmpdir(), 'gcp-mm-'));
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '-c', CONFIG, '--persist-to', persist], { cwd: root, stdio: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  dev = spawn('npx', ['wrangler', 'dev', '-c', CONFIG, '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist, '--log-level', 'error'], { cwd: root, stdio: ['ignore', 'ignore', process.env.DEBUG ? 'inherit' : 'ignore'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, detached: true });
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${HTTP}/match?id=x`); if (r.ok) return; } catch { /* starting */ }
    await sleep(500);
  }
  throw new Error('wrangler dev did not start');
});
after(() => { try { process.kill(-dev.pid, 'SIGTERM'); } catch { /* gone */ } });

const seed = (...plays) => fetch(`${HTTP}/seed?plays=${plays.join(',')}`);
function seat(u, o = {}) {
  return { u, n: u.toUpperCase(), s: 'play_' + u, k: 'player', px: 0, tr: false, g: 'g1', e: 'live', q: 'duel', size: 2, min: 2, teams: 1, mode: '', code: null, region: 'weur', rating: 1000, at: 0, ...o };
}
function queue(s) {
  const ws = new WebSocket(`${BASE}/?seat=${encodeURIComponent(JSON.stringify(s))}`);
  const c = { ws, got: [], closed: null };
  c.closed = new Promise((r) => { ws.onclose = (ev) => r(ev.code); });
  ws.onmessage = (ev) => c.got.push(JSON.parse(ev.data));
  c.open = new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return c;
}
const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(25); } return false; };
const env = { PLAY_KEY, GAME_ID: 'g1', ENV: 'live' };

test('two players in a public queue are matched; each gets a ticket the game Worker accepts; the match is recorded', async () => {
  await seed('play_a1:a1', 'play_b1:b1');
  const a = queue(seat('a1', { q: 'q1' })), b = queue(seat('b1', { q: 'q1', rating: 1050 }));
  assert.ok(await until(() => a.got.some((m) => m.t === 'found') && b.got.some((m) => m.t === 'found')));
  const fa = a.got.find((m) => m.t === 'found'), fb = b.got.find((m) => m.t === 'found');
  assert.equal(fa.match, fb.match); assert.equal(fa.region, 'weur');
  assert.equal(await a.closed, 1000);
  const ta = await verifyTicket(fa.ticket, env), tb = await verifyTicket(fb.ticket, env);
  assert.equal(ta.u, 'a1'); assert.equal(tb.u, 'b1'); assert.equal(ta.m, fa.match); assert.equal(ta.seed, tb.seed);
  assert.deepEqual(ta.r.map((r) => r.id).sort(), ['a1', 'b1']);
  assert.equal(await verifyTicket(fa.ticket, { ...env, GAME_ID: 'other' }), null, 'a ticket is only good for its game');
  assert.equal(await verifyTicket(fa.ticket, { ...env, PLAY_KEY: 'x' }), null);
  const row = await (await fetch(`${HTTP}/match?id=${fa.match}`)).json();
  assert.equal(row.project_id, 'g1'); assert.equal(row.queue, 'q1');
  // each player's seat names the match, so a reload can lead back into it (GCP.match.rejoin)
  for (const u of ['a1', 'b1']) assert.equal((await (await fetch(`${HTTP}/seat?u=${u}`)).json()).match_id, fa.match);
  assert.ok(JSON.parse(row.roster).every((r) => r.k === 'player'));
});

test('a private lobby lists its players; only its owner starts it early; it starts by itself when full', async () => {
  await seed('play_o:o', 'play_p:p', 'play_r:r');
  const base = { code: 'ROOM42', size: 3, min: 2, q: 'q2' };
  const o = queue(seat('o', base)); await o.open; await sleep(100);
  const p = queue(seat('p', base));
  assert.ok(await until(() => p.got.some((m) => m.t === 'lobby' && m.players.length === 2)));
  assert.equal(p.got.findLast((m) => m.t === 'lobby').owner, 'o');
  p.ws.send(JSON.stringify({ t: 'start' }));
  assert.ok(await until(() => p.got.some((m) => m.t === 'error' && m.code === 'cannot_start')));
  o.ws.send(JSON.stringify({ t: 'start' }));
  assert.ok(await until(() => o.got.some((m) => m.t === 'found') && p.got.some((m) => m.t === 'found')));
  // a full lobby starts without anyone asking
  const full = { code: 'FULL01', size: 2, min: 2, q: 'q2' };
  const x = queue(seat('o', full)), y = queue(seat('p', full));
  assert.ok(await until(() => x.got.some((m) => m.t === 'found') && y.got.some((m) => m.t === 'found')));
});

test('min 1: a private lobby starts with only its owner; a lone player in a public queue starts after 30 s', { timeout: 60_000 }, async () => {
  await seed('play_solo:solo', 'play_lone:lone');
  const o = queue(seat('solo', { code: 'SOLO01', size: 4, min: 1, q: 'q5' }));
  assert.ok(await until(() => o.got.some((m) => m.t === 'lobby')));
  o.ws.send(JSON.stringify({ t: 'start' }));
  assert.ok(await until(() => o.got.some((m) => m.t === 'found')));
  const f = o.got.find((m) => m.t === 'found');
  assert.deepEqual(f.players.map((p) => p.id), ['solo']);
  const t = await verifyTicket(f.ticket, env);
  assert.equal(t.min, 1); assert.deepEqual(t.r.map((r) => r.id), ['solo']);
  // public queue: alone, it waits out the short-start wait, then starts by itself
  const l = queue(seat('lone', { q: 'q6', size: 4, min: 1 }));
  await l.open; await sleep(3000);
  assert.ok(!l.got.some((m) => m.t === 'found'), 'not at once');
  assert.ok(await until(() => l.got.some((m) => m.t === 'found'), 40_000));
  assert.deepEqual(l.got.find((m) => m.t === 'found').players.map((p) => p.id), ['lone']);
});

test('min 2: a lone player in a public queue keeps waiting', { timeout: 60_000 }, async () => {
  await seed('play_wait:wait');
  const c = queue(seat('wait', { q: 'q7', size: 4, min: 2 }));
  await c.open; await sleep(33_000);
  assert.ok(!c.got.some((m) => m.t === 'found'));
  assert.ok(c.got.some((m) => m.t === 'queued' && m.waited >= 30));
  c.ws.send(JSON.stringify({ t: 'cancel' }));
});

test('a second tab takes the place in the queue; cancel leaves it', async () => {
  await seed('play_t:t');
  const one = queue(seat('t', { q: 'q3' })); await one.open; await sleep(100);
  const two = queue(seat('t', { q: 'q3' }));
  // the old tab is told (the SDK then closes it) and leaves the queue
  assert.ok(await until(() => one.got.some((m) => m.t === 'error' && m.code === 'replaced')));
  await two.open; await sleep(1200);
  assert.ok(!one.got.some((m) => m.t === 'queued' && m.waited), 'no longer in the queue');
  two.ws.send(JSON.stringify({ t: 'cancel' }));
  assert.equal(await two.closed, 1000);
});

test('a player whose play session ended leaves the queue', { timeout: 30_000 }, async () => {
  const ghost = queue(seat('ghost', { q: 'q4', s: 'no_such_play' }));   // never seeded
  assert.equal(await ghost.closed, 4001);
  assert.ok(ghost.got.some((m) => m.t === 'error' && m.code === 'session_ended'));
});

test('a malformed seat is refused', async () => {
  const bad = new WebSocket(`${BASE}/?seat=${encodeURIComponent('{"q":"x"}')}`);
  assert.equal(await new Promise((r) => { bad.onclose = (ev) => r(ev.code); }), 4000);
});

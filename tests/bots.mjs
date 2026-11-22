// Preview test bots, the parts without bindings: the last mile (latency, jitter, loss, spikes, outages, order), the
// numbers per bot, what a creator may ask for, the sandboxed bot logic (bot-runner.js), and the bots' play sessions
// (preview only, of kind bot, never anything else). The whole path over real sockets is tests/bots-live.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { NET_PROFILES, NetLink, NetStats, fleetRequest, netShape, patch, botMinutes, botId } from '../src/bots-core.js';
import { describe, runOne } from '../src/runtime/bot-runner.js';
import { bindingProblem } from '../src/session-binding.js';
import { BotClient } from '../src/bot-client.js';

const seq = (seed = 1) => { let a = seed; return () => ((a = (a * 16807) % 2147483647) / 2147483647); };

test('a network shape: a profile, numbers, and limits', () => {
  assert.deepEqual(netShape({ profile: '4g' }), { profile: '4g', latency: 35, jitter: 15, loss: 0.5 });
  assert.deepEqual(netShape({ latency: 50 }), { profile: 'custom', latency: 50, jitter: 0, loss: 0 });
  assert.deepEqual(netShape({ latency: 99999, jitter: -5, loss: 90 }), { profile: 'custom', latency: 2000, jitter: 0, loss: 30 });
  assert.equal(netShape({}).profile, 'none');
  for (const k of Object.keys(NET_PROFILES)) assert.equal(netShape({ profile: k }).profile, k);
});

test('the last mile adds its delay, keeps messages in order, and a lost packet holds up the ones behind it', () => {
  const l = new NetLink({ latency: 50, jitter: 20, loss: 0 }, seq(7));
  let last = 0; const d = [];
  for (let t = 0; t < 2000; t += 10) { const at = l.schedule(t); assert.ok(at >= last, 'in order'); assert.ok(at >= t); last = at; d.push(at - t); }
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  assert.ok(mean > 40 && mean < 90, `mean added delay ${mean}`);
  // loss: a retransmission after a timeout, and everything after it waits
  const lossy = new NetLink({ latency: 20, jitter: 0, loss: 30 }, seq(3));
  const ds = []; for (let t = 0; t < 5000; t += 20) ds.push(lossy.schedule(t) - t);
  assert.ok(ds.some((x) => x >= 200), 'some messages come a timeout late');
  assert.ok(ds.filter((x) => x > 20).length > ds.filter((x) => x >= 200).length, 'and the ones right behind them are late too');
  // a clear link adds nothing
  const none = new NetLink(netShape({}), seq(1));
  assert.equal(none.schedule(100), 100); assert.ok(none.clear);
});

test('a lag spike and an outage', () => {
  const l = new NetLink({ latency: 10, jitter: 0, loss: 0 }, seq(2));
  l.spike(1000, 2000, 500);
  assert.equal(l.schedule(1500), 2010);
  assert.equal(l.schedule(3500), 3510, 'the spike is over');
  l.outage(4000, 3000);
  assert.equal(l.schedule(4100), 7010, 'nothing gets through until the outage ends');
  assert.equal(l.schedule(4200), 7010, 'then everything sent meanwhile arrives together');
  assert.equal(l.schedule(8000), 8010);
});

test('the numbers per bot: round trips, snapshot spacing and its jitter, traffic', () => {
  const s = new NetStats();
  for (let i = 0; i < 20; i++) s.rtt(1000 + i * 100, 60 + (i % 5) * 10);
  for (let i = 0; i < 50; i++) s.snapshot(1000 + i * 100 + (i % 2 ? 20 : 0));
  s.inBytes(5000, 10240); s.outBytes(5000, 2048);
  const v = s.view(6000);
  assert.equal(v.rtt_p50_ms, 80); assert.equal(v.rtt_p95_ms, 100);
  assert.equal(v.snapshots_per_s, 5);
  assert.ok(v.snapshot_jitter_ms >= 15 && v.snapshot_jitter_ms <= 25, `jitter ${v.snapshot_jitter_ms}`);
  assert.equal(v.snapshot_gap_max_ms, 120);
  assert.equal(v.kb_in_per_s, 1); assert.equal(v.kb_out_per_s, 0.2);
  assert.equal(s.view(60_000).snapshots_per_s, 0, 'old samples leave the window');
});

test('what a creator may ask for', () => {
  const L = { maxBots: 15, maxMinutes: 30 };
  const ok = fleetRequest({ bots: 7, net: '4g', nets: [null, 'poor'] }, L);
  assert.ok(ok.ok); assert.equal(ok.cfg.target, 'follow'); assert.equal(ok.cfg.nets[1].profile, 'poor'); assert.equal(ok.cfg.nets[2].profile, '4g');
  assert.equal(ok.cfg.names[6], 'Test Bot 7'); assert.equal(ok.cfg.minutes, 15);
  assert.match(fleetRequest({ bots: 16 }, L).error, /between 1 and 15/);
  assert.match(fleetRequest({ bots: 2, target: 'queue' }, L).error, /players/);
  assert.ok(fleetRequest({ bots: 3, target: 'queue', players: 4, queue: 'duel' }, L).ok);
  assert.equal(fleetRequest({ bots: 3, target: 'invite' }, L).cfg.target, 'invite', 'bots that wait for the creator\'s invites');
  assert.match(fleetRequest({ bots: 3, target: 'nowhere' }, L).error, /follow, invite, queue/);
  assert.match(fleetRequest({ bots: 2, target: 'code', code: 'x' }, L).error, /code/);
  assert.match(fleetRequest({ bots: 2, region: 'mars' }, L).error, /region/);
  assert.equal(fleetRequest({ bots: 2, minutes: 500 }, L).cfg.minutes, 30, 'never longer than the platform allows');
  assert.equal(botMinutes(7, 30 * 60_000), 210);
  assert.match(botId('abcdefghijkl', 0), /^bot_abcdefgh_1$/);
});

test('snapshot deltas are applied like the SDK applies them', () => {
  const a = { pl: { x: { gold: 3, offer: [1, 2] }, y: { hp: 9 } }, t: 1 };
  assert.deepEqual(patch(a, { o: { t: { v: 2 }, pl: { o: { x: { o: { gold: { v: 5 } } } }, x: ['y'] } } }), { pl: { x: { gold: 5, offer: [1, 2] } }, t: 2 });
  assert.equal(patch(a, null), a);
});

test('server/bot.js in its sandbox: think, the generic actions bot, rooms, memory, and errors that never escape', () => {
  assert.deepEqual(describe(null), { think: false, actions: false, room: false, thinkMs: 250 });
  assert.equal(describe({ think() {}, thinkMs: 5 }).thinkMs, 50);
  const thinker = { think: (view, me, ctx) => { ctx.memory.n = (ctx.memory.n || 0) + 1; return { go: view.x + 1, me, n: ctx.memory.n, skill: ctx.skill }; } };
  const r = runOne(thinker, { kind: 'match', view: { x: 1 }, me: 'bot_1', memory: { n: 4 }, skill: 0.5 });
  assert.deepEqual(r.input, { go: 2, me: 'bot_1', n: 5, skill: 0.5 }); assert.equal(r.memory.n, 5);
  const generic = { actions: () => [{ a: 1 }, { a: 2 }, { a: 3 }] };
  const seen = new Set(); for (let i = 0; i < 40; i++) seen.add(runOne(generic, { kind: 'match', view: {}, seed: 9, calls: i }).input.a);
  assert.equal(seen.size, 3, 'the generic bot picks among the valid actions');
  assert.equal(runOne({ actions: () => [] }, { kind: 'match', view: {} }).input, null);
  assert.deepEqual(runOne(null, { kind: 'match', view: {} }), { input: null }, 'no bot.js: nothing is sent');
  const bad = runOne({ think() { throw new Error('boom'); } }, { kind: 'match', view: {} });
  assert.match(bad.error, /boom/);
  const room = runOne({ room: (ctx) => ctx.messages.map((m) => ({ d: { echo: m.d }, to: m.from })) }, { kind: 'room', messages: [{ from: 'p1', d: 7 }] });
  assert.deepEqual(room.send, [{ d: { echo: 7 }, to: 'p1' }]);
  const big = runOne({ think(v, me, ctx) { ctx.memory.blob = 'x'.repeat(20000); return 1; } }, { kind: 'match', view: {} });
  assert.ok(big.memory._dropped, 'memory is kept small');
});

function d1() {
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(f, dir), 'utf8'));
  const stmt = (q, args = []) => ({ bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...args).changes) } }) });
  return { prepare: (q) => stmt(q), sql };
}

test('a bot\'s play session works in the preview only, only as a bot, and ends when its row is removed', async () => {
  const db = d1(), T = 1_800_000_000_000;
  db.sql.prepare("INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at) VALUES ('ps_b', 'gamea1', 1, 'preview', 'bot_x_1', 'bot', ?, ?)").run(T, T);
  db.sql.prepare("INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at) VALUES ('ps_o', 'gamea1', 1, 'preview', 'u_owner', 'owner', ?, ?)").run(T, T);
  const tok = (o) => ({ g: 'gamea1', e: 'preview', u: 'bot_x_1', n: 'B', k: 'bot', s: 'ps_b', x: T / 1000 + 60, ...o });
  assert.equal(await bindingProblem(db, tok(), T), null);
  assert.ok(await bindingProblem(db, tok({ e: 'live' }), T), 'never live');
  assert.ok(await bindingProblem(db, tok({ k: 'player' }), T), 'a bot session cannot be used as a player\'s');
  assert.ok(await bindingProblem(db, tok({ k: 'owner' }), T));
  assert.ok(await bindingProblem(db, tok({ u: 'u_owner' }), T));
  assert.ok(await bindingProblem(db, { ...tok(), s: 'ps_o', u: 'u_owner' }, T), 'a token saying bot cannot ride the owner\'s session');
  db.sql.prepare("UPDATE plays SET env = 'live' WHERE id = 'ps_b'").run();
  assert.ok(await bindingProblem(db, { ...tok(), e: 'live' }, T), 'a bot row outside the preview is refused too');
  db.sql.prepare("DELETE FROM plays WHERE id = 'ps_b'").run();
  assert.ok(await bindingProblem(db, tok(), T), 'the fleet stopped: the session is over');
});

// A fake game and matchmaker on fake sockets, to check the client's side of the protocol (the live test runs the real one).
function fakeIo(now) {
  const socks = [], io = { now: () => now.t, log: () => {}, changed: () => {}, think: async (c) => ({ input: { at: c.tick } }), api: async () => ({ ticket: 'T2', match: 'm1' }),
    open: async (url, h) => { const s = { url, h, sent: [], closed: null, send(d) { s.sent.push(JSON.parse(d)); }, close(code) { s.closed = code; } }; socks.push(s); return s; } };
  return { io, socks };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('the bot client: matchmaker, hello, snapshots and inputs numbered on from the match; a drop and a reload', async () => {
  const now = { t: 1000 }, { io, socks } = fakeIo(now);
  const b = new BotClient({ id: 'bot_1', name: 'B1', token: 'tok', platform: 'https://p.test', game: 'https://g.test', net: { profile: 'none' }, seed: 1, thinkMs: 50 }, io);
  await b.go({ kind: 'match', query: 'queue=court&players=8' });
  assert.match(socks[0].url, /^wss:\/\/p\.test\/api\/rt\/match\?t=tok&queue=court&players=8$/);
  socks[0].h.message(JSON.stringify({ t: 'found', match: 'm1', ticket: 'T1', players: [{ id: 'bot_1' }] }));
  await tick();
  assert.equal(socks[0].closed, 1000);
  assert.match(socks[1].url, /^wss:\/\/g\.test\/__gcp\/match\?t=T1$/);
  socks[1].h.message(JSON.stringify({ t: 'hello', you: 'bot_1', phase: 'running', players: [], n: 41 }));
  socks[1].h.message(JSON.stringify({ t: 's', k: 5, a: 41, f: 1, d: { x: 1 } }));
  assert.equal(b.phase, 'playing'); assert.deepEqual(b.view, { x: 1 });
  await b.think();
  assert.deepEqual(socks[1].sent.at(-1), { t: 'i', n: 42, v: 5, d: { at: 5 } }, 'inputs go on from the number the match gave');
  socks[1].h.message(JSON.stringify({ t: 's', k: 6, a: 42, f: 0, d: { o: { x: { v: 2 } } } }));
  assert.deepEqual(b.view, { x: 2 });
  // a drop: the socket closes, and the bot comes back with the same ticket
  assert.ok(b.drop(10));
  assert.equal(b.phase, 'away'); assert.equal(socks[1].closed, 4000);
  await new Promise((r) => setTimeout(r, 30));
  assert.match(socks[2].url, /\?t=T1$/);
  // a reload: it asks the platform for its match (match-current) and comes back with the new ticket
  b.drop(10, true);
  await new Promise((r) => setTimeout(r, 30));
  assert.match(socks[3].url, /\?t=T2$/);
  // the match closes for good: no reconnect
  socks[3].h.close(4004, 'This match is over.');
  assert.equal(b.phase, 'out');
  b.stop();
});

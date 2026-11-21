// Server-run matches in the real Workers runtime (wrangler dev / workerd) with real WebSockets: a game Worker built
// exactly like a deployed one (game-worker.js, match-core.js, the creator's server/match.js and shared/), tickets
// signed like the matchmaker signs them, a fake platform for results, and bots playing at 30 inputs a second.
// Measures the tick rate, snapshot spacing and input-to-ack time, then loads many matches at once.
//   node --test tests/match-live.mjs     (npm run test:matches; starts and stops its own wrangler dev on port 8791)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patch } from '../src/runtime/match-core.js';

const PORT = Number(process.env.MATCH_PORT || 8791), BASE = `ws://127.0.0.1:${PORT}`;
const PLAY_KEY = 'test-play-key-0123456789', GAME = 'game1', ENV = 'live';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let dev, platform, signTicket;
const reports = [], checks = [];

// The creator's code: a small arena shooter. Rules live in shared/ like the guide says.
const RULES = `export const SPEED = 6;
export function move(p, inp, dt) {
  const mx = Math.max(-1, Math.min(1, Number(inp.mx) || 0));
  p.x += mx * SPEED * dt;
  return p;
}`;
const MATCH = `import { move } from '../shared/rules.js';
export default {
  tickRate: 30, maxRewindMs: 200,
  init(ctx) { const s = { players: {}, shots: 0 }; ctx.players.forEach((p, i) => { s.players[p.id] = { x: i * 3, y: i % 2 ? 5 : 0, kills: 0 }; }); return s; },
  join(s, p) { s.players[p.id] = { x: 0, y: 0, kills: 0 }; },
  leave(s, p) { delete s.players[p.id]; },
  input(s, p, inp, ctx) {
    const me = s.players[p.id]; if (!me || !inp || typeof inp !== 'object') return;
    if (inp.boom) throw new Error('bad input');
    move(me, inp, ctx.dt);
    if (inp.fire) {
      s.shots++;
      const hit = ctx.hitscan(p.id, { origin: [me.x, me.y], dir: [Number(inp.dx) || 0, Number(inp.dy) || 1], range: 50 });
      if (hit) { me.kills++; ctx.emit({ hit: hit.id, by: p.id }); }
    }
  },
  tick(s, ctx) {
    let burn = 0; for (let i = 0; i < 2000; i++) burn += Math.sqrt(i);   // some work, like a real step
    const win = Object.entries(s.players).find(([, v]) => v.kills >= 3);
    if (win) ctx.end({ ranking: [[win[0]], Object.keys(s.players).filter((id) => id !== win[0])] });
    else if (ctx.options.endAfter && ctx.time >= ctx.options.endAfter) ctx.end({ ranking: [Object.keys(s.players)] });
  },
  hitboxes(s) { return Object.entries(s.players).map(([id, p]) => ({ id, x: p.x, y: p.y, r: 0.6 })); },
};`;

before(async () => {
  // the fake platform: match results and session checks from the game Worker
  platform = createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      if (req.url === '/api/rt/match-result') reports.push({ key: req.headers['x-gcp-key'], ...j });
      if (req.url === '/api/rt/match-check') checks.push(j);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, ended: [] }));
    });
  });
  await new Promise((r) => platform.listen(0, '127.0.0.1', r));
  const platformUrl = `http://127.0.0.1:${platform.address().port}`;

  const dir = mkdtempSync(join(tmpdir(), 'gcp-match-'));
  mkdirSync(join(dir, 'server')); mkdirSync(join(dir, 'shared'));
  for (const f of ['game-worker.js', 'gcp-intrinsics.js', 'match-core.js']) copyFileSync(new URL(`../src/runtime/${f}`, import.meta.url), join(dir, f));
  copyFileSync(new URL('../src/runtime/server/index.js', import.meta.url), join(dir, 'server/index.js'));
  writeFileSync(join(dir, 'server/match.js'), MATCH);
  writeFileSync(join(dir, 'shared/rules.js'), RULES);
  // The local runtime refuses a main module that exports anything but handlers and classes (game-worker.js also exports
  // its helpers for the platform's own code and for tests), so the test enters through a module that passes on only
  // what a deployed game Worker is asked for: the fetch handler and the match class.
  writeFileSync(join(dir, 'entry.js'), "import worker, { GameMatch } from './game-worker.js';\nexport { GameMatch };\nexport default worker;\n");
  writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify({
    name: 'gcp-match-test', main: 'entry.js', compatibility_date: '2026-10-01',
    durable_objects: { bindings: [{ name: 'MATCH', class_name: 'GameMatch' }] },
    migrations: [{ tag: 'gcp-match-v1', new_sqlite_classes: ['GameMatch'] }],
    vars: { PLAY_KEY, STORE_KEY: 'store-key', GAME_ID: GAME, ENV, PLATFORM: platformUrl, PREFIX: 'g/1/', SLUG: 'g', TITLE: 'G', VERSION: '1', MANIFEST: '{}' },
  }));
  const gw = await import(join(dir, 'game-worker.js'));
  const key = await gw.matchKey(PLAY_KEY);
  signTicket = (p) => gw.signPlayToken({ typ: 'match', g: GAME, e: ENV, x: Math.floor(Date.now() / 1000) + 3600, s: 'sess', k: 'player', seed: 7, q: 'duel', min: p.r.length, o: {}, h: 'weur', ...p }, key);
  dev = spawn('npx', ['wrangler', 'dev', '-c', join(dir, 'wrangler.jsonc'), '--port', String(PORT), '--ip', '127.0.0.1', '--log-level', 'error'], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'ignore', process.env.DEBUG ? 'inherit' : 'ignore'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, detached: true });
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/__gcp/health`); if (r.ok) return; } catch { /* starting */ }
    await sleep(500);
  }
  throw new Error('wrangler dev did not start');
});
after(() => { try { process.kill(-dev.pid, 'SIGTERM'); } catch { /* gone */ } platform?.close(); });

const matchId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** A bot: connects with its ticket, sends an input every tick, records snapshots and when each input was acknowledged. */
async function bot(m, u, roster, { o = {}, hz = 30, input = () => ({ mx: 1 }), rejoin = false } = {}) {
  // a ticket for coming back (/api/rt/match-current) names the match and the roster, but not how to start it
  const ticket = await signTicket({ m, u, n: u, r: roster, o, ...(rejoin ? { rj: 1, seed: undefined, min: undefined } : {}) });
  const ws = new WebSocket(`${BASE}/__gcp/match?t=${encodeURIComponent(ticket)}`);
  const b = { u, ws, got: [], snaps: [], states: [], state: null, events: [], sentAt: new Map(), ackMs: [], n: 0, ack: 0, closed: null, end: null, hello: null };
  b.closed = new Promise((r) => { ws.onclose = (ev) => { clearInterval(b.timer); r(ev.code); }; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data), now = performance.now();
    if (msg.t === 's') {
      b.snaps.push({ k: msg.k, at: now, f: msg.f, bytes: ev.data.length });
      b.state = msg.f ? msg.d : patch(b.state, msg.d); b.states.push({ k: msg.k, s: b.state }); if (b.states.length > 30) b.states.shift();
      if (msg.a > b.ack) { for (let n = b.ack + 1; n <= msg.a; n++) if (b.sentAt.has(n)) { b.ackMs.push(now - b.sentAt.get(n)); b.sentAt.delete(n); } b.ack = msg.a; }
    } else if (msg.t === 'e') b.events.push(msg.d);
    else if (msg.t === 'hello') b.hello = msg;
    else if (msg.t === 'end') b.end = msg.result;
    else b.got.push(msg);
    if (msg.t === 'start' || (msg.t === 'hello' && msg.phase === 'running')) startInputs();
  };
  const startInputs = () => {
    if (b.timer) return;
    b.timer = setInterval(() => {
      if (ws.readyState !== 1) return;
      b.n++; b.sentAt.set(b.n, performance.now());
      const d = input(b);
      ws.send(JSON.stringify({ t: 'i', n: b.n, v: d.v !== undefined ? d.v : b.snaps.at(-1)?.k ?? null, d }));
    }, 1000 / hz);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return b;
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(20); } return false; };

test('a forged, expired or foreign ticket is refused; a player not on the roster cannot join', async () => {
  const bad = new WebSocket(`${BASE}/__gcp/match?t=abc.def`);
  const code = await new Promise((r) => { bad.onclose = (e) => r(e.code); bad.onerror = () => r('refused'); });
  assert.ok(code === 'refused' || code === 1006 || code >= 4000, String(code));
  const m = matchId(), roster = [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }];
  const expired = await signTicket({ m, u: 'a', n: 'a', r: roster, x: 1 });
  const e = new WebSocket(`${BASE}/__gcp/match?t=${encodeURIComponent(expired)}`);
  assert.ok(['refused', 1006].includes(await new Promise((r) => { e.onclose = (ev) => r(ev.code); e.onerror = () => r('refused'); })));
  const r = await fetch(`http://127.0.0.1:${PORT}/__gcp/match?t=${encodeURIComponent(await signTicket({ m, u: 'a', n: 'a', r: roster }))}`);
  assert.equal(r.status, 426, 'a plain request is not a match connection');
  const outsider = new WebSocket(`${BASE}/__gcp/match?t=${encodeURIComponent(await signTicket({ m, u: 'zed', n: 'zed', r: roster }))}`);
  assert.ok(['refused', 1006].includes(await new Promise((r) => { outsider.onclose = (ev) => r(ev.code); outsider.onerror = () => r('refused'); })));
});

test('a duel runs at 30 ticks a second, acknowledges inputs quickly, rewinds hits and reports its result once', async () => {
  const m = matchId(), roster = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  let shots = 0;
  // b runs along x at 6 units/s (0.2 a tick). a fires at where b was 5 snapshots ago, 1 unit behind b now (more than
  // b's 0.6 radius), and says it was looking at that moment: only the server's rewind makes these shots hit.
  const a = await bot(m, 'a', roster, { input: (me) => {
    const old = me.states.at(-6);
    if (!old || me.n < 60 || me.n % 10 || shots >= 3 || !old.s.players.b) return {};
    shots++; const t = old.s.players.b, s0 = me.state.players.a;
    return { fire: 1, dx: t.x - s0.x, dy: t.y - s0.y, v: old.k };
  } });
  const b = await bot(m, 'b', roster, { input: () => ({ mx: 1 }) });
  assert.ok(await until(() => a.end, 10_000), 'the match ended');
  assert.deepEqual(a.end.ranking, [['a'], ['b']]);
  assert.equal(a.events.filter((e) => e.hit === 'b').length, 3);
  // tick rate and spacing, from what a player received
  const s = a.snaps.filter((x) => x.k > 5);
  const rate = (s.at(-1).k - s[0].k) / ((s.at(-1).at - s[0].at) / 1000);
  const gaps = s.slice(1).map((x, i) => x.at - s[i].at);
  console.log(`duel: ${rate.toFixed(1)} ticks/s, snapshot gap p50 ${pct(gaps, 0.5).toFixed(1)} ms p99 ${pct(gaps, 0.99).toFixed(1)} ms, input→ack p50 ${pct(a.ackMs, 0.5).toFixed(1)} ms p99 ${pct(a.ackMs, 0.99).toFixed(1)} ms, delta ${pct(s.map((x) => x.bytes), 0.5)} B`);
  assert.ok(rate > 28 && rate < 32, `tick rate ${rate}`);
  assert.ok(pct(gaps, 0.99) < 80, `snapshot gaps p99 ${pct(gaps, 0.99)}`);
  assert.ok(pct(a.ackMs, 0.5) < 60, `input→ack p50 ${pct(a.ackMs, 0.5)}`);
  assert.equal((await a.closed), 1000); await b.closed;
  assert.ok(await until(() => reports.some((r) => r.match === m)));
  const rep = reports.filter((r) => r.match === m);
  assert.equal(rep.length, 1); assert.equal(rep[0].key, 'store-key'); assert.deepEqual(rep[0].result.ranking, [['a'], ['b']]);
  // the match is over for good: a ticket for it is refused now
  const again = await bot(m, 'a', roster);
  assert.equal(await again.closed, 4004);
});

test('a ticket for coming back leads into the running match and never starts one; a player who said goodbye stays out', async () => {
  const m = matchId(), roster = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], o = { endAfter: 9000 };
  // nobody has connected yet: a rejoin ticket does not start the match
  const early = await bot(m, 'a', roster, { o, rejoin: true });
  assert.equal(await early.closed, 4004);
  const a = await bot(m, 'a', roster, { o }), b = await bot(m, 'b', roster, { o });
  assert.ok(await until(() => a.snaps.length > 20 && b.snaps.length > 20), 'the match runs (the refused ticket left nothing behind)');
  // a's page is reloaded: the connection ends without a word, and the new page comes with a new ticket
  const x = a.state.players.a.x, k = a.snaps.at(-1).k;
  a.ws.close(); await a.closed;
  await sleep(300);
  const a2 = await bot(m, 'a', roster, { o, rejoin: true });
  assert.ok(await until(() => a2.snaps.length > 5), 'back in');
  assert.equal(a2.hello.phase, 'running'); assert.ok(a2.hello.k > k, 'the match went on meanwhile');
  assert.equal(a2.snaps[0].f, 1, 'the first snapshot is whole');
  assert.ok(a2.state.players.a.x >= x, `their things are where the match left them (${a2.state.players.a.x} from ${x})`);
  assert.ok(a2.state.players.b, 'and the others are there');
  // b leaves on purpose: leave() runs at once (no grace time), and no ticket leads back in
  b.ws.send(JSON.stringify({ t: 'bye' }));
  assert.equal(await b.closed, 1000);
  assert.ok(await until(() => !a2.state.players.b, 2000), 'gone from the match within a moment, not after 20 s');
  const b2 = await bot(m, 'b', roster, { o, rejoin: true });
  assert.equal(await b2.closed, 4003);
  const b3 = await bot(m, 'b', roster, { o });
  assert.equal(await b3.closed, 4003, 'nor does the ticket they had');
  assert.ok(await until(() => a2.end, 12_000));
  await a2.closed;
});

test('a reconnecting player picks up where they were; a second tab takes over; a flood or broken inputs do not hurt the others', async () => {
  const m = matchId(), roster = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
  const o = { endAfter: 6000 };
  const a = await bot(m, 'a', roster, { o }), b = await bot(m, 'b', roster, { o }), c = await bot(m, 'c', roster, { o, input: () => ({ boom: 1 }) });
  await sleep(800);
  // b floods: thousands of messages at once
  for (let i = 0; i < 3000; i++) b.ws.send(JSON.stringify({ t: 'i', n: 100000 + i, d: { mx: 1 } }));
  // c's inputs keep making input() throw: c is removed, the match goes on
  assert.equal(await c.closed, 4009);
  // a drops and comes back with the same ticket
  a.ws.close(); await a.closed;
  const a2 = await bot(m, 'a', roster, { o });
  assert.ok(await until(() => a2.snaps.length > 10));
  assert.equal(a2.snaps[0].f, 1, 'a full snapshot first');
  assert.ok(a2.hello.ack > 0, 'the server still knows a\'s last input');
  // a second tab of a replaces the first
  const a3 = await bot(m, 'a', roster, { o });
  assert.equal(await a2.closed, 4002);
  const before = a3.snaps.length; await sleep(500);
  assert.ok(a3.snaps.length - before > 12, 'the match kept ticking for the others');
  assert.ok(await until(() => a3.end, 8000));
  await sleep(300);
});

test('load: many matches at once keep their tick rate', { timeout: 120_000 }, async () => {
  const MATCHES = Number(process.env.MATCHES || 20), PLAYERS = 4;
  const all = [];
  for (let i = 0; i < MATCHES; i++) {
    const m = matchId(), roster = Array.from({ length: PLAYERS }, (_, j) => ({ id: `p${j}`, name: `P${j}` }));
    for (const r of roster) all.push(bot(m, r.id, roster, { o: { endAfter: 8000 }, input: (b) => ({ mx: Math.sin(b.n / 10), fire: b.n % 15 === 0 ? 1 : 0, dx: 1, dy: 0 }) }));
  }
  const bots = await Promise.all(all);
  assert.ok(await until(() => bots.every((b) => b.end), 60_000), `${bots.filter((b) => b.end).length}/${bots.length} saw the end`);
  const rates = [], gaps = [], acks = [];
  for (const b of bots) {
    const s = b.snaps.filter((x) => x.k > 15);
    rates.push((s.at(-1).k - s[0].k) / ((s.at(-1).at - s[0].at) / 1000));
    for (let i = 1; i < s.length; i++) gaps.push(s[i].at - s[i - 1].at);
    acks.push(...b.ackMs);
  }
  console.log(`load: ${MATCHES} matches × ${PLAYERS} players on one local runtime: ticks/s min ${Math.min(...rates).toFixed(1)} p50 ${pct(rates, 0.5).toFixed(1)}, snapshot gap p50 ${pct(gaps, 0.5).toFixed(1)} p99 ${pct(gaps, 0.99).toFixed(1)} ms, input→ack p50 ${pct(acks, 0.5).toFixed(1)} p99 ${pct(acks, 0.99).toFixed(1)} ms`);
  assert.ok(Math.min(...rates) > 27, `slowest match ${Math.min(...rates)} ticks/s`);
  assert.ok(pct(gaps, 0.99) < 120, `gap p99 ${pct(gaps, 0.99)}`);
  await sleep(500);
  assert.equal(reports.filter((r) => r.result?.ranking?.[0]?.length === PLAYERS).length >= MATCHES, true);
});

// The play clock at scale (src/clock-core.ts, src/clock-ticket.ts) and the shared game host (src/game-host.ts).
// Proves: for any sequence of check-ins, the in-memory clock gives exactly what the database play clock (src/play-clock.ts)
// gives (each answer, each session's time and counted play, the game's daily totals); a flush writes only what changed
// and owes nothing twice; the tally adds up and forgets players who left; a ticket is bound to its session, player and
// sign-in; the shared host sends only /api/* of games with server code to a Dynamic Worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

// src/clock-do.ts runs here with a stand-in for the Workers runtime's DurableObject base class
const shim = 'data:text/javascript,' + encodeURIComponent('export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}');
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { return s === 'cloudflare:workers' ? { url: ${JSON.stringify(shim)}, shortCircuit: true } : n(s, c); }`));
register('./ts-hook.mjs', import.meta.url);
const { checkIn } = await import('../src/play-clock.ts');
const core = await import('../src/clock-core.ts');
const { clockTicket, readClockTicket } = await import('../src/clock-ticket.ts');
const hosting = await import('../src/hosting.ts');

function d1() {
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(f, dir), 'utf8'));
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  const batch = async (list) => { sql.exec('BEGIN'); try { const out = []; for (const s of list) out.push(await s.run()); sql.exec('COMMIT'); return out; } catch (e) { sql.exec('ROLLBACK'); throw e; } };
  return { prepare: (q) => stmt(q), batch, sql };
}

const T0 = Date.parse('2026-11-19T22:30:00Z');   // crosses midnight UTC, so the daily totals split
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function world(sessions) {
  const DB = d1();
  DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, price_cents, created_at, updated_at) VALUES ('g1', 'u_maker', 'g', 'G', 'live', 0, 0, 0)").run();
  const book = core.emptyBook();
  for (const s of sessions) {
    DB.sql.prepare('INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)').run(s.id, 'g1', s.env, 'u_p', s.kind, s.at, s.at);
    book.sessions[s.id] = core.fromRow(DB.sql.prepare('SELECT * FROM plays WHERE id = ?').get(s.id), s.at);
    book.scopes[core.scopeOf('g1', s.env)] ||= { clock_at: 0, last_counted_at: 0, clock_saved: 0 };
  }
  return { env: { DB }, book };
}

test('the in-memory clock gives the same answers and totals as the database clock, for any sequence of check-ins', async () => {
  const seen = { credited: 0, counted: 0, too_soon: 0, too_old: 0 };
  for (let round = 0; round < 25; round++) {
    const sessions = [
      { id: 'ps_a', env: 'live', kind: 'player', at: T0 },
      { id: 'ps_b', env: 'live', kind: 'player', at: T0 + Math.floor(rnd() * 120_000) },   // a second tab or device
      { id: 'ps_c', env: 'preview', kind: 'player', at: T0 + 5000 },                       // preview: time, no plays
      { id: 'ps_d', env: 'live', kind: 'owner', at: T0 + 1000 },                           // the creator: no plays
    ];
    const { env, book } = world(sessions);
    let t = T0 + 1000, tally = [];
    for (let i = 0; i < 300; i++) {
      // mostly the 15-second rhythm; sometimes too soon, sometimes after a long sleep, sometimes hours apart
      const r = rnd();
      t += r < 0.08 ? Math.floor(rnd() * 2500) : r < 0.9 ? 12_000 + Math.floor(rnd() * 6000) : r < 0.98 ? 60_000 + Math.floor(rnd() * 600_000) : 3_600_000;
      const s = sessions[Math.floor(rnd() * sessions.length)];
      if (t < s.at) continue;
      const visible = rnd() < 0.1 ? Math.floor(rnd() * 5000) : rnd() < 0.05 ? 'junk' : 15_000;
      const db = await checkIn(env, { play_min_seconds: 30 }, s.id, 'u_p', visible, t);
      const mem = core.checkInBook(book, s.id, 'u_p', visible, t, 30);
      assert.deepEqual(mem, db, `round ${round}, check-in ${i} of ${s.id} at +${t - T0}ms`);
      if (db.ok) { seen.credited += db.seconds > 0 ? 1 : 0; seen.counted += db.counted ? 1 : 0; } else if (db.reason in seen) seen[db.reason]++;
      if (rnd() < 0.05) tally.push(...core.takeTally(book, t));   // tallies go out now and then
    }
    tally.push(...core.takeTally(book, t));
    for (const s of sessions) {
      const row = env.DB.sql.prepare('SELECT seconds, counted, seen_at FROM plays WHERE id = ?').get(s.id), b = book.sessions[s.id];
      assert.deepEqual({ seconds: b.seconds, counted: b.counted, seen_at: b.seen_at }, { ...row }, `round ${round}: ${s.id}`);
    }
    const days = {};
    for (const a of tally) for (const [d, v] of Object.entries(a.days)) { const x = (days[d] ||= { seconds: 0, plays: 0 }); x.seconds += v.seconds; x.plays += v.plays; }
    const dbDays = Object.fromEntries(env.DB.sql.prepare("SELECT day, seconds, plays FROM game_daily WHERE project_id = 'g1'").all().map((r) => [r.day, { seconds: r.seconds, plays: r.plays }]));
    for (const d of Object.keys(dbDays)) if (!dbDays[d].seconds && !dbDays[d].plays) delete dbDays[d];
    assert.deepEqual(days, dbDays, `round ${round}: daily totals`);
  }
  // the sequences reach every rule: credited time, counted plays, check-ins too soon, sessions too old
  for (const [k, n] of Object.entries(seen)) assert.ok(n > 10, `only ${n} ${k}`);
});

test('a verifier session and another player are refused, as by the database clock', () => {
  const { book } = world([{ id: 'ps_v', env: 'preview', kind: 'verify', at: T0 }, { id: 'ps_a', env: 'live', kind: 'player', at: T0 }]);
  assert.deepEqual(core.checkInBook(book, 'ps_v', 'u_p', 15000, T0 + 15000, 30), { ok: false, reason: 'unknown' });
  assert.deepEqual(core.checkInBook(book, 'ps_a', 'u_other', 15000, T0 + 15000, 30), { ok: false, reason: 'unknown' });
  assert.deepEqual(core.checkInBook(book, 'ps_nope', 'u_p', 15000, T0 + 15000, 30), { ok: false, reason: 'unknown' });
  assert.deepEqual(core.checkInBook(book, 'ps_a', 'u_p', 15000, T0 + 13 * 3600_000, 30), { ok: false, reason: 'too_old' });
});

test('a flush writes only what changed, and nothing is owed twice', () => {
  const { book } = world([{ id: 'ps_a', env: 'live', kind: 'player', at: T0 }, { id: 'ps_b', env: 'live', kind: 'player', at: T0 }]);
  assert.deepEqual(core.dirtySessions(book), [], 'nothing happened yet');
  core.checkInBook(book, 'ps_a', 'u_p', 15000, T0 + 15000, 30);
  assert.deepEqual(core.dirtySessions(book).map((s) => s.id), ['ps_a']);
  const s = book.sessions.ps_a;
  assert.equal(s.record_add, 15);
  assert.equal(s.record_first, true);
  core.markFlushed(book, core.dirtySessions(book), T0 + 16000);
  assert.deepEqual(core.dirtySessions(book), [], 'written once');
  assert.equal(s.record_add, 0);
  assert.equal(s.record_first, false, 'the player record counts the session once');
  core.checkInBook(book, 'ps_a', 'u_p', 15000, T0 + 30000, 30);
  assert.equal(s.record_add, 15, 'only time since the flush');
  // a heartbeat changes the row but owes the record nothing
  core.beatBook(book, 'ps_b', 120, 0, T0 + 31000);
  const dirty = core.dirtySessions(book).map((x) => x.id).sort();
  assert.deepEqual(dirty, ['ps_a', 'ps_b']);
  assert.equal(book.sessions.ps_b.record_add, 0);
  // tallies are taken once
  assert.equal(core.takeTally(book, T0 + 32000).length, 1);
  assert.deepEqual(core.takeTally(book, T0 + 33000), []);
});

test('a heartbeat moves no play number', () => {
  const { book } = world([{ id: 'ps_a', env: 'live', kind: 'player', at: T0 }]);
  for (let i = 1; i <= 20; i++) core.beatBook(book, 'ps_a', i * 1000, i === 5 ? 2 : 0, T0 + i * 15000);
  const s = book.sessions.ps_a;
  assert.equal(s.seconds, 0); assert.equal(s.counted, 0); assert.equal(s.ready, 1); assert.equal(s.errors, 2); assert.equal(s.frames, 20000);
  const [a] = core.takeTally(book, T0);
  assert.deepEqual(a.days, {}, 'no time, no plays');
  assert.equal(a.seen.length, 1, 'but the player is online');
  assert.equal(core.beatBook(book, 'ps_unknown', 1, 0, T0), null);
});

test('sessions that go quiet are over: dropped from the book with the scopes nobody uses', () => {
  const { book } = world([{ id: 'ps_a', env: 'live', kind: 'player', at: T0 }, { id: 'ps_c', env: 'preview', kind: 'player', at: T0 }]);
  core.checkInBook(book, 'ps_a', 'u_p', 15000, T0 + 15000, 30);
  core.checkInBook(book, 'ps_c', 'u_p', 15000, T0 + 15000, 30);
  core.checkInBook(book, 'ps_a', 'u_p', 15000, T0 + 200_000, 30);
  assert.deepEqual(core.idleSessions(book, T0 + 200_000).map((s) => s.id), ['ps_c']);
  core.dropIdle(book, T0 + 200_000);
  assert.deepEqual(Object.keys(book.sessions), ['ps_a']);
  assert.deepEqual(Object.keys(book.scopes), ['g1']);
});

test('the tally adds up its players\' clocks and counts who is online', () => {
  const tl = core.emptyTally();
  core.addToTally(tl, { project: 'g1', days: { '2026-11-19': { seconds: 30, plays: 1 } }, seen: [{ sid: 'ps_a', env: 'live', player: 'u_1', at: T0 }, { sid: 'ps_b', env: 'live', player: 'u_1', at: T0 }] });
  core.addToTally(tl, { project: 'g1', days: { '2026-11-19': { seconds: 15, plays: 0 }, '2026-11-20': { seconds: 5, plays: 1 } }, seen: [{ sid: 'ps_c', env: 'preview', player: 'u_2', at: T0 + 1000 }, { sid: 'ps_a', env: 'live', player: 'u_1', at: T0 - 50_000 }] });
  assert.deepEqual(tl.days, { '2026-11-19': { seconds: 45, plays: 1 }, '2026-11-20': { seconds: 5, plays: 1 } });
  assert.equal(tl.seen.ps_a.at, T0, 'an older report does not move a session back');
  assert.deepEqual(core.onlineOf(tl, T0 + 2000), { live: 1, preview: 1, live_sessions: 2 }, 'one player in two tabs is one player');
  assert.deepEqual(core.onlineOf(tl, T0 + core.TALLY_ONLINE_MS + 1500), { live: 0, preview: 0, live_sessions: 0 });
  assert.deepEqual(tl.seen, {}, 'players who left are forgotten');
});

test('a clock ticket is bound to its session, its player and the sign-in that started it', async () => {
  const k = 'secret-1', sid = 'ps_abcdef0123456789', t = await clockTicket(k, sid, 'u_player1', 'login-1');
  assert.equal(await readClockTicket(k, t, sid, 'login-1'), 'u_player1');
  assert.equal(await readClockTicket(k, t, sid, 'login-2'), null, 'another sign-in (signed out and in again, another browser)');
  assert.equal(await readClockTicket(k, t, sid, null), null);
  assert.equal(await readClockTicket(k, t, 'ps_0000000000000000', 'login-1'), null, 'another session');
  assert.equal(await readClockTicket('secret-2', t, sid, 'login-1'), null, 'another key');
  assert.equal(await readClockTicket(k, t.replace('u_player1', 'u_player2'), sid, 'login-1'), null, 'another player');
  assert.equal(await readClockTicket(k, t.slice(0, -1) + (t.endsWith('0') ? '1' : '0'), sid, 'login-1'), null, 'a forged signature');
  for (const bad of ['', null, undefined, 'x', `${sid}.u_player1`, `${sid}.u_player1.zz`]) assert.equal(await readClockTicket(k, bad, sid, 'login-1'), null, String(bad));
  const g = await clockTicket(k, sid, 'guest_abc123', null);
  assert.equal(await readClockTicket(k, g, sid, null), 'guest_abc123', 'a guest has no sign-in');
});

test('the shared host: one host for every game, matches keep a Worker of their own', () => {
  const env = { DEPLOY_DRIVER: 'shared', GAME_HOST: 'hearthcade.app', GAME_ZONE_ID: 'z1' };
  assert.equal(hosting.hostKind(env), 'shared');
  assert.equal(hosting.hostId(env), 'shared:hearthcade.app');
  assert.deepEqual(hosting.parseHostId('shared:hearthcade.app'), { kind: 'shared', routeHost: 'hearthcade.app' });
  assert.equal(hosting.matchHostId(env), 'workers:hearthcade.app');
  assert.equal(hosting.matchHostId({ DEPLOY_DRIVER: 'cloudflare' }), hosting.hostId({ DEPLOY_DRIVER: 'cloudflare' }), 'other hosts keep every game');
  assert.equal(hosting.gameUrlFor(env, hosting.parseHostId(hosting.hostId(env)), 'gcp-abc123-live', { origin: 'https://hearthcade.com' }), 'https://gcp-abc123-live.hearthcade.app/');
  assert.throws(() => hosting.scriptsPath({ kind: 'shared' }), /no scripts/);
  assert.deepEqual(hosting.hostingProblems({ ...env, LOADER: {} }), []);
  const missing = hosting.hostingProblems({ DEPLOY_DRIVER: 'shared' }).join(' ');
  for (const w of ['GAME_HOST', 'LOADER', 'GAME_ZONE_ID']) assert.match(missing, new RegExp(w));
  assert.equal(hosting.matchGameRequest(env, new URL('https://gcp-abc123-live.hearthcade.app/index.html'))?.script, 'gcp-abc123-live');
  assert.equal(hosting.matchGameRequest(env, new URL('https://evil-abc123-live.hearthcade.app/'))?.script ?? null, null);
});

test('the shared host sends only /api/* of a game with server code to a Dynamic Worker', async () => {
  const gh = await import('../src/game-host.ts');
  for (const p of ['/api/save', '/api/', '/~t/abcdefghijklmnop1234/api/score', '/%61pi/x']) assert.equal(gh.isServerRequest(p), true, p);
  for (const p of ['/', '/index.html', '/apix', '/assets/api/x.js', '/~t/abcdefghijklmnop1234/index.html', '/~t/short/api/x', '/%E0%A4%A']) assert.equal(gh.isServerRequest(p), false, p);
  const files = (...p) => JSON.stringify(p.map((path) => ({ path })));
  assert.deepEqual(gh.serverModules(files('index.html', 'game.js')), { server: [], hasServer: false, matches: false });
  assert.deepEqual(gh.serverModules(files('index.html', 'server/index.js', 'shared/rules.mjs', 'server/notes.txt')), { server: ['server/index.js', 'shared/rules.mjs'], hasServer: true, matches: false });
  assert.equal(gh.serverModules(files('server/match.js')).matches, true);
  assert.deepEqual(gh.serverModules(null), { server: [], hasServer: false, matches: false });
  assert.equal(gh.servedVersion({ status: 'live', live_version: 3, preview_version: 4 }, 'live'), 3);
  assert.equal(gh.servedVersion({ status: 'live', live_version: 3, preview_version: 4 }, 'preview'), 4);
  assert.equal(gh.servedVersion({ status: 'draft', live_version: 3, preview_version: 4 }, 'live'), null, 'an unpublished game has no live version');
  assert.equal(gh.servedVersion({ status: 'removed', live_version: 3, preview_version: 4 }, 'preview'), null);
  const out = { a: 1 };
  const id = await gh.dynamicWorkerId('gcp-abc123-live', 3, 'r1', out);
  assert.equal(id, await gh.dynamicWorkerId('gcp-abc123-live', 3, 'r1', { a: 1 }), 'same code, same id: reused');
  for (const other of [gh.dynamicWorkerId('gcp-abc123-live', 4, 'r1', out), gh.dynamicWorkerId('gcp-abc123-live', 3, 'r2', out), gh.dynamicWorkerId('gcp-abc123-live', 3, 'r1', { a: 2 }), gh.dynamicWorkerId('gcp-abc123-preview', 3, 'r1', out)])
    assert.notEqual(await other, id);
});

test('a player clock that is shut down between every two requests loses nothing and counts nothing twice', async () => {
  // Durable Objects drop their memory after 10 idle seconds, and check-ins come every 15: each request may meet a new
  // object with only its storage. Here every request and alarm does.
  const { PlayClock, GameTally } = await import('../src/clock-do.ts');
  let now = T0;
  const realNow = Date.now; Date.now = () => now;
  try {
    const DB = d1();
    DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, live_version, price_cents, created_at, updated_at) VALUES ('g1', 'u_maker', 'g', 'G', 'live', 1, 0, 0, 0)").run();
    DB.sql.prepare("INSERT INTO users (id, email, name, pw_hash, created_at) VALUES ('u_p', 'p@example.com', 'P', 'x', 0)").run();
    DB.sql.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)').run('login1', 'u_p', T0 + 86400_000);
    DB.sql.prepare("INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at, login_id) VALUES ('ps_a', 'g1', 1, 'live', 'u_p', 'player', ?, ?, 'login1')").run(T0, T0);
    const env = { DB };
    const ns = (Cls) => {
      const stores = new Map(), alarms = new Map();
      const store = (name) => { const m = new Map(); return { get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, getAlarm: async () => alarms.get(name) ?? null, setAlarm: async (t) => { alarms.set(name, t); } }; };
      const fresh = (name) => { if (!stores.has(name)) stores.set(name, store(name)); return new Cls({ storage: stores.get(name) }, env); };
      return {
        idFromName: (n) => n,
        get: (name) => new Proxy({}, { get: (_, m) => async (...a) => structuredClone(await fresh(name)[m](...structuredClone(a))) }),
        alarms: async (t) => { for (const [name, at] of [...alarms]) if (at <= t) { alarms.delete(name); await fresh(name).alarm(); } },
      };
    };
    env.PLAY_CLOCK = ns(PlayClock); env.GAME_TALLY = ns(GameTally);
    const clock = env.PLAY_CLOCK.get('u_p');
    const seen = [];
    for (let i = 0; i <= 40; i++) {   // ten minutes of check-ins and heartbeats
      now = T0 + i * 15_000;
      const r = await clock.checkIn('ps_a', 'u_p', i ? 15_000 : 0, now, 30);
      seen.push(r.seconds);
      await clock.beat({ sid: 'ps_a', player: 'u_p', frames: i * 900, errors: [], fatal: false, t: now + 1, human_min_seconds: 60, tok: { g: 'g1', e: 'live', u: 'u_p', k: 'player', s: 'ps_a' } });
      await env.PLAY_CLOCK.alarms(now); await env.GAME_TALLY.alarms(now);
    }
    assert.deepEqual(seen.slice(0, 4), [0, 15, 30, 45]);
    assert.equal(seen.at(-1), 600, 'every check-in credited, none lost to a restart');
    // the player leaves: the clock writes out, the tally writes the totals and counts the player down to zero
    for (let t = now, stop = now + 15 * 60_000; t <= stop; t += 1000) { now = t; await env.PLAY_CLOCK.alarms(t); await env.GAME_TALLY.alarms(t); }
    const row = (q) => DB.sql.prepare(q).get();
    assert.deepEqual({ ...row("SELECT seconds, counted, ready FROM plays WHERE id = 'ps_a'") }, { seconds: 600, counted: 1, ready: 1 });
    assert.equal(row("SELECT seconds FROM player_games WHERE project_id = 'g1' AND user_id = 'u_p'").seconds, 600, 'the player record, once');
    assert.deepEqual({ ...row("SELECT seconds, plays FROM projects WHERE id = 'g1'") }, { seconds: 600, plays: 1 }, 'the game totals, once');
    assert.equal(row("SELECT SUM(seconds) AS s FROM game_daily WHERE project_id = 'g1'").s, 600);
    assert.equal(row("SELECT live_players FROM game_online WHERE project_id = 'g1'").live_players, 0, 'nobody online after they left');
  } finally { Date.now = realNow; }
});

test('a session handed to the clock at its start is counted once and never read back', async () => {
  const { PlayClock, GameTally } = await import('../src/clock-do.ts');
  let now = T0;
  const realNow = Date.now; Date.now = () => now;
  try {
    const DB = d1();
    DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, live_version, price_cents, created_at, updated_at) VALUES ('g1', 'u_maker', 'g', 'G', 'live', 1, 0, 0, 0)").run();
    const queries = [];
    const env = { DB: { prepare: (q) => { queries.push(q); return DB.prepare(q); }, batch: (l) => DB.batch(l) } };
    const objs = new Map(), alarms = new Map();
    const ns = (Cls, prefix) => ({
      idFromName: (n) => n,
      get: (name) => {
        const key = prefix + name;
        if (!objs.has(key)) { const m = new Map(); objs.set(key, new Cls({ storage: { get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, getAlarm: async () => alarms.get(key) ?? null, setAlarm: async (t) => { alarms.set(key, t); } } }, env)); }
        const o = objs.get(key);
        return new Proxy({}, { get: (_, f) => async (...a) => structuredClone(await o[f](...structuredClone(a))) });
      },
    });
    env.PLAY_CLOCK = ns(PlayClock, 'c:'); env.GAME_TALLY = ns(GameTally, 't:');
    DB.sql.prepare("INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at) VALUES ('ps_a', 'g1', 1, 'live', 'u_p', 'player', ?, ?)").run(T0, T0);
    const clock = env.PLAY_CLOCK.get('u_p');
    await clock.open({ id: 'ps_a', project_id: 'g1', version: 1, env: 'live', user_id: 'u_p', kind: 'player', started_at: T0, seen_at: null, seconds: 0, counted: 0, trial: 0, trial_seconds: 0, trial_until: null }, T0);
    await clock.open({ id: 'ps_a', project_id: 'g1', version: 1, env: 'live', user_id: 'u_p', kind: 'player', started_at: T0, seen_at: null, seconds: 0, counted: 0, trial: 0, trial_seconds: 0, trial_until: null }, T0);
    assert.equal(queries.length, 1, 'one read at the start: the player\'s clock for the game');
    now = T0 + 15_000;
    assert.deepEqual(await clock.checkIn('ps_a', 'u_p', 15_000, now, 30), { ok: true, counted: false, seconds: 15 });
    assert.ok(!queries.some((q) => /FROM plays WHERE id = \? AND user_id/.test(q)), 'the session is not read back');
    assert.ok(!queries.some((q) => /LEFT JOIN plays p ON p.id/.test(q)), 'the sign-in was checked at the start');
    now = T0 + 120_000;
    await clock.flush(now);
    await clock.checkIn('ps_a', 'u_p', 15_000, now, 30);   // sends the tally (a minute has passed)
    for (const [k, at] of [...alarms]) if (k.startsWith('t:') && at <= now + 60_000) { now = at; alarms.delete(k); await objs.get(k).alarm(); }
    assert.equal(DB.sql.prepare("SELECT SUM(sessions) AS n FROM game_daily WHERE project_id = 'g1'").get().n, 1, 'the start counted once, by the tally');
  } finally { Date.now = realNow; }
});

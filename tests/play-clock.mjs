// The platform's play clock: every play number comes from the platform's own observations, never from the game.
// Proves: play time is credited only from check-ins of the page showing the game, capped by the server's clock; a play
// counts once it passes the minimum and only once; a game's heartbeat claims move nothing; a session can only be checked
// in by the player it belongs to; racing check-ins credit time once; the daily totals, the game's totals and the
// player's record follow the check-ins; free-trial time is charged by the server's clock up to the session's end.
// Real migrations, in-memory SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { checkIn, creditSeconds, openSeconds, sessionStartStmt, MAX_CREDIT_MS } = await import('../src/play-clock.ts');
const { trialOpenStmts, TRIAL_MIN_CHARGE_S } = await import('../src/trials.ts');
const { playedSeconds } = await import('../src/earnings.ts');

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

const S = { play_min_seconds: 30 };
const T0 = Date.parse('2026-11-19T10:00:00Z');
function setup({ kind = 'player', env = 'live', trial = 0, trialUntil = null } = {}) {
  const DB = d1();
  DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, price_cents, created_at, updated_at) VALUES ('g1', 'u_maker', 'g', 'G', 'live', 0, 0, 0)").run();
  DB.sql.prepare('INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at, trial, trial_until) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)').run('ps1', 'g1', env, 'u_p', kind, T0, T0, trial, trialUntil);
  return { DB };
}
const row = (env, q) => env.DB.sql.prepare(q).get();
const play = (env) => row(env, "SELECT * FROM plays WHERE id = 'ps1'");

test('one check-in credits what the page saw on screen, never more than the server clock or the cap', () => {
  assert.equal(creditSeconds(0, 15000, 15000), 15);
  assert.equal(creditSeconds(0, 15000, 9000), 9);
  assert.equal(creditSeconds(0, 15000, 3_600_000), 15, 'a page cannot claim more time than has passed');
  assert.equal(creditSeconds(0, 600_000, 600_000), MAX_CREDIT_MS / 1000, 'a long gap (sleep, throttled tab) credits at most the cap');
  assert.equal(creditSeconds(0, 15000, -5), 0);
  assert.equal(creditSeconds(0, 15000, 'lots'), 0);
  assert.equal(creditSeconds(20000, 15000, 15000), 0, 'a clock that went backwards credits nothing');
  assert.equal(openSeconds({ started_at: 1000, seen_at: null }), 0);
  assert.equal(openSeconds({ started_at: 1000, seen_at: 91000 }), 90);
});

test('play time, counted plays and the totals come only from the page check-ins', async () => {
  const env = setup();
  await env.DB.batch([sessionStartStmt(env.DB, 'g1', T0)]);
  // first check-in right after launch: the session is open, no time yet, the player's record starts
  let r = await checkIn(env, S, 'ps1', 'u_p', 0, T0 + 1000);
  assert.deepEqual(r, { ok: true, counted: false, seconds: 0 });
  assert.equal(row(env, "SELECT sessions FROM player_games WHERE user_id = 'u_p'").sessions, 1);
  r = await checkIn(env, S, 'ps1', 'u_p', 15000, T0 + 16000);
  assert.deepEqual(r, { ok: true, counted: false, seconds: 15 });
  r = await checkIn(env, S, 'ps1', 'u_p', 15000, T0 + 31000);
  assert.deepEqual(r, { ok: true, counted: true, seconds: 30 }, 'counted once it reaches the minimum');
  r = await checkIn(env, S, 'ps1', 'u_p', 15000, T0 + 46000);
  assert.equal(r.seconds, 45);
  const p = play(env);
  assert.equal(p.counted, 1); assert.equal(p.seconds, 45); assert.equal(p.seen_at, T0 + 46000);
  const g = row(env, "SELECT plays, seconds FROM projects WHERE id = 'g1'");
  assert.deepEqual({ ...g }, { plays: 1, seconds: 45 }, 'the play counted exactly once');
  const day = row(env, "SELECT sessions, plays, seconds FROM game_daily WHERE project_id = 'g1'");
  assert.deepEqual({ ...day }, { sessions: 1, plays: 1, seconds: 45 });
  const rec = row(env, "SELECT sessions, seconds, last_at FROM player_games WHERE user_id = 'u_p'");
  assert.deepEqual({ ...rec }, { sessions: 1, seconds: 45, last_at: T0 + 46000 });
});

test('a hidden tab keeps the session open but credits no play time', async () => {
  const env = setup();
  await checkIn(env, S, 'ps1', 'u_p', 0, T0 + 1000);
  for (let i = 1; i <= 10; i++) await checkIn(env, S, 'ps1', 'u_p', 0, T0 + 1000 + i * 60000);
  const p = play(env);
  assert.equal(p.seconds, 0); assert.equal(p.counted, 0);
  assert.equal(openSeconds(p), 601, 'open time (refunds, trials) still runs by the server clock');
});

test('only the player the session belongs to can check it in; verifier sessions take none; old sessions stop', async () => {
  const env = setup();
  assert.deepEqual(await checkIn(env, S, 'ps1', 'u_other', 15000, T0 + 15000), { ok: false, reason: 'unknown' });
  assert.deepEqual(await checkIn(env, S, 'nope', 'u_p', 15000, T0 + 15000), { ok: false, reason: 'unknown' });
  assert.equal(await checkIn(env, S, 'ps1', 'u_p', 15000, T0 + 13 * 3600_000).then((r) => r.reason), 'too_old');
  assert.equal(play(env).seen_at, null);
  const v = setup({ kind: 'verify', env: 'preview' });
  assert.equal((await checkIn(v, S, 'ps1', 'u_p', 15000, T0 + 15000)).reason, 'unknown');
});

test('check-ins sent twice or racing each other credit the time once', async () => {
  const env = setup();
  await checkIn(env, S, 'ps1', 'u_p', 0, T0 + 1000);
  const [a, b] = await Promise.all([checkIn(env, S, 'ps1', 'u_p', 15000, T0 + 16000), checkIn(env, S, 'ps1', 'u_p', 15000, T0 + 16500)]);
  assert.equal([a, b].filter((x) => x.ok).length, 1);
  assert.equal(play(env).seconds, 15);
  assert.equal((await checkIn(env, S, 'ps1', 'u_p', 1000, T0 + 17000)).reason, 'too_soon');
});

test('the creator\'s own sessions keep a play record but never count as plays', async () => {
  const env = setup({ kind: 'owner' });
  await checkIn(env, S, 'ps1', 'u_p', 0, T0 + 1000);
  await checkIn(env, S, 'ps1', 'u_p', 15000, T0 + 16000);
  await checkIn(env, S, 'ps1', 'u_p', 15000, T0 + 31000);
  assert.equal(play(env).counted, 0);
  assert.deepEqual({ ...row(env, "SELECT plays, seconds FROM projects WHERE id = 'g1'") }, { plays: 0, seconds: 0 });
  assert.equal(row(env, "SELECT COUNT(*) AS n FROM game_daily").n, 0);
});

test('what a game claims about itself moves no play number', async () => {
  const env = setup();
  // a game that reports heartbeats for an hour (or keeps a stolen token alive) after the store page closed
  await checkIn(env, S, 'ps1', 'u_p', 0, T0 + 1000);
  await checkIn(env, S, 'ps1', 'u_p', 10000, T0 + 11000);
  env.DB.sql.prepare("UPDATE plays SET last_beat_at = ?, ready = 1, frames = 999999 WHERE id = 'ps1'").run(T0 + 3600_000);
  assert.equal(play(env).seconds, 10);
  assert.equal(await playedSeconds(env, 'u_p', 'g1'), 11, 'refund play time stops at the page\'s last check-in');
});

test('a free-trial session is charged by the server clock, up to its end, from heartbeats or check-ins alike', async () => {
  const env = setup({ trial: 1, trialUntil: T0 + 120_000 });
  env.DB.sql.prepare("INSERT INTO trials (project_id, user_id, seconds, sessions, started_at, last_at) VALUES ('g1', 'u_p', ?, 1, ?, ?)").run(TRIAL_MIN_CHARGE_S, T0, T0);
  const used = () => row(env, "SELECT seconds FROM trials WHERE user_id = 'u_p'").seconds;
  await checkIn(env, S, 'ps1', 'u_p', 0, T0 + 20_000);
  assert.equal(used(), TRIAL_MIN_CHARGE_S, 'the first 30 s were charged up front');
  await checkIn(env, S, 'ps1', 'u_p', 15_000, T0 + 60_000);
  assert.equal(used(), 60);
  // a heartbeat at the same moment charges nothing more (guarded on the value read)
  const p = play(env);
  await env.DB.batch(trialOpenStmts(env.DB, p, T0 + 60_000, p.trial_until));
  assert.equal(used(), 60);
  // a stale read racing a newer charge is refused
  await env.DB.batch(trialOpenStmts(env.DB, { ...p, trial_seconds: 30 }, T0 + 60_000, p.trial_until));
  assert.equal(used(), 60);
  // never past the session's end, however late the check-in
  await checkIn(env, S, 'ps1', 'u_p', 15_000, T0 + 600_000);
  assert.equal(used(), 120);
  assert.equal(play(env).trial_seconds, 120);
});

test('sessions a player opens side by side share one clock: the same minute is never credited twice', async () => {
  const env = setup();
  for (const id of ['ps2', 'ps3']) env.DB.sql.prepare("INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at) VALUES (?, 'g1', 1, 'live', 'u_p', 'player', ?, ?)").run(id, T0, T0);
  for (const id of ['ps1', 'ps2', 'ps3']) await checkIn(env, S, id, 'u_p', 0, T0 + 1000);
  for (let i = 1; i <= 4; i++) for (const [j, id] of ['ps1', 'ps2', 'ps3'].entries()) await checkIn(env, S, id, 'u_p', 15000, T0 + 1000 + i * 15000 + j * 100);
  const total = row(env, "SELECT SUM(seconds) AS s FROM plays").s;
  assert.ok(total <= 61, `three tabs for one minute credited ${total} s`);
  assert.equal(row(env, "SELECT plays FROM projects WHERE id = 'g1'").plays, 1, 'and count one play, not three');
  assert.equal(row(env, "SELECT seconds FROM projects WHERE id = 'g1'").seconds, total);
});

test('a player adds at most one counted play per game an hour, however many sessions they start', async () => {
  const env = setup();
  const run = async (id, start) => {
    if (id !== 'ps1') env.DB.sql.prepare("INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at) VALUES (?, 'g1', 1, 'live', 'u_p', 'player', ?, ?)").run(id, start, start);
    else env.DB.sql.prepare("UPDATE plays SET started_at = ?, last_beat_at = ? WHERE id = 'ps1'").run(start, start);
    await checkIn(env, S, id, 'u_p', 0, start + 1000);
    for (let i = 1; i <= 3; i++) await checkIn(env, S, id, 'u_p', 15000, start + 1000 + i * 15000);
  };
  await run('ps1', T0);
  await run('ps2', T0 + 120_000);
  await run('ps3', T0 + 240_000);
  assert.equal(row(env, "SELECT plays FROM projects WHERE id = 'g1'").plays, 1);
  assert.equal(row(env, "SELECT seconds FROM projects WHERE id = 'g1'").seconds, 135, 'their play time still counts');
  await run('ps4', T0 + 3700_000);
  assert.equal(row(env, "SELECT plays FROM projects WHERE id = 'g1'").plays, 2, 'an hour later it counts again');
});

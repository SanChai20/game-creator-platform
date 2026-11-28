// Daily and weekly challenges (src/challenges.js): which game is picked and that it holds for the day, the seed, the
// day's board (that day, that board, best per player), streaks, the weekly goal, and an admin's pick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { challengesView, dailyFor, dayOf, ensureDaily, ensureWeekly, recordPlay, recordScore, seedOf, setDaily, streakOf, weekOf } from '../src/challenges.js';

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
  return { prepare: (q) => stmt(q), batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; }, sql };
}
const T = Date.parse('2027-03-10T12:00:00Z'), D = 86400_000;
function world() {
  const db = d1(), q = (s, ...a) => db.sql.prepare(s).run(...a);
  q("INSERT INTO users (id, email, name, pw_hash, status, created_at) VALUES ('u_c', 'c@x', 'Maker', '', 'active', 1)");
  const game = (id, extra = {}) => q('INSERT INTO projects (id, owner_id, slug, title, status, live_version, price_cents, age, plays, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 1, 1)', id, 'u_c', id, 'Game ' + id, extra.status || 'live', extra.price || 0, extra.age ?? null, extra.plays ?? 10);
  game('g1', { plays: 100 }); game('g2', { plays: 50 }); game('paid', { price: 500, plays: 999 }); game('adult', { age: 18, plays: 999 }); game('few', { plays: 999 });
  const board = (pid, b, asc, n) => { q('INSERT INTO boards (project_id, board, asc, created_at) VALUES (?, ?, ?, 1)', pid, b, asc); for (let i = 0; i < n; i++) q('INSERT INTO scores (project_id, board, user_id, name, score, updated_at) VALUES (?, ?, ?, ?, ?, ?)', pid, b, `${pid}-${b}-${i}`, 'p', i, T - D); };
  board('g1', 'default', 0, 5); board('g1', 'time', 1, 3); board('g2', 'default', 0, 4); board('paid', 'default', 0, 9); board('adult', 'default', 0, 9); board('few', 'default', 0, 2);
  return { db, q };
}

test('the daily pick: a free, live, safe game with a busy board, fixed for the day', async () => {
  const { db } = world();
  const c = await ensureDaily(db, T);
  assert.ok(['g1', 'g2'].includes(c.project_id), c.project_id);
  if (c.project_id === 'g1') assert.equal(c.board, 'default');   // its busiest board
  assert.equal(c.seed, seedOf(dayOf(T), c.project_id));
  assert.deepEqual(await ensureDaily(db, T + 3600_000), c);
  // the next day picks again, never the same game within 14 days
  const next = await ensureDaily(db, T + D);
  assert.notEqual(next.project_id, c.project_id);
  assert.equal(await ensureDaily(db, T + 2 * D), null);   // both used: nothing qualifies
});

test('the seed is the same for every player of a game on a day, and differs by game and day', async () => {
  assert.equal(seedOf('2027-03-10', 'g1'), seedOf('2027-03-10', 'g1'));
  assert.notEqual(seedOf('2027-03-10', 'g1'), seedOf('2027-03-11', 'g1'));
  assert.notEqual(seedOf('2027-03-10', 'g1'), seedOf('2027-03-10', 'g2'));
  assert.match(seedOf('2027-03-10', 'g1'), /^[0-9a-f]{16}$/);
  const { db } = world();
  await setDaily(db, dayOf(T), 'g1', 'time', 'u_admin', T);
  assert.deepEqual(await dailyFor(db, 'g1', T), { day: dayOf(T), seed: seedOf(dayOf(T), 'g1'), challenge: true, board: 'time', ends_at: Date.parse('2027-03-11T00:00:00Z') });
  assert.equal((await dailyFor(db, 'g2', T)).challenge, false);
});

test("the day's board: that board, that day, best per player (lower wins when the board says so)", async () => {
  const { db } = world();
  await setDaily(db, dayOf(T), 'g1', 'time', 'u_admin', T);
  assert.equal(await recordScore(db, 'g1', 'default', 'u_a', 'A', 10, T), false);
  assert.equal(await recordScore(db, 'g2', 'time', 'u_a', 'A', 10, T), false);
  await recordScore(db, 'g1', 'time', 'u_a', 'A', 50, T);
  await recordScore(db, 'g1', 'time', 'u_a', 'A', 40, T + 1);
  await recordScore(db, 'g1', 'time', 'u_a', 'A', 60, T + 2);
  await recordScore(db, 'g1', 'time', 'u_b', 'B', 45, T + 3);
  await recordScore(db, 'g1', 'time', 'u_c', 'C', 40, T + 4);   // ties go to the earlier score
  const v = await challengesView(db, 'u_b', T + 5);
  assert.deepEqual(v.daily.top.map((r) => [r.rank, r.name, r.score]), [[1, 'A', 40], [2, 'C', 40], [3, 'B', 45]]);
  assert.deepEqual(v.daily.mine, { score: 45, rank: 3 });
  assert.equal(v.daily.players, 3); assert.equal(v.daily.lower_wins, true);
  // tomorrow's board starts empty
  await setDaily(db, dayOf(T + D), 'g1', 'time', 'u_admin', T);
  assert.equal((await challengesView(db, 'u_b', T + D)).daily.players, 0);
  await assert.rejects(setDaily(db, dayOf(T - D), 'g1', 'time', 'u_admin', T), /today or a later day/);
  await assert.rejects(setDaily(db, dayOf(T), 'paid', 'default', 'u_admin', T), /free, live/);
});

test('streaks: days in a row on the challenge game', async () => {
  const { db } = world();
  for (let i = 0; i < 4; i++) await setDaily(db, dayOf(T + i * D), 'g1', 'default', 'u_admin', T);
  assert.equal(await recordPlay(db, 'g2', 'u_a', T), null);
  await recordPlay(db, 'g1', 'u_a', T); await recordPlay(db, 'g1', 'u_a', T + 1000);
  assert.deepEqual(await streakOf(db, 'u_a', T), { streak: 1, best: 1, days: 1, played_today: true });
  await recordPlay(db, 'g1', 'u_a', T + D);
  assert.deepEqual(await streakOf(db, 'u_a', T + D), { streak: 2, best: 2, days: 2, played_today: true });
  assert.deepEqual(await streakOf(db, 'u_a', T + 2 * D), { streak: 2, best: 2, days: 2, played_today: false });   // still alive today
  await recordPlay(db, 'g1', 'u_a', T + 3 * D);   // missed a day
  assert.deepEqual(await streakOf(db, 'u_a', T + 3 * D), { streak: 1, best: 2, days: 3, played_today: true });
  assert.deepEqual(await streakOf(db, 'u_nobody', T), { streak: 0, best: 0, days: 0, played_today: false });
});

test('the weekly goal: a played, free game, half again last week, progress from this week', async () => {
  const { db, q } = world();
  const wk = weekOf(T);
  assert.equal(wk, '2027-03-08');
  assert.equal(await ensureWeekly(db, T), null);
  q("INSERT INTO game_daily (project_id, day, seconds) VALUES ('g2', ?, 60000)", dayOf(T - 7 * D));   // 1000 min last week
  q("INSERT INTO game_daily (project_id, day, seconds) VALUES ('paid', ?, 999999)", dayOf(T - D));
  q("INSERT INTO game_daily (project_id, day, seconds) VALUES ('g2', ?, 6000)", dayOf(T));             // 100 min this week
  const w = await ensureWeekly(db, T);
  assert.deepEqual([w.project_id, w.goal_minutes], ['g2', 1500]);
  const v = await challengesView(db, null, T);
  assert.notEqual(v.daily?.game.id, 'g2');   // the daily challenge leaves the week's game to the weekly goal
  assert.deepEqual([v.weekly.minutes, v.weekly.goal_minutes, v.weekly.game.id], [100, 1500, 'g2']);
  assert.equal(v.weekly.ends_at, Date.parse('2027-03-15T00:00:00Z'));
});

// The store's rankings run by themselves (src/rankings.ts). Proves: the trending score weights recent days over older
// ones and a little toward well-rated games, and drops games that are not live; today's picks are chosen once a day,
// with a slot each for trending, rising, new, a hidden gem and a free game, leave out adults-only games, rotate away
// from games picked in the last days, and stay put for the rest of the day; the home page reads them in order; each
// job records its last run and its error. Real migrations, in-memory SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { trendStmt, choosePicks, ensurePicks, currentPicks, oldPicksStmt, runJob, growth } = await import('../src/rankings.ts');

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

const T = Date.parse('2026-11-19T12:00:00Z'), DAY = 86400000;
const day = (n) => new Date(T - n * DAY).toISOString().slice(0, 10);
function seed(db) {
  db.sql.exec("INSERT INTO users (id, email, name, pw_hash, created_at) VALUES ('u1', 'a@x', 'Ann', 'x', 0)");
}
let n = 0;
function game(db, o = {}) {
  const id = o.id || 'g' + ++n;
  db.sql.prepare(`INSERT INTO projects (id, owner_id, slug, title, status, price_cents, featured, plays, rating_sum, rating_count, mature, created_at, updated_at, published_at, shelf, hidden_at, eng_players, eng_avg_s, eng_quit, eng_return)
    VALUES (?, 'u1', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`).run(id, id, id.toUpperCase(), o.status || 'live', o.price ?? 0, o.featured ? 1 : 0, o.plays ?? 10, o.rsum ?? 0, o.rcount ?? 0, o.mature || '', o.published ?? T - 60 * DAY,
    o.shelf || 'main', o.hidden ?? null, o.eng?.players ?? 0, o.eng?.avg_s ?? 0, o.eng?.quit ?? 0, o.eng?.ret ?? 0);
  for (const [ago, plays, seconds] of o.days || []) db.sql.prepare('INSERT INTO game_daily (project_id, day, sessions, plays, seconds) VALUES (?, ?, ?, ?, ?)').run(id, day(ago), plays, plays, seconds);
  return id;
}
const recent = (db, id) => db.sql.prepare('SELECT recent FROM projects WHERE id = ?').get(id).recent;

test('trending: recent days count more than older ones, ratings nudge, non-live games get 0', async () => {
  const db = d1(); seed(db);
  const now = game(db, { days: [[0, 10, 600]] });           // 10 plays and 10 minutes today
  const old = game(db, { days: [[8, 10, 600]] });           // the same, eight days ago
  const gone = game(db, { days: [[15, 100, 6000]] });       // outside the 14 days
  const loved = game(db, { days: [[0, 10, 600]], rsum: 50, rcount: 10 });
  const hated = game(db, { days: [[0, 10, 600]], rsum: 10, rcount: 10 });
  const off = game(db, { status: 'offline', days: [[0, 10, 600]] });
  db.sql.exec(`UPDATE projects SET recent = 999 WHERE id = '${off}'`);
  await trendStmt(db, T).run();
  // today: (10 plays * 2 + 10 minutes) * 1, times 0.8 (too few players to judge engagement) and 0.95 (no ratings: the 3.5 prior)
  assert.equal(recent(db, now), Math.round(30 * 0.8 * 0.95));
  assert.equal(recent(db, old), Math.round(30 * (2 / 10) * 0.8 * 0.95));
  assert.equal(recent(db, gone), 0);
  assert.ok(recent(db, loved) > recent(db, now) && recent(db, now) > recent(db, hated));
  assert.equal(recent(db, off), 0);
});

test('trending: play time and how players stick with a game move it, not play count alone', async () => {
  const db = d1(); seed(db);
  // the same plays and minutes today; players stay long and come back, or leave at once
  const sticky = game(db, { days: [[0, 10, 1200]], eng: { players: 20, avg_s: 600, quit: 10, ret: 40 } });
  const leave = game(db, { days: [[0, 10, 1200]], eng: { players: 20, avg_s: 40, quit: 80, ret: 0 } });
  const unknown = game(db, { days: [[0, 10, 1200]], eng: { players: 3, avg_s: 40, quit: 80, ret: 0 } });
  // many opens, little play beats nothing: but less than fewer opens with long play
  const spammy = game(db, { days: [[0, 25, 300]] });   // 25 * 2 + 5 = 55
  const long = game(db, { days: [[0, 5, 3000]] });      // 5 * 2 + 50 = 60 (it was 75 against 70 the other way)
  await trendStmt(db, T).run();
  assert.equal(recent(db, sticky), Math.round(40 * ((0.5 + 0.5 + 0.2) * 0.95) * 0.95));
  assert.equal(recent(db, leave), Math.round(40 * ((0.5 + 0.5 * 40 / 600) * 0.6) * 0.95));
  assert.equal(recent(db, unknown), Math.round(40 * 0.8 * 0.95), 'under 5 players: neutral');
  assert.ok(recent(db, sticky) > recent(db, unknown) && recent(db, unknown) > recent(db, leave));
  assert.ok(recent(db, long) > recent(db, spammy), 'minutes played weigh more than opens');
});

test('trending: a score or an ending is an optional signal that lifts a game a little', async () => {
  const db = d1(); seed(db);
  const sandbox = game(db, { days: [[0, 100, 6000]] });
  const scored = game(db, { days: [[0, 100, 6000]] });
  db.sql.exec(`UPDATE projects SET eng_outcome = 1 WHERE id = '${scored}'`);
  await trendStmt(db, T).run();
  assert.equal(recent(db, sandbox), Math.round(300 * 0.8 * 0.95), 'no penalty without one');
  assert.equal(recent(db, scored), Math.round(300 * 0.8 * 1.05 * 0.95));
});

const C = (id, o = {}) => ({ id, featured: 0, price_cents: 0, recent: 0, plays: 10, rating_sum: 0, rating_count: 0, published_at: 0, last3: 0, prior7: 0, ...o });

test('choosePicks: one slot per kind, featured first, then filled from trending', () => {
  const trending = Array.from({ length: 10 }, (_, i) => C('t' + i, { recent: 100 - i, plays: 1000 - i * 50, price_cents: 499 }));
  const rising = C('r', { recent: 20, last3: 300, prior7: 10, price_cents: 499 });
  const fresh = C('n', { recent: 5, published_at: T, price_cents: 499 });
  const gem = C('gem', { plays: 3, rating_sum: 48, rating_count: 10, price_cents: 499 });
  const free = C('f', { price_cents: 0 });
  const picks = choosePicks({ featured: [C('feat', { featured: 1 })], trending: [...trending, rising], fresh: [fresh], rated: [gem], free: [free] }, new Set(), '2026-11-19');
  assert.equal(picks.length, 6);
  assert.deepEqual(picks.map((p) => p.reason), ['featured', 'trending', 'rising', 'new', 'gem', 'free']);
  assert.equal(picks[0].id, 'feat');
  assert.ok(['t0', 't1', 't2'].includes(picks[1].id), 'trending comes from the top three');
  assert.deepEqual(picks.slice(2).map((p) => p.id), ['r', 'n', 'gem', 'f']);
  assert.equal(new Set(picks.map((p) => p.id)).size, 6, 'no game twice');
});

test('choosePicks: skips games picked lately while there are others, and varies by day', () => {
  const trending = Array.from({ length: 8 }, (_, i) => C('t' + i, { recent: 100 - i }));
  const lists = { featured: [], trending, fresh: [], rated: [], free: [] };
  const seen = new Set(['t0', 't1', 't2']);
  const p = choosePicks(lists, seen, '2026-11-19');
  assert.ok(!seen.has(p[0].id), 'the trending slot passes over recent picks');
  const days = new Set(Array.from({ length: 10 }, (_, i) => choosePicks(lists, new Set(), `2026-11-${10 + i}`)[0].id));
  assert.ok(days.size > 1, 'the lead changes from day to day');
  // a small catalogue: every game, recently picked or not, still fills the lead
  assert.equal(choosePicks({ ...lists, trending: trending.slice(0, 3) }, new Set(['t0', 't1', 't2']), '2026-11-19').length, 3);
});

test('rising needs real recent activity', () => {
  assert.ok(growth(C('a', { last3: 300, prior7: 0 })) > 1.5);
  const p = choosePicks({ featured: [], trending: [C('quiet', { last3: 2, prior7: 0 })], fresh: [], rated: [], free: [] }, new Set(), '2026-11-19');
  assert.deepEqual(p.map((x) => x.reason), ['trending']);
});

test('ensurePicks: chosen once a day, adults-only games left out, the home page reads them in order', async () => {
  const db = d1(); seed(db);
  for (let i = 0; i < 8; i++) game(db, { id: 'p' + i, price: 499, days: [[0, 20 - i, 600]] });
  game(db, { id: 'adult', price: 499, mature: 'sexual', days: [[0, 500, 60000]] });
  game(db, { id: 'freebie', days: [[1, 2, 60]] });
  // the New shelf and games hidden by reports never lead the store front
  game(db, { id: 'newbie', price: 499, shelf: 'new', days: [[0, 400, 60000]] });
  game(db, { id: 'reported', price: 499, hidden: T - DAY, days: [[0, 400, 60000]] });
  await trendStmt(db, T).run();
  const env = { DB: db };
  assert.equal(await ensurePicks(env, T), 6);
  assert.equal(await ensurePicks(env, T + 3600000), 0, 'the same day: nothing changes');
  const rows = await currentPicks(db, T + 3600000);
  assert.equal(rows.length, 6);
  assert.ok(!rows.some((r) => r.id === 'adult'));
  assert.ok(!rows.some((r) => r.id === 'newbie' || r.id === 'reported'));
  assert.ok(rows.some((r) => r.id === 'freebie' && r.pick === 'free'));
  assert.equal(rows[0].author, 'Ann');
  // a picked game that goes offline drops out of the lead at once
  db.sql.exec(`UPDATE projects SET status = 'offline' WHERE id = '${rows[1].id}'`);
  assert.equal((await currentPicks(db, T)).length, 5);
  // the next day: new picks, rotated away from yesterday's where the catalogue allows
  assert.equal(await ensurePicks(env, T + DAY), 6);
  const next = await currentPicks(db, T + DAY);
  assert.ok(next.some((r) => !rows.some((x) => x.id === r.id)));
  // before the day's picks exist, yesterday's still show
  db.sql.exec(`DELETE FROM daily_picks WHERE day = '${day(-1)}'`);
  assert.equal((await currentPicks(db, T + DAY)).length, 5);
  // the daily cleanup keeps a month
  await oldPicksStmt(db, T + 31 * DAY).run();
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM daily_picks').get().n, 0);
});

test('ensurePicks: an empty store picks nothing', async () => {
  const db = d1(); seed(db);
  assert.equal(await ensurePicks({ DB: db }, T), 0);
  assert.deepEqual(await currentPicks(db, T), []);
});

test('runJob records the last run, the last success and the last error, and never throws', async () => {
  const db = d1(), env = { DB: db }, err = console.error;
  await runJob(env, 'x', async () => {});
  console.error = () => {};
  try { await runJob(env, 'x', async () => { throw new Error('boom'); }); } finally { console.error = err; }
  const r = db.sql.prepare("SELECT * FROM job_runs WHERE job = 'x'").get();
  assert.equal(r.runs, 2);
  assert.equal(r.last_error, 'boom');
  assert.ok(r.last_ok_at && r.last_error_at >= r.last_ok_at);
});

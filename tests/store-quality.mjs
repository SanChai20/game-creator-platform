// Store quality (src/store-quality.ts): the weekly cap on new games, the New shelf and its graduation, the ranking that
// tunes itself to the store, and player reports that hide a game by themselves and let it back with a new version.
// Real migrations, in-memory SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const Q = await import('../src/store-quality.ts');
const { SETTING_DEFS } = await import('../src/settings.ts');
const { RULES } = await import('../src/release-gate.ts');
const S = Object.fromEntries(Object.entries(SETTING_DEFS).map(([k, d]) => [k, d.v]));

function d1() {
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(f, dir), 'utf8'));
  const stmt = (q, args = []) => ({
    q, bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  const batch = async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; };
  return { prepare: (q) => stmt(q), batch, sql };
}
const T = Date.parse('2026-11-23T12:00:00Z'), DAY = 86400000;
function world() {
  const db = d1();
  db.sql.exec("INSERT INTO users (id, email, name, pw_hash, created_at) VALUES ('u1', 'a@x', 'Ann', 'x', 0), ('adm', 'b@x', 'Bo', 'x', 0)");
  db.sql.exec("UPDATE users SET role = 'admin' WHERE id = 'adm'");
  return { db, env: { DB: db } };
}
let n = 0;
function game(db, o = {}) {
  const id = o.id || 'g' + ++n;
  db.sql.prepare(`INSERT INTO projects (id, owner_id, slug, title, status, rating_sum, rating_count, created_at, updated_at, published_at, live_version, shelf)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`).run(id, o.owner || 'u1', id, id, o.status || 'live', o.rsum ?? 0, o.rcount ?? 0, o.published === undefined ? T - 30 * DAY : o.published, o.live ?? 1, o.shelf || 'new');
  return id;
}
const row = (db, id) => db.sql.prepare('SELECT * FROM projects WHERE id = ?').get(id);
function players(db, id, list) {   // [seconds, sessions, days between first and last]
  list.forEach(([sec, ses, days], i) => db.sql.prepare('INSERT INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds) VALUES (?, ?, ?, ?, ?, ?)').run(id, `p${i}`, T - 5 * DAY, T - 5 * DAY + days * DAY, ses, sec));
}

test('the weekly cap: a few new games a week, more for well-rated games, never for updates or admins', async () => {
  const { db, env } = world();
  assert.equal(Q.capFor(S, 0), 3); assert.equal(Q.capFor(S, 4), 7); assert.equal(Q.capFor(S, 50), 10);
  assert.equal(Q.capFor({ ...S, publish_cap_base: 0 }, 0), Infinity, '0 turns the cap off');
  for (let i = 0; i < 3; i++) game(db, { published: T - (i + 1) * DAY });
  const fresh = game(db, { published: null, status: 'draft', live: null });
  const gate = await Q.capGate(env, S, row(db, fresh), 'user', T);
  assert.ok(gate && /3 new games live in the last 7 days/.test(gate.reason), gate?.reason);
  assert.match(gate.fix, /after 2026-11-27 12:00 UTC/, 'the oldest of the three drops out of the window then');
  assert.equal(await Q.capGate(env, S, row(db, fresh), 'admin', T), null, 'admins are not capped');
  const live = game(db, { published: T - 20 * DAY });
  assert.equal(await Q.capGate(env, S, row(db, live), 'user', T), null, 'an update to a game that was live before is never capped');
  // one well-rated live game (5 ratings averaging 5 stars) lifts the cap to 4
  game(db, { published: T - 60 * DAY, rsum: 25, rcount: 5 });
  assert.equal(await Q.capGate(env, S, row(db, fresh), 'user', T), null);
  const cap = await Q.publishCap(env, S, 'u1', fresh, T);
  assert.equal(cap.cap, 4); assert.equal(cap.good, 1);
  assert.ok(RULES.some((r) => r.id === 'publish_cap' && r.waivable && r.modes.join() === 'publish'));
});

test('engagement is measured from players, the creator left out, and New shelf games graduate by themselves', async () => {
  const { db, env } = world();
  const good = game(db, { rsum: 16, rcount: 4 }), bad = game(db, { rsum: 16, rcount: 4 }), old = game(db, { shelf: 'main' });
  players(db, good, Array.from({ length: 16 }, (_, i) => [300, i < 4 ? 3 : 1, i < 4 ? 2 : 0]));
  players(db, bad, Array.from({ length: 16 }, () => [20, 1, 0]));
  db.sql.prepare("INSERT INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds) VALUES (?, 'u1', 0, 0, 1, 99999)").run(good);   // the creator
  db.sql.prepare('INSERT INTO game_daily (project_id, day, sessions, plays, seconds) VALUES (?, ?, 1, 1, 60)').run(old, '2026-11-23');
  players(db, old, [[100, 1, 0]]);
  await Q.engagementStmt(db, T).run();
  const g = row(db, good), b = row(db, bad);
  assert.deepEqual([g.eng_players, g.eng_avg_s, g.eng_quit, g.eng_return], [16, 300, 0, 25]);
  assert.deepEqual([b.eng_players, b.eng_quit], [16, 100]);
  assert.equal(row(db, old).eng_players, 1, 'main-shelf games played since yesterday are refreshed too');
  const moved = await Q.graduate(env, S, T);
  assert.deepEqual(moved, [good]);
  assert.equal(row(db, good).shelf, 'main'); assert.equal(row(db, bad).shelf, 'new');
  const left = Q.graduation(S, b).needs.filter((x) => !x.ok).map((x) => x.id);
  assert.deepEqual(left, ['minutes', 'quit']);
  assert.match(Q.needText(Q.graduation(S, b).needs[1]), /at least 2 min \(now 0.3 min\)/);
});

test('shelves: the main store, the New shelf, search shows both, hidden games never', () => {
  assert.equal(Q.shelfWhere('main', true), "p.hidden_at IS NULL AND p.shelf = 'main'");
  assert.equal(Q.shelfWhere('new', true), "p.hidden_at IS NULL AND p.shelf = 'new'");
  assert.equal(Q.shelfWhere('all', true), 'p.hidden_at IS NULL');
  assert.equal(Q.shelfWhere('main', false), 'p.hidden_at IS NULL', 'New shelf off: every visible game is on the main store');
  assert.equal(Q.shelfWhere('new', false), '0');
});

test('the ranking tunes itself to the store once enough games have players', async () => {
  const { db } = world();
  const get = () => Object.fromEntries(db.sql.prepare('SELECT key, value FROM store_tuning').all().map((r) => [r.key, r.value]));
  for (let i = 0; i < 9; i++) db.sql.prepare("UPDATE projects SET eng_players = 10, eng_avg_s = ?, eng_return = ? WHERE id = ?").run(200, 15, game(db));
  await db.batch(Q.tuneStmts(db, T));
  assert.deepEqual(get(), {}, 'nine games: the defaults stay');
  for (let i = 0; i < 3; i++) db.sql.prepare("UPDATE projects SET eng_players = 10, eng_avg_s = ?, eng_return = ? WHERE id = ?").run(900, 60, game(db));
  await db.batch(Q.tuneStmts(db, T));
  assert.deepEqual(get(), { time_scale_s: 400, return_scale: 30 }, 'twice the median time per player and returning share');
  const f = (g) => db.sql.prepare(`SELECT ${Q.engagementFactor('p')} AS f FROM projects p WHERE id = ?`).get(g).f;
  const id = game(db); db.sql.prepare('UPDATE projects SET eng_players = 10, eng_avg_s = 400, eng_return = 30, eng_quit = 0 WHERE id = ?').run(id);
  assert.equal(f(id), 1.5, 'a game twice as engaging as the typical one gets the full lift');
  assert.equal(Q.engagementOf({ eng_players: 10, eng_avg_s: 400, eng_return: 30, eng_quit: 0 }, { time_s: 400, ret: 30 }), 1.5);
});

test('reports: only open reports from different players count, they hide a game by themselves, a new version brings it back', async () => {
  const { db, env } = world();
  assert.equal(Q.hideThreshold(S, 10), 5); assert.equal(Q.hideThreshold(S, 120), 12); assert.equal(Q.hideThreshold(S, 100000), 25);
  assert.equal(Q.hideThreshold({ ...S, report_hide_min: 0 }, 10), Infinity);
  const id = game(db, { live: 3 }), p = row(db, id);
  players(db, id, Array.from({ length: 20 }, () => [100, 1, 0]));
  for (let i = 0; i < 4; i++) assert.equal((await Q.fileReport(env, S, p, 'p' + i, 'low_effort', '', T)).hidden, false);
  await Q.fileReport(env, S, p, 'p0', 'broken', 'again', T);   // the same player again replaces their report
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM game_reports').get().n, 4);
  const r = await Q.fileReport(env, S, p, 'p9', 'broken', '', T);
  assert.deepEqual(r, { ok: true, open: 5, threshold: 5, hidden: true });
  assert.equal(row(db, id).hidden_reason, 'reports');
  assert.equal((await Q.reportQueue(env, S))[0].reasons.broken, 2);
  // the creator fixes it: version 4 goes live, the reports about version 3 are superseded, and it is back
  await db.batch(Q.reviveStmts(db, id, 4, T + DAY));
  assert.equal(row(db, id).hidden_at, null);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM game_reports WHERE status = 'superseded'").get().n, 5);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'reports_superseded'").get().n, 1);
  // a player can report the new version again
  await Q.fileReport(env, S, { ...p, live_version: 4 }, 'p1', 'broken', '', T + 2 * DAY);
  assert.equal(db.sql.prepare("SELECT status FROM game_reports WHERE user_id = 'p1'").get().status, 'open');
  // an admin may still decide (optional): uphold keeps it hidden, and a new version does not bring back what an admin hid
  await Q.reviewReports(env, 'adm', row(db, id), 'hide', T + 3 * DAY);
  await db.batch(Q.reviveStmts(db, id, 5, T + 4 * DAY));
  assert.equal(row(db, id).hidden_reason, 'admin');
  await Q.reviewReports(env, 'adm', row(db, id), 'unhide', T + 5 * DAY);
  assert.equal(row(db, id).hidden_at, null);
});

test('the creator and their agent are told where the game stands', async () => {
  const { db, env } = world();
  const id = game(db, { published: null, status: 'draft', live: null });
  const st = await Q.storeStatus(env, S, row(db, id));
  assert.equal(st.shelf, 'new'); assert.equal(st.new_game_cap.cap, 3);
  const text = Q.storeText(st, false);
  assert.match(text, /Once live it starts on the New shelf/); assert.match(text, /0 of 3/);
});

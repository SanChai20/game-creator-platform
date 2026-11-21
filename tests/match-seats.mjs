// Coming back to a running match (src/match-seats.js): which match a player is handed a new ticket for after a reload.
// Proves: a player gets back only into the match they were last put in, only while it runs, only in the same game and
// environment; nobody gets into someone else's match; and the lookup reads by key, not through the match log.
// Real migrations, in-memory SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MATCH_MAX_AGE_MS, currentMatch, oldSeatsStmt, seatStmts } from '../src/match-seats.js';
import { LIMITS } from '../src/runtime/match-core.js';

function d1() {
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(f, dir), 'utf8'));
  const stmt = (q, args = []) => ({
    q, args, bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  const batch = async (list) => { sql.exec('BEGIN'); try { const out = []; for (const s of list) out.push(await s.run()); sql.exec('COMMIT'); return out; } catch (e) { sql.exec('ROLLBACK'); throw e; } };
  return { prepare: (q) => stmt(q), batch, sql };
}
const T = 1_800_000_000_000;
/** What the matchmaker does when it starts a match (src/matchmaker.ts launch): the match and every player's seat, as one batch. */
async function launch(db, id, players, { g = 'gamea1', e = 'live', queue = 'ranked', mode = '', t = T } = {}) {
  const roster = players.map((u, i) => ({ id: u, name: u.toUpperCase(), team: null, rating: 1000 + i, k: 'player' }));
  await db.batch([
    db.prepare('INSERT INTO matches (id, project_id, env, queue, mode, roster, region, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, g, e, queue, mode, JSON.stringify(roster), 'weur', t),
    ...seatStmts(db, g, e, players, id, t),
  ]);
}
const tok = (u, o = {}) => ({ g: 'gamea1', e: 'live', u, ...o });

test('a player is led back into the match they were last put in, while it runs', async () => {
  const db = d1();
  assert.equal(await currentMatch(db, tok('u_a'), T), null, 'never matched: nothing to go back to');
  await launch(db, 'aaaa1111aaaa1111aaaa1111', ['u_a', 'u_b'], { mode: 'hard' });
  const m = await currentMatch(db, tok('u_a'), T + 5 * 60_000);
  assert.deepEqual(m, { id: 'aaaa1111aaaa1111aaaa1111', queue: 'ranked', mode: 'hard', region: 'weur', started: T,
    roster: [{ id: 'u_a', name: 'U_A', team: null }, { id: 'u_b', name: 'U_B', team: null }] });
  assert.equal((await currentMatch(db, tok('u_b'), T + 1000)).id, m.id);
  // the roster a ticket carries holds what the game needs and nothing else (no ratings, no session kinds)
  assert.deepEqual(Object.keys(m.roster[0]), ['id', 'name', 'team']);
  // a new match replaces the seat: the old one is never offered again, even though it has not reported its end
  await launch(db, 'bbbb2222bbbb2222bbbb2222', ['u_a', 'u_c'], { t: T + 10 * 60_000 });
  assert.equal((await currentMatch(db, tok('u_a'), T + 11 * 60_000)).id, 'bbbb2222bbbb2222bbbb2222');
  assert.equal((await currentMatch(db, tok('u_b'), T + 11 * 60_000)).id, 'aaaa1111aaaa1111aaaa1111', 'the other player of the first match still has theirs');
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM match_seats').get().n, 3, 'one seat per player and game');
});

test('a match that is over, too old, or of another game or environment is never offered', async () => {
  const db = d1();
  await launch(db, 'aaaa1111aaaa1111aaaa1111', ['u_a', 'u_b']);
  assert.ok(MATCH_MAX_AGE_MS > LIMITS.maxDurationMs + LIMITS.startWaitMs * 2, 'the window covers the longest match there can be');
  assert.ok(await currentMatch(db, tok('u_a'), T + LIMITS.maxDurationMs));
  assert.equal(await currentMatch(db, tok('u_a'), T + MATCH_MAX_AGE_MS + 1), null, 'older than a match can last: it ended without saying so');
  // the same player in the preview, or in another game: their seat here is not a way in there
  assert.equal(await currentMatch(db, tok('u_a', { e: 'preview' }), T), null);
  assert.equal(await currentMatch(db, tok('u_a', { g: 'gameb2' }), T), null);
  // the match reported its result (src/routes/rt.ts match-result)
  db.sql.prepare("UPDATE matches SET ended_at = ?, result = '{}' WHERE id = 'aaaa1111aaaa1111aaaa1111'").run(T + 60_000);
  assert.equal(await currentMatch(db, tok('u_a'), T + 61_000), null);
  assert.equal(await currentMatch(db, tok('u_b'), T + 61_000), null);
});

test('nobody is handed a ticket for a match they are not in', async () => {
  const db = d1();
  await launch(db, 'aaaa1111aaaa1111aaaa1111', ['u_a', 'u_b']);
  assert.equal(await currentMatch(db, tok('u_zed'), T), null);
  // a seat that names a match whose roster does not list the player (it cannot be written by the matchmaker) leads nowhere
  await db.batch(seatStmts(db, 'gamea1', 'live', ['u_zed'], 'aaaa1111aaaa1111aaaa1111', T));
  assert.equal(await currentMatch(db, tok('u_zed'), T), null);
  // nor one whose match is another game's
  await launch(db, 'cccc3333cccc3333cccc3333', ['u_x'], { g: 'gameb2' });
  await db.batch(seatStmts(db, 'gamea1', 'live', ['u_x'], 'cccc3333cccc3333cccc3333', T));
  assert.equal(await currentMatch(db, tok('u_x'), T), null);
  // a roster that cannot be read is no match
  db.sql.prepare("UPDATE matches SET roster = 'oops' WHERE id = 'aaaa1111aaaa1111aaaa1111'").run();
  assert.equal(await currentMatch(db, tok('u_a'), T), null);
});

test('the lookup reads one seat and one match by key, and old seats are cleaned up', async () => {
  const db = d1();
  const plan = (q, ...a) => db.sql.prepare('EXPLAIN QUERY PLAN ' + q).all(...a).map((r) => r.detail);
  const seat = plan('SELECT match_id FROM match_seats WHERE project_id = ? AND env = ? AND user_id = ?', 'g', 'live', 'u');
  const match = plan('SELECT id, queue, mode, roster, region, created_at, ended_at FROM matches WHERE id = ? AND project_id = ? AND env = ?', 'm', 'g', 'live');
  for (const p of [seat, match]) assert.ok(p.every((d) => /SEARCH/.test(d) && !/SCAN/.test(d)), p.join(' | '));
  await launch(db, 'aaaa1111aaaa1111aaaa1111', ['u_a', 'u_b']);
  await launch(db, 'bbbb2222bbbb2222bbbb2222', ['u_c'], { t: T + 2 * 86400000 });
  await oldSeatsStmt(db, T + 86400000).run();
  assert.deepEqual(db.sql.prepare('SELECT user_id FROM match_seats').all().map((r) => r.user_id), ['u_c']);
  assert.ok(plan('DELETE FROM match_seats WHERE created_at < ?', 0).every((d) => !/SCAN match_seats$/.test(d)), 'the cleanup uses the age index');
});

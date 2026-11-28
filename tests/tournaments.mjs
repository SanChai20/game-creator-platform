// Tournaments (src/tournaments.js): making one (who may, the time limits), signing up, cups scored from rated matches,
// brackets seeded by rating with byes, pairing searches with the bracket opponent, results deciding matches, rounds
// whose time runs out (who showed up, else the better seed), the winner, and cancelling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { cancel, create, join, leave, list, pairingFor, recordMatch, seedOrder, tick, view } from '../src/tournaments.js';

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
const H = 3600000, T0 = 1_000_000_000_000;
function world() {
  const db = d1(), q = (s, ...a) => db.sql.prepare(s).run(...a);
  for (const u of ['own', 'adm', 'p1', 'p2', 'p3', 'p4', 'p5', 'x']) q("INSERT INTO users (id, email, name, pw_hash, status, created_at) VALUES (?, ?, ?, '', 'active', 1)", u, u + '@x', 'N' + u);
  q("INSERT INTO projects (id, owner_id, slug, title, status, live_version, price_cents, created_at, updated_at) VALUES ('g', 'own', 'g', 'Game', 'live', 1, 0, 1, 1)");
  q("INSERT INTO projects (id, owner_id, slug, title, status, live_version, price_cents, created_at, updated_at) VALUES ('d', 'own', 'd', 'Draft', 'draft', 1, 0, 1, 1)");
  // ratings in the duel queue: p1 strongest ... p5 weakest
  [['p1', 1400], ['p2', 1300], ['p3', 1200], ['p4', 1100], ['p5', 1000]].forEach(([u, r]) => q("INSERT INTO match_ratings (project_id, env, queue, user_id, rating, games, wins, updated_at) VALUES ('g', 'live', 'duel', ?, ?, 1, 0, 1)", u, r));
  const game = (id) => db.sql.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return { db, q, game };
}
const code = (e) => (err) => err.code === e;
const own = { id: 'own' }, adm = { id: 'adm', admin: true };

test('who may run one, and the limits', async () => {
  const { db, game } = world();
  const base = { title: 'Spring cup', kind: 'cup', queue: 'duel', starts_at: T0 + H, ends_at: T0 + 25 * H };
  await assert.rejects(create(db, { id: 'x' }, game('g'), base, T0), code('forbidden'));
  await assert.rejects(create(db, own, game('d'), base, T0), code('not_live'));
  await assert.rejects(create(db, own, game('g'), { ...base, starts_at: T0 + 1000 }, T0), code('bad_start'));
  await assert.rejects(create(db, own, game('g'), { ...base, ends_at: T0 + H + 60000 }, T0), code('bad_end'));
  await assert.rejects(create(db, own, game('g'), { ...base, kind: 'bracket', round_minutes: 5 }, T0), code('bad_round'));
  await assert.rejects(create(db, own, game('g'), { ...base, queue: 'Bad Queue' }, T0), code('bad_request'));
  const c = await create(db, own, game('g'), { ...base, official: true }, T0);
  assert.equal(c.slug, 'spring-cup');
  assert.equal((await view(db, c.slug)).official, false);   // only admins make official ones
  const o = await create(db, adm, game('g'), { ...base, title: 'Platform cup', official: true }, T0);
  assert.equal((await view(db, o.id)).official, true);
  for (let i = 0; i < 3; i++) await create(db, own, game('g'), { ...base, title: 'More ' + i }, T0);
  await assert.rejects(create(db, own, game('g'), { ...base, title: 'One too many' }, T0), code('too_many'));
  await assert.rejects(cancel(db, own, o.id, T0), code('forbidden'));
  await cancel(db, own, c.id, T0);
  assert.equal((await view(db, c.id)).status, 'cancelled');
});

test('a cup scores rated matches in its queue between its start and end', async () => {
  const { db, game } = world();
  const c = await create(db, own, game('g'), { title: 'Cup', kind: 'cup', queue: 'duel', starts_at: T0 + H, ends_at: T0 + 3 * H }, T0);
  await join(db, 'p1', c.slug, T0); await join(db, 'p2', c.slug, T0);
  await recordMatch(db, 'g', 'duel', [['p1'], ['p2']], 'm0', T0 + 10);       // before it started: nothing
  await tick(db, T0 + H);
  assert.equal((await view(db, c.slug)).status, 'running');
  await join(db, 'p3', c.slug, T0 + H + 1);                                   // cups take players while they run
  await recordMatch(db, 'g', 'duel', [['p1'], ['p2']], 'm1', T0 + H + 10);
  await recordMatch(db, 'g', 'duel', [['p3'], ['p1']], 'm2', T0 + H + 20);
  await recordMatch(db, 'g', 'other', [['p2'], ['p1']], 'm3', T0 + H + 30);   // another queue: nothing
  const v = await view(db, c.slug, 'p1');
  assert.deepEqual(v.standings.map((s) => [s.id, s.points, s.wins, s.played]), [['p1', 5, 1, 2], ['p3', 4, 1, 1], ['p2', 1, 0, 1]]);
  await assert.rejects(leave(db, 'p1', c.slug, T0 + H + 40), code('started'));
  await tick(db, T0 + 3 * H);
  const done = await view(db, c.slug);
  assert.equal(done.status, 'done'); assert.equal(done.winner.id, 'p1');
  await assert.rejects(join(db, 'p4', c.slug, T0 + 3 * H + 1), code('closed'));
});

test('a bracket: seeded by rating with byes, searches meet the opponent, results and deadlines decide, a winner', async () => {
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  const { db, game, q } = world();
  const b = await create(db, own, game('g'), { title: 'Duel bracket', kind: 'bracket', queue: 'duel', starts_at: T0 + H, round_minutes: 30, max_players: 8 }, T0);
  for (const u of ['p5', 'p3', 'p1', 'p4', 'p2']) await join(db, u, b.slug, T0);
  await leave(db, 'p4', b.slug, T0); await join(db, 'p4', b.slug, T0);
  await assert.rejects(join(db, 'x', b.slug, T0 + H), code('closed'));
  await tick(db, T0 + H);
  let v = await view(db, b.slug, 'p1', T0 + H);
  assert.equal(v.status, 'running'); assert.equal(v.round, 1);
  // 5 players in a bracket of 8: seeds 1-3 get byes; 4 meets 5
  assert.deepEqual(v.rounds[0].map((m) => [m.a?.id || null, m.b?.id || null, m.winner]), [['p1', null, 'p1'], ['p4', 'p5', null], ['p2', null, 'p2'], ['p3', null, 'p3']]);
  assert.equal(v.me.next, undefined);   // p1 waits for round 2
  // the search pairs p4 with p5 only
  assert.equal((await pairingFor(db, 'g', 'duel', 'p4', T0 + H + 5)).opponent, 'p5');
  assert.equal(await pairingFor(db, 'g', 'other', 'p4', T0 + H + 5), null);
  assert.equal(await pairingFor(db, 'g', 'duel', 'p1', T0 + H + 5), null);
  // a draw decides nothing; a win does, and the next round is made
  await recordMatch(db, 'g', 'duel', [['p4', 'p5']], 'm1', T0 + H + 10);
  assert.equal((await view(db, b.slug, 'p4')).rounds[0][1].winner, null);
  await recordMatch(db, 'g', 'duel', [['p5'], ['p4']], 'm2', T0 + H + 20);
  v = await view(db, b.slug, 'p1', T0 + H + 20);
  assert.equal(v.round, 2);
  assert.deepEqual(v.rounds[1].map((m) => [m.a.id, m.b.id]), [['p1', 'p5'], ['p2', 'p3']]);
  assert.equal(v.me.next.opponent.id, 'p5');
  assert.ok(db.sql.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'tournament_match' AND user_id = 'p1'").get().n >= 1);
  // round 2: p1 beats p5; p2 and p3 never play, but p3 searched: p3 goes through when time runs out
  await recordMatch(db, 'g', 'duel', [['p1'], ['p5']], 'm3', T0 + H + 30);
  await pairingFor(db, 'g', 'duel', 'p3', T0 + H + 40);
  await tick(db, T0 + H + 20 + 30 * 60000);
  v = await view(db, b.slug, 'p3');
  assert.equal(v.rounds[1][1].winner, 'p3'); assert.equal(v.rounds[1][1].decided_by, 'no_show');
  assert.equal(v.round, 3);
  // the final runs out with nobody searching: the better seed (p1) wins
  await tick(db, T0 + H + 20 + 61 * 60000);
  v = await view(db, b.slug);
  assert.equal(v.status, 'done'); assert.equal(v.winner.id, 'p1');
  void q;
});

test('a bracket with fewer than 2 players is cancelled; lists show what is on', async () => {
  const { db, game } = world();
  const b = await create(db, own, game('g'), { title: 'Lonely', kind: 'bracket', queue: 'duel', starts_at: T0 + H }, T0);
  await join(db, 'p1', b.slug, T0);
  await tick(db, T0 + H);
  assert.equal((await view(db, b.slug)).status, 'cancelled');
  const c = await create(db, own, game('g'), { title: 'Open cup', kind: 'cup', queue: 'duel', starts_at: T0 + H, ends_at: T0 + 5 * H }, T0);
  const l = await list(db, {}, T0);
  assert.deepEqual(l.map((x) => x.slug), [c.slug]);
  assert.equal(l[0].game.title, 'Game');
  assert.equal((await list(db, { organizer: 'own', all: true }, T0)).length, 2);
});

// Curated collections (src/collections.js): making lists, adding only live games, notes and order, private lists,
// following, staff picks and takedowns, the lists page, and account deletion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { addGame, browse, createCollection, deleteCollection, deleteStatements, follow, listsFor, moderate, removeGame, reorder, staffPicks, updateCollection, view } from '../src/collections.js';

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
function world() {
  const db = d1(), q = (s, ...a) => db.sql.prepare(s).run(...a);
  for (const u of ['u_a', 'u_b', 'u_c']) q("INSERT INTO users (id, email, name, pw_hash, status, created_at) VALUES (?, ?, ?, '', 'active', 1)", u, u + '@x', 'Name ' + u);
  const game = (id, status = 'live', age = null) => q('INSERT INTO projects (id, owner_id, slug, title, status, live_version, price_cents, age, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, 1, 1)', id, 'u_c', id, 'Game ' + id, status, age);
  game('g1'); game('g2'); game('g3'); game('draft', 'draft'); game('adult', 'live', 18);
  return { db, q };
}
const code = (e) => (err) => err.code === e;

test('a list: a title, only live games, notes, order', async () => {
  const { db, q } = world();
  await assert.rejects(createCollection(db, null, { title: 'x' }), code('unauthenticated'));
  await assert.rejects(createCollection(db, 'u_a', { title: '  ' }), code('bad_request'));
  const c = await createCollection(db, 'u_a', { title: 'Best 10-minute puzzlers', description: 'Short and sharp.' });
  assert.equal(c.slug, 'best-10-minute-puzzlers');
  await assert.rejects(addGame(db, 'u_a', c.slug, 'draft'), code('not_found'));
  await assert.rejects(addGame(db, 'u_b', c.slug, 'g1'), code('not_found'));   // not their list
  assert.equal((await addGame(db, 'u_a', c.slug, 'g1', 'A perfect first puzzle.')).added, true);
  await addGame(db, 'u_a', c.slug, 'g2');
  await addGame(db, 'u_a', c.slug, 'g3');
  assert.equal((await addGame(db, 'u_a', c.slug, 'g2', 'Hard but fair.')).added, false);
  let v = await view(db, c.slug, null);
  assert.deepEqual(v.games.map((g) => [g.id, g.note]), [['g1', 'A perfect first puzzle.'], ['g2', 'Hard but fair.'], ['g3', null]]);
  assert.equal(v.games[0].author, 'Name u_c');
  await reorder(db, 'u_a', c.slug, ['g3', 'g1']);
  await removeGame(db, 'u_a', c.slug, 'g2');
  v = await view(db, c.slug, 'u_a');
  assert.deepEqual(v.games.map((g) => g.id), ['g3', 'g1']);
  assert.equal(v.mine, true);
  // a game that goes offline drops out of the list's page
  q("UPDATE projects SET status = 'unpublished' WHERE id = 'g3'");
  assert.deepEqual((await view(db, c.slug, null)).games.map((g) => g.id), ['g1']);
  assert.deepEqual((await listsFor(db, 'u_a', 'g1')).map((l) => [l.slug, l.has]), [[c.slug, true]]);
});

test('private lists, following, staff picks and takedowns', async () => {
  const { db } = world();
  const c = await createCollection(db, 'u_a', { title: 'Cozy', public: false });
  await addGame(db, 'u_a', c.slug, 'g1');
  await assert.rejects(view(db, c.slug, 'u_b'), code('not_found'));
  assert.ok(await view(db, c.slug, 'u_a'));
  await assert.rejects(follow(db, 'u_b', c.slug), code('not_found'));
  await updateCollection(db, 'u_a', c.slug, { public: true });
  await assert.rejects(follow(db, 'u_a', c.slug), code('own'));
  await follow(db, 'u_b', c.slug); await follow(db, 'u_b', c.slug); await follow(db, 'u_c', c.slug);
  let v = await view(db, c.slug, 'u_b');
  assert.equal(v.collection.followers, 2); assert.equal(v.following, true);
  await follow(db, 'u_c', c.slug, false);
  assert.equal((await view(db, c.slug, null)).collection.followers, 1);
  assert.deepEqual((await browse(db, 'u_b')).following.map((x) => x.slug), [c.slug]);
  assert.deepEqual(await staffPicks(db), []);
  await moderate(db, c.slug, { staff_pick: true });
  assert.deepEqual((await staffPicks(db)).map((x) => x.slug), [c.slug]);
  await moderate(db, c.slug, { hidden: true });
  await assert.rejects(view(db, c.slug, 'u_b'), code('not_found'));
  assert.equal((await view(db, c.slug, 'u_a')).collection.hidden, true);
  assert.deepEqual(await staffPicks(db), []);
});

test('the lists page leaves out empty lists, and the cover strip leaves out adult-only games', async () => {
  const { db } = world();
  const empty = await createCollection(db, 'u_a', { title: 'Empty' });
  const full = await createCollection(db, 'u_b', { title: 'Full' });
  await addGame(db, 'u_b', full.slug, 'adult'); await addGame(db, 'u_b', full.slug, 'g2');
  const b = await browse(db, 'u_a');
  assert.deepEqual(b.popular.map((x) => x.slug), [full.slug]);
  assert.deepEqual(b.mine.map((x) => x.slug), [empty.slug]);
  assert.deepEqual(b.popular[0].covers.map((x) => x.id), ['g2']);
  assert.equal(b.popular[0].games, 2);
});

test('deleting a list or an account', async () => {
  const { db } = world();
  const a = await createCollection(db, 'u_a', { title: 'Mine' });
  const b = await createCollection(db, 'u_b', { title: 'Theirs' });
  await addGame(db, 'u_a', a.slug, 'g1'); await addGame(db, 'u_b', b.slug, 'g1');
  await follow(db, 'u_a', b.slug); await follow(db, 'u_b', a.slug);
  await db.batch(deleteStatements(db, 'u_a'));
  assert.equal((await view(db, b.slug, null)).collection.followers, 0);
  await assert.rejects(view(db, a.slug, null), code('not_found'));
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM collection_follows').get().n, 0);
  await deleteCollection(db, 'u_b', b.slug);
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM collection_games').get().n, 0);
});

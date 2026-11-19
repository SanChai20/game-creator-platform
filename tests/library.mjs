// The game library: bought games are in it from their purchase (and leave on a refund), free games are added and removed
// by the player, paid games cannot be added without buying them, and each player sees only their own. Runs the real
// module against SQLite with the real migrations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { addToLibrary, libraryCounts, libraryList, libraryState, removeFromLibrary, LibraryError } from '../src/library.js';

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
  return { prepare: (q) => stmt(q), sql };
}
function game(db, id, { status = 'live', price = 0, owner = 'u_creator' } = {}) {
  db.sql.prepare('INSERT INTO projects (id, owner_id, slug, title, status, price_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0)').run(id, owner, 'slug-' + id, 'Game ' + id, status, price);
  return { id, status, price_cents: price };
}
let n = 0;
const buy = (db, u, g, t, status = 'paid') => db.sql.prepare("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, provider_ref, status, created_at) VALUES (?, ?, ?, 'u_creator', 500, 50, 450, 'stripe', ?, ?, ?)").run('pur_' + ++n, u, g, 'cs_' + n, status, t);
const ids = async (db, u, o) => (await libraryList(db, u, o)).list.map((x) => `${x.game_id}:${x.source}`);

test('a bought game is in the library from its purchase and leaves it on a refund', async () => {
  const db = d1(); game(db, 'paid1', { price: 500 });
  assert.equal(await libraryState(db, 'u_alice', 'paid1'), null);
  buy(db, 'u_alice', 'paid1', 1000);
  assert.equal(await libraryState(db, 'u_alice', 'paid1'), 'bought');
  assert.deepEqual(await ids(db, 'u_alice'), ['paid1:bought']);
  assert.deepEqual(await ids(db, 'u_bob'), [], 'only the buyer\'s library');
  db.sql.prepare("UPDATE purchases SET status = 'refunded' WHERE project_id = 'paid1'").run();
  assert.deepEqual(await ids(db, 'u_alice'), []);
  assert.equal(await libraryState(db, 'u_alice', 'paid1'), null);
});

test('free games are added and removed by the player; paid ones only by buying', async () => {
  const db = d1(), free = game(db, 'free1'), paid = game(db, 'paid1', { price: 500 }), off = game(db, 'off1', { status: 'offline' });
  assert.deepEqual(await addToLibrary(db, 'u_alice', free, 10), { ok: true, library: 'added' });
  assert.deepEqual(await addToLibrary(db, 'u_alice', free, 20), { ok: true, library: 'added' }, 'adding twice changes nothing');
  await assert.rejects(addToLibrary(db, 'u_alice', paid), (e) => e instanceof LibraryError && e.code === 'paid');
  await assert.rejects(addToLibrary(db, 'u_alice', off), (e) => e instanceof LibraryError && e.status === 404);
  await assert.rejects(addToLibrary(db, 'u_alice', null), (e) => e instanceof LibraryError && e.status === 404);
  buy(db, 'u_alice', 'paid1', 30);
  assert.deepEqual(await addToLibrary(db, 'u_alice', paid), { ok: true, library: 'bought' });
  assert.deepEqual(await ids(db, 'u_alice'), ['paid1:bought', 'free1:added']);
  assert.deepEqual(await removeFromLibrary(db, 'u_alice', 'paid1'), { ok: true, library: 'bought' }, 'a bought game stays while owned');
  assert.deepEqual(await removeFromLibrary(db, 'u_alice', 'free1'), { ok: true, library: null });
  assert.deepEqual(await ids(db, 'u_alice'), ['paid1:bought']);
});

test('the library lists live games only, newest first, filtered and paged, with counts', async () => {
  const db = d1();
  for (let i = 0; i < 5; i++) await addToLibrary(db, 'u_alice', game(db, 'f' + i), 100 + i);
  game(db, 'p1', { price: 300 }); buy(db, 'u_alice', 'p1', 250);
  game(db, 'p2', { price: 300 }); buy(db, 'u_alice', 'p2', 50);
  db.sql.prepare("UPDATE projects SET status = 'offline' WHERE id = 'f2'").run();
  assert.deepEqual(await ids(db, 'u_alice'), ['p1:bought', 'f4:added', 'f3:added', 'f1:added', 'f0:added', 'p2:bought']);
  assert.deepEqual(await ids(db, 'u_alice', { filter: 'bought' }), ['p1:bought', 'p2:bought']);
  assert.deepEqual(await ids(db, 'u_alice', { filter: 'added' }), ['f4:added', 'f3:added', 'f1:added', 'f0:added']);
  const page = await libraryList(db, 'u_alice', { limit: 4 });
  assert.equal(page.more, true);
  assert.deepEqual((await libraryList(db, 'u_alice', { limit: 4, offset: 4 })).list.map((x) => x.game_id), ['f0', 'p2']);
  assert.deepEqual(await libraryCounts(db, 'u_alice'), { all: 6, bought: 2, added: 4 });
});

test('a free game that later got a price: listed once, as bought once bought, and not owned until then', async () => {
  const db = d1(), g = game(db, 'g1');
  await addToLibrary(db, 'u_alice', g, 10);
  db.sql.prepare("UPDATE projects SET price_cents = 400 WHERE id = 'g1'").run();
  let r = (await libraryList(db, 'u_alice')).list;
  assert.equal(r.length, 1); assert.equal(r[0].source, 'added'); assert.equal(r[0].owned, false);
  buy(db, 'u_alice', 'g1', 20);
  r = (await libraryList(db, 'u_alice')).list;
  assert.deepEqual(r.map((x) => [x.source, x.owned]), [['bought', true]]);
  assert.deepEqual(await libraryCounts(db, 'u_alice'), { all: 1, bought: 1, added: 0 });
});

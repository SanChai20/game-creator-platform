// Coming soon pages and wishlists (src/wishlist.js): what an announcement needs, who may wishlist what, the release and
// sale news (once each, never the owner or suspended accounts), and devlogs reaching wishlisters while the page is up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { addWish, announceIssues, canWish, cleanReleaseNote, comingSoonGames, isComingSoon, released, removeWish, setComingSoon, tellWishers, wishCount, wishlistOf } from '../src/wishlist.js';
import { postDevlog } from '../src/devlogs.js';
import { feed } from '../src/follows.js';

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
const T = 1_800_000_000_000;
function world() {
  const db = d1(), q = (s, ...a) => db.sql.prepare(s).run(...a);
  for (const [id, status] of [['u_owner', 'active'], ['u_a', 'active'], ['u_b', 'active'], ['u_gone', 'suspended']]) q("INSERT INTO users (id, email, name, pw_hash, status, created_at) VALUES (?, ?, ?, '', ?, 1)", id, id + '@example.com', id, status);
  q("INSERT INTO projects (id, owner_id, slug, title, tagline, cover_key, status, created_at, updated_at) VALUES ('g1', 'u_owner', 'soon-one', 'Soon One', 'A game.', 'covers/x.png', 'draft', 1, 1)");
  q("INSERT INTO projects (id, owner_id, slug, title, status, created_at, updated_at) VALUES ('g2', 'u_owner', 'bare', 'Bare', 'draft', 1, 1)");
  q("INSERT INTO projects (id, owner_id, slug, title, tagline, cover_key, status, price_cents, published_at, created_at, updated_at) VALUES ('g3', 'u_owner', 'paid', 'Paid', 'x', 'c', 'live', 500, 1, 1, 1)");
  q("INSERT INTO projects (id, owner_id, slug, title, tagline, cover_key, status, price_cents, published_at, created_at, updated_at) VALUES ('g4', 'u_owner', 'free', 'Free', 'x', 'c', 'live', 0, 1, 1, 1)");
  return db;
}
const P = async (db, id) => db.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first();

test('an announcement needs a title, tagline and cover, and an unreleased game', async () => {
  const db = world();
  assert.deepEqual(announceIssues(await P(db, 'g1')), []);
  assert.deepEqual(announceIssues(await P(db, 'g2')).map((i) => i.field), ['tagline', 'cover']);
  assert.deepEqual(announceIssues(await P(db, 'g3')).map((i) => i.field), ['status']);
  await assert.rejects(setComingSoon(db, await P(db, 'g2'), { on: true }), /Not ready/);
  const r = await setComingSoon(db, await P(db, 'g1'), { on: true, release_note: '  Spring   2027 ' }, T);
  assert.deepEqual(r, { coming_soon: true, release_note: 'Spring 2027', coming_soon_at: T });
  assert.ok(isComingSoon(await P(db, 'g1')));
  assert.equal(cleanReleaseNote('x'.repeat(80)).length, 40);
  assert.equal(cleanReleaseNote('   '), null);
});

test('who may wishlist what', async () => {
  const db = world();
  await setComingSoon(db, await P(db, 'g1'), { on: true }, T);
  assert.equal(await canWish(db, 'u_a', await P(db, 'g1')), true);
  assert.equal(await canWish(db, 'u_owner', await P(db, 'g1')), false);
  assert.equal(await canWish(db, 'u_a', await P(db, 'g2')), false);   // not announced
  assert.equal(await canWish(db, 'u_a', await P(db, 'g3')), true);    // paid, not owned
  assert.equal(await canWish(db, 'u_a', await P(db, 'g4')), false);   // free and live: the library is for that
  db.sql.prepare("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, status, created_at) VALUES ('pu', 'u_b', 'g3', 'u_owner', 500, 50, 450, 'admin', 'paid', 1)").run();
  assert.equal(await canWish(db, 'u_b', await P(db, 'g3')), false);   // already bought
  await addWish(db, 'u_a', await P(db, 'g1'), T); await addWish(db, 'u_a', await P(db, 'g1'), T);
  await assert.rejects(addWish(db, 'u_a', await P(db, 'g4')), /coming soon, or a paid game/);
  assert.deepEqual(await wishCount(db, 'g1'), { wishlists: 1, recent: 1 });
  assert.deepEqual((await wishlistOf(db, 'u_a')).map((g) => g.id), ['g1']);
  assert.deepEqual((await comingSoonGames(db)).map((g) => [g.id, g.wishes]), [['g1', 1]]);
  await removeWish(db, 'u_a', 'g1');
  assert.equal((await wishCount(db, 'g1')).wishlists, 0);
});

test('the first release tells wishlisters once, and ends the coming soon page', async () => {
  const db = world();
  await setComingSoon(db, await P(db, 'g1'), { on: true }, T);
  for (const u of ['u_a', 'u_b']) await addWish(db, u, await P(db, 'g1'), T);
  db.sql.prepare("INSERT INTO wishlists (user_id, project_id, created_at) VALUES ('u_gone', 'g1', 1)").run();
  db.sql.prepare("UPDATE projects SET status = 'live', published_at = ? WHERE id = 'g1'").run(T);
  const r = await released(db, 'g1', T);
  assert.equal(r.notified, 2);
  assert.deepEqual(r.live.sort(), ['u_a', 'u_b']);
  assert.equal((await released(db, 'g1', T)).notified, 0);
  assert.equal((await P(db, 'g1')).coming_soon_at, null);
  const f = await feed(db, 'u_a');
  assert.equal(f.items[0].kind, 'wish_release');
  // a sale is told once per sale
  await addWish(db, 'u_a', await P(db, 'g3'), T);
  assert.equal((await tellWishers(db, 'g3', 'wish_sale', '100', T)).notified, 1);
  assert.equal((await tellWishers(db, 'g3', 'wish_sale', '100', T)).notified, 0);
  assert.equal((await tellWishers(db, 'g3', 'wish_sale', '200', T)).notified, 1);
});

test('devlogs on a coming soon page reach the players who wishlisted it', async () => {
  const db = world();
  await setComingSoon(db, await P(db, 'g1'), { on: true }, T);
  await addWish(db, 'u_a', await P(db, 'g1'), T);
  const r = await postDevlog(db, await P(db, 'g1'), 'u_owner', { title: 'Trailer is out', body: 'Have a look.' }, { t: T });
  assert.equal(r.notified, 1);
  assert.equal((await feed(db, 'u_a')).items[0].kind, 'devlog');
  // taken down: the post stays, but its notification no longer shows
  await setComingSoon(db, await P(db, 'g1'), { on: false });
  assert.equal((await feed(db, 'u_a')).items.length, 0);
});

// Bundles (src/bundles.js): only the creator's own paid games, limits, the complete-the-set discount (owning another game
// of the bundle), the best of several bundles, the public view, and editing and removing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { bundleDiscount, bundlesOf, bundleView, createBundle, myBundles, removeBundle, updateBundle } from '../src/bundles.js';

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
  for (const u of ['u_c', 'u_o', 'u_a']) q("INSERT INTO users (id, email, name, pw_hash, status, created_at) VALUES (?, ?, ?, '', 'active', 1)", u, u + '@x', 'Name ' + u);
  const game = (id, owner, price, status = 'live') => q('INSERT INTO projects (id, owner_id, slug, title, status, live_version, price_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, 1, 1)', id, owner, id, 'Game ' + id, status, price);
  game('a', 'u_c', 1000); game('b', 'u_c', 500); game('c', 'u_c', 800); game('free', 'u_c', 0); game('other', 'u_o', 900); game('draft', 'u_c', 700, 'draft');
  const buy = (uid, pid, status = 'paid') => q("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, provider_ref, status, created_at) VALUES (?, ?, ?, 'u_c', 0, 0, 0, 'stripe', ?, ?, 1)", 'p' + uid + pid + status, uid, pid, 'ref' + uid + pid + status, status);
  return { db, q, buy };
}
const code = (e) => (err) => err.code === e;
const plain = (p, pct) => (pct ? Math.round(p.price_cents * (100 - pct) / 100) : p.price_cents);

test('a bundle holds 2 to 10 of the creator\'s own paid games', async () => {
  const { db } = world();
  await assert.rejects(createBundle(db, 'u_c', { title: 'Set', percent_off: 20, games: ['a'] }), code('bad_request'));
  await assert.rejects(createBundle(db, 'u_c', { title: 'Set', percent_off: 20, games: ['a', 'other'] }), code('forbidden'));
  await assert.rejects(createBundle(db, 'u_c', { title: 'Set', percent_off: 20, games: ['a', 'free'] }), code('free'));
  await assert.rejects(createBundle(db, 'u_c', { title: 'Set', percent_off: 70, games: ['a', 'b'] }), code('bad_request'));
  await assert.rejects(createBundle(db, 'u_c', { title: '', percent_off: 20, games: ['a', 'b'] }), code('bad_request'));
  await assert.rejects(createBundle(db, 'u_c', { title: 'Set', percent_off: 20, games: ['a', 'a'] }), code('bad_request'));
  const b = await createBundle(db, 'u_c', { title: 'Space Trilogy', percent_off: 25, games: ['a', 'b', 'c'] });
  assert.equal(b.slug, 'space-trilogy');
  const again = await createBundle(db, 'u_c', { title: 'Space Trilogy', percent_off: 10, games: ['a', 'b'] });
  assert.notEqual(again.slug, b.slug);
  const mine = await myBundles(db, 'u_c');
  assert.deepEqual(mine.map((x) => x.games.map((g) => g.id)).sort((x, y) => x.length - y.length), [['a', 'b'], ['a', 'b', 'c']]);
});

test('complete the set: owning another game of the bundle takes its discount off the rest', async () => {
  const { db, buy } = world();
  await createBundle(db, 'u_c', { title: 'Trio', percent_off: 25, games: ['a', 'b', 'c'] });
  assert.equal(await bundleDiscount(db, 'a', 'u_a'), null);   // owns nothing yet
  assert.equal(await bundleDiscount(db, 'a', null), null);
  buy('u_a', 'b', 'refunded');
  assert.equal(await bundleDiscount(db, 'a', 'u_a'), null);   // a refunded purchase is not owning
  buy('u_a', 'b');
  assert.equal((await bundleDiscount(db, 'a', 'u_a')).percent_off, 25);
  assert.equal((await bundleDiscount(db, 'c', 'u_a')).percent_off, 25);
  // the largest of several bundles wins
  await createBundle(db, 'u_c', { title: 'Duo', percent_off: 40, games: ['a', 'b'] });
  assert.equal((await bundleDiscount(db, 'a', 'u_a')).percent_off, 40);
  assert.equal((await bundleDiscount(db, 'c', 'u_a')).percent_off, 25);
  const shown = await bundlesOf(db, 'a', 'u_a');
  assert.deepEqual(shown.map((x) => [x.slug, x.owned, x.games, x.applies]), [['duo', 1, 2, true], ['trio', 1, 3, true]]);
});

test('a game that is not live does not count, and a bundle with under 2 live games is not shown', async () => {
  const { db, q, buy } = world();
  await createBundle(db, 'u_c', { title: 'Pair', percent_off: 30, games: ['a', 'draft'] });
  buy('u_a', 'draft');
  assert.equal(await bundleDiscount(db, 'a', 'u_a'), null);
  await assert.rejects(bundleView(db, 'pair', 'u_a', plain), code('not_found'));
  assert.deepEqual(await bundlesOf(db, 'a', 'u_a'), []);
  q("UPDATE projects SET status = 'live' WHERE id = 'draft'");
  assert.equal((await bundleDiscount(db, 'a', 'u_a')).percent_off, 30);
});

test('the bundle page: owned games, what the rest cost this player', async () => {
  const { db, buy } = world();
  await createBundle(db, 'u_c', { title: 'Trio', percent_off: 25, games: ['a', 'b', 'c'], description: 'Three  games.' });
  let v = await bundleView(db, 'trio', null, plain);
  assert.equal(v.bundle.description, 'Three games.');
  assert.deepEqual(v.games.map((x) => [x.game.id, x.owned, x.price_cents]), [['a', false, 1000], ['b', false, 500], ['c', false, 800]]);
  buy('u_a', 'a');
  v = await bundleView(db, 'trio', 'u_a', plain);
  assert.deepEqual(v.games.map((x) => [x.game.id, x.owned, x.discounted, x.price_cents]), [['a', true, false, 0], ['b', false, true, 375], ['c', false, true, 600]]);
  assert.equal(v.owned, 1); assert.equal(v.rest_cents, 975); assert.equal(v.rest_regular_cents, 1300);
  assert.equal(v.bundle.owner.name, 'Name u_c');
});

test('editing and removing: the owner only', async () => {
  const { db } = world();
  const b = await createBundle(db, 'u_c', { title: 'Trio', percent_off: 25, games: ['a', 'b', 'c'] });
  await assert.rejects(updateBundle(db, 'u_o', b.id, { percent_off: 10 }), code('not_found'));
  await updateBundle(db, 'u_c', 'trio', { percent_off: 15, games: ['c', 'a'] });
  const [m] = await myBundles(db, 'u_c');
  assert.equal(m.percent_off, 15); assert.deepEqual(m.games.map((g) => g.id), ['c', 'a']);
  await assert.rejects(removeBundle(db, 'u_o', b.id), code('not_found'));
  await removeBundle(db, 'u_c', b.id);
  assert.deepEqual(await myBundles(db, 'u_c'), []);
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM bundle_games').get().n, 0);
});

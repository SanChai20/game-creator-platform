// Coupons and keys (src/coupons.js): discount codes for a paid game (limits, ends, uses, once per account, the price
// with a sale), single-use keys (a batch, redeeming, never twice, never your own or an owned game), and switching off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { batchKeys, checkDiscount, cleanCode, countDiscountUse, createDiscount, createKeys, disable, discounted, listCoupons, lookup, redeemKey } from '../src/coupons.js';

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
  for (const u of ['u_c', 'u_a', 'u_b']) q("INSERT INTO users (id, email, name, pw_hash, status, created_at) VALUES (?, ?, ?, '', 'active', 1)", u, u + '@x', u);
  q("INSERT INTO projects (id, owner_id, slug, title, status, live_version, price_cents, created_at, updated_at) VALUES ('g', 'u_c', 'g', 'Paid', 'live', 1, 1000, 1, 1)");
  q("INSERT INTO projects (id, owner_id, slug, title, status, live_version, price_cents, created_at, updated_at) VALUES ('f', 'u_c', 'f', 'Free', 'live', 1, 0, 1, 1)");
  const game = (id) => db.sql.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return { db, q, game };
}
const code = (e) => (err) => err.code === e;

test('discount codes: only for paid games, within limits, a code is taken once', async () => {
  const { db, game } = world();
  await assert.rejects(createDiscount(db, game('f'), { percent_off: 20 }), code('free'));
  await assert.rejects(createDiscount(db, game('g'), { percent_off: 95 }), code('bad_request'));
  await assert.rejects(createDiscount(db, game('g'), { percent_off: 20, max_uses: 0 }), code('bad_request'));
  const c = await createDiscount(db, game('g'), { code: 'press-2027', percent_off: 25, max_uses: 2, days: 7, note: 'Press' }, T);
  assert.equal(c.code, 'PRESS2027');
  assert.equal(c.expires_at, T + 7 * D);
  await assert.rejects(createDiscount(db, game('g'), { code: 'Press 2027', percent_off: 10 }, T), code('taken'));
  const auto = await createDiscount(db, game('g'), { percent_off: 10 }, T);
  assert.match(auto.code, /^[A-Z2-9]{8}$/);
  assert.equal(cleanCode(' ab-cd 12 '), 'ABCD12');
});

test('the price with a discount: off the regular price, the sale when lower, never below 50 cents', () => {
  assert.equal(discounted(1000, 25), 750);
  assert.equal(discounted(1000, 25, 600), 600);
  assert.equal(discounted(1000, 25, 900), 750);
  assert.equal(discounted(60, 90), 50);
  assert.equal(discounted(40, 50), 40);
});

test('a discount code works for its game, once per account, until it runs out or ends', async () => {
  const { db, game } = world();
  const c = await createDiscount(db, game('g'), { code: 'TWICE', percent_off: 50, max_uses: 2, days: 3 }, T);
  const p = game('g');
  assert.equal((await checkDiscount(db, 'twice', p, 'u_a', T)).id, c.id);
  await assert.rejects(checkDiscount(db, 'twice', game('f'), 'u_a', T), code('bad_code'));
  assert.equal(await countDiscountUse(db, c.id, 'u_a', 'cs_1', T), true);
  assert.equal(await countDiscountUse(db, c.id, 'u_a', 'cs_1', T), false);   // the webhook and the return both apply it
  await assert.rejects(checkDiscount(db, 'TWICE', p, 'u_a', T), code('used'));
  await countDiscountUse(db, c.id, 'u_b', 'cs_2', T);
  await assert.rejects(checkDiscount(db, 'TWICE', p, 'u_c', T), code('bad_code'));   // used up
  const later = await createDiscount(db, game('g'), { code: 'SOON', percent_off: 10, days: 1 }, T);
  assert.ok(await lookup(db, 'SOON', T + D - 1));
  assert.equal(await lookup(db, 'SOON', T + D), null);
  await disable(db, 'g', { id: later.id }, T);
  assert.equal(await lookup(db, 'SOON', T), null);
  await assert.rejects(disable(db, 'g', { id: later.id }, T), code('not_found'));
  const { discounts } = await listCoupons(db, 'g', T);
  assert.deepEqual(discounts.map((d) => [d.code, d.working]).sort(), [['SOON', false], ['TWICE', false]]);
});

test('keys: a batch of single-use keys gives the game at no charge, once', async () => {
  const { db, game } = world();
  await assert.rejects(createKeys(db, game('g'), { count: 101 }), code('bad_request'));
  const { batch, codes } = await createKeys(db, game('g'), { count: 3, note: 'Streamers' }, T);
  assert.equal(codes.length, 3);
  assert.match(codes[0], /^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  await assert.rejects(redeemKey(db, codes[0], null, T), code('unauthenticated'));
  await assert.rejects(redeemKey(db, codes[0], 'u_c', T), code('own_game'));
  const r = await redeemKey(db, codes[0].toLowerCase(), 'u_a', T);
  assert.equal(r.slug, 'g');
  const pur = db.sql.prepare("SELECT * FROM purchases WHERE user_id = 'u_a'").get();
  assert.equal(pur.provider, 'key'); assert.equal(pur.price_cents, 0); assert.equal(pur.net_cents, 0); assert.equal(pur.status, 'paid');
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 0);
  await assert.rejects(redeemKey(db, codes[0], 'u_b', T), code('bad_code'));   // used
  await assert.rejects(redeemKey(db, codes[1], 'u_a', T), code('owned'));
  assert.equal(db.sql.prepare('SELECT uses FROM coupons WHERE code = ?').get(codes[1].replace(/-/g, '')).uses, 0);
  // a key is not a discount code
  await assert.rejects(checkDiscount(db, codes[1], game('g'), 'u_b', T), code('bad_code'));
  const keys = await batchKeys(db, 'g', batch);
  assert.deepEqual(keys.map((k) => k.used), [true, false, false]);
  assert.deepEqual(await disable(db, 'g', { batch }, T), { ok: true, switched_off: 2 });
  await assert.rejects(redeemKey(db, codes[2], 'u_b', T), code('bad_code'));
  const { batches } = await listCoupons(db, 'g', T);
  assert.deepEqual(batches.map((b) => [b.note, b.count, b.used, b.off]), [['Streamers', 3, 1, 2]]);
});

test('a key bought at the same moment goes back unused', async () => {
  const { db, game, q } = world();
  const { codes } = await createKeys(db, game('g'), { count: 1 }, T);
  // the purchase lands between the owned check and the insert
  const real = db.prepare;
  db.prepare = (s) => { if (s.startsWith('INSERT INTO purchases')) { q("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, provider_ref, status, created_at) VALUES ('p1', 'u_a', 'g', 'u_c', 1000, 100, 900, 'stripe', 'cs_x', 'paid', 1)"); db.prepare = real; } return real(s); };
  await assert.rejects(redeemKey(db, codes[0], 'u_a', T), code('owned'));
  assert.ok(await lookup(db, codes[0], T));
});

// Limited-time sales (src/sales.ts): the sale price applies only while the sale runs, the rules that keep the
// struck-through price honest (at least the minimum discount, a fixed regular price during the sale, a wait after a
// sale or a price rise), changing and ending a sale, and the money: a purchase made on sale records the sale price,
// and its refund gives back that price, with the cut and the creator's credit worked out from it.
// Real migrations, in-memory SQLite, Stripe stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { saleOf, priceNow, planSale, setSale, saleView, nextSaleAt, checkoutExpiry, percentOff, PRICE_NOW_SQL, DAY_MS } = await import('../src/sales.ts');
const { recordPurchase, balanceOf, splitSale } = await import('../src/earnings.ts');
const { requestRefund } = await import('../src/refunds.ts');
const { updateProjectMeta } = await import('../src/projects.ts');
const { SETTING_DEFS } = await import('../src/settings.ts');

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
const S = { ...Object.fromEntries(Object.entries(SETTING_DEFS).map(([k, d]) => [k, d.v])), earnings_hold_days: 0, new_creator_days: 0 };
const T = Date.UTC(2026, 10, 22, 12);

function world(price = 1000) {
  const DB = d1();
  DB.sql.prepare("INSERT INTO users (id, email, name, pw_hash, role, status, created_at) VALUES ('u_maker', 'm@x.test', 'Maker', '', 'user', 'active', 0), ('u_buyer', 'b@x.test', 'Buyer', '', 'user', 'active', 0)").run();
  DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, price_cents, created_at, updated_at) VALUES ('g1', 'u_maker', 'g', 'Game', 'live', ?, 0, 0)").run(price);
  return { DB };
}
const row = (env) => env.DB.sql.prepare("SELECT * FROM projects WHERE id = 'g1'").get();

test('the defaults', () => {
  assert.equal(S.sales_enabled, true);
  assert.equal(S.sale_max_days, 30);
  assert.equal(S.sale_min_percent_off, 10);
  assert.equal(S.sale_gap_days, 30);
});

test('the sale price applies only while the sale runs, then the regular price is back by itself', () => {
  const p = { price_cents: 1000, sale_price_cents: 600, sale_starts_at: T, sale_ends_at: T + 3 * DAY_MS };
  assert.deepEqual(saleOf(p, T + 1), { price_cents: 600, regular_cents: 1000, percent_off: 40, starts_at: T, ends_at: T + 3 * DAY_MS });
  assert.equal(priceNow(p, T + 1), 600);
  assert.equal(priceNow(p, T + 3 * DAY_MS), 1000, 'over at the end time exactly');
  assert.equal(saleOf(p, T + 3 * DAY_MS), null);
  assert.equal(priceNow({ ...p, sale_price_cents: 0 }, T + 1), 1000, 'never on sale');
  assert.equal(priceNow({ ...p, price_cents: 0 }, T + 1), 0, 'a free game is never on sale');
  assert.equal(priceNow({ ...p, price_cents: 500 }, T + 1), 500, 'a sale price above the regular price never counts');
  assert.equal(percentOff(999, 599), 40, 'rounded down, so the shown discount is never more than the real one');
});

test('the SQL price matches the code', () => {
  const env = world();
  env.DB.sql.prepare("UPDATE projects SET sale_price_cents = 450, sale_starts_at = ?, sale_ends_at = ? WHERE id = 'g1'").run(T, T + DAY_MS);
  const at = (t) => env.DB.sql.prepare(`SELECT ${PRICE_NOW_SQL} AS n FROM projects p WHERE id = 'g1'`).get(t).n;
  assert.equal(at(T + 1), 450);
  assert.equal(at(T + DAY_MS), 1000);
});

test('the rules: a paid game, at least the minimum discount, not below the lowest sale price, at most the longest sale', () => {
  const p = { price_cents: 1000 };
  assert.deepEqual(planSale(p, S, { price_cents: 900, days: 7 }, T), { sale_price_cents: 900, sale_starts_at: T, sale_ends_at: T + 7 * DAY_MS });
  assert.throws(() => planSale(p, S, { price_cents: 901, days: 7 }, T), /at least 10% off.*900 cents or less/);
  assert.throws(() => planSale(p, S, { price_cents: 98, days: 7 }, T), /at least 99 cents/);
  assert.throws(() => planSale(p, S, { price_cents: 500, days: 31 }, T), /at most 30 days/);
  assert.throws(() => planSale(p, S, { price_cents: 500, days: 0 }, T), /whole number of days/);
  assert.throws(() => planSale(p, S, { price_cents: 500, days: 1.5 }, T), /whole number of days/);
  assert.throws(() => planSale(p, S, { price_cents: 0, days: 3 }, T), /positive/);
  assert.throws(() => planSale({ price_cents: 0 }, S, { price_cents: 500, days: 3 }, T), /Only a paid game/);
  assert.throws(() => planSale(p, { ...S, sales_enabled: false }, { price_cents: 500, days: 3 }, T), (e) => e.status === 403);
});

test('a running sale can be changed from its start; ending it starts the wait before the next one', async () => {
  const env = world();
  let sale = await setSale(env, S, row(env), { price_cents: 700, days: 5 }, T);
  assert.equal(sale.ends_at, T + 5 * DAY_MS);
  // two days in: fixed to 600 and made 10 days long, counted from its start
  sale = await setSale(env, S, row(env), { price_cents: 600, days: 10 }, T + 2 * DAY_MS);
  assert.deepEqual([sale.price_cents, sale.starts_at, sale.ends_at], [600, T, T + 10 * DAY_MS]);
  await assert.rejects(setSale(env, S, row(env), { price_cents: 600, days: 31 }, T + 2 * DAY_MS), /at most 30 days/);
  await assert.rejects(setSale(env, S, row(env), { price_cents: 600, days: 2 }, T + 3 * DAY_MS), /already be over/);
  // ended early, on day 3: the price is back at once and the next sale waits 30 days from now
  assert.equal(await setSale(env, S, row(env), null, T + 3 * DAY_MS), null);
  assert.equal(priceNow(row(env), T + 3 * DAY_MS + 1), 1000);
  assert.equal(nextSaleAt(row(env), S), T + 33 * DAY_MS);
  await assert.rejects(setSale(env, S, row(env), { price_cents: 600, days: 3 }, T + 10 * DAY_MS), /had a sale recently.*2026-12-25/);
  assert.ok(await setSale(env, S, row(env), { price_cents: 600, days: 3 }, T + 33 * DAY_MS));
  const v = saleView(row(env), S, T + 40 * DAY_MS);
  assert.equal(v.running, null);
  assert.equal(v.last.price_cents, 600);
  assert.equal(v.next_sale_at, T + 66 * DAY_MS);
});

test('the regular price is fixed during a sale, and raising it delays the next sale', async () => {
  const env = world();
  await setSale(env, S, row(env), { price_cents: 700, days: 5 });
  await assert.rejects(updateProjectMeta(env, row(env), { price_cents: 1500 }), /on sale/);
  await assert.rejects(updateProjectMeta(env, row(env), { price_cents: 0 }), /on sale/);
  await updateProjectMeta(env, row(env), { price_cents: 1000 }); // unchanged is fine
  await setSale(env, S, row(env), null);
  // a fresh game: raise the price, then a sale has to wait, so the struck-through price is one it really sold at
  const g = world(1000);
  await updateProjectMeta(g, row(g), { price_cents: 1500 });
  assert.ok(row(g).price_raised_at > 0);
  await assert.rejects(setSale(g, S, row(g), { price_cents: 900, days: 3 }), /regular price went up recently/);
  assert.ok(await setSale(g, { ...S, sale_gap_days: 0 }, row(g), { price_cents: 900, days: 3 }), 'no wait when the gap is 0');
  // lowering the price is no reason to wait
  const h = world(1500);
  await updateProjectMeta(h, row(h), { price_cents: 1000 });
  assert.equal(row(h).price_raised_at, null);
});

test('a sale checkout closes when the sale ends, within what Stripe allows', () => {
  assert.equal(checkoutExpiry(T + 5 * DAY_MS, T), Math.floor((T + 23 * 3600000) / 1000), 'a long sale: Stripe\'s own limit');
  assert.equal(checkoutExpiry(T + 2 * 3600000, T), Math.floor((T + 2 * 3600000) / 1000), 'ends in 2 hours: the checkout too');
  assert.equal(checkoutExpiry(T + 60000, T), Math.floor((T + 31 * 60000) / 1000), 'Stripe needs at least 30 minutes');
});

test('bought on sale: the purchase records the sale price, and a refund gives back exactly that', async () => {
  const env = world();
  await setSale(env, S, row(env), { price_cents: 600, days: 5 });
  // what the webhook records: Stripe's amount_total of the sale checkout
  await recordPurchase(env, { ...S, refund_window_hours: 0 }, { userId: 'u_buyer', projectId: 'g1', ownerId: 'u_maker', title: 'Game', priceCents: priceNow(row(env)), provider: 'stripe', providerRef: 'cs_sale', paymentIntent: 'pi_sale' });
  const p = env.DB.sql.prepare("SELECT * FROM purchases WHERE payment_intent = 'pi_sale'").get();
  const split = splitSale(600, S);
  assert.deepEqual([p.price_cents, p.fee_cents, p.net_cents], [600, split.fee, split.net]);
  assert.equal((await balanceOf(env, 'u_maker')).total, 540, 'the creator is credited from the sale price');
  // the sale ends before the refund: the refund still follows what was paid
  await setSale(env, S, row(env), null);
  const calls = [];
  const pay = { async refund(pi, id) { calls.push(pi); return 're_' + id; }, async fee() { return 47; }, async reverseTransfer() {} };
  const r = await requestRefund(env, S, 'u_buyer', p.id, '', pay);
  assert.equal(r.status, 'refunded');
  assert.deepEqual(calls, ['pi_sale'], 'Stripe refunds the whole charge, which was the sale price');
  const books = env.DB.sql.prepare('SELECT * FROM refund_requests WHERE id = ?').get(r.id);
  assert.deepEqual([books.price_cents, books.platform_fee_cents, books.creator_net_cents], [600, 60, 540]);
  assert.equal((await balanceOf(env, 'u_maker')).total, 0, 'the creator gives back the credit of the sale, not of the regular price');
});

// Open Implementation rewards: a lower platform cut on paid games, a moderate lift among free games.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { splitSale, cutPercent, recordPurchase, refundPurchase, partialRefund, balanceOf } = await import('../src/earnings.ts');
const { openPerks } = await import('../src/mcp/services.ts');
const { freeTrendingOrder } = await import('../src/catalog.ts');
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

const S = { platform_fee_percent: 10, platform_fee_open_percent: 5, sale_processing_percent: 0, sale_processing_fixed_cents: 0, earnings_hold_days: 0, refund_window_hours: 0, paid_games_enabled: true, open_impl_free_boost_percent: 50 };

test('defaults: 10% standard, 5% with Open Implementation, a 50% free-game lift; all admin settings', () => {
  assert.equal(SETTING_DEFS.platform_fee_percent.v, 10);
  assert.equal(SETTING_DEFS.platform_fee_open_percent.v, 5);
  assert.equal(SETTING_DEFS.open_impl_free_boost_percent.v, 50);
  for (const k of ['platform_fee_open_percent', 'open_impl_free_boost_percent']) assert.equal(SETTING_DEFS[k].public, true, k);
});

test('a paid game that shares pays the lower cut; one that does not pays the standard cut', () => {
  assert.equal(cutPercent(S, false), 10);
  assert.equal(cutPercent(S, true), 5);
  assert.deepEqual(splitSale(999, S), { fee: 100, net: 899, cut: 100, processing: 0, cut_percent: 10 });
  assert.deepEqual(splitSale(999, S, true), { fee: 50, net: 949, cut: 50, processing: 0, cut_percent: 5 });
  // processing costs still pass on, on top of the cut
  assert.equal(splitSale(1000, { ...S, sale_processing_percent: 3, sale_processing_fixed_cents: 30 }, true).net, 1000 - 50 - 30 - 30);
});

test('the sale keeps the fee it was charged: refunds take back exactly that net, whatever sharing is later', async () => {
  const DB = d1(), env = { DB };
  DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, price_cents, open_implementation, created_at, updated_at) VALUES ('g1', 'u_maker', 'g', 'G', 'live', 1000, 1, 0, 0)").run();
  await recordPurchase(env, S, { userId: 'b1', projectId: 'g1', ownerId: 'u_maker', title: 'G', priceCents: 1000, provider: 'stripe', providerRef: 'cs_1', paymentIntent: 'pi_1', openImplementation: true });
  DB.sql.prepare("UPDATE projects SET open_implementation = 0 WHERE id = 'g1'").run();   // the creator stops sharing
  await recordPurchase(env, S, { userId: 'b2', projectId: 'g1', ownerId: 'u_maker', title: 'G', priceCents: 1000, provider: 'stripe', providerRef: 'cs_2', paymentIntent: 'pi_2', openImplementation: false });
  const rows = DB.sql.prepare('SELECT provider_ref, fee_cents, net_cents FROM purchases ORDER BY provider_ref').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ provider_ref: 'cs_1', fee_cents: 50, net_cents: 950 }, { provider_ref: 'cs_2', fee_cents: 100, net_cents: 900 }]);
  assert.equal((await balanceOf(env, 'u_maker')).total, 1850);
  await partialRefund(env, 'pi_1', 500);   // half of the shared-era sale
  assert.equal((await balanceOf(env, 'u_maker')).total, 1850 - 475);
  await refundPurchase(env, { paymentIntent: 'pi_1' });
  assert.equal((await balanceOf(env, 'u_maker')).total, 900);
  await refundPurchase(env, { paymentIntent: 'pi_2' });
  assert.equal((await balanceOf(env, 'u_maker')).total, 0);
});

test('free games that share rise above similar ones, never above clearly better or poorly rated ones', () => {
  const DB = d1();
  const add = (id, recent, open, ratings = [0, 0], plays = 0) => DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, price_cents, open_implementation, recent, plays, rating_sum, rating_count, created_at, updated_at) VALUES (?, 'u', ?, ?, 'live', 0, ?, ?, ?, ?, ?, 0, 0)")
    .run(id, id, id, open, recent, plays, ratings[0], ratings[1]);
  add('closed_100', 100, 0);
  add('open_80', 80, 1);            // 80 * 1.5 = 120: above a closed game with 100
  add('closed_200', 200, 0);        // clearly more played: stays above
  add('open_bad', 150, 1, [20, 10]); // average 2 from 10 ratings: no lift (225 would beat closed_200)
  add('open_new', 0, 1);            // no recent play: nothing to multiply
  const order = (boost) => DB.sql.prepare(`SELECT id FROM projects p WHERE p.status = 'live' AND p.price_cents = 0 ORDER BY ${freeTrendingOrder(boost)}`).all().map((r) => r.id);
  assert.deepEqual(order(50), ['closed_200', 'open_bad', 'open_80', 'closed_100', 'open_new']);
  assert.deepEqual(order(0), ['closed_200', 'open_bad', 'closed_100', 'open_80', 'open_new']);
  assert.deepEqual(order(100), order(5000));   // capped at double
  assert.doesNotMatch(freeTrendingOrder('1); DROP TABLE projects; --'), /DROP/);
});

test('agents can tell the user what sharing earns', () => {
  assert.match(openPerks(S), /5% platform cut .* instead of 10%/);
  assert.match(openPerks(S), /ranked higher among free games/);
  assert.equal(openPerks({ ...S, platform_fee_open_percent: 10, open_impl_free_boost_percent: 0 }), '');
});

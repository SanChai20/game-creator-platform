// Money after a sale: full and partial refunds, chargebacks won and lost, and the Stripe webhook signature check.
// Proves: a creator's credit is taken back exactly once whatever order the events arrive in, a partial refund followed by
// a full one never takes more than the sale credited, a chargeback holds the credit back and winning it returns it once,
// and a webhook with a wrong, missing or stale signature is refused. Real migrations, in-memory SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { recordPurchase, refundPurchase, partialRefund, disputePurchase, disputeWon, balanceOf, owns } = await import('../src/earnings.ts');
const { verifyWebhook, STRIPE_API_VERSION } = await import('../src/stripe.ts');
const { hmacHex } = await import('../src/util.ts');

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

const S = { platform_fee_percent: 10, sale_processing_percent: 0, sale_processing_fixed_cents: 0, earnings_hold_days: 0 };
async function setup() {
  const DB = d1();
  DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, price_cents, created_at, updated_at) VALUES ('g1', 'u_maker', 'g', 'G', 'live', 1000, 0, 0)").run();
  const env = { DB };
  await recordPurchase(env, S, { userId: 'u_buyer', projectId: 'g1', ownerId: 'u_maker', title: 'G', priceCents: 1000, provider: 'stripe', providerRef: 'cs_1', paymentIntent: 'pi_1' });
  return env;
}
const total = async (env) => (await balanceOf(env, 'u_maker')).total;
const sales = (env) => env.DB.sql.prepare("SELECT sales FROM projects WHERE id = 'g1'").get().sales;

test('a sale credits the creator its net, and a full refund takes it back once', async () => {
  const env = await setup();
  assert.equal(await total(env), 900);
  assert.equal(await refundPurchase(env, { paymentIntent: 'pi_1' }), true);
  assert.equal(await refundPurchase(env, { paymentIntent: 'pi_1' }), false);   // the webhook after an admin refund
  assert.equal(await total(env), 0);
  assert.equal(await owns(env, 'u_buyer', 'g1'), false);
  assert.equal(sales(env), 0);
});

test('partial refunds take back the same share once, and a later full refund only the rest', async () => {
  const env = await setup();
  assert.equal(await partialRefund(env, 'pi_1', 300), true);
  assert.equal(await total(env), 630);
  assert.equal(await partialRefund(env, 'pi_1', 300), false);   // the same event again
  assert.equal(await partialRefund(env, 'pi_1', 200), false);   // an older event arriving late
  assert.equal(await partialRefund(env, 'pi_1', 500), true);    // a second partial refund: running total 500
  assert.equal(await total(env), 450);
  assert.equal(await owns(env, 'u_buyer', 'g1'), true);
  await refundPurchase(env, { paymentIntent: 'pi_1' });
  assert.equal(await total(env), 0);
  assert.equal(await partialRefund(env, 'pi_1', 1000), false);  // nothing more once refunded
  assert.equal(await total(env), 0);
});

test('a chargeback revokes access and holds the credit; winning it gives both back once', async () => {
  const env = await setup();
  assert.equal(await disputePurchase(env, 'pi_1'), true);
  assert.equal(await disputePurchase(env, 'pi_1'), false);
  assert.equal(await total(env), 0);
  assert.equal(await owns(env, 'u_buyer', 'g1'), false);
  assert.equal(await disputeWon(env, 'pi_1'), true);
  assert.equal(await disputeWon(env, 'pi_1'), false);
  assert.equal(await total(env), 900);
  assert.equal(await owns(env, 'u_buyer', 'g1'), true);
  assert.equal(sales(env), 1);
});

test('a lost chargeback keeps the credit taken back, and a won one after a re-purchase does not clash', async () => {
  const env = await setup();
  await partialRefund(env, 'pi_1', 100);
  await disputePurchase(env, 'pi_1');
  assert.equal(await total(env), 0);   // the partial refund is not taken twice
  // the buyer bought the game again while the dispute was open
  await recordPurchase(env, S, { userId: 'u_buyer', projectId: 'g1', ownerId: 'u_maker', title: 'G', priceCents: 1000, provider: 'stripe', providerRef: 'cs_2', paymentIntent: 'pi_2' });
  assert.equal(await disputeWon(env, 'pi_1'), true);
  assert.equal(await total(env), 900 + 810);
  assert.equal(env.DB.sql.prepare("SELECT status FROM purchases WHERE payment_intent = 'pi_1'").get().status, 'dispute_won');
  assert.equal(await owns(env, 'u_buyer', 'g1'), true);
});

test('webhook signatures: only a fresh, correct signature is accepted', async () => {
  const env = { STRIPE_WEBHOOK_SECRET: 'whsec_test' };
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const t = Math.floor(Date.now() / 1000);
  const sig = await hmacHex('whsec_test', `${t}.${body}`);
  assert.equal((await verifyWebhook(env, body, `t=${t},v1=${sig}`)).id, 'evt_1');
  assert.equal((await verifyWebhook(env, body, `t=${t},v1=deadbeef,v1=${sig}`)).id, 'evt_1');   // rolled secrets send two
  await assert.rejects(verifyWebhook(env, body, `t=${t},v1=${'0'.repeat(64)}`));
  await assert.rejects(verifyWebhook(env, body + ' ', `t=${t},v1=${sig}`));
  await assert.rejects(verifyWebhook(env, body, null));
  const old = t - 600, oldSig = await hmacHex('whsec_test', `${old}.${body}`);
  await assert.rejects(verifyWebhook(env, body, `t=${old},v1=${oldSig}`));
  await assert.rejects(verifyWebhook({}, body, `t=${t},v1=${sig}`));
});

test('webhook signatures: the Connect endpoint has its own secret, and either is accepted', async () => {
  const env = { STRIPE_WEBHOOK_SECRET: 'whsec_platform', STRIPE_ACCOUNTS_WEBHOOK_SECRET: 'whsec_connect' };
  const body = JSON.stringify({ id: 'evt_2', type: 'account.updated', account: 'acct_1' });
  const t = Math.floor(Date.now() / 1000);
  for (const k of ['whsec_platform', 'whsec_connect']) assert.equal((await verifyWebhook(env, body, `t=${t},v1=${await hmacHex(k, `${t}.${body}`)}`)).id, 'evt_2');
  await assert.rejects(verifyWebhook(env, body, `t=${t},v1=${await hmacHex('whsec_other', `${t}.${body}`)}`));
});

test('every Stripe request names one pinned API version', () => {
  assert.match(STRIPE_API_VERSION, /^\d{4}-\d{2}-\d{2}\.[a-z]+$/);
  assert.match(readFileSync(new URL('../src/stripe.ts', import.meta.url), 'utf8'), /'stripe-version': STRIPE_API_VERSION/);
});

test('daily automatic payouts send each ready creator their available balance once', async () => {
  const { autoPayouts } = await import('../src/payouts.ts');
  const env = await setup();
  env.STRIPE_SECRET_KEY = 'rk_test_x'; env.STRIPE_API_BASE = 'https://stripe.test';
  const db = env.DB.sql;
  db.prepare("INSERT INTO users (id, email, name, pw_hash, created_at, stripe_account, stripe_payouts_enabled) VALUES ('u_maker', 'm@x.test', 'M', 'x', 0, 'acct_m', 1)").run();
  db.prepare("INSERT INTO users (id, email, name, pw_hash, created_at, stripe_account, stripe_payouts_enabled) VALUES ('u_other', 'o@x.test', 'O', 'x', 0, 'acct_o', 0)").run();
  db.prepare("INSERT INTO ledger (user_id, kind, amount_cents, ref, available_at, created_at) VALUES ('u_other', 'sale', 9000, 'x', 0, 0)").run();
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('withdraw_min_cents', '500', 0)").run();
  const calls = [], real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: String(init.body), key: init.headers['idempotency-key'], version: init.headers['stripe-version'] }); return new Response(JSON.stringify({ id: 'tr_1' })); };
  try {
    await autoPayouts(env);
    await autoPayouts(env);   // nothing left the second time
  } finally { globalThis.fetch = real; }
  assert.equal(calls.length, 1);   // u_other's account is not ready
  assert.match(calls[0].url, /\/v1\/transfers$/);
  assert.match(calls[0].body, /amount=900&currency=usd&destination=acct_m/);
  assert.equal(calls[0].version, STRIPE_API_VERSION);
  assert.equal(await total(env), 0);
  assert.equal(db.prepare("SELECT status FROM withdrawals WHERE user_id = 'u_maker'").get().status, 'paid');
});

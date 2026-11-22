// Game refunds (src/refunds.ts): the policy (within 1 day of buying, under 10 minutes played, once per game), every
// reason listed when a purchase is not refundable, the instant self-service refund and its books (the creator's credit
// back, the platform's cut given back, Stripe's kept fee borne by whoever the setting says, a Transfer reversed when the
// creator was already paid), the requests that go to the platform instead (an account refunding too often, play time
// that could not be confirmed, Stripe not answering), the admin's decisions, the held credit while a request is open,
// and build skills that never refund. Real migrations, in-memory SQLite, Stripe stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { recordPurchase, balanceOf, owns } = await import('../src/earnings.ts');
const { refundReasons, refundStates, gameRefundState, requestRefund, decideRefund, adminRefund, purchaseHistory, setRefundReview, overRefundLimit } = await import('../src/refunds.ts');
const { SETTING_DEFS } = await import('../src/settings.ts');
const { startWithdrawal } = await import('../src/payouts.ts');

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

const defaults = Object.fromEntries(Object.entries(SETTING_DEFS).map(([k, d]) => [k, d.v]));
const S = { ...defaults, earnings_hold_days: 0, new_creator_days: 0 };
const SALE = { ...S, refund_window_hours: 0 };   // recording sales without a hold, so balances are easy to read

function stubPay({ fail = false, fee = 59 } = {}) {
  const calls = { refunds: [], reversals: [] };
  return {
    calls,
    async refund(pi, purchaseId) { if (fail) throw new Error('Stripe could not be reached'); calls.refunds.push({ pi, purchaseId }); return 're_' + purchaseId; },
    async fee() { return fee; },
    async reverseTransfer(tr, amount, key) { calls.reversals.push({ tr, amount, key }); },
  };
}

async function world() {
  const DB = d1(), t = Date.now();
  DB.sql.prepare("INSERT INTO users (id, email, name, pw_hash, role, status, created_at) VALUES ('u_maker', 'm@x.test', 'Maker', '', 'user', 'active', 0), ('u_buyer', 'b@x.test', 'Buyer', '', 'user', 'active', 0)").run();
  for (const [id, slug] of [['g1', 'g'], ['g2', 'h'], ['g3', 'i'], ['g4', 'j'], ['g5', 'k']]) DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, price_cents, created_at, updated_at) VALUES (?, 'u_maker', ?, ?, 'live', 1000, 0, 0)").run(id, slug, 'Game ' + slug);
  const env = { DB };
  await buy(env, 'g1', 'pi_1');
  return { env, t };
}
async function buy(env, project, pi) {
  await recordPurchase(env, SALE, { userId: 'u_buyer', projectId: project, ownerId: 'u_maker', title: 'G', priceCents: 1000, provider: 'stripe', providerRef: 'cs_' + pi, paymentIntent: pi });
  return env.DB.sql.prepare('SELECT * FROM purchases WHERE payment_intent = ?').get(pi);
}
const play = (env, project, seconds, extra = 0) => {
  const t = Date.now();
  env.DB.sql.prepare("INSERT INTO plays (id, project_id, version, env, user_id, started_at, last_beat_at, seen_at, seconds) VALUES (?, ?, 1, 'live', 'u_buyer', ?, ?, ?, 0)")
    .run('pl_' + Math.random().toString(36).slice(2), project, t - seconds * 1000, t + extra * 1000, t);
};
const state = async (env, project = 'g1', s = S) => gameRefundState(env, s, 'u_buyer', project);

test('the policy: within 1 day of buying and under 10 minutes played, every failing reason listed', () => {
  assert.equal(SETTING_DEFS.refund_window_hours.v, 24);
  assert.equal(SETTING_DEFS.refund_max_play_minutes.v, 10);
  assert.equal(SETTING_DEFS.refund_fee_bearer.v, 'platform');
  const at = Date.now(), p = { status: 'paid', provider: 'stripe', payment_intent: 'pi', price_cents: 1000, created_at: at - 3600000 };
  assert.deepEqual(refundReasons(S, p, 9 * 60 + 59, at), []);
  assert.deepEqual(refundReasons(S, p, 10 * 60, at), ['played']);
  assert.deepEqual(refundReasons(S, { ...p, created_at: at - 24 * 3600000 }, 0, at), ['window']);
  assert.deepEqual(refundReasons(S, { ...p, created_at: at - 25 * 3600000 }, 900, at, { refundedBefore: true }), ['window', 'played', 'refunded_before']);
  assert.deepEqual(refundReasons(S, { ...p, provider: 'admin', payment_intent: null }, 0, at), ['not_charged']);
  assert.deepEqual(refundReasons({ ...S, refund_window_hours: 0 }, p, 0, at), ['off']);
  assert.deepEqual(refundReasons(S, { ...p, status: 'refunded' }, 0, at), ['not_paid']);
  assert.deepEqual(refundReasons(S, p, 0, at, { request: { status: 'denied' } }), ['denied']);
  assert.equal(overRefundLimit({ refund_limit_count: 3 }, 3), true);
  assert.equal(overRefundLimit({ refund_limit_count: 3 }, 2), false);
  assert.equal(overRefundLimit({ refund_limit_count: 0 }, 99), false);
});

test('the page gets the state: enabled, or greyed out with the reasons; play time is the platform clock', async () => {
  const { env } = await world();
  let st = await state(env);
  assert.equal(st.refundable, true);
  assert.deepEqual(st.reasons, []);
  assert.equal(st.max_play_seconds, 600);
  play(env, 'g1', 9 * 60);
  assert.equal((await state(env)).refundable, true);
  play(env, 'g1', 60);   // a second session: 10 minutes in all
  st = await state(env);
  assert.equal(st.refundable, false);
  assert.deepEqual(st.reasons, ['played']);
  assert.equal(st.played_seconds, 600);
  env.DB.sql.prepare("UPDATE purchases SET created_at = ? WHERE id = ?").run(Date.now() - 30 * 3600000, st.purchase_id);
  assert.deepEqual((await state(env)).reasons, ['window', 'played']);
  assert.equal(await state(env, 'g2'), null, 'not bought: no refund state');
  // the server refuses too, whatever the page shows
  await assert.rejects(requestRefund(env, S, 'u_buyer', st.purchase_id, '', stubPay()), (e) => e.code === 'not_refundable' && /1 day|24 hours/.test(e.message) && /10 minutes/.test(e.message));
});

test('an eligible refund goes through at once, with the books: creator credit back, platform cut given back, the platform absorbs the Stripe fee', async () => {
  const { env } = await world(), pay = stubPay({ fee: 59 });
  const p = env.DB.sql.prepare("SELECT * FROM purchases WHERE payment_intent = 'pi_1'").get();
  assert.equal((await balanceOf(env, 'u_maker')).total, 900);
  const r = await requestRefund(env, S, 'u_buyer', p.id, 'Not my kind of game', pay);
  assert.equal(r.status, 'refunded');
  assert.equal(pay.calls.refunds.length, 1);
  assert.equal(await owns(env, 'u_buyer', 'g1'), false);
  assert.equal((await balanceOf(env, 'u_maker')).total, 0, 'the platform bears the fee: the creator gives back only their credit');
  const row = env.DB.sql.prepare('SELECT * FROM refund_requests WHERE id = ?').get(r.id);
  assert.equal(row.status, 'refunded');
  assert.equal(row.decided_by, 'auto');
  assert.equal(row.refund_ref, 're_' + p.id);
  assert.equal(row.platform_fee_cents, 100);
  assert.equal(row.creator_net_cents, 900);
  assert.equal(row.stripe_fee_cents, 59);
  assert.equal(row.fee_bearer, 'platform');
  assert.equal(row.note, 'Not my kind of game');
  // once per purchase, and once per game: bought again, the second purchase is final
  await assert.rejects(requestRefund(env, S, 'u_buyer', p.id, '', pay), /already/);
  const again = await buy(env, 'g1', 'pi_1b');
  const st = await state(env);
  assert.equal(st.purchase_id, again.id);
  assert.deepEqual(st.reasons, ['refunded_before']);
  await assert.rejects(requestRefund(env, S, 'u_buyer', again.id, '', pay), (e) => e.code === 'not_refundable');
  // the history lists both, the refunded one without a button
  const h = await purchaseHistory(env, S, 'u_buyer', 'https://x.test');
  assert.deepEqual(h.purchases.map((x) => x.status), ['paid', 'refunded']);
  assert.deepEqual(h.purchases[0].refund.reasons, ['refunded_before']);
});

test('the creator can be made to bear the Stripe fee', async () => {
  const { env } = await world();
  const p = env.DB.sql.prepare("SELECT * FROM purchases WHERE payment_intent = 'pi_1'").get();
  await requestRefund(env, { ...S, refund_fee_bearer: 'creator' }, 'u_buyer', p.id, '', stubPay({ fee: 59 }));
  assert.equal((await balanceOf(env, 'u_maker')).total, -59);
  assert.equal(env.DB.sql.prepare("SELECT fee_bearer FROM refund_requests").get().fee_bearer, 'creator');
});

test('an account that refunds too often loses self-service: its refunds become requests the platform decides', async () => {
  const { env } = await world(), pay = stubPay(), lim = { ...S, refund_limit_count: 2, refund_limit_days: 30 };
  const a = env.DB.sql.prepare("SELECT id FROM purchases WHERE payment_intent = 'pi_1'").get();
  const b = await buy(env, 'g2', 'pi_2'), c = await buy(env, 'g3', 'pi_3'), d = await buy(env, 'g4', 'pi_4');
  assert.equal((await requestRefund(env, lim, 'u_buyer', a.id, '', pay)).status, 'refunded');
  assert.equal((await requestRefund(env, lim, 'u_buyer', b.id, '', pay)).status, 'refunded');
  assert.equal((await state(env, 'g3', lim)).review, true, 'the page says it will be a request');
  const r = await requestRefund(env, lim, 'u_buyer', c.id, '', pay);
  assert.deepEqual([r.status, r.review_reason], ['pending', 'frequent']);
  assert.equal(pay.calls.refunds.length, 2, 'no money moved for the third');
  assert.ok(env.DB.sql.prepare("SELECT refund_review_at FROM users WHERE id = 'u_buyer'").get().refund_review_at, 'self-service is off from now on');
  // the open request holds the creator's credit for that sale
  const bal = await balanceOf(env, 'u_maker');
  assert.equal(bal.held, 900);
  assert.equal(bal.available, 900, 'g4 is available, g3 is held');
  await assert.rejects(startWithdrawal(env, 'u_maker', 1800, 'manual'), /balance changed/);
  // even a limit switched off later keeps it off until an admin gives it back
  assert.equal((await requestRefund(env, { ...lim, refund_limit_count: 0 }, 'u_buyer', d.id, '', pay)).review_reason, 'account');
  await assert.rejects(requestRefund(env, lim, 'u_buyer', c.id, '', pay), /already asked/);
  // the admin decides: refund one, decline the other with a reason the buyer reads
  const reqC = env.DB.sql.prepare('SELECT id FROM refund_requests WHERE purchase_id = ?').get(c.id).id;
  const reqD = env.DB.sql.prepare('SELECT id FROM refund_requests WHERE purchase_id = ?').get(d.id).id;
  assert.equal(await decideRefund(env, lim, 'u_admin', reqC, 'approve', '', pay), 'refunded');
  assert.equal(await decideRefund(env, lim, 'u_admin', reqD, 'deny', 'Too many refunds this month.', pay), 'denied');
  assert.equal(await owns(env, 'u_buyer', 'g3'), false);
  assert.equal(await owns(env, 'u_buyer', 'g4'), true);
  const st = await state(env, 'g4', lim);
  assert.deepEqual(st.reasons, ['denied']);
  assert.equal(st.request.decision_note, 'Too many refunds this month.');
  assert.equal((await balanceOf(env, 'u_maker')).held, 0);
  await assert.rejects(decideRefund(env, lim, 'u_admin', reqC, 'approve', '', pay), /No open refund request/);
  await setRefundReview(env, 'u_buyer', false);
  const e = await buy(env, 'g5', 'pi_5');
  assert.equal((await state(env, 'g5', { ...lim, refund_limit_count: 0 })).review, false);
  assert.equal((await requestRefund(env, { ...lim, refund_limit_count: 0 }, 'u_buyer', e.id, '', pay)).status, 'refunded');
});

test('play time the platform could not confirm, or Stripe not answering, sends the refund to the platform', async () => {
  const { env } = await world();
  const p = env.DB.sql.prepare("SELECT id FROM purchases WHERE payment_intent = 'pi_1'").get();
  play(env, 'g1', 60, 600);   // the game's heartbeats ran ten minutes past the page's last check-in
  const r = await requestRefund(env, S, 'u_buyer', p.id, '', stubPay());
  assert.deepEqual([r.status, r.review_reason], ['pending', 'play_unconfirmed']);
  assert.equal(await owns(env, 'u_buyer', 'g1'), true);
  const { env: env2 } = await world();
  const p2 = env2.DB.sql.prepare("SELECT id FROM purchases WHERE payment_intent = 'pi_1'").get();
  const r2 = await requestRefund(env2, S, 'u_buyer', p2.id, '', stubPay({ fail: true }));
  assert.deepEqual([r2.status, r2.review_reason], ['pending', 'refund_failed']);
  assert.equal(await owns(env2, 'u_buyer', 'g1'), true, 'nothing changed hands');
  assert.equal((await balanceOf(env2, 'u_maker')).total, 900);
  // the admin tries again
  assert.equal(await decideRefund(env2, S, 'u_admin', r2.id, 'approve', '', stubPay()), 'refunded');
  assert.equal((await balanceOf(env2, 'u_maker')).total, 0);
});

test('an admin refund after the creator was paid reverses that much of their Transfer', async () => {
  const { env } = await world(), pay = stubPay();
  const p = env.DB.sql.prepare("SELECT id FROM purchases WHERE payment_intent = 'pi_1'").get();
  // the creator withdrew the 900 and Stripe sent the Transfer
  const w = await startWithdrawal(env, 'u_maker', 900, 'manual');
  env.DB.sql.prepare("UPDATE withdrawals SET method = 'stripe', status = 'paid', provider_ref = 'tr_1', settled_at = ? WHERE id = ?").run(Date.now(), w.id);
  assert.equal((await balanceOf(env, 'u_maker')).total, 0);
  await adminRefund(env, S, 'u_admin', p.id, pay);
  assert.deepEqual(pay.calls.reversals, [{ tr: 'tr_1', amount: 900, key: 'refund-reversal:' + p.id }]);
  assert.equal((await balanceOf(env, 'u_maker')).total, 0, 'the money came back from the payout: nothing owed');
  const row = env.DB.sql.prepare('SELECT * FROM refund_requests WHERE purchase_id = ?').get(p.id);
  assert.deepEqual([row.status, row.transfer_ref, row.transfer_reversal_cents, row.decided_by], ['refunded', 'tr_1', 900, 'admin:u_admin']);
  await assert.rejects(adminRefund(env, S, 'u_admin', p.id, pay), /Already refunded/);
});

test('build skills never refund: no state, no request, the admin refund refuses them', async () => {
  const { env } = await world();
  await recordPurchase(env, SALE, { userId: 'u_buyer', projectId: 'g2', ownerId: 'u_maker', title: 'G', priceCents: 1500, provider: 'stripe', providerRef: 'cs_skill', paymentIntent: 'pi_skill', item: 'skill' });
  const sk = env.DB.sql.prepare('SELECT id FROM skill_purchases').get();
  assert.equal(await state(env, 'g2'), null);
  await assert.rejects(requestRefund(env, S, 'u_buyer', sk.id, '', stubPay()), (e) => e.code === 'skill_non_refundable');
  await assert.rejects(adminRefund(env, S, 'u_admin', sk.id, stubPay()), (e) => e.code === 'skill_non_refundable');
  const h = await purchaseHistory(env, S, 'u_buyer', 'https://x.test');
  const skill = h.purchases.find((x) => x.item === 'skill');
  assert.equal(skill.refund, null);
});

test('a refund from the Stripe Dashboard settles an open request too', async () => {
  const { env } = await world();
  const { refundPurchase } = await import('../src/earnings.ts');
  const p = env.DB.sql.prepare("SELECT id FROM purchases WHERE payment_intent = 'pi_1'").get();
  const r = await requestRefund(env, { ...S, refund_auto: false }, 'u_buyer', p.id, '', stubPay());
  assert.deepEqual([r.status, r.review_reason], ['pending', 'manual']);
  await refundPurchase(env, { paymentIntent: 'pi_1' });
  const row = env.DB.sql.prepare('SELECT status, decided_by FROM refund_requests WHERE id = ?').get(r.id);
  assert.deepEqual([row.status, row.decided_by], ['refunded', 'payment']);
});

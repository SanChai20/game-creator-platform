// Gifts between friends (src/gifts.ts): only friends can gift (not strangers, not across a block, not to yourself), a game
// the recipient owns or made cannot be gifted, a gift request is one per friend and game and can be declined or
// cancelled with the other side told, a paid gift lands with the recipient (not the payer) and credits the creator
// exactly like a sale, both sides are notified once, and gifts are non-refundable for the recipient, for the payer and
// for the admin console, while a Stripe-side refund still takes the game and the credit back. Real migrations, SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { recordPurchase, balanceOf, owns, refundPurchase, splitSale } = await import('../src/earnings.ts');
const { gameRefundState, requestRefund, adminRefund, purchaseHistory } = await import('../src/refunds.ts');
const { askForGift, cancelGiftRequest, checkGift, declineGift, gameGiftState, giftDelivered, giftOverview, giftableFriends, giftCleanupStmts, GIFT_REQUEST_DAYS } = await import('../src/gifts.ts');
const { noteFor } = await import('../src/push-core.ts');
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

const defaults = Object.fromEntries(Object.entries(SETTING_DEFS).map(([k, d]) => [k, d.v]));
const S = { ...defaults, earnings_hold_days: 0, new_creator_days: 0 };
const stubPay = () => { const calls = []; return { calls, async refund(pi, id) { calls.push(pi); return 're_' + id; }, async fee() { return 0; }, async reverseTransfer() {} }; };

function world() {
  const DB = d1();
  const users = [['u_maker', 'Maker'], ['u_ana', 'Ana'], ['u_ben', 'Ben'], ['u_cy', 'Cy'], ['u_dee', 'Dee']];
  for (const [id, name] of users) DB.sql.prepare("INSERT INTO users (id, email, name, pw_hash, role, status, created_at) VALUES (?, ?, ?, '', 'user', 'active', 0)").run(id, id + '@x.test', name);
  DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, price_cents, created_at, updated_at) VALUES ('g1', 'u_maker', 'star', 'Star', 'live', 1000, 0, 0), ('g2', 'u_maker', 'free', 'Free', 'live', 0, 0, 0)").run();
  // Ana and Ben are friends, Ana and Dee are friends; Cy is a stranger to both; Ana and the maker are friends
  for (const [a, b] of [['u_ana', 'u_ben'], ['u_ana', 'u_dee'], ['u_ana', 'u_maker']]) DB.sql.prepare('INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, 0), (?, ?, 0)').run(a, b, b, a);
  return { DB };
}
const game = (env, id = 'g1') => env.DB.sql.prepare('SELECT * FROM projects WHERE id = ?').get(id);
const notes = (env, uid) => env.DB.sql.prepare('SELECT kind, actor_id, data, read_at FROM notifications WHERE user_id = ? ORDER BY id').all(uid);
/** What api.ts applySession does for a paid gift: record it as the recipient's purchase, then deliver it. */
async function payGift(env, giver, recipient, ref = 'cs_' + giver + recipient) {
  const p = game(env);
  const fresh = await recordPurchase(env, S, { userId: recipient, projectId: p.id, ownerId: p.owner_id, title: p.title, priceCents: 1000, provider: 'stripe', providerRef: ref, paymentIntent: 'pi_' + ref, giftedBy: giver });
  const row = env.DB.sql.prepare('SELECT * FROM purchases WHERE provider_ref = ?').get(ref);
  return { fresh, row, delivered: await giftDelivered(env, { purchaseId: row.id, giver, recipient, project: p }) };
}

test('only friends can gift: not strangers, not across a block, not yourself', async () => {
  const env = world();
  await checkGift(env, S, 'u_ben', 'u_ana', game(env));
  await assert.rejects(checkGift(env, S, 'u_cy', 'u_ana', game(env)), (e) => e.code === 'not_friends');
  await assert.rejects(checkGift(env, S, 'u_ben', 'u_ben', game(env)), /yourself/);
  env.DB.sql.prepare("INSERT INTO blocks (user_id, blocked_id, created_at) VALUES ('u_ana', 'u_ben', 0)").run();
  await assert.rejects(checkGift(env, S, 'u_ben', 'u_ana', game(env)), (e) => e.code === 'not_friends');
  await assert.rejects(askForGift(env, S, 'u_ana', 'u_ben', game(env)), (e) => e.code === 'not_friends');
  await assert.rejects(askForGift(env, S, 'u_ana', 'u_cy', game(env)), (e) => e.code === 'not_friends');
});

test('a game the recipient owns or made, a free game, or gifts turned off: refused', async () => {
  const env = world();
  await assert.rejects(checkGift(env, S, 'u_ana', 'u_maker', game(env)), (e) => e.code === 'own_game');
  await recordPurchase(env, S, { userId: 'u_ana', projectId: 'g1', ownerId: 'u_maker', title: 'Star', priceCents: 1000, provider: 'stripe', providerRef: 'cs_own', paymentIntent: 'pi_own' });
  await assert.rejects(checkGift(env, S, 'u_ben', 'u_ana', game(env)), (e) => e.code === 'already_owned');
  await assert.rejects(askForGift(env, S, 'u_ana', 'u_ben', game(env)), (e) => e.code === 'already_owned');
  await assert.rejects(checkGift(env, S, 'u_ana', 'u_ben', game(env, 'g2')), /free/);
  await assert.rejects(checkGift(env, { ...S, gifts_enabled: false }, 'u_ana', 'u_ben', game(env)), /turned off/);
  await assert.rejects(checkGift(env, { ...S, paid_games_enabled: false }, 'u_ana', 'u_ben', game(env)), /turned off/);
  // the friend picker marks who already has it
  const f = await giftableFriends(env, 'u_ben', game(env));
  assert.deepEqual(f.map((x) => [x.name, x.owned]), [['Ana', true]]);
  const fa = await giftableFriends(env, 'u_ana', game(env));
  assert.deepEqual(fa.map((x) => [x.name, x.owned]), [['Ben', false], ['Dee', false], ['Maker', true]]);
});

test('a gift request: one per friend and game, the friend is notified, a decline tells the asker', async () => {
  const env = world();
  const a = await askForGift(env, S, 'u_ana', 'u_ben', game(env), '  please!  ');
  assert.equal(a.created, true);
  assert.equal(a.request.note, 'please!');
  assert.equal((await askForGift(env, S, 'u_ana', 'u_ben', game(env))).created, false, 'asking twice keeps one request');
  const n = notes(env, 'u_ben');
  assert.equal(n.length, 1);
  assert.equal(n[0].kind, 'gift_request');
  assert.equal(JSON.parse(n[0].data).project.slug, 'star');
  // both sides see it
  assert.equal((await giftOverview(env, 'u_ben')).incoming[0].friend.name, 'Ana');
  assert.equal((await giftOverview(env, 'u_ana')).outgoing[0].friend.name, 'Ben');
  assert.deepEqual((await gameGiftState(env, S, 'u_ben', game(env))).asked_by.map((x) => x.friend.name), ['Ana']);
  // only the asked friend can decline it
  await assert.rejects(declineGift(env, 'u_ana', a.request.id), /no longer open/);
  await declineGift(env, 'u_ben', a.request.id);
  assert.equal(notes(env, 'u_ben')[0].read_at > 0, true, "the friend's request notification is cleared");
  assert.equal(notes(env, 'u_ana').at(-1).kind, 'gift_declined');
  assert.equal((await giftOverview(env, 'u_ben')).incoming.length, 0);
  // asking again after a decline is a new request
  assert.equal((await askForGift(env, S, 'u_ana', 'u_ben', game(env))).created, true);
});

test('the asker can cancel; an unfriended request disappears; lapsed requests close', async () => {
  const env = world();
  const a = await askForGift(env, S, 'u_ana', 'u_ben', game(env));
  await assert.rejects(cancelGiftRequest(env, 'u_ben', a.request.id), /no longer open/);
  await cancelGiftRequest(env, 'u_ana', a.request.id);
  assert.equal(env.DB.sql.prepare('SELECT status FROM gift_requests WHERE id = ?').get(a.request.id).status, 'cancelled');
  assert.ok(notes(env, 'u_ben')[0].read_at);
  await askForGift(env, S, 'u_ana', 'u_dee', game(env));
  env.DB.sql.prepare("DELETE FROM friendships WHERE (user_id = 'u_ana' AND friend_id = 'u_dee') OR (user_id = 'u_dee' AND friend_id = 'u_ana')").run();
  assert.equal((await giftOverview(env, 'u_dee')).incoming.length, 0, 'no longer friends: the request is not shown');
  await assert.rejects(checkGift(env, S, 'u_dee', 'u_ana', game(env)), (e) => e.code === 'not_friends');
  const later = Date.now() + (GIFT_REQUEST_DAYS + 1) * 86400000;
  for (const s of giftCleanupStmts(env, later)) await s.run();
  assert.equal(env.DB.sql.prepare("SELECT COUNT(*) AS n FROM gift_requests WHERE status = 'pending'").get().n, 0);
});

test('a paid gift lands with the recipient, credits the creator like a sale, and both sides are told once', async () => {
  const env = world();
  await askForGift(env, S, 'u_ana', 'u_ben', game(env));
  await askForGift(env, S, 'u_ana', 'u_dee', game(env));
  const { fresh, row, delivered } = await payGift(env, 'u_ben', 'u_ana');
  assert.equal(fresh, true);
  assert.equal(delivered, true);
  assert.equal(row.user_id, 'u_ana');
  assert.equal(row.gifted_by, 'u_ben');
  assert.equal(await owns(env, 'u_ana', 'g1'), true, 'the recipient owns it');
  assert.equal(await owns(env, 'u_ben', 'g1'), false, 'the payer does not');
  // the creator's share is exactly a normal sale's
  const split = splitSale(1000, S);
  assert.equal(row.fee_cents, split.fee);
  assert.equal(row.net_cents, split.net);
  assert.equal((await balanceOf(env, 'u_maker')).total, split.net);
  assert.equal(env.DB.sql.prepare("SELECT sales FROM projects WHERE id = 'g1'").get().sales, 1);
  assert.match(env.DB.sql.prepare('SELECT note FROM ledger WHERE ref = ?').get(row.id).note, /^Gift sale of Star/);
  // requests: the one to Ben is gifted, the one to Dee closed (Ana has the game now)
  const reqs = env.DB.sql.prepare('SELECT to_id, status, purchase_id FROM gift_requests ORDER BY to_id').all();
  assert.deepEqual(reqs.map((r) => [r.to_id, r.status]), [['u_ben', 'gifted'], ['u_dee', 'closed']]);
  assert.equal(reqs[0].purchase_id, row.id);
  assert.equal(notes(env, 'u_ana').filter((n) => n.kind === 'gift_received').length, 1);
  assert.equal(notes(env, 'u_ben').filter((n) => n.kind === 'gift_sent').length, 1);
  assert.ok(notes(env, 'u_dee').every((n) => n.read_at), "Dee's request notification is cleared");
  // the webhook and the return page both apply the session: recorded and notified once
  assert.equal(await recordPurchase(env, S, { userId: 'u_ana', projectId: 'g1', ownerId: 'u_maker', title: 'Star', priceCents: 1000, provider: 'stripe', providerRef: 'cs_u_benu_ana', paymentIntent: 'pi_x', giftedBy: 'u_ben' }), false);
  assert.equal(await giftDelivered(env, { purchaseId: row.id, giver: 'u_ben', recipient: 'u_ana', project: game(env) }), false);
  assert.equal((await balanceOf(env, 'u_maker')).total, split.net);
  // a second friend's gift paid at the same time cannot make a second paid row (api.ts refunds that payment)
  await assert.rejects(recordPurchase(env, S, { userId: 'u_ana', projectId: 'g1', ownerId: 'u_maker', title: 'Star', priceCents: 1000, provider: 'stripe', providerRef: 'cs_dee', paymentIntent: 'pi_dee', giftedBy: 'u_dee' }), /UNIQUE/);
  assert.equal((await balanceOf(env, 'u_maker')).total, split.net);
  // the lists
  const ov = await giftOverview(env, 'u_ana');
  assert.deepEqual(ov.received.map((g) => g.friend.name), ['Ben']);
  assert.deepEqual((await giftOverview(env, 'u_ben')).sent.map((g) => g.friend.name), ['Ana']);
});

test('gifts are non-refundable for the recipient, the payer and the admin; a Stripe-side refund still reverses it', async () => {
  const env = world(), pay = stubPay();
  const { row } = await payGift(env, 'u_ben', 'u_ana');
  const st = await gameRefundState(env, S, 'u_ana', 'g1');
  assert.equal(st.refundable, false);
  assert.deepEqual(st.reasons, ['gift']);
  await assert.rejects(requestRefund(env, S, 'u_ana', row.id, '', pay), (e) => e.code === 'gift_non_refundable');
  await assert.rejects(requestRefund(env, S, 'u_ben', row.id, '', pay), /No such purchase/, 'the payer has no purchase to refund');
  await assert.rejects(adminRefund(env, S, 'u_admin', row.id, pay), (e) => e.code === 'gift_non_refundable');
  assert.equal(pay.calls.length, 0, 'no money moved');
  const h = await purchaseHistory(env, S, 'u_ana', 'https://x.test');
  assert.equal(h.purchases[0].gift, true);
  assert.equal(h.purchases[0].gifted_by.name, 'Ben');
  // a refund made in the Stripe Dashboard (or a lost chargeback) still takes the game and the creator's credit back
  assert.equal(await refundPurchase(env, { paymentIntent: row.payment_intent }), true);
  assert.equal(await owns(env, 'u_ana', 'g1'), false);
  assert.equal((await balanceOf(env, 'u_maker')).total, 0);
});

test('push notifications for gifts', () => {
  const g = { slug: 'star', title: 'Star' };
  assert.equal(noteFor({ kind: 'gift_request', from: { id: 'u_ana', name: 'Ana' }, game: g, request: 'gfr_1' }, 'en').title, 'Ana would like Star as a gift');
  assert.equal(noteFor({ kind: 'gift_request', from: { id: 'u_ana', name: 'Ana' }, game: g, request: 'gfr_1' }, 'en').url, '/gifts');
  assert.equal(noteFor({ kind: 'gift_received', from: { id: 'u_ben', name: 'Ben' }, game: g }, 'en').title, 'Ben gave you Star');
  assert.equal(noteFor({ kind: 'gift_received', from: { id: 'u_ben', name: 'Ben' }, game: g }, 'en').kind, 'gifts');
  assert.equal(noteFor({ kind: 'gift_sent', by: { id: 'u_ana', name: 'Ana' }, game: g, mine: true }, 'en'), null);
});

test("a friend's refunded duplicate gift does not count as the recipient's own refund, and stays out of their history", async () => {
  const env = world(), t = Date.now();
  // Dee's gift payment arrived after Ana already had the game: given back, kept on record as refunded (api.ts)
  env.DB.sql.prepare("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, provider_ref, payment_intent, status, created_at, refunded_at, gifted_by) VALUES ('pur_dup', 'u_ana', 'g1', 'u_maker', 1000, 0, 0, 'stripe', 'cs_dup', 'pi_dup', 'refunded', ?, ?, 'u_dee')").run(t, t);
  await recordPurchase(env, S, { userId: 'u_ana', projectId: 'g1', ownerId: 'u_maker', title: 'Star', priceCents: 1000, provider: 'stripe', providerRef: 'cs_mine', paymentIntent: 'pi_mine' });
  const st = await gameRefundState(env, { ...S, refund_limit_count: 1 }, 'u_ana', 'g1');
  assert.equal(st.refundable, true, 'her own purchase is still refundable');
  assert.equal(st.review, false, 'and the duplicate does not count towards her refund limit');
  const h = await purchaseHistory(env, S, 'u_ana', 'https://x.test');
  assert.deepEqual(h.purchases.map((x) => x.id).includes('pur_dup'), false);
});

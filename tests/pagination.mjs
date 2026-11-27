// Server-side pagination helpers & list queries (src/paging.ts, src/refunds.ts, src/gifts.ts, src/follows.js,
// src/social-rules.js, src/player-data.js, src/store-quality.ts, src/feedback.ts, src/skills.ts). Real SQLite + migrations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { parsePage, pageMeta } = await import('../src/paging.ts');
const { recordPurchase } = await import('../src/earnings.ts');
const { purchaseHistory, adminRefundRequestsPage } = await import('../src/refunds.ts');
const { askForGift, giftDelivered, giftOverview } = await import('../src/gifts.ts');
const { follow, followingPage } = await import('../src/follows.js');
const { block, listBlockedPage } = await import('../src/social-rules.js');
const { continueList } = await import('../src/player-data.js');
const { fileReport, reportQueuePage } = await import('../src/store-quality.ts');
const { listFeedback } = await import('../src/feedback.ts');
const { storeList } = await import('../src/skills.ts');
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
  const batch = async (list) => {
    sql.exec('BEGIN');
    try { const out = []; for (const s of list) out.push(await s.run()); sql.exec('COMMIT'); return out; }
    catch (e) { sql.exec('ROLLBACK'); throw e; }
  };
  return { prepare: (q) => stmt(q), batch, sql };
}

const defaults = Object.fromEntries(Object.entries(SETTING_DEFS).map(([k, d]) => [k, d.v]));
const S = { ...defaults, earnings_hold_days: 0, new_creator_days: 0 };

test('parsePage and pageMeta handle page/per_page, offset/limit, clamping, and edge cases', () => {
  const q = (obj) => (k) => obj[k];
  assert.deepEqual(parsePage(q({}), 20, 100), { page: 1, per_page: 20, limit: 20, offset: 0 });
  assert.deepEqual(parsePage(q({ page: '3', per_page: '15' }), 20, 100), { page: 3, per_page: 15, limit: 15, offset: 30 });
  assert.deepEqual(parsePage(q({ page: '-5', per_page: '999' }), 20, 50), { page: 1, per_page: 50, limit: 50, offset: 0 });
  assert.deepEqual(parsePage(q({ offset: '40', limit: '20' }), 10, 100), { page: 3, per_page: 20, limit: 20, offset: 40 });
  assert.deepEqual(parsePage(q({ page: 'abc', per_page: '0' }), 12, 100), { page: 1, per_page: 12, limit: 12, offset: 0 });

  assert.deepEqual(pageMeta(0, 1, 20), { total: 0, page: 1, per_page: 20, pages: 1 });
  assert.deepEqual(pageMeta(45, 2, 20), { total: 45, page: 2, per_page: 20, pages: 3 });
  assert.deepEqual(pageMeta(40, 2, 20), { total: 40, page: 2, per_page: 20, pages: 2 });
});

test('purchaseHistory paginates combined game and skill purchases in chronological order', async () => {
  const DB = d1();
  const env = { DB };
  DB.sql.prepare("INSERT INTO users (id, email, name, pw_hash, role, status, created_at) VALUES ('u_maker', 'm@x.test', 'Maker', '', 'user', 'active', 0), ('u_buyer', 'b@x.test', 'Buyer', '', 'user', 'active', 0)").run();
  for (let i = 1; i <= 4; i++) {
    DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, price_cents, open_implementation, created_at, updated_at) VALUES (?, 'u_maker', ?, ?, 'live', 500, 1, 0, 0)").run(`g${i}`, `game-${i}`, `Game ${i}`);
  }
  // Interleave 3 game purchases and 2 skill purchases with distinct created_at
  for (const [idx, ts] of [[1, 1000], [2, 3000], [3, 5000]]) {
    DB.sql.prepare("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, provider_ref, status, created_at) VALUES (?, 'u_buyer', ?, 'u_maker', 500, 50, 450, 'stripe', ?, 'paid', ?)").run(`pur_${idx}`, `g${idx}`, `ref_g${idx}`, ts);
  }
  for (const [idx, ts] of [[1, 2000], [4, 4000]]) {
    DB.sql.prepare("INSERT INTO skill_purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, provider_ref, status, created_at) VALUES (?, 'u_buyer', ?, 'u_maker', 300, 15, 285, 'stripe', ?, 'paid', ?)").run(`sp_${idx}`, `g${idx}`, `ref_s${idx}`, ts);
  }

  const p1 = await purchaseHistory(env, S, 'u_buyer', 'https://hearthcade.com', { limit: 2, offset: 0 });
  const p2 = await purchaseHistory(env, S, 'u_buyer', 'https://hearthcade.com', { limit: 2, offset: 2 });
  const p3 = await purchaseHistory(env, S, 'u_buyer', 'https://hearthcade.com', { limit: 2, offset: 4 });

  assert.equal(p1.total, 5);
  assert.deepEqual(p1.purchases.map((x) => [x.item, x.id]), [['game', 'pur_3'], ['skill', 'sp_4']]);
  assert.deepEqual(p2.purchases.map((x) => [x.item, x.id]), [['game', 'pur_2'], ['skill', 'sp_1']]);
  assert.deepEqual(p3.purchases.map((x) => [x.item, x.id]), [['game', 'pur_1']]);
});

test('giftOverview paginates all four sections independently with exact totals', async () => {
  const DB = d1();
  const env = { DB };
  for (const [id, name] of [['u_maker', 'Maker'], ['u_me', 'Me'], ['u_f1', 'F1'], ['u_f2', 'F2'], ['u_f3', 'F3']]) {
    DB.sql.prepare("INSERT INTO users (id, email, name, pw_hash, role, status, created_at) VALUES (?, ?, ?, '', 'user', 'active', 0)").run(id, `${id}@x.test`, name);
  }
  for (const f of ['u_f1', 'u_f2', 'u_f3']) {
    DB.sql.prepare('INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, 0), (?, ?, 0)').run('u_me', f, f, 'u_me');
  }
  for (let i = 1; i <= 4; i++) {
    DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, price_cents, created_at, updated_at) VALUES (?, 'u_maker', ?, ?, 'live', 1000, 0, 0)").run(`g${i}`, `g-${i}`, `G${i}`);
  }
  const t = Date.now();
  const g1 = DB.sql.prepare("SELECT * FROM projects WHERE id = 'g1'").get();
  const g2 = DB.sql.prepare("SELECT * FROM projects WHERE id = 'g2'").get();
  const g3 = DB.sql.prepare("SELECT * FROM projects WHERE id = 'g3'").get();
  const g4 = DB.sql.prepare("SELECT * FROM projects WHERE id = 'g4'").get();

  // 3 incoming requests to u_me (for g1)
  await askForGift(env, S, 'u_f1', 'u_me', g1, '', t + 1);
  await askForGift(env, S, 'u_f2', 'u_me', g1, '', t + 2);
  await askForGift(env, S, 'u_f3', 'u_me', g1, '', t + 3);
  // 2 outgoing requests from u_me (for g4, which u_me does not receive)
  await askForGift(env, S, 'u_me', 'u_f1', g4, '', t + 4);
  await askForGift(env, S, 'u_me', 'u_f2', g4, '', t + 5);
  // 2 received gifts by u_me (g1, g2), 2 sent gifts by u_me (g3)
  for (const [idx, g] of [[1, g1], [2, g2]]) {
    await recordPurchase(env, S, { userId: 'u_me', projectId: g.id, ownerId: 'u_maker', title: g.title, priceCents: 1000, provider: 'stripe', providerRef: `rc_${idx}`, paymentIntent: `pi_rc_${idx}`, giftedBy: `u_f${idx}` });
    const row = DB.sql.prepare('SELECT * FROM purchases WHERE provider_ref = ?').get(`rc_${idx}`);
    await giftDelivered(env, { purchaseId: row.id, giver: `u_f${idx}`, recipient: 'u_me', project: g }, t + 10 + idx);
  }
  for (const [idx, f] of [[1, 'u_f1'], [2, 'u_f2']]) {
    await recordPurchase(env, S, { userId: f, projectId: g3.id, ownerId: 'u_maker', title: g3.title, priceCents: 1000, provider: 'stripe', providerRef: `sn_${idx}`, paymentIntent: `pi_sn_${idx}`, giftedBy: 'u_me' });
    const row = DB.sql.prepare('SELECT * FROM purchases WHERE provider_ref = ?').get(`sn_${idx}`);
    await giftDelivered(env, { purchaseId: row.id, giver: 'u_me', recipient: f, project: g3 }, t + 20 + idx);
  }

  const ov1 = await giftOverview(env, 'u_me', t + 100, {
    incoming: { limit: 2, offset: 0 },
    outgoing: { limit: 1, offset: 0 },
    received: { limit: 1, offset: 0 },
    sent: { limit: 1, offset: 1 },
  });
  assert.deepEqual(ov1.totals, { incoming: 3, outgoing: 2, received: 2, sent: 2 });
  assert.equal(ov1.incoming.length, 2);
  assert.equal(ov1.outgoing.length, 1);
  assert.equal(ov1.received.length, 1);
  assert.equal(ov1.sent.length, 1);

  const ov2 = await giftOverview(env, 'u_me', t + 100, { incoming: { limit: 2, offset: 2 } });
  assert.equal(ov2.incoming.length, 1);
  assert.equal(ov2.totals.incoming, 3);
});

test('followingPage, listBlockedPage, continueList, reportQueuePage, listFeedback, adminRefundRequestsPage, storeList paginate accurately', async () => {
  const DB = d1();
  const env = { DB };
  const t = Date.now();
  DB.sql.prepare("INSERT INTO users (id, email, name, pw_hash, role, status, created_at) VALUES ('u_me', 'me@x.test', 'Me', '', 'user', 'active', 0)").run();
  for (let i = 1; i <= 5; i++) {
    DB.sql.prepare("INSERT INTO users (id, email, name, pw_hash, role, status, creator, created_at) VALUES (?, ?, ?, '', 'user', 'active', 1, 0)").run(`u_${i}`, `u${i}@x.test`, `User ${i}`);
    DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, price_cents, open_implementation, live_version, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'live', 0, 1, 1, ?, ?, ?)").run(`p_${i}`, `u_${i}`, `slug-${i}`, `Game ${i}`, t + i, t + i, t + i);
    DB.sql.prepare("INSERT INTO game_skills (project_id, version, description, content, written_by, created_at, updated_at) VALUES (?, 1, 'How it works', '# Skill', 'agent', ?, ?)").run(`p_${i}`, t + i, t + i);
  }

  // followingPage
  for (let i = 1; i <= 5; i++) await follow(DB, 'u_me', `u_${i}`, undefined, t + i);
  const f1 = await followingPage(DB, 'u_me', { limit: 2, offset: 0 });
  const f3 = await followingPage(DB, 'u_me', { limit: 2, offset: 4 });
  assert.equal(f1.total, 5);
  assert.equal(f1.following.length, 2);
  assert.equal(f3.following.length, 1);

  // listBlockedPage
  for (let i = 1; i <= 3; i++) await block(DB, 'u_me', `u_${i}`, t + i);
  const b1 = await listBlockedPage(DB, 'u_me', { limit: 2, offset: 0 });
  const b2 = await listBlockedPage(DB, 'u_me', { limit: 2, offset: 2 });
  assert.equal(b1.total, 3);
  assert.equal(b1.blocked.length, 2);
  assert.equal(b2.blocked.length, 1);

  // continueList
  for (let i = 1; i <= 4; i++) {
    DB.sql.prepare("INSERT INTO player_games (user_id, project_id, first_at, last_at, sessions, seconds) VALUES ('u_me', ?, ?, ?, 1, 120)").run(`p_${i}`, t + i, t + i);
  }
  const c1 = await continueList(DB, 'u_me', { limit: 2, offset: 0 });
  const c2 = await continueList(DB, 'u_me', { limit: 2, offset: 2 });
  assert.equal(c1.total, 4);
  assert.equal(c1.more, true);
  assert.equal(c1.list.length, 2);
  assert.equal(c2.total, 4);
  assert.equal(c2.more, false);
  assert.equal(c2.list.length, 2);

  // reportQueuePage
  for (let i = 1; i <= 3; i++) {
    const proj = DB.sql.prepare('SELECT * FROM projects WHERE id = ?').get(`p_${i}`);
    await fileReport(env, S, proj, 'u_me', 'broken', 'crashes', t + i);
  }
  const rq1 = await reportQueuePage(env, S, { limit: 2, offset: 0 });
  const rq2 = await reportQueuePage(env, S, { limit: 2, offset: 2 });
  assert.equal(rq1.total, 3);
  assert.equal(rq1.games.length, 2);
  assert.equal(rq2.games.length, 1);

  // listFeedback
  const p1 = DB.sql.prepare("SELECT * FROM projects WHERE id = 'p_1'").get();
  for (let i = 1; i <= 4; i++) {
    DB.sql.prepare("INSERT INTO feedback (id, project_id, owner_id, version, note, marks, context, created_at) VALUES (?, 'p_1', 'u_1', 1, ?, '[]', '{}', ?)").run(`fb_${i}`, `Note ${i}`, t + i);
  }
  const fb1 = await listFeedback(env, p1, { limit: 2, offset: 0 });
  const fb2 = await listFeedback(env, p1, { limit: 2, offset: 2 });
  assert.equal(fb1.total, 4);
  assert.equal(fb1.items.length, 2);
  assert.equal(fb2.items.length, 2);

  // adminRefundRequestsPage
  for (let i = 1; i <= 3; i++) {
    DB.sql.prepare("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, provider_ref, status, created_at) VALUES (?, 'u_me', ?, ?, 500, 50, 450, 'stripe', ?, 'paid', ?)").run(`rp_${i}`, `p_${i}`, `u_${i}`, `rref_${i}`, t + i);
    DB.sql.prepare("INSERT INTO refund_requests (id, purchase_id, user_id, project_id, owner_id, price_cents, status, note, played_seconds, bought_at, review_reason, created_at) VALUES (?, ?, 'u_me', ?, ?, 500, 'pending', 'test', 0, ?, 'manual', ?)").run(`rr_${i}`, `rp_${i}`, `p_${i}`, `u_${i}`, t + i, t + i);
  }
  const rr1 = await adminRefundRequestsPage(env, { limit: 2, offset: 0 });
  const rr2 = await adminRefundRequestsPage(env, { limit: 2, offset: 2 });
  assert.equal(rr1.total, 3);
  assert.equal(rr1.waiting, 3);
  assert.equal(rr1.refunds.length, 2);
  assert.equal(rr2.refunds.length, 1);

  // storeList (Creator Store pagination)
  const st1 = await storeList(env, 'https://hearthcade.com', null, { limit: 2, offset: 0 });
  const st3 = await storeList(env, 'https://hearthcade.com', null, { limit: 2, offset: 4 });
  assert.equal(st1.total, 5);
  assert.equal(st1.page, 1);
  assert.equal(st1.pages, 3);
  assert.equal(st1.skills.length, 2);
  assert.equal(st3.page, 3);
  assert.equal(st3.skills.length, 1);
});

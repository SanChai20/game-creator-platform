// Back office: every product parameter, every user, every game, sales, payments and withdrawals.
import { Hono } from 'hono';
import { bad, notFound, type Env, type User } from '../env';
import { requireAdmin } from '../auth';
import { balanceOf, recordPurchase, refundPurchase } from '../earnings';
import { getProject, logEvent } from '../projects';
import { getSettings, putSettings, SETTING_DEFS } from '../settings';
import { stripe, stripeReady } from '../stripe';
import { undeployGame } from '../deploy';
import { addDays, dayOf, now, rid } from '../util';
import { grantCreator, reverseWithdrawal, takeOffline } from './api';

export const admin = new Hono<{ Bindings: Env; Variables: { user: User | null; origin: string } }>();
admin.use('*', async (c, next) => { requireAdmin(c as any); await next(); });

admin.get('/overview', async (c) => {
  const db = c.env.DB, since = addDays(dayOf(now()), -29), t30 = now() - 30 * 86400000;
  const [users, games, plays, sales, fees, owed, pendingW, daily, signups, salesDaily] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n, SUM(creator) AS creators, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS new30 FROM users").bind(t30).first<any>(),
    db.prepare("SELECT COUNT(*) AS n, SUM(status = 'live') AS live, SUM(status = 'live' AND price_cents > 0) AS paid, SUM(status = 'draft') AS draft, SUM(status = 'offline') AS offline, SUM(status = 'removed') AS removed FROM projects").first<any>(),
    db.prepare('SELECT COALESCE(SUM(plays), 0) AS plays, COALESCE(SUM(seconds), 0) AS seconds, COALESCE(SUM(sessions), 0) AS sessions FROM game_daily WHERE day >= ?').bind(since).first<any>(),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price_cents), 0) AS gross, COALESCE(SUM(fee_cents), 0) AS fees, COALESCE(SUM(net_cents), 0) AS net, COALESCE(SUM(CASE WHEN created_at >= ?1 THEN price_cents ELSE 0 END), 0) AS gross30, COALESCE(SUM(CASE WHEN created_at >= ?1 THEN fee_cents ELSE 0 END), 0) AS fees30 FROM purchases WHERE status = 'paid'").bind(t30).first<any>(),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total, COALESCE(SUM(CASE WHEN created_at >= ? THEN amount_cents ELSE 0 END), 0) AS total30 FROM payments WHERE kind = 'creator_fee' AND status = 'paid' AND provider = 'stripe'").bind(t30).first<any>(),
    db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS c FROM ledger').first<any>(),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS c FROM withdrawals WHERE status = 'pending'").first<any>(),
    db.prepare('SELECT day, SUM(sessions) AS sessions, SUM(plays) AS plays, SUM(seconds) AS seconds FROM game_daily WHERE day >= ? GROUP BY day ORDER BY day').bind(since).all(),
    db.prepare("SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day ORDER BY day").bind(t30).all(),
    db.prepare("SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n, SUM(price_cents) AS gross, SUM(fee_cents) AS fees FROM purchases WHERE status = 'paid' AND created_at >= ? GROUP BY day ORDER BY day").bind(t30).all(),
  ]);
  return c.json({
    users, games, plays, sales, creator_fees: fees, owed_cents: owed?.c || 0, pending_withdrawals: pendingW, daily: daily.results, signups: signups.results, sales_daily: salesDaily.results,
    health: { payments: stripeReady(c.env), webhook: !!c.env.STRIPE_WEBHOOK_SECRET, deploy: !!(c.env.CF_API_TOKEN && c.env.CF_ACCOUNT_ID) || c.env.DEPLOY_DRIVER === 'local', browser: !!c.env.BROWSER || !!(c.env as any).VERIFIER_URL, driver: c.env.DEPLOY_DRIVER },
  });
});

admin.get('/settings', async (c) => c.json({ defs: SETTING_DEFS, values: await getSettings(c.env, true) }));
admin.put('/settings', async (c) => c.json({ values: await putSettings(c.env, await c.req.json<Record<string, unknown>>()) }));

admin.get('/users', async (c) => {
  const q = (c.req.query('q') || '').trim(), like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.status, u.creator, u.created_at, u.last_seen_at, u.stripe_payouts_enabled, u.payout_country,
       (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id AND p.status != 'removed') AS projects,
       (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id AND p.status = 'live') AS live,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM ledger l WHERE l.user_id = u.id) AS balance,
       (SELECT COUNT(*) FROM purchases x WHERE x.user_id = u.id AND x.status = 'paid') AS bought,
       (SELECT COALESCE(SUM(seconds), 0) FROM plays y WHERE y.user_id = u.id AND y.kind = 'player') AS played
     FROM users u WHERE ?1 = '' OR u.email LIKE ?2 ESCAPE '\\' OR u.name LIKE ?2 ESCAPE '\\' ORDER BY u.created_at DESC LIMIT 200`).bind(q, like).all();
  return c.json({ users: rows.results });
});

admin.patch('/users/:id', async (c) => {
  const me = requireAdmin(c as any), id = c.req.param('id'), b = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>));
  const u = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(id).first<{ id: string; role: string }>();
  if (!u) throw notFound();
  if (b.creator === true) await grantCreator(c.env, id, 'admin', 'grant:' + id + ':' + rid(6), 0);
  if (b.creator === false) await c.env.DB.prepare('UPDATE users SET creator = 0 WHERE id = ?').bind(id).run();
  if (b.status === 'active' || b.status === 'suspended') {
    if (id === me.id) throw bad('You cannot suspend yourself.');
    await c.env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(b.status, id).run();
    if (b.status === 'suspended') await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  }
  if (b.role === 'admin' || b.role === 'user') { if (id === me.id) throw bad('You cannot change your own role.'); await c.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(b.role, id).run(); }
  if (typeof b.adjust_cents === 'number' && Number.isFinite(b.adjust_cents) && b.adjust_cents !== 0) {
    await c.env.DB.prepare("INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at) VALUES (?, 'adjustment', ?, ?, ?, ?, ?)").bind(id, Math.round(b.adjust_cents), 'admin:' + me.id, String(b.note || 'Adjustment by admin').slice(0, 200), now(), now()).run();
  }
  return c.json({ ok: true, balance: await balanceOf(c.env, id) });
});

admin.get('/games', async (c) => {
  const q = (c.req.query('q') || '').trim(), like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%', since = addDays(dayOf(now()), -6);
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.title, p.status, p.featured, p.price_cents, p.sales, p.plays, p.seconds, p.rating_sum, p.rating_count, p.live_version, p.preview_version, p.created_at, p.published_at, p.removed_reason, p.cover_key,
       u.name AS author, u.email AS author_email,
       (SELECT COALESCE(SUM(plays), 0) FROM game_daily d WHERE d.project_id = p.id AND d.day >= ?3) AS plays7,
       (SELECT COALESCE(SUM(net_cents), 0) FROM purchases x WHERE x.project_id = p.id AND x.status = 'paid') AS net,
       (SELECT COALESCE(SUM(fee_cents), 0) FROM purchases x WHERE x.project_id = p.id AND x.status = 'paid') AS fees,
       (SELECT COALESCE(SUM(count), 0) FROM client_errors e WHERE e.project_id = p.id AND e.env = 'live') AS errors
     FROM projects p JOIN users u ON u.id = p.owner_id WHERE ?1 = '' OR p.title LIKE ?2 ESCAPE '\\' OR p.slug LIKE ?2 ESCAPE '\\' OR u.email LIKE ?2 ESCAPE '\\'
     ORDER BY (p.status = 'live') DESC, p.plays DESC, p.updated_at DESC LIMIT 300`).bind(q, like, since).all<any>();
  return c.json({ games: rows.results.map((g) => ({ ...g, cover: g.cover_key ? `${c.get('origin')}/api/media/${g.cover_key}` : null })) });
});

admin.patch('/games/:id', async (c) => {
  const p = await getProject(c.env, c.req.param('id')), b = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>));
  if (!p) throw notFound();
  if (typeof b.featured === 'boolean') await c.env.DB.prepare('UPDATE projects SET featured = ? WHERE id = ?').bind(b.featured ? 1 : 0, p.id).run();
  if (b.action === 'offline' && p.status === 'live') await takeOffline(c.env, p, 'admin');
  if (b.action === 'remove') {
    await c.env.DB.prepare("UPDATE projects SET status = 'removed', removed_reason = ?, updated_at = ? WHERE id = ?").bind(String(b.reason || 'Removed by the platform').slice(0, 300), now(), p.id).run();
    await undeployGame(c.env, p.id, 'live'); await undeployGame(c.env, p.id, 'preview');
    await logEvent(c.env, p.id, 'removed', String(b.reason || ''), null, 'admin');
  }
  if (b.action === 'restore' && p.status === 'removed') await c.env.DB.prepare("UPDATE projects SET status = ?, removed_reason = NULL WHERE id = ?").bind(p.live_version ? 'offline' : 'draft', p.id).run();
  return c.json({ ok: true });
});

admin.get('/money', async (c) => {
  const db = c.env.DB;
  const [purchases, payments, withdrawals] = await Promise.all([
    db.prepare('SELECT x.id, x.price_cents, x.fee_cents, x.net_cents, x.status, x.provider, x.created_at, p.title, p.slug, b.email AS buyer, o.email AS creator FROM purchases x JOIN projects p ON p.id = x.project_id JOIN users b ON b.id = x.user_id JOIN users o ON o.id = x.owner_id ORDER BY x.created_at DESC LIMIT 200').all(),
    db.prepare('SELECT y.id, y.amount_cents, y.provider, y.status, y.created_at, u.email FROM payments y JOIN users u ON u.id = y.user_id ORDER BY y.created_at DESC LIMIT 200').all(),
    db.prepare('SELECT w.id, w.amount_cents, w.method, w.details, w.status, w.error, w.provider_ref, w.created_at, w.settled_at, u.email, u.name FROM withdrawals w JOIN users u ON u.id = w.user_id ORDER BY (w.status = \'pending\') DESC, w.created_at DESC LIMIT 200').all(),
  ]);
  return c.json({ purchases: purchases.results, payments: payments.results, withdrawals: withdrawals.results });
});

admin.post('/withdrawals/:id', async (c) => {
  const b = await c.req.json<{ action?: string; note?: string }>().catch(() => ({} as any));
  const w = await c.env.DB.prepare('SELECT * FROM withdrawals WHERE id = ?').bind(c.req.param('id')).first<{ id: string; user_id: string; amount_cents: number; status: string }>();
  if (!w) throw notFound();
  if (w.status !== 'pending') throw bad('Only a pending withdrawal can be settled.');
  if (b.action === 'paid') await c.env.DB.prepare("UPDATE withdrawals SET status = 'paid', provider_ref = ?, settled_at = ? WHERE id = ?").bind(String(b.note || 'manual').slice(0, 120), now(), w.id).run();
  else if (b.action === 'reject') await reverseWithdrawal(c.env, w.id, w.user_id, w.amount_cents, 'rejected', String(b.note || 'Rejected by admin'));
  else throw bad('action must be "paid" or "reject".');
  return c.json({ ok: true });
});

admin.post('/purchases/:id/refund', async (c) => {
  const x = await c.env.DB.prepare('SELECT * FROM purchases WHERE id = ?').bind(c.req.param('id')).first<{ id: string; status: string; provider: string; payment_intent: string | null }>();
  if (!x) throw notFound();
  if (x.status !== 'paid') throw bad('Already refunded.');
  if (x.provider === 'stripe' && x.payment_intent) await stripe(c.env, 'POST', '/refunds', { payment_intent: x.payment_intent }, 'refund:' + x.id);
  await refundPurchase(c.env, { id: x.id });
  return c.json({ ok: true });
});

// Give a player a paid game without charging (support cases, testing). Credits the creator nothing.
admin.post('/grant-game', async (c) => {
  const b = await c.req.json<{ email?: string; slug?: string; credit?: boolean }>().catch(() => ({} as any));
  const u = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(String(b.email || '').toLowerCase()).first<{ id: string }>();
  const p = await getProject(c.env, String(b.slug || ''));
  if (!u || !p) throw notFound('User or game not found.');
  const s = await getSettings(c.env);
  await recordPurchase(c.env, b.credit ? s : { ...s, platform_fee_percent: 100, sale_processing_percent: 0, sale_processing_fixed_cents: 0 }, { userId: u.id, projectId: p.id, ownerId: p.owner_id, title: p.title, priceCents: b.credit ? p.price_cents : 0, provider: 'admin', providerRef: 'grant:' + rid(12) });
  return c.json({ ok: true });
});


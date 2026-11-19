// Back office: every product parameter, every user, every game, sales, payments and withdrawals.
import { Hono } from 'hono';
import { bad, notFound, type Env, type User } from '../env';
import { requireAdmin } from '../auth';
import { balanceOf, recordPurchase, refundPurchase } from '../earnings';
import { getProject, logEvent } from '../projects';
import { getSettings, putSettings, SETTING_DEFS } from '../settings';
import { stripe, stripeReady } from '../stripe';
import { rolloutRuntime, undeployGame } from '../deploy';
import { auditFiles } from '../audit';
import { disableTwoFactor } from '../two-factor';
import { dbSize } from '../db-guard';
import { enqueue } from '../pipeline';
import { hostId, hostingProblems } from '../hosting';
import { decideRequest, setGameStorage, MB } from '../storage';
import { addDays, dayOf, now, rid } from '../util';
import { currentPicks, JOBS } from '../rankings';
import { reverseWithdrawal, takeOffline } from './api';
import { grantLicense, isPlan, revokeLicense } from '../license';

export const admin = new Hono<{ Bindings: Env; Variables: { user: User | null; origin: string } }>();
admin.use('*', async (c, next) => { requireAdmin(c as any); await next(); });

// Brings game Workers up to this build's runtime now, instead of waiting for the scheduled rollout (16 every 10 minutes).
// Run it again while `remaining` is above 0. A security fix to the runtime reaches every game this way.
admin.post('/hosting/rollout', async (c) => c.json(await rolloutRuntime(c.env, 25)));

// One page of the games bucket checked against the database (src/audit.ts). Pass the returned cursor to go on.
admin.post('/audit/files', async (c) => {
  const b = await c.req.json<{ cursor?: string; limit?: number }>().catch(() => ({} as { cursor?: string; limit?: number }));
  return c.json(await auditFiles(c.env, typeof b.cursor === 'string' && b.cursor ? b.cursor : undefined, Number(b.limit) || 500));
});

admin.get('/overview', async (c) => {
  const db = c.env.DB, since = addDays(dayOf(now()), -29), t30 = now() - 30 * 86400000;
  const [users, games, plays, sales, fees, owed, pendingW, daily, signups, salesDaily, flags, ai, runs, picks] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN creator = 1 AND (creator_plan IS NOT 'term' OR creator_until > ?2) THEN 1 ELSE 0 END) AS creators, SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END) AS new30 FROM users").bind(t30, now()).first<any>(),
    db.prepare("SELECT COUNT(*) AS n, SUM(status = 'live') AS live, SUM(status = 'live' AND price_cents > 0) AS paid, SUM(status = 'draft') AS draft, SUM(status = 'offline') AS offline, SUM(status = 'removed') AS removed FROM projects").first<any>(),
    db.prepare('SELECT COALESCE(SUM(plays), 0) AS plays, COALESCE(SUM(seconds), 0) AS seconds, COALESCE(SUM(sessions), 0) AS sessions FROM game_daily WHERE day >= ?').bind(since).first<any>(),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price_cents), 0) AS gross, COALESCE(SUM(fee_cents), 0) AS fees, COALESCE(SUM(net_cents), 0) AS net, COALESCE(SUM(CASE WHEN created_at >= ?1 THEN price_cents ELSE 0 END), 0) AS gross30, COALESCE(SUM(CASE WHEN created_at >= ?1 THEN fee_cents ELSE 0 END), 0) AS fees30 FROM purchases WHERE status = 'paid'").bind(t30).first<any>(),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total, COALESCE(SUM(CASE WHEN created_at >= ? THEN amount_cents ELSE 0 END), 0) AS total30 FROM payments WHERE kind = 'creator_fee' AND status IN ('paid', 'revoked') AND provider = 'stripe'").bind(t30).first<any>(),
    db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS c FROM ledger').first<any>(),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS c FROM withdrawals WHERE status = 'pending'").first<any>(),
    db.prepare('SELECT day, SUM(sessions) AS sessions, SUM(plays) AS plays, SUM(seconds) AS seconds FROM game_daily WHERE day >= ? GROUP BY day ORDER BY day').bind(since).all(),
    db.prepare("SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day ORDER BY day").bind(t30).all(),
    db.prepare("SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n, SUM(price_cents) AS gross, SUM(fee_cents) AS fees FROM purchases WHERE status = 'paid' AND created_at >= ? GROUP BY day ORDER BY day").bind(t30).all(),
    db.prepare("SELECT e.kind, e.detail, e.version, e.created_at, p.id, p.title, p.slug, u.email FROM events e JOIN projects p ON p.id = e.project_id JOIN users u ON u.id = p.owner_id WHERE e.kind IN ('copy_flagged', 'not_game_flagged', 'player_report') ORDER BY e.id DESC LIMIT 30").all(),
    db.prepare("SELECT purpose, SUM(calls) AS calls FROM ai_usage WHERE day >= ? GROUP BY purpose").bind(since).all(),
    db.prepare('SELECT job, last_run_at, last_ok_at, last_error, last_error_at, runs FROM job_runs').all<Record<string, any>>(),
    currentPicks(db),
  ]);
  // the scheduled jobs (src/rankings.ts): each one's last run, so a stuck job shows without anyone having to watch it
  const ran = new Map(runs.results.map((r) => [r.job, r]));
  const jobs = JOBS.map((j) => { const r = ran.get(j.job); return { ...j, last_run_at: r?.last_run_at ?? null, last_ok_at: r?.last_ok_at ?? null, last_error: r && r.last_error_at && (!r.last_ok_at || r.last_error_at > r.last_ok_at) ? r.last_error : null, runs: r?.runs || 0 }; });
  return c.json({
    users, games, plays, sales, creator_fees: fees, owed_cents: owed?.c || 0, pending_withdrawals: pendingW, daily: daily.results, signups: signups.results, sales_daily: salesDaily.results, flags: flags.results, ai_calls_30d: ai.results,
    jobs, picks: picks.map((p) => ({ id: p.id, slug: p.slug, title: p.title, reason: p.pick })),
    health: { payments: stripeReady(c.env), webhook: !!c.env.STRIPE_WEBHOOK_SECRET, accounts_webhook: !!c.env.STRIPE_ACCOUNTS_WEBHOOK_SECRET, deploy: (!!(c.env.CF_API_TOKEN && c.env.CF_ACCOUNT_ID) && !hostingProblems(c.env).length) || c.env.DEPLOY_DRIVER === 'local', hosting: hostId(c.env), hosting_problems: hostingProblems(c.env), browser: !!c.env.BROWSER || !!(c.env as any).VERIFIER_URL, driver: c.env.DEPLOY_DRIVER, db_bytes: await dbSize(c.env) },
  });
});

admin.get('/settings', async (c) => c.json({ defs: SETTING_DEFS, values: await getSettings(c.env, true) }));
admin.put('/settings', async (c) => c.json({ values: await putSettings(c.env, await c.req.json<Record<string, unknown>>()) }));

// Admin lists are paged (50 a page, with the total) so they stay quick however many users and games there are.
const ADMIN_PAGE = 50;
const pageOf = (c: { req: { query: (k: string) => string | undefined } }) => Math.max(0, Math.min(10000, (Number(c.req.query('page')) || 1) - 1)) * ADMIN_PAGE;

admin.get('/users', async (c) => {
  const q = (c.req.query('q') || '').trim(), like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%', off = pageOf(c);
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.status, u.creator, u.creator_plan, u.creator_until, u.created_at, u.last_seen_at, u.stripe_payouts_enabled, u.payout_country, (u.totp_enabled_at IS NOT NULL) AS two_factor,
       (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id AND p.status != 'removed') AS projects,
       (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id AND p.status = 'live') AS live,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM ledger l WHERE l.user_id = u.id) AS balance,
       (SELECT COUNT(*) FROM purchases x WHERE x.user_id = u.id AND x.status = 'paid') AS bought,
       (SELECT COALESCE(SUM(seconds), 0) FROM plays y WHERE y.user_id = u.id AND y.kind = 'player') AS played
     FROM users u WHERE ?1 = '' OR u.email LIKE ?2 ESCAPE '\\' OR u.name LIKE ?2 ESCAPE '\\' ORDER BY u.created_at DESC LIMIT ?3 OFFSET ?4`).bind(q, like, ADMIN_PAGE, off).all();
  const total = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users u WHERE ?1 = '' OR u.email LIKE ?2 ESCAPE '\\' OR u.name LIKE ?2 ESCAPE '\\'").bind(q, like).first<{ n: number }>();
  return c.json({ users: rows.results, total: total?.n || 0, per_page: ADMIN_PAGE });
});

admin.patch('/users/:id', async (c) => {
  const me = requireAdmin(c as any), id = c.req.param('id'), b = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>));
  const u = await c.env.DB.prepare('SELECT id, role, status FROM users WHERE id = ?').bind(id).first<{ id: string; role: string; status: string }>();
  if (!u) throw notFound();
  if (u.status === 'deleted') throw bad('This account was deleted by its owner.');
  // license: "lifetime" or "term" grants that kind (free, on record as an admin grant); "none" takes every grant back.
  // creator true / false are the older form of the same thing (true grants lifetime).
  const lic = b.license ?? (b.creator === true ? 'lifetime' : b.creator === false ? 'none' : undefined);
  if (lic !== undefined) {
    if (lic === 'none') await revokeLicense(c.env, id);
    else if (isPlan(lic)) { await revokeLicense(c.env, id); await grantLicense(c.env, await getSettings(c.env), id, lic, 'admin', 'grant:' + id + ':' + rid(6), 0, true); }
    else throw bad('license must be "term", "lifetime" or "none".');
  }
  if (b.status === 'active' || b.status === 'suspended') {
    if (id === me.id) throw bad('You cannot suspend yourself.');
    await c.env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(b.status, id).run();
    if (b.status === 'suspended') await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  }
  // For someone who lost both their authenticator and their recovery codes: after checking it is really them, an admin
  // turns two-factor off and they sign in with the password alone (and can turn it on again from their account).
  if (b.two_factor === false) {
    await disableTwoFactor(c.env, id);
    console.log(JSON.stringify({ event: 'two_factor_reset', user: id, by: me.id }));
  }
  if (b.role === 'admin' || b.role === 'user') { if (id === me.id) throw bad('You cannot change your own role.'); await c.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(b.role, id).run(); }
  if (typeof b.adjust_cents === 'number' && Number.isFinite(b.adjust_cents) && b.adjust_cents !== 0) {
    await c.env.DB.prepare("INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at) VALUES (?, 'adjustment', ?, ?, ?, ?, ?)").bind(id, Math.round(b.adjust_cents), 'admin:' + me.id, String(b.note || 'Adjustment by admin').slice(0, 200), now(), now()).run();
  }
  return c.json({ ok: true, balance: await balanceOf(c.env, id) });
});

admin.get('/games', async (c) => {
  const q = (c.req.query('q') || '').trim(), like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%', since = addDays(dayOf(now()), -6), off = pageOf(c);
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.title, p.status, p.featured, p.price_cents, p.sales, p.plays, p.seconds, p.rating_sum, p.rating_count, p.live_version, p.preview_version, p.created_at, p.published_at, p.removed_reason, p.cover_key, p.storage_bytes,
       (SELECT COALESCE(SUM(size), 0) FROM files f WHERE f.project_id = p.id) AS used_bytes,
       u.name AS author, u.email AS author_email,
       (SELECT COALESCE(SUM(plays), 0) FROM game_daily d WHERE d.project_id = p.id AND d.day >= ?3) AS plays7,
       (SELECT COALESCE(SUM(net_cents), 0) FROM purchases x WHERE x.project_id = p.id AND x.status = 'paid') AS net,
       (SELECT COALESCE(SUM(fee_cents), 0) FROM purchases x WHERE x.project_id = p.id AND x.status = 'paid') AS fees,
       (SELECT COALESCE(SUM(count), 0) FROM client_errors e WHERE e.project_id = p.id AND e.env = 'live') AS errors
     FROM projects p JOIN users u ON u.id = p.owner_id WHERE ?1 = '' OR p.title LIKE ?2 ESCAPE '\\' OR p.slug LIKE ?2 ESCAPE '\\' OR u.email LIKE ?2 ESCAPE '\\'
     ORDER BY (p.status = 'live') DESC, p.plays DESC, p.updated_at DESC LIMIT ?4 OFFSET ?5`).bind(q, like, since, ADMIN_PAGE, off).all<any>();
  const total = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM projects p JOIN users u ON u.id = p.owner_id WHERE ?1 = '' OR p.title LIKE ?2 ESCAPE '\\' OR p.slug LIKE ?2 ESCAPE '\\' OR u.email LIKE ?2 ESCAPE '\\'").bind(q, like).first<{ n: number }>();
  return c.json({ total: total?.n || 0, per_page: ADMIN_PAGE, games: rows.results.map((g) => ({ ...g, cover: g.cover_key ? `${c.get('origin')}/api/media/${g.cover_key}` : null })) });
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
  // storage: a number of MB for this game, or null for the platform default
  if (b.storage_mb !== undefined) await setGameStorage(c.env, p, b.storage_mb === null || b.storage_mb === '' ? null : Math.round(Number(b.storage_mb) * MB), 'admin');
  if (b.action === 'restore' && p.status === 'removed') await c.env.DB.prepare("UPDATE projects SET status = ?, removed_reason = NULL WHERE id = ?").bind(p.live_version ? 'offline' : 'draft', p.id).run();
  return c.json({ ok: true });
});

// Creators' requests for more storage: pending first, then the latest decisions.
admin.get('/storage-requests', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT r.*, p.title, p.slug, p.status AS game_status, p.storage_bytes, u.name AS author, u.email AS author_email,
       (SELECT COALESCE(SUM(size), 0) FROM files f WHERE f.project_id = r.project_id) AS used_now
     FROM storage_requests r JOIN projects p ON p.id = r.project_id JOIN users u ON u.id = r.user_id
     WHERE r.status = 'pending' OR r.decided_at > ? ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 100`).bind(now() - 30 * 86400000).all();
  return c.json({ requests: rows.results, default_bytes: (await getSettings(c.env)).bundle_max_bytes });
});

admin.post('/storage-requests/:id', async (c) => {
  const me = requireAdmin(c as any), b = await c.req.json<{ action?: string; megabytes?: number | string; note?: string }>().catch(() => ({} as any));
  if (b.action !== 'approve' && b.action !== 'deny') throw bad('action must be "approve" or "deny".');
  await decideRequest(c.env, me, c.req.param('id'), b.action === 'approve', b.megabytes, b.note);
  return c.json({ ok: true });
});

// Versions the verification browser could not run (WebGPU, or no browser): a person checks them before they go live.
admin.get('/reviews', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT v.project_id, v.n, v.note, v.review, v.review_note, v.reviewed_at, v.created_at, v.screenshot_key, v.report, p.title, p.slug, p.status AS game_status,
       u.name AS author, u.email AS author_email
     FROM versions v JOIN projects p ON p.id = v.project_id JOIN users u ON u.id = p.owner_id
     WHERE v.review = 'pending' OR v.reviewed_at > ? ORDER BY (v.review = 'pending') DESC, v.created_at DESC LIMIT 100`).bind(now() - 30 * 86400000).all<any>();
  const origin = c.get('origin');
  return c.json({ reviews: rows.results.map(({ report, screenshot_key, ...r }) => {
    const rep = JSON.parse(report || '{}');
    return { ...r, screenshot: screenshot_key ? `${origin}/api/media/${screenshot_key}` : null, why: rep.gpuLimited ? 'webgpu' : rep.browser === 'unavailable' ? 'no_browser' : 'other', summary: rep.summary || '' };
  }) });
});

admin.post('/reviews/:pid/:n', async (c) => {
  const me = requireAdmin(c as any), b = await c.req.json<{ action?: string; note?: string }>().catch(() => ({} as any));
  if (b.action !== 'approve' && b.action !== 'deny') throw bad('action must be "approve" or "deny".');
  const pid = c.req.param('pid'), n = Number(c.req.param('n')), note = String(b.note || '').slice(0, 500) || null;
  const r = await c.env.DB.prepare("UPDATE versions SET review = ?, review_note = ?, reviewed_at = ?, reviewed_by = ? WHERE project_id = ? AND n = ? AND review = 'pending'")
    .bind(b.action === 'approve' ? 'approved' : 'denied', note, now(), me.id, pid, n).run();
  if (!r.meta.changes) throw notFound('No pending review for that version.');
  await logEvent(c.env, pid, b.action === 'approve' ? 'review_approved' : 'review_denied', note || '', n, 'admin:' + me.id);
  // approved: it goes live now, as the creator asked when they called publish
  if (b.action === 'approve') await enqueue(c.env, { kind: 'publish', pid, n, origin: c.get('origin'), actor: 'admin:' + me.id });
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
  let done: boolean;
  if (b.action === 'paid') done = !!(await c.env.DB.prepare("UPDATE withdrawals SET status = 'paid', provider_ref = ?, settled_at = ? WHERE id = ? AND status = 'pending'").bind(String(b.note || 'manual').slice(0, 120), now(), w.id).run()).meta.changes;
  else if (b.action === 'reject') done = await reverseWithdrawal(c.env, w.id, w.user_id, w.amount_cents, 'rejected', String(b.note || 'Rejected by admin'));
  else throw bad('action must be "paid" or "reject".');
  if (!done) throw bad('This withdrawal was settled meanwhile. Reload to see how.');
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
  await recordPurchase(c.env, b.credit ? s : { ...s, platform_fee_percent: 100, sale_processing_percent: 0, sale_processing_fixed_cents: 0 }, { userId: u.id, projectId: p.id, ownerId: p.owner_id, title: p.title, priceCents: b.credit ? p.price_cents : 0, provider: 'admin', providerRef: 'grant:' + rid(12), openImplementation: !!p.open_implementation });
  return c.json({ ok: true });
});


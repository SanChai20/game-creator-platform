// The web app's API: accounts, marketplace, play sessions, purchases, the creator console and billing.
import { Hono } from 'hono';
import { AppError, bad, forbidden, notFound, type Env, type Project, type User } from '../env';
import { checkPassword, COOKIE, createSession, hashPassword, newUserId, rateLimit, readCookie, requireUser, sessionCookie, type Ctx } from '../auth';
import { gameUrl, playKey, undeployGame } from '../deploy';
import { balanceOf, owns, recordPurchase, refundPurchase, splitSale } from '../earnings';
import { enqueue } from '../pipeline';
import { getProject, getVersion, listFiles, logEvent, ownedProject, publicVersion, updateProjectMeta, versionEligible } from '../projects';
import { getSettings, SETTING_DEFS } from '../settings';
import { stripe, stripeReady, verifyWebhook } from '../stripe';
import { addDays, dayOf, now, parseJson, rid, sha256 } from '../util';
// @ts-ignore plain JS module
import { signPlayToken } from '../runtime/game-worker.js';

type App = { Bindings: Env; Variables: { user: User | null; origin: string } };
export const api = new Hono<App>();

const media = (origin: string, key: string | null) => (key ? `${origin}/api/media/${key}` : null);
const pubUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, role: u.role, creator: !!u.creator, creator_since: u.creator_since, payouts_enabled: !!u.stripe_payouts_enabled, has_payout_account: !!u.stripe_account, payout_country: u.payout_country });

function card(origin: string, r: Record<string, any>) {
  return {
    id: r.id, slug: r.slug, title: r.title, tagline: r.tagline, tags: parseJson<string[]>(r.tags, []), cover: media(origin, r.cover_key), price_cents: r.price_cents,
    plays: r.plays, minutes: Math.round(r.seconds / 60), rating: r.rating_count ? Math.round((r.rating_sum / r.rating_count) * 10) / 10 : null, rating_count: r.rating_count,
    author: r.author, featured: !!r.featured, published_at: r.published_at, status: r.status,
  };
}

// ----- config + auth ---------------------------------------------------------------------------
api.get('/config', async (c) => {
  const s = await getSettings(c.env), out: Record<string, unknown> = {};
  for (const [k, d] of Object.entries(SETTING_DEFS)) if ((d as { public?: boolean }).public) out[k] = (s as Record<string, unknown>)[k];
  return c.json({ settings: out, payments: stripeReady(c.env), mcp_url: `${c.get('origin')}/mcp`, origin: c.get('origin') });
});

api.get('/me', (c) => { const u = c.get('user'); return c.json({ user: u ? pubUser(u) : null }); });

api.post('/auth/signup', async (c) => {
  const b = await c.req.json<{ email?: string; name?: string; password?: string }>().catch(() => ({} as any)), s = await getSettings(c.env);
  if (!s.signups_open) throw forbidden('Sign-ups are closed right now.');
  await rateLimit(c.env, 'signup:' + (c.req.header('cf-connecting-ip') || 'x'), 10, 3600);
  const email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim().slice(0, 40), pw = String(b.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) throw bad('Enter a valid email address.');
  if (name.length < 2) throw bad('Choose a display name of at least 2 characters.');
  if (pw.length < 8 || pw.length > 200) throw bad('Password must be at least 8 characters.');
  if (await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) throw new AppError(409, 'An account with that email already exists. Sign in instead.', 'exists');
  const id = newUserId();
  await c.env.DB.prepare('INSERT INTO users (id, email, name, pw_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, email, name, await hashPassword(pw), now(), now()).run();
  c.header('set-cookie', await createSession(c.env, c.req.raw, id));
  return c.json({ ok: true });
});

api.post('/auth/login', async (c) => {
  const b = await c.req.json<{ email?: string; password?: string }>().catch(() => ({} as any));
  const email = String(b.email || '').trim().toLowerCase();
  await rateLimit(c.env, 'login:' + email, 10, 900);
  const u = await c.env.DB.prepare('SELECT id, pw_hash, status FROM users WHERE email = ?').bind(email).first<{ id: string; pw_hash: string; status: string }>();
  if (!u || !(await checkPassword(String(b.password || ''), u.pw_hash))) throw new AppError(401, 'Wrong email or password.', 'bad_login');
  if (u.status !== 'active') throw forbidden('This account is suspended.');
  await c.env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now(), u.id).run();
  c.header('set-cookie', await createSession(c.env, c.req.raw, u.id));
  return c.json({ ok: true });
});

api.post('/auth/logout', async (c) => {
  const t = readCookie(c.req.raw, COOKIE);
  if (t) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256(t)).run();
  c.header('set-cookie', sessionCookie(c.req.raw, '', 0));
  return c.json({ ok: true });
});

// ----- marketplace -----------------------------------------------------------------------------
api.get('/games', async (c) => {
  const sort = c.req.query('sort') || 'trending', q = (c.req.query('q') || '').trim().slice(0, 60), tag = (c.req.query('tag') || '').trim().toLowerCase().slice(0, 24), price = c.req.query('price') || '';
  const where = ["p.status = 'live'"], args: unknown[] = [];
  if (q) { where.push("(p.title LIKE ? ESCAPE '\\' OR p.tagline LIKE ? ESCAPE '\\')"); const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%'; args.push(like, like); }
  if (tag) { where.push("p.tags LIKE ? ESCAPE '\\'"); args.push('%"' + tag.replace(/[\\%_]/g, '\\$&') + '"%'); }
  if (price === 'free') where.push('p.price_cents = 0'); else if (price === 'paid') where.push('p.price_cents > 0');
  const order = sort === 'new' ? 'p.published_at DESC' : sort === 'top' ? '(p.rating_sum + 3.5 * 3) * 1.0 / (p.rating_count + 3) DESC, p.rating_count DESC' : sort === 'played' ? 'p.plays DESC' : 'p.featured DESC, recent DESC, p.plays DESC, p.published_at DESC';
  const rows = await c.env.DB.prepare(
    `SELECT p.*, u.name AS author, COALESCE((SELECT SUM(plays) * 4 + SUM(seconds) / 60 FROM game_daily d WHERE d.project_id = p.id AND d.day >= ?), 0) AS recent
     FROM projects p JOIN users u ON u.id = p.owner_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 60`).bind(addDays(dayOf(now()), -7), ...args).all();
  const tags = await c.env.DB.prepare("SELECT tags FROM projects WHERE status = 'live' LIMIT 500").all<{ tags: string }>();
  const counts = new Map<string, number>();
  for (const r of tags.results) for (const t of parseJson<string[]>(r.tags, [])) counts.set(t, (counts.get(t) || 0) + 1);
  return c.json({ games: rows.results.map((r) => card(c.get('origin'), r)), tags: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([t]) => t) });
});

async function liveGame(c: Ctx, slug: string): Promise<Project & { author: string }> {
  const p = await c.env.DB.prepare('SELECT p.*, u.name AS author FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.slug = ?').bind(slug).first<Project & { author: string }>();
  const u = c.get('user');
  if (!p || (p.status !== 'live' && !(u && (u.id === p.owner_id || u.role === 'admin')))) throw notFound('That game is not available.');
  return p;
}

api.get('/games/:slug', async (c) => {
  const p = await liveGame(c, c.req.param('slug')), u = c.get('user'), origin = c.get('origin');
  const reviews = await c.env.DB.prepare('SELECT r.rating, r.body, r.created_at, r.updated_at, u.name, r.user_id FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.project_id = ? AND r.hidden = 0 ORDER BY r.updated_at DESC LIMIT 50').bind(p.id).all<Record<string, any>>();
  const dist = await c.env.DB.prepare('SELECT rating, COUNT(*) AS n FROM reviews WHERE project_id = ? AND hidden = 0 GROUP BY rating').bind(p.id).all<{ rating: number; n: number }>();
  let mine = null, played = false, owned = p.price_cents === 0;
  if (u) {
    mine = await c.env.DB.prepare('SELECT rating, body FROM reviews WHERE project_id = ? AND user_id = ?').bind(p.id, u.id).first();
    played = !!(await c.env.DB.prepare("SELECT 1 FROM plays WHERE project_id = ? AND user_id = ? AND env = 'live' AND counted = 1 LIMIT 1").bind(p.id, u.id).first());
    owned = owned || u.id === p.owner_id || u.role === 'admin' || await owns(c.env, u.id, p.id);
  }
  const v = p.live_version ? await getVersion(c.env, p.id, p.live_version) : null;
  return c.json({
    game: { ...card(origin, p), description: p.description, controls: p.controls, version: p.live_version, updated_at: v?.published_at || p.updated_at, screenshot: media(origin, v?.screenshot_key || null), owner_id: p.owner_id },
    reviews: reviews.results.map((r) => ({ rating: r.rating, body: r.body, at: r.updated_at, name: r.name, mine: !!u && r.user_id === u.id })),
    rating_dist: [1, 2, 3, 4, 5].map((n) => dist.results.find((d) => d.rating === n)?.n || 0),
    my_review: mine, played, owned, is_owner: !!u && u.id === p.owner_id,
  });
});

async function startPlay(c: Ctx, p: Project, envName: 'live' | 'preview', version: number, u: User) {
  const kind = u.id === p.owner_id || u.role === 'admin' ? 'owner' : 'player', sid = 'ps_' + rid(16), t = now();
  await c.env.DB.prepare('INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(sid, p.id, version, envName, u.id, kind, t, t).run();
  const token = await signPlayToken({ g: p.id, e: envName, u: u.id, n: u.name, k: kind, s: sid, x: Math.floor(t / 1000) + 6 * 3600 }, await playKey(c.env, p.id));
  return { url: `${await gameUrl(c.env, c.get('origin'), p.id, envName)}?gcp_t=${token}`, session: sid, version };
}

api.post('/games/:slug/play', async (c) => {
  const u = requireUser(c), p = await liveGame(c, c.req.param('slug'));
  if (p.status !== 'live' || !p.live_version) throw new AppError(409, 'This game is offline.', 'offline');
  if (p.price_cents > 0 && u.id !== p.owner_id && u.role !== 'admin' && !(await owns(c.env, u.id, p.id))) throw new AppError(402, 'Buy this game to play it.', 'purchase_required');
  return c.json(await startPlay(c, p, 'live', p.live_version, u));
});

api.post('/games/:slug/reviews', async (c) => {
  const u = requireUser(c), p = await liveGame(c, c.req.param('slug')), s = await getSettings(c.env);
  const b = await c.req.json<{ rating?: number; body?: string }>().catch(() => ({} as any));
  const rating = Math.round(Number(b.rating)), text = String(b.body || '').trim().slice(0, 2000);
  if (!(rating >= 1 && rating <= 5)) throw bad('Rating must be 1 to 5.');
  if (u.id === p.owner_id) throw forbidden('You cannot review your own game.');
  if (s.review_requires_play && !(await c.env.DB.prepare("SELECT 1 FROM plays WHERE project_id = ? AND user_id = ? AND env = 'live' AND counted = 1 LIMIT 1").bind(p.id, u.id).first())) throw forbidden(`Play the game for at least ${s.play_min_seconds} seconds before reviewing it.`);
  await rateLimit(c.env, 'review:' + u.id, 30, 3600);
  const old = await c.env.DB.prepare('SELECT rating, hidden FROM reviews WHERE project_id = ? AND user_id = ?').bind(p.id, u.id).first<{ rating: number; hidden: number }>();
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO reviews (project_id, user_id, rating, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET rating = excluded.rating, body = excluded.body, updated_at = excluded.updated_at').bind(p.id, u.id, rating, text, t, t),
    old ? (old.hidden ? c.env.DB.prepare('SELECT 1') : c.env.DB.prepare('UPDATE projects SET rating_sum = rating_sum + ? WHERE id = ?').bind(rating - old.rating, p.id))
      : c.env.DB.prepare('UPDATE projects SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE id = ?').bind(rating, p.id),
  ]);
  return c.json({ ok: true });
});

api.get('/media/*', async (c) => {
  const key = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/api\/media\//, ''));
  if (!/^(shots|covers)\/[A-Za-z0-9/_.\-]+$/.test(key) || key.includes('..')) throw notFound();
  const obj = await c.env.FILES.get(key);
  if (!obj) throw notFound();
  return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'image/png', 'cache-control': 'public, max-age=3600', etag: obj.httpEtag } });
});

// ----- purchases + billing ---------------------------------------------------------------------
async function checkout(c: Ctx, u: User, name: string, amount: number, metadata: Record<string, string>, back: string) {
  const origin = c.get('origin');
  const session = await stripe<{ id: string; url: string }>(c.env, 'POST', '/checkout/sessions', {
    mode: 'payment', client_reference_id: u.id, customer_email: u.email, metadata, payment_intent_data: { metadata },
    line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: amount, product_data: { name } } } },
    success_url: `${origin}${back}${back.includes('?') ? '&' : '?'}paid={CHECKOUT_SESSION_ID}`, cancel_url: `${origin}${back}`,
  });
  return c.json({ url: session.url });
}

api.post('/billing/creator-fee', async (c) => {
  const u = requireUser(c), s = await getSettings(c.env);
  if (u.creator) throw new AppError(409, 'You already have a creator license.', 'already');
  if (s.creator_fee_cents === 0) { await grantCreator(c.env, u.id, 'admin', 'free:' + u.id, 0); return c.json({ ok: true }); }
  return checkout(c, u, `${s.brand_name} creator license`, s.creator_fee_cents, { kind: 'creator_fee', user_id: u.id }, '/console');
});

api.post('/games/:slug/buy', async (c) => {
  const u = requireUser(c), p = await liveGame(c, c.req.param('slug'));
  if (p.status !== 'live') throw new AppError(409, 'This game is offline.', 'offline');
  if (p.price_cents <= 0) throw bad('This game is free.');
  if (u.id === p.owner_id) throw bad('This is your own game.');
  if (await owns(c.env, u.id, p.id)) throw new AppError(409, 'You already own this game.', 'already');
  return checkout(c, u, p.title, p.price_cents, { kind: 'game', user_id: u.id, project_id: p.id }, `/g/${p.slug}`);
});

export async function grantCreator(env: Env, userId: string, provider: string, ref: string, amount: number) {
  if (await env.DB.prepare('SELECT 1 FROM payments WHERE provider_ref = ?').bind(ref).first()) return;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO payments (id, user_id, kind, amount_cents, provider, provider_ref, status, created_at) VALUES (?, ?, 'creator_fee', ?, ?, ?, 'paid', ?)").bind('pay_' + rid(16), userId, amount, provider, ref, now()),
    env.DB.prepare('UPDATE users SET creator = 1, creator_since = COALESCE(creator_since, ?) WHERE id = ?').bind(now(), userId),
  ]);
}

/** Applies a paid Checkout Session. Safe to call more than once for the same session. */
async function applySession(env: Env, session: any): Promise<string> {
  if (!session || session.payment_status !== 'paid') return 'unpaid';
  const m = session.metadata || {};
  const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null;
  if (m.kind === 'creator_fee' && m.user_id) { await grantCreator(env, m.user_id, 'stripe', session.id, session.amount_total || 0); return 'creator_fee'; }
  if (m.kind === 'game' && m.user_id && m.project_id) {
    const p = await getProject(env, m.project_id);
    if (!p) return 'missing_project';
    await recordPurchase(env, await getSettings(env), { userId: m.user_id, projectId: p.id, ownerId: p.owner_id, title: p.title, priceCents: session.amount_total || p.price_cents, provider: 'stripe', providerRef: session.id, paymentIntent: pi });
    return 'game';
  }
  return 'ignored';
}

// Called by the web app when Stripe sends the buyer back, so access does not wait for the webhook.
api.post('/billing/confirm', async (c) => {
  const u = requireUser(c), b = await c.req.json<{ session_id?: string }>().catch(() => ({} as any));
  if (!/^cs_[A-Za-z0-9_]+$/.test(String(b.session_id || ''))) throw bad('Bad session id.');
  const session = await stripe(c.env, 'GET', `/checkout/sessions/${b.session_id}`);
  if (session.client_reference_id !== u.id) throw forbidden();
  return c.json({ result: await applySession(c.env, session) });
});

api.post('/stripe/webhook', async (c) => {
  const event = await verifyWebhook(c.env, await c.req.text(), c.req.header('stripe-signature') || null), o = event.data?.object;
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') await applySession(c.env, o);
  else if (event.type === 'charge.refunded' && o?.refunded && o.payment_intent) {
    await refundPurchase(c.env, { paymentIntent: o.payment_intent }); // a refunded creator fee is handled by an admin
  } else if (event.type === 'account.updated' && o?.id) {
    await c.env.DB.prepare('UPDATE users SET stripe_payouts_enabled = ? WHERE stripe_account = ?').bind(o.payouts_enabled && o.capabilities?.transfers === 'active' ? 1 : 0, o.id).run();
  }
  return c.json({ received: true });
});

api.post('/billing/payout-account', async (c) => {
  const u = requireUser(c), s = await getSettings(c.env), origin = c.get('origin');
  const b = await c.req.json<{ country?: string }>().catch(() => ({} as any));
  let acct = u.stripe_account;
  if (!acct) {
    const country = String(b.country || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw bad('Choose the country of your bank account.');
    const cross = country !== String(s.stripe_platform_country).toUpperCase();
    const a = await stripe<{ id: string }>(c.env, 'POST', '/accounts', {
      type: 'express', country, email: u.email, business_type: 'individual', metadata: { user_id: u.id },
      capabilities: { transfers: { requested: true } }, ...(cross ? { tos_acceptance: { service_agreement: 'recipient' } } : {}),
    }, 'acct:' + u.id + ':' + country);
    acct = a.id;
    await c.env.DB.prepare('UPDATE users SET stripe_account = ?, payout_country = ? WHERE id = ?').bind(acct, country, u.id).run();
  }
  const link = await stripe<{ url: string }>(c.env, 'POST', '/account_links', { account: acct, type: 'account_onboarding', refresh_url: `${origin}/console/earnings?payout=retry`, return_url: `${origin}/console/earnings?payout=done` });
  return c.json({ url: link.url });
});

api.post('/billing/payout-account/refresh', async (c) => {
  const u = requireUser(c);
  if (!u.stripe_account) return c.json({ payouts_enabled: false });
  const a = await stripe<{ payouts_enabled: boolean; capabilities?: { transfers?: string } }>(c.env, 'GET', `/accounts/${u.stripe_account}`);
  const on = a.payouts_enabled && a.capabilities?.transfers === 'active' ? 1 : 0;
  await c.env.DB.prepare('UPDATE users SET stripe_payouts_enabled = ? WHERE id = ?').bind(on, u.id).run();
  return c.json({ payouts_enabled: !!on });
});

api.post('/billing/withdraw', async (c) => {
  const u = requireUser(c), s = await getSettings(c.env), env = c.env;
  const b = await c.req.json<{ method?: string; details?: string }>().catch(() => ({} as any));
  const method = b.method === 'manual' ? 'manual' : 'stripe';
  const bal = await balanceOf(env, u.id), amount = bal.available;
  if (amount < s.withdraw_min_cents) throw bad(`You can withdraw once your available balance reaches $${(s.withdraw_min_cents / 100).toFixed(2)}.`);
  if (method === 'stripe' && !(u.stripe_account && u.stripe_payouts_enabled)) throw bad('Finish setting up your payout account first.');
  if (method === 'manual') { if (!s.allow_manual_withdrawals) throw forbidden('Manual withdrawals are turned off.'); if (String(b.details || '').trim().length < 8) throw bad('Describe where the money should be sent.'); }
  if (await env.DB.prepare("SELECT 1 FROM withdrawals WHERE user_id = ? AND status = 'pending'").bind(u.id).first()) throw new AppError(409, 'You already have a withdrawal in progress.', 'pending');
  const id = 'wd_' + rid(16), t = now();
  // One statement debits the ledger only if the available balance still covers it, so two requests cannot both succeed.
  const debit = await env.DB.prepare(
    `INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at)
     SELECT ?1, 'withdrawal', -?2, ?3, 'Withdrawal', ?4, ?4
     WHERE (SELECT COALESCE(SUM(CASE WHEN available_at <= ?4 OR amount_cents < 0 THEN amount_cents ELSE 0 END), 0) FROM ledger WHERE user_id = ?1) >= ?2`).bind(u.id, amount, id, t).run();
  if (!debit.meta.changes) throw new AppError(409, 'Your balance changed. Try again.', 'conflict');
  await env.DB.prepare("INSERT INTO withdrawals (id, user_id, amount_cents, method, details, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)").bind(id, u.id, amount, method, String(b.details || '').slice(0, 500), t).run();
  if (method === 'stripe') {
    try {
      const tr = await stripe<{ id: string }>(env, 'POST', '/transfers', { amount, currency: 'usd', destination: u.stripe_account, metadata: { withdrawal: id, user_id: u.id } }, id);
      await env.DB.prepare("UPDATE withdrawals SET status = 'paid', provider_ref = ?, settled_at = ? WHERE id = ?").bind(tr.id, now(), id).run();
    } catch (e) {
      await reverseWithdrawal(env, id, u.id, amount, 'failed', String((e as Error).message));
      throw new AppError(502, `The transfer did not go through and your balance was restored. ${(e as Error).message}`, 'transfer_failed');
    }
  }
  return c.json({ ok: true, id, amount_cents: amount, method });
});

export async function reverseWithdrawal(env: Env, id: string, userId: string, amount: number, status: 'failed' | 'rejected', error: string) {
  const t = now();
  await env.DB.batch([
    env.DB.prepare('UPDATE withdrawals SET status = ?, error = ?, settled_at = ? WHERE id = ?').bind(status, error.slice(0, 300), t, id),
    env.DB.prepare("INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at) VALUES (?, 'withdrawal_reversal', ?, ?, ?, ?, ?)").bind(userId, amount, id, status === 'failed' ? 'Withdrawal failed, returned' : 'Withdrawal rejected, returned', t, t),
  ]);
}

// ----- creator console -------------------------------------------------------------------------
api.get('/console/overview', async (c) => {
  const u = requireUser(c), origin = c.get('origin'), s = await getSettings(c.env);
  const projects = await c.env.DB.prepare("SELECT p.*, ? AS author FROM projects p WHERE p.owner_id = ? AND p.status != 'removed' ORDER BY p.updated_at DESC").bind(u.name, u.id).all<Record<string, any>>();
  const sales = await c.env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(net_cents), 0) AS net FROM purchases WHERE owner_id = ? AND status = 'paid'").bind(u.id).first<{ n: number; net: number }>();
  const library = await c.env.DB.prepare("SELECT p.*, u.name AS author FROM purchases x JOIN projects p ON p.id = x.project_id JOIN users u ON u.id = p.owner_id WHERE x.user_id = ? AND x.status = 'paid' ORDER BY x.created_at DESC LIMIT 60").bind(u.id).all<Record<string, any>>();
  return c.json({
    user: pubUser(u), balance: await balanceOf(c.env, u.id), sales: sales || { n: 0, net: 0 }, fee_cents: s.creator_fee_cents,
    projects: projects.results.map((p) => ({ ...card(origin, p), live_version: p.live_version, preview_version: p.preview_version, sales: p.sales, updated_at: p.updated_at })),
    library: library.results.map((p) => card(origin, p)),
  });
});

api.get('/console/projects/:id', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id')), origin = c.get('origin'), db = c.env.DB;
  const [versions, events, daily, errors, files, sales] = await Promise.all([
    db.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY n DESC LIMIT 30').bind(p.id).all<any>(),
    db.prepare('SELECT kind, detail, version, actor, created_at FROM events WHERE project_id = ? ORDER BY id DESC LIMIT 40').bind(p.id).all(),
    db.prepare('SELECT day, sessions, plays, seconds FROM game_daily WHERE project_id = ? AND day >= ? ORDER BY day').bind(p.id, addDays(dayOf(now()), -29)).all(),
    db.prepare('SELECT version, env, message, count, last_at FROM client_errors WHERE project_id = ? ORDER BY last_at DESC LIMIT 20').bind(p.id).all(),
    listFiles(c.env, p.id),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price_cents), 0) AS gross, COALESCE(SUM(net_cents), 0) AS net FROM purchases WHERE project_id = ? AND status = 'paid'").bind(p.id).first(),
  ]);
  const s = await getSettings(c.env);
  return c.json({
    project: { ...card(origin, { ...p, author: u.name }), description: p.description, controls: p.controls, live_version: p.live_version, preview_version: p.preview_version, removed_reason: p.removed_reason, created_at: p.created_at, updated_at: p.updated_at },
    versions: versions.results.map((v) => ({ ...publicVersion(v, origin), eligible: versionEligible(v, s.verify_browser_required) })),
    events: events.results, daily: daily.results, errors: errors.results, sales,
    files: { count: files.length, bytes: files.reduce((a, f) => a + f.size, 0) },
    split: p.price_cents > 0 ? splitSale(p.price_cents, s) : null,
  });
});

api.post('/console/projects/:id/preview', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  if (!p.preview_version) throw new AppError(409, 'No preview has been deployed yet. Ask your agent to run deploy_preview.', 'no_preview');
  return c.json(await startPlay(c, p, 'preview', p.preview_version, u));
});

api.post('/console/projects/:id/offline', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  if (p.status !== 'live') throw bad('This game is not live.');
  await takeOffline(c.env, p, 'console');
  return c.json({ ok: true });
});
export async function takeOffline(env: Env, p: Project, actor: string) {
  await env.DB.prepare("UPDATE projects SET status = 'offline', updated_at = ? WHERE id = ? AND status = 'live'").bind(now(), p.id).run();
  await undeployGame(env, p.id, 'live');
  await logEvent(env, p.id, 'offline', 'Taken offline', p.live_version, actor);
}

api.post('/console/projects/:id/online', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id')), s = await getSettings(c.env);
  if (p.status !== 'offline' || !p.live_version) throw bad('Only a game that was taken offline can be put back online.');
  if (s.creator_fee_required && !u.creator) throw forbidden('A creator license is required to publish.');
  await enqueue(c.env, { kind: 'publish', pid: p.id, n: p.live_version, origin: c.get('origin'), actor: 'console' });
  return c.json({ ok: true });
});

api.patch('/console/projects/:id', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, any>));
  await updateProjectMeta(c.env, p, { price_cents: b.price_cents });
  return c.json({ ok: true });
});

api.get('/console/earnings', async (c) => {
  const u = requireUser(c), s = await getSettings(c.env), db = c.env.DB;
  const [ledger, withdrawals, byGame] = await Promise.all([
    db.prepare('SELECT kind, amount_cents, note, available_at, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100').bind(u.id).all(),
    db.prepare('SELECT id, amount_cents, method, status, error, created_at, settled_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(u.id).all(),
    db.prepare("SELECT p.title, p.slug, COUNT(*) AS n, SUM(x.price_cents) AS gross, SUM(x.fee_cents) AS fees, SUM(x.net_cents) AS net FROM purchases x JOIN projects p ON p.id = x.project_id WHERE x.owner_id = ? AND x.status = 'paid' GROUP BY x.project_id ORDER BY net DESC").bind(u.id).all(),
  ]);
  return c.json({
    balance: await balanceOf(c.env, u.id), min_cents: s.withdraw_min_cents, hold_days: s.earnings_hold_days, fee_percent: s.platform_fee_percent,
    payments: stripeReady(c.env), manual: s.allow_manual_withdrawals, user: pubUser(u), ledger: ledger.results, withdrawals: withdrawals.results, by_game: byGame.results,
  });
});

api.get('/console/agents', async (c) => {
  const u = requireUser(c);
  const grants = await c.env.OAUTH_PROVIDER.listUserGrants(u.id);
  const out = [];
  for (const g of grants.items) {
    const client = await c.env.OAUTH_PROVIDER.lookupClient(g.clientId).catch(() => null);
    out.push({ id: g.id, client: client?.clientName || g.clientId, scope: g.scope, created_at: (g as any).createdAt * 1000, expires_at: (g as any).expiresAt ? (g as any).expiresAt * 1000 : null });
  }
  return c.json({ agents: out });
});
api.delete('/console/agents/:id', async (c) => {
  const u = requireUser(c);
  await c.env.OAUTH_PROVIDER.revokeGrant(c.req.param('id'), u.id);
  return c.json({ ok: true });
});

// ----- first admin -----------------------------------------------------------------------------
api.post('/claim-admin', async (c) => {
  const u = requireUser(c), b = await c.req.json<{ token?: string }>().catch(() => ({} as any));
  if (!c.env.ADMIN_CLAIM_TOKEN || String(b.token || '') !== c.env.ADMIN_CLAIM_TOKEN) throw forbidden('That claim link is not valid.');
  if (await c.env.DB.prepare("SELECT 1 FROM users WHERE role = 'admin'").first()) throw forbidden('An admin already exists. Ask them to promote you.');
  await c.env.DB.prepare("UPDATE users SET role = 'admin', creator = 1, creator_since = COALESCE(creator_since, ?) WHERE id = ?").bind(now(), u.id).run();
  return c.json({ ok: true });
});

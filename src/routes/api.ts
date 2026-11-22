// The web app's API: accounts, marketplace, play sessions, purchases, the creator console and billing.
import { actBots, botOptions, botStatus, startBots, stopBots } from '../bots';
import { Hono } from 'hono';
import { AppError, bad, forbidden, notFound, type Env, type Project, type User } from '../env';
import { checkPassword, clearGuestCookie, clientNet, createSession, endPreviousLogin, existingGuestId, guestCookieId, guestIdentity, userFromRequest, hashPassword, isGuestId, loginIdOf, newUserId, rateLimit, requireUser, sessionCookie, sessionToken, type Ctx } from '../auth';
import { GUEST_SESSION_S, PLAY_SESSION_S } from './rt';
import { gameUrl, playKey, undeployGame } from '../deploy';
import { ensurePreview } from '../cleanup';
import { deleteAccount, deleteBlocker, newResetToken, takeResetToken } from '../account';
import { passwordResetMail } from '../mail';
import { answerChallenge, beginSetup, confirmSetup, disableTwoFactor, replaceRecoveryCodes, startChallenge, twoFactorOn, twoFactorState, useCode } from '../two-factor';
import { holdMs, balanceOf, disputePurchase, disputeWon, freeSkillShared, owns, ownsSkill, partialRefund, recordPurchase, refundPurchase, splitSale, splitSkillSale } from '../earnings';
import { gameRefundState, purchaseHistory, requestRefund, stripePay } from '../refunds';
import { liveSkill, setSkillPrice, skillCopied, skillSalesOf, storeItem, storeList } from '../skills';
import { enqueue } from '../pipeline';
import { matureOf } from '../../web/src/gamemeta';
import { liveMature, matureList } from '../mature';
import { missingToPublish, normalizeStoredTags, tagGroup } from '../../web/src/tags';
import { OPERATOR, DEFAULT_BRAND } from '../../web/src/operator';
import { currentChecks, gateError, gateView, recordGate, releaseGate, storedGate } from '../release-gate';
import { PRICE_NOW_SQL, applySale, checkoutExpiry, saleOf, saleView } from '../sales';
import { ensureCompat, ensureVersionMeta, getProject, getVersion, listFiles, logEvent, ownedProject, publicVersion, updateProjectMeta, versionEligible } from '../projects';
import { budgetOf, latestRequest } from '../storage';
import { getSettings, SETTING_DEFS } from '../settings';
import { grantLicense, isPlan, licenseOf, licenseView, offerOf, planName, syncLicense } from '../license';
import { freeTrendingArgs, freeTrendingOrder, freeTrendingQuery } from '../catalog';
import { gameAnalytics, ONLINE_WINDOW_MS, onlineNow } from '../analytics';
import { currentPicks } from '../rankings';
import { checkIn, sessionStartStmt } from '../play-clock';
import { CLOCK_ONLINE_FRESH_MS, playClock } from '../clock-do';
import { CLOCK_HEADER, clockTicket, readClockTicket } from '../clock-ticket';
import { implementationCard, setOpenImplementation } from '../implementations';
import { addFeedback, feedbackImage, feedbackProject, listFeedback, removeFeedback } from '../feedback';
// @ts-ignore plain JS module
import { FEEDBACK_LIMITS } from '../feedback-rules.js';
import { payoutReady, stripe, stripeReady, stripeV2, verifyWebhook } from '../stripe';
import { startWithdrawal } from '../payouts';
export { autoPayouts, retryTransfers, reverseWithdrawal, sendTransfer } from '../payouts';
import { beginTrial, trialMinutes, trialState } from '../trials';
import { addDays, dayOf, now, parseJson, readCapped, rid, safeEqual, sha256 } from '../util';
// @ts-ignore plain JS module
import { signPlayToken } from '../runtime/game-worker.js';
// @ts-ignore plain JS module
import { continueList, hideContinue, playerSummary, resetPlayer, scopeOf } from '../player-data.js';
// @ts-ignore plain JS module
import { claimGuest, guestProgress } from '../session-binding.js';
import { socialHub } from '../social';
// @ts-ignore plain JS module
import { ensureProfile } from '../social-rules.js';
import { LibraryError, addToLibrary, libraryCounts, libraryList, libraryState, removeFromLibrary } from '../library.js';

type App = { Bindings: Env; Variables: { user: User | null; origin: string } };
export const api = new Hono<App>();

const media = (origin: string, key: string | null) => (key ? `${origin}/api/media/${key}` : null);
const pubUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, role: u.role, creator: !!u.creator, creator_since: u.creator_since,
  license: licenseOf({ ...u, creator: u.creator_licensed ?? u.creator }), payouts_enabled: !!u.stripe_payouts_enabled, has_payout_account: !!u.stripe_account, payout_country: u.payout_country, two_factor: !!u.totp_enabled_at });

function card(origin: string, r: Record<string, any>, at = now()) {
  // price_cents is what a buyer pays now; during a limited-time sale (src/sales.ts) that is the sale price, and `sale`
  // carries the regular price (struck through in the store), the percent off and when the sale ends
  const sale = saleOf(r as Project, at);
  return {
    id: r.id, slug: r.slug, title: r.title, tagline: r.tagline, tags: normalizeStoredTags(parseJson<string[]>(r.tags, [])), /* only genres and tags on the platform list */ cover: media(origin, r.cover_key), price_cents: sale ? sale.price_cents : r.price_cents,
    sale: sale && { regular_cents: sale.regular_cents, percent_off: sale.percent_off, ends_at: sale.ends_at },
    trial_minutes: r.price_cents > 0 ? Number(r.trial_minutes) || 0 : 0,   // the web app also applies the platform's trial settings
    plays: r.plays, minutes: Math.round(r.seconds / 60), rating: r.rating_count ? Math.round((r.rating_sum / r.rating_count) * 10) / 10 : null, rating_count: r.rating_count,
    author: r.author, featured: !!r.featured, published_at: r.published_at, status: r.status, open_implementation: !!r.open_implementation, skill_price_cents: Number(r.skill_price_cents) || 0, playing: Number(r.playing) || 0,
    // adults-only games: the store blurs the cover and labels it 18+ (sexual, violence, other)
    age: r.age || null, mature: matureList(r),
    // on today's picks: why the game was picked (featured, trending, rising, new, gem, free, more)
    ...(r.pick ? { pick: r.pick } : {}),
    // the title and tagline in other platform languages, when the creator translated the listing
    ...(r.listing_i18n && r.listing_i18n !== '{}' ? { i18n: Object.fromEntries(Object.entries(parseJson<Record<string, { title?: string; tagline?: string }>>(r.listing_i18n, {})).map(([k, v]) => [k, { title: v.title, tagline: v.tagline }])) } : {}),
  };
}

// ----- config + auth ---------------------------------------------------------------------------
api.get('/config', async (c) => {
  const s = await getSettings(c.env), out: Record<string, unknown> = {};
  for (const [k, d] of Object.entries(SETTING_DEFS)) if ((d as { public?: boolean }).public) out[k] = (s as Record<string, unknown>)[k];
  return c.json({ settings: out, payments: stripeReady(c.env), mcp_url: `${c.get('origin')}/mcp`, origin: c.get('origin') });
});

// makes_games: this account is also a creator (a creator license, or games of its own on the platform). Everyone is a
// player; only then does the web app show the creator console in its main navigation.
api.get('/me', async (c) => {
  const u = c.get('user');
  if (!u) return c.json({ user: null });
  const makes = !!u.creator || !!u.creator_licensed || !!(await c.env.DB.prepare("SELECT 1 FROM projects WHERE owner_id = ? AND status != 'removed' LIMIT 1").bind(u.id).first());
  return c.json({ user: { ...pubUser(u), makes_games: makes } });
});

api.post('/auth/signup', async (c) => {
  const b = await c.req.json<{ email?: string; name?: string; password?: string }>().catch(() => ({} as any)), s = await getSettings(c.env);
  if (!s.signups_open) throw forbidden('Sign-ups are closed right now.');
  // Per network, not per person: carriers in much of Asia, Africa and South America put thousands of phones behind one
  // IPv4 address (carrier-grade NAT), so the bar is set for a busy shared address, not one household.
  await rateLimit(c.env, 'signup:' + clientNet(c.req.raw), 30, 3600);
  const email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim().slice(0, 40), pw = String(b.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) throw bad('Enter a valid email address.');
  if (name.length < 2) throw bad('Choose a display name of at least 2 characters.');
  if (pw.length < 8 || pw.length > 200) throw bad('Password must be at least 8 characters.');
  if (await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) throw new AppError(409, 'An account with that email already exists. Sign in instead.', 'exists');
  const id = newUserId();
  await c.env.DB.prepare('INSERT INTO users (id, email, name, pw_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, email, name, await hashPassword(pw), now(), now()).run();
  await ensureProfile(c.env.DB, { id, name }).catch(() => {});   // findable by friends from the start (src/social-rules.js)
  await endPreviousLogin(c.env, c.req.raw);   // games still open on the browser's earlier sign-in stop (see session-binding.js)
  c.header('set-cookie', await createSession(c.env, c.req.raw, id));
  return c.json({ ok: true });
});

const DUMMY_HASH = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
api.post('/auth/login', async (c) => {
  const b = await c.req.json<{ email?: string; password?: string }>().catch(() => ({} as any));
  const email = String(b.email || '').trim().toLowerCase();
  // Attempts are limited per network (many emails from one place), per email from one network (guessing one password),
  // and per email overall at a higher bar (a spread-out attack), so a stranger cannot lock someone out with a few tries.
  const net = clientNet(c.req.raw);
  await rateLimit(c.env, 'loginnet:' + net, 60, 900);
  await rateLimit(c.env, 'login:' + email + '|' + net, 10, 900);
  await rateLimit(c.env, 'loginall:' + email, 200, 3600);
  const u = await c.env.DB.prepare('SELECT id, pw_hash, status FROM users WHERE email = ?').bind(email).first<{ id: string; pw_hash: string; status: string }>();
  // an unknown email costs the same hash as a known one, so the answer time does not tell which emails have accounts
  const good = await checkPassword(String(b.password || ''), u?.pw_hash || DUMMY_HASH);
  if (!u || !good) throw new AppError(401, 'Wrong email or password.', 'bad_login');
  if (u.status !== 'active') throw forbidden('This account is suspended.');
  // With two-factor on, the right password only opens the second step: nothing is signed in until the code follows.
  if (await twoFactorOn(c.env, u.id)) return c.json({ ok: true, two_factor: true, challenge: await startChallenge(c.env, u.id) });
  return c.json(await signIn(c, u.id));
});

/** Signs this browser in as the account (the password, and the code when two-factor is on, were checked). */
async function signIn(c: Ctx, userId: string) {
  await c.env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now(), userId).run();
  // Signing in replaces this browser's earlier sign-in, whoever it was: games still open on it (another tab, a reload)
  // stop at their next call instead of carrying on as the previous account.
  await endPreviousLogin(c.env, c.req.raw);
  c.header('set-cookie', await createSession(c.env, c.req.raw, userId));
  return { ok: true as const };
}

// The second step of a sign-in with two-factor on: the challenge from the password step and a code from the
// authenticator app, or one of the recovery codes (src/two-factor.ts). Five wrong codes and the password is asked again.
/** Codes one account may try at the second step of signing in, from anywhere: ample for a person, too few to guess with. */
export const TWO_FACTOR_CODES_PER_15_MIN = 10, TWO_FACTOR_CODES_PER_DAY = 30;
api.post('/auth/login/code', async (c) => {
  const b = await c.req.json<{ challenge?: string; code?: string }>().catch(() => ({} as any));
  await rateLimit(c.env, 'login2fa:' + clientNet(c.req.raw), 30, 900);
  const r = await answerChallenge(c.env, String(b.challenge || ''), String(b.code || ''), now(), async (userId) => {
    await rateLimit(c.env, '2falogin:' + userId, TWO_FACTOR_CODES_PER_15_MIN, 900);
    await rateLimit(c.env, '2falogind:' + userId, TWO_FACTOR_CODES_PER_DAY, 86400);
  });
  if (!r.ok) throw r.reason === 'expired'
    ? new AppError(401, 'This sign-in timed out or had too many wrong codes. Enter your password again.', 'challenge_expired')
    : new AppError(401, 'That code is not right. Check the time on your phone, or use a recovery code.', 'bad_code');
  const u = await c.env.DB.prepare('SELECT status FROM users WHERE id = ?').bind(r.userId).first<{ status: string }>();
  if (u?.status !== 'active') throw forbidden('This account is suspended.');
  await signIn(c, r.userId);
  return c.json({ ok: true, used_recovery: r.kind === 'recovery', recovery_left: r.kind === 'recovery' ? (await twoFactorState(c.env, r.userId)).recovery_left : undefined });
});

// Progress this browser made as a guest, offered to the signed-in account. Nothing moves until the player says so
// (POST below): on a shared computer the guest progress may be someone else's. A game where the account already has
// progress is listed as kept: the account's own progress stays and the guest's is not mixed into it.
api.get('/guest-progress', async (c) => {
  const u = requireUser(c), g = await existingGuestId(c.env, c.req.raw);
  return c.json({ games: g ? await guestProgress(c.env.DB, g, u.id) : [] });
});
api.post('/guest-progress', async (c) => {
  const u = requireUser(c), b = await c.req.json<{ move?: boolean }>().catch(() => ({} as { move?: boolean }));
  const g = await existingGuestId(c.env, c.req.raw);
  // Either way the guest id is claimed once and its cookie removed, so it can never reach a second account.
  c.header('set-cookie', clearGuestCookie(c.req.raw), { append: true });
  if (!g) return c.json({ ok: true, moved: 0, kept: 0, games: [] });
  const r = await claimGuest(c.env.DB, g, u.id, u.name, { move: b.move === true, t: now() });
  return c.json({ ok: true, ...(r || { moved: 0, kept: 0, games: [] }) });
});

api.post('/auth/logout', async (c) => {
  const t = sessionToken(c.req.raw), u = c.get('user');
  if (t) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256(t)).run();
  // the friends connection of this sign-in closes now, so this browser goes offline at once (src/social.ts)
  if (t && u && c.env.SOCIAL) await socialHub(c.env, u.id).closeLogin(await sha256(t)).catch(() => {});
  c.header('set-cookie', sessionCookie(c.req.raw, '', 0));
  return c.json({ ok: true });
});

// ----- account: password, sign-ins, deletion, reset by email (security review, finding 8) --------------------------
const checkNewPassword = (pw: string) => { if (pw.length < 8 || pw.length > 200) throw bad('Password must be at least 8 characters.'); };
const pwHashOf = async (c: Ctx, id: string) => (await c.env.DB.prepare('SELECT pw_hash FROM users WHERE id = ?').bind(id).first<{ pw_hash: string }>())?.pw_hash || '';
async function requirePassword(c: Ctx, u: User, pw: unknown) {
  await rateLimit(c.env, 'pwcheck:' + u.id, 10, 900);
  if (!(await checkPassword(String(pw || ''), await pwHashOf(c, u.id)))) throw new AppError(401, 'That is not your current password.', 'bad_password');
}
/** Ends every sign-in of this account except the one making the request. */
async function endOtherSessions(c: Ctx, userId: string) {
  const mine = await loginIdOf(c.req.raw);
  return (await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(userId, mine || '').run()).meta.changes || 0;
}

api.get('/account', async (c) => {
  const u = requireUser(c), mine = await loginIdOf(c.req.raw);
  const rows = await c.env.DB.prepare('SELECT id, created_at, ua FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 50').bind(u.id, now()).all<{ id: string; created_at: number; ua: string }>();
  return c.json({
    user: pubUser(u), created_at: u.created_at,
    sessions: rows.results.map((r) => ({ created_at: r.created_at, ua: r.ua || '', current: r.id === mine })),
    delete_blocker: await deleteBlocker(c.env, u),
    two_factor: await twoFactorState(c.env, u.id),
  });
});

// ----- two-factor sign-in (src/two-factor.ts): the same for every account, players and creators alike ---------------
/** A code from the authenticator or a recovery code, for changing two-factor itself. Used up when it is good. */
async function requireCode(c: Ctx, u: User, code: unknown) {
  await rateLimit(c.env, '2facheck:' + u.id, 10, 900);
  if (!(await useCode(c.env, u.id, String(code || '')))) throw new AppError(401, 'That code is not right. Check the time on your phone, or use a recovery code.', 'bad_code');
}
// 1. the password again, then a new secret to put in the authenticator app (a QR code of `uri`, or `secret` typed in)
api.post('/account/2fa/setup', async (c) => {
  const u = requireUser(c), b = await c.req.json<{ password?: string }>().catch(() => ({} as any));
  if (u.totp_enabled_at) throw new AppError(409, 'Two-factor sign-in is already on.', 'already_on');
  await requirePassword(c, u, b.password);
  return c.json(await beginSetup(c.env, u, (await getSettings(c.env)).brand_name || DEFAULT_BRAND));
});
// 2. a code from the app proves it has the secret: two-factor is on, the recovery codes are shown once, and every other
//    sign-in (which never gave a code) ends
api.post('/account/2fa/enable', async (c) => {
  const u = requireUser(c), b = await c.req.json<{ code?: string }>().catch(() => ({} as any));
  if (u.totp_enabled_at) throw new AppError(409, 'Two-factor sign-in is already on.', 'already_on');
  await rateLimit(c.env, '2facheck:' + u.id, 10, 900);
  const codes = await confirmSetup(c.env, u.id, String(b.code || '').replace(/\s/g, ''));
  if (!codes) throw new AppError(400, 'That code is not right, or the setup expired. Check the time on your phone, or start again.', 'bad_code');
  return c.json({ ok: true, recovery_codes: codes, ended: await endOtherSessions(c, u.id) });
});
api.post('/account/2fa/disable', async (c) => {
  const u = requireUser(c), b = await c.req.json<{ password?: string; code?: string }>().catch(() => ({} as any));
  if (!u.totp_enabled_at) return c.json({ ok: true });
  await requirePassword(c, u, b.password);
  await requireCode(c, u, b.code);
  await disableTwoFactor(c.env, u.id);
  return c.json({ ok: true });
});
api.post('/account/2fa/recovery-codes', async (c) => {
  const u = requireUser(c), b = await c.req.json<{ password?: string; code?: string }>().catch(() => ({} as any));
  if (!u.totp_enabled_at) throw new AppError(409, 'Turn on two-factor sign-in first.', 'not_on');
  await requirePassword(c, u, b.password);
  await requireCode(c, u, b.code);
  return c.json({ ok: true, recovery_codes: await replaceRecoveryCodes(c.env, u.id) });
});

api.post('/auth/password', async (c) => {
  const u = requireUser(c), b = await c.req.json<{ current?: string; password?: string }>().catch(() => ({} as any));
  const pw = String(b.password || '');
  checkNewPassword(pw);
  await requirePassword(c, u, b.current);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').bind(await hashPassword(pw), u.id),
    c.env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(u.id),
  ]);
  // whoever else knew the old password is signed out everywhere; this browser stays signed in
  return c.json({ ok: true, ended: await endOtherSessions(c, u.id) });
});

api.post('/auth/sessions/end-others', async (c) => {
  const u = requireUser(c);
  return c.json({ ok: true, ended: await endOtherSessions(c, u.id) });
});

// The answer is the same whether or not the email has an account, so the form cannot be used to find out who has one.
api.post('/auth/forgot', async (c) => {
  if (!c.env.EMAIL) throw new AppError(503, 'Password reset by email is not available right now. Contact us to recover your account.', 'no_email');
  const b = await c.req.json<{ email?: string }>().catch(() => ({} as any));
  const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
  await rateLimit(c.env, 'forgotnet:' + clientNet(c.req.raw), 10, 3600);
  await rateLimit(c.env, 'forgot:' + email, 3, 3600);
  const u = await c.env.DB.prepare("SELECT id, name, email FROM users WHERE email = ? AND status = 'active'").bind(email).first<{ id: string; name: string; email: string }>();
  if (u) {
    const link = `${c.get('origin')}/reset?token=${await newResetToken(c.env, u.id)}`;
    const send = passwordResetMail(c.env, u.email, u.name, link).then(() => {});
    // sent after the answer, so how long the answer takes does not tell either
    try { c.executionCtx.waitUntil(send); } catch { await send; }
  }
  return c.json({ ok: true });
});

api.post('/auth/reset', async (c) => {
  const b = await c.req.json<{ token?: string; password?: string }>().catch(() => ({} as any));
  const pw = String(b.password || '');
  checkNewPassword(pw);
  await rateLimit(c.env, 'reset:' + clientNet(c.req.raw), 20, 3600);
  const id = await takeResetToken(c.env, String(b.token || ''));
  const u = id ? await c.env.DB.prepare('SELECT id, status FROM users WHERE id = ?').bind(id).first<{ id: string; status: string }>() : null;
  if (!u || u.status !== 'active') throw new AppError(400, 'This reset link has expired or was already used. Ask for a new one.', 'bad_token');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET pw_hash = ?, last_seen_at = ? WHERE id = ?').bind(await hashPassword(pw), now(), u.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
    c.env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(u.id),
  ]);
  // A reset link proves the email, not the second factor: with two-factor on, the code is still asked before signing in.
  if (await twoFactorOn(c.env, u.id)) return c.json({ ok: true, two_factor: true, challenge: await startChallenge(c.env, u.id) });
  return c.json(await signIn(c, u.id));
});

api.post('/account/delete', async (c) => {
  const u = requireUser(c), b = await c.req.json<{ password?: string }>().catch(() => ({} as any));
  await requirePassword(c, u, b.password);
  const blocker = await deleteBlocker(c.env, u);
  if (blocker) throw new AppError(409, blocker, 'cannot_delete');
  await deleteAccount(c.env, u.id);
  c.header('set-cookie', sessionCookie(c.req.raw, '', 0));
  return c.json({ ok: true });
});

// ----- marketplace -----------------------------------------------------------------------------
// ---- the catalogue -------------------------------------------------------------------------------
// Built for tens of thousands of games: every list is paged (limit and offset, with the total), and the home
// page gets all of its shelves in one request. "Playing now" counts players whose game page checked in during the last minute (src/play-clock.ts).
type ListOpts = { sort?: string; q?: string; tag?: string; price?: string; limit?: number; offset?: number; newSince?: number; by?: string; minRating?: number };
const ORDER: Record<string, string> = {
  new: 'p.published_at DESC',
  top: '(p.rating_sum + 3.5 * 3) * 1.0 / (p.rating_count + 3) DESC, p.rating_count DESC',
  played: 'p.plays DESC',
  playing: 'p.playing DESC, p.recent DESC, p.plays DESC',
  // the trending score (src/rankings.ts); admin-featured games go into today's picks instead of being pinned here
  trending: 'p.recent DESC, p.plays DESC, p.published_at DESC',
};
/** One page of live games. recent and playing are columns kept fresh by cron (src/catalog.ts), so the sort can use an
 *  index; the Top sort is read in order from its own index (migration 0030), which the planner would not choose by
 *  itself. Before that migration has run, the Top sort simply sorts. */
async function pageOf(c: Ctx, sort: string, w: string, order: string, args: unknown[], limit: number, offset: number) {
  const q = (hint: string) => c.env.DB.prepare(`SELECT p.*, u.name AS author FROM projects p${hint} JOIN users u ON u.id = p.owner_id WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...args, limit, offset).all();
  if (sort !== 'top') return q('');
  try { return await q(' INDEXED BY projects_top'); }
  catch (e) { if (/no such index|no query solution/i.test(String((e as Error).message))) return q(''); throw e; }
}
async function listGames(c: Ctx, o: ListOpts) {
  const sort = ORDER[o.sort || ''] ? o.sort! : 'trending', q = (o.q || '').trim().slice(0, 60), tag = (o.tag || '').trim().toLowerCase().slice(0, 130);
  const limit = Math.max(1, Math.min(60, o.limit || 24)), offset = Math.max(0, Math.min(100000, o.offset || 0));
  const where = ["p.status = 'live'"], args: unknown[] = [];
  if (q) { where.push("(p.title LIKE ? ESCAPE '\\' OR p.tagline LIKE ? ESCAPE '\\' OR p.tags LIKE ? ESCAPE '\\')"); const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%'; args.push(like, like, like.toLowerCase()); }
  // tag can name several genres, comma separated: a game must carry all of them
  for (const one of tag.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 5)) { where.push("p.tags LIKE ? ESCAPE '\\'"); args.push('%"' + one.replace(/[\\%_]/g, '\\$&') + '"%'); }
  if (o.price === 'free') where.push('p.price_cents = 0'); else if (o.price === 'paid') where.push('p.price_cents > 0'); else if (o.price === 'under5') { where.push(`p.price_cents > 0 AND ${PRICE_NOW_SQL} < 500`); args.push(now()); } else if (o.price === 'sale') { where.push('p.sale_price_cents > 0 AND p.sale_ends_at > ? AND p.sale_starts_at <= ? AND p.sale_price_cents < p.price_cents'); const t = now(); args.push(t, t); } else if (o.price === 'trial') where.push('p.price_cents > 0 AND p.trial_minutes > 0');
  if (o.minRating) { where.push('p.rating_count > 0 AND p.rating_sum >= ? * p.rating_count'); args.push(Math.max(1, Math.min(5, o.minRating))); }
  if (o.newSince) { where.push('p.published_at > ?'); args.push(o.newSince); }
  if (o.by) { where.push('p.owner_id = ?'); args.push(String(o.by).slice(0, 64)); }   // one creator's games
  const w = where.join(' AND ');
  // among free games, those that share their Open Implementation get a moderate lift (src/catalog.ts)
  const freeTrending = sort === 'trending' && o.price === 'free', boost = freeTrending ? (await getSettings(c.env)).open_impl_free_boost_percent : 0;
  const order = freeTrending ? freeTrendingOrder(boost) : ORDER[sort];
  // the Free shelf's boosted order, merged from two index-ordered lists instead of sorting every free game (src/catalog.ts)
  const merged = freeTrending ? freeTrendingQuery(boost, 'p.*, u.name AS author', 'projects p JOIN users u ON u.id = p.owner_id', w) : null;
  const [rows, total] = await Promise.all([
    merged ? c.env.DB.prepare(merged).bind(...freeTrendingArgs(args, limit, offset)).all() : pageOf(c, sort, w, order, args, limit, offset),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM projects p WHERE ${w}`).bind(...args).first<{ n: number }>(),
  ]);
  const games = rows.results.map((r) => card(c.get('origin'), r)), n = total?.n || 0;
  return { games, total: n, next_offset: offset + games.length < n ? offset + games.length : null };
}
/**
 * Genres: the most used tags with how many live games carry each, and the covers of the three most played games
 * in each (for the category tiles). With `within`, only games carrying that tag count: its related genres.
 * Reads the 5,000 most played games, which is plenty to rank genres however big the catalogue grows.
 */
// Genre counts move slowly and are the same for everyone, so each isolate keeps them for a minute: the facets of every
// store request (and each data centre's cache refills) then read the 5,000 rows once a minute, not once a request.
const GENRE_TTL_MS = 60_000, genreMemo = new Map<string, { at: number; value: ReturnType<typeof readGenreCounts> }>();
function genreCounts(c: Ctx, top = 16, within = '') {
  const key = `${c.get('origin')}|${top}|${within}`, hit = genreMemo.get(key), t = now();
  if (hit && t - hit.at < GENRE_TTL_MS) return hit.value;
  if (genreMemo.size > 500) genreMemo.clear();
  const value = readGenreCounts(c, top, within);
  genreMemo.set(key, { at: t, value });
  value.catch(() => genreMemo.delete(key));
  return value;
}
async function readGenreCounts(c: Ctx, top: number, within: string) {
  const w = within ? " AND tags LIKE ? ESCAPE '\\'" : '', a = within ? ['%"' + within.replace(/[\\%_]/g, '\\$&') + '"%'] : [];
  const rows = await c.env.DB.prepare(`SELECT tags, cover_key, mature FROM projects WHERE status = 'live'${w} ORDER BY plays DESC LIMIT 5000`).bind(...a).all<{ tags: string; cover_key: string | null; mature: string }>();
  const counts = new Map<string, { n: number; covers: string[] }>(), origin = c.get('origin');
  for (const r of rows.results) for (const t of normalizeStoredTags(parseJson<string[]>(r.tags, []))) {
    if (t === within) continue;
    const e = counts.get(t) || { n: 0, covers: [] }; e.n++;
    if (r.cover_key && !r.mature && e.covers.length < 3) e.covers.push(media(origin, r.cover_key)!);   // category tiles never show an adults-only cover
    counts.set(t, e);
  }
  return [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, top).map(([tag, e]) => ({ tag, group: tagGroup(tag), n: e.n, covers: e.covers }));
}
const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

// The same for everyone (nothing in it depends on who asks), so each data centre answers it from its cache for half a
// minute: browsing, search and the category pages then cost the database one read per address per half minute, not one
// per visitor. The genre facets alone read the 5,000 most played games.
api.get('/games', (c) => edgeCached(c, 30, async () => {
  const qy = (k: string) => c.req.query(k);
  const [list, genres] = await Promise.all([
    listGames(c, { sort: qy('sort'), q: qy('q'), tag: qy('tag'), price: qy('price'), limit: num(qy('limit')) || 60, offset: num(qy('offset')), newSince: num(qy('since')), by: qy('by'), minRating: Number(qy('rating')) || undefined }),
    num(qy('offset')) || qy('facets') === '0' ? Promise.resolve(null) : genreCounts(c),   // facets=0: just the games (instant search, shelves)
  ]);
  return c.json({ ...list, ...(genres && { tags: genres.map((g) => g.tag), genres }) });
}));

/** Every genre with its count and covers (the categories index), or one genre's numbers and related genres. */
api.get('/categories', (c) => edgeCached(c, 60, async () => { c.header('cache-control', 'public, max-age=60'); return c.json({ genres: await genreCounts(c, 200) }); }));
api.get('/categories/:tag', (c) => edgeCached(c, 30, async () => {
  const tag = c.req.param('tag').trim().toLowerCase().slice(0, 24), like = '%"' + tag.replace(/[\\%_]/g, '\\$&') + '"%', t = now();
  const [related, nums] = await Promise.all([
    genreCounts(c, 14, tag),
    c.env.DB.prepare(`SELECT COUNT(*) AS games, COALESCE(SUM(price_cents = 0), 0) AS free, COALESCE(SUM(published_at > ?), 0) AS new_week,
        COALESCE(SUM(playing), 0) AS playing
      FROM projects WHERE status = 'live' AND tags LIKE ? ESCAPE '\\'`).bind(t - 7 * 86400000, like).first<{ games: number; free: number; new_week: number; playing: number }>(),
  ]);
  c.header('cache-control', 'public, max-age=30');
  return c.json({ tag, games: nums?.games || 0, free: nums?.free || 0, new_week: nums?.new_week || 0, playing: nums?.playing || 0, related });
}));

/** Everything the home page shows, in one request: the spotlight, the shelves, the genres and the key numbers. */
/** Public, same for everyone: answered from this data centre's cache for a few seconds, so a rush does not reach D1. */
async function edgeCached(c: Ctx, seconds: number, make: () => Promise<Response>): Promise<Response> {
  const cache = (globalThis as any).caches?.default as Cache | undefined, key = new Request(new URL(c.req.url).toString(), { method: 'GET' });
  const hit = cache && await cache.match(key).catch(() => undefined);
  if (hit) return hit;
  const res = await make();
  if (cache && res.ok) {
    const copy = new Response(res.clone().body, res); copy.headers.set('cache-control', `public, max-age=${seconds}`); copy.headers.delete('set-cookie');
    c.executionCtx.waitUntil(cache.put(key, copy).catch(() => {}));
  }
  return res;
}

api.get('/home', (c) => edgeCached(c, 20, () => homeData(c)));
async function homeData(c: Ctx): Promise<Response> {
  const t = now(), weekAgo = t - 7 * 86400000;
  const [picks, trending, playing, fresh, top, free, sale, genres, stats] = await Promise.all([
    currentPicks(c.env.DB, t),
    listGames(c, { sort: 'trending', limit: 16 }),
    listGames(c, { sort: 'playing', limit: 12 }),
    listGames(c, { sort: 'new', limit: 12 }),
    listGames(c, { sort: 'top', limit: 12 }),
    listGames(c, { sort: 'trending', price: 'free', limit: 12 }),
    listGames(c, { sort: 'trending', price: 'sale', limit: 12 }),
    genreCounts(c, 18),
    c.env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM projects WHERE status = 'live') AS games,
        (SELECT COUNT(*) FROM projects WHERE status = 'live' AND published_at > ?) AS new_week,
        ${(await getSettings(c.env)).play_clock_do ? `(SELECT COALESCE(SUM(live_players), 0) FROM game_online WHERE updated_at > ${t - CLOCK_ONLINE_FRESH_MS} AND ? > 0)` : "(SELECT COUNT(DISTINCT user_id) FROM plays WHERE env = 'live' AND seen_at > ? AND kind != 'verify')"} AS playing,
        (SELECT COUNT(DISTINCT owner_id) FROM projects WHERE status = 'live') AS creators`).bind(weekAgo, t - ONLINE_WINDOW_MS).first<{ games: number; new_week: number; playing: number; creators: number }>(),
  ]);
  c.header('cache-control', 'public, max-age=20');
  return c.json({
    stats: { games: stats?.games || 0, new_week: stats?.new_week || 0, playing: stats?.playing || 0, creators: stats?.creators || 0 },
    shelves: {
      // today's picks lead the page (chosen each day by the schedule, src/rankings.ts)
      picks: picks.map((r) => card(c.get('origin'), r)),
      trending: trending.games, playing: playing.games.filter((g) => g.playing > 0), new: fresh.games, top: top.games.filter((g) => g.rating_count > 0), free: free.games,
      // games on a limited-time sale right now (src/sales.ts)
      sale: sale.games,
    },
    genres,
  });
}

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
  let mine = null, played = false, owned = p.price_cents === 0, library: string | null = null, resume: { last_played: number; saved_at: number | null; resume: unknown } | null = null;
  if (u) {
    mine = await c.env.DB.prepare('SELECT rating, body FROM reviews WHERE project_id = ? AND user_id = ?').bind(p.id, u.id).first();
    played = !!(await c.env.DB.prepare("SELECT 1 FROM plays WHERE project_id = ? AND user_id = ? AND env = 'live' AND counted = 1 LIMIT 1").bind(p.id, u.id).first());
    owned = owned || u.id === p.owner_id || u.role === 'admin' || await owns(c.env, u.id, p.id);
    library = await libraryState(c.env.DB, u.id, p.id);
    // Played before: the page offers Continue (with where the game says the player is) instead of Play.
    const pg = await c.env.DB.prepare('SELECT last_at, resume, (SELECT MAX(updated_at) FROM saves s WHERE s.project_id = ?1 AND s.user_id = ?2) AS saved_at FROM player_games WHERE project_id = ?1 AND user_id = ?2').bind(p.id, u.id).first<{ last_at: number; resume: string | null; saved_at: number | null }>();
    if (pg && (pg.saved_at || pg.resume)) resume = { last_played: pg.last_at, saved_at: pg.saved_at, resume: parseJson(pg.resume, null) };
  }
  const s = await getSettings(c.env), trial = owned ? null : await trialState(c.env, p, s, u?.id || null);
  // the buyer's refund: whether the Refund button is enabled, and every reason it is not (src/refunds.ts)
  const refund = u && p.price_cents > 0 && u.id !== p.owner_id ? await gameRefundState(c.env, s, u.id, p.id) : null;
  const [v, on] = await Promise.all([
    p.live_version ? getVersion(c.env, p.id, p.live_version) : null,
    s.play_clock_do ? c.env.DB.prepare('SELECT live_players AS n FROM game_online WHERE project_id = ? AND updated_at > ?').bind(p.id, now() - CLOCK_ONLINE_FRESH_MS).first<{ n: number }>()
      : c.env.DB.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM plays WHERE project_id = ? AND env = 'live' AND seen_at > ? AND kind != 'verify'").bind(p.id, now() - ONLINE_WINDOW_MS).first<{ n: number }>(),
  ]);
  return c.json({
    game: { ...card(origin, { ...p, playing: on?.n || 0 }), description: p.description, controls: p.controls, listing_i18n: parseJson(p.listing_i18n, {}), version: p.live_version, updated_at: v?.published_at || p.updated_at, screenshot: media(origin, v?.screenshot_key || null), owner_id: p.owner_id },
    reviews: reviews.results.map((r) => ({ rating: r.rating, body: r.body, at: r.updated_at, name: r.name, mine: !!u && r.user_id === u.id })),
    rating_dist: [1, 2, 3, 4, 5].map((n) => dist.results.find((d) => d.rating === n)?.n || 0),
    my_review: mine, played, owned, is_owner: !!u && u.id === p.owner_id,
    // whether the game is in this player's library: 'bought' (a paid game, from its purchase), 'added' (a free game they added) or null
    library,
    // where this player left off (null when they have nothing saved here): the page's Continue button
    continue: resume,
    // This buyer's purchase of it: the Refund button, enabled or greyed out with every reason (null without a paid purchase).
    refund,
    // A paid game's free trial, for a player who has not bought it: minutes offered and the time this account has left.
    trial,
    // What the game needs from the player's browser; the page compares it with what this browser has before launch.
    // ...and the rest of what the build declares: languages, players, session, progress, accessibility, the age rating.
    // ...and the on-screen controls the player hands the game on touch screens.
    ...(v ? await ensureVersionMeta(c.env, v).then(({ compat, meta, controls }) => ({
      controls,
      compat: { requirements: compat.requirements, declared: compat.declared, download_bytes: compat.download_bytes },
      meta: { ...meta.meta, rating: meta.rating, languages: meta.languages.languages, languages_declared: meta.languages.declared, declared: meta.declared, multiplayer: meta.detected.multiplayer },
      // adults only: the page blurs the cover and asks the player to confirm before the game starts (POST /play enforces it)
      mature: matureOf(meta.meta.content).categories,
    })).catch(() => ({ controls: null, compat: null, meta: null, mature: matureList(p) })) : { controls: null, compat: null, meta: null, mature: matureList(p) }),
  });
});

async function startPlay(c: Ctx, p: Project, envName: 'live' | 'preview', version: number, u: User, trialSeconds?: number, lifeS = PLAY_SESSION_S) {
  const kind = u.id === p.owner_id || u.role === 'admin' ? 'owner' : 'player', sid = 'ps_' + rid(16), t = now(), trial = trialSeconds !== undefined;
  // An account's session is bound to the sign-in that started it (session-binding.js): it ends when that sign-in does.
  const login = isGuestId(u.id) ? null : await loginIdOf(c.req.raw);
  // The session, its start time, its device (this request's User-Agent) and a trial's end are all the platform's own record.
  const insert = c.env.DB.prepare('INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at, trial, trial_until, login_id, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(sid, p.id, version, envName, u.id, kind, t, t, trial ? 1 : 0, trial ? t + trialSeconds * 1000 : null, login, (c.req.header('user-agent') || '').slice(0, 200) || null);
  // At scale (play_clock_do) the player's clock takes the new session at once: it never reads it back, and the game's
  // tally counts the day's sessions, so a start is one database write. Should the clock not answer, the start is
  // counted here and the clock reads the session when it first sees it.
  const s = await getSettings(c.env), clocked = s.play_clock_do && !!c.env.PLAY_CLOCK && !trial;
  const counts = kind === 'player' && envName === 'live';
  if (!clocked) {
    if (counts) await c.env.DB.batch([insert, sessionStartStmt(c.env.DB, p.id, t)]);
    else await insert.run();
  } else {
    await insert.run();
    const row = { id: sid, project_id: p.id, version, env: envName, user_id: u.id, kind, started_at: t, seen_at: null, seconds: 0, counted: 0, trial: 0, trial_seconds: 0, trial_until: null };
    const opened = await playClock(c.env, u.id).open(row, t).then(() => true, (e: unknown) => { console.error('clock open failed', String((e as Error)?.message || e)); return false; });
    if (counts && !opened) await sessionStartStmt(c.env.DB, p.id, t).run();
  }
  // A trial token lasts only as long as the trial time left (plus a little slack for the last heartbeat); a full one six hours.
  const life = trial ? trialSeconds + 20 : lifeS;
  const token = await signPlayToken({ g: p.id, e: envName, u: u.id, n: u.name, k: kind, s: sid, x: Math.floor(t / 1000) + life, ...(trial ? { tr: 1 } : {}) }, await playKey(c.env, p.id));
  return { url: `${await gameUrl(c.env, c.get('origin'), p.id, envName)}?gcp_t=${token}`, session: sid, clock: await clockTicket(c.env.SESSION_SECRET, sid, u.id, login), version, player: { id: u.id, name: u.name, guest: isGuestId(u.id) }, ...(trial ? { trial: { remaining_seconds: trialSeconds } } : {}) };
}

api.post('/games/:slug/play', async (c) => {
  const p = await liveGame(c, c.req.param('slug'));
  if (p.status !== 'live' || !p.live_version) throw new AppError(409, 'This game is offline.', 'offline');
  // An adults-only game starts only after the player has seen the warning and confirmed (the game page sends confirm_mature).
  if ((await liveMature(c.env, p)).length) {
    const b = await c.req.json<{ confirm_mature?: boolean }>().catch(() => ({} as { confirm_mature?: boolean }));
    if (b.confirm_mature !== true) throw new AppError(428, 'This game is for adults only. Confirm that you are 18 or older and want to see its content.', 'mature_confirm');
  }
  // "Require login to play" is enforced here, where play sessions are signed: with it on (the default) only accounts get
  // one, free games included. With it off, a visitor without an account plays a free game as a guest; paid games always need an account
  // (buying and free trials belong to one). Every service the game then calls checks the setting again (routes/rt.ts).
  if (!c.get('user')) {
    const s = await getSettings(c.env);
    if (s.require_login_to_play) throw new AppError(401, 'Sign in to play.', 'unauthenticated');
    if (p.price_cents > 0) throw new AppError(401, 'Sign in to buy or try this game.', 'unauthenticated');
    // Every visitor without a cookie becomes a new guest with its own save quota, so new guests are limited per network:
    // plenty for a carrier address shared by thousands of phones (carrier-grade NAT, common in much of Asia, Africa and
    // South America), too few to fill the database with throwaway guests. A returning guest is limited by its own id,
    // like an account, so busy neighbours on the same address never use up its play starts.
    const g = await guestIdentity(c.env, c.req.raw);
    if (g.cookie) await rateLimit(c.env, 'guestnew:' + clientNet(c.req.raw), 60, 3600);
    else await rateLimit(c.env, 'guestplay:' + g.id, 240, 3600);
    if (g.cookie) c.header('set-cookie', g.cookie, { append: true });
    return c.json(await startPlay(c, p, 'live', p.live_version, { id: g.id, name: g.name, role: 'player' } as unknown as User, undefined, GUEST_SESSION_S));
  }
  const u = requireUser(c);
  await rateLimit(c.env, 'play:' + u.id, 240, 3600);
  if (p.price_cents > 0 && u.id !== p.owner_id && u.role !== 'admin' && !(await owns(c.env, u.id, p.id))) {
    // Not bought: a free trial if the game offers one and this account has time left, otherwise the purchase prompt.
    const tr = await beginTrial(c.env, p, await getSettings(c.env), u.id);
    return c.json(await startPlay(c, p, 'live', p.live_version, u, tr.remaining_seconds));
  }
  return c.json(await startPlay(c, p, 'live', p.live_version, u));
});

// The signed-in player's own progress in one game (live). Only ever their own: the player comes from the session, not the request.
api.get('/games/:slug/progress', async (c) => {
  const u = requireUser(c), p = await liveGame(c, c.req.param('slug'));
  return c.json(await playerSummary(c.env.DB, scopeOf(p.id, 'live'), u.id));
});
api.delete('/games/:slug/progress', async (c) => {
  const u = requireUser(c), p = await liveGame(c, c.req.param('slug'));
  await rateLimit(c.env, 'reset:' + u.id, 20, 3600);
  return c.json(await resetPlayer(c.env.DB, scopeOf(p.id, 'live'), u.id));
});

// ---- continue playing ---------------------------------------------------------------------------
// The signed-in player's own games, most recently played first: the store's Continue row and the library. Only their own.
async function continueCards(c: Ctx, userId: string, limit: number, offset = 0) {
  const { list, more } = await continueList(c.env.DB, userId, { limit, offset });
  if (!list.length) return { games: [], more: false };
  const ids = list.map((x: { game_id: string }) => x.game_id), origin = c.get('origin');
  const rows = await c.env.DB.prepare(`SELECT p.*, u.name AS author FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<Record<string, any>>();
  const byId = new Map(rows.results.map((r) => [r.id, r]));
  const games = list.filter((x: { game_id: string }) => byId.has(x.game_id)).map(({ game_id, ...x }: Record<string, any>) => ({ ...card(origin, byId.get(game_id)!), progress: x }));
  return { games, more };
}
api.get('/me/continue', async (c) => {
  const u = requireUser(c);
  c.header('cache-control', 'private, no-store');
  return c.json(await continueCards(c, u.id, num(c.req.query('limit')) || 12, num(c.req.query('offset')) || 0));
});
// Takes a game off the Continue row until it is played again. Progress stays.
api.delete('/me/continue/:slug', async (c) => {
  const u = requireUser(c), p = await c.env.DB.prepare('SELECT id FROM projects WHERE slug = ?').bind(c.req.param('slug')).first<{ id: string }>();
  if (!p) throw notFound('No such game.');
  return c.json(await hideContinue(c.env.DB, scopeOf(p.id, 'live'), u.id, now()));
});
// ---- the game library (players' side; the creator console never lists games a person bought or added) ---------------
// What the library shows: the games played (the Continue row, paged), and the games the player owns or keeps: every paid
// game they bought (in it from the moment the payment succeeds, out again on a refund) and the free games they added.
const libraryErr = (e: unknown): never => { if (e instanceof LibraryError) throw new AppError((e as any).status, e.message, (e as any).code); throw e; };
async function libraryCards(c: Ctx, userId: string, offset: number, filter: string) {
  const { list, more } = await libraryList(c.env.DB, userId, { limit: 24, offset, filter });
  if (!list.length) return { games: [], more: false };
  const ids = list.map((x: { game_id: string }) => x.game_id), origin = c.get('origin');
  const rows = await c.env.DB.prepare(`SELECT p.*, u.name AS author FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<Record<string, any>>();
  const byId = new Map(rows.results.map((r) => [r.id, r]));
  return { games: list.filter((x: { game_id: string }) => byId.has(x.game_id)).map(({ game_id, ...x }: Record<string, any>) => ({ ...card(origin, byId.get(game_id)!), library: x })), more };
}
api.get('/me/library', async (c) => {
  const u = requireUser(c), offset = num(c.req.query('offset')) || 0;
  c.header('cache-control', 'private, no-store');
  const [played, owned, counts] = await Promise.all([continueCards(c, u.id, 24, offset), offset ? null : libraryCards(c, u.id, 0, 'all'), offset ? null : libraryCounts(c.env.DB, u.id)]);
  return c.json({ ...played, owned, counts });
});
// More of the owned part, or one filter of it: all, bought or added.
api.get('/me/library/games', async (c) => {
  const u = requireUser(c);
  c.header('cache-control', 'private, no-store');
  return c.json(await libraryCards(c, u.id, num(c.req.query('offset')) || 0, String(c.req.query('filter') || 'all')));
});
api.post('/me/library/:slug', async (c) => {
  const u = requireUser(c), p = await c.env.DB.prepare('SELECT id, status, price_cents FROM projects WHERE slug = ?').bind(c.req.param('slug')).first<{ id: string; status: string; price_cents: number }>();
  await rateLimit(c.env, 'library:' + u.id, 120, 3600);
  return c.json(await addToLibrary(c.env.DB, u.id, p, now()).catch(libraryErr));
});
api.delete('/me/library/:slug', async (c) => {
  const u = requireUser(c), p = await c.env.DB.prepare('SELECT id FROM projects WHERE slug = ?').bind(c.req.param('slug')).first<{ id: string }>();
  if (!p) throw notFound('No such game.');
  return c.json(await removeFromLibrary(c.env.DB, u.id, p.id));
});

// A player tells the platform something is wrong with a live game: it asks for passwords or payment, behaves differently
// than it did in review, uses someone else's work. Each report goes to the admin overview with the game's other flags.
export const REPORT_REASONS = ['phishing', 'malicious', 'stolen', 'offensive', 'broken', 'other'] as const;
api.post('/games/:slug/report', async (c) => {
  const u = requireUser(c), p = await liveGame(c, c.req.param('slug'));
  const b = await c.req.json<{ reason?: string; detail?: string }>().catch(() => ({} as { reason?: string; detail?: string }));
  const reason = String(b.reason || '');
  if (!(REPORT_REASONS as readonly string[]).includes(reason)) throw bad(`reason must be one of: ${REPORT_REASONS.join(', ')}.`);
  await rateLimit(c.env, 'report:' + u.id, 10, 86400);
  const detail = String(b.detail || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  await logEvent(c.env, p.id, 'player_report', detail ? `${reason}: ${detail}` : reason, p.live_version, 'user:' + u.id);
  return c.json({ ok: true });
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

const MEDIA_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
api.get('/media/*', async (c) => {
  const key = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/api\/media\//, ''));
  // shots/<project>/<version>[-play-i].ext and covers/<project>-<time>.ext
  const m = key.match(/^(shots)\/([A-Za-z0-9_\-]+)\/([A-Za-z0-9_.\-]+)$/) || key.match(/^(covers)\/([A-Za-z0-9_]+)-([A-Za-z0-9]+\.[a-z0-9]+)$/);
  if (!m || key.includes('..')) throw notFound();
  // Public only for a live game's cover and the pictures of versions that went live. A draft's, a removed game's or the
  // verifier's frames of an unpublished version are for the creator and admins.
  const p = await c.env.DB.prepare('SELECT owner_id, status, cover_key FROM projects WHERE id = ?').bind(m[2]).first<{ owner_id: string; status: string; cover_key: string | null }>();
  if (!p) throw notFound();
  const n = m[1] === 'shots' ? Number((m[3].match(/^(\d+)/) || [])[1]) : NaN;
  const published = p.status === 'live' && (key === p.cover_key || (Number.isInteger(n) && !!(await c.env.DB.prepare('SELECT 1 FROM versions WHERE project_id = ? AND n = ? AND published_at IS NOT NULL').bind(m[2], n).first())));
  const u = c.get('user');
  if (!published && !(u && (u.id === p.owner_id || u.role === 'admin'))) throw notFound();
  // Only pictures, typed by their name, never by what was stored with them: this is the platform's own origin, so an
  // object stored as HTML or SVG must never render here as a page.
  const type = MEDIA_TYPES[(key.match(/\.([a-z0-9]+)$/) || [])[1] || ''];
  if (!type) throw notFound();
  const obj = await c.env.FILES.get(key);
  if (!obj) throw notFound();
  return new Response(obj.body, { headers: {
    'content-type': type, 'cache-control': published ? 'public, max-age=3600' : 'private, no-store', etag: obj.httpEtag,
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
  } });
});

// ----- purchases + billing ---------------------------------------------------------------------
async function checkout(c: Ctx, u: User, name: string, amount: number, metadata: Record<string, string>, back: string, digitalGoods = false, closeBy?: number) {
  // A build skill is final once bought: it shows in full the moment the payment succeeds and is never refunded.
  const skill = metadata.kind === 'skill';
  const origin = c.get('origin'), brand = (await getSettings(c.env)).brand_name || DEFAULT_BRAND;
  const session = await stripe<{ id: string; url: string }>(c.env, 'POST', '/checkout/sessions', {
    // HearthCade is the seller of record and pays creators through Connect, which Stripe's Managed Payments (Stripe as
    // merchant of record) does not support; new Stripe accounts turn it on by default, so it is turned off per session.
    managed_payments: { enabled: false },
    mode: 'payment', integration_identifier: 'hearthcade_checkout_kqzvmrtd', client_reference_id: u.id, customer_email: u.email, metadata, payment_intent_data: { metadata },
    line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: amount, product_data: { name, description: `Sold by ${OPERATOR.name} on ${brand}` } } } },
    // The seller of record, next to the Pay button, with the terms the purchase falls under.
    custom_text: {
      submit: { message: `${brand} is developed and operated by ${OPERATOR.name}, the seller of this purchase.${skill ? ' Build skills are non-refundable.' : ''} Terms: ${origin}/legal/terms · Refunds: ${origin}/legal/refunds` },
      // A game is digital content delivered at once. EU and UK law gives buyers 14 days to cancel unless they ask for it
      // right away and accept losing that right, so the buyer ticks this before paying; Stripe records the consent.
      ...(digitalGoods ? { terms_of_service_acceptance: { message: skill
        ? `I agree to the [Terms](${origin}/legal/terms) and want this build skill shown to me right away. I understand that I then lose my right to cancel within 14 days, and that build skills are non-refundable ([refund policy](${origin}/legal/refunds)).`
        : `I agree to the [Terms](${origin}/legal/terms) and want access to this game right away. I understand that I then lose my right to cancel within 14 days; ${brand}'s own [refund policy](${origin}/legal/refunds) still applies.` } } : {}),
    },
    ...(digitalGoods ? { consent_collection: { terms_of_service: 'required' } } : {}),
    success_url: `${origin}${back}${back.includes('?') ? '&' : '?'}paid={CHECKOUT_SESSION_ID}`, cancel_url: `${origin}${back}`,
    ...(closeBy ? { expires_at: checkoutExpiry(closeBy) } : {}),
  });
  return c.json({ url: session.url });
}

// Creator licenses (src/license.ts). The web app's license page lists what can be bought; choosing one opens Stripe
// Checkout, or grants it at once when that license is free. An account with a valid license cannot buy either kind.
api.get('/license', async (c) => {
  const u = requireUser(c), s = await getSettings(c.env);
  c.header('cache-control', 'private, no-store');
  return c.json(licenseView(u, s, stripeReady(c.env)));
});

api.post('/billing/license', async (c) => {
  const u = requireUser(c), s = await getSettings(c.env), b = await c.req.json<{ plan?: string }>().catch(() => ({} as { plan?: string }));
  if (!isPlan(b.plan)) throw bad('Choose a license: "term" or "lifetime".');
  if (u.creator) throw new AppError(409, 'You already have a valid creator license.', 'already');
  const o = offerOf(s, b.plan);
  if (o.cents === 0) { await grantLicense(c.env, s, u.id, o.plan, 'admin', `free:${o.plan}:${u.id}:${now()}`, 0); return c.json({ ok: true, granted: o.plan }); }
  return checkout(c, u, `${s.brand_name} ${planName(o.plan, o.days)}`, o.cents, { kind: 'creator_fee', user_id: u.id, plan: o.plan }, '/license');
});

// ----- the Creator Store: build skills, free or sold, each under its game (src/skills.ts) -------------------------------
api.get('/creator-store', async (c) => {
  c.header('cache-control', 'private, no-store');
  return c.json(await storeList(c.env, c.get('origin'), c.get('user'), { query: c.req.query('q'), price: c.req.query('price'), sort: c.req.query('sort'), limit: Number(c.req.query('limit')) || undefined, offset: Number(c.req.query('offset')) || undefined }));
});
api.get('/creator-store/:slug', async (c) => {
  c.header('cache-control', 'private, no-store');
  return c.json(await storeItem(c.env, c.get('origin'), c.get('user'), c.req.param('slug')));
});
api.post('/creator-store/:slug/copied', async (c) => {
  const u = c.get('user');
  return c.json(await skillCopied(c.env, u, c.req.param('slug'), u?.id || 'net:' + clientNet(c.req.raw)));
});
api.post('/creator-store/:slug/buy', async (c) => {
  const u = requireUser(c), s = await getSettings(c.env), p = await getProject(c.env, c.req.param('slug'));
  if (!p || p.status !== 'live' || !p.open_implementation) throw notFound('That build skill is not in the Creator Store.');
  if (!(p.skill_price_cents > 0)) throw bad('This build skill is free.');
  if (!s.paid_skills_enabled) throw forbidden('Build skill sales are turned off on this platform.');
  if (u.id === p.owner_id) throw bad('This is your own game\'s skill.');
  if (await ownsSkill(c.env, u.id, p.id)) throw new AppError(409, 'You already own this build skill.', 'already');
  const live = await liveSkill(c.env, p);
  if (!live || live.generated) throw new AppError(409, 'This build skill is not written yet.', 'not_ready');
  return checkout(c, u, `Build skill: ${p.title}`, p.skill_price_cents, { kind: 'skill', user_id: u.id, project_id: p.id }, `/creator-store/${p.slug}`, true);
});

api.post('/games/:slug/buy', async (c) => {
  const u = requireUser(c), p = await liveGame(c, c.req.param('slug'));
  if (p.status !== 'live') throw new AppError(409, 'This game is offline.', 'offline');
  if (p.price_cents <= 0) throw bad('This game is free.');
  if (u.id === p.owner_id) throw bad('This is your own game.');
  if (await owns(c.env, u.id, p.id)) throw new AppError(409, 'You already own this game.', 'already');
  // During a sale the buyer pays the sale price. The checkout closes when the sale ends (Stripe keeps a session open at
  // least 30 minutes), so a sale price is never charged long after the sale. Stripe's amount_total is what gets recorded,
  // and what a refund gives back.
  const sale = saleOf(p), amount = sale ? sale.price_cents : p.price_cents;
  return checkout(c, u, p.title, amount, { kind: 'game', user_id: u.id, project_id: p.id, ...(sale ? { sale_regular_cents: String(sale.regular_cents), sale_ends_at: String(sale.ends_at) } : {}) }, `/g/${p.slug}`, true, sale ? sale.ends_at : undefined);
});

// The page showing a game (the store page, or the console's preview) checks in every 30 seconds while the game is open,
// saying how long the game was on screen since the last check-in. This is the platform's play clock (src/play-clock.ts):
// it runs on the platform's own origin with the player's sign-in, so the game, on another origin, cannot send it. Every
// play number (counted plays, play time, players online, the player's record, trial time, refund play time) comes from it.
api.post('/plays/:sid/seen', async (c) => {
  const s = await getSettings(c.env), sid = c.req.param('sid');
  const b = await c.req.json<{ visible_ms?: number }>().catch(() => ({} as { visible_ms?: number }));
  // At scale (play_clock_do) the check-in goes to the player's clock in a Durable Object. Its ticket says whose it is
  // without a database read, and the clock confirms the sign-in once a minute (src/clock-do.ts). Free-trial sessions,
  // and anything the clock does not know, take the database path below.
  if (s.play_clock_do && c.env.PLAY_CLOCK) {
    const ticketed = await readClockTicket(c.env.SESSION_SECRET, c.req.header(CLOCK_HEADER), sid, await loginIdOf(c.req.raw));
    // the sign-in middleware skipped its lookup for a ticketed check-in (src/index.ts): without a good ticket, look now
    const player = ticketed && (!isGuestId(ticketed) || ticketed === await guestCookieId(c.env, c.req.raw)) ? ticketed
      : ((c.get('user') ?? await userFromRequest(c.env, c.req.raw))?.id || await existingGuestId(c.env, c.req.raw));
    if (!player) throw new AppError(401, 'Sign in first.', 'unauthenticated');
    const r = await playClock(c.env, player).checkIn(sid, player, b.visible_ms, now(), s.play_min_seconds);
    if (r.ok || r.reason !== 'unknown') { return c.json(JSON.parse(JSON.stringify(r))); }
    return c.json(await checkIn(c.env, s, sid, player, b.visible_ms, now()));
  }
  const u = c.get('user'), player = u?.id || await existingGuestId(c.env, c.req.raw);
  if (!player) throw new AppError(401, 'Sign in first.', 'unauthenticated');
  return c.json(await checkIn(c.env, s, sid, player, b.visible_ms, now()));
});

// A buyer refunds a game themselves (src/refunds.ts): within refund_window_hours of buying it and with less than
// refund_max_play_minutes played, once per game. The server checks every rule; an eligible refund goes back through
// Stripe at once, access goes and the creator's credit (still on hold) is taken back. What the platform cannot settle
// by itself becomes a request an admin decides. Build skills are non-refundable.
async function buyerRefund(c: Ctx, purchaseId: string | null, projectId: string | null) {
  const u = requireUser(c), s = await getSettings(c.env);
  await rateLimit(c.env, 'refund:' + u.id, 5, 3600);
  const b = await c.req.json<{ note?: string }>().catch(() => ({} as { note?: string }));
  // the play time a refund depends on must be the clock's latest, not its last batch (src/clock-do.ts)
  if (s.play_clock_do && c.env.PLAY_CLOCK) await playClock(c.env, u.id).flush();
  let id = purchaseId;
  if (!id) {
    const x = await c.env.DB.prepare("SELECT id FROM purchases WHERE user_id = ? AND project_id = ? AND status = 'paid' ORDER BY created_at DESC LIMIT 1").bind(u.id, projectId).first<{ id: string }>();
    if (!x) throw new AppError(409, 'You have no purchase of this game to refund.', 'not_refundable');
    id = x.id;
  }
  const r = await requestRefund(c.env, s, u.id, id, String(b.note || ''), stripePay(c.env), c.get('origin'));
  return c.json({ ok: true, status: r.status, id: r.id, review: r.review_reason, timeline: '5-10 business days' });
}
api.post('/games/:slug/refund', async (c) => {
  const p = await c.env.DB.prepare('SELECT id FROM projects WHERE slug = ?').bind(c.req.param('slug')).first<{ id: string }>();
  if (!p) throw notFound('That game is not available.');
  return buyerRefund(c, null, p.id);
});
api.post('/me/purchases/:id/refund', (c) => buyerRefund(c, c.req.param('id'), null));
// The buyer's purchase history: every game and build skill bought, each game with its refund button state.
api.get('/me/purchases', async (c) => {
  const u = requireUser(c), s = await getSettings(c.env);
  c.header('cache-control', 'private, no-store');
  return c.json(await purchaseHistory(c.env, s, u.id, c.get('origin')));
});

async function creatorFeeSession(env: Env, paymentIntent: string): Promise<string | null> {
  // A Stripe failure here must reach the webhook's caller, so Stripe retries the event instead of it being dropped.
  const list = await stripe<{ data: { id: string }[] }>(env, 'GET', '/checkout/sessions', { payment_intent: paymentIntent, limit: 1 });
  return list.data[0]?.id || null;
}

/** Takes back a creator license whose payment was refunded or disputed. */
async function revokeCreatorFee(env: Env, paymentIntent: string, status: 'refunded' | 'disputed' = 'refunded'): Promise<void> {
  const sid = await creatorFeeSession(env, paymentIntent);
  if (!sid) return;
  const pay = await env.DB.prepare("SELECT id, user_id FROM payments WHERE provider_ref = ? AND kind = 'creator_fee' AND status = 'paid'").bind(sid).first<{ id: string; user_id: string }>();
  if (!pay) return;
  await env.DB.prepare("UPDATE payments SET status = ? WHERE id = ? AND status = 'paid'").bind(status, pay.id).run();
  await syncLicense(env, pay.user_id);   // any other paid grant (an admin grant, a later payment) still counts
}

/** A disputed creator license payment that the platform won: the license comes back. */
async function restoreCreatorFee(env: Env, paymentIntent: string): Promise<void> {
  const sid = await creatorFeeSession(env, paymentIntent);
  if (!sid) return;
  const pay = await env.DB.prepare("SELECT id, user_id FROM payments WHERE provider_ref = ? AND kind = 'creator_fee' AND status = 'disputed'").bind(sid).first<{ id: string; user_id: string }>();
  if (!pay) return;
  await env.DB.prepare("UPDATE payments SET status = 'paid' WHERE id = ? AND status = 'disputed'").bind(pay.id).run();
  await syncLicense(env, pay.user_id);
}

/**
 * Makes sure the sale behind a payment is recorded before a refund or dispute is applied to it. Stripe does not promise
 * event order, and a chargeback on a fresh payment can arrive before checkout.session.completed; without this the dispute
 * would find nothing to reverse and the late sale would then grant the game anyway.
 */
async function syncPayment(env: Env, paymentIntent: string): Promise<void> {
  const list = await stripe<{ data: any[] }>(env, 'GET', '/checkout/sessions', { payment_intent: paymentIntent, limit: 1 });
  if (list.data[0]) await applySession(env, list.data[0]);
}

/** Applies a paid Checkout Session. Safe to call more than once for the same session. */
async function applySession(env: Env, session: any): Promise<string> {
  if (!session || session.payment_status !== 'paid') return 'unpaid';
  const m = session.metadata || {};
  const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null;
  if (m.kind === 'creator_fee' && m.user_id) {
    // Checkouts made before there were two licenses carry no plan: they bought the one-time unlimited license, now lifetime.
    const plan = isPlan(m.plan) ? m.plan : 'lifetime';
    const r = await grantLicense(env, await getSettings(env), m.user_id, plan, 'stripe', session.id, session.amount_total || 0);
    if (r === 'already_licensed') {
      // The account got a valid license while this checkout was open (another tab, the other kind): the payment is given
      // back at once and kept on record as refunded, so nobody pays for a license they cannot use.
      if (pi) await stripe(env, 'POST', '/refunds', { payment_intent: pi, reason: 'duplicate', metadata: { session: session.id } }, 'dup:' + session.id);
      await env.DB.prepare("INSERT INTO payments (id, user_id, kind, amount_cents, provider, provider_ref, status, plan, created_at) VALUES (?, ?, 'creator_fee', ?, 'stripe', ?, 'refunded', ?, ?)")
        .bind('pay_' + rid(16), m.user_id, session.amount_total || 0, session.id, plan, now()).run();
      return 'duplicate_refunded';
    }
    return 'creator_fee';
  }
  if (m.kind === 'game' && m.user_id && m.project_id) {
    const p = await getProject(env, m.project_id);
    if (!p) return 'missing_project';
    const sale = { userId: m.user_id, projectId: p.id, ownerId: p.owner_id, title: p.title, priceCents: session.amount_total || p.price_cents, provider: 'stripe' as const, providerRef: session.id, paymentIntent: pi };
    try { await recordPurchase(env, await getSettings(env), { ...sale, openImplementation: freeSkillShared(p) }); }
    catch (e) {
      // The buyer already owns the game (two checkouts open at once, or paid in two tabs): the second payment is given
      // back at once and kept on record as refunded, instead of failing and leaving the money taken.
      if (!/UNIQUE/i.test(String((e as Error).message))) throw e;
      if (await env.DB.prepare('SELECT 1 FROM purchases WHERE provider_ref = ?').bind(session.id).first()) return 'game';
      if (pi) await stripe(env, 'POST', '/refunds', { payment_intent: pi, reason: 'duplicate', metadata: { session: session.id } }, 'dup:' + session.id);
      await env.DB.prepare("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, provider_ref, payment_intent, status, created_at, refunded_at) VALUES (?, ?, ?, ?, ?, 0, 0, 'stripe', ?, ?, 'refunded', ?, ?)")
        .bind('pur_' + rid(20), m.user_id, p.id, p.owner_id, sale.priceCents, session.id, pi, now(), now()).run();
      return 'duplicate_refunded';
    }
    return 'game';
  }
  if (m.kind === 'skill' && m.user_id && m.project_id) {
    // a build skill: its own table and sales count, the skill commission (src/earnings.ts splitSkillSale)
    const p = await getProject(env, m.project_id);
    if (!p) return 'missing_project';
    const sale = { userId: m.user_id, projectId: p.id, ownerId: p.owner_id, title: p.title, priceCents: session.amount_total || p.skill_price_cents, provider: 'stripe' as const, providerRef: session.id, paymentIntent: pi, item: 'skill' as const };
    try { await recordPurchase(env, await getSettings(env), sale); }
    catch (e) {
      if (!/UNIQUE/i.test(String((e as Error).message))) throw e;
      if (await env.DB.prepare('SELECT 1 FROM skill_purchases WHERE provider_ref = ?').bind(session.id).first()) return 'skill';
      if (pi) await stripe(env, 'POST', '/refunds', { payment_intent: pi, reason: 'duplicate', metadata: { session: session.id } }, 'dup:' + session.id);
      await env.DB.prepare("INSERT INTO skill_purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, provider_ref, payment_intent, status, created_at, refunded_at) VALUES (?, ?, ?, ?, ?, 0, 0, 'stripe', ?, ?, 'refunded', ?, ?)")
        .bind('spur_' + rid(20), m.user_id, p.id, p.owner_id, sale.priceCents, session.id, pi, now(), now()).run();
      return 'duplicate_refunded';
    }
    return 'skill';
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
  // Creators' payout accounts (Accounts v2) report changes as thin events that carry only the account's id: the account is
  // read back from Stripe, so nothing in the event body is trusted beyond which account to look at.
  if (typeof event.type === 'string' && event.type.startsWith('v2.core.account')) {
    const id = event.related_object?.type === 'v2.core.account' ? String(event.related_object.id || '') : '';
    if (/^acct_[A-Za-z0-9]+$/.test(id) && await c.env.DB.prepare('SELECT 1 FROM users WHERE stripe_account = ?').bind(id).first())
      await c.env.DB.prepare('UPDATE users SET stripe_payouts_enabled = ? WHERE stripe_account = ?').bind((await payoutReady(c.env, id)) ? 1 : 0, id).run();
    return c.json({ received: true });
  }
  // Snapshot events from a connected account (they name the account) are not the platform's money: ignored.
  if (event.account) return c.json({ received: true, ignored: true });
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') await applySession(c.env, o);
  else if (event.type === 'charge.refunded' && o?.payment_intent) {
    const pi = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent.id;
    await syncPayment(c.env, pi);
    // a refunded game sale takes back access and the creator's credit; a refunded creator fee takes back the license;
    // a partial refund (Dashboard) takes back the same share of the creator's credit and leaves the game with the buyer
    if (o.refunded) { if (!(await refundPurchase(c.env, { paymentIntent: pi }))) await revokeCreatorFee(c.env, pi); }
    else if (Number(o.amount_refunded) > 0) await partialRefund(c.env, pi, Number(o.amount_refunded));
  } else if ((event.type === 'charge.dispute.created' || event.type === 'charge.dispute.closed') && o?.payment_intent) {
    // The platform is the seller of record, so a chargeback is debited from the platform's Stripe balance. The buyer loses
    // access and the creator's credit is held back while it is open; winning (or an inquiry closing) gives both back.
    const pi = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent.id;
    await syncPayment(c.env, pi);
    if (event.type === 'charge.dispute.created') { if (!(await disputePurchase(c.env, pi))) await revokeCreatorFee(c.env, pi, 'disputed'); }
    else if (o.status === 'won' || o.status === 'warning_closed') { if (!(await disputeWon(c.env, pi))) await restoreCreatorFee(c.env, pi); }
  }
  return c.json({ received: true });
});

api.post('/billing/payout-account', async (c) => {
  const u = requireUser(c), origin = c.get('origin');
  const b = await c.req.json<{ country?: string }>().catch(() => ({} as any));
  let acct = u.stripe_account;
  if (!acct) {
    const country = String(b.country || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw bad('Choose the country of your bank account.');
    // Accounts v2, marketplace recipient: the creator receives Transfers from the platform's balance and Stripe pays them
    // out to their bank. HearthCade is the seller of record, so it collects Stripe's fees and carries negative balances.
    // A recipient in another country than the platform accepts the recipient service agreement during onboarding.
    const a = await stripeV2<{ id: string }>(c.env, 'POST', '/core/accounts', {
      contact_email: u.email, display_name: u.name.slice(0, 100), dashboard: 'express',
      identity: { country: country.toLowerCase(), entity_type: 'individual' },
      defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
      configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
      metadata: { user_id: u.id },
    }, 'acct2:' + u.id + ':' + country);
    acct = a.id;
    // Only the first account sticks: two clicks at once cannot leave the user pointing at an account they did not onboard.
    await c.env.DB.prepare('UPDATE users SET stripe_account = ?, payout_country = ? WHERE id = ? AND stripe_account IS NULL').bind(acct, country, u.id).run();
    acct = (await c.env.DB.prepare('SELECT stripe_account FROM users WHERE id = ?').bind(u.id).first<{ stripe_account: string }>())!.stripe_account;
  }
  const link = await stripeV2<{ url: string }>(c.env, 'POST', '/core/account_links', {
    account: acct,
    use_case: { type: 'account_onboarding', account_onboarding: { collection_options: { fields: 'eventually_due' }, refresh_url: `${origin}/console/earnings?payout=retry`, return_url: `${origin}/console/earnings?payout=done` } },
  });
  return c.json({ url: link.url });
});

api.post('/billing/payout-account/refresh', async (c) => {
  const u = requireUser(c);
  if (!u.stripe_account) return c.json({ payouts_enabled: false });
  const on = (await payoutReady(c.env, u.stripe_account)) ? 1 : 0;
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
  const w = await startWithdrawal(env, u.id, amount, method, String(b.details || ''));
  if (w.result === 'failed') throw new AppError(502, 'The transfer did not go through and your balance was restored.', 'transfer_failed');
  if (w.result === 'unknown') return c.json({ ok: true, id: w.id, amount_cents: amount, method, pending: true, note: 'Stripe did not confirm the transfer yet. It is checked again in a few minutes; your balance stays reserved meanwhile.' });
  return c.json({ ok: true, id: w.id, amount_cents: amount, method });
});

// ----- creator console -------------------------------------------------------------------------
api.get('/console/overview', async (c) => {
  const u = requireUser(c), origin = c.get('origin'), s = await getSettings(c.env);
  const projects = await c.env.DB.prepare("SELECT p.*, ? AS author FROM projects p WHERE p.owner_id = ? AND p.status != 'removed' ORDER BY p.updated_at DESC").bind(u.name, u.id).all<Record<string, any>>();
  const sales = await c.env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(net_cents), 0) AS net FROM purchases WHERE owner_id = ? AND status = 'paid'").bind(u.id).first<{ n: number; net: number }>();
  const skillSales = await c.env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(net_cents), 0) AS net FROM skill_purchases WHERE owner_id = ? AND status = 'paid'").bind(u.id).first<{ n: number; net: number }>();
  return c.json({
    user: pubUser(u), balance: await balanceOf(c.env, u.id), sales: sales || { n: 0, net: 0 }, skill_sales: skillSales || { n: 0, net: 0 },
    skills_shared: projects.results.filter((p) => p.open_implementation && p.status === 'live').length,
    projects: projects.results.map((p) => ({ ...card(origin, p), live_version: p.live_version, preview_version: p.preview_version, sales: p.sales, skill_price_cents: p.skill_price_cents, skill_sales: p.skill_sales, updated_at: p.updated_at })),
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
  const [skillSales, skillRows] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price_cents), 0) AS gross, COALESCE(SUM(net_cents), 0) AS net FROM skill_purchases WHERE project_id = ? AND status = 'paid'").bind(p.id).first(),
    db.prepare('SELECT version, description, written_by, updated_at, LENGTH(content) AS characters FROM game_skills WHERE project_id = ? ORDER BY version DESC LIMIT 10').bind(p.id).all(),
  ]);
  const s = await getSettings(c.env), trials = await trialStats(c.env, p.id);
  // The newest version's store-page metadata: what publishing still needs (field ids), and the age rating it works out to.
  const newest = versions.results[0], vm = newest ? await ensureVersionMeta(c.env, newest).catch(() => null) : null;
  const metadata = newest ? { version: newest.n, required: s.metadata_required, missing: missingToPublish(vm?.meta, !!vm?.compat?.declared, JSON.parse(p.tags || '[]')).map((m) => m.split(' ')[0]), age: vm?.meta?.rating?.age ?? null, declared: vm?.meta?.declared ?? [] } : null;
  return c.json({
    metadata,
    project: { ...card(origin, { ...p, author: u.name }), regular_price_cents: p.price_cents, open_implementation_at: p.open_implementation_at, description: p.description, controls: p.controls, live_version: p.live_version, preview_version: p.preview_version, removed_reason: p.removed_reason, created_at: p.created_at, updated_at: p.updated_at },
    versions: versions.results.map((v) => { const g = storedGate(v); return { ...publicVersion(v, origin), eligible: versionEligible(v, s.verify_browser_required), current: currentChecks(v, s), release: g ? gateView(g) : null }; }),
    events: events.results, daily: daily.results, errors: errors.results, sales,
    files: { count: files.length, bytes: files.reduce((a, f) => a + f.size, 0), storage_bytes: budgetOf(p, s).bytes, storage_set: budgetOf(p, s).source === 'game', request: await latestRequest(c.env, p.id).then((r) => r && { status: r.status, bytes: r.bytes, granted_bytes: r.granted_bytes, note: r.note, created_at: r.created_at }) },
    split: p.price_cents > 0 ? splitSale(p.price_cents, s, freeSkillShared(p)) : null,
    // the limited-time sale: the one running (with what the creator receives per sale at that price), the last one, and
    // when the next can start (src/sales.ts)
    sale: (() => { const v = saleView(p, s); return { ...v, split: v.running ? splitSale(v.running.price_cents, s, freeSkillShared(p)) : null }; })(),
    skill: {
      shared: !!p.open_implementation, price_cents: p.skill_price_cents || 0, sales: skillSales, copies: p.skill_copies, views: p.skill_views,
      split: p.skill_price_cents > 0 ? splitSkillSale(p.skill_price_cents, s) : null, versions: skillRows.results,
      live: await liveSkill(c.env, p).then((l) => l && { version: l.row.version, in_sync: l.current, written_by_platform: l.generated }).catch(() => null),
      newest_version: p.preview_version, required_to_publish: !!s.skill_required_to_publish,
    },
    trial: { minutes: p.trial_minutes, active: trialMinutes(p, s) > 0, ...trials },
    online: await onlineNow(c.env, p.id),
    implementation: p.open_implementation ? await db.prepare('SELECT version, summary_source, reads, created_at FROM implementations WHERE project_id = ?').bind(p.id).first() : null,
  });
});

// Preview test bots (src/bots.ts): bot players that join the creator's own preview over the real network path.
api.get('/console/projects/:id/bots', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  const [options, status] = await Promise.all([botOptions(c.env, p, u), botStatus(c.env, u, p.id)]);
  return c.json({ options, status });
});
api.post('/console/projects/:id/bots', async (c) => {
  const u = requireUser(c), b = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  await rateLimit(c.env, 'bots:' + u.id, 30, 3600);
  return c.json(await startBots(c.env, c.get('origin'), u, c.req.param('id'), b));
});
api.post('/console/projects/:id/bots/act', async (c) => {
  const u = requireUser(c), b = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return c.json(await actBots(c.env, u, c.req.param('id'), b));
});
api.delete('/console/projects/:id/bots', async (c) => {
  const u = requireUser(c);
  return c.json(await stopBots(c.env, u, c.req.param('id')));
});

/** Players who started a free trial of this game, and how many of them then bought it. */
export async function trialStats(env: Env, pid: string): Promise<{ players: number; bought: number }> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS players, COALESCE(SUM(EXISTS (SELECT 1 FROM purchases x WHERE x.project_id = t.project_id AND x.user_id = t.user_id AND x.status = 'paid')), 0) AS bought FROM trials t WHERE t.project_id = ?").bind(pid).first<{ players: number; bought: number }>();
  return { players: r?.players || 0, bought: r?.bought || 0 };
}

// Analytics: the full picture for a window of days, and the cheap live count the dashboard polls.
api.get('/console/projects/:id/analytics', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  return c.json({ project: { id: p.id, title: p.title, slug: p.slug, status: p.status, live_version: p.live_version }, ...(await gameAnalytics(c.env, p.id, Number(c.req.query('days')) || 30)) });
});
api.get('/console/projects/:id/online', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  return c.json(await onlineNow(c.env, p.id));
});

api.post('/console/projects/:id/preview', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  if (!p.preview_version) throw new AppError(409, 'No preview has been deployed yet. Ask your agent to run deploy_preview.', 'no_preview');
  await ensurePreview(c.env, c.get('origin'), p);   // removed after two idle weeks: deployed again first
  return c.json(await startPlay(c, p, 'preview', p.preview_version, u));
});

// The creator feedback queue (src/feedback.ts): annotated screenshots of the preview, waiting for the creator's agent.
// base64 of every picture of one item, with room for the note, marks and context
const FEEDBACK_BODY_MAX = Math.ceil(FEEDBACK_LIMITS.item_bytes / 3) * 4 + 300_000;
// Owner only, never an admin looking at someone else's game.
api.get('/console/projects/:id/feedback', async (c) => {
  const u = requireUser(c), p = await feedbackProject(c.env, u, c.req.param('id'));
  return c.json(await listFeedback(c.env, p));
});
api.post('/console/projects/:id/feedback', async (c) => {
  const u = requireUser(c), p = await feedbackProject(c.env, u, c.req.param('id'));
  // the pictures travel as data URLs (the screenshot and any attached, FEEDBACK_LIMITS.item_bytes together): refuse an
  // oversized body before reading it
  const raw = await readCapped(c.req.raw, FEEDBACK_BODY_MAX);   // with or without a Content-Length, never more than the limit
  if (!raw) throw new AppError(413, 'The pictures are too large together.', 'too_large');
  const text = new TextDecoder().decode(raw);
  const b = parseJson<Record<string, unknown> | null>(text, null);
  if (!b || typeof b !== 'object') throw bad('Send the feedback as JSON.');
  return c.json(await addFeedback(c.env, u, p, b));
});
api.get('/console/projects/:id/feedback/:fid/image', async (c) => {
  const u = requireUser(c), p = await feedbackProject(c.env, u, c.req.param('id'));
  // ?n=1… for the pictures the creator attached
  const n = Math.round(Number(c.req.query('n') || 0));
  return feedbackImage(c.env, p, c.req.param('fid'), Number.isFinite(n) && n > 0 && n <= 10 ? n : 0);
});
api.delete('/console/projects/:id/feedback/:fid', async (c) => {
  const u = requireUser(c), p = await feedbackProject(c.env, u, c.req.param('id'));
  return c.json(await removeFeedback(c.env, p, c.req.param('fid')));
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
  // checked here so the console can say why at once; the pipeline checks again before the game goes back live
  const v = await getVersion(c.env, p.id, p.live_version);
  if (!v) throw bad('The version that was live no longer exists.');
  const g = await releaseGate(c.env, p, v, { mode: 'restore' });
  await recordGate(c.env, g);
  if (!g.ok) throw gateError(g);
  await enqueue(c.env, { kind: 'publish', pid: p.id, n: p.live_version, origin: c.get('origin'), actor: 'console', mode: 'restore' });
  return c.json({ ok: true });
});

api.patch('/console/projects/:id', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, any>));
  if (b.price_cents !== undefined || b.trial_minutes !== undefined) await updateProjectMeta(c.env, p, { price_cents: b.price_cents, trial_minutes: b.trial_minutes });
  if (b.trial_minutes !== undefined) await logEvent(c.env, p.id, 'trial', Number(b.trial_minutes) > 0 ? `Free trial set to ${Math.round(Number(b.trial_minutes))} min` : 'Free trial turned off', null, 'console');
  if (b.skill_price_cents !== undefined) await setSkillPrice(c.env, await getSettings(c.env), p, b.skill_price_cents, 'console');
  if (b.sale !== undefined) await applySale(c.env, p, b.sale, 'console');
  if (typeof b.open_implementation === 'boolean') await setOpenImplementation(c.env, p, b.open_implementation, 'console');
  return c.json({ ok: true });
});
// What other developers' agents see when this game's implementation is open (a preview while it is not).
api.get('/console/projects/:id/implementation', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  if (!p.live_version) return c.json({ card: null });
  return c.json({ card: await implementationCard(c.env, c.get('origin'), u, p.id) });
});

api.get('/console/earnings', async (c) => {
  const u = requireUser(c), s = await getSettings(c.env), db = c.env.DB;
  const [ledger, withdrawals, byGame] = await Promise.all([
    db.prepare('SELECT kind, amount_cents, note, available_at, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100').bind(u.id).all(),
    db.prepare('SELECT id, amount_cents, method, status, error, created_at, settled_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(u.id).all(),
    db.prepare("SELECT p.title, p.slug, COUNT(*) AS n, SUM(x.price_cents) AS gross, SUM(x.fee_cents) AS fees, SUM(x.net_cents) AS net FROM purchases x JOIN projects p ON p.id = x.project_id WHERE x.owner_id = ? AND x.status = 'paid' GROUP BY x.project_id ORDER BY net DESC").bind(u.id).all(),
  ]);
  const [gameTotal, skills] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price_cents), 0) AS gross, COALESCE(SUM(fee_cents), 0) AS fees, COALESCE(SUM(net_cents), 0) AS net FROM purchases WHERE owner_id = ? AND status = 'paid'").bind(u.id).first(),
    skillSalesOf(c.env, u.id),
  ]);
  return c.json({
    balance: await balanceOf(c.env, u.id), min_cents: s.withdraw_min_cents, hold_days: Math.ceil(holdMs(s, now() - u.created_at) / 86400000), fee_percent: s.platform_fee_percent, fee_open_percent: s.platform_fee_open_percent,
    skill_fee_percent: s.skill_fee_percent, game_sales: gameTotal, skill_sales: skills.total, by_skill: skills.by_game,
    payments: stripeReady(c.env), manual: s.allow_manual_withdrawals, auto: !!s.auto_payouts, user: pubUser(u), ledger: ledger.results, withdrawals: withdrawals.results, by_game: byGame.results,
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
  await rateLimit(c.env, 'claim:' + clientNet(c.req.raw), 10, 3600);
  if (!c.env.ADMIN_CLAIM_TOKEN || !safeEqual(String(b.token || ''), c.env.ADMIN_CLAIM_TOKEN)) throw forbidden('That claim link is not valid.');
  // one statement: two people claiming at the same moment cannot both become the first admin. The link works once
  // ever: once used it stays used, even if every admin is later demoted (the _admin_claimed row; getSettings ignores it).
  const r = await c.env.DB.prepare("UPDATE users SET role = 'admin', creator = 1, creator_since = COALESCE(creator_since, ?1) WHERE id = ?2 AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin') AND NOT EXISTS (SELECT 1 FROM settings WHERE key = '_admin_claimed')").bind(now(), u.id).run();
  if (!r.meta.changes) throw forbidden('This claim link was already used. Ask an admin to promote you.');
  await c.env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('_admin_claimed', ?, ?) ON CONFLICT(key) DO NOTHING").bind(JSON.stringify(u.id), now()).run();
  // the first admin is a creator for good: a lifetime license on record, so recomputing the license keeps it
  await grantLicense(c.env, await getSettings(c.env), u.id, 'lifetime', 'admin', 'claim:' + u.id, 0, true);
  return c.json({ ok: true });
});

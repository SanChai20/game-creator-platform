// The web app's API: accounts, marketplace, play sessions, purchases, the creator console and billing.
import { actBots, botOptions, botStatus, inviteBotFor, startBots, stopBots } from '../bots';
import { Hono } from 'hono';
import { AppError, bad, forbidden, notFound, type Env, type Project, type User } from '../env';
import { clearGuestCookie, clientNet, createSession, endPreviousLogin, existingGuestId, guestCookieId, guestIdentity, userFromRequest, isGuestId, loginIdOf, newUserId, rateLimit, requireUser, sessionCookie, sessionToken, type Ctx } from '../auth';
import { CODE_TTL_MS, checkCode, cleanName, confirmedUntil, markConfirmed, newSignupLink, normEmail, peekSignupLink, safeNext, startCode, takeSignupLink, validEmail } from '../email-auth';
import { ALGS, PASSKEY_CHALLENGE_TTL_MS, passkeyName, verifyAssertion, verifyRegistration, type AssertionJSON, type RegistrationJSON } from '../passkey';
import { sendAuthMail } from '../auth-mail';
import { pageLang } from '../consent-text';
import { GUEST_SESSION_S, PLAY_SESSION_S } from './rt';
import { gameUrl, playKey, undeployGame } from '../deploy';
import { ensurePreview } from '../cleanup';
import { deleteAccount, deleteBlocker } from '../account';
import { devMailOn, devOutbox, testMailbox } from '../mail';
import { answerChallenge, beginSetup, confirmSetup, disableTwoFactor, replaceRecoveryCodes, startChallenge, twoFactorOn, twoFactorState, useCode } from '../two-factor';
import { holdMs, balanceOf, disputePurchase, disputeWon, freeSkillShared, owns, ownsSkill, partialRefund, recordPurchase, refundPurchase, splitSale, splitSkillSale } from '../earnings';
import { gameRefundState, purchaseHistory, requestRefund, stripePay } from '../refunds';
import { liveSkill, setSkillPrice, skillCopied, skillCoverage, skillLangCodes, skillSalesOf, storeItem, storeList } from '../skills';
import { enqueue } from '../pipeline';
import { matureOf } from '../../web/src/gamemeta';
import { liveMature, matureList } from '../mature';
import { missingToPublish, normalizeStoredTags, tagGroup } from '../../web/src/tags';
import { listingLangs } from '../listing';
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
import { REPORT_REASONS, fileReport, shelfWhere, storeStatus, type ReportReason } from '../store-quality';
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
import { addDays, b64u, dayOf, now, parseJson, readCapped, rid, safeEqual, sha256, token, unb64 } from '../util';
// @ts-ignore plain JS module
import { signPlayToken } from '../runtime/game-worker.js';
// @ts-ignore plain JS module
import { continueList, hideContinue, playerSummary, resetPlayer, scopeOf } from '../player-data.js';
import { publishDevlog } from '../devlog-news';
// @ts-ignore plain JS module
import { DevlogError, deleteDevlog, editDevlog, listDevlogs } from '../devlogs.js';
// @ts-ignore plain JS module
import { WishError, addWish, announceIssues, canWish, comingSoonGames, isComingSoon, isWished, removeWish, setComingSoon, wishCount, wishlistOf } from '../wishlist.js';
// @ts-ignore plain JS module
import { declaredFor, rarityOf, unlocksOf, viewOf } from '../achievements.js';
// @ts-ignore plain JS module
import { claimGuest, guestProgress } from '../session-binding.js';
import { pushTo, socialHub } from '../social';
import { askForGift, cancelGiftRequest, checkGift, declineGift, gameGiftState, giftDelivered, giftableFriends, giftOverview, giftsOn } from '../gifts';
// @ts-ignore plain JS module
import { ensureProfile } from '../social-rules.js';
import { LibraryError, addToLibrary, libraryCounts, libraryList, libraryState, removeFromLibrary } from '../library.js';
import { deleteFacts, deleteProject, deleteVerdict } from '../project-delete';
import { pageMeta, parsePage } from '../paging';
import { normalizeProjectIds } from '../mcp/scope';

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
    author: r.author, author_id: r.owner_id, featured: !!r.featured, published_at: r.published_at, status: r.status, open_implementation: !!r.open_implementation, skill_price_cents: Number(r.skill_price_cents) || 0, playing: Number(r.playing) || 0,
    // adults-only games: the store blurs the cover and labels it 18+ (sexual, violence, other)
    age: r.age || null, mature: matureList(r),
    // on today's picks: why the game was picked (featured, trending, rising, new, gem, free, more)
    ...(r.pick ? { pick: r.pick } : {}),
    // the listing's own language and the title, tagline and cover in every other platform language the game is
    // played in: the web app shows the viewer's language, else English, else the game's own (web/src/languages.ts)
    ...listingLangs(r, ['title', 'tagline'], (k) => media(origin, k)),
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

// ----- signing up and signing in: no passwords (src/email-auth.ts, src/passkey.ts) ---------------------------------
// Sign-up is an emailed link, and the account exists only once it is opened; sign-in is a code emailed to the account,
// or a passkey. With two-factor on, the authenticator code follows the email code. The answers never tell whether an
// email has an account: every request sends an email, saying what applies to that address.
const emailFailed = () => new AppError(503, 'We could not send the email right now. Try again in a few minutes.', 'email_failed');
const authLinks = (origin: string, email: string, next: string | null) => {
  const q = (p: string) => `${origin}${p}?email=${encodeURIComponent(email)}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
  return { login: q('/login'), signup: q('/signup') };
};

api.post('/auth/signup', async (c) => {
  const b = await c.req.json<{ email?: string; name?: string; next?: string }>().catch(() => ({} as any)), s = await getSettings(c.env);
  if (!s.signups_open) throw forbidden('Sign-ups are closed right now.');
  // Per network, not per person: carriers in much of Asia, Africa and South America put thousands of phones behind one
  // IPv4 address (carrier-grade NAT), so the bar is set for a busy shared address, not one household.
  await rateLimit(c.env, 'signup:' + clientNet(c.req.raw), 30, 3600);
  const email = normEmail(b.email), name = cleanName(b.name), next = safeNext(b.next);
  if (!validEmail(email)) throw bad('Enter a valid email address.');
  if (name.length < 2) throw bad('Choose a display name of at least 2 characters.');
  await rateLimit(c.env, 'signupmail:' + email, 4, 3600);   // nobody's inbox is flooded with links
  const lang = pageLang(c.req.raw), links = authLinks(c.get('origin'), email, next);
  const taken = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ? AND status != 'deleted'").bind(email).first();
  if (testMailbox(c.env, c.req.raw, email)) return c.json({ ok: true, sent: true, test_token: taken ? null : await newSignupLink(c.env, email, name, next) });
  const sent = taken
    ? await sendAuthMail(c.env, email, lang, { kind: 'signup_exists', link: links.login })
    : await sendAuthMail(c.env, email, lang, { kind: 'signup_link', name, link: `${c.get('origin')}/verify?token=${await newSignupLink(c.env, email, name, next)}` });
  if (!sent) throw emailFailed();
  return c.json({ ok: true, sent: true });
});

// The page the sign-up link opens shows who the account is for; nothing is created until the person confirms there.
api.get('/auth/signup/link', async (c) => {
  await rateLimit(c.env, 'signuppeek:' + clientNet(c.req.raw), 60, 3600);
  const l = await peekSignupLink(c.env, String(c.req.query('token') || ''));
  if (!l) throw new AppError(400, 'This link has expired or was already used. Create your account again to get a new link.', 'bad_token');
  const exists = !!(await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ? AND status != 'deleted'").bind(l.email).first());
  return c.json({ email: l.email, name: l.name, exists });
});

api.post('/auth/signup/confirm', async (c) => {
  const b = await c.req.json<{ token?: string }>().catch(() => ({} as any));
  await rateLimit(c.env, 'signupconfirm:' + clientNet(c.req.raw), 30, 3600);
  const l = await takeSignupLink(c.env, String(b.token || ''));
  if (!l) throw new AppError(400, 'This link has expired or was already used. Create your account again to get a new link.', 'bad_token');
  const t = now();
  let u = await c.env.DB.prepare("SELECT id, status FROM users WHERE email = ? AND status != 'deleted'").bind(l.email).first<{ id: string; status: string }>();
  const created = !u;
  if (!u) {
    if (!(await getSettings(c.env)).signups_open) throw forbidden('Sign-ups are closed right now.');
    const id = newUserId();
    // pw_hash is a leftover NOT NULL column: no account has a password any more
    await c.env.DB.prepare("INSERT INTO users (id, email, name, pw_hash, created_at, last_seen_at, email_verified_at) VALUES (?, ?, ?, '', ?, ?, ?)").bind(id, l.email, l.name, t, t, t).run();
    await ensureProfile(c.env.DB, { id, name: l.name }).catch(() => {});   // findable by friends from the start (src/social-rules.js)
    u = { id, status: 'active' };
  } else {
    // the link proves the email, so it signs in to the account that has it (two-factor still applies)
    if (u.status !== 'active') throw forbidden('This account is suspended.');
    await c.env.DB.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').bind(t, u.id).run();
    if (await twoFactorOn(c.env, u.id)) return c.json({ ok: true, two_factor: true, challenge: await startChallenge(c.env, u.id), next: l.next });
  }
  await signIn(c, u.id, 'link');
  return c.json({ ok: true, created, next: l.next });
});

// Signing in, step 1: a 6-digit code to the email. Every email gets a handle back; only an account's email gets a code
// (others get an email saying no account uses them), so neither the answer nor its timing tells who has an account.
api.post('/auth/login', async (c) => {
  const b = await c.req.json<{ email?: string; next?: string }>().catch(() => ({} as any));
  const email = normEmail(b.email), net = clientNet(c.req.raw);
  if (!validEmail(email)) throw bad('Enter a valid email address.');
  // per network (many emails from one place), and per email: a few codes per quarter hour, so no inbox is flooded
  await rateLimit(c.env, 'loginnet:' + net, 60, 900);
  await rateLimit(c.env, 'logincode:' + email, 5, 900);
  await rateLimit(c.env, 'loginall:' + email, 20, 86400 / 4);
  const u = await c.env.DB.prepare("SELECT id, name, status FROM users WHERE email = ? AND status != 'deleted'").bind(email).first<{ id: string; name: string; status: string }>();
  const lang = pageLang(c.req.raw), { handle, code } = await startCode(c.env, 'login', email, u?.id || null);
  if (testMailbox(c.env, c.req.raw, email)) return c.json({ ok: true, challenge: handle, expires_in: Math.round(CODE_TTL_MS / 1000), test_code: u ? code : null });
  const sent = u && code
    ? await sendAuthMail(c.env, email, lang, { kind: 'login_code', name: u.name, code })
    : await sendAuthMail(c.env, email, lang, { kind: 'login_unknown', link: authLinks(c.get('origin'), email, safeNext(b.next)).signup });
  if (!sent) throw emailFailed();
  return c.json({ ok: true, challenge: handle, expires_in: Math.round(CODE_TTL_MS / 1000) });
});

// Signing in, step 2: the code from the email. With two-factor on, it opens the authenticator step (/auth/login/code).
api.post('/auth/login/verify', async (c) => {
  const b = await c.req.json<{ challenge?: string; code?: string }>().catch(() => ({} as any));
  await rateLimit(c.env, 'loginverify:' + clientNet(c.req.raw), 60, 900);
  const r = await checkCode(c.env, 'login', String(b.challenge || ''), String(b.code || ''));
  if (!r.ok) throw r.reason === 'expired'
    ? new AppError(401, 'This code has expired or had too many wrong tries. Ask for a new code.', 'code_expired')
    : new AppError(401, 'That code is not right. Use the code in the latest email from us.', 'bad_email_code');
  const u = await c.env.DB.prepare('SELECT status FROM users WHERE id = ?').bind(r.userId).first<{ status: string }>();
  if (u?.status !== 'active') throw forbidden('This account is suspended.');
  await c.env.DB.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').bind(now(), r.userId).run();
  if (await twoFactorOn(c.env, r.userId)) return c.json({ ok: true, two_factor: true, challenge: await startChallenge(c.env, r.userId) });
  return c.json(await signIn(c, r.userId, 'email'));
});

/** Signs this browser in as the account (its email code or link, and the authenticator code when two-factor is on, were checked; or a passkey). */
async function signIn(c: Ctx, userId: string, method: 'email' | 'link' | 'passkey') {
  await c.env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now(), userId).run();
  // Signing in replaces this browser's earlier sign-in, whoever it was: games still open on it (another tab, a reload)
  // stop at their next call instead of carrying on as the previous account.
  await endPreviousLogin(c.env, c.req.raw);
  c.header('set-cookie', await createSession(c.env, c.req.raw, userId, method));
  return { ok: true as const };
}

// The authenticator step of a sign-in with two-factor on: the challenge from the email step and a code from the
// authenticator app, or one of the recovery codes (src/two-factor.ts). Five wrong codes and the sign-in starts again.
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
    ? new AppError(401, 'This sign-in timed out or had too many wrong codes. Start again with your email.', 'challenge_expired')
    : new AppError(401, 'That code is not right. Check the time on your phone, or use a recovery code.', 'bad_code');
  const u = await c.env.DB.prepare('SELECT status FROM users WHERE id = ?').bind(r.userId).first<{ status: string }>();
  if (u?.status !== 'active') throw forbidden('This account is suspended.');
  await signIn(c, r.userId, 'email');
  return c.json({ ok: true, used_recovery: r.kind === 'recovery', recovery_left: r.kind === 'recovery' ? (await twoFactorState(c.env, r.userId)).recovery_left : undefined });
});

// ----- passkeys (src/passkey.ts) -------------------------------------------------------------------------------------
const rpOf = (c: Ctx) => ({ origin: c.get('origin'), rpId: new URL(c.get('origin')).hostname });
async function newPasskeyChallenge(c: Ctx, kind: 'register' | 'login' | 'confirm', userId: string | null) {
  const ch = token(32), t = now();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM passkey_challenges WHERE expires_at < ?').bind(t),
    c.env.DB.prepare('INSERT INTO passkey_challenges (id, kind, user_id, expires_at) VALUES (?, ?, ?, ?)').bind(ch, kind, userId, t + PASSKEY_CHALLENGE_TTL_MS),
  ]);
  return ch;
}
/** Uses up the challenge a ceremony's clientDataJSON names, if it is this kind (and this account's), unexpired and unused. */
async function takePasskeyChallenge(c: Ctx, cred: { response?: { clientDataJSON?: string } }, kind: string, userId: string | null): Promise<string> {
  let ch = '';
  try { ch = String(JSON.parse(new TextDecoder().decode(unb64(String(cred?.response?.clientDataJSON || '')))).challenge || ''); } catch { /* refused below */ }
  const row = ch && ch.length < 100 ? await c.env.DB.prepare('DELETE FROM passkey_challenges WHERE id = ?1 AND kind = ?2 AND expires_at > ?3 RETURNING user_id').bind(ch, kind, now()).first<{ user_id: string | null }>() : null;
  if (!row || (userId && row.user_id !== userId)) throw new AppError(400, 'This passkey request expired. Try again.', 'passkey_expired');
  return ch;
}
type PasskeyRow = { id: string; user_id: string; public_key: string; alg: number; sign_count: number; transports: string | null; name: string; created_at: number; last_used_at: number | null };
const passkeyFailed = (e: unknown) => { console.warn('passkey refused', (e as Error).message); return new AppError(400, 'That passkey could not be verified. Try again, or sign in with an email code.', 'passkey_failed'); };
/** Checks a sign-in assertion: the account it belongs to (and, with userId, only that account's passkeys). */
async function checkPasskey(c: Ctx, cred: AssertionJSON, kind: 'login' | 'confirm', userId: string | null): Promise<string> {
  const challenge = await takePasskeyChallenge(c, cred, kind, userId);
  const row = typeof cred?.id === 'string' && cred.id.length < 1400 ? await c.env.DB.prepare('SELECT * FROM passkeys WHERE id = ?').bind(cred.id).first<PasskeyRow>() : null;
  if (!row || (userId && row.user_id !== userId)) throw new AppError(400, 'This passkey is not on any account here. Sign in with an email code, then add it on your account page.', 'passkey_unknown');
  let counter: number;
  try { counter = await verifyAssertion(cred, { jwk: JSON.parse(row.public_key), alg: row.alg, counter: row.sign_count }, { challenge, ...rpOf(c) }); }
  catch (e) { throw passkeyFailed(e); }
  await c.env.DB.prepare('UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?').bind(counter, now(), row.id).run();
  return row.user_id;
}

// The options for navigator.credentials.get(): a sign-in (any passkey of the site; the browser offers the ones it has)
// or, signed in, a confirmation with one of this account's own passkeys.
api.post('/auth/passkey/options', async (c) => {
  const b = await c.req.json<{ purpose?: string }>().catch(() => ({} as any));
  await rateLimit(c.env, 'pkopts:' + clientNet(c.req.raw), 120, 900);
  const confirm = b.purpose === 'confirm', u = confirm ? requireUser(c) : null;
  const allow = u ? (await c.env.DB.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').bind(u.id).all<{ id: string; transports: string | null }>()).results : [];
  if (u && !allow.length) throw new AppError(409, 'This account has no passkey yet.', 'no_passkey');
  return c.json({
    challenge: await newPasskeyChallenge(c, confirm ? 'confirm' : 'login', u?.id || null), rpId: rpOf(c).rpId, timeout: PASSKEY_CHALLENGE_TTL_MS, userVerification: 'required',
    allowCredentials: allow.map((p) => ({ type: 'public-key', id: p.id, transports: parseJson<string[]>(p.transports, []) })),
  });
});
// A passkey signs in on its own: it is the device plus its fingerprint, face or PIN, so the authenticator code is not asked.
api.post('/auth/passkey/login', async (c) => {
  const b = await c.req.json<{ credential?: AssertionJSON }>().catch(() => ({} as any));
  await rateLimit(c.env, 'pklogin:' + clientNet(c.req.raw), 60, 900);
  const userId = await checkPasskey(c, b.credential as AssertionJSON, 'login', null);
  const u = await c.env.DB.prepare('SELECT status FROM users WHERE id = ?').bind(userId).first<{ status: string }>();
  if (u?.status !== 'active') throw forbidden('This account is suspended.');
  return c.json(await signIn(c, userId, 'passkey'));
});

api.post('/auth/logout', async (c) => {
  const t = sessionToken(c.req.raw), u = c.get('user');
  if (t) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256(t)).run();
  // the friends connection of this sign-in closes now, so this browser goes offline at once (src/social.ts)
  if (t && u && c.env.SOCIAL) await socialHub(c.env, u.id).closeLogin(await sha256(t)).catch(() => {});
  c.header('set-cookie', sessionCookie(c.req.raw, '', 0));
  return c.json({ ok: true });
});
// Passwords are gone: a page still open from before gets told what to do instead.
for (const p of ['/auth/forgot', '/auth/reset', '/auth/password']) api.post(p, () => { throw new AppError(410, 'Passwords are gone. Sign in with a code we email you, or with a passkey.', 'no_passwords'); });

// Local development only: the emails the Worker would have sent, for tests/e2e.mjs and other local runs.
api.get('/dev/mail', (c) => {
  if (!devMailOn(c.env)) throw notFound('Not found.');
  const to = normEmail(c.req.query('to'));
  return c.json({ mail: devOutbox.filter((m) => !to || m.to === to).slice(-20) });
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

// ----- account: sign-ins, passkeys, two-factor, deletion (security review, finding 8) ------------------------------
// Sensitive changes need a fresh proof that the person at this sign-in is its owner: signing in counts for ten minutes,
// and after that a code we email or one of the account's passkeys (src/email-auth.ts, confirmedUntil).
async function requireConfirmed(c: Ctx) {
  if (!(await confirmedUntil(c.env, await loginIdOf(c.req.raw)))) throw new AppError(403, 'Confirm it is you first.', 'confirm_required');
}
/** Ends every sign-in of this account except the one making the request. */
async function endOtherSessions(c: Ctx, userId: string) {
  const mine = await loginIdOf(c.req.raw);
  return (await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(userId, mine || '').run()).meta.changes || 0;
}

api.get('/account', async (c) => {
  const u = requireUser(c), mine = await loginIdOf(c.req.raw), t = now();
  const [rows, sessTot, keys, v] = await Promise.all([
    c.env.DB.prepare('SELECT id, created_at, ua, method FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 50').bind(u.id, t).all<{ id: string; created_at: number; ua: string; method: string | null }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?').bind(u.id, t).first<{ n: number }>(),
    c.env.DB.prepare('SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at').bind(u.id).all<{ id: string; name: string; created_at: number; last_used_at: number | null }>(),
    c.env.DB.prepare('SELECT email_verified_at FROM users WHERE id = ?').bind(u.id).first<{ email_verified_at: number | null }>(),
  ]);
  return c.json({
    user: pubUser(u), created_at: u.created_at, email_verified_at: v?.email_verified_at || null,
    sessions: rows.results.map((r) => ({ created_at: r.created_at, ua: r.ua || '', method: r.method || null, current: r.id === mine })),
    sessions_total: sessTot?.n || 0,
    passkeys: keys.results,
    confirmed_until: await confirmedUntil(c.env, mine),
    delete_blocker: await deleteBlocker(c.env, u),
    two_factor: await twoFactorState(c.env, u.id),
  });
});

api.get('/account/sessions', async (c) => {
  const u = requireUser(c), mine = await loginIdOf(c.req.raw), t = now();
  const pg = parsePage((k) => c.req.query(k), 10, 50);
  const [rows, tot] = await Promise.all([
    c.env.DB.prepare('SELECT id, created_at, ua, method FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .bind(u.id, t, pg.limit, pg.offset).all<{ id: string; created_at: number; ua: string; method: string | null }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?').bind(u.id, t).first<{ n: number }>(),
  ]);
  return c.json({
    sessions: rows.results.map((r) => ({ created_at: r.created_at, ua: r.ua || '', method: r.method || null, current: r.id === mine })),
    ...pageMeta(tot?.n || 0, pg.page, pg.per_page),
  });
});

// Confirming it is you: a code to the account's email, or one of its passkeys. Either keeps this sign-in confirmed for ten minutes.
api.post('/account/confirm/send', async (c) => {
  const u = requireUser(c);
  await rateLimit(c.env, 'confirmmail:' + u.id, 5, 900);
  const { handle, code } = await startCode(c.env, 'confirm', u.email, u.id);
  if (!(await sendAuthMail(c.env, u.email, pageLang(c.req.raw), { kind: 'confirm_code', name: u.name, code: code! }))) throw emailFailed();
  return c.json({ ok: true, challenge: handle });
});
api.post('/account/confirm', async (c) => {
  const u = requireUser(c), b = await c.req.json<{ challenge?: string; code?: string }>().catch(() => ({} as any));
  await rateLimit(c.env, 'confirmcheck:' + u.id, 20, 900);
  const r = await checkCode(c.env, 'confirm', String(b.challenge || ''), String(b.code || ''));
  if (!r.ok || r.userId !== u.id) throw r.ok || r.reason === 'bad_code'
    ? new AppError(401, 'That code is not right. Use the code in the latest email from us.', 'bad_email_code')
    : new AppError(401, 'This code has expired or had too many wrong tries. Ask for a new code.', 'code_expired');
  const id = await loginIdOf(c.req.raw);
  if (id) await markConfirmed(c.env, id);
  return c.json({ ok: true, confirmed_until: await confirmedUntil(c.env, id) });
});
api.post('/account/confirm/passkey', async (c) => {
  const u = requireUser(c), b = await c.req.json<{ credential?: AssertionJSON }>().catch(() => ({} as any));
  await rateLimit(c.env, 'confirmpk:' + u.id, 20, 900);
  await checkPasskey(c, b.credential as AssertionJSON, 'confirm', u.id);
  const id = await loginIdOf(c.req.raw);
  if (id) await markConfirmed(c.env, id);
  return c.json({ ok: true, confirmed_until: await confirmedUntil(c.env, id) });
});

// Adding a passkey: the options for navigator.credentials.create(), then the browser's answer.
const MAX_PASSKEYS = 20;
api.post('/account/passkeys/options', async (c) => {
  const u = requireUser(c);
  await requireConfirmed(c);
  const have = (await c.env.DB.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').bind(u.id).all<{ id: string; transports: string | null }>()).results;
  if (have.length >= MAX_PASSKEYS) throw new AppError(409, `An account can have up to ${MAX_PASSKEYS} passkeys. Remove one first.`, 'too_many');
  const s = await getSettings(c.env);
  return c.json({
    challenge: await newPasskeyChallenge(c, 'register', u.id), timeout: PASSKEY_CHALLENGE_TTL_MS, attestation: 'none',
    rp: { id: rpOf(c).rpId, name: s.brand_name || DEFAULT_BRAND },
    user: { id: b64u(new TextEncoder().encode(u.id)), name: u.email, displayName: u.name },
    pubKeyCredParams: ALGS.map((alg) => ({ type: 'public-key', alg })),
    excludeCredentials: have.map((p) => ({ type: 'public-key', id: p.id, transports: parseJson<string[]>(p.transports, []) })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
  });
});
api.post('/account/passkeys', async (c) => {
  const u = requireUser(c), b = await c.req.json<{ credential?: RegistrationJSON; name?: string }>().catch(() => ({} as any));
  await requireConfirmed(c);
  const challenge = await takePasskeyChallenge(c, b.credential as RegistrationJSON, 'register', u.id);
  let pk;
  try { pk = await verifyRegistration(b.credential as RegistrationJSON, { challenge, ...rpOf(c) }); } catch (e) { throw passkeyFailed(e); }
  if (await c.env.DB.prepare('SELECT 1 FROM passkeys WHERE id = ?').bind(pk.id).first()) throw new AppError(409, 'This passkey is already on an account.', 'exists');
  const name = cleanName(b.name) || passkeyName(c.req.header('user-agent') || '');
  await c.env.DB.prepare('INSERT INTO passkeys (id, user_id, public_key, alg, sign_count, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(pk.id, u.id, JSON.stringify(pk.jwk), pk.alg, pk.counter, JSON.stringify(pk.transports), name, now()).run();
  return c.json({ ok: true, id: pk.id, name });
});
api.post('/account/passkeys/:id/rename', async (c) => {
  const u = requireUser(c), b = await c.req.json<{ name?: string }>().catch(() => ({} as any)), name = cleanName(b.name);
  if (!name) throw bad('Give the passkey a name.');
  await c.env.DB.prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?').bind(name, c.req.param('id'), u.id).run();
  return c.json({ ok: true });
});
api.post('/account/passkeys/:id/delete', async (c) => {
  const u = requireUser(c);
  await requireConfirmed(c);
  await c.env.DB.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').bind(c.req.param('id'), u.id).run();
  return c.json({ ok: true });
});

// ----- two-factor sign-in (src/two-factor.ts): the same for every account, players and creators alike ---------------
/** A code from the authenticator or a recovery code, for changing two-factor itself. Used up when it is good. */
async function requireCode(c: Ctx, u: User, code: unknown) {
  await rateLimit(c.env, '2facheck:' + u.id, 10, 900);
  if (!(await useCode(c.env, u.id, String(code || '')))) throw new AppError(401, 'That code is not right. Check the time on your phone, or use a recovery code.', 'bad_code');
}
// 1. a fresh confirmation, then a new secret to put in the authenticator app (a QR code of `uri`, or `secret` typed in)
api.post('/account/2fa/setup', async (c) => {
  const u = requireUser(c);
  if (u.totp_enabled_at) throw new AppError(409, 'Two-factor sign-in is already on.', 'already_on');
  await requireConfirmed(c);
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
  const u = requireUser(c), b = await c.req.json<{ code?: string }>().catch(() => ({} as any));
  if (!u.totp_enabled_at) return c.json({ ok: true });
  await requireConfirmed(c);
  await requireCode(c, u, b.code);
  await disableTwoFactor(c.env, u.id);
  return c.json({ ok: true });
});
api.post('/account/2fa/recovery-codes', async (c) => {
  const u = requireUser(c), b = await c.req.json<{ code?: string }>().catch(() => ({} as any));
  if (!u.totp_enabled_at) throw new AppError(409, 'Turn on two-factor sign-in first.', 'not_on');
  await requireConfirmed(c);
  await requireCode(c, u, b.code);
  return c.json({ ok: true, recovery_codes: await replaceRecoveryCodes(c.env, u.id) });
});

api.post('/auth/sessions/end-others', async (c) => {
  const u = requireUser(c);
  return c.json({ ok: true, ended: await endOtherSessions(c, u.id) });
});

api.post('/account/delete', async (c) => {
  const u = requireUser(c);
  await requireConfirmed(c);
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
type ListOpts = { sort?: string; q?: string; tag?: string; price?: string; limit?: number; offset?: number; newSince?: number; by?: string; minRating?: number; shelf?: string };
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
  // which shelf (src/store-quality.ts): the main store by default; search and a creator's page show both shelves; the New
  // shelf on request. Games hidden by player reports are never listed.
  const shelf = o.shelf === 'new' || o.shelf === 'all' || o.shelf === 'main' ? o.shelf : q || o.by ? 'all' : 'main';
  where.push(shelfWhere(shelf, (await getSettings(c.env)).new_shelf !== false));
  // the title and tagline in every language the listing is in, so a game is found by its name in any of them
  if (q) { where.push("(p.title LIKE ? ESCAPE '\\' OR p.tagline LIKE ? ESCAPE '\\' OR p.tags LIKE ? ESCAPE '\\' OR (p.listing_i18n != '{}' AND EXISTS (SELECT 1 FROM json_each(p.listing_i18n) j WHERE json_extract(j.value, '$.title') LIKE ? ESCAPE '\\' OR json_extract(j.value, '$.tagline') LIKE ? ESCAPE '\\')))"); const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%'; args.push(like, like, like.toLowerCase(), like, like); }
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
  const rows = await c.env.DB.prepare(`SELECT tags, cover_key, mature FROM projects WHERE status = 'live' AND hidden_at IS NULL${w} ORDER BY plays DESC LIMIT 5000`).bind(...a).all<{ tags: string; cover_key: string | null; mature: string }>();
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
    listGames(c, { sort: qy('sort'), q: qy('q'), tag: qy('tag'), price: qy('price'), limit: num(qy('limit')) || 60, offset: num(qy('offset')), newSince: num(qy('since')), by: qy('by'), minRating: Number(qy('rating')) || undefined, shelf: qy('shelf') }),
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
  const [picks, trending, playing, fresh, newShelf, top, free, sale, genres, stats] = await Promise.all([
    currentPicks(c.env.DB, t),
    listGames(c, { sort: 'trending', limit: 16 }),
    listGames(c, { sort: 'playing', limit: 12 }),
    listGames(c, { sort: 'new', limit: 12 }),
    // the New shelf: games still earning their place on the main store, the most played first
    listGames(c, { sort: 'trending', shelf: 'new', limit: 12 }),
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
      trending: trending.games, playing: playing.games.filter((g) => g.playing > 0), new: fresh.games, new_shelf: newShelf.games, top: top.games.filter((g) => g.rating_count > 0), free: free.games,
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

/** A game whose page anyone may open: live, or announced on a coming soon page (src/wishlist.js). */
async function pageGame(c: Ctx, slug: string): Promise<Project & { author: string }> {
  const p = await c.env.DB.prepare('SELECT p.*, u.name AS author FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.slug = ?').bind(slug).first<Project & { author: string }>();
  if (p && isComingSoon(p)) return p;
  return liveGame(c, slug);
}

api.get('/games/:slug', async (c) => {
  const p = await pageGame(c, c.req.param('slug')), u = c.get('user'), origin = c.get('origin');
  const [reviews, revTot, dist] = await Promise.all([
    c.env.DB.prepare('SELECT r.rating, r.body, r.created_at, r.updated_at, u.name, r.user_id FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.project_id = ? AND r.hidden = 0 ORDER BY r.updated_at DESC LIMIT 10').bind(p.id).all<Record<string, any>>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.project_id = ? AND r.hidden = 0').bind(p.id).first<{ n: number }>(),
    c.env.DB.prepare('SELECT rating, COUNT(*) AS n FROM reviews WHERE project_id = ? AND hidden = 0 GROUP BY rating').bind(p.id).all<{ rating: number; n: number }>(),
  ]);
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
  // a store page load for the creator's store funnel (src/analytics.ts); the creator's own and crawlers' are not counted
  if (p.status === 'live' && (!u || u.id !== p.owner_id) && !/bot|crawl|spider|preview|headless/i.test(c.req.header('user-agent') || '')) {
    {
      // a visit from a shared link or another site's embed card (src/share.ts) is counted apart as well
      const shared = ['share', 'embed'].includes(c.req.query('ref') || '') ? 1 : 0;
      c.executionCtx.waitUntil(c.env.DB.prepare('INSERT INTO game_daily (project_id, day, views, shared_views) VALUES (?, ?, 1, ?) ON CONFLICT(project_id, day) DO UPDATE SET views = views + 1, shared_views = shared_views + excluded.shared_views').bind(p.id, dayOf(now()), shared).run().catch(() => {}));
    }
  }
  const s = await getSettings(c.env), trial = owned ? null : await trialState(c.env, p, s, u?.id || null);
  // the buyer's refund: whether the Refund button is enabled, and every reason it is not (src/refunds.ts)
  const refund = u && p.price_cents > 0 && u.id !== p.owner_id ? await gameRefundState(c.env, s, u.id, p.id) : null;
  // gifts (src/gifts.ts): the friends this player asked for this game, and the friends who asked this player for it
  const gift = u && !isGuestId(u.id) ? await gameGiftState(c.env, s, u.id, p) : null;
  const [v, on] = await Promise.all([
    p.live_version ? getVersion(c.env, p.id, p.live_version) : null,
    s.play_clock_do ? c.env.DB.prepare('SELECT live_players AS n FROM game_online WHERE project_id = ? AND updated_at > ?').bind(p.id, now() - CLOCK_ONLINE_FRESH_MS).first<{ n: number }>()
      : c.env.DB.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM plays WHERE project_id = ? AND env = 'live' AND seen_at > ? AND kind != 'verify'").bind(p.id, now() - ONLINE_WINDOW_MS).first<{ n: number }>(),
  ]);
  return c.json({
    game: { ...card(origin, { ...p, playing: on?.n || 0 }), description: p.description, controls: p.controls, listing_i18n: listingLangs(p, ['title', 'tagline', 'description', 'controls'], (k) => media(origin, k)).i18n || {}, version: p.live_version, updated_at: v?.published_at || p.updated_at, screenshot: media(origin, v?.screenshot_key || null), owner_id: p.owner_id },
    reviews: reviews.results.map((r) => ({ rating: r.rating, body: r.body, at: r.updated_at, name: r.name, mine: !!u && r.user_id === u.id })),
    reviews_total: revTot?.n || 0,
    rating_dist: [1, 2, 3, 4, 5].map((n) => dist.results.find((d) => d.rating === n)?.n || 0),
    my_review: mine, played, owned, is_owner: !!u && u.id === p.owner_id,
    // a game announced before release (src/wishlist.js): its page has no Play button, and players wishlist it
    coming_soon: isComingSoon(p) ? { release_note: p.release_note || null, announced_at: p.coming_soon_at } : null,
    wished: u ? await isWished(c.env.DB, u.id, p.id) : false,
    can_wish: u ? await canWish(c.env.DB, u.id, p) : isComingSoon(p) || (p.status === 'live' && p.price_cents > 0),
    // whether the game is in this player's library: 'bought' (a paid game, from its purchase), 'added' (a free game they added) or null
    library,
    // where this player left off (null when they have nothing saved here): the page's Continue button
    continue: resume,
    // This buyer's purchase of it: the Refund button, enabled or greyed out with every reason (null without a paid purchase).
    refund,
    // Gifts between friends: null when gifts are off or the game is free; otherwise the open requests either way.
    gift,
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

api.get('/games/:slug/reviews', async (c) => {
  const p = await liveGame(c, c.req.param('slug')), u = c.get('user');
  const pg = parsePage((k) => c.req.query(k), 10, 50);
  const [rows, tot] = await Promise.all([
    c.env.DB.prepare('SELECT r.rating, r.body, r.created_at, r.updated_at, u.name, r.user_id FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.project_id = ? AND r.hidden = 0 ORDER BY r.updated_at DESC LIMIT ? OFFSET ?')
      .bind(p.id, pg.limit, pg.offset).all<Record<string, any>>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.project_id = ? AND r.hidden = 0').bind(p.id).first<{ n: number }>(),
  ]);
  return c.json({
    reviews: rows.results.map((r) => ({ rating: r.rating, body: r.body, at: r.updated_at, name: r.name, mine: !!u && r.user_id === u.id })),
    ...pageMeta(tot?.n || 0, pg.page, pg.per_page),
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
// A game's devlog: news posts and patch notes, newest first (src/devlogs.js). Everyone can read a live game's.
const devlogErr = (e: unknown): never => { if (e instanceof DevlogError) throw new AppError((e as any).status, e.message, (e as any).code); throw e; };
api.get('/games/:slug/devlogs', async (c) => {
  const p = await pageGame(c, c.req.param('slug'));
  return c.json(await listDevlogs(c.env.DB, p.id, { before: c.req.query('before') || null, limit: Number(c.req.query('limit')) || undefined }));
});
// The owner writes, edits and deletes posts from the console; posting to a live game tells its players.
// Wishlists and coming soon pages (src/wishlist.js)
const wishErr = (e: unknown): never => { if (e instanceof WishError) throw new AppError((e as any).status, e.message, (e as any).code); throw e; };
api.post('/games/:slug/wishlist', async (c) => {
  const u = requireUser(c), p = await pageGame(c, c.req.param('slug'));
  await rateLimit(c.env, 'wish:' + u.id, 120, 3600);
  return c.json({ ok: true, ...(await addWish(c.env.DB, u.id, p).catch(wishErr)) });
});
api.delete('/games/:slug/wishlist', async (c) => {
  const u = requireUser(c), p = await c.env.DB.prepare('SELECT id FROM projects WHERE slug = ?').bind(c.req.param('slug')).first<{ id: string }>();
  if (!p) throw notFound('That game is not available.');
  return c.json({ ok: true, ...(await removeWish(c.env.DB, u.id, p.id)) });
});
api.get('/me/wishlist', async (c) => {
  const u = requireUser(c), origin = c.get('origin');
  const rows = await wishlistOf(c.env.DB, u.id) as Record<string, any>[];
  return c.json({ games: rows.map((r) => ({ ...card(origin, r), wished_at: r.wished_at, coming_soon: isComingSoon(r) ? { release_note: r.release_note || null } : null })) });
});
api.get('/coming-soon', (c) => edgeCached(c, 60, async () => {
  const origin = c.get('origin'), rows = await comingSoonGames(c.env.DB, Math.min(48, Number(c.req.query('limit')) || 12)) as Record<string, any>[];
  return c.json({ games: rows.map((r) => ({ ...card(origin, r), coming_soon: { release_note: r.release_note || null, wishlists: r.wishes } })) });
}));
const comingSoonView = async (c: Ctx, p: Project) => {
  const fresh = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(p.id).first<Project>() || p;
  return { coming_soon: isComingSoon(fresh), release_note: fresh.release_note || null, coming_soon_at: fresh.coming_soon_at || null, released: !!fresh.published_at,
    issues: fresh.published_at ? [] : announceIssues(fresh), ...(await wishCount(c.env.DB, p.id, now() - 7 * 86400_000)), page: `${c.get('origin')}/g/${encodeURIComponent(fresh.slug)}` };
};
api.get('/console/projects/:id/coming-soon', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  return c.json(await comingSoonView(c, p));
});
api.put('/console/projects/:id/coming-soon', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  const b = await c.req.json<{ on?: boolean; release_note?: string | null }>().catch(() => ({} as { on?: boolean; release_note?: string | null }));
  const before = isComingSoon(p);
  await setComingSoon(c.env.DB, p, { on: typeof b.on === 'boolean' ? b.on : undefined, release_note: b.release_note }).catch(wishErr);
  const v = await comingSoonView(c, p);
  if (v.coming_soon !== before) await logEvent(c.env, p.id, v.coming_soon ? 'coming_soon' : 'coming_soon_off', v.coming_soon ? `Coming soon page is up${v.release_note ? ` (${v.release_note})` : ''}` : 'Coming soon page taken down', null, 'console');
  return c.json(v);
});

api.post('/console/projects/:id/devlogs', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  if (p.status !== 'live' && !isComingSoon(p)) throw new AppError(409, 'Publish the game, or put up its coming soon page, first: a post is for its players.', 'not_live');
  await rateLimit(c.env, 'devlog:' + u.id, 20, 3600);
  const b = await c.req.json<{ title?: string; body?: string }>().catch(() => ({} as { title?: string; body?: string }));
  const r = await publishDevlog(c.env, p, u.id, { title: b.title, body: b.body }).catch(devlogErr);
  await logEvent(c.env, p.id, 'devlog', String(b.title || '').slice(0, 120), null, 'console');
  return c.json({ ok: true, ...r });
});
api.patch('/console/projects/:id/devlogs/:did', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  const b = await c.req.json<{ title?: string; body?: string }>().catch(() => ({} as { title?: string; body?: string }));
  return c.json(await editDevlog(c.env.DB, p.id, c.req.param('did'), b).catch(devlogErr));
});
api.delete('/console/projects/:id/devlogs/:did', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  return c.json(await deleteDevlog(c.env.DB, p.id, c.req.param('did')).catch(devlogErr));
});

// A live game's achievements: everyone sees the list and how rare each one is; a signed-in player also sees their own unlocks.
api.get('/games/:slug/achievements', async (c) => {
  const p = await liveGame(c, c.req.param('slug')), u = c.get('user'), db = c.env.DB, scope = scopeOf(p.id, 'live');
  c.header('cache-control', 'private, no-store');
  const [defs, mine, rarity] = await Promise.all([declaredFor(db, p.id, 'live'), u ? unlocksOf(db, scope, u.id) : {}, rarityOf(db, scope)]);
  return c.json(viewOf(defs, mine, rarity, c.req.query('lang') || pageLang(c.req.raw)));
});
api.delete('/games/:slug/progress', async (c) => {
  const u = requireUser(c), p = await liveGame(c, c.req.param('slug'));
  await rateLimit(c.env, 'reset:' + u.id, 20, 3600);
  return c.json(await resetPlayer(c.env.DB, scopeOf(p.id, 'live'), u.id));
});

// ---- continue playing ---------------------------------------------------------------------------
// The signed-in player's own games, most recently played first: the store's Continue row and the library. Only their own.
async function continueCards(c: Ctx, userId: string, limit: number, offset = 0) {
  const { list, more, total } = await continueList(c.env.DB, userId, { limit, offset });
  if (!list.length) return { games: [], more: false, total: total || 0 };
  const ids = list.map((x: { game_id: string }) => x.game_id), origin = c.get('origin');
  const rows = await c.env.DB.prepare(`SELECT p.*, u.name AS author FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<Record<string, any>>();
  const byId = new Map(rows.results.map((r) => [r.id, r]));
  const games = list.filter((x: { game_id: string }) => byId.has(x.game_id)).map(({ game_id, ...x }: Record<string, any>) => ({ ...card(origin, byId.get(game_id)!), progress: x }));
  return { games, more, total: total ?? games.length };
}
api.get('/me/continue', async (c) => {
  const u = requireUser(c);
  c.header('cache-control', 'private, no-store');
  const pg = parsePage((k) => c.req.query(k), 12, 60);
  const res = await continueCards(c, u.id, pg.limit, pg.offset);
  return c.json({ ...res, ...pageMeta(res.total, pg.page, pg.per_page) });
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
async function libraryCards(c: Ctx, userId: string, offset: number, filter: string, limit = 24) {
  const { list, more } = await libraryList(c.env.DB, userId, { limit, offset, filter });
  if (!list.length) return { games: [], more: false };
  const ids = list.map((x: { game_id: string }) => x.game_id), origin = c.get('origin');
  const rows = await c.env.DB.prepare(`SELECT p.*, u.name AS author FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<Record<string, any>>();
  const byId = new Map(rows.results.map((r) => [r.id, r]));
  return { games: list.filter((x: { game_id: string }) => byId.has(x.game_id)).map(({ game_id, ...x }: Record<string, any>) => ({ ...card(origin, byId.get(game_id)!), library: x })), more };
}
api.get('/me/library', async (c) => {
  const u = requireUser(c);
  const pg = parsePage((k) => c.req.query(k), 24, 60);
  c.header('cache-control', 'private, no-store');
  const first = pg.offset === 0;
  const [played, owned, counts] = await Promise.all([continueCards(c, u.id, pg.limit, pg.offset), first ? libraryCards(c, u.id, 0, 'all', 24) : null, first ? libraryCounts(c.env.DB, u.id) : null]);
  return c.json({ ...played, ...pageMeta(played.total, pg.page, pg.per_page), owned: owned && counts ? { ...owned, ...pageMeta(counts.all, 1, 24) } : owned, counts });
});
// More of the owned part, or one filter of it: all, bought or added.
api.get('/me/library/games', async (c) => {
  const u = requireUser(c);
  const filter = String(c.req.query('filter') || 'all');
  const pg = parsePage((k) => c.req.query(k), 24, 60);
  c.header('cache-control', 'private, no-store');
  const [res, counts] = await Promise.all([libraryCards(c, u.id, pg.offset, filter, pg.limit), libraryCounts(c.env.DB, u.id)]);
  const total = filter === 'bought' ? counts.bought : filter === 'added' ? counts.added : counts.all;
  return c.json({ ...res, ...pageMeta(total, pg.page, pg.per_page), counts });
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

// A player tells the platform something is wrong with a live game: it does not work, it is low effort, it asks for
// passwords or payment, it uses someone else's work. Each report goes to the admin's report queue (Admin, Reports) and the
// game's flags. Only players who opened the game can report it; enough reports from different players hide it from the
// store until an admin reviews them (src/store-quality.ts).
export { REPORT_REASONS };
api.post('/games/:slug/report', async (c) => {
  const u = requireUser(c), p = await liveGame(c, c.req.param('slug'));
  const b = await c.req.json<{ reason?: string; detail?: string }>().catch(() => ({} as { reason?: string; detail?: string }));
  const reason = String(b.reason || '');
  if (!(REPORT_REASONS as readonly string[]).includes(reason)) throw bad(`reason must be one of: ${REPORT_REASONS.join(', ')}.`);
  if (u.id === p.owner_id) throw forbidden('You cannot report your own game.');
  if (!(await c.env.DB.prepare("SELECT 1 FROM plays WHERE project_id = ? AND user_id = ? AND env = 'live' LIMIT 1").bind(p.id, u.id).first())) throw forbidden('Play the game before reporting it. If it does not start at all, open it once and then report it as broken.');
  await rateLimit(c.env, 'report:' + u.id, 10, 86400);
  const detail = String(b.detail || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  await logEvent(c.env, p.id, 'player_report', detail ? `${reason}: ${detail}` : reason, p.live_version, 'user:' + u.id);
  await fileReport(c.env, await getSettings(c.env), p, u.id, reason as ReportReason, detail);
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
  // shots/<project>/<version>[-play-i].ext, covers/<project>-<time>.ext and a language's cover covers/<project>-<lang>-<time>.ext
  const m = key.match(/^(shots)\/([A-Za-z0-9_\-]+)\/([A-Za-z0-9_.\-]+)$/) || key.match(/^(covers)\/([A-Za-z0-9_]+)-((?:[A-Za-z]{2}(?:-[A-Za-z]{2})?-)?[A-Za-z0-9]+\.[a-z0-9]+)$/);
  if (!m || key.includes('..')) throw notFound();
  // Public only for a live game's cover and the pictures of versions that went live. A draft's, a removed game's or the
  // verifier's frames of an unpublished version are for the creator and admins.
  const p = await c.env.DB.prepare('SELECT owner_id, status, cover_key, listing_i18n, coming_soon_at, published_at, hidden_at FROM projects WHERE id = ?').bind(m[2]).first<Project>();
  if (!p) throw notFound();
  const n = m[1] === 'shots' ? Number((m[3].match(/^(\d+)/) || [])[1]) : NaN;
  // a live game's covers: the main one and each listing language's (update_project covers)
  const langCover = m[1] === 'covers' && Object.values(parseJson<Record<string, { cover_key?: string }>>(p.listing_i18n || '{}', {})).some((x) => x?.cover_key === key);
  // ...and the covers of a game announced on a coming soon page (src/wishlist.js); its frames stay private until release
  const published = (p.status === 'live' && (key === p.cover_key || langCover || (Number.isInteger(n) && !!(await c.env.DB.prepare('SELECT 1 FROM versions WHERE project_id = ? AND n = ? AND published_at IS NOT NULL').bind(m[2], n).first())))) || (isComingSoon(p) && (key === p.cover_key || langCover));
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
async function checkout(c: Ctx, u: User, name: string, amount: number, metadata: Record<string, string>, back: string, digitalGoods = false, closeBy?: number, giftFor?: string) {
  // A build skill is final once bought: it shows in full the moment the payment succeeds and is never refunded. So is a
  // gift (src/gifts.ts): the friend gets the game the moment the payment succeeds, and gifts are never refunded.
  const skill = metadata.kind === 'skill', gift = metadata.kind === 'gift';
  const origin = c.get('origin'), brand = (await getSettings(c.env)).brand_name || DEFAULT_BRAND;
  const session = await stripe<{ id: string; url: string }>(c.env, 'POST', '/checkout/sessions', {
    // HearthCade is the seller of record and pays creators through Connect, which Stripe's Managed Payments (Stripe as
    // merchant of record) does not support; new Stripe accounts turn it on by default, so it is turned off per session.
    managed_payments: { enabled: false },
    mode: 'payment', integration_identifier: 'hearthcade_checkout_kqzvmrtd', client_reference_id: u.id, customer_email: u.email, metadata, payment_intent_data: { metadata },
    line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: amount, product_data: { name, description: `Sold by ${OPERATOR.name} on ${brand}` } } } },
    // The seller of record, next to the Pay button, with the terms the purchase falls under.
    custom_text: {
      submit: { message: `${brand} is developed and operated by ${OPERATOR.name}, the seller of this purchase.${skill ? ' Build skills are non-refundable.' : ''}${gift ? ` This is a gift for ${giftFor}: gifts are non-refundable.` : ''} Terms: ${origin}/legal/terms · Refunds: ${origin}/legal/refunds` },
      // A game is digital content delivered at once. EU and UK law gives buyers 14 days to cancel unless they ask for it
      // right away and accept losing that right, so the buyer ticks this before paying; Stripe records the consent.
      ...(digitalGoods ? { terms_of_service_acceptance: { message: gift
        ? `I agree to the [Terms](${origin}/legal/terms) and want ${giftFor} to get this game right away. I understand that gifts are non-refundable: neither of us can cancel or refund this purchase ([refund policy](${origin}/legal/refunds)).`
        : skill
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
  const pg = parsePage((k) => c.req.query(k), 24, 100);
  return c.json(await storeList(c.env, c.get('origin'), c.get('user'), { query: c.req.query('q'), price: c.req.query('price'), sort: c.req.query('sort'), limit: pg.limit, offset: pg.offset }));
});
api.get('/creator-store/:slug', async (c) => {
  c.header('cache-control', 'private, no-store');
  const lang = c.req.query('lang') || pageLang(c.req.raw);
  const count = c.req.query('count') !== '0';
  return c.json(await storeItem(c.env, c.get('origin'), c.get('user'), c.req.param('slug'), count, lang));
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

// ----- gifts between friends (src/gifts.ts) -------------------------------------------------------------------------------
const playerId = (v: unknown) => { const id = String(v || ''); if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) throw bad('Choose a friend.'); return id; };
const giftEvent = (p: { id: string; slug: string; title: string }) => ({ id: p.id, slug: p.slug, title: p.title });

// Buy a game for a friend: the same Checkout at the price the game sells for now, a gift's own non-refundable terms, and
// the game lands with the friend once paid (applySession). request: the gift request this answers, if any.
api.post('/games/:slug/gift', async (c) => {
  const u = requireUser(c), s = await getSettings(c.env), p = await liveGame(c, c.req.param('slug'));
  const b = await c.req.json<{ to?: string; request?: string }>().catch(() => ({} as { to?: string; request?: string }));
  const to = playerId(b.to);
  await rateLimit(c.env, 'gift:' + u.id, 20, 3600);
  await checkGift(c.env, s, u.id, to, p);
  const friend = (await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(to).first<{ name: string }>())!.name;
  const sale = saleOf(p), amount = sale ? sale.price_cents : p.price_cents;
  const request = typeof b.request === 'string' && /^gfr_[A-Za-z0-9]+$/.test(b.request) ? b.request : undefined;
  return checkout(c, u, `Gift: ${p.title} for ${friend}`.slice(0, 250), amount, { kind: 'gift', user_id: u.id, recipient_id: to, project_id: p.id, ...(request ? { request_id: request } : {}), ...(sale ? { sale_regular_cents: String(sale.regular_cents), sale_ends_at: String(sale.ends_at) } : {}) }, `/g/${p.slug}?gift=1`, true, sale ? sale.ends_at : undefined, friend.slice(0, 60));
});
// "Gift me this game": ask a friend to buy it for you.
api.post('/games/:slug/gift-request', async (c) => {
  const u = requireUser(c), s = await getSettings(c.env), p = await liveGame(c, c.req.param('slug'));
  const b = await c.req.json<{ to?: string; note?: string }>().catch(() => ({} as { to?: string; note?: string }));
  const to = playerId(b.to);
  await rateLimit(c.env, 'giftreq:' + u.id, 30, 86400);
  const r = await askForGift(c.env, s, u.id, to, p, b.note);
  if (r.created) await pushTo(c.env, to, { kind: 'gift_request', from: { id: u.id, name: u.name }, game: giftEvent(p), request: r.request.id });
  return c.json({ ok: true, request: r.request.id, already: !r.created });
});
// Friends to pick from on a game page, each with whether they can receive this game.
api.get('/games/:slug/gift-friends', async (c) => {
  const u = requireUser(c), p = await liveGame(c, c.req.param('slug'));
  c.header('cache-control', 'private, no-store');
  return c.json({ friends: await giftableFriends(c.env, u.id, p) });
});
api.get('/me/gifts', async (c) => {
  const u = requireUser(c), s = await getSettings(c.env);
  c.header('cache-control', 'private, no-store');
  const q = (k: string) => c.req.query(k);
  const paged = ['incoming_page', 'outgoing_page', 'received_page', 'sent_page', 'per_page'].some((k) => q(k) != null && q(k) !== '');
  if (!paged) return c.json({ enabled: giftsOn(s), ...(await giftOverview(c.env, u.id)) });
  const rawPer = Math.floor(Number(q('per_page') || 10));
  const per = Number.isFinite(rawPer) ? Math.max(1, Math.min(100, rawPer)) : 10;
  const sec = (k: string) => {
    const p = Math.floor(Number(q(k) || 1));
    const page = Number.isFinite(p) ? Math.max(1, Math.min(10_000, p)) : 1;
    return { limit: per, offset: (page - 1) * per };
  };
  return c.json({
    enabled: giftsOn(s),
    per_page: per,
    ...(await giftOverview(c.env, u.id, now(), { incoming: sec('incoming_page'), outgoing: sec('outgoing_page'), received: sec('received_page'), sent: sec('sent_page') })),
  });
});
api.post('/me/gifts/requests/:id/decline', async (c) => {
  const u = requireUser(c), r = await declineGift(c.env, u.id, c.req.param('id'));
  const p = await c.env.DB.prepare('SELECT id, slug, title FROM projects WHERE id = ?').bind(r.project_id).first<{ id: string; slug: string; title: string }>();
  await pushTo(c.env, r.from_id, { kind: 'gift_declined', by: { id: u.id, name: u.name }, game: p ? giftEvent(p) : null, request: r.id });
  return c.json({ ok: true });
});
api.delete('/me/gifts/requests/:id', async (c) => {
  const u = requireUser(c), r = await cancelGiftRequest(c.env, u.id, c.req.param('id'));
  await pushTo(c.env, r.to_id, { kind: 'counts' });
  return c.json({ ok: true });
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
  const q = (k: string) => c.req.query(k);
  const paged = ['page', 'per_page', 'limit', 'offset'].some((k) => q(k) != null && q(k) !== '');
  const pg = paged ? parsePage(q, 20, 100) : null;
  return c.json(await purchaseHistory(c.env, s, u.id, c.get('origin'), pg ? { limit: pg.limit, offset: pg.offset } : undefined));
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
  if (m.kind === 'gift' && m.user_id && m.recipient_id && m.project_id) {
    // a gift: the purchase is the recipient's, the payer is gifted_by, the creator is credited as for any sale
    const p = await getProject(env, m.project_id);
    if (!p) return 'missing_project';
    const sale = { userId: m.recipient_id, projectId: p.id, ownerId: p.owner_id, title: p.title, priceCents: session.amount_total || p.price_cents, provider: 'stripe' as const, providerRef: session.id, paymentIntent: pi, giftedBy: m.user_id };
    if (m.recipient_id === p.owner_id) {
      // the friend made the game (it changed hands while the checkout was open): nothing to give, the payment goes back
      if (await env.DB.prepare('SELECT 1 FROM purchases WHERE provider_ref = ?').bind(session.id).first()) return 'gift';
      if (pi) await stripe(env, 'POST', '/refunds', { payment_intent: pi, reason: 'duplicate', metadata: { session: session.id } }, 'dup:' + session.id);
      await env.DB.prepare("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, provider_ref, payment_intent, status, created_at, refunded_at, gifted_by) VALUES (?, ?, ?, ?, ?, 0, 0, 'stripe', ?, ?, 'refunded', ?, ?, ?)")
        .bind('pur_' + rid(20), m.recipient_id, p.id, p.owner_id, sale.priceCents, session.id, pi, now(), now(), m.user_id).run();
      return 'duplicate_refunded';
    }
    try { await recordPurchase(env, await getSettings(env), { ...sale, openImplementation: freeSkillShared(p) }); }
    catch (e) {
      // The friend already owns the game (they bought it, or another friend's gift was paid first while this checkout
      // was open): the payment is given back to the payer at once and kept on record as refunded.
      if (!/UNIQUE/i.test(String((e as Error).message))) throw e;
      if (await env.DB.prepare('SELECT 1 FROM purchases WHERE provider_ref = ?').bind(session.id).first()) return 'gift';
      if (pi) await stripe(env, 'POST', '/refunds', { payment_intent: pi, reason: 'duplicate', metadata: { session: session.id } }, 'dup:' + session.id);
      await env.DB.prepare("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, provider_ref, payment_intent, status, created_at, refunded_at, gifted_by) VALUES (?, ?, ?, ?, ?, 0, 0, 'stripe', ?, ?, 'refunded', ?, ?, ?)")
        .bind('pur_' + rid(20), m.recipient_id, p.id, p.owner_id, sale.priceCents, session.id, pi, now(), now(), m.user_id).run();
      return 'duplicate_refunded';
    }
    const row = await env.DB.prepare('SELECT id, status FROM purchases WHERE provider_ref = ?').bind(session.id).first<{ id: string; status: string }>();
    if (row && await giftDelivered(env, { purchaseId: row.id, giver: m.user_id, recipient: m.recipient_id, project: p, requestId: m.request_id || null })) {
      const [giver, recipient] = await Promise.all([m.user_id, m.recipient_id].map((id) => env.DB.prepare('SELECT id, name FROM users WHERE id = ?').bind(id).first<{ id: string; name: string }>()));
      const game = giftEvent(p);
      await Promise.all([
        pushTo(env, m.recipient_id, { kind: 'gift_received', from: giver ? { id: giver.id, name: giver.name } : null, game }),
        pushTo(env, m.user_id, { kind: 'gift_sent', by: recipient ? { id: recipient.id, name: recipient.name } : null, game, mine: true }),
      ]);
    }
    return 'gift';
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
const consoleProjectCard = (origin: string, p: Record<string, any>) => ({
  ...card(origin, p), live_version: p.live_version, preview_version: p.preview_version,
  sales: p.sales, skill_price_cents: p.skill_price_cents, skill_sales: p.skill_sales, updated_at: p.updated_at,
});

api.get('/console/overview', async (c) => {
  const u = requireUser(c), origin = c.get('origin');
  const includeProjects = c.req.query('projects') !== '0';
  const [agg, projects, sales, skillSales, balance] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS total_games,
        COALESCE(SUM(CASE WHEN status = 'live' THEN 1 ELSE 0 END), 0) AS live_games,
        COALESCE(SUM(plays), 0) AS total_plays,
        COALESCE(SUM(seconds), 0) AS total_seconds,
        COALESCE(SUM(CASE WHEN open_implementation = 1 AND status = 'live' THEN 1 ELSE 0 END), 0) AS skills_shared
      FROM projects WHERE owner_id = ? AND status != 'removed'`).bind(u.id).first<{ total_games: number; live_games: number; total_plays: number; total_seconds: number; skills_shared: number }>(),
    includeProjects
      ? c.env.DB.prepare("SELECT p.*, ? AS author FROM projects p WHERE p.owner_id = ? AND p.status != 'removed' ORDER BY p.updated_at DESC").bind(u.name, u.id).all<Record<string, any>>()
      : Promise.resolve({ results: [] as Record<string, any>[] }),
    c.env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(net_cents), 0) AS net FROM purchases WHERE owner_id = ? AND status = 'paid'").bind(u.id).first<{ n: number; net: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(net_cents), 0) AS net FROM skill_purchases WHERE owner_id = ? AND status = 'paid'").bind(u.id).first<{ n: number; net: number }>(),
    balanceOf(c.env, u.id),
  ]);
  const stats = {
    total_games: agg?.total_games || 0,
    live_games: agg?.live_games || 0,
    total_plays: agg?.total_plays || 0,
    total_minutes: Math.round((agg?.total_seconds || 0) / 60),
    skills_shared: agg?.skills_shared || 0,
  };
  return c.json({
    user: pubUser(u), balance, sales: sales || { n: 0, net: 0 }, skill_sales: skillSales || { n: 0, net: 0 },
    skills_shared: stats.skills_shared,
    stats,
    projects: projects.results.map((p) => consoleProjectCard(origin, p)),
  });
});

api.get('/console/projects', async (c) => {
  const u = requireUser(c), origin = c.get('origin');
  const pg = parsePage((k) => c.req.query(k), 20, 100);
  const q = (c.req.query('q') || '').trim().slice(0, 80);
  const status = String(c.req.query('status') || 'all');
  const sort = String(c.req.query('sort') || 'updated');
  const where = ["p.owner_id = ?", "p.status != 'removed'"], args: unknown[] = [u.id];
  if (status === 'live' || status === 'draft' || status === 'offline') { where.push('p.status = ?'); args.push(status); }
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    where.push("(p.title LIKE ? ESCAPE '\\' OR p.slug LIKE ? ESCAPE '\\' OR p.tagline LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  const order = sort === 'plays' ? 'p.plays DESC, p.updated_at DESC' : sort === 'title' ? 'LOWER(p.title) ASC, p.updated_at DESC' : 'p.updated_at DESC';
  const w = where.join(' AND ');
  const [rows, tot, counts] = await Promise.all([
    c.env.DB.prepare(`SELECT p.*, ? AS author FROM projects p WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(u.name, ...args, pg.limit, pg.offset).all<Record<string, any>>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM projects p WHERE ${w}`).bind(...args).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS all_n,
        COALESCE(SUM(CASE WHEN status = 'live' THEN 1 ELSE 0 END), 0) AS live,
        COALESCE(SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END), 0) AS draft,
        COALESCE(SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END), 0) AS offline
      FROM projects WHERE owner_id = ? AND status != 'removed'`).bind(u.id).first<{ all_n: number; live: number; draft: number; offline: number }>(),
  ]);
  return c.json({
    projects: rows.results.map((p) => consoleProjectCard(origin, p)),
    counts: { all: counts?.all_n || 0, live: counts?.live || 0, draft: counts?.draft || 0, offline: counts?.offline || 0 },
    ...pageMeta(tot?.n || 0, pg.page, pg.per_page),
  });
});

api.get('/console/projects/:id', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id')), origin = c.get('origin'), db = c.env.DB;
  const [versions, events, daily, errors, files, sales, vTot, evTot, erTot] = await Promise.all([
    db.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY n DESC LIMIT 30').bind(p.id).all<any>(),
    db.prepare('SELECT kind, detail, version, actor, created_at FROM events WHERE project_id = ? ORDER BY id DESC LIMIT 40').bind(p.id).all(),
    db.prepare('SELECT day, sessions, plays, seconds FROM game_daily WHERE project_id = ? AND day >= ? ORDER BY day').bind(p.id, addDays(dayOf(now()), -29)).all(),
    db.prepare('SELECT version, env, message, count, last_at FROM client_errors WHERE project_id = ? ORDER BY last_at DESC LIMIT 20').bind(p.id).all(),
    listFiles(c.env, p.id),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price_cents), 0) AS gross, COALESCE(SUM(net_cents), 0) AS net FROM purchases WHERE project_id = ? AND status = 'paid'").bind(p.id).first(),
    db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id = ?').bind(p.id).first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM events WHERE project_id = ?').bind(p.id).first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM client_errors WHERE project_id = ?').bind(p.id).first<{ n: number }>(),
  ]);
  const [skillSales, skillRows, skillTrLangs] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price_cents), 0) AS gross, COALESCE(SUM(net_cents), 0) AS net FROM skill_purchases WHERE project_id = ? AND status = 'paid'").bind(p.id).first(),
    db.prepare('SELECT version, description, content, i18n, written_by, updated_at, LENGTH(content) AS characters FROM game_skills WHERE project_id = ? ORDER BY version DESC LIMIT 10').bind(p.id).all<any>(),
    db.prepare('SELECT version, lang FROM game_skill_i18n WHERE project_id = ?').bind(p.id).all<{ version: number; lang: string }>(),
  ]);
  const s = await getSettings(c.env), trials = await trialStats(c.env, p.id);
  // The newest version's store-page metadata: what publishing still needs (field ids), and the age rating it works out to.
  const newest = versions.results[0], vm = newest ? await ensureVersionMeta(c.env, newest).catch(() => null) : null;
  const metadata = newest ? { version: newest.n, required: s.metadata_required, missing: missingToPublish(vm?.meta, !!vm?.compat?.declared, JSON.parse(p.tags || '[]')).map((m) => m.split(' ')[0]), age: vm?.meta?.rating?.age ?? null, declared: vm?.meta?.declared ?? [] } : null;
  const langsByVer = new Map<number, string[]>();
  for (const r of skillTrLangs.results) {
    const arr = langsByVer.get(r.version) || [];
    arr.push(r.lang);
    langsByVer.set(r.version, arr);
  }
  const skillVersions = skillRows.results.map((r) => {
    const cov = skillCoverage(r, langsByVer.get(r.version) || []);
    return {
      version: r.version, description: r.description, written_by: r.written_by, updated_at: r.updated_at, characters: r.characters,
      languages: cov.available, missing_languages: cov.missing,
    };
  });
  const liveSk = await liveSkill(c.env, p).catch(() => null);
  const liveCov = liveSk && !liveSk.generated ? skillCoverage(liveSk.row, await skillLangCodes(c.env, p.id, liveSk.row.version, liveSk.row.i18n)) : null;
  return c.json({
    metadata,
    // the New shelf, hiding by reports and the weekly cap on new games (src/store-quality.ts)
    store: await storeStatus(c.env, s, p),
    project: { ...card(origin, { ...p, author: u.name }), regular_price_cents: p.price_cents, open_implementation_at: p.open_implementation_at, description: p.description, controls: p.controls, live_version: p.live_version, preview_version: p.preview_version, removed_reason: p.removed_reason, created_at: p.created_at, updated_at: p.updated_at },
    versions: versions.results.map((v) => { const g = storedGate(v); return { ...publicVersion(v, origin), eligible: versionEligible(v, s.verify_browser_required), current: currentChecks(v, s), release: g ? gateView(g) : null }; }),
    versions_total: vTot?.n || 0,
    events: events.results, events_total: evTot?.n || 0,
    daily: daily.results,
    errors: errors.results, errors_total: erTot?.n || 0,
    sales,
    files: { count: files.length, bytes: files.reduce((a, f) => a + f.size, 0), storage_bytes: budgetOf(p, s).bytes, storage_set: budgetOf(p, s).source === 'game', request: await latestRequest(c.env, p.id).then((r) => r && { status: r.status, bytes: r.bytes, granted_bytes: r.granted_bytes, note: r.note, created_at: r.created_at }) },
    split: p.price_cents > 0 ? splitSale(p.price_cents, s, freeSkillShared(p)) : null,
    // the limited-time sale: the one running (with what the creator receives per sale at that price), the last one, and
    // when the next can start (src/sales.ts)
    sale: (() => { const v = saleView(p, s); return { ...v, split: v.running ? splitSale(v.running.price_cents, s, freeSkillShared(p)) : null }; })(),
    skill: {
      shared: !!p.open_implementation, price_cents: p.skill_price_cents || 0, sales: skillSales, copies: p.skill_copies, views: p.skill_views,
      split: p.skill_price_cents > 0 ? splitSkillSale(p.skill_price_cents, s) : null, versions: skillVersions,
      live: liveSk && { version: liveSk.row.version, in_sync: liveSk.current, written_by_platform: liveSk.generated, languages: liveCov ? liveCov.available : ['en'], missing_languages: liveCov ? liveCov.missing : [] },
      newest_version: p.preview_version, required_to_publish: !!s.skill_required_to_publish,
    },
    trial: { minutes: p.trial_minutes, active: trialMinutes(p, s) > 0, ...trials },
    online: await onlineNow(c.env, p.id),
    implementation: p.open_implementation ? await db.prepare('SELECT version, summary_source, reads, created_at FROM implementations WHERE project_id = ?').bind(p.id).first() : null,
  });
});

api.get('/console/projects/:id/versions', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id')), origin = c.get('origin');
  const pg = parsePage((k) => c.req.query(k), 10, 50);
  const [rows, tot, s] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY n DESC LIMIT ? OFFSET ?').bind(p.id, pg.limit, pg.offset).all<any>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id = ?').bind(p.id).first<{ n: number }>(),
    getSettings(c.env),
  ]);
  return c.json({
    versions: rows.results.map((v) => { const g = storedGate(v); return { ...publicVersion(v, origin), eligible: versionEligible(v, s.verify_browser_required), current: currentChecks(v, s), release: g ? gateView(g) : null }; }),
    ...pageMeta(tot?.n || 0, pg.page, pg.per_page),
  });
});

api.get('/console/projects/:id/errors', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  const pg = parsePage((k) => c.req.query(k), 10, 100);
  const envName = c.req.query('env');
  const days = Number(c.req.query('days') || 0);
  const sort = c.req.query('sort') || (envName === 'live' && days > 0 ? 'count' : 'recent');
  const where = ['project_id = ?'], args: unknown[] = [p.id];
  if (envName === 'live' || envName === 'preview') { where.push('env = ?'); args.push(envName); }
  if (Number.isFinite(days) && days > 0) { where.push('last_at >= ?'); args.push(now() - Math.min(365, Math.round(days)) * 86400000); }
  const w = where.join(' AND ');
  const order = sort === 'count' ? 'count DESC, last_at DESC' : 'last_at DESC, count DESC';
  const [rows, tot] = await Promise.all([
    c.env.DB.prepare(`SELECT version, env, message, count, last_at FROM client_errors WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...args, pg.limit, pg.offset).all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM client_errors WHERE ${w}`).bind(...args).first<{ n: number }>(),
  ]);
  return c.json({ errors: rows.results, ...pageMeta(tot?.n || 0, pg.page, pg.per_page) });
});

api.get('/console/projects/:id/events', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  const pg = parsePage((k) => c.req.query(k), 15, 100);
  const [rows, tot] = await Promise.all([
    c.env.DB.prepare('SELECT kind, detail, version, actor, created_at FROM events WHERE project_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').bind(p.id, pg.limit, pg.offset).all(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE project_id = ?').bind(p.id).first<{ n: number }>(),
  ]);
  return c.json({ events: rows.results, ...pageMeta(tot?.n || 0, pg.page, pg.per_page) });
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
// the invite picker over the preview (GCP.friends.open) invites a test bot as a friend: { bot, lobby?, label?, data? }
api.post('/console/projects/:id/bots/invite', async (c) => {
  const u = requireUser(c), b = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  await rateLimit(c.env, 'botinvite:' + u.id, 120, 600);
  return c.json(await inviteBotFor(c.env, u, c.req.param('id'), b));
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
  return c.json({ project: { id: p.id, title: p.title, slug: p.slug, status: p.status, live_version: p.live_version }, ...(await gameAnalytics(c.env, p.id, Number(c.req.query('days')) || 30, c.req.query('funnel') ? String(c.req.query('funnel')).split(',').slice(0, 10) : undefined)) });
});
api.get('/console/projects/:id/online', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  return c.json(await onlineNow(c.env, p.id));
});

api.post('/console/projects/:id/preview', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  if (!p.preview_version) throw new AppError(409, 'No preview has been deployed yet. Ask your agent to run deploy_preview.', 'no_preview');
  await ensurePreview(c.env, c.get('origin'), p);   // removed after two idle weeks: deployed again first
  // The player is set up from the same facts the game page uses for the live version (the orientation it declares), so
  // the preview plays in the same frame and the same way as the game will on its store page.
  const v = await getVersion(c.env, p.id, p.preview_version);
  const orientation = v ? await ensureVersionMeta(c.env, v).then(({ compat }) => compat.requirements?.orientation ?? 'any', () => 'any') : 'any';
  return c.json({ ...(await startPlay(c, p, 'preview', p.preview_version, u)), orientation });
});

// The creator feedback queue (src/feedback.ts): annotated screenshots of the preview, waiting for the creator's agent.
// base64 of every picture of one item, with room for the note, marks and context
const FEEDBACK_BODY_MAX = Math.ceil(FEEDBACK_LIMITS.item_bytes / 3) * 4 + 300_000;
// Owner only, never an admin looking at someone else's game.
api.get('/console/projects/:id/feedback', async (c) => {
  const u = requireUser(c), p = await feedbackProject(c.env, u, c.req.param('id'));
  const q = (k: string) => c.req.query(k);
  const paged = ['page', 'per_page', 'limit', 'offset'].some((k) => q(k) != null && q(k) !== '');
  const pg = parsePage(q, paged ? 10 : 100, 100);
  const res = await listFeedback(c.env, p, { limit: pg.limit, offset: pg.offset });
  return c.json({ ...res, ...pageMeta(res.total, pg.page, pg.per_page) });
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

// Delete project (src/project-delete.ts): the body's confirm is the game's address, typed by the creator.
api.post('/console/projects/:id/delete', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  const b = await c.req.json<{ confirm?: string }>().catch(() => ({} as { confirm?: string }));
  if (!b.confirm) throw bad('Type the game\'s address to confirm.', `Its address is ${p.slug}.`);
  return c.json(await deleteProject(c.env, u, p, b.confirm, 'console'));
});
api.get('/console/projects/:id/delete', async (c) => {
  const u = requireUser(c), p = await ownedProject(c.env, u, c.req.param('id'));
  return c.json(deleteVerdict(await deleteFacts(c.env, p), undefined));
});

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
  const summaryOnly = c.req.query('summary') === '1';
  const [ledger, withdrawals, byGame, gameTotal, skills, balance, pendingW] = await Promise.all([
    summaryOnly ? Promise.resolve({ results: [] }) : db.prepare('SELECT kind, amount_cents, note, available_at, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100').bind(u.id).all(),
    summaryOnly ? Promise.resolve({ results: [] }) : db.prepare('SELECT id, amount_cents, method, status, error, created_at, settled_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(u.id).all(),
    summaryOnly ? Promise.resolve({ results: [] }) : db.prepare("SELECT p.title, p.slug, COUNT(*) AS n, SUM(x.price_cents) AS gross, SUM(x.fee_cents) AS fees, SUM(x.net_cents) AS net FROM purchases x JOIN projects p ON p.id = x.project_id WHERE x.owner_id = ? AND x.status = 'paid' GROUP BY x.project_id ORDER BY net DESC").bind(u.id).all(),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price_cents), 0) AS gross, COALESCE(SUM(fee_cents), 0) AS fees, COALESCE(SUM(net_cents), 0) AS net FROM purchases WHERE owner_id = ? AND status = 'paid'").bind(u.id).first(),
    summaryOnly
      ? db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price_cents), 0) AS gross, COALESCE(SUM(fee_cents), 0) AS fees, COALESCE(SUM(net_cents), 0) AS net FROM skill_purchases WHERE owner_id = ? AND status = 'paid'").bind(u.id).first().then((total) => ({ total, by_game: [] }))
      : skillSalesOf(c.env, u.id),
    balanceOf(c.env, u.id),
    db.prepare("SELECT 1 FROM withdrawals WHERE user_id = ? AND status = 'pending' LIMIT 1").bind(u.id).first(),
  ]);
  return c.json({
    balance, min_cents: s.withdraw_min_cents, hold_days: Math.ceil(holdMs(s, now() - u.created_at) / 86400000), fee_percent: s.platform_fee_percent, fee_open_percent: s.platform_fee_open_percent,
    skill_fee_percent: s.skill_fee_percent, game_sales: gameTotal, skill_sales: skills.total, by_skill: skills.by_game,
    has_pending_withdrawal: !!pendingW,
    payments: stripeReady(c.env), manual: s.allow_manual_withdrawals, auto: !!s.auto_payouts, user: pubUser(u), ledger: ledger.results, withdrawals: withdrawals.results, by_game: byGame.results,
  });
});

api.get('/console/earnings/ledger', async (c) => {
  const u = requireUser(c), db = c.env.DB, pg = parsePage((k) => c.req.query(k), 20, 100);
  const [rows, tot] = await Promise.all([
    db.prepare('SELECT kind, amount_cents, note, available_at, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').bind(u.id, pg.limit, pg.offset).all(),
    db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE user_id = ?').bind(u.id).first<{ n: number }>(),
  ]);
  return c.json({ ledger: rows.results, ...pageMeta(tot?.n || 0, pg.page, pg.per_page) });
});

api.get('/console/earnings/withdrawals', async (c) => {
  const u = requireUser(c), db = c.env.DB, pg = parsePage((k) => c.req.query(k), 10, 100);
  const [rows, tot] = await Promise.all([
    db.prepare('SELECT id, amount_cents, method, status, error, created_at, settled_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(u.id, pg.limit, pg.offset).all(),
    db.prepare('SELECT COUNT(*) AS n FROM withdrawals WHERE user_id = ?').bind(u.id).first<{ n: number }>(),
  ]);
  return c.json({ withdrawals: rows.results, ...pageMeta(tot?.n || 0, pg.page, pg.per_page) });
});

api.get('/console/earnings/by-game', async (c) => {
  const u = requireUser(c), db = c.env.DB, pg = parsePage((k) => c.req.query(k), 10, 100);
  const [rows, tot] = await Promise.all([
    db.prepare("SELECT p.title, p.slug, COUNT(*) AS n, SUM(x.price_cents) AS gross, SUM(x.fee_cents) AS fees, SUM(x.net_cents) AS net FROM purchases x JOIN projects p ON p.id = x.project_id WHERE x.owner_id = ? AND x.status = 'paid' GROUP BY x.project_id ORDER BY net DESC, p.title ASC LIMIT ? OFFSET ?")
      .bind(u.id, pg.limit, pg.offset).all(),
    db.prepare("SELECT COUNT(DISTINCT x.project_id) AS n FROM purchases x JOIN projects p ON p.id = x.project_id WHERE x.owner_id = ? AND x.status = 'paid'").bind(u.id).first<{ n: number }>(),
  ]);
  return c.json({ by_game: rows.results, ...pageMeta(tot?.n || 0, pg.page, pg.per_page) });
});

api.get('/console/earnings/by-skill', async (c) => {
  const u = requireUser(c), db = c.env.DB, pg = parsePage((k) => c.req.query(k), 10, 100);
  const [rows, tot] = await Promise.all([
    db.prepare("SELECT p.title, p.slug, p.skill_copies AS copies, COUNT(x.id) AS n, COALESCE(SUM(x.price_cents), 0) AS gross, COALESCE(SUM(x.fee_cents), 0) AS fees, COALESCE(SUM(x.net_cents), 0) AS net FROM projects p LEFT JOIN skill_purchases x ON x.project_id = p.id AND x.status = 'paid' WHERE p.owner_id = ? AND (p.open_implementation = 1 OR x.id IS NOT NULL) GROUP BY p.id ORDER BY net DESC, copies DESC, p.title ASC LIMIT ? OFFSET ?")
      .bind(u.id, pg.limit, pg.offset).all(),
    db.prepare("SELECT COUNT(DISTINCT p.id) AS n FROM projects p LEFT JOIN skill_purchases x ON x.project_id = p.id AND x.status = 'paid' WHERE p.owner_id = ? AND (p.open_implementation = 1 OR x.id IS NOT NULL)").bind(u.id).first<{ n: number }>(),
  ]);
  return c.json({ by_skill: rows.results, ...pageMeta(tot?.n || 0, pg.page, pg.per_page) });
});

api.get('/console/agents', async (c) => {
  const u = requireUser(c);
  const q = (k: string) => c.req.query(k);
  const paged = ['page', 'per_page', 'limit', 'offset'].some((k) => q(k) != null && q(k) !== '');
  const pg = parsePage(q, paged ? 8 : 50, 50);
  const allGrants: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const res = await c.env.OAUTH_PROVIDER.listUserGrants(u.id, cursor ? { cursor } : undefined);
    allGrants.push(...res.items);
    if (!res.cursor) break;
    cursor = res.cursor;
  }
  // the workbench's own grants (one per running bridge, src/acp.ts) are listed on the workbench, not here
  for (let i = allGrants.length - 1; i >= 0; i--) if ((allGrants[i] as any).metadata?.via === 'workbench') allGrants.splice(i, 1);
  allGrants.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  const slice = allGrants.slice(pg.offset, pg.offset + pg.limit);
  // Batch-resolve any project IDs stored in grant metadata for display in the console.
  const allPids = new Set<string>();
  const grantPids = slice.map((g) => {
    const pids = normalizeProjectIds((g as any).metadata?.projectIds);
    if (pids) for (const pid of pids) allPids.add(pid);
    return pids;
  });
  const byId = new Map<string, { id: string; slug: string; title: string; status: string }>();
  if (allPids.size) {
    const rows = await c.env.DB.prepare('SELECT id, slug, title, status FROM projects WHERE owner_id = ? AND id IN (SELECT value FROM json_each(?))')
      .bind(u.id, JSON.stringify([...allPids])).all<{ id: string; slug: string; title: string; status: string }>();
    for (const r of rows.results) byId.set(r.id, r);
  }
  const out = [];
  for (let i = 0; i < slice.length; i++) {
    const g = slice[i], pids = grantPids[i];
    const client = await c.env.OAUTH_PROVIDER.lookupClient(g.clientId).catch(() => null);
    out.push({
      id: g.id,
      client: client?.clientName || g.clientId,
      scope: g.scope,
      project_scope: pids ? 'selected' : 'all',
      projects: pids ? pids.map((pid) => {
        const p = byId.get(pid);
        return p ? { id: p.id, slug: p.slug, title: p.title, status: p.status } : { id: pid, slug: null, title: null, status: 'removed' };
      }) : null,
      created_at: (g as any).createdAt * 1000,
      expires_at: (g as any).expiresAt ? (g as any).expiresAt * 1000 : null,
    });
  }
  return c.json({ agents: out, ...pageMeta(allGrants.length, pg.page, pg.per_page) });
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

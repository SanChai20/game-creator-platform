// The web app's API: accounts, marketplace, play sessions, purchases, the creator console and billing.
import { Hono } from 'hono';
import { AppError, bad, forbidden, notFound, type Env, type Project, type User } from '../env';
import { checkPassword, clearGuestCookie, COOKIE, createSession, endPreviousLogin, existingGuestId, guestIdentity, hashPassword, isGuestId, loginIdOf, newUserId, rateLimit, readCookie, requireUser, sessionCookie, type Ctx } from '../auth';
import { GUEST_SESSION_S, PLAY_SESSION_S } from './rt';
import { gameUrl, playKey, undeployGame } from '../deploy';
import { balanceOf, owns, recordPurchase, refundPurchase, splitSale } from '../earnings';
import { enqueue } from '../pipeline';
import { matureOf } from '../../web/src/gamemeta';
import { liveMature, matureList } from '../mature';
import { missingToPublish, normalizeStoredTags, tagGroup } from '../../web/src/tags';
import { OPERATOR, DEFAULT_BRAND } from '../../web/src/operator';
import { ensureCompat, ensureVersionMeta, getProject, getVersion, listFiles, logEvent, ownedProject, publicVersion, updateProjectMeta, versionEligible } from '../projects';
import { budgetOf, latestRequest } from '../storage';
import { getSettings, SETTING_DEFS } from '../settings';
import { gameAnalytics, ONLINE_WINDOW_MS, onlineNow } from '../analytics';
import { implementationCard, setOpenImplementation } from '../implementations';
import { stripe, stripeReady, verifyWebhook } from '../stripe';
import { beginTrial, trialMinutes, trialState } from '../trials';
import { addDays, dayOf, now, parseJson, rid, sha256 } from '../util';
// @ts-ignore plain JS module
import { signPlayToken } from '../runtime/game-worker.js';
// @ts-ignore plain JS module
import { playerSummary, resetPlayer, scopeOf } from '../player-data.js';
// @ts-ignore plain JS module
import { claimGuest, guestProgress } from '../session-binding.js';

type App = { Bindings: Env; Variables: { user: User | null; origin: string } };
export const api = new Hono<App>();

const media = (origin: string, key: string | null) => (key ? `${origin}/api/media/${key}` : null);
const pubUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, role: u.role, creator: !!u.creator, creator_since: u.creator_since, payouts_enabled: !!u.stripe_payouts_enabled, has_payout_account: !!u.stripe_account, payout_country: u.payout_country });

function card(origin: string, r: Record<string, any>) {
  return {
    id: r.id, slug: r.slug, title: r.title, tagline: r.tagline, tags: normalizeStoredTags(parseJson<string[]>(r.tags, [])), /* only genres and tags on the platform list */ cover: media(origin, r.cover_key), price_cents: r.price_cents,
    trial_minutes: r.price_cents > 0 ? Number(r.trial_minutes) || 0 : 0,   // the web app also applies the platform's trial settings
    plays: r.plays, minutes: Math.round(r.seconds / 60), rating: r.rating_count ? Math.round((r.rating_sum / r.rating_count) * 10) / 10 : null, rating_count: r.rating_count,
    author: r.author, featured: !!r.featured, published_at: r.published_at, status: r.status, open_implementation: !!r.open_implementation, playing: Number(r.playing) || 0,
    // adults-only games: the store blurs the cover and labels it 18+ (sexual, violence, other)
    age: r.age || null, mature: matureList(r),
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
  await endPreviousLogin(c.env, c.req.raw);   // games still open on the browser's earlier sign-in stop (see session-binding.js)
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
  // Signing in replaces this browser's earlier sign-in, whoever it was: games still open on it (another tab, a reload)
  // stop at their next call instead of carrying on as the previous account.
  await endPreviousLogin(c.env, c.req.raw);
  c.header('set-cookie', await createSession(c.env, c.req.raw, u.id));
  return c.json({ ok: true });
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
  const t = readCookie(c.req.raw, COOKIE);
  if (t) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256(t)).run();
  c.header('set-cookie', sessionCookie(c.req.raw, '', 0));
  return c.json({ ok: true });
});

// ----- marketplace -----------------------------------------------------------------------------
// ---- the catalogue -------------------------------------------------------------------------------
// Built for tens of thousands of games: every list is paged (limit and offset, with the total), and the home
// page gets all of its shelves in one request. "Playing now" counts players with a heartbeat in the last minute.
type ListOpts = { sort?: string; q?: string; tag?: string; price?: string; limit?: number; offset?: number; newSince?: number; by?: string; minRating?: number };
const ORDER: Record<string, string> = {
  new: 'p.published_at DESC',
  top: '(p.rating_sum + 3.5 * 3) * 1.0 / (p.rating_count + 3) DESC, p.rating_count DESC',
  played: 'p.plays DESC',
  playing: 'playing DESC, recent DESC, p.plays DESC',
  trending: 'p.featured DESC, recent DESC, p.plays DESC, p.published_at DESC',
};
async function listGames(c: Ctx, o: ListOpts) {
  const sort = ORDER[o.sort || ''] ? o.sort! : 'trending', q = (o.q || '').trim().slice(0, 60), tag = (o.tag || '').trim().toLowerCase().slice(0, 130);
  const limit = Math.max(1, Math.min(60, o.limit || 24)), offset = Math.max(0, Math.min(100000, o.offset || 0));
  const where = ["p.status = 'live'"], args: unknown[] = [];
  if (q) { where.push("(p.title LIKE ? ESCAPE '\\' OR p.tagline LIKE ? ESCAPE '\\' OR p.tags LIKE ? ESCAPE '\\')"); const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%'; args.push(like, like, like.toLowerCase()); }
  // tag can name several genres, comma separated: a game must carry all of them
  for (const one of tag.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 5)) { where.push("p.tags LIKE ? ESCAPE '\\'"); args.push('%"' + one.replace(/[\\%_]/g, '\\$&') + '"%'); }
  if (o.price === 'free') where.push('p.price_cents = 0'); else if (o.price === 'paid') where.push('p.price_cents > 0'); else if (o.price === 'under5') where.push('p.price_cents > 0 AND p.price_cents < 500'); else if (o.price === 'trial') where.push('p.price_cents > 0 AND p.trial_minutes > 0');
  if (o.minRating) { where.push('p.rating_count > 0 AND p.rating_sum >= ? * p.rating_count'); args.push(Math.max(1, Math.min(5, o.minRating))); }
  if (o.newSince) { where.push('p.published_at > ?'); args.push(o.newSince); }
  if (o.by) { where.push('p.owner_id = ?'); args.push(String(o.by).slice(0, 64)); }   // one creator's games
  const t = now(), w = where.join(' AND ');
  const [rows, total] = await Promise.all([
    c.env.DB.prepare(
      `SELECT p.*, u.name AS author, COALESCE((SELECT SUM(plays) * 4 + SUM(seconds) / 60 FROM game_daily d WHERE d.project_id = p.id AND d.day >= ?), 0) AS recent,
         (SELECT COUNT(DISTINCT pl.user_id) FROM plays pl WHERE pl.project_id = p.id AND pl.env = 'live' AND pl.last_beat_at > ? AND pl.kind != 'verify') AS playing
       FROM projects p JOIN users u ON u.id = p.owner_id WHERE ${w} ORDER BY ${ORDER[sort]} LIMIT ? OFFSET ?`).bind(addDays(dayOf(t), -7), t - ONLINE_WINDOW_MS, ...args, limit, offset).all(),
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
async function genreCounts(c: Ctx, top = 16, within = '') {
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

api.get('/games', async (c) => {
  const qy = (k: string) => c.req.query(k);
  const [list, genres] = await Promise.all([
    listGames(c, { sort: qy('sort'), q: qy('q'), tag: qy('tag'), price: qy('price'), limit: num(qy('limit')) || 60, offset: num(qy('offset')), newSince: num(qy('since')), by: qy('by'), minRating: Number(qy('rating')) || undefined }),
    num(qy('offset')) || qy('facets') === '0' ? Promise.resolve(null) : genreCounts(c),   // facets=0: just the games (instant search, shelves)
  ]);
  return c.json({ ...list, ...(genres && { tags: genres.map((g) => g.tag), genres }) });
});

/** Every genre with its count and covers (the categories index), or one genre's numbers and related genres. */
api.get('/categories', async (c) => {
  c.header('cache-control', 'public, max-age=60');
  return c.json({ genres: await genreCounts(c, 200) });
});
api.get('/categories/:tag', async (c) => {
  const tag = c.req.param('tag').trim().toLowerCase().slice(0, 24), like = '%"' + tag.replace(/[\\%_]/g, '\\$&') + '"%', t = now();
  const [related, nums] = await Promise.all([
    genreCounts(c, 14, tag),
    c.env.DB.prepare(`SELECT COUNT(*) AS games, COALESCE(SUM(price_cents = 0), 0) AS free, COALESCE(SUM(published_at > ?), 0) AS new_week,
        (SELECT COUNT(DISTINCT pl.user_id) FROM plays pl JOIN projects q ON q.id = pl.project_id WHERE q.status = 'live' AND q.tags LIKE ? ESCAPE '\\' AND pl.env = 'live' AND pl.last_beat_at > ? AND pl.kind != 'verify') AS playing
      FROM projects WHERE status = 'live' AND tags LIKE ? ESCAPE '\\'`).bind(t - 7 * 86400000, like, t - ONLINE_WINDOW_MS, like).first<{ games: number; free: number; new_week: number; playing: number }>(),
  ]);
  c.header('cache-control', 'public, max-age=30');
  return c.json({ tag, games: nums?.games || 0, free: nums?.free || 0, new_week: nums?.new_week || 0, playing: nums?.playing || 0, related });
});

/** Everything the home page shows, in one request: the spotlight, the shelves, the genres and the key numbers. */
api.get('/home', async (c) => {
  const t = now(), weekAgo = t - 7 * 86400000;
  const [trending, playing, fresh, top, free, genres, stats] = await Promise.all([
    listGames(c, { sort: 'trending', limit: 16 }),
    listGames(c, { sort: 'playing', limit: 12 }),
    listGames(c, { sort: 'new', limit: 12 }),
    listGames(c, { sort: 'top', limit: 12 }),
    listGames(c, { sort: 'trending', price: 'free', limit: 12 }),
    genreCounts(c, 18),
    c.env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM projects WHERE status = 'live') AS games,
        (SELECT COUNT(*) FROM projects WHERE status = 'live' AND published_at > ?) AS new_week,
        (SELECT COUNT(DISTINCT user_id) FROM plays WHERE env = 'live' AND last_beat_at > ? AND kind != 'verify') AS playing,
        (SELECT COUNT(DISTINCT owner_id) FROM projects WHERE status = 'live') AS creators`).bind(weekAgo, t - ONLINE_WINDOW_MS).first<{ games: number; new_week: number; playing: number; creators: number }>(),
  ]);
  c.header('cache-control', 'public, max-age=20');
  return c.json({
    stats: { games: stats?.games || 0, new_week: stats?.new_week || 0, playing: stats?.playing || 0, creators: stats?.creators || 0 },
    shelves: {
      trending: trending.games, playing: playing.games.filter((g) => g.playing > 0), new: fresh.games, top: top.games.filter((g) => g.rating_count > 0), free: free.games,
    },
    genres,
  });
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
  const s = await getSettings(c.env), trial = owned ? null : await trialState(c.env, p, s, u?.id || null);
  const [v, on] = await Promise.all([
    p.live_version ? getVersion(c.env, p.id, p.live_version) : null,
    c.env.DB.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM plays WHERE project_id = ? AND env = 'live' AND last_beat_at > ? AND kind != 'verify'").bind(p.id, now() - ONLINE_WINDOW_MS).first<{ n: number }>(),
  ]);
  return c.json({
    game: { ...card(origin, { ...p, playing: on?.n || 0 }), description: p.description, controls: p.controls, listing_i18n: parseJson(p.listing_i18n, {}), version: p.live_version, updated_at: v?.published_at || p.updated_at, screenshot: media(origin, v?.screenshot_key || null), owner_id: p.owner_id },
    reviews: reviews.results.map((r) => ({ rating: r.rating, body: r.body, at: r.updated_at, name: r.name, mine: !!u && r.user_id === u.id })),
    rating_dist: [1, 2, 3, 4, 5].map((n) => dist.results.find((d) => d.rating === n)?.n || 0),
    my_review: mine, played, owned, is_owner: !!u && u.id === p.owner_id,
    // A paid game's free trial, for a player who has not bought it: minutes offered and the time this account has left.
    trial,
    // What the game needs from the player's browser; the page compares it with what this browser has before launch.
    // ...and the rest of what the build declares: languages, players, session, progress, accessibility, the age rating.
    ...(v ? await ensureVersionMeta(c.env, v).then(({ compat, meta }) => ({
      compat: { requirements: compat.requirements, declared: compat.declared, download_bytes: compat.download_bytes },
      meta: { ...meta.meta, rating: meta.rating, languages: meta.languages.languages, languages_declared: meta.languages.declared, declared: meta.declared, multiplayer: meta.detected.multiplayer },
      // adults only: the page blurs the cover and asks the player to confirm before the game starts (POST /play enforces it)
      mature: matureOf(meta.meta.content).categories,
    })).catch(() => ({ compat: null, meta: null, mature: matureList(p) })) : { compat: null, meta: null, mature: matureList(p) }),
  });
});

async function startPlay(c: Ctx, p: Project, envName: 'live' | 'preview', version: number, u: User, trialSeconds?: number, lifeS = PLAY_SESSION_S) {
  const kind = u.id === p.owner_id || u.role === 'admin' ? 'owner' : 'player', sid = 'ps_' + rid(16), t = now(), trial = trialSeconds !== undefined;
  // An account's session is bound to the sign-in that started it (session-binding.js): it ends when that sign-in does.
  const login = isGuestId(u.id) ? null : await loginIdOf(c.req.raw);
  await c.env.DB.prepare('INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at, trial, login_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(sid, p.id, version, envName, u.id, kind, t, t, trial ? 1 : 0, login).run();
  // A trial token lasts only as long as the trial time left (plus a little slack for the last heartbeat); a full one six hours.
  const life = trial ? trialSeconds + 20 : lifeS;
  const token = await signPlayToken({ g: p.id, e: envName, u: u.id, n: u.name, k: kind, s: sid, x: Math.floor(t / 1000) + life, ...(trial ? { tr: 1 } : {}) }, await playKey(c.env, p.id));
  return { url: `${await gameUrl(c.env, c.get('origin'), p.id, envName)}?gcp_t=${token}`, session: sid, version, player: { id: u.id, name: u.name, guest: isGuestId(u.id) }, ...(trial ? { trial: { remaining_seconds: trialSeconds } } : {}) };
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
  // one. With it off, a visitor without an account plays a free game as a guest; paid games always need an account
  // (buying and free trials belong to one). Every service the game then calls checks the setting again (routes/rt.ts).
  if (!c.get('user')) {
    const s = await getSettings(c.env);
    if (s.require_login_to_play) throw new AppError(401, 'Sign in to play.', 'unauthenticated');
    if (p.price_cents > 0) throw new AppError(401, 'Sign in to buy or try this game.', 'unauthenticated');
    const g = await guestIdentity(c.env, c.req.raw);
    if (g.cookie) c.header('set-cookie', g.cookie, { append: true });
    return c.json(await startPlay(c, p, 'live', p.live_version, { id: g.id, name: g.name, role: 'player' } as unknown as User, undefined, GUEST_SESSION_S));
  }
  const u = requireUser(c);
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
  const origin = c.get('origin'), brand = (await getSettings(c.env)).brand_name || DEFAULT_BRAND;
  const session = await stripe<{ id: string; url: string }>(c.env, 'POST', '/checkout/sessions', {
    mode: 'payment', client_reference_id: u.id, customer_email: u.email, metadata, payment_intent_data: { metadata },
    line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: amount, product_data: { name, description: `Sold by ${OPERATOR.name} on ${brand}` } } } },
    // The seller of record, next to the Pay button, with the terms the purchase falls under.
    custom_text: { submit: { message: `${brand} is developed and operated by ${OPERATOR.name}, the seller of this purchase. Terms: ${origin}/legal/terms · Refunds: ${origin}/legal/refunds` } },
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
  const s = await getSettings(c.env), trials = await trialStats(c.env, p.id);
  // The newest version's store-page metadata: what publishing still needs (field ids), and the age rating it works out to.
  const newest = versions.results[0], vm = newest ? await ensureVersionMeta(c.env, newest).catch(() => null) : null;
  const metadata = newest ? { version: newest.n, required: s.metadata_required, missing: missingToPublish(vm?.meta, !!vm?.compat?.declared, JSON.parse(p.tags || '[]')).map((m) => m.split(' ')[0]), age: vm?.meta?.rating?.age ?? null, declared: vm?.meta?.declared ?? [] } : null;
  return c.json({
    metadata,
    project: { ...card(origin, { ...p, author: u.name }), open_implementation_at: p.open_implementation_at, description: p.description, controls: p.controls, live_version: p.live_version, preview_version: p.preview_version, removed_reason: p.removed_reason, created_at: p.created_at, updated_at: p.updated_at },
    versions: versions.results.map((v) => ({ ...publicVersion(v, origin), eligible: versionEligible(v, s.verify_browser_required) })),
    events: events.results, daily: daily.results, errors: errors.results, sales,
    files: { count: files.length, bytes: files.reduce((a, f) => a + f.size, 0), storage_bytes: budgetOf(p, s).bytes, storage_set: budgetOf(p, s).source === 'game', request: await latestRequest(c.env, p.id).then((r) => r && { status: r.status, bytes: r.bytes, granted_bytes: r.granted_bytes, note: r.note, created_at: r.created_at }) },
    split: p.price_cents > 0 ? splitSale(p.price_cents, s) : null,
    trial: { minutes: p.trial_minutes, active: trialMinutes(p, s) > 0, ...trials },
    online: await onlineNow(c.env, p.id),
    implementation: p.open_implementation ? await db.prepare('SELECT version, summary_source, reads, created_at FROM implementations WHERE project_id = ?').bind(p.id).first() : null,
  });
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
  if (b.price_cents !== undefined || b.trial_minutes !== undefined) await updateProjectMeta(c.env, p, { price_cents: b.price_cents, trial_minutes: b.trial_minutes });
  if (b.trial_minutes !== undefined) await logEvent(c.env, p.id, 'trial', Number(b.trial_minutes) > 0 ? `Free trial set to ${Math.round(Number(b.trial_minutes))} min` : 'Free trial turned off', null, 'console');
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

// Following creators, and the notification feed under the bell in the top bar: the rules, as plain JS so the tests run
// them against SQLite with the real migrations (tests/follows.mjs). The routes are src/routes/follows.ts; news of a new
// game is written by src/pipeline.ts when a game goes live for the first time.
//
// Privacy: a follow is between the player and the creator's public profile. A creator sees how many follow them, never
// who; nobody else sees whom a player follows. A profile carries the display name, when the account joined, when it
// became a creator, its live games and public totals: never an email, a last-seen time or anything about purchases.
// A follow tells the creator nothing, so following and unfollowing cannot be used to ping someone; the rate limit in
// the routes only keeps scripts from churning the table.
import { FRIEND_KINDS } from './social-rules.js';

export class FollowError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const err = (status, code, message) => new FollowError(status, code, message);
const now = () => Date.now();

export const LIMITS = { following_max: 2000, live_push_max: 500, feed_max: 50 };
const ID_RE = /^[A-Za-z0-9_-]{2,64}$/;
export const validId = (id) => typeof id === 'string' && ID_RE.test(id);
const friendKinds = FRIEND_KINDS.map((k) => `'${k}'`).join(', ');

// ---- who is a creator -------------------------------------------------------------------------------------------------
/** An active account that is a creator: it holds a creator license or has (had) a game live. Null otherwise. */
export async function creatorOf(db, id) {
  if (!validId(id)) return null;
  return db.prepare(`SELECT u.id, u.name, u.created_at, u.creator_since FROM users u WHERE u.id = ? AND u.status = 'active'
      AND (u.creator = 1 OR EXISTS (SELECT 1 FROM projects p WHERE p.owner_id = u.id AND p.published_at IS NOT NULL))`).bind(id).first();
}

export async function followerCount(db, id) {
  return (await db.prepare("SELECT COUNT(*) AS n FROM follows f JOIN users u ON u.id = f.follower_id AND u.status = 'active' WHERE f.creator_id = ?").bind(id).first())?.n || 0;
}
export async function isFollowing(db, me, id) {
  if (!me || !validId(id)) return false;
  return !!(await db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND creator_id = ?').bind(me, id).first());
}

/**
 * A creator's public profile: who they are and their totals over the games players can find (live, not hidden by
 * reports). The games themselves come from the store's list (GET /api/games?by=<id>), so they look as they do there.
 */
export async function profile(db, id, viewer = null) {
  const u = await creatorOf(db, id);
  if (!u) return null;
  const [s, followers, following] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS games, COALESCE(SUM(plays), 0) AS plays, COALESCE(SUM(rating_sum), 0) AS rsum, COALESCE(SUM(rating_count), 0) AS rcount,
        COALESCE(SUM(playing), 0) AS playing, MIN(published_at) AS first_release, MAX(published_at) AS latest_release
      FROM projects WHERE owner_id = ? AND status = 'live' AND hidden_at IS NULL`).bind(id).first(),
    followerCount(db, id),
    viewer && viewer !== id ? isFollowing(db, viewer, id) : Promise.resolve(false),
  ]);
  return {
    creator: {
      id: u.id, name: u.name, joined_at: u.created_at, creator_since: u.creator_since || s?.first_release || null,
      followers, games: s?.games || 0, plays: s?.plays || 0, playing: s?.playing || 0,
      rating: s?.rcount ? Math.round((s.rsum / s.rcount) * 10) / 10 : null, rating_count: s?.rcount || 0,
      first_release: s?.first_release || null, latest_release: s?.latest_release || null,
    },
    viewer: { signed_in: !!viewer, self: viewer === id, following },
  };
}

// ---- following --------------------------------------------------------------------------------------------------------
export async function follow(db, me, id, limits = LIMITS, t = now()) {
  if (!validId(id)) throw err(400, 'bad_request', 'Unknown creator.');
  if (me === id) throw err(400, 'self_follow', 'You cannot follow yourself.');
  const c = await creatorOf(db, id);
  if (!c) throw err(404, 'not_found', 'No such creator.');
  if (await db.prepare('SELECT 1 FROM blocks WHERE (user_id = ?1 AND blocked_id = ?2) OR (user_id = ?2 AND blocked_id = ?1) LIMIT 1').bind(me, id).first()) throw err(403, 'not_allowed', 'You cannot follow this creator.');
  if (!(await isFollowing(db, me, id))) {
    const n = (await db.prepare('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?').bind(me).first())?.n || 0;
    if (n >= limits.following_max) throw err(409, 'following_max', `You follow ${limits.following_max} creators, the most there can be. Unfollow some first.`);
    await db.prepare('INSERT OR IGNORE INTO follows (follower_id, creator_id, created_at) VALUES (?, ?, ?)').bind(me, id, t).run();
  }
  return { following: true, followers: await followerCount(db, id) };
}
export async function unfollow(db, me, id) {
  if (!validId(id)) throw err(400, 'bad_request', 'Unknown creator.');
  await db.prepare('DELETE FROM follows WHERE follower_id = ? AND creator_id = ?').bind(me, id).run();
  return { following: false, followers: await followerCount(db, id) };
}
/** The creators this account follows, the most recently followed first, with how many live games each has. */
export async function followingList(db, me, limit = 200) {
  const r = await db.prepare(`SELECT u.id, u.name, f.created_at AS since,
        (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id AND p.status = 'live' AND p.hidden_at IS NULL) AS games
      FROM follows f JOIN users u ON u.id = f.creator_id AND u.status = 'active' WHERE f.follower_id = ? ORDER BY f.created_at DESC LIMIT ?`)
    .bind(me, Math.max(1, Math.min(LIMITS.following_max, limit))).all();
  return r.results.map((x) => ({ id: x.id, name: x.name, since: x.since, games: x.games }));
}
/** Paginated list of creators this account follows, with total count. */
export async function followingPage(db, me, { limit = 24, offset = 0 } = {}) {
  const lim = Math.max(1, Math.min(100, limit | 0 || 24)), off = Math.max(0, Math.min(LIMITS.following_max, offset | 0));
  const [rows, tot] = await Promise.all([
    db.prepare(`SELECT u.id, u.name, f.created_at AS since,
        (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id AND p.status = 'live' AND p.hidden_at IS NULL) AS games
      FROM follows f JOIN users u ON u.id = f.creator_id AND u.status = 'active' WHERE f.follower_id = ?1 ORDER BY f.created_at DESC LIMIT ?2 OFFSET ?3`)
      .bind(me, lim, off).all(),
    db.prepare("SELECT COUNT(*) AS n FROM follows f JOIN users u ON u.id = f.creator_id AND u.status = 'active' WHERE f.follower_id = ?").bind(me).first(),
  ]);
  return { following: rows.results.map((x) => ({ id: x.id, name: x.name, since: x.since, games: x.games })), total: tot?.n || 0 };
}

// ---- news of a new game --------------------------------------------------------------------------------------------
/**
 * A creator's game went live for the first time: every active follower gets one 'new_game' notification (written in
 * one statement however many there are, and never twice for the same game). Returns how many were written and the
 * followers to tell live (the most recent followers first, at most limits.live_push_max; the rest see it next time
 * they open the bell).
 */
export async function announceNewGame(db, creatorId, projectId, limits = LIMITS, t = now()) {
  const data = JSON.stringify({ project: projectId });
  const r = await db.prepare(`INSERT INTO notifications (user_id, kind, actor_id, data, created_at)
      SELECT f.follower_id, 'new_game', ?1, ?2, ?3 FROM follows f JOIN users u ON u.id = f.follower_id AND u.status = 'active'
      WHERE f.creator_id = ?1 AND f.follower_id != ?1
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = f.follower_id AND n.kind = 'new_game' AND n.actor_id = ?1 AND n.data = ?2)`)
    .bind(creatorId, data, t).run();
  const live = r.meta.changes ? await db.prepare(`SELECT f.follower_id AS id FROM follows f JOIN users u ON u.id = f.follower_id AND u.status = 'active'
      WHERE f.creator_id = ? AND f.follower_id != ? ORDER BY f.created_at DESC LIMIT ?`).bind(creatorId, creatorId, limits.live_push_max).all() : { results: [] };
  return { notified: r.meta.changes, live: live.results.map((x) => x.id) };
}

// ---- the bell ---------------------------------------------------------------------------------------------------------
// Everything that is not about friends (requests and acceptances live in the Friends panel). A notification about a
// game shows only while that game can be played: a game taken down drops out of the list and the count. data.project is
// the game's id (new_game) or {id, slug, title} (gifts, src/gifts.ts).
const FEED_WHERE = `n.user_id = ?1 AND n.kind NOT IN (${friendKinds})
  AND (n.kind NOT IN ('new_game', 'devlog') OR EXISTS (SELECT 1 FROM projects p WHERE p.id = json_extract(n.data, '$.project') AND p.status = 'live' AND p.hidden_at IS NULL))`;

export async function unreadCount(db, me) {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM notifications n WHERE ${FEED_WHERE} AND n.read_at IS NULL`).bind(me).first())?.n || 0;
}
const parse = (s) => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
/** The newest notifications (before: an id, for the next page), with the actor and the game each one is about. */
export async function feed(db, me, { limit = 20, before = null } = {}) {
  const n = Math.max(1, Math.min(LIMITS.feed_max, Number(limit) || 20));
  const r = await db.prepare(`SELECT n.id, n.kind, n.actor_id, n.data, n.created_at, n.read_at, a.name AS actor_name,
        p.slug, p.title, p.tagline, p.cover_key, p.status AS game_status, p.mature, p.listing_lang, p.listing_i18n, p.langs
      FROM notifications n LEFT JOIN users a ON a.id = n.actor_id LEFT JOIN projects p ON p.id = COALESCE(json_extract(n.data, '$.project.id'), json_extract(n.data, '$.project'))
      WHERE ${FEED_WHERE} ${before ? 'AND n.id < ?2' : ''} ORDER BY n.id DESC LIMIT ${before ? '?3' : '?2'}`)
    .bind(...(before ? [me, Number(before), n + 1] : [me, n + 1])).all();
  const rows = r.results.slice(0, n);
  return {
    items: rows.map((x) => {
      const data = parse(x.data);
      return {
        id: x.id, kind: x.kind, at: x.created_at, read: !!x.read_at,
        actor: { id: x.actor_id, name: x.actor_name || 'Deleted account' },
        game: x.slug ? { id: typeof data.project === 'object' && data.project ? data.project.id : data.project, slug: x.slug, title: x.title, tagline: x.tagline || '', cover_key: x.cover_key || null, live: x.game_status === 'live', mature: x.mature || '', listing_lang: x.listing_lang, listing_i18n: x.listing_i18n, langs: x.langs } : null,
        data,
      };
    }),
    more: r.results.length > n ? rows[rows.length - 1].id : null,
  };
}
/** Marks one notification read (id), or every one under the bell (id null). Friends' notifications are left alone. */
export async function markRead(db, me, id = null, t = now()) {
  if (id != null) {
    if (!/^\d{1,15}$/.test(String(id))) throw err(400, 'bad_request', 'Unknown notification.');
    await db.prepare(`UPDATE notifications SET read_at = ?3 WHERE id = ?2 AND user_id = ?1 AND kind NOT IN (${friendKinds}) AND read_at IS NULL`).bind(me, Number(id), t).run();
  } else {
    await db.prepare(`UPDATE notifications SET read_at = ?2 WHERE user_id = ?1 AND kind NOT IN (${friendKinds}) AND read_at IS NULL`).bind(me, t).run();
  }
  return { ok: true, unread: await unreadCount(db, me) };
}

// ---- upkeep -----------------------------------------------------------------------------------------------------------
/** A deleted account follows nobody and is followed by nobody. (Its notifications go with src/social-rules.js.) */
export function deleteAccountStmts(db, uid) {
  return [db.prepare('DELETE FROM follows WHERE follower_id = ?1 OR creator_id = ?1').bind(uid)];
}

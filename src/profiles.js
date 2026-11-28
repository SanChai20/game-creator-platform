// Player profiles: a page for every account with the games it plays, its play time, achievements and reviews, shown to
// the people its owner chose. Plain JS over a D1-shaped database so the rules can be tested without a Worker
// (tests/profiles.mjs).
//
// Rules, enforced here and nowhere else:
//   - Visibility is the owner's choice: everyone, friends (the default) or nobody. The owner always sees their own.
//     A block either way hides the profile completely, as if the account did not exist.
//   - A profile shows only what the platform measured (sessions, play time, unlocks) and what the owner wrote in public
//     (reviews), and only for live, listed games. Adults-only games are left out for everyone but the owner.
//   - The showcase holds up to 6 games the owner played, kept, or bought; anything else is refused.

import { pickText } from './achievements.js';

export const LIMITS = { bio: 160, showcase: 6, recent_achievements: 8, reviews: 5 };
export const VISIBILITY = ['everyone', 'friends', 'nobody'];
const ID_RE = /^[A-Za-z0-9_-]{2,64}$/;

export class ProfileError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const now = () => Date.now();
const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } };

/** The owner's settings: { visibility, bio, showcase: [ids] | null }. */
export async function settingsOf(db, uid) {
  const r = await db.prepare('SELECT visibility, bio, showcase FROM player_profiles WHERE user_id = ?').bind(uid).first();
  return { visibility: r?.visibility || 'friends', bio: r?.bio || null, showcase: r?.showcase ? parse(r.showcase, null) : null };
}

/** Trims a bio to one paragraph of plain text. */
export function cleanBio(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.bio);
  return s || null;
}

/** Changes visibility, bio and showcase (null: the most played games). Returns the new settings. */
export async function setSettings(db, uid, patch, t = now()) {
  const cur = await settingsOf(db, uid);
  const next = { ...cur };
  if (patch.visibility !== undefined) {
    if (!VISIBILITY.includes(patch.visibility)) throw new ProfileError(400, `visibility must be one of: ${VISIBILITY.join(', ')}.`, 'bad_request');
    next.visibility = patch.visibility;
  }
  if (patch.bio !== undefined) next.bio = cleanBio(patch.bio);
  if (patch.showcase !== undefined) {
    if (patch.showcase === null) next.showcase = null;
    else {
      if (!Array.isArray(patch.showcase)) throw new ProfileError(400, 'showcase must be a list of game ids, or null.', 'bad_request');
      const ids = [...new Set(patch.showcase.map(String))];
      if (ids.length > LIMITS.showcase) throw new ProfileError(400, `A showcase holds at most ${LIMITS.showcase} games.`, 'bad_request');
      if (ids.length) {
        const ok = await db.prepare(`SELECT p.id FROM projects p WHERE p.id IN (${ids.map(() => '?').join(',')}) AND p.status = 'live' AND (
            EXISTS (SELECT 1 FROM player_games g WHERE g.project_id = p.id AND g.user_id = ?)
            OR EXISTS (SELECT 1 FROM library_games l WHERE l.project_id = p.id AND l.user_id = ?)
            OR EXISTS (SELECT 1 FROM purchases b WHERE b.project_id = p.id AND b.user_id = ? AND b.status = 'paid')
            OR p.owner_id = ?)`).bind(...ids, uid, uid, uid, uid).all();
        const have = new Set(ok.results.map((r) => r.id));
        const bad = ids.filter((id) => !have.has(id));
        if (bad.length) throw new ProfileError(400, 'A showcase can only hold live games you played, keep or bought.', 'bad_showcase');
      }
      next.showcase = ids;
    }
  }
  await db.prepare(`INSERT INTO player_profiles (user_id, visibility, bio, showcase, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET visibility = excluded.visibility, bio = excluded.bio, showcase = excluded.showcase, updated_at = excluded.updated_at`)
    .bind(uid, next.visibility, next.bio, next.showcase ? JSON.stringify(next.showcase) : null, t).run();
  return next;
}

/**
 * Who `viewer` is to `target` and whether the profile shows: 'self', 'visible', 'private' (the name only, with a
 * friend request where allowed) or 'hidden' (no such account, blocked either way, or suspended).
 */
export async function access(db, viewer, target) {
  if (!ID_RE.test(String(target || ''))) return { state: 'hidden' };
  const u = await db.prepare("SELECT id, name, created_at FROM users WHERE id = ? AND status = 'active'").bind(target).first();
  if (!u) return { state: 'hidden' };
  if (viewer && viewer === target) return { state: 'self', user: u };
  if (viewer) {
    const b = await db.prepare('SELECT 1 AS x FROM blocks WHERE (user_id = ?1 AND blocked_id = ?2) OR (user_id = ?2 AND blocked_id = ?1) LIMIT 1').bind(viewer, target).first();
    if (b) return { state: 'hidden' };
  }
  const { visibility } = await settingsOf(db, target);
  if (visibility === 'everyone') return { state: 'visible', user: u };
  if (visibility === 'friends' && viewer && await db.prepare('SELECT 1 AS x FROM friendships WHERE user_id = ? AND friend_id = ?').bind(viewer, target).first()) return { state: 'visible', user: u };
  return { state: 'private', user: u };
}

const gameCols = 'p.id, p.slug, p.title, p.tagline, p.cover_key, p.listing_lang, p.listing_i18n, p.langs, p.age, p.tags';
const shownGame = (self) => `p.status = 'live' AND p.hidden_at IS NULL${self ? '' : ' AND COALESCE(p.age, 0) < 18'}`;

/** Everything a profile shows. `self` lets the owner see their adults-only games too. */
export async function profileOf(db, uid, { self = false, lang = 'en' } = {}) {
  const st = await settingsOf(db, uid);
  const [stats, ach, revs, creator, daily] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS games, COALESCE(SUM(g.seconds), 0) AS seconds FROM player_games g JOIN projects p ON p.id = g.project_id WHERE g.user_id = ? AND ${shownGame(self)}`).bind(uid).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM achievement_unlocks a JOIN projects p ON p.id = a.project_id WHERE a.user_id = ? AND ${shownGame(self)}`).bind(uid).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM reviews r JOIN projects p ON p.id = r.project_id WHERE r.user_id = ? AND r.hidden = 0 AND ${shownGame(self)}`).bind(uid).first(),
    db.prepare("SELECT 1 AS x FROM users u WHERE u.id = ? AND (u.creator = 1 OR EXISTS (SELECT 1 FROM projects p WHERE p.owner_id = u.id AND p.published_at IS NOT NULL))").bind(uid).first(),
    db.prepare('SELECT best, days FROM challenge_streaks WHERE user_id = ?').bind(uid).first(),   // daily challenges (src/challenges.js)
  ]);
  // the showcase: the games the owner picked, in their order, else the most played
  let games;
  if (st.showcase?.length) {
    const rows = (await db.prepare(`SELECT ${gameCols}, COALESCE(g.seconds, 0) AS seconds, g.last_at FROM projects p LEFT JOIN player_games g ON g.project_id = p.id AND g.user_id = ?
        WHERE p.id IN (${st.showcase.map(() => '?').join(',')}) AND ${shownGame(self)}`).bind(uid, ...st.showcase).all()).results;
    games = st.showcase.map((id) => rows.find((r) => r.id === id)).filter(Boolean);
  } else {
    games = (await db.prepare(`SELECT ${gameCols}, g.seconds, g.last_at FROM player_games g JOIN projects p ON p.id = g.project_id
        WHERE g.user_id = ? AND ${shownGame(self)} ORDER BY g.seconds DESC LIMIT ?`).bind(uid, LIMITS.showcase).all()).results;
  }
  const counts = games.length ? Object.fromEntries((await db.prepare(`SELECT project_id, COUNT(*) AS n FROM achievement_unlocks WHERE user_id = ? AND project_id IN (${games.map(() => '?').join(',')}) GROUP BY project_id`).bind(uid, ...games.map((g) => g.id)).all()).results.map((r) => [r.project_id, r.n])) : {};
  // the latest unlocks, named from the version that is live now
  const recent = (await db.prepare(`SELECT a.ach_id, a.unlocked_at, ${gameCols}, json_extract(v.manifest, '$.achievements') AS defs
      FROM achievement_unlocks a JOIN projects p ON p.id = a.project_id JOIN versions v ON v.project_id = p.id AND v.n = p.live_version
      WHERE a.user_id = ? AND ${shownGame(self)} ORDER BY a.unlocked_at DESC LIMIT ?`).bind(uid, LIMITS.recent_achievements).all()).results;
  const achievements = recent.map((r) => {
    const def = (parse(r.defs, []) || []).find((d) => d && d.id === r.ach_id);
    return def ? { id: r.ach_id, name: pickText(def.name, lang), description: pickText(def.description, lang), unlocked_at: r.unlocked_at, game: { slug: r.slug, title: r.title } } : null;
  }).filter(Boolean);
  const reviews = (await db.prepare(`SELECT r.rating, r.body, r.updated_at, ${gameCols} FROM reviews r JOIN projects p ON p.id = r.project_id
      WHERE r.user_id = ? AND r.hidden = 0 AND ${shownGame(self)} ORDER BY r.updated_at DESC LIMIT ?`).bind(uid, LIMITS.reviews).all()).results;
  return {
    bio: st.bio, visibility: st.visibility, creator: !!creator,
    stats: { games: stats?.games || 0, minutes: Math.round((stats?.seconds || 0) / 60), achievements: ach?.n || 0, reviews: revs?.n || 0, best_streak: daily?.best || 0, daily_days: daily?.days || 0 },
    showcase: games.map((g) => ({ ...g, minutes: Math.round((g.seconds || 0) / 60), achievements: counts[g.id] || 0, picked: !!st.showcase?.length })),
    achievements,
    reviews: reviews.map((r) => ({ rating: r.rating, body: r.body, at: r.updated_at, game: { slug: r.slug, title: r.title, cover_key: r.cover_key } })),
  };
}

/** Games the owner may put in their showcase: what they played, keep or bought, most played first. */
export async function showcaseChoices(db, uid) {
  return (await db.prepare(`SELECT p.id, p.slug, p.title, COALESCE(g.seconds, 0) AS seconds FROM projects p LEFT JOIN player_games g ON g.project_id = p.id AND g.user_id = ?1
      WHERE p.status = 'live' AND p.hidden_at IS NULL AND (g.user_id IS NOT NULL OR EXISTS (SELECT 1 FROM library_games l WHERE l.project_id = p.id AND l.user_id = ?1)
        OR EXISTS (SELECT 1 FROM purchases b WHERE b.project_id = p.id AND b.user_id = ?1 AND b.status = 'paid'))
      ORDER BY seconds DESC LIMIT 100`).bind(uid).all()).results;
}

/** The ids of reviewers whose profile anyone may open, for linking their names. */
export async function publicIds(db, ids) {
  const list = [...new Set(ids.filter((x) => ID_RE.test(String(x))))];
  if (!list.length) return new Set();
  const r = await db.prepare(`SELECT user_id FROM player_profiles WHERE visibility = 'everyone' AND user_id IN (${list.map(() => '?').join(',')})`).bind(...list).all();
  return new Set(r.results.map((x) => x.user_id));
}

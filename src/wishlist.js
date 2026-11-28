// Coming soon pages and wishlists. A creator announces a game before its first release: the game page is public, shows
// no Play button, and players add it to their wishlist. The first release tells everyone who wished for it, under the
// bell and by push. A paid live game can be wishlisted too, and its next sale is news for them. Plain JS over a
// D1-shaped database so the rules can be tested without a Worker (tests/wishlist.mjs).
//
// Rules, enforced here and nowhere else:
//   - Only a game that was never released can be announced, and only with a title, a tagline and a cover, because that
//     is all a coming soon page has to show. A release ends the announcement for good.
//   - A player wishlists a game that is coming soon, or a paid live game they do not own. Never their own game.
//   - Creators see how many wished for a game, never who.

export const LIMITS = { release_note: 40, wishlist_max: 1000, live_push_max: 500 };

export class WishError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const now = () => Date.now();

/** What an announcement still needs: a list of { field, message } (empty when it can go up). */
export function announceIssues(p) {
  const out = [];
  if (p.published_at || p.status === 'live') out.push({ field: 'status', message: 'The game has already been released, so its page is a store page now.' });
  if (p.status === 'removed') out.push({ field: 'status', message: 'The project was deleted.' });
  if (!String(p.title || '').trim()) out.push({ field: 'title', message: 'Give the game a title.' });
  if (!String(p.tagline || '').trim()) out.push({ field: 'tagline', message: 'Write a tagline: one line that says what the game is.' });
  if (!p.cover_key) out.push({ field: 'cover', message: 'Upload a cover: it is the picture of a coming soon page and of its store card.' });
  return out;
}

/** The creator's "when": trimmed, one line, up to 40 characters, or null. */
export function cleanReleaseNote(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/\s+/g, ' ').trim().slice(0, LIMITS.release_note);
  return s || null;
}

/** Whether a project's page is a public coming soon page. */
export const isComingSoon = (p) => !!p && !!p.coming_soon_at && !p.published_at && p.status !== 'live' && p.status !== 'removed' && !p.hidden_at;

/**
 * Turns the coming soon page on or off, or changes its release note. on: true needs announceIssues() to be empty.
 * Returns { coming_soon, release_note, coming_soon_at }.
 */
export async function setComingSoon(db, p, { on, release_note } = {}, t = now()) {
  const note = release_note === undefined ? (p.release_note ?? null) : cleanReleaseNote(release_note);
  if (on === false) {
    await db.prepare('UPDATE projects SET coming_soon_at = NULL, release_note = ? WHERE id = ?').bind(note, p.id).run();
    return { coming_soon: false, release_note: note, coming_soon_at: null };
  }
  if (on === true && !p.coming_soon_at) {
    const issues = announceIssues(p);
    if (issues.length) throw new WishError(409, `Not ready to announce: ${issues.map((i) => i.message).join(' ')}`, 'not_ready');
  }
  const at = on === true ? (p.coming_soon_at || t) : p.coming_soon_at || null;
  await db.prepare('UPDATE projects SET coming_soon_at = ?, release_note = ? WHERE id = ?').bind(at, note, p.id).run();
  return { coming_soon: !!at, release_note: note, coming_soon_at: at };
}

/** Whether a player may wishlist this game: coming soon, or paid and live and not theirs already. */
export async function canWish(db, uid, p) {
  if (!uid || uid === p.owner_id) return false;
  if (isComingSoon(p)) return true;
  if (p.status !== 'live' || p.hidden_at || !(p.price_cents > 0)) return false;
  const owned = await db.prepare("SELECT 1 AS x FROM purchases WHERE user_id = ? AND project_id = ? AND status = 'paid' LIMIT 1").bind(uid, p.id).first();
  return !owned;
}

export async function addWish(db, uid, p, t = now()) {
  if (!(await canWish(db, uid, p))) throw new WishError(409, p.owner_id === uid ? 'This is your own game.' : 'Only a game that is coming soon, or a paid game you do not own, can go on your wishlist.', 'not_wishable');
  const n = (await db.prepare('SELECT COUNT(*) AS n FROM wishlists WHERE user_id = ?').bind(uid).first())?.n || 0;
  if (n >= LIMITS.wishlist_max) throw new WishError(409, `Your wishlist holds at most ${LIMITS.wishlist_max} games. Take some off first.`, 'wishlist_full');
  await db.prepare('INSERT INTO wishlists (user_id, project_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(uid, p.id, t).run();
  return { wished: true };
}

export async function removeWish(db, uid, pid) {
  await db.prepare('DELETE FROM wishlists WHERE user_id = ? AND project_id = ?').bind(uid, pid).run();
  return { wished: false };
}

export async function isWished(db, uid, pid) {
  if (!uid) return false;
  return !!(await db.prepare('SELECT 1 AS x FROM wishlists WHERE user_id = ? AND project_id = ?').bind(uid, pid).first());
}

/** How many active accounts wish for a game, and how many joined since `since`. */
export async function wishCount(db, pid, since = 0) {
  const r = await db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN w.created_at >= ? THEN 1 ELSE 0 END), 0) AS recent FROM wishlists w JOIN users u ON u.id = w.user_id AND u.status = 'active' WHERE w.project_id = ?").bind(since, pid).first();
  return { wishlists: r?.n || 0, recent: r?.recent || 0 };
}

/** A player's wishlist, newest first: the games that are still coming soon or live. */
export async function wishlistOf(db, uid, limit = 200) {
  const r = await db.prepare(`SELECT p.*, u.name AS author, w.created_at AS wished_at FROM wishlists w JOIN projects p ON p.id = w.project_id JOIN users u ON u.id = p.owner_id
      WHERE w.user_id = ? AND p.status != 'removed' AND p.hidden_at IS NULL AND (p.status = 'live' OR (p.coming_soon_at IS NOT NULL AND p.published_at IS NULL))
      ORDER BY w.created_at DESC LIMIT ?`).bind(uid, Math.min(500, limit)).all();
  return r.results;
}

/** Coming soon games for the store: the most wished for first. */
export async function comingSoonGames(db, limit = 12) {
  const r = await db.prepare(`SELECT p.*, u.name AS author, (SELECT COUNT(*) FROM wishlists w WHERE w.project_id = p.id) AS wishes FROM projects p JOIN users u ON u.id = p.owner_id
      WHERE p.coming_soon_at IS NOT NULL AND p.published_at IS NULL AND p.status NOT IN ('live', 'removed') AND p.hidden_at IS NULL AND COALESCE(p.age, 0) < 18
      ORDER BY wishes DESC, p.coming_soon_at DESC LIMIT ?`).bind(Math.min(50, limit)).all();
  return r.results;
}

/**
 * Tells everyone who wished for a game that something happened to it: kind 'wish_release' (its first release) or
 * 'wish_sale' (a sale started). One notification per player, game and kind for each event key. The game's owner and
 * inactive accounts are left out. Returns { notified, live: [user ids to push to] }.
 */
export async function tellWishers(db, pid, kind, key = '', t = now()) {
  if (!['wish_release', 'wish_sale'].includes(kind)) throw new Error('unknown kind ' + kind);
  const p = await db.prepare('SELECT id, owner_id FROM projects WHERE id = ?').bind(pid).first();
  if (!p) return { notified: 0, live: [] };
  const data = JSON.stringify(key ? { project: pid, key } : { project: pid });
  const r = await db.prepare(`INSERT INTO notifications (user_id, kind, actor_id, data, created_at)
      SELECT w.user_id, ?1, ?2, ?3, ?4 FROM wishlists w JOIN users u ON u.id = w.user_id AND u.status = 'active'
      WHERE w.project_id = ?5 AND w.user_id != ?2
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = w.user_id AND n.kind = ?1 AND n.data = ?3)`).bind(kind, p.owner_id, data, t, pid).run();
  const notified = r.meta?.changes || 0;
  const live = notified ? await db.prepare(`SELECT w.user_id AS id FROM wishlists w JOIN users u ON u.id = w.user_id AND u.status = 'active'
      WHERE w.project_id = ? AND w.user_id != ? ORDER BY w.created_at DESC LIMIT ?`).bind(pid, p.owner_id, LIMITS.live_push_max).all() : { results: [] };
  return { notified, live: live.results.map((x) => x.id) };
}

/** After the first release: the announcement is over, and the players who wished for it hear about it. */
export async function released(db, pid, t = now()) {
  await db.prepare('UPDATE projects SET coming_soon_at = NULL WHERE id = ?').bind(pid).run();
  return tellWishers(db, pid, 'wish_release', '', t);
}

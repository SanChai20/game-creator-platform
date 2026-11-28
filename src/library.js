// The player's game library: the games a player owns or keeps, apart from the creator console.
//   - Paid games join it through their purchase: the moment a payment is recorded as paid (Stripe checkout, an admin
//     grant) the game is in the library, and a refund or chargeback takes it out again. Nothing is copied, so the library
//     can never disagree with what the player actually owns.
//   - Free games are added (and removed) by the player themselves (library_games).
//   - Games the player played are on the Continue row (player-data.js continueList), shown at the top of the library.
// Plain JS over a D1-shaped database so the rules can be tested without a Worker (tests/library.mjs). Every call takes
// the player from the signed-in session, never from a request body.

export const MAX_ADDED = 2000;   // free games one account can keep in its library
export const LIBRARY_FILTERS = ['all', 'bought', 'added'];

export class LibraryError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const PAID = "SELECT 1 FROM purchases b WHERE b.user_id = ?1 AND b.project_id = p.id AND b.status = 'paid'";

/**
 * One page of the player's library, newest first: bought games (when they were bought) and added free games (when they
 * were added). Only live games: one taken offline or removed drops out and comes back if it returns.
 */
export async function libraryList(db, userId, { limit = 24, offset = 0, filter = 'all' } = {}) {
  const lim = Math.max(1, Math.min(60, limit | 0 || 24)), off = Math.max(0, Math.min(10000, offset | 0));
  const f = LIBRARY_FILTERS.includes(filter) ? filter : 'all';
  const parts = [];
  if (f !== 'added') parts.push("SELECT b.project_id, 'bought' AS source, MAX(b.created_at) AS added_at FROM purchases b WHERE b.user_id = ?1 AND b.status = 'paid' GROUP BY b.project_id");
  // a free game that later got a price and was then bought is listed once, as bought
  if (f !== 'bought') parts.push("SELECT l.project_id, 'added' AS source, l.added_at FROM library_games l WHERE l.user_id = ?1 AND NOT EXISTS (SELECT 1 FROM purchases b WHERE b.user_id = ?1 AND b.project_id = l.project_id AND b.status = 'paid')");
  const rows = await db.prepare(`SELECT x.project_id, x.source, x.added_at, (p.price_cents = 0 OR p.owner_id = ?1 OR EXISTS (${PAID})) AS owned,
      (SELECT pg.last_at FROM player_games pg WHERE pg.project_id = p.id AND pg.user_id = ?1) AS last_played,
      (SELECT COUNT(*) FROM achievement_unlocks a WHERE a.project_id = p.id AND a.user_id = ?1) AS ach_unlocked,
      (SELECT json_array_length(v.manifest, '$.achievements') FROM versions v WHERE v.project_id = p.id AND v.n = p.live_version) AS ach_total
    FROM (${parts.join(' UNION ALL ')}) x JOIN projects p ON p.id = x.project_id
    WHERE p.status = 'live' ORDER BY x.added_at DESC, x.project_id LIMIT ?2 OFFSET ?3`).bind(userId, lim + 1, off).all();
  const list = rows.results.slice(0, lim).map((r) => ({ game_id: r.project_id, source: r.source, added_at: r.added_at, owned: !!r.owned, last_played: r.last_played || null, achievements: r.ach_total ? { unlocked: Math.min(r.ach_unlocked || 0, r.ach_total), total: r.ach_total } : null }));
  return { list, more: rows.results.length > lim };
}

/** How many live games are in each part of the library, for its filter. */
export async function libraryCounts(db, userId) {
  const r = await db.prepare(`SELECT
      (SELECT COUNT(DISTINCT b.project_id) FROM purchases b JOIN projects p ON p.id = b.project_id WHERE b.user_id = ?1 AND b.status = 'paid' AND p.status = 'live') AS bought,
      (SELECT COUNT(*) FROM library_games l JOIN projects p ON p.id = l.project_id WHERE l.user_id = ?1 AND p.status = 'live' AND NOT EXISTS (${PAID})) AS added`).bind(userId).first();
  const bought = r?.bought || 0, added = r?.added || 0;
  return { all: bought + added, bought, added };
}

/** Whether one game is in the player's library, and how it got there: 'bought', 'added' or null. */
export async function libraryState(db, userId, projectId) {
  if (await db.prepare("SELECT 1 FROM purchases WHERE user_id = ? AND project_id = ? AND status = 'paid'").bind(userId, projectId).first()) return 'bought';
  if (await db.prepare('SELECT 1 FROM library_games WHERE user_id = ? AND project_id = ?').bind(userId, projectId).first()) return 'added';
  return null;
}

/**
 * Adds a free live game to the player's library. A paid game cannot be added: it joins the library when it is bought.
 * Adding one already there changes nothing.
 */
export async function addToLibrary(db, userId, game, t = Date.now()) {
  if (!game || game.status !== 'live') throw new LibraryError(404, 'That game is not available.', 'not_found');
  const state = await libraryState(db, userId, game.id);
  if (state) return { ok: true, library: state };
  if (game.price_cents > 0) throw new LibraryError(409, 'Paid games join your library when you buy them.', 'paid');
  const n = await db.prepare('SELECT COUNT(*) AS n FROM library_games WHERE user_id = ?').bind(userId).first();
  if ((n?.n || 0) >= MAX_ADDED) throw new LibraryError(409, `Your library holds up to ${MAX_ADDED} free games. Remove some first.`, 'full');
  await db.prepare('INSERT INTO library_games (user_id, project_id, added_at) VALUES (?, ?, ?) ON CONFLICT(user_id, project_id) DO NOTHING').bind(userId, game.id, t).run();
  return { ok: true, library: 'added' };
}

/**
 * Takes an added free game out of the library. Progress and saves stay. A bought game stays in the library while the
 * player owns it (a refund is what takes it out), so this leaves it where it is and says so.
 */
export async function removeFromLibrary(db, userId, projectId) {
  await db.prepare('DELETE FROM library_games WHERE user_id = ? AND project_id = ?').bind(userId, projectId).run();
  return { ok: true, library: await libraryState(db, userId, projectId) };
}

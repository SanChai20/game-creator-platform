// Coming back to a running match (GCP.match.rejoin): where each player's last match is kept, and which match a player
// may be handed a new ticket for. Plain JS over a D1-shaped database, so the rules can be tested without a Worker
// (tests/match-seats.mjs).
//
// The rules:
//   - The matchmaker records one seat per player, game and environment when it starts a match; the next match replaces it.
//   - A player gets a ticket again only for the match their seat names, only while it has not reported its end, only
//     if its roster lists them, and never for a match older than a match can last.
//   - Whether the player may still enter (they did not leave on purpose, the game's rejoinMs has not run out) is the
//     running match's own decision (src/runtime/match-core.js): the platform does not know what happened inside it.

/** A match lasts an hour at most (LIMITS.maxDurationMs in src/runtime/match-core.js) after a short wait for its players. */
export const MATCH_MAX_AGE_MS = 62 * 60 * 1000;

/** The statements that record every player's seat in a match that is starting (run them with the match's own insert). */
export function seatStmts(db, g, e, userIds, matchId, t = Date.now()) {
  return userIds.map((u) => db.prepare(`INSERT INTO match_seats (project_id, env, user_id, match_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(project_id, env, user_id) DO UPDATE SET match_id = ?4, created_at = ?5`).bind(g, e, String(u), matchId, t));
}

/**
 * The running match a player may go back into, or null: { id, queue, mode, region, started, roster: [{ id, name, team }] }.
 * tok is the verified play token ({ g, e, u }).
 */
export async function currentMatch(db, tok, t = Date.now()) {
  const seat = await db.prepare('SELECT match_id FROM match_seats WHERE project_id = ? AND env = ? AND user_id = ?').bind(tok.g, tok.e, tok.u).first();
  if (!seat) return null;
  const m = await db.prepare('SELECT id, queue, mode, roster, region, created_at, ended_at FROM matches WHERE id = ? AND project_id = ? AND env = ?').bind(seat.match_id, tok.g, tok.e).first();
  // over, or older than a match can last (it ended without reporting: its Worker was deployed again)
  if (!m || m.ended_at || t - m.created_at > MATCH_MAX_AGE_MS) return null;
  let roster = [];
  try { roster = JSON.parse(m.roster || '[]').map((r) => ({ id: String(r.id), name: String(r.name || 'Player'), team: r.team ?? null })); } catch { return null; }
  if (!roster.some((r) => r.id === tok.u)) return null;
  return { id: m.id, queue: m.queue, mode: m.mode || '', region: m.region || null, started: m.created_at, roster };
}

/** Daily cleanup: a seat older than a day leads nowhere. */
export const oldSeatsStmt = (db, before) => db.prepare('DELETE FROM match_seats WHERE created_at < ?').bind(before);

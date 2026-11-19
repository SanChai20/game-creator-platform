// The catalogue's sort numbers, kept on each project by cron instead of being worked out for every live game on every
// store request (correlated subqueries per row took the home page to seconds at 20,000 games).
import type { Env } from './env';
import { addDays, dayOf, now } from './util';
import { ONLINE_WINDOW_MS } from './analytics';

/** Players with a heartbeat in the last minute, per live game (runs every minute). */
export function playingStmts(db: D1Database, t = now()): D1PreparedStatement[] {
  const since = t - ONLINE_WINDOW_MS, active = "SELECT project_id FROM plays WHERE env = 'live' AND last_beat_at > ?1 AND kind != 'verify'";
  return [
    db.prepare(`UPDATE projects SET playing = 0 WHERE playing != 0 AND id NOT IN (${active})`).bind(since),
    db.prepare(`UPDATE projects SET playing = (SELECT COUNT(DISTINCT pl.user_id) FROM plays pl WHERE pl.project_id = projects.id AND pl.env = 'live' AND pl.last_beat_at > ?1 AND pl.kind != 'verify')
      WHERE id IN (${active})`).bind(since),
  ];
}

/** Plays * 4 + minutes played over the last 7 days, per live game (runs every 10 minutes). */
export function recentStmt(db: D1Database, t = now()): D1PreparedStatement {
  return db.prepare(`UPDATE projects SET recent = COALESCE((SELECT SUM(plays) * 4 + SUM(seconds) / 60 FROM game_daily d WHERE d.project_id = projects.id AND d.day >= ?), 0)
    WHERE status = 'live' OR recent != 0`).bind(addDays(dayOf(t), -7));
}

export async function refreshCatalog(env: Env, withRecent: boolean): Promise<void> {
  await env.DB.batch([...playingStmts(env.DB), ...(withRecent ? [recentStmt(env.DB)] : [])]);
}

/**
 * How free games are ranked against each other (the Free shelf, and /games?price=free in trending order). A free game
 * that shares its Open Implementation gets its recent play counted `boostPercent` percent higher, so it rises above
 * free games with similar or somewhat more play, but never above one with clearly more (at most double). A game rated
 * poorly (Bayesian average below 3, with the same prior as the Top sort) gets no boost, so sharing never lifts a bad game.
 * Returns an ORDER BY fragment over the projects table aliased p; the boost is clamped to a whole number from 0 to 100
 * before it is written into the SQL.
 */
export function freeTrendingOrder(boostPercent: number, a = 'p'): string {
  const b = Math.max(0, Math.min(100, Math.round(Number(boostPercent) || 0)));
  if (!b) return `${a}.featured DESC, ${a}.recent DESC, ${a}.plays DESC, ${a}.published_at DESC`;
  const goodEnough = `(${a}.rating_sum + 3.5 * 3) * 1.0 / (${a}.rating_count + 3) >= 3`;
  return `${a}.featured DESC, ${a}.recent * (CASE WHEN ${a}.open_implementation = 1 AND ${goodEnough} THEN ${(100 + b) / 100} ELSE 1 END) DESC, ${a}.plays DESC, ${a}.published_at DESC`;
}

// The catalogue's sort numbers, kept on each project by cron instead of being worked out for every live game on every
// store request (correlated subqueries per row took the home page to seconds at 20,000 games).
import type { Env } from './env';
import { now } from './util';
import { trendStmt } from './rankings';
import { ONLINE_WINDOW_MS } from './analytics';
import { getSettings } from './settings';

/** Players whose page checked in during the last minute (the platform's play clock, not the game's heartbeat), per live game (runs every minute). */
export function playingStmts(db: D1Database, t = now()): D1PreparedStatement[] {
  const since = t - ONLINE_WINDOW_MS, active = "SELECT project_id FROM plays WHERE env = 'live' AND seen_at > ?1 AND kind != 'verify'";
  return [
    db.prepare(`UPDATE projects SET playing = 0 WHERE playing != 0 AND id NOT IN (${active})`).bind(since),
    db.prepare(`UPDATE projects SET playing = (SELECT COUNT(DISTINCT pl.user_id) FROM plays pl WHERE pl.project_id = projects.id AND pl.env = 'live' AND pl.seen_at > ?1 AND pl.kind != 'verify')
      WHERE id IN (${active})`).bind(since),
  ];
}

/** The trending score, per live game (runs every 10 minutes). Worked out in src/rankings.ts. */
export const recentStmt = (db: D1Database, t = now()) => trendStmt(db, t);

export async function refreshCatalog(env: Env, withRecent: boolean): Promise<void> {
  // at scale each game's tally keeps projects.playing itself (src/clock-do.ts); this only clears games whose tally stopped
  const playing = (await getSettings(env)).play_clock_do
    ? [env.DB.prepare('UPDATE projects SET playing = 0 WHERE playing != 0 AND id NOT IN (SELECT project_id FROM game_online WHERE updated_at > ?)').bind(now() - 6 * 60_000)]
    : playingStmts(env.DB);
  await env.DB.batch([...playing, ...(withRecent ? [recentStmt(env.DB)] : [])]);
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
  // like Trending, no admin-featured pin: featured games go into today's picks (src/rankings.ts)
  if (!b) return `${a}.recent DESC, ${a}.plays DESC, ${a}.published_at DESC`;
  const goodEnough = `(${a}.rating_sum + 3.5 * 3) * 1.0 / (${a}.rating_count + 3) >= 3`;
  return `${a}.recent * (CASE WHEN ${a}.open_implementation = 1 AND ${goodEnough} THEN ${(100 + b) / 100} ELSE 1 END) DESC, ${a}.plays DESC, ${a}.published_at DESC`;
}

/**
 * A page of free games in the same order as freeTrendingOrder, without sorting every free game. The boost only scales a
 * game's recent score within its own group (boosted: shares its Open Implementation and is rated well enough; or not),
 * so the first `offset + limit` games of the boosted order are always among the first `offset + limit` of each group in
 * plain trending order, which an index reads directly. The two short lists are merged with the boosted order.
 * Placeholders: the WHERE arguments, then `offset + limit`, the WHERE arguments again, `offset + limit`, `limit` and
 * `offset` (freeTrendingArgs). Returns null when there is no boost: the plain trending order is already indexed.
 */
export function freeTrendingQuery(boostPercent: number, select: string, from: string, where: string): string | null {
  const b = Math.max(0, Math.min(100, Math.round(Number(boostPercent) || 0)));
  if (!b) return null;
  const boosted = `(p.open_implementation = 1 AND (p.rating_sum + 3.5 * 3) * 1.0 / (p.rating_count + 3) >= 3)`;
  const part = (cond: string, g: number) => `SELECT * FROM (SELECT ${select}, ${g} AS boost_group FROM ${from} WHERE ${where} AND ${cond} ORDER BY p.recent DESC, p.plays DESC, p.published_at DESC LIMIT ?)`;
  return `SELECT * FROM (${part(boosted, 1)} UNION ALL ${part(`NOT ${boosted}`, 0)})
    ORDER BY recent * (CASE WHEN boost_group = 1 THEN ${(100 + b) / 100} ELSE 1 END) DESC, plays DESC, published_at DESC LIMIT ? OFFSET ?`;
}
export const freeTrendingArgs = (args: unknown[], limit: number, offset: number) => [...args, offset + limit, ...args, offset + limit, limit, offset];

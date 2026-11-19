// The catalogue's sort numbers, kept on each project by cron instead of being worked out for every live game on every
// store request (correlated subqueries per row took the home page to seconds at 20,000 games).
import type { Env } from './env';
import { now } from './util';
import { trendStmt } from './rankings';
import { ONLINE_WINDOW_MS } from './analytics';

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
export const recentStmt = trendStmt;

export async function refreshCatalog(env: Env, withRecent: boolean): Promise<void> {
  await env.DB.batch([...playingStmts(env.DB), ...(withRecent ? [recentStmt(env.DB)] : [])]);
}

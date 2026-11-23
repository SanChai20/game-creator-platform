// The store's rankings, kept by the scheduled jobs (src/index.ts) so that no admin has to look after them:
//
//   playing now      every minute   players whose page checked in during the last minute (src/catalog.ts)
//   trending score   every 10 min   projects.recent: platform-measured plays and play time over 14 days, weighted toward
//                                   the last few days, times how players stick with the game (src/store-quality.ts) and
//                                   a small rating factor. Trending, the Free shelf and "Trending this week" sort on it.
//   engagement, New shelf  every 10 min  players, time per player, quick quits and returns (src/store-quality.ts); games
//                                   on the New shelf that players stuck with move to the main store
//   today's picks    once a day     the home page's lead (daily_picks), chosen at the first run after midnight UTC
//   top rated, most played, new     worked out from live numbers on every request, nothing to refresh
//   game leaderboards (GCP.leaderboard)  sorted when read, nothing to refresh; guests' scores go with the daily cleanup
//
// Every number comes from what the platform measures itself (game_daily, src/play-clock.ts) and from player ratings,
// never from what a game reports.
import type { Env } from './env';
import { addDays, dayOf, now } from './util';
import { freeTrendingOrder } from './catalog';
import { getSettings } from './settings';
import { engagementFactor } from './store-quality';

/** Days of activity the trending score looks at. */
export const TREND_DAYS = 14;
/** The Bayesian prior every ranking uses: a game starts as if it had PRIOR_N ratings of PRIOR_MEAN. */
export const PRIOR_MEAN = 3.5, PRIOR_N = 3;
const BAYES = (p = '') => `((${p}rating_sum + ${PRIOR_MEAN * PRIOR_N}) * 1.0 / (${p}rating_count + ${PRIOR_N}))`;

/**
 * The trending score of every live game, into projects.recent (runs every 10 minutes).
 * Each day counts plays * 2 + minutes played, weighted 2 / (2 + days ago): today 1, two days ago 0.5, a week ago 0.22,
 * two weeks ago 0.13. So a game that is being played now climbs within the hour and a burst from last week fades,
 * instead of a flat seven-day sum that drops a game off a cliff on day eight. Play time weighs more than play count, so
 * a game opened often but left at once does not lead. That is multiplied by the engagement factor (0.25 to 1.5: time
 * per player, players who come back another day, players who leave within a minute; src/store-quality.ts) and by the
 * rating factor, 0.7 (1 star) to 1.1 (5 stars), 0.95 with no ratings, so a well-liked game edges ahead of an equally played one.
 * Games that are not live get 0.
 *
 * Only rows whose score changes are written. The score of a game nobody played in the last 14 days stays 0, and within a
 * day only games played since the last run move, so at tens of thousands of games the job writes a few hundred rows a
 * run instead of every live game every 10 minutes (D1 bills and serializes every row written).
 */
export function trendStmt(db: D1Database, t = now()): D1PreparedStatement {
  const today = dayOf(t);
  return db.prepare(`UPDATE projects SET recent = n.score FROM (
      SELECT p.id, CASE WHEN p.status = 'live' THEN CAST(ROUND(COALESCE(d.s, 0) * ${engagementFactor('p')} * (0.6 + 0.1 * ${BAYES('p.')})) AS INTEGER) ELSE 0 END AS score
      FROM projects p LEFT JOIN (
        SELECT project_id, SUM((plays * 2 + seconds / 60.0) * 2.0 / (2 + julianday(?1) - julianday(day))) AS s
        FROM game_daily WHERE day >= ?2 AND day <= ?1 GROUP BY project_id
      ) d ON d.project_id = p.id
      WHERE p.recent != 0 OR d.project_id IS NOT NULL
    ) AS n
    WHERE projects.id = n.id AND projects.recent != n.score`).bind(today, addDays(today, -(TREND_DAYS - 1)));
}

// ---- today's picks -------------------------------------------------------------------------------
export const PICK_SLOTS = 6;
/** A game picked on one of the last REPEAT_DAYS days is passed over while there are others to pick (featured games excepted). */
export const REPEAT_DAYS = 3;
/** Picks are kept this long, then the daily cleanup drops them. */
export const KEEP_PICKS_DAYS = 30;
/**
 * How the free slot orders free games (an ORDER BY fragment over projects p): the same order as the Free shelf, so
 * free games that share their Open Implementation get the same lift here (src/catalog.ts).
 */
export async function freePickOrder(env: Env): Promise<string> { return freeTrendingOrder((await getSettings(env)).open_impl_free_boost_percent); }

export type PickReason = 'featured' | 'trending' | 'rising' | 'new' | 'gem' | 'free' | 'more';
export interface PickCandidate {
  id: string; featured: number; price_cents: number; recent: number; plays: number; rating_sum: number; rating_count: number; published_at: number | null;
  last3?: number; prior7?: number;   // activity (plays * 4 + minutes) in the last 3 days and in the 7 days before them
}
export interface PickLists { featured: PickCandidate[]; trending: PickCandidate[]; fresh: PickCandidate[]; rated: PickCandidate[]; free: PickCandidate[] }

const bayes = (g: PickCandidate) => (g.rating_sum + PRIOR_MEAN * PRIOR_N) / (g.rating_count + PRIOR_N);
/** How much faster a game is being played in the last 3 days than in the week before (per day, smoothed). */
export const growth = (g: PickCandidate) => ((g.last3 || 0) / 3 + 1) / ((g.prior7 || 0) / 7 + 1);
function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

/**
 * Pure: the day's picks from the candidate lists, in page order. Up to two admin-featured games lead (an optional
 * override; nothing needs featuring). Then one slot each for: trending, rising (played much more these last 3 days),
 * new (published in the last 14 days), a hidden gem (rated well, played little) and a free game; the rest is filled
 * from trending. Each slot takes one of its top three that was not picked in the last few days, varied by the day, so
 * the lead changes every day without anyone touching it.
 */
export function choosePicks(lists: PickLists, recentlyPicked: Set<string>, day: string, slots = PICK_SLOTS): { id: string; reason: PickReason }[] {
  const out: { id: string; reason: PickReason }[] = [], used = new Set<string>();
  const take = (list: PickCandidate[], reason: PickReason, ok: (g: PickCandidate) => boolean = () => true) => {
    if (out.length >= slots) return false;
    const open = list.filter((g) => !used.has(g.id) && ok(g)), unseen = open.filter((g) => !recentlyPicked.has(g.id));
    const pool = (unseen.length ? unseen : open).slice(0, 3);
    if (!pool.length) return false;
    const g = pool[hash(day + ':' + reason + ':' + out.length) % pool.length];
    used.add(g.id); out.push({ id: g.id, reason });
    return true;
  };
  for (const g of lists.featured.slice(0, 2)) if (out.length < slots && !used.has(g.id)) { used.add(g.id); out.push({ id: g.id, reason: 'featured' }); }
  take(lists.trending, 'trending');
  take([...lists.trending, ...lists.fresh].sort((a, b) => growth(b) - growth(a)), 'rising', (g) => (g.last3 || 0) >= 8 && growth(g) >= 1.5);
  take(lists.fresh, 'new');
  const played = lists.trending.map((g) => g.plays).sort((a, b) => a - b), median = played.length ? played[Math.floor(played.length / 2)] : 0;
  take(lists.rated, 'gem', (g) => g.rating_count >= 3 && bayes(g) >= 4 && g.plays <= median);
  take(lists.free, 'free', (g) => g.price_cents === 0);
  while (take(lists.trending, 'more'));
  return out;
}

const COLS = 'p.id, p.featured, p.price_cents, p.recent, p.plays, p.rating_sum, p.rating_count, p.published_at';
// Adults-only games never lead the store front, and neither do games on the New shelf or hidden by player reports
// (with the New shelf turned off, every visible live game can be picked).
const liveWhere = (newShelf = true) => `p.status = 'live' AND p.mature = '' AND p.hidden_at IS NULL${newShelf ? " AND p.shelf = 'main'" : ''}`;

/** The candidate lists for choosePicks, read from the catalogue. */
export async function pickLists(db: D1Database, t = now(), freeOrder = 'p.recent DESC, p.plays DESC', newShelf = true): Promise<PickLists> {
  const today = dayOf(t), LIVE = liveWhere(newShelf);
  const q = (sql: string, ...a: unknown[]) => db.prepare(sql).bind(...a).all<PickCandidate>().then((r) => r.results);
  const [featured, trending, fresh, rated, free] = await Promise.all([
    q(`SELECT ${COLS} FROM projects p WHERE ${LIVE} AND p.featured = 1 ORDER BY p.recent DESC LIMIT 6`),
    q(`SELECT ${COLS} FROM projects p WHERE ${LIVE} ORDER BY p.recent DESC, p.plays DESC LIMIT 60`),
    q(`SELECT ${COLS} FROM projects p WHERE ${LIVE} AND p.published_at > ? ORDER BY p.recent DESC, p.published_at DESC LIMIT 20`, t - 14 * 86400000),
    q(`SELECT ${COLS} FROM projects p WHERE ${LIVE} AND p.rating_count >= 3 ORDER BY ${BAYES('p.')} DESC, p.rating_count DESC LIMIT 30`),
    q(`SELECT ${COLS} FROM projects p WHERE ${LIVE} AND p.price_cents = 0 ORDER BY ${freeOrder} LIMIT 20`),
  ]);
  const ids = [...new Set([...trending, ...fresh].map((g) => g.id))];
  if (ids.length) {
    const from3 = addDays(today, -2), from10 = addDays(today, -9);
    const rows = await db.prepare(`SELECT project_id, COALESCE(SUM(CASE WHEN day >= ?1 THEN plays * 4 + seconds / 60 END), 0) AS last3,
        COALESCE(SUM(CASE WHEN day < ?1 THEN plays * 4 + seconds / 60 END), 0) AS prior7
      FROM game_daily WHERE day >= ?2 AND project_id IN (SELECT value FROM json_each(?3)) GROUP BY project_id`).bind(from3, from10, JSON.stringify(ids)).all<{ project_id: string; last3: number; prior7: number }>();
    const act = new Map(rows.results.map((r) => [r.project_id, r]));
    for (const g of [...trending, ...fresh]) { const a = act.get(g.id); g.last3 = a?.last3 || 0; g.prior7 = a?.prior7 || 0; }
  }
  return { featured, trending, fresh, rated, free };
}

/**
 * Today's picks, chosen once per UTC day: a no-op when today's are already there (runs every 10 minutes, so the lead
 * changes within minutes of midnight UTC and a fresh deploy fills it at once). Returns how many were chosen.
 */
export async function ensurePicks(env: Env, t = now()): Promise<number> {
  const db = env.DB, day = dayOf(t);
  if (await db.prepare('SELECT 1 FROM daily_picks WHERE day = ? LIMIT 1').bind(day).first()) return 0;
  const [lists, recent] = await Promise.all([
    Promise.all([freePickOrder(env), getSettings(env)]).then(([o, s]) => pickLists(db, t, o, s.new_shelf !== false)),
    db.prepare("SELECT DISTINCT project_id FROM daily_picks WHERE day >= ? AND day < ? AND reason != 'featured'").bind(addDays(day, -REPEAT_DAYS), day).all<{ project_id: string }>(),
  ]);
  const picks = choosePicks(lists, new Set(recent.results.map((r) => r.project_id)), day);
  if (!picks.length) return 0;
  // one batch is one transaction: if two runs race, the first one's picks stand and the other's are all ignored
  await db.batch(picks.map((p, slot) => db.prepare('INSERT OR IGNORE INTO daily_picks (day, slot, project_id, reason) VALUES (?, ?, ?, ?)').bind(day, slot, p.id, p.reason)));
  return picks.length;
}

/** Picks older than KEEP_PICKS_DAYS (daily cleanup). */
export const oldPicksStmt = (db: D1Database, t = now()) => db.prepare('DELETE FROM daily_picks WHERE day < ?').bind(addDays(dayOf(t), -KEEP_PICKS_DAYS));

/** The latest day's picks that are still live, in page order, with the card columns (the home page). */
export async function currentPicks(db: D1Database, t = now()) {
  const rows = await db.prepare(`SELECT p.*, u.name AS author, dp.reason AS pick FROM daily_picks dp JOIN projects p ON p.id = dp.project_id JOIN users u ON u.id = p.owner_id
    WHERE dp.day = (SELECT MAX(day) FROM daily_picks WHERE day <= ?) AND p.status = 'live' AND p.mature = '' AND p.hidden_at IS NULL ORDER BY dp.slot`).bind(dayOf(t)).all<Record<string, any>>();
  return rows.results;
}

// ---- job bookkeeping -----------------------------------------------------------------------------
/** Runs one scheduled job and records when it last ran and whether it worked (shown in the admin overview). Never throws. */
export async function runJob(env: Env, job: string, fn: () => Promise<unknown>): Promise<void> {
  const t = now();
  let error: string | null = null;
  try { await fn(); } catch (e) { error = String((e as Error)?.message || e).slice(0, 300); console.error(`${job} failed`, e); }
  await env.DB.prepare(`INSERT INTO job_runs (job, last_run_at, last_ok_at, last_error, last_error_at, runs) VALUES (?1, ?2, ?3, ?4, ?5, 1)
    ON CONFLICT(job) DO UPDATE SET last_run_at = ?2, last_ok_at = COALESCE(?3, last_ok_at), last_error = COALESCE(?4, last_error), last_error_at = COALESCE(?5, last_error_at), runs = runs + 1`)
    .bind(job, t, error ? null : t, error, error ? t : null).run().catch((e) => console.error('job bookkeeping failed', e));
}

/** Every job the schedule runs, with how often (minutes) and what it does, for the admin overview. */
export const JOBS: { job: string; every: number; what: string }[] = [
  { job: 'playing', every: 1, what: 'Playing now counts' },
  { job: 'engagement', every: 10, what: 'Engagement numbers and New shelf graduation' },
  { job: 'trending', every: 10, what: 'Trending scores' },
  { job: 'picks', every: 10, what: 'Today\'s picks (chosen once a day)' },
  { job: 'transfers', every: 10, what: 'Stripe transfer retries' },
  { job: 'rollout', every: 10, what: 'Game runtime rollout' },
  { job: 'mature', every: 10, what: 'Age rating backfill' },
  { job: 'payouts', every: 1440, what: 'Automatic payouts' },
  { job: 'cleanup', every: 1440, what: 'Expired data cleanup' },
  { job: 'fingerprints', every: 1440, what: 'Originality fingerprint backfill' },
];

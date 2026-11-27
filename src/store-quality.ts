// Store quality: what keeps low-effort games from flooding the store, without blocking honest creators.
//
//   playability     a platform requirement checked by the verifier (src/verify-core.js, playability): the game reacts to
//                   input and keeps running through bot play. A version that fails one does not go live
//                   (src/release-gate.ts, "verified"). A score or an ending is optional (sandbox, idle, creative and
//                   exploration games have neither): a live version that reports one (GCP.score, GCP.gameOver,
//                   GCP.leaderboard.submit) gets a small ranking lift, OUTCOME_LIFT (projects.eng_outcome).
//   weekly cap      a creator can put a few new games live in any 7 days (publish_cap_base), more for each of their
//                   well-rated live games, up to publish_cap_max. Updates to games already live are never limited.
//                   Checked by the release gate (rule publish_cap); an admin can waive it for one version.
//   New shelf       every new game starts on the New shelf (projects.shelf = 'new'). The main store's lists, shelves,
//                   picks and genre pages show only games on the main shelf; search, a creator's page and the New shelf
//                   show both. A game moves to the main store by itself once players stick with it (graduate below).
//                   Games published before this existed were grandfathered onto the main store (migration 0044).
//   ranking         the trending score (src/rankings.ts) weighs play time and how players stick with a game
//                   (engagementFactor), so low-effort games sink.
//   reports         players who played a game can report it (broken, low effort, …). Enough reports from different
//                   players hide it from the store; it stays playable by link and comes back by itself when a new
//                   version goes live (reviveStmts). Admin review (Admin, Reports) is optional, never needed to move on.
//   self-tuning     the ranking's engagement scales follow what is typical in the store (tuneStmts), every 10 minutes.
//
// Every number comes from what the platform measures (player_games, src/play-clock.ts) and from player ratings.
import type { Env, Project } from './env';
import type { Settings } from './settings';
import { logEvent } from './projects';
import { now } from './util';
import { PRIOR_MEAN, PRIOR_N } from './rankings';

const DAY = 86400000, WEEK = 7 * DAY;
const bayes = (p = '') => `((${p}rating_sum + ${PRIOR_MEAN * PRIOR_N}) * 1.0 / (${p}rating_count + ${PRIOR_N}))`;
type S = Pick<Settings, 'publish_cap_base' | 'publish_cap_per_good' | 'publish_cap_max' | 'good_game_min_ratings' | 'good_game_min_rating'>;

// ---- weekly cap on new games ---------------------------------------------------------------------------------------
export interface Cap { limited: boolean; used: number; cap: number; good: number; next_at: number | null }

/** Pure: the cap from the settings and how many well-rated live games the creator has. */
export function capFor(s: S, good: number): number {
  const base = Math.max(0, Math.round(Number(s.publish_cap_base) || 0));
  if (!base) return Infinity;
  const per = Math.max(0, Math.round(Number(s.publish_cap_per_good) || 0)), max = Math.max(base, Math.round(Number(s.publish_cap_max) || base));
  return Math.min(max, base + per * Math.max(0, good));
}

/** How many new games the creator put live in the last 7 days against their cap. `except` is the game being published. */
export async function publishCap(env: Env, s: S, ownerId: string, except = '', t = now()): Promise<Cap> {
  const [recent, good] = await Promise.all([
    env.DB.prepare('SELECT published_at FROM projects WHERE owner_id = ? AND published_at > ? AND id != ? ORDER BY published_at').bind(ownerId, t - WEEK, except).all<{ published_at: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM projects WHERE owner_id = ? AND status = 'live' AND rating_count >= ? AND ${bayes()} >= ?`).bind(ownerId, Math.max(1, Number(s.good_game_min_ratings) || 1), Number(s.good_game_min_rating) || 0).first<{ n: number }>(),
  ]);
  const used = recent.results.length, cap = capFor(s, good?.n || 0), limited = Number.isFinite(cap);
  // the next slot opens when the oldest release that is still inside the window drops out of it
  const next = limited && used >= cap ? recent.results[used - cap].published_at + WEEK : null;
  return { limited, used, cap: limited ? cap : 0, good: good?.n || 0, next_at: next };
}

/** The release gate's refusal for a new game over the cap, or null. Admins and games that were live before are never capped. */
export async function capGate(env: Env, s: S, p: Pick<Project, 'id' | 'owner_id' | 'published_at'>, ownerRole: string | undefined, t = now()): Promise<{ reason: string; fix: string } | null> {
  if (p.published_at || ownerRole === 'admin') return null;
  const c = await publishCap(env, s, p.owner_id, p.id, t);
  if (!c.limited || c.used < c.cap) return null;
  const when = c.next_at ? new Date(c.next_at).toISOString().replace(/:\d\d\.\d+Z$/, ' UTC').replace('T', ' ') : 'in a few days';
  return {
    reason: `This would be a new game, and this account already put ${c.used} new game${c.used === 1 ? '' : 's'} live in the last 7 days: its cap is ${c.cap} a week (${s.publish_cap_base} for every creator, plus ${s.publish_cap_per_good} for each well-rated live game; it has ${c.good}).`,
    fix: `Publish it after ${when}, when a slot opens. Meanwhile keep improving it in preview. Updates to games that are already live are not limited. The cap grows by ${s.publish_cap_per_good} for each live game with at least ${s.good_game_min_ratings} ratings averaging ${s.good_game_min_rating} stars or more (up to ${s.publish_cap_max} a week).`,
  };
}

// ---- engagement: how players stick with a game ---------------------------------------------------------------------
/** Players below this give no engagement signal yet: the ranking treats the game as neutral. */
export const ENGAGEMENT_MIN_PLAYERS = 5;
/** Neutral factor for games with too few players to judge. A little under a typical engaged game, so unknown games do not
 *  outrank ones players proved, and a little over a game players leave. */
export const NEUTRAL_FACTOR = 0.8;

/**
 * The ranking tunes itself to the store. Time per player and returning players are judged against what is typical on
 * this platform right now, not fixed numbers: a game whose players stay twice as long as the typical game's gets the
 * full lift. The schedule works the scales out from every live game with enough players (tuneStmts) and keeps them in
 * store_tuning; until TUNE_MIN_GAMES games have enough players the defaults below apply.
 */
export const TUNE_MIN_GAMES = 10;
export const DEFAULT_TIME_SCALE_S = 600, DEFAULT_RETURN_SCALE = 100;
const TIME_SCALE = `COALESCE((SELECT value FROM store_tuning WHERE key = 'time_scale_s'), ${DEFAULT_TIME_SCALE_S}.0)`;
const RETURN_SCALE = `COALESCE((SELECT value FROM store_tuning WHERE key = 'return_scale'), ${DEFAULT_RETURN_SCALE}.0)`;

/**
 * The engagement factor the trending score is multiplied by, as SQL over projects aliased `a` (0.25 to 1.5): time per
 * player (full lift at the store's time scale) and the share of players who came back another day (full lift at the
 * return scale) lift it; players who leave within their first minute and never come back pull it down.
 */
export function engagementFactor(a = 'p'): string {
  return `(CASE WHEN ${a}.eng_players >= ${ENGAGEMENT_MIN_PLAYERS} THEN (0.5 + 0.5 * MIN(1.0, ${a}.eng_avg_s * 1.0 / ${TIME_SCALE}) + 0.5 * MIN(1.0, ${a}.eng_return * 1.0 / ${RETURN_SCALE})) * (1.0 - 0.5 * ${a}.eng_quit / 100.0) ELSE ${NEUTRAL_FACTOR} END)`;
}
/** A live version that reports a score or an ending ranks this much higher (optional; never required). */
export const OUTCOME_LIFT = 0.05;
/** The trending lift for a score or an ending (an SQL fragment over projects a). */
export function outcomeFactor(a = 'p'): string { return `(1.0 + ${OUTCOME_LIFT} * ${a}.eng_outcome)`; }
/** 1 when a verification report shows a score or an ending (its score_or_end check passed without the advice flag). */
export function outcomeOf(report: string | null | undefined): number {
  try { const c = (JSON.parse(report || '{}').checks || []).find((x: { id: string }) => x.id === 'score_or_end'); return c && c.ok && !c.soft ? 1 : 0; } catch { return 0; }
}
/** The same in JavaScript (tests, the console). */
export function engagementOf(g: { eng_players: number; eng_avg_s: number; eng_return: number; eng_quit: number }, scale = { time_s: DEFAULT_TIME_SCALE_S, ret: DEFAULT_RETURN_SCALE }): number {
  if (g.eng_players < ENGAGEMENT_MIN_PLAYERS) return NEUTRAL_FACTOR;
  return (0.5 + 0.5 * Math.min(1, g.eng_avg_s / scale.time_s) + 0.5 * Math.min(1, g.eng_return / scale.ret)) * (1 - 0.5 * g.eng_quit / 100);
}

/**
 * Re-tunes the ranking from the whole store (runs after engagementStmt): the scales become twice the median time per
 * player (2 to 30 minutes) and twice the median share of returning players (10 to 100 percent), over live games with
 * enough players. Nothing changes until TUNE_MIN_GAMES games qualify, so a small store keeps the defaults.
 */
export function tuneStmts(db: D1Database, t = now()): D1PreparedStatement[] {
  const median = (col: string) => `(SELECT ${col} FROM projects WHERE status = 'live' AND eng_players >= ${ENGAGEMENT_MIN_PLAYERS} ORDER BY ${col} LIMIT 1 OFFSET (SELECT COUNT(*) / 2 FROM projects WHERE status = 'live' AND eng_players >= ${ENGAGEMENT_MIN_PLAYERS}))`;
  const enough = `(SELECT COUNT(*) FROM projects WHERE status = 'live' AND eng_players >= ${ENGAGEMENT_MIN_PLAYERS})`;
  const put = (key: string, expr: string) => db.prepare(`INSERT INTO store_tuning (key, value, games, updated_at) SELECT ?1, ${expr}, ${enough}, ?2 WHERE ${enough} >= ${TUNE_MIN_GAMES}
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, games = excluded.games, updated_at = excluded.updated_at`).bind(key, t);
  return [
    put('time_scale_s', `MIN(1800, MAX(120, 2 * ${median('eng_avg_s')}))`),
    put('return_scale', `MIN(100, MAX(10, 2 * ${median('eng_return')}))`),
  ];
}

/**
 * A game hidden by player reports comes back by itself when a new version goes live: that version passed every
 * platform requirement again, including the playability checks, and the reports were about an older one (they are
 * closed as superseded; if players report the new version enough, it is hidden again). No admin has to act. A game an
 * admin hid stays hidden. Runs in the same batch that switches the live version (src/go-live.ts).
 */
export function reviveStmts(db: D1Database, pid: string, n: number, t = now()): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO events (project_id, kind, detail, version, actor, created_at) SELECT ?1, 'reports_superseded', 'A new version went live: the reports about the older one are closed and the game is back in the store.', ?2, 'system', ?3
      WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?1 AND hidden_reason = 'reports')`).bind(pid, n, t),
    db.prepare("UPDATE game_reports SET status = 'superseded', resolved_at = ?3, resolved_by = 'system' WHERE project_id = ?1 AND status = 'open' AND COALESCE(version, -1) != ?2").bind(pid, n, t),
    db.prepare("UPDATE projects SET hidden_at = NULL, hidden_reason = NULL WHERE id = ?1 AND hidden_reason = 'reports'").bind(pid),
  ];
}

/** A player "came back" when their last session is at least this long after their first. */
const RETURN_GAP_MS = 20 * 3600 * 1000;

/**
 * Refreshes the engagement numbers of live games played since yesterday, and of every game still on the New shelf
 * (runs every 10 minutes, before the trending score). Players are counted from player_games, the creator excluded.
 */
export function engagementStmt(db: D1Database, t = now()): D1PreparedStatement {
  const since = new Date(t - DAY).toISOString().slice(0, 10);
  return db.prepare(`UPDATE projects SET eng_players = a.n, eng_avg_s = a.avg_s, eng_quit = a.quit, eng_return = a.ret, eng_at = ?1 FROM (
      SELECT pg.project_id AS id, COUNT(*) AS n, CAST(AVG(pg.seconds) AS INTEGER) AS avg_s,
        CAST(ROUND(100.0 * SUM(CASE WHEN pg.seconds < 60 AND pg.sessions <= 1 THEN 1 ELSE 0 END) / COUNT(*)) AS INTEGER) AS quit,
        CAST(ROUND(100.0 * SUM(CASE WHEN pg.sessions >= 2 AND pg.last_at - pg.first_at >= ${RETURN_GAP_MS} THEN 1 ELSE 0 END) / COUNT(*)) AS INTEGER) AS ret
      FROM player_games pg JOIN projects p ON p.id = pg.project_id
      WHERE p.status = 'live' AND pg.user_id != p.owner_id
        AND (p.shelf = 'new' OR pg.project_id IN (SELECT DISTINCT project_id FROM game_daily WHERE day >= ?2))
      GROUP BY pg.project_id
    ) AS a WHERE projects.id = a.id`).bind(t, since);
}

// ---- the New shelf -------------------------------------------------------------------------------------------------
type G = Pick<Settings, 'graduate_min_players' | 'graduate_min_minutes' | 'graduate_max_quit_percent' | 'graduate_min_ratings' | 'graduate_min_rating'>;
export interface Progress { players: number; avg_minutes: number; quit_percent: number; ratings: number; rating: number }
export type NeedId = 'players' | 'minutes' | 'quit' | 'ratings' | 'rating';
/** One condition: what the game has (have) against what it needs (need; at most for quit, at least for the rest). */
export interface Need { id: NeedId; have: number; need: number; ok: boolean }
export interface Graduation { ready: boolean; needs: Need[] }
const NEED_TEXT: Record<NeedId, (n: Need) => string> = {
  players: (n) => `players other than you at least ${n.need} (now ${n.have})`,
  minutes: (n) => `average play time per player at least ${n.need} min (now ${n.have} min)`,
  quit: (n) => `players who left within a minute and never came back at most ${n.need}% (now ${n.have}%)`,
  ratings: (n) => `ratings at least ${n.need} (now ${n.have})`,
  rating: (n) => `average rating at least ${n.need} (now ${n.have})`,
};
export const needText = (n: Need) => NEED_TEXT[n.id](n);

/** Pure: what a game on the New shelf still needs to reach the main store. */
export function graduation(s: G, g: { eng_players: number; eng_avg_s: number; eng_quit: number; rating_sum: number; rating_count: number }): Graduation {
  const rating = (g.rating_sum + PRIOR_MEAN * PRIOR_N) / (g.rating_count + PRIOR_N), mins = g.eng_avg_s / 60;
  const needs: Need[] = [
    { id: 'players', have: g.eng_players, need: s.graduate_min_players, ok: g.eng_players >= s.graduate_min_players },
    { id: 'minutes', have: Math.round(mins * 10) / 10, need: Number(s.graduate_min_minutes), ok: mins >= Number(s.graduate_min_minutes) },
    { id: 'quit', have: g.eng_quit, need: s.graduate_max_quit_percent, ok: g.eng_players > 0 && g.eng_quit <= s.graduate_max_quit_percent },
    { id: 'ratings', have: g.rating_count, need: s.graduate_min_ratings, ok: g.rating_count >= s.graduate_min_ratings },
    { id: 'rating', have: Math.round(rating * 100) / 100, need: Number(s.graduate_min_rating), ok: rating >= Number(s.graduate_min_rating) },
  ];
  return { ready: needs.every((n) => n.ok), needs };
}

/** Moves every game on the New shelf that players stuck with to the main store (runs after engagementStmt). Returns them. */
export async function graduate(env: Env, s: G & Pick<Settings, 'new_shelf'>, t = now()): Promise<string[]> {
  const r = await env.DB.prepare(`UPDATE projects SET shelf = 'main', shelf_at = ?1 WHERE status = 'live' AND shelf = 'new'
      AND eng_players >= ?2 AND eng_avg_s >= ?3 AND eng_players > 0 AND eng_quit <= ?4 AND rating_count >= ?5 AND ${bayes()} >= ?6 RETURNING id`)
    .bind(t, s.graduate_min_players, Math.round(Number(s.graduate_min_minutes) * 60), s.graduate_max_quit_percent, s.graduate_min_ratings, Number(s.graduate_min_rating)).all<{ id: string }>();
  for (const g of r.results) await logEvent(env, g.id, 'graduated', 'Players stuck with it: it moved from the New shelf to the main store.', null, 'system');
  return r.results.map((g) => g.id);
}

/**
 * The WHERE part every store list uses for a shelf, over projects aliased `a`. Hidden games are never listed.
 * shelf: 'main' (the main store), 'new' (the New shelf) or 'all' (search, a creator's page). With the New shelf turned
 * off every live game is on the main store and the New shelf is empty.
 */
export function shelfWhere(shelf: 'main' | 'new' | 'all', on: boolean, a = 'p'): string {
  const visible = `${a}.hidden_at IS NULL`;
  if (shelf === 'all' || (!on && shelf === 'main')) return visible;
  if (!on) return '0';
  return `${visible} AND ${a}.shelf = '${shelf === 'new' ? 'new' : 'main'}'`;
}

// ---- player reports ------------------------------------------------------------------------------------------------
export const REPORT_REASONS = ['broken', 'low_effort', 'phishing', 'malicious', 'stolen', 'offensive', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
type R = Pick<Settings, 'report_hide_min' | 'report_hide_percent' | 'report_hide_max'>;

/** Pure: how many open reports from different players hide a game with this many players (Infinity: never). */
export function hideThreshold(s: R, players: number): number {
  const min = Math.max(0, Math.round(Number(s.report_hide_min) || 0));
  if (!min) return Infinity;
  const max = Math.max(min, Math.round(Number(s.report_hide_max) || min));
  return Math.min(max, Math.max(min, Math.ceil(Math.max(0, players) * Math.max(0, Number(s.report_hide_percent) || 0) / 100)));
}

export interface ReportOutcome { ok: true; open: number; threshold: number | null; hidden: boolean }

/**
 * A player's report. Only players who opened the live game can report it, once each (a new report replaces their open
 * one; after an admin dismissed theirs, they can report again once a newer version is live). Hides the game when the
 * open reports reach the threshold.
 */
export async function fileReport(env: Env, s: R, p: Project, userId: string, reason: ReportReason, detail: string, t = now()): Promise<ReportOutcome> {
  await env.DB.prepare(`INSERT INTO game_reports (project_id, user_id, reason, detail, version, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6)
    ON CONFLICT(project_id, user_id) DO UPDATE SET reason = excluded.reason, detail = excluded.detail, created_at = excluded.created_at,
      status = CASE WHEN game_reports.status = 'open' OR COALESCE(game_reports.version, -1) != COALESCE(excluded.version, -1) THEN 'open' ELSE game_reports.status END,
      version = excluded.version, resolved_at = CASE WHEN game_reports.status = 'open' OR COALESCE(game_reports.version, -1) != COALESCE(excluded.version, -1) THEN NULL ELSE game_reports.resolved_at END`)
    .bind(p.id, userId, reason, detail, p.live_version, t).run();
  return { ok: true, ...(await autoHide(env, s, p, t)) };
}

/** Hides the game once enough different players reported it. Returns the open count and the threshold. */
export async function autoHide(env: Env, s: R, p: Pick<Project, 'id' | 'owner_id' | 'live_version'> & { hidden_at?: number | null }, t = now()): Promise<{ open: number; threshold: number | null; hidden: boolean }> {
  const row = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM game_reports WHERE project_id = ?1 AND status = 'open') AS open,
      (SELECT COUNT(*) FROM player_games WHERE project_id = ?1 AND user_id != ?2) AS players, (SELECT hidden_at FROM projects WHERE id = ?1) AS hidden_at`).bind(p.id, p.owner_id).first<{ open: number; players: number; hidden_at: number | null }>();
  const open = row?.open || 0, th = hideThreshold(s, row?.players || 0);
  if (row?.hidden_at) return { open, threshold: Number.isFinite(th) ? th : null, hidden: true };
  if (open < th) return { open, threshold: Number.isFinite(th) ? th : null, hidden: false };
  const r = await env.DB.prepare("UPDATE projects SET hidden_at = ?, hidden_reason = 'reports' WHERE id = ? AND hidden_at IS NULL").bind(t, p.id).run();
  if (r.meta.changes) await logEvent(env, p.id, 'auto_hidden', `Hidden from the store: ${open} players reported it. It stays playable by its link, and comes back by itself when a new version goes live (or when a platform admin reviews the reports).`, p.live_version ?? null, 'system');
  return { open, threshold: th, hidden: true };
}

export type ReviewAction = 'dismiss' | 'hide' | 'unhide';
/**
 * An admin's decision on a reported (or hidden) game. dismiss: nothing wrong, the open reports are closed and the game is
 * back in the store. hide: it stays out of the store (reports upheld). unhide: back in the store, reports left open.
 * Taking a game offline or removing it is done with the game's other admin actions.
 */
export async function reviewReports(env: Env, adminId: string, p: Pick<Project, 'id' | 'live_version'>, action: ReviewAction, t = now()): Promise<void> {
  const db = env.DB;
  if (action === 'dismiss') await db.batch([
    db.prepare("UPDATE game_reports SET status = 'dismissed', resolved_at = ?, resolved_by = ? WHERE project_id = ? AND status = 'open'").bind(t, adminId, p.id),
    db.prepare('UPDATE projects SET hidden_at = NULL, hidden_reason = NULL WHERE id = ?').bind(p.id),
  ]);
  else if (action === 'hide') await db.batch([
    db.prepare("UPDATE game_reports SET status = 'upheld', resolved_at = ?, resolved_by = ? WHERE project_id = ? AND status = 'open'").bind(t, adminId, p.id),
    db.prepare("UPDATE projects SET hidden_at = COALESCE(hidden_at, ?), hidden_reason = 'admin' WHERE id = ?").bind(t, p.id),
  ]);
  else await db.prepare('UPDATE projects SET hidden_at = NULL, hidden_reason = NULL WHERE id = ?').bind(p.id).run();
  const what = action === 'dismiss' ? 'Reports reviewed and dismissed: the game is back in the store.' : action === 'hide' ? 'Reports upheld: the game stays hidden from the store. Fix what players reported and contact the platform.' : 'Back in the store (an admin lifted the hiding).';
  await logEvent(env, p.id, 'reports_' + action, what, p.live_version ?? null, 'admin:' + adminId);
}

/** Paginated admin queue: games with open reports or hidden from the store, most reported first, with total count. */
export async function reportQueuePage(env: Env, s: R, opts?: { limit?: number; offset?: number }) {
  const lim = Math.max(1, Math.min(100, Math.floor(opts?.limit ?? 100))), off = Math.max(0, Math.floor(opts?.offset ?? 0));
  const where = "p.hidden_at IS NOT NULL OR p.id IN (SELECT project_id FROM game_reports WHERE status = 'open')";
  const [games, tot] = await Promise.all([
    env.DB.prepare(`SELECT p.id, p.slug, p.title, p.status, p.shelf, p.hidden_at, p.hidden_reason, p.live_version, u.email, u.name AS author,
        (SELECT COUNT(*) FROM game_reports r WHERE r.project_id = p.id AND r.status = 'open') AS open,
        (SELECT COUNT(*) FROM player_games pg WHERE pg.project_id = p.id AND pg.user_id != p.owner_id) AS players
      FROM projects p JOIN users u ON u.id = p.owner_id
      WHERE ${where}
      ORDER BY p.hidden_at IS NULL, open DESC LIMIT ?1 OFFSET ?2`).bind(lim, off).all<Record<string, any>>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM projects p WHERE ${where}`).first<{ n: number }>(),
  ]);
  const ids = games.results.map((g) => g.id);
  const reports = ids.length ? (await env.DB.prepare(`SELECT r.project_id, r.reason, r.detail, r.version, r.created_at, COALESCE(u.name, 'a player') AS name FROM game_reports r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.status = 'open' AND r.project_id IN (SELECT value FROM json_each(?)) ORDER BY r.created_at DESC LIMIT 1000`).bind(JSON.stringify(ids)).all<Record<string, any>>()).results : [];
  return {
    total: tot?.n || 0,
    games: games.results.map((g) => {
      const mine = reports.filter((r) => r.project_id === g.id), th = hideThreshold(s, g.players);
      const reasons: Record<string, number> = {};
      for (const r of mine) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
      return { ...g, threshold: Number.isFinite(th) ? th : null, reasons, reports: mine.slice(0, 10).map(({ project_id, ...r }) => r) };
    }),
  };
}

/** The admin queue: games with open reports or hidden from the store, most reported first, with the latest reports. */
export async function reportQueue(env: Env, s: R) {
  return (await reportQueuePage(env, s, { limit: 100, offset: 0 })).games;
}

// ---- what the creator sees -----------------------------------------------------------------------------------------
type All = S & G & R & Pick<Settings, 'new_shelf'>;
export interface StoreStatus {
  shelf: 'new' | 'main'; new_shelf_on: boolean;
  graduation: Graduation | null;
  hidden: { at: number; reason: string } | null;
  reports_open: number;
  new_game_cap: Cap | null;
}
/** Where the game stands in the store, for the console and the agent tools. */
export async function storeStatus(env: Env, s: All, p: Project): Promise<StoreStatus> {
  const q = p as Project & { shelf?: string; hidden_at?: number | null; hidden_reason?: string | null; eng_players?: number; eng_avg_s?: number; eng_quit?: number };
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM game_reports WHERE project_id = ? AND status = 'open'").bind(p.id).first<{ n: number }>();
  const shelf = q.shelf === 'main' ? 'main' : 'new', on = s.new_shelf !== false;
  return {
    shelf, new_shelf_on: on,
    graduation: on && shelf === 'new' ? graduation(s, { eng_players: q.eng_players || 0, eng_avg_s: q.eng_avg_s || 0, eng_quit: q.eng_quit || 0, rating_sum: p.rating_sum, rating_count: p.rating_count }) : null,
    hidden: q.hidden_at ? { at: q.hidden_at, reason: q.hidden_reason || 'admin' } : null,
    reports_open: open?.n || 0,
    new_game_cap: p.published_at ? null : await publishCap(env, s, p.owner_id, p.id),
  };
}
/** The same as one paragraph for an agent. */
export function storeText(st: StoreStatus, live: boolean): string {
  const parts: string[] = [];
  if (st.hidden) parts.push(`Hidden from the store since ${new Date(st.hidden.at).toISOString().slice(0, 10)} (${st.hidden.reason === 'reports' ? 'player reports reached the threshold' : 'by a platform admin'}); it stays playable by its link. Fix what players reported and publish a new version: the game comes back by itself when it goes live.`);
  if (!st.new_shelf_on) parts.push(live ? 'It is on the main store.' : 'Once live it is on the main store.');
  else if (st.shelf === 'main') parts.push('It is on the main store.');
  else {
    const left = st.graduation ? st.graduation.needs.filter((n) => !n.ok) : [];
    parts.push(`${live ? 'It is on the New shelf' : 'Once live it starts on the New shelf'}: the main store's lists, shelves and picks show it once players stick with it.${left.length ? ` Still needed: ${left.map(needText).join('; ')}.` : live ? ' It meets every condition and moves within 10 minutes.' : ''}`);
  }
  if (st.reports_open) parts.push(`${st.reports_open} open player report${st.reports_open === 1 ? '' : 's'}.`);
  if (st.new_game_cap && st.new_game_cap.limited) parts.push(`New games this account put live in the last 7 days: ${st.new_game_cap.used} of ${st.new_game_cap.cap}${st.new_game_cap.next_at ? `; the next slot opens ${new Date(st.new_game_cap.next_at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}.`);
  return parts.join(' ');
}

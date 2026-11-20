// The platform's own play clock. Every play number the platform shows (sessions, counted plays, play time, players
// online, a player's play record, the trending order, free-trial time and the play time that decides self-serve refunds)
// is measured here, from things only the platform can observe:
//   - the server time a play session started (POST /api/games/:slug/play, before the game has loaded);
//   - check-ins from the page that shows the game (the store page or the console preview), which runs on the platform's
//     own origin and is authenticated by the player's sign-in cookie. A game runs on another origin, in a frame, and
//     cannot send these: the cookie is SameSite=Lax and cookie-carrying mutations from another origin are refused;
//   - the server's clock at each check-in.
// What a game says about itself (heartbeats, "active" flags, frame counts, its own service calls) never moves these
// numbers. The game's heartbeat still reports whether it started (GCP.ready) and the errors it hit, which the creator's
// analytics show apart, as reported by the game.
import type { Env } from './env';
import type { Settings } from './settings';
import { dayOf } from './util';
import { trialOpenStmts } from './trials';
// @ts-ignore plain JS module
import { playRecordStmt, scopeOf } from './player-data.js';

/** How often the page showing a game checks in while the game is open. */
export const CHECKIN_MS = 30_000;
/** One check-in never credits more than this, however long since the last one (the tab was throttled, the computer slept). */
export const MAX_CREDIT_MS = 60_000;
/** Check-ins closer together than this are ignored (a double send). */
export const MIN_GAP_MS = 2_000;
/** A player adds at most one counted play per game in this time, however many sessions they open. */
export const COUNT_EVERY_MS = 3600_000;
/** Sessions older than this no longer take check-ins (a play token lasts six hours and is renewed; this leaves room). */
export const MAX_SESSION_MS = 12 * 3600_000;

export interface PlayRow {
  id: string; project_id: string; version: number; env: string; user_id: string; kind: string;
  started_at: number; seen_at: number | null; seconds: number; counted: number;
  trial: number; trial_seconds: number; trial_until: number | null;
}

/**
 * Seconds of play one check-in credits: the time the page says the game was on screen since its last check-in, never
 * more than the server's own clock says has passed since then, and never more than MAX_CREDIT_MS.
 */
export function creditSeconds(prevAt: number, t: number, visibleMs: unknown): number {
  const elapsed = Math.max(0, t - prevAt), v = Number(visibleMs);
  const ms = Number.isFinite(v) ? Math.max(0, Math.min(v, elapsed, MAX_CREDIT_MS)) : 0;
  return Math.round(ms / 1000);
}

/** Wall-clock seconds a session has been open, by the platform's timestamps only: start to the page's last check-in. */
export const openSeconds = (p: Pick<PlayRow, 'started_at' | 'seen_at'>) => Math.max(0, Math.round(((p.seen_at ?? p.started_at) - p.started_at) / 1000));

export type CheckinResult = { ok: true; counted: boolean; seconds: number } | { ok: false; reason: 'unknown' | 'too_soon' | 'too_old' };

/**
 * A check-in from the page showing the game. Moves the session's clock (seen_at), credits play time, counts the play once
 * it passes the minimum, and keeps the daily totals, the game's totals and the player's own record. `player` is the
 * account (or guest) the page is signed in as: a session can only be checked in by the identity it was started for.
 */
export async function checkIn(env: Env, s: Pick<Settings, 'play_min_seconds'>, sessionId: string, player: string, visibleMs: unknown, t: number): Promise<CheckinResult> {
  const db = env.DB;
  const play = await db.prepare('SELECT id, project_id, version, env, user_id, kind, started_at, seen_at, seconds, counted, trial, trial_seconds, trial_until FROM plays WHERE id = ? AND user_id = ?').bind(sessionId, player).first<PlayRow>();
  if (!play || play.kind === 'verify') return { ok: false, reason: 'unknown' };
  if (t - play.started_at > MAX_SESSION_MS) return { ok: false, reason: 'too_old' };
  const prev = play.seen_at ?? play.started_at;
  if (play.seen_at !== null && t - prev < MIN_GAP_MS) return { ok: false, reason: 'too_soon' };
  // The player has one clock per game: time already credited to another of their sessions open at the same moment
  // (another tab, another device, a script opening many) is not credited again.
  const scope = scopeOf(play.project_id, play.env);
  const clock = (await db.prepare('SELECT clock_at FROM player_games WHERE project_id = ? AND user_id = ?').bind(scope, player).first<{ clock_at: number | null }>())?.clock_at ?? 0;
  let add = creditSeconds(Math.max(prev, clock), t, visibleMs);
  if (add) {
    // claimed only from the value read above, so two sessions racing each other credit the same moment once
    const claimed = await db.prepare(`INSERT INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds, last_version, clock_at) VALUES (?1, ?2, ?3, ?3, 0, 0, ?4, ?3)
      ON CONFLICT(project_id, user_id) DO UPDATE SET clock_at = ?3 WHERE COALESCE(player_games.clock_at, 0) = ?5 RETURNING clock_at`).bind(scope, player, t, play.version, clock).first();
    if (!claimed) add = 0;
  }
  const total = play.seconds + add;
  const counts = play.kind === 'player' && play.env === 'live';
  // A session counts as a play once it reaches the minimum, and a player adds at most one play per game an hour.
  const becameCounted = counts && !play.counted && total >= s.play_min_seconds
    && !(await db.prepare("SELECT 1 FROM plays WHERE user_id = ? AND project_id = ? AND env = 'live' AND counted_at > ? LIMIT 1").bind(player, play.project_id, t - COUNT_EVERY_MS).first());
  // Moved only from the clock value read above, so two check-ins of one session racing each other credit the time once.
  const moved = await db.prepare('UPDATE plays SET seen_at = ?1, seconds = seconds + ?2, counted = CASE WHEN ?3 THEN 1 ELSE counted END, counted_at = CASE WHEN ?3 THEN ?1 ELSE counted_at END WHERE id = ?4 AND COALESCE(seen_at, -1) = ?5 RETURNING id')
    .bind(t, add, becameCounted ? 1 : 0, play.id, play.seen_at ?? -1).first<{ id: string }>();
  if (!moved) return { ok: false, reason: 'too_soon' };
  const first = play.seen_at === null, stmts: D1PreparedStatement[] = [];
  if (counts && (add || becameCounted)) {
    stmts.push(
      db.prepare('INSERT INTO game_daily (project_id, day, sessions, plays, seconds) VALUES (?, ?, 0, ?, ?) ON CONFLICT(project_id, day) DO UPDATE SET plays = plays + excluded.plays, seconds = seconds + excluded.seconds')
        .bind(play.project_id, dayOf(t), becameCounted ? 1 : 0, add),
      db.prepare('UPDATE projects SET seconds = seconds + ?, plays = plays + ? WHERE id = ?').bind(add, becameCounted ? 1 : 0, play.project_id),
    );
  }
  const rec = playRecordStmt(db, play, add, first, t);   // the player's own record for this game
  if (rec) stmts.push(rec);
  if (play.trial && play.trial_until) stmts.push(...trialOpenStmts(db, play, t, play.trial_until));
  if (stmts.length) await db.batch(stmts);
  return { ok: true, counted: !!play.counted || becameCounted, seconds: total };
}

/** The session counts in the game's daily sessions when the platform starts it, not when the game says it loaded. */
export function sessionStartStmt(db: D1Database, projectId: string, t: number): D1PreparedStatement {
  return db.prepare('INSERT INTO game_daily (project_id, day, sessions, plays, seconds) VALUES (?, ?, 1, 0, 0) ON CONFLICT(project_id, day) DO UPDATE SET sessions = sessions + 1').bind(projectId, dayOf(t));
}

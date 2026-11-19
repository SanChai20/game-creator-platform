// Free trials for paid games. The creator sets a number of minutes; a signed-in player who has not bought the game
// may play that long, in total, before the game asks them to buy it.
//
// Enforced on the server:
//  - the allowance is kept per account (play always needs a signed-in player), so reloading, clearing the browser,
//    another browser or another device all draw from the same minutes;
//  - time is wall-clock time while the game is open, by the server's clock, charged at each check-in of the page showing
//    the game and at each heartbeat of the game (whichever comes; neither can stretch it, see trialOpenStmts); every trial
//    session also costs at least TRIAL_MIN_CHARGE_S up front, so reloading over and over (or blocking heartbeats)
//    cannot stretch the trial;
//  - a trial play token expires when the remaining time runs out, so the game document cannot be reopened and the
//    platform services (saves, leaderboards, rooms) refuse it once the trial is over;
//  - no new trial session starts once the minutes are used.
import { AppError, type Env, type Project } from './env';
import type { Settings } from './settings';
import { now } from './util';

export const TRIAL_MIN_CHARGE_S = 30;

export interface TrialState { minutes: number; used_seconds: number; remaining_seconds: number; over: boolean }

/** The trial a game offers right now, in minutes (0 when it offers none). */
export function trialMinutes(p: Pick<Project, 'price_cents' | 'trial_minutes'>, s: Settings): number {
  if (!s.trials_enabled || !(p.price_cents > 0)) return 0;
  return Math.max(0, Math.min(Number(p.trial_minutes) || 0, s.trial_max_minutes));
}

export async function trialState(env: Env, p: Project, s: Settings, userId: string | null): Promise<TrialState | null> {
  const minutes = trialMinutes(p, s);
  if (!minutes) return null;
  const used = userId ? (await env.DB.prepare('SELECT seconds FROM trials WHERE project_id = ? AND user_id = ?').bind(p.id, userId).first<{ seconds: number }>())?.seconds || 0 : 0;
  const remaining = Math.max(0, minutes * 60 - used);
  return { minutes, used_seconds: used, remaining_seconds: remaining, over: remaining <= 0 };
}

/** Starts a trial session: charges the minimum up front and returns what is left after it. */
export async function beginTrial(env: Env, p: Project, s: Settings, userId: string): Promise<TrialState> {
  const st = await trialState(env, p, s, userId);
  if (!st) throw new AppError(402, 'Buy this game to play it.', 'purchase_required');
  if (st.over) throw new AppError(402, `Your ${st.minutes}-minute free trial is used up. Buy the game to keep playing.`, 'trial_over');
  const t = now();
  // Checked and charged in one statement, so sessions started at the same moment cannot all pass on the same last seconds.
  const row = await env.DB.prepare(`INSERT INTO trials (project_id, user_id, seconds, sessions, started_at, last_at) VALUES (?1, ?2, ?3, 1, ?4, ?4)
      ON CONFLICT(project_id, user_id) DO UPDATE SET seconds = seconds + excluded.seconds, sessions = sessions + 1, last_at = excluded.last_at WHERE trials.seconds < ?5
      RETURNING seconds`).bind(p.id, userId, TRIAL_MIN_CHARGE_S, t, st.minutes * 60).first<{ seconds: number }>();
  if (!row) throw new AppError(402, `Your ${st.minutes}-minute free trial is used up. Buy the game to keep playing.`, 'trial_over');
  // The session may stay open for the time that was left; the up-front charge is part of that time, not on top of it.
  const before = row.seconds - TRIAL_MIN_CHARGE_S;
  return { ...st, used_seconds: Math.min(st.minutes * 60, row.seconds), remaining_seconds: Math.max(0, st.minutes * 60 - before), over: false };
}

/** Extra seconds to add to the allowance after a heartbeat moved a trial session from `before` to `after` open seconds. */
export const trialCharge = (before: number, after: number) => Math.max(0, after - TRIAL_MIN_CHARGE_S) - Math.max(0, before - TRIAL_MIN_CHARGE_S);

/**
 * Charges a free-trial session for the wall-clock time it has been open, by the server's clock: from when the platform
 * started it to `t`, never past `until` (when the session's time runs out). Called from the game's heartbeat and from the
 * store page's check-ins, so the trial is used up even if the game stops sending heartbeats. Guarded on the value read,
 * so two calls at once charge the time once.
 */
export function trialOpenStmts(db: D1Database, play: { id: string; project_id: string; user_id: string; started_at: number; trial_seconds: number }, t: number, until: number): D1PreparedStatement[] {
  const end = Math.max(play.started_at, Math.min(t, until));
  const open = Math.max(play.trial_seconds, Math.round((end - play.started_at) / 1000)), extra = trialCharge(play.trial_seconds, open);
  if (open === play.trial_seconds) return [];
  return [
    ...(extra ? [db.prepare('UPDATE trials SET seconds = seconds + ?1, last_at = ?2 WHERE project_id = ?3 AND user_id = ?4 AND (SELECT trial_seconds FROM plays WHERE id = ?5) = ?6')
      .bind(extra, t, play.project_id, play.user_id, play.id, play.trial_seconds)] : []),
    db.prepare('UPDATE plays SET trial_seconds = ?1 WHERE id = ?2 AND trial_seconds = ?3').bind(open, play.id, play.trial_seconds),
  ];
}

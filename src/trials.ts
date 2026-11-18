// Free trials for paid games. The creator sets a number of minutes; a signed-in player who has not bought the game
// may play that long, in total, before the game asks them to buy it.
//
// Enforced on the server:
//  - the allowance is kept per account (play always needs a signed-in player), so reloading, clearing the browser,
//    another browser or another device all draw from the same minutes;
//  - time is wall-clock time while the game is open, measured by the heartbeats the SDK already sends; every trial
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

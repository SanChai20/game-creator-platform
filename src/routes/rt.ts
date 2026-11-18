// Runtime API called from inside games (cross-origin, authenticated by the signed play token):
// heartbeats that measure play time, cloud saves, leaderboards, realtime rooms, and the store used by game server code.
import { Hono } from 'hono';
import { AppError, bad, type Env } from '../env';
import { isGuestId } from '../auth';
import { playKey, runtimeHash, storeKey } from '../deploy';
import { getSettings } from '../settings';
import { owns } from '../earnings';
import { TRIAL_MIN_CHARGE_S, trialCharge } from '../trials';
import { clamp, dayOf, now, safeEqual } from '../util';
import { regionHint } from '../placement';
// @ts-ignore plain JS module
import { DataError, authToken, playRecordStmt, playerOf, playerSummary, saveOp, scopeOf, serverStoreOp, statOp } from '../player-data.js';
// @ts-ignore plain JS module
import { bindingProblem } from '../session-binding.js';
// @ts-ignore plain JS module
import { signPlayToken } from '../runtime/game-worker.js';

export const PLAY_SESSION_S = 6 * 3600;   // an account's play token; renewed while the sign-in lasts
export const GUEST_SESSION_S = 3600;      // a guest's, short so switching "Require login to play" on ends guest play within the hour
interface Tok { g: string; e: 'preview' | 'live'; u: string; n: string; k: 'player' | 'owner' | 'verify'; s: string; x: number; tr?: 1 }

// The token names its own game and environment; the signature is checked against that game's key.
// Every per-player read and write below takes the game, environment and player from this token, never from the request body.
async function authAny(env: Env, token: unknown): Promise<Tok> {
  const tok = await guard(() => authToken(token, (g: string) => playKey(env, g))) as Tok;
  // Guest sessions exist only while "Require login to play" is off; switching it on ends them for every service at once.
  if (isGuestId(tok.u) && (await getSettings(env)).require_login_to_play) throw new AppError(401, 'Sign in to play.', 'unauthenticated');
  // The session must still belong to the identity that started it: the same sign-in for an account (not signed out, not
  // switched to another account in this browser), an unclaimed guest id for a guest. Checked on every call.
  const problem = await bindingProblem(env.DB, tok, now());
  if (problem) throw new AppError(401, problem.message, problem.code, problem.reason);
  return tok;
}
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) { if (e instanceof DataError) throw new AppError((e as any).status, e.message, (e as any).code); throw e; }
}

// A free-trial token works for the platform services only while the player's trial has time left (or once they bought the game).
async function trialLeft(env: Env, tok: Tok): Promise<number | null> {
  if (!tok.tr) return null;
  const r = await env.DB.prepare('SELECT p.trial_minutes, p.price_cents, t.seconds FROM projects p LEFT JOIN trials t ON t.project_id = p.id AND t.user_id = ? WHERE p.id = ?').bind(tok.u, tok.g).first<{ trial_minutes: number; price_cents: number; seconds: number | null }>();
  const s = await getSettings(env), mins = r && r.price_cents > 0 && s.trials_enabled ? Math.min(r.trial_minutes, s.trial_max_minutes) : 0;
  return Math.max(0, mins * 60 - (r?.seconds || 0));
}
async function inReserve(env: Env, tok: Tok): Promise<boolean> {
  const p = await env.DB.prepare('SELECT started_at FROM plays WHERE id = ?').bind(tok.s).first<{ started_at: number }>();
  return !!p && now() - p.started_at < TRIAL_MIN_CHARGE_S * 1000;
}
async function authPlay(env: Env, token: unknown): Promise<Tok> {
  const tok = await authAny(env, token), left = await trialLeft(env, tok);
  // A session may still use the minimum it was charged when it started, even if that brought the trial to zero.
  if (left !== null && left <= 0 && !(await inReserve(env, tok)) && !(await owns(env, tok.u, tok.g))) throw new AppError(402, 'The free trial is over. Buy the game to keep playing.', 'trial_over');
  return tok;
}


export const rt = new Hono<{ Bindings: Env }>();

rt.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-gcp-game, x-gcp-env, x-gcp-key', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-max-age': '86400' } });
  await next();
  if (c.res.status !== 101) c.res.headers.set('access-control-allow-origin', '*');   // a WebSocket upgrade response is immutable
});

const MAX_ERROR_KINDS = 200;
const MAX_BOARDS = 50, MAX_SCORE = 1e15;
const body = async (c: { req: { text(): Promise<string> } }) => { try { return JSON.parse(await c.req.text()) as Record<string, any>; } catch { throw bad('Body must be JSON.'); } };

rt.post('/beat', async (c) => {
  const b = await body(c), env = c.env, tok = await authAny(env, b.t), s = await getSettings(env), t = now();
  const play = await env.DB.prepare('SELECT * FROM plays WHERE id = ?').bind(tok.s).first<{ id: string; project_id: string; version: number; env: string; user_id: string; kind: string; last_beat_at: number; seconds: number; counted: number; ready: number; errors: number; trial: number; trial_seconds: number; started_at: number }>();
  if (!play || play.project_id !== tok.g) throw new AppError(401, 'Unknown play session.', 'bad_token');
  const delta = b.active ? Math.round(clamp((t - play.last_beat_at) / 1000, 0, 20)) : 0;
  // a session starts once: only the first heartbeat of a play (before it was marked ready) counts it, whatever b.first says
  const first = !!b.first && !play.ready;
  const errs: string[] = Array.isArray(b.errors) ? b.errors.slice(0, 5).map((e: unknown) => String(e).slice(0, 500)) : [];
  const total = play.seconds + delta, nerr = play.errors + errs.length + (b.fatal ? 1 : 0);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('UPDATE plays SET last_beat_at = ?, seconds = ?, frames = ?, ready = 1, errors = ?, ua = COALESCE(ua, ?) WHERE id = ?').bind(t, total, Number(b.frames) || 0, nerr, (c.req.header('user-agent') || '').slice(0, 200), play.id),
  ];
  if (play.kind !== 'verify') for (const m of errs) {
    // at most MAX_ERROR_KINDS different messages per version: a game (or a script) cannot fill the table with unique strings
    stmts.push(env.DB.prepare(`INSERT INTO client_errors (project_id, version, env, message, first_at, last_at) SELECT ?1, ?2, ?3, ?4, ?5, ?5
      WHERE (SELECT COUNT(*) FROM client_errors WHERE project_id = ?1 AND version = ?2 AND env = ?3) < ?6
         OR EXISTS (SELECT 1 FROM client_errors WHERE project_id = ?1 AND version = ?2 AND env = ?3 AND message = ?4)
      ON CONFLICT(project_id, version, env, message) DO UPDATE SET count = count + 1, last_at = excluded.last_at`).bind(play.project_id, play.version, play.env, m, t, MAX_ERROR_KINDS));
  }
  if (play.kind === 'player' && play.env === 'live') {
    const day = dayOf(t);
    const becameCounted = !play.counted && total >= s.play_min_seconds;
    stmts.push(
      env.DB.prepare('INSERT INTO game_daily (project_id, day, sessions, plays, seconds) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, day) DO UPDATE SET sessions = sessions + excluded.sessions, plays = plays + excluded.plays, seconds = seconds + excluded.seconds')
        .bind(play.project_id, day, first ? 1 : 0, becameCounted ? 1 : 0, delta),
      env.DB.prepare('UPDATE projects SET seconds = seconds + ?, plays = plays + ? WHERE id = ?').bind(delta, becameCounted ? 1 : 0, play.project_id),
    );
    if (becameCounted) stmts.push(env.DB.prepare('UPDATE plays SET counted = 1 WHERE id = ?').bind(play.id));
  }
  const rec = playRecordStmt(env.DB, play, delta, first, t);   // the player's own record for this game (none for the verifier)
  if (rec) stmts.push(rec);
  // A creator playing their own preview cleanly, in a real browser, qualifies the version when the automated browser cannot.
  if (play.kind === 'owner' && play.env === 'preview' && total >= s.verify_human_min_seconds && nerr === 0) {
    stmts.push(env.DB.prepare('UPDATE versions SET human_ok = 1 WHERE project_id = ? AND n = ? AND human_ok = 0').bind(play.project_id, play.version));
  }
  // A free-trial session uses up the player's trial by wall-clock time while the game is open, visible or not.
  let trial: { remaining_seconds: number; over: boolean; bought: boolean } | undefined, open = 0;
  if (play.trial) {
    // Measured from the start of the session, so a slow start and gaps between heartbeats are counted too; the token caps it.
    open = Math.max(play.trial_seconds, Math.round(clamp(t / 1000, play.started_at / 1000, Math.max(play.started_at / 1000, tok.x - 20)) - play.started_at / 1000));
    const extra = trialCharge(play.trial_seconds, open);
    stmts.push(env.DB.prepare('UPDATE plays SET trial_seconds = ? WHERE id = ?').bind(open, play.id));
    if (extra) stmts.push(env.DB.prepare('UPDATE trials SET seconds = seconds + ?, last_at = ? WHERE project_id = ? AND user_id = ?').bind(extra, t, play.project_id, play.user_id));
  }
  await env.DB.batch(stmts);
  if (play.trial) {
    const left = (await trialLeft(env, tok))!, bought = left <= 0 && await owns(env, play.user_id, play.project_id);
    // The up-front minimum charge is time this session has paid for but not used yet, so it is still this session's to play.
    const mine = t / 1000 >= tok.x - 20 ? 0 : left + Math.max(0, TRIAL_MIN_CHARGE_S - open);   // past the session's own end, nothing is left
    trial = { remaining_seconds: mine, over: mine <= 0 && !bought, bought };
  }
  return c.json({ ok: true, seconds: total, ...(trial ? { trial } : {}) });
});

// Is this play token still good? The game Worker asks before it serves a game page from the token it kept in a cookie
// (a reload), so a page reopened after signing out or switching accounts never starts as the previous player.
rt.post('/check', async (c) => {
  const b = await body(c), tok = await authAny(c.env, b.t);
  return c.json({ ok: true, player: { id: tok.u, name: tok.n, guest: isGuestId(tok.u) } });
});

// A fresh token for a session that is still bound, so a long session never loses its saves when its token runs out.
// Same session, player and game; a free-trial token is never renewed (it ends with the trial), and a paid game is renewed
// only while the player still owns it (a refund ends access here too).
const RENEW_WITHIN_S = 20 * 60;
rt.post('/renew', async (c) => {
  const b = await body(c), env = c.env, tok = await authAny(env, b.t);
  if (tok.tr) throw new AppError(409, 'A free-trial session is not renewed.', 'trial');
  if (tok.k !== 'player' && tok.k !== 'owner') throw new AppError(409, 'This session is not renewed.', 'not_renewable');
  const left = tok.x - Math.floor(now() / 1000);
  if (left > RENEW_WITHIN_S) return c.json({ token: null, expires_in: left });
  const p = await env.DB.prepare('SELECT price_cents, owner_id, status FROM projects WHERE id = ?').bind(tok.g).first<{ price_cents: number; owner_id: string; status: string }>();
  if (!p || (tok.e === 'live' && p.status !== 'live')) throw new AppError(409, 'This game is offline.', 'offline');
  if (tok.k === 'player' && p.price_cents > 0 && !(await owns(env, tok.u, tok.g))) throw new AppError(402, 'Buy the game to keep playing.', 'not_owned');
  const life = isGuestId(tok.u) ? GUEST_SESSION_S : PLAY_SESSION_S, x = Math.floor(now() / 1000) + life;
  const token = await signPlayToken({ g: tok.g, e: tok.e, u: tok.u, n: tok.n, k: tok.k, s: tok.s, x }, await playKey(env, tok.g));
  return c.json({ token, expires_in: life });
});

rt.post('/save', async (c) => {
  const b = await body(c), tok = await authPlay(c.env, b.t);
  return c.json(await guard(() => saveOp(c.env.DB, tok, b, now())));
});

// GCP.playerStats: named numbers per player and game.
rt.post('/stats', async (c) => {
  const b = await body(c), tok = await authPlay(c.env, b.t);
  return c.json(await guard(() => statOp(c.env.DB, tok, b, now())));
});

// GCP.playRecord(): what the platform recorded for this player in this game.
rt.post('/record', async (c) => {
  const b = await body(c), tok = await authPlay(c.env, b.t);
  return c.json(await playerSummary(c.env.DB, scopeOf(tok.g, tok.e), playerOf(tok)));
});

rt.post('/score', async (c) => {
  const b = await body(c), tok = await authPlay(c.env, b.t);
  const board = String(b.board || 'default').slice(0, 40), scope = scopeOf(tok.g, tok.e), me = playerOf(tok), db = c.env.DB;
  // A board's order is fixed by the first submit to it (boards table), so a later call cannot flip lowest-wins and
  // highest-wins; a game has at most MAX_BOARDS boards per environment.
  const fixed = await db.prepare('SELECT asc FROM boards WHERE project_id = ? AND board = ?').bind(scope, board).first<{ asc: number }>();
  let asc = fixed ? !!fixed.asc : b.order === 'asc';
  if (b.op === 'submit') {
    const score = Number(b.score);
    if (!Number.isFinite(score) || Math.abs(score) > MAX_SCORE) throw bad(`score must be a number between -${MAX_SCORE} and ${MAX_SCORE}.`);
    if (!fixed && tok.k !== 'verify') {
      await db.prepare('INSERT INTO boards (project_id, board, asc, created_at) SELECT ?1, ?2, ?3, ?4 WHERE (SELECT COUNT(*) FROM boards WHERE project_id = ?1) < ?5 ON CONFLICT DO NOTHING')
        .bind(scope, board, asc ? 1 : 0, now(), MAX_BOARDS).run();
      const row = await db.prepare('SELECT asc FROM boards WHERE project_id = ? AND board = ?').bind(scope, board).first<{ asc: number }>();
      if (!row) throw bad(`This game already has ${MAX_BOARDS} leaderboards. Reuse one of them.`);
      asc = !!row.asc;
    }
    if (tok.k !== 'verify') await c.env.DB.prepare(`INSERT INTO scores (project_id, board, user_id, name, score, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, board, user_id) DO UPDATE SET score = ${asc ? 'MIN' : 'MAX'}(score, excluded.score), name = excluded.name, updated_at = excluded.updated_at`).bind(scope, board, me, tok.n, score, now()).run();
    const mine = await c.env.DB.prepare('SELECT score FROM scores WHERE project_id = ? AND board = ? AND user_id = ?').bind(scope, board, me).first<{ score: number }>();
    return c.json({ ok: true, best: mine?.score ?? score });
  }
  const rows = await c.env.DB.prepare(`SELECT name, score, user_id = ?4 AS me FROM scores WHERE project_id = ?1 AND board = ?2 ORDER BY score ${asc ? 'ASC' : 'DESC'} LIMIT ?3`).bind(scope, board, clamp(Number(b.limit) || 10, 1, 100), me).all();
  return c.json({ rows: rows.results });
});

// Game server code (running in the game's own Worker) reads and writes game data with the game's key.
rt.post('/server-store', async (c) => {
  const g = c.req.header('x-gcp-game') || '', e = c.req.header('x-gcp-env') || 'live', key = c.req.header('x-gcp-key') || '';
  if (!/^[a-z0-9]{6,16}$/.test(g) || (e !== 'live' && e !== 'preview')) throw new AppError(401, 'Bad game key.');
  // The store key names one game AND environment, so a preview's server code cannot reach live data.
  if (!safeEqual(key, await storeKey(c.env, g, e))) {
    // Game Workers deployed before store keys existed still send the play key until the runtime rollout redeploys them.
    const row = await c.env.DB.prepare('SELECT runtime FROM game_workers WHERE project_id = ? AND env = ?').bind(g, e).first<{ runtime: string | null }>().catch(() => null);
    const legacy = !!row && !String(row.runtime || '').startsWith(await runtimeHash());
    if (!legacy || !safeEqual(key, await playKey(c.env, g))) throw new AppError(401, 'Bad game key.');
  }
  const b = await body(c);
  return c.json(await guard(() => serverStoreOp(c.env.DB, g, e, b, now())));
});

rt.get('/room', async (c) => {
  const tok = await authPlay(c.env, c.req.query('t')), s = await getSettings(c.env);
  const code = String(c.req.query('room') || 'lobby').slice(0, 40);
  const want = Number(c.req.query('max')) || s.room_max_peers;
  const id = c.env.ROOMS.idFromName(`${tok.g}:${tok.e}:${code}`);
  // Only the first get() of a room uses the hint, so the room is created in the region of the player who opens it
  // rather than wherever that player's request happened to land.
  const hint = regionHint((c.req.raw as any).cf);
  const u = new URL(c.req.url);
  // The room keeps who this socket belongs to (session, kind, token end, trial), and checks it again while it is open.
  u.search = `?uid=${encodeURIComponent(tok.u)}&name=${encodeURIComponent(tok.n)}&cap=${clamp(Math.round(want), 2, s.room_max_peers)}&g=${tok.g}&e=${tok.e}&r=${encodeURIComponent(code)}&s=${encodeURIComponent(tok.s)}&k=${tok.k}&x=${tok.x}${tok.tr ? '&tr=1' : ''}&mr=${clamp(Math.round(Number(s.room_msgs_per_second) || 60), 5, 240)}`;
  return c.env.ROOMS.get(id, hint ? { locationHint: hint as DurableObjectLocationHint } : undefined).fetch(new Request(u, c.req.raw));
});

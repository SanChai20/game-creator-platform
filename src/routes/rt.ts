// Runtime API called from inside games (cross-origin, authenticated by the signed play token):
// the game's heartbeat (started, errors), cloud saves, leaderboards, realtime rooms, and the store used by game server code.
import { readOptions } from '../file-read';
import { Hono, type Context } from 'hono';
import { AppError, bad, type Env } from '../env';
import { isGuestId } from '../auth';
import { playKey, runtimeHash, storeKey } from '../deploy';
import { getSettings } from '../settings';
import { playClock } from '../clock-do';
import { assertGameDataRoom } from '../db-guard';
import { owns } from '../earnings';
import { TRIAL_MIN_CHARGE_S, trialOpenStmts } from '../trials';
import { clamp, now, readCapped, safeEqual } from '../util';
import { regionHint } from '../placement';
import { eloChanges, matchRequest } from '../match-making';
import { getProject, getVersion, verKey } from '../projects';
import { TICKET_TTL_S, matchTicketKey, type Seat } from '../matchmaker';
import { newLobbyCode, readLobby, signLobby, type Lobby } from '../lobby';
import { socialHub } from '../social';
import { lobbyData, sendInvite } from './social';
// @ts-ignore plain JS module
import { forGame } from '../presence.js';
// @ts-ignore plain JS module
import { acceptedInvite, listFriends } from '../social-rules.js';
// @ts-ignore plain JS module
import { DataError, authToken, playerOf, playerSummary, resumeOp, saveOp, scopeOf, serverStoreOp, statOp } from '../player-data.js';
// @ts-ignore plain JS module
import { bindingProblem } from '../session-binding.js';
// @ts-ignore plain JS module
import { currentMatch } from '../match-seats.js';
// @ts-ignore plain JS module
import { isServerPath, signPlayToken } from '../runtime/game-worker.js';

export const PLAY_SESSION_S = 6 * 3600;   // an account's play token; renewed while the sign-in lasts
export const GUEST_SESSION_S = 3600;      // a guest's, short so switching "Require login to play" on ends guest play within the hour
interface Tok { g: string; e: 'preview' | 'live'; u: string; n: string; k: 'player' | 'owner' | 'verify'; s: string; x: number; tr?: 1 }

// The token names its own game and environment; the signature is checked against that game's key.
// Every per-player read and write below takes the game, environment and player from this token, never from the request body.
/** One call against a rate limit binding; a platform without the binding (local, tests) is not limited. */
async function throttle(rl: RateLimit | undefined, key: string): Promise<void> {
  if (!rl) return;
  const { success } = await rl.limit({ key });
  if (!success) throw new AppError(429, 'Too many calls to the game services. Slow down and try again in a minute.', 'rate_limited');
}
/** Game data is written only while the database has room for it (src/db-guard.ts). */
const roomForGameData = async (env: Env) => assertGameDataRoom(env, Number((await getSettings(env)).game_data_max_db_gb) || 0);
const READ_OPS = new Set(['get', 'list', 'all', 'top']);

async function authAny(env: Env, token: unknown): Promise<Tok> {
  const tok = await guard(() => authToken(token, (g: string) => playKey(env, g))) as Tok;
  // Guest sessions exist only while "Require login to play" is off; switching it on ends them for every service at once.
  if (isGuestId(tok.u) && (await getSettings(env)).require_login_to_play) throw new AppError(401, 'Sign in to play.', 'unauthenticated');
  // The session must still belong to the identity that started it: the same sign-in for an account (not signed out, not
  // switched to another account in this browser), an unclaimed guest id for a guest. Checked on every call.
  const problem = await bindingProblem(env.DB, tok, now());
  if (problem) throw new AppError(401, problem.message, problem.code, problem.reason);
  await throttle(env.PLAY_RL, 'play:' + tok.s);
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
// Every call's body is read before its token can be checked (the token travels in it), so it is read only up to a cap:
// a stranger posting a huge body must not make the Worker hold and parse it. The largest legitimate body is one save
// value (256 KB of JSON) with its key and token.
export const RT_BODY_MAX = 1024 * 1024;
const body = async (c: { req: { raw: Request } }) => {
  const raw = await readCapped(c.req.raw, RT_BODY_MAX);
  if (!raw) throw new AppError(413, 'Request body too large (1 MB at most).', 'too_large');
  try { return JSON.parse(new TextDecoder().decode(raw)) as Record<string, any>; } catch { throw bad('Body must be JSON.'); }
};

// The game's heartbeat. It reports what only the game knows: that it started (GCP.ready), its frame count and the errors
// it hit, which the creator's analytics show as reported by the game. It moves no play number: sessions, counted plays,
// play time, players online and the player's record come from the platform's own clock (src/play-clock.ts).
rt.post('/beat', async (c) => {
  const b = await body(c), env = c.env, s = await getSettings(env), t = now();
  // At scale (play_clock_do) the heartbeat goes to the player's clock, which confirms the session binding once a minute
  // instead of on every beat (src/clock-do.ts). Free-trial and verifier sessions stay on the database path below.
  if (s.play_clock_do && env.PLAY_CLOCK) {
    const tok = await guard(() => authToken(b.t, (g: string) => playKey(env, g))) as Tok;
    if (!tok.tr && tok.k !== 'verify') {
      if (isGuestId(tok.u) && s.require_login_to_play) throw new AppError(401, 'Sign in to play.', 'unauthenticated');
      await throttle(env.PLAY_RL, 'play:' + tok.s);
      const errors: string[] = Array.isArray(b.errors) ? b.errors.map((e: unknown) => String(e)) : [];
      const r = await playClock(env, tok.u).beat({ sid: tok.s, player: tok.u, frames: b.frames, errors, fatal: !!b.fatal, t, human_min_seconds: s.verify_human_min_seconds, tok });
      if (r.ok) return c.json({ ok: true, seconds: r.seconds });
      if (r.reason === 'ended') throw new AppError(401, r.message || 'This play session ended.', r.code || 'session_ended');
      if (r.reason === 'unknown') throw new AppError(401, 'Unknown play session.', 'bad_token');
    }
  }
  return legacyBeat(c, b, s, t);
});

async function legacyBeat(c: Context<{ Bindings: Env }>, b: Record<string, any>, s: Awaited<ReturnType<typeof getSettings>>, t: number) {
  const env = c.env, tok = await authAny(env, b.t);
  const play = await env.DB.prepare('SELECT * FROM plays WHERE id = ?').bind(tok.s).first<{ id: string; project_id: string; version: number; env: string; user_id: string; kind: string; last_beat_at: number; seconds: number; counted: number; ready: number; errors: number; trial: number; trial_seconds: number; trial_until: number | null; started_at: number }>();
  if (!play || play.project_id !== tok.g) throw new AppError(401, 'Unknown play session.', 'bad_token');
  const errs: string[] = Array.isArray(b.errors) ? b.errors.slice(0, 5).map((e: unknown) => String(e).slice(0, 500)) : [];
  const nerr = play.errors + errs.length + (b.fatal ? 1 : 0);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('UPDATE plays SET last_beat_at = ?, frames = ?, ready = 1, errors = ? WHERE id = ?').bind(t, Number(b.frames) || 0, nerr, play.id),
  ];
  if (play.kind !== 'verify') for (const m of errs) {
    // at most MAX_ERROR_KINDS different messages per version: a game (or a script) cannot fill the table with unique strings
    stmts.push(env.DB.prepare(`INSERT INTO client_errors (project_id, version, env, message, first_at, last_at) SELECT ?1, ?2, ?3, ?4, ?5, ?5
      WHERE (SELECT COUNT(*) FROM client_errors WHERE project_id = ?1 AND version = ?2 AND env = ?3) < ?6
         OR EXISTS (SELECT 1 FROM client_errors WHERE project_id = ?1 AND version = ?2 AND env = ?3 AND message = ?4)
      ON CONFLICT(project_id, version, env, message) DO UPDATE SET count = count + 1, last_at = excluded.last_at`).bind(play.project_id, play.version, play.env, m, t, MAX_ERROR_KINDS));
  }
  // A creator playing their own preview cleanly, in a real browser, qualifies the version when the automated browser cannot.
  // How long it has been open is the server's clock since the platform started the session, not a figure from the game.
  if (play.kind === 'owner' && play.env === 'preview' && (t - play.started_at) / 1000 >= s.verify_human_min_seconds && nerr === 0) {
    stmts.push(env.DB.prepare('UPDATE versions SET human_ok = 1 WHERE project_id = ? AND n = ? AND human_ok = 0').bind(play.project_id, play.version));
  }
  // A free-trial session uses up the player's trial by wall-clock time while the game is open, visible or not, by the
  // server's clock from the start of the session (a slow start and gaps between heartbeats count too); the token caps it.
  let trial: { remaining_seconds: number; over: boolean; bought: boolean } | undefined;
  const until = play.trial_until ?? (tok.x - 20) * 1000;
  if (play.trial) stmts.push(...trialOpenStmts(env.DB, play, t, until));
  await env.DB.batch(stmts);
  if (play.trial) {
    const open = Math.max(play.trial_seconds, Math.round((Math.max(play.started_at, Math.min(t, until)) - play.started_at) / 1000));
    const left = (await trialLeft(env, tok))!, bought = left <= 0 && await owns(env, play.user_id, play.project_id);
    // The up-front minimum charge is time this session has paid for but not used yet, so it is still this session's to play.
    const mine = t >= until ? 0 : left + Math.max(0, TRIAL_MIN_CHARGE_S - open);   // past the session's own end, nothing is left
    trial = { remaining_seconds: mine, over: mine <= 0 && !bought, bought };
  }
  // seconds: the play time the platform has measured for this session so far (from the page's check-ins)
  return c.json({ ok: true, seconds: play.seconds, ...(trial ? { trial } : {}) });
}

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
  if (b.op === 'set') await roomForGameData(c.env);
  return c.json(await guard(() => saveOp(c.env.DB, tok, b, now())));
});

// GCP.playerStats: named numbers per player and game.
rt.post('/stats', async (c) => {
  const b = await body(c), tok = await authPlay(c.env, b.t);
  if (!READ_OPS.has(b.op)) await roomForGameData(c.env);
  return c.json(await guard(() => statOp(c.env.DB, tok, b, now())));
});

// GCP.playRecord(): what the platform recorded for this player in this game.
rt.post('/record', async (c) => {
  const b = await body(c), tok = await authPlay(c.env, b.t);
  return c.json(await playerSummary(c.env.DB, scopeOf(tok.g, tok.e), playerOf(tok)));
});

// GCP.resume: where the player left off, shown on their Continue row ("Act 2, Floor 14").
rt.post('/resume', async (c) => {
  const b = await body(c), tok = await authPlay(c.env, b.t);
  if (b.op === 'set') await roomForGameData(c.env);
  return c.json(await guard(() => resumeOp(c.env.DB, tok, b, now())));
});

rt.post('/score', async (c) => {
  const b = await body(c), tok = await authPlay(c.env, b.t);
  const board = String(b.board || 'default').slice(0, 40), scope = scopeOf(tok.g, tok.e), me = playerOf(tok), db = c.env.DB;
  // A board's order is fixed by the first submit to it (boards table), so a later call cannot flip lowest-wins and
  // highest-wins; a game has at most MAX_BOARDS boards per environment.
  const fixed = await db.prepare('SELECT asc FROM boards WHERE project_id = ? AND board = ?').bind(scope, board).first<{ asc: number }>();
  let asc = fixed ? !!fixed.asc : b.order === 'asc';
  if (b.op === 'submit') {
    await roomForGameData(c.env);
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
/** A call from a game's own Worker (its server code or a running match), authenticated with the game's store key. */
async function gameWorker(c: { env: Env; req: { header(n: string): string | undefined } }, legacyPlayKey = false): Promise<{ g: string; e: 'live' | 'preview' }> {
  const g = c.req.header('x-gcp-game') || '', e = c.req.header('x-gcp-env') || 'live', key = c.req.header('x-gcp-key') || '';
  if (!/^[a-z0-9]{6,16}$/.test(g) || (e !== 'live' && e !== 'preview')) throw new AppError(401, 'Bad game key.');
  // The store key names one game AND environment, so a preview's server code cannot reach live data.
  if (!safeEqual(key, await storeKey(c.env, g, e))) {
    if (!legacyPlayKey) throw new AppError(401, 'Bad game key.');
    // Game Workers deployed before store keys existed still send the play key until the runtime rollout redeploys them.
    const row = await c.env.DB.prepare('SELECT runtime FROM game_workers WHERE project_id = ? AND env = ?').bind(g, e).first<{ runtime: string | null }>().catch(() => null);
    const legacy = !!row && !String(row.runtime || '').startsWith(await runtimeHash());
    if (!legacy || !safeEqual(key, await playKey(c.env, g))) throw new AppError(401, 'Bad game key.');
  }
  return { g, e };
}

rt.post('/server-store', async (c) => {
  const { g, e } = await gameWorker(c, true);
  await throttle(c.env.SERVER_RL, `store:${g}:${e}`);
  const b = await body(c);
  if (b.op === 'set') await roomForGameData(c.env);
  return c.json(await guard(() => serverStoreOp(c.env.DB, g, e, b, now())));
});

// The bundle of a version, read by the game's own Worker. A game Worker has no bucket binding (its server code shares the
// isolate with the runtime, so a binding would be the creator's too): it reads its files here with its store key, which
// opens only this game's versions, never another game's files, covers or anything else in the bucket.
rt.get('/file/:n/*', async (c) => {
  const { g } = await gameWorker(c);
  const n = Number(c.req.param('n'));
  const raw = new URL(c.req.url).pathname.replace(/^\/api\/rt\/file\/[^/]+\//, '');
  let path: string;
  try { path = raw.split('/').map((s) => decodeURIComponent(s)).join('/'); } catch { throw bad('Bad path.'); }
  if (!Number.isInteger(n) || n < 1 || !path || path.includes('..') || path.includes('\0') || path.startsWith('/') || isServerPath(path)) throw new AppError(404, 'Not found.', 'not_found');
  // Conditions and ranges are handed to R2 as parsed values, not as the request's headers: given the headers of a browser's
  // revalidation (If-None-Match, sent when a game fetch()es a file it already has in its cache, as the SDK does to embed
  // fonts in a feedback picture) R2 failed with an internal error, and every such file read came back 500. A read that
  // still fails with a condition or range is served whole instead: a file read never fails because of how it was asked.
  const key = verKey(g, n, path), opts = readOptions(c.req.raw.headers);
  let obj: R2Object | R2ObjectBody | null;
  try { obj = await c.env.FILES.get(key, opts); }
  catch (e) { if (!opts.onlyIf && !opts.range) throw e; console.warn('file read retried without conditions', key, String((e as Error).message || e)); obj = await c.env.FILES.get(key); }
  if (!obj) throw new AppError(404, 'Not found.', 'not_found');
  const headers = new Headers({ etag: obj.httpEtag, 'x-gcp-size': String(obj.size), 'cache-control': 'no-store' });
  if (obj.httpMetadata?.contentType) headers.set('x-gcp-type', obj.httpMetadata.contentType);
  if (!('body' in obj) || !(obj as R2ObjectBody).body) return new Response(null, { status: 304, headers });
  const body = (obj as R2ObjectBody).body, range = obj.range as { offset?: number; length?: number } | undefined;
  if (range && c.req.header('range')) {
    const off = range.offset ?? 0, len = range.length ?? obj.size - off;
    headers.set('content-range', `bytes ${off}-${off + len - 1}/${obj.size}`);
    return new Response(body, { status: 206, headers });
  }
  return new Response(body, { headers });
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

// ----- server-run matches (GCP.match) ------------------------------------------------------------------------------
// Matchmaking: a WebSocket to the Matchmaker Durable Object for this game, environment and queue shape (or private code).
rt.get('/match', async (c) => {
  const tok = await authPlay(c.env, c.req.query('t')), s = await getSettings(c.env);
  if (!s.allow_matches) throw new AppError(403, 'Server-run matches are switched off on this platform.', 'matches_off');
  // Three ways in: a public queue; a private lobby of one's own (private=1), which only invited friends can enter; or the
  // lobby of an invite this player accepted (invite=<id>), whose shape comes from the lobby, not from the request.
  // (code=<typed code> is the older private lobby, kept working for games that still use it.)
  const inviteId = c.req.query('invite'), own = c.req.query('private') === '1' && !inviteId;
  let lobby: Lobby | null = null;
  if (inviteId) {
    if (isGuestId(tok.u)) throw new AppError(403, 'Sign in to join friends.', 'guest');
    const inv = await acceptedInvite(c.env.DB, tok.u, inviteId, tok.g, tok.e) as { lobby: string } | null;
    lobby = inv ? await readLobby(c.env, inv.lobby, tok.g, tok.e) : null;
    if (!lobby) throw new AppError(409, 'This invite cannot be used any more: the match has started or ended, or the invite is older than half an hour. Ask your friend for a new one.', 'lobby_gone');
  }
  const q = lobby ? matchRequest({ queue: lobby.q, size: String(lobby.n), min: String(lobby.m), teams: String(lobby.t), mode: lobby.o }, s.match_max_players)
    : matchRequest({ queue: c.req.query('queue'), size: c.req.query('players'), min: c.req.query('min'), teams: c.req.query('teams'), code: own ? null : c.req.query('code'), mode: c.req.query('mode'), wait: c.req.query('wait'), settle: c.req.query('settle') }, s.match_max_players);
  if (!q.ok) throw bad(q.error);
  if (own) lobby = { typ: 'lobby', g: tok.g, e: tok.e, c: newLobbyCode(), q: q.queue, n: q.size, m: q.min, t: q.teams, o: q.mode, x: 0 };
  // only a version that ships server/match.js can run the match the tickets lead to
  const p = await getProject(c.env, tok.g);
  const n = p && (tok.e === 'live' ? p.live_version : p.preview_version);
  const v = p && n ? await getVersion(c.env, p.id, n) : null;
  let hasMatch = false; try { hasMatch = !!JSON.parse(v?.manifest || '{}').hasMatch; } catch { /* old manifest */ }
  if (!hasMatch) throw new AppError(409, 'This version of the game has no server/match.js, so it cannot run matches.', 'no_match_code');
  const row = await c.env.DB.prepare('SELECT rating FROM match_ratings WHERE project_id = ? AND env = ? AND queue = ? AND user_id = ?').bind(tok.g, tok.e, q.queue, tok.u).first<{ rating: number }>().catch(() => null);
  const seat: Seat = { u: tok.u, n: tok.n, s: tok.s, k: tok.k, px: tok.x, tr: !!tok.tr, g: tok.g, e: tok.e, q: q.queue, size: q.size, min: q.min, teams: q.teams, mode: q.mode, code: q.code,
    region: regionHint((c.req.raw as any).cf), rating: row?.rating ?? 1000, at: 0, wait: q.wait, settle: q.settle };
  if (lobby) {
    seat.code = lobby.c; seat.priv = true; seat.own = own;
    seat.lk = await signLobby(c.env, { g: tok.g, e: tok.e, c: lobby.c, q: q.queue, n: q.size, m: q.min, t: q.teams, o: q.mode });
  }
  const name = lobby ? `${tok.g}:${tok.e}:pcode:${lobby.c}` : q.code ? `${tok.g}:${tok.e}:code:${q.code}` : `${tok.g}:${tok.e}:q:${q.queue}:${q.size}:${q.min}:${q.teams}:${q.mode}`;
  const u = new URL(c.req.url);
  u.search = `?seat=${encodeURIComponent(JSON.stringify(seat))}`;
  return c.env.MATCHMAKER.get(c.env.MATCHMAKER.idFromName(name)).fetch(new Request(u, c.req.raw));
});

// Coming back to a running match (GCP.match.rejoin): after a reload or a closed browser the page has lost its ticket, so
// it asks for the match this player was last put in. While that match has not ended, the answer is a fresh ticket for
// it, bound to the play session that asks. The ticket is marked rj: the game's Worker lets it into a match that is
// running and never starts one with it (src/runtime/game-worker.js). Whether the player may still come back (they did
// not leave on purpose, the game's rejoinMs has not run out) is decided there, by the match itself.
rt.post('/match-current', async (c) => {
  const b = await body(c), tok = await authPlay(c.env, b.t), t = now();
  const m = await currentMatch(c.env.DB, tok, t) as { id: string; queue: string; mode: string; region: string | null; started: number; roster: { id: string; name: string; team: unknown }[] } | null;
  if (!m) return c.json({ match: null });
  const ticket = await signPlayToken({ typ: 'match', rj: 1, g: tok.g, e: tok.e, m: m.id, u: tok.u, n: tok.n, s: tok.s, k: tok.k, px: tok.x, tr: tok.tr ? 1 : 0,
    x: Math.floor(t / 1000) + TICKET_TTL_S, h: m.region, q: m.queue, r: m.roster, o: m.mode ? { mode: m.mode } : {} }, await matchTicketKey(c.env, tok.g));
  return c.json({ match: m.id, ticket, queue: m.queue, mode: m.mode, region: m.region, players: m.roster, started: m.started });
});

// A running match asks which of its players' play sessions have ended (signed out, suspended, trial over).
rt.post('/match-check', async (c) => {
  const { g, e } = await gameWorker(c), b = await body(c), t = now();
  const players = Array.isArray(b.players) ? b.players.slice(0, 64) : [];
  const ended: string[] = [];
  for (const p of players) {
    if (!p || typeof p.u !== 'string') continue;
    if (p.tr && Number(p.px) && t / 1000 > Number(p.px)) { ended.push(p.u); continue; }
    const problem = await bindingProblem(c.env.DB, { g, e, u: p.u, k: String(p.k || 'player'), s: String(p.s || '') }, t).catch(() => null);
    if (problem) ended.push(p.u);
  }
  return c.json({ ended });
});

// A match reports its result once; ratings move for ranked players (never for the verifier's throwaway sessions).
rt.post('/match-result', async (c) => {
  const { g, e } = await gameWorker(c), b = await body(c), t = now();
  const id = String(b.match || '');
  if (!/^[a-f0-9]{16,40}$/.test(id)) throw bad('Unknown match.');
  const m = await c.env.DB.prepare('SELECT queue, roster, ended_at FROM matches WHERE id = ? AND project_id = ? AND env = ?').bind(id, g, e).first<{ queue: string; roster: string; ended_at: number | null }>();
  if (!m) throw new AppError(404, 'Unknown match.', 'not_found');
  if (m.ended_at) return c.json({ ok: true, already: true });
  const roster = JSON.parse(m.roster || '[]') as { id: string; k?: string }[];
  const ranked = new Set(roster.filter((r) => r.k !== 'verify').map((r) => r.id));
  const result = b.result && typeof b.result === 'object' ? b.result : {};
  const ranking = Array.isArray(result.ranking) ? (result.ranking as unknown[]).map((pl) => (Array.isArray(pl) ? pl : [pl]).map(String).filter((u) => ranked.has(u))).filter((pl) => pl.length) : [];
  const done = await c.env.DB.prepare('UPDATE matches SET ended_at = ?, result = ? WHERE id = ? AND ended_at IS NULL').bind(t, JSON.stringify(result).slice(0, 16_000), id).run();
  if (!done.meta.changes) return c.json({ ok: true, already: true });
  if (result.aborted || ranking.length < 2) return c.json({ ok: true, rated: 0 });
  const ids = ranking.flat();
  const rows = await c.env.DB.prepare(`SELECT user_id, rating FROM match_ratings WHERE project_id = ? AND env = ? AND queue = ? AND user_id IN (${ids.map(() => '?').join(',')})`).bind(g, e, m.queue, ...ids).all<{ user_id: string; rating: number }>();
  const ratings = new Map(rows.results.map((r) => [r.user_id, r.rating]));
  const delta = eloChanges(ranking, ratings);
  // the change is added to the stored rating, so two matches of the same player ending at once both count
  const stmts = ids.map((u) => c.env.DB.prepare(`INSERT INTO match_ratings (project_id, env, queue, user_id, rating, games, wins, updated_at) VALUES (?1, ?2, ?3, ?4, 1000 + ?5, 1, ?6, ?7)
      ON CONFLICT(project_id, env, queue, user_id) DO UPDATE SET rating = ROUND(rating + ?5, 1), games = games + 1, wins = wins + ?6, updated_at = ?7`)
    .bind(g, e, m.queue, u, Math.round((delta.get(u) || 0) * 10) / 10, ranking[0].includes(u) ? 1 : 0, t));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, rated: ids.length });
});

// ----- friends (GCP.friends) -------------------------------------------------------------------------------------
// The player's platform friends as the game sees them: name, an id (the same id match rosters use), status, and what
// they play only as "this game" or its title. Invites from a game go to friends who are online, away or busy; a match
// invite carries the private lobby the player is in (GCP.match.find({ private: true })), so only invitees can enter it.
// Guests and the verifier have no friends: the list is empty and invites are refused with a code the game can show.
rt.post('/friends', async (c) => {
  const b = await body(c), tok = await authPlay(c.env, b.t), s = await getSettings(c.env), env = c.env;
  const none = (code: string, message: string) => c.json({ ok: false, friends: [], code, error: message });
  if (!s.social_enabled) return none('social_off', 'Friends are switched off on this platform.');
  if (isGuestId(tok.u)) return none('guest', 'Sign in to play with friends.');
  if (tok.k === 'verify') return none('verify', 'The verification browser has no friends.');
  if (b.op === 'list') {
    const list = await listFriends(env.DB, tok.u, 500) as { id: string; name: string }[];
    const pres = env.SOCIAL && list.length ? await socialHub(env, tok.u).snapshot(list.map((f) => f.id)).catch(() => ({} as Record<string, unknown>)) : {};
    const rank: Record<string, number> = { online: 0, away: 1, busy: 2, offline: 3 };
    const friends = list.map((f) => {
      const p = forGame((pres as Record<string, unknown>)[f.id], tok.g) as { status: string; playing: unknown; since: number | null; joinable: boolean };
      return { id: f.id, name: f.name, ...p, invitable: p.status !== 'offline' && tok.e === 'live' };
    }).sort((a, b2) => (rank[a.status] ?? 3) - (rank[b2.status] ?? 3) || a.name.localeCompare(b2.name));
    return c.json({ ok: true, friends });
  }
  if (b.op === 'invite') {
    const to = String(b.to || '');
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(to)) throw bad('to must be a friend\'s id from GCP.friends.list().');
    const data = b.lobby ? await lobbyData(env, b.lobby, tok.g, tok.e, b.label) : { ...(b.label != null ? { label: b.label } : {}) };
    if (b.data !== undefined) (data as Record<string, unknown>).data = b.data;
    const me = await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(tok.u).first<{ name: string }>();
    return c.json(await sendInvite(env, s, { id: tok.u, name: me?.name || tok.n }, to, tok.g, tok.e, data));
  }
  throw bad('op must be list or invite.');
});

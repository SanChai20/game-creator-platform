// Runtime API called from inside games (cross-origin, authenticated by the signed play token):
// heartbeats that measure play time, cloud saves, leaderboards, realtime rooms, and the store used by game server code.
import { Hono } from 'hono';
import { AppError, bad, type Env } from '../env';
import { playKey } from '../deploy';
import { getSettings } from '../settings';
import { clamp, dayOf, now, safeEqual } from '../util';
// @ts-ignore plain JS module
import { verifyPlayToken } from '../runtime/game-worker.js';

interface Tok { g: string; e: 'preview' | 'live'; u: string; n: string; k: 'player' | 'owner' | 'verify'; s: string; x: number }

// The token names its own game and environment; the signature is checked against that game's key.
async function authAny(env: Env, token: unknown): Promise<Tok> {
  let body: Tok | null = null;
  try { body = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(String(token).split('.')[0].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))); } catch { /* invalid */ }
  if (!body || !/^[a-z0-9]{6,16}$/.test(String(body.g))) throw new AppError(401, 'Play session expired. Reopen the game from its page.', 'bad_token');
  const ok = await verifyPlayToken(token, await playKey(env, body.g), body.g, body.e);
  if (!ok) throw new AppError(401, 'Play session expired. Reopen the game from its page.', 'bad_token');
  return ok as Tok;
}

const MAX_VALUE = 256 * 1024;
const keyOk = (k: unknown): k is string => typeof k === 'string' && k.length > 0 && k.length <= 120;

export const rt = new Hono<{ Bindings: Env }>();

rt.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-gcp-game, x-gcp-env, x-gcp-key', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-max-age': '86400' } });
  await next();
  if (c.res.status !== 101) c.res.headers.set('access-control-allow-origin', '*');   // a WebSocket upgrade response is immutable
});

const body = async (c: { req: { text(): Promise<string> } }) => { try { return JSON.parse(await c.req.text()) as Record<string, any>; } catch { throw bad('Body must be JSON.'); } };

rt.post('/beat', async (c) => {
  const b = await body(c), env = c.env, tok = await authAny(env, b.t), s = await getSettings(env), t = now();
  const play = await env.DB.prepare('SELECT * FROM plays WHERE id = ?').bind(tok.s).first<{ id: string; project_id: string; version: number; env: string; user_id: string; kind: string; last_beat_at: number; seconds: number; counted: number; ready: number; errors: number }>();
  if (!play || play.project_id !== tok.g) throw new AppError(401, 'Unknown play session.', 'bad_token');
  const delta = b.active ? Math.round(clamp((t - play.last_beat_at) / 1000, 0, 20)) : 0;
  const errs: string[] = Array.isArray(b.errors) ? b.errors.slice(0, 5).map((e: unknown) => String(e).slice(0, 500)) : [];
  const total = play.seconds + delta, nerr = play.errors + errs.length + (b.fatal ? 1 : 0);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('UPDATE plays SET last_beat_at = ?, seconds = ?, frames = ?, ready = 1, errors = ?, ua = COALESCE(ua, ?) WHERE id = ?').bind(t, total, Number(b.frames) || 0, nerr, (c.req.header('user-agent') || '').slice(0, 200), play.id),
  ];
  if (play.kind !== 'verify') for (const m of errs) {
    stmts.push(env.DB.prepare('INSERT INTO client_errors (project_id, version, env, message, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, version, env, message) DO UPDATE SET count = count + 1, last_at = excluded.last_at').bind(play.project_id, play.version, play.env, m, t, t));
  }
  if (play.kind === 'player' && play.env === 'live') {
    const day = dayOf(t);
    const becameCounted = !play.counted && total >= s.play_min_seconds;
    stmts.push(
      env.DB.prepare('INSERT INTO game_daily (project_id, day, sessions, plays, seconds) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, day) DO UPDATE SET sessions = sessions + excluded.sessions, plays = plays + excluded.plays, seconds = seconds + excluded.seconds')
        .bind(play.project_id, day, b.first ? 1 : 0, becameCounted ? 1 : 0, delta),
      env.DB.prepare('UPDATE projects SET seconds = seconds + ?, plays = plays + ? WHERE id = ?').bind(delta, becameCounted ? 1 : 0, play.project_id),
    );
    if (becameCounted) stmts.push(env.DB.prepare('UPDATE plays SET counted = 1 WHERE id = ?').bind(play.id));
  }
  // A creator playing their own preview cleanly, in a real browser, qualifies the version when the automated browser cannot.
  if (play.kind === 'owner' && play.env === 'preview' && total >= s.verify_human_min_seconds && nerr === 0) {
    stmts.push(env.DB.prepare('UPDATE versions SET human_ok = 1 WHERE project_id = ? AND n = ? AND human_ok = 0').bind(play.project_id, play.version));
  }
  await env.DB.batch(stmts);
  return c.json({ ok: true, seconds: total });
});

rt.post('/save', async (c) => {
  const b = await body(c), tok = await authAny(c.env, b.t);
  if (!keyOk(b.key)) throw bad('key must be a string of 1–120 characters.');
  const owner = b.shared ? '' : tok.u, scope = `${tok.g}${tok.e === 'preview' ? ':preview' : ''}`;
  if (b.op === 'get') {
    const r = await c.env.DB.prepare('SELECT v FROM saves WHERE project_id = ? AND user_id = ? AND k = ?').bind(scope, owner, b.key).first<{ v: string }>();
    return c.json({ value: r ? JSON.parse(r.v) : null });
  }
  if (b.shared) throw new AppError(403, 'Shared data is written by game server code only.');
  if (b.op === 'set') {
    const v = JSON.stringify(b.value ?? null);
    if (v.length > MAX_VALUE) throw bad('Value too large (256 KB max per key).');
    const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM saves WHERE project_id = ? AND user_id = ?').bind(scope, owner).first<{ n: number }>();
    if ((n?.n || 0) >= 64) throw bad('Too many save keys (64 max per player).');
    await c.env.DB.prepare('INSERT INTO saves (project_id, user_id, k, v, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, user_id, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').bind(scope, owner, b.key, v, now()).run();
    return c.json({ ok: true });
  }
  if (b.op === 'delete') { await c.env.DB.prepare('DELETE FROM saves WHERE project_id = ? AND user_id = ? AND k = ?').bind(scope, owner, b.key).run(); return c.json({ ok: true }); }
  throw bad('op must be get, set or delete.');
});

rt.post('/score', async (c) => {
  const b = await body(c), tok = await authAny(c.env, b.t);
  const board = String(b.board || 'default').slice(0, 40), asc = b.order === 'asc', scope = `${tok.g}${tok.e === 'preview' ? ':preview' : ''}`;
  if (b.op === 'submit') {
    const score = Number(b.score);
    if (!Number.isFinite(score)) throw bad('score must be a number.');
    if (tok.k !== 'verify') await c.env.DB.prepare(`INSERT INTO scores (project_id, board, user_id, name, score, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, board, user_id) DO UPDATE SET score = ${asc ? 'MIN' : 'MAX'}(score, excluded.score), name = excluded.name, updated_at = excluded.updated_at`).bind(scope, board, tok.u, tok.n, score, now()).run();
    const mine = await c.env.DB.prepare('SELECT score FROM scores WHERE project_id = ? AND board = ? AND user_id = ?').bind(scope, board, tok.u).first<{ score: number }>();
    return c.json({ ok: true, best: mine?.score ?? score });
  }
  const rows = await c.env.DB.prepare(`SELECT name, score, user_id = ?4 AS me FROM scores WHERE project_id = ?1 AND board = ?2 ORDER BY score ${asc ? 'ASC' : 'DESC'} LIMIT ?3`).bind(scope, board, clamp(Number(b.limit) || 10, 1, 100), tok.u).all();
  return c.json({ rows: rows.results });
});

// Game server code (running in the game's own Worker) reads and writes game data with the game's key.
rt.post('/server-store', async (c) => {
  const g = c.req.header('x-gcp-game') || '', e = c.req.header('x-gcp-env') || 'live';
  if (!/^[a-z0-9]{6,16}$/.test(g) || !safeEqual(c.req.header('x-gcp-key') || '', await playKey(c.env, g))) throw new AppError(401, 'Bad game key.');
  const b = await body(c), scope = `${g}${e === 'preview' ? ':preview' : ''}`, owner = String(b.player || '');
  if (b.op === 'list') {
    const rows = await c.env.DB.prepare("SELECT k FROM saves WHERE project_id = ? AND user_id = ? AND k LIKE ? ESCAPE '\\' ORDER BY k LIMIT 500").bind(scope, owner, String(b.prefix || '').replace(/[\\%_]/g, '\\$&') + '%').all<{ k: string }>();
    return c.json({ keys: rows.results.map((r) => r.k) });
  }
  if (!keyOk(b.key)) throw bad('key must be a string of 1–120 characters.');
  if (b.op === 'get') { const r = await c.env.DB.prepare('SELECT v FROM saves WHERE project_id = ? AND user_id = ? AND k = ?').bind(scope, owner, b.key).first<{ v: string }>(); return c.json({ value: r ? JSON.parse(r.v) : null }); }
  if (b.op === 'set') {
    const v = JSON.stringify(b.value ?? null);
    if (v.length > MAX_VALUE) throw bad('Value too large (256 KB max per key).');
    await c.env.DB.prepare('INSERT INTO saves (project_id, user_id, k, v, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, user_id, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').bind(scope, owner, b.key, v, now()).run();
    return c.json({ ok: true });
  }
  if (b.op === 'delete') { await c.env.DB.prepare('DELETE FROM saves WHERE project_id = ? AND user_id = ? AND k = ?').bind(scope, owner, b.key).run(); return c.json({ ok: true }); }
  throw bad('op must be get, set, delete or list.');
});

rt.get('/room', async (c) => {
  const tok = await authAny(c.env, c.req.query('t')), s = await getSettings(c.env);
  const code = String(c.req.query('room') || 'lobby').slice(0, 40);
  const want = Number(c.req.query('max')) || s.room_max_peers;
  const id = c.env.ROOMS.idFromName(`${tok.g}:${tok.e}:${code}`);
  const u = new URL(c.req.url);
  u.search = `?uid=${encodeURIComponent(tok.u)}&name=${encodeURIComponent(tok.n)}&cap=${Math.min(want, s.room_max_peers)}`;
  return c.env.ROOMS.get(id).fetch(new Request(u, c.req.raw));
});

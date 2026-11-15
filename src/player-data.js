// Per-player game data: cloud saves, stats and the play record the platform keeps for every player of every game.
// Plain JS over a D1-shaped database so the isolation rules can be tested without a Worker (tests/player-data.mjs).
//
// Isolation rules, enforced here and nowhere else:
//   - Which game and environment: always the signed play token's own `g` and `e`, checked against that game's key.
//     A request body can never name another game, environment or player.
//   - Which player: always the token's player. A verifier session gets a throwaway identity of its own
//     ("verify:<session>"), so automated runs never read or overwrite the creator's own progress.
//   - Preview and live are separate scopes ("<game>:preview" and "<game>").
//   - Game-wide shared data (user_id '') is readable by players and writable only by the game's server code or its creator.
import { verifyPlayToken } from './runtime/game-worker.js';

export const MAX_VALUE = 256 * 1024;
export const MAX_SAVE_KEYS = 64;
export const MAX_STATS = 64;

export class DataError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const bad = (m) => new DataError(400, m, 'bad_request');
const expired = () => new DataError(401, 'Play session expired. Reopen the game from its page.', 'bad_token');

export const keyOk = (k) => typeof k === 'string' && k.length > 0 && k.length <= 120;
const statOk = (k) => typeof k === 'string' && k.length > 0 && k.length <= 60;
export const scopeOf = (game, env) => `${game}${env === 'preview' ? ':preview' : ''}`;
export const verifierId = (session) => `verify:${session}`;
/** The identity a token's data is stored under. */
export const playerOf = (tok) => (tok.k === 'verify' ? verifierId(tok.s) : String(tok.u || ''));

/** Checks a play token against the key of the game it names. keyFor(gameId) returns that game's play key. */
export async function authToken(token, keyFor) {
  let body = null;
  try { body = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(String(token).split('.')[0].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))); } catch { /* invalid */ }
  if (!body || !/^[a-z0-9]{6,16}$/.test(String(body.g)) || (body.e !== 'live' && body.e !== 'preview')) throw expired();
  const ok = await verifyPlayToken(token, await keyFor(body.g), body.g, body.e);
  if (!ok || !ok.u) throw expired();
  return ok;
}

const parse = (v) => { try { return JSON.parse(v); } catch { return null; } };
const encode = (value) => {
  const v = JSON.stringify(value ?? null);
  if (v.length > MAX_VALUE) throw bad('Value too large (256 KB max per key).');
  return v;
};

async function getSave(db, scope, owner, key) {
  const r = await db.prepare('SELECT v FROM saves WHERE project_id = ? AND user_id = ? AND k = ?').bind(scope, owner, key).first();
  return r ? parse(r.v) : null;
}
async function putSave(db, scope, owner, key, v, t) {
  await db.prepare('INSERT INTO saves (project_id, user_id, k, v, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, user_id, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').bind(scope, owner, key, v, t).run();
}

/** GCP.save and GCP.shared.get, called from the game page with the player's token. */
export async function saveOp(db, tok, b, t = Date.now()) {
  const scope = scopeOf(tok.g, tok.e), owner = b.shared ? '' : playerOf(tok);
  if (b.op === 'list' && !b.shared) {
    const rows = await db.prepare('SELECT k FROM saves WHERE project_id = ? AND user_id = ? ORDER BY k LIMIT 100').bind(scope, owner).all();
    return { keys: rows.results.map((r) => r.k) };
  }
  if (!keyOk(b.key)) throw bad('key must be a string of 1–120 characters.');
  if (b.op === 'get') return { value: await getSave(db, scope, owner, b.key) };
  if (b.shared) throw new DataError(403, 'Shared data is written by game server code only.', 'forbidden');
  if (b.op === 'set') {
    const v = encode(b.value);
    const exists = await db.prepare('SELECT 1 AS x FROM saves WHERE project_id = ? AND user_id = ? AND k = ?').bind(scope, owner, b.key).first();
    if (!exists) {
      const n = await db.prepare('SELECT COUNT(*) AS n FROM saves WHERE project_id = ? AND user_id = ?').bind(scope, owner).first();
      if ((n?.n || 0) >= MAX_SAVE_KEYS) throw bad(`Too many save keys (${MAX_SAVE_KEYS} max per player).`);
    }
    await putSave(db, scope, owner, b.key, v, t);
    return { ok: true };
  }
  if (b.op === 'delete') { await db.prepare('DELETE FROM saves WHERE project_id = ? AND user_id = ? AND k = ?').bind(scope, owner, b.key).run(); return { ok: true }; }
  throw bad('op must be get, set, delete or list.');
}

/** GCP.playerStats: named numbers per player and game (kills, levels cleared, best lap). */
export async function statOp(db, tok, b, t = Date.now()) {
  const scope = scopeOf(tok.g, tok.e), owner = playerOf(tok);
  if (b.op === 'all') {
    const rows = await db.prepare('SELECT name, value FROM player_stats WHERE project_id = ? AND user_id = ? ORDER BY name').bind(scope, owner).all();
    return { stats: Object.fromEntries(rows.results.map((r) => [r.name, r.value])) };
  }
  if (!statOk(b.name)) throw bad('name must be a string of 1–60 characters.');
  if (b.op === 'get') {
    const r = await db.prepare('SELECT value FROM player_stats WHERE project_id = ? AND user_id = ? AND name = ?').bind(scope, owner, b.name).first();
    return { value: r ? r.value : null };
  }
  const merge = { add: 'value + excluded.value', set: 'excluded.value', max: 'MAX(value, excluded.value)', min: 'MIN(value, excluded.value)' }[b.op];
  if (!merge) throw bad('op must be add, set, max, min, get or all.');
  const n = b.op === 'add' && b.value === undefined ? 1 : Number(b.value);
  if (!Number.isFinite(n) || Math.abs(n) > 1e15) throw bad('value must be a finite number.');
  const exists = await db.prepare('SELECT 1 AS x FROM player_stats WHERE project_id = ? AND user_id = ? AND name = ?').bind(scope, owner, b.name).first();
  if (!exists) {
    const c = await db.prepare('SELECT COUNT(*) AS n FROM player_stats WHERE project_id = ? AND user_id = ?').bind(scope, owner).first();
    if ((c?.n || 0) >= MAX_STATS) throw bad(`Too many stats (${MAX_STATS} max per player).`);
  }
  const r = await db.prepare(`INSERT INTO player_stats (project_id, user_id, name, value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, user_id, name) DO UPDATE SET value = ${merge}, updated_at = excluded.updated_at RETURNING value`).bind(scope, owner, b.name, n, t).first();
  return { ok: true, value: r ? r.value : n };
}

/** The statement /beat adds so every session updates the player's record for this game. Verifier sessions keep none. */
export function playRecordStmt(db, play, delta, first, t = Date.now()) {
  if (play.kind === 'verify') return null;
  return db.prepare(`INSERT INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds, last_version) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, user_id) DO UPDATE SET last_at = excluded.last_at, sessions = sessions + excluded.sessions, seconds = seconds + excluded.seconds, last_version = excluded.last_version`)
    .bind(scopeOf(play.project_id, play.env), play.user_id, t, t, first ? 1 : 0, delta, play.version);
}

/** GCP.playRecord() and the player's own "your progress" panel. */
export async function playerSummary(db, scope, owner) {
  const [rec, stats, saves, best] = await Promise.all([
    db.prepare('SELECT first_at, last_at, sessions, seconds, last_version FROM player_games WHERE project_id = ? AND user_id = ?').bind(scope, owner).first(),
    db.prepare('SELECT name, value FROM player_stats WHERE project_id = ? AND user_id = ? ORDER BY name').bind(scope, owner).all(),
    db.prepare('SELECT COUNT(*) AS keys, COALESCE(SUM(LENGTH(v)), 0) AS bytes, MAX(updated_at) AS last_at FROM saves WHERE project_id = ? AND user_id = ?').bind(scope, owner).first(),
    db.prepare('SELECT board, score FROM scores WHERE project_id = ? AND user_id = ? ORDER BY board').bind(scope, owner).all(),
  ]);
  return {
    sessions: rec?.sessions || 0, seconds: rec?.seconds || 0,
    first_played: rec?.first_at || null, last_played: rec?.last_at || null, last_version: rec?.last_version || null,
    stats: Object.fromEntries(stats.results.map((r) => [r.name, r.value])),
    best: Object.fromEntries(best.results.map((r) => [r.board, r.score])),
    saves: { keys: saves?.keys || 0, bytes: saves?.bytes || 0, last_saved: saves?.last_at || null },
  };
}

/** A player wiping their own progress in one game: saves, stats and leaderboard entries. The play record stays (it is play time, not progress). */
export async function resetPlayer(db, scope, owner) {
  if (!owner) throw bad('No player.');
  const r = await db.batch([
    db.prepare('DELETE FROM saves WHERE project_id = ? AND user_id = ?').bind(scope, owner),
    db.prepare('DELETE FROM player_stats WHERE project_id = ? AND user_id = ?').bind(scope, owner),
    db.prepare('DELETE FROM scores WHERE project_id = ? AND user_id = ?').bind(scope, owner),
  ]);
  return { ok: true, removed: r.reduce((s, x) => s + (x.meta?.changes || 0), 0) };
}

/** env.store in the game's server code. Authenticated by the game's own key, so it reaches only that game's data. */
export async function serverStoreOp(db, game, envName, b, t = Date.now()) {
  const scope = scopeOf(game, envName === 'preview' ? 'preview' : 'live'), owner = String(b.player || '');
  if (b.op === 'list') {
    const rows = await db.prepare("SELECT k FROM saves WHERE project_id = ? AND user_id = ? AND k LIKE ? ESCAPE '\\' ORDER BY k LIMIT 500").bind(scope, owner, String(b.prefix || '').replace(/[\\%_]/g, '\\$&') + '%').all();
    return { keys: rows.results.map((r) => r.k) };
  }
  if (!keyOk(b.key)) throw bad('key must be a string of 1–120 characters.');
  if (b.op === 'get') return { value: await getSave(db, scope, owner, b.key) };
  if (b.op === 'set') { await putSave(db, scope, owner, b.key, encode(b.value), t); return { ok: true }; }
  if (b.op === 'delete') { await db.prepare('DELETE FROM saves WHERE project_id = ? AND user_id = ? AND k = ?').bind(scope, owner, b.key).run(); return { ok: true }; }
  throw bad('op must be get, set, delete or list.');
}

/** Daily cleanup: verifier sessions' throwaway data. */
export const verifierCleanupStmts = (db, before) => [
  db.prepare("DELETE FROM saves WHERE user_id LIKE 'verify:%' AND updated_at < ?").bind(before),
  db.prepare("DELETE FROM player_stats WHERE user_id LIKE 'verify:%' AND updated_at < ?").bind(before),
];

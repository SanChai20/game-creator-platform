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

export const MAX_VALUE = 256 * 1024;          // bytes (UTF-8) per value
export const MAX_SAVE_KEYS = 64;
export const MAX_STATS = 64;
// All of one player's saves in one game, together. Guests get less: anyone can become a new guest at no cost, so a guest's
// quota is what one visitor can make the platform store per game they open (and play starts are rate-limited per address).
export const MAX_PLAYER_BYTES = 2 * 1024 * 1024;
export const MAX_GUEST_BYTES = 512 * 1024;
// What game server code may keep in one game and environment (shared data and per-player data it writes for players).
export const MAX_SERVER_KEYS = 10000;
export const MAX_SERVER_BYTES = 50 * 1024 * 1024;
const utf8 = new TextEncoder();
export const byteLength = (s) => utf8.encode(String(s)).byteLength;
const isGuest = (id) => String(id || '').startsWith('guest_');
export const playerQuota = (owner) => (isGuest(owner) ? MAX_GUEST_BYTES : MAX_PLAYER_BYTES);

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
  if (byteLength(v) > MAX_VALUE) throw bad('Value too large (256 KB max per key, counted as UTF-8 bytes of its JSON).');
  return v;
};

async function getSave(db, scope, owner, key) {
  const r = await db.prepare('SELECT v FROM saves WHERE project_id = ? AND user_id = ? AND k = ?').bind(scope, owner, key).first();
  return r ? parse(r.v) : null;
}
async function putSave(db, scope, owner, key, v, t) {
  await db.prepare('INSERT INTO saves (project_id, user_id, k, v, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, user_id, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').bind(scope, owner, key, v, t).run();
}
/**
 * Writes one value only if the owner stays within maxKeys keys and maxBytes bytes in this scope, in ONE statement, so
 * parallel writes cannot each pass a separate check. Returns true when written.
 */
async function putSaveWithin(db, scope, owner, key, v, t, maxKeys, maxBytes) {
  const r = await db.prepare(`INSERT INTO saves (project_id, user_id, k, v, updated_at)
      SELECT ?1, ?2, ?3, ?4, ?5
      WHERE (SELECT COUNT(*) FROM saves WHERE project_id = ?1 AND user_id = ?2 AND k != ?3) < ?6
        AND (SELECT COALESCE(SUM(LENGTH(CAST(v AS BLOB))), 0) FROM saves WHERE project_id = ?1 AND user_id = ?2 AND k != ?3) + LENGTH(CAST(?4 AS BLOB)) <= ?7
      ON CONFLICT(project_id, user_id, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`).bind(scope, owner, key, v, t, maxKeys, maxBytes).run();
  return (r?.meta?.changes || 0) > 0;
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
    const v = encode(b.value), quota = playerQuota(owner);
    if (!(await putSaveWithin(db, scope, owner, b.key, v, t, MAX_SAVE_KEYS, quota))) {
      const n = await db.prepare('SELECT COUNT(*) AS n FROM saves WHERE project_id = ? AND user_id = ? AND k != ?').bind(scope, owner, b.key).first();
      if ((n?.n || 0) >= MAX_SAVE_KEYS) throw bad(`Too many save keys (${MAX_SAVE_KEYS} max per player).`);
      throw bad(`Saves full: a ${isGuest(owner) ? 'guest' : 'player'} may keep ${Math.round(quota / 1024)} KB in one game, all keys together. Delete keys or keep less.`);
    }
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
  // One statement: a new name is only added while the player has fewer than MAX_STATS, so parallel calls cannot overshoot.
  const r = await db.prepare(`INSERT INTO player_stats (project_id, user_id, name, value, updated_at)
      SELECT ?1, ?2, ?3, ?4, ?5 WHERE (SELECT COUNT(*) FROM player_stats WHERE project_id = ?1 AND user_id = ?2 AND name != ?3) < ?6
      ON CONFLICT(project_id, user_id, name) DO UPDATE SET value = ${merge}, updated_at = excluded.updated_at RETURNING value`).bind(scope, owner, b.name, n, t, MAX_STATS).first();
  if (!r) throw bad(`Too many stats (${MAX_STATS} max per player).`);
  return { ok: true, value: r.value };
}

/** The statement /beat adds so every session updates the player's record for this game. Verifier sessions keep none. */
export function playRecordStmt(db, play, delta, first, t = Date.now()) {
  if (play.kind === 'verify') return null;
  return db.prepare(`INSERT INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds, last_version) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, user_id) DO UPDATE SET last_at = excluded.last_at, sessions = sessions + excluded.sessions, seconds = seconds + excluded.seconds, last_version = excluded.last_version`)
    .bind(scopeOf(play.project_id, play.env), play.user_id, t, t, first ? 1 : 0, delta, play.version);
}

// ---- where the player left off (GCP.resume), for "Continue playing" -------------------------------
export const RESUME_LABEL_MAX = 60;
export const RESUME_DETAIL_MAX = 80;
const oneLine = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
/** Checks what a game sent with GCP.resume.set: a short label ("Act 2, Floor 14"), an optional detail line and progress 0..1. */
export function cleanResume(b, t = Date.now()) {
  const label = oneLine(b?.label, RESUME_LABEL_MAX);
  if (!label) throw bad('resume needs a label: a few words saying where the player is ("Act 2, Floor 14").');
  const out = { label, at: t };
  const detail = oneLine(b?.detail, RESUME_DETAIL_MAX);
  if (detail) out.detail = detail;
  if (b?.progress != null) {
    const p = Number(b.progress);
    if (!Number.isFinite(p)) throw bad('progress must be a number from 0 to 1.');
    out.progress = Math.round(Math.max(0, Math.min(1, p)) * 1000) / 1000;
  }
  return out;
}
/** GCP.resume: set (where the player is now), clear (nothing to resume: the run ended) and get. The verifier keeps none. */
export async function resumeOp(db, tok, b, t = Date.now()) {
  const scope = scopeOf(tok.g, tok.e), owner = playerOf(tok);
  if (b.op === 'get') {
    const r = tok.k === 'verify' ? null : await db.prepare('SELECT resume FROM player_games WHERE project_id = ? AND user_id = ?').bind(scope, owner).first();
    return { resume: r?.resume ? parse(r.resume) : null };
  }
  if (b.op === 'clear') {
    if (tok.k !== 'verify') await db.prepare('UPDATE player_games SET resume = NULL WHERE project_id = ? AND user_id = ?').bind(scope, owner).run();
    return { ok: true };
  }
  if (b.op !== 'set') throw bad('op must be set, clear or get.');
  const r = cleanResume(b, t);
  if (tok.k === 'verify') return { ok: true, resume: r };
  // usually the heartbeat has made the row already; if not, start it without counting a session
  await db.prepare(`INSERT INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds, resume) VALUES (?1, ?2, ?3, ?3, 0, 0, ?4)
    ON CONFLICT(project_id, user_id) DO UPDATE SET resume = excluded.resume`).bind(scope, owner, t, JSON.stringify(r)).run();
  return { ok: true, resume: r };
}

/**
 * The signed-in player's live games, most recently played first, for "Continue playing": play record, last save, what the
 * game said with GCP.resume, and whether the player may still open it in full (a paid game they bought, or their own).
 * Games taken off the row stay off until played again. Only live games, never preview data.
 */
export async function continueList(db, owner, { limit = 12, offset = 0 } = {}) {
  const lim = Math.max(1, Math.min(50, limit | 0 || 12)), off = Math.max(0, Math.min(5000, offset | 0));
  const rows = await db.prepare(`SELECT pg.project_id, pg.first_at, pg.last_at, pg.sessions, pg.seconds, pg.resume,
      (SELECT MAX(updated_at) FROM saves s WHERE s.project_id = pg.project_id AND s.user_id = pg.user_id) AS saved_at,
      (p.price_cents = 0 OR p.owner_id = pg.user_id OR EXISTS (SELECT 1 FROM purchases b WHERE b.user_id = pg.user_id AND b.project_id = p.id AND b.status = 'paid')) AS owned
    FROM player_games pg JOIN projects p ON p.id = pg.project_id
    WHERE pg.user_id = ? AND p.status = 'live' AND (pg.continue_hidden_at IS NULL OR pg.last_at > pg.continue_hidden_at)
    ORDER BY pg.last_at DESC LIMIT ? OFFSET ?`).bind(owner, lim + 1, off).all();
  const list = rows.results.slice(0, lim).map((r) => ({
    game_id: r.project_id, first_played: r.first_at, last_played: r.last_at, sessions: r.sessions || 0, seconds: r.seconds || 0,
    saved_at: r.saved_at || null, resume: r.resume ? parse(r.resume) : null, owned: !!r.owned,
  }));
  return { list, more: rows.results.length > lim };
}
/** Takes one game off the player's Continue row until they play it again. Their progress is untouched. */
export async function hideContinue(db, scope, owner, t = Date.now()) {
  const r = await db.prepare('UPDATE player_games SET continue_hidden_at = ? WHERE project_id = ? AND user_id = ?').bind(t, scope, owner).run();
  return { ok: (r?.meta?.changes || 0) > 0 };
}

/** GCP.playRecord() and the player's own "your progress" panel. */
export async function playerSummary(db, scope, owner) {
  const [rec, stats, saves, best] = await Promise.all([
    db.prepare('SELECT first_at, last_at, sessions, seconds, last_version, resume FROM player_games WHERE project_id = ? AND user_id = ?').bind(scope, owner).first(),
    db.prepare('SELECT name, value FROM player_stats WHERE project_id = ? AND user_id = ? ORDER BY name').bind(scope, owner).all(),
    db.prepare('SELECT COUNT(*) AS keys, COALESCE(SUM(LENGTH(v)), 0) AS bytes, MAX(updated_at) AS last_at FROM saves WHERE project_id = ? AND user_id = ?').bind(scope, owner).first(),
    db.prepare('SELECT board, score FROM scores WHERE project_id = ? AND user_id = ? ORDER BY board').bind(scope, owner).all(),
  ]);
  return {
    sessions: rec?.sessions || 0, seconds: rec?.seconds || 0,
    first_played: rec?.first_at || null, last_played: rec?.last_at || null, last_version: rec?.last_version || null,
    resume: rec?.resume ? parse(rec.resume) : null,
    stats: Object.fromEntries(stats.results.map((r) => [r.name, r.value])),
    best: Object.fromEntries(best.results.map((r) => [r.board, r.score])),
    saves: { keys: saves?.keys || 0, bytes: saves?.bytes || 0, last_saved: saves?.last_at || null },
  };
}

/** A player wiping their own progress in one game: saves, stats, leaderboard entries and where they left off. The play record stays (it is play time, not progress). */
export async function resetPlayer(db, scope, owner) {
  if (!owner) throw bad('No player.');
  const r = await db.batch([
    db.prepare('DELETE FROM saves WHERE project_id = ? AND user_id = ?').bind(scope, owner),
    db.prepare('DELETE FROM player_stats WHERE project_id = ? AND user_id = ?').bind(scope, owner),
    db.prepare('DELETE FROM scores WHERE project_id = ? AND user_id = ?').bind(scope, owner),
    db.prepare('UPDATE player_games SET resume = NULL WHERE project_id = ? AND user_id = ?').bind(scope, owner),
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
  if (b.op === 'set') {
    // Server code has its own, larger allowance per game and environment (all owners together), checked in one statement.
    const v = encode(b.value);
    const r = await db.prepare(`INSERT INTO saves (project_id, user_id, k, v, updated_at)
        SELECT ?1, ?2, ?3, ?4, ?5
        WHERE (SELECT COUNT(*) FROM saves WHERE project_id = ?1) < ?6
          AND (SELECT COALESCE(SUM(LENGTH(CAST(v AS BLOB))), 0) FROM saves WHERE project_id = ?1) + LENGTH(CAST(?4 AS BLOB)) <= ?7
        ON CONFLICT(project_id, user_id, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`).bind(scope, owner, b.key, v, t, MAX_SERVER_KEYS, MAX_SERVER_BYTES).run();
    if (!(r?.meta?.changes)) {
      // an existing key may still be overwritten when the new value is not larger
      const old = await db.prepare('SELECT LENGTH(CAST(v AS BLOB)) AS b FROM saves WHERE project_id = ? AND user_id = ? AND k = ?').bind(scope, owner, b.key).first();
      if (old && byteLength(v) <= old.b) { await putSave(db, scope, owner, b.key, v, t); return { ok: true }; }
      throw bad(`Game data full: this game may keep ${MAX_SERVER_KEYS} keys and ${MAX_SERVER_BYTES / 1024 / 1024} MB per environment. Delete keys you no longer need.`);
    }
    return { ok: true };
  }
  if (b.op === 'delete') { await db.prepare('DELETE FROM saves WHERE project_id = ? AND user_id = ? AND k = ?').bind(scope, owner, b.key).run(); return { ok: true }; }
  throw bad('op must be get, set, delete or list.');
}

/** Daily cleanup: progress of guests who have not played for `before` (ms epoch) and never signed in to keep it. */
export const idleGuestCleanupStmts = (db, before) => [
  ...['saves', 'player_stats', 'scores', 'player_games'].map((tb) => db.prepare(`DELETE FROM ${tb} WHERE user_id LIKE 'guest\\_%' ESCAPE '\\' AND user_id IN (SELECT user_id FROM player_games WHERE user_id LIKE 'guest\\_%' ESCAPE '\\' GROUP BY user_id HAVING MAX(last_at) < ?)`).bind(before)),
];

/** Daily cleanup: verifier sessions' throwaway data. */
export const verifierCleanupStmts = (db, before) => [
  db.prepare("DELETE FROM saves WHERE user_id LIKE 'verify:%' AND updated_at < ?").bind(before),
  db.prepare("DELETE FROM player_stats WHERE user_id LIKE 'verify:%' AND updated_at < ?").bind(before),
];

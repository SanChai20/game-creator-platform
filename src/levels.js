// Player-made levels: levels, maps or mods that players make inside a game that supports them and share with everyone
// who plays it. The game hands over its own JSON (GCP.levels.publish); the platform keeps it, lists it on the game
// page's shelf and in the game (GCP.levels.list), and opens the game with it (GCP.launch.level, GCP.levels.get).
// Plain JS over a D1-shaped database (tests/levels.mjs); the API and the play-token route call it.
//
// Rules, enforced here and nowhere else:
//   - Only signed-in players publish (not guests, not the verifier), to a game whose live version supports levels
//     (gcp.json "levels": true, or code that calls GCP.levels.publish) and whose creator has not turned sharing off.
//     A preview's levels stay in the preview.
//   - A level is the game's JSON, at most 256 KB, with a title (3 to 60 characters) and an optional description (300).
//     Titles and descriptions go through the content rules (src/content-check.js) and may not carry links. At most 50
//     levels a player per game and 20 a day. The maker can publish a new version of their level under the same id.
//   - A play counts once per player. Only players who opened a level rate it (1 to 5 stars, not their own); the shelf
//     ranks by a rating pulled toward 3 stars until a level has a few ratings, so one 5-star vote does not top it.
//   - The maker or an admin deletes a level; the game's creator hides it; three reports by different players hide it
//     until an admin looks at it.

import { contentRules } from './content-check.js';

export const LIMITS = { bytes: 256 * 1024, title_min: 3, title: 60, description: 300, per_game: 50, per_day: 20, page: 24, reports_hide: 3, prior: 3 };
export const SORTS = ['top', 'new', 'played', 'mine'];

export class LevelError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const now = () => Date.now();
const line = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const text = (v, n) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);
const rid = () => 'lvl_' + [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
const LINK = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.|\b[a-z0-9-]+\.(?:com|net|org|io|gg|xyz|ru|cn|ly|me|app|tk)\b/i;
const isGuest = (id) => /^guest_/.test(String(id || ''));

/** Whether a version supports levels: its manifest (parsed or JSON text). */
export function supportsLevels(manifest) {
  let m = manifest;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return false; } }
  return !!(m && m.levels);
}
/** Whether players can share levels of this game now: the game row (status, hidden_at, levels_off) and its live manifest. */
export const levelsOpen = (p, manifest) => !!p && p.status === 'live' && !p.hidden_at && !p.levels_off && supportsLevels(manifest);

/** What a title and description may not say, or null. Adults-only games may describe what they declare. */
export function textProblem(title, description, adult = false) {
  const both = `${title}\n${description || ''}`;
  if (LINK.test(both)) return 'Links are not allowed in a level\'s title or description.';
  const r = contentRules(both, adult ? { sexual: 'explicit', violence: 'graphic', blood: true, adult_themes: true } : null);
  return r && r.reason ? 'That title or description is not allowed here.' : null;
}

/**
 * Publishes a level, or a new version of the player's own level (raw.id).
 * @param {any} db
 * @param {{ id: string, kind?: string }} who the player (from the play token)
 * @param {{ id: string, open: boolean, age?: number|null, version?: number|null }} game
 * @param {string} env live | preview
 * @param {any} raw { id?, title, description?, data }
 */
export async function publish(db, who, game, env, raw = {}, t = now()) {
  const uid = who && who.id;
  if (!uid || isGuest(uid)) throw new LevelError(401, 'Sign in to share levels.', 'guest');
  if (who.kind === 'verify') throw new LevelError(403, 'The verification browser cannot share levels.', 'verify');
  if (!game || !game.open) throw new LevelError(403, 'This game does not take player levels.', 'levels_off');
  const title = line(raw.title, LIMITS.title), description = text(raw.description, LIMITS.description) || null;
  if (title.length < LIMITS.title_min) throw new LevelError(400, `A level needs a title of ${LIMITS.title_min} to ${LIMITS.title} characters.`, 'bad_title');
  const problem = textProblem(title, description, (game.age || 0) >= 18);
  if (problem) throw new LevelError(400, problem, 'not_allowed');
  if (raw.data === undefined) throw new LevelError(400, 'A level needs its data: the JSON your game loads it from.', 'no_data');
  let data; try { data = JSON.stringify(raw.data); } catch { data = undefined; }
  if (data === undefined) throw new LevelError(400, 'A level\'s data must be JSON.', 'bad_data');
  const bytes = new TextEncoder().encode(data).length;
  if (bytes > LIMITS.bytes) throw new LevelError(413, 'A level can be at most 256 KB.', 'too_big');
  if (raw.id) {
    const id = String(raw.id);
    const own = await db.prepare('SELECT id, user_id FROM levels WHERE id = ? AND project_id = ? AND env = ?').bind(id, game.id, env).first();
    if (!own) throw new LevelError(404, 'No such level.', 'not_found');
    if (own.user_id !== uid) throw new LevelError(403, 'Only its maker can change a level.', 'forbidden');
    await db.prepare('UPDATE levels SET title = ?, description = ?, data = ?, bytes = ?, game_version = ?, updated_at = ? WHERE id = ?').bind(title, description, data, bytes, game.version ?? null, t, id).run();
    return { id, updated: true };
  }
  const n = await db.prepare('SELECT COUNT(*) AS n FROM levels WHERE user_id = ? AND project_id = ? AND env = ?').bind(uid, game.id, env).first();
  if ((n?.n || 0) >= LIMITS.per_game) throw new LevelError(409, `You can share at most ${LIMITS.per_game} levels of a game. Delete one to share another.`, 'too_many');
  const day = await db.prepare('SELECT COUNT(*) AS n FROM levels WHERE user_id = ? AND created_at > ?').bind(uid, t - 86400000).first();
  if ((day?.n || 0) >= LIMITS.per_day) throw new LevelError(429, 'You shared a lot of levels today. Try again tomorrow.', 'rate_limited');
  const id = rid();
  await db.prepare('INSERT INTO levels (id, project_id, env, user_id, title, description, data, bytes, game_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, game.id, env, uid, title, description, data, bytes, game.version ?? null, t, t).run();
  return { id, updated: false };
}

const COLS = `l.id, l.project_id, l.env, l.user_id, l.title, l.description, l.bytes, l.game_version, l.plays, l.rating_sum, l.ratings, l.reports,
  l.hidden_at, l.hidden_by, l.created_at, l.updated_at, p.owner_id, p.slug, COALESCE(u.name, 'Player') AS by_name`;
const FROM = 'FROM levels l JOIN projects p ON p.id = l.project_id LEFT JOIN users u ON u.id = l.user_id';
const SCORE = `(l.rating_sum + ${LIMITS.prior}.0 * ${LIMITS.prior}) / (l.ratings + ${LIMITS.prior})`;

const view = (l, me, admin, stars) => ({
  id: l.id, title: l.title, description: l.description || null, by: { id: l.user_id, name: l.by_name },
  plays: l.plays, ratings: l.ratings, rating: l.ratings ? Math.round((l.rating_sum / l.ratings) * 10) / 10 : null,
  my_stars: stars ?? null, bytes: l.bytes, game_version: l.game_version ?? null, created_at: l.created_at, updated_at: l.updated_at,
  hidden: !!l.hidden_at, hidden_by: l.hidden_by || null,
  mine: !!me && me === l.user_id, can_hide: !!me && (me === l.owner_id || admin), can_delete: !!me && (me === l.user_id || admin),
  ...(admin ? { reports: l.reports } : {}),
});
async function starsOf(db, ids, me) {
  if (!me || !ids.length) return new Map();
  const rows = (await db.prepare(`SELECT level_id, stars FROM level_plays WHERE user_id = ? AND level_id IN (${ids.map(() => '?').join(',')})`).bind(me, ...ids).all()).results || [];
  return new Map(rows.map((r) => [r.level_id, r.stars]));
}

/**
 * A game's shelf: visible levels (and the viewer's own, hidden or not, under "mine"), without their data.
 * @param {any} db @param {string} projectId @param {string} env
 * @param {{ sort?: string, me?: string|null, offset?: number, limit?: number }} [o]
 */
export async function list(db, projectId, env, o = {}) {
  const sort = SORTS.includes(String(o.sort)) ? String(o.sort) : 'top', me = o.me || null;
  const limit = Math.min(LIMITS.page, Math.max(1, Math.floor(+(o.limit ?? LIMITS.page)) || LIMITS.page)), offset = Math.max(0, Math.floor(+(o.offset || 0)) || 0);
  if (sort === 'mine' && !me) return { levels: [], more: false };
  const where = sort === 'mine' ? 'l.project_id = ? AND l.env = ? AND l.user_id = ?' : 'l.project_id = ? AND l.env = ? AND l.hidden_at IS NULL';
  const order = sort === 'new' || sort === 'mine' ? 'l.created_at DESC' : sort === 'played' ? 'l.plays DESC, l.created_at DESC' : `${SCORE} DESC, l.plays DESC, l.created_at DESC`;
  const args = sort === 'mine' ? [projectId, env, me] : [projectId, env];
  const rows = (await db.prepare(`SELECT ${COLS} ${FROM} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...args, limit + 1, offset).all()).results || [];
  const page = rows.slice(0, limit), stars = await starsOf(db, page.map((r) => r.id), me);
  return { levels: page.map((l) => view(l, me, false, stars.get(l.id))), more: rows.length > limit };
}

/**
 * One level, or null when it is gone, of another game, or hidden from this viewer (its maker, the creator and admins
 * still see a hidden one). withData adds the game's JSON.
 * @param {any} db @param {string} id
 * @param {{ projectId?: string, env?: string, me?: string|null, admin?: boolean, withData?: boolean }} [o]
 */
export async function get(db, id, o = {}) {
  const l = await db.prepare(`SELECT ${COLS}${o.withData ? ', l.data' : ''} ${FROM} WHERE l.id = ?`).bind(String(id || '')).first();
  if (!l || (o.projectId && l.project_id !== o.projectId) || (o.env && l.env !== o.env)) return null;
  const me = o.me || null, admin = !!o.admin;
  if (l.hidden_at && me !== l.user_id && me !== l.owner_id && !admin) return null;
  const stars = await starsOf(db, [l.id], me);
  const v = view(l, me, admin, stars.get(l.id));
  if (o.withData) { try { v.data = JSON.parse(l.data); } catch { v.data = null; } }
  return { ...v, game: { id: l.project_id, slug: l.slug } };
}

/** The player opened a level in the game: counts the play once per signed-in player. */
export async function recordPlay(db, id, uid, t = now()) {
  if (!uid || isGuest(uid)) return false;
  const r = await db.prepare('INSERT OR IGNORE INTO level_plays (level_id, user_id, played_at) VALUES (?, ?, ?)').bind(id, uid, t).run();
  if (!r.meta?.changes) return false;
  await db.prepare('UPDATE levels SET plays = plays + 1 WHERE id = ?').bind(id).run();
  return true;
}

/** Rates a level 1 to 5 stars (again to change it). Only a player who opened it, and never its maker. */
export async function rate(db, id, uid, stars, t = now()) {
  if (!uid || isGuest(uid)) throw new LevelError(401, 'Sign in to rate levels.', 'guest');
  const s = Math.floor(+stars);
  if (!(s >= 1 && s <= 5)) throw new LevelError(400, 'A rating is 1 to 5 stars.', 'bad_stars');
  const l = await db.prepare('SELECT id, user_id, hidden_at FROM levels WHERE id = ?').bind(id).first();
  if (!l || l.hidden_at) throw new LevelError(404, 'No such level.', 'not_found');
  if (l.user_id === uid) throw new LevelError(400, 'You cannot rate your own level.', 'own');
  const p = await db.prepare('SELECT stars FROM level_plays WHERE level_id = ? AND user_id = ?').bind(id, uid).first();
  if (!p) throw new LevelError(403, 'Play a level before you rate it.', 'not_played');
  await db.batch([
    db.prepare('UPDATE level_plays SET stars = ? WHERE level_id = ? AND user_id = ?').bind(s, id, uid),
    p.stars ? db.prepare('UPDATE levels SET rating_sum = rating_sum + ? WHERE id = ?').bind(s - p.stars, id)
      : db.prepare('UPDATE levels SET rating_sum = rating_sum + ?, ratings = ratings + 1 WHERE id = ?').bind(s, id),
  ]);
  const r = await db.prepare('SELECT rating_sum, ratings FROM levels WHERE id = ?').bind(id).first();
  return { stars: s, rating: r.ratings ? Math.round((r.rating_sum / r.ratings) * 10) / 10 : null, ratings: r.ratings, at: t };
}

/** A player reports a level (once each); enough reports hide it. */
export async function report(db, id, uid, reason, t = now()) {
  if (!uid || isGuest(uid)) throw new LevelError(401, 'Sign in to report.', 'guest');
  const l = await db.prepare('SELECT id, user_id FROM levels WHERE id = ?').bind(id).first();
  if (!l) throw new LevelError(404, 'No such level.', 'not_found');
  if (l.user_id === uid) throw new LevelError(400, 'You cannot report your own level.', 'own');
  const r = await db.prepare('INSERT OR IGNORE INTO level_reports (level_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)').bind(id, uid, line(reason, 200) || null, t).run();
  if (!r.meta?.changes) return { reported: true };
  await db.prepare('UPDATE levels SET reports = reports + 1 WHERE id = ?').bind(id).run();
  await db.prepare("UPDATE levels SET hidden_at = ?, hidden_by = 'reports' WHERE id = ? AND hidden_at IS NULL AND reports >= ?").bind(t, id, LIMITS.reports_hide).run();
  return { reported: true };
}

/** Hides or shows a level: the game's creator or an admin. A level an admin hid stays hidden for the creator. */
export async function setHidden(db, id, uid, hidden, admin = false, t = now()) {
  const l = await db.prepare('SELECT l.id, l.hidden_by, p.owner_id FROM levels l JOIN projects p ON p.id = l.project_id WHERE l.id = ?').bind(id).first();
  if (!l) throw new LevelError(404, 'No such level.', 'not_found');
  if (l.owner_id !== uid && !admin) throw new LevelError(403, 'Only the game\'s creator can hide its levels.', 'forbidden');
  if (!hidden && l.hidden_by === 'admin' && !admin) throw new LevelError(403, 'An admin hid this level.', 'forbidden');
  if (hidden) await db.prepare('UPDATE levels SET hidden_at = COALESCE(hidden_at, ?), hidden_by = ? WHERE id = ?').bind(t, admin && l.owner_id !== uid ? 'admin' : 'creator', id).run();
  else await db.batch([db.prepare('UPDATE levels SET hidden_at = NULL, hidden_by = NULL, reports = 0 WHERE id = ?').bind(id), db.prepare('DELETE FROM level_reports WHERE level_id = ?').bind(id)]);
}

/** Deletes a level: its maker or an admin. */
export async function remove(db, id, uid, admin = false) {
  const l = await db.prepare('SELECT id, user_id FROM levels WHERE id = ?').bind(id).first();
  if (!l) throw new LevelError(404, 'No such level.', 'not_found');
  if (l.user_id !== uid && !admin) throw new LevelError(403, 'Only its maker can delete a level.', 'forbidden');
  await db.batch(levelGone(db, id));
}
const levelGone = (db, id) => [
  db.prepare('DELETE FROM level_plays WHERE level_id = ?').bind(id),
  db.prepare('DELETE FROM level_reports WHERE level_id = ?').bind(id),
  db.prepare('DELETE FROM levels WHERE id = ?').bind(id),
];

/** Reported levels waiting for an admin: hidden by reports, newest first. */
export async function reported(db, limit = 50) {
  const rows = (await db.prepare(`SELECT ${COLS}, p.title AS game_title ${FROM} WHERE l.reports > 0 AND (l.hidden_by IS NULL OR l.hidden_by = 'reports') ORDER BY l.reports DESC, l.created_at DESC LIMIT ?`).bind(Math.min(100, limit)).all()).results || [];
  return rows.map((l) => ({ ...view(l, null, true, null), game: { id: l.project_id, slug: l.slug, title: l.game_title } }));
}

/** The creator turns level sharing on or off for their game (shared levels stay until they hide them). */
export async function setLevelsOff(db, projectId, off) { await db.prepare('UPDATE projects SET levels_off = ? WHERE id = ?').bind(off ? 1 : 0, projectId).run(); }

/** Deleting an account: its levels and everything about them, its plays, ratings and reports (ratings come off the levels). */
export function deleteStatements(db, uid) {
  return [
    db.prepare(`UPDATE levels SET rating_sum = rating_sum - COALESCE((SELECT stars FROM level_plays lp WHERE lp.level_id = levels.id AND lp.user_id = ?1), 0),
      ratings = ratings - (SELECT COUNT(*) FROM level_plays lp WHERE lp.level_id = levels.id AND lp.user_id = ?1 AND lp.stars IS NOT NULL)
      WHERE id IN (SELECT level_id FROM level_plays WHERE user_id = ?1 AND stars IS NOT NULL)`).bind(uid),
    db.prepare('DELETE FROM level_plays WHERE user_id = ? OR level_id IN (SELECT id FROM levels WHERE user_id = ?)').bind(uid, uid),
    db.prepare('DELETE FROM level_reports WHERE user_id = ? OR level_id IN (SELECT id FROM levels WHERE user_id = ?)').bind(uid, uid),
    db.prepare('DELETE FROM levels WHERE user_id = ?').bind(uid),
  ];
}

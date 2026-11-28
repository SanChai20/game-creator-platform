// Clips: short recordings of a game that players make while they play it and share by link. The SDK records the frame
// the game hands over (GCP.test.onCapture, else its canvases) when the player presses Record clip on the platform page,
// and the page uploads it here. Plain JS over a D1-shaped database (tests/clips.mjs); the API stores the video in R2.
//
// Rules, enforced here and nowhere else:
//   - Signed-in players only (not guests), of a live, listed game that is not adults-only and whose creator has not turned
//     clips off. Video only, webm or mp4, 1 to 31 seconds, at most 25 MB. At most 30 clips per account and 20 a day.
//   - A clip is public by its link and listed on its game's page. Its maker or an admin deletes it; the game's creator
//     hides it. Three reports by different players hide it until an admin looks at it.

export const LIMITS = { bytes: 25 * 1024 * 1024, min_ms: 1000, max_ms: 31000, per_user: 30, per_day: 20, title: 80, reports_hide: 3 };
export const TYPES = { 'video/webm': 'webm', 'video/mp4': 'mp4' };

export class ClipError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const now = () => Date.now();
const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const rid = () => 'clp_' + [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);

/** Whether a game takes clips: the game row (id, status, hidden_at, age, clips_off). Adults-only is age 18 and up. */
export const clipsOpen = (p) => !!p && p.status === 'live' && !p.hidden_at && !((p.age || 0) >= 18) && !p.clips_off;

/** Checks an upload before it is stored, and returns the row to store: { id, r2_key, ... }. */
export async function prepareClip(db, uid, p, raw = {}, t = now()) {
  if (!uid) throw new ClipError(401, 'Sign in to save clips.', 'unauthenticated');
  if (!clipsOpen(p)) throw new ClipError(403, 'This game does not take clips.', 'clips_off');
  const type = String(raw.type || '').split(';')[0].trim().toLowerCase();
  if (!TYPES[type]) throw new ClipError(415, 'A clip is a WebM or MP4 video.', 'bad_type');
  const bytes = Math.floor(+raw.bytes || 0), ms = Math.floor(+raw.ms || 0);
  if (bytes <= 0) throw new ClipError(400, 'The clip is empty.', 'empty');
  if (bytes > LIMITS.bytes) throw new ClipError(413, 'A clip can be at most 25 MB.', 'too_big');
  if (ms < LIMITS.min_ms || ms > LIMITS.max_ms) throw new ClipError(400, 'A clip is 1 to 30 seconds long.', 'bad_length');
  const n = await db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS day FROM clips WHERE user_id = ?').bind(t - 86400000, uid).first();
  if ((n?.n || 0) >= LIMITS.per_user) throw new ClipError(409, `You can keep at most ${LIMITS.per_user} clips. Delete one to save another.`, 'too_many');
  if ((n?.day || 0) >= LIMITS.per_day) throw new ClipError(429, 'You saved a lot of clips today. Try again tomorrow.', 'rate_limited');
  const id = rid();
  return { id, project_id: p.id, user_id: uid, r2_key: `clips/${id}.${TYPES[type]}`, type, bytes, ms, title: clean(raw.title, LIMITS.title) || null, created_at: t };
}

/** Records a clip whose video is stored. */
export async function addClip(db, row) {
  await db.prepare('INSERT INTO clips (id, project_id, user_id, r2_key, type, bytes, ms, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.project_id, row.user_id, row.r2_key, row.type, row.bytes, row.ms, row.title, row.created_at).run();
  return row;
}

const SELECT = `SELECT c.id, c.project_id, c.user_id, c.r2_key, c.type, c.bytes, c.ms, c.title, c.views, c.reports, c.hidden_at, c.hidden_by, c.created_at,
  p.slug, p.title AS game_title, p.owner_id, p.status, p.hidden_at AS game_hidden, p.age, p.clips_off, COALESCE(u.name, 'Player') AS by_name
  FROM clips c JOIN projects p ON p.id = c.project_id LEFT JOIN users u ON u.id = c.user_id`;

/** A clip as its page shows it, or null when it is gone or hidden from this viewer (the maker, the creator and admins still see a hidden one).
 * @param {any} db @param {string} id @param {string|null} [me] @param {boolean} [admin] */
export async function getClip(db, id, me = null, admin = false) {
  const c = await db.prepare(`${SELECT} WHERE c.id = ?`).bind(id).first();
  if (!c) return null;
  const own = !!me && me === c.user_id, creator = !!me && me === c.owner_id;
  const shown = !c.hidden_at && c.status === 'live' && !c.game_hidden && !((c.age || 0) >= 18);
  if (!shown && !own && !creator && !admin) return null;
  return view(c, me, admin);
}
const view = (c, me, admin) => ({
  id: c.id, title: c.title, ms: c.ms, type: c.type, bytes: c.bytes, views: c.views, created_at: c.created_at,
  by: { id: c.user_id, name: c.by_name }, game: { id: c.project_id, slug: c.slug, title: c.game_title },
  hidden: !!c.hidden_at, hidden_by: c.hidden_by || null,
  mine: !!me && me === c.user_id, can_hide: !!me && (me === c.owner_id || admin), can_delete: !!me && (me === c.user_id || admin),
  ...(admin ? { reports: c.reports } : {}),
});

/** The newest visible clips of a game (its page), at most 24.
 * @param {any} db @param {string} projectId @param {string|null} [me] @param {number} [limit] @returns {Promise<any[]>} */
export async function clipsOf(db, projectId, me = null, limit = 12) {
  const rows = (await db.prepare(`${SELECT} WHERE c.project_id = ? AND c.hidden_at IS NULL ORDER BY c.created_at DESC LIMIT ?`).bind(projectId, Math.min(24, Math.max(1, limit))).all()).results || [];
  return rows.map((c) => view(c, me, false));
}
/** The account's own clips, newest first. @returns {Promise<any[]>} */
export async function myClips(db, uid) {
  const rows = (await db.prepare(`${SELECT} WHERE c.user_id = ? ORDER BY c.created_at DESC LIMIT ?`).bind(uid, LIMITS.per_user).all()).results || [];
  return rows.map((c) => view(c, uid, false));
}

/** A view of the clip's page (counted once per call; the API rate-limits per viewer). */
export async function countView(db, id) { await db.prepare('UPDATE clips SET views = views + 1 WHERE id = ?').bind(id).run(); }

/** Deletes a clip (its maker or an admin). Returns the R2 key to remove. */
export async function deleteClip(db, id, uid, admin = false) {
  const c = await db.prepare('SELECT id, user_id, r2_key FROM clips WHERE id = ?').bind(id).first();
  if (!c) throw new ClipError(404, 'No such clip.', 'not_found');
  if (c.user_id !== uid && !admin) throw new ClipError(403, 'Only its maker can delete a clip.', 'forbidden');
  await db.batch([db.prepare('DELETE FROM clip_reports WHERE clip_id = ?').bind(id), db.prepare('DELETE FROM clips WHERE id = ?').bind(id)]);
  return c.r2_key;
}

/** Hides or shows a clip: the game's creator (hidden_by creator) or an admin. */
export async function setHidden(db, id, uid, hidden, admin = false, t = now()) {
  const c = await db.prepare('SELECT c.id, c.hidden_by, p.owner_id FROM clips c JOIN projects p ON p.id = c.project_id WHERE c.id = ?').bind(id).first();
  if (!c) throw new ClipError(404, 'No such clip.', 'not_found');
  if (c.owner_id !== uid && !admin) throw new ClipError(403, 'Only the game\'s creator can hide its clips.', 'forbidden');
  if (!hidden && c.hidden_by === 'admin' && !admin) throw new ClipError(403, 'An admin hid this clip.', 'forbidden');
  if (hidden) await db.prepare('UPDATE clips SET hidden_at = COALESCE(hidden_at, ?), hidden_by = ? WHERE id = ?').bind(t, admin && c.owner_id !== uid ? 'admin' : 'creator', id).run();
  else await db.prepare('UPDATE clips SET hidden_at = NULL, hidden_by = NULL, reports = 0 WHERE id = ?').bind(id).run();
  if (!hidden) await db.prepare('DELETE FROM clip_reports WHERE clip_id = ?').bind(id).run();
}

/** A player reports a clip (once each); enough reports hide it. */
export async function reportClip(db, id, uid, reason, t = now()) {
  if (!uid) throw new ClipError(401, 'Sign in to report.', 'unauthenticated');
  const c = await db.prepare('SELECT id, user_id FROM clips WHERE id = ?').bind(id).first();
  if (!c) throw new ClipError(404, 'No such clip.', 'not_found');
  if (c.user_id === uid) throw new ClipError(400, 'You cannot report your own clip.', 'own');
  const r = await db.prepare('INSERT OR IGNORE INTO clip_reports (clip_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)').bind(id, uid, clean(reason, 200) || null, t).run();
  if (!r.meta?.changes) return { reported: true };
  await db.prepare('UPDATE clips SET reports = reports + 1 WHERE id = ?').bind(id).run();
  await db.prepare("UPDATE clips SET hidden_at = ?, hidden_by = 'reports' WHERE id = ? AND hidden_at IS NULL AND reports >= ?").bind(t, id, LIMITS.reports_hide).run();
  return { reported: true };
}

/** The creator turns clips on or off for their game (existing clips stay until they hide them). */
export async function setClipsOff(db, projectId, off) { await db.prepare('UPDATE projects SET clips_off = ? WHERE id = ?').bind(off ? 1 : 0, projectId).run(); }

/** The R2 keys of an account's clips (deleted with the account). */
export async function keysOf(db, uid) { return ((await db.prepare('SELECT r2_key FROM clips WHERE user_id = ?').bind(uid).all()).results || []).map((r) => r.r2_key); }
export function deleteStatements(db, uid) {
  return [
    db.prepare('DELETE FROM clip_reports WHERE user_id = ? OR clip_id IN (SELECT id FROM clips WHERE user_id = ?)').bind(uid, uid),
    db.prepare('DELETE FROM clips WHERE user_id = ?').bind(uid),
  ];
}

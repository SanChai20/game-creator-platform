// Devlogs and patch notes: what a creator tells players about their game after it is out. A post is written from the
// console or by the creator's agent (MCP devlog); a patch note is handed to publish and posted when that version goes
// live (src/pipeline.ts). Each one shows on the game page and is announced under the bell to the game's audience:
// followers of its creator, and players who keep it in their library, bought it, or played it in the last 90 days.
// Plain JS over a D1-shaped database so the rules can be tested without a Worker (tests/devlogs.mjs).
//
// Rules: only the game's owner (or a collaborator who may publish, checked by the caller) writes; a game must be live for
// a post to be announced; a creator posts at most MAX_PER_DAY times a day per game, so the bell cannot be used to spam;
// the same player hears about one game at most once per post and never about their own post.

export const LIMITS = { title: 120, body: 5000, per_day: 3, audience_max: 20000, live_push_max: 500, played_days: 90, page: 10 };

export class DevlogError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const bad = (m, code = 'bad_request') => new DevlogError(400, m, code);
const rid = () => 'dl_' + [...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);

/** Trims and checks a title and body. Plain text with line breaks; links are shown as text. */
export function cleanPost(raw) {
  const title = String(raw?.title ?? '').replace(/\s+/g, ' ').trim();
  const body = String(raw?.body ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!title) throw bad('title is required.');
  if (title.length > LIMITS.title) throw bad(`title is ${title.length} characters; at most ${LIMITS.title}.`);
  if (!body) throw bad('body is required.');
  if (body.length > LIMITS.body) throw bad(`body is ${body.length} characters; at most ${LIMITS.body}.`);
  return { title, body };
}

/** Patch notes handed to publish: { title?, body } or a plain string. Null when absent. */
export function cleanPatchNotes(raw, version) {
  if (raw == null || raw === '') return null;
  const o = typeof raw === 'string' ? { body: raw } : raw;
  if (!o || typeof o !== 'object') throw bad('patch_notes must be a string or { title, body }.');
  return cleanPost({ title: o.title || `Version ${version}`, body: o.body });
}

/** The players a post about this game is announced to (never its author). */
const AUDIENCE = `SELECT follower_id AS uid FROM follows WHERE creator_id = ?2
  UNION SELECT user_id FROM library_games WHERE project_id = ?1
  UNION SELECT user_id FROM purchases WHERE project_id = ?1 AND status = 'paid'
  UNION SELECT user_id FROM player_games WHERE project_id = ?1 AND last_at >= ?3`;

/**
 * Writes a post and announces it. game: { id, owner_id, status }. Returns { id, notified, live: [user ids to push to] }.
 * kind 'patch' with a version is written once per version (a second call returns the first).
 * @param {any} db @param {any} game @param {string} author @param {any} raw
 * @param {{ kind?: string, version?: number | null, announce?: boolean, t?: number }} [opts]
 */
export async function postDevlog(db, game, author, raw, { kind = 'post', version = null, announce = true, t = Date.now() } = {}) {
  if (!game) throw new DevlogError(404, 'No such game.', 'not_found');
  const { title, body } = cleanPost(raw);
  if (kind === 'post') {
    const n = (await db.prepare('SELECT COUNT(*) AS n FROM devlogs WHERE project_id = ? AND created_at >= ?').bind(game.id, t - 86400_000).first())?.n || 0;
    if (n >= LIMITS.per_day) throw new DevlogError(429, `This game already has ${n} posts in the last 24 hours (at most ${LIMITS.per_day}).`, 'rate_limited');
  }
  const id = rid();
  const ins = await db.prepare(`INSERT INTO devlogs (id, project_id, author_id, kind, version, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`).bind(id, game.id, author, kind, version, title, body, t, t).run();
  if (!ins.meta?.changes) {
    const prev = await db.prepare("SELECT id FROM devlogs WHERE project_id = ? AND version = ? AND kind = 'patch'").bind(game.id, version).first();
    return { id: prev?.id || null, notified: 0, live: [], existing: true };
  }
  if (!announce || game.status !== 'live') return { id, notified: 0, live: [] };
  const data = JSON.stringify({ project: game.id, devlog: id });
  const since = t - LIMITS.played_days * 86400_000;
  const r = await db.prepare(`INSERT INTO notifications (user_id, kind, actor_id, data, created_at)
      SELECT a.uid, 'devlog', ?2, ?4, ?5 FROM (${AUDIENCE}) a JOIN users u ON u.id = a.uid AND u.status = 'active'
      WHERE a.uid != ?2 AND a.uid != ?6 LIMIT ?7`).bind(game.id, game.owner_id, since, data, t, author, LIMITS.audience_max).run();
  const notified = r.meta?.changes || 0;
  await db.prepare('UPDATE devlogs SET notified = ? WHERE id = ?').bind(notified, id).run();
  const live = notified ? await db.prepare(`SELECT a.uid AS id FROM (${AUDIENCE}) a JOIN users u ON u.id = a.uid AND u.status = 'active'
      WHERE a.uid != ?2 AND a.uid != ?4 LIMIT ?5`).bind(game.id, game.owner_id, since, author, LIMITS.live_push_max).all() : { results: [] };
  return { id, notified, live: live.results.map((x) => x.id) };
}

/** One page of a game's posts, newest first. before: the created_at of the last one shown.
 * @param {any} db @param {string} projectId @param {{ limit?: number, before?: number | string | null }} [opts] */
export async function listDevlogs(db, projectId, { limit = LIMITS.page, before = null } = {}) {
  const n = Math.max(1, Math.min(50, Number(limit) || LIMITS.page));
  const rows = await db.prepare(`SELECT d.id, d.kind, d.version, d.title, d.body, d.notified, d.created_at, d.updated_at, u.name AS author
      FROM devlogs d LEFT JOIN users u ON u.id = d.author_id WHERE d.project_id = ?1 ${before ? 'AND d.created_at < ?3' : ''}
      ORDER BY d.created_at DESC, d.id DESC LIMIT ?2`).bind(projectId, n + 1, ...(before ? [Number(before)] : [])).all();
  const list = rows.results.slice(0, n).map((r) => ({ id: r.id, kind: r.kind, version: r.version, title: r.title, body: r.body, author: r.author || '', notified: r.notified, created_at: r.created_at, ...(r.updated_at !== r.created_at ? { edited_at: r.updated_at } : {}) }));
  return { devlogs: list, more: rows.results.length > n ? list[list.length - 1].created_at : null };
}

/** Edits a post's text (no new announcement). */
export async function editDevlog(db, projectId, id, raw, t = Date.now()) {
  const { title, body } = cleanPost(raw);
  const r = await db.prepare('UPDATE devlogs SET title = ?, body = ?, updated_at = ? WHERE id = ? AND project_id = ?').bind(title, body, t, String(id), projectId).run();
  if (!r.meta?.changes) throw new DevlogError(404, 'No such post on this game.', 'not_found');
  return { ok: true, id };
}

/** Deletes a post and its unread announcements. */
export async function deleteDevlog(db, projectId, id) {
  const r = await db.prepare('DELETE FROM devlogs WHERE id = ? AND project_id = ?').bind(String(id), projectId).run();
  if (!r.meta?.changes) throw new DevlogError(404, 'No such post on this game.', 'not_found');
  await db.prepare("DELETE FROM notifications WHERE kind = 'devlog' AND data = ?").bind(JSON.stringify({ project: projectId, devlog: String(id) })).run();
  return { ok: true };
}

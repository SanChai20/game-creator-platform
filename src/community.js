// Creator replies to reviews, and each game's community board. Plain JS over a D1-shaped database (tests/community.mjs).
//
// Rules, enforced here and nowhere else:
//   - Review replies: the game's creator (or an admin) writes one public reply per review, up to 1000 characters, and can
//     change or remove it. The reviewer hears about it under the bell. A hidden review's reply is not shown.
//   - The board: signed-in players start threads (title 3 to 100 characters, body up to 2000) and reply to them (up to
//     2000), at most 20 posts an hour each. The creator can switch the board off; then nothing new can be posted and it is
//     not shown. Accounts that are not active cannot post.
//   - The creator pins (at most 3) and locks threads, and hides or restores any post on their board; an admin can too.
//     Authors edit their own posts and remove them. Hiding a thread hides its replies with it.
//   - Players report a post once each; at 3 reports it is hidden until the creator or an admin restores it.
//   - A thread's author hears about replies under the bell, once per thread until they look at it again.

export const LIMITS = { reply: 1000, title_min: 3, title: 100, body: 2000, per_hour: 20, pinned: 3, report_hide: 3, page: 20 };
export const REPORT_REASONS = ['spam', 'harassment', 'hate', 'spoilers', 'off_topic', 'other'];

export class CommunityError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const now = () => Date.now();
const text = (v, n) => String(v ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);
const line = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const rid = () => 'bp_' + [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
const isMod = (p, viewer) => !!viewer && (viewer.id === p.owner_id || viewer.role === 'admin');

// ----- review replies -----------------------------------------------------------------------------------------------
/** The creator's reply to one review: creates or changes it. */
export async function replyToReview(db, p, viewer, reviewer, body, t = now()) {
  if (!isMod(p, viewer)) throw new CommunityError(403, 'Only the game\'s creator can reply to its reviews.', 'forbidden');
  const b = text(body, LIMITS.reply);
  if (!b) throw new CommunityError(400, 'Write a reply first.', 'bad_request');
  const r = await db.prepare('SELECT hidden FROM reviews WHERE project_id = ? AND user_id = ?').bind(p.id, reviewer).first();
  if (!r) throw new CommunityError(404, 'No such review.', 'not_found');
  if (reviewer === viewer.id) throw new CommunityError(409, 'You cannot reply to your own review.', 'own');
  const had = await db.prepare('SELECT 1 AS x FROM review_replies WHERE project_id = ? AND user_id = ?').bind(p.id, reviewer).first();
  await db.prepare('INSERT INTO review_replies (project_id, user_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET body = excluded.body, author_id = excluded.author_id, updated_at = excluded.updated_at')
    .bind(p.id, reviewer, viewer.id, b, t, t).run();
  if (!had && !r.hidden) await db.prepare("INSERT INTO notifications (user_id, kind, actor_id, data, created_at) VALUES (?, 'review_reply', ?, json_object('project', ?), ?)").bind(reviewer, viewer.id, p.id, t).run();
  return { ok: true, created: !had };
}
export async function removeReviewReply(db, p, viewer, reviewer) {
  if (!isMod(p, viewer)) throw new CommunityError(403, 'Only the game\'s creator can remove its replies.', 'forbidden');
  const r = await db.prepare('DELETE FROM review_replies WHERE project_id = ? AND user_id = ?').bind(p.id, reviewer).run();
  if (!r.meta?.changes) throw new CommunityError(404, 'No reply to remove.', 'not_found');
  return { ok: true };
}
/** Adds each review's creator reply (or null), for the reviews shown on a page. */
export async function withReplies(db, projectId, reviews) {
  if (!reviews.length) return reviews;
  const ids = reviews.map((r) => r.user_id);
  const rows = (await db.prepare(`SELECT rr.user_id, rr.body, rr.created_at, rr.updated_at, u.name FROM review_replies rr JOIN users u ON u.id = rr.author_id WHERE rr.project_id = ? AND rr.user_id IN (${ids.map(() => '?').join(',')})`).bind(projectId, ...ids).all()).results;
  const by = new Map(rows.map((r) => [r.user_id, { body: r.body, name: r.name, created_at: r.created_at, updated_at: r.updated_at }]));
  return reviews.map((r) => ({ ...r, reply: by.get(r.user_id) ?? null }));
}

// ----- the board ----------------------------------------------------------------------------------------------------
async function canPost(db, p, viewer, t) {
  if (!viewer) throw new CommunityError(401, 'Sign in to post.', 'unauthenticated');
  if (p.board_off) throw new CommunityError(409, 'The creator switched this game\'s board off.', 'board_off');
  if (p.status !== 'live' && !isMod(p, viewer)) throw new CommunityError(404, 'No such game.', 'not_found');
  const u = await db.prepare('SELECT status FROM users WHERE id = ?').bind(viewer.id).first();
  if (!u || u.status !== 'active') throw new CommunityError(403, 'This account cannot post.', 'forbidden');
  const n = (await db.prepare('SELECT COUNT(*) AS n FROM board_posts WHERE user_id = ? AND created_at > ?').bind(viewer.id, t - 3600_000).first())?.n || 0;
  if (n >= LIMITS.per_hour) throw new CommunityError(429, 'You have posted a lot in the last hour. Try again a little later.', 'rate_limited');
}

/** Starts a thread: { title, body }. */
export async function startThread(db, p, viewer, raw = {}, t = now()) {
  await canPost(db, p, viewer, t);
  const title = line(raw.title, LIMITS.title), body = text(raw.body, LIMITS.body);
  if (title.length < LIMITS.title_min) throw new CommunityError(400, `A title has ${LIMITS.title_min} to ${LIMITS.title} characters.`, 'bad_request');
  if (!body) throw new CommunityError(400, 'Write something first.', 'bad_request');
  const id = rid();
  await db.prepare('INSERT INTO board_posts (id, project_id, user_id, title, body, created_at, updated_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, p.id, viewer.id, title, body, t, t, t).run();
  return { ok: true, id };
}

/** Replies to a thread. */
export async function reply(db, p, viewer, threadId, raw = {}, t = now()) {
  await canPost(db, p, viewer, t);
  const th = await db.prepare('SELECT * FROM board_posts WHERE id = ? AND project_id = ? AND thread_id IS NULL').bind(threadId, p.id).first();
  if (!th || (th.hidden_at && !isMod(p, viewer))) throw new CommunityError(404, 'No such thread.', 'not_found');
  if (th.locked && !isMod(p, viewer)) throw new CommunityError(409, 'This thread is locked.', 'locked');
  const body = text(raw.body, LIMITS.body);
  if (!body) throw new CommunityError(400, 'Write something first.', 'bad_request');
  const id = rid();
  await db.batch([
    db.prepare('INSERT INTO board_posts (id, project_id, thread_id, user_id, body, created_at, updated_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, p.id, th.id, viewer.id, body, t, t, t),
    db.prepare('UPDATE board_posts SET replies = replies + 1, last_at = ? WHERE id = ?').bind(t, th.id),
  ]);
  // the thread's author hears about it once, until they open the thread again (an unread notice for it stands)
  if (th.user_id !== viewer.id && !(await db.prepare("SELECT 1 AS x FROM notifications WHERE user_id = ? AND kind = 'board_reply' AND read_at IS NULL AND json_extract(data, '$.thread') = ?").bind(th.user_id, th.id).first()))
    await db.prepare("INSERT INTO notifications (user_id, kind, actor_id, data, created_at) VALUES (?, 'board_reply', ?, json_object('project', ?, 'thread', ?, 'title', ?), ?)").bind(th.user_id, viewer.id, p.id, th.id, th.title, t).run();
  return { ok: true, id };
}

const author = (r, p) => ({ id: r.user_id, name: r.name, creator: r.user_id === p.owner_id });
const shape = (r, p, viewer) => {
  const hidden = !!r.hidden_at;
  return {
    id: r.id, title: r.title ?? undefined, body: hidden && !isMod(p, viewer) && r.user_id !== viewer?.id ? '' : r.body, author: author(r, p),
    pinned: !!r.pinned, locked: !!r.locked, replies: r.replies, created_at: r.created_at, updated_at: r.updated_at, last_at: r.last_at,
    hidden: hidden ? r.hidden_by || 'creator' : null, reports: isMod(p, viewer) ? r.reports : undefined, mine: !!viewer && r.user_id === viewer.id,
  };
};

/** The board's threads, pinned first, then by latest activity. Hidden threads only for the creator and admins. */
export async function threads(db, p, viewer, { offset = 0, limit = LIMITS.page } = {}) {
  const mod = isMod(p, viewer);
  const where = `b.project_id = ? AND b.thread_id IS NULL${mod ? '' : ' AND b.hidden_at IS NULL'}`;
  const rows = (await db.prepare(`SELECT b.*, u.name FROM board_posts b JOIN users u ON u.id = b.user_id WHERE ${where} ORDER BY b.pinned DESC, b.last_at DESC LIMIT ? OFFSET ?`).bind(p.id, limit, offset).all()).results;
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM board_posts b WHERE ${where}`).bind(p.id).first())?.n || 0;
  return { off: !!p.board_off, moderator: mod, total, threads: rows.map((r) => ({ ...shape(r, p, viewer), body: undefined, excerpt: r.hidden_at && !mod ? '' : r.body.slice(0, 160) })) };
}

/** One thread with its replies. Hidden replies show as removed to players, in full to the creator and admins. */
export async function thread(db, p, viewer, id) {
  const mod = isMod(p, viewer);
  const th = await db.prepare('SELECT b.*, u.name FROM board_posts b JOIN users u ON u.id = b.user_id WHERE b.id = ? AND b.project_id = ? AND b.thread_id IS NULL').bind(id, p.id).first();
  if (!th || (th.hidden_at && !mod && th.user_id !== viewer?.id)) throw new CommunityError(404, 'No such thread.', 'not_found');
  const rows = (await db.prepare('SELECT b.*, u.name FROM board_posts b JOIN users u ON u.id = b.user_id WHERE b.thread_id = ? ORDER BY b.created_at LIMIT 500').bind(th.id).all()).results;
  return { moderator: mod, off: !!p.board_off, thread: shape(th, p, viewer), posts: rows.map((r) => shape(r, p, viewer)) };
}

/** The author changes their post (a thread's title and body, or a reply's body). */
export async function editPost(db, p, viewer, id, raw = {}, t = now()) {
  const r = await db.prepare('SELECT * FROM board_posts WHERE id = ? AND project_id = ?').bind(id, p.id).first();
  if (!r || !viewer || r.user_id !== viewer.id) throw new CommunityError(404, 'No such post of yours.', 'not_found');
  if (r.hidden_at) throw new CommunityError(409, 'This post was hidden and cannot be changed.', 'hidden');
  const body = raw.body !== undefined ? text(raw.body, LIMITS.body) : r.body;
  const title = r.thread_id ? null : raw.title !== undefined ? line(raw.title, LIMITS.title) : r.title;
  if (!body || (!r.thread_id && title.length < LIMITS.title_min)) throw new CommunityError(400, 'A post needs a title (threads) and some text.', 'bad_request');
  await db.prepare('UPDATE board_posts SET title = ?, body = ?, updated_at = ? WHERE id = ?').bind(title, body, t, r.id).run();
  return { ok: true };
}

async function setHidden(db, r, hide, by, t) {
  if (!!r.hidden_at === hide) return;
  await db.prepare('UPDATE board_posts SET hidden_at = ?, hidden_by = ? WHERE id = ?').bind(hide ? t : null, hide ? by : null, r.id).run();
  if (r.thread_id) await db.prepare(`UPDATE board_posts SET replies = MAX(0, replies ${hide ? '- 1' : '+ 1'}) WHERE id = ?`).bind(r.thread_id).run();
}

/** The author takes down their own post. */
export async function removePost(db, p, viewer, id, t = now()) {
  const r = await db.prepare('SELECT * FROM board_posts WHERE id = ? AND project_id = ?').bind(id, p.id).first();
  if (!r || !viewer || r.user_id !== viewer.id) throw new CommunityError(404, 'No such post of yours.', 'not_found');
  await setHidden(db, r, true, 'author', t);
  return { ok: true };
}

/** The creator or an admin: { pinned?, locked?, hidden? } on a post. */
export async function moderatePost(db, p, viewer, id, raw = {}, t = now()) {
  if (!isMod(p, viewer)) throw new CommunityError(403, 'Only the game\'s creator can do that.', 'forbidden');
  const r = await db.prepare('SELECT * FROM board_posts WHERE id = ? AND project_id = ?').bind(id, p.id).first();
  if (!r) throw new CommunityError(404, 'No such post.', 'not_found');
  if ((raw.pinned !== undefined || raw.locked !== undefined) && r.thread_id) throw new CommunityError(400, 'Only threads are pinned or locked.', 'bad_request');
  if (raw.pinned) {
    const n = (await db.prepare('SELECT COUNT(*) AS n FROM board_posts WHERE project_id = ? AND thread_id IS NULL AND pinned = 1 AND id != ?').bind(p.id, r.id).first())?.n || 0;
    if (n >= LIMITS.pinned) throw new CommunityError(409, `At most ${LIMITS.pinned} threads are pinned. Unpin one first.`, 'too_many');
  }
  if (raw.pinned !== undefined) await db.prepare('UPDATE board_posts SET pinned = ? WHERE id = ?').bind(raw.pinned ? 1 : 0, r.id).run();
  if (raw.locked !== undefined) await db.prepare('UPDATE board_posts SET locked = ? WHERE id = ?').bind(raw.locked ? 1 : 0, r.id).run();
  if (raw.hidden !== undefined) {
    await setHidden(db, r, !!raw.hidden, viewer.id === p.owner_id ? 'creator' : 'admin', t);
    if (!raw.hidden) await db.prepare('UPDATE board_posts SET reports = 0 WHERE id = ?').bind(r.id).run();
  }
  return { ok: true };
}

/** A player reports a post once; at 3 reports it is hidden until the creator or an admin restores it. */
export async function reportPost(db, p, viewer, id, reason, t = now()) {
  if (!viewer) throw new CommunityError(401, 'Sign in to report.', 'unauthenticated');
  if (!REPORT_REASONS.includes(reason)) throw new CommunityError(400, `reason must be one of ${REPORT_REASONS.join(', ')}.`, 'bad_request');
  const r = await db.prepare('SELECT * FROM board_posts WHERE id = ? AND project_id = ?').bind(id, p.id).first();
  if (!r || r.hidden_at) throw new CommunityError(404, 'No such post.', 'not_found');
  if (r.user_id === viewer.id) throw new CommunityError(409, 'This is your own post.', 'own');
  const ins = await db.prepare('INSERT INTO board_reports (post_id, user_id, reason, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(r.id, viewer.id, reason, t).run();
  if (ins.meta?.changes) {
    await db.prepare('UPDATE board_posts SET reports = reports + 1 WHERE id = ?').bind(r.id).run();
    if (r.reports + 1 >= LIMITS.report_hide) await setHidden(db, r, true, 'reports', t);
  }
  return { ok: true };
}

/** The creator switches the board on or off. */
export async function setBoard(db, p, viewer, on) {
  if (!isMod(p, viewer)) throw new CommunityError(403, 'Only the game\'s creator can do that.', 'forbidden');
  await db.prepare('UPDATE projects SET board_off = ? WHERE id = ?').bind(on ? 0 : 1, p.id).run();
  return { ok: true, on: !!on };
}

/** Account deletion: the account's posts are hidden as removed by their author, reports and review replies they wrote go. */
export function deleteStatements(db, uid, t = now()) {
  return [
    db.prepare("UPDATE board_posts SET replies = MAX(0, replies - (SELECT COUNT(*) FROM board_posts r WHERE r.thread_id = board_posts.id AND r.user_id = ?1 AND r.hidden_at IS NULL)) WHERE id IN (SELECT thread_id FROM board_posts WHERE user_id = ?1 AND thread_id IS NOT NULL)").bind(uid),
    db.prepare("UPDATE board_posts SET hidden_at = COALESCE(hidden_at, ?2), hidden_by = COALESCE(hidden_by, 'author'), body = '' WHERE user_id = ?1").bind(uid, t),
    db.prepare('DELETE FROM board_reports WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM review_replies WHERE user_id = ? OR author_id = ?').bind(uid, uid),
  ];
}

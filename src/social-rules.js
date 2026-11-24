// Friends, requests, blocks, privacy, direct messages, game invites, notifications and reports: the rules, as plain JS
// over a D1-shaped database, so tests/social.mjs runs them against SQLite with the real migrations. Who is online lives
// in each account's SocialHub Durable Object (src/social.ts); the routes that join the two are src/routes/social.ts
// (the web app) and /api/rt/friends in src/routes/rt.ts (games, through the SDK).
//
// The rules:
//   - Only active accounts take part. Guests never do (they have no account to befriend).
//   - A friendship needs a request and the other person's yes. Two people who ask each other are friends at once.
//   - Requests follow the receiver's choice: everyone, friends of friends, or nobody. Both sides have a friend cap, and
//     a sender has a cap of requests waiting.
//   - A block ends the friendship, every request and every open invite both ways, and hides each from the other's search.
//     Neither can then ask, message or invite the other.
//   - Messages and invites go only between friends, and only when the receiver allows them. Invites also need the
//     receiver to be online, away or busy (checked by the caller against their hub: Invisible and Offline cannot be invited,
//     and a Busy friend gets the invite quietly, without a pop-up).
//   - An invite to a match carries the private lobby the inviter is in; only an accepted invite lets its receiver in.


/** A game as friends, invites and chat show it: its name in every platform language its listing is in (only those the
 *  live version is played in), so each viewer sees it in theirs (web/src/lib.tsx shown; src/listing.ts does the same
 *  for the store). */
export function gameRef(r, id = r.id) {
  const g = id === null ? { slug: r.slug, title: r.title } : { id, slug: r.slug, title: r.title };
  let all = {};
  try { all = JSON.parse(r.listing_i18n || '{}') || {}; } catch { /* stored as written */ }
  const langs = String(r.langs || '').split(',').filter(Boolean), i18n = {};
  for (const [k, v] of Object.entries(all)) if (v && v.title && (!langs.length || langs.includes(k))) i18n[k] = { title: v.title };
  if (r.listing_lang) g.lang = r.listing_lang;
  if (Object.keys(i18n).length) g.i18n = i18n;
  return g;
}
const GAME_COLS = 'p.listing_i18n, p.listing_lang, p.langs';

export class SocialError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const err = (status, code, message) => new SocialError(status, code, message);

export const LIMITS = { friends_max: 300, requests_pending_max: 100, message_max: 500, search_max: 20, report_detail_max: 1000 };
export const STATUSES = ['online', 'away', 'busy', 'invisible'];
export const PRIVACY = {
  requests_from: ['everyone', 'friends_of_friends', 'nobody'],
  messages_from: ['friends', 'nobody'],
  invites_from: ['friends', 'nobody'],
};
/** Who can be invited: anyone with a page open and not Invisible. Busy friends get the invite quietly (no pop-up). */
export const INVITABLE = ['online', 'away', 'busy'];
/** The notifications the Friends panel shows (Requests). Every other kind is under the bell (src/follows.js). */
export const FRIEND_KINDS = ['friend_request', 'friend_accepted'];
export const REPORT_REASONS = ['spam', 'harassment', 'hate', 'cheating', 'name', 'other'];
/** How long an invite can be answered: a match lobby goes stale quickly, a plain "come and play" less so. */
export const INVITE_TTL_MS = { match: 10 * 60 * 1000, game: 60 * 60 * 1000, join: 10 * 60 * 1000 };
/** How long after accepting an invite its lobby can still be entered (the page may need a reload or a sign-in). */
export const ACCEPTED_USE_MS = 30 * 60 * 1000;

export const pairOf = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const now = () => Date.now();
const rnd = (n) => { const b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); };
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newFriendCode = () => { const b = crypto.getRandomValues(new Uint8Array(8)); return [...b].map((x) => CODE_ALPHA[x % CODE_ALPHA.length]).join(''); };
/** A typed friend code (any case, with or without the dash or spaces) as stored, or null. */
export function cleanCode(q) { const c = String(q || '').toUpperCase().replace(/[\s-]/g, ''); return /^[A-Z0-9]{8}$/.test(c) ? c : null; }
export const showCode = (c) => (c && c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c || '');

async function exec(db, stmts) {
  if (!stmts.length) return;
  if (db.batch) await db.batch(stmts); else for (const s of stmts) await s.run();
}

// ---- profiles and privacy ---------------------------------------------------------------------------------------
const PROFILE_COLS = 'user_id, code, status, requests_from, messages_from, invites_from, show_game, joinable, searchable';
function view(p) {
  return p && { code: showCode(p.code), status: p.status, requests_from: p.requests_from, messages_from: p.messages_from, invites_from: p.invites_from, show_game: !!p.show_game, joinable: !!p.joinable, searchable: !!p.searchable };
}
export async function getProfile(db, uid) {
  return db.prepare(`SELECT ${PROFILE_COLS} FROM social_profiles WHERE user_id = ?`).bind(uid).first();
}
/** The account's profile, made on first use (accounts made after the migration get theirs here). */
export async function ensureProfile(db, user, t = now()) {
  const p = await getProfile(db, user.id);
  if (p) return p;
  for (let i = 0; i < 4; i++) {
    const r = await db.prepare('INSERT INTO social_profiles (user_id, code, name_lc, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
      .bind(user.id, newFriendCode(), String(user.name || '').toLowerCase().slice(0, 80), t).run().catch(() => ({ meta: { changes: 0 } }));
    if (r.meta.changes) break;   // a code taken by someone else (very rare): draw again
  }
  const made = await getProfile(db, user.id);
  if (!made) throw err(500, 'internal', 'Could not set up friends for this account.');
  return made;
}
export const profileView = view;
export async function updateProfile(db, uid, patch, t = now()) {
  const sets = [], args = [];
  if (patch.status !== undefined) { if (!STATUSES.includes(patch.status)) throw err(400, 'bad_request', `status must be one of: ${STATUSES.join(', ')}.`); sets.push('status = ?'); args.push(patch.status); }
  for (const k of Object.keys(PRIVACY)) if (patch[k] !== undefined) { if (!PRIVACY[k].includes(patch[k])) throw err(400, 'bad_request', `${k} must be one of: ${PRIVACY[k].join(', ')}.`); sets.push(`${k} = ?`); args.push(patch[k]); }
  for (const k of ['show_game', 'joinable', 'searchable']) if (patch[k] !== undefined) { if (typeof patch[k] !== 'boolean') throw err(400, 'bad_request', `${k} must be true or false.`); sets.push(`${k} = ?`); args.push(patch[k] ? 1 : 0); }
  if (!sets.length) return view(await getProfile(db, uid));
  await db.prepare(`UPDATE social_profiles SET ${sets.join(', ')}, updated_at = ? WHERE user_id = ?`).bind(...args, t, uid).run();
  return view(await getProfile(db, uid));
}
/** Keeps search by name in step when an account renames itself. */
export const renameStmt = (db, uid, name) => db.prepare('UPDATE social_profiles SET name_lc = ? WHERE user_id = ?').bind(String(name || '').toLowerCase().slice(0, 80), uid);

async function activeUser(db, id) {
  if (typeof id !== 'string' || !id || id.length > 64) return null;
  return db.prepare("SELECT id, name FROM users WHERE id = ? AND status = 'active'").bind(id).first();
}
async function blockedEither(db, a, b) {
  return !!(await db.prepare('SELECT 1 FROM blocks WHERE (user_id = ?1 AND blocked_id = ?2) OR (user_id = ?2 AND blocked_id = ?1) LIMIT 1').bind(a, b).first());
}
export async function areFriends(db, a, b) {
  return !!(await db.prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?').bind(a, b).first());
}
const friendCount = async (db, u) => (await db.prepare('SELECT COUNT(*) AS n FROM friendships WHERE user_id = ?').bind(u).first())?.n || 0;

/** What `other` is to `me`: self, friends, requested (I asked), incoming (they asked), blocked (I blocked), blocked_by, none. */
export async function relation(db, me, other) {
  if (me === other) return 'self';
  const r = await db.prepare(`SELECT
      EXISTS(SELECT 1 FROM blocks WHERE user_id = ?1 AND blocked_id = ?2) AS b1,
      EXISTS(SELECT 1 FROM blocks WHERE user_id = ?2 AND blocked_id = ?1) AS b2,
      EXISTS(SELECT 1 FROM friendships WHERE user_id = ?1 AND friend_id = ?2) AS f,
      EXISTS(SELECT 1 FROM friend_requests WHERE from_id = ?1 AND to_id = ?2) AS out,
      EXISTS(SELECT 1 FROM friend_requests WHERE from_id = ?2 AND to_id = ?1) AS inc`).bind(me, other).first();
  if (r.b1) return 'blocked'; if (r.b2) return 'blocked_by'; if (r.f) return 'friends'; if (r.inc) return 'incoming'; if (r.out) return 'requested';
  return 'none';
}

// ---- search -------------------------------------------------------------------------------------------------------
/** Players by friend code (exact, always) or by the start of their name (only those who allow it). Blocks hide both ways. */
export async function search(db, me, q) {
  const text = String(q || '').trim().slice(0, 40), code = cleanCode(text);
  const out = new Map();
  const hide = `AND u.id != ?1 AND u.status = 'active' AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = ?1 AND b.blocked_id = u.id) OR (b.user_id = u.id AND b.blocked_id = ?1))`;
  if (code) {
    const r = await db.prepare(`SELECT u.id, u.name, p.code FROM social_profiles p JOIN users u ON u.id = p.user_id WHERE p.code = ?2 ${hide}`).bind(me, code).first();
    if (r) out.set(r.id, r);
  }
  const lc = text.toLowerCase();
  if (lc.length >= 2) {
    // a range on the index instead of LIKE, which SQLite cannot serve from an index here
    const rows = await db.prepare(`SELECT u.id, u.name, p.code FROM social_profiles p JOIN users u ON u.id = p.user_id
        WHERE p.name_lc >= ?2 AND p.name_lc < ?3 AND p.searchable = 1 ${hide} ORDER BY p.name_lc LIMIT ?4`).bind(me, lc, lc + '￿', LIMITS.search_max).all();
    for (const r of rows.results) if (!out.has(r.id)) out.set(r.id, r);
  }
  const list = [...out.values()].slice(0, LIMITS.search_max);
  const res = [];
  for (const r of list) res.push({ id: r.id, name: r.name, relation: await relation(db, me, r.id) });
  return res;
}

// ---- requests and friendships ---------------------------------------------------------------------------------------
export async function sendRequest(db, me, to, limits = LIMITS, t = now()) {
  if (to === me) throw err(400, 'self', 'That is you.');
  const target = await activeUser(db, to);
  if (!target) throw err(404, 'not_found', 'No such player.');
  const rel = await relation(db, me, to);
  if (rel === 'friends') return { state: 'friends' };
  if (rel === 'requested') return { state: 'requested' };
  if (rel === 'blocked') throw err(409, 'blocked', 'You blocked this player. Unblock them first.');
  if (rel === 'blocked_by') throw err(403, 'not_allowed', 'This player is not taking friend requests.');
  if (rel === 'incoming') return { state: 'friends', accepted: await acceptRequest(db, me, to, limits, t) };
  const p = await getProfile(db, to);
  const from = p?.requests_from || 'everyone';
  if (from === 'nobody') throw err(403, 'not_allowed', 'This player is not taking friend requests.');
  if (from === 'friends_of_friends') {
    const mutual = await db.prepare('SELECT 1 FROM friendships a JOIN friendships b ON b.user_id = a.friend_id WHERE a.user_id = ? AND b.friend_id = ? LIMIT 1').bind(me, to).first();
    if (!mutual) throw err(403, 'not_allowed', 'This player takes friend requests only from friends of their friends.');
  }
  if (await friendCount(db, me) >= limits.friends_max) throw err(409, 'friends_full', `You have ${limits.friends_max} friends, the most there can be. Remove one first.`);
  if (await friendCount(db, to) >= limits.friends_max) throw err(409, 'friends_full', 'This player has as many friends as there can be.');
  const pending = (await db.prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE from_id = ?').bind(me).first())?.n || 0;
  if (pending >= limits.requests_pending_max) throw err(429, 'too_many_requests', `You have ${limits.requests_pending_max} requests waiting. Cancel some first.`);
  await exec(db, [
    db.prepare('INSERT INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(me, to, t),
    db.prepare("INSERT INTO notifications (user_id, kind, actor_id, created_at) VALUES (?, 'friend_request', ?, ?)").bind(to, me, t),
  ]);
  return { state: 'requested', notify: to };
}
export async function acceptRequest(db, me, from, limits = LIMITS, t = now()) {
  const req = await db.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').bind(from, me).first();
  if (!req) throw err(404, 'not_found', 'That request is no longer there.');
  if (!(await activeUser(db, from))) { await db.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?').bind(from, me).run(); throw err(404, 'not_found', 'That account no longer exists.'); }
  if (await friendCount(db, me) >= limits.friends_max) throw err(409, 'friends_full', `You have ${limits.friends_max} friends, the most there can be. Remove one first.`);
  if (await friendCount(db, from) >= limits.friends_max) throw err(409, 'friends_full', 'This player has as many friends as there can be.');
  await exec(db, [
    db.prepare('INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(me, from, t),
    db.prepare('INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(from, me, t),
    db.prepare('DELETE FROM friend_requests WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)').bind(me, from),
    db.prepare("UPDATE notifications SET read_at = ?3 WHERE user_id = ?1 AND actor_id = ?2 AND kind = 'friend_request' AND read_at IS NULL").bind(me, from, t),
    db.prepare("INSERT INTO notifications (user_id, kind, actor_id, created_at) VALUES (?, 'friend_accepted', ?, ?)").bind(from, me, t),
  ]);
  return { state: 'friends', notify: from };
}
export async function declineRequest(db, me, from, t = now()) {
  await exec(db, [
    db.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?').bind(from, me),
    db.prepare("UPDATE notifications SET read_at = ?3 WHERE user_id = ?1 AND actor_id = ?2 AND kind = 'friend_request' AND read_at IS NULL").bind(me, from, t),
  ]);
  return { ok: true };
}
export async function cancelRequest(db, me, to) {
  await exec(db, [
    db.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?').bind(me, to),
    db.prepare("DELETE FROM notifications WHERE user_id = ? AND actor_id = ? AND kind = 'friend_request' AND read_at IS NULL").bind(to, me),
  ]);
  return { ok: true };
}
const endTies = (db, a, b, t) => [
  db.prepare('DELETE FROM friendships WHERE (user_id = ?1 AND friend_id = ?2) OR (user_id = ?2 AND friend_id = ?1)').bind(a, b),
  db.prepare('DELETE FROM friend_requests WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)').bind(a, b),
  db.prepare("UPDATE game_invites SET status = 'cancelled', answered_at = ?3 WHERE status = 'sent' AND ((from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1))").bind(a, b, t),
];
export async function removeFriend(db, me, other, t = now()) {
  const was = await areFriends(db, me, other);
  await exec(db, endTies(db, me, other, t));
  return { ok: true, was };
}
export async function block(db, me, other, t = now()) {
  if (other === me) throw err(400, 'self', 'That is you.');
  if (!(await db.prepare('SELECT 1 FROM users WHERE id = ?').bind(other).first())) throw err(404, 'not_found', 'No such player.');
  const was = await areFriends(db, me, other);
  await exec(db, [...endTies(db, me, other, t), db.prepare('INSERT INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(me, other, t),
    db.prepare("UPDATE notifications SET read_at = ?3 WHERE user_id = ?1 AND actor_id = ?2 AND read_at IS NULL").bind(me, other, t),
    // a block also ends a follow either way (src/follows.js)
    db.prepare('DELETE FROM follows WHERE (follower_id = ?1 AND creator_id = ?2) OR (follower_id = ?2 AND creator_id = ?1)').bind(me, other)]);
  return { ok: true, was };
}
export async function unblock(db, me, other) {
  await db.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').bind(me, other).run();
  return { ok: true };
}
export async function friendIds(db, me, max = LIMITS.friends_max) {
  const r = await db.prepare('SELECT friend_id FROM friendships WHERE user_id = ? LIMIT ?').bind(me, max).all();
  return r.results.map((x) => x.friend_id);
}
export async function listFriends(db, me, max = LIMITS.friends_max) {
  const r = await db.prepare(`SELECT u.id, u.name, f.created_at AS since FROM friendships f JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = ? AND u.status = 'active' ORDER BY u.name COLLATE NOCASE LIMIT ?`).bind(me, max).all();
  return r.results.map((x) => ({ id: x.id, name: x.name, since: x.since }));
}
export async function listRequests(db, me) {
  const inc = await db.prepare(`SELECT u.id, u.name, r.created_at AS at FROM friend_requests r JOIN users u ON u.id = r.from_id WHERE r.to_id = ? AND u.status = 'active' ORDER BY r.created_at DESC LIMIT 200`).bind(me).all();
  const out = await db.prepare(`SELECT u.id, u.name, r.created_at AS at FROM friend_requests r JOIN users u ON u.id = r.to_id WHERE r.from_id = ? ORDER BY r.created_at DESC LIMIT 200`).bind(me).all();
  return { incoming: inc.results, outgoing: out.results };
}
export async function listBlocked(db, me) {
  const r = await db.prepare('SELECT u.id, u.name, b.created_at AS at FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ? ORDER BY b.created_at DESC LIMIT 500').bind(me).all();
  return r.results;
}

// ---- messages -------------------------------------------------------------------------------------------------------
export function cleanBody(s, max = LIMITS.message_max) {
  // control characters out (newlines kept), at most two blank lines in a row, trimmed, capped
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F‪-‮⁦-⁩]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
async function canReach(db, me, to, what) {
  if (to === me) throw err(400, 'self', 'That is you.');
  if (!(await activeUser(db, to))) throw err(404, 'not_found', 'No such player.');
  if (await blockedEither(db, me, to)) throw err(403, 'not_allowed', what === 'messages' ? 'You cannot message this player.' : 'You cannot invite this player.');
  if (!(await areFriends(db, me, to))) throw err(403, 'not_friends', what === 'messages' ? 'You can message only your friends.' : 'You can invite only your friends.');
  const p = await getProfile(db, to);
  if (p && p[what + '_from'] === 'nobody') throw err(403, 'not_allowed', what === 'messages' ? 'This player is not taking messages.' : 'This player is not taking invites.');
}
export async function sendMessage(db, me, to, body, t = now()) {
  const text = cleanBody(body);
  if (!text) throw err(400, 'bad_request', 'Write something first.');
  await canReach(db, me, to, 'messages');
  const r = await db.prepare("INSERT INTO dm_messages (pair, from_id, to_id, kind, body, created_at) VALUES (?, ?, ?, 'text', ?, ?) RETURNING id").bind(pairOf(me, to), me, to, text, t).first();
  return { id: r.id, from: me, to, kind: 'text', body: text, at: t, read: false };
}
function msgView(r) {
  const m = { id: r.id, from: r.from_id, to: r.to_id, kind: r.kind, body: r.body, at: r.created_at, read: !!r.read_at };
  if (r.kind === 'invite') m.invite = { id: r.invite_id, status: r.i_status || 'cancelled', game: r.slug ? gameRef(r, null) : null, expires_at: r.expires_at, label: (() => { try { return JSON.parse(r.i_data || '{}').label || ''; } catch { return ''; } })() };
  return m;
}
export async function conversation(db, me, other, before = null, limit = 50) {
  const n = Math.max(1, Math.min(100, Number(limit) || 50));
  const r = await db.prepare(`SELECT m.*, i.status AS i_status, i.data AS i_data, i.expires_at, p.slug, p.title, ${GAME_COLS} FROM dm_messages m
      LEFT JOIN game_invites i ON i.id = m.invite_id LEFT JOIN projects p ON p.id = i.project_id
      WHERE m.pair = ? ${before ? 'AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`).bind(...[pairOf(me, other), ...(before ? [Number(before)] : []), n + 1]).all();
  const rows = r.results.slice(0, n).reverse().map(msgView);
  return { messages: rows, more: r.results.length > n };
}
export async function markRead(db, me, other, t = now()) {
  const r = await db.prepare('UPDATE dm_messages SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL').bind(t, me, other).run();
  return { ok: true, read: r.meta.changes };
}

// ---- notifications and counts ---------------------------------------------------------------------------------------
export async function counts(db, me) {
  const chats = await db.prepare('SELECT from_id, COUNT(*) AS n FROM dm_messages WHERE to_id = ? AND read_at IS NULL GROUP BY from_id LIMIT 500').bind(me).all();
  const c = await db.prepare(`SELECT (SELECT COUNT(*) FROM friend_requests r JOIN users u ON u.id = r.from_id WHERE r.to_id = ?1 AND u.status = 'active') AS requests,
      (SELECT COUNT(*) FROM notifications WHERE user_id = ?1 AND read_at IS NULL AND kind IN ('friend_request', 'friend_accepted')) AS notes,
      (SELECT COUNT(*) FROM game_invites WHERE to_id = ?1 AND status = 'sent' AND expires_at > ?2) AS invites`).bind(me, now()).first();
  const per = {}; let messages = 0;
  for (const r of chats.results) { per[r.from_id] = r.n; messages += r.n; }
  return { messages, chats: per, requests: c.requests, notifications: c.notes, invites: c.invites };
}
export async function notificationList(db, me, limit = 30) {
  const r = await db.prepare(`SELECT n.id, n.kind, n.actor_id, u.name AS actor_name, n.created_at, n.read_at FROM notifications n JOIN users u ON u.id = n.actor_id
      WHERE n.user_id = ? AND n.kind IN ('friend_request', 'friend_accepted') ORDER BY n.id DESC LIMIT ?`).bind(me, Math.max(1, Math.min(100, limit))).all();
  return r.results.map((x) => ({ id: x.id, kind: x.kind, actor: { id: x.actor_id, name: x.actor_name }, at: x.created_at, read: !!x.read_at }));
}
export async function markNotificationsRead(db, me, t = now()) {
  // only the friends panel's own kinds: gift notifications (src/gifts.ts) are read where they are shown
  await db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND kind IN ('friend_request', 'friend_accepted')").bind(t, me).run();
  return { ok: true };
}

// ---- invites --------------------------------------------------------------------------------------------------------
const QUEUE_RE = /^[a-z0-9_-]{1,32}$/, MODE_RE = /^[a-z0-9_-]{0,32}$/;
/** What a match invite (or a joinable presence) may carry, cleaned. lobby: the signed private lobby (checked by the caller). */
export function cleanInviteData(d) {
  d = d && typeof d === 'object' ? d : {};
  const out = {};
  if (d.lobby != null) { const l = String(d.lobby); if (!/^[A-Za-z0-9._-]{10,400}$/.test(l)) throw err(400, 'bad_request', 'That match cannot be joined by invite.'); out.lobby = l; }
  if (d.queue != null) { if (!QUEUE_RE.test(String(d.queue))) throw err(400, 'bad_request', 'queue must be 1 to 32 characters: a-z, 0-9, _ or -.'); out.queue = String(d.queue); }
  if (d.mode != null && d.mode !== '') { if (!MODE_RE.test(String(d.mode))) throw err(400, 'bad_request', 'mode must be up to 32 characters: a-z, 0-9, _ or -.'); out.mode = String(d.mode); }
  for (const k of ['players', 'min', 'teams']) if (d[k] != null) { const n = Math.round(Number(d[k])); if (!(n >= 1 && n <= 64)) throw err(400, 'bad_request', `${k} must be between 1 and 64.`); out[k] = n; }
  if (d.label != null) { const l = cleanBody(d.label, 60).replace(/\n/g, ' '); if (l) out.label = l; }
  if (d.data !== undefined) { const j = JSON.stringify(d.data); if (j && j.length > 1000) throw err(400, 'bad_request', 'data must be under 1 KB of JSON.'); out.data = d.data; }
  return out;
}
/**
 * Sends an invite from `me` to friend `to` for one game. One invite waits per sender, receiver and game: a new one replaces
 * it. Also posts it into their chat. `online` is the receiver's status as their hub reports it to `me` (the caller asks).
 */
export async function createInvite(db, { from, to, project, env = 'live', kind = 'game', data = {}, online }, t = now()) {
  await canReach(db, from, to, 'invites');
  if (!INVITABLE.includes(online)) throw err(409, 'not_online', 'This friend is offline. Invites go only to friends who are online, away or busy.');
  const p = await db.prepare('SELECT id, slug, title, status, listing_i18n, listing_lang, langs FROM projects WHERE id = ?').bind(project).first();
  if (!p || (env === 'live' && p.status !== 'live')) throw err(409, 'offline', 'This game is not live.');
  const id = 'inv_' + rnd(10), clean = cleanInviteData(data), ttl = INVITE_TTL_MS[kind] || INVITE_TTL_MS.game;
  await exec(db, [
    db.prepare("UPDATE game_invites SET status = 'cancelled', answered_at = ? WHERE from_id = ? AND to_id = ? AND project_id = ? AND status = 'sent'").bind(t, from, to, project),
    db.prepare('INSERT INTO game_invites (id, from_id, to_id, project_id, env, kind, data, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'sent\', ?, ?)')
      .bind(id, from, to, project, env, kind, JSON.stringify(clean), t, t + ttl),
    db.prepare("INSERT INTO dm_messages (pair, from_id, to_id, kind, body, invite_id, created_at) VALUES (?, ?, ?, 'invite', '', ?, ?)").bind(pairOf(from, to), from, to, id, t),
  ]);
  return { id, from, to, game: gameRef(p), kind, label: clean.label || '', created_at: t, expires_at: t + ttl };
}
async function inviteRow(db, id) {
  if (typeof id !== 'string' || !/^inv_[a-f0-9]{20}$/.test(id)) return null;
  return db.prepare(`SELECT i.*, p.slug, p.title, ${GAME_COLS}, p.status AS p_status, u.name AS from_name FROM game_invites i JOIN projects p ON p.id = i.project_id JOIN users u ON u.id = i.from_id WHERE i.id = ?`).bind(id).first();
}
/** The receiver says yes or no. A yes returns where to go: the game and what the game is told (GCP.launch.join). */
export async function answerInvite(db, me, id, accept, t = now()) {
  const r = await inviteRow(db, id);
  if (!r || r.to_id !== me) throw err(404, 'not_found', 'No such invite.');
  if (r.status === 'accepted' && accept) return { invite: id, from: r.from_id, game: gameRef(r, r.project_id), join: joinOf(r) };
  if (r.status !== 'sent') throw err(409, 'gone', r.status === 'cancelled' ? 'This invite was withdrawn.' : 'You already answered this invite.');
  if (r.expires_at <= t) throw err(409, 'expired', 'This invite has expired.');
  if (accept && r.p_status !== 'live') throw err(409, 'offline', 'This game is not live any more.');
  await db.prepare('UPDATE game_invites SET status = ?, answered_at = ? WHERE id = ? AND status = \'sent\'').bind(accept ? 'accepted' : 'declined', t, id).run();
  await db.prepare('UPDATE dm_messages SET read_at = ? WHERE invite_id = ? AND read_at IS NULL').bind(t, id).run();
  return { invite: id, from: r.from_id, accepted: !!accept, game: gameRef(r, r.project_id), ...(accept ? { join: joinOf(r) } : {}) };
}
/** What the game is told about an accepted invite (GCP.launch.join and the 'join' event). The lobby itself stays hidden. */
export function joinOf(r) {
  let d = {}; try { d = JSON.parse(r.data || '{}'); } catch { /* bad row */ }
  const out = { id: r.id, kind: r.kind, from: { id: r.from_id, name: r.from_name || 'Player' }, match: !!d.lobby };
  for (const k of ['queue', 'players', 'min', 'teams', 'mode', 'label', 'data']) if (d[k] !== undefined) out[k] = d[k];
  return out;
}
/** An accepted invite to me for this game and environment, still usable: the lobby the matchmaker puts me in. */
export async function acceptedInvite(db, me, id, g, e, t = now()) {
  const r = await inviteRow(db, id);
  if (!r || r.to_id !== me || r.project_id !== g || r.env !== e || r.status !== 'accepted' || !r.answered_at || t - r.answered_at > ACCEPTED_USE_MS) return null;
  if (await blockedEither(db, me, r.from_id)) return null;
  let d = {}; try { d = JSON.parse(r.data || '{}'); } catch { return null; }
  return d.lobby ? { ...d, from: r.from_id } : null;
}
/**
 * A creator's invite to one of their own preview test bots (src/bots.ts): the same invite row a friend gets, in the
 * preview, so the bot enters the lobby through the real invite path (acceptedInvite). No friendship (a bot is nobody's
 * friend), no chat line, and no live-game check: the caller has checked that the bot is in the creator's running fleet.
 */
export async function createBotInvite(db, { from, to, project, kind = 'game', data = {} }, t = now()) {
  if (!/^bot_[a-z0-9]{8}_\d{1,2}$/.test(String(to))) throw err(400, 'bad_request', 'That is not a test bot.');
  const id = 'inv_' + rnd(10), clean = cleanInviteData(data), ttl = INVITE_TTL_MS[kind] || INVITE_TTL_MS.game;
  await exec(db, [
    db.prepare("UPDATE game_invites SET status = 'cancelled', answered_at = ? WHERE from_id = ? AND to_id = ? AND project_id = ? AND status = 'sent'").bind(t, from, to, project),
    db.prepare("INSERT INTO game_invites (id, from_id, to_id, project_id, env, kind, data, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'preview', ?, ?, 'sent', ?, ?)")
      .bind(id, from, to, project, kind, JSON.stringify(clean), t, t + ttl),
  ]);
  return { id, kind, label: clean.label || '', created_at: t, expires_at: t + ttl };
}
/** A test bot answers a preview invite: as answerInvite, without the live-game check (the preview is never live). */
export async function answerBotInvite(db, bot, id, accept, t = now()) {
  const r = await inviteRow(db, id);
  if (!r || r.to_id !== bot || r.env !== 'preview') throw err(404, 'not_found', 'No such invite.');
  if (r.status !== 'sent') throw err(409, 'gone', r.status === 'cancelled' ? 'This invite was withdrawn.' : 'This invite was already answered.');
  if (r.expires_at <= t) throw err(409, 'expired', 'This invite has expired.');
  await db.prepare('UPDATE game_invites SET status = ?, answered_at = ? WHERE id = ? AND status = \'sent\'').bind(accept ? 'accepted' : 'declined', t, id).run();
  return { invite: id, from: r.from_id, accepted: !!accept, game: gameRef(r, r.project_id), ...(accept ? { join: joinOf(r) } : {}) };
}
/** "Join" on a friend who offers a place: recorded as an invite the joiner has already accepted. */
export async function createJoin(db, { me, friend, project, env = 'live', data }, t = now()) {
  if (!(await areFriends(db, me, friend)) || await blockedEither(db, me, friend)) throw err(403, 'not_friends', 'You can join only your friends.');
  const p = await getProfile(db, friend);
  if (p && (!p.joinable || p.invites_from === 'nobody')) throw err(403, 'not_allowed', 'This friend does not let friends join.');
  const id = 'inv_' + rnd(10), clean = cleanInviteData(data);
  await db.prepare("INSERT INTO game_invites (id, from_id, to_id, project_id, env, kind, data, status, created_at, expires_at, answered_at) VALUES (?, ?, ?, ?, ?, 'join', ?, 'accepted', ?, ?, ?)")
    .bind(id, friend, me, project, env, JSON.stringify(clean), t, t + INVITE_TTL_MS.join, t).run();
  return joinOf({ id, kind: 'join', from_id: friend, from_name: (await activeUser(db, friend))?.name, data: JSON.stringify(clean) });
}
export async function pendingInvites(db, me, t = now()) {
  const r = await db.prepare(`SELECT i.*, p.slug, p.title, ${GAME_COLS}, u.name AS from_name FROM game_invites i JOIN projects p ON p.id = i.project_id JOIN users u ON u.id = i.from_id
      WHERE i.to_id = ? AND i.status = 'sent' AND i.expires_at > ? AND p.status = 'live' ORDER BY i.created_at DESC LIMIT 20`).bind(me, t).all();
  return r.results.map((x) => ({ id: x.id, from: { id: x.from_id, name: x.from_name }, game: gameRef(x, x.project_id), kind: x.kind, label: joinOf(x).label || '', created_at: x.created_at, expires_at: x.expires_at }));
}
export async function cancelInvite(db, me, id, t = now()) {
  const r = await db.prepare("UPDATE game_invites SET status = 'cancelled', answered_at = ? WHERE id = ? AND from_id = ? AND status = 'sent' RETURNING to_id").bind(t, id, me).first();
  return { ok: true, to: r?.to_id || null };
}

// ---- reports ----------------------------------------------------------------------------------------------------------
export async function report(db, me, target, reason, detail, messageIds = [], t = now()) {
  if (!REPORT_REASONS.includes(reason)) throw err(400, 'bad_request', `reason must be one of: ${REPORT_REASONS.join(', ')}.`);
  if (target === me) throw err(400, 'self', 'That is you.');
  if (!(await db.prepare('SELECT 1 FROM users WHERE id = ?').bind(target).first())) throw err(404, 'not_found', 'No such player.');
  const open = await db.prepare("SELECT 1 FROM social_reports WHERE reporter_id = ? AND target_id = ? AND status = 'open' AND created_at > ?").bind(me, target, t - 3600_000).first();
  if (open) return { ok: true, already: true };
  // the reported messages are copied now, so deleting or editing later changes nothing (only messages between the two)
  const ids = (Array.isArray(messageIds) ? messageIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);
  let msgs = [];
  if (ids.length) msgs = (await db.prepare(`SELECT id, from_id, body, created_at FROM dm_messages WHERE pair = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(pairOf(me, target), ...ids).all()).results;
  else msgs = (await db.prepare("SELECT id, from_id, body, created_at FROM dm_messages WHERE pair = ? AND from_id = ? AND kind = 'text' ORDER BY id DESC LIMIT 10").bind(pairOf(me, target), target).all()).results;
  const id = 'rep_' + rnd(8);
  await db.prepare('INSERT INTO social_reports (id, reporter_id, target_id, reason, detail, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, me, target, reason, cleanBody(detail, LIMITS.report_detail_max), JSON.stringify({ messages: msgs }), t).run();
  return { ok: true, id };
}

// ---- upkeep -----------------------------------------------------------------------------------------------------------
export function cleanupStmts(db, t = now(), keepDays = 365) {
  return [
    db.prepare('DELETE FROM dm_messages WHERE created_at < ?').bind(t - keepDays * 86400_000),
    db.prepare('DELETE FROM game_invites WHERE created_at < ? AND id NOT IN (SELECT invite_id FROM dm_messages WHERE invite_id IS NOT NULL)').bind(t - 7 * 86400_000),
    db.prepare('DELETE FROM notifications WHERE created_at < ?').bind(t - 90 * 86400_000),
  ];
}
/** Everything social an account leaves behind when it is deleted (its friends lose it; reports about it stay for admins). */
export function deleteAccountStmts(db, uid) {
  return [
    db.prepare('DELETE FROM social_profiles WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM friendships WHERE user_id = ?1 OR friend_id = ?1').bind(uid),
    db.prepare('DELETE FROM friend_requests WHERE from_id = ?1 OR to_id = ?1').bind(uid),
    db.prepare('DELETE FROM blocks WHERE user_id = ?1').bind(uid),
    db.prepare('DELETE FROM dm_messages WHERE from_id = ?1 OR to_id = ?1').bind(uid),
    db.prepare('DELETE FROM game_invites WHERE from_id = ?1 OR to_id = ?1').bind(uid),
    db.prepare('DELETE FROM notifications WHERE user_id = ?1 OR actor_id = ?1').bind(uid),
  ];
}

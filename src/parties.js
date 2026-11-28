// Parties: a small group of friends that stays together across games, with voice chat. Plain JS over a D1-shaped
// database (tests/parties.mjs); the routes (src/routes/social.ts) tell the members' pages when the party changes, and
// pass voice connection messages between members.
//
// Rules, enforced here and nowhere else:
//   - Signed-in accounts only, in one party at a time, at most 8 members. Anyone can start a party.
//   - A member invites their own friends; an invite lasts 10 minutes. Nobody joins a party where they and a member have
//     blocked each other. Accepting leaves the party the player was in.
//   - The leader brings the party into a game, removes members and hands leadership on. A leader who leaves passes it
//     to the member who has been in longest; the last one out ends the party.
//   - Voice is only between members. Voice messages go only from a member to another member of the same party.

export const LIMITS = { members: 8, invite_ms: 10 * 60 * 1000 };

export class PartyError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const now = () => Date.now();
const rid = () => 'pty_' + [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
const err = (s, c, m) => new PartyError(s, m, c);

/** The party id of an account, or null. */
export async function partyOf(db, uid) { return (await db.prepare('SELECT party_id FROM party_members WHERE user_id = ?').bind(uid).first())?.party_id || null; }
/** The members' ids of a party, longest in first. @returns {Promise<string[]>} */
export async function memberIds(db, pid) { return ((await db.prepare('SELECT user_id FROM party_members WHERE party_id = ? ORDER BY joined_at, user_id').bind(pid).all()).results || []).map((r) => r.user_id); }

/** The account's party as its page shows it, with the invites waiting for it. */
export async function view(db, uid, t = now()) {
  const pid = await partyOf(db, uid);
  const invites = ((await db.prepare(`SELECT i.party_id AS id, i.from_id, u.name AS from_name, i.expires_at, (SELECT COUNT(*) FROM party_members m WHERE m.party_id = i.party_id) AS size
    FROM party_invites i JOIN users u ON u.id = i.from_id WHERE i.user_id = ? AND i.expires_at > ? ORDER BY i.created_at DESC LIMIT 10`).bind(uid, t).all()).results || [])
    .filter((r) => r.size > 0).map((r) => ({ id: r.id, from: { id: r.from_id, name: r.from_name }, size: r.size, expires_at: r.expires_at }));
  if (!pid) return { party: null, invites, max: LIMITS.members };
  const p = await db.prepare('SELECT id, leader_id, game_slug FROM parties WHERE id = ?').bind(pid).first();
  const members = ((await db.prepare(`SELECT m.user_id AS id, COALESCE(u.name, 'Player') AS name, m.voice, m.joined_at FROM party_members m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.party_id = ? ORDER BY m.joined_at, m.user_id`).bind(pid).all()).results || []).map((m) => ({ id: m.id, name: m.name, voice: !!m.voice, leader: m.id === p?.leader_id }));
  const pending = ((await db.prepare('SELECT i.user_id AS id, COALESCE(u.name, \'Player\') AS name FROM party_invites i LEFT JOIN users u ON u.id = i.user_id WHERE i.party_id = ? AND i.expires_at > ?').bind(pid, t).all()).results || []);
  let game = null;
  if (p?.game_slug) game = await db.prepare("SELECT id, slug, title FROM projects WHERE slug = ? AND status = 'live'").bind(p.game_slug).first();
  return { party: { id: pid, leader: p?.leader_id || null, me_leader: p?.leader_id === uid, members, pending, game }, invites: invites.filter((i) => i.id !== pid), max: LIMITS.members };
}

/** Starts a party with the account as its leader (or returns the one it is in). */
export async function create(db, uid, t = now()) {
  if (!uid) throw err(401, 'unauthenticated', 'Sign in to start a party.');
  const pid = await partyOf(db, uid);
  if (pid) return { id: pid, created: false };
  const id = rid();
  await db.batch([
    db.prepare('INSERT INTO parties (id, leader_id, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(id, uid, t, t),
    db.prepare('INSERT INTO party_members (user_id, party_id, joined_at) VALUES (?, ?, ?)').bind(uid, id, t),
  ]);
  return { id, created: true };
}

async function blockedWithAny(db, uid, pid) {
  return !!(await db.prepare(`SELECT 1 FROM blocks b JOIN party_members m ON m.party_id = ?2 AND m.user_id != ?1
    WHERE (b.user_id = ?1 AND b.blocked_id = m.user_id) OR (b.blocked_id = ?1 AND b.user_id = m.user_id) LIMIT 1`).bind(uid, pid).first());
}

/** A member invites a friend (starting a party first when the inviter has none). Returns { party, to }. */
export async function invite(db, uid, to, t = now()) {
  if (!uid) throw err(401, 'unauthenticated', 'Sign in to start a party.');
  if (!to || to === uid) throw err(400, 'bad_request', 'Choose a friend to invite.');
  if (!(await db.prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?').bind(uid, to).first())) throw err(403, 'not_friends', 'You can invite only your friends to a party.');
  const { id: pid } = await create(db, uid, t);
  if ((await partyOf(db, to)) === pid) throw err(409, 'already_in', 'They are already in your party.');
  const size = (await db.prepare('SELECT COUNT(*) AS n FROM party_members WHERE party_id = ?').bind(pid).first())?.n || 0;
  if (size >= LIMITS.members) throw err(409, 'party_full', `A party has at most ${LIMITS.members} players.`);
  if (await blockedWithAny(db, to, pid)) throw err(403, 'blocked', 'They cannot join this party.');
  await db.prepare('INSERT OR REPLACE INTO party_invites (party_id, user_id, from_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(pid, to, uid, t, t + LIMITS.invite_ms).run();
  return { party: pid, to, expires_at: t + LIMITS.invite_ms };
}

/** Accepts an invite: leaves the party the account was in, joins this one. Returns { party, left } (left: the old party, if any). */
export async function accept(db, uid, pid, t = now()) {
  const inv = await db.prepare('SELECT from_id FROM party_invites WHERE party_id = ? AND user_id = ? AND expires_at > ?').bind(pid, uid, t).first();
  if (!inv) throw err(404, 'invite_gone', 'That invite has expired or was taken back.');
  const size = (await db.prepare('SELECT COUNT(*) AS n FROM party_members WHERE party_id = ?').bind(pid).first())?.n || 0;
  if (!size) { await db.prepare('DELETE FROM party_invites WHERE party_id = ?').bind(pid).run(); throw err(404, 'invite_gone', 'That party has ended.'); }
  if (size >= LIMITS.members) throw err(409, 'party_full', `A party has at most ${LIMITS.members} players.`);
  if (await blockedWithAny(db, uid, pid)) throw err(403, 'blocked', 'You cannot join this party.');
  const was = await partyOf(db, uid);
  let left = null;
  if (was && was !== pid) left = await leave(db, uid, t);
  if (was !== pid) await db.prepare('INSERT INTO party_members (user_id, party_id, joined_at) VALUES (?, ?, ?)').bind(uid, pid, t).run();
  await db.batch([db.prepare('DELETE FROM party_invites WHERE party_id = ? AND user_id = ?').bind(pid, uid), db.prepare('UPDATE parties SET updated_at = ? WHERE id = ?').bind(t, pid)]);
  return { party: pid, left };
}
export async function decline(db, uid, pid) { await db.prepare('DELETE FROM party_invites WHERE party_id = ? AND user_id = ?').bind(pid, uid).run(); return { ok: true }; }

/** Leaves the party. Returns { party, members (who are left), ended, leader }. */
export async function leave(db, uid, t = now()) {
  const pid = await partyOf(db, uid);
  if (!pid) return { party: null, members: [], ended: false, leader: null };
  await db.prepare('DELETE FROM party_members WHERE user_id = ?').bind(uid).run();
  const rest = await memberIds(db, pid);
  if (!rest.length) {
    await db.batch([db.prepare('DELETE FROM party_invites WHERE party_id = ?').bind(pid), db.prepare('DELETE FROM parties WHERE id = ?').bind(pid)]);
    return { party: pid, members: [], ended: true, leader: null };
  }
  const p = await db.prepare('SELECT leader_id FROM parties WHERE id = ?').bind(pid).first();
  const leader = p?.leader_id === uid ? rest[0] : p?.leader_id;
  await db.prepare('UPDATE parties SET leader_id = ?, updated_at = ? WHERE id = ?').bind(leader, t, pid).run();
  await db.prepare('DELETE FROM party_invites WHERE party_id = ? AND from_id = ?').bind(pid, uid).run();
  return { party: pid, members: rest, ended: false, leader };
}

async function asLeader(db, uid) {
  const pid = await partyOf(db, uid);
  if (!pid) throw err(404, 'no_party', 'You are not in a party.');
  const p = await db.prepare('SELECT leader_id FROM parties WHERE id = ?').bind(pid).first();
  if (p?.leader_id !== uid) throw err(403, 'not_leader', 'Only the party leader can do that.');
  return pid;
}
/** The leader removes a member. */
export async function kick(db, uid, member, t = now()) {
  const pid = await asLeader(db, uid);
  if (member === uid) throw err(400, 'bad_request', 'Leave the party instead.');
  if ((await partyOf(db, member)) !== pid) throw err(404, 'not_member', 'They are not in your party.');
  await db.prepare('DELETE FROM party_members WHERE user_id = ?').bind(member).run();
  await db.prepare('UPDATE parties SET updated_at = ? WHERE id = ?').bind(t, pid).run();
  return { party: pid };
}
/** The leader hands leadership to another member. */
export async function promote(db, uid, member, t = now()) {
  const pid = await asLeader(db, uid);
  if ((await partyOf(db, member)) !== pid) throw err(404, 'not_member', 'They are not in your party.');
  await db.prepare('UPDATE parties SET leader_id = ?, updated_at = ? WHERE id = ?').bind(member, t, pid).run();
  return { party: pid };
}
/** The leader brings the party into a live game (null: no game). Returns the game. */
export async function setGame(db, uid, slug, t = now()) {
  const pid = await asLeader(db, uid);
  const g = slug ? await db.prepare("SELECT id, slug, title FROM projects WHERE slug = ? AND status = 'live' AND hidden_at IS NULL").bind(String(slug)).first() : null;
  if (slug && !g) throw err(404, 'not_found', 'No such game.');
  await db.prepare('UPDATE parties SET game_slug = ?, updated_at = ? WHERE id = ?').bind(g ? g.slug : null, t, pid).run();
  return { party: pid, game: g };
}
/** Joins or leaves the party's voice chat. Returns { party, in_voice: ids of the others already in voice }. */
export async function setVoice(db, uid, on, t = now()) {
  const pid = await partyOf(db, uid);
  if (!pid) throw err(404, 'no_party', 'You are not in a party.');
  await db.prepare('UPDATE party_members SET voice = ?, voice_at = ? WHERE user_id = ?').bind(on ? 1 : 0, on ? t : null, uid).run();
  const others = ((await db.prepare('SELECT user_id FROM party_members WHERE party_id = ? AND voice = 1 AND user_id != ?').bind(pid, uid).all()).results || []).map((r) => r.user_id);
  return { party: pid, in_voice: others };
}
/** Whether a voice message may go from one account to another: both in the same party. */
export async function canSignal(db, from, to) {
  if (!from || !to || from === to) return false;
  const a = await partyOf(db, from);
  return !!a && a === (await partyOf(db, to));
}

export function deleteStatements(db, uid) {
  return [
    db.prepare('DELETE FROM party_invites WHERE user_id = ? OR from_id = ?').bind(uid, uid),
    db.prepare('UPDATE parties SET leader_id = COALESCE((SELECT m.user_id FROM party_members m WHERE m.party_id = parties.id AND m.user_id != ?1 ORDER BY m.joined_at LIMIT 1), leader_id) WHERE leader_id = ?1').bind(uid),
    db.prepare('DELETE FROM party_members WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM parties WHERE NOT EXISTS (SELECT 1 FROM party_members m WHERE m.party_id = parties.id)'),
  ];
}

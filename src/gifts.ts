// Gifts between friends. A player can buy a paid game for a friend, and can ask a friend to gift them one ("Gift me this"
// on the game page). Only friends can gift each other: neither side may have blocked the other, and both accounts must be
// active. The friend who pays goes through the same Stripe Checkout as any purchase, at the price the game sells for now
// (a running sale included), and the game lands with the recipient:
//   - the purchase row belongs to the recipient (purchases.user_id), with the payer in gifted_by, so the game is in the
//     recipient's library, counts as theirs everywhere and is never the payer's;
//   - the creator is credited exactly as for any sale (splitSale, the same hold), so the revenue share does not change;
//   - a game the recipient already owns, or made, cannot be gifted; if they come to own it while the checkout is open
//     (two friends paying at once), the second payment is given back at once (api.ts applySession), as for a buyer who
//     paid twice;
//   - gifts are non-refundable: the payer is told so at checkout and ticks it, the recipient has no Refund button, and
//     the admin refund refuses one (src/refunds.ts). A refund or chargeback made in Stripe itself still takes the game
//     back and the creator's credit, like any sale.
// Both sides are told: the asked friend gets the request, the asker hears when it is declined, and when a gift is paid
// the recipient gets "gift_received" and the payer "gift_sent" (the notifications table, and a live event or a push).
import { AppError, bad, forbidden, notFound, type Env, type Project } from './env';
import type { Settings } from './settings';
import { now, rid } from './util';

/** How long a gift request stays open before it lapses. */
export const GIFT_REQUEST_DAYS = 30;
/** Open gift requests one player may have at once, across all friends and games. */
export const GIFT_REQUESTS_OPEN_MAX = 20;
const NOTE_MAX = 200;

type GiftSettings = Pick<Settings, 'gifts_enabled' | 'paid_games_enabled'>;
type Game = Pick<Project, 'id' | 'slug' | 'title' | 'owner_id' | 'price_cents' | 'status'>;

export const giftsOn = (s: GiftSettings) => !!s.gifts_enabled && !!s.paid_games_enabled;

/** Why `a` and `b` cannot exchange gifts, or null when they can: friends, neither blocked, both accounts active. */
export async function giftBlocker(env: Env, a: string, b: string): Promise<'self' | 'not_friends' | 'blocked' | 'inactive' | null> {
  if (a === b) return 'self';
  const r = await env.DB.prepare(`SELECT
      EXISTS(SELECT 1 FROM friendships WHERE user_id = ?1 AND friend_id = ?2) AS f,
      EXISTS(SELECT 1 FROM blocks WHERE (user_id = ?1 AND blocked_id = ?2) OR (user_id = ?2 AND blocked_id = ?1)) AS bl,
      (SELECT COUNT(*) FROM users WHERE id IN (?1, ?2) AND status = 'active') AS act`).bind(a, b).first<{ f: number; bl: number; act: number }>();
  if (!r || r.act < 2) return 'inactive';
  if (r.bl) return 'blocked';
  if (!r.f) return 'not_friends';
  return null;
}

const BLOCKER_TEXT = {
  self: 'You cannot gift a game to yourself. Buy it instead.',
  not_friends: 'Gifts are only possible between friends.',
  blocked: 'Gifts are only possible between friends.',
  inactive: 'That player is not available.',
} as const;

/** Whether this player already has the game: bought, gifted or given by an admin (still paid), or made it. */
export async function hasGame(env: Env, userId: string, p: Pick<Project, 'id' | 'owner_id'>): Promise<boolean> {
  if (userId === p.owner_id) return true;
  return !!(await env.DB.prepare("SELECT 1 FROM purchases WHERE user_id = ? AND project_id = ? AND status = 'paid'").bind(userId, p.id).first());
}

function checkGame(s: GiftSettings, p: Game | null): asserts p is Game {
  if (!p) throw notFound('That game is not available.');
  if (!giftsOn(s)) throw forbidden('Gifts are turned off on this platform.');
  if (p.status !== 'live') throw new AppError(409, 'This game is offline.', 'offline');
  if (!(p.price_cents > 0)) throw bad('This game is free, so there is nothing to gift. Send your friend an invite instead.');
}

/**
 * Checks that `giver` may buy game `p` for `recipient` now. Throws with a code the page can show: gifts_off, not_friends,
 * already_owned (the recipient has it), own_game (the recipient made it).
 */
export async function checkGift(env: Env, s: GiftSettings, giver: string, recipient: string, p: Game | null): Promise<void> {
  checkGame(s, p);
  const why = await giftBlocker(env, giver, recipient);
  if (why) throw new AppError(why === 'inactive' ? 404 : 403, BLOCKER_TEXT[why], why === 'self' ? 'bad_request' : 'not_friends');
  if (recipient === p.owner_id) throw new AppError(409, 'Your friend made this game, so they already have it.', 'own_game');
  if (await hasGame(env, recipient, p)) throw new AppError(409, 'Your friend already owns this game.', 'already_owned');
}

export interface GiftRequestRow { id: string; from_id: string; to_id: string; project_id: string; note: string | null; status: string; purchase_id: string | null; created_at: number; expires_at: number; answered_at: number | null }

const notifyStmt = (env: Env, userId: string, kind: string, actorId: string, data: Record<string, unknown>, t: number) =>
  env.DB.prepare('INSERT INTO notifications (user_id, kind, actor_id, data, created_at) VALUES (?, ?, ?, ?, ?)').bind(userId, kind, actorId, JSON.stringify(data), t);
const gameData = (p: Pick<Project, 'id' | 'slug' | 'title'>) => ({ id: p.id, slug: p.slug, title: p.title });

/** `from` asks their friend `to` to gift them game `p`. One open request per friend and game. */
export async function askForGift(env: Env, s: GiftSettings, from: string, to: string, p: Game | null, note: unknown, t = now()): Promise<{ request: GiftRequestRow; created: boolean }> {
  checkGame(s, p);
  const why = await giftBlocker(env, from, to);
  if (why) throw new AppError(why === 'inactive' ? 404 : 403, why === 'self' ? 'Ask a friend, not yourself.' : BLOCKER_TEXT[why], why === 'self' ? 'bad_request' : 'not_friends');
  if (await hasGame(env, from, p)) throw new AppError(409, 'You already own this game.', 'already_owned');
  const open = await env.DB.prepare("SELECT * FROM gift_requests WHERE from_id = ? AND to_id = ? AND project_id = ? AND status = 'pending' AND expires_at > ?").bind(from, to, p.id, t).first<GiftRequestRow>();
  if (open) return { request: open, created: false };
  // a lapsed request still holds the unique index: close it first
  await env.DB.prepare("UPDATE gift_requests SET status = 'closed', answered_at = ? WHERE from_id = ? AND to_id = ? AND project_id = ? AND status = 'pending'").bind(t, from, to, p.id).run();
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM gift_requests WHERE from_id = ? AND status = 'pending' AND expires_at > ?").bind(from, t).first<{ n: number }>();
  if ((n?.n || 0) >= GIFT_REQUESTS_OPEN_MAX) throw new AppError(429, `You have ${GIFT_REQUESTS_OPEN_MAX} gift requests waiting already. Cancel one first.`, 'too_many');
  const text = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) : '';
  const row: GiftRequestRow = { id: 'gfr_' + rid(16), from_id: from, to_id: to, project_id: p.id, note: text || null, status: 'pending', purchase_id: null, created_at: t, expires_at: t + GIFT_REQUEST_DAYS * 86400000, answered_at: null };
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO gift_requests (id, from_id, to_id, project_id, note, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(row.id, from, to, p.id, row.note, 'pending', t, row.expires_at),
      notifyStmt(env, to, 'gift_request', from, { project: gameData(p), request: row.id, note: row.note }, t),
    ]);
  } catch (e) {
    // the same request sent twice at once: the other one won
    if (!/UNIQUE/i.test(String((e as Error).message))) throw e;
    const won = await env.DB.prepare("SELECT * FROM gift_requests WHERE from_id = ? AND to_id = ? AND project_id = ? AND status = 'pending'").bind(from, to, p.id).first<GiftRequestRow>();
    if (won) return { request: won, created: false };
    throw e;
  }
  return { request: row, created: true };
}

/** The friend who was asked declines. The asker is told. */
export async function declineGift(env: Env, me: string, id: string, t = now()): Promise<GiftRequestRow> {
  const r = await env.DB.prepare("SELECT * FROM gift_requests WHERE id = ? AND to_id = ? AND status = 'pending'").bind(id, me).first<GiftRequestRow>();
  if (!r) throw notFound('That gift request is no longer open.');
  const p = await env.DB.prepare('SELECT id, slug, title FROM projects WHERE id = ?').bind(r.project_id).first<Pick<Project, 'id' | 'slug' | 'title'>>();
  const upd = await env.DB.prepare("UPDATE gift_requests SET status = 'declined', answered_at = ? WHERE id = ? AND status = 'pending'").bind(t, id).run();
  if (!upd.meta.changes) throw notFound('That gift request is no longer open.');
  await env.DB.batch([
    readRequestNote(env, me, id, t),
    notifyStmt(env, r.from_id, 'gift_declined', me, { project: p ? gameData(p) : { id: r.project_id }, request: id }, t),
  ]);
  return { ...r, status: 'declined', answered_at: t };
}

/** The asker takes their request back. The friend's notification of it is marked read. */
export async function cancelGiftRequest(env: Env, me: string, id: string, t = now()): Promise<GiftRequestRow> {
  const r = await env.DB.prepare("SELECT * FROM gift_requests WHERE id = ? AND from_id = ? AND status = 'pending'").bind(id, me).first<GiftRequestRow>();
  if (!r) throw notFound('That gift request is no longer open.');
  await env.DB.batch([
    env.DB.prepare("UPDATE gift_requests SET status = 'cancelled', answered_at = ? WHERE id = ? AND status = 'pending'").bind(t, id),
    readRequestNote(env, r.to_id, id, t),
  ]);
  return { ...r, status: 'cancelled', answered_at: t };
}

const readRequestNote = (env: Env, userId: string, requestId: string, t: number) =>
  env.DB.prepare("UPDATE notifications SET read_at = ?3 WHERE user_id = ?1 AND kind = 'gift_request' AND read_at IS NULL AND json_extract(data, '$.request') = ?2").bind(userId, requestId, t);

/**
 * After a gift was paid and recorded (purchase `purchaseId`, now the recipient's): the request it answered is marked
 * gifted, every other open request of the recipient for that game is closed (they own it now), and both sides get a
 * notification. Safe to call more than once: only the first call notifies.
 */
export async function giftDelivered(env: Env, a: { purchaseId: string; giver: string; recipient: string; project: Pick<Project, 'id' | 'slug' | 'title'>; requestId?: string | null }, t = now()): Promise<boolean> {
  const done = await env.DB.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'gift_received' AND json_extract(data, '$.purchase') = ?").bind(a.recipient, a.purchaseId).first();
  if (done) return false;
  const data = { project: gameData(a.project), purchase: a.purchaseId };
  await env.DB.batch([
    // the request this gift answered: the one named at checkout, or else the recipient's open request to this friend
    env.DB.prepare("UPDATE gift_requests SET status = 'gifted', purchase_id = ?1, answered_at = ?2 WHERE from_id = ?3 AND to_id = ?4 AND project_id = ?5 AND status = 'pending'").bind(a.purchaseId, t, a.recipient, a.giver, a.project.id),
    env.DB.prepare("UPDATE gift_requests SET status = 'closed', answered_at = ?1 WHERE from_id = ?2 AND project_id = ?3 AND status = 'pending'").bind(t, a.recipient, a.project.id),
    env.DB.prepare("UPDATE notifications SET read_at = ?1 WHERE kind = 'gift_request' AND actor_id = ?2 AND read_at IS NULL AND json_extract(data, '$.project.id') = ?3").bind(t, a.recipient, a.project.id),
    notifyStmt(env, a.recipient, 'gift_received', a.giver, data, t),
    notifyStmt(env, a.giver, 'gift_sent', a.recipient, data, t),
  ]);
  return true;
}

/** Everything gift-related for one player: requests waiting for them, their own open requests, gifts in and out. */
export async function giftOverview(env: Env, me: string, t = now()) {
  const reqCols = `r.id, r.note, r.created_at, r.expires_at, p.id AS project_id, p.slug, p.title, p.price_cents, p.sale_price_cents, p.sale_starts_at, p.sale_ends_at, p.status AS game_status`;
  const [incoming, outgoing, received, sent] = await Promise.all([
    env.DB.prepare(`SELECT ${reqCols}, u.id AS user_id, u.name AS user_name,
        EXISTS(SELECT 1 FROM purchases x WHERE x.user_id = r.from_id AND x.project_id = r.project_id AND x.status = 'paid') AS owned
      FROM gift_requests r JOIN projects p ON p.id = r.project_id JOIN users u ON u.id = r.from_id
      WHERE r.to_id = ?1 AND r.status = 'pending' AND r.expires_at > ?2 AND u.status = 'active' AND EXISTS(SELECT 1 FROM friendships f WHERE f.user_id = r.to_id AND f.friend_id = r.from_id) ORDER BY r.created_at DESC LIMIT 50`).bind(me, t).all<any>(),
    env.DB.prepare(`SELECT ${reqCols}, u.id AS user_id, u.name AS user_name, 0 AS owned
      FROM gift_requests r JOIN projects p ON p.id = r.project_id JOIN users u ON u.id = r.to_id
      WHERE r.from_id = ?1 AND r.status = 'pending' AND r.expires_at > ?2 AND EXISTS(SELECT 1 FROM friendships f WHERE f.user_id = r.from_id AND f.friend_id = r.to_id) ORDER BY r.created_at DESC LIMIT 50`).bind(me, t).all<any>(),
    env.DB.prepare(`SELECT x.id, x.price_cents, x.status, x.created_at, p.slug, p.title, u.id AS user_id, u.name AS user_name
      FROM purchases x JOIN projects p ON p.id = x.project_id JOIN users u ON u.id = x.gifted_by
      WHERE x.user_id = ? AND x.gifted_by IS NOT NULL AND x.status != 'refunded' ORDER BY x.created_at DESC LIMIT 100`).bind(me).all<any>(),
    env.DB.prepare(`SELECT x.id, x.price_cents, x.status, x.created_at, p.slug, p.title, u.id AS user_id, u.name AS user_name
      FROM purchases x JOIN projects p ON p.id = x.project_id JOIN users u ON u.id = x.user_id
      WHERE x.gifted_by = ? AND (x.status = 'paid' OR x.status = 'disputed') ORDER BY x.created_at DESC LIMIT 100`).bind(me).all<any>(),
  ]);
  const req = (r: any) => ({
    id: r.id, note: r.note, created_at: r.created_at, expires_at: r.expires_at, friend: { id: r.user_id, name: r.user_name },
    game: { id: r.project_id, slug: r.slug, title: r.title, price_cents: r.price_cents, sale_price_cents: r.sale_price_cents, sale_starts_at: r.sale_starts_at, sale_ends_at: r.sale_ends_at, live: r.game_status === 'live' },
    owned: !!r.owned,
  });
  const gift = (g: any) => ({ id: g.id, price_cents: g.price_cents, status: g.status, created_at: g.created_at, friend: { id: g.user_id, name: g.user_name }, game: { slug: g.slug, title: g.title } });
  return { incoming: incoming.results.map(req), outgoing: outgoing.results.map(req), received: received.results.map(gift), sent: sent.results.map(gift) };
}

/** What the game page shows about gifts for this player and game: whether they can be given, and requests already open. */
export async function gameGiftState(env: Env, s: GiftSettings, me: string, p: Game, t = now()) {
  if (!giftsOn(s) || !(p.price_cents > 0) || p.status !== 'live') return null;
  const [asked, askedOf] = await Promise.all([
    env.DB.prepare("SELECT r.id, r.to_id AS user_id, u.name FROM gift_requests r JOIN users u ON u.id = r.to_id WHERE r.from_id = ? AND r.project_id = ? AND r.status = 'pending' AND r.expires_at > ?").bind(me, p.id, t).all<{ id: string; user_id: string; name: string }>(),
    env.DB.prepare("SELECT r.id, r.from_id AS user_id, u.name FROM gift_requests r JOIN users u ON u.id = r.from_id WHERE r.to_id = ? AND r.project_id = ? AND r.status = 'pending' AND r.expires_at > ? AND u.status = 'active'").bind(me, p.id, t).all<{ id: string; user_id: string; name: string }>(),
  ]);
  return {
    // the friends this player asked for this game, and the friends who asked this player for it
    asked: asked.results.map((r) => ({ request: r.id, friend: { id: r.user_id, name: r.name } })),
    asked_by: askedOf.results.map((r) => ({ request: r.id, friend: { id: r.user_id, name: r.name } })),
  };
}

/** Friends of `me` with, for one game, whether each can receive it as a gift (not owned, not its maker). */
export async function giftableFriends(env: Env, me: string, p: Pick<Project, 'id' | 'owner_id'>) {
  const r = await env.DB.prepare(`SELECT u.id, u.name,
      EXISTS(SELECT 1 FROM purchases x WHERE x.user_id = u.id AND x.project_id = ?2 AND x.status = 'paid') AS owned
    FROM friendships f JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ?1 AND u.status = 'active' AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = ?1 AND b.blocked_id = u.id) OR (b.user_id = u.id AND b.blocked_id = ?1))
    ORDER BY u.name COLLATE NOCASE LIMIT 500`).bind(me, p.id).all<{ id: string; name: string; owned: number }>();
  return r.results.map((f) => ({ id: f.id, name: f.name, owned: !!f.owned || f.id === p.owner_id }));
}

/** Cleanup: lapsed requests are closed, answered ones go after a year (account deletion: src/account.ts). */
export const giftCleanupStmts = (env: Env, t = now()) => [
  env.DB.prepare("UPDATE gift_requests SET status = 'closed', answered_at = ? WHERE status = 'pending' AND expires_at <= ?").bind(t, t),
  env.DB.prepare("DELETE FROM gift_requests WHERE status != 'pending' AND created_at < ?").bind(t - 365 * 86400000),
];

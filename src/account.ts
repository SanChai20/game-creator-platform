// Account basics (security review, finding 8): deleting an account.
// Deleting keeps what the platform must keep as a record (purchases, payments, the ledger, payouts) under the account's
// id, and removes or blanks everything that is about the person: email, name, passkeys, sign-ins, saves, stats, scores
// and reviews. The id stays, so purchase records and the creator's ledger still add up.
import type { Env } from './env';
import { balanceOf } from './earnings';
import { now } from './util';
// @ts-ignore plain JS module
import { deleteAccountStmts as socialDeleteStmts } from './social-rules.js';

/** Why this account cannot be deleted yet, or null when it can. Each reason is something the person can do first. */
export async function deleteBlocker(env: Env, u: { id: string; role: string }): Promise<string | null> {
  if (u.role === 'admin') return 'An admin account cannot be deleted. Ask another admin to remove your admin role first.';
  const games = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE owner_id = ? AND status != 'removed'").bind(u.id).first<{ n: number }>();
  // a creator's games have buyers and players to look after, so deleting a creator account goes through the platform
  if (games?.n) return `You have ${games.n === 1 ? 'a game' : `${games.n} games`} on the platform. To delete a creator account, write to us, so the players of your games can be looked after.`;
  const b = await balanceOf(env, u.id);
  if (b.total !== 0) return 'You still have earnings on your account. Withdraw them first, or contact us.';
  if (await env.DB.prepare("SELECT 1 FROM withdrawals WHERE user_id = ? AND status = 'pending'").bind(u.id).first()) return 'A withdrawal is still on its way. Wait for it to finish first.';
  return null;
}

/** Deletes the account's personal data and ends every sign-in. Call deleteBlocker first. */
export async function deleteAccount(env: Env, userId: string): Promise<void> {
  const db = env.DB, t = now();
  await db.batch([
    // Reviews leave their games' ratings, unless they were already hidden (a hidden review is not counted).
    db.prepare(`UPDATE projects SET rating_sum = rating_sum - (SELECT r.rating FROM reviews r WHERE r.project_id = projects.id AND r.user_id = ?1),
      rating_count = rating_count - 1 WHERE id IN (SELECT project_id FROM reviews WHERE user_id = ?1 AND hidden = 0)`).bind(userId),
    db.prepare('DELETE FROM reviews WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM saves WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM player_stats WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM player_games WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM library_games WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM scores WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM trials WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM match_ratings WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM match_seats WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM device_codes WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM passkeys WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM passkey_challenges WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM email_codes WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM login_challenges WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    // friends lose the account; its chats, requests, invites and blocks go with it (reports about it stay for admins)
    ...(socialDeleteStmts(db, userId) as D1PreparedStatement[]),
    // gift requests to and from it (gifts already given stay: they are purchases)
    db.prepare('DELETE FROM gift_requests WHERE from_id = ?1 OR to_id = ?1').bind(userId),
    // the address is freed for a new account; the row stays so purchases and the ledger keep their owner
    db.prepare(`UPDATE users SET email = ?1, name = 'Deleted account', pw_hash = '!', email_verified_at = NULL, status = 'deleted', role = 'user', stripe_customer = NULL, totp_secret = NULL, totp_enabled_at = NULL, totp_pending = NULL, last_seen_at = ?2 WHERE id = ?3`)
      .bind(`deleted-${userId}@deleted.invalid`, t, userId),
  ]);
  // MCP agents the person connected lose their access too
  try {
    let cursor: string | undefined;
    do {
      const r = await env.OAUTH_PROVIDER.listUserGrants(userId, cursor ? { cursor } : undefined);
      for (const g of r.items) await env.OAUTH_PROVIDER.revokeGrant(g.id, userId);
      cursor = r.cursor;
    } while (cursor);
  } catch (e) { console.error('grants not revoked for deleted account', userId, (e as Error).message); }
}


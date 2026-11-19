// Creator earnings. A paid game's buyer pays the platform; the platform keeps its cut and credits the
// rest to the creator's ledger. Credits become withdrawable after a hold period that covers refunds.
import type { Env } from './env';
import type { Settings } from './settings';
import { now } from './util';

export function splitSale(priceCents: number, s: Settings): { fee: number; net: number; cut: number; processing: number } {
  const cut = Math.round(priceCents * s.platform_fee_percent / 100);
  const processing = Math.round(priceCents * s.sale_processing_percent / 100) + s.sale_processing_fixed_cents;
  const fee = Math.min(priceCents, cut + processing);
  return { fee, net: priceCents - fee, cut, processing };
}

/** How long a sale's credit waits before the creator can withdraw it: the hold period, and never less than the window in
 *  which the buyer can still refund it themselves, so a self-serve refund never has to claw back money already paid out. */
export function holdMs(s: Pick<Settings, 'earnings_hold_days' | 'refund_window_hours'> & Partial<Pick<Settings, 'new_creator_hold_days' | 'new_creator_days'>>, creatorAgeMs = Infinity): number {
  const base = Math.max(s.earnings_hold_days * 86400000, s.refund_window_hours * 3600000);
  // A new creator's sales wait longer: card disputes arrive weeks after a sale, and a creator who sells to themselves
  // with stolen cards would otherwise be paid out and gone before the first one lands.
  const young = (s.new_creator_days || 0) > 0 && creatorAgeMs < (s.new_creator_days || 0) * 86400000;
  return young ? Math.max(base, (s.new_creator_hold_days || 0) * 86400000) : base;
}

/** Seconds this player has spent in a game's live sessions, free trial included, measured by the platform alone: each
 *  session counts from the moment the platform started it (server clock) to the last check-in of the page that showed
 *  the game (src/play-clock.ts), on the platform's own origin. Nothing the game sends (its heartbeats, its own service
 *  calls, what it says about its play time) is used, so a game can neither make itself refundable by under-reporting nor
 *  block a refund by keeping a session alive after the player left. */
export async function playedSeconds(env: Env, userId: string, projectId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM((COALESCE(seen_at, started_at) - started_at) / 1000), 0) AS s FROM plays WHERE user_id = ? AND project_id = ? AND env = 'live'")
    .bind(userId, projectId).first<{ s: number }>();
  return Math.round(r?.s || 0);
}

/** Seconds the game's heartbeats say its sessions ran past the page's last check-in (see refundablePurchase). */
export const UNCONFIRMED_PLAY_S = 120;
export async function unconfirmedSeconds(env: Env, userId: string, projectId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(MAX(0, last_beat_at - COALESCE(seen_at, started_at)) / 1000), 0) AS s FROM plays WHERE user_id = ? AND project_id = ? AND env = 'live'")
    .bind(userId, projectId).first<{ s: number }>();
  return Math.round(r?.s || 0);
}

/** The purchase a buyer can still refund themselves, if any: paid through Stripe within the refund window, played for
 *  less than the limit, and the first purchase of this game they would refund (a game is refunded once per buyer, so
 *  buy-play-refund cannot repeat). */
export async function refundablePurchase(env: Env, s: Pick<Settings, 'refund_window_hours' | 'refund_max_play_minutes'>, userId: string, projectId: string): Promise<{ id: string; payment_intent: string; created_at: number; until: number; played_seconds: number } | null> {
  if (!(s.refund_window_hours > 0)) return null;
  const win = s.refund_window_hours * 3600000;
  const p = await env.DB.prepare("SELECT id, payment_intent, created_at FROM purchases WHERE user_id = ?1 AND project_id = ?2 AND status = 'paid' AND provider = 'stripe' AND payment_intent IS NOT NULL AND created_at > ?3 AND NOT EXISTS (SELECT 1 FROM purchases o WHERE o.user_id = ?1 AND o.project_id = ?2 AND o.status = 'refunded') ORDER BY created_at DESC LIMIT 1")
    .bind(userId, projectId, now() - win).first<{ id: string; payment_intent: string; created_at: number }>();
  if (!p) return null;
  const played = await playedSeconds(env, userId, projectId);
  if (played >= s.refund_max_play_minutes * 60) return null;
  // The page's check-ins can be blocked by the buyer. If the game's own heartbeats say it kept running well past the
  // page's last check-in, the platform cannot confirm the play time, so the refund is not automatic: support decides.
  // (The heartbeats never add play time: a game that sends them after the player left only sends the buyer to support.)
  if (await unconfirmedSeconds(env, userId, projectId) > UNCONFIRMED_PLAY_S) return null;
  return { ...p, until: p.created_at + win, played_seconds: played };
}

export interface Balance { total: number; available: number; pending: number }
export async function balanceOf(env: Env, userId: string): Promise<Balance> {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total, COALESCE(SUM(CASE WHEN available_at <= ?1 OR amount_cents < 0 THEN amount_cents ELSE 0 END), 0) AS available FROM ledger WHERE user_id = ?2')
    .bind(now(), userId).first<{ total: number; available: number }>();
  const total = r?.total || 0, available = Math.min(total, r?.available || 0);
  return { total, available: Math.max(0, available), pending: Math.max(0, total - Math.max(0, available)) };
}

/** Records a paid purchase and credits the creator. Idempotent on providerRef. Returns false if it already existed. */
export async function recordPurchase(env: Env, s: Settings, a: { userId: string; projectId: string; ownerId: string; title: string; priceCents: number; provider: 'stripe' | 'admin'; providerRef: string; paymentIntent?: string | null }): Promise<boolean> {
  if (await env.DB.prepare('SELECT 1 FROM purchases WHERE provider_ref = ?').bind(a.providerRef).first()) return false;
  const { fee, net } = splitSale(a.priceCents, s);
  const t = now(), id = 'pur_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const owner = await env.DB.prepare('SELECT created_at FROM users WHERE id = ?').bind(a.ownerId).first<{ created_at: number }>();
  const hold = holdMs(s, owner ? t - owner.created_at : Infinity);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, provider_ref, payment_intent, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)")
      .bind(id, a.userId, a.projectId, a.ownerId, a.priceCents, fee, net, a.provider, a.providerRef, a.paymentIntent || null, t),
    env.DB.prepare("INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at) VALUES (?, 'sale', ?, ?, ?, ?, ?)")
      .bind(a.ownerId, net, id, `Sale of ${a.title}`, t + hold, t),
    env.DB.prepare('UPDATE projects SET sales = sales + 1 WHERE id = ?').bind(a.projectId),
  ]);
  return true;
}

/** Sum of the partial-refund debits already taken for a purchase (zero or negative). */
const PARTIAL = "COALESCE((SELECT SUM(amount_cents) FROM ledger WHERE ref = ?3 AND kind = 'partial_refund'), 0)";

/** Reverses a purchase after a full refund: access is revoked and what is left of the creator's credit is taken back. */
export async function refundPurchase(env: Env, where: { paymentIntent?: string; id?: string }): Promise<boolean> {
  return reversePurchase(env, where, 'refunded', 'refund', 'Refunded sale');
}

/** A buyer disputed the charge: access is revoked and the creator's credit is held back until the dispute is decided. */
export async function disputePurchase(env: Env, paymentIntent: string): Promise<boolean> {
  return reversePurchase(env, { paymentIntent }, 'disputed', 'dispute', 'Disputed sale (chargeback)');
}

async function reversePurchase(env: Env, where: { paymentIntent?: string; id?: string }, status: 'refunded' | 'disputed', kind: 'refund' | 'dispute', note: string): Promise<boolean> {
  const p = await env.DB.prepare(`SELECT * FROM purchases WHERE ${where.id ? 'id = ?' : 'payment_intent = ?'} AND status = 'paid'`).bind(where.id || where.paymentIntent).first<{ id: string; owner_id: string; project_id: string; net_cents: number }>();
  if (!p) return false;
  const t = now();
  // One transaction, guarded on the purchase still being paid: a webhook and an admin refunding at once take the
  // creator's credit back once. Partial refunds already taken back are not taken twice.
  const [upd] = await env.DB.batch([
    env.DB.prepare("UPDATE purchases SET status = ?, refunded_at = ? WHERE id = ? AND status = 'paid'").bind(status, t, p.id),
    env.DB.prepare(`INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at) SELECT ?1, ?5, -?2 - ${PARTIAL}, ?3, ?6, ?4, ?4 WHERE EXISTS (SELECT 1 FROM purchases WHERE id = ?3 AND refunded_at = ?4) AND NOT EXISTS (SELECT 1 FROM ledger WHERE ref = ?3 AND kind = ?5)`).bind(p.owner_id, p.net_cents, p.id, t, kind, note),
    env.DB.prepare('UPDATE projects SET sales = MAX(0, sales - 1) WHERE id = ? AND EXISTS (SELECT 1 FROM purchases WHERE id = ? AND refunded_at = ?)').bind(p.project_id, p.id, t),
  ]);
  return !!upd.meta.changes;
}

/**
 * A dispute was decided in the platform's favour: the creator's credit comes back, and so does the buyer's access unless
 * they bought the game again meanwhile. Idempotent: the credit is returned once.
 */
export async function disputeWon(env: Env, paymentIntent: string): Promise<boolean> {
  const p = await env.DB.prepare("SELECT * FROM purchases WHERE payment_intent = ? AND status = 'disputed'").bind(paymentIntent).first<{ id: string; user_id: string; owner_id: string; project_id: string }>();
  if (!p) return false;
  const t = now();
  const [credit] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at) SELECT ?1, 'dispute_won', -amount_cents, ?2, 'Dispute won, sale restored', ?3, ?3 FROM ledger WHERE ref = ?2 AND kind = 'dispute' AND NOT EXISTS (SELECT 1 FROM ledger WHERE ref = ?2 AND kind = 'dispute_won') LIMIT 1`).bind(p.owner_id, p.id, t),
    env.DB.prepare("UPDATE purchases SET status = CASE WHEN EXISTS (SELECT 1 FROM purchases o WHERE o.user_id = ?1 AND o.project_id = ?2 AND o.status = 'paid') THEN 'dispute_won' ELSE 'paid' END, refunded_at = NULL WHERE id = ?3 AND status = 'disputed'").bind(p.user_id, p.project_id, p.id),
    env.DB.prepare("UPDATE projects SET sales = sales + 1 WHERE id = ? AND EXISTS (SELECT 1 FROM purchases WHERE id = ? AND status = 'paid')").bind(p.project_id, p.id),
  ]);
  return !!credit.meta.changes;
}

/**
 * A charge was partly refunded (from the Stripe Dashboard): the creator gives back the same share of their credit and the
 * buyer keeps the game. `refundedCents` is the charge's running total, so replays and later partial refunds add only the
 * difference.
 */
export async function partialRefund(env: Env, paymentIntent: string, refundedCents: number): Promise<boolean> {
  const p = await env.DB.prepare("SELECT * FROM purchases WHERE payment_intent = ? AND status = 'paid'").bind(paymentIntent).first<{ id: string; owner_id: string; price_cents: number; net_cents: number }>();
  if (!p || p.price_cents <= 0) return false;
  const target = -Math.min(p.net_cents, Math.round(p.net_cents * Math.min(refundedCents, p.price_cents) / p.price_cents));
  const t = now();
  const r = await env.DB.prepare(`INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at) SELECT ?1, 'partial_refund', ?2 - ${PARTIAL}, ?3, 'Partly refunded sale', ?4, ?4 WHERE ?2 - ${PARTIAL} < 0`)
    .bind(p.owner_id, target, p.id, t).run();
  return !!r.meta.changes;
}

export async function owns(env: Env, userId: string, projectId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM purchases WHERE user_id = ? AND project_id = ? AND status = 'paid'").bind(userId, projectId).first());
}

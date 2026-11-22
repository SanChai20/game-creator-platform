// Creator earnings. A paid game's buyer pays the platform; the platform keeps its cut and credits the
// rest to the creator's ledger. Credits become withdrawable after a hold period that covers refunds.
import type { Env } from './env';
import type { Settings } from './settings';
import { now } from './util';

type FeeSettings = Pick<Settings, 'platform_fee_percent' | 'platform_fee_open_percent'>;

/** The platform's cut of a game sale, in percent. A paid game that shares its build skill for free (Open Implementation
 *  with no skill price) pays the lower rate; a game whose skill is sold pays the standard rate, and the platform takes its
 *  skill commission on the skill's own sales instead (splitSkillSale). The rate is the one in force when the sale is
 *  recorded, and the purchase keeps the fee it was charged, so changing sharing later never changes past sales, their
 *  refunds or the creator's ledger. */
export function cutPercent(s: FeeSettings, open: boolean): number {
  return open ? s.platform_fee_open_percent : s.platform_fee_percent;
}

export function splitSale(priceCents: number, s: Settings, open = false): { fee: number; net: number; cut: number; processing: number; cut_percent: number } {
  const pct = cutPercent(s, open), cut = Math.round(priceCents * pct / 100);
  const processing = Math.round(priceCents * s.sale_processing_percent / 100) + s.sale_processing_fixed_cents;
  const fee = Math.min(priceCents, cut + processing);
  return { fee, net: priceCents - fee, cut, processing, cut_percent: pct };
}

/** Whether a game's sales get the lower cut: its build skill is shared, and shared for free. */
export const freeSkillShared = (p: { open_implementation?: number | boolean | null; skill_price_cents?: number | null }) => !!p.open_implementation && !(Number(p.skill_price_cents) > 0);

/** A build skill sale: the platform keeps its skill commission (admin setting skill_fee_percent, 5% by default), apart
 *  from the game's own cut, plus the same processing cost a game sale passes on. */
export function splitSkillSale(priceCents: number, s: Pick<Settings, 'skill_fee_percent' | 'sale_processing_percent' | 'sale_processing_fixed_cents'>): { fee: number; net: number; cut: number; processing: number; cut_percent: number } {
  const pct = s.skill_fee_percent, cut = Math.round(priceCents * pct / 100);
  const processing = Math.round(priceCents * s.sale_processing_percent / 100) + s.sale_processing_fixed_cents;
  const fee = Math.min(priceCents, cut + processing);
  return { fee, net: priceCents - fee, cut, processing, cut_percent: pct };
}

/** What was sold: a game, or a game's build skill. Each has its own table and sales counter, so the two are counted apart. */
export type Item = 'game' | 'skill';
const ITEM = {
  game: { table: 'purchases', counter: 'sales', kind: 'sale', note: 'Sale of' },
  skill: { table: 'skill_purchases', counter: 'skill_sales', kind: 'skill_sale', note: 'Skill sale of' },
} as const;

/** How long a sale's credit waits before the creator can withdraw it: the hold period, and never less than the window in
 *  which the buyer can still refund it themselves, so a self-service refund never has to claw back money already paid out
 *  (a sale with a refund request still open is held for as long as it stays open, see availableRow). */
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

/** Seconds the game's heartbeats say its sessions ran past the page's last check-in. More than UNCONFIRMED_PLAY_S means
 *  the platform could not confirm the play time, so a refund waits for an admin (src/refunds.ts). */
export const UNCONFIRMED_PLAY_S = 120;
export async function unconfirmedSeconds(env: Env, userId: string, projectId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(MAX(0, last_beat_at - COALESCE(seen_at, started_at)) / 1000), 0) AS s FROM plays WHERE user_id = ? AND project_id = ? AND env = 'live'")
    .bind(userId, projectId).first<{ s: number }>();
  return Math.round(r?.s || 0);
}

export interface Balance { total: number; available: number; pending: number; held: number }

/** SQL: whether a ledger row counts towards the withdrawable balance at time `t` (a bound parameter such as "?1"). Debits
 *  count at once; a credit counts once its hold has passed and no refund request for its sale is waiting for a decision,
 *  so a sale whose buyer asked for a refund is never paid out while the platform is still deciding (src/refunds.ts). */
export const availableRow = (l: string, t: string) =>
  `(${l}.amount_cents < 0 OR (${l}.available_at <= ${t} AND NOT EXISTS (SELECT 1 FROM refund_requests rr WHERE rr.purchase_id = ${l}.ref AND rr.status = 'pending')))`;

export async function balanceOf(env: Env, userId: string): Promise<Balance> {
  const r = await env.DB.prepare(`SELECT COALESCE(SUM(l.amount_cents), 0) AS total, COALESCE(SUM(CASE WHEN ${availableRow('l', '?1')} THEN l.amount_cents ELSE 0 END), 0) AS available,
      COALESCE(SUM(CASE WHEN l.amount_cents > 0 AND EXISTS (SELECT 1 FROM refund_requests rr WHERE rr.purchase_id = l.ref AND rr.status = 'pending') THEN l.amount_cents ELSE 0 END), 0) AS held
    FROM ledger l WHERE l.user_id = ?2`)
    .bind(now(), userId).first<{ total: number; available: number; held: number }>();
  const total = r?.total || 0, available = Math.min(total, r?.available || 0);
  // held: credits of sales whose buyer asked for a refund that is still open (part of pending)
  return { total, available: Math.max(0, available), pending: Math.max(0, total - Math.max(0, available)), held: Math.max(0, r?.held || 0) };
}

/** Records a paid purchase and credits the creator. Idempotent on providerRef. Returns false if it already existed. */
export async function recordPurchase(env: Env, s: Settings, a: { userId: string; projectId: string; ownerId: string; title: string; priceCents: number; provider: 'stripe' | 'admin'; providerRef: string; paymentIntent?: string | null; openImplementation?: boolean; item?: Item }): Promise<boolean> {
  const it = ITEM[a.item || 'game'];
  if (await env.DB.prepare(`SELECT 1 FROM ${it.table} WHERE provider_ref = ?`).bind(a.providerRef).first()) return false;
  const { fee, net } = a.item === 'skill' ? splitSkillSale(a.priceCents, s) : splitSale(a.priceCents, s, !!a.openImplementation);
  const t = now(), id = (a.item === 'skill' ? 'spur_' : 'pur_') + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const owner = await env.DB.prepare('SELECT created_at FROM users WHERE id = ?').bind(a.ownerId).first<{ created_at: number }>();
  const hold = holdMs(s, owner ? t - owner.created_at : Infinity);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO ${it.table} (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, provider_ref, payment_intent, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)`)
      .bind(id, a.userId, a.projectId, a.ownerId, a.priceCents, fee, net, a.provider, a.providerRef, a.paymentIntent || null, t),
    env.DB.prepare('INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(a.ownerId, it.kind, net, id, `${it.note} ${a.title}`, t + hold, t),
    env.DB.prepare(`UPDATE projects SET ${it.counter} = ${it.counter} + 1 WHERE id = ?`).bind(a.projectId),
  ]);
  return true;
}

/** Sum of the partial-refund debits already taken for a purchase (zero or negative). */
const PARTIAL = "COALESCE((SELECT SUM(amount_cents) FROM ledger WHERE ref = ?3 AND kind = 'partial_refund'), 0)";

/** Reverses a purchase (a game or a build skill) after a full refund: access is revoked and what is left of the creator's
 *  credit is taken back. */
export async function refundPurchase(env: Env, where: { paymentIntent?: string; id?: string }): Promise<boolean> {
  return await reversePurchase(env, 'game', where, 'refunded', 'refund', 'Refunded sale') || reversePurchase(env, 'skill', where, 'refunded', 'refund', 'Refunded skill sale');
}

/** A buyer disputed the charge: access is revoked and the creator's credit is held back until the dispute is decided. */
export async function disputePurchase(env: Env, paymentIntent: string): Promise<boolean> {
  return await reversePurchase(env, 'game', { paymentIntent }, 'disputed', 'dispute', 'Disputed sale (chargeback)') || reversePurchase(env, 'skill', { paymentIntent }, 'disputed', 'dispute', 'Disputed skill sale (chargeback)');
}

async function reversePurchase(env: Env, item: Item, where: { paymentIntent?: string; id?: string }, status: 'refunded' | 'disputed', kind: 'refund' | 'dispute', note: string): Promise<boolean> {
  const it = ITEM[item];
  const p = await env.DB.prepare(`SELECT * FROM ${it.table} WHERE ${where.id ? 'id = ?' : 'payment_intent = ?'} AND status = 'paid'`).bind(where.id || where.paymentIntent).first<{ id: string; owner_id: string; project_id: string; net_cents: number }>();
  if (!p) return false;
  const t = now();
  // One transaction, guarded on the purchase still being paid: a webhook and an admin refunding at once take the
  // creator's credit back once. Partial refunds already taken back are not taken twice.
  const [upd] = await env.DB.batch([
    env.DB.prepare(`UPDATE ${it.table} SET status = ?, refunded_at = ? WHERE id = ? AND status = 'paid'`).bind(status, t, p.id),
    env.DB.prepare(`INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at) SELECT ?1, ?5, -?2 - ${PARTIAL}, ?3, ?6, ?4, ?4 WHERE EXISTS (SELECT 1 FROM ${it.table} WHERE id = ?3 AND refunded_at = ?4) AND NOT EXISTS (SELECT 1 FROM ledger WHERE ref = ?3 AND kind = ?5)`).bind(p.owner_id, p.net_cents, p.id, t, kind, note),
    env.DB.prepare(`UPDATE projects SET ${it.counter} = MAX(0, ${it.counter} - 1) WHERE id = ? AND EXISTS (SELECT 1 FROM ${it.table} WHERE id = ? AND refunded_at = ?)`).bind(p.project_id, p.id, t),
    // an open refund request for this sale is settled by it: refunded (by the request, an admin or the Stripe Dashboard),
    // or closed when the buyer disputed the charge instead
    env.DB.prepare("UPDATE refund_requests SET status = ?, decided_at = ?, decided_by = COALESCE(decided_by, 'payment') WHERE purchase_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM purchases WHERE id = ? AND refunded_at = ?)")
      .bind(kind === 'refund' ? 'refunded' : 'closed', t, p.id, p.id, t),
  ]);
  return !!upd.meta.changes;
}

/**
 * A dispute was decided in the platform's favour: the creator's credit comes back, and so does the buyer's access unless
 * they bought the game again meanwhile. Idempotent: the credit is returned once.
 */
export async function disputeWon(env: Env, paymentIntent: string): Promise<boolean> {
  return await disputeWonOf(env, 'game', paymentIntent) || disputeWonOf(env, 'skill', paymentIntent);
}
async function disputeWonOf(env: Env, item: Item, paymentIntent: string): Promise<boolean> {
  const it = ITEM[item];
  const p = await env.DB.prepare(`SELECT * FROM ${it.table} WHERE payment_intent = ? AND status = 'disputed'`).bind(paymentIntent).first<{ id: string; user_id: string; owner_id: string; project_id: string }>();
  if (!p) return false;
  const t = now();
  const [credit] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at) SELECT ?1, 'dispute_won', -amount_cents, ?2, 'Dispute won, sale restored', ?3, ?3 FROM ledger WHERE ref = ?2 AND kind = 'dispute' AND NOT EXISTS (SELECT 1 FROM ledger WHERE ref = ?2 AND kind = 'dispute_won') LIMIT 1`).bind(p.owner_id, p.id, t),
    env.DB.prepare(`UPDATE ${it.table} SET status = CASE WHEN EXISTS (SELECT 1 FROM ${it.table} o WHERE o.user_id = ?1 AND o.project_id = ?2 AND o.status = 'paid') THEN 'dispute_won' ELSE 'paid' END, refunded_at = NULL WHERE id = ?3 AND status = 'disputed'`).bind(p.user_id, p.project_id, p.id),
    env.DB.prepare(`UPDATE projects SET ${it.counter} = ${it.counter} + 1 WHERE id = ? AND EXISTS (SELECT 1 FROM ${it.table} WHERE id = ? AND status = 'paid')`).bind(p.project_id, p.id),
  ]);
  return !!credit.meta.changes;
}

/**
 * A charge was partly refunded (from the Stripe Dashboard): the creator gives back the same share of their credit and the
 * buyer keeps the game. `refundedCents` is the charge's running total, so replays and later partial refunds add only the
 * difference.
 */
export async function partialRefund(env: Env, paymentIntent: string, refundedCents: number): Promise<boolean> {
  const p = await env.DB.prepare("SELECT * FROM purchases WHERE payment_intent = ? AND status = 'paid'").bind(paymentIntent).first<{ id: string; owner_id: string; price_cents: number; net_cents: number }>()
    ?? await env.DB.prepare("SELECT * FROM skill_purchases WHERE payment_intent = ? AND status = 'paid'").bind(paymentIntent).first<{ id: string; owner_id: string; price_cents: number; net_cents: number }>();
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

/** Whether this player bought this game's build skill (and still has it: not refunded or disputed). */
export async function ownsSkill(env: Env, userId: string, projectId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM skill_purchases WHERE user_id = ? AND project_id = ? AND status = 'paid'").bind(userId, projectId).first());
}

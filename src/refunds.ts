// Game refunds. A buyer refunds a game themselves, from its page or from their purchase history, and the platform checks
// the policy on the server before any money moves:
//   - a game can be refunded within refund_window_hours (24, one day) of buying it,
//   - and only while it has been played for less than refund_max_play_minutes (10, free trial included),
//   - once per game per buyer: a game refunded and bought again is final, and only a purchase that was paid for.
// An eligible refund goes through at once (refund_auto). The platform sends it to the platform as a request instead,
// for an admin to decide under Admin, Money, Refunds, when it cannot settle it by itself: the play time could not be
// confirmed, the account refunded too often lately (refund_limit_count within refund_limit_days, after which it loses
// self-service until an admin gives it back), automatic refunds are off, or Stripe did not answer. While a request
// waits, the creator's credit for that sale is held (earnings.ts availableRow), so it is never paid out and clawed back.
// A request is judged by the moment it was made. Build skills are non-refundable and never get one.
//
// The books of every refund (settleRefund): the buyer gets the full price back; the creator gives back their credit for
// the sale (and, if their share was already transferred, that much of the Transfer is reversed); the platform gives back
// its own cut; Stripe keeps its processing fee, which the platform absorbs or the creator bears (refund_fee_bearer).
import { AppError, notFound, type Env } from './env';
import type { Settings } from './settings';
import { refundPurchase, UNCONFIRMED_PLAY_S } from './earnings';
import { refundDecidedMail, refundReceivedMail, saleRefundedMail } from './mail';
import { stripe } from './stripe';
import { now, rid } from './util';

type RS = Pick<Settings, 'refund_window_hours' | 'refund_max_play_minutes'>;
type Limits = Partial<Pick<Settings, 'refund_limit_count' | 'refund_limit_days'>>;
export type RefundSettings = RS & Limits & Partial<Pick<Settings, 'refund_auto' | 'refund_fee_bearer'>>;

/** Why a purchase cannot be refunded. The page lists every one that applies next to the greyed-out button. */
export type RefundReason =
  | 'window'           // bought more than refund_window_hours ago
  | 'played'           // played for refund_max_play_minutes or more
  | 'refunded_before'  // this buyer already had this game refunded once (bought again: final)
  | 'not_charged'      // given by an admin, nothing was paid
  | 'gift'             // a friend bought it as a gift: gifts are non-refundable (src/gifts.ts)
  | 'off'              // refunds are switched off (refund_window_hours 0)
  | 'denied'           // a request for this purchase was declined
  | 'not_paid';        // refunded or disputed already

export interface RefundRequestInfo { id: string; status: 'pending' | 'refunded' | 'denied' | 'closed'; created_at: number; decided_at: number | null; decision_note: string | null }

export interface RefundState {
  purchase_id: string;
  /** whether the Refund button is enabled */
  refundable: boolean;
  /** every reason it is not (empty when it is, or while a request is open) */
  reasons: RefundReason[];
  /** a refund now would be a request the platform decides, not instant (an account that lost self-service) */
  review: boolean;
  /** the end of the refund window for this purchase */
  until: number;
  played_seconds: number;
  max_play_seconds: number;
  window_hours: number;
  /** the refund or request already made for this purchase, if any */
  request: RefundRequestInfo | null;
}

export interface PurchaseRow { id: string; user_id: string; project_id: string; owner_id: string; price_cents: number; fee_cents: number; net_cents: number; provider: string; payment_intent: string | null; status: string; created_at: number; title?: string; gifted_by?: string | null }

/** The policy itself, without the database: every reason that applies, most important first. */
export function refundReasons(s: RS, p: Pick<PurchaseRow, 'status' | 'provider' | 'payment_intent' | 'price_cents' | 'created_at'> & { gifted_by?: string | null }, playedS: number, at: number, o: { refundedBefore?: boolean; request?: Pick<RefundRequestInfo, 'status'> | null } = {}): RefundReason[] {
  if (p.status !== 'paid') return ['not_paid'];
  if (o.request?.status === 'denied') return ['denied'];
  if (p.gifted_by) return ['gift'];
  if (p.provider !== 'stripe' || !p.payment_intent || !(p.price_cents > 0)) return ['not_charged'];
  if (!(s.refund_window_hours > 0)) return ['off'];
  const out: RefundReason[] = [];
  if (at - p.created_at >= s.refund_window_hours * 3600000) out.push('window');
  if (playedS >= s.refund_max_play_minutes * 60) out.push('played');
  if (o.refundedBefore) out.push('refunded_before');
  return out;
}

/** Whether a buyer's refunds have reached the limit: `count` refunds within the period. 0 turns the limit off. */
export const overRefundLimit = (s: Limits, recentRefunds: number) => (s.refund_limit_count || 0) > 0 && recentRefunds >= (s.refund_limit_count || 0);

/** Play time per game for one player, measured by the platform alone (see earnings.ts playedSeconds): the sum of each
 *  session from its start to the last check-in of the page showing it, and how far the game's own heartbeats ran past
 *  those check-ins (which never adds play time, but means the platform could not confirm it). */
async function playTimes(env: Env, userId: string, projectIds: string[]): Promise<Map<string, { played: number; unconfirmed: number }>> {
  const out = new Map<string, { played: number; unconfirmed: number }>();
  if (!projectIds.length) return out;
  const r = await env.DB.prepare(`SELECT project_id, COALESCE(SUM((COALESCE(seen_at, started_at) - started_at) / 1000), 0) AS played, COALESCE(SUM(MAX(0, last_beat_at - COALESCE(seen_at, started_at)) / 1000), 0) AS unconfirmed FROM plays WHERE user_id = ? AND env = 'live' AND project_id IN (${projectIds.map(() => '?').join(',')}) GROUP BY project_id`)
    .bind(userId, ...projectIds).all<{ project_id: string; played: number; unconfirmed: number }>();
  for (const x of r.results) out.set(x.project_id, { played: Math.round(x.played || 0), unconfirmed: Math.round(x.unconfirmed || 0) });
  return out;
}

/** Whether this account's refunds go to the platform: it lost self-service before, or has just reached the limit. */
async function accountReview(env: Env, s: Limits, userId: string, at: number): Promise<'account' | 'frequent' | null> {
  const u = await env.DB.prepare('SELECT refund_review_at FROM users WHERE id = ?').bind(userId).first<{ refund_review_at: number | null }>();
  if (u?.refund_review_at) return 'account';
  if (!((s.refund_limit_count || 0) > 0)) return null;
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM purchases WHERE user_id = ? AND status = 'refunded' AND gifted_by IS NULL AND refunded_at > ?").bind(userId, at - Math.max(1, s.refund_limit_days || 30) * 86400000).first<{ n: number }>();
  return overRefundLimit(s, r?.n || 0) ? 'frequent' : null;
}

const REQ_COLS = 'id, purchase_id, status, created_at, decided_at, decision_note';

/** The refund state of each of these game purchases, all of one buyer. */
export async function refundStates(env: Env, s: RS & Limits, userId: string, purchases: PurchaseRow[], at = now()): Promise<Map<string, RefundState & { unconfirmed: boolean; review_reason: string | null }>> {
  const out = new Map<string, RefundState & { unconfirmed: boolean; review_reason: string | null }>();
  if (!purchases.length) return out;
  const pids = [...new Set(purchases.map((p) => p.project_id))];
  const [times, reqs, refunded, acct] = await Promise.all([
    playTimes(env, userId, pids),
    env.DB.prepare(`SELECT ${REQ_COLS} FROM refund_requests WHERE purchase_id IN (${purchases.map(() => '?').join(',')})`).bind(...purchases.map((p) => p.id)).all<RefundRequestInfo & { purchase_id: string }>(),
    // a gift that was given back (a friend's duplicate payment, a Stripe-side refund) is not this player's own refund
    env.DB.prepare(`SELECT id, project_id FROM purchases WHERE user_id = ? AND status = 'refunded' AND gifted_by IS NULL AND project_id IN (${pids.map(() => '?').join(',')})`).bind(userId, ...pids).all<{ id: string; project_id: string }>(),
    accountReview(env, s, userId, at),
  ]);
  const reqOf = new Map(reqs.results.map(({ purchase_id, ...r }) => [purchase_id, r]));
  for (const p of purchases) {
    const tm = times.get(p.project_id) || { played: 0, unconfirmed: 0 }, request = reqOf.get(p.id) || null;
    const refundedBefore = refunded.results.some((x) => x.project_id === p.project_id && x.id !== p.id);
    const reasons = request?.status === 'pending' ? [] : refundReasons(s, p, tm.played, at, { refundedBefore, request });
    out.set(p.id, {
      purchase_id: p.id, refundable: !request && reasons.length === 0, reasons, review: !!acct,
      until: p.created_at + Math.max(0, s.refund_window_hours) * 3600000,
      played_seconds: tm.played, max_play_seconds: s.refund_max_play_minutes * 60, window_hours: s.refund_window_hours,
      request, unconfirmed: tm.unconfirmed > UNCONFIRMED_PLAY_S, review_reason: acct,
    });
  }
  return out;
}

const pub = <T extends { unconfirmed: boolean; review_reason: string | null }>({ unconfirmed: _u, review_reason: _r, ...rest }: T) => rest;

/** The refund state of a buyer's current purchase of one game (null when they have no paid purchase of it). */
export async function gameRefundState(env: Env, s: RS & Limits, userId: string, projectId: string): Promise<RefundState | null> {
  const p = await env.DB.prepare("SELECT * FROM purchases WHERE user_id = ? AND project_id = ? AND status = 'paid' ORDER BY created_at DESC LIMIT 1").bind(userId, projectId).first<PurchaseRow>();
  if (!p) return null;
  return pub((await refundStates(env, s, userId, [p])).get(p.id)!);
}

/** The money side of a refund: Stripe in production, a stub in tests. */
export interface RefundPay {
  /** refunds the charge in full, keyed on the purchase so a retry refunds once; returns the refund's id */
  refund(paymentIntent: string, purchaseId: string, by: 'buyer' | 'admin'): Promise<string | null>;
  /** Stripe's processing fee on the charge (kept by Stripe on a refund), or null when it cannot be read */
  fee(paymentIntent: string): Promise<number | null>;
  /** takes `amount` back from a Transfer already sent to a creator */
  reverseTransfer(transferId: string, amount: number, key: string): Promise<void>;
}

export function stripePay(env: Env): RefundPay {
  return {
    async refund(pi, purchaseId) {   // the same parameters whoever asks, so a retry under the same key is accepted
      const r = await stripe<{ id: string }>(env, 'POST', '/refunds', { payment_intent: pi, reason: 'requested_by_customer', metadata: { purchase: purchaseId } }, 'refund:' + purchaseId);
      return r?.id || null;
    },
    async fee(pi) {
      try {
        const x = await stripe<any>(env, 'GET', `/payment_intents/${encodeURIComponent(pi)}`, { 'expand[]': 'latest_charge.balance_transaction' });
        const f = Number(x?.latest_charge?.balance_transaction?.fee);
        return Number.isFinite(f) ? f : null;
      } catch { return null; }
    },
    async reverseTransfer(transferId, amount, key) {
      await stripe(env, 'POST', `/transfers/${encodeURIComponent(transferId)}/reversals`, { amount, metadata: { reason: 'game_refund' } }, key);
    },
  };
}

/**
 * Sends the money back and settles the books. The purchase must still be paid. Records (or completes) the refund's row
 * in refund_requests. Safe to run twice: the Stripe calls are keyed and every ledger row is written once.
 */
export async function settleRefund(env: Env, s: RefundSettings, p: PurchaseRow, requestId: string, by: 'buyer' | 'admin', pay: RefundPay): Promise<void> {
  const refundRef = p.provider === 'stripe' && p.payment_intent ? await pay.refund(p.payment_intent, p.id, by) : null;
  await refundPurchase(env, { id: p.id });   // access goes, the creator's credit is taken back, an open request closes
  const t = now(), bearer = s.refund_fee_bearer === 'creator' ? 'creator' : 'platform';
  const fee = p.provider === 'stripe' && p.payment_intent ? await pay.fee(p.payment_intent) : null;
  // The fee Stripe keeps: the platform absorbs it, or the creator bears it as a debit next to the refund.
  if (bearer === 'creator' && fee && fee > 0) {
    await env.DB.prepare("INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at) SELECT ?1, 'refund_fee', ?2, ?3, ?4, ?5, ?5 WHERE NOT EXISTS (SELECT 1 FROM ledger WHERE ref = ?3 AND kind = 'refund_fee')")
      .bind(p.owner_id, -fee, p.id, `Payment fee kept on the refund of ${p.title || 'a game'}`, t).run();
  }
  // The creator's share was already paid out (an admin refund after the hold): what the balance is short by, up to what
  // this refund took back, comes back from their latest Transfer, so the platform is not left owed.
  let transfer: string | null = null, reversed = 0;
  const debit = p.net_cents + (bearer === 'creator' && fee ? fee : 0);
  const bal = await env.DB.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM ledger WHERE user_id = ?').bind(p.owner_id).first<{ total: number }>();
  const short = Math.min(debit, -Math.min(0, bal?.total || 0));
  if (short > 0 && !(await env.DB.prepare("SELECT 1 FROM ledger WHERE ref = ? AND kind = 'transfer_reversal'").bind(p.id).first())) {
    const w = await env.DB.prepare(`SELECT w.provider_ref, w.amount_cents - COALESCE((SELECT SUM(q.transfer_reversal_cents) FROM refund_requests q WHERE q.transfer_ref = w.provider_ref), 0) AS left
      FROM withdrawals w WHERE w.user_id = ? AND w.method = 'stripe' AND w.status = 'paid' AND w.provider_ref LIKE 'tr_%' ORDER BY w.settled_at DESC LIMIT 5`).bind(p.owner_id).all<{ provider_ref: string; left: number }>();
    const from = w.results.find((x) => x.left > 0);
    if (from) {
      const amount = Math.min(short, from.left);
      try {
        await pay.reverseTransfer(from.provider_ref, amount, 'refund-reversal:' + p.id);
        transfer = from.provider_ref; reversed = amount;
        await env.DB.prepare("INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at) SELECT ?1, 'transfer_reversal', ?2, ?3, ?4, ?5, ?5 WHERE NOT EXISTS (SELECT 1 FROM ledger WHERE ref = ?3 AND kind = 'transfer_reversal')")
          .bind(p.owner_id, amount, p.id, `Taken back from payout ${from.provider_ref} for a refund`, t).run();
      } catch (e) { console.error('refund: transfer reversal failed; the creator balance stays negative', p.id, (e as Error).message); }
    }
  }
  await env.DB.prepare(`UPDATE refund_requests SET status = 'refunded', decided_at = COALESCE(decided_at, ?1), refund_ref = ?2, platform_fee_cents = ?3, creator_net_cents = ?4,
      stripe_fee_cents = ?5, fee_bearer = ?6, transfer_ref = COALESCE(?7, transfer_ref), transfer_reversal_cents = transfer_reversal_cents + ?8 WHERE id = ?9`)
    .bind(t, refundRef, p.fee_cents, p.net_cents, fee, bearer, transfer, reversed, requestId).run();
}

/** The plain-English sentence for each reason, for API errors (the web app has its own, translated). */
export function reasonText(s: RS, r: RefundReason): string {
  return {
    window: `More than ${s.refund_window_hours} hours have passed since you bought it.`,
    played: `You have played it for ${s.refund_max_play_minutes} minutes or more.`,
    refunded_before: 'You already had this game refunded once, so buying it again is final.',
    not_charged: 'This game was given to you, so nothing was paid.',
    gift: 'Gifted games are non-refundable.',
    off: 'Refunds are not available.',
    denied: 'A refund request for this purchase was declined.',
    not_paid: 'This purchase was already refunded.',
  }[r];
}

const insertRequest = (env: Env, a: { id: string; p: PurchaseRow; status: 'pending'; note: string | null; played: number; review: string | null; by: string | null; t: number }) =>
  env.DB.prepare("INSERT INTO refund_requests (id, purchase_id, user_id, project_id, owner_id, price_cents, status, note, played_seconds, bought_at, review_reason, decided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (purchase_id) DO NOTHING")
    .bind(a.id, a.p.id, a.p.user_id, a.p.project_id, a.p.owner_id, a.p.price_cents, a.status, a.note, a.played, a.p.created_at, a.review, a.by, a.t).run();

/**
 * A buyer refunds one of their game purchases. Checks the policy on the server and refunds at once when the platform can
 * settle it by itself; otherwise records a request for an admin. Returns what happened.
 */
export async function requestRefund(env: Env, s: RefundSettings, userId: string, purchaseId: string, note: string, pay: RefundPay, origin?: string): Promise<{ id: string; status: 'refunded' | 'pending'; review_reason: string | null }> {
  const p = await env.DB.prepare('SELECT x.*, g.title FROM purchases x JOIN projects g ON g.id = x.project_id WHERE x.id = ? AND x.user_id = ?').bind(purchaseId, userId).first<PurchaseRow>();
  if (!p) {
    if (await env.DB.prepare('SELECT 1 FROM skill_purchases WHERE id = ? AND user_id = ?').bind(purchaseId, userId).first()) throw new AppError(409, 'Build skills are non-refundable.', 'skill_non_refundable');
    throw notFound('No such purchase.');
  }
  if (p.gifted_by) throw new AppError(409, 'Gifted games are non-refundable.', 'gift_non_refundable');
  const t = now(), st = (await refundStates(env, s, userId, [p], t)).get(p.id)!;
  if (st.request) throw new AppError(409, st.request.status === 'pending' ? 'You already asked for a refund of this game. We will email you when it is decided.' : 'A refund was already made or requested for this purchase.', 'refund_requested');
  if (!st.refundable) throw new AppError(409, `This game cannot be refunded: ${st.reasons.map((r) => reasonText(s, r)).join(' ')}`, 'not_refundable', st.reasons.join(','));
  // Goes to the platform instead of through at once: the account refunds too often (and loses self-service from now
  // on), the play time could not be confirmed (the page's check-ins were blocked while the game kept running), or
  // automatic refunds are off.
  const review = st.review_reason || (st.unconfirmed ? 'play_unconfirmed' : s.refund_auto === false ? 'manual' : null);
  if (review === 'frequent') await env.DB.prepare('UPDATE users SET refund_review_at = ? WHERE id = ? AND refund_review_at IS NULL').bind(t, userId).run();
  const id = 'rfr_' + rid(16);
  const ins = await insertRequest(env, { id, p, status: 'pending', note: note.trim().slice(0, 1000) || null, played: st.played_seconds, review, by: review ? null : 'auto', t });
  if (!ins.meta.changes) throw new AppError(409, 'A refund was already made or requested for this purchase.', 'refund_requested');
  if (!review) {
    try {
      await settleRefund(env, s, p, id, 'buyer', pay);
    } catch (e) {
      // Stripe did not refund: nothing changed hands, so it waits for an admin, who can try again.
      console.error('refund: Stripe refund failed', p.id, (e as Error).message);
      await env.DB.prepare("UPDATE refund_requests SET review_reason = 'refund_failed', decided_by = NULL WHERE id = ? AND status = 'pending'").bind(id).run();
      await refundReceivedMail(env, id, origin).catch(() => false);
      return { id, status: 'pending', review_reason: 'refund_failed' };
    }
    await Promise.all([refundDecidedMail(env, id, origin).catch(() => false), saleRefundedMail(env, id, origin).catch(() => false)]);
    return { id, status: 'refunded', review_reason: null };
  }
  await refundReceivedMail(env, id, origin).catch(() => false);
  return { id, status: 'pending', review_reason: review };
}

/** An admin settles a waiting request: approve refunds it (it was eligible when it was made, whatever the time now),
 *  deny keeps the sale and tells the buyer why. */
export async function decideRefund(env: Env, s: RefundSettings, adminId: string, requestId: string, action: 'approve' | 'deny', note: string, pay: RefundPay, origin?: string): Promise<'refunded' | 'denied'> {
  const r = await env.DB.prepare("SELECT * FROM refund_requests WHERE id = ? AND status = 'pending'").bind(requestId).first<{ id: string; purchase_id: string }>();
  if (!r) throw notFound('No open refund request with that id. It may have been decided meanwhile.');
  const msg = note.trim().slice(0, 500) || null;
  if (action === 'deny') {
    const d = await env.DB.prepare("UPDATE refund_requests SET status = 'denied', decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ? AND status = 'pending'").bind('admin:' + adminId, msg, now(), r.id).run();
    if (!d.meta.changes) throw notFound('That request was decided meanwhile.');
    await refundDecidedMail(env, r.id, origin).catch(() => false);
    return 'denied';
  }
  const p = await env.DB.prepare('SELECT x.*, g.title FROM purchases x JOIN projects g ON g.id = x.project_id WHERE x.id = ?').bind(r.purchase_id).first<PurchaseRow>();
  if (!p || p.status !== 'paid') {
    await env.DB.prepare("UPDATE refund_requests SET status = 'closed', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'").bind('admin:' + adminId, now(), r.id).run();
    throw new AppError(409, 'That purchase was already refunded or disputed, so the request was closed.', 'not_paid');
  }
  await env.DB.prepare("UPDATE refund_requests SET decided_by = ?, decision_note = ? WHERE id = ? AND status = 'pending'").bind('admin:' + adminId, msg, r.id).run();
  await settleRefund(env, s, p, r.id, 'admin', pay);
  await Promise.all([refundDecidedMail(env, r.id, origin).catch(() => false), saleRefundedMail(env, r.id, origin).catch(() => false)]);
  return 'refunded';
}

/** An admin refunds a game purchase directly (support cases, or where the law requires it), with the same books. */
export async function adminRefund(env: Env, s: RefundSettings, adminId: string, purchaseId: string, pay: RefundPay, origin?: string): Promise<void> {
  const p = await env.DB.prepare('SELECT x.*, g.title FROM purchases x JOIN projects g ON g.id = x.project_id WHERE x.id = ?').bind(purchaseId).first<PurchaseRow>();
  if (!p) {
    if (await env.DB.prepare('SELECT 1 FROM skill_purchases WHERE id = ?').bind(purchaseId).first()) throw new AppError(409, 'Build skills are non-refundable.', 'skill_non_refundable');
    throw notFound();
  }
  if (p.status !== 'paid') throw new AppError(400, 'Already refunded.', 'bad_request');
  // gifts are final for everyone; a refund that the law requires is made in the Stripe Dashboard, whose webhook takes the
  // game back and the creator's credit like any refund
  if (p.gifted_by) throw new AppError(409, 'Gifted games are non-refundable. If a refund is required by law, refund the payment in the Stripe Dashboard: access and the creator\'s credit follow it.', 'gift_non_refundable');
  const open = await env.DB.prepare("SELECT id FROM refund_requests WHERE purchase_id = ? AND status = 'pending'").bind(p.id).first<{ id: string }>();
  let id = open?.id;
  if (!id) {
    id = 'rfr_' + rid(16);
    // a purchase whose earlier request was denied gets its row reused: one row per purchase
    const prev = await env.DB.prepare('SELECT id FROM refund_requests WHERE purchase_id = ?').bind(p.id).first<{ id: string }>();
    if (prev) { id = prev.id; await env.DB.prepare("UPDATE refund_requests SET status = 'pending' WHERE id = ?").bind(id).run(); }
    else await insertRequest(env, { id, p, status: 'pending', note: null, played: 0, review: 'admin', by: null, t: now() });
  }
  await env.DB.prepare('UPDATE refund_requests SET decided_by = ? WHERE id = ?').bind('admin:' + adminId, id).run();
  await settleRefund(env, s, p, id, 'admin', pay);
  if (p.provider === 'stripe') await Promise.all([refundDecidedMail(env, id, origin).catch(() => false), saleRefundedMail(env, id, origin).catch(() => false)]);
}

/** A buyer's purchase history: every game and build skill they bought, newest first, each game with its refund state. */
export async function purchaseHistory(env: Env, s: RS & Limits, userId: string, origin: string, opts?: { limit?: number; offset?: number }) {
  const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? 200)));
  const offset = Math.max(0, Math.min(200_000, Math.floor(opts?.offset ?? 0)));
  const page = Math.floor(offset / limit) + 1;
  const gameWhere = "x.user_id = ?1 AND NOT (x.gifted_by IS NOT NULL AND x.status = 'refunded')";
  const skillWhere = 'x.user_id = ?1';
  const [slice, tot] = await Promise.all([
    env.DB.prepare(`SELECT id, item, created_at FROM (
        SELECT x.id, 'game' AS item, x.created_at FROM purchases x JOIN projects p ON p.id = x.project_id WHERE ${gameWhere}
        UNION ALL
        SELECT x.id, 'skill' AS item, x.created_at FROM skill_purchases x JOIN projects p ON p.id = x.project_id WHERE ${skillWhere}
      ) ORDER BY created_at DESC, id DESC LIMIT ?2 OFFSET ?3`).bind(userId, limit, offset).all<{ id: string; item: 'game' | 'skill'; created_at: number }>(),
    env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM purchases x JOIN projects p ON p.id = x.project_id WHERE ${gameWhere}) +
        (SELECT COUNT(*) FROM skill_purchases x JOIN projects p ON p.id = x.project_id WHERE ${skillWhere}) AS n`).bind(userId).first<{ n: number }>(),
  ]);
  const gameIds = slice.results.filter((r) => r.item === 'game').map((r) => r.id);
  const skillIds = slice.results.filter((r) => r.item === 'skill').map((r) => r.id);
  const [games, skills] = await Promise.all([
    gameIds.length
      ? env.DB.prepare('SELECT x.*, p.title, p.slug FROM purchases x JOIN projects p ON p.id = x.project_id WHERE x.id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(gameIds)).all<PurchaseRow & { title: string; slug: string; refunded_at: number | null }>()
      : Promise.resolve({ results: [] as (PurchaseRow & { title: string; slug: string; refunded_at: number | null })[] }),
    skillIds.length
      ? env.DB.prepare('SELECT x.id, x.price_cents, x.status, x.provider, x.created_at, p.title, p.slug FROM skill_purchases x JOIN projects p ON p.id = x.project_id WHERE x.id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(skillIds)).all<{ id: string; price_cents: number; status: string; provider: string; created_at: number; title: string; slug: string }>()
      : Promise.resolve({ results: [] as { id: string; price_cents: number; status: string; provider: string; created_at: number; title: string; slug: string }[] }),
  ]);
  const states = await refundStates(env, s, userId, games.results);
  // gifts: who gave each one
  const givers = [...new Set(games.results.map((g) => g.gifted_by).filter((x): x is string => !!x))];
  const names = new Map<string, { id: string; name: string }>();
  if (givers.length) for (const u of (await env.DB.prepare('SELECT id, name, status FROM users WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(givers)).all<{ id: string; name: string; status: string }>()).results) names.set(u.id, { id: u.id, name: u.status === 'active' ? u.name : 'Deleted account' });
  const byGame = new Map(games.results.map((g) => [g.id, { id: g.id, item: 'game' as const, title: g.title, slug: g.slug, price_cents: g.price_cents, status: g.status, gift: g.provider !== 'stripe' || !!g.gifted_by, gifted_by: g.gifted_by ? names.get(g.gifted_by) ?? null : null, created_at: g.created_at, refunded_at: g.refunded_at ?? null, refund: pub(states.get(g.id)!) }]));
  const bySkill = new Map(skills.results.map((k) => [k.id, { id: k.id, item: 'skill' as const, title: k.title, slug: k.slug, price_cents: k.price_cents, status: k.status, gift: k.provider !== 'stripe', created_at: k.created_at, refunded_at: null, refund: null }]));
  const list = slice.results.map((r) => (r.item === 'game' ? byGame.get(r.id) : bySkill.get(r.id))).filter((x): x is NonNullable<typeof x> => !!x);
  const total = tot?.n || 0;
  return { purchases: list, total, page, per_page: limit, pages: Math.max(1, Math.ceil(total / limit)), policy: { window_hours: s.refund_window_hours, max_play_minutes: s.refund_max_play_minutes } };
}

/** Paginated refunds and requests for the admin console: open ones first, with totals. */
export async function adminRefundRequestsPage(env: Env, opts?: { limit?: number; offset?: number }) {
  const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? 20)));
  const offset = Math.max(0, Math.min(200_000, Math.floor(opts?.offset ?? 0)));
  const [rows, tot] = await Promise.all([
    env.DB.prepare(`SELECT q.*, p.title, p.slug, b.email AS buyer, b.refund_review_at AS buyer_review_at, o.email AS creator, x.status AS purchase_status
      FROM refund_requests q JOIN projects p ON p.id = q.project_id LEFT JOIN users b ON b.id = q.user_id LEFT JOIN users o ON o.id = q.owner_id LEFT JOIN purchases x ON x.id = q.purchase_id
      ORDER BY (q.status = 'pending') DESC, q.created_at DESC LIMIT ?1 OFFSET ?2`).bind(limit, offset).all<Record<string, unknown>>(),
    env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS waiting FROM refund_requests").first<{ n: number; waiting: number | null }>(),
  ]);
  return { refunds: rows.results, total: tot?.n || 0, waiting: tot?.waiting || 0 };
}

/** Every refund and request for the admin console: open ones first, with what the admin needs to decide. */
export async function adminRefundRequests(env: Env) {
  return (await adminRefundRequestsPage(env, { limit: 200, offset: 0 })).refunds;
}

/** An admin gives an account its self-service refunds back (or takes them away). */
export async function setRefundReview(env: Env, userId: string, on: boolean): Promise<void> {
  await env.DB.prepare('UPDATE users SET refund_review_at = ? WHERE id = ?').bind(on ? now() : null, userId).run();
}

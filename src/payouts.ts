// Creator payouts: moving available earnings from the platform's Stripe balance to creators' connected accounts.
import { AppError, type Env } from './env';
import { getSettings } from './settings';
import { stripe, stripeReady } from './stripe';
import { now, rid } from './util';

/**
 * Takes `amount` off a creator's available balance and, for Stripe, sends the Transfer. Used by the Withdraw button and
 * by the daily automatic payout. Refuses (409) when another withdrawal is pending or the balance no longer covers it.
 */
export async function startWithdrawal(env: Env, userId: string, amount: number, method: 'stripe' | 'manual', details = ''): Promise<{ id: string; result: 'paid' | 'failed' | 'unknown' | 'requested' }> {
  if (await env.DB.prepare("SELECT 1 FROM withdrawals WHERE user_id = ? AND status = 'pending'").bind(userId).first()) throw new AppError(409, 'You already have a withdrawal in progress.', 'pending');
  const id = 'wd_' + rid(16), t = now();
  // One statement debits the ledger only if the available balance still covers it, so two requests cannot both succeed.
  // The debit and the withdrawal record are one transaction, so a failure between them cannot take money off the balance
  // without a withdrawal to show for it (or the reverse).
  const [debit] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at)
       SELECT ?1, 'withdrawal', -?2, ?3, 'Withdrawal', ?4, ?4
       WHERE (SELECT COALESCE(SUM(CASE WHEN available_at <= ?4 OR amount_cents < 0 THEN amount_cents ELSE 0 END), 0) FROM ledger WHERE user_id = ?1) >= ?2`).bind(userId, amount, id, t),
    env.DB.prepare("INSERT INTO withdrawals (id, user_id, amount_cents, method, details, status, created_at) SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?6 WHERE EXISTS (SELECT 1 FROM ledger WHERE ref = ?1 AND kind = 'withdrawal')")
      .bind(id, userId, amount, method, details.slice(0, 500), t),
  ]);
  if (!debit.meta.changes) throw new AppError(409, 'Your balance changed. Try again.', 'conflict');
  if (method !== 'stripe') return { id, result: 'requested' };
  const acct = await env.DB.prepare('SELECT stripe_account FROM users WHERE id = ?').bind(userId).first<{ stripe_account: string | null }>();
  return { id, result: await sendTransfer(env, { id, user_id: userId, amount_cents: amount, stripe_account: acct!.stripe_account! }) };
}

/**
 * Daily automatic payout: every creator whose payout account is ready and whose available balance reached the minimum
 * gets it transferred, so the platform holds creator money only for the hold period. Stripe then pays it out to their bank
 * on the connected account's payout schedule. Creators can still withdraw earlier with the Withdraw button.
 */
export async function autoPayouts(env: Env, max = 200): Promise<void> {
  const s = await getSettings(env);
  if (!s.auto_payouts || !stripeReady(env)) return;
  const t = now();
  const rows = await env.DB.prepare(
    `SELECT u.id, SUM(CASE WHEN l.available_at <= ?1 OR l.amount_cents < 0 THEN l.amount_cents ELSE 0 END) AS available
     FROM users u JOIN ledger l ON l.user_id = u.id
     WHERE u.stripe_account IS NOT NULL AND u.stripe_payouts_enabled = 1 AND u.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM withdrawals w WHERE w.user_id = u.id AND w.status = 'pending')
     GROUP BY u.id HAVING available >= ?2 LIMIT ?3`).bind(t, Math.max(1, s.withdraw_min_cents), max).all<{ id: string; available: number }>();
  for (const r of rows.results) {
    try { await startWithdrawal(env, r.id, r.available, 'stripe'); }
    catch (e) { console.error('auto payout failed', r.id, (e as Error).message); }
  }
}

/**
 * Sends (or re-sends, with the same idempotency key, so Stripe never pays twice) a withdrawal's transfer. Only a clear
 * refusal returns the money to the balance; when the outcome is unknown the withdrawal stays pending for the next try.
 */
export async function sendTransfer(env: Env, w: { id: string; user_id: string; amount_cents: number; stripe_account: string }): Promise<'paid' | 'failed' | 'unknown'> {
  try {
    const tr = await stripe<{ id: string }>(env, 'POST', '/transfers', { amount: w.amount_cents, currency: 'usd', destination: w.stripe_account, metadata: { withdrawal: w.id, user_id: w.user_id } }, w.id);
    await env.DB.prepare("UPDATE withdrawals SET status = 'paid', provider_ref = ?, settled_at = ?, error = NULL WHERE id = ? AND status = 'pending'").bind(tr.id, now(), w.id).run();
    return 'paid';
  } catch (e) {
    if (e instanceof AppError && e.code === 'stripe_error') { await reverseWithdrawal(env, w.id, w.user_id, w.amount_cents, 'failed', e.message); return 'failed'; }
    await env.DB.prepare("UPDATE withdrawals SET error = ? WHERE id = ? AND status = 'pending'").bind(('Unconfirmed: ' + String((e as Error).message)).slice(0, 300), w.id).run();
    return 'unknown';
  }
}

/** Stripe withdrawals whose transfer was never confirmed, tried again (cron, every 10 minutes). */
export async function retryTransfers(env: Env, max = 20): Promise<void> {
  const rows = await env.DB.prepare("SELECT w.id, w.user_id, w.amount_cents, u.stripe_account FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = 'pending' AND w.method = 'stripe' AND w.created_at < ? AND u.stripe_account IS NOT NULL LIMIT ?")
    .bind(now() - 120000, max).all<{ id: string; user_id: string; amount_cents: number; stripe_account: string }>();
  for (const w of rows.results) await sendTransfer(env, w);
}

/** Returns a pending withdrawal's money to the balance, once: a withdrawal that was settled meanwhile is left alone. */
export async function reverseWithdrawal(env: Env, id: string, userId: string, amount: number, status: 'failed' | 'rejected', error: string): Promise<boolean> {
  const t = now();
  const [upd] = await env.DB.batch([
    env.DB.prepare("UPDATE withdrawals SET status = ?, error = ?, settled_at = ? WHERE id = ? AND status = 'pending'").bind(status, error.slice(0, 300), t, id),
    env.DB.prepare(`INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at)
      SELECT ?1, 'withdrawal_reversal', ?2, ?3, ?4, ?5, ?5 WHERE EXISTS (SELECT 1 FROM withdrawals WHERE id = ?3 AND status = ?6 AND settled_at = ?5)
        AND NOT EXISTS (SELECT 1 FROM ledger WHERE ref = ?3 AND kind = 'withdrawal_reversal')`).bind(userId, amount, id, status === 'failed' ? 'Withdrawal failed, returned' : 'Withdrawal rejected, returned', t, status),
  ]);
  return !!upd.meta.changes;
}

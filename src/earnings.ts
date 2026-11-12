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
  await env.DB.batch([
    env.DB.prepare("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, provider_ref, payment_intent, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)")
      .bind(id, a.userId, a.projectId, a.ownerId, a.priceCents, fee, net, a.provider, a.providerRef, a.paymentIntent || null, t),
    env.DB.prepare("INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at) VALUES (?, 'sale', ?, ?, ?, ?, ?)")
      .bind(a.ownerId, net, id, `Sale of ${a.title}`, t + s.earnings_hold_days * 86400000, t),
    env.DB.prepare('UPDATE projects SET sales = sales + 1 WHERE id = ?').bind(a.projectId),
  ]);
  return true;
}

/** Reverses a purchase after a refund: access is revoked and the creator's credit is taken back. */
export async function refundPurchase(env: Env, where: { paymentIntent?: string; id?: string }): Promise<boolean> {
  const p = await env.DB.prepare(`SELECT * FROM purchases WHERE ${where.id ? 'id = ?' : 'payment_intent = ?'} AND status = 'paid'`).bind(where.id || where.paymentIntent).first<{ id: string; owner_id: string; project_id: string; net_cents: number }>();
  if (!p) return false;
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE purchases SET status = 'refunded', refunded_at = ? WHERE id = ?").bind(t, p.id),
    env.DB.prepare("INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at) VALUES (?, 'refund', ?, ?, 'Refunded sale', ?, ?)").bind(p.owner_id, -p.net_cents, p.id, t, t),
    env.DB.prepare('UPDATE projects SET sales = MAX(0, sales - 1) WHERE id = ?').bind(p.project_id),
  ]);
  return true;
}

export async function owns(env: Env, userId: string, projectId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM purchases WHERE user_id = ? AND project_id = ? AND status = 'paid'").bind(userId, projectId).first());
}

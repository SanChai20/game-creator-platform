// Minimal Stripe client: Checkout for the one-time creator fee, Connect (Express) for creator payouts.
import { AppError, type Env } from './env';
import { hmacHex, safeEqual } from './util';

export const stripeReady = (env: Env) => !!env.STRIPE_SECRET_KEY;

function encode(obj: Record<string, unknown>, prefix = '', out: string[] = []): string[] {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encode(v as Record<string, unknown>, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

export async function stripe<T = any>(env: Env, method: 'GET' | 'POST', path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new AppError(503, 'Payments are not configured yet.', 'payments_unavailable');
  const qs = params ? encode(params).join('&') : '';
  const r = await fetch(`${env.STRIPE_API_BASE}/v1${path}${method === 'GET' && qs ? '?' + qs : ''}`, {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
    body: method === 'POST' ? qs : undefined,
  });
  const j = await r.json<any>().catch(() => ({}));
  if (!r.ok) throw new AppError(502, `Stripe: ${j?.error?.message || `HTTP ${r.status}`}`, 'stripe_error');
  return j as T;
}

/** Verifies a Stripe webhook signature (t=…,v1=…) and returns the parsed event. */
export async function verifyWebhook(env: Env, payload: string, header: string | null): Promise<any> {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new AppError(503, 'Webhook secret is not configured.');
  const parts = Object.fromEntries((header || '').split(',').map((p) => p.split('=') as [string, string]).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const t = Number(parts.t);
  const sigs = (header || '').split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) throw new AppError(400, 'Bad signature timestamp.');
  const expect = await hmacHex(env.STRIPE_WEBHOOK_SECRET, `${t}.${payload}`);
  if (!sigs.some((s) => safeEqual(s, expect))) throw new AppError(400, 'Bad signature.');
  return JSON.parse(payload);
}

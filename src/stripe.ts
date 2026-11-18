// Minimal Stripe client: Checkout for the one-time creator fee, Connect (Express) for creator payouts.
import { AppError, type Env } from './env';
import { hmacHex, safeEqual } from './util';

export const stripeReady = (env: Env) => !!env.STRIPE_SECRET_KEY;

// Every request names the API version it was written against, so a change to the account's default version in the
// Dashboard cannot change response shapes under this code. The webhook endpoint is created with the same version
// (docs/stripe.md), so event payloads match too. Upgrade both together.
export const STRIPE_API_VERSION = '2026-10-28.endive';

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
  // 'stripe_error': Stripe answered and refused, so nothing happened. 'stripe_unknown': no answer, a server error or a
  // request still in flight, so it may have gone through; retry with the same idempotency key to learn which.
  let r: Response;
  try {
    r = await fetch(`${env.STRIPE_API_BASE}/v1${path}${method === 'GET' && qs ? '?' + qs : ''}`, {
      method,
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'stripe-version': STRIPE_API_VERSION, 'content-type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
      body: method === 'POST' ? qs : undefined,
    });
  } catch (e) { throw new AppError(502, `Stripe could not be reached: ${(e as Error).message}`, 'stripe_unknown'); }
  const j = await r.json<any>().catch(() => ({}));
  if (!r.ok) throw new AppError(502, `Stripe: ${j?.error?.message || `HTTP ${r.status}`}`, r.status >= 500 || r.status === 409 || r.status === 429 ? 'stripe_unknown' : 'stripe_error');
  return j as T;
}

/**
 * Verifies a Stripe webhook signature (t=…,v1=…) and returns the parsed event. Stripe sends events about the platform
 * account and events about connected accounts from two separate endpoints, each with its own signing secret, both
 * pointed at /api/stripe/webhook: a signature from either secret is accepted.
 */
export async function verifyWebhook(env: Env, payload: string, header: string | null): Promise<any> {
  const secrets = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_CONNECT_WEBHOOK_SECRET].filter((x): x is string => !!x);
  if (!secrets.length) throw new AppError(503, 'Webhook secret is not configured.');
  const parts = Object.fromEntries((header || '').split(',').map((p) => p.split('=') as [string, string]).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const t = Number(parts.t);
  const sigs = (header || '').split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) throw new AppError(400, 'Bad signature timestamp.');
  for (const secret of secrets) {
    const expect = await hmacHex(secret, `${t}.${payload}`);
    if (sigs.some((s) => safeEqual(s, expect))) return JSON.parse(payload);
  }
  throw new AppError(400, 'Bad signature.');
}

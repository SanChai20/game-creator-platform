// Creator licenses. The console, publishing and (when the admin asks for it) creating projects need one.
//
// Two kinds, both one-time payments (never a subscription):
//   term      valid for `license_term_days` days from the moment it is granted (365 by default), `license_term_cents`
//   lifetime  never expires, `license_lifetime_cents`
// They cannot be turned into each other, and while one is still valid the account cannot buy either kind. A term license
// that ran out is no license: the account buys again, either kind. A price of 0 makes that kind free: asking for it
// grants it at once, with no checkout.
//
// Each grant is a `payments` row (kind creator_fee) with its plan and end. The account's license (users.creator_plan,
// users.creator_until) is recomputed from the rows still paid, so a refund or dispute of one grant leaves any other.
import type { Env, User } from './env';
import type { Settings } from './settings';
import { now, rid } from './util';

export const PLANS = ['term', 'lifetime'] as const;
export type Plan = (typeof PLANS)[number];
export const isPlan = (p: unknown): p is Plan => p === 'term' || p === 'lifetime';

export interface License { active: boolean; plan: Plan | null; until: number | null; since: number | null; expired: boolean }

const DAY = 86400000;

/** What an account's stored columns mean at time `at`. */
export function licenseOf(u: { creator?: number | boolean | null; creator_plan?: string | null; creator_until?: number | null; creator_since?: number | null }, at = now()): License {
  const plan = u.creator ? (isPlan(u.creator_plan) ? u.creator_plan : 'lifetime') : null;
  const until = plan === 'term' ? Number(u.creator_until) || 0 : null;
  const active = plan === 'lifetime' || (plan === 'term' && (until as number) > at);
  return { active, plan, until, since: u.creator_since ?? null, expired: plan === 'term' && !active };
}

/** The account as the rest of the platform sees it: `creator` is 1 only while the license is valid. */
export function withLicense<T extends User | null>(u: T, at = now()): T {
  if (!u) return u;
  return { ...u, creator: licenseOf(u, at).active ? 1 : 0, creator_licensed: u.creator };
}

export interface Offer { plan: Plan; cents: number; days: number | null }
export function offers(s: Settings): Offer[] {
  return [
    { plan: 'term', cents: s.license_term_cents, days: Math.max(1, s.license_term_days) },
    { plan: 'lifetime', cents: s.license_lifetime_cents, days: null },
  ];
}
export const offerOf = (s: Settings, plan: Plan) => offers(s).find((o) => o.plan === plan)!;
export const planName = (plan: Plan, days: number | null) => plan === 'lifetime' ? 'lifetime creator license' : `${days === 365 ? '1-year' : `${days}-day`} creator license`;

/** The license that a set of paid grants adds up to: lifetime wins; otherwise the term grant that ends last. */
export function licenseFromGrants(rows: { plan: string | null; expires_at: number | null }[]): { creator: 0 | 1; plan: Plan | null; until: number | null } {
  if (!rows.length) return { creator: 0, plan: null, until: null };
  if (rows.some((r) => r.plan !== 'term')) return { creator: 1, plan: 'lifetime', until: null };
  return { creator: 1, plan: 'term', until: Math.max(...rows.map((r) => Number(r.expires_at) || 0)) };
}

/** Recomputes an account's license from its paid grants. */
export async function syncLicense(env: Env, userId: string): Promise<void> {
  const rows = await env.DB.prepare("SELECT plan, expires_at FROM payments WHERE user_id = ? AND kind = 'creator_fee' AND status = 'paid'").bind(userId).all<{ plan: string | null; expires_at: number | null }>();
  const l = licenseFromGrants(rows.results);
  await env.DB.prepare('UPDATE users SET creator = ?, creator_plan = ?, creator_until = ?, creator_since = CASE WHEN ? = 1 THEN COALESCE(creator_since, ?) ELSE creator_since END WHERE id = ?')
    .bind(l.creator, l.plan, l.until, l.creator, now(), userId).run();
}

/** The license an account holds right now, read from the database. */
export async function currentLicense(env: Env, userId: string): Promise<License> {
  const u = await env.DB.prepare('SELECT creator, creator_plan, creator_until, creator_since FROM users WHERE id = ?').bind(userId).first<any>();
  return licenseOf(u || {});
}

export type GrantResult = 'granted' | 'exists' | 'already_licensed';

/**
 * Grants a license for a payment (or a free or admin grant). Idempotent on `ref`. A paid grant for an account that already
 * holds a valid license (two checkouts open at once) is not applied: the caller refunds it. Admin grants always apply.
 */
export async function grantLicense(env: Env, s: Settings, userId: string, plan: Plan, provider: string, ref: string, amount: number, force = false): Promise<GrantResult> {
  if (await env.DB.prepare('SELECT 1 FROM payments WHERE provider_ref = ?').bind(ref).first()) return 'exists';
  if (!force && (await currentLicense(env, userId)).active) return 'already_licensed';
  const at = now(), expires = plan === 'term' ? at + offerOf(s, 'term').days! * DAY : null;
  await env.DB.prepare("INSERT INTO payments (id, user_id, kind, amount_cents, provider, provider_ref, status, plan, expires_at, created_at) VALUES (?, ?, 'creator_fee', ?, ?, ?, 'paid', ?, ?, ?)")
    .bind('pay_' + rid(16), userId, amount, provider, ref, plan, expires, at).run();
  await syncLicense(env, userId);
  return 'granted';
}

/** Takes an account's license away (admin): every grant is marked revoked, the payments stay on record. */
export async function revokeLicense(env: Env, userId: string): Promise<void> {
  await env.DB.prepare("UPDATE payments SET status = 'revoked' WHERE user_id = ? AND kind = 'creator_fee' AND status = 'paid'").bind(userId).run();
  await syncLicense(env, userId);
}

/** What the web app gets: the license and, while there is none, what can be bought. */
export function licenseView(u: User, s: Settings, payments: boolean) {
  const l = licenseOf({ ...u, creator: u.creator_licensed ?? u.creator });
  return { license: l, offers: l.active ? [] : offers(s), payments };
}

export { offersText } from './mcp/services';

/** An account's license as agents read it. */
export function licenseText(u: User): string {
  const l = licenseOf({ ...u, creator: u.creator_licensed ?? u.creator });
  if (l.active) return l.plan === 'lifetime' ? 'active: lifetime, never expires' : `active: time-limited, valid until ${new Date(l.until!).toISOString().slice(0, 10)}`;
  return l.expired ? `expired on ${new Date(l.until!).toISOString().slice(0, 10)}` : 'none';
}

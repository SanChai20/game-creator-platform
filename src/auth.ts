import type { Context } from 'hono';
import { AppError, type Env, type User } from './env';
import { b64u, hmacHex, unb64, now, rid, sha256, token, safeEqual } from './util';

const ITER = 100_000; // the Workers runtime caps PBKDF2 at 100k iterations
const SESSION_DAYS = 30;
export const COOKIE = 'gcp_session';

export async function hashPassword(pw: string, salt: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(16))): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256);
  return `pbkdf2$${ITER}$${b64u(salt)}$${b64u(bits)}`;
}
export async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [, , salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  return safeEqual(await hashPassword(pw, unb64(salt)), stored);
}

export function readCookie(req: Request, name: string): string | null {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
export function sessionCookie(req: Request, value: string, maxAge: number): string {
  const secure = new URL(req.url).protocol === 'https:';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export async function createSession(env: Env, req: Request, userId: string): Promise<string> {
  const t = token(32);
  await env.DB.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, ua) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(t), userId, now(), now() + SESSION_DAYS * 86400000, (req.headers.get('user-agent') || '').slice(0, 200)).run();
  return sessionCookie(req, t, SESSION_DAYS * 86400);
}

const USER_COLS = 'u.id, u.email, u.name, u.role, u.status, u.creator, u.creator_since, u.stripe_account, u.stripe_payouts_enabled, u.payout_country, u.created_at';

export async function userFromRequest(env: Env, req: Request): Promise<User | null> {
  const t = readCookie(req, COOKIE);
  if (!t) return null;
  const u = await env.DB.prepare(`SELECT ${USER_COLS} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`)
    .bind(await sha256(t), now()).first<User>();
  return u && u.status === 'active' ? u : null;
}
export async function userById(env: Env, id: string): Promise<User | null> {
  return env.DB.prepare(`SELECT ${USER_COLS} FROM users u WHERE u.id = ?`).bind(id).first<User>();
}

// ---- guests: players without an account, only when the admin setting "Require login to play" is off ----
// A guest is a random id kept in a signed, HttpOnly cookie, so one browser keeps its saves between visits. The id has its
// own prefix, so every service can tell a guest from an account and refuse guests the moment the setting is switched on.
export const GUEST_PREFIX = 'guest_';
const GUEST_COOKIE = 'gcp_guest';
export const isGuestId = (id: unknown) => typeof id === 'string' && id.startsWith(GUEST_PREFIX);
/** The guest id this browser's signed cookie carries, if it is valid and has not been claimed by an account. Never mints one. */
export async function existingGuestId(env: Env, req: Request): Promise<string | null> {
  const raw = readCookie(req, GUEST_COOKIE), [id, sig] = (raw || '').split('.');
  if (!id || !sig || !/^guest_[a-z0-9]{12,40}$/.test(id) || !safeEqual(sig, await hmacHex(env.SESSION_SECRET, 'guest:' + id))) return null;
  // A guest id whose progress moved to an account (or was left behind) is never used again, even if its cookie was copied.
  if (await env.DB.prepare('SELECT 1 FROM guest_claims WHERE guest_id = ?').bind(id).first()) return null;
  return id;
}
/** The Set-Cookie header that removes this browser's guest id (after its progress moved to an account). */
export function clearGuestCookie(req: Request): string {
  const secure = new URL(req.url).protocol === 'https:';
  return `${GUEST_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
/** The guest id this browser already has, or a new one with the Set-Cookie header that keeps it (a year). */
export async function guestIdentity(env: Env, req: Request): Promise<{ id: string; name: string; cookie: string | null }> {
  const id = await existingGuestId(env, req);
  if (id) return { id, name: 'Guest', cookie: null };
  const fresh = GUEST_PREFIX + rid(20).toLowerCase();
  const secure = new URL(req.url).protocol === 'https:';
  return { id: fresh, name: 'Guest', cookie: `${GUEST_COOKIE}=${fresh}.${await hmacHex(env.SESSION_SECRET, 'guest:' + fresh)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}` };
}
/** The sign-in (sessions.id) this request's session cookie names, whether or not it is still valid. */
export async function loginIdOf(req: Request): Promise<string | null> {
  const t = readCookie(req, COOKIE);
  return t ? sha256(t) : null;
}
/** Ends the sign-in this browser had before (signing in again, maybe as someone else): games still open on it stop. */
export async function endPreviousLogin(env: Env, req: Request): Promise<void> {
  const id = await loginIdOf(req);
  if (id) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

export type Ctx = Context<{ Bindings: Env; Variables: { user: User | null; origin: string } }>;

export function requireUser(c: Ctx): User {
  const u = c.get('user');
  if (!u) throw new AppError(401, 'Sign in first.', 'unauthenticated');
  return u;
}
export function requireAdmin(c: Ctx): User {
  const u = requireUser(c);
  if (u.role !== 'admin') throw new AppError(403, 'Admins only.', 'forbidden');
  return u;
}

/** Fixed-window rate limit stored in D1. Throws 429 when exceeded. */
export async function rateLimit(env: Env, key: string, max: number, windowS: number): Promise<void> {
  const t = now();
  const r = await env.DB.prepare(
    `INSERT INTO rate_limits (k, n, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(k) DO UPDATE SET n = CASE WHEN reset_at < ?3 THEN 1 ELSE n + 1 END, reset_at = CASE WHEN reset_at < ?3 THEN ?2 ELSE reset_at END
     RETURNING n`).bind(key, t + windowS * 1000, t).first<{ n: number }>();
  if (r && r.n > max) throw new AppError(429, 'Too many attempts. Try again later.', 'rate_limited');
}

export const newUserId = () => 'u_' + rid(14);

// Signing up and signing in by email, with no password anywhere.
//
// Sign-up: the person gives an email and a display name, and gets a link. Nothing is created until the link is opened
// and confirmed (a press on the page it opens, so a mail scanner that fetches links cannot create accounts): only then
// does the account exist, with its email verified.
//
// Sign-in: the person gives their email and gets a 6-digit code, which signs them in once, within 10 minutes and 5 tries.
// With two-factor on, the authenticator code is asked after it (src/two-factor.ts). The same codes, with purpose
// 'confirm', prove it is still the owner before a sensitive change on the account page.
//
// The answer never tells whether an email has an account: an unknown email gets a handle all the same (no code ever
// matches it) and an email saying there is no account; a sign-up for a taken email gets an email saying so.
import type { Env } from './env';
import { hmacHex, now, rid, safeEqual, sha256, token } from './util';

export const LINK_TTL_MS = 24 * 60 * 60 * 1000;         // a sign-up link works for a day
export const CODE_TTL_MS = 10 * 60 * 1000;              // a code works for 10 minutes
export const CODE_TRIES = 5;                            // wrong codes before the handle is gone and a new code is needed
export const CONFIRM_WINDOW_MS = 10 * 60 * 1000;        // how long a proof (sign-in, code, passkey) allows sensitive changes
export type CodePurpose = 'login' | 'confirm';

export const normEmail = (raw: unknown) => String(raw || '').trim().toLowerCase().slice(0, 254);
export const validEmail = (e: string) => e.length <= 200 && /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(e);
export const cleanName = (raw: unknown) => String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
/** Only same-site paths are kept as a place to return to. */
export const safeNext = (n: unknown) => { const s = String(n || ''); return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') && s.length <= 500 ? s : null; };

// ---- sign-up links ------------------------------------------------------------------------------------------------
/** A new sign-up link token for this email (only its hash is kept). Earlier unused links for the email stop working. */
export async function newSignupLink(env: Env, email: string, name: string, next: string | null, at = now()): Promise<string> {
  const tk = token(32);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM signup_links WHERE email = ? OR expires_at < ?').bind(email, at),
    env.DB.prepare('INSERT INTO signup_links (id, email, name, next, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(await sha256(tk), email, name, next, at, at + LINK_TTL_MS),
  ]);
  return tk;
}
export interface SignupLink { email: string; name: string; next: string | null }
/** What a link is for, without using it (the page it opens shows this before the person confirms). */
export async function peekSignupLink(env: Env, tk: string, at = now()): Promise<SignupLink | null> {
  if (!tk || tk.length > 100) return null;
  return env.DB.prepare('SELECT email, name, next FROM signup_links WHERE id = ? AND used_at IS NULL AND expires_at > ?').bind(await sha256(tk), at).first<SignupLink>();
}
/** Uses a link once. Null when it is unknown, used or expired. */
export async function takeSignupLink(env: Env, tk: string, at = now()): Promise<SignupLink | null> {
  if (!tk || tk.length > 100) return null;
  return env.DB.prepare('UPDATE signup_links SET used_at = ?1 WHERE id = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING email, name, next').bind(at, await sha256(tk)).first<SignupLink>();
}

// ---- one-time codes -----------------------------------------------------------------------------------------------
/** Six digits from a uniform draw (rejection sampling, so no digit string is likelier than another). */
export function newCode(): string {
  const b = new Uint32Array(1), max = 4_294_000_000; // largest multiple of 1e6 below 2^32
  do crypto.getRandomValues(b); while (b[0] >= max);
  return String(b[0] % 1_000_000).padStart(6, '0');
}
const codeHash = (env: Env, handleId: string, code: string) => hmacHex(env.SESSION_SECRET, `email-code:${handleId}:${code}`);

/**
 * Starts a code for this email. Returns the handle the browser keeps and the code to email; the code is null for an email
 * with no account, whose handle never accepts anything. A new code replaces the email's earlier one for the same purpose.
 */
export async function startCode(env: Env, purpose: CodePurpose, email: string, userId: string | null, at = now()): Promise<{ handle: string; code: string | null }> {
  const handle = token(24), id = await sha256(handle), code = userId ? newCode() : null;
  // an account-less handle keeps a hash of a code nobody was sent, so it looks like any other row
  const hash = await codeHash(env, id, code || rid(24));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM email_codes WHERE (email = ? AND purpose = ?) OR expires_at < ?').bind(email, purpose, at),
    env.DB.prepare('INSERT INTO email_codes (id, purpose, email, user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, purpose, email, userId, hash, at, at + CODE_TTL_MS),
  ]);
  return { handle, code };
}

export type CodeResult = { ok: true; userId: string; email: string } | { ok: false; reason: 'expired' | 'bad_code' };
/** Checks a code against its handle. A good code is used up; after CODE_TRIES wrong ones, or 10 minutes, the handle is gone. */
export async function checkCode(env: Env, purpose: CodePurpose, handle: string, code: string, at = now()): Promise<CodeResult> {
  if (!handle || handle.length > 100) return { ok: false, reason: 'expired' };
  const id = await sha256(handle), clean = String(code || '').replace(/\D/g, '');
  // the try is counted before the code is compared, so parallel guesses all count
  const r = await env.DB.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?1 AND purpose = ?2 AND expires_at > ?3 AND attempts < ?4 RETURNING user_id, email, code_hash')
    .bind(id, purpose, at, CODE_TRIES).first<{ user_id: string | null; email: string; code_hash: string }>();
  if (!r) { await env.DB.prepare('DELETE FROM email_codes WHERE id = ?').bind(id).run(); return { ok: false, reason: 'expired' }; }
  if (clean.length !== 6 || !safeEqual(await codeHash(env, id, clean), r.code_hash) || !r.user_id) return { ok: false, reason: 'bad_code' };
  const used = await env.DB.prepare('DELETE FROM email_codes WHERE id = ?').bind(id).run();
  if (!used.meta.changes) return { ok: false, reason: 'expired' };   // a parallel request with the same code got there first
  return { ok: true, userId: r.user_id, email: r.email };
}

// ---- proof that the person at this sign-in is its owner -------------------------------------------------------------
/** Records a fresh proof on this sign-in (sessions.id), so sensitive changes are allowed for CONFIRM_WINDOW_MS. */
export async function markConfirmed(env: Env, loginId: string, at = now()): Promise<void> {
  await env.DB.prepare('UPDATE sessions SET confirmed_at = ? WHERE id = ?').bind(at, loginId).run();
}
/** Until when this sign-in may make sensitive changes, or 0 when it has to prove it is its owner first. */
export async function confirmedUntil(env: Env, loginId: string | null, at = now()): Promise<number> {
  if (!loginId) return 0;
  const r = await env.DB.prepare('SELECT confirmed_at FROM sessions WHERE id = ?').bind(loginId).first<{ confirmed_at: number | null }>();
  const until = (r?.confirmed_at || 0) + CONFIRM_WINDOW_MS;
  return until > at ? until : 0;
}

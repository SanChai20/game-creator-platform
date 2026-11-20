// Two-factor sign-in: an authenticator app (TOTP, RFC 6238: 6 digits, 30-second steps, HMAC-SHA1, the settings every
// authenticator app uses) plus ten single-use recovery codes. Optional for every account.
//
// This is account security, so it is the same for every account: a player, a creator and an admin all sign in through
// the one login, and nothing here knows or asks what the account does on the platform. What differs by role lives with
// that role: the creator console only points creators here (web/src/pages/Console.tsx), and an admin can turn it off for
// someone who lost both their authenticator and their recovery codes (src/routes/admin.ts).
//
// The secret is kept encrypted (AES-GCM, key derived from SESSION_SECRET), recovery codes and sign-in challenges only as
// sha-256 hashes. A code is accepted once: the step it belongs to is recorded, and an older or equal step is refused.
import type { Env } from './env';
import { b64u, now, sha256, token, unb64 } from './util';

const STEP_S = 30, DIGITS = 6, WINDOW = 1;               // a code from one step either side is accepted (clock drift)
export const SETUP_TTL_MS = 15 * 60 * 1000;               // a started setup must be confirmed within 15 minutes
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;            // the code must follow the password within 5 minutes
export const CHALLENGE_TRIES = 5;                         // wrong codes before the sign-in starts over from the password
export const RECOVERY_COUNT = 10;
const ISSUER_FALLBACK = 'HearthCade';
const enc = new TextEncoder();

// ---- TOTP ---------------------------------------------------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Uint8Array): string {
  let bits = 0, v = 0, out = '';
  for (const b of bytes) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(v << (5 - bits)) & 31];
  return out;
}
export function unbase32(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.toUpperCase().replace(/[\s=-]/g, ''), out: number[] = [];
  let bits = 0, v = 0;
  for (const ch of clean) { const i = B32.indexOf(ch); if (i < 0) throw new Error('bad base32'); v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(out);
}

/** The code an authenticator shows for this secret at this 30-second step. */
export async function totpAt(secret: Uint8Array<ArrayBuffer>, step: number): Promise<string> {
  const msg = new Uint8Array(8);
  let x = step;
  for (let i = 7; i >= 0; i--) { msg[i] = x & 255; x = Math.floor(x / 256); }
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg)), o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}
export const stepOf = (ms: number) => Math.floor(ms / 1000 / STEP_S);

/** The step this code belongs to (within the allowed drift), or null. Compares every candidate, so timing says nothing. */
export async function matchTotp(secret: Uint8Array<ArrayBuffer>, code: string, at = now()): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const s = stepOf(at);
  let found: number | null = null;
  for (let d = -WINDOW; d <= WINDOW; d++) { const c = await totpAt(secret, s + d); let diff = 0; for (let i = 0; i < DIGITS; i++) diff |= c.charCodeAt(i) ^ code.charCodeAt(i); if (diff === 0 && found === null) found = s + d; }
  return found;
}

/** The otpauth:// link authenticator apps read from the QR code (or that a phone opens directly). */
export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const iss = issuer.trim() || ISSUER_FALLBACK;
  return `otpauth://totp/${encodeURIComponent(iss)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(iss)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_S}`;
}

// ---- the secret at rest -------------------------------------------------------------------------------------------
async function sealKey(env: Env): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('gcp-totp'), info: enc.encode('totp secret v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
/** The secret encrypted for the users table, bound to its account (a sealed secret copied to another row does not open). */
export async function seal(env: Env, userId: string, secret: Uint8Array<ArrayBuffer>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(userId) }, await sealKey(env), secret);
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}
export async function unseal(env: Env, userId: string, sealed: string | null): Promise<Uint8Array<ArrayBuffer> | null> {
  const [v, iv, ct] = (sealed || '').split('.');
  if (v !== 'v1' || !iv || !ct) return null;
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(userId) }, await sealKey(env), unb64(ct))); }
  catch { return null; }
}

// ---- recovery codes -----------------------------------------------------------------------------------------------
const RC_ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';   // no 0/o, 1/l/i: easy to read back from paper
/** Recovery codes are typed in any case, with or without the dash or spaces. */
export const normRecovery = (s: string) => s.toLowerCase().replace(/[\s-]/g, '');
function newRecoveryCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(10));
  let s = '';
  for (let i = 0; i < 10; i++) s += RC_ALPHA[b[i] % RC_ALPHA.length];
  return s.slice(0, 5) + '-' + s.slice(5);
}
const rcId = (userId: string, code: string) => sha256('rc:' + userId + ':' + normRecovery(code));

/** A fresh set of recovery codes, replacing every earlier one. Shown to the person once; only hashes are kept. */
export async function replaceRecoveryCodes(env: Env, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode), t = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(userId),
    ...(await Promise.all(codes.map(async (c) => env.DB.prepare('INSERT INTO recovery_codes (user_id, id, created_at) VALUES (?, ?, ?)').bind(userId, await rcId(userId, c), t)))),
  ]);
  return codes;
}

// ---- state --------------------------------------------------------------------------------------------------------
export interface TwoFactorState { enabled: boolean; enabled_at: number | null; recovery_left: number }
export async function twoFactorState(env: Env, userId: string): Promise<TwoFactorState> {
  const u = await env.DB.prepare('SELECT totp_enabled_at FROM users WHERE id = ?').bind(userId).first<{ totp_enabled_at: number | null }>();
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').bind(userId).first<{ n: number }>();
  return { enabled: !!u?.totp_enabled_at, enabled_at: u?.totp_enabled_at || null, recovery_left: Number(n?.n) || 0 };
}
export async function twoFactorOn(env: Env, userId: string): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT totp_enabled_at FROM users WHERE id = ?').bind(userId).first<{ totp_enabled_at: number | null }>())?.totp_enabled_at;
}

// ---- turning it on and off ----------------------------------------------------------------------------------------
/** Starts setup: a new secret, kept as pending until a code from it confirms the person's app has it. */
export async function beginSetup(env: Env, user: { id: string; email: string }, issuer: string, at = now()): Promise<{ secret: string; uri: string }> {
  const secret = crypto.getRandomValues(new Uint8Array(20));
  await env.DB.prepare('UPDATE users SET totp_pending = ?, totp_pending_at = ? WHERE id = ?').bind(await seal(env, user.id, secret), at, user.id).run();
  const b32 = base32(secret);
  return { secret: b32, uri: otpauthUri(b32, user.email, issuer) };
}

/** Confirms setup with a code from the pending secret: two-factor is on, and the recovery codes come back (once). */
export async function confirmSetup(env: Env, userId: string, code: string, at = now()): Promise<string[] | null> {
  const r = await env.DB.prepare('SELECT totp_pending, totp_pending_at FROM users WHERE id = ?').bind(userId).first<{ totp_pending: string | null; totp_pending_at: number | null }>();
  if (!r?.totp_pending || !r.totp_pending_at || r.totp_pending_at + SETUP_TTL_MS < at) return null;
  const secret = await unseal(env, userId, r.totp_pending);
  const step = secret && (await matchTotp(secret, code.trim(), at));
  if (step == null) return null;
  await env.DB.prepare('UPDATE users SET totp_secret = totp_pending, totp_enabled_at = ?, totp_last_step = ?, totp_pending = NULL, totp_pending_at = NULL WHERE id = ?').bind(at, step, userId).run();
  return replaceRecoveryCodes(env, userId);
}

/** Turns two-factor off and forgets the secret and every recovery code. */
export async function disableTwoFactor(env: Env, userId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_pending = NULL, totp_pending_at = NULL WHERE id = ?').bind(userId),
    env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM login_challenges WHERE user_id = ?').bind(userId),
  ]);
}

/**
 * Checks a code from the authenticator, or a recovery code, for an account with two-factor on, and uses it up.
 * 'totp' or 'recovery' when it was good; null otherwise (also when the same authenticator code is tried a second time).
 */
export async function useCode(env: Env, userId: string, raw: string, at = now()): Promise<'totp' | 'recovery' | null> {
  const code = String(raw || '').trim().slice(0, 40);
  const u = await env.DB.prepare('SELECT totp_secret, totp_enabled_at FROM users WHERE id = ?').bind(userId).first<{ totp_secret: string | null; totp_enabled_at: number | null }>();
  if (!u?.totp_enabled_at) return null;
  const digits = code.replace(/\s/g, '');
  if (/^\d{6}$/.test(digits)) {
    const secret = await unseal(env, userId, u.totp_secret);
    const step = secret && (await matchTotp(secret, digits, at));
    if (step == null) return null;
    // the step is recorded in the same statement that checks it, so two requests with one code cannot both pass
    const r = await env.DB.prepare('UPDATE users SET totp_last_step = ?1 WHERE id = ?2 AND (totp_last_step IS NULL OR totp_last_step < ?1)').bind(step, userId).run();
    return r.meta.changes ? 'totp' : null;
  }
  if (normRecovery(code).length !== 10) return null;
  const r = await env.DB.prepare('UPDATE recovery_codes SET used_at = ?1 WHERE user_id = ?2 AND id = ?3 AND used_at IS NULL').bind(at, userId, await rcId(userId, code)).run();
  return r.meta.changes ? 'recovery' : null;
}

// ---- the second step of a sign-in ---------------------------------------------------------------------------------
/** After the right password on an account with two-factor on: a token for the browser to send back with the code. */
export async function startChallenge(env: Env, userId: string, at = now()): Promise<string> {
  const tk = token(32);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_challenges WHERE user_id = ? AND expires_at < ?').bind(userId, at),
    env.DB.prepare('INSERT INTO login_challenges (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(tk), userId, at, at + CHALLENGE_TTL_MS),
  ]);
  return tk;
}

export type ChallengeResult = { ok: true; userId: string; kind: 'totp' | 'recovery' } | { ok: false; reason: 'expired' | 'bad_code' };
/**
 * Answers a sign-in challenge. A good code ends the challenge and names the account to sign in. A wrong one counts
 * against it; after CHALLENGE_TRIES wrong codes, or five minutes, it is gone and the sign-in starts again from the password.
 */
export async function answerChallenge(env: Env, tk: string, code: string, at = now(), perAccount?: (userId: string) => Promise<void>): Promise<ChallengeResult> {
  if (!tk || tk.length > 100) return { ok: false, reason: 'expired' };
  const id = await sha256(tk);
  // the try is counted before the code is checked, so parallel guesses all count
  const c = await env.DB.prepare('UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ?1 AND expires_at > ?2 AND attempts < ?3 RETURNING user_id')
    .bind(id, at, CHALLENGE_TRIES).first<{ user_id: string }>();
  if (!c) { await env.DB.prepare('DELETE FROM login_challenges WHERE id = ?').bind(id).run(); return { ok: false, reason: 'expired' }; }
  // A limit per account as well as per challenge: whoever has the password can start challenge after challenge (from many
  // networks), and five guesses each would otherwise add up to thousands of guesses at the six digits a day.
  if (perAccount) await perAccount(c.user_id);
  const kind = await useCode(env, c.user_id, code, at);
  if (!kind) return { ok: false, reason: 'bad_code' };
  await env.DB.prepare('DELETE FROM login_challenges WHERE id = ?').bind(id).run();
  return { ok: true, userId: c.user_id, kind };
}

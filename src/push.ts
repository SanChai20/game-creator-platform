// Push notifications, the Worker side: the platform's VAPID key pair (made on first use, kept sealed in D1), each
// browser's subscription, and sending. What becomes a notification, its text and the crypto are src/push-core.ts.
//
// A notification goes out when a SocialHub event (src/social.ts pushTo) reaches no page the player is looking at: with
// the platform open in front of them, the page's own pop-up says it. A subscription belongs to the sign-in it was made
// under, so once that sign-in ends (sign out, expiry, a password change) the browser gets nothing more and the row goes.
import type { Env } from './env';
import { seal, unseal } from './two-factor';
import { now } from './util';
import { encryptPayload, newVapidKeys, noteFor, pushLang, readOff, testNote, vapidAuth, type Note, type Subscription, type VapidKeys } from './push-core';

const KEY_OWNER = 'push:vapid', MAX_PER_USER = 10, MAX_FAILS = 5;
const enc = new TextEncoder(), dec = new TextDecoder();
let cached: VapidKeys | null = null;

/** The platform's VAPID keys, made and stored the first time they are needed. */
export async function vapidKeys(env: Env): Promise<VapidKeys> {
  if (cached) return cached;
  const load = async () => {
    const r = await env.DB.prepare('SELECT public_key, sealed_private FROM push_keys WHERE id = 1').first<{ public_key: string; sealed_private: string }>();
    if (!r) return null;
    const raw = await unseal(env, KEY_OWNER, r.sealed_private);
    return raw ? { publicKey: r.public_key, privateJwk: JSON.parse(dec.decode(raw)) as JsonWebKey } : null;
  };
  let k = await load();
  if (!k) {
    const fresh = await newVapidKeys();
    // two requests racing here: the first insert wins and both read it back
    await env.DB.prepare('INSERT OR IGNORE INTO push_keys (id, public_key, sealed_private, created_at) VALUES (1, ?, ?, ?)')
      .bind(fresh.publicKey, await seal(env, KEY_OWNER, enc.encode(JSON.stringify(fresh.privateJwk)) as Uint8Array<ArrayBuffer>), now()).run();
    k = await load();
    if (!k) throw new Error('push keys could not be stored or opened (SESSION_SECRET changed?)');
  }
  return (cached = k);
}

export async function saveSubscription(env: Env, userId: string, sessionId: string, sub: Subscription, lang: string, ua: string | null) {
  const t = now();
  await env.DB.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, session_id, p256dh, auth, lang, ua, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, session_id = excluded.session_id, p256dh = excluded.p256dh, auth = excluded.auth, lang = excluded.lang, ua = excluded.ua, fails = 0`)
    .bind(sub.endpoint, userId, sessionId, sub.p256dh, sub.auth, pushLang(lang), (ua || '').slice(0, 300), t).run();
  // the oldest go when an account has more browsers than the cap
  await env.DB.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint NOT IN (SELECT endpoint FROM push_subscriptions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ${MAX_PER_USER})`).bind(userId).run();
}
export async function dropSubscription(env: Env, userId: string, endpoint: string) {
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').bind(userId, endpoint).run();
}
export async function subscribed(env: Env, userId: string, endpoint: string): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').bind(userId, endpoint).first());
}
export async function pushOff(env: Env, userId: string): Promise<string[]> {
  const r = await env.DB.prepare('SELECT off FROM push_prefs WHERE user_id = ?').bind(userId).first<{ off: string }>();
  return readOff(r?.off);
}
export async function setPushOff(env: Env, userId: string, off: string[]) {
  await env.DB.prepare('INSERT INTO push_prefs (user_id, off) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET off = excluded.off').bind(userId, readOff(off.join(',')).join(',')).run();
}

interface Row { endpoint: string; p256dh: string; auth: string; lang: string; session_id: string; fails: number }
const subjectOf = (env: Env) => env.PUBLIC_ORIGIN || 'https://hearthcade.com';

/** Sends one notification to one browser. True when the push service took it. */
async function sendOne(env: Env, keys: VapidKeys, r: Row, note: Note): Promise<boolean> {
  const body = await encryptPayload(r, JSON.stringify({ title: note.title, body: note.body, url: note.url, tag: note.tag }));
  let res: Response;
  try {
    res = await fetch(r.endpoint, {
      method: 'POST', body: body as BodyInit,
      headers: { Authorization: await vapidAuth(r.endpoint, keys, subjectOf(env)), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: note.kind === 'messages' || note.kind === 'invites' ? 'high' : 'normal' },
    });
  } catch (e) { console.warn('push send', String((e as Error).message || e)); return false; }
  if (res.ok) { await env.DB.prepare('UPDATE push_subscriptions SET last_ok_at = ?, fails = 0 WHERE endpoint = ?').bind(now(), r.endpoint).run(); return true; }
  // gone (unsubscribed, expired) or refused for good: forget it; anything else counts as a failure, and enough of them forget it too
  if (res.status === 404 || res.status === 410 || res.status === 403 || r.fails + 1 >= MAX_FAILS) await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(r.endpoint).run();
  else await env.DB.prepare('UPDATE push_subscriptions SET fails = fails + 1 WHERE endpoint = ?').bind(r.endpoint).run();
  console.warn('push refused', res.status, new URL(r.endpoint).hostname);
  return false;
}

/** The subscriptions of an account whose sign-in is still on; the others are removed on the way. */
async function liveRows(env: Env, userId: string): Promise<Row[]> {
  const rs = await env.DB.prepare(`SELECT p.endpoint, p.p256dh, p.auth, p.lang, p.session_id, p.fails, s.id AS alive FROM push_subscriptions p
    LEFT JOIN sessions s ON s.id = p.session_id AND s.expires_at > ? WHERE p.user_id = ?`).bind(now(), userId).all<Row & { alive: string | null }>();
  const dead = rs.results.filter((r) => !r.alive);
  if (dead.length) await env.DB.batch(dead.map((r) => env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(r.endpoint)));
  return rs.results.filter((r) => r.alive);
}

/** Turns a SocialHub event into notifications on the account's browsers. Never throws. Returns how many were taken. */
export async function notify(env: Env, userId: string, ev: Record<string, unknown>): Promise<number> {
  try {
    if (!noteFor(ev, 'en')) return 0;
    const rows = await liveRows(env, userId);
    if (!rows.length) return 0;
    const off = await pushOff(env, userId), keys = await vapidKeys(env);
    let n = 0;
    for (const r of rows) {
      const note = noteFor(ev, pushLang(r.lang));
      if (note && !off.includes(note.kind)) n += (await sendOne(env, keys, r, note)) ? 1 : 0;
    }
    return n;
  } catch (e) { console.warn('push notify', String((e as Error).message || e)); return 0; }
}

/** The "Notifications are on" message, to one browser of the account. */
export async function sendTest(env: Env, userId: string, endpoint: string): Promise<boolean> {
  const r = (await liveRows(env, userId)).find((x) => x.endpoint === endpoint);
  return !!r && sendOne(env, await vapidKeys(env), r, testNote(pushLang(r.lang)));
}

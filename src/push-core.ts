// Web Push without a library: VAPID (RFC 8292) and message encryption (RFC 8291, aes128gcm), on WebCrypto only, so it
// runs the same in the Worker and in Node's tests. Also what may be pushed where: the push services a subscription may
// point at (no other host is ever contacted, so a subscription cannot be used to make the platform call an arbitrary
// address), the events that become a notification, and their text in the platform's six languages.
// src/push.ts is the Worker side (keys, subscriptions, sending); tests in tests/push.mjs.

const enc = new TextEncoder();

export const b64u = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ''; for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = (s: string) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/'), p = t + '='.repeat((4 - (t.length % 4)) % 4);
  const bin = atob(p), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// ---- where a subscription may point ----------------------------------------------------------------------------------
// The browsers' own push services: Chrome, Edge (and other Chromium browsers) through FCM or Windows, Firefox, and
// Safari on iPhone, iPad and Mac through Apple.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^push\.services\.mozilla\.com$/, /^(.+\.)?push\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];
export function pushEndpointOk(endpoint: unknown): boolean {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false;
  try { const u = new URL(endpoint); return u.protocol === 'https:' && !u.port && !u.username && PUSH_HOSTS.some((r) => r.test(u.hostname)); } catch { return false; }
}

export interface Subscription { endpoint: string; p256dh: string; auth: string }
/** A PushSubscription's JSON as the browser gives it, checked; null when it is not one. */
export function readSubscription(v: unknown): Subscription | null {
  const s = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!s || !pushEndpointOk(s.endpoint) || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') return null;
  try { if (unb64u(s.keys.p256dh).length !== 65 || unb64u(s.keys.auth).length !== 16) return null; } catch { return null; }
  return { endpoint: s.endpoint as string, p256dh: s.keys.p256dh, auth: s.keys.auth };
}

// ---- VAPID -----------------------------------------------------------------------------------------------------------
export interface VapidKeys { publicKey: string; privateJwk: JsonWebKey }
export async function newVapidKeys(): Promise<VapidKeys> {
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  return { publicKey: b64u(await crypto.subtle.exportKey('raw', k.publicKey) as ArrayBuffer), privateJwk: await crypto.subtle.exportKey('jwk', k.privateKey) as JsonWebKey };
}
/** The Authorization header for one push service: a JWT for its origin, signed with the platform's key, valid 12 hours. */
export async function vapidAuth(endpoint: string, keys: VapidKeys, subject: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowS + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', { ...keys.privateJwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.publicKey}`;
}

// ---- the message -----------------------------------------------------------------------------------------------------
const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) => {
  const k = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, k, bytes * 8));
};
/** The keys the content key and nonce come from (RFC 8291 section 3.4), shared by encrypt and the tests' decrypt. */
export async function contentKeys(ecdh: Uint8Array, auth: Uint8Array, uaPublic: Uint8Array, asPublic: Uint8Array, salt: Uint8Array) {
  const ikm = await hkdf(auth, ecdh, cat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  return { cek: await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16), nonce: await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12) };
}
/** Encrypts one message for one subscription: the request body, in a single record. */
export async function encryptPayload(sub: Subscription, payload: string): Promise<Uint8Array> {
  const uaPublic = unb64u(sub.p256dh), auth = unb64u(sub.auth), salt = crypto.getRandomValues(new Uint8Array(16));
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey) as ArrayBuffer);
  const ua = await crypto.subtle.importKey('raw', uaPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua } as unknown as SubtleCryptoDeriveKeyAlgorithm, as.privateKey, 256));
  const { cek, nonce } = await contentKeys(ecdh, auth, uaPublic, asPublic, salt);
  const key = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, cat(enc.encode(payload), new Uint8Array([2])) as BufferSource));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

// ---- what becomes a notification ---------------------------------------------------------------------------------------
/** The kinds a player can switch on and off (Account, Notifications on this device). All on by default. */
export const PUSH_KINDS = ['requests', 'invites', 'messages', 'creators'] as const;
export type PushKind = typeof PUSH_KINDS[number];
export const PUSH_LANGS = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es'] as const;
type Lang = typeof PUSH_LANGS[number];
export const pushLang = (l: unknown): Lang => (PUSH_LANGS as readonly string[]).includes(l as string) ? l as Lang : 'en';

const TEXT: Record<string, Record<Lang, string>> = {
  request: { en: '{name} sent you a friend request', zh: '{name} 向你发送了好友请求', 'zh-TW': '{name} 向你傳送了好友邀請', ja: '{name} さんからフレンド申請が届きました', ko: '{name}님이 친구 요청을 보냈습니다', es: '{name} te ha enviado una solicitud de amistad' },
  accepted: { en: '{name} accepted your friend request', zh: '{name} 接受了你的好友请求', 'zh-TW': '{name} 接受了你的好友邀請', ja: '{name} さんがフレンド申請を承認しました', ko: '{name}님이 친구 요청을 수락했습니다', es: '{name} ha aceptado tu solicitud de amistad' },
  invite: { en: '{name} invited you to play {game}', zh: '{name} 邀请你一起玩 {game}', 'zh-TW': '{name} 邀請你一起玩 {game}', ja: '{name} さんから {game} への招待が届きました', ko: '{name}님이 {game} 게임에 초대했습니다', es: '{name} te ha invitado a jugar a {game}' },
  new_game: { en: '{name} published a new game: {game}', zh: '{name} 发布了新游戏：{game}', 'zh-TW': '{name} 發布了新遊戲：{game}', ja: '{name} さんが新しいゲームを公開しました：{game}', ko: '{name}님이 새 게임을 공개했습니다: {game}', es: '{name} ha publicado un juego nuevo: {game}' },
  message: { en: 'Message from {name}', zh: '来自 {name} 的消息', 'zh-TW': '來自 {name} 的訊息', ja: '{name} さんからのメッセージ', ko: '{name}님의 메시지', es: 'Mensaje de {name}' },
  test: { en: 'Notifications are on', zh: '通知已开启', 'zh-TW': '通知已開啟', ja: '通知がオンになりました', ko: '알림이 켜졌습니다', es: 'Las notificaciones están activadas' },
  testBody: { en: 'HearthCade will tell you here when friends write or invite you.', zh: '好友给你发消息或邀请你时，HearthCade 会在这里通知你。', 'zh-TW': '好友傳訊息或邀請你時，HearthCade 會在這裡通知你。', ja: 'フレンドからのメッセージや招待をここでお知らせします。', ko: '친구가 메시지를 보내거나 초대하면 여기에서 알려 드립니다.', es: 'HearthCade te avisará aquí cuando tus amigos te escriban o te inviten.' },
};
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
const short = (s: unknown, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export interface Note { kind: PushKind | 'test'; title: string; body: string; url: string; tag: string }
type GameLike = { slug?: string; title?: string; i18n?: Record<string, { title?: string }> };
/**
 * The notification for one SocialHub event (src/social.ts pushTo), or null when it never becomes one: events that only
 * refresh a page, the sender's own copy, and anything quiet (a Busy player gets no pop-ups, and no notifications either).
 */
export function noteFor(ev: Record<string, any>, lang: Lang): Note | null {
  if (!ev || ev.quiet || ev.mine || ev.test_bot) return null;
  const name = short(ev.from?.name ?? ev.by?.name ?? ev.invite?.from?.name, 40);
  switch (ev.kind) {
    case 'request': return name ? { kind: 'requests', title: fill(TEXT.request[lang], { name }), body: '', url: '/?friends=requests', tag: 'request:' + (ev.from?.id || '') } : null;
    case 'accepted': return name ? { kind: 'requests', title: fill(TEXT.accepted[lang], { name }), body: '', url: '/?friends=friends', tag: 'accepted:' + (ev.by?.id || '') } : null;
    case 'invite': {
      const g: GameLike = ev.invite?.game || {}, game = short(g.i18n?.[lang]?.title || g.title, 60);
      return name && game && g.slug ? { kind: 'invites', title: fill(TEXT.invite[lang], { name, game }), body: '', url: `/g/${encodeURIComponent(g.slug)}`, tag: 'invite:' + (ev.invite?.id || '') } : null;
    }
    case 'new_game': {
      // a creator this player follows published a new game (src/creator-news.ts)
      const g: GameLike = ev.game || {}, game = short(g.i18n?.[lang]?.title || g.title, 60), who = short(ev.creator?.name, 40);
      return who && game && g.slug ? { kind: 'creators', title: fill(TEXT.new_game[lang], { name: who, game }), body: '', url: `/g/${encodeURIComponent(g.slug)}`, tag: 'new_game:' + g.slug } : null;
    }
    case 'message': {
      if (!ev.from || !ev.msg) return null;
      return name ? { kind: 'messages', title: fill(TEXT.message[lang], { name }), body: short(ev.msg.text ?? ev.msg.body, 140), url: `/?chat=${encodeURIComponent(ev.from.id)}`, tag: 'chat:' + ev.from.id } : null;
    }
    default: return null;
  }
}
export const testNote = (lang: Lang): Note => ({ kind: 'test', title: TEXT.test[lang], body: TEXT.testBody[lang], url: '/account', tag: 'test' });

/** The kinds switched off, as stored ("messages,invites"), read back safely. */
export const readOff = (s: unknown): PushKind[] => String(s || '').split(',').filter((k): k is PushKind => (PUSH_KINDS as readonly string[]).includes(k));

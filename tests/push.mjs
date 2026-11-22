// Push notifications (src/push-core.ts): the message decrypts for the browser it was made for (RFC 8291), the VAPID
// header verifies with the platform's public key (RFC 8292), only browsers' push services are ever contacted, and only
// the right events become notifications, in the player's language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64u, contentKeys, encryptPayload, newVapidKeys, noteFor, pushEndpointOk, pushLang, readOff, readSubscription, testNote, unb64u, vapidAuth } from '../src/push-core.ts';

const enc = new TextEncoder(), dec = new TextDecoder();

// a browser: its key pair and auth secret, as PushManager.subscribe makes them
async function browser() {
  const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey)), auth = crypto.getRandomValues(new Uint8Array(16));
  return { k, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', p256dh: b64u(pub), auth: b64u(auth) }, pub, auth };
}
// what the browser does with a message (RFC 8291 section 3)
async function decrypt(b, body) {
  const salt = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0), idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  assert.equal(rs, 4096); assert.equal(idlen, 65);
  const as = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: as }, b.k.privateKey, 256));
  const { cek, nonce } = await contentKeys(ecdh, b.auth, b.pub, asPublic, salt);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return dec.decode(plain.slice(0, -1));
}

test('a message decrypts for its browser only', async () => {
  const b = await browser(), other = await browser();
  const msg = JSON.stringify({ title: 'Mia sent you a friend request', url: '/?friends=requests', note: 'ünïcødé ✓' });
  const body = await encryptPayload(b.sub, msg);
  assert.equal(await decrypt(b, body), msg);
  await assert.rejects(decrypt({ ...other, pub: b.pub }, body), 'another browser cannot read it');
  assert.notDeepEqual(await encryptPayload(b.sub, msg), body, 'a fresh key and salt every time');
});

test('the VAPID header is a JWT for the push service, signed by the platform key', async () => {
  const keys = await newVapidKeys(), t0 = 1_800_000_000;
  const h = await vapidAuth('https://web.push.apple.com/QGsome/token', keys, 'https://hearthcade.com', t0);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h);
  assert.ok(m, h);
  assert.equal(m[4], keys.publicKey);
  assert.deepEqual(JSON.parse(dec.decode(unb64u(m[1]))), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(dec.decode(unb64u(m[2]))), { aud: 'https://web.push.apple.com', exp: t0 + 12 * 3600, sub: 'https://hearthcade.com' });
  const pub = await crypto.subtle.importKey('raw', unb64u(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64u(m[3]), enc.encode(`${m[1]}.${m[2]}`)));
  assert.equal(unb64u(keys.publicKey).length, 65);
});

test('only the browsers\' own push services are contacted', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://api.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/w/?token=x'])
    assert.equal(pushEndpointOk(ok), true, ok);
  for (const no of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://evil.com/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.com/x', 'https://push.apple.com.evil.com/', 'https://user@fcm.googleapis.com/x', 'https://127.0.0.1/', 'https://hearthcade.com/api/admin', 'not a url', 42, null, 'https://fcm.googleapis.com/' + 'x'.repeat(1100)])
    assert.equal(pushEndpointOk(no), false, String(no));
});

test('a subscription is read only when it is one', async () => {
  const b = await browser();
  assert.deepEqual(readSubscription({ endpoint: b.sub.endpoint, keys: { p256dh: b.sub.p256dh, auth: b.sub.auth } }), b.sub);
  assert.equal(readSubscription({ endpoint: 'https://evil.com/x', keys: { p256dh: b.sub.p256dh, auth: b.sub.auth } }), null);
  assert.equal(readSubscription({ endpoint: b.sub.endpoint, keys: { p256dh: 'short', auth: b.sub.auth } }), null);
  assert.equal(readSubscription({ endpoint: b.sub.endpoint }), null);
  assert.equal(readSubscription(null), null);
});

test('which events become notifications, and what they say', () => {
  const game = { id: 'p1', slug: 'star-farm', title: 'Star Farm', i18n: { ja: { title: 'スターファーム' } } };
  assert.deepEqual(noteFor({ kind: 'request', from: { id: 'u1', name: 'Mia' } }, 'en'), { kind: 'requests', title: 'Mia sent you a friend request', body: '', url: '/?friends=requests', tag: 'request:u1' });
  assert.equal(noteFor({ kind: 'accepted', by: { id: 'u1', name: 'Mia' } }, 'es').title, 'Mia ha aceptado tu solicitud de amistad');
  const inv = noteFor({ kind: 'invite', invite: { id: 'i9', from: { id: 'u1', name: 'Mia' }, game } }, 'ja');
  assert.equal(inv.title, 'Mia さんから スターファーム への招待が届きました');
  assert.equal(inv.url, '/g/star-farm'); assert.equal(inv.kind, 'invites');
  assert.equal(noteFor({ kind: 'invite', invite: { id: 'i9', from: { id: 'u1', name: 'Mia' }, game } }, 'en').title, 'Mia invited you to play Star Farm');
  const m = noteFor({ kind: 'message', peer: 'u1', from: { id: 'u1', name: 'Mia' }, msg: { body: 'hi   there\n' + 'x'.repeat(300) } }, 'zh');
  assert.equal(m.title, '来自 Mia 的消息'); assert.equal(m.url, '/?chat=u1'); assert.equal(m.tag, 'chat:u1');
  assert.ok(m.body.startsWith('hi there x') && m.body.length === 140 && m.body.endsWith('…'));
  // never: the sender's own copy, quiet ones (Busy), test bots, and events that only refresh a page
  assert.equal(noteFor({ kind: 'message', peer: 'u2', msg: { body: 'x' }, mine: true }, 'en'), null);
  assert.equal(noteFor({ kind: 'message', from: { id: 'u1', name: 'Mia' }, msg: { body: 'x' }, quiet: true }, 'en'), null);
  assert.equal(noteFor({ kind: 'invite', quiet: true, invite: { id: 'i', from: { id: 'u1', name: 'Mia' }, game } }, 'en'), null);
  assert.equal(noteFor({ kind: 'invite_answer', by: { id: 'b', name: 'Bot' }, test_bot: true }, 'en'), null);
  for (const kind of ['counts', 'friends', 'invite_cancelled', 'joining', 'invite_answer']) assert.equal(noteFor({ kind, by: { id: 'u', name: 'A' } }, 'en'), null, kind);
  assert.equal(noteFor({ kind: 'message', peer: 'u2' }, 'en'), null, 'the sender\'s invite echo');
});

test('languages and switched-off kinds read back safely', () => {
  assert.equal(pushLang('zh-TW'), 'zh-TW'); assert.equal(pushLang('fr'), 'en'); assert.equal(pushLang(undefined), 'en');
  assert.deepEqual(readOff('messages,bogus,invites'), ['messages', 'invites']);
  assert.deepEqual(readOff(null), []);
  for (const l of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es']) { const n = testNote(l); assert.ok(n.title && n.body, l); }
});

test('the encryption matches RFC 8291 appendix A', async () => {
  const V = { as_public: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', as_private: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', ua_public: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg', salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN' };
  const asPub = unb64u(V.as_public);
  const priv = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: V.as_private, x: b64u(asPub.slice(1, 33)), y: b64u(asPub.slice(33)) }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const ua = await crypto.subtle.importKey('raw', unb64u(V.ua_public), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, priv, 256));
  const { cek, nonce } = await contentKeys(ecdh, unb64u(V.auth), unb64u(V.ua_public), asPub, unb64u(V.salt));
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const pt = enc.encode('When I grow up, I want to be a watermelon'), padded = new Uint8Array(pt.length + 1);
  padded.set(pt); padded[pt.length] = 2;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, padded));
  const body = unb64u(V.body);
  assert.equal(b64u(body.slice(16, 21)), b64u(new Uint8Array([0, 0, 16, 0, 65])), 'record size 4096, key id length 65');
  assert.equal(b64u(ct), b64u(body.slice(21 + 65)));
});

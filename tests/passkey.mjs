// Passkeys (src/passkey.ts): registrations and sign-ins made here the way an authenticator makes them (CBOR, COSE keys,
// DER signatures), with real keys, then checked: the right ones pass, and every way of getting one wrong is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const P = await import('../src/passkey.ts');
const subtle = crypto.subtle, enc = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = async (d) => new Uint8Array(await subtle.digest('SHA-256', typeof d === 'string' ? enc.encode(d) : d));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

// ---- a CBOR writer, for what authenticators send ----
function head(major, n) { if (n < 24) return [major << 5 | n]; if (n < 256) return [major << 5 | 24, n]; if (n < 65536) return [major << 5 | 25, n >> 8, n & 255]; return [major << 5 | 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function cbor(v) {
  if (typeof v === 'number') return Uint8Array.from(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === 'string') { const b = enc.encode(v); return cat(Uint8Array.from(head(3, b.length)), b); }
  if (v instanceof Uint8Array) return cat(Uint8Array.from(head(2, v.length)), v);
  if (v instanceof Map) return cat(Uint8Array.from(head(5, v.size)), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
  throw new Error('cbor ' + typeof v);
}
const RP = { origin: 'https://hearthcade.test', rpId: 'hearthcade.test' };

async function authenticator(kind) {
  const alg = kind === 'es256' ? -7 : kind === 'ed25519' ? -8 : -257;
  const keys = kind === 'es256' ? await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    : kind === 'ed25519' ? await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    : await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', keys.publicKey), b = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
  const cose = kind === 'es256' ? new Map([[1, 2], [3, -7], [-1, 1], [-2, b(jwk.x)], [-3, b(jwk.y)]])
    : kind === 'ed25519' ? new Map([[1, 1], [3, -8], [-1, 6], [-2, b(jwk.x)]])
    : new Map([[1, 3], [3, -257], [-1, b(jwk.n)], [-2, b(jwk.e)]]);
  const credId = crypto.getRandomValues(new Uint8Array(32));
  let counter = 0;
  const authData = async ({ flags = 0x05, rpId = RP.rpId, attested = false, count } = {}) => {
    const c = count ?? counter, ctr = Uint8Array.from([c >>> 24, (c >> 16) & 255, (c >> 8) & 255, c & 255]);
    const base = cat(await sha(rpId), Uint8Array.of(flags | (attested ? 0x40 : 0)), ctr);
    return attested ? cat(base, new Uint8Array(16), Uint8Array.of(credId.length >> 8, credId.length & 255), credId, cbor(cose)) : base;
  };
  const clientData = (type, challenge, origin = RP.origin) => enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: b64u(credId),
    async register(challenge, o = {}) {
      const ad = await authData({ attested: true, ...o });
      return { id: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(clientData(o.type || 'webauthn.create', challenge, o.origin)), attestationObject: b64u(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]))), transports: ['internal', 'hybrid'] } };
    },
    async sign(challenge, o = {}) {
      counter += o.step ?? 1;
      const ad = await authData(o), cd = clientData(o.type || 'webauthn.get', challenge, o.origin);
      const data = cat(ad, await sha(cd));
      let sig = new Uint8Array(await subtle.sign(kind === 'es256' ? { name: 'ECDSA', hash: 'SHA-256' } : kind === 'ed25519' ? { name: 'Ed25519' } : { name: 'RSASSA-PKCS1-v1_5' }, keys.privateKey, data));
      if (kind === 'es256') sig = der(sig);
      if (o.tamper) sig[sig.length - 1] ^= 1;
      return { id: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: null } };
    },
    alg,
  };
}
/** raw r||s as ASN.1 DER, the way authenticators send ECDSA signatures */
function der(raw) {
  const int = (x) => { let i = 0; while (i < x.length - 1 && x[i] === 0) i++; let v = x.slice(i); if (v[0] & 0x80) v = cat(Uint8Array.of(0), v); return cat(Uint8Array.of(2, v.length), v); };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(Uint8Array.of(0x30, body.length), body);
}

for (const kind of ['es256', 'ed25519', 'rs256']) {
  test(`${kind}: a passkey registers and signs in, and its counter must go up`, async () => {
    const a = await authenticator(kind), ch = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const pk = await P.verifyRegistration(await a.register(ch), { challenge: ch, ...RP });
    assert.equal(pk.id, a.id); assert.equal(pk.alg, a.alg); assert.deepEqual(pk.transports, ['internal', 'hybrid']);
    const stored = { jwk: pk.jwk, alg: pk.alg, counter: pk.counter };
    const ch2 = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const n = await P.verifyAssertion(await a.sign(ch2), stored, { challenge: ch2, ...RP });
    assert.equal(n, 1);
    await assert.rejects(P.verifyAssertion(await a.sign(ch2, { count: 1, step: 0 }), { ...stored, counter: 1 }, { challenge: ch2, ...RP }), /counter/);
    await assert.rejects(P.verifyAssertion(await a.sign(ch2, { tamper: true }), stored, { challenge: ch2, ...RP }), /signature/);
  });
}

test('everything that ties a passkey to this site and this request is checked', async () => {
  const a = await authenticator('es256'), ch = 'challenge-1', x = { challenge: ch, ...RP };
  await assert.rejects(P.verifyRegistration(await a.register('other'), x), /challenge/);
  await assert.rejects(P.verifyRegistration(await a.register(ch, { origin: 'https://evil.test' }), x), /origin/);
  await assert.rejects(P.verifyRegistration(await a.register(ch, { type: 'webauthn.get' }), x), /ceremony/);
  await assert.rejects(P.verifyRegistration(await a.register(ch, { rpId: 'evil.test' }), x), /RP ID/);
  await assert.rejects(P.verifyRegistration(await a.register(ch, { flags: 0x01 }), x), /verification/, 'no fingerprint, face or PIN');
  await assert.rejects(P.verifyRegistration(await a.register(ch, { flags: 0x04 }), x), /presence/);
  const reg = await a.register(ch); reg.id = 'someone-else';
  await assert.rejects(P.verifyRegistration(reg, x), /mismatch/);
  const pk = await P.verifyRegistration(await a.register(ch), x), stored = { jwk: pk.jwk, alg: pk.alg, counter: 0 };
  await assert.rejects(P.verifyAssertion(await a.sign(ch, { type: 'webauthn.create' }), stored, x), /ceremony/);
  await assert.rejects(P.verifyAssertion(await a.sign('stale'), stored, x), /challenge/);
  await assert.rejects(P.verifyAssertion(await a.sign(ch, { origin: 'https://hearthcade.test.evil.test' }), stored, x), /origin/);
  const other = await authenticator('es256'), otherPk = await P.verifyRegistration(await other.register(ch), x);
  await assert.rejects(P.verifyAssertion(await a.sign(ch), { jwk: otherPk.jwk, alg: -7, counter: 0 }, x), /signature/, 'another key');
  await assert.rejects(P.verifyAssertion({ id: 'x' }, stored, x), /missing/);
});

test('an authenticator that keeps no counter (always 0) still signs in', async () => {
  const a = await authenticator('es256'), ch = 'c', x = { challenge: ch, ...RP };
  const pk = await P.verifyRegistration(await a.register(ch), x), stored = { jwk: pk.jwk, alg: -7, counter: 0 };
  assert.equal(await P.verifyAssertion(await a.sign(ch, { count: 0, step: 0 }), stored, x), 0);
  assert.equal(await P.verifyAssertion(await a.sign(ch, { count: 0, step: 0 }), stored, x), 0);
});

test('CBOR reading refuses what it does not expect', () => {
  assert.deepEqual(P.cbor(cbor(new Map([['a', 1], [-2, new Uint8Array([7])]]))).value, new Map([['a', 1], [-2, new Uint8Array([7])]]));
  assert.throws(() => P.cbor(Uint8Array.of(0x5f)), /indefinite/);
  assert.throws(() => P.cbor(Uint8Array.of(0x58, 10, 1)), /truncated/);
  assert.equal(P.passkeyName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'), 'iPhone · Safari');
});

// Passkeys (WebAuthn Level 3) with nothing but WebCrypto: registering a passkey on the account page, and signing in with
// one. Only what the platform needs is implemented, and checked strictly:
//
// - Every ceremony has a one-time challenge from the server (passkey_challenges), five minutes, used once.
// - clientDataJSON must have the ceremony's type, that challenge and the platform's own origin; authenticatorData the hash
//   of the platform's RP ID, user presence and user verification (a fingerprint, face or device PIN), so a passkey is two
//   factors by itself and a sign-in with one does not ask for the authenticator code as well.
// - Attestation is not asked for ("none"): which authenticator made the passkey does not matter here.
// - Keys: ES256 (P-256, what almost every passkey uses), EdDSA (Ed25519) and RS256 (Windows Hello on older machines).
// - The signature counter, when the authenticator keeps one, must go up; one that goes back means a cloned key and is refused.
import { b64u, unb64 } from './util';

export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const ALGS = [-7, -8, -257] as const;   // ES256, EdDSA, RS256, in order of preference
const enc = new TextEncoder();

// ---- a minimal CBOR reader (RFC 8949): what attestation objects and COSE keys use -----------------------------------
export function cbor(buf: Uint8Array, at = 0): { value: unknown; end: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const read = (i: number): { value: unknown; end: number } => {
    if (i >= buf.length) throw new Error('cbor: truncated');
    const ib = buf[i], major = ib >> 5, info = ib & 31;
    let n: number, p = i + 1;
    if (info < 24) n = info;
    else if (info === 24) { n = buf[p]; p += 1; }
    else if (info === 25) { n = dv.getUint16(p); p += 2; }
    else if (info === 26) { n = dv.getUint32(p); p += 4; }
    else if (info === 27) { const hi = dv.getUint32(p), lo = dv.getUint32(p + 4); if (hi > 0x1fffff) throw new Error('cbor: integer too large'); n = hi * 2 ** 32 + lo; p += 8; }
    else throw new Error('cbor: indefinite lengths are not used here');
    switch (major) {
      case 0: return { value: n, end: p };
      case 1: return { value: -1 - n, end: p };
      case 2: if (p + n > buf.length) throw new Error('cbor: truncated'); return { value: buf.slice(p, p + n), end: p + n };
      case 3: if (p + n > buf.length) throw new Error('cbor: truncated'); return { value: new TextDecoder().decode(buf.subarray(p, p + n)), end: p + n };
      case 4: { const a: unknown[] = []; for (let k = 0; k < n; k++) { const r = read(p); a.push(r.value); p = r.end; } return { value: a, end: p }; }
      case 5: { const m = new Map<unknown, unknown>(); for (let k = 0; k < n; k++) { const kr = read(p); const vr = read(kr.end); m.set(kr.value, vr.value); p = vr.end; } return { value: m, end: p }; }
      case 7: if (info === 20) return { value: false, end: p }; if (info === 21) return { value: true, end: p }; if (info === 22) return { value: null, end: p }; throw new Error('cbor: unsupported simple value');
      default: throw new Error('cbor: tags are not used here');
    }
  };
  return read(at);
}

// ---- authenticator data -------------------------------------------------------------------------------------------
export interface AuthData { rpIdHash: Uint8Array; up: boolean; uv: boolean; counter: number; credentialId?: Uint8Array; coseKey?: Map<unknown, unknown> }
export function parseAuthData(a: Uint8Array): AuthData {
  if (a.length < 37) throw new Error('authenticator data too short');
  const flags = a[32], dv = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const out: AuthData = { rpIdHash: a.slice(0, 32), up: !!(flags & 1), uv: !!(flags & 4), counter: dv.getUint32(33) };
  if (flags & 0x40) {   // attested credential data: aaguid (16), id length (2), id, COSE key
    const len = dv.getUint16(53);
    out.credentialId = a.slice(55, 55 + len);
    const k = cbor(a, 55 + len);
    if (!(k.value instanceof Map)) throw new Error('credential key is not a COSE key');
    out.coseKey = k.value;
  }
  return out;
}

/** A COSE public key (RFC 9053) as a JWK WebCrypto can import, with its algorithm. */
export function coseToJwk(k: Map<unknown, unknown>): { jwk: JsonWebKey; alg: number } {
  const kty = k.get(1), alg = Number(k.get(3)), bytes = (l: number) => { const v = k.get(l); if (!(v instanceof Uint8Array)) throw new Error('bad COSE key'); return b64u(v); };
  if (kty === 2 && alg === -7 && k.get(-1) === 1) return { alg, jwk: { kty: 'EC', crv: 'P-256', x: bytes(-2), y: bytes(-3) } };
  if (kty === 1 && alg === -8 && k.get(-1) === 6) return { alg, jwk: { kty: 'OKP', crv: 'Ed25519', x: bytes(-2) } };
  if (kty === 3 && alg === -257) return { alg, jwk: { kty: 'RSA', n: bytes(-1), e: bytes(-2) } };
  throw new Error('This kind of passkey is not supported. Try another device or password manager.');
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const importParams = (alg: number): any =>
  alg === -7 ? { name: 'ECDSA', namedCurve: 'P-256' } : alg === -8 ? { name: 'Ed25519' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const verifyParams = (alg: number): any => (alg === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : alg === -8 ? { name: 'Ed25519' } : { name: 'RSASSA-PKCS1-v1_5' });

/** An ECDSA signature as authenticators send it (ASN.1 DER) in the raw r||s form WebCrypto takes. */
export function derToRaw(der: Uint8Array, size = 32): Uint8Array {
  let p = 0;
  if (der[p++] !== 0x30) throw new Error('bad signature');
  if (der[p] & 0x80) p += (der[p] & 0x7f) + 1; else p++;
  const int = () => {
    if (der[p++] !== 0x02) throw new Error('bad signature');
    const len = der[p++]; let v = der.subarray(p, p + len); p += len;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Error('bad signature');
    const out = new Uint8Array(size); out.set(v, size - v.length); return out;
  };
  const r = int(), s = int(), raw = new Uint8Array(size * 2); raw.set(r); raw.set(s, size); return raw;
}

const sha = async (d: Uint8Array | string) => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof d === 'string' ? enc.encode(d) : d));
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const bytesOf = (s: unknown) => { if (typeof s !== 'string' || s.length > 20000) throw new Error('missing field'); return unb64(s); };

interface Expect { challenge: string; origin: string; rpId: string }
function checkClientData(raw: Uint8Array, type: string, x: Expect) {
  let cd: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
  try { cd = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new Error('bad client data'); }
  if (cd.type !== type) throw new Error('wrong ceremony');
  if (cd.challenge !== x.challenge) throw new Error('wrong challenge');
  if (cd.origin !== x.origin) throw new Error('wrong origin');
  if (cd.crossOrigin) throw new Error('cross-origin ceremony');
}
async function checkAuthData(ad: AuthData, x: Expect) {
  if (!sameBytes(ad.rpIdHash, await sha(x.rpId))) throw new Error('wrong RP ID');
  if (!ad.up) throw new Error('user presence missing');
  if (!ad.uv) throw new Error('user verification missing');
}

export interface RegistrationJSON { id: string; rawId?: string; type?: string; response: { clientDataJSON: string; attestationObject: string; transports?: string[] } }
export interface NewPasskey { id: string; jwk: JsonWebKey; alg: number; counter: number; transports: string[] }
/** Checks a registration (navigator.credentials.create) against its challenge. Throws with the reason when it fails. */
export async function verifyRegistration(cred: RegistrationJSON, x: Expect): Promise<NewPasskey> {
  if (!cred || typeof cred !== 'object' || !cred.response) throw new Error('missing credential');
  checkClientData(bytesOf(cred.response.clientDataJSON), 'webauthn.create', x);
  const att = cbor(bytesOf(cred.response.attestationObject)).value;
  if (!(att instanceof Map) || !(att.get('authData') instanceof Uint8Array)) throw new Error('bad attestation object');
  const ad = parseAuthData(att.get('authData') as Uint8Array);
  await checkAuthData(ad, x);
  if (!ad.credentialId || !ad.coseKey) throw new Error('no credential in the attestation');
  const id = b64u(ad.credentialId);
  if (id !== cred.id) throw new Error('credential id mismatch');
  const { jwk, alg } = coseToJwk(ad.coseKey);
  await crypto.subtle.importKey('jwk', jwk, importParams(alg), false, ['verify']);   // a key WebCrypto refuses is refused here
  const transports = Array.isArray(cred.response.transports) ? cred.response.transports.filter((t) => typeof t === 'string' && /^[a-z-]{2,20}$/.test(t)).slice(0, 6) : [];
  return { id, jwk, alg, counter: ad.counter, transports };
}

export interface AssertionJSON { id: string; rawId?: string; type?: string; response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null } }
/** Checks a sign-in (navigator.credentials.get) with the stored key. Returns the new signature counter. */
export async function verifyAssertion(cred: AssertionJSON, stored: { jwk: JsonWebKey; alg: number; counter: number }, x: Expect): Promise<number> {
  if (!cred || typeof cred !== 'object' || !cred.response) throw new Error('missing credential');
  const cdRaw = bytesOf(cred.response.clientDataJSON), adRaw = bytesOf(cred.response.authenticatorData);
  checkClientData(cdRaw, 'webauthn.get', x);
  const ad = parseAuthData(adRaw);
  await checkAuthData(ad, x);
  const data = new Uint8Array(adRaw.length + 32); data.set(adRaw); data.set(await sha(cdRaw), adRaw.length);
  let sig: Uint8Array = bytesOf(cred.response.signature);
  if (stored.alg === -7) sig = derToRaw(sig);
  const key = await crypto.subtle.importKey('jwk', stored.jwk, importParams(stored.alg), false, ['verify']);
  if (!(await crypto.subtle.verify(verifyParams(stored.alg), key, sig as Uint8Array<ArrayBuffer>, data))) throw new Error('bad signature');
  if ((ad.counter !== 0 || stored.counter !== 0) && ad.counter <= stored.counter) throw new Error('signature counter went back: this passkey may have been copied');
  return ad.counter;
}

/** A friendly default name for a new passkey, from the browser it was made in. */
export function passkeyName(ua: string): string {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : '';
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [os, b].filter(Boolean).join(' · ') || 'Passkey';
}

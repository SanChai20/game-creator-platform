// Passkeys in the browser: the server's options (src/routes/api.ts) turned into navigator.credentials calls, and the
// browser's answer turned back into JSON for the server to check (src/passkey.ts).
const toBytes = (s: string) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
const toB64u = (buf: ArrayBuffer | null | undefined) => { if (!buf) return null; let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

export const passkeysSupported = () => typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;
/** Whether the browser can offer passkeys in the email field's autofill list (conditional mediation). */
export async function passkeyAutofill(): Promise<boolean> {
  try { return passkeysSupported() && !!(await (PublicKeyCredential as unknown as { isConditionalMediationAvailable?: () => Promise<boolean> }).isConditionalMediationAvailable?.()); } catch { return false; }
}

type Desc = { type: string; id: string; transports?: string[] };
const descs = (l: Desc[] = []) => l.map((d) => ({ type: 'public-key' as const, id: toBytes(d.id), transports: d.transports as AuthenticatorTransport[] | undefined }));

/** True when the person closed the passkey prompt or it timed out: nothing to report. */
export const passkeyCancelled = (e: unknown) => e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError');

export async function getPasskey(o: { challenge: string; rpId: string; timeout: number; userVerification: string; allowCredentials: Desc[] }, opts: { conditional?: boolean; signal?: AbortSignal } = {}) {
  const cred = await navigator.credentials.get({
    publicKey: { challenge: toBytes(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: o.userVerification as UserVerificationRequirement, allowCredentials: descs(o.allowCredentials) },
    ...(opts.conditional ? { mediation: 'conditional' as CredentialMediationRequirement } : {}), signal: opts.signal,
  }) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('cancelled', 'NotAllowedError');
  const r = cred.response as AuthenticatorAssertionResponse;
  return { id: cred.id, type: cred.type, response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature), userHandle: toB64u(r.userHandle) } };
}

export async function createPasskey(o: {
  challenge: string; timeout: number; attestation: string; rp: { id: string; name: string }; user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: string; alg: number }[]; excludeCredentials: Desc[]; authenticatorSelection: AuthenticatorSelectionCriteria;
}) {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: toBytes(o.challenge), timeout: o.timeout, attestation: o.attestation as AttestationConveyancePreference, rp: o.rp,
      user: { ...o.user, id: toBytes(o.user.id) }, pubKeyCredParams: o.pubKeyCredParams as PublicKeyCredentialParameters[],
      excludeCredentials: descs(o.excludeCredentials), authenticatorSelection: o.authenticatorSelection,
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('cancelled', 'NotAllowedError');
  const r = cred.response as AuthenticatorAttestationResponse;
  return { id: cred.id, type: cred.type, response: { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject), transports: typeof r.getTransports === 'function' ? r.getTransports() : [] } };
}

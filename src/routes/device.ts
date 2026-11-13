// Device sign-in (OAuth 2.0 Device Authorization Grant, RFC 8628).
// For agents that cannot open a browser or receive a redirect: a sandboxed or remote agent asks for a
// code, shows its user a link, and polls. The user signs in and approves in any browser. What the agent
// receives is the same thing the browser flow issues: a short-lived access token and a refresh token
// inside a grant that expires and can be revoked from the console. No permanent key is ever created.
import { Hono, type Context } from 'hono';
import { AppError, bad, notFound, type Env, type User } from '../env';
import { rateLimit, requireUser, userById } from '../auth';
import { getSettings } from '../settings';
import { b64u, now, sha256, token } from '../util';

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const TTL_S = 900, INTERVAL_S = 5, ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';   // no vowels: codes never spell words

type App = { Bindings: Env; Variables: { user: User | null; origin: string } };
type Row = { id: string; user_code: string; client_name: string; status: string; user_id: string | null; created_at: number; expires_at: number; last_poll_at: number };
/** Runs a token request against this server's own token endpoint. Supplied by index.ts, which owns the provider. */
export type TokenExchange = (env: Env, ctx: ExecutionContext, origin: string, form: URLSearchParams) => Promise<Response>;

const noStore = { 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
const oauthError = (c: Context<App>, error: string, description: string, status = 400) => c.json({ error, error_description: description }, status as any, noStore);
function newUserCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  let s = ''; for (let i = 0; i < 8; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}
export function normalizeUserCode(raw: string): string {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
  return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4) : '';
}
/** Accepts form-encoded bodies (the standard) and JSON (what simple agents tend to send). */
async function params(req: Request): Promise<Record<string, string>> {
  const text = await req.text().catch(() => '');
  if ((req.headers.get('content-type') || '').includes('json') || text.trim().startsWith('{')) {
    try { const j = JSON.parse(text || '{}'); return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v ?? '')])); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export function deviceOAuth(exchange: TokenExchange) {
  const r = new Hono<App>();
  r.options('*', () => new Response(null, { status: 204, headers: { ...noStore, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS' } }));

  // Step 1: the agent asks for a code.
  r.post('/', async (c) => {
    const p = await params(c.req.raw), origin = c.get('origin');
    await rateLimit(c.env, 'device:' + (c.req.header('cf-connecting-ip') || 'x'), 20, 600);
    const name = (p.client_name || p.name || 'Agent').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) || 'Agent';
    const deviceCode = token(32), t = now();
    let userCode = '';
    for (let i = 0; i < 5 && !userCode; i++) {
      const candidate = newUserCode();
      const ins = await c.env.DB.prepare('INSERT OR IGNORE INTO device_codes (id, user_code, client_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(await sha256(deviceCode), candidate, name, t, t + TTL_S * 1000).run();
      if (ins.meta.changes) userCode = candidate;
    }
    if (!userCode) throw new AppError(503, 'Could not create a sign-in code. Try again.', 'busy');
    return c.json({
      device_code: deviceCode, user_code: userCode, verification_uri: `${origin}/device`, verification_uri_complete: `${origin}/device?code=${userCode}`,
      expires_in: TTL_S, interval: INTERVAL_S, token_endpoint: `${origin}/oauth/token`, grant_type: DEVICE_GRANT,
      next: `Ask your user to open verification_uri_complete in any browser, sign in and approve. Meanwhile POST grant_type=${DEVICE_GRANT} and device_code to token_endpoint every ${INTERVAL_S} seconds until it returns access_token. Send a User-Agent header with every request: Python urllib's default one is refused with 403 "error code: 1010" before it reaches this server.`,
    }, 200, noStore);
  });

  // Step 3: the agent polls. (Requests to /oauth/token with the device grant type are routed here.)
  r.post('/token', async (c) => {
    const p = await params(c.req.raw), env = c.env, origin = c.get('origin'), t = now();
    if (p.grant_type && p.grant_type !== DEVICE_GRANT) return oauthError(c, 'unsupported_grant_type', `Use grant_type=${DEVICE_GRANT} here.`);
    if (!p.device_code) return oauthError(c, 'invalid_request', 'device_code is required.');
    const id = await sha256(p.device_code);
    const row = await env.DB.prepare('SELECT * FROM device_codes WHERE id = ?').bind(id).first<Row>();
    if (!row || row.expires_at < t || row.status === 'used') return oauthError(c, 'expired_token', 'This device code has expired or was already used. Start again with POST /oauth/device.');
    if (row.status === 'denied') return oauthError(c, 'access_denied', 'The user declined this request.');
    if (row.status === 'pending') {
      const tooFast = t - row.last_poll_at < 1500;
      await env.DB.prepare('UPDATE device_codes SET last_poll_at = ? WHERE id = ?').bind(t, id).run();
      return tooFast ? oauthError(c, 'slow_down', `Poll every ${INTERVAL_S} seconds.`) : oauthError(c, 'authorization_pending', `Waiting for the user to approve at ${origin}/device?code=${row.user_code}`);
    }
    // approved: only one poll may turn it into tokens
    const claim = await env.DB.prepare("UPDATE device_codes SET status = 'used' WHERE id = ? AND status = 'approved'").bind(id).run();
    if (!claim.meta.changes) return oauthError(c, 'expired_token', 'This device code was already used.');
    const user = row.user_id ? await userById(env, row.user_id) : null;
    if (!user || user.status !== 'active') return oauthError(c, 'access_denied', 'The approving account is not active.');

    // Issue through the ordinary authorization-code path, so the grant is listed, expires and is revocable like any other.
    const redirectUri = `${origin}/oauth/code`, resource = `${origin}/mcp`;
    const client = await env.OAUTH_PROVIDER.createClient({ clientName: row.client_name, redirectUris: [redirectUri], tokenEndpointAuthMethod: 'none', grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'] });
    const verifier = token(32), challenge = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: { responseType: 'code', clientId: client.clientId, redirectUri, scope: ['games'], state: 'device', codeChallenge: challenge, codeChallengeMethod: 'S256', resource },
      userId: user.id, metadata: { client: row.client_name, via: 'device' }, scope: ['games'], props: { userId: user.id, client: row.client_name },
    });
    const code = new URL(redirectTo).searchParams.get('code') || '';
    const res = await exchange(env, c.executionCtx as ExecutionContext, origin, new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.clientId, redirect_uri: redirectUri, code_verifier: verifier, resource }));
    const tokens = await res.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    if (!res.ok || !tokens.access_token) return oauthError(c, 'server_error', 'Could not issue tokens. Start again with POST /oauth/device.', 500);
    const s = await getSettings(env);
    return c.json({
      ...tokens, client_id: client.clientId, mcp_url: resource, token_endpoint: `${origin}/oauth/token`, authorization_expires_in: s.oauth_grant_ttl_s,
      usage: `Call mcp_url with the header "Authorization: Bearer <access_token>". The access token expires in ${tokens.expires_in} seconds: get a new one with POST token_endpoint, grant_type=refresh_token, refresh_token=<refresh_token>, client_id=<client_id>. Each refresh returns a new refresh_token. The whole authorization ends after authorization_expires_in seconds or when the user revokes it; then start again with POST /oauth/device.`,
    }, 200, noStore);
  });
  return r;
}

// Step 2: the signed-in user looks the code up and decides (called by the /device page).
export const deviceApi = new Hono<App>();
async function pendingByUserCode(c: Context<App>): Promise<Row> {
  const u = requireUser(c as any);
  await rateLimit(c.env, 'devcode:' + u.id, 30, 600);                       // 20^8 codes; guessing one is not practical at this rate
  const code = normalizeUserCode(c.req.param('code') || '');
  if (!code) throw bad('That code is not complete. It looks like ABCD-EFGH.');
  const row = await c.env.DB.prepare('SELECT * FROM device_codes WHERE user_code = ?').bind(code).first<Row>();
  if (!row || row.expires_at < now() || row.status !== 'pending') throw notFound('That code is not valid any more. Ask your agent to start again.');
  return row;
}
deviceApi.get('/:code', async (c) => {
  const row = await pendingByUserCode(c), s = await getSettings(c.env);
  return c.json({ user_code: row.user_code, client_name: row.client_name, created_at: row.created_at, expires_at: row.expires_at, grant_days: Math.max(1, Math.round(s.oauth_grant_ttl_s / 86400)) });
});
deviceApi.post('/:code', async (c) => {
  const row = await pendingByUserCode(c), u = requireUser(c as any);
  const b = await c.req.json<{ decision?: string }>().catch(() => ({} as { decision?: string }));
  const status = b.decision === 'approve' ? 'approved' : 'denied';
  const r = await c.env.DB.prepare("UPDATE device_codes SET status = ?, user_id = ? WHERE id = ? AND status = 'pending' AND expires_at > ?").bind(status, u.id, row.id, now()).run();
  if (!r.meta.changes) throw notFound('That code is not valid any more. Ask your agent to start again.');
  return c.json({ ok: true, status });
});

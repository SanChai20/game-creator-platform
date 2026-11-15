// Game Creator platform Worker: web API, OAuth authorization server, MCP server, and static hosting
// for the web app, the SDK, the kits and the vendored Three.js build.
import { AuthorizationError, CimdFetchError, OAuthProvider, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import { AppError, type Env, type User } from './env';
import { userFromRequest } from './auth';
import { gameBindings } from './deploy';
import { handleMcp } from './mcp/server';
import { THREE_VERSION } from './generated/runtime-source';
import { getProject, getVersion } from './projects';
import { admin } from './routes/admin';
import { api } from './routes/api';
import { DEVICE_GRANT, deviceApi, deviceOAuth, type TokenExchange } from './routes/device';
import { rt } from './routes/rt';
import { upload } from './routes/upload';
import { getSettings } from './settings';
import { esc, now } from './util';
import { TOKENS_CSS } from '../web/src/ui/tokens';
// @ts-ignore plain JS module
import { handle as handleGame } from './runtime/game-worker.js';

export { GameRoom } from './room';
export { Pipeline } from './pipeline';

type App = { Bindings: Env; Variables: { user: User | null; origin: string } };
const app = new Hono<App>();
const originOf = (env: Env, req: Request) => env.PUBLIC_ORIGIN || new URL(req.url).origin;

app.onError((e, c) => {
  if (e instanceof AppError) return c.json({ error: e.message, code: e.code, hint: e.hint }, e.status as any);
  console.error('unhandled', e);
  return c.json({ error: 'Something went wrong on our side.', code: 'internal' }, 500);
});

app.use('*', async (c, next) => { c.set('origin', originOf(c.env, c.req.raw)); await next(); });

// In-game runtime API and curl uploads: token-authenticated, cross-origin, no cookies involved.
app.route('/api/rt', rt);
app.route('/api/upload', upload);

// Everything else under /api uses the session cookie. Mutations must come from our own pages.
app.use('/api/*', async (c, next) => {
  const m = c.req.method, path = new URL(c.req.url).pathname;
  if (m !== 'GET' && m !== 'HEAD' && path !== '/api/stripe/webhook') {
    const o = c.req.header('origin');
    if (o && o !== c.get('origin') && o !== new URL(c.req.url).origin) throw new AppError(403, 'Cross-site request refused.', 'csrf');
  }
  c.set('user', path === '/api/stripe/webhook' ? null : await userFromRequest(c.env, c.req.raw));
  await next();
});
app.route('/api/admin', admin);
app.route('/api/device', deviceApi);
app.route('/api', api);
app.all('/api/*', (c) => c.json({ error: 'Not found', code: 'not_found' }, 404));

// Device sign-in for agents that cannot open a browser. Tokens come from the provider's own token endpoint.
const exchange: TokenExchange = async (env, ctx, origin, form) => {
  const s = await getSettings(env);
  return provider(origin, s.oauth_access_ttl_s, s.oauth_grant_ttl_s).fetch(new Request(`${origin}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }), env, ctx);
};
app.route('/oauth/device', deviceOAuth(exchange));

// Platform-hosted modules that games import cross-origin.
app.get('/:kind{sdk|kits|vendor|guides|templates}/*', async (c) => {
  const r = await c.env.ASSETS.fetch(c.req.raw);
  const path = new URL(c.req.url).pathname;
  if (!r.ok && r.status !== 304 || (r.headers.get('content-type') || '').includes('text/html') && !path.endsWith('.html')) return c.text('Not found', 404, { 'access-control-allow-origin': '*' });
  const h = new Headers(r.headers);
  h.set('access-control-allow-origin', '*');
  h.set('cross-origin-resource-policy', 'cross-origin');
  h.set('cache-control', path.startsWith('/vendor/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
  if (path.startsWith('/guides/') && path.endsWith('.md') && r.status === 200) { // readable in a browser tab, with the placeholders filled in
    h.set('content-type', 'text/plain; charset=utf-8'); h.delete('content-length'); h.delete('etag');
    return new Response((await r.text()).replaceAll('{{ORIGIN}}', new URL(c.req.url).origin).replaceAll('{{THREE}}', THREE_VERSION).replaceAll('{{TARGET}}', String((await getSettings(c.env)).craft_target)), { headers: h });
  }
  return new Response(r.body, { status: r.status, headers: h });
});

// Local driver (wrangler dev): serve games from this Worker with the exact runtime the deployed Workers use.
app.all('/__game/:pid/:env/*', async (c) => {
  if (c.env.DEPLOY_DRIVER !== 'local') return c.text('Not found', 404);
  const pid = c.req.param('pid'), e = c.req.param('env') === 'live' ? 'live' : 'preview';
  const p = await getProject(c.env, pid);
  const n = p && (e === 'live' ? (p.status === 'live' ? p.live_version : null) : p.preview_version);
  const v = p && n ? await getVersion(c.env, p.id, n) : null;
  if (!p || !v) return c.text('This game is not deployed.', 404);
  const fake = { FILES: c.env.FILES, ...(await gameBindings(c.env, c.get('origin'), p, v, e)) };
  return handleGame(c.req.raw, fake, c.executionCtx, `/__game/${pid}/${e}`);
});

// ----- OAuth consent ---------------------------------------------------------------------------
// Server-rendered pages share the web app's design tokens (web/src/ui/tokens.ts), so they look like the rest of the site.
const PAGE_CSS = `*,*::before,*::after{box-sizing:border-box}html,body{min-height:100%;margin:0;background:var(--bg-0);color:var(--text);font:400 var(--fs-md)/1.6 var(--font-sans);-webkit-font-smoothing:antialiased}
body{display:grid;place-items:center;padding:24px;background:radial-gradient(60vw 50vh at 10% -10%,rgba(143,124,255,.14),transparent 70%),radial-gradient(50vw 45vh at 100% -5%,rgba(255,138,48,.12),transparent 70%),var(--bg-0)}
main{width:min(480px,100%);display:grid;gap:14px;background:var(--grad-surface),rgba(12,14,20,.9);border:1px solid var(--line-2);border-radius:var(--r-xl);padding:clamp(24px,5vw,36px);box-shadow:var(--shadow-3),0 0 120px -40px var(--accent-glow)}
.mark{display:flex;align-items:center;gap:10px;font:700 15px/1 var(--font-display);letter-spacing:-.01em;margin-bottom:6px}.mark i{width:28px;height:28px;border-radius:9px;background:var(--grad-accent);display:grid;place-items:center;box-shadow:var(--shadow-glow)}.mark i::after{content:"";border-left:9px solid var(--accent-ink);border-top:6px solid transparent;border-bottom:6px solid transparent;margin-left:3px}
h1{font:700 26px/1.15 var(--font-display);letter-spacing:-.03em;margin:0;text-wrap:balance}p{margin:0;color:var(--text-2)}strong{color:var(--text);font-weight:650}
ul{margin:0;padding:14px 16px;list-style:none;display:grid;gap:9px;background:rgba(6,7,11,.5);border:1px solid var(--line);border-radius:var(--r-md);font-size:14px}li{padding-left:24px;position:relative}li::before{content:"✓";position:absolute;left:0;top:1px;width:16px;height:16px;border-radius:50%;background:var(--accent-wash);color:var(--accent);font:700 10px/16px var(--font-mono);text-align:center}
.warn{border:1px solid rgba(255,107,107,.3);border-left:3px solid var(--bad);background:var(--bad-wash);border-radius:var(--r-md);padding:12px 14px;color:var(--text)}
.web-only{font-size:14px;padding:10px 14px;border:1px solid var(--line-2);border-radius:var(--r-md);background:rgba(6,7,11,.5)}
.row{display:flex;gap:10px;margin-top:6px}button{flex:1;height:52px;font:600 15px/1 var(--font-sans);border-radius:var(--r-md);cursor:pointer;border:1px solid var(--line-2);background:var(--bg-2);color:var(--text);box-shadow:var(--shadow-inset);transition:background var(--dur),filter var(--dur),transform var(--dur-fast)}button:hover{background:var(--bg-3)}button:active{transform:translateY(1px)}
button.go{background:var(--grad-accent);border-color:transparent;color:var(--accent-ink);font-weight:700;box-shadow:var(--shadow-glow),inset 0 1px 0 rgba(255,255,255,.45)}button.go:hover{filter:brightness(1.07)}
small{display:block;color:var(--text-3);font-size:13px}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}`;
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#06070b"><title>${esc(title)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${TOKENS_CSS}${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`;
}

function consentPage(brand: string, d: ConsentDescription, handle: string, user: User, days: number): string {
  const who = d.clientDomain ? `Published by <strong>${esc(d.clientDomain)}</strong>.` : 'This app registered itself, so its name is not verified.';
  return page(`Connect ${d.clientName}`, `<div class="mark"><i></i>${esc(brand)}</div>
<h1>Let ${esc(d.clientName)} publish web games for you?</h1>
<p>${who} Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<div class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from that app.</div>' : ''}
<p>Signed in as <strong>${esc(user.name)}</strong> (${esc(user.email)}). The agent will be able to:</p>
<ul><li>Create your game projects and upload their files</li><li>Deploy previews and run verification</li><li>Publish, roll back and take games offline</li><li>Set listing details and prices, and read your game stats</li></ul>
<p>It cannot withdraw money, change your password or see payment details.</p>
<p class="web-only">This platform hosts web games only: games that run in a browser page. Native, mobile, console and desktop builds are refused.</p>
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<div class="row"><button name="decision" value="deny">Deny</button><button class="go" name="decision" value="approve">Allow</button></div></form>
<small>Access expires after ${days} day${days === 1 ? '' : 's'}; you can revoke it sooner from your console.</small>`);
}

app.all('/authorize', async (c) => {
  const env = c.env, req = c.req.raw, oauth = env.OAUTH_PROVIDER, s = await getSettings(env);
  try {
    const user = await userFromRequest(env, req);
    if (req.method === 'POST') {
      if (!user) return c.html(page('Sign in again', '<h1>Your session ended</h1><p>Sign in and start connecting from your agent again.</p>'), 401);
      const form = await req.formData(), handle = String(form.get('handle') || '');
      if (form.get('decision') !== 'approve') { const denied = await oauth.denyConsent(req, handle); return new Response(null, { status: 302, headers: denied.headers }); }
      const approved = await oauth.approveConsent(req, handle);
      const client = await oauth.lookupClient(approved.request.clientId).catch(() => null);
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request, userId: user.id, metadata: { client: client?.clientName || 'agent' }, scope: approved.request.scope,
        props: { userId: user.id, client: client?.clientName || 'agent' },
      });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    const authReq = await oauth.parseAuthRequest(req);
    if (!user) { const u = new URL(req.url); return c.redirect(`/login?next=${encodeURIComponent(u.pathname + u.search)}`, 302); }
    const details = await oauth.describeConsent(authReq);
    const consent = await oauth.beginConsent(authReq);
    consent.headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(consentPage(s.brand_name, details, consent.handle, user, Math.max(1, Math.round(s.oauth_grant_ttl_s / 86400))), { headers: consent.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const msg = error instanceof AuthorizationError ? error.description : 'This app could not be verified.';
      return c.html(page('Cannot connect', `<h1>This connection cannot continue</h1><p>${esc(msg)}</p><p>Start connecting from your agent again.</p>`), 400);
    }
    throw error;
  }
});

// Anything else is the web app (served from static assets; unknown paths fall back to index.html).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

// ----- wiring ----------------------------------------------------------------------------------
const providers = new Map<string, OAuthProvider<Env>>();
function provider(origin: string, accessTtl: number, grantTtl: number): OAuthProvider<Env> {
  const key = `${origin}|${accessTtl}|${grantTtl}`;
  let p = providers.get(key);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: { fetch: (req: Request, env: Env, ctx: ExecutionContext) => handleMcp(req, env, ((ctx as any).props || {}) as { userId?: string; client?: string }, originOf(env, req)) } as any,
      defaultHandler: { fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx) } as any,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: ['games', 'offline_access'],
      requiredScopes: ['games'],
      accessTokenTTL: Math.max(60, accessTtl),      // access tokens are short-lived…
      refreshTokenTTL: Math.max(3600, grantTtl),    // …and the whole authorization expires, forcing a fresh approval
      clientIdMetadataDocumentEnabled: true,
      allowPrivateUseRedirectUris: true,            // native clients (Cursor, desktop apps) use custom URI schemes
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: 'Game Creator MCP', bearer_methods_supported: ['header'] },
    });
    if (providers.size > 8) providers.clear();
    providers.set(key, p);
  }
  return p;
}

/** What an agent with no token is told, in words it can act on. The challenge header stays as the standard requires. */
function accessHelp(origin: string, hadToken: boolean, accessTtl: number) {
  const refresh = `POST ${origin}/oauth/token with grant_type=refresh_token, refresh_token=<your refresh token> and client_id=<your client id>. The answer has a new access_token and a new refresh_token; keep both.`;
  return {
    error: 'invalid_token',
    error_description: hadToken ? `This access token is not valid any more. Access tokens last ${Math.round(accessTtl / 60)} minutes; get a new one with your refresh token (see if_you_had_a_token) and repeat the call. Nothing in the project is lost.` : 'Sign-in is required. This server uses OAuth; there are no API keys. See how_to_connect.',
    if_you_had_a_token: `${refresh} Only when that is refused too (the user revoked access, or the whole authorization reached its end) start again with how_to_connect.`,
    how_to_connect: {
      if_your_client_supports_mcp_oauth: `Add ${origin}/mcp as a remote MCP server (Streamable HTTP). The client discovers sign-in from ${origin}/.well-known/oauth-protected-resource/mcp and opens a browser for the user.`,
      if_you_cannot_open_a_browser: [
        `1. POST ${origin}/oauth/device with the form field client_name=<your agent's name>. No authentication is needed. The answer has device_code, user_code and verification_uri_complete.`,
        '2. Show verification_uri_complete to your user and ask them to open it in any browser, sign in (or create an account) and choose Allow. They have 15 minutes.',
        `3. Every 5 seconds, POST ${origin}/oauth/token with grant_type=${DEVICE_GRANT} and device_code=<device_code>. It answers authorization_pending until the user approves, then access_token and refresh_token.`,
        `4. Call ${origin}/mcp with the header "Authorization: Bearer <access_token>". Start with initialize, then tools/list, then the get_started tool.`,
        `5. The access token lasts ${Math.round(accessTtl / 60)} minutes. When a call answers 401, ${refresh}`,
      ],
      example: `curl -s -X POST ${origin}/oauth/device -d client_name=my-agent`,
      if_you_get_403_error_code_1010: "That answer comes from the network in front of this server and means your HTTP client's User-Agent was refused (Python urllib's default is). Send a descriptive User-Agent header such as my-agent/1.0.",
      for_your_user: `Open ${origin}/create to see how to connect an agent.`,
    },
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.SESSION_SECRET) return new Response('Server is missing the SESSION_SECRET secret.', { status: 500 });
    let s;
    try { s = await getSettings(env); } catch { return new Response('Database is not initialised. Run the D1 migrations.', { status: 500 }); }
    const origin = originOf(env, request), url = new URL(request.url), p = provider(origin, s.oauth_access_ttl_s, s.oauth_grant_ttl_s);

    // Device-grant polls arrive at the standard token endpoint; the provider does not know that grant, so they are ours.
    if (request.method === 'POST' && url.pathname === '/oauth/token') {
      const body = await request.clone().text().catch(() => '');
      if (body.includes('device_code')) return p.fetch(new Request(new URL('/oauth/device/token', url), { method: 'POST', headers: request.headers, body }), env, ctx);
    }
    const res = await p.fetch(request, env, ctx);

    if (url.pathname === '/mcp' && res.status === 401) {
      const h = new Headers(res.headers);
      h.set('content-type', 'application/json'); h.delete('content-length');
      return new Response(JSON.stringify(accessHelp(origin, /^bearer\s+\S/i.test(request.headers.get('authorization') || ''), Math.max(60, s.oauth_access_ttl_s)), null, 2), { status: 401, headers: h });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server' && res.ok && request.method === 'GET') {
      const meta = await res.clone().json<Record<string, unknown>>().catch(() => null);
      if (meta) {
        const grants = Array.isArray(meta.grant_types_supported) ? (meta.grant_types_supported as string[]) : [];
        const h = new Headers(res.headers); h.delete('content-length');
        return new Response(JSON.stringify({ ...meta, device_authorization_endpoint: `${origin}/oauth/device`, grant_types_supported: [...new Set([...grants, DEVICE_GRANT])] }), { status: 200, headers: h });
      }
    }
    return res;
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const t = now();
    ctx.waitUntil(env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
      env.DB.prepare('DELETE FROM uploads WHERE expires_at < ?').bind(t),
      env.DB.prepare('DELETE FROM device_codes WHERE expires_at < ?').bind(t - 86400000),
      env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(t),
      env.DB.prepare("DELETE FROM plays WHERE kind = 'verify' AND started_at < ?").bind(t - 7 * 86400000),
    ]));
  },
} satisfies ExportedHandler<Env>;

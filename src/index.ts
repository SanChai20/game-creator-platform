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
import { rt } from './routes/rt';
import { upload } from './routes/upload';
import { getSettings } from './settings';
import { esc, now } from './util';
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
app.route('/api', api);
app.all('/api/*', (c) => c.json({ error: 'Not found', code: 'not_found' }, 404));

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
    return new Response((await r.text()).replaceAll('{{ORIGIN}}', new URL(c.req.url).origin).replaceAll('{{THREE}}', THREE_VERSION), { headers: h });
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
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:dark}html,body{height:100%;margin:0;background:#0b0d0f;color:#e8e4da;font:15px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif}
body{display:grid;place-items:center;padding:24px;box-sizing:border-box;background:radial-gradient(900px 500px at 50% -10%,rgba(255,179,71,.14),transparent 60%),#0b0d0f}
main{width:min(460px,100%);background:#14181b;border:1px solid rgba(232,228,218,.14);border-radius:18px;padding:28px}
.mark{font-weight:800;letter-spacing:.14em;text-transform:uppercase;font-size:12px;color:#ffb347;margin-bottom:18px}
h1{font-size:24px;line-height:1.2;margin:0 0 10px;letter-spacing:-.01em}p{margin:0 0 12px;color:rgba(232,228,218,.7)}strong{color:#e8e4da}
ul{margin:14px 0 18px;padding:14px 16px;list-style:none;background:#0f1215;border:1px solid rgba(232,228,218,.1);border-radius:12px}li{padding:4px 0 4px 22px;position:relative}li:before{content:"";position:absolute;left:2px;top:12px;width:8px;height:8px;border-radius:50%;background:#ffb347}
.warn{border:1px solid rgba(255,90,64,.5);background:rgba(255,90,64,.08);color:#ffc2b6;border-radius:12px;padding:10px 14px;margin:0 0 14px}
.row{display:flex;gap:10px;margin-top:8px}button{flex:1;font:inherit;font-weight:700;border-radius:11px;padding:12px 16px;cursor:pointer;border:1px solid rgba(232,228,218,.2);background:transparent;color:#e8e4da}
button.go{background:#ffb347;border-color:#ffb347;color:#1b1203}small{display:block;margin-top:16px;color:rgba(232,228,218,.5)}</style></head><body><main>${body}</main></body></html>`;
}

function consentPage(brand: string, d: ConsentDescription, handle: string, user: User, days: number): string {
  const who = d.clientDomain ? `Published by <strong>${esc(d.clientDomain)}</strong>.` : 'This app registered itself, so its name is not verified.';
  return page(`Connect ${d.clientName}`, `<div class="mark">${esc(brand)}</div>
<h1>Let ${esc(d.clientName)} make games for you?</h1>
<p>${who} Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<div class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from that app.</div>' : ''}
<p>Signed in as <strong>${esc(user.name)}</strong> (${esc(user.email)}). The agent will be able to:</p>
<ul><li>Create and edit your game projects</li><li>Deploy previews and run verification</li><li>Publish, roll back and take games offline</li><li>Set listing details and prices, and read your game stats</li></ul>
<p>It cannot withdraw money, change your password or see payment details.</p>
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.SESSION_SECRET) return new Response('Server is missing the SESSION_SECRET secret.', { status: 500 });
    let s;
    try { s = await getSettings(env); } catch { return new Response('Database is not initialised. Run the D1 migrations.', { status: 500 }); }
    return provider(originOf(env, request), s.oauth_access_ttl_s, s.oauth_grant_ttl_s).fetch(request, env, ctx);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const t = now();
    ctx.waitUntil(env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
      env.DB.prepare('DELETE FROM uploads WHERE expires_at < ?').bind(t),
      env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(t),
      env.DB.prepare("DELETE FROM plays WHERE kind = 'verify' AND started_at < ?").bind(t - 7 * 86400000),
    ]));
  },
} satisfies ExportedHandler<Env>;

// Game Creator platform Worker: web API, OAuth authorization server, MCP server, and static hosting
// for the web app, the SDK, the kits and the vendored Three.js build.
import { AuthorizationError, CimdFetchError, OAuthProvider, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import { AppError, type Env, type User } from './env';
import { userFromRequest } from './auth';
import { gameBindings, rolloutRuntime } from './deploy';
import { dispatchGame, type Namespace } from './dispatch';
import { hostKind, matchGameRequest } from './hosting';

const DAILY_CRON = '17 3 * * *';   // must match the first cron in wrangler.jsonc
import { handleMcp } from './mcp/server';
import { THREE_VERSION } from './generated/runtime-source';
import { getProject, getVersion } from './projects';
import { admin } from './routes/admin';
import { api } from './routes/api';
import { DEVICE_GRANT, deviceApi, deviceOAuth, type TokenExchange } from './routes/device';
import { rt } from './routes/rt';
import { upload } from './routes/upload';
import { getSettings } from './settings';
import { dayOf, esc, now } from './util';
import { backfill } from './originality-check';
import { backfillMature } from './mature';
import { TOKENS_CSS } from '../web/src/ui/tokens';
import { langTag, pageLang, TEXT } from './consent-text';
import type { Lang } from '../web/src/i18n/langs';
// @ts-ignore plain JS module
import { handle as handleGame } from './runtime/game-worker.js';
// @ts-ignore plain JS module
import { verifierCleanupStmts } from './player-data.js';

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

// Local driver (wrangler dev): serve games from this Worker with the exact runtime the deployed Workers use, through
// the same dispatch code the Workers for Platforms dispatch Worker runs, with this namespace standing in for the real one.
app.all('/__game/:pid/:env/*', async (c) => {
  const m = hostKind(c.env) === 'local' ? matchGameRequest(c.env, new URL(c.req.url)) : null;
  if (!m || !m.script) return c.text('Not found', 404);
  const route = m, env = c.env, origin = c.get('origin'), ctx = c.executionCtx;
  const local: Namespace = {
    get: () => ({
      fetch: async (req: Request) => {
        const p = await getProject(env, route.pid);
        const n = p && (route.env === 'live' ? (p.status === 'live' ? p.live_version : null) : p.preview_version);
        const v = p && n ? await getVersion(env, p.id, n) : null;
        if (!p || !v) throw new Error(`Worker not found: ${route.script}`);
        const fake = { FILES: env.FILES, ...(await gameBindings(env, origin, p, v, route.env)) };
        return handleGame(req, fake, ctx, route.base);
      },
    }),
  };
  return dispatchGame(c.req.raw, env, local, await getSettings(env), m, origin);
});

// ----- OAuth consent ---------------------------------------------------------------------------
// Server-rendered pages share the web app's design tokens (web/src/ui/tokens.ts), so they look like the rest of the site.
const PAGE_CSS = `*,*::before,*::after{box-sizing:border-box}html,body{min-height:100%;margin:0;background:var(--paper);color:var(--text);font:400 var(--fs-md)/1.6 var(--font-sans);-webkit-font-smoothing:antialiased}
body{display:grid;place-items:center;padding:24px}
main{position:relative;width:min(470px,100%);display:grid;gap:14px;background:var(--surface);border:1px solid var(--line-2);border-radius:var(--r-lg);padding:clamp(24px,5vw,34px);box-shadow:var(--shadow-3)}
main::before{content:"";position:absolute;left:-1px;top:-1px;width:84px;height:5px;background:var(--accent);clip-path:polygon(0 0,100% 0,calc(100% - 5px) 100%,0 100%)}
.mark{display:flex;align-items:center;gap:10px;font:800 15px/1 var(--font-display);font-stretch:82%;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px}.mark i{width:24px;height:24px;border-radius:50%;background:radial-gradient(circle at 34% 32%,var(--c-cream) 0 15%,transparent 16%),radial-gradient(circle at 26% 30%,var(--accent) 0 60%,var(--c-wine) 61%)}
h1{font:800 27px/1.05 var(--font-display);font-stretch:80%;text-transform:uppercase;margin:0;text-wrap:balance}p{margin:0;color:var(--text-2)}strong{color:var(--text);font-weight:650}
ul{margin:0;padding:14px 16px;list-style:none;display:grid;gap:9px;background:var(--sunk);border-radius:var(--r-sm);font-size:13.5px}li{padding-left:26px;position:relative}li::before{content:"";position:absolute;left:0;top:.5em;width:14px;height:7px;background:var(--accent);clip-path:polygon(4px 0,100% 0,calc(100% - 4px) 100%,0 100%)}
.warn{border-left:4px solid var(--bad);background:rgb(var(--bad-rgb) / .09);border-radius:var(--r-sm);padding:12px 14px;color:var(--text)}
.web-only{font-size:13px;padding-left:12px;border-left:2px solid var(--line-3)}
.row{display:flex;gap:16px;margin-top:8px;padding-inline:5px}button{position:relative;isolation:isolate;flex:1;height:48px;font:700 14px/1 var(--font-display);letter-spacing:.06em;text-transform:uppercase;cursor:pointer;border:0;background:none;color:var(--text)}
button::before{content:"";position:absolute;inset:0;z-index:-1;transform:skewX(-12deg);border-radius:3px;border:1.5px solid var(--line-2);background:var(--surface);transition:border-color var(--dur-fast),background-position var(--dur) var(--ease)}button:hover::before{border-color:var(--edge)}button:active{transform:translate(1px,1px)}
button.go{color:var(--on-accent)}button.go::before{border-color:transparent;background:var(--accent) linear-gradient(105deg,transparent 0 49.8%,rgb(0 0 0 / .16) 50% 100%) 22% 0 / 300% 100% no-repeat}button.go:hover::before{border-color:transparent;background-position:62% 0}
button.go::after{content:"";position:absolute;inset:0;z-index:-2;border-radius:3px;background:rgb(var(--accent-rgb) / .3);transform:skewX(-12deg) translate(3px,3px)}
small{display:block;color:var(--text-3);font-size:12.5px}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}:lang(zh) h1,:lang(ja) h1,:lang(ko) h1{letter-spacing:0;line-height:1.25}`;
// The same start-up line as the web app: the visitor's chosen theme, or the system's.
const THEME_JS = `try{var t=localStorage.getItem('gcp.theme');document.documentElement.dataset.theme=t==='day'||t==='night'?t:matchMedia('(prefers-color-scheme: dark)').matches?'night':'day'}catch(e){document.documentElement.dataset.theme='day'}`;
function page(title: string, body: string, lang: Lang = 'en'): string {
  return `<!doctype html><html lang="${langTag(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><script>${THEME_JS}</script>
<style>${TOKENS_CSS}${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`;
}

function consentPage(brand: string, d: ConsentDescription, handle: string, user: User, days: number, lang: Lang): string {
  const T = TEXT[lang], app = esc(d.clientName);
  const who = d.clientDomain ? T.publishedBy(esc(d.clientDomain)) : T.unverified;
  return page(T.connect(d.clientName), `<div class="mark"><i></i>${esc(brand)}</div>
<h1>${T.heading(app)}</h1>
<p>${who} ${T.sentTo(esc(d.redirectHost))}</p>
${d.redirectIsLoopback ? `<div class="warn"><strong>${T.loopback[0]}</strong> ${T.loopback[1]}</div>` : ''}
<p>${T.signedInAs(esc(user.name), esc(user.email))}</p>
<ul>${T.can.map((c) => `<li>${c}</li>`).join('')}</ul>
<p>${T.cannot}</p>
<p class="web-only">${T.webOnly}</p>
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<div class="row"><button name="decision" value="deny">${T.deny}</button><button class="go" name="decision" value="approve">${T.allow}</button></div></form>
<small>${T.expires(days)}</small>`, lang);
}

app.all('/authorize', async (c) => {
  const env = c.env, req = c.req.raw, oauth = env.OAUTH_PROVIDER, s = await getSettings(env), lang = pageLang(req), T = TEXT[lang];
  try {
    const user = await userFromRequest(env, req);
    if (req.method === 'POST') {
      if (!user) return c.html(page(T.signInAgain, `<h1>${T.sessionEnded}</h1><p>${T.sessionEndedBody}</p>`, lang), 401);
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
    return new Response(consentPage(s.brand_name, details, consent.handle, user, Math.max(1, Math.round(s.oauth_grant_ttl_s / 86400)), lang), { headers: consent.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const msg = error instanceof AuthorizationError ? error.description : T.notVerified;
      return c.html(page(T.cannotConnect, `<h1>${T.cannotContinue}</h1><p>${esc(msg)}</p><p>${T.startAgain}</p>`, lang), 400);
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

// Pages ask for their own agent cluster (Origin-Agent-Cluster). Games are served from sibling subdomains of the same site
// (<script>.<account>.workers.dev), and Chrome keeps same-site frames in one process, so a game that is busy loading
// froze the platform page around it. An origin-keyed page gets a process of its own, and so does the game frame inside
// it. web/public/_headers does the same for the web app's static pages, and the game runtime for game pages.
function isolated(res: Response): Response {
  if (res.headers.has('origin-agent-cluster') || !(res.headers.get('content-type') || '').includes('text/html') || res.status === 101) return res;
  const h = new Headers(res.headers); h.set('origin-agent-cluster', '?1');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
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
    return isolated(res);
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // every few minutes: bring game Workers deployed with an older runtime up to this build's (a no-op once all are current)
    ctx.waitUntil(rolloutRuntime(env).catch((e) => console.error('runtime rollout failed', e)));
    // live games published before adult games were labelled get their age rating on the project (a no-op once all have one)
    ctx.waitUntil(backfillMature(env, 20).catch((e) => console.error('mature backfill failed', e)));
    if (event.cron !== DAILY_CRON) return;
    const t = now();
    ctx.waitUntil(env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
      env.DB.prepare('DELETE FROM uploads WHERE expires_at < ?').bind(t),
      env.DB.prepare('DELETE FROM device_codes WHERE expires_at < ?').bind(t - 86400000),
      env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(t),
      env.DB.prepare("DELETE FROM plays WHERE kind = 'verify' AND started_at < ?").bind(t - 7 * 86400000),
      env.DB.prepare('DELETE FROM ai_usage WHERE day < ?').bind(dayOf(t - 60 * 86400000)),
      ...verifierCleanupStmts(env.DB, t - 86400000),
    ]));
    // games published before the duplication check existed get their fingerprints a few at a time
    ctx.waitUntil(backfill(env, 20).catch((e) => console.error('fingerprint backfill failed', e)));
  },
} satisfies ExportedHandler<Env>;

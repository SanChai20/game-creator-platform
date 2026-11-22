// HearthCade platform Worker: web API, OAuth authorization server, MCP server, and static hosting
// for the web app, the SDK, the kits and the vendored Three.js build.
import { AuthorizationError, CimdFetchError, OAuthProvider, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import { AppError, type Env, type User } from './env';
import { sessionToken, userFromRequest } from './auth';
import { gameBindings, rolloutRuntime } from './deploy';
import { eachStmt, purgeOldVersions, purgeRemovedGameData, retireIdlePreviews } from './cleanup';
import { reapDebugSessions } from './debug';
import { purgeOldFeedback } from './feedback';
import { dispatchGame, type Namespace } from './dispatch';
import { gameHostName, hostKind, matchGameRequest, type OutboundParams } from './hosting';
import { serveSharedGame } from './game-host';
import { CLOCK_HEADER } from './clock-ticket';
import { WorkerEntrypoint } from 'cloudflare:workers';
// @ts-ignore plain JS module
import { outboundDecision } from './runtime/outbound-worker.js';

const DAILY_CRON = '17 3 * * *';   // must match the first cron in wrangler.jsonc
const MINUTE_CRON = '* * * * *';
import { handleMcp } from './mcp/server';
import { THREE_VERSION } from './generated/runtime-source';
import { getProject, getVersion } from './projects';
import { admin } from './routes/admin';
import { api, autoPayouts, retryTransfers } from './routes/api';
import { DEVICE_GRANT, deviceApi, deviceOAuth, type TokenExchange } from './routes/device';
import { rt } from './routes/rt';
import { social } from './routes/social';
import { push } from './routes/push';
import { upload } from './routes/upload';
import { getSettings } from './settings';
import { dayOf, esc, now, parseJson } from './util';
import { GUIDES, gamePage, homePage, injectMeta, isPrivatePath, llmsTxt, robotsTxt, siteJsonLd, sitemapXml, staticPage, type PageMeta, type SitemapEntry } from './seo';
import { GENRES } from '../web/src/gamemeta';
import { TAGS, normalizeStoredTags } from '../web/src/tags';
import { OPERATOR } from '../web/src/operator';
import { backfill, backfillIdentity } from './originality-check';
import { backfillMature } from './mature';
import { TOKENS_CSS } from '../web/src/ui/tokens';
import { langTag, pageLang, TEXT } from './consent-text';
import type { Lang } from '../web/src/i18n/langs';
// @ts-ignore plain JS module
import { handle as handleGame } from './runtime/game-worker.js';
// @ts-ignore plain JS module
import { idleGuestCleanupStmts, verifierCleanupStmts } from './player-data.js';
// @ts-ignore plain JS module
import { claimedGuestCleanupStmts } from './session-binding.js';
// @ts-ignore plain JS module
import { oldSeatsStmt } from './match-seats.js';
// @ts-ignore plain JS module
import { cleanupStmts as socialCleanupStmts } from './social-rules.js';

import { recentStmt, refreshCatalog } from './catalog';
import { ensurePicks, oldPicksStmt, runJob } from './rankings';
export { GameRoom } from './room';
export { Matchmaker } from './matchmaker';
export { BotFleet } from './bots';
export { Pipeline } from './pipeline';
export { SocialHub } from './social';
export { PlayClock, GameTally } from './clock-do';

type App = { Bindings: Env; Variables: { user: User | null; origin: string } };
const app = new Hono<App>();
const originOf = (env: Env, req: Request) => env.PUBLIC_ORIGIN || new URL(req.url).origin;

// Machine endpoints that keep answering on the Worker's other hosts (workers.dev, www): game Workers deployed before a
// domain move call back to the address they were deployed with, and agents keep their configured MCP URL. None of them
// sets a cookie. Everything else (pages, cookie-session API) moves to PUBLIC_ORIGIN, so sign-in only ever happens there.
const MACHINE_PATHS = /^\/(api\/rt\/|api\/upload\/|api\/stripe\/webhook$|mcp(\/|$)|oauth\/(token|register|device(\/token)?)$|\.well-known\/|sdk\/|kits\/|vendor\/|guides\/|templates\/|__game\/)/;
export function canonicalRedirect(env: Pick<Env, 'PUBLIC_ORIGIN'>, url: URL): Response | null {
  if (!env.PUBLIC_ORIGIN || url.origin === env.PUBLIC_ORIGIN || MACHINE_PATHS.test(url.pathname)) return null;
  return new Response(null, { status: 308, headers: { location: env.PUBLIC_ORIGIN + url.pathname + url.search, 'cache-control': 'no-store' } });
}

app.onError((e, c) => {
  if (e instanceof AppError) return c.json({ error: e.message, code: e.code, hint: e.hint }, e.status as any);
  // A burst the database cannot take right now (D1 refuses work over a 10-second window): the page retries in a moment
  // (web/src/lib.tsx api), so a rush of players turns into a short wait instead of an error.
  if (/D1 DB is overloaded|D1_ERROR: .*(overloaded|Too many requests)/i.test(String((e as Error)?.message || ''))) {
    console.warn('busy', c.req.method, new URL(c.req.url).pathname);
    c.header('retry-after', '1');
    return c.json({ error: 'The platform is very busy right now. Try again in a moment.', code: 'busy' }, 503);
  }
  // the message first: Workers Logs keep an Error's stack but not always its message
  console.error('unhandled', c.req.method, new URL(c.req.url).pathname, String((e as Error)?.message || e), (e as Error)?.stack);
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
    const o = c.req.header('origin'), site = c.req.header('sec-fetch-site');
    if (o && o !== c.get('origin') && o !== new URL(c.req.url).origin) throw new AppError(403, 'Cross-site request refused.', 'csrf');
    // A browser always says where a cookie-carrying mutation comes from; one that says neither is refused.
    if (!o && sessionToken(c.req.raw) && site !== 'same-origin' && site !== 'none') throw new AppError(403, 'Cross-site request refused.', 'csrf');
  }
  // A ticketed play-clock check-in (every 30 s per open game) needs no sign-in lookup: the route reads its ticket instead.
  const ticketed = m === 'POST' && c.req.header(CLOCK_HEADER) && /^\/api\/plays\/[^/]+\/seen$/.test(path);
  c.set('user', path === '/api/stripe/webhook' || ticketed ? null : await userFromRequest(c.env, c.req.raw));
  await next();
});
app.route('/api/admin', admin);
app.route('/api/device', deviceApi);
app.route('/api/social', social);
app.route('/api/push', push);
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

// ----- being found: robots.txt, the sitemap, llms.txt, and meta tags in the pages (src/seo.ts) ---------------------
const PUBLIC_TXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' };
type SeoGame = { slug: string; title: string; tagline: string | null; tags: string | null; price_cents: number; plays: number; updated_at: number | null; published_at: number | null; author: string; age: number | null; open_implementation: number };
const liveGames = (env: Env, limit: number) => env.DB.prepare(`SELECT p.slug, p.title, p.tagline, p.tags, p.price_cents, p.plays, p.updated_at, p.published_at, p.age, p.open_implementation, u.name AS author
  FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.status = 'live' ORDER BY p.plays DESC LIMIT ?`).bind(limit).all<SeoGame>().then((r) => r.results);
const genreOf = (tags: string | null) => normalizeStoredTags(parseJson<string[]>(tags, []))[0] || null;

app.get('/robots.txt', (c) => c.text(robotsTxt(c.get('origin')), 200, PUBLIC_TXT));
app.get('/sitemap.xml', async (c) => {
  const games = await liveGames(c.env, 20000), t = now();
  const entries: SitemapEntry[] = [
    { path: '/', changefreq: 'daily', priority: 1 }, { path: '/browse', changefreq: 'daily', priority: 0.8 }, { path: '/categories', changefreq: 'weekly', priority: 0.7 },
    { path: '/create', changefreq: 'weekly', priority: 0.9 }, { path: '/docs', changefreq: 'weekly', priority: 0.9 }, { path: '/creator-store', changefreq: 'daily', priority: 0.7 },
    ...games.map((g) => ({ path: `/g/${encodeURIComponent(g.slug)}`, lastmod: g.updated_at || g.published_at, changefreq: 'weekly' as const, priority: 0.8 })),
    ...games.filter((g) => g.open_implementation).map((g) => ({ path: `/creator-store/${encodeURIComponent(g.slug)}`, lastmod: g.updated_at, changefreq: 'weekly' as const, priority: 0.5 })),
    ...[...GENRES, ...TAGS].map((tag) => ({ path: `/c/${encodeURIComponent(tag)}`, changefreq: 'weekly' as const, priority: 0.5 })),
    ...GUIDES.map(([f]) => ({ path: `/guides/${f}`, changefreq: 'monthly' as const, priority: 0.6 })),
    { path: '/llms.txt', lastmod: t, priority: 0.6 }, { path: '/llms-full.txt', lastmod: t, priority: 0.4 },
    ...['terms', 'privacy', 'cookies', 'refunds'].map((d) => ({ path: `/legal/${d}`, changefreq: 'monthly' as const, priority: 0.2 })),
  ];
  return c.body(sitemapXml(c.get('origin'), entries), 200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' });
});
async function llmsBody(c: { env: Env; get: (k: 'origin') => string }) {
  const s = await getSettings(c.env), games = await liveGames(c.env, 200);
  const stats = await c.env.DB.prepare("SELECT COUNT(*) AS games, COUNT(DISTINCT owner_id) AS creators FROM projects WHERE status = 'live'").first<{ games: number; creators: number }>();
  return llmsTxt({ brand: s.brand_name || 'HearthCade', origin: c.get('origin'), games: stats?.games || 0, creators: stats?.creators || 0, licenseTermCents: s.license_term_cents, licenseTermDays: s.license_term_days, licenseLifetimeCents: s.license_lifetime_cents, feePercent: s.platform_fee_percent, feeOpenPercent: s.platform_fee_open_percent },
    games.filter((g) => !((g.age || 0) >= 18)).slice(0, 100).map((g) => ({ slug: g.slug, title: g.title, tagline: g.tagline, genre: genreOf(g.tags), price_cents: g.price_cents, author: g.author, plays: g.plays })));
}
app.get('/llms.txt', async (c) => c.text(await llmsBody(c), 200, PUBLIC_TXT));
app.get('/llms-full.txt', async (c) => {
  const parts = [await llmsBody(c)];
  for (const [f] of GUIDES) {
    const r = await c.env.ASSETS.fetch(new Request(`${new URL(c.req.url).origin}/guides/${f}`));
    if (r.ok && !(r.headers.get('content-type') || '').includes('text/html')) parts.push(`\n\n---\n\n<!-- ${c.get('origin')}/guides/${f} -->\n\n` + (await r.text()).replaceAll('{{ORIGIN}}', c.get('origin')).replaceAll('{{THREE}}', THREE_VERSION).replaceAll('{{TARGET}}', String((await getSettings(c.env)).craft_target)));
  }
  return c.text(parts.join(''), 200, PUBLIC_TXT);
});

/** The page's meta tags, JSON-LD and noscript summary for the app's HTML, or null to send it as it is. */
async function pageMeta(env: Env, origin: string, path: string): Promise<PageMeta | null> {
  const brand = (await getSettings(env)).brand_name || 'HearthCade';
  if (isPrivatePath(path)) return { title: brand, description: brand, path, noindex: true };
  const site = siteJsonLd(origin, brand, OPERATOR);
  if (path === '/') {
    const games = (await liveGames(env, 60)).filter((g) => !((g.age || 0) >= 18)).slice(0, 40);
    return { ...homePage(origin, brand, games), jsonld: site };
  }
  const m = path.match(/^\/g\/([^/]+)$/);
  if (m) {
    const slug = decodeURIComponent(m[1]);
    const g = await env.DB.prepare(`SELECT p.slug, p.title, p.tagline, p.description, p.tags, p.price_cents, p.rating_sum, p.rating_count, p.cover_key, p.age, p.published_at, p.updated_at, p.plays, u.name AS author
      FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.slug = ? AND p.status = 'live'`).bind(slug).first<Record<string, any>>().catch(() => null);
    if (!g) return null;
    const tags = normalizeStoredTags(parseJson<string[]>(g.tags, []));
    const meta = gamePage(origin, brand, { slug: g.slug, title: g.title, tagline: g.tagline, description: g.description, genre: tags[0] || null, tags: tags.slice(1), price_cents: g.price_cents, author: g.author,
      rating_sum: g.rating_sum, rating_count: g.rating_count, cover: (g.age || 0) >= 18 || !g.cover_key ? null : `${origin}/api/media/${g.cover_key}`, age: g.age, published_at: g.published_at, updated_at: g.updated_at, plays: g.plays,
      multiplayer: tags.some((x) => ['multiplayer', 'co-op', 'pvp', 'local-multiplayer'].includes(x)) });
    return { ...meta, jsonld: [...(meta.jsonld || []), ...site] };
  }
  const st = staticPage(origin, brand, path);
  return st ? { ...st, jsonld: site } : null;
}

// Anything else is the web app (served from static assets; unknown paths fall back to index.html), with the page's own
// meta in its HTML for crawlers and link previews.
app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (c.req.method !== 'GET' || res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  const path = new URL(c.req.url).pathname.replace(/\/+$/, '') || '/';
  const meta = await pageMeta(c.env, c.get('origin'), path).catch((e) => { console.warn('page meta', path, (e as Error).message); return null; });
  if (!meta) return res;
  const h = new Headers(res.headers); h.delete('content-length'); h.delete('etag');
  if (meta.noindex) h.set('x-robots-tag', 'noindex, nofollow');
  return new Response(injectMeta(await res.text(), c.get('origin'), meta), { status: 200, headers: h });
});

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
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: 'HearthCade MCP', bearer_methods_supported: ['header'] },
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
// They also refuse to be framed by any other site (clickjacking of sign-in, purchase and consent buttons).
function isolated(res: Response): Response {
  if (res.headers.has('origin-agent-cluster') || !(res.headers.get('content-type') || '').includes('text/html') || res.status === 101) return res;
  const h = new Headers(res.headers); h.set('origin-agent-cluster', '?1');
  if (!h.has('content-security-policy')) h.set('content-security-policy', "frame-ancestors 'self'");
  if (!h.has('x-frame-options')) h.set('x-frame-options', 'SAMEORIGIN');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/** Personal pages, sign-in, the API and MCP are never indexed, whatever answers them (src/seo.ts). */
function unlisted(path: string, res: Response): Response {
  if (!isPrivatePath(path) || res.status === 101 || res.headers.has('x-robots-tag')) return res;
  const h = new Headers(res.headers); h.set('x-robots-tag', 'noindex, nofollow');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/** Every fetch() a game's Dynamic Worker makes (its server code, and the runtime's calls to the platform) comes here
    (src/game-host.ts): the admin's blocked hosts are refused, calls to the platform are answered in-process (one Worker
    does not reach itself over HTTP) and say which game made them, whatever the game's code put in the headers. */
export class GameOutbound extends WorkerEntrypoint<Env, OutboundParams> {
  async fetch(request: Request): Promise<Response> {
    const p = this.ctx.props;
    const d = outboundDecision(request.url, p);
    if (!d.allow) {
      console.log(JSON.stringify({ outbound: 'blocked', game: p.game, env: p.env, url: request.url.split('?')[0], reason: d.reason }));
      return Response.json({ error: d.reason, code: 'outbound_blocked' }, { status: 403 });
    }
    if (!d.platform) return fetch(request);
    const r = new Request(request);
    r.headers.set('x-gcp-game', String(p.game || ''));
    r.headers.set('x-gcp-env', String(p.env || ''));
    return handler.fetch(r, this.env, this.ctx);
  }
}

const handler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.SESSION_SECRET) return new Response('Server is missing the SESSION_SECRET secret.', { status: 500 });
    let s;
    try { s = await getSettings(env); } catch { return new Response('Database is not initialised. Run the D1 migrations.', { status: 500 }); }
    const origin = originOf(env, request), url = new URL(request.url);
    // The shared game host (src/game-host.ts): requests for <script>.<GAME_HOST> are games and nothing else, so a game's
    // address never reaches the platform's pages, API or cookies. Games still on a Worker of their own are not routed here
    // (their per-script route is more specific than the wildcard).
    const gh = gameHostName(env);
    if (gh && hostKind(env) !== 'local' && url.host.toLowerCase().endsWith('.' + gh)) {
      const exp = (ctx as unknown as { exports?: { GameOutbound?: (o: { props: OutboundParams }) => Fetcher } }).exports;
      const lc = env.LOADER && exp?.GameOutbound ? { loader: env.LOADER, outbound: (props: OutboundParams) => exp.GameOutbound!({ props }) } : null;
      return serveSharedGame(request, env, ctx, matchGameRequest(env, url) || { script: null }, env.PUBLIC_ORIGIN || origin, lc);
    }
    const p = provider(origin, s.oauth_access_ttl_s, s.oauth_grant_ttl_s);
    const moved = canonicalRedirect(env, url);
    if (moved) return moved;

    // Device-grant polls arrive at the standard token endpoint; the provider does not know that grant, so they are ours.
    if (request.method === 'POST' && url.pathname === '/oauth/token') {
      const body = await request.clone().text().catch(() => '');
      if (new URLSearchParams(body).get('grant_type') === DEVICE_GRANT) return p.fetch(new Request(new URL('/oauth/device/token', url), { method: 'POST', headers: request.headers, body }), env, ctx);
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
    return isolated(unlisted(url.pathname, res));
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Everything the store keeps in order runs from here, so no admin has to look after it (src/rankings.ts lists it);
    // each job records its last run for the admin overview.
    const job = (name: string, fn: () => Promise<unknown>) => ctx.waitUntil(runJob(env, name, fn));
    // every minute: who is playing what
    job('playing', () => refreshCatalog(env, false));
    if (event.cron === MINUTE_CRON) return;
    // every 10 minutes: trending scores, then today's picks (chosen at the first run of each UTC day, from those scores)
    job('trending', async () => { await env.DB.batch([recentStmt(env.DB)]); await runJob(env, 'picks', () => ensurePicks(env)); });
    job('transfers', () => retryTransfers(env));
    // bring game Workers deployed with an older runtime up to this build's (a no-op once all are current)
    job('rollout', () => rolloutRuntime(env));
    // live games published before adult games were labelled get their age rating on the project (a no-op once all have one)
    job('mature', () => backfillMature(env, 20));
    // debug browsers past their lifetime are closed (src/debug.ts)
    job('debug sessions', () => reapDebugSessions(env));
    // live games published before the identity index get their keys (a no-op once all have them; src/originality-check.ts)
    job('identity index', () => backfillIdentity(env, 10));
    if (event.cron !== DAILY_CRON) return;
    job('payouts', () => autoPayouts(env));
    const t = now();
    // Each statement runs on its own: they are independent, and one that runs out of time on a big table must not roll
    // back the others (a single batch is one transaction), or nothing would ever be cleaned up again.
    job('cleanup', () => eachStmt([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
      env.DB.prepare('DELETE FROM uploads WHERE expires_at < ?').bind(t),
      env.DB.prepare('DELETE FROM device_codes WHERE expires_at < ?').bind(t - 86400000),
      env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(t),
      env.DB.prepare('DELETE FROM login_challenges WHERE expires_at < ?').bind(t),
      env.DB.prepare('DELETE FROM email_codes WHERE expires_at < ?').bind(t),
      env.DB.prepare('DELETE FROM signup_links WHERE expires_at < ?').bind(t),
      env.DB.prepare('DELETE FROM passkey_challenges WHERE expires_at < ?').bind(t),
      env.DB.prepare("DELETE FROM plays WHERE kind = 'verify' AND started_at < ?").bind(t - 7 * 86400000),
      // preview test bots (src/bots.ts): a fleet removes its bots' sessions when it stops; these catch one that never did
      env.DB.prepare("DELETE FROM plays WHERE kind = 'bot' AND started_at < ?").bind(t - 86400000),
      env.DB.prepare("UPDATE bot_fleets SET ended_at = ends_at, summary = COALESCE(summary, '{\"why\":\"closed by the daily cleanup\"}') WHERE ended_at IS NULL AND ends_at < ?").bind(t - 3600000),
      env.DB.prepare('DELETE FROM bot_fleets WHERE started_at < ?').bind(t - 90 * 86400000),
      env.DB.prepare('DELETE FROM ai_usage WHERE day < ?').bind(dayOf(t - 60 * 86400000)),
      env.DB.prepare('DELETE FROM dup_judgments WHERE created_at < ?').bind(t - 30 * 86400000),
      env.DB.prepare('DELETE FROM matches WHERE created_at < ?').bind(t - 30 * 86400000),   // ratings stay; the match log is a month
      oldSeatsStmt(env.DB, t - 86400000),   // a match lasts an hour: older seats lead nowhere
      oldPicksStmt(env.DB, t),
      ...verifierCleanupStmts(env.DB, t - 86400000),
      ...claimedGuestCleanupStmts(env.DB, t - 30 * 86400000),
      ...idleGuestCleanupStmts(env.DB, t - 180 * 86400000),   // guests who never came back keep nothing forever
    ]));
    // games published before the duplication check existed get their fingerprints a few at a time
    job('fingerprints', () => backfill(env, 20));
    // hosting within its limits: idle preview Workers and old versions' files; removed games' player data (src/cleanup.ts)
    job('idle previews', () => retireIdlePreviews(env));
    job('old versions', () => purgeOldVersions(env));
    job('removed game data', () => purgeRemovedGameData(env));
    job('old feedback', () => purgeOldFeedback(env));
    // chat older than the setting, answered invites after a week, seen notifications after 90 days (src/social-rules.js)
    job('old chat', async () => eachStmt(socialCleanupStmts(env.DB, t, Math.max(7, Number((await getSettings(env)).dm_keep_days) || 365))));
  },
} satisfies ExportedHandler<Env>;
export default handler;

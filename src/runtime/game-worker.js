// Entry module of every game Worker. The platform uploads this file unchanged for each game and
// binds: FILES (R2 bucket), PREFIX (where this version's files live), PLATFORM (platform origin),
// GAME_ID, SLUG, TITLE, VERSION, ENV ("preview" | "live"), MANIFEST (JSON), PLAY_KEY (secret).
// It gates the game document behind a platform play token, injects the SDK, serves the bundle,
// and forwards /api/* to the game's optional server module.
// The same script runs as a standard Worker or as a user Worker in a Workers for Platforms dispatch namespace (src/hosting.ts):
// it reads nothing host-specific (no request.cf, no Cache API), and it is deployed with disallow_importable_env so the
// game's server modules only ever see the narrow env handed to them below, never these bindings.
// gcp-intrinsics.js must stay the FIRST import: modules are evaluated in import order, so it captures the built-ins
// before the game's server modules (imported next) can replace them.
import { I } from './gcp-intrinsics.js';
import userServer from './server/index.js';

const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', map: 'application/json', txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', ico: 'image/x-icon',
  wasm: 'application/wasm', glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream', ktx2: 'image/ktx2', hdr: 'application/octet-stream',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wgsl: 'text/plain; charset=utf-8', glsl: 'text/plain; charset=utf-8',
};
const b64u = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return I.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s) => { const b = I.atob(s.replace(/-/g, '+').replace(/_/g, '/')), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function verifyPlayToken(token, key, gameId, envName) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const k = await I.importKey('raw', I.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!(await I.verify('HMAC', k, unb64u(sig), I.encode(body)))) return null;
    const p = I.parse(I.decode(unb64u(body)));
    if (p.g !== gameId || p.e !== envName || !(p.x > Date.now() / 1000)) return null;
    return p;
  } catch { return null; }
}
export async function signPlayToken(payload, key) {
  const body = b64u(I.encode(I.stringify(payload)));
  const k = await I.importKey('raw', I.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return body + '.' + b64u(await I.sign('HMAC', k, I.encode(body)));
}

// Calls to the platform use the fetch captured before the game's code ran. Tests hand in their own through env (the env
// object belongs to the runtime; game code never receives it, so it cannot set this).
const platformFetch = (env) => (typeof env.__testFetch === 'function' ? env.__testFetch : I.fetch);

function cookie(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

function gate(env) {
  const link = `${env.PLATFORM}/g/${encodeURIComponent(env.SLUG)}?play=1`;
  // Opened by itself (a bookmark, a shared link, a reload after the session ended): straight on to the game's page, which
  // starts it at once for whoever is signed in there (or as a guest). Inside the platform's player, the page around the
  // game is told instead, so it can start a fresh session for the right account.
  const go = `try{if(window.top===window)location.replace(${JSON.stringify(link).replace(/</g, '\\u003c')});else parent.postMessage({gcp:'session_ended',reason:'expired'},'*')}catch(e){}`;
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(env.TITLE)}</title>
<style>html,body{height:100%;margin:0;background:#0b0d0f;color:#e8e4da;font:15px/1.5 system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}
main{height:100%;display:grid;place-items:center;text-align:center;padding:24px}h1{font-size:28px;margin:0 0 8px}p{color:rgba(232,228,218,.64);margin:0 0 20px}
a{display:inline-block;background:#ffb347;color:#1b1203;font-weight:700;text-decoration:none;padding:11px 20px;border-radius:10px}</style>
<main><div><h1>${esc(env.TITLE)}</h1><p>This game is played from its page on the platform.</p><a href="${esc(link)}" target="_top">Play on the game page</a></div></main><script>${go}</script>`,
    { status: 401, headers: { 'content-type': TYPES.html, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

/**
 * Asks the platform whether a token this origin kept in a cookie is still bound to the player it names (the player may
 * have signed out or switched accounts since). Only a clear "no" refuses; if the platform cannot be reached the page is
 * served and every service call is checked there anyway.
 */
async function stillBound(env, token) {
  try {
    const r = await platformFetch(env)(`${env.PLATFORM}/api/rt/check`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ t: token }), signal: AbortSignal.timeout(2500) });
    return r.status !== 401 && r.status !== 402;
  } catch { return true; }
}

function tokenCookie(token, base, secure, maxAge) {
  // Over HTTPS the cookie is __Host- prefixed: games on one games domain are same-site with each other, and the prefix
  // stops one game from planting or shadowing another game's token cookie with Domain=<games domain>.
  return secure
    ? `__Host-gcp_t=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None; Partitioned`
    : `gcp_t=${token}; Path=${base || '/'}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

// Import maps are frozen with the platform origin of the day they were built. When the platform moved (its old
// workers.dev address is switched off), platform-hosted modules (/vendor/, /kits/) must follow it or the game never loads.
const PLATFORM_PATH = /^\/(vendor|kits)\//;
function rehome(imports, platform) {
  let p;
  try { p = new URL(platform); } catch { return imports; }
  const out = {};
  for (const [k, v] of Object.entries(imports || {})) {
    let u = null;
    try { u = typeof v === 'string' ? new URL(v) : null; } catch { /* relative or bare: leave it */ }
    const old = u && u.origin !== p.origin && PLATFORM_PATH.test(u.pathname)
      && (/^game-creator-platform\.[a-z0-9-]+\.workers\.dev$/i.test(u.hostname) || u.hostname === 'www.' + p.hostname);
    out[k] = old ? p.origin + u.pathname + u.search : v;
  }
  return out;
}

function inject(html, env, auth, token, base) {
  const manifest = JSON.parse(env.MANIFEST || '{}');
  if (manifest.imports) manifest.imports = rehome(manifest.imports, env.PLATFORM);
  const cfg = {
    api: env.PLATFORM, token, gameId: env.GAME_ID, slug: env.SLUG, title: env.TITLE, version: Number(env.VERSION), env: env.ENV, base,
    player: { id: auth.u, name: auth.n, guest: String(auth.u).startsWith('guest_') }, kind: auth.k, session: auth.s,
  };
  let head = `<script>window.__GCP_CONFIG=${JSON.stringify(cfg).replace(/</g, '\\u003c')}</script><script src="${env.PLATFORM}/sdk/gcp.js"></script>`;
  // One import map for the whole page. If the game wrote its own, leave it alone (browsers only honour the first).
  if (manifest.imports && Object.keys(manifest.imports).length && !/<script[^>]+type=["']importmap["']/i.test(html)) {
    head += `<script type="importmap">${JSON.stringify({ imports: manifest.imports }).replace(/</g, '\\u003c')}</script>`;
  }
  const m = html.match(/<head[^>]*>/i);
  if (m) return html.slice(0, m.index + m[0].length) + head + html.slice(m.index + m[0].length);
  const d = html.match(/<!doctype[^>]*>/i);
  return d ? html.slice(0, d.index + d[0].length) + head + html.slice(d.index + d[0].length) : head + html;
}

// A small client for the platform's game data service, handed to the game's server code. It authenticates with
// STORE_KEY, which is only good for this game's store in this environment (never PLAY_KEY, which signs play tokens), and
// it goes through the captured fetch, so server code that replaced globalThis.fetch never sees the key.
function storeClient(env) {
  const call = async (op, body) => {
    const r = await platformFetch(env)(`${env.PLATFORM}/api/rt/server-store`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-gcp-game': env.GAME_ID, 'x-gcp-env': env.ENV, 'x-gcp-key': env.STORE_KEY || env.PLAY_KEY },
      body: I.stringify({ op, ...body }),
    });
    if (!r.ok) throw new Error(`store ${op} failed: ${r.status}`);
    return r.json();
  };
  return {
    get: async (key, opts = {}) => (await call('get', { key, player: opts.player || '' })).value,
    set: async (key, value, opts = {}) => { await call('set', { key, value, player: opts.player || '' }); },
    delete: async (key, opts = {}) => { await call('delete', { key, player: opts.player || '' }); },
    list: async (prefix = '', opts = {}) => (await call('list', { prefix, player: opts.player || '' })).keys,
  };
}

/** True for any request path that names a file under the bundle's server/ folder. */
export function isServerPath(path) {
  const parts = [];
  for (const seg of String(path).split('/')) { if (!seg || seg === '.') continue; if (seg === '..') parts.pop(); else parts.push(seg); }
  return parts[0] === 'server';
}

export async function handle(request, env, ctx, base = '') {
  const url = new URL(request.url);
  let path;
  try { path = decodeURIComponent(url.pathname.slice(base.length)) || '/'; } catch { return new Response('Bad path', { status: 400 }); }
  if (path.includes('..') || path.includes('\0')) return new Response('Bad path', { status: 400 });
  if (path === '/__gcp/health') return Response.json({ ok: true, game: env.GAME_ID, version: Number(env.VERSION), env: env.ENV });

  const fromUrl = url.searchParams.get('gcp_t'), token = fromUrl || cookie(request, url.protocol === 'https:' ? '__Host-gcp_t' : 'gcp_t');
  // The SDK hands over a renewed token so a reload later in a long session still opens (POST, same origin, signed token only).
  if (path === '/__gcp/token' && request.method === 'POST') {
    const next = String(await request.text().catch(() => '')).trim(), ok = await verifyPlayToken(next, env.PLAY_KEY, env.GAME_ID, env.ENV);
    const cur = await verifyPlayToken(token, env.PLAY_KEY, env.GAME_ID, env.ENV);
    // only a token for the same player and session as the one this origin already holds: a page cannot swap players
    if (!ok || !cur || ok.u !== cur.u || ok.s !== cur.s) return Response.json({ ok: false }, { status: 400, headers: { 'cache-control': 'no-store' } });
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store', 'set-cookie': tokenCookie(next, base, url.protocol === 'https:', Math.max(60, Math.floor(ok.x - Date.now() / 1000))) } });
  }
  if (path.startsWith('/api/')) {
    if (!userServer || typeof userServer.fetch !== 'function') return Response.json({ error: 'This game has no server code.' }, { status: 404 });
    const auth = await verifyPlayToken(request.headers.get('x-gcp-token') || token, env.PLAY_KEY, env.GAME_ID, env.ENV);
    const safeEnv = { GAME: { id: env.GAME_ID, slug: env.SLUG, version: Number(env.VERSION), env: env.ENV }, player: auth ? { id: auth.u, name: auth.n, guest: String(auth.u).startsWith('guest_') } : null, store: storeClient(env) };
    try { return await userServer.fetch(request, safeEnv, ctx); }
    catch (e) {
      // Marked so the verifier reports it as the game's server code failing, not as a missing file. A preview also says where.
      const where = env.ENV === 'preview' ? String(e && e.stack || '').split('\n').slice(1, 4).map((l) => l.trim()).filter(Boolean) : [];
      return Response.json({ error: 'Game server error', message: String(e && e.message || e), ...(where.length ? { stack: where } : {}) }, { status: 500, headers: { 'x-gcp-server-error': '1' } });
    }
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  // The game's server code (server/ in the bundle) runs here and is never served as a file: it may hold logic or data the
  // creator does not want players to read. Checked on the storage key, so '//server/…' or '/./server/…' cannot get around it.
  if (isServerPath(path)) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  if (path.endsWith('/')) path += 'index.html';
  const ext = (path.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  const key = env.PREFIX + path.slice(1);

  if (ext === 'html') {
    const auth = await verifyPlayToken(token, env.PLAY_KEY, env.GAME_ID, env.ENV);
    if (!auth) return gate(env);
    // A token from the address bar was signed a moment ago for this launch. One kept in this origin's cookie (a reload, a
    // second page of the game) may be from before the player signed out or switched accounts: the platform decides.
    if (!fromUrl && auth.k !== 'verify' && !(await stillBound(env, token))) return gate(env);
    const obj = await env.FILES.get(key);
    if (!obj) return new Response('Not found', { status: 404 });
    const secure = url.protocol === 'https:';
    const headers = new Headers({
      'content-type': TYPES.html, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      // Its own agent cluster, so Chrome gives the game a process of its own even though the platform page that frames it
      // is on the same site (both on <account>.workers.dev): a game busy loading no longer freezes the page around it.
      'origin-agent-cluster': '?1',
      'content-security-policy': `frame-ancestors 'self' ${env.PLATFORM}`,
      // The token lives only as long as it is valid; the address-bar copy is removed by the SDK and never sent on.
      'set-cookie': tokenCookie(token, base, secure, Math.max(60, Math.floor(auth.x - Date.now() / 1000))),
      'referrer-policy': 'strict-origin-when-cross-origin',
    });
    return new Response(inject(await obj.text(), env, auth, token, base), { headers });
  }

  // Every other file needs the same play token as the page (the page's cookie comes along with its own requests), so a
  // paid game's code and assets cannot be fetched without a session, and a trial that ended stops loading them.
  if (!(await verifyPlayToken(token, env.PLAY_KEY, env.GAME_ID, env.ENV))) return new Response('A play session is needed.', { status: 401, headers: { 'cache-control': 'no-store' } });
  const obj = await env.FILES.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) return new Response('Not found: ' + path, { status: 404 });
  const headers = new Headers({
    'content-type': TYPES[ext] || obj.httpMetadata?.contentType || 'application/octet-stream', etag: obj.httpEtag,
    'cache-control': env.ENV === 'live' ? 'private, max-age=300' : 'no-cache', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes',
    vary: 'cookie',
  });
  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers });
  if (obj.range && request.headers.has('range')) {
    const off = obj.range.offset ?? 0, len = obj.range.length ?? obj.size - off;
    headers.set('content-range', `bytes ${off}-${off + len - 1}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
}

export default { fetch: (request, env, ctx) => handle(request, env, ctx, '') };

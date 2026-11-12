// Entry module of every game Worker. The platform uploads this file unchanged for each game and
// binds: FILES (R2 bucket), PREFIX (where this version's files live), PLATFORM (platform origin),
// GAME_ID, SLUG, TITLE, VERSION, ENV ("preview" | "live"), MANIFEST (JSON), PLAY_KEY (secret).
// It gates the game document behind a platform play token, injects the SDK, serves the bundle,
// and forwards /api/* to the game's optional server module.
import userServer from './server/index.js';

const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', map: 'application/json', txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', ico: 'image/x-icon',
  wasm: 'application/wasm', glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream', ktx2: 'image/ktx2', hdr: 'application/octet-stream',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wgsl: 'text/plain; charset=utf-8', glsl: 'text/plain; charset=utf-8',
};
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function verifyPlayToken(token, key, gameId, envName) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('HMAC', k, unb64u(sig), enc.encode(body)))) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    if (p.g !== gameId || p.e !== envName || !(p.x > Date.now() / 1000)) return null;
    return p;
  } catch { return null; }
}
export async function signPlayToken(payload, key) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return body + '.' + b64u(await crypto.subtle.sign('HMAC', k, enc.encode(body)));
}

function cookie(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

function gate(env) {
  const link = `${env.PLATFORM}/g/${encodeURIComponent(env.SLUG)}`;
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(env.TITLE)}</title>
<style>html,body{height:100%;margin:0;background:#0b0d0f;color:#e8e4da;font:15px/1.5 system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}
main{height:100%;display:grid;place-items:center;text-align:center;padding:24px}h1{font-size:28px;margin:0 0 8px}p{color:rgba(232,228,218,.64);margin:0 0 20px}
a{display:inline-block;background:#ffb347;color:#1b1203;font-weight:700;text-decoration:none;padding:11px 20px;border-radius:10px}</style>
<main><div><h1>${esc(env.TITLE)}</h1><p>This game is played from its page on the platform. Sign in there to start a session.</p><a href="${esc(link)}" target="_top">Open the game page</a></div></main>`,
    { status: 401, headers: { 'content-type': TYPES.html, 'cache-control': 'no-store' } });
}

function inject(html, env, auth, token, base) {
  const manifest = JSON.parse(env.MANIFEST || '{}');
  const cfg = {
    api: env.PLATFORM, token, gameId: env.GAME_ID, slug: env.SLUG, title: env.TITLE, version: Number(env.VERSION), env: env.ENV, base,
    player: { id: auth.u, name: auth.n }, kind: auth.k, session: auth.s,
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

// A small client for the platform's game data service, handed to the game's server code.
function storeClient(env) {
  const call = async (op, body) => {
    const r = await fetch(`${env.PLATFORM}/api/rt/server-store`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-gcp-game': env.GAME_ID, 'x-gcp-env': env.ENV, 'x-gcp-key': env.PLAY_KEY },
      body: JSON.stringify({ op, ...body }),
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

export async function handle(request, env, ctx, base = '') {
  const url = new URL(request.url);
  let path;
  try { path = decodeURIComponent(url.pathname.slice(base.length)) || '/'; } catch { return new Response('Bad path', { status: 400 }); }
  if (path.includes('..') || path.includes('\0')) return new Response('Bad path', { status: 400 });
  if (path === '/__gcp/health') return Response.json({ ok: true, game: env.GAME_ID, version: Number(env.VERSION), env: env.ENV });

  const token = url.searchParams.get('gcp_t') || cookie(request, 'gcp_t');
  if (path.startsWith('/api/')) {
    if (!userServer || typeof userServer.fetch !== 'function') return Response.json({ error: 'This game has no server code.' }, { status: 404 });
    const auth = await verifyPlayToken(request.headers.get('x-gcp-token') || token, env.PLAY_KEY, env.GAME_ID, env.ENV);
    const safeEnv = { GAME: { id: env.GAME_ID, slug: env.SLUG, version: Number(env.VERSION), env: env.ENV }, player: auth ? { id: auth.u, name: auth.n } : null, store: storeClient(env) };
    try { return await userServer.fetch(request, safeEnv, ctx); }
    catch (e) { return Response.json({ error: 'Game server error', message: String(e && e.message || e) }, { status: 500 }); }
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  if (path.endsWith('/')) path += 'index.html';
  const ext = (path.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  const key = env.PREFIX + path.slice(1);

  if (ext === 'html') {
    const auth = await verifyPlayToken(token, env.PLAY_KEY, env.GAME_ID, env.ENV);
    if (!auth) return gate(env);
    const obj = await env.FILES.get(key);
    if (!obj) return new Response('Not found', { status: 404 });
    const secure = url.protocol === 'https:';
    const headers = new Headers({
      'content-type': TYPES.html, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': `frame-ancestors 'self' ${env.PLATFORM}`,
      'set-cookie': `gcp_t=${token}; Path=${base || '/'}; Max-Age=21600; HttpOnly; ${secure ? 'Secure; SameSite=None; Partitioned' : 'SameSite=Lax'}`,
    });
    return new Response(inject(await obj.text(), env, auth, token, base), { headers });
  }

  const obj = await env.FILES.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) return new Response('Not found: ' + path, { status: 404 });
  const headers = new Headers({
    'content-type': TYPES[ext] || obj.httpMetadata?.contentType || 'application/octet-stream', etag: obj.httpEtag,
    'cache-control': env.ENV === 'live' ? 'public, max-age=300' : 'no-cache', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
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

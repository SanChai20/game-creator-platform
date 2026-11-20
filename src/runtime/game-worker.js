// Entry module of every game Worker. The platform uploads this file unchanged for each game and
// binds: PREFIX (where this version's files live), PLATFORM (platform origin), GAME_ID, SLUG, TITLE, VERSION,
// ENV ("preview" | "live"), MANIFEST (JSON), PLAY_KEY (secret), STORE_KEY (secret), and MATCH (the GameMatch Durable
// Object namespace of this script).
// It gates the game document behind a platform play token, injects the SDK, serves the bundle,
// forwards /api/* to the game's optional server module, and runs server-run matches (server/match.js) in GameMatch.
// The same script runs as a standard Worker or as a user Worker in a Workers for Platforms dispatch namespace (src/hosting.ts):
// it reads nothing host-specific (no request.cf, no Cache API), and it is deployed with disallow_importable_env so the
// game's server modules only ever see the narrow env handed to them below, never these bindings.
//
// The game's server modules share this isolate, so nothing bound here may reach beyond this one game: a game Worker
// has no bucket binding (the bundle is read through the platform's /api/rt/file route with this game's store key, which
// only opens this game's own versions), and both keys are derived for this game alone. If the game's code ever got hold
// of this env, it would get nothing its creator does not already control. Only the local driver and tests hand in a
// FILES binding of their own.
// gcp-intrinsics.js must stay the FIRST import: modules are evaluated in import order, so it captures the built-ins
// before the game's server modules (imported next) can replace them.
import { I } from './gcp-intrinsics.js';
import { MatchCore, normalizeDef } from './match-core.js';
import userServer from './server/index.js';
import userMatch from './server/match.js';

const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', map: 'application/json', txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', ico: 'image/x-icon',
  wasm: 'application/wasm', glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream', ktx2: 'image/ktx2', hdr: 'application/octet-stream',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wgsl: 'text/plain; charset=utf-8', glsl: 'text/plain; charset=utf-8',
};
// Added to the end of the preview's worker scripts (a request the browser marks Sec-Fetch-Dest: worker), so the creator's
// feedback pictures can show a canvas the game draws in a Web Worker: the page cannot read such a canvas, only the worker
// can. The helper notes the OffscreenCanvas objects the page hands over, says hello to the SDK (which hides that from the
// game, web/public/sdk/gcp.js), gets a private channel back, and on a request answers with a copy of each canvas, taken
// right after the worker's next draw call on it (a WebGL canvas holds its picture only until the frame is shown). It sees
// the game's messages before the game does but never changes them, and hides only its own channel's hello. Only on the
// preview, where pictures are taken; live games are served unchanged. At the end of the file, so line numbers in the
// game's errors stay as they are; a listener registered in the capturing phase still runs before the game's own.
export const WORKER_HELPER = `
;(function () {
  try {
    var G = self;
    if (G.__gcpw || typeof G.postMessage !== 'function' || typeof OffscreenCanvas !== 'function' || typeof WeakMap !== 'function') return;
    G.__gcpw = 1;
    var offs = [], ctxs = new WeakMap(), port = null, want = null;
    var gc = OffscreenCanvas.prototype.getContext;
    var calls = 0, hook = function () { var c = gc.apply(this, arguments); calls++; try { if (c && !ctxs.has(this)) ctxs.set(this, c); } catch (e) {} return c; };
    OffscreenCanvas.prototype.getContext = hook;
    function walk(v, out, b, d) {
      if (!v || typeof v !== 'object' || d > 4 || ++b.n > 300 || out.length > 8) return;
      if (v instanceof OffscreenCanvas) { out.push(v); return; }
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || (typeof MessagePort === 'function' && v instanceof MessagePort) || (typeof ImageBitmap === 'function' && v instanceof ImageBitmap) || (typeof Blob === 'function' && v instanceof Blob) || v instanceof Date || v instanceof RegExp || (typeof Map === 'function' && v instanceof Map) || (typeof Set === 'function' && v instanceof Set)) return;
      if (Array.isArray(v)) { for (var i = 0; i < v.length && i < 64; i++) walk(v[i], out, b, d + 1); return; }
      var ks = Object.keys(v); for (var j = 0; j < ks.length && j < 64; j++) walk(v[ks[j]], out, b, d + 1);
    }
    var DRAW = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'clear'];
    var GLS = [G.WebGLRenderingContext, G.WebGL2RenderingContext].filter(Boolean);
    // a copy of the canvas: drawn into a 2D canvas, or, where the browser cannot draw a WebGL canvas that way, read back
    // from its frame (the frame is still there: this runs right after the game's draw call)
    function snap(c, max) {
      var w = c.width, h = c.height; if (!w || !h) return null;
      var k = Math.min(1, max / Math.max(w, h)), o = new OffscreenCanvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))), og = o.getContext('2d'), err = null;
      try { og.drawImage(c, 0, 0, o.width, o.height); if (!blank(og, o)) return o.transferToImageBitmap(); } catch (e) { err = e; }
      var g = ctxs.get(c), full = g && typeof g.readPixels === 'function' ? pixels(g, w, h) : null;
      if (!full) { if (err) throw err; return o.transferToImageBitmap(); }
      og.clearRect(0, 0, o.width, o.height); og.drawImage(full, 0, 0, o.width, o.height); return o.transferToImageBitmap();
    }
    // nothing at all drawn (every pixel clear): a browser that copies a WebGL canvas as empty
    function blank(og, o) { var d = og.getImageData(0, 0, o.width, o.height).data, step = Math.max(4, (d.length / 4096 | 0) * 4); for (var i = 3; i < d.length; i += step) if (d[i]) return false; return true; }
    function pixels(g, w, h) {
      var fb = g.getParameter(g.FRAMEBUFFER_BINDING), px = new Uint8Array(w * h * 4), row = w * 4;
      if (fb) g.bindFramebuffer(g.FRAMEBUFFER, null);
      try { g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px); } finally { if (fb) g.bindFramebuffer(g.FRAMEBUFFER, fb); }
      var full = new OffscreenCanvas(w, h), fg = full.getContext('2d'), id = fg.createImageData(w, h);
      for (var y = 0; y < h; y++) id.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
      fg.putImageData(id, 0, 0); return full;
    }
    function reply(r) {
      if (want !== r) return; want = null; clearTimeout(r.t);
      for (var s = 0; s < r.saved.length; s++) r.saved[s][0][r.saved[s][1]] = r.saved[s][2];
      var frames = [], give = [], why = null;
      for (var i = 0; i < offs.length; i++) { var b = null; try { if (ctxs.has(offs[i])) b = snap(offs[i], r.max); else why = why || 'no context (hooked ' + (OffscreenCanvas.prototype.getContext === hook) + ', calls ' + calls + ', canvases ' + offs.length + ')'; } catch (e) { why = why || String(e && e.message || e).slice(0, 160); } frames.push(b); if (b) give.push(b); }
      if (!offs.length) why = 'no canvas';
      try { port.postMessage({ cap: r.id, frames: frames, why: why }, give); } catch (e) { try { port.postMessage({ cap: r.id, frames: [], why: String(e && e.message || e).slice(0, 160) }); } catch (x) {} }
    }
    function needsDraw(c) { var g = ctxs.get(c), a = null; if (!g) return false; if (typeof G.GPUCanvasContext === 'function' && g instanceof G.GPUCanvasContext) return true; if (typeof g.getContextAttributes !== 'function') return false; try { a = g.getContextAttributes(); } catch (e) {} return !!a && !a.preserveDrawingBuffer; }
    function ask(e) {
      var d = e.data || {}; if (!d.cap) return;
      if (want) reply(want);
      var r = want = { id: d.cap, max: Math.max(64, Math.min(4096, +d.max || 1600)), saved: [], queued: false, t: 0 };
      if (!offs.some(needsDraw)) { reply(r); return; }
      GLS.forEach(function (GL) {
        DRAW.forEach(function (n) {
          var f = GL.prototype[n]; if (typeof f !== 'function') return;
          r.saved.push([GL.prototype, n, f]);
          GL.prototype[n] = function () {
            var out = f.apply(this, arguments);
            try { if (want === r && !r.queued && offs.indexOf(this.canvas) >= 0 && !this.getParameter(this.FRAMEBUFFER_BINDING)) { r.queued = true; Promise.resolve().then(function () { reply(r); }); } } catch (x) {}
            return out;
          };
        });
      });
      // WebGPU: the frame is in the canvas from the queue submit that draws it until it is shown
      if (G.GPUQueue && typeof G.GPUQueue.prototype.submit === 'function') {
        var sub = G.GPUQueue.prototype.submit; r.saved.push([G.GPUQueue.prototype, 'submit', sub]);
        G.GPUQueue.prototype.submit = function () { var out = sub.apply(this, arguments); if (want === r && !r.queued) { r.queued = true; Promise.resolve().then(function () { reply(r); }); } return out; };
      }
      r.t = setTimeout(function () { reply(r); }, 800);
    }
    G.addEventListener('message', function (e) {
      var d = e.data;
      if (d && d.__gcpw === 2 && d.port) { e.stopImmediatePropagation(); if (!port) { port = d.port; port.onmessage = ask; } return; }
      try { var l = []; walk(d, l, { n: 0 }, 0); for (var i = 0; i < l.length; i++) if (offs.indexOf(l[i]) < 0) offs.push(l[i]); } catch (x) {}
    }, true);
    G.postMessage({ __gcpw: 1 });
  } catch (e) {}
})();
`;

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
// object belongs to the runtime; game code never receives it, so it cannot set this). Only an own property counts: a
// getter the game's code put on Object.prototype must never run with `this` set to the runtime's env.
const platformFetch = (env) => (I.hasOwn(env, '__testFetch') && typeof env.__testFetch === 'function' ? env.__testFetch : I.fetch);

// The request headers a file read passes on, so ranges and revalidation work the same through the platform.
const READ_HEADERS = ['range', 'if-none-match', 'if-match', 'if-modified-since', 'if-unmodified-since'];
/**
 * Reads one file of this version's bundle (path relative to the bundle root). Returns an object shaped like an R2
 * object (body, size, httpEtag, httpMetadata, range, text()), an object without a body for a conditional request that
 * matched (304), or null when there is no such file. A FILES binding is only ever present in the local driver and tests;
 * a deployed game Worker reads through the platform, which only opens this game's own files.
 */
async function readFile(env, path, request) {
  if (I.hasOwn(env, 'FILES') && env.FILES) {
    return request ? env.FILES.get(env.PREFIX + path, { range: request.headers, onlyIf: request.headers }) : env.FILES.get(env.PREFIX + path);
  }
  const headers = { 'x-gcp-game': env.GAME_ID, 'x-gcp-env': env.ENV, 'x-gcp-key': env.STORE_KEY || '' };
  if (request) for (const h of READ_HEADERS) { const v = request.headers.get(h); if (v) headers[h] = v; }
  const enc = path.split('/').map((s) => encodeURIComponent(s)).join('/');
  const r = await platformFetch(env)(`${env.PLATFORM}/api/rt/file/${encodeURIComponent(env.VERSION)}/${enc}`, { headers });
  if (r.status === 404) return null;
  const etag = r.headers.get('etag') || '', size = Number(r.headers.get('x-gcp-size')) || 0;
  const base = { size, httpEtag: etag, httpMetadata: { contentType: r.headers.get('x-gcp-type') || undefined } };
  if (r.status === 304 || r.status === 412) return base;
  if (!r.ok) throw new Error(`file read failed: ${r.status}`);
  const cr = /^bytes (\d+)-(\d+)\//.exec(r.headers.get('content-range') || '');
  return { ...base, body: r.body, range: cr ? { offset: Number(cr[1]), length: Number(cr[2]) - Number(cr[1]) + 1 } : undefined, text: () => r.text() };
}

function cookie(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

function gate(env) {
  const link = `${env.PLATFORM}/g/${encodeURIComponent(env.SLUG)}?play=1`;
  // Opened by itself (a bookmark, a shared link, a reload after the session ended): straight on to the game's page, which
  // starts it at once for whoever is signed in there (or asks them to sign in first). Inside the platform's player, the page around the
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
  env = I.own(env);
  const url = new URL(request.url);
  let path;
  try { path = decodeURIComponent(url.pathname.slice(base.length)) || '/'; } catch { return new Response('Bad path', { status: 400 }); }
  if (path.includes('..') || path.includes('\0')) return new Response('Bad path', { status: 400 });
  if (path === '/__gcp/health') return Response.json({ ok: true, game: env.GAME_ID, version: Number(env.VERSION), env: env.ENV });

  // The play token also travels in the path: /~t/<token>/index.html, and so in every relative address the page, its
  // scripts, workers and stylesheets resolve from there. The game is framed by the platform's page on another site, and
  // browsers that refuse third-party cookies (Safari on iPhone and iPad, some versions even with Partitioned) never send
  // the cookie below, so without this every file after the page itself was refused and the game never started.
  let pathToken = null; const root = base;
  const tm = path.match(/^\/~t\/([A-Za-z0-9_.-]{16,4096})(\/.*)?$/);
  if (tm) { pathToken = tm[1]; path = tm[2] || '/'; base = base + '/~t/' + pathToken; }
  const fromUrl = url.searchParams.get('gcp_t'), fromCookie = cookie(request, url.protocol === 'https:' ? '__Host-gcp_t' : 'gcp_t');
  // A path token stops working when it expires; a renewed one the SDK handed over may be in the cookie (where cookies work).
  const token = fromUrl || (pathToken && (fromCookie === pathToken || !fromCookie || await verifyPlayToken(pathToken, env.PLAY_KEY, env.GAME_ID, env.ENV)) ? pathToken : fromCookie || pathToken);
  // The SDK hands over a renewed token so a reload later in a long session still opens (POST, same origin, signed token only).
  if (path === '/__gcp/token' && request.method === 'POST') {
    const next = String(await request.text().catch(() => '')).trim(), ok = await verifyPlayToken(next, env.PLAY_KEY, env.GAME_ID, env.ENV);
    const cur = await verifyPlayToken(token, env.PLAY_KEY, env.GAME_ID, env.ENV);
    // only a token for the same player and session as the one this origin already holds: a page cannot swap players
    if (!ok || !cur || ok.u !== cur.u || ok.s !== cur.s) return Response.json({ ok: false }, { status: 400, headers: { 'cache-control': 'no-store' } });
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store', 'set-cookie': tokenCookie(next, root, url.protocol === 'https:', Math.max(60, Math.floor(ok.x - Date.now() / 1000))) } });
  }
  if (path === '/__gcp/match') return matchRoute(request, env, url);
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
  const asked = path;
  if (path.endsWith('/')) path += 'index.html';
  const ext = (path.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  const rel = path.slice(1);

  if (ext === 'html') {
    const auth = await verifyPlayToken(token, env.PLAY_KEY, env.GAME_ID, env.ENV);
    if (!auth) return gate(env);
    // A token from the address bar was signed a moment ago for this launch. One kept in this origin's cookie (a reload, a
    // second page of the game) may be from before the player signed out or switched accounts: the platform decides.
    // A guest's token is checked every time, even fresh from the address bar: guest play exists only while the platform
    // allows it, and a link handed out before "Require login to play" was switched on must not open the game.
    const guest = String(auth.u).startsWith('guest_');
    if ((guest || !fromUrl) && auth.k !== 'verify' && !(await stillBound(env, token))) return gate(env);
    const secure = url.protocol === 'https:';
    // A launch (?gcp_t=) moves to the address that carries the token, so the page's own files load without the cookie.
    // The cookie is still set for browsers that keep it (a renewed token reaches later loads that way).
    if (fromUrl) {
      const q = new URLSearchParams(url.search); q.delete('gcp_t');
      const to = `${root}/~t/${fromUrl}${encodeURI(asked)}${q.toString() ? '?' + q : ''}`;
      return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': tokenCookie(fromUrl, root, secure, Math.max(60, Math.floor(auth.x - Date.now() / 1000))) } });
    }
    const obj = await readFile(env, rel);
    if (!obj || typeof obj.text !== 'function') return new Response('Not found', { status: 404 });
    const headers = new Headers({
      'content-type': TYPES.html, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      // Its own agent cluster, so Chrome gives the game a process of its own even though the platform page that frames it
      // is on the same site (both on <account>.workers.dev): a game busy loading no longer freezes the page around it.
      'origin-agent-cluster': '?1',
      'content-security-policy': `frame-ancestors 'self' ${env.PLATFORM}`,
      // The token lives only as long as it is valid; the address-bar copy is removed by the SDK and never sent on.
      'set-cookie': tokenCookie(token, root, secure, Math.max(60, Math.floor(auth.x - Date.now() / 1000))),
      'referrer-policy': 'strict-origin-when-cross-origin',
    });
    return new Response(inject(await obj.text(), env, auth, token, base), { headers });
  }

  // Every other file needs the same play token as the page (the page's cookie comes along with its own requests), so a
  // paid game's code and assets cannot be fetched without a session, and a trial that ended stops loading them.
  if (!(await verifyPlayToken(token, env.PLAY_KEY, env.GAME_ID, env.ENV))) return new Response('A play session is needed.', { status: 401, headers: { 'cache-control': 'no-store' } });
  // a worker script of the preview: whole, with the feedback-picture helper at its end (see WORKER_HELPER). The browser
  // marks a worker's script Sec-Fetch-Dest: worker; the SDK also adds ?__gcpw=1 to the scripts the page starts workers
  // with, for browsers that leave the header out
  const asWorker = request.headers.get('sec-fetch-dest') === 'worker' || url.searchParams.get('__gcpw') === '1';
  if (env.ENV === 'preview' && (ext === 'js' || ext === 'mjs') && asWorker && request.method !== 'HEAD') {
    const whole = await readFile(env, rel);
    if (!whole || typeof whole.text !== 'function') return new Response('Not found: ' + path, { status: 404 });
    return new Response((await whole.text()) + WORKER_HELPER, { headers: { 'content-type': TYPES[ext], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'cookie, sec-fetch-dest' } });
  }
  const obj = await readFile(env, rel, request);
  if (!obj) return new Response('Not found: ' + path, { status: 404 });
  const headers = new Headers({
    'content-type': TYPES[ext] || obj.httpMetadata?.contentType || 'application/octet-stream', etag: obj.httpEtag,
    'cache-control': env.ENV === 'live' ? 'private, max-age=300' : 'no-cache', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes',
    vary: env.ENV === 'preview' && (ext === 'js' || ext === 'mjs') ? 'cookie, sec-fetch-dest' : 'cookie',
  });
  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers });
  if (obj.range && request.headers.has('range')) {
    const off = obj.range.offset ?? 0, len = obj.range.length ?? obj.size - off;
    headers.set('content-range', `bytes ${off}-${off + len - 1}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
}

// ----- server-run matches -------------------------------------------------------------------------------------------
// The platform's matchmaker (src/matchmaker.ts) groups players and signs one ticket per player with a key derived from
// this game's play key. A ticket names the match, the player, the roster and the region; it cannot be used as a play
// token (different key) and a play token cannot be used as a ticket. Each match is one GameMatch Durable Object, named
// by the match id and created in the players' region, running the creator's server/match.js through MatchCore.
const REGIONS = new Set(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me']);
const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
/** The key match tickets are signed with: HMAC(play key, "match-ticket"), the same derivation as the platform's. */
export async function matchKey(playKey) {
  const k = await I.importKey('raw', I.encode(playKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hexOf(await I.sign('HMAC', k, I.encode('match-ticket')));
}
export async function verifyTicket(ticket, env) {
  const p = await verifyPlayToken(ticket, await matchKey(env.PLAY_KEY), env.GAME_ID, env.ENV);
  if (!p || p.typ !== 'match' || typeof p.m !== 'string' || !/^[a-f0-9]{16,40}$/.test(p.m) || !Array.isArray(p.r) || !p.r.some((r) => r && r.id === p.u)) return null;
  return p;
}

async function matchRoute(request, env, url) {
  const json = (status, error, code) => Response.json({ error, code }, { status, headers: { 'cache-control': 'no-store' } });
  if (request.headers.get('upgrade') !== 'websocket') return json(426, 'Expected a WebSocket.', 'upgrade_required');
  if (!userMatch) return json(404, 'This game has no server/match.js.', 'no_match_code');
  if (!env.MATCH) return json(501, 'Server-run matches are not available for this deployment. Deploy the game again (deploy_preview) on a platform with matches enabled.', 'matches_unavailable');
  const p = await verifyTicket(url.searchParams.get('t'), env);
  if (!p) return json(401, 'The match ticket is not valid or has expired. Find a match again.', 'bad_ticket');
  const hint = REGIONS.has(p.h) ? { locationHint: p.h } : undefined;
  return env.MATCH.get(env.MATCH.idFromName(p.m), hint).fetch(request);
}

/** One server-run match. Plain Durable Object class (no imports), so the runtime stays loadable in Node for tests. */
export class GameMatch {
  constructor(state, env) {
    this.state = state; this.env = I.own(env); this.core = null; this.sockets = new Map(); this.timer = 0; this.checkTimer = 0;
    this.banned = new Set(); this.ended = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = await verifyTicket(url.searchParams.get('t'), this.env);
    if (!p) return new Response('Bad ticket', { status: 401 });
    if (this.ended || (await this.state.storage.get('ended'))) return this.refuse(4004, 'This match is over.');
    if (this.banned.has(p.u)) return this.refuse(4001, 'Your play session ended.');
    if (!this.core) {
      let def;
      try { def = normalizeDef(userMatch); } catch (e) { return this.refuse(4500, String(e.message || e)); }
      this.core = new MatchCore(def, { id: p.m, roster: p.r, seed: p.seed, queue: p.q, options: p.o, minPlayers: p.min }, {
        now: () => Date.now(),
        send: (id, text) => { const ws = this.sockets.get(id); if (ws) try { ws.send(text); } catch { /* closing */ } },
        close: (id, code, reason) => { const ws = this.sockets.get(id); if (ws) try { ws.close(code, reason); } catch { /* closed */ } },
        report: (result) => this.report(result),
        log: (msg) => console.log(JSON.stringify({ match: p.m, log: msg })),
      });
      this.sessions = new Map();
    } else if (this.core.id !== p.m) return this.refuse(4004, 'This match is over.');
    const pair = new WebSocketPair(), ws = pair[1];
    ws.accept();
    const old = this.sockets.get(p.u);
    this.sockets.set(p.u, ws);
    if (old) try { old.close(4002, 'Opened in another tab'); } catch { /* closed */ }
    this.sessions.set(p.u, { u: p.u, s: p.s, k: p.k, px: p.px, tr: p.tr });
    if (!this.core.connect(p.u)) { this.sockets.delete(p.u); try { ws.close(4003, 'You are not in this match.'); } catch { /* closed */ } return new Response(null, { status: 101, webSocket: pair[0] }); }
    ws.addEventListener('message', (ev) => { if (this.sockets.get(p.u) === ws && this.core) this.core.message(p.u, typeof ev.data === 'string' ? ev.data : null); });
    const gone = () => { if (this.sockets.get(p.u) === ws) { this.sockets.delete(p.u); if (this.core) this.core.disconnect(p.u); } };
    ws.addEventListener('close', gone); ws.addEventListener('error', gone);
    this.loop();
    if (!this.checkTimer) this.checkTimer = setInterval(() => this.checkSessions(), 30_000);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  refuse(code, reason) {
    const pair = new WebSocketPair();
    pair[1].accept(); pair[1].close(code, reason.slice(0, 120));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Runs the match's steps on a timer. Called again on each connection, so a match that just started (the last player
      arrived) ticks at once instead of after the slower waiting-room timer. */
  loop() {
    if (!this.core) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
    const run = () => {
      this.timer = 0;
      if (!this.core) return;
      const wait = this.core.step();
      if (wait === Infinity) return this.wrapUp();
      this.timer = setTimeout(run, Math.max(1, Math.min(wait, 250)));
    };
    run();
  }

  wrapUp() {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.checkTimer); this.checkTimer = 0;
    this.state.storage.put('ended', Date.now()).catch(() => {});
    // the end message went out with the last tick; close whatever is still open a moment later
    setTimeout(() => { for (const ws of this.sockets.values()) try { ws.close(1000, 'Match over'); } catch { /* closed */ } this.sockets.clear(); this.core = null; }, 2000);
  }

  /** Players whose play session ended since they joined (signed out, suspended, trial over) are disconnected for good. */
  async checkSessions() {
    if (!this.core || !this.sessions.size) return;
    try {
      const r = await platformFetch(this.env)(`${this.env.PLATFORM}/api/rt/match-check`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-gcp-game': this.env.GAME_ID, 'x-gcp-env': this.env.ENV, 'x-gcp-key': this.env.STORE_KEY || '' },
        body: I.stringify({ match: this.core.id, players: [...this.sessions.values()] }), signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return;
      const j = await r.json();
      for (const u of Array.isArray(j.ended) ? j.ended : []) {
        this.banned.add(u);
        const ws = this.sockets.get(u);
        if (ws) { try { ws.send(I.stringify({ t: 'error', code: 'session_ended', message: 'Your play session ended.' })); ws.close(4001, 'Session ended'); } catch { /* closed */ } }
        this.sockets.delete(u); if (this.core) this.core.disconnect(u);
      }
    } catch { /* the platform is unreachable: try again next time */ }
  }

  async report(result) {
    try {
      await platformFetch(this.env)(`${this.env.PLATFORM}/api/rt/match-result`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-gcp-game': this.env.GAME_ID, 'x-gcp-env': this.env.ENV, 'x-gcp-key': this.env.STORE_KEY || '' },
        body: I.stringify({ match: this.core ? this.core.id : '', result }), signal: AbortSignal.timeout(10_000),
      });
    } catch (e) { console.log(JSON.stringify({ match: this.core && this.core.id, log: 'result report failed: ' + (e && e.message) })); }
  }
}

export default { fetch: (request, env, ctx) => handle(request, env, ctx, '') };

// A local copy of the publish pipeline, for measuring the automated gates against a labelled corpus.
// Every gate runs the platform's own code: the static check (checkProject in src/projects.ts, bundled with esbuild),
// the game Worker (src/runtime/game-worker.js, which injects the real SDK), the browser check (src/verify-core.js in
// Playwright with a software GPU, as in Cloudflare Browser Rendering), and the originality, "is it a game" and
// content checks (src/originality.js, src/content-check.js). Rooms go through a small relay with the same protocol as
// src/room.ts. Workers AI is called over the REST API when CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ACCOUNT_API_TOKEN are set.
import http from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PUB = join(ROOT, 'web/public');

// ---------------------------------------------------------------------------------------------- platform modules
const esbuild = require('esbuild');
const out = join(tmpdir(), 'gcp-moderation');
mkdirSync(out, { recursive: true });
await esbuild.build({ entryPoints: [join(ROOT, 'src/projects.ts')], bundle: true, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], outfile: join(out, 'projects.mjs'), logLevel: 'warning' });
const projects = await import(pathToFileURL(join(out, 'projects.mjs')).href + '?' + Date.now());
const { handle, signPlayToken } = await import(pathToFileURL(join(ROOT, 'src/runtime/game-worker.js')).href);
const { verifyPage } = await import(pathToFileURL(join(ROOT, 'src/verify-core.js')).href);
const O = await import(pathToFileURL(join(ROOT, 'src/originality.js')).href);
const { analyzeBundle, isVendor, READABLE } = await import(pathToFileURL(join(ROOT, 'src/implementation.js')).href);
const { decodePng } = await import(pathToFileURL(join(ROOT, 'src/craft-review.js')).href);
const C = existsSync(join(ROOT, 'src/content-check.js')) ? await import(pathToFileURL(join(ROOT, 'src/content-check.js')).href) : null;
export { O, C };

const baselineBuf = readFileSync(join(PUB, 'kits/baseline.bin'));
const BASELINE = new Set(new Int32Array(baselineBuf.buffer, baselineBuf.byteOffset, baselineBuf.byteLength / 4));
const ASSET = /\.(png|jpe?g|webp|gif|avif|ktx2|basis|mp3|ogg|wav|m4a|aac|opus|flac|glb|gltf|bin|obj|fbx|woff2?|ttf|otf|wasm|data|pck)$/i;
const CODE = /\.(m?js|cjs|html?)$/i;

// ---------------------------------------------------------------------------------------------- corpus
export function walk(dir, base = dir, outList = []) {
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, base, outList);
    else if (f !== 'case.json') outList.push(p.slice(base.length + 1).split('\\').join('/'));
  }
  return outList;
}
export function loadCase(dir) {
  const meta = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'));
  const files = walk(dir).map((path) => { const bytes = readFileSync(join(dir, path)); return { path, bytes, size: bytes.length, sha: createHash('sha256').update(bytes).digest('hex').slice(0, 32) }; });
  return { id: dir.split('/').pop(), dir, ...meta, owner: meta.owner || dir.split('/').pop(), files };
}

// ---------------------------------------------------------------------------------------------- static check
const fakeDb = (files) => ({
  prepare(sql) {
    const st = { bind() { return st; }, async all() { return { results: /FROM files/.test(sql) ? files.map((f) => ({ path: f.path, size: f.size, sha: f.sha, ctype: '', updated_at: 0 })) : [] }; }, async first() { return null; }, async run() { return { meta: {} }; } };
    return st;
  },
  async batch() { return []; },
});
const r2 = (bytes) => ({ size: bytes.length, httpEtag: '"x"', httpMetadata: {}, body: new Blob([bytes]).stream(), text: async () => Buffer.from(bytes).toString('utf8'), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });

export async function staticCheck(c, origin) {
  const byKey = new Map(c.files.map((f) => [`ws/${c.id}/${f.path}`, f.bytes]));
  const env = { DB: fakeDb(c.files), FILES: { get: async (k) => (byKey.has(k) ? r2(byKey.get(k)) : null) }, ASSETS: { fetch: async () => new Response('', { status: 404 }) } };
  // putFile refuses native programs and archives before they are stored
  for (const f of c.files) { const what = (await import(pathToFileURL(join(ROOT, 'src/web-only.js')).href)).nonWebContent(new Uint8Array(f.bytes), f.path); if (what) return { ok: false, errors: [{ message: `${f.path} is ${what}` }], warnings: [], manifest: {} }; }
  return projects.checkProject(env, { id: c.id }, origin);
}

// ---------------------------------------------------------------------------------------------- local platform + game Workers
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.bin': 'application/octet-stream', '.wasm': 'application/wasm', '.html': 'text/html' };
export async function startPlatform() {
  const games = new Map();   // id -> { env }
  const rooms = new Map();
  const { WebSocketServer } = require('ws');
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (u.pathname.startsWith('/api/rt/')) {
        let body = ''; for await (const ch of req) body += ch;
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify({ ok: true, value: null, rows: [], stats: {}, keys: [] }));
      }
      const m = u.pathname.match(/^\/c\/([^/]+)(\/.*)?$/);
      if (m && games.has(m[1])) {
        const g = games.get(m[1]);
        const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        const r = await handle(new Request('http://127.0.0.1:' + port + req.url, { method: req.method, headers }), g.env, {}, '/c/' + m[1]);
        const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
        res.writeHead(r.status, h); return res.end(Buffer.from(await r.arrayBuffer()));
      }
      const file = join(PUB, decodeURIComponent(u.pathname));
      if (file.startsWith(PUB) && existsSync(file) && statSync(file).isFile()) { res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'access-control-allow-origin': '*' }); return res.end(readFileSync(file)); }
      res.writeHead(404); res.end('not found');
    } catch (e) { res.writeHead(500); res.end(String(e && e.stack || e)); }
  });
  // the room relay (same messages as src/room.ts)
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, sock, head) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/api/rt/room') return sock.destroy();
    wss.handleUpgrade(req, sock, head, (ws) => {
      const code = u.searchParams.get('room') || 'lobby', list = rooms.get(code) || []; rooms.set(code, list);
      let tok = {}; try { tok = JSON.parse(Buffer.from(String(u.searchParams.get('t')).split('.')[0], 'base64url').toString()); } catch { /* none */ }
      let id = tok.u || 'p', i = 2; while (list.some((p) => p.id === id)) id = `${tok.u || 'p'}#${i++}`;
      const me = { ws, id, name: tok.n || 'Player' }, send = (w, msg) => { try { w.send(JSON.stringify(msg)); } catch { /* closed */ } };
      for (const p of list) send(p.ws, { t: 'join', peer: { id, name: me.name } });
      send(ws, { t: 'welcome', id, host: list[0]?.id ?? id, peers: list.map((p) => ({ id: p.id, name: p.name })), state: list.state ?? null });
      list.push(me);
      ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.t === 'msg') { const to = msg.to === 'host' ? list[0]?.id : msg.to; for (const p of list) if (p !== me && (!to || p.id === to)) send(p.ws, { t: 'msg', from: id, d: msg.d, at: msg.at }); }
        else if (msg.t === 'state') { if (list[0] !== me) return; list.state = msg.d; for (const p of list) if (p !== me) send(p.ws, { t: 'state', d: msg.d }); }
        else if (msg.t === 'ping') send(ws, { t: 'pong', now: Date.now() });
      });
      ws.on('close', () => { const k = list.indexOf(me); if (k >= 0) list.splice(k, 1); for (const p of list) send(p.ws, { t: 'leave', id, host: list[0]?.id ?? null }); if (!list.length) rooms.delete(code); });
    });
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const origin = 'http://127.0.0.1:' + port;
  return {
    origin, port,
    async deploy(c, manifest) {
      const byKey = new Map(c.files.map((f) => [`${c.id}/${f.path}`, f.bytes]));
      const env = { FILES: { get: async (k) => (byKey.has(k) ? r2(byKey.get(k)) : null) }, PREFIX: c.id + '/', PLATFORM: origin, GAME_ID: c.id, SLUG: c.id, TITLE: c.listing?.title || c.id, VERSION: '1', ENV: 'preview', MANIFEST: JSON.stringify(manifest || {}), PLAY_KEY: 'local-key' };
      games.set(c.id, { env });
      const token = await signPlayToken({ g: c.id, e: 'preview', u: 'verifier_' + c.id, n: 'Verifier', k: 'verify', s: 'vf_' + c.id, x: Math.floor(Date.now() / 1000) + 900 }, 'local-key');
      return `${origin}/c/${c.id}/?gcp_t=${token}&gcp_autostart=1`;
    },
    close: () => new Promise((r) => { wss.close(); server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

// ---------------------------------------------------------------------------------------------- browser check
let browser = null;
export async function browserCheck(url, usesWebGPU, platformOrigin) {
  const { chromium } = require('playwright');
  browser ||= await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1, acceptDownloads: false });
  try {
    const page = await ctx.newPage();
    const { report, shots } = await verifyPage(page, url, { readyTimeoutS: 30, minFrames: 6, observeS: 3, playthroughS: 30, usesWebGPU, platformOrigin, openPage: () => ctx.newPage() });
    return { report, shot: shots.length ? Buffer.from(shots[0]) : null };
  } finally { await ctx.close(); }
}
export const closeBrowser = async () => { if (browser) await browser.close(); browser = null; };

// ---------------------------------------------------------------------------------------------- originality (printVersion + matchesFor)
export function printCase(c, shot, report) {
  const texts = c.files.map((f) => ({ path: f.path, size: f.size, text: READABLE(f.path) && f.size <= 2 * 1024 * 1024 ? f.bytes.toString('utf8') : null }));
  const own = texts.filter((t) => t.text !== null && CODE.test(t.path) && !/^server\//.test(t.path) && !isVendor(t.path, t.text));
  const prints = O.bundlePrints(own, BASELINE);
  const ownPaths = new Set(own.filter((t) => O.distinctFile(t.path, t.text, BASELINE)).map((t) => t.path));
  const files = c.files.filter((f) => ownPaths.has(f.path) && f.size > 512).map((f) => f.sha);
  const assets = [...new Set(c.files.filter((f) => ASSET.test(f.path) && f.size > 2048).map((f) => f.sha))];
  let look = null; if (shot) { try { look = O.lookOf(decodePng(new Uint8Array(shot))); } catch { look = null; } }
  const keys = [...new Set([...O.sketchOf(prints), ...assets.slice(0, 30).map((s) => parseInt(s.slice(0, 8), 16) | 0)])];
  return { prints, files, assets, look, keys, facts: analyzeBundle(texts, report || {}), html: texts.find((t) => t.path === 'index.html')?.text || '' };
}
/** The same candidate search as matchesFor: 3+ shared index keys, or one of the 3 closest looks within distance 10. */
export function matchesFor(me, owner, live) {
  const ids = new Set();
  const mk = new Set(me.keys.slice(0, 94));
  live.filter((x) => x.owner !== owner).map((x) => ({ x, n: x.print.keys.filter((k) => mk.has(k)).length })).filter((r) => r.n >= 3).sort((a, b) => b.n - a.n).slice(0, 8).forEach((r) => ids.add(r.x));
  if (me.look) live.filter((x) => x.owner !== owner && x.print.look).map((x) => ({ x, d: O.lookDistance(me.look, x.print.look) })).filter((r) => r.d <= 10).sort((a, b) => a.d - b.d).slice(0, 3).forEach((r) => ids.add(r.x));
  const rank = { copy: 2, similar: 1, different: 0 };
  return [...ids].map((x) => ({ id: x.id, title: x.listing?.title || x.id, other: x, ...O.compare(me, x.print) })).sort((a, b) => rank[b.verdict] - rank[a.verdict] || b.code - a.code || b.assets - a.assets);
}

// ---------------------------------------------------------------------------------------------- Workers AI over REST
export const AI_ON = !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_API_TOKEN) && !process.env.NO_AI;
export const aiUsage = { calls: 0, input_tokens: 0 };
/** Same contract as aiDecide in src/ai.ts. */
export async function aiDecide(model, state, questions, extra = {}) {
  if (!AI_ON) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/${model}`, { method: 'POST', headers: { authorization: `Bearer ${process.env.CLOUDFLARE_ACCOUNT_API_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, state, questions, ...extra }) });
      const j = await r.json(); const answers = j?.result?.answers;
      aiUsage.calls++; aiUsage.input_tokens += j?.result?.usage?.input_tokens || 0;
      if (!answers) { if (attempt === 2) console.error('ai error', model, JSON.stringify(j.errors || j).slice(0, 300)); continue; }
      for (const [id, q] of Object.entries(questions)) { const a = answers[id]; if (!a || a.type !== q.type) return null; }
      return answers;
    } catch (e) { if (attempt === 2) console.error('ai failed', String(e)); }
  }
  return null;
}

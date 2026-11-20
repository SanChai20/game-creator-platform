// The capture contract (platform-contract guide, "Hand over the frame"), end to end in a real browser: the preview check
// of src/verify-core.js passes a game that draws everything in its canvases and registers GCP.test.onCapture and
// GCP.test.onState, and fails one without the hooks, one that paints a menu of page elements over the game, and one whose
// hook hands over the wrong picture. The game's world is drawn by a module Web Worker (WebGL, frames not kept), its UI
// on a 2D canvas over it. Needs Playwright's Chromium:   npm run test:sdk-capture
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { WORKER_HELPER } from '../src/runtime/game-worker.js';
import { verifyPage } from '../src/verify-core.js';

const require = createRequire(import.meta.url);
let playwright; try { playwright = require('playwright'); } catch { playwright = require(join(process.env.NODE_PATH || '', 'playwright')); }
const fx = (f) => readFileSync(new URL('./fixtures/sdk-capture/' + f, import.meta.url));
const SDK = readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url));
const server = await new Promise((ok) => { const s = createServer((q, r) => {
  const p = new URL(q.url, 'http://x').pathname;
  const send = (body, type) => { r.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); r.end(body); };
  if (p === '/sdk/gcp.js') return send(SDK, 'text/javascript');
  if (p === '/worker.js') return send(q.headers['sec-fetch-dest'] === 'worker' ? fx('worker.js') + WORKER_HELPER : fx('worker.js'), 'text/javascript');
  if (/^\/[a-z-]+\.html$/.test(p)) { let html = String(fx(p.slice(1))); if (new URL(q.url, 'http://x').searchParams.has('wrong')) html = html.replace('return [world, ui];', 'return ui;'); return send(html, 'text/html'); }
  r.writeHead(404); r.end();
}).listen(8932, '127.0.0.1', () => ok(s)); });

const browser = await playwright.chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failed = 0;
async function check(name, path, expect, url, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  try {
    const { report } = await verifyPage(page, url || 'http://127.0.0.1:8932' + path, { portrait: false, observeS: 1.5, playthroughS: 5, readyTimeoutS: 40, ...opts });
    const c = report.checks.find((x) => x.id === 'capture');
    if (!c && process.env.DEBUG) console.log(JSON.stringify(report.checks.filter((x) => !x.ok), null, 1).slice(0, 3000), JSON.stringify(report.playthrough || {}).slice(0, 2000));
    assert.ok(c, `${name}: a capture check ran (${report.checks.map((x) => `${x.id}:${x.ok}`).join(' ')})`);
    if (process.env.DEBUG) console.log(JSON.stringify(report.checks.filter((x) => !x.ok), null, 1).slice(0, 3000));
    expect(c, report);
    console.log('  ✓', name, '-', c.detail.slice(0, 160));
  } catch (e) { failed++; console.log('  ✗', name, String(e.message || e).split('\n')[0]); }
  finally { await page.close(); }
}
if (!process.env.ONLY) await check('a game drawn in its canvases, with both hooks, passes', '/contract.html', (c, r) => { assert.equal(c.ok, true, c.detail); assert.equal(r.capture.exact, true); });
if (!process.env.ONLY) await check('a text field over the game is allowed and noted', '/contract.html?field=1', (c, r) => { assert.equal(c.ok, true, c.detail); assert.ok(r.notes.some((n) => /Text fields/.test(n))); assert.deepEqual(r.capture.redrawn, ['input#name']); });
if (!process.env.ONLY) await check('a hook that hands over only part of the frame fails', '/contract.html?wrong=1', (c) => { assert.equal(c.ok, false); assert.match(c.detail, /does not match the screen/); });
if (!process.env.ONLY) await check('no hooks fails', '/html-ui.html', (c) => { assert.equal(c.ok, false); assert.match(c.detail, /no GCP\.test\.onCapture and no GCP\.test\.onState/); });
if (!process.env.ONLY) await check('a menu of page elements over the game fails, hooks or not', '/html-ui.html?hooks=1', (c) => { assert.equal(c.ok, false); assert.match(c.detail, /div\.menu \(text "Single Player"\)/); });
// every platform template starts a game that keeps the contract (served as the platform serves a game: the SDK and the
// import map in front of the page, the platform's own files on another origin)
const PUB = new URL('../web/public/', import.meta.url).pathname, templates = JSON.parse(readFileSync(join(PUB, 'templates/index.json'), 'utf8'));
const TYPES = { js: 'text/javascript', mjs: 'text/javascript', html: 'text/html', json: 'application/json', css: 'text/css', png: 'image/png', woff2: 'font/woff2', wasm: 'application/wasm', glb: 'model/gltf-binary', bin: 'application/octet-stream' };
const platform = await new Promise((ok) => { const s = createServer((q, r) => {
  const p = decodeURIComponent(new URL(q.url, 'http://x').pathname), ext = p.split('.').pop();
  if (p.startsWith('/api/')) { r.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); r.end('{}'); return; }   // the platform's API, answered empty
  try {
    let body = readFileSync(join(PUB, p.replace(/^\/(game\/[^/]+)\//, (m, g) => `templates/${g.slice(5)}/`).replace(/\.\.+/g, '')));
    if (/^\/game\/[^/]+\/(index\.html)?$/.test(p) || p.endsWith('/index.html')) {
      const cfg = { env: 'preview', kind: 'verify', gameId: 'tpl', version: '1', api: 'http://127.0.0.1:8933', player: { id: 'u_test', name: 'Test' } };
      const imports = { three: '/vendor/three-0.187.0/build/three.module.js', 'three/webgpu': '/vendor/three-0.187.0/build/three.webgpu.js', 'three/tsl': '/vendor/three-0.187.0/build/three.tsl.js', 'three/addons/': '/vendor/three-0.187.0/examples/jsm/', '@gcp/': '/kits/v1/' };
      body = String(body).replace(/<head>/i, `<head><script>window.__GCP_CONFIG=${JSON.stringify(cfg)}</script><script src="/sdk/gcp.js"></script><script type="importmap">${JSON.stringify({ imports })}</script>`);
    }
    r.writeHead(200, { 'content-type': TYPES[ext] || 'text/html', 'cache-control': 'no-store' }); r.end(body);
  } catch { r.writeHead(404); r.end(); }
}).listen(8933, '127.0.0.1', () => ok(s)); });
for (const tpl of (templates.templates || templates).map((x) => x.name || x.id || x).filter((n) => !process.env.ONLY || n === process.env.ONLY)) {
  await check(`the "${tpl}" template keeps the contract`, '', (c) => assert.equal(c.ok, true, c.detail), `http://127.0.0.1:8933/game/${tpl}/index.html`, { playthroughS: 90 });
}
platform.close();
await browser.close(); server.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

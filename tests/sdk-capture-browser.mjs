// Feedback pictures made by the game's own page (web/public/sdk/gcp.js), the way an iPad takes them: Safari there cannot
// share a tab, so the page redraws itself. A page on another site, like the console, asks a preview game for a picture;
// the game draws in a module Web Worker on an OffscreenCanvas (green), on its own page with WebGL that does not keep its
// frames (blue), and has elements styled with CSS variables (a red box, a round box, a half-full bar). The picture must
// show each where it is on the page. The worker script is served with the runtime's helper (src/runtime/game-worker.js),
// as the platform serves a preview's worker scripts. Needs Playwright's Chromium:   npm run test:sdk-capture
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { WORKER_HELPER } from '../src/runtime/game-worker.js';

const require = createRequire(import.meta.url);
let playwright; try { playwright = require('playwright'); } catch { playwright = require(join(process.env.NODE_PATH || '', 'playwright')); }
const fx = (f) => readFileSync(new URL('./fixtures/sdk-capture/' + f, import.meta.url));
const SDK = readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url));
const server = await new Promise((ok) => { const s = createServer((q, r) => {
  const p = new URL(q.url, 'http://x').pathname;
  const send = (body, type) => { r.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); r.end(body); };
  if (p === '/sdk/gcp.js') return send(SDK, 'text/javascript');
  if (p === '/worker.js') return send(q.headers['sec-fetch-dest'] === 'worker' ? fx('worker.js') + WORKER_HELPER : fx('worker.js'), 'text/javascript');
  if (p === '/page.html' || p === '/game.html') return send(fx(p.slice(1)), 'text/html');
  r.writeHead(404); r.end();
}).listen(8932, '127.0.0.1', () => ok(s)); });

let failed = 0;
// BROWSER=chromium (default) | firefox | webkit: the same checks in each engine (CI runs all three)
const engine = process.env.BROWSER || 'chromium';
const browser = await playwright[engine].launch(engine === 'chromium' ? { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } : engine === 'firefox' ? { headless: !process.env.HEADED, firefoxUserPrefs: { 'webgl.force-enabled': true, 'webgl.disabled': false } } : { headless: !process.env.HEADED });   // HEADED=1 under xvfb: Mesa's software WebGL
console.log('engine:', engine, browser.version());
try {
  for (const dpr of [1, 2]) {
    const name = `pixel ratio ${dpr}`;
    try {
      const page = await browser.newPage({ deviceScaleFactor: dpr, viewport: { width: 640, height: 300 } });
      const log = []; page.on('console', (m) => log.push(m.type() + ': ' + m.text())); page.on('pageerror', (e) => log.push('error: ' + e.message));
      page.context().on('weberror', (e) => log.push('weberror: ' + e.error().message));
      await page.goto('http://127.0.0.1:8932/page.html');
      const game = await (await page.waitForSelector('#game')).contentFrame();
      await game.waitForFunction(() => window.ready === true, null, { timeout: 10000 }).catch((e) => { throw new Error(e.message.split('\n')[0] + ' | ' + log.slice(-6).join(' | ')); });
      await page.waitForTimeout(300);
      const res = await page.evaluate(() => window.shoot());
      assert.ok(res.image, `${name}: a picture (${res.error})`);
      assert.equal(res.method, 'page', `${name}: the page redrew itself`);
      assert.equal(res.sources?.worker, 1, `${name}: the worker's canvas was copied by the worker (${JSON.stringify(res.sources)})`);
      const px = await page.evaluate(async (src) => {
        const img = new Image(); img.src = src; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const s = img.width / 600, at = (x, y) => [...g.getImageData(Math.round(x * s), Math.round(y * s), 1, 1).data.slice(0, 3)];
        return { w: img.width, h: img.height, worker: at(80, 100), gl: at(220, 100), vbox: at(360, 100), round: at(500, 100), corner: at(446, 46),
          barFull: at(140, 215), barEmpty: at(500, 215), page: at(10, 10) };
      }, res.image);
      const is = (got, rgb, what) => assert.ok(got.every((v, i) => Math.abs(v - rgb[i]) < 40), `${name}: ${what} is ${got}, expected ${rgb}`);
      assert.ok(Math.abs(px.w / px.h - 600 / 260) < 0.02, `${name}: the game's shape (${px.w}×${px.h})`);
      is(px.worker, [26, 204, 26], 'the canvas drawn by the worker');
      is(px.gl, [15, 51, 230], 'the WebGL canvas of the page');
      is(px.vbox, [224, 16, 16], 'the box whose background uses a CSS variable');
      is(px.round, [16, 192, 192], 'the round box');
      is(px.corner, [128, 128, 128], 'outside the round box\'s curve');
      is(px.barFull, [240, 208, 32], 'the filled part of the bar');
      is(px.barEmpty, [48, 48, 48], 'the empty part of the bar');
      is(px.page, [128, 128, 128], 'the page');
      console.log('  ✓', name, `${px.w}×${px.h}`, JSON.stringify(res.sources));
      await page.close();
    } catch (e) { failed++; console.log('  ✗', name, String(e.message || e).split('\n')[0]); }
  }
} finally { await browser.close(); server.close(); }
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

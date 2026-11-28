// Clips in a real browser: the page around the game asks for a recording (clip_start / clip_stop) and the SDK hands back
// a video of the game's own frame: one canvas recorded as it is, several (a WebGL world drawn by a worker under a 2D UI)
// drawn into one, and an error, not a hang, for a game with nothing to record. Needs Playwright's Chromium:
//   npm run test:clips
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
const EMPTY = `<!doctype html><html><head><script>window.__GCP_CONFIG = { env: 'live', kind: 'player', gameId: 'cliptest', version: '1', api: 'http://127.0.0.1:8933', player: { id: 'u_test', name: 'Test' } };</script><script src="/sdk/gcp.js"></script></head><body><p>No canvas here</p><script>GCP.ready()</script></body></html>`;
const PARENT = `<!doctype html><html><body style="margin:0"><iframe id="g" style="width:640px;height:360px;border:0"></iframe><script>
  window.got = []; addEventListener('message', (e) => { const d = e.data; if (d && /^clip_/.test(d.gcp)) got.push({ gcp: d.gcp, error: d.error || null, size: d.blob ? d.blob.size : 0, type: d.type || null, ms: d.ms || 0 }); });
  window.ask = (m) => document.getElementById('g').contentWindow.postMessage(m, location.origin);
</script></body></html>`;
const server = await new Promise((ok) => { const s = createServer((q, r) => {
  const p = new URL(q.url, 'http://x').pathname;
  const send = (body, type) => { r.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); r.end(body); };
  if (p === '/sdk/gcp.js') return send(SDK, 'text/javascript');
  if (p === '/worker.js') return send(q.headers['sec-fetch-dest'] === 'worker' ? fx('worker.js') + WORKER_HELPER : fx('worker.js'), 'text/javascript');
  if (p === '/parent.html') return send(PARENT, 'text/html');
  if (p === '/empty.html') return send(EMPTY, 'text/html');
  if (/^\/[a-z-]+\.html$/.test(p)) return send(String(fx(p.slice(1))).replace(/127\.0\.0\.1:8932/g, '127.0.0.1:8933'), 'text/html');
  r.writeHead(404); r.end();
}).listen(8933, '127.0.0.1', () => ok(s)); });

const browser = await playwright.chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failed = 0;
async function clip(name, game, expect, holdMs = 1500) {
  const page = await browser.newPage();
  try {
    await page.goto('http://127.0.0.1:8933/parent.html');
    await page.evaluate((src) => { document.getElementById('g').src = src; }, 'http://127.0.0.1:8933' + game);
    await page.waitForTimeout(2500);
    await page.evaluate(() => ask({ gcp: 'clip_start', id: 'c1', max: 30000 }));
    await page.waitForTimeout(holdMs);
    await page.evaluate(() => ask({ gcp: 'clip_stop', id: 'c1' }));
    await page.waitForFunction(() => got.some((m) => m.gcp === 'clip_result'), null, { timeout: 8000 });
    const got = await page.evaluate(() => got);
    expect(got.find((m) => m.gcp === 'clip_result'), got);
    console.log('  ✓', name);
  } catch (e) { failed++; console.log('  ✗', name, String(e.message || e).split('\n')[0]); }
  finally { await page.close(); }
}
await clip('one 2D canvas is recorded', '/html-ui.html?hooks=1', (r, all) => {
  assert.ok(all.some((m) => m.gcp === 'clip_started'));
  assert.equal(r.error, null); assert.ok(r.size > 1000, `a video came back: ${r.size} bytes`); assert.match(r.type, /^video\/(webm|mp4)$/); assert.ok(r.ms >= 1000);
});
await clip('a WebGL world from a worker under a 2D UI is drawn into one recording', '/contract.html', (r) => { assert.equal(r.error, null); assert.ok(r.size > 1000, `${r.size} bytes`); });
await clip('a game with nothing to record answers with an error', '/empty.html', (r) => { assert.equal(r.error, 'no_canvas'); assert.equal(r.size, 0); }, 200);
await browser.close(); server.close();
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');

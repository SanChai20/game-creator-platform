// The "responds" check of src/verify-core.js in a real browser (MCP run 5): a game that waits on a still title screen and
// undoes what the player did before the verifier's last picture (cards turned back over, Escape back to the title) passes,
// and a still picture that listens for input and ignores it still fails. Needs Playwright's Chromium:  npm run test:responds
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { verifyPage } from '../src/verify-core.js';

const require = createRequire(import.meta.url);
let playwright; try { playwright = require('playwright'); } catch { playwright = require(join(process.env.NODE_PATH || '', 'playwright')); }
const SDK = readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url));
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#1d2a2a;overflow:hidden}canvas{display:block;width:100vw;height:100vh}</style></head>
<body><canvas id="c"></canvas><script src="/sdk/gcp.js"></script><script>
const c = document.getElementById('c'), g = c.getContext('2d'); c.width = innerWidth; c.height = innerHeight;
${body}
requestAnimationFrame(function f() { draw(); requestAnimationFrame(f); }); GCP.ready();
</script></body></html>`;
// a memory game: a still title; a click deals the cards and turns the one under it; unmatched cards turn back after 500 ms,
// and Escape goes back to the title, so by the verifier's last picture the screen is the title again
const MEMORY = page(`
let scene = 'title', up = -1, t = 0;
const cards = 12, cw = c.width / 6, ch = c.height / 2;
addEventListener('pointerdown', (e) => {
  if (scene === 'title') { scene = 'play'; }
  up = Math.floor(e.clientX / cw) + 6 * Math.floor(e.clientY / ch); clearTimeout(t); t = setTimeout(() => { up = -1; }, 500);
});
addEventListener('keydown', (e) => { if (e.code === 'Escape') { scene = 'title'; up = -1; } });
function draw() {
  g.fillStyle = '#1d2a2a'; g.fillRect(0, 0, c.width, c.height);
  if (scene === 'title') { g.fillStyle = '#f5e6c8'; g.font = '48px sans-serif'; g.fillText('Memory', c.width / 2 - 90, c.height / 2); g.font = '20px sans-serif'; g.fillText('Click to play', c.width / 2 - 60, c.height / 2 + 40); return; }
  for (let i = 0; i < cards; i++) { g.fillStyle = i === up ? '#ffd166' : '#3a6ea5'; g.fillRect((i % 6) * cw + 8, Math.floor(i / 6) * ch + 8, cw - 16, ch - 16); }
}`);
// a still picture: listens for everything, draws the same frame every time
const STILL = page(`
addEventListener('pointerdown', () => {}); addEventListener('keydown', () => {});
function draw() { g.fillStyle = '#1d2a2a'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#f5e6c8'; g.font = '48px sans-serif'; g.fillText('Nothing happens', 200, c.height / 2); }`);

const server = await new Promise((ok) => { const s = createServer((q, r) => {
  const p = new URL(q.url, 'http://x').pathname, send = (b, t) => { r.writeHead(200, { 'content-type': t, 'cache-control': 'no-store' }); r.end(b); };
  if (p === '/sdk/gcp.js') return send(SDK, 'text/javascript');
  if (p === '/memory.html') return send(MEMORY, 'text/html');
  if (p === '/still.html') return send(STILL, 'text/html');
  r.writeHead(404); r.end();
}).listen(8933, '127.0.0.1', () => ok(s)); });

const browser = await playwright.chromium.launch();
let failed = 0;
async function check(name, path, expect) {
  const pg = await browser.newPage({ viewport: { width: 960, height: 540 } });
  try {
    const { report } = await verifyPage(pg, 'http://127.0.0.1:8933' + path, { portrait: false, observeS: 1.5, playthroughS: 5, readyTimeoutS: 20, playability: false });
    const r = report.checks.find((x) => x.id === 'responds');
    assert.ok(r, `${name}: responds ran (${report.checks.map((x) => `${x.id}:${x.ok}`).join(' ')})`);
    expect(r, report);
    console.log('  ✓', name, '-', r.detail.slice(0, 160));
  } catch (e) { failed++; console.log('  ✗', name, String(e.message || e).split('\n')[0]); }
  finally { await pg.close(); }
}
await check('a still title that a click starts, undone before the last picture, responds', '/memory.html', (r) => { assert.equal(r.ok, true, r.detail); });
await check('a still picture that ignores input does not', '/still.html', (r) => { assert.equal(r.ok, false, r.detail); });
await browser.close(); server.close();
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');

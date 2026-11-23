// Games of every kind verify (Haiku run 6): a doodle sandbox with no animation loop, no score and no ending passes the
// whole check and the iPhone and iPad pass; a game that drew a few frames at start and then redraws only on input passes;
// a reaction game that waits on one flat colour passes once input shows something; a still picture that ignores input,
// and a page that freezes on touch, still fail. Needs Playwright's Chromium:  npm run test:sandbox
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { applyDeviceResults, verifyDevices, verifyPage } from '../src/verify-core.js';

const require = createRequire(import.meta.url);
let playwright; try { playwright = require('playwright'); } catch { playwright = require(join(process.env.NODE_PATH || '', 'playwright')); }
const SDK = readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url));
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#fdf6e3;overflow:hidden;touch-action:none}canvas{display:block;width:100vw;height:100vh;touch-action:none}</style></head>
<body><canvas id="c"></canvas><script src="/sdk/gcp.js"></script><script>
const c = document.getElementById('c'), g = c.getContext('2d'); c.width = innerWidth; c.height = innerHeight;
${body}
</script></body></html>`;
// a doodle sandbox: draws only when the player drags or taps, no requestAnimationFrame, no score, no ending
const DOODLE = page(`
g.fillStyle = '#fdf6e3'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#586e75'; g.font = '18px sans-serif'; g.fillText('Draw anything', 16, 30);
let down = false, last = null, hue = 0;
const dot = (x, y) => { hue = (hue + 7) % 360; g.strokeStyle = g.fillStyle = 'hsl(' + hue + ',70%,45%)'; g.lineWidth = 8; g.lineCap = 'round';
  if (last) { g.beginPath(); g.moveTo(last.x, last.y); g.lineTo(x, y); g.stroke(); } else { g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill(); } last = { x, y }; };
c.addEventListener('pointerdown', (e) => { e.preventDefault(); down = true; last = null; dot(e.clientX, e.clientY); });
addEventListener('pointermove', (e) => { if (down) dot(e.clientX, e.clientY); });
addEventListener('pointerup', () => { down = false; last = null; });
addEventListener('keydown', (e) => { dot(40 + Math.random() * (c.width - 80), 60 + Math.random() * (c.height - 100)); last = null; });
GCP.ready();`);
// the same, but it animated an intro for a few frames before settling into redraw-on-input
const INTRO = DOODLE.replace('GCP.ready();', 'let n = 0; requestAnimationFrame(function f() { g.fillStyle = "#93a1a1"; g.fillRect(16, 40, n * 4, 4); if (++n < 20) requestAnimationFrame(f); }); GCP.ready();');
// a reaction game: one flat colour until the player taps or presses, then a coloured target and a message
const REACTION = page(`
g.fillStyle = '#c0392b'; g.fillRect(0, 0, c.width, c.height);
const hit = () => { g.fillStyle = '#27ae60'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText('Tap when green! ' + Math.round(performance.now() % 1000) + ' ms', 30, c.height / 2); g.beginPath(); g.arc(c.width / 2, c.height * 0.75, 40, 0, 7); g.fill(); };
addEventListener('pointerdown', hit); addEventListener('keydown', hit);
GCP.ready();`);
// a still picture: listens for everything, never changes
const STILL = page(`
g.fillStyle = '#1d2a2a'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#f5e6c8'; g.font = '40px sans-serif'; g.fillText('Nothing happens', 40, c.height / 2);
addEventListener('pointerdown', () => {}); addEventListener('keydown', () => {});
GCP.ready();`);

const PAGES = { '/doodle.html': DOODLE, '/intro.html': INTRO, '/reaction.html': REACTION, '/still.html': STILL };
const server = await new Promise((ok) => { const s = createServer((q, r) => {
  const p = new URL(q.url, 'http://x').pathname, send = (b, t) => { r.writeHead(200, { 'content-type': t, 'cache-control': 'no-store' }); r.end(b); };
  if (p === '/sdk/gcp.js') return send(SDK, 'text/javascript');
  if (PAGES[p]) return send(PAGES[p], 'text/html');
  r.writeHead(404); r.end();
}).listen(8934, '127.0.0.1', () => ok(s)); });

const browser = await playwright.chromium.launch();
let failed = 0;
const contexts = [];
const openDevicePage = async (p, vp) => { const c = await browser.newContext({ viewport: vp, deviceScaleFactor: p.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: p.userAgent }); contexts.push(c); return c.newPage(); };
async function run(path, { devices = false } = {}) {
  const pg = await browser.newPage({ viewport: { width: 960, height: 540 } });
  try {
    const { report } = await verifyPage(pg, 'http://127.0.0.1:8934' + path, { portrait: false, observeS: 1.5, playthroughS: 5, readyTimeoutS: 20, botPlayS: 6 });
    if (devices) applyDeviceResults(report, await verifyDevices(openDevicePage, 'http://127.0.0.1:8934' + path, { profiles: ['iphone', 'ipad'], orientation: 'any', readyTimeoutS: 20, observeS: 1 }));
    return report;
  } finally { await pg.close(); for (const c of contexts.splice(0)) await c.close().catch(() => {}); }
}
async function check(name, fn) {
  try { await fn(); console.log('  ✓', name); } catch (e) { failed++; console.log('  ✗', name, String(e.message || e).split('\n').slice(0, 3).join(' ')); }
}
const failing = (r) => r.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join(' | ');

await check('a doodle sandbox with no loop, no score and no ending passes, on the computer, iPhone and iPad', async () => {
  const r = await run('/doodle.html', { devices: true });
  assert.equal(r.ok, true, failing(r));
  for (const d of r.devices) assert.equal(d.ok, true, `${d.label}: ${d.problems.join('; ')}`);
  assert.ok(r.devices.length >= 3, 'iPhone, iPhone upright and iPad ran');
  assert.ok(r.checks.find((c) => c.id === 'score_or_end').soft, 'no score or ending is advice only');
});
await check('a game that animated an intro and then redraws only on input passes', async () => {
  const r = await run('/intro.html', { devices: true });
  assert.equal(r.ok, true, failing(r));
});
await check('a reaction game that waits on one flat colour passes once input shows something', async () => {
  const r = await run('/reaction.html');
  const pic = r.checks.find((c) => c.id === 'picture');
  assert.ok(pic && pic.ok, pic && pic.detail);
});
await check('a still picture that ignores input still fails, and fails on the devices too', async () => {
  const r = await run('/still.html', { devices: true });
  assert.equal(r.ok, false);
  assert.ok(r.devices.some((d) => d.problems.some((p) => /Nothing changed when it was touched/.test(p))), JSON.stringify(r.devices.map((d) => d.problems)));
});
await browser.close(); server.close();
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');

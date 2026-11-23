// The game standards' zone check (src/verify-core.js zonesOf) in a real browser: a game told it is in fullscreen on a
// notched phone, whose interface layer does or does not keep clear of the notch and the home bar. The menu button's
// corner is not reserved: the button floats on top and the player drags it aside.
// node tests/zones-browser.mjs (needs Playwright)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { zonesOf } from '../src/verify-core.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const sdk = new URL('../web/public/sdk/gcp.js', import.meta.url).pathname;
const b = await chromium.launch();
async function run(ui, setup = '', layers = '[W, U]') {
  const p = await b.newPage({ viewport: { width: 844, height: 390 } });
  await p.setContent('<html><body style="margin:0"><canvas id=w style="position:fixed;inset:0"></canvas><canvas id=u style="position:fixed;inset:0"></canvas></body></html>');
  await p.addScriptTag({ path: sdk });
  await p.addScriptTag({ content: `const W = document.getElementById('w'), U = document.getElementById('u'); W.width = U.width = innerWidth; W.height = U.height = innerHeight;
    const w = W.getContext('2d'), u = U.getContext('2d'); ${setup}
    (function f() { requestAnimationFrame(f); w.fillStyle = '#246'; w.fillRect(0, 0, W.width, W.height); u.clearRect(0, 0, U.width, U.height); u.fillStyle = '#fff'; const s = GCP.display.safe; ${ui} })();
    GCP.test.onCapture(() => ${layers}); GCP.test.onState(() => ({})); GCP.ready();` });
  await new Promise((r) => setTimeout(r, 400));
  const z = await zonesOf(p, 'landscape'); await p.close(); return z;
}
const zones = (z) => z.zones.map((x) => x.zone).sort();
let z = await run('u.fillRect(10, 4, 140, 48); u.fillRect(0, innerHeight - 14, innerWidth, 14);');
assert.equal(z.checked, true); assert.deepEqual(zones(z), ['home-bar', 'notch-left'].sort());
z = await run('u.fillRect(s.left + 300, s.top + 8, 140, 48); u.fillRect(s.left, innerHeight - s.bottom - 30, 200, 30);');
assert.deepEqual(zones(z), [], 'a HUD inside the safe area');
z = await run('u.fillRect(s.left + 8, s.top + 8, 140, 48);', "GCP.setDisplay({ exitButton: 'top-right' });");
assert.equal(z.corner, 'top-right'); assert.deepEqual(zones(z), [], 'a HUD in the top-left corner, where the button starts by default');
z = await run('u.fillRect(innerWidth - s.right - 60, s.top + 4, 56, 56);', "GCP.setDisplay({ exitButton: 'top-right' });");
assert.deepEqual(zones(z), [], 'a HUD in the corner the button starts in is fine');
z = await run('u.fillRect(60, 0, 140, 48);', "GCP.setDisplay({ edgeToEdge: false, exitButton: 'none' });");
assert.deepEqual(zones(z), [], 'kept inside the insets');
z = await run("u.fillStyle = '#312'; u.fillRect(0, innerHeight - 90, innerWidth, 90); u.fillStyle = '#fff'; u.fillRect(s.left + 10, innerHeight - 80, 100, 40);");
assert.deepEqual(zones(z), [], 'a bottom panel whose plain background runs to the edges, its content inside the safe area');
z = await run("u.fillStyle = '#312'; u.fillRect(0, innerHeight - 90, innerWidth, 90); u.fillStyle = '#fff'; u.fillRect(300, innerHeight - 30, 200, 30);");
assert.deepEqual(zones(z), ['home-bar'], 'a button on that panel reaching into the home bar');
assert.equal(z.zones[0].bleed, true);
z = await run('u.fillRect(0, 0, 140, 48);', '', 'W');
assert.equal(z.checked, false); assert.equal(z.reason, 'one-layer');
// GCP.display.menuButton: where the button sits while it shows, for a HUD to move aside by
{
  const p = await b.newPage({ viewport: { width: 844, height: 390 } });
  await p.setContent('<html><body></body></html>'); await p.addScriptTag({ path: sdk });
  assert.equal(await p.evaluate(() => GCP.display.menuButton), null, 'no button outside the player');
  const post = () => p.evaluate(() => { window.postMessage({ gcp: 'display', fullscreen: true, touch: true, edgeToEdge: true, safe: { top: 0, right: 47, bottom: 21, left: 47 } }, '*'); return new Promise((r) => setTimeout(r, 50)); });
  await post(); assert.deepEqual(await p.evaluate(() => GCP.display.menuButton), { corner: 'top-left', x: 47, y: 0, w: 56, h: 56 });
  await p.evaluate(() => GCP.setDisplay({ exitButton: 'bottom-right' }));
  assert.deepEqual(await p.evaluate(() => GCP.display.menuButton), { corner: 'bottom-right', x: 844 - 47 - 56, y: 390 - 21 - 56, w: 56, h: 56 });
  await p.evaluate(() => GCP.setDisplay({ exitButton: 'none' }));
  assert.deepEqual(await p.evaluate(() => GCP.display.menuButton), { corner: 'top-left', x: 47, y: 0, w: 56, h: 56 }, "'none' cannot hide the button");
  // in the window on the page: shown too, and scaled to a frame drawn smaller
  await p.evaluate(() => { window.postMessage({ gcp: 'display', fullscreen: false, mode: 'inline', safe: {}, scale: 0.5 }, '*'); return new Promise((r) => setTimeout(r, 50)); });
  assert.deepEqual(await p.evaluate(() => GCP.display.menuButton), { corner: 'top-left', x: 0, y: 0, w: 112, h: 112 });
  await p.close();
}
await b.close();
console.log('zones: ok');

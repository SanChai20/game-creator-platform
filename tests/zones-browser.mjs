// The game standards' zone check (src/verify-core.js zonesOf) in a real browser: a game told it is in fullscreen on a
// notched phone, whose interface layer does or does not keep clear of the notch, the home bar and the menu button.
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
let z = await run('u.fillRect(0, 0, 140, 48); u.fillRect(0, innerHeight - 14, innerWidth, 14);');
assert.equal(z.checked, true); assert.deepEqual(zones(z), ['home-bar', 'menu-button', 'notch-left'].sort());
z = await run('u.fillRect(s.left + 300, s.top + 8, 140, 48); u.fillRect(s.left, innerHeight - s.bottom - 30, 200, 30);');
assert.deepEqual(zones(z), [], 'a HUD inside the safe area and out of the corner');
z = await run('u.fillRect(s.left + 8, s.top + 8, 140, 48);', "GCP.setDisplay({ exitButton: 'top-right' });");
assert.equal(z.corner, 'top-right'); assert.deepEqual(zones(z), [], 'the button moved to a free corner');
z = await run('u.fillRect(innerWidth - s.right - 60, s.top + 4, 56, 56);', "GCP.setDisplay({ exitButton: 'top-right' });");
assert.deepEqual(zones(z), ['menu-button'], 'HUD in the corner the button moved to');
z = await run('u.fillRect(0, 0, 140, 48);', "GCP.setDisplay({ edgeToEdge: false, exitButton: 'none' });");
assert.deepEqual(zones(z), [], 'kept inside the insets, no button');
z = await run('u.fillRect(0, 0, 140, 48);', '', 'W');
assert.equal(z.checked, false); assert.equal(z.reason, 'one-layer');
await b.close();
console.log('zones: ok');

// Exact feedback screenshots in a real browser (web/src/capture.ts): a page shaped like the console's preview, with a
// "game" on another site (its own process, as in production) that shows a known colour in each corner. Each case shares
// the tab, takes a picture and checks that the corners sit at the picture's corners: the game neither shrunk nor shifted.
// Cases: device pixel ratios 1 to 3, browser zoom, a resize after sharing, a game box partly scrolled away, and a browser
// that cannot share a tab. Needs Playwright's Chromium and a display (the tab picker cannot run headless):
//   xvfb-run -a npm run test:capture        (Linux)       npm run test:capture        (macOS, Windows)
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let playwright; try { playwright = require('playwright'); } catch { playwright = require(join(process.env.NODE_PATH || '', 'playwright')); }
const fx = new URL('./fixtures/capture/', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'capture-'));
await build({ entryPoints: [new URL('../web/src/capture.ts', import.meta.url).pathname], bundle: true, format: 'esm', outfile: join(dir, 'capture.js'), target: 'es2020' });
writeFileSync(join(dir, 'page.html'), readFileSync(new URL('page.html', fx))); writeFileSync(join(dir, 'game.html'), readFileSync(new URL('game.html', fx)));
const serve = (port) => new Promise((ok) => { const s = createServer((q, r) => { try { const f = readFileSync(join(dir, new URL(q.url, 'http://x').pathname)); r.writeHead(200, { 'content-type': q.url.includes('.js') ? 'text/javascript' : 'text/html' }); r.end(f); } catch { r.writeHead(404); r.end(); } }).listen(port, '127.0.0.1', () => ok(s)); });
const servers = [await serve(8931)];
// the page on 127.0.0.1, the game on localhost: two sites, so the game runs in its own process like hearthcade.app does
const PAGE = 'http://127.0.0.1:8931/page.html?game=' + encodeURIComponent('http://localhost:8931/game.html');

async function run(name, { dpr = 1, zoom = 0, unsupported = false, after } = {}) {
  const prof = mkdtempSync(join(tmpdir(), 'prof-'));
  // browser zoom, as the person sets it (Ctrl +): Chrome's default zoom level, 1.0 = 120 %, -0.5 ≈ 90 %
  if (zoom) { mkdirSync(join(prof, 'Default'), { recursive: true }); writeFileSync(join(prof, 'Default', 'Preferences'), JSON.stringify({ partition: { default_zoom_level: { x: zoom } } })); }
  const ctx = await playwright.chromium.launchPersistentContext(prof, { headless: false, viewport: null,
    args: ['--auto-accept-this-tab-capture', `--force-device-scale-factor=${dpr}`, '--window-size=1100,760', '--window-position=0,0'] });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    if (unsupported) await page.addInitScript(() => { delete window.CropTarget; delete window.RestrictionTarget; });
    await page.goto(PAGE); await page.waitForFunction(() => window.ready);
    await page.waitForTimeout(600);
    const supported = await page.evaluate(() => window.cap.canCaptureTab());
    if (unsupported) { assert.equal(supported, false, `${name}: a browser without tab capture is not asked`); console.log('  ✓', name); return; }
    assert.equal(supported, true, `${name}: Chromium can share its tab`);
    await page.click('#go'); assert.equal(await page.evaluate(() => window.started), true, `${name}: sharing started`);
    if (after) await after(page);
    const res = await page.evaluate(async () => {
      const { image, diag } = await window.cap.grabTab(document.getElementById('game'));
      const img = new Image(); img.src = image; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const r = document.getElementById('game').getBoundingClientRect(), s = img.width / r.width, d = Math.max(3, Math.round(12 * s));
      const at = (x, y) => [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)];
      // each corner square, sampled just inside it, and just outside it (the grey of the page)
      return { w: img.width, h: img.height, rw: r.width, rh: r.height, diag, s,
        tl: at(d, d), tr: at(img.width - 1 - d, d), bl: at(d, img.height - 1 - d), br: at(img.width - 1 - d, img.height - 1 - d),
        mid: at(img.width / 2, img.height * 0.2), beyond: at(Math.min(img.width - 1, 60 * s), Math.min(img.height - 1, 60 * s)) };
    });
    const is = (px, rgb, what) => assert.ok(px.every((v, i) => Math.abs(v - rgb[i]) < 60), `${name}: ${what} is ${px}, expected ${rgb} (${JSON.stringify(res.diag)})`);
    is(res.tl, [255, 0, 0], 'top-left'); is(res.tr, [0, 255, 0], 'top-right'); is(res.bl, [0, 0, 255], 'bottom-left'); is(res.br, [255, 255, 0], 'bottom-right');
    is(res.mid, [128, 128, 128], 'the middle'); is(res.beyond, [128, 128, 128], 'beside the corner');
    // the picture has the game's shape, at the screen's own resolution up to 1600 px
    assert.ok(Math.abs(res.w / res.h - res.rw / res.rh) < 0.02, `${name}: shape ${res.w}×${res.h} vs ${res.rw}×${res.rh}`);
    console.log('  ✓', name, `${res.w}×${res.h}`, JSON.stringify(res.diag));
  } finally { await ctx.close(); }
}

let failed = 0;
const cases = [
  ['ratio 1', { dpr: 1 }], ['ratio 1.25', { dpr: 1.25 }], ['ratio 1.5', { dpr: 1.5 }], ['ratio 1.75', { dpr: 1.75 }], ['ratio 2', { dpr: 2 }], ['ratio 3', { dpr: 3 }],
  ['zoom 120 %', { zoom: 1 }], ['zoom 90 % at ratio 1.5', { zoom: -0.58, dpr: 1.5 }],
  ['game box resized after sharing', { after: async (p) => { await p.evaluate(() => { const b = document.getElementById('box'); b.style.width = '640.4px'; b.style.height = '360.2px'; b.style.left = '33.7px'; }); await p.waitForTimeout(500); } }],
  ['window resized after sharing', { after: async (p) => { await p.setViewportSize({ width: 980, height: 640 }).catch(() => {}); await p.evaluate(() => { const b = document.getElementById('box'); b.style.width = '700px'; b.style.height = '393.75px'; }); await p.waitForTimeout(500); } }],
  ['no tab capture in this browser', { unsupported: true }],
];
for (const [name, o] of cases) { try { await run(name, o); } catch (e) { failed++; console.log('  ✗', name, String(e.message || e).split('\n')[0]); } }
servers.forEach((s) => s.close());
console.log(failed ? `${failed} of ${cases.length} failed` : `all ${cases.length} passed`);
process.exit(failed ? 1 : 0);

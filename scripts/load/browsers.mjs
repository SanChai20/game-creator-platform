// Plays games through the platform in real browser engines and emulated devices, and reports what loaded.
// For a local stack only (see scripts/load/README.md): BASE=http://localhost:8788 node scripts/load/browsers.mjs bloomguard void-echoes
// For each engine/device it signs up a fresh account, opens the game's page, waits for the game frame, and checks that
// every request to the game's host succeeded, that the game started (its heartbeat said ready), that the page's play
// clock credited time, and that a reload starts the game again.
import { createRequire } from 'node:module';
const { chromium, firefox, webkit, devices } = createRequire(import.meta.url)('playwright');
import { signUp } from '../../tests/live-auth.mjs';

const BASE = process.env.BASE || 'http://localhost:8788';
const slugs = process.argv.slice(2);
if (!slugs.length) { console.error('usage: node scripts/load/browsers.mjs <slug>...'); process.exit(2); }
const PLAY_MS = Number(process.env.PLAY_MS || 35000);

// Only Chromium may be installed (CI images often have just one engine); ENGINES=all adds Firefox and WebKit.
// Phones and tablets are emulated (screen, touch, user agent). Third-party cookies are blocked in every Chromium target,
// as Safari on iPhone and iPad does: give the platform and the games different sites (BASE http://127.0.0.1:…, games on
// *.localhost) so the game frame is cross-site, as hearthcade.com and hearthcade.app are.
const strip = (d) => { const { defaultBrowserType: _d, ...rest } = d; return rest; };
const NO_3P = ['--test-third-party-cookie-phaseout'];
const targets = [
  { name: 'Chromium desktop', engine: chromium, args: NO_3P, ctx: { viewport: { width: 1280, height: 800 } } },
  { name: 'iPhone 15 (emulated)', engine: chromium, args: NO_3P, ctx: strip(devices['iPhone 15']) },
  { name: 'iPad Pro 11 (emulated)', engine: chromium, args: NO_3P, ctx: strip(devices['iPad Pro 11']) },
  { name: 'Pixel 7 (emulated)', engine: chromium, args: NO_3P, ctx: strip(devices['Pixel 7']) },
  ...(process.env.ENGINES === 'all' ? [
    { name: 'Firefox desktop', engine: firefox, ctx: { viewport: { width: 1280, height: 800 } } },
    { name: 'WebKit desktop', engine: webkit, ctx: { viewport: { width: 1280, height: 800 } } },
    { name: 'iPhone 15 (WebKit)', engine: webkit, ctx: { ...devices['iPhone 15'] } },
    { name: 'iPad Pro 11 (WebKit)', engine: webkit, ctx: { ...devices['iPad Pro 11'] } },
  ] : []),
];
const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;

const results = [];
for (const t of targets.filter((x) => !only || only.test(x.name))) {
  const browser = await t.engine.launch({ args: t.args || [] });
  for (const slug of slugs) {
    const r = { target: t.name, slug, ok: false, frame: '', gameRequests: 0, failed: [], ready: false, credited: 0, reload: false, errors: [] };
    const ctx = await browser.newContext({ ...t.ctx, baseURL: BASE });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => r.errors.push(String(e.message || e).slice(0, 160)));
    const onResponse = (res) => {
      const u = new URL(res.url());
      if (/^gcp-[a-z0-9]+-(live|preview)\./.test(u.hostname)) {
        r.gameRequests++;
        // the gate's 401 for a request without a token, or a 404, means a file did not load
        if (res.status() >= 400) r.failed.push(`${res.status()} ${u.pathname.replace(/\/~t\/[^/]+/, '/~t/…').slice(0, 80)}`);
      }
      if (/\/api\/rt\/beat$/.test(u.pathname) && res.status() === 200) r.ready = true;
      if (/\/api\/plays\/[^/]+\/seen$/.test(u.pathname)) res.json().then((j) => { if (j && j.ok) r.credited = Math.max(r.credited, j.seconds || 0); }).catch(() => {});
    };
    page.on('response', onResponse);
    try {
      const email = `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.com`;
      await signUp(BASE, async (p, data, headers) => { const s = await page.request.post(p, { data, headers }); const text = await s.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } return { status: s.status(), json, text }; }, email, 'E2E player');
      await page.goto(`/g/${slug}?play=1`, { waitUntil: 'domcontentloaded' });
      const frameEl = await page.waitForSelector('iframe[src*="gcp-"]', { timeout: 30000 });
      r.frame = new URL(await frameEl.getAttribute('src')).host;
      await page.waitForTimeout(PLAY_MS);
      // open the game again (the store page drops ?play=1 once it started): it must start again, on the same address
      const before = r.gameRequests;
      await page.goto(`/g/${slug}?play=1`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('iframe[src*="gcp-"]', { timeout: 30000 });
      await page.waitForTimeout(8000);
      r.reload = r.gameRequests > before;
      r.ok = !r.failed.length && r.ready && r.reload && r.credited > 0;
    } catch (e) { r.errors.push(String(e.message || e).slice(0, 200)); }
    results.push(r);
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${t.name.padEnd(24)} ${slug.padEnd(12)} frame=${r.frame} files=${r.gameRequests} failed=${r.failed.length} ready=${r.ready} credited=${r.credited}s reload=${r.reload}${r.failed.length ? ' ' + r.failed.slice(0, 3).join(', ') : ''}${r.errors.length ? ' errors: ' + r.errors.slice(0, 2).join(' | ') : ''}`);
    await ctx.close();
  }
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} passed`);
process.exit(failed ? 1 : 0);

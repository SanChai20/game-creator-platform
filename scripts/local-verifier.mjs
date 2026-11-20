// Local stand-in for Cloudflare Browser Rendering: runs the same playability check with Playwright.
// Start it next to `wrangler dev` and set VERIFIER_URL=http://127.0.0.1:8799 in .dev.vars.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { applyDeviceResults, verifyDevices, verifyPage } from '../src/verify-core.js';
import { gameState, openGame, runSteps, shoot } from '../src/debug-core.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

// debug_preview's browsers (src/debug.ts): pages kept open between calls, closed after 3 idle minutes
const debugPages = new Map();
setInterval(() => { for (const [id, d] of debugPages) if (Date.now() - d.at > 180000) { debugPages.delete(id); d.ctx.close().catch(() => {}); } }, 15000).unref();
async function drive(page, steps) {
  const f0 = await gameState(page).catch(() => ({ frames: 0 })), t0 = Date.now();
  const run = await runSteps(page, steps || []);
  const shots = [...run.shots, { label: 'now', bytes: await shoot(page) }];
  const state = await gameState(page).catch((e) => ({ error: String(e.message || e) }));
  const dt = Date.now() - t0; if (dt > 600 && typeof state.frames === 'number') state.fps_during_call = Math.round(((state.frames - (f0.frames || 0)) * 1000) / dt);
  return { log: run.log, state, stopped: run.stopped || 0, shots: shots.map((s) => ({ label: s.label, b64: Buffer.from(s.bytes).toString('base64') })) };
}
async function debug(req, res, body) {
  const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  try {
    const b = JSON.parse(body);
    if (b.op === 'open') {
      const ctx = await browser.newContext({ viewport: { width: b.viewport.width, height: b.viewport.height }, deviceScaleFactor: 1, hasTouch: !!b.viewport.touch });
      const page = await ctx.newPage(), id = 'local_' + Math.random().toString(36).slice(2, 12);
      debugPages.set(id, { ctx, page, at: Date.now() });
      const opened = await openGame(page, b.url, b.viewport);
      return send(200, { id, opened, ...(await drive(page, b.steps)) });
    }
    const d = debugPages.get(b.id);
    if (!d) return send(410, { error: 'gone' });
    if (b.op === 'close') { debugPages.delete(b.id); await d.ctx.close().catch(() => {}); return send(200, { ok: true }); }
    d.at = Date.now();
    const out = await drive(d.page, b.steps); d.at = Date.now();
    return send(200, out);
  } catch (e) { send(500, { error: String(e && e.stack || e) }); }
}

createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url === '/debug') return debug(req, res, body);
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  try {
    const { url, opts } = JSON.parse(body);
    const page = await ctx.newPage();
    const { report, shots, frames } = await verifyPage(page, url, { ...opts, openPage: () => ctx.newPage() });
    const dv = opts.devices || { profiles: [] };
    if (report.ok && dv.profiles && dv.profiles.length && !opts.usesWebGPU) {
      const contexts = [];
      const openDevicePage = async (p, vp) => { const c = await browser.newContext({ viewport: vp, deviceScaleFactor: p.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: p.userAgent }); contexts.push(c); return c.newPage(); };
      try { applyDeviceResults(report, await verifyDevices(openDevicePage, url, { profiles: dv.profiles, orientation: dv.orientation, readyTimeoutS: opts.readyTimeoutS }), dv.devices); }
      finally { for (const c of contexts) await c.close().catch(() => {}); }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ report, shot: shots.length ? Buffer.from(shots[0]).toString('base64') : null, frames: (frames || []).map((f) => Buffer.from(f).toString('base64')) }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e && e.stack || e) }));
  } finally { await ctx.close(); }
}).listen(8799, '127.0.0.1', () => console.log('local verifier on http://127.0.0.1:8799'));

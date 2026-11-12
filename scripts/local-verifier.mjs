// Local stand-in for Cloudflare Browser Rendering: runs the same playability check with Playwright.
// Start it next to `wrangler dev` and set VERIFIER_URL=http://127.0.0.1:8799 in .dev.vars.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { verifyPage } from '../src/verify-core.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  try {
    const { url, opts } = JSON.parse(body);
    const page = await ctx.newPage();
    const { report, shots } = await verifyPage(page, url, opts);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ report, shot: shots.length ? Buffer.from(shots[shots.length - 1]).toString('base64') : null }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e && e.stack || e) }));
  } finally { await ctx.close(); }
}).listen(8799, '127.0.0.1', () => console.log('local verifier on http://127.0.0.1:8799'));

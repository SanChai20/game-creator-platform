// The runtime's scroll-keys fix in a real browser: a game in a frame on a page that scrolls (the player) is played with
// Space, the arrows, Page Down and End while its canvas (tabindex, so it holds the focus) has the keyboard. The page
// around it must not move in any engine (Firefox and Safari hand an unused Space or arrow to the page around a frame),
// the game's own listener must see each key as it came (not cancelled), and what a game page scrolls or types itself
// still works: a scrolling list, a text field, Space on a button.
// BROWSER=chromium|firefox|webkit (default chromium), HEADED=1 for a headed browser.   npm run test:scroll-keys
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let playwright; try { playwright = require('playwright'); } catch { playwright = require(join(process.env.NODE_PATH || '', 'playwright')); }
const SDK = readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url));
const CFG = '<script>window.__GCP_CONFIG={api:"",token:"",gameId:"t",version:1,env:"live",base:"",player:{id:"p",name:"P"},kind:"player",session:"s"}</script><script src="/sdk/gcp.js"></script>';
const pages = {
  // the player: a store page that scrolls, the game in a frame on another origin
  '/player.html': (q) => `<!doctype html><body style="margin:0"><iframe id="f" src="http://localhost:${PORT}/${q.get('g')}.html" style="display:block;width:800px;height:450px;border:0"></iframe><div style="height:4000px"></div></body>`,
  // a canvas game that cancels its keys only when they reach <body> (what Bloomguard did)
  '/canvas.html': () => `<!doctype html><html><head><style>html,body{margin:0;height:100%;overflow:hidden}canvas{display:block;width:100%;height:100%}</style>${CFG}</head><body>
    <canvas id="view" tabindex="0"></canvas><script>window.seen=[];addEventListener('keydown',function(e){if(e.key!=='Shift')seen.push(e.defaultPrevented);if(e.code==='Space'&&e.target===document.body)e.preventDefault();});</script></body></html>`,
  // a game page with its own scrolling list, a text field and a button
  '/menu.html': () => `<!doctype html><html><head><style>html,body{margin:0;height:100%;overflow:hidden}#list{position:absolute;left:0;top:0;width:300px;height:200px;overflow:auto}#list div{height:40px}</style>${CFG}</head><body>
    <div id="list" tabindex="0"></div><input id="name" style="position:absolute;left:400px;top:10px"><button id="btn" style="position:absolute;left:400px;top:60px">Go</button>
    <script>for(var i=0;i<30;i++){var d=document.createElement('div');d.textContent='row '+i;list.appendChild(d)}window.clicks=0;btn.onclick=function(){clicks++};</script></body></html>`,
};
let PORT = 0;
const server = await new Promise((ok) => { const s = createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/sdk/gcp.js') { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end(SDK); }
  const page = pages[u.pathname]; if (!page) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': 'text/html' }); r.end(page(u.searchParams));
}).listen(0, '127.0.0.1', () => { PORT = s.address().port; ok(s); }); });

const name = process.env.BROWSER || 'chromium';
const browser = await playwright[name].launch({ headless: !process.env.HEADED });
let failed = 0;
async function check(label, fn) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  try { await fn(page); console.log('ok   ' + label); } catch (e) { failed++; console.log('FAIL ' + label + '\n     ' + e.message.split('\n')[0]); } finally { await page.close(); }
}
const open = async (page, g) => { await page.goto(`http://127.0.0.1:${PORT}/player.html?g=${g}`); const f = page.frames()[1] || (await page.waitForEvent('frameattached')); await f.waitForLoadState(); await page.waitForTimeout(300); return f; };

await check(`${name}: keys played on a focused canvas leave the page around the game where it is`, async (page) => {
  const f = await open(page, 'canvas');
  assert.equal(await f.evaluate(() => GCP.runtime.fixes.includes('scroll-keys')), true, 'scroll-keys is listed as active');
  await f.click('#view'); assert.equal(await f.evaluate(() => document.activeElement.id), 'view');
  for (const key of ['Space', 'ArrowDown', 'ArrowRight', 'PageDown', 'End', 'Shift+Space']) {
    await page.evaluate(() => scrollTo(0, 0)); await page.keyboard.press(key); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => scrollY), 0, key + ' scrolled the page around the game');
  }
  assert.deepEqual(await f.evaluate(() => seen), [false, false, false, false, false, false], 'the game saw every key uncancelled');
});

await check(`${name}: a list, a text field and a button in the game page keep their keys`, async (page) => {
  const f = await open(page, 'menu');
  await f.click('#list'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space'); await page.waitForTimeout(400);
  assert.ok(await f.evaluate(() => list.scrollTop) > 0, 'the list scrolled');
  await f.evaluate(() => { list.scrollTop = 1e6; }); await page.keyboard.press('Space'); await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => scrollY), 0, 'a list at its end does not hand Space to the page');
  await f.click('#name'); await page.keyboard.type('a b');
  assert.equal(await f.evaluate(() => document.getElementById('name').value), 'a b', 'Space types in a text field');
  await f.focus('#btn'); await page.keyboard.press('Space'); await page.waitForTimeout(100);
  assert.equal(await f.evaluate(() => clicks), 1, 'Space presses a focused button');
  assert.equal(await page.evaluate(() => scrollY), 0);
});

await browser.close(); server.close();
if (failed) { console.log(failed + ' failed'); process.exit(1); }

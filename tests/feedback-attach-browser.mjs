// Feedback with attached pictures, in a real browser against a running platform (npm run dev + scripts/local-verifier.mjs):
// a creator opens the preview in the console, captures it, marks the screenshot, attaches pictures of their own (chosen
// with the file picker, pasted and dropped), marks one of them, removes one, sends the item, sees it in the queue, and
// their agent reads it with creator_feedback: every picture, in order, with its marks.
//   BASE=http://127.0.0.1:8787 node tests/feedback-attach-browser.mjs
//   BROWSER=firefox | webkit, DEVICE="iPad Pro 11" (any Playwright device), SHOTS=<folder for screenshots>
// The console opens with a creator license: locally, WRANGLER_CONFIG=<wrangler config of the dev server> lets the test
// give its throwaway account one (and clear sign-up rate limits) in the local D1.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { signUp } from './live-auth.mjs';

const require = createRequire(import.meta.url);
let playwright; try { playwright = require('playwright'); } catch { playwright = require(join(process.env.NODE_PATH || '', 'playwright')); }
const BASE = process.env.BASE || 'http://127.0.0.1:8787', BROWSER = process.env.BROWSER || 'chromium', DEVICE = process.env.DEVICE || '';
const SHOTS = process.env.SHOTS || '', tag = `${BROWSER}${DEVICE ? '-' + DEVICE.replace(/\W+/g, '-').toLowerCase() : ''}`;
const run = randomBytes(3).toString('hex'), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`  ✓ [${tag}] ${m}`);
const tplDir = new URL('../web/public/templates/', import.meta.url);
const blankFiles = JSON.parse(readFileSync(new URL('index.json', tplDir), 'utf8')).templates.find((x) => x.name === 'blank').files
  .map((f) => ({ path: f.path, content: readFileSync(new URL(`blank/${f.path}`, tplDir), 'utf8') }));

// ---- a creator, their agent (OAuth) and a verified preview
const jar = new Map();
const call = async (method, path, body, extra = {}) => {
  const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { ...(body && !extra.raw ? { 'content-type': 'application/json' } : {}), origin: BASE, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(extra.headers || {}) }, body: extra.raw ? body : body ? JSON.stringify(body) : undefined });
  for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, headers: r.headers };
};
const must = (r, code = 200) => { assert.equal(r.status, code, `expected ${code}, got ${r.status}: ${r.text.slice(0, 300)}`); return r.json; };
const form = { raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } };
const d1 = (sql) => execFileSync('npx', ['wrangler', 'd1', 'execute', 'gcp-db', '--local', '-c', process.env.WRANGLER_CONFIG, '--command', sql], { stdio: 'ignore' });
if (process.env.WRANGLER_CONFIG) d1('DELETE FROM rate_limits');
const email = `fb-attach-${run}@example.com`;
await signUp(BASE, (p, b, h) => call('POST', p, b, { headers: h }), email, 'Attach ' + run);
if (process.env.WRANGLER_CONFIG) d1(`UPDATE users SET creator = 1, creator_plan = 'lifetime' WHERE email = '${email}'`);
const reg = must(await call('POST', '/oauth/register', { client_name: 'Attach test', redirect_uris: ['http://127.0.0.1:9999/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }), 201);
const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9999/cb', scope: 'games', state: 's', code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp` });
const consent = await call('GET', '/authorize?' + q);
const handle = consent.text.match(/name="handle" value="([^"]+)"/)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
const approve = await call('POST', '/authorize?' + q, new URLSearchParams({ handle, decision: 'approve' }).toString(), form);
const tok = must(await call('POST', '/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: new URL(approve.headers.get('location')).searchParams.get('code'), redirect_uri: 'http://127.0.0.1:9999/cb', client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }).toString(), form));
let rpcId = 0;
async function ok(name, args = {}) {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const j = await r.json(); assert.ok(!j.error && !j.result.isError, `${name}: ${JSON.stringify(j).slice(0, 400)}`);
  const text = j.result.content[0].text; let data = text; try { data = JSON.parse(text); } catch { /* plain text */ }
  return { data, images: j.result.content.filter((x) => x.type === 'image') };
}
const { data: proj } = await ok('create_project', { title: 'Attach ' + run });
const pid = proj.project?.id || proj.id || proj.project;
await ok('upload_files', { project: pid, files: blankFiles });
let { data: dep } = await ok('deploy_preview', { project: pid, note: 'attach test' });
for (let i = 0; i < 20 && dep.not_finished; i++) { await sleep(3000); dep = (await ok('list_versions', { project: pid, version: dep.version })).data; }
assert.equal(dep.status, 'verified', JSON.stringify(dep).slice(0, 300));
step(`preview v${dep.version} verified`);

// ---- the browser, signed in as the creator
const type = playwright[BROWSER];
const browser = await type.launch(BROWSER === 'chromium' ? { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {});
const device = DEVICE ? { ...playwright.devices[DEVICE] } : { viewport: { width: 1280, height: 900 } };
if (BROWSER === 'firefox') delete device.isMobile;   // Firefox cannot emulate a mobile viewport
const ctx = await browser.newContext({ ...device, deviceScaleFactor: 1 });
await ctx.addCookies([{ name: 'gcp_session', value: jar.get('gcp_session'), url: BASE }]);
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e.message || e)));
const shot = async (name) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${tag}-${name}.png`) }); } };

// pictures of the creator's own, made by the browser: a transparent PNG mockup, a large camera-sized JPEG, two small ones
const files = await page.evaluate(() => {
  const make = (w, h, kind, paint) => { const c = document.createElement('canvas'); c.width = w; c.height = h; paint(c.getContext('2d'), w, h); return c.toDataURL(kind, 0.95).split(',')[1]; };
  return {
    mockup: make(1200, 800, 'image/png', (g, w, h) => { g.fillStyle = '#2a6cf0'; g.fillRect(w * 0.25, h * 0.25, w * 0.5, h * 0.5); g.fillStyle = '#fff'; g.font = '80px sans-serif'; g.fillText('MENU', w * 0.36, h * 0.55); }),
    photo: make(4032, 3024, 'image/jpeg', (g, w, h) => { for (let i = 0; i < 400; i++) { g.fillStyle = `hsl(${(i * 37) % 360} 70% 50%)`; g.fillRect((i * 97) % w, (i * 53) % h, 300, 200); } }),
    pasted: make(600, 400, 'image/png', (g, w, h) => { g.fillStyle = '#16a34a'; g.fillRect(0, 0, w, h); }),
    dropped: make(500, 500, 'image/jpeg', (g, w, h) => { g.fillStyle = '#f59e0b'; g.fillRect(0, 0, w, h); }),
  };
});
const dir = mkdtempSync(join(tmpdir(), 'fb-attach-'));
writeFileSync(join(dir, 'menu-mockup.png'), Buffer.from(files.mockup, 'base64'));
writeFileSync(join(dir, 'IMG_0042.jpg'), Buffer.from(files.photo, 'base64'));

await page.goto(`${BASE}/console/p/${pid}`);
await page.getByRole('button', { name: /Play preview/ }).click({ timeout: 20000 }).catch(async (e) => { console.log((await page.innerText('body')).slice(0, 800)); throw e; });
await page.locator('iframe').first().waitFor();
await sleep(2500);   // the game starts
await page.getByRole('button', { name: 'Capture feedback' }).first().click();
const editor = page.locator('.fb-editor');
await editor.waitFor({ timeout: 20000 });
await sleep(300);
step('preview captured; the editor is open');

// draw on a picture: a drag with the mouse, or a tap on a touch screen
const canvas = editor.locator('canvas.fb-canvas');
async function mark(fx, fy, fw, fh) {
  const b = await canvas.boundingBox();
  if (DEVICE && device.hasTouch) { await page.touchscreen.tap(b.x + b.width * fx, b.y + b.height * fy); return; }
  await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy); await page.mouse.down();
  await page.mouse.move(b.x + b.width * (fx + fw), b.y + b.height * (fy + fh), { steps: 6 }); await page.mouse.up();
}
await mark(0.2, 0.2, 0.3, 0.3);
await editor.locator('.fb-mark').first().waitFor();
// a move and the release in the same frame (a quick flick; Edge on Windows does this often): the editor keeps working
await canvas.evaluate((c) => {
  const r = c.getBoundingClientRect(), o = { pointerId: 7, pointerType: 'mouse', isPrimary: true, bubbles: true, button: 0, buttons: 1 };
  const at = (fx, fy) => ({ ...o, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy });
  c.dispatchEvent(new PointerEvent('pointerdown', at(0.6, 0.6)));
  for (let i = 1; i <= 5; i++) c.dispatchEvent(new PointerEvent('pointermove', at(0.6 + i * 0.03, 0.6 + i * 0.02)));
  c.dispatchEvent(new PointerEvent('pointerup', { ...at(0.75, 0.7), buttons: 0 }));
});
await page.waitForFunction(() => document.querySelectorAll('.fb-mark').length === 2);
await editor.getByRole('button', { name: 'Undo' }).click();
await page.waitForFunction(() => document.querySelectorAll('.fb-mark').length === 1);
step('a mark on the screenshot; a flick (move and release in one frame) marks too, and undo');

// attach two with the file picker
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), editor.getByRole('button', { name: /Attach images/ }).click()]);
assert.equal(chooser.isMultiple(), true);
await chooser.setFiles([join(dir, 'menu-mockup.png'), join(dir, 'IMG_0042.jpg')]);
await page.waitForFunction(() => document.querySelectorAll('.fb-pic').length === 3);
assert.equal(await editor.locator('.fb-pic.on .fb-pic-label').innerText(), 'Image 1');
await editor.getByRole('tab', { name: /Image 1/ }).click();
await sleep(200);
// the box tool on the mockup
await editor.getByRole('tab', { name: 'Box', exact: true }).click();
await mark(0.25, 0.25, 0.5, 0.5);
await editor.locator('.fb-mark input').first().fill('make the menu this blue panel');
await shot('editor-attachment-marked');
step('two pictures attached with the file picker; the mockup marked');

// paste one, drop one
await page.evaluate((b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), dt = new DataTransfer();
  dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
  const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  // WebKit ignores clipboardData in the constructor
  if (!e.clipboardData) Object.defineProperty(e, 'clipboardData', { value: dt });
  document.body.dispatchEvent(e);
}, files.pasted);
await page.waitForFunction(() => document.querySelectorAll('.fb-pic').length === 4);
await page.evaluate((b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), dt = new DataTransfer();
  dt.items.add(new File([bytes], 'dropped.jpg', { type: 'image/jpeg' }));
  const el = document.querySelector('.fb-editor');
  for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
}, files.dropped);
await page.waitForFunction(() => document.querySelectorAll('.fb-pic').length === 5);
assert.equal(await editor.locator('.fb-pic-add').count(), 0, 'no more than four attached');
assert.equal(await page.locator('.fb-drop').count(), 0, 'the drop hint is gone after the drop');
await shot('editor-four-attached');
// pasting text into the note stays text
await editor.locator('textarea').click();
await editor.locator('textarea').fill('Make the menu look like my mockup; the photo shows the colours.');
step('one pasted, one dropped (four attached, the most); the note written');

// remove the pasted one (Image 3)
await editor.getByRole('button', { name: 'Remove Image 3' }).click();
await page.waitForFunction(() => document.querySelectorAll('.fb-pic').length === 4);
// labels, each followed by its number of marks when it has some
const labels = await editor.locator('.fb-pic-label').evaluateAll((els) => els.map((e) => [e.firstChild.textContent, e.querySelector('.fb-num')?.textContent || '']));
assert.deepEqual(labels, [['Screenshot', '1'], ['Image 1', '1'], ['Image 2', ''], ['Image 3', '']]);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px`);
step('one removed; the rest renumbered; no sideways scrolling');

// send
const sent = page.waitForResponse((r) => r.url().endsWith(`/feedback`) && r.request().method() === 'POST');
await editor.getByRole('button', { name: 'Add to queue' }).click();
const res = await sent;
assert.equal(res.status(), 200, await res.text());
const reqBytes = (res.request().postData() || '').length;
await editor.waitFor({ state: 'detached', timeout: 20000 });
step(`sent (${Math.round(reqBytes / 1024)} KB)`);

// the queue on the project page shows the item with its pictures
await page.getByRole('button', { name: 'Close' }).first().click();
const item = page.locator('.fb-item').first();
await item.waitFor({ timeout: 20000 });
assert.equal(await item.locator('.fb-thumb').count(), 4);
await item.locator('.fb-thumb').nth(1).click();
await page.waitForFunction(() => { const i = document.querySelector('.fb-full'); return i && i.complete && i.naturalWidth > 0; });
assert.match(await item.innerText(), /Image 1 \(menu-mockup\.png\): 1\. Box: make the menu this blue panel/);
await item.scrollIntoViewIfNeeded(); await shot('queue');
step('the queue shows the item with its four pictures; an attached one opens');

// the agent reads it
const r = await ok('creator_feedback', { project: pid });
assert.equal(r.data.taken, 1); assert.equal(r.images.length, 4);
const [it] = r.data.items;
assert.equal(it.marks.length, 1);
assert.deepEqual(it.attached_pictures.map((a) => a.file), ['menu-mockup.png', 'IMG_0042.jpg', 'dropped.jpg']);
assert.match(it.attached_pictures[0].marks[0], /^1\. box .*"make the menu this blue panel"$/);
assert.equal(it.attached_pictures[1].marks, undefined);
const total = r.images.reduce((n, x) => n + Buffer.from(x.data, 'base64').length, 0);
assert.ok(total <= 3_000_000, `pictures add up to ${total} bytes`);
// the mockup's clear background came out white, not black; the camera photo was made smaller
const px = await page.evaluate(async ([a, b]) => {
  const load = (d) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = 'data:image/jpeg;base64,' + d; });
  const [m, p] = [await load(a), await load(b)]; const c = document.createElement('canvas'); c.width = m.naturalWidth; c.height = m.naturalHeight;
  const g = c.getContext('2d'); g.drawImage(m, 0, 0); return { corner: [...g.getImageData(3, 3, 1, 1).data].slice(0, 3), mockup: [m.naturalWidth, m.naturalHeight], photo: [p.naturalWidth, p.naturalHeight] };
}, [r.images[1].data, r.images[2].data]);
assert.ok(px.corner.every((v) => v > 240), `the mockup's clear corner is ${px.corner}`);
assert.deepEqual(px.mockup, [1200, 800]); assert.deepEqual(px.photo, [1600, 1200]);
step(`creator_feedback: 4 pictures in order (${Math.round(total / 1024)} KB), marks on the mockup, clear parts white, the photo made smaller`);
assert.deepEqual(errors, [], 'no uncaught errors in the page');
await browser.close();
console.log(`OK [${tag}] (project ${pid})`);

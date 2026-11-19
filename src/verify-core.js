// The playability check. Runs against a Puppeteer or Playwright `page` (their APIs match for what is
// used here), so the same code runs in Cloudflare Browser Rendering and in local tests.
//
// A version passes when the deployed build, opened in a real browser:
//   1. serves its document and every file it asks for          (deployed)
//   2. calls GCP.ready() in time without GCP.fatal()           (boots)
//   3. keeps rendering frames after ready                      (renders)
//   4. draws something other than a flat colour                (picture)
//   5. keeps rendering after keyboard, mouse and touch input   (input)
//   6. throws no uncaught errors during all of the above       (clean)
import { craftReview, decodePng, imageMetrics, motionBetween } from './craft-review.js';

/** Decodes an 8-bit RGB/RGBA PNG and summarises it. `img` is the decoded picture, kept for the craft review. */
export function pngStats(buf) {
  const img = decodePng(buf);
  if (!img) return { w: 0, h: 0, ok: false, top: 1, other: 0, colors: 0, hash: '', img: null };
  const { w, h, bpp, stride, px } = img;
  // Share of the most common colour, number of distinct coarse colours, and a coarse layout hash.
  const counts = new Uint32Array(32768), cells = new Uint32Array(64), cellN = new Uint32Array(64), n = w * h;
  for (let y = 0; y < h; y++) {
    const cy = Math.min(7, (y * 8 / h) | 0) * 8;
    for (let x = 0; x < w; x++) {
      const i = y * stride + x * bpp;
      counts[((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3)]++;
      const cell = cy + Math.min(7, (x * 8 / w) | 0); cells[cell] += px[i] + px[i + 1] + px[i + 2]; cellN[cell]++;
    }
  }
  let top = 0, colors = 0; for (let i = 0; i < 32768; i++) { if (counts[i]) colors++; if (counts[i] > top) top = counts[i]; }
  let hash = ''; for (let i = 0; i < 64; i++) hash += ((cells[i] / Math.max(1, cellN[i]) / 48) | 0).toString(16);
  return { w, h, ok: true, top: top / n, other: n - top, colors, hash, img };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = (page) => page.evaluate(() => {
  const s = window.__GCP; if (!s) return null;
  const c = document.querySelector('canvas');
  return { ready: s.ready, loadMs: s.ready ? Math.round(s.readyAt - s.boot) : 0, frames: s.frames, fatal: s.fatal, errors: s.errors.slice(), warnings: s.warnings.slice(0, 8), missing: s.missing.slice(),
    progress: s.progress, label: s.label, stats: s.stats, canvas: c ? { w: c.width, h: c.height } : null,
    caps: { webgl2: !!document.createElement('canvas').getContext('webgl2'), webgpu: !!navigator.gpu } };
});

/** Whether the game is still on a loading screen: it said so with GCP.progress(f < 1) after ready(), or an opaque element
 *  that does not hold the canvas covers most of the screen (a loading or title overlay). Pages without a canvas never are. */
const covered = (page) => page.evaluate(() => {
  const s = window.__GCP; if (s && s.busy) return 'loading' + (s.label ? ` ("${s.label}")` : '');
  const canvases = [...document.querySelectorAll('canvas')]; if (!canvases.length) return '';
  const vw = innerWidth, vh = innerHeight, area = vw * vh; let n = 0;
  for (const el of document.body.getElementsByTagName('*')) {
    if (++n > 4000) break;
    if (el.tagName === 'CANVAS' || canvases.some((c) => el.contains(c))) continue;
    const r = el.getBoundingClientRect(), w = Math.min(r.right, vw) - Math.max(r.left, 0), h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    if (w <= 0 || h <= 0 || w * h < area * 0.6) continue;
    const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    let op = 1; for (let e = el; e && e !== document.documentElement; e = e.parentElement) op *= +getComputedStyle(e).opacity;
    if (op < 0.5) continue;
    const a = cs.backgroundColor.match(/[\d.]+/g), alpha = !a ? 0 : a.length > 3 ? +a[3] : 1;
    if (alpha >= 0.6 || cs.backgroundImage !== 'none') return 'covered by ' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
  }
  return '';
}).catch(() => '');

/** Visible text elements on the page: the HUD, hints, menus. */
const uiState = (page) => page.evaluate(() => {
  let texts = 0, chars = 0, sample = ''; const seen = new Set(), w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) {
    const t = w.currentNode.nodeValue.trim(), el = w.currentNode.parentElement;
    if (!t || !el || seen.has(el) || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity < 0.05) continue;
    seen.add(el); texts++; chars += t.length; if (sample.length < 1500) sample += t.slice(0, 300) + ' ';
  }
  // what a player can act on without a canvas (DOM games), and password fields (a game never needs one for the platform)
  const shown = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity >= 0.05; };
  const controls = [...document.querySelectorAll('button, a[href], input, select, textarea, [onclick], [role="button"], [tabindex]')].filter(shown).length;
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(shown).length;
  return { texts, chars, controls, passwords, changes: window.__gcpChanges ? window.__gcpChanges() : 0, text: sample.trim().slice(0, 1500) };
}).catch(() => ({ texts: 0, chars: 0, controls: 0, passwords: 0, changes: 0, text: '' }));

/** Share of pixels that differ clearly between two decoded pictures of the same size (0..1). */
export function pixelChange(a, b) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return 0;
  let n = 0, all = 0;
  for (let y = 0; y < a.h; y += 2) for (let x = 0; x < a.w; x += 2) {
    const i = y * a.stride + x * a.bpp, j = y * b.stride + x * b.bpp; all++;
    if (Math.abs(a.px[i] - b.px[j]) + Math.abs(a.px[i + 1] - b.px[j + 1]) + Math.abs(a.px[i + 2] - b.px[j + 2]) > 36) n++;
  }
  return all ? n / all : 0;
}

/** A touch tap that works in Puppeteer and, through a raw protocol session, in Playwright without touch emulation. */
async function tap(page, x, y) {
  try { await page.touchscreen.tap(x, y); return; } catch { /* Playwright without hasTouch */ }
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } catch { /* this browser cannot send touch events */ }
}

/**
 * @param page   Puppeteer/Playwright page (fresh, viewport ~960x540)
 * @param url    game URL including the play token
 * @param opts   { readyTimeoutS, minFrames, observeS, usesWebGPU, log, openPage, guestUrl (the game URL with a second verifier's play token, for the two-player check's guest) }
 */
/**
 * Opens the game in two more pages that meet in one room (host first, then guest) and runs the function the game gave to
 * GCP.test.onTwoPlayers in both at once. Passes when both finish, each sees at least two players and both return the same
 * world string. openPage() -> a new page of the same browser. Returns { ok, detail, host, guest } or { skipped: why }.
 */
export async function twoPlayerCheck(openPage, url, { limitS = 45, readyTimeoutS = 30, guestUrl = '' } = {}) {
  const code = 'V' + Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join(''), pages = [];
  // The guest plays under a verifier identity of its own (guestUrl carries its play token): a server-run match seats players
  // by identity, so two pages of one identity would be one player whose second tab takes the first one's place.
  const addr = (role) => { const u = role === 'guest' && guestUrl ? guestUrl : url;
    return u + (u.includes('?') ? '&' : '?') + (/[?&]gcp_autostart=/.test(u) ? '' : 'gcp_autostart=1&') + 'gcp_two=' + role + '&gcp_room=' + code; };
  const boot = async (role) => { const p = await openPage(); pages.push(p); p.on('dialog', (d) => { d.dismiss().catch(() => {}); }); await p.goto(addr(role), { waitUntil: 'domcontentloaded', timeout: 45000 });
    const t0 = Date.now(); let s = null; while (Date.now() - t0 < readyTimeoutS * 1000) { s = await state(p).catch(() => null); if (s && (s.ready || s.fatal)) break; await sleep(250); }
    if (!s || !s.ready || s.fatal) throw new Error(`the ${role} page did not start` + (s && s.fatal ? ': ' + String(s.fatal).slice(0, 160) : '')); return p; };
  try {
    let host, guest;
    try { host = await boot('host'); await sleep(1200); guest = await boot('guest'); } catch (e) { return { skipped: String(e && e.message || e).slice(0, 240) }; }
    const run = (p, role) => Promise.race([
      p.evaluate((ms) => window.__GCP.runTwoPlayers(ms), limitS * 1000).catch((e) => ({ ran: true, ok: false, error: `The ${role} page reloaded or closed: ` + String(e && e.message || e).slice(0, 160), steps: [], result: null })),
      sleep(limitS * 1000 + 5000).then(() => ({ ran: true, ok: false, error: `The ${role} did not finish within ${limitS} s.`, steps: [], result: null })),
    ]);
    // only one page of a browser is in front, and a page behind draws no frames: keep both awake and take turns in front
    for (const p of pages) { try { const cdp = p.createCDPSession ? await p.createCDPSession() : await p.context().newCDPSession(p); await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch { /* not every browser */ } }
    let turn = 0; const swap = setInterval(() => { const p = pages[turn++ % pages.length]; if (p && p.bringToFront) p.bringToFront().catch(() => {}); }, 700);
    const [a, b] = await Promise.all([run(host, 'host'), run(guest, 'guest')]).finally(() => clearInterval(swap));
    // what each side's room saw, whatever the outcome: its id, who it knew was there, and how many changes reached it
    // (a game plays online through a relay room, GCP.room, or a server-run match, GCP.match.find: whichever it opened is described)
    const lastOf = (p, what) => p.evaluate((w) => (window.__GCP && window.__GCP[w] ? window.__GCP[w]() : []), what).then((l) => (Array.isArray(l) && l[l.length - 1]) || null).catch(() => null);
    const [ra, rb, ma, mb] = await Promise.all([lastOf(host, 'roomInfo'), lastOf(guest, 'roomInfo'), lastOf(host, 'matchInfo'), lastOf(guest, 'matchInfo')]);
    const sides = ` · ${twoPlayerSide('Host', ra, ma)} · ${twoPlayerSide('Guest', rb, mb)}.`;
    const brief = (r) => ({ ok: !!r.ok, error: r.error || '', steps: r.steps || [], players: r.result && r.result.players, world: r.result && typeof r.result.world === 'string' ? r.result.world.slice(0, 2000) : null });
    const H = brief(a), G = brief(b), saw = H.players >= 2 && G.players >= 2, same = H.world != null && H.world === G.world, ok = H.ok && G.ok && saw && same;
    const last = (r) => (r.steps.length ? ` (during "${r.steps[r.steps.length - 1]}")` : '');
    const detail = ok ? `Host and guest met in one ${(ma && !ra) || (mb && !rb) ? 'match' : 'room'}, each saw ${Math.min(H.players, G.players)} players, and their worlds agree after both changed it.`
      : !H.ok ? `The host failed: ${H.error}${last(H)}` : !G.ok ? `The guest failed: ${G.error}${last(G)}` : !saw ? `The host saw ${H.players || 0} player(s) and the guest ${G.players || 0}: each must see both.`
        : H.world == null || G.world == null ? 'The function must return { players, world } with world a string.' : 'The two worlds differ. Host: ' + H.world.slice(0, 200) + ' · Guest: ' + G.world.slice(0, 200);
    return { ok, detail: ok ? detail : detail + sides, host: { ok: H.ok, error: H.error, steps: H.steps, players: H.players, room: ra, match: ma }, guest: { ok: G.ok, error: G.error, steps: G.steps, players: G.players, room: rb, match: mb } };
  } finally { for (const p of pages) { try { await p.close(); } catch { /* gone */ } } }
}

/** One page's side of a failed two-player check: the room (GCP.room) or match (GCP.match.find) it opened and what reached it. */
export function twoPlayerSide(name, r, m) {
  const parts = [];
  if (r) {
    const others = (r.peers || []).filter((id) => id !== r.id);
    parts.push(`room id ${r.id || 'none (never connected)'}${r.isHost ? ' (host)' : ''}, saw ${others.length ? 'peer ' + others.join(', ') : 'no other peer'} in the room, received ${r.world_ops} world change(s), ${r.states} world snapshot(s) and ${r.messages} message(s)${r.closes ? `, lost the connection ${r.closes} time(s)` : ''}`);
  }
  if (m) {
    const lobby = (m.lobby || []).filter(Boolean), players = (m.players || []).filter(Boolean);
    parts.push(`match ${m.match || '(none found)'}${m.code ? ` from lobby ${m.code}` : ''}, phase ${m.phase || 'unknown'}, player id ${m.you || 'unknown'}`
      + (lobby.length ? `, the lobby listed ${lobby.join(', ')}` : '') + (players.length ? `, the match has ${players.join(', ')}` : '')
      + `, received ${m.snapshots || 0} snapshot(s)` + (m.closes ? `, lost the connection ${m.closes} time(s)` : '') + (m.error ? `, error ${m.error}` : ''));
  }
  return `${name}: ` + (parts.length ? parts.join('; ') : 'opened no room and found no match (neither GCP.room nor GCP.match.find was called)');
}

export async function verifyPage(page, url, opts = {}) {
  const o = { readyTimeoutS: 30, minFrames: 6, observeS: 3, playthroughS: 30, usesWebGPU: false, ...opts };
  const checks = [], pageErrors = [], badResponses = [];
  const add = (id, ok, label, detail = '', hint = '') => checks.push({ id, ok, label, detail, hint });
  page.on('pageerror', (e) => { if (pageErrors.length < 20) pageErrors.push(String(e && (e.message || e)).slice(0, 500)); });
  // Calls to the game's own server code (GCP.server, /api/* next to the game) are not files: a failure there is the server
  // code's, reported by the "server" check with what it threw, instead of as a missing file.
  const serverErrors = [], apiBase = (() => { try { const u = new URL(url); return { host: u.host, path: u.pathname.replace(/[^/]*$/, '') + 'api/' }; } catch { return null; } })();
  const sameHost = (u) => { try { return !!apiBase && new URL(u).host === apiBase.host; } catch { return false; } };
  const unsettled = [];   // the game's own files that answered 5xx or failed during the current load: the deploy may still be settling
  const isServerCall = (r) => { try { if (r.headers()['x-gcp-server-error']) return true; const u = new URL(r.url()); return !!apiBase && u.host === apiBase.host && u.pathname.startsWith(apiBase.path); } catch { return false; } };
  page.on('response', (r) => { try {
    const s = r.status(); if (s < 400 || /favicon\.ico/.test(r.url())) return;
    if (isServerCall(r)) {
      if (serverErrors.length >= 10) return;
      const e = { status: s, path: (() => { try { return new URL(r.url()).pathname.slice(apiBase.path.length - 'api/'.length - 1); } catch { return r.url().split('?')[0]; } })(), message: '', stack: [] };
      serverErrors.push(e);
      e.read = r.text().then((t) => { try { const j = JSON.parse(t); e.message = String(j.message || j.error || '').slice(0, 300); e.stack = Array.isArray(j.stack) ? j.stack.slice(0, 3).map((l) => String(l).slice(0, 200)) : []; } catch { e.message = /\b1101\b|threw exception/i.test(t) ? 'The Worker threw an exception outside the request (for example in a promise that was not awaited).' : String(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200); } }).catch(() => {});
      return;
    }
    if (s >= 500 && sameHost(r.url())) unsettled.push(`${s} ${r.url().split('?')[0]}`);
    if (badResponses.length < 20) badResponses.push(`${s} ${r.url().split('?')[0]}`);
  } catch { /* detached */ } });
  // A file of the game's own that failed outright (no response at all), e.g. src/main.js on an edge still taking the deploy.
  page.on('requestfailed', (r) => { try {
    if (!sameHost(r.url()) || r.resourceType() === 'media' || (apiBase && new URL(r.url()).pathname.startsWith(apiBase.path))) return;
    const why = String((r.failure() && r.failure().errorText) || 'failed');
    if (!/ABORTED|cancel/i.test(why)) unsettled.push(`${why} ${r.url().split('?')[0]}`);
  } catch { /* detached */ } });
  // What the page does to the player's browser, besides the game: other sites it talks to, windows, downloads, dialogs,
  // navigation away. Read by the conduct check below and by the content check (src/content-check.js).
  const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
  const own = new Set([hostOf(url), ...(o.platformOrigin ? [hostOf(o.platformOrigin)] : [])].filter(Boolean));
  const token = (() => { try { return new URL(url).searchParams.get('gcp_t') || ''; } catch { return ''; } })();
  const conduct = { external: [], popups: [], downloads: [], navigations: [], dialogs: 0, workers: 0, passwordFields: 0 };
  const outside = (u, type, method) => { const h = hostOf(u); if (!h || own.has(h) || !/^(https?|wss?):/.test(u)) return; if (conduct.external.length < 40 && !conduct.external.some((x) => x.host === h && x.type === type && x.method === method)) conduct.external.push({ host: h, type, method }); };
  page.on('dialog', (d) => { conduct.dialogs++; d.dismiss().catch(() => {}); });
  page.on('request', (r) => { try {
    outside(r.url(), r.resourceType(), r.method());
    // the player's play token (it signs them in to this game's saves and rooms) must never reach another site
    if (token && !conduct.tokenSent && !own.has(hostOf(r.url())) && (r.url().includes(token) || String(r.postData() || '').includes(token))) conduct.tokenSent = hostOf(r.url());
    // the top page asking for a document on another site is leaving, even when that site never answers
    if (r.resourceType() === 'document' && r.frame() === page.mainFrame() && /^https?:/.test(r.url()) && !own.has(hostOf(r.url())) && conduct.navigations.length < 5) conduct.navigations.push(r.url().slice(0, 200));
  } catch { /* detached */ } });
  page.on('popup', (p) => { try { conduct.popups.push(String(p.url()).slice(0, 200)); p.close().catch(() => {}); } catch { /* gone */ } });
  page.on('worker', () => { conduct.workers++; });          // Playwright
  page.on('workercreated', () => { conduct.workers++; });   // Puppeteer
  page.on('download', (d) => { try { conduct.downloads.push(String(d.suggestedFilename()).slice(0, 120)); d.cancel && d.cancel().catch(() => {}); } catch { /* gone */ } });
  page.on('framenavigated', (f) => { try { if (f === page.mainFrame() && !own.has(hostOf(f.url())) && /^https?:/.test(f.url()) && conduct.navigations.length < 5) conduct.navigations.push(f.url().slice(0, 200)); } catch { /* detached */ } });
  try {
    const cdp = page.createCDPSession ? await page.createCDPSession() : await page.context().newCDPSession(page);
    await cdp.send('Network.enable').catch(() => {}); await cdp.send('Page.enable').catch(() => {});
    cdp.on('Network.webSocketCreated', (e) => outside(e.url, 'websocket', 'WS'));
    // Puppeteer has no download event of its own; Playwright reports downloads above and here, so names are de-duplicated
    cdp.on('Page.downloadWillBegin', (e) => { const n = String(e.suggestedFilename || e.url || '').slice(0, 120); if (!conduct.downloads.includes(n)) conduct.downloads.push(n); });
  } catch { /* this browser has no protocol session */ }

  const report = { ok: false, summary: '', checks, metrics: {}, errors: [], warnings: [], missing: [], notes: [], caps: {}, gpuLimited: false, at: Date.now() };
  // A Worker that was deployed seconds ago can still be missing at some edge locations, so a 404 or 5xx gets a few more tries.
  // So does a document that loaded while some of the game's own files answered 5xx or failed outright: the deploy is not yet
  // served consistently, and the same files usually load a few seconds later. Only the last load counts against the game.
  const settle = () => page.evaluate(() => Promise.race([
    new Promise((r) => (document.readyState === 'complete' ? r() : addEventListener('load', () => r(), { once: true }))).then(() => document.fonts && document.fonts.ready),
    new Promise((r) => setTimeout(r, 8000)),
  ])).catch(() => {});
  let status = 0, navError = '', retried = [];
  const ATTEMPTS = 6;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) await sleep([0, 3000, 5000, 8000, 10000, 12000][attempt]);
    badResponses.length = 0; pageErrors.length = 0; unsettled.length = 0;   // earlier attempts do not count against the game
    try { const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); status = resp ? resp.status() : 0; navError = ''; }
    catch (e) { status = 0; navError = String(e && e.message || e); }
    if (status === 200) {
      await settle();
      if (unsettled.length && attempt < ATTEMPTS - 1) { retried = unsettled.slice(0, 3); continue; }
      break;
    }
    if (status >= 400 && status < 500 && status !== 404) break;
  }
  if (navError) { add('deployed', false, 'The deployed game responds', `Navigation failed: ${navError}`); report.summary = 'The deployed game did not load.'; return { report, shots: [], frames: [] }; }
  if (status === 200 && retried.length && !unsettled.length) report.notes.push(`The first loads right after the deploy had files that did not load yet (${retried.join('; ')}); a later load served everything.`);
  add('deployed', status === 200, 'The deployed game responds', `HTTP ${status}`, status === 200 ? '' : 'The preview Worker did not serve index.html.');
  if (status !== 200) { report.summary = `The game document returned HTTP ${status}.`; return { report, shots: [], frames: [] }; }

  // 2. boots
  const t0 = Date.now(); let s = null;
  while (Date.now() - t0 < o.readyTimeoutS * 1000) {
    s = await state(page).catch(() => null);
    if (s && (s.ready || s.fatal)) break;
    await sleep(250);
  }
  if (!s) { add('boots', false, 'The game boots', 'The platform SDK never loaded in the page.'); report.summary = 'The page did not run.'; return { report, shots: [], frames: [] }; }
  report.caps = s.caps;
  report.conduct = conduct;
  // count changes to the page from now on: a DOM game shows it is alive by changing when it is played
  await page.evaluate(() => { let n = 0; try { new MutationObserver((l) => { n += l.length; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); } catch { /* no DOM */ } Object.defineProperty(window, '__gcpChanges', { value: () => n }); }).catch(() => {});
  report.gpuLimited = !!o.usesWebGPU && !s.caps.webgpu;
  if (s.fatal) add('boots', false, 'The game boots', `GCP.fatal: ${s.fatal}`, report.gpuLimited ? 'The verification browser has no WebGPU. Add a WebGL fallback, or qualify this version by playing the preview yourself in a WebGPU browser.' : 'Fix the startup error and deploy a new preview.');
  else if (!s.ready) add('boots', false, 'The game boots', `GCP.ready() was not called within ${o.readyTimeoutS}s (progress ${Math.round(s.progress * 100)}%${s.label ? `, "${s.label}"` : ''}, ${s.frames} frames).`,
    s.errors.length || pageErrors.length ? 'An uncaught error stopped startup; see errors.' : 'Call GCP.ready() right after the first playable frame is drawn. If loading is slow, do less work before the first frame and keep generating in the background.');
  else add('boots', true, 'The game boots', `GCP.ready() after ${s.loadMs} ms`);

  const shots = [];
  // Frames for the content review (src/content-check.js): small JPEGs taken while the game starts, plays itself through and
  // takes input, so the review judges what a player actually sees, not only the first screen.
  const frames = [];
  const snap = async () => { if (frames.length >= 8) return; try { frames.push(await page.screenshot({ type: 'jpeg', quality: 60 })); } catch { /* page busy or gone */ } };
  const shoot = async () => { try { const b = await page.screenshot({ type: 'png' }); shots.push(b); return pngStats(b); } catch { return null; } };
  let pic1 = null, pic1Cover = '', pic2 = null, picIdle = null, f1 = 0, f2 = 0, observedS = o.observeS, inputS = 1.5, ui1 = null, ui2 = null, probeBeforeInput = null, restarted = false, domGame = false;
  if (s.ready && !s.fatal) {
    // 3. renders
    const a = await state(page); await sleep(o.observeS * 1000); let b = await state(page);
    f1 = b.frames - a.frames;
    // A heavy game on the verifier's software GPU can sit right at the threshold (2 fps one run, 1.7 the next). A loop that is
    // alive but slow gets up to two more windows to reach the frame count, so the check judges "frames advance", not speed.
    for (let k = 0; f1 > 0 && f1 < o.minFrames && k < 2; k++) { await sleep(o.observeS * 1000); b = await state(page); f1 = b.frames - a.frames; observedS += o.observeS; }
    // A page that never asked for an animation frame is event driven (cards, text, a board or canvas redrawn on clicks and keys):
    // it is alive when it responds, which the "responds" check below measures, not when it animates. A still picture fails there.
    domGame = b.frames === 0;
    if (domGame) add('renders', true, 'Frames keep rendering', 'No animation loop: the page changes when the player acts (see "Responds to the player").');
    else add('renders', f1 >= o.minFrames, 'Frames keep rendering', `${f1} frames in ${observedS}s (${(f1 / observedS).toFixed(1)} fps in the verification browser)${f1 >= o.minFrames && observedS > o.observeS ? '; slow on the software GPU, so the window was extended' : ''}`,
      f1 >= o.minFrames ? '' : f1 > 0 ? `Frames advance but too slowly in the verification browser (it has no GPU). Pick a lower quality level when the frame time is high (fewer redraws per frame, cache what does not change in an offscreen canvas), then deploy again. A version that only just missed can be checked again without a new number: deploy_preview {retry_version}.` : 'Drive the game from requestAnimationFrame and keep the loop alive even on menus. A software GPU runs this check, so heavy scenes should offer a lower quality level and pick it when the frame time is high.');
    // 4. picture
    pic1 = await shoot(); pic1Cover = await covered(page);
    const blank = !pic1 || !pic1.ok || pic1.other < 200 || pic1.colors < 2; // a flat screen; a sparse one (Pong) is fine
    add('picture', !blank, 'Something is drawn', pic1 ? `${pic1.colors} distinct colours; ${pic1.other} pixels differ from the background` : 'No screenshot',
      blank ? 'The screen is a single flat colour. Check the camera, lights, canvas size and that the render call runs each frame.' : '');
    // For the craft review: a second picture a moment later with nothing pressed (does anything move by itself?), and the HUD.
    await snap();
    await sleep(700); picIdle = await shoot(); ui1 = await uiState(page);
    // Browsers keep sound locked until the first real press. One click in the top-left corner pixel gives the page that press, as a
    // player's first key or tap would, so sounds played during the play-through are real and can be measured.
    try { await page.mouse.click(2, 2); await sleep(120); } catch { /* no pointer */ }
    // 4b. play-through: if the game registered one, it plays itself to the end and every step is reported.
    let play = null;
    try {
      play = await Promise.race([
        page.evaluate((ms) => (window.__GCP && window.__GCP.runPlaythrough ? window.__GCP.runPlaythrough(ms) : { ran: false }), o.playthroughS * 1000),
        sleep(o.playthroughS * 1000 + 5000).then(() => ({ ran: true, ok: false, error: `The play-through did not finish within ${o.playthroughS} s.`, steps: [], ms: o.playthroughS * 1000, frames: 0 })),
      ]);
    } catch (e) { play = { ran: true, ok: false, error: 'The page reloaded or closed during the play-through: ' + String(e && e.message || e).slice(0, 200), steps: [], ms: 0, frames: 0 }; }
    // where the play-through left the game (screenshots are not taken during it: they can stall frames in a slow browser)
    if (play && play.ran) await snap();
    if (play && play.ran) {
      const last = play.steps.length ? play.steps[play.steps.length - 1] : '';
      add('playthrough', !!play.ok, 'The game plays through', play.ok ? `${play.steps.length} step(s) in ${(play.ms / 1000).toFixed(1)} s: ${play.steps.join(' → ').slice(0, 600)}` : `${play.error}${last ? ` (during step ${play.steps.length}: "${last}")` : ''}`,
        play.ok ? '' : 'The function given to GCP.test.onPlaythrough failed. Either the game has a bug on that path or the script waits for something that does not happen. The verification browser is slow, so wait on game state with t.until(...) instead of fixed times.');
      report.playthrough = { ok: !!play.ok, steps: play.steps, error: play.error || '', ms: play.ms, frames: play.frames };
    } else {
      report.playthrough = null;
      report.notes.push('Only start-up, rendering and input were checked: this version registers no play-through, so nothing confirmed that it can be played to the end. Add GCP.test.onPlaythrough (see the platform-contract guide) to have the whole loop played and reported.');
    }
    // 4c. two players: a game that registered GCP.test.onTwoPlayers is opened twice more, in one room, and both pages must agree
    if (o.openPage && await page.evaluate(() => !!(window.__GCP && window.__GCP.twoPlayers)).catch(() => false)) {
      const two = await twoPlayerCheck(o.openPage, url, { limitS: o.twoPlayersS || 45, readyTimeoutS: o.readyTimeoutS, guestUrl: o.guestUrl || '' });
      if (two.skipped) report.notes.push('The two-player check could not be run: ' + two.skipped);
      else { add('two_players', two.ok, 'Two players share one world', two.detail, two.ok ? '' : 'The function given to GCP.test.onTwoPlayers ran in two pages, two different players, that met on GCP.test.twoPlayers.code (the first as host): a room opened with GCP.room, or a private match from GCP.match.find({ code }). Each must see the other and return the same world string. Check that the game hosts or joins that code on autostart, and that every change to the world reaches the other player.'); report.two_players = two; }
    }
    // 5. input: click, keys, drag, touch. A marker on window tells us afterwards whether the page was reloaded.
    // The probe is read here as well: a game may restart itself by reloading when its end screen is clicked, which resets it.
    const readProbe = () => page.evaluate(() => (window.__GCP && window.__GCP.probe ? JSON.parse(JSON.stringify(window.__GCP.probe)) : null)).catch(() => null);
    probeBeforeInput = await readProbe();
    const where = () => { try { const u = new URL(page.url()); return u.origin + u.pathname; } catch { return ''; } }, home = where();
    await page.evaluate(() => { window.__gcpStay = 1; }).catch(() => {});
    try {
      const vp = page.viewport ? page.viewport() : page.viewportSize(); const cx = (vp?.width || 960) / 2, cy = (vp?.height || 540) / 2;
      await page.mouse.click(cx, cy); await sleep(150);
      for (const k of ['Enter', 'Space']) { await page.keyboard.press(k); await sleep(80); }
      for (const k of ['KeyW', 'KeyD', 'ArrowUp', 'ArrowRight']) { await page.keyboard.down(k); await sleep(220); await page.keyboard.up(k); }
      await page.mouse.move(cx - 80, cy); await page.mouse.down(); await page.mouse.move(cx + 80, cy + 30, { steps: 6 }); await page.mouse.up();
      await tap(page, cx + 40, cy + 40);
      await page.keyboard.press('Escape');
    } catch (e) { report.warnings.push('Input simulation error: ' + e.message); }
    await sleep(300);
    let d = null;
    try { if (await page.evaluate(() => window.__gcpStay === 1)) { const c = await state(page); await sleep(1500); d = await state(page); f2 = d.frames - c.frames; } } catch { d = null; }
    if (!d && where() === home) {
      // Same address, new page: the game reloaded itself (the usual "Play again"). That is a restart, not a crash, as long as it boots again.
      let back = null;
      for (let i = 0; i < 40 && !(back && back.ready); i++) { await sleep(500); back = await state(page).catch(() => null); if (back && back.fatal) break; }
      if (back && back.ready && !back.fatal) {
        const c = await state(page); await sleep(1500); d = await state(page); f2 = d.frames - c.frames; restarted = true;
        d = { ...d, loadMs: s.loadMs, errors: [...(s.errors || []), ...(d.errors || [])], warnings: [...(s.warnings || []), ...(d.warnings || [])], missing: [...(s.missing || []), ...(d.missing || [])] };
      }
    }
    if (!d) {
      add('input', false, 'Survives keyboard, mouse and touch input', where() === home ? 'The page reloaded when it received input and did not boot again within 20 s.' : 'The page navigated away when it received input.',
        'Something reloads or leaves the page on a click, tap or key press. A common cause is a button or link that is invisible (opacity 0) but still clickable: hide inactive UI with display:none or visibility:hidden.');
    } else {
      const need = Math.max(3, o.minFrames / 3);
      // the same allowance as "renders": a loop that still advances after input, only slowly, gets two more short windows
      for (let k = 0; !domGame && f2 > 0 && f2 < need && k < 2; k++) {
        const before = d.frames; await sleep(1500);
        const more = await state(page).catch(() => null); if (!more) break;
        f2 += more.frames - before; inputS += 1.5; d = restarted ? { ...d, frames: more.frames } : more;
      }
      s = d;
      const alive = domGame ? !restarted : f2 >= need;
      add('input', alive, 'Survives keyboard, mouse and touch input', domGame ? 'The page kept running after input.' : restarted ? `The game restarted itself by reloading the page, booted again and drew ${f2} frames in ${inputS}s` : `${f2} frames in the ${inputS}s after input`, alive ? '' : 'The loop stopped after input. An input handler probably threw; see errors.');
      pic2 = await shoot(); ui2 = await uiState(page); await snap();
    }
  }
  // 5b. responds: something on screen changes, by itself or when played. A picture with a frame loop behind it never does.
  if (pic1 && pic1.img && checks.every((c) => c.ok)) {
    const moved = Math.max(pixelChange(pic1.img, picIdle && picIdle.img), pixelChange(pic1.img, pic2 && pic2.img), pixelChange(picIdle && picIdle.img, pic2 && pic2.img));
    const changes = Math.max(ui1 ? ui1.changes : 0, ui2 ? ui2.changes : 0);
    const played = !!(report.playthrough && report.playthrough.ok);
    const responds = moved >= 0.002 || changes > 0;
    report.metrics.change = { pixels: Math.round(moved * 10000) / 10000, dom: changes };
    add('responds', responds, 'Responds to the player', responds ? (moved >= 0.002 ? `${(moved * 100).toFixed(1)}% of the screen changed while it ran and was played` : `the page changed ${changes} time(s) while it was played`) : `Nothing on screen changed in ${o.observeS + 4} s of running, input${played ? ' and its play-through' : ''}: it looks like a still picture.`,
      responds ? '' : 'The verifier clicks the centre, presses Enter, Space, WASD and the arrows, drags and taps. A game must visibly react, or move by itself. If the game waits on a title screen, register GCP.test.onAutostart to skip it.');
  }
  report.page = { text: (ui2 && ui2.text) || (ui1 && ui1.text) || '', controls: Math.max(ui1 ? ui1.controls : 0, ui2 ? ui2.controls : 0), domGame };
  // 5c. conduct: the page stays on its own address and does not open windows, start downloads or bury the player in dialogs
  if (pic1) {
    conduct.passwordFields = Math.max(ui1 ? ui1.passwords : 0, ui2 ? ui2.passwords : 0);
    const bad = [];
    if (conduct.navigations.length) bad.push(`it left for another site (${hostOf(conduct.navigations[0])})`);
    if (conduct.downloads.length) bad.push(`it started a download (${conduct.downloads[0]})`);
    if (conduct.popups.length >= 2) bad.push(`it opened ${conduct.popups.length} windows (${hostOf(conduct.popups[0]) || conduct.popups[0]})`);
    if (conduct.dialogs >= 3) bad.push(`it opened ${conduct.dialogs} alert or confirm dialogs`);
    add('conduct', !bad.length, 'Leaves the player\'s browser alone', bad.length ? `While it was checked, ${bad.join('; ')}.` : '',
      bad.length ? 'A game runs on its own page: it may not redirect the player, open windows by itself, push downloads or stack dialogs. Links a player clicks on purpose (credits, a shop page) are fine.' : '');
    if (conduct.popups.length === 1) report.notes.push(`It opened one window while it was played (${conduct.popups[0]}).`);
  }
  // 1b + 6
  const missing = [...new Set([...(s.missing || []), ...badResponses])];
  if (missing.length) add('files', false, 'Every requested file is served', missing.slice(0, 6).join('; '), 'Upload the missing files or fix their paths (paths are case-sensitive).');
  else add('files', true, 'Every requested file is served', '');
  // 1c. the game's server code: a crash in server/index.js fails here, with what it threw
  await Promise.all(serverErrors.map((e) => Promise.race([e.read, sleep(2000)])));
  const crashed = serverErrors.filter((e) => e.status >= 500), refused = serverErrors.filter((e) => e.status < 500);
  const line = (e) => `${e.status} ${e.path}${e.message ? `: ${e.message}` : ''}${e.stack && e.stack.length ? ` (${e.stack[0]})` : ''}`;
  if (crashed.length) add('server', false, 'The game\'s server code answers', crashed.slice(0, 4).map(line).join('; '),
    'server/index.js threw while handling these requests (the game called them through GCP.server). Fix the error shown, or catch it in fetch() and return a Response with a 4xx status. Run the handler locally with a fake env to reproduce it.');
  else if (serverErrors.length) add('server', true, 'The game\'s server code answers', '');
  if (refused.length) report.warnings.push(`The game's server code answered ${refused.slice(0, 4).map(line).join('; ')}. Fine if the game expects it (a 404 for a save that does not exist yet).`);
  report.server = serverErrors.length ? serverErrors.map(({ read, ...e }) => e) : undefined;
  const errs = [...new Set([...(s.errors || []), ...pageErrors])];
  add('clean', errs.length === 0, 'No uncaught errors', errs.length ? `${errs.length} uncaught error(s)` : '', errs.length ? 'Fix each error listed under "errors", then deploy a new preview.' : '');

  report.errors = errs; report.warnings.push(...(s.warnings || [])); report.missing = missing;
  report.metrics = { loadMs: s.loadMs, frames: s.frames, fps: Math.round(f1 / observedS), framesAfterInput: f2, canvas: s.canvas, stats: s.stats, pictureChanged: !!(pic1 && pic2 && pic1.hash !== pic2.hash), colors: pic1 ? pic1.colors : 0 };
  report.ok = checks.every((c) => c.ok);
  // a few more frames of the game left running after the checks, for the content review; nothing here can fail the version
  if (report.ok) for (let i = 0; i < 3 && frames.length < 7; i++) { await sleep(1500); await snap(); }
  // The portrait. The checks above ran on a CPU renderer, where a well-made game rightly draws less (lower resolution,
  // sparser grass, no finishing passes). People judge the game by what a device with a graphics card draws, so the game
  // is loaded once more with ?gcp_portrait=1, which asks it for exactly that, and one picture is taken. It is the
  // version's screenshot and the picture the craft review reads. Slow is fine here: one frame is enough.
  let portrait = null, portraitShot = null, portraitGl = null, lateShot = null;
  // If the first picture caught a loading screen and the game is past it now, a picture of now stands in when there is no portrait.
  if (pic1Cover && report.ok && !(await covered(page))) { try { lateShot = await page.screenshot({ type: 'png' }); } catch { /* page busy */ } }
  // what the checked run saw (sound, input, drawing) is read before the page is loaded again for the portrait
  const runProbe = pic1 && pic1.img ? await page.evaluate(() => (window.__GCP && window.__GCP.probe ? JSON.parse(JSON.stringify(window.__GCP.probe)) : null)).catch(() => null) : null;
  if (pic1 && pic1.img && report.ok && o.portrait !== false) {
    try {
      const tp = Date.now(); let ps = null;
      await page.goto(url + (url.includes('?') ? '&' : '?') + 'gcp_portrait=1', { waitUntil: 'domcontentloaded', timeout: 30000 });
      while (Date.now() - tp < 30000) { ps = await state(page).catch(() => null); if (ps && (ps.ready || ps.fatal)) break; await sleep(250); }
      if (ps && ps.ready && !ps.fatal) {
        // ready() only means the first frame: many games then load a world behind a loading screen. Wait (up to 20 s) until
        // the screen has been clear twice in a row, so the picture shows the game and not its loading screen.
        const tc = Date.now(); let clear = 0, cover = await covered(page);
        while (Date.now() - tc < 20000 && clear < 2) { await sleep(500); cover = await covered(page); clear = cover ? 0 : clear + 1; }
        if (cover) report.notes.push(`The version's picture was taken while the game still seemed to be loading (${cover}). Set your own cover with update_project {cover}, or call GCP.progress(1) when play is on screen.`);
        ps = await state(page).catch(() => ps) || ps;
        const f0 = ps.frames, tw = Date.now(); let fr = 0;
        while (Date.now() - tw < 9000) { const c = await state(page).catch(() => null); fr = c ? c.frames - f0 : 0; if (fr >= 10) break; await sleep(300); }   // late passes and textures settle
        portraitGl = await page.evaluate(() => (window.__GCP && window.__GCP.probe && window.__GCP.probe.gl ? JSON.parse(JSON.stringify(window.__GCP.probe.gl)) : null)).catch(() => null);
        // a frame that takes a quarter of a second leaves the browser no room to take a picture: hold the loop on the frame it has drawn
        await page.evaluate(() => { if (window.__GCP && window.__GCP.hold) window.__GCP.hold(true); }).catch(() => {}); await sleep(900);
        const b = await page.screenshot({ type: 'png' }), st = pngStats(b);
        if (st && st.ok && st.img && st.colors >= 2 && st.other >= 200) { portrait = st; portraitShot = b; report.portrait = { ms: Date.now() - tp, frames: fr }; await snap(); }
      }
    } catch (e) { report.notes.push('The full-quality picture could not be taken: ' + String(e && e.message || e).slice(0, 160)); }
  }
  // The craft review: not a pass/fail check, a measured account of how finished the game is and what to improve next.
  if (pic1 && pic1.img) {
    try {
      const after = runProbe;
      let probe = restarted || !after ? probeBeforeInput || after : after;   // after a self-restart the fresh page has seen almost nothing
      if (restarted && probe && after && after.audio && probe.audio) probe = { ...probe, audio: { contexts: Math.max(probe.audio.contexts || 0, after.audio.contexts || 0), starts: Math.max(probe.audio.starts || 0, after.audio.starts || 0) } };
      const ui = [ui1, ui2].filter(Boolean).sort((a, b) => b.texts - a.texts)[0] || { texts: 0, chars: 0 };
      report.craft = craftReview({
        stills: (portrait ? [portrait] : [pic1, pic2]).filter((p) => p && p.img).map((p) => imageMetrics(p.img)), portrait: !!portrait, look: portraitGl, idleMotion: picIdle && picIdle.img ? motionBetween(pic1.img, picIdle.img) : 0,
        inputChange: !!(pic1 && pic2 && pic1.hash !== pic2.hash), probe, ui, playthrough: report.playthrough, warnings: report.warnings.length,
      });
    } catch (e) { report.warnings.push('Craft review could not run: ' + String(e && e.message || e).slice(0, 200)); }
  }
  const failed = checks.filter((c) => !c.ok);
  report.summary = report.ok ? `Playable: booted in ${s.loadMs} ms, ${Math.round(f1 / observedS)} fps in the verification browser, no errors${report.playthrough ? `, play-through of ${report.playthrough.steps.length} step(s) passed` : '; no play-through registered, so only start-up, rendering and input were checked'}.` : `Not playable yet: ${failed.map((c) => c.label.toLowerCase()).join('; ')}.`;
  report.metrics.reviewFrames = frames.length;
  return { report, shots: portraitShot ? [portraitShot, ...shots] : lateShot ? [lateShot, ...shots] : shots, frames };
}

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
import { NUMBERS } from './standards.js';

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
    progress: s.progress, progressBeforeReady: (s.probe && s.probe.progressBeforeReady) || 0, label: s.label, stats: s.stats, canvas: c ? { w: c.width, h: c.height } : null,
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
  // ---- the capture contract (the platform-contract guide, "Hand over the frame") ----
  // What the page paints over the game besides its canvases, gathered at the moments the checks look at the game.
  const pageUi = { elements: [], fields: [] };
  const scanUi = async () => {
    const r = await page.evaluate(() => (window.__GCP && window.__GCP.pageUi ? window.__GCP.pageUi(12) : null)).catch(() => null);
    if (!r) return;
    for (const k of ['elements', 'fields']) for (const e of r[k] || []) if (pageUi[k].length < 12 && !pageUi[k].some((x) => x.what === e.what)) pageUi[k].push(e);
  };
  const captureCheck = async () => {
    const hooks = await page.evaluate(() => ({ capture: !!(window.__GCP && window.__GCP.capture), state: !!(window.__GCP && window.__GCP.stateHook), api: !!(window.__GCP && window.__GCP.captureFrame) })).catch(() => ({ capture: false, state: false, api: false }));
    if (!hooks.api) return;   // an older runtime: nothing to check against
    const missing = [!hooks.capture && 'GCP.test.onCapture', !hooks.state && 'GCP.test.onState'].filter(Boolean);
    const problems = [];
    if (missing.length) problems.push(`it registers no ${missing.join(' and no ')}`);
    if (pageUi.elements.length) problems.push(`the page paints its own elements over the game: ${pageUi.elements.slice(0, 6).map((e) => `${e.what} (${e.why})`).join(', ')}${pageUi.elements.length > 6 ? ` and ${pageUi.elements.length - 6} more` : ''}`);
    let match = null;
    if (hooks.capture) {
      // hold the loop, let the game draw one frame, and compare the picture it hands over with that frame on screen
      try {
        await page.evaluate(() => window.__GCP.hold(true)); await sleep(250);
        const got = await Promise.race([page.evaluate(() => window.__GCP.captureFrame({ step: true }).then((r) => ({ image: r.image, error: r.error, exact: r.exact, redrawn: r.redrawn, hookError: r.hookError || '', canvases: r.canvases }))), sleep(8000).then(() => null)]);
        await sleep(120);
        const real = await page.screenshot({ type: 'png' });
        if (!got) problems.push('the picture it hands over did not come within 8 s');
        else if (got.hookError) problems.push(got.hookError);
        else if (!got.image) problems.push(`it handed over no picture (${got.error || 'no canvas'})`);
        else {
          match = await page.evaluate(async ({ a, b }) => {
            const load = async (src) => { const i = new Image(); i.src = src; await i.decode(); return i; };
            const [x, y] = await Promise.all([load(a), load(b)]);
            const W = 64, H = Math.max(8, Math.round(64 * x.height / x.width)), px = (img) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(img, 0, 0, W, H); return g.getImageData(0, 0, W, H).data; };
            const p = px(x), q = px(y); let sum = 0, okCells = 0;
            for (let i = 0; i < p.length; i += 4) { const d = (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2])) / 3; sum += d; if (d <= 24) okCells++; }
            return { mean: Math.round(sum / (W * H) * 10) / 10, same: Math.round(okCells / (W * H) * 1000) / 1000 };
          }, { a: 'data:image/png;base64,' + Buffer.from(real).toString('base64'), b: got.image }).catch((e) => ({ error: String(e && e.message || e).slice(0, 160) }));
          report.capture = { ...match, exact: !!got.exact, redrawn: got.redrawn || [], canvases: got.canvases };
          if (match.error) problems.push('the picture could not be compared: ' + match.error);
          else if (!(match.mean <= 12 && match.same >= 0.93)) problems.push(`the picture it hands over does not match the screen (${Math.round(match.same * 100)}% alike, mean difference ${match.mean})`);
        }
      } catch (e) { problems.push('the capture failed: ' + String(e && e.message || e).slice(0, 160)); }
      finally { await page.evaluate(() => window.__GCP.hold(false)).catch(() => {}); }
    }
    if (pageUi.fields.length) report.notes.push(`Text fields over the game (${pageUi.fields.map((f) => f.what).join(', ')}) are drawn into feedback pictures from their boxes; everything else comes from the game's canvases.`);
    report.pageUi = pageUi.elements.length ? pageUi.elements : undefined;
    // o.captureRequired false (the platform setting verify_capture_required, while games move over): reported, not failed
    const soft = problems.length && o.captureRequired === false;
    if (soft) report.notes.push('The capture check is enforced only for live games; it will fail a version once this game is live: ' + problems.join('; ') + '.');
    add('capture', !problems.length || soft, 'Hands over its exact frame', problems.length ? (soft ? 'Not enforced until the game is live: ' : '') + problems.join('; ') + '.' : `The picture from GCP.test.onCapture matches the screen (${Math.round(match.same * 100)}% alike)`,
      problems.length ? 'Every game draws everything the player sees (world, HUD, menus, text) in its canvases, and registers GCP.test.onCapture(() => canvas or [canvases]) and GCP.test.onState(fn). Move menus and HUD made of page elements into the canvas (draw text with fillText, buttons as shapes, and hit-test pointer events yourself). A WebGL game that does not redraw every frame keeps preserveDrawingBuffer: true or draws a frame inside onCapture. See get_started {topic: "contract"}, "Hand over the frame".' : '');
    // the release gate (src/release-gate.ts) refuses to publish a version whose capture check only warned
    if (soft) checks[checks.length - 1].soft = true;
  };
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
    await sleep(700); picIdle = await shoot(); ui1 = await uiState(page); await scanUi();
    // Browsers keep sound locked until the first real press. One click in the top-left corner pixel gives the page that press, as a
    // player's first key or tap would, so sounds played during the play-through are real and can be measured.
    try { await page.mouse.click(2, 2); await sleep(120); } catch { /* no pointer */ }
    // 4a. one menu at a time: in simulated fullscreen, Esc must open the game's own pause menu or the platform's, never both,
    // and the platform's pause must not make the game open its own menu (two menus, and Resume runs the game under one).
    // Only games that use the pause contract can be checked (GCP.onEscape, GCP.pauseMenu, GCP.setPaused).
    try {
      const pz = await Promise.race([page.evaluate(() => (window.__GCP && window.__GCP.pauseCheck ? window.__GCP.pauseCheck() : { ran: false })), sleep(8000).then(() => ({ ran: false }))]);
      if (pz && pz.ran) {
        const both = !!(pz.esc && pz.esc.platformMenu && pz.esc.gameMenu), self = !!(pz.platformPause && pz.platformPause.gameMenu);
        const ok = !both && !self;
        add('pause', ok, 'One pause menu at a time', (pz.steps || []).join('; ').slice(0, 400),
          ok ? '' : both ? 'One Esc opened the game\'s own pause menu and the platform menu together. Route Esc through GCP.onEscape (return false only when nothing of the game\'s was open), declare the pause menu with GCP.pauseMenu(open), and report it with GCP.setPaused(true/false) (input guide, "One pause owner").'
            : 'The game opened its own pause menu because the platform paused it. Only freeze the clock on GCP.onPause or display.paused; the platform shows its own menu. Otherwise the player sees two menus, and Resume leaves the game\'s menu up (input guide, "One pause owner").');
        if (pz.escCloses === false) report.warnings.push('Esc opened the game\'s pause menu but a second Esc did not close it. Players expect Esc to toggle it.');
        report.pause = pz;
      }
    } catch { /* the page went away; the input check reports it */ }
    // 4b. play-through: if the game registered one, it plays itself to the end and every step is reported.
    let play = null;
    try {
      play = await Promise.race([
        page.evaluate((ms) => (window.__GCP && window.__GCP.runPlaythrough ? window.__GCP.runPlaythrough(ms) : { ran: false }), o.playthroughS * 1000),
        sleep(o.playthroughS * 1000 + 5000).then(() => ({ ran: true, ok: false, error: `The play-through did not finish within ${o.playthroughS} s.`, steps: [], ms: o.playthroughS * 1000, frames: 0 })),
      ]);
    } catch (e) { play = { ran: true, ok: false, error: 'The page reloaded or closed during the play-through: ' + String(e && e.message || e).slice(0, 200), steps: [], ms: 0, frames: 0 }; }
    // where the play-through left the game (screenshots are not taken during it: they can stall frames in a slow browser)
    if (play && play.ran) { await snap(); await scanUi(); }
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
      pic2 = await shoot(); ui2 = await uiState(page); await snap(); await scanUi();
    }
    // 5a. the capture contract: the game hands over its frame, and its frame is all the player sees
    if (d && checks.every((c) => c.ok)) await captureCheck();
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
  report.metrics = { loadMs: s.loadMs, progressBeforeReady: s.progressBeforeReady, frames: s.frames, fps: Math.round(f1 / observedS), framesAfterInput: f2, canvas: s.canvas, stats: s.stats, pictureChanged: !!(pic1 && pic2 && pic1.hash !== pic2.hash), colors: pic1 ? pic1.colors : 0 };
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

// ----- phones and tablets ------------------------------------------------------------------------------------------
// After the main check passes, the game is opened again as it would be on an iPhone and an iPad (touch screen, small
// viewport, high pixel density, Safari's user agent): the same browser with phone and tablet emulation, not Safari
// itself, so what it catches is what the device's size, touch and density do to a game. Safari's own engine is covered
// by the game runtime's fix-ins and by the deploy's static device checks (src/device-checks.js).
// Hard problems (it does not start, it throws, it stops drawing, a finger crashes it) fail the version when the game
// says it is made for that kind of device (requirements.devices); otherwise they are noted. Layout problems (cut off,
// tiny, unreadable text, buttons too small for a finger) are always notes.
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';
export const DEVICE_PROFILES = {
  iphone: { id: 'iphone', label: 'iPhone', kind: 'mobile', width: 844, height: 390, deviceScaleFactor: 3, userAgent: IOS_UA },
  ipad: { id: 'ipad', label: 'iPad', kind: 'tablet', width: 1180, height: 820, deviceScaleFactor: 2, userAgent: IPAD_UA },
  android: { id: 'android', label: 'Android phone', kind: 'mobile', width: 915, height: 412, deviceScaleFactor: 2.625, userAgent: ANDROID_UA },
};
/** The viewport of a profile for a game's orientation (portrait games are held upright, everything else sideways). */
export function deviceViewport(profile, orientation) {
  const long = Math.max(profile.width, profile.height), short = Math.min(profile.width, profile.height);
  return orientation === 'portrait' ? { width: short, height: long } : { width: long, height: short };
}

/** A one-finger drag through the browser's protocol (Puppeteer and Playwright on Chromium). */
async function swipe(page, x0, y0, x1, y1) {
  try {
    const cdp = page.createCDPSession ? await page.createCDPSession() : await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
    for (let i = 1; i <= 6; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / 6, y: y0 + ((y1 - y0) * i) / 6 }] }); await sleep(30); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach().catch(() => {});
  } catch { /* no protocol session */ }
}

/** What the screen shows of the game: the page against the screen, the main canvas, text size and finger-sized buttons. */
const layoutOf = (page) => page.evaluate(() => {
  const vw = innerWidth, vh = innerHeight, se = document.scrollingElement || document.documentElement;
  const shown = (el, r) => { const cs = getComputedStyle(el); return r.width > 1 && r.height > 1 && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
  let canvas = null, best = 0;
  for (const c of document.querySelectorAll('canvas')) { const r = c.getBoundingClientRect(); if (shown(c, r) && r.width * r.height > best) { best = r.width * r.height; canvas = r; } }
  const cut = canvas ? (() => { const w = Math.max(0, Math.min(canvas.right, vw) - Math.max(canvas.left, 0)), h = Math.max(0, Math.min(canvas.bottom, vh) - Math.max(canvas.top, 0)); return { onScreen: (w * h) / (canvas.width * canvas.height), covers: (w * h) / (vw * vh), w: Math.round(canvas.width), h: Math.round(canvas.height) }; })() : null;
  const bodyCs = getComputedStyle(document.body || document.documentElement), htmlCs = getComputedStyle(document.documentElement);
  const clipped = /hidden|clip/.test(bodyCs.overflow + htmlCs.overflow);
  let small = 0, sample = '', tiny = 0, tinySample = '';
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT), seen = new Set();
  while (walker.nextNode()) {
    const t = walker.currentNode.nodeValue.trim(), el = walker.currentNode.parentElement;
    if (!t || !el || seen.has(el) || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue; seen.add(el);
    const r = el.getBoundingClientRect(); if (!shown(el, r) || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize) || 16;
    if (fs < 9) { small++; if (!sample) sample = `"${t.slice(0, 30)}" at ${Math.round(fs * 10) / 10} px`; }
  }
  for (const el of document.querySelectorAll('button, a[href], [role="button"], input:not([type="hidden"]), select')) {
    const r = el.getBoundingClientRect(); if (!shown(el, r) || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
    if (Math.min(r.width, r.height) < 20) { tiny++; if (!tinySample) tinySample = `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}" ${Math.round(r.width)}×${Math.round(r.height)} px`; }
  }
  return { vw, vh, scrollW: se.scrollWidth, scrollH: se.scrollHeight, clipped, canvas: cut, small, sample, tiny, tinySample };
}).catch(() => null);

/**
 * The game standards' reserved zones, checked on a phone (src/standards.js, "menu-button" and "safe-area"). The page is
 * told it is in fullscreen on a notched phone (the same message the platform's player sends, with iPhone insets), then
 * the layers GCP.test.onCapture hands over are read back right after the game draws: the world (the bottom layer) may
 * fill the screen, but the interface layers above it must leave the notch, the home bar and the platform menu button's
 * corner clear. A game that hands over one canvas cannot be checked this way, and is told so.
 * Returns { checked, layers, reason?, safe, corner, zones: [{ zone, coverage, box }] } or null.
 */
export const ZONE_INSETS = { landscape: { top: 0, right: 47, bottom: 21, left: 47 }, portrait: { top: 47, right: 0, bottom: 34, left: 0 } };
export async function zonesOf(page, orientation) {
  const safe = ZONE_INSETS[orientation === 'portrait' ? 'portrait' : 'landscape'], mb = NUMBERS.menu_button;
  const told = await page.evaluate((a) => {
    const G = window.__GCP; if (!G || !G.captureLayers) return null;
    const prefs = G.displayPrefs || {}, edge = prefs.edgeToEdge !== false;
    window.postMessage({ gcp: 'display', fullscreen: true, mode: 'fullscreen', orientation: a.orientation, touch: true, edgeToEdge: edge, safe: edge ? a.safe : { top: 0, right: 0, bottom: 0, left: 0 }, paused: false, menu: false }, '*');
    return { edge, corner: prefs.exitButton || 'top-left' };
  }, { safe, orientation: orientation === 'portrait' ? 'portrait' : 'landscape' }).catch(() => null);
  if (!told) return null;
  await sleep(900);
  return page.evaluate(async (a) => {
    const G = window.__GCP, vw = innerWidth, vh = innerHeight, sf = a.edge ? a.safe : { top: 0, right: 0, bottom: 0, left: 0 };
    const layers = await G.captureLayers().catch(() => null);
    const out = { checked: false, layers: layers ? layers.length : 0, safe: sf, corner: a.corner, edgeToEdge: a.edge, zones: [] };
    if (!layers || !layers.length) { out.reason = 'no-hook'; return out; }
    if (layers.length < 2) { out.reason = 'one-layer'; return out; }
    const sq = a.size + 2 * a.inset, rects = [];
    if (sf.left) rects.push({ zone: 'notch-left', x: 0, y: sf.top, w: sf.left, h: vh - sf.top - sf.bottom });
    if (sf.right) rects.push({ zone: 'notch-right', x: vw - sf.right, y: sf.top, w: sf.right, h: vh - sf.top - sf.bottom });
    if (sf.top) rects.push({ zone: 'notch-top', x: 0, y: 0, w: vw, h: sf.top });
    if (sf.bottom) rects.push({ zone: 'home-bar', x: 0, y: vh - sf.bottom, w: vw, h: sf.bottom });
    if (a.corner !== 'none') {
      const right = /right/.test(a.corner), bottom = /bottom/.test(a.corner);
      rects.push({ zone: 'menu-button', x: right ? vw - sf.right - sq : sf.left, y: bottom ? vh - sf.bottom - sq : sf.top, w: sq, h: sq });
    }
    // read the interface layers right after the game's next frame (a WebGL canvas is readable until it is composited)
    const counts = await new Promise((done) => requestAnimationFrame(() => {
      const res = rects.map(() => ({ hit: 0, all: 0, x0: 1e9, y0: 1e9, x1: -1, y1: -1 }));
      for (const c of layers.slice(1)) {
        const r = c.getBoundingClientRect(); if (!r.width || !r.height) continue;
        const k = document.createElement('canvas'); k.width = Math.max(1, Math.round(r.width)); k.height = Math.max(1, Math.round(r.height));
        const g = k.getContext('2d', { willReadFrequently: true }); let px;
        try { g.drawImage(c, 0, 0, k.width, k.height); px = g.getImageData(0, 0, k.width, k.height).data; } catch { continue; }
        // a layer that is opaque nearly everywhere is not an overlay: it is the world, or a full-screen menu
        let solid = 0, n = 0; for (let i = 3; i < px.length; i += 4 * 97) { n++; if (px[i] >= 200) solid++; }
        if (n && solid / n > 0.85) continue;
        rects.forEach((z, j) => {
          const o = res[j];
          for (let y = Math.max(0, Math.floor(z.y - r.top)); y < Math.min(k.height, Math.ceil(z.y + z.h - r.top)); y += 2)
            for (let x = Math.max(0, Math.floor(z.x - r.left)); x < Math.min(k.width, Math.ceil(z.x + z.w - r.left)); x += 2) {
              o.all++; if (px[(y * k.width + x) * 4 + 3] >= 200) { o.hit++; const X = x + r.left, Y = y + r.top; if (X < o.x0) o.x0 = X; if (Y < o.y0) o.y0 = Y; if (X > o.x1) o.x1 = X; if (Y > o.y1) o.y1 = Y; }
            }
        });
      }
      done(res);
    }));
    out.checked = true;
    rects.forEach((z, j) => { const o = counts[j]; const cov = o.all ? o.hit / o.all : 0; if (cov > 0.03) out.zones.push({ zone: z.zone, coverage: Math.round(cov * 100) / 100, box: [Math.round(o.x0), Math.round(o.y0), Math.round(o.x1 - o.x0 + 1), Math.round(o.y1 - o.y0 + 1)] }); });
    return out;
  }, { safe, edge: told.edge, corner: told.corner, size: mb.size, inset: mb.inset }).catch(() => null);
}
const ZONE_WORDS = { 'notch-left': 'under the notch on the left', 'notch-right': 'under the rounded corner on the right', 'notch-top': 'under the notch at the top', 'home-bar': 'over the home bar at the bottom', 'menu-button': 'under the platform menu button' };
/** The zone check in words, for the report's notes. */
export function zoneNotes(z, label = 'iPhone') {
  if (!z) return [];
  if (!z.checked) return z.reason === 'one-layer' ? [`On ${label}: the reserved zones (notch, home bar, the platform menu button's corner) could not be checked, because GCP.test.onCapture hands over one canvas. Hand over the interface as its own layer (return [world, ui]) so the platform can check it.`] : [];
  return z.zones.map((x) => `On ${label} in fullscreen: the interface draws ${ZONE_WORDS[x.zone] || x.zone} (${Math.round(x.coverage * 100)}% of that zone, around ${x.box[0]},${x.box[1]} ${x.box[2]}×${x.box[3]} px). ${x.zone === 'menu-button' ? `Keep the ${z.corner} corner free or move the button with GCP.setDisplay({ exitButton }).` : 'Keep the interface inside GCP.display.safe.'}`);
}

/**
 * Plays the game on each device profile. openDevicePage(profile, viewport) -> a fresh page emulating that device (touch,
 * mobile, density, user agent). Returns [{ id, label, kind, ok, problems: [..], notes: [..], loadMs, fps, runtime }].
 */
export async function verifyDevices(openDevicePage, url, { profiles = ['iphone', 'ipad'], orientation = 'any', readyTimeoutS = 30, observeS = 2 } = {}) {
  const out = [];
  for (const id of profiles) {
    const profile = DEVICE_PROFILES[id]; if (!profile) continue;
    const vp = deviceViewport(profile, orientation), res = { id, label: profile.label, kind: profile.kind, viewport: `${vp.width}×${vp.height}`, ok: true, problems: [], notes: [], loadMs: 0, fps: 0, runtime: null };
    out.push(res);
    let page = null;
    try {
      page = await openDevicePage(profile, vp);
      const errs = [];
      page.on('pageerror', (e) => { if (errs.length < 10) errs.push(String(e && (e.message || e)).slice(0, 300)); });
      page.on('dialog', (d) => { d.dismiss().catch(() => {}); });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const t0 = Date.now(); let s = null;
      while (Date.now() - t0 < readyTimeoutS * 1000) { s = await state(page).catch(() => null); if (s && (s.ready || s.fatal)) break; await sleep(250); }
      if (!s) { res.problems.push('The page did not run (the platform SDK never loaded).'); continue; }
      if (s.fatal) { res.problems.push(`It did not start: GCP.fatal: ${String(s.fatal).slice(0, 200)}`); continue; }
      if (!s.ready) { res.problems.push(`It did not start: GCP.ready() was not called within ${readyTimeoutS} s (progress ${Math.round(s.progress * 100)}%).`); continue; }
      res.loadMs = s.loadMs;
      await sleep(observeS * 1000);
      const a = await state(page).catch(() => null);
      await sleep(1000);
      const b = await state(page).catch(() => null);
      if (!a || !b || b.frames <= a.frames) {
        // a game that draws only when something changes (turn-based, a page of elements) is not stalled: a tap must make it draw
        if (!(b && (await page.evaluate(() => !document.querySelector('canvas')).catch(() => false)))) {
          const f0 = b ? b.frames : 0; await tap(page, vp.width / 2, vp.height / 2); await sleep(1200);
          const c = await state(page).catch(() => null);
          if (!c || c.frames <= f0) res.problems.push(`It stopped drawing frames after it started (${b ? b.frames : 0} frames).`);
        }
      } else res.fps = Math.round(b.frames - a.frames);
      // a finger: taps in the middle and a corner, then a drag across the screen
      await page.evaluate(() => { window.__gcpDeviceMark = 1; }).catch(() => {});
      const before = await state(page).catch(() => null);
      await tap(page, vp.width / 2, vp.height / 2); await sleep(300);
      await tap(page, vp.width * 0.2, vp.height * 0.75); await sleep(300);
      await swipe(page, vp.width * 0.3, vp.height * 0.6, vp.width * 0.7, vp.height * 0.4); await sleep(1500);
      const after = await state(page).catch(() => null);
      const still = await page.evaluate(() => !!window.__gcpDeviceMark).catch(() => false);
      if (!still) res.problems.push('The page reloaded or navigated away when it was touched.');
      else if (!after) res.problems.push('The page stopped answering when it was touched.');
      else if (before && after.frames <= before.frames && res.fps) res.problems.push('It stopped drawing frames when it was touched.');
      const thrown = [...new Set([...(after ? after.errors : s.errors), ...errs])];
      if (thrown.length) res.problems.push(`It threw ${thrown.length === 1 ? 'an error' : thrown.length + ' errors'}: ${thrown.slice(0, 2).map((e) => e.slice(0, 160)).join(' | ')}`);
      res.runtime = await page.evaluate(() => (window.__GCP && window.__GCP.runtime) || null).catch(() => null);
      // the game standards' reserved zones, on the phone only
      if (profile.kind === 'mobile' && !res.zones) { res.zones = await zonesOf(page, orientation); res.notes.push(...zoneNotes(res.zones, profile.label)); }
      // what the screen shows
      const L = await layoutOf(page);
      if (L) {
        if (!L.clipped && (L.scrollW > L.vw + 4 || L.scrollH > L.vh + 4)) res.notes.push(`The page is larger than the ${L.vw}×${L.vh} screen (${L.scrollW}×${L.scrollH}), so part of it is off screen. Size the game to the window (100% width and height, or innerWidth and innerHeight on resize).`);
        if (L.canvas && L.canvas.onScreen < 0.9) res.notes.push(`Only ${Math.round(L.canvas.onScreen * 100)}% of the game's canvas (${L.canvas.w}×${L.canvas.h}) is on the ${L.vw}×${L.vh} screen. Scale it to fit the window.`);
        else if (L.canvas && L.canvas.covers < 0.3) res.notes.push(`The game's canvas covers only ${Math.round(L.canvas.covers * 100)}% of the ${L.vw}×${L.vh} screen. Scale it up to the window.`);
        if (L.small >= 3) res.notes.push(`${L.small} pieces of text are smaller than 9 px, hard to read on a ${profile.label} (${L.sample}).`);
        if (L.tiny >= 3) res.notes.push(`${L.tiny} buttons are smaller than 20 px, hard to hit with a finger (${L.tinySample}).`);
      }
    } catch (e) {
      res.problems.push('It could not be opened: ' + String(e && e.message || e).slice(0, 200));
    } finally {
      res.ok = !res.problems.length;
      try { if (page) await page.close(); } catch { /* gone */ }
    }
  }
  return out;
}

/**
 * Adds the device results to a report: one check per device ("Plays on iPhone"), failing only for a device kind the game
 * says it is made for (devices from its requirements); the rest of the findings go into the report's notes.
 */
export function applyDeviceResults(report, results, devices = ['desktop', 'tablet', 'mobile']) {
  report.devices = results;
  const z = results.find((r) => r.zones); if (z) report.zones = z.zones;
  const failed = [];
  for (const r of results) {
    const made = devices.includes(r.kind), label = `Plays on ${r.label} (touch screen, ${r.viewport})`;
    if (r.ok) report.checks.push({ id: 'device_' + r.id, ok: true, label, detail: `Started in ${r.loadMs} ms and kept running through taps and a drag${r.runtime && r.runtime.fixes ? `; platform fixes on: ${r.runtime.fixes.join(', ') || 'none'}` : ''}.`, hint: '' });
    else if (made) { failed.push(r); report.checks.push({ id: 'device_' + r.id, ok: false, label, detail: r.problems.join(' '), hint: `The game says it is made for ${r.kind === 'mobile' ? 'phones' : 'tablets'} (requirements.devices). Fix it there (debug_preview with a ${r.kind === 'mobile' ? 'phone' : 'tablet'} viewport and touch shows what happens), or remove ${r.kind} from requirements.devices so players are told before they start.` }); }
    else report.notes.push(`On ${r.label}: ${r.problems.join(' ')} The game is not listed for ${r.kind === 'mobile' ? 'phones' : 'tablets'}, so this does not stop the version.`);
    for (const n of r.notes) report.notes.push(`On ${r.label}: ${n}`);
  }
  if (failed.length) {
    report.ok = false;
    report.summary = `Not playable on ${failed.map((r) => r.label).join(' and ')} yet: ${failed.map((r) => r.problems[0]).join(' ')}`;
  }
  return report;
}

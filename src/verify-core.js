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

/** Visible text elements on the page: the HUD, hints, menus. */
const uiState = (page) => page.evaluate(() => {
  let texts = 0, chars = 0; const seen = new Set(), w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) {
    const t = w.currentNode.nodeValue.trim(), el = w.currentNode.parentElement;
    if (!t || !el || seen.has(el) || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity < 0.05) continue;
    seen.add(el); texts++; chars += t.length;
  }
  return { texts, chars };
}).catch(() => ({ texts: 0, chars: 0 }));

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
 * @param opts   { readyTimeoutS, minFrames, observeS, usesWebGPU, log }
 */
/**
 * Opens the game in two more pages that meet in one room (host first, then guest) and runs the function the game gave to
 * GCP.test.onTwoPlayers in both at once. Passes when both finish, each sees at least two players and both return the same
 * world string. openPage() -> a new page of the same browser. Returns { ok, detail, host, guest } or { skipped: why }.
 */
export async function twoPlayerCheck(openPage, url, { limitS = 45, readyTimeoutS = 30 } = {}) {
  const code = 'V' + Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join(''), pages = [];
  const addr = (role) => url + (url.includes('?') ? '&' : '?') + (/[?&]gcp_autostart=/.test(url) ? '' : 'gcp_autostart=1&') + 'gcp_two=' + role + '&gcp_room=' + code;
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
    const [a, b] = await Promise.all([run(host, 'host'), run(guest, 'guest')]);
    const brief = (r) => ({ ok: !!r.ok, error: r.error || '', steps: r.steps || [], players: r.result && r.result.players, world: r.result && typeof r.result.world === 'string' ? r.result.world.slice(0, 2000) : null });
    const H = brief(a), G = brief(b), saw = H.players >= 2 && G.players >= 2, same = H.world != null && H.world === G.world, ok = H.ok && G.ok && saw && same;
    const last = (r) => (r.steps.length ? ` (during "${r.steps[r.steps.length - 1]}")` : '');
    const detail = ok ? `Host and guest met in one room, each saw ${Math.min(H.players, G.players)} players, and their worlds agree after both changed it.`
      : !H.ok ? `The host failed: ${H.error}${last(H)}` : !G.ok ? `The guest failed: ${G.error}${last(G)}` : !saw ? `The host saw ${H.players || 0} player(s) and the guest ${G.players || 0}: each must see both.`
        : H.world == null || G.world == null ? 'The function must return { players, world } with world a string.' : 'The two worlds differ. Host: ' + H.world.slice(0, 200) + ' · Guest: ' + G.world.slice(0, 200);
    return { ok, detail, host: { ok: H.ok, error: H.error, steps: H.steps, players: H.players }, guest: { ok: G.ok, error: G.error, steps: G.steps, players: G.players } };
  } finally { for (const p of pages) { try { await p.close(); } catch { /* gone */ } } }
}

export async function verifyPage(page, url, opts = {}) {
  const o = { readyTimeoutS: 30, minFrames: 6, observeS: 3, playthroughS: 30, usesWebGPU: false, ...opts };
  const checks = [], pageErrors = [], badResponses = [];
  const add = (id, ok, label, detail = '', hint = '') => checks.push({ id, ok, label, detail, hint });
  page.on('pageerror', (e) => { if (pageErrors.length < 20) pageErrors.push(String(e && (e.message || e)).slice(0, 500)); });
  page.on('response', (r) => { try { const s = r.status(); if (s >= 400 && badResponses.length < 20 && !/favicon\.ico/.test(r.url())) badResponses.push(`${s} ${r.url().split('?')[0]}`); } catch { /* detached */ } });
  page.on('dialog', (d) => { d.dismiss().catch(() => {}); });

  const report = { ok: false, summary: '', checks, metrics: {}, errors: [], warnings: [], missing: [], notes: [], caps: {}, gpuLimited: false, at: Date.now() };
  // A Worker that was deployed seconds ago can still be missing at some edge locations, so a 404 or 5xx gets a few more tries.
  let status = 0, navError = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await sleep(5000);
    try { const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); status = resp ? resp.status() : 0; navError = ''; }
    catch (e) { status = 0; navError = String(e && e.message || e); }
    if (status === 200 || (status >= 400 && status < 500 && status !== 404)) break;
  }
  if (navError) { add('deployed', false, 'The deployed game responds', `Navigation failed: ${navError}`); report.summary = 'The deployed game did not load.'; return { report, shots: [] }; }
  if (status === 200) { badResponses.length = 0; pageErrors.length = 0; }   // earlier attempts do not count against the game
  add('deployed', status === 200, 'The deployed game responds', `HTTP ${status}`, status === 200 ? '' : 'The preview Worker did not serve index.html.');
  if (status !== 200) { report.summary = `The game document returned HTTP ${status}.`; return { report, shots: [] }; }

  // 2. boots
  const t0 = Date.now(); let s = null;
  while (Date.now() - t0 < o.readyTimeoutS * 1000) {
    s = await state(page).catch(() => null);
    if (s && (s.ready || s.fatal)) break;
    await sleep(250);
  }
  if (!s) { add('boots', false, 'The game boots', 'The platform SDK never loaded in the page.'); report.summary = 'The page did not run.'; return { report, shots: [] }; }
  report.caps = s.caps;
  report.gpuLimited = !!o.usesWebGPU && !s.caps.webgpu;
  if (s.fatal) add('boots', false, 'The game boots', `GCP.fatal: ${s.fatal}`, report.gpuLimited ? 'The verification browser has no WebGPU. Add a WebGL fallback, or qualify this version by playing the preview yourself in a WebGPU browser.' : 'Fix the startup error and deploy a new preview.');
  else if (!s.ready) add('boots', false, 'The game boots', `GCP.ready() was not called within ${o.readyTimeoutS}s (progress ${Math.round(s.progress * 100)}%${s.label ? `, "${s.label}"` : ''}, ${s.frames} frames).`,
    s.errors.length || pageErrors.length ? 'An uncaught error stopped startup; see errors.' : 'Call GCP.ready() right after the first playable frame is drawn. If loading is slow, do less work before the first frame and keep generating in the background.');
  else add('boots', true, 'The game boots', `GCP.ready() after ${s.loadMs} ms`);

  const shots = [];
  const shoot = async () => { try { const b = await page.screenshot({ type: 'png' }); shots.push(b); return pngStats(b); } catch { return null; } };
  let pic1 = null, pic2 = null, picIdle = null, f1 = 0, f2 = 0, ui1 = null, ui2 = null, probeBeforeInput = null, restarted = false;
  if (s.ready && !s.fatal) {
    // 3. renders
    const a = await state(page); await sleep(o.observeS * 1000); const b = await state(page);
    f1 = b.frames - a.frames;
    add('renders', f1 >= o.minFrames, 'Frames keep rendering', `${f1} frames in ${o.observeS}s (${Math.round(f1 / o.observeS)} fps in the verification browser)`,
      f1 >= o.minFrames ? '' : 'Drive the game from requestAnimationFrame and keep the loop alive even on menus. A software GPU runs this check, so heavy scenes should offer a lower quality level and pick it when the frame time is high.');
    // 4. picture
    pic1 = await shoot();
    const blank = !pic1 || !pic1.ok || pic1.other < 200 || pic1.colors < 2; // a flat screen; a sparse one (Pong) is fine
    add('picture', !blank, 'Something is drawn', pic1 ? `${pic1.colors} distinct colours; ${pic1.other} pixels differ from the background` : 'No screenshot',
      blank ? 'The screen is a single flat colour. Check the camera, lights, canvas size and that the render call runs each frame.' : '');
    // For the craft review: a second picture a moment later with nothing pressed (does anything move by itself?), and the HUD.
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
      const two = await twoPlayerCheck(o.openPage, url, { limitS: o.twoPlayersS || 45, readyTimeoutS: o.readyTimeoutS });
      if (two.skipped) report.notes.push('The two-player check could not be run: ' + two.skipped);
      else { add('two_players', two.ok, 'Two players share one world', two.detail, two.ok ? '' : 'The function given to GCP.test.onTwoPlayers ran in two pages that joined the same room (the first as host). Each must see the other and return the same world string. Check that the game hosts or joins GCP.test.twoPlayers.code on autostart, and that every change to the world reaches the other player.'); report.two_players = two; }
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
      s = d;
      add('input', f2 >= Math.max(3, o.minFrames / 3), 'Survives keyboard, mouse and touch input', restarted ? `The game restarted itself by reloading the page, booted again and drew ${f2} frames in 1.5s` : `${f2} frames in the 1.5s after input`, f2 >= 3 ? '' : 'The loop stopped after input. An input handler probably threw; see errors.');
      pic2 = await shoot(); ui2 = await uiState(page);
    }
  }
  // 1b + 6
  const missing = [...new Set([...(s.missing || []), ...badResponses])];
  if (missing.length) add('files', false, 'Every requested file is served', missing.slice(0, 6).join('; '), 'Upload the missing files or fix their paths (paths are case-sensitive).');
  else add('files', true, 'Every requested file is served', '');
  const errs = [...new Set([...(s.errors || []), ...pageErrors])];
  add('clean', errs.length === 0, 'No uncaught errors', errs.length ? `${errs.length} uncaught error(s)` : '', errs.length ? 'Fix each error listed under "errors", then deploy a new preview.' : '');

  report.errors = errs; report.warnings.push(...(s.warnings || [])); report.missing = missing;
  report.metrics = { loadMs: s.loadMs, frames: s.frames, fps: Math.round(f1 / o.observeS), framesAfterInput: f2, canvas: s.canvas, stats: s.stats, pictureChanged: !!(pic1 && pic2 && pic1.hash !== pic2.hash), colors: pic1 ? pic1.colors : 0 };
  report.ok = checks.every((c) => c.ok);
  // The portrait. The checks above ran on a CPU renderer, where a well-made game rightly draws less (lower resolution,
  // sparser grass, no finishing passes). People judge the game by what a device with a graphics card draws, so the game
  // is loaded once more with ?gcp_portrait=1, which asks it for exactly that, and one picture is taken. It is the
  // version's screenshot and the picture the craft review reads. Slow is fine here: one frame is enough.
  let portrait = null, portraitShot = null, portraitGl = null;
  // what the checked run saw (sound, input, drawing) is read before the page is loaded again for the portrait
  const runProbe = pic1 && pic1.img ? await page.evaluate(() => (window.__GCP && window.__GCP.probe ? JSON.parse(JSON.stringify(window.__GCP.probe)) : null)).catch(() => null) : null;
  if (pic1 && pic1.img && report.ok && o.portrait !== false) {
    try {
      const tp = Date.now(); let ps = null;
      await page.goto(url + (url.includes('?') ? '&' : '?') + 'gcp_portrait=1', { waitUntil: 'domcontentloaded', timeout: 30000 });
      while (Date.now() - tp < 30000) { ps = await state(page).catch(() => null); if (ps && (ps.ready || ps.fatal)) break; await sleep(250); }
      if (ps && ps.ready && !ps.fatal) {
        const f0 = ps.frames, tw = Date.now(); let fr = 0;
        while (Date.now() - tw < 9000) { const c = await state(page).catch(() => null); fr = c ? c.frames - f0 : 0; if (fr >= 10) break; await sleep(300); }   // late passes and textures settle
        portraitGl = await page.evaluate(() => (window.__GCP && window.__GCP.probe && window.__GCP.probe.gl ? JSON.parse(JSON.stringify(window.__GCP.probe.gl)) : null)).catch(() => null);
        // a frame that takes a quarter of a second leaves the browser no room to take a picture: hold the loop on the frame it has drawn
        await page.evaluate(() => { if (window.__GCP && window.__GCP.hold) window.__GCP.hold(true); }).catch(() => {}); await sleep(900);
        const b = await page.screenshot({ type: 'png' }), st = pngStats(b);
        if (st && st.ok && st.img && st.colors >= 2 && st.other >= 200) { portrait = st; portraitShot = b; report.portrait = { ms: Date.now() - tp, frames: fr }; }
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
  report.summary = report.ok ? `Playable: booted in ${s.loadMs} ms, ${Math.round(f1 / o.observeS)} fps in the verification browser, no errors${report.playthrough ? `, play-through of ${report.playthrough.steps.length} step(s) passed` : '; no play-through registered, so only start-up, rendering and input were checked'}.` : `Not playable yet: ${failed.map((c) => c.label.toLowerCase()).join('; ')}.`;
  return { report, shots: portraitShot ? [portraitShot, ...shots] : shots };
}

// The steps an agent drives its game's preview with (debug_preview, src/debug.ts): clicks, taps, drags, keys, typing,
// waits and screenshots. Runs against a Puppeteer page (Cloudflare Browser Rendering) or a Playwright page (the local
// verifier), like verify-core.js, so it is checked by the same tests. checkSteps holds a call to its limits before any
// browser is touched.

export const DEBUG_LIMITS = {
  steps: 40,             // per call
  wait_ms: 20000,        // all waits of one call together (wait, wait_for, key holds, drags)
  shots: 4,              // screenshots one call returns
  text_chars: 500,       // type
  eval_chars: 2000,      // eval: the expression
  eval_result_chars: 4000,
  state_chars: 4000,     // what GCP.test.onState(fn) returned
  zoom_max: 4,           // screenshot zoom: the region re-rendered at up to 4 image pixels per CSS pixel
  shot_edge: 1920,       // a screenshot's longest side, in image pixels (clip × zoom)
  shot_pixels: 1920 * 1200,
  png_bytes: 1_200_000,  // a PNG over this is sent as a JPEG instead (the answer says so), so one call stays a few MB
};
export const VIEWPORTS = {
  desktop: { width: 960, height: 540, touch: false },
  hd: { width: 1280, height: 720, touch: false },
  'phone-landscape': { width: 844, height: 390, touch: true },
  'phone-portrait': { width: 390, height: 844, touch: true },
  tablet: { width: 1024, height: 768, touch: true },
  // the sizes verification's device checks play the game at ("Plays on iPhone", "Plays on iPad")
  iphone: { width: 844, height: 390, touch: true },
  ipad: { width: 1180, height: 820, touch: true },
};
const ACTIONS = ['click', 'double_click', 'right_click', 'move', 'down', 'up', 'drag', 'tap', 'scroll', 'key', 'key_down', 'key_up', 'type', 'wait', 'wait_for', 'screenshot', 'eval'];
const KEY = /^([\x20-\x7e]|[A-Z][A-Za-z0-9]{1,24})$/;   // one printable character, or a key name: Enter, ArrowLeft, KeyW, Space, F1…

export class StepError extends Error { constructor(m) { super(m); this.name = 'StepError'; } }
const fail = (m) => { throw new StepError(m); };

/** A viewport from a preset name or { width, height, touch }, kept to sizes a phone or a monitor has. */
export function viewportOf(v) {
  if (v === undefined || v === null || v === '') return { ...VIEWPORTS.desktop, name: 'desktop' };
  if (typeof v === 'string') { const p = VIEWPORTS[v]; if (!p) fail(`viewport must be one of ${Object.keys(VIEWPORTS).join(', ')}, or { width, height, touch }.`); return { ...p, name: v }; }
  const w = Math.round(Number(v.width)), h = Math.round(Number(v.height));
  if (!(w >= 320 && w <= 1920 && h >= 240 && h <= 1200)) fail('viewport width must be 320 to 1920 and height 240 to 1200.');
  return { width: w, height: h, touch: v.touch === true, name: 'custom' };
}

/** Checks and normalises a list of steps against the viewport. Throws StepError with the step number. */
export function checkSteps(steps, vp) {
  if (steps === undefined || steps === null) return [];
  if (!Array.isArray(steps)) fail('steps must be a list.');
  if (steps.length > DEBUG_LIMITS.steps) fail(`At most ${DEBUG_LIMITS.steps} steps in one call; send the rest in the next call.`);
  let waited = 0, shots = 0;
  const xy = (s, i, kx = 'x', ky = 'y', need = true) => {
    if (s[kx] === undefined && s[ky] === undefined && !need) return {};
    const x = Number(s[kx]), y = Number(s[ky]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) fail(`Step ${i + 1} (${s.do}) needs ${kx} and ${ky} in CSS pixels of the viewport.`);
    if (x < 0 || y < 0 || x > vp.width || y > vp.height) fail(`Step ${i + 1} (${s.do}): (${x}, ${y}) is outside the ${vp.width} × ${vp.height} viewport.`);
    return { [kx]: Math.round(x * 10) / 10, [ky]: Math.round(y * 10) / 10 };
  };
  const ms = (v, i, max) => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < 0 || n > max) fail(`Step ${i + 1}: milliseconds must be 0 to ${max}.`); return n; };
  const out = steps.map((s, i) => {
    if (!s || typeof s !== 'object' || !ACTIONS.includes(s.do)) fail(`Step ${i + 1} needs "do": one of ${ACTIONS.join(', ')}.`);
    const d = s.do, o = { do: d };
    const button = s.button === undefined ? 'left' : s.button;
    if (['click', 'down', 'up'].includes(d) && !['left', 'right', 'middle'].includes(button)) fail(`Step ${i + 1}: button must be left, right or middle.`);
    switch (d) {
      case 'click': Object.assign(o, xy(s, i), { button, count: s.count === 2 ? 2 : 1 }); break;
      case 'double_click': case 'right_click': case 'move': case 'tap': Object.assign(o, xy(s, i)); break;
      case 'down': case 'up': Object.assign(o, xy(s, i, 'x', 'y', false), { button }); break;
      case 'drag': Object.assign(o, xy(s, i), xy(s, i, 'to_x', 'to_y'), { ms: ms(s.ms ?? 300, i, 5000) }); waited += o.ms; break;
      case 'scroll': Object.assign(o, xy(s, i, 'x', 'y', false), { dx: Math.max(-5000, Math.min(5000, Number(s.dx) || 0)), dy: Math.max(-5000, Math.min(5000, Number(s.dy) || 0)) }); break;
      case 'key': case 'key_down': case 'key_up':
        if (typeof s.key !== 'string' || !KEY.test(s.key)) fail(`Step ${i + 1} (${d}) needs key: one character or a key name such as Enter, Space, ArrowLeft, KeyW, Shift, Escape.`);
        o.key = s.key === ' ' ? 'Space' : s.key;
        if (d === 'key' && s.hold_ms !== undefined) { o.hold_ms = ms(s.hold_ms, i, 10000); waited += o.hold_ms; }
        break;
      case 'type':
        if (typeof s.text !== 'string' || !s.text) fail(`Step ${i + 1} (type) needs text.`);
        if (s.text.length > DEBUG_LIMITS.text_chars) fail(`Step ${i + 1} (type): at most ${DEBUG_LIMITS.text_chars} characters.`);
        o.text = s.text; break;
      case 'wait': o.ms = ms(s.ms, i, 10000); waited += o.ms; break;
      case 'wait_for': {
        const until = s.until ?? 'ready';
        if (!['ready', 'text', 'frames'].includes(until)) fail(`Step ${i + 1} (wait_for): until must be ready, text or frames.`);
        o.until = until; o.timeout_ms = ms(s.timeout_ms ?? 8000, i, 15000); waited += o.timeout_ms;
        if (until === 'text') { if (typeof s.text !== 'string' || !s.text.trim()) fail(`Step ${i + 1} (wait_for text) needs text to look for on the page.`); o.text = s.text.slice(0, 200); }
        if (until === 'frames') o.frames = Math.max(1, Math.min(600, Math.round(Number(s.frames) || 30)));
        break;
      }
      case 'screenshot': {
        if (++shots > DEBUG_LIMITS.shots - 1) fail(`At most ${DEBUG_LIMITS.shots} screenshots per call, the final one included.`);
        if (s.label !== undefined) o.label = String(s.label).slice(0, 80);
        if (s.clip !== undefined) {
          const c = s.clip || {}, x = Number(c.x), y = Number(c.y), w = Number(c.width), h = Number(c.height);
          if (![x, y, w, h].every(Number.isFinite) || w < 16 || h < 16 || x < 0 || y < 0 || x + w > vp.width + 0.5 || y + h > vp.height + 0.5) fail(`Step ${i + 1} (screenshot): clip must be { x, y, width, height } inside the viewport, at least 16 px each way.`);
          o.clip = { x, y, width: w, height: h };
        }
        if (s.format !== undefined) { if (s.format !== 'png' && s.format !== 'jpeg') fail(`Step ${i + 1} (screenshot): format must be png or jpeg.`); if (s.format === 'png') o.format = 'png'; }
        if (s.zoom !== undefined) {
          const z = Number(s.zoom);
          if (![1, 2, 3, 4].includes(z)) fail(`Step ${i + 1} (screenshot): zoom must be 1, 2, 3 or ${DEBUG_LIMITS.zoom_max}.`);
          const w = o.clip ? o.clip.width : vp.width, h = o.clip ? o.clip.height : vp.height;
          if (Math.max(w, h) * z > DEBUG_LIMITS.shot_edge + 0.5 || w * h * z * z > DEBUG_LIMITS.shot_pixels) fail(`Step ${i + 1} (screenshot): at zoom ${z} the picture would be ${Math.round(w * z)} × ${Math.round(h * z)}; keep it within ${DEBUG_LIMITS.shot_edge} px on its longest side and ${DEBUG_LIMITS.shot_pixels / 1e6} megapixels: clip a smaller region (at most ${Math.floor(DEBUG_LIMITS.shot_edge / z)} px wide or high).`);
          if (z > 1) o.zoom = z;
        }
        break;
      }
      case 'eval':
        if (typeof s.js !== 'string' || !s.js.trim()) fail(`Step ${i + 1} (eval) needs js: an expression to evaluate in the game page.`);
        if (s.js.length > DEBUG_LIMITS.eval_chars) fail(`Step ${i + 1} (eval): at most ${DEBUG_LIMITS.eval_chars} characters.`);
        o.js = s.js; break;
    }
    return o;
  });
  if (waited > DEBUG_LIMITS.wait_ms) fail(`The waits in one call add up to at most ${DEBUG_LIMITS.wait_ms / 1000} seconds (these add up to ${Math.round(waited / 100) / 10}); split them over several calls.`);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isPlaywright = (page) => typeof page.context === 'function';

async function tap(page, x, y) {
  try { await page.touchscreen.tap(x, y); return; } catch { /* Playwright without touch */ }
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await cdp.detach().catch(() => {}); }
}
async function wheel(page, x, y, dx, dy) {
  if (x !== undefined) await page.mouse.move(x, y);
  if (isPlaywright(page)) await page.mouse.wheel(dx, dy); else await page.mouse.wheel({ deltaX: dx, deltaY: dy });
}

/** What the SDK knows about the game right now, plus the game's own GCP.test.onState(fn) answer. */
export async function gameState(page) {
  return page.evaluate((stateChars) => {
    const s = window.__GCP;
    if (!s) return { sdk: false, title: document.title, url_path: location.pathname };
    let state = null;
    try { state = typeof s.debugState === 'function' ? s.debugState() : null; } catch (e) { state = 'onState threw: ' + (e && e.message || e); }
    if (state !== null && typeof state !== 'string') { try { state = JSON.stringify(state); } catch { state = String(state); } }
    return { sdk: true, ready: !!s.ready, frames: s.frames, fatal: s.fatal || null, loading: s.busy ? (s.label || true) : false, label: s.label || '',
      errors: s.errors.slice(0, 15), console_errors: s.warnings.slice(0, 10), console_warnings: (s.warns || []).slice(-10), platform_calls: (s.calls || []).slice(-10), missing_files: s.missing.slice(0, 10),
      game_state: state ? String(state).slice(0, stateChars) : null, title: document.title, url_path: location.pathname };
  }, DEBUG_LIMITS.state_chars);
}

/**
 * A picture of the viewport (or of clip, in CSS pixels of the viewport): a JPEG by default, or a PNG (exact colours and
 * hard pixel edges). zoom > 1 has the browser render the region again at that scale (page text and shapes come out sharp,
 * a canvas drawn with image-rendering: pixelated keeps its square pixels), not an enlargement of a 1× picture.
 * Puppeteer would capture a clip "beyond the viewport" by default, which resizes the page for the shot: the game would
 * get a resize event and could be caught re-laying out. The viewport as it is, never resized, is what the agent asked for.
 */
export async function shoot(page, clip, quality = 72, o = {}) {
  const format = o.format === 'png' ? 'png' : 'jpeg', zoom = o.zoom > 1 ? o.zoom : 1;
  if (!isPlaywright(page)) {
    const vp = page.viewport() || { width: 960, height: 540 };
    const c = clip || zoom > 1 ? { ...(clip || { x: 0, y: 0, width: vp.width, height: vp.height }), ...(zoom > 1 ? { scale: zoom } : {}) } : null;
    const buf = await page.screenshot({ type: format, ...(format === 'jpeg' ? { quality } : {}), ...(c ? { clip: c } : {}), captureBeyondViewport: false });
    return new Uint8Array(buf);
  }
  if (zoom === 1) return new Uint8Array(await page.screenshot({ type: format, ...(format === 'jpeg' ? { quality } : {}), ...(clip ? { clip } : {}) }));
  // Playwright has no zoomed capture: the browser's debugging protocol does it (the local verifier runs Chromium)
  const vp = page.viewportSize() || { width: 960, height: 540 };
  const cdp = await page.context().newCDPSession(page);
  try {
    const r = await cdp.send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality } : {}), clip: { ...(clip || { x: 0, y: 0, width: vp.width, height: vp.height }), scale: zoom }, captureBeyondViewport: false });
    return new Uint8Array(Buffer.from(r.data, 'base64'));
  } finally { await cdp.detach().catch(() => {}); }
}

/**
 * The pictures one call returns: its screenshot steps, then "now" (the viewport as the call ends), unless the last step
 * was a screenshot that was taken: that one already shows the end of the call.
 */
export async function callShots(page, steps, run) {
  const last = steps[steps.length - 1];
  if (last && last.do === 'screenshot' && !run.stopped && run.log[run.log.length - 1]?.ok) return run.shots;
  return [...run.shots, { label: 'now', bytes: await shoot(page), type: 'image/jpeg' }];
}

/** A screenshot step's picture: a PNG over the size cap is taken again as a JPEG, and the shot says so. */
export async function shootStep(page, s) {
  const zoom = s.zoom || 1;
  let bytes = await shoot(page, s.clip, 72, { format: s.format, zoom }), type = s.format === 'png' ? 'image/png' : 'image/jpeg', note = '';
  if (s.format === 'png' && bytes.byteLength > DEBUG_LIMITS.png_bytes) {
    const kb = Math.round(bytes.byteLength / 1000);
    bytes = await shoot(page, s.clip, 90, { zoom }); type = 'image/jpeg';
    note = `sent as JPEG (quality 90): the PNG was ${kb} kB, over the ${DEBUG_LIMITS.png_bytes / 1e6} MB cap; clip a smaller region for a PNG`;
  }
  return { label: s.label, bytes, type, ...(zoom > 1 ? { zoom } : {}), ...(note ? { note } : {}) };
}
/**
 * Runs checked steps on the page. Returns { log: [{ step, do, ok, detail? }], shots: [{ label, bytes }] }.
 * A failing step is logged and the rest still run, except after a failed wait_for, which stops the call.
 */
export async function runSteps(page, steps) {
  const log = [], shots = [];
  // an alert or confirm would stop the page until someone answered it (a reconnected page has lost its handler)
  if (!page.__gcpDialogs) { page.__gcpDialogs = true; page.on('dialog', (d) => { d.dismiss().catch(() => {}); }); }
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i], entry = { step: i + 1, do: s.do, ok: true };
    try {
      switch (s.do) {
        case 'click': await page.mouse.click(s.x, s.y, { button: s.button, clickCount: s.count, ...(isPlaywright(page) ? {} : { count: s.count }) }); break;
        case 'double_click': await page.mouse.click(s.x, s.y, { clickCount: 2, ...(isPlaywright(page) ? {} : { count: 2 }) }); break;
        case 'right_click': await page.mouse.click(s.x, s.y, { button: 'right' }); break;
        case 'move': await page.mouse.move(s.x, s.y, { steps: 4 }); break;
        case 'down': if (s.x !== undefined) await page.mouse.move(s.x, s.y); await page.mouse.down({ button: s.button }); break;
        case 'up': if (s.x !== undefined) await page.mouse.move(s.x, s.y); await page.mouse.up({ button: s.button }); break;
        case 'drag': {
          const n = Math.max(2, Math.round(s.ms / 16));
          await page.mouse.move(s.x, s.y); await page.mouse.down();
          for (let k = 1; k <= n; k++) { await page.mouse.move(s.x + (s.to_x - s.x) * k / n, s.y + (s.to_y - s.y) * k / n); await sleep(s.ms / n); }
          await page.mouse.up(); break;
        }
        case 'tap': await tap(page, s.x, s.y); break;
        case 'scroll': await wheel(page, s.x, s.y, s.dx, s.dy); break;
        case 'key':
          if (s.hold_ms) { await page.keyboard.down(s.key); await sleep(s.hold_ms); await page.keyboard.up(s.key); }
          else await page.keyboard.press(s.key);
          break;
        case 'key_down': await page.keyboard.down(s.key); break;
        case 'key_up': await page.keyboard.up(s.key); break;
        case 'type': await page.keyboard.type(s.text, { delay: 15 }); break;
        case 'wait': await sleep(s.ms); break;
        case 'wait_for': {
          const t0 = Date.now(), f0 = s.until === 'frames' ? (await gameState(page)).frames || 0 : 0;
          let met = false;
          while (Date.now() - t0 < s.timeout_ms) {
            met = await page.evaluate(([until, text, want]) => {
              const g = window.__GCP;
              if (until === 'ready') return !!(g && (g.ready || g.fatal));
              if (until === 'frames') return !!g && g.frames >= want;
              return (document.body?.innerText || '').toLowerCase().includes(String(text).toLowerCase());
            }, [s.until, s.text || '', f0 + (s.frames || 0)]).catch(() => false);
            if (met) break;
            await sleep(150);
          }
          entry.detail = met ? `met after ${Date.now() - t0} ms` : `not met within ${s.timeout_ms} ms`;
          if (!met) { entry.ok = false; log.push(entry); return { log, shots, stopped: i + 1 }; }
          break;
        }
        case 'screenshot': shots.push(await shootStep(page, { ...s, label: s.label || `after step ${i}` })); break;
        case 'eval': {
          // Evaluated through the browser's debugging protocol, so the page's own script policy does not apply.
          // js is an expression, or statements that end in return.
          const wrap = (body) => `(async () => { const v = await (async () => { ${body} })(); try { return v === undefined ? 'undefined' : typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)); } catch (e) { return String(v); } })()`;
          let value;
          try { value = await page.evaluate(wrap(`return (\n${s.js}\n);`)); }
          catch (e) { if (!/SyntaxError|Unexpected (token|identifier|end of input|string|number)|missing \) |Illegal return/.test(String(e && e.message))) throw e; value = await page.evaluate(wrap(s.js)); }
          entry.detail = String(value).slice(0, DEBUG_LIMITS.eval_result_chars);
          break;
        }
      }
    } catch (e) { entry.ok = false; entry.detail = String(e && e.message || e).slice(0, 300); }
    log.push(entry);
  }
  return { log, shots, stopped: 0 };
}

/** Opens the game and waits for it to start (GCP.ready, GCP.fatal or the timeout). */
export async function openGame(page, url, vp, readyMs = 20000) {
  if (!isPlaywright(page)) await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1, isMobile: !!vp.touch, hasTouch: !!vp.touch });
  else await page.setViewportSize({ width: vp.width, height: vp.height });
  if (!page.__gcpDialogs) { page.__gcpDialogs = true; page.on('dialog', (d) => { d.dismiss().catch(() => {}); }); }
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  let started = false;
  while (Date.now() - t0 < readyMs) {
    started = await page.evaluate(() => !!(window.__GCP && (window.__GCP.ready || window.__GCP.fatal))).catch(() => false);
    if (started) break;
    await sleep(250);
  }
  return { started, ms: Date.now() - t0 };
}

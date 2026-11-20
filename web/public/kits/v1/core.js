// @gcp/core.js — small, engine-agnostic building blocks. Everything here is optional.
// Conventions these encode (verified in shipped games):
//  - all randomness is seeded, so a world can be rebuilt from one number
//  - dt is clamped, so a background tab or a hitch never teleports the simulation
//  - a boot screen shows at once and failures are reported, never a blank page

export const TAU = Math.PI * 2;
export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// Seeded randomness and simplex noise live in procgen/noise.js (one implementation, frozen per version).
export { mulberry32, strSeed, Simplex, rng } from './procgen/noise.js';

/**
 * Frame loop. update(dt, time) runs once per frame with dt clamped to maxDt (or in fixed steps when
 * fixedStep > 0); render(alpha) follows. A throwing update is logged once per message and does not kill the loop.
 */
export function createLoop({ update, render, maxDt = 0.1, fixedStep = 0 }) {
  let raf = 0, last = 0, acc = 0, time = 0, running = false; const seen = new Set();
  const loop = { fps: 60, frame: 0, start, stop };
  const guard = (fn, a, b) => { try { fn(a, b); } catch (e) { const k = String(e && e.message); if (!seen.has(k)) { seen.add(k); console.error(e); } } };
  function tick(now) {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    let dt = Math.min(maxDt, (now - last) / 1000); last = now;
    if (dt <= 0) dt = 1 / 60;
    loop.fps += (1 / dt - loop.fps) * 0.05; loop.frame++;
    if (fixedStep > 0) { acc += dt; let n = 0; while (acc >= fixedStep && n++ < 5) { time += fixedStep; guard(update, fixedStep, time); acc -= fixedStep; } if (n > 5) acc = 0; if (render) guard(render, acc / fixedStep); }
    else { time += dt; guard(update, dt, time); if (render) guard(render, 1); }
  }
  function start() { if (running) return loop; running = true; last = performance.now(); raf = requestAnimationFrame(tick); return loop; }
  function stop() { running = false; cancelAnimationFrame(raf); }
  return loop;
}

/**
 * A boot screen that appears immediately, drawn in its own canvas over the page (the platform contract: everything
 * the player sees is drawn in canvases). set(0..1, label) updates it and GCP.progress; done() fades it out;
 * fail(err) shows the error and reports GCP.fatal.
 */
export function createBoot({ title = document.title, accent = '#ffb347', background = '#0b0d0f', color = '#e8e4da' } = {}) {
  const el = document.createElement('canvas'), c = el.getContext('2d');
  el.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:1000;pointer-events:auto;touch-action:none';
  el.setAttribute('aria-label', title);
  (document.body || document.documentElement).appendChild(el);
  const FONT = "system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
  let f = 0, shown = 0, label = '', err = '', alpha = 1, gone = false;
  function draw() {
    if (gone) return;
    const w = innerWidth, h = innerHeight, d = Math.min(3, devicePixelRatio || 1);
    if (el.width !== Math.round(w * d) || el.height !== Math.round(h * d)) { el.width = Math.round(w * d); el.height = Math.round(h * d); }
    c.setTransform(d, 0, 0, d, 0, 0); c.clearRect(0, 0, w, h); c.globalAlpha = alpha;
    c.fillStyle = background; c.fillRect(0, 0, w, h);
    const bw = Math.min(360, w * 0.8), x = (w - bw) / 2, y = h / 2;
    c.fillStyle = color; c.textAlign = 'center'; c.textBaseline = 'alphabetic'; c.font = `800 26px ${FONT}`;
    let t = String(title); while (t.length > 1 && c.measureText(t).width > w - 32) t = t.slice(0, -2) + '…';
    c.fillText(t, w / 2, y - 18);
    c.fillStyle = 'rgba(255,255,255,.12)'; c.beginPath(); c.roundRect(x, y - 2, bw, 4, 2); c.fill();
    if (shown > 0) { c.fillStyle = accent; c.beginPath(); c.roundRect(x, y - 2, Math.max(4, bw * shown), 4, 2); c.fill(); }
    const m = err || label; if (m) { c.font = `14px ${FONT}`; c.fillStyle = err ? '#ff8a70' : color; c.globalAlpha = alpha * (err ? 1 : 0.65); let line = '', ly = y + 28; for (const word of m.split(' ')) { const tt = line ? line + ' ' + word : word; if (c.measureText(tt).width > Math.max(bw, w - 40) && line) { c.fillText(line, w / 2, ly); line = word; ly += 20; } else line = tt; } c.fillText(line, w / 2, ly); }
  }
  let raf = 0; const tick = () => { raf = 0; shown += (f - shown) * 0.35; if (Math.abs(f - shown) < 0.002) shown = f; draw(); if (shown !== f || alpha < 1) raf = requestAnimationFrame(tick); };
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
  addEventListener('resize', draw); draw();
  const G = () => window.GCP;
  return {
    el,
    set(v, text = '') { f = clamp(v); label = text; draw(); kick(); if (G()) G().progress(v, text); },
    /** Yields to the browser so the bar actually repaints between heavy steps. */
    async step(v, text) { this.set(v, text); await new Promise((r) => setTimeout(r, 16)); },
    done() { f = shown = 1; el.style.pointerEvents = 'none'; const t0 = performance.now(); const fade = () => { alpha = Math.max(0, 1 - (performance.now() - t0) / 400); draw(); if (alpha > 0) requestAnimationFrame(fade); else { gone = true; removeEventListener('resize', draw); el.remove(); } }; requestAnimationFrame(fade); setTimeout(() => { if (!gone) { gone = true; el.remove(); } }, 1500); },
    fail(e) { err = 'Could not start: ' + (e && e.message || e); draw(); if (G()) G().fatal(e); },
  };
}

/** 'low' | 'medium' | 'high' from a saved choice or a guess about the device. */
export function pickQuality(saved) {
  if (saved === 'low' || saved === 'medium' || saved === 'high') return saved;
  const coarse = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  const cores = navigator.hardwareConcurrency || 4, mem = navigator.deviceMemory || 4;
  if (coarse) return cores >= 8 && mem >= 6 ? 'medium' : 'low';
  return cores >= 8 && mem >= 8 ? 'high' : 'medium';
}

/** localStorage that never throws (private mode, sandboxed frames). Values are JSON. */
export const store = {
  get(key, fallback = null) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
};

/** Calls fn(dt) about every `ms` while the tab is hidden (rAF stops there). Use it to keep a multiplayer host simulating. */
export function backgroundTicker(fn, ms = 50) {
  try {
    const w = new Worker(URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms})`], { type: 'text/javascript' })));
    let last = 0;
    w.onmessage = () => { if (!document.hidden) { last = 0; return; } const t = performance.now(), dt = last ? Math.min(0.25, (t - last) / 1000) : ms / 1000; last = t; try { fn(dt); } catch (e) { console.error(e); } };
    return () => w.terminate();
  } catch { return () => {}; }
}

/**
 * Runs an async main(boot) with a boot screen; any error is shown and reported instead of leaving a blank page.
 *   run(async (boot) => { await boot.step(0.3, 'Growing the forest'); …build…; boot.done(); });
 * boot.step(0..1, label) updates the bar (and GCP.progress) and lets the browser paint before the next heavy step;
 * boot.done() fades the screen out once the game is running.
 */
export async function run(main, bootOptions) {
  const boot = createBoot(bootOptions);
  try { await main(boot); } catch (e) { console.error(e); boot.fail(e); }
}

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
 * A boot overlay that appears immediately. set(0..1, label) updates it and GCP.progress;
 * done() fades it out; fail(err) shows the error and reports GCP.fatal.
 */
export function createBoot({ title = document.title, accent = '#ffb347', background = '#0b0d0f', color = '#e8e4da' } = {}) {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;inset:0;z-index:1000;display:grid;place-items:center;background:${background};color:${color};font:14px/1.4 system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;transition:opacity .4s`;
  el.innerHTML = `<div style="width:min(360px,80vw);text-align:center"><div data-t style="font-size:26px;font-weight:800;letter-spacing:.02em;margin-bottom:14px"></div><div style="height:4px;border-radius:2px;background:rgba(255,255,255,.12);overflow:hidden"><i style="display:block;height:100%;width:0;background:${accent};transition:width .25s"></i></div><p style="opacity:.65;min-height:20px;margin:10px 0 0"></p></div>`;
  el.querySelector('[data-t]').textContent = title;
  const bar = el.querySelector('i'), msg = el.querySelector('p');
  (document.body || document.documentElement).appendChild(el);
  const G = () => window.GCP;
  return {
    el,
    set(f, label = '') { bar.style.width = Math.round(clamp(f) * 100) + '%'; msg.textContent = label; if (G()) G().progress(f, label); },
    /** Yields to the browser so the bar actually repaints between heavy steps. */
    async step(f, label) { this.set(f, label); await new Promise((r) => setTimeout(r, 16)); },
    done() { bar.style.width = '100%'; el.style.opacity = '0'; el.style.pointerEvents = 'none'; setTimeout(() => el.remove(), 450); },
    fail(err) { msg.style.opacity = '1'; msg.style.color = '#ff8a70'; msg.textContent = 'Could not start: ' + (err && err.message || err); if (G()) G().fatal(err); },
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

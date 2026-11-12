// @gcp/core.js — small, engine-agnostic building blocks. Everything here is optional.
// Conventions these encode (verified in shipped games):
//  - all randomness is seeded, so a world can be rebuilt from one number
//  - dt is clamped, so a background tab or a hitch never teleports the simulation
//  - a boot screen shows at once and failures are reported, never a blank page

export const TAU = Math.PI * 2;
export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Deterministic PRNG. const rand = mulberry32(1234); rand() -> [0, 1) */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Hash any string to a 32-bit seed. */
export function strSeed(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/** Seeded simplex noise. n2/n3 return [-1, 1]; fbm2 layers octaves and returns roughly [-1, 1]. */
export class Simplex {
  constructor(seed = 1) {
    const r = mulberry32(seed), p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; }
    this.perm = new Uint8Array(512); for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  n2(x, y) {
    const F = 0.3660254037844386, G = 0.21132486540518713, P = this.perm;
    const s = (x + y) * F, i = Math.floor(x + s), j = Math.floor(y + s), t = (i + j) * G;
    const x0 = x - (i - t), y0 = y - (j - t), i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G, y1 = y0 - j1 + G, x2 = x0 - 1 + 2 * G, y2 = y0 - 1 + 2 * G, ii = i & 255, jj = j & 255;
    const g = (h, a, b) => { const u = h & 7, k = u < 4 ? a : b, l = u < 4 ? b : a; return ((u & 1) ? -k : k) + ((u & 2) ? -2 * l : 2 * l); };
    let n = 0, a = 0.5 - x0 * x0 - y0 * y0;
    if (a > 0) { a *= a; n += a * a * g(P[ii + P[jj]], x0, y0); }
    a = 0.5 - x1 * x1 - y1 * y1; if (a > 0) { a *= a; n += a * a * g(P[ii + i1 + P[jj + j1]], x1, y1); }
    a = 0.5 - x2 * x2 - y2 * y2; if (a > 0) { a *= a; n += a * a * g(P[ii + 1 + P[jj + 1]], x2, y2); }
    return clamp(n * 38, -1, 1);
  }
  n3(x, y, z) { // cheap 3D: blend three 2D slices (smooth, fine for displacing shapes)
    return (this.n2(x + z * 0.7, y - z * 0.4) + this.n2(y + 31.4, z + x * 0.6) + this.n2(z - 12.7, x + y * 0.5)) / 3;
  }
  fbm2(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) { sum += amp * this.n2(x * freq, y * freq); norm += amp; amp *= gain; freq *= lacunarity; }
    return sum / norm;
  }
}

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

/** Runs an async main(boot) with a boot screen; any error is shown and reported instead of leaving a blank page. */
export async function run(main, bootOptions) {
  const boot = createBoot(bootOptions);
  try { await main(boot); } catch (e) { console.error(e); boot.fail(e); }
}

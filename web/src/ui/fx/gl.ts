// Capability detection and preferences for the effects layer. Effects are on by default; this module decides how
// much of them a browser gets, and every step down leaves the page itself untouched:
//
//   full   WebGL 2 on a real GPU, desktop-class: the Three.js world (toon-shaded meshes, generated textures, bloom),
//          the GPU-drawn billboard, and the cartoon particle overlay. Up to 60 fps.
//   lite   WebGL 2 on a phone, a weak device or Save-Data: the same world at low resolution and 30 fps, fewer
//          meshes, no bloom; the overlay keeps a smaller particle budget.
//   basic  No WebGL 2 (WebGL 1-only devices, old Safari and Android browsers), a software renderer, or a GPU that
//          failed once this session: the world is painted once with Canvas 2D, and the overlay still runs.
//   still  Reduced motion: one frame of the world (Three.js where it can run, else Canvas 2D), no animation,
//          no particles.
//   off    The person switched effects off, or the browser has no canvas at all: the CSS look stands alone.
//
// Nothing in the page depends on the layer: text, controls and pictures are DOM, and the CSS background underneath
// is complete on its own, so any failure only ever removes decoration.

import { color } from '../tokens';

export type FxTier = 'full' | 'lite' | 'basic' | 'still' | 'off';
/** Which renderer draws the world behind the page. */
export type FxEngine = 'three' | 'canvas' | 'none';
export interface FxPlan { tier: FxTier; engine: FxEngine; /** why this tier: shown in __fx.stats for support */ reason: string }

const PREF_KEY = 'fx', FAIL_KEY = 'fx.fail';
const read = (s: () => Storage, k: string) => { try { return s().getItem(k); } catch { return null; } };
const write = (s: () => Storage, k: string, v: string | null) => { try { if (v === null) s().removeItem(k); else s().setItem(k, v); } catch { /* private mode */ } };

/** Effects are on unless the person switched them off in this browser. */
export const fxPref = (): 'on' | 'off' => (read(() => localStorage, PREF_KEY) === 'off' ? 'off' : 'on');
export function setFxPref(v: 'on' | 'off') {
  write(() => localStorage, PREF_KEY, v === 'off' ? 'off' : null);
  if (v === 'on') write(() => sessionStorage, FAIL_KEY, null); // switching back on gives the GPU another chance
  replan();
}
/** localStorage fx=force: skip the GPU checks and the automatic quality drops (for testing on machines without a GPU). */
export const fxForced = () => read(() => localStorage, PREF_KEY) === 'force';

/** The GPU path failed in this tab (an init error, a shader that would not compile, a lost context): remember it
 *  for the rest of the session so the next page load goes straight to the Canvas 2D look instead of failing again. */
export function markGpuFailed(why: string) { write(() => sessionStorage, FAIL_KEY, why.slice(0, 80)); replan(); }

let memo: FxPlan | undefined;
export function fxPlan(): FxPlan {
  if (memo) return memo;
  memo = detect();
  if (typeof document !== 'undefined') { document.documentElement.dataset.fx = memo.tier; document.documentElement.dataset.fxEngine = memo.engine; }
  return memo;
}
export const fxTier = (): FxTier => fxPlan().tier;
function replan() { memo = undefined; if (typeof window !== 'undefined') dispatchEvent(new Event('fxchange')); }

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;

/** Renderers that would make the page slower rather than nicer, or that are known to mis-render shaders. */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen|microsoft basic/i;

/** What WebGL 2 on this device can do, without keeping a context alive. */
function probeGl2(force: boolean): { ok: boolean; why: string } {
  let cv: HTMLCanvasElement;
  try { cv = document.createElement('canvas'); } catch { return { ok: false, why: 'no canvas' }; }
  const get = (caveat: boolean) => {
    try { return cv.getContext('webgl2', { failIfMajorPerformanceCaveat: caveat, antialias: false, depth: false, stencil: false }) as WebGL2RenderingContext | null; } catch { return null; }
  };
  const gl = get(!force);
  if (!gl) {
    // A second try without the caveat only tells us why: WebGL 2 exists but runs in software.
    const soft = !force && (cv = document.createElement('canvas'), get(false));
    soft && soft.getExtension('WEBGL_lose_context')?.loseContext();
    return { ok: false, why: soft ? 'webgl2 software' : 'no webgl2' };
  }
  let why = '';
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    if (!force && SOFTWARE.test(renderer)) why = 'software renderer';
    else if (gl.getParameter(gl.MAX_TEXTURE_SIZE) < 4096) why = 'small textures';
    else if (!gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision) why = 'no highp';
    else if (gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) < 128) why = 'few uniforms';
  } catch { why = 'probe failed'; }
  gl.getExtension('WEBGL_lose_context')?.loseContext(); // hand the probe context back straight away
  return { ok: !why, why: why || 'webgl2' };
}

function detect(): FxPlan {
  if (typeof window === 'undefined') return { tier: 'off', engine: 'none', reason: 'server' };
  if (fxPref() === 'off') return { tier: 'off', engine: 'none', reason: 'switched off' };
  let has2d = false;
  try { has2d = !!document.createElement('canvas').getContext('2d'); } catch { /* none */ }
  if (!has2d) return { tier: 'off', engine: 'none', reason: 'no canvas' };
  const force = fxForced(), failed = read(() => sessionStorage, FAIL_KEY);
  const gl2 = failed && !force ? { ok: false, why: 'gpu failed: ' + failed } : probeGl2(force);
  if (reduced()) return { tier: 'still', engine: gl2.ok ? 'three' : 'canvas', reason: 'reduced motion; ' + gl2.why };
  if (!gl2.ok) return { tier: 'basic', engine: 'canvas', reason: gl2.why };
  const phone = mq('(pointer: coarse)') && Math.min(screen.width, screen.height) < 600;
  if (phone || (!force && fxWeak())) return { tier: 'lite', engine: 'three', reason: phone ? 'phone' : 'weak device' };
  return { tier: 'full', engine: 'three', reason: 'webgl2' };
}

if (typeof window !== 'undefined' && typeof matchMedia === 'function') {
  const m = matchMedia('(prefers-reduced-motion: reduce)');
  // Safari before 14 only has addListener.
  if (m.addEventListener) m.addEventListener('change', replan); else (m as MediaQueryList & { addListener?: (f: () => void) => void }).addListener?.(replan);
}

let held = false;
/** Pauses the page's effects layer while another GPU scene fills the view, so the two never compete for the GPU. */
export function holdFx(on: boolean) { if (on === held) return; held = on; dispatchEvent(new CustomEvent('fx:hold', { detail: on })); }
export const fxHeld = () => held;
/** Weak hardware, Save-Data or reduced data: worth the light version. */
export function fxWeak() {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) || (navigator.hardwareConcurrency || 8) <= 4 || !!nav.connection?.saveData || mq('(prefers-reduced-data: reduce)');
}

/** Brand colours from the design tokens, so the generated art follows tokens.ts like everything else. */
export const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
export const palette = { ink: color.bg0, violet: color.violet, accent: color.accent, hot: color.hot, cyan: color.cyan, gold: color.gold, good: color.good, text: color.text } as const;

/** Which world the page is in: the store's night sky, or the creators' workshop. */
export type FxTheme = 'arcade' | 'workshop';
export const themeFor = (path: string): FxTheme => (/^\/(console|create|docs|admin|device|claim-admin)/.test(path) ? 'workshop' : 'arcade');

/** A render loop that pauses while the tab is hidden and caps its frame rate. */
export function loop(frame: (now: number) => void, fps: number) {
  let raf = 0, last = 0, running = false;
  const step = 1000 / fps - 2;
  const tick = (now: number) => { raf = requestAnimationFrame(tick); if (now - last >= step) { last = now; frame(now); } };
  const start = () => { if (!running && !document.hidden) { running = true; raf = requestAnimationFrame(tick); } };
  const stop = () => { running = false; cancelAnimationFrame(raf); };
  const vis = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', vis);
  start();
  return () => { stop(); document.removeEventListener('visibilitychange', vis); };
}

/** A small seeded random generator, so generated art is the same on every visit. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

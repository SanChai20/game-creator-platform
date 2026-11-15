// Device detection and preferences for the GPU layer (see pipeline.ts). Everything degrades instead of failing:
// no WebGL 2, a software renderer, a lost context, a slow GPU or a reduced-motion preference each lead to a calmer
// tier, and the plain CSS look underneath is always complete on its own.

import { color } from '../tokens';

/** How much of the GPU layer this device and person get.
 *  full: the whole pipeline at up to 1.5x pixel density, 60 fps; covers, billboard and posters are drawn by the GPU.
 *  lite: phones and weak devices; background and post-processing at low resolution and 30 fps, covers stay plain images.
 *  still: reduced motion; one rendered frame of the background, no animation, no transitions.
 *  off: no WebGL 2, or the person turned effects off; the CSS look stands alone. */
export type FxTier = 'full' | 'lite' | 'still' | 'off';

const PREF_KEY = 'fx';
export const fxPref = (): 'on' | 'off' => { try { return localStorage.getItem(PREF_KEY) === 'off' ? 'off' : 'on'; } catch { return 'on'; } };
export function setFxPref(v: 'on' | 'off') {
  try { localStorage.setItem(PREF_KEY, v); } catch { /* private mode: the choice lasts for this page only */ }
  memo = undefined; dispatchEvent(new Event('fxchange'));
}

/** localStorage fx=force: skip the GPU check and the automatic quality drops (for testing on machines without a GPU). */
export const fxForced = () => { try { return localStorage.getItem(PREF_KEY) === 'force'; } catch { return false; } };

let memo: FxTier | undefined;
/** Decides the tier once per page (and again when the person flips the switch or the motion preference changes). */
export function fxTier(): FxTier {
  if (memo) return memo;
  memo = detect();
  document.documentElement.dataset.fx = memo;
  return memo;
}
function detect(): FxTier {
  if (typeof window === 'undefined' || fxPref() === 'off') return 'off';
  // failIfMajorPerformanceCaveat: a software-rendered context (no GPU) would make the page slower, not nicer.
  const force = fxForced();
  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2', { failIfMajorPerformanceCaveat: !force }) as WebGL2RenderingContext | null;
  if (!gl) return 'off';
  gl.getExtension('WEBGL_lose_context')?.loseContext(); // give the probe context back straight away
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 'still';
  const weak = fxWeak();
  const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
  return (weak && !force) || phone ? 'lite' : 'full';
}
if (typeof window !== 'undefined') {
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => { memo = undefined; dispatchEvent(new Event('fxchange')); });
}

let held = false;
/** Pauses the page's GPU layer while another GPU scene fills the view (the exhibition hall), so the two never compete
 *  for the GPU. The layer keeps its last frame and carries on when released. */
export function holdFx(on: boolean) { if (on === held) return; held = on; dispatchEvent(new CustomEvent('fx:hold', { detail: on })); }
export const fxHeld = () => held;
/** Weak hardware or Save-Data: worth the light background, not a 3D scene and its download. */
export function fxWeak() {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) || (navigator.hardwareConcurrency || 8) <= 4 || !!nav.connection?.saveData;
}

/** Brand colours from the design tokens as GLSL vec3s, so shaders follow tokens.ts like everything else. */
export const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
export const palette = { ink: rgb(color.bg0), violet: rgb(color.violet), accent: rgb(color.accent), hot: rgb(color.hot), cyan: rgb(color.cyan) };

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

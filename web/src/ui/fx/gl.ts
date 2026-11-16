// Capability detection and preferences for the rendered scenes (ui/fx/CelScene.tsx). A scene is a picture behind a
// few large blocks (the creators' lead, the sign-in page, the invitation bands). It is decoration only: the block
// has a complete CSS painting underneath, so every step down here just leaves that painting showing.
//
//   live   WebGL 2 is available: the scene is drawn by a fragment shader and drifts slowly while it is on screen.
//   still  Reduced motion: the shader draws one frame and stops.
//   off    The person switched effects off, WebGL 2 is missing, or the GPU path failed once this session:
//          the CSS painting stands alone.

export type FxTier = 'live' | 'still' | 'off';
export interface FxPlan { tier: FxTier; /** why this tier: shown in __fx for support */ reason: string }

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
/** The GPU path failed in this tab (a shader that would not compile, a lost context): remember it for the session. */
export function markGpuFailed(why: string) { write(() => sessionStorage, FAIL_KEY, why.slice(0, 80)); replan(); }

let memo: FxPlan | undefined;
export function fxPlan(): FxPlan {
  if (memo) return memo;
  memo = detect();
  if (typeof document !== 'undefined') document.documentElement.dataset.fx = memo.tier;
  return memo;
}
function replan() { memo = undefined; if (typeof window !== 'undefined') { fxPlan(); dispatchEvent(new Event('fxchange')); } }

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function detect(): FxPlan {
  if (typeof window === 'undefined') return { tier: 'off', reason: 'server' };
  if (fxPref() === 'off') return { tier: 'off', reason: 'switched off' };
  const failed = read(() => sessionStorage, FAIL_KEY);
  if (failed) return { tier: 'off', reason: 'gpu failed: ' + failed };
  let ok = false;
  try {
    const gl = document.createElement('canvas').getContext('webgl2', { antialias: false, depth: false, stencil: false });
    ok = !!gl && !!gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision;
    gl?.getExtension('WEBGL_lose_context')?.loseContext(); // hand the probe context back straight away
  } catch { /* no canvas, or WebGL is blocked */ }
  if (!ok) return { tier: 'off', reason: 'no webgl2' };
  return reducedMotion() ? { tier: 'still', reason: 'reduced motion' } : { tier: 'live', reason: 'webgl2' };
}

if (typeof window !== 'undefined' && typeof matchMedia === 'function') {
  const m = matchMedia('(prefers-reduced-motion: reduce)');
  // Safari before 14 only has addListener.
  if (m.addEventListener) m.addEventListener('change', replan); else (m as MediaQueryList & { addListener?: (f: () => void) => void }).addListener?.(replan);
}

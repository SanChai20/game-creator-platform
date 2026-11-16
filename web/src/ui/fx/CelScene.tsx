// A rendered scene for the few large blocks that carry one: dusk over layered hills, shaded the way the games here
// are shaded. Flat colour, a hard edge between light and shade, a rim of light on every ridge and halftone dots
// where one tone gives way to the next. One fragment shader draws it; nothing is loaded.
//
// The scene is decoration. The .scene block has a CSS painting of the same picture underneath, and the canvas only
// appears over it once a frame has been drawn. Without WebGL 2, with effects switched off, or after any failure the
// painting stays. Under reduced motion the shader draws one frame and stops. While the block is off screen or the
// tab is hidden nothing is drawn.
import { useEffect, useRef, useState } from 'react';
import { hue, day } from '../tokens';
import { fxPlan, markGpuFailed, type FxPlan } from './gl';

const v3 = (hex: string) => { const n = parseInt(hex.slice(1), 16); return `vec3(${((n >> 16) & 255) / 255}, ${((n >> 8) & 255) / 255}, ${(n & 255) / 255})`; };

const VERT = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0., 1.); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform float uT, uSeed, uPx;
out vec4 o;
const vec3 INK = ${v3(day.ink)}, PLUM = ${v3(hue.plum)}, WINE = ${v3(hue.wine)}, FLARE = ${v3(hue.flare)}, PEACH = ${v3(hue.peach)}, CREAM = ${v3(hue.cream)}, LILAC = ${v3(hue.lilac)};
float h1(float n) { return fract(sin(n) * 43758.5453123); }
float vn(float x) { float i = floor(x), f = fract(x); f = f * f * (3. - 2. * f); return mix(h1(i), h1(i + 1.), f); }
float fbm(float x) { return vn(x) * .5 + vn(x * 2.03 + 7.1) * .25 + vn(x * 4.01 + 3.7) * .125 + vn(x * 8.1 + 1.3) * .0625; }
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
// A halftone screen at 45 degrees: 1 inside a dot, and the dots grow from nothing (a = 0) until they merge (a = 1).
float dots(vec2 px, float a, float cell) {
  vec2 g = mat2(.7071, -.7071, .7071, .7071) * px / cell, c = fract(g) - .5;
  float r = sqrt(clamp(a, 0., 1.)) * .74;
  return 1. - smoothstep(r - .07, r + .07, length(c));
}
// One ridge line: its height at x.
float peaks(float x) { return (1. - abs(2. * vn(x) - 1.)) * .6 + (1. - abs(2. * vn(x * 2.3 + 4.2) - 1.)) * .28 + vn(x * 6.1) * .12; }
float ridge(float x, float k, float base, float amp, float freq, float drift) {
  float u = x * freq + k * 17.3 + uSeed * 5.1 + uT * drift;
  return base + amp * (mix(fbm(u), peaks(u * .8), k < 2.5 ? .85 : .35) - .4);
}
// A layer of hills: flat colour, a darker shade tone lower down joined by halftone, and a rim of light along the top.
void hill(inout vec3 col, vec2 px, float x, float y, float k, float base, float amp, float freq, float drift, vec3 lit, vec3 shade, vec3 rim, float cell) {
  float h = ridge(x, k, base, amp, freq, drift);
  if (y > h) return;
  float d = h - y, e = .002, slope = (ridge(x + e, k, base, amp, freq, drift) - h) / e;
  float fold = .05 + .07 * vn(x * freq * 2.7 + k * 3.1 + uT * drift * 2.7);      // where the shade tone starts
  vec3 c = mix(lit, shade, dots(px, smoothstep(fold * .35, fold * 1.5, d), cell));
  float w = (1.2 + 1.6 * smoothstep(.1, -.5, slope)) * uPx / uRes.y;                // the rim is wider where the slope faces the sun
  col = d < w ? rim : c;
}
void main() {
  vec2 px = gl_FragCoord.xy, uv = px / uRes;
  float asp = uRes.x / uRes.y, x = uv.x * asp, y = uv.y, cell = 5.5 * uPx;
  // the sky: five flat bands from the horizon up, each giving way to the next through halftone
  vec3 ramp[6] = vec3[6](PEACH, FLARE, WINE, PLUM, INK, INK);
  float s = pow(clamp((y - .3) / .7, 0., 1.), .7) * 4., f = fract(s); int i = int(floor(s));
  vec3 col = mix(ramp[i], ramp[i + 1], dots(px, smoothstep(.3, 1., f), cell));
  // clouds: long flat shapes that take the colour of the band below, so they read as lit from underneath
  float cn = vn2(vec2(x * 1.3 - uT * .012 + uSeed, y * 9.)) * .62 + vn2(vec2(x * 3.1 - uT * .02, y * 21.)) * .38;
  float cb = smoothstep(.36, .5, y) * smoothstep(.95, .7, y);
  if (cn * cb > .6 && i > 0) col = ramp[i - 1];
  // the sun: a flat disc with one crescent of shade, and a halo of dots
  vec2 sc = vec2(asp * .72, .5); float sr = .12, sd = length(vec2(x, y) - sc);
  col = mix(col, PEACH, dots(px, smoothstep(sr * 2.1, sr, sd) * .55, cell) * step(sr, sd));
  if (sd < sr) col = length(vec2(x, y) - sc - vec2(-.035, .03)) < sr * 1.02 ? CREAM : mix(CREAM, PEACH, .75);
  // four layers of hills, far to near
  hill(col, px, x, y, 1., .38, .40, 1.7, .003, mix(FLARE, WINE, .45), WINE, PEACH, cell);
  hill(col, px, x, y, 2., .27, .32, 2.3, .006, WINE, mix(WINE, PLUM, .7), FLARE, cell);
  hill(col, px, x, y, 3., .16, .22, 2.6, .011, PLUM, mix(PLUM, INK, .6), LILAC, cell);
  hill(col, px, x, y, 4., .06, .13, 3.1, .018, mix(INK, PLUM, .25), INK, mix(PLUM, LILAC, .5), cell);
  o = vec4(col, 1.);
}`;

function start(cv: HTMLCanvasElement, seed: number, still: boolean, fail: (why: string) => void) {
  const gl = cv.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'low-power' });
  if (!gl) { fail('no context'); return () => {}; }
  const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader'); return s; };
  let prog: WebGLProgram;
  try {
    prog = gl.createProgram()!; gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
  } catch (e) { fail((e as Error).message); return () => {}; }
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n: string) => gl.getUniformLocation(prog, n), uRes = U('uRes'), uT = U('uT'), uPx = U('uPx');
  gl.uniform1f(U('uSeed'), seed);

  let raf = 0, seen = true, last = 0, dead = false, shown = false;
  const t0 = performance.now() - seed * 40000;
  const draw = (now: number) => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5), w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); }
    gl.uniform2f(uRes, w, h); gl.uniform1f(uPx, dpr); gl.uniform1f(uT, (now - t0) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!shown) { shown = true; cv.classList.add('on'); }
  };
  const tick = (now: number) => { raf = 0; if (dead) return; if (now - last > 30) { last = now; draw(now); } if (!still && seen && !document.hidden) raf = requestAnimationFrame(tick); };
  const wake = () => { if (!raf && !dead) raf = requestAnimationFrame(tick); };
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => { seen = es.some((e) => e.isIntersecting); if (seen) wake(); }) : null;
  io?.observe(cv);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { last = 0; wake(); }) : null;
  ro?.observe(cv);
  const lost = (e: Event) => { e.preventDefault(); fail('context lost'); };
  cv.addEventListener('webglcontextlost', lost);
  document.addEventListener('visibilitychange', wake);
  wake();
  return () => {
    dead = true; cancelAnimationFrame(raf); io?.disconnect(); ro?.disconnect();
    cv.removeEventListener('webglcontextlost', lost); document.removeEventListener('visibilitychange', wake);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
}

/** The scene, filling its nearest positioned ancestor. `seed` picks a different stretch of hills. */
export function CelScene({ seed = 1, className }: { seed?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null), [plan, setPlan] = useState<FxPlan>(() => fxPlan());
  useEffect(() => { const f = () => setPlan(fxPlan()); addEventListener('fxchange', f); return () => removeEventListener('fxchange', f); }, []);
  useEffect(() => {
    const cv = ref.current; if (!cv || plan.tier === 'off') return;
    (window as unknown as { __fx: unknown }).__fx = { plan };
    return start(cv, seed, plan.tier === 'still', (why) => { console.warn('[fx] scene off, the CSS painting stays:', why); markGpuFailed(why); });
  }, [plan, seed]);
  return <div className={'scene' + (className ? ' ' + className : '')} aria-hidden="true">{plan.tier !== 'off' && <canvas key={plan.tier} ref={ref} />}</div>;
}

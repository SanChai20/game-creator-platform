// @gcp/craft.js · stage — the part of a 3D game that decides whether it looks finished before a single
// object is placed: a sky with depth, a sun and ambient light that agree with it, fog that melts distance
// into the horizon, weather, wind, tone mapping, a shadow that follows the action, and quality that adapts.
// One call sets all of it from a mood; every value can be overridden, blended over time, or driven by a clock.
import * as THREE from 'three';
import { createRenderer, fitRenderer, makeSun } from '../three-kit.js';
import { pickQuality, store, createLoop } from '../core.js';

/** Named moods. Pass one to createStage({ mood }), or your own object with any of these fields. */
export const MOODS = {
  'clear-day':   { top: 0x2a6fd0, horizon: 0xcfe7f7, sun: 0xfff1d8, sunPower: 2.7, elevation: 52, azimuth: 35, skyLight: 0xd3e8ff, groundLight: 0x6d7a52, ambient: 1.35, fog: [90, 340], exposure: 1.0, stars: 0, glow: 0xfff0c8, clouds: 0.35 },
  'golden-hour': { top: 0x35549c, horizon: 0xffc58a, sun: 0xffab5e, sunPower: 2.6, elevation: 13, azimuth: 60, skyLight: 0xb9c4e8, groundLight: 0x7a5a3c, ambient: 1.05, fog: [60, 280], exposure: 1.05, stars: 0, glow: 0xff9a4a, clouds: 0.45 },
  'misty-dawn':  { top: 0x8fa9c4, horizon: 0xe9dfd2, sun: 0xffe2bf, sunPower: 1.5, elevation: 18, azimuth: -50, skyLight: 0xd9e2ea, groundLight: 0x76806c, ambient: 1.55, fog: [14, 120], exposure: 1.0, stars: 0, glow: 0xfff0d8, clouds: 0.2 },
  overcast:      { top: 0x7f8c9a, horizon: 0xc3cad0, sun: 0xe6ecf2, sunPower: 1.1, elevation: 62, azimuth: 20, skyLight: 0xdfe6ee, groundLight: 0x6a6f66, ambient: 1.9, fog: [50, 240], exposure: 0.95, stars: 0, glow: 0xffffff, clouds: 0.9 },
  storm:         { top: 0x2c3540, horizon: 0x6f7b86, sun: 0xb8c6d6, sunPower: 0.8, elevation: 48, azimuth: -20, skyLight: 0xa9b6c4, groundLight: 0x3c4244, ambient: 1.5, fog: [28, 170], exposure: 0.9, stars: 0, glow: 0xdde8f5, clouds: 1 },
  dusk:          { top: 0x1c2452, horizon: 0xd9778a, sun: 0xff8f6a, sunPower: 1.4, elevation: 5, azimuth: 80, skyLight: 0x8f95cf, groundLight: 0x4a3a4a, ambient: 0.95, fog: [50, 240], exposure: 1.05, stars: 0.35, glow: 0xff7a5a, clouds: 0.4 },
  night:         { top: 0x050a1c, horizon: 0x22385e, sun: 0xa8c0ff, sunPower: 1.15, elevation: 42, azimuth: -40, skyLight: 0x6f8ad0, groundLight: 0x2c3a50, ambient: 1.25, fog: [40, 220], exposure: 1.15, stars: 1, glow: 0xcfdcff, clouds: 0.15, moon: true },
  desert:        { top: 0x2f7fd6, horizon: 0xf3dfb8, sun: 0xfff0cc, sunPower: 3.1, elevation: 64, azimuth: 15, skyLight: 0xe8ecf5, groundLight: 0xb08a55, ambient: 1.4, fog: [110, 420], exposure: 1.0, stars: 0, glow: 0xfff3d0, clouds: 0.05 },
  arctic:        { top: 0x5f9ad8, horizon: 0xe6f1fa, sun: 0xfdf6ee, sunPower: 2.2, elevation: 22, azimuth: 30, skyLight: 0xe2eefc, groundLight: 0xa9bdd0, ambient: 1.7, fog: [70, 300], exposure: 0.95, stars: 0, glow: 0xffffff, clouds: 0.3 },
  autumn:        { top: 0x4a7fc0, horizon: 0xf0d9b6, sun: 0xffd9a0, sunPower: 2.4, elevation: 30, azimuth: 45, skyLight: 0xd8dff0, groundLight: 0x80603a, ambient: 1.25, fog: [70, 300], exposure: 1.0, stars: 0, glow: 0xffd08a, clouds: 0.4 },
  volcanic:      { top: 0x1f1014, horizon: 0xc04a1c, sun: 0xffa060, sunPower: 2.5, elevation: 24, azimuth: 10, skyLight: 0xc8866a, groundLight: 0x7a3a22, ambient: 1.6, fog: [40, 200], exposure: 1.2, stars: 0.1, glow: 0xff5a1a, clouds: 0.8 },
  alien:         { top: 0x1c0f3f, horizon: 0x3fd6c0, sun: 0xd9ff9a, sunPower: 2.0, elevation: 35, azimuth: -60, skyLight: 0x8a7ad8, groundLight: 0x1f5a55, ambient: 1.2, fog: [50, 260], exposure: 1.05, stars: 0.6, glow: 0xb8ffd8, clouds: 0.3 },
  'neon-night':  { top: 0x0a0718, horizon: 0x6a2490, sun: 0x9fc0ff, sunPower: 1.2, elevation: 50, azimuth: 0, skyLight: 0xa67af0, groundLight: 0x40306a, ambient: 1.7, fog: [30, 200], exposure: 1.2, stars: 0.5, glow: 0xff4ad8, clouds: 0.1, moon: true },
  indoor:        { top: 0x16181c, horizon: 0x24272c, sun: 0xffe2b8, sunPower: 1.4, elevation: 70, azimuth: 30, skyLight: 0xbfc6d0, groundLight: 0x3a3630, ambient: 1.3, fog: [30, 140], exposure: 1.0, stars: 0, glow: 0x000000, clouds: 0 },
};
const MOOD_KEYS = ['top', 'horizon', 'sun', 'skyLight', 'groundLight', 'glow'];
const DAY = [[0, 'night'], [4.6, 'night'], [6.2, 'golden-hour'], [8.5, 'clear-day'], [16, 'clear-day'], [18.4, 'golden-hour'], [19.8, 'dusk'], [21.3, 'night'], [24, 'night']];

function resolveMood(m) {
  const base = typeof m === 'string' ? MOODS[m] || MOODS['clear-day'] : { ...MOODS['clear-day'], ...(m && m.base ? MOODS[m.base] : null), ...(m || {}) };
  const out = { ...base, fog: [...base.fog] };
  for (const k of MOOD_KEYS) out[k] = new THREE.Color(base[k]);
  return out;
}
function mixMood(a, b, t) {
  const out = { fog: [a.fog[0] + (b.fog[0] - a.fog[0]) * t, a.fog[1] + (b.fog[1] - a.fog[1]) * t], moon: t < 0.5 ? a.moon : b.moon };
  for (const k of MOOD_KEYS) out[k] = a[k].clone().lerp(b[k], t);
  for (const k of ['sunPower', 'elevation', 'azimuth', 'ambient', 'exposure', 'stars', 'clouds']) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

let CURRENT = null;
/** The stage made most recently. Building blocks use it when you do not pass one. */
export const currentStage = () => CURRENT;

/** True when WebGL is drawn by the CPU (no GPU): start on the lowest quality there. */
export function isSoftwareRenderer(renderer) {
  try { const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); return /swiftshader|llvmpipe|software|basic render/i.test(String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '')); } catch { return false; }
}

const SKY_VERT = 'varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }';
const SKY_FRAG = `uniform vec3 top; uniform vec3 horizon; uniform vec3 glow; uniform vec3 sunDir; uniform float stars; uniform float clouds; uniform float time; uniform float disc; varying vec3 vDir;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
void main(){
  vec3 d = normalize(vDir); float y = max(d.y, 0.0);
  vec3 c = mix(horizon, top, 1.0 - pow(1.0 - y, 3.0));
  c = mix(c, horizon * 0.82, smoothstep(0.0, -0.35, d.y));                       // below the horizon: a soft floor, never black
  float s = max(dot(d, sunDir), 0.0);
  c += glow * (pow(s, 8.0) * 0.28 + pow(s, 48.0) * 0.5) * (1.0 - y * 0.5);       // wide halo and tight glow
  c += glow * smoothstep(disc, disc + 0.0006, s) * 2.5;                            // the disc itself
#ifdef CLOUDS
  if (clouds > 0.01 && d.y > 0.02) {
    vec2 uv = d.xz / (d.y + 0.18) * 1.6 + vec2(time * 0.012, time * 0.004);
    float n = vn(uv) * 0.55 + vn(uv * 2.3 + 7.1) * 0.3 + vn(uv * 5.1 + 3.7) * 0.15;
    float k = smoothstep(1.0 - clouds * 0.75, 1.05 - clouds * 0.35, n) * smoothstep(0.02, 0.22, d.y);
    vec3 lit = mix(horizon, vec3(1.0), 0.55) + glow * pow(s, 4.0) * 0.35;
    c = mix(c, lit, k * 0.85);
  }
#endif
  if (stars > 0.01 && d.y > 0.0) {
    vec2 g = d.xz / (d.y + 0.35) * 46.0; vec2 id = floor(g); float r = h21(id);
    float tw = 0.7 + 0.3 * sin(time * (1.0 + r * 3.0) + r * 60.0);
    c += vec3(0.9, 0.95, 1.0) * step(0.965, r) * smoothstep(0.42, 0.0, length(fract(g) - 0.5)) * stars * tw * smoothstep(0.0, 0.25, d.y);
  }
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const WEATHER = {
  rain:      { count: 1400, box: [36, 26, 36], fall: 26, drift: 3, size: 0.5, color: 0xbfd4e8, opacity: 0.5, streak: 1 },
  snow:      { count: 900, box: [40, 26, 40], fall: 1.6, drift: 0.9, size: 0.1, color: 0xffffff, opacity: 0.85, streak: 0, sway: 1 },
  motes:     { count: 260, box: [34, 14, 34], fall: -0.12, drift: 0.25, size: 0.07, color: 0xfff3c0, opacity: 0.7, streak: 0, sway: 1, glow: 1 },
  fireflies: { count: 120, box: [34, 8, 34], fall: 0, drift: 0.2, size: 0.12, color: 0xd8ff7a, opacity: 0.95, streak: 0, sway: 2, glow: 1, blink: 1 },
  embers:    { count: 260, box: [30, 16, 30], fall: -1.6, drift: 0.8, size: 0.08, color: 0xff8a3a, opacity: 0.9, streak: 0, sway: 1.5, glow: 1 },
  leaves:    { count: 160, box: [36, 16, 36], fall: 1.1, drift: 1.6, size: 0.16, color: 0xd98a3a, opacity: 0.95, streak: 0, sway: 2.5 },
  dust:      { count: 320, box: [34, 12, 34], fall: 0.05, drift: 1.8, size: 0.06, color: 0xe6d2a8, opacity: 0.45, streak: 0, sway: 1 },
};
/** Every weather kind createStage({ weather }) and stage.setWeather() accept. */
export const WEATHERS = Object.keys(WEATHER);
function makeWeather(kind, quality) {
  const w = WEATHER[kind]; if (!w) return null;
  const n = Math.round(w.count * (quality === 'low' ? 0.45 : quality === 'medium' ? 0.75 : 1)), pos = new Float32Array(n * 3), seed = new Float32Array(n);
  for (let i = 0; i < n; i++) { pos[i * 3] = Math.random(); pos[i * 3 + 1] = Math.random(); pos[i * 3 + 2] = Math.random(); seed[i] = Math.random(); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false, blending: w.glow ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { time: { value: 0 }, cam: { value: new THREE.Vector3() }, box: { value: new THREE.Vector3(...w.box) }, fall: { value: w.fall }, drift: { value: w.drift }, size: { value: w.size }, color: { value: new THREE.Color(w.color) }, opacity: { value: w.opacity }, streak: { value: w.streak }, sway: { value: w.sway || 0 }, blink: { value: w.blink || 0 }, scale: { value: 1 } },
    vertexShader: `uniform float time, fall, drift, size, sway, scale; uniform vec3 cam, box; attribute float seed; varying float vSeed; varying float vFade;
      void main(){ vSeed = seed; vec3 p = position * box; p.y -= time * fall * (0.7 + seed * 0.6); p.x += time * drift + sin(time * (0.6 + seed) + seed * 40.0) * sway; p.z += cos(time * (0.5 + seed * 0.7) + seed * 20.0) * sway;
        p = mod(p - cam, box) - box * 0.5 + cam; vec4 mv = viewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
        vFade = smoothstep(box.x * 0.5, box.x * 0.3, length(p.xz - cam.xz)); gl_PointSize = min(size * scale * (0.6 + seed * 0.8) / max(-mv.z, 0.5), 48.0); }`,
    fragmentShader: `uniform vec3 color; uniform float opacity, streak, blink, time; varying float vSeed; varying float vFade;
      void main(){ vec2 q = gl_PointCoord - 0.5; float a = streak > 0.5 ? smoothstep(0.09, 0.0, abs(q.x)) * smoothstep(0.5, 0.2, abs(q.y)) : smoothstep(0.5, 0.05, length(q));
        if (blink > 0.5) a *= smoothstep(0.2, 0.9, sin(time * (1.0 + vSeed * 2.0) + vSeed * 50.0) * 0.5 + 0.5);
        gl_FragColor = vec4(color, a * opacity * vFade); if (gl_FragColor.a < 0.01) discard; }`,
  });
  const points = new THREE.Points(g, material); points.frustumCulled = false; points.renderOrder = 5; points.userData.weather = kind;
  return points;
}

/**
 * Sets up everything around the game objects. Returns a stage:
 *   stage.scene, stage.camera, stage.renderer, stage.sun, stage.quality ('low' | 'medium' | 'high')
 *   stage.update(dt)            call once per frame before render: clock, wind, weather, mood blends, shadow follow
 *   stage.render()              draws the frame (through bloom when it is on)
 *   stage.focus = object3D      what the shadow box and the weather stay centred on (usually the player)
 *   stage.setMood(mood, secs)   change the mood, blending over `secs` seconds
 *   stage.setTime(hours)        0..24 on a day cycle: dawn, day, golden hour, dusk, starry night
 *   stage.setWeather(kind)      'rain' | 'snow' | 'motes' | 'fireflies' | 'embers' | 'leaves' | 'dust' | null
 *   stage.wind                  { strength, direction } read by everything from windSway()
 *   stage.shake(amount)         a short camera shake (0..1)
 *   stage.onUpdate(fn)          run fn(dt, time) every frame (props with animation register themselves this way)
 * Options: mood (name or object), time (hours, instead of mood), weather, shadows, shadowArea, fov, near, far,
 * quality ('auto' or a level), bloom ('auto' | true | false | { strength, radius, threshold }), storageKey.
 */
export function createStage(canvas, opts = {}) {
  const el = typeof canvas === 'string' ? document.querySelector(canvas) : canvas;
  const saved = opts.storageKey ? store.get(opts.storageKey) : null;
  let quality = opts.quality && opts.quality !== 'auto' ? opts.quality : pickQuality(saved);
  const renderer = createRenderer(el, { quality, shadows: opts.shadows !== false });
  const software = isSoftwareRenderer(renderer);
  if (software && (!opts.quality || opts.quality === 'auto')) { quality = 'low'; renderer.setPixelRatio(0.6); renderer.shadowMap.type = THREE.BasicShadowMap; renderer.shadowMap.autoUpdate = false; }
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(opts.fov || 60, 1, opts.near || 0.1, opts.far || 900);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1); scene.add(hemi);
  const sun = makeSun(scene, { area: software ? 24 : opts.shadowArea || 42, mapSize: software ? 512 : quality === 'low' ? 1024 : 2048, far: 260 });
  sun.castShadow = opts.shadows !== false;
  scene.fog = new THREE.Fog(0xffffff, 80, 300);

  const skyU = { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, glow: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, stars: { value: 0 }, clouds: { value: 0 }, time: { value: 0 }, disc: { value: 0.9994 } };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({ uniforms: skyU, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false, defines: software ? {} : { CLOUDS: 1 } }));
  sky.frustumCulled = false; sky.renderOrder = -10; sky.material.depthFunc = THREE.LessEqualDepth; scene.add(sky);

  const wind = { strength: opts.wind ?? 1, direction: new THREE.Vector2(1, 0.35).normalize(), uniforms: { uWindTime: { value: 0 }, uWind: { value: 1 }, uWindDir: { value: new THREE.Vector2(1, 0.35) } } };
  const updaters = [], dir = new THREE.Vector3(), tmp = new THREE.Vector3();
  let mood = resolveMood(opts.mood || 'clear-day'), from = null, to = null, blend = 0, blendSecs = 0, weather = null, time = 0, shakeAmt = 0, composer = null, bloomPass = null, hours = null;

  function apply(m) {
    skyU.top.value.copy(m.top); skyU.horizon.value.copy(m.horizon); skyU.glow.value.copy(m.glow); skyU.stars.value = m.stars; skyU.clouds.value = m.clouds;
    const e = THREE.MathUtils.degToRad(m.elevation), a = THREE.MathUtils.degToRad(m.azimuth);
    dir.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)).normalize(); skyU.sunDir.value.copy(dir);
    sun.color.copy(m.sun); sun.intensity = m.sunPower; sun.userData.dir = dir.clone();
    hemi.color.copy(m.skyLight); hemi.groundColor.copy(m.groundLight); hemi.intensity = m.ambient;
    scene.fog.color.copy(m.horizon); scene.fog.near = m.fog[0]; scene.fog.far = m.fog[1];
    if (software) { scene.fog.far = Math.min(m.fog[1], 150); scene.fog.near = Math.min(m.fog[0], 50); camera.far = scene.fog.far * 1.02; camera.updateProjectionMatrix(); }   // nothing is drawn beyond the fog
    renderer.toneMappingExposure = m.exposure;
    stage.mood = m;
  }
  const stage = {
    renderer, scene, camera, sun, hemi, sky, wind, quality, software, focus: null, time: 0, mood,
    /** How much optional decoration to draw: 1 on a normal device, less on slow ones. grassField and weather follow it. */
    density: software ? 0.2 : quality === 'low' ? 0.5 : quality === 'medium' ? 0.8 : 1,
    setMood(next, secs = 0) { const target = resolveMood(next); if (secs > 0) { from = stage.mood; to = target; blend = 0; blendSecs = secs; } else { from = to = null; mood = target; apply(target); } return stage; },
    setTime(h) {
      hours = ((h % 24) + 24) % 24; let i = 0; while (i < DAY.length - 2 && DAY[i + 1][0] <= hours) i++;
      const [h0, a] = DAY[i], [h1, b] = DAY[i + 1], t = THREE.MathUtils.smoothstep((hours - h0) / Math.max(0.001, h1 - h0), 0, 1), m = mixMood(resolveMood(a), resolveMood(b), t);
      const dayT = (hours - 6) / 12; if (dayT > 0 && dayT < 1) { m.elevation = Math.max(4, Math.sin(dayT * Math.PI) * 62); m.azimuth = -80 + dayT * 160; }
      from = to = null; apply(m); return stage;
    },
    get hours() { return hours; },
    setWeather(kind) { if (weather) { scene.remove(weather); weather.geometry.dispose(); weather.material.dispose(); weather = null; } if (kind) { weather = makeWeather(kind, quality); if (weather) scene.add(weather); } return stage; },
    shake(amount = 0.4) { shakeAmt = Math.min(1.5, shakeAmt + amount); },
    onUpdate(fn) { updaters.push(fn); return () => { const i = updaters.indexOf(fn); if (i >= 0) updaters.splice(i, 1); }; },
    update(dt) {
      time += dt; stage.time = time; skyU.time.value = time; if (software && (stage.frames = (stage.frames || 0) + 1) % 3 === 1) renderer.shadowMap.needsUpdate = true;   // CPU renderers refresh shadows every third frame
      if (to) { blend = Math.min(1, blend + dt / blendSecs); apply(mixMood(from, to, blend)); if (blend >= 1) { mood = to; from = to = null; } }
      wind.uniforms.uWindTime.value = time; wind.uniforms.uWind.value = wind.strength; wind.uniforms.uWindDir.value.copy(wind.direction);
      const f = stage.focus ? (stage.focus.isObject3D ? stage.focus.position : stage.focus) : camera.position;
      if (sun.castShadow || true) { const d = sun.userData.dir || dir; const far = sun.shadow.camera.far; sun.target.position.copy(f); sun.position.set(f.x + d.x * far * 0.5, f.y + d.y * far * 0.5, f.z + d.z * far * 0.5); }
      if (weather) { weather.material.uniforms.time.value = time; weather.material.uniforms.cam.value.copy(camera.position); weather.material.uniforms.scale.value = renderer.domElement.height * 0.87; }
      for (let i = 0; i < updaters.length; i++) updaters[i](dt, time);
      if (shakeAmt > 0.001) { camera.position.add(tmp.set((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).multiplyScalar(shakeAmt * 0.35)); shakeAmt *= Math.exp(-dt * 9); }
    },
    render() {
      sky.position.copy(camera.position); sky.scale.setScalar(camera.far * 0.9); sky.updateMatrixWorld();
      if (composer) composer.render(); else renderer.render(scene, camera);
    },
    /**
     * Runs the game: every frame calls your update(dt, time), then stage.update and stage.render. It also lowers the
     * cost by itself when frames are slow, and tells the platform the game is ready after the first frames are drawn
     * (pass { ready: false } to call GCP.ready() yourself). Returns the loop ({ stop(), start(), fps }).
     */
    run(update, { ready = true, maxDt = 0.05 } = {}) {
      let since = 0, n = 0;
      const loop = createLoop({ maxDt, update: (dt, t) => {
        if (update) update(dt, t); stage.update(dt); stage.render(); n++;
        if (ready && n === 3 && window.GCP && !(window.__GCP && window.__GCP.ready)) window.GCP.ready();
        since += dt; if (since > 1.5 && n > 20) { since = 0; stage.adapt(loop.fps); }
      } });
      stage.loop = loop; return loop.start();
    },
    /** Glow around bright things. Skipped on CPU renderers and low quality unless you pass force: true. */
    async enableBloom({ strength = 0.45, radius = 0.6, threshold = 0.82, force = false } = {}) {
      if ((software || quality === 'low') && !force) return false;
      try {
        const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([import('three/addons/postprocessing/EffectComposer.js'), import('three/addons/postprocessing/RenderPass.js'), import('three/addons/postprocessing/UnrealBloomPass.js'), import('three/addons/postprocessing/OutputPass.js')]);
        const size = renderer.getSize(new THREE.Vector2());
        composer = new EffectComposer(renderer); composer.addPass(new RenderPass(scene, camera));
        bloomPass = new UnrealBloomPass(size.clone().multiplyScalar(0.5), strength, radius, threshold); composer.addPass(bloomPass); composer.addPass(new OutputPass());
        composer.setSize(size.x, size.y); stage.bloom = bloomPass; return true;
      } catch (e) { console.warn('Bloom is unavailable: ' + (e && e.message)); composer = null; return false; }
    },
    /** Lower the cost when frames are slow: call with a smoothed fps about once a second. Remembers the choice when storageKey is set. */
    adapt(fps) {
      if (software || fps > 26 || stage._adapted >= 3) return;   // a CPU renderer already runs the lightest profile
      stage._adapted = (stage._adapted || 0) + 1;
      if (composer) { composer = null; } else if (renderer.getPixelRatio() > 1) renderer.setPixelRatio(1); else if (renderer.shadowMap.enabled && stage._adapted > 2) { renderer.shadowMap.enabled = false; sun.castShadow = false; scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); }
      resize(); if (opts.storageKey) store.set(opts.storageKey, 'low');
    },
  };
  const resize = () => { const w = el.clientWidth || innerWidth, h = el.clientHeight || innerHeight; if (composer) composer.setSize(w, h); };
  stage.stopResize = fitRenderer(renderer, camera, resize);
  CURRENT = stage;
  if (opts.time != null) stage.setTime(opts.time); else apply(mood);
  if (opts.weather) stage.setWeather(opts.weather);
  const bloom = opts.bloom ?? 'auto';
  stage.ready = bloom && !(bloom === 'auto' && (software || quality === 'low')) ? stage.enableBloom(typeof bloom === 'object' ? bloom : {}) : Promise.resolve(false);
  return stage;
}

/**
 * Makes a material sway in the stage's wind: tree crowns, grass, flags, reeds. Height above `base` (object space)
 * decides how far a vertex moves, so trunks stay put while tips swing. Works on instanced meshes; every instance
 * gets its own phase from where it stands.
 */
export function windSway(material, stage, { amount = 0.12, base = 0, speed = 1.4, flutter = 0.3 } = {}) {
  const U = stage.wind.uniforms, prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, r) => {
    if (prev) prev(shader, r);
    Object.assign(shader.uniforms, U, { uSwayAmt: { value: amount }, uSwayBase: { value: base }, uSwaySpeed: { value: speed }, uSwayFlutter: { value: flutter } });
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uWindTime, uWind, uSwayAmt, uSwayBase, uSwaySpeed, uSwayFlutter; uniform vec2 uWindDir;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 swayO = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      #else
        vec3 swayO = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      #endif
      float swayP = swayO.x * 0.31 + swayO.z * 0.23, swayH = max(transformed.y - uSwayBase, 0.0);
      float swayW = (sin(uWindTime * uSwaySpeed + swayP) * 0.7 + sin(uWindTime * uSwaySpeed * 2.3 + swayP * 1.9) * 0.3) * uWind * uSwayAmt * swayH;
      float swayF = sin(uWindTime * 5.0 + transformed.x * 3.1 + transformed.z * 2.7 + swayP) * uSwayFlutter * uSwayAmt * uWind * min(swayH, 1.0);
      transformed.x += uWindDir.x * swayW + swayF; transformed.z += uWindDir.y * swayW + swayF * 0.6;`);
  };
  material.customProgramCacheKey = () => `sway${amount}|${base}|${speed}|${flutter}`;
  material.needsUpdate = true;
  return material;
}

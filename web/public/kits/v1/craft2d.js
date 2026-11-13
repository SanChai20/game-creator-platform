// @gcp/craft2d.js — finished-looking 2D and 2.5D worlds on a plain canvas, from small calls. The view is the classic
// top-down one with upright things (trees, houses and people stand up and overlap by their feet), which is what
// "2.5D" survival, farming and adventure games use. Everything is painted in code from options and a seed:
//   createStage2d   canvas, camera, depth sorting, soft shadows, moods with real darkness and lights, weather, wind
//   ground2d        painted land from noise: water, shore, grass, dirt paths, stone; walkable(x, y)
//   sprite2d        40 painted things: trees by species, rocks, bushes, houses, camp props, pickups
//   scatter2d       hundreds of things placed by rule; returns the solid ones for collision
//   actor2d         animated people and animals drawn from parts; control2d, wander2d
// The HUD, sound and input blocks are the same as in 3D (createHud, createSound, createInput).
import { clamp, lerp, smoothstep, TAU, createLoop } from './core.js';
import { mulberry32, Simplex, toSeed, hash2 } from './procgen/noise.js';
import { setupCanvas, bake, Camera2D, ChunkCache } from './canvas2d.js';

const sd = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : toSeed(v ?? 1) % 99991);
const hex = (c) => (typeof c === 'string' ? c : '#' + (c >>> 0).toString(16).padStart(6, '0'));
const rgb = (c) => { if (typeof c === 'string') c = parseInt(c.slice(1), 16); return [(c >> 16) & 255, (c >> 8) & 255, c & 255]; };
/** A colour made lighter (k > 0) or darker (k < 0), as a CSS string. */
export const shade = (c, k) => { const [r, g, b] = rgb(c), f = (v) => Math.round(clamp(k > 0 ? v + (255 - v) * k : v * (1 + k), 0, 255)); return `rgb(${f(r)},${f(g)},${f(b)})`; };

/** Named moods, the same names as in 3D. ambient multiplies the whole picture (white = full daylight); lights cut through it. */
export const MOODS2D = {
  'clear-day': { ambient: 0xffffff, shadow: 0.38, vignette: 0.3 }, 'golden-hour': { ambient: 0xffd9a6, shadow: 0.34, vignette: 0.35 }, 'misty-dawn': { ambient: 0xdfe6ea, shadow: 0.16, vignette: 0.3, haze: 0xe9eef0 },
  overcast: { ambient: 0xc9d0d6, shadow: 0.14, vignette: 0.3 }, storm: { ambient: 0x8a96a8, shadow: 0.1, vignette: 0.45 }, dusk: { ambient: 0xb88aa6, shadow: 0.22, vignette: 0.45 },
  night: { ambient: 0x3d4f8f, shadow: 0.2, vignette: 0.6 }, desert: { ambient: 0xfff2d6, shadow: 0.36, vignette: 0.22 }, arctic: { ambient: 0xe8f2ff, shadow: 0.22, vignette: 0.22 },
  autumn: { ambient: 0xffe6c2, shadow: 0.3, vignette: 0.3 }, volcanic: { ambient: 0xc8785a, shadow: 0.25, vignette: 0.5 }, alien: { ambient: 0x9a8ad8, shadow: 0.25, vignette: 0.45 },
  'neon-night': { ambient: 0x5a4a9a, shadow: 0.2, vignette: 0.55 }, indoor: { ambient: 0x8a8478, shadow: 0.15, vignette: 0.55 },
};
const WEATHER2D = {
  rain: { n: 260, vx: -60, vy: 900, len: 16, w: 1.2, color: 'rgba(200,220,240,0.5)' }, snow: { n: 180, vx: 20, vy: 70, r: 2.2, sway: 30, color: 'rgba(255,255,255,0.9)' },
  motes: { n: 60, vx: 6, vy: -8, r: 1.6, sway: 14, color: 'rgba(255,244,190,0.75)', glow: 1 }, fireflies: { n: 40, vx: 0, vy: 0, r: 2, sway: 40, color: 'rgba(214,255,120,0.95)', glow: 1, blink: 1 },
  embers: { n: 80, vx: 14, vy: -70, r: 1.8, sway: 20, color: 'rgba(255,140,60,0.9)', glow: 1 }, leaves: { n: 46, vx: 60, vy: 50, r: 3.2, sway: 40, color: 'rgba(214,138,58,0.95)' },
  dust: { n: 70, vx: 40, vy: 4, r: 1.4, sway: 10, color: 'rgba(230,210,170,0.5)' }, sandstorm: { n: 420, vx: 620, vy: 30, len: 22, w: 2, color: 'rgba(222,190,140,0.35)', haze: 'rgba(214,180,128,0.22)' },
};
/** Every weather kind createStage2d({ weather }) accepts. */
export const WEATHERS2D = Object.keys(WEATHER2D);

let CURRENT = null;
/** The 2D stage made most recently. Blocks use it when you do not pass one. */
export const currentStage2d = () => CURRENT;

/**
 * Sets up a 2D world view. Returns a stage:
 *   stage.add(sprite, x, y, opts)  put a sprite2d in the world; returns the item ({ x, y, visible, remove() }).
 *                                  opts: solid (collision radius), sway (true: moves in the wind), bob (floats up
 *                                  and down, for pickups), light ({ r, color } glows in the dark), flip, scale
 *   stage.addActor(actor)          actor2d things draw themselves and sort with everything else
 *   stage.light(x, y, r, color)    a light of its own; returns { x, y, r, on }
 *   stage.focus = actor            what the camera follows;  stage.camera.zoom  pixels per world unit
 *   stage.setMood(name, secs)      blend to another mood;  stage.setWeather(kind)
 *   stage.fx                       burst(x, y, color), text(x, y, 'words', color), ring(x, y, color), confetti(x, y)
 *   stage.shake(amount), stage.onUpdate(fn), stage.run(update)  the frame loop; calls GCP.ready() after the first frames
 * Options: mood, weather, zoom (pixels per unit, default fits about 22 units across), ground (a ground2d, or set
 * stage.ground later), wind (0..2).
 */
export function createStage2d(canvas, opts = {}) {
  const el = typeof canvas === 'string' ? document.querySelector(canvas) : canvas, view = setupCanvas(el, { maxDpr: 2 }), ctx = view.ctx, cam = new Camera2D();
  const items = [], actors = [], lights = [], updaters = [], parts = [], texts = [], drawList = [];
  const lightC = document.createElement('canvas'), lctx = lightC.getContext('2d');
  let mood = { ...MOODS2D[opts.mood] || MOODS2D['clear-day'] }, from = null, to = null, blend = 0, secs = 0, weather = null, drops = [], time = 0, shakeAmt = 0, vig = null, vigKey = '';
  const amb = () => rgb(mood.ambient);
  const stage = {
    canvas: el, view, ctx, camera: cam, items, actors, lights, ground: opts.ground || null, focus: null, time: 0, wind: opts.wind ?? 1, mood, is2d: true,
    add(sprite, x, y, o = {}) {
      const it = { sprite, x, y, visible: true, solid: o.solid ?? sprite.solid ?? 0, sway: o.sway ?? sprite.sway ?? false, bob: o.bob ? 1 : 0, flip: !!o.flip, scale: o.scale || 1, phase: hash2(Math.round(x * 7), Math.round(y * 7)) * TAU, light: null, remove() { const i = items.indexOf(it); if (i >= 0) items.splice(i, 1); if (it.light) it.light.on = false; } };
      const L = o.light ?? sprite.light; if (L) it.light = stage.light(x, y - sprite.h * 0.5, L.r || 3, L.color || 0xffc070, L.flicker ?? true);
      items.push(it); return it;
    },
    addActor(a) { if (!actors.includes(a)) actors.push(a); a.stage = stage; return a; },
    light(x, y, r = 3, color = 0xffc070, flicker = false) { const l = { x, y, r, color: rgb(color), on: true, flicker, phase: Math.random() * TAU }; lights.push(l); return l; },
    setMood(name, s = 0) { const t = { ...MOODS2D['clear-day'], ...(typeof name === 'string' ? MOODS2D[name] : name) }; if (s > 0) { from = { ...mood }; to = t; blend = 0; secs = s; } else { mood = t; stage.mood = mood; from = to = null; } return stage; },
    setWeather(kind) { weather = WEATHER2D[kind] || null; drops = weather ? Array.from({ length: weather.n }, () => ({ x: Math.random(), y: Math.random(), s: Math.random() })) : []; return stage; },
    shake(a = 0.4) { shakeAmt = Math.min(1.5, shakeAmt + a); },
    onUpdate(fn) { updaters.push(fn); return () => { const i = updaters.indexOf(fn); if (i >= 0) updaters.splice(i, 1); }; },
    fx: {
      burst(x, y, color = 0xffd060, n = 14) { for (let i = 0; i < n; i++) { const a = Math.random() * TAU, v = 1.5 + Math.random() * 3; parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.5, life: 0.5 + Math.random() * 0.4, t: 0, r: 0.06 + Math.random() * 0.07, color: hex(color), g: 5 }); } return stage.fx; },
      confetti(x, y) { for (let i = 0; i < 70; i++) { const a = -Math.PI / 2 + (Math.random() - 0.5) * 2, v = 3 + Math.random() * 6; parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1.4 + Math.random(), t: 0, r: 0.08, color: ['#ff5a5a', '#ffd060', '#6ad86a', '#5aa8ff', '#d86ad8'][i % 5], g: 7 }); } return stage.fx; },
      ring(x, y, color = 0xffffff) { parts.push({ x, y, vx: 0, vy: 0, life: 0.5, t: 0, r: 0.2, color: hex(color), ring: 1, g: 0 }); return stage.fx; },
      text(x, y, s, color = '#ffffff') { texts.push({ x, y, s: String(s), color: hex(color), t: 0 }); return stage.fx; },
    },
    update(dt) {
      time += dt; stage.time = time;
      if (to) { blend = Math.min(1, blend + dt / secs); const a = rgb(from.ambient), b = rgb(to.ambient); mood = { ...to, ambient: (Math.round(lerp(a[0], b[0], blend)) << 16) | (Math.round(lerp(a[1], b[1], blend)) << 8) | Math.round(lerp(a[2], b[2], blend)), shadow: lerp(from.shadow, to.shadow, blend), vignette: lerp(from.vignette, to.vignette, blend) }; stage.mood = mood; if (blend >= 1) from = to = null; }
      const f = stage.focus; if (f) cam.follow(f.x, f.y - 0.6, dt, 5); cam.shake = shakeAmt; shakeAmt *= Math.exp(-dt * 8);
      for (let i = 0; i < updaters.length; i++) updaters[i](dt, time);
      for (let i = parts.length - 1; i >= 0; i--) { const p = parts[i]; p.t += dt; if (p.t > p.life) { parts.splice(i, 1); continue; } p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
      for (let i = texts.length - 1; i >= 0; i--) { texts[i].t += dt; if (texts[i].t > 1.1) texts.splice(i, 1); }
    },
    render() {
      const w = view.w, h = view.h; if (!opts.zoom) cam.zoom = Math.max(30, Math.min(72, Math.max(w / 24, h / 14)));
      const g = stage.ground; ctx.fillStyle = g ? g.deep : '#20242c'; ctx.fillRect(0, 0, w, h);
      cam.begin(view); const b = cam.bounds(view, 4), z = cam.zoom;
      if (g) { g.cache.scale = Math.round(Math.min(64, Math.max(32, z))); g.cache.draw(ctx, b); g.ripples(ctx, b, time); }
      // soft shadows first, then everything that stands up, sorted by its feet
      drawList.length = 0;
      for (const it of items) if (it.visible && it.x > b.x0 && it.x < b.x1 && it.y > b.y0 && it.y < b.y1 + 4) drawList.push(it);
      for (const a of actors) if (a.visible !== false && a.x > b.x0 && a.x < b.x1 && a.y > b.y0 && a.y < b.y1 + 2) drawList.push(a);
      drawList.sort((p, q) => p.y - q.y);
      ctx.fillStyle = `rgba(10,20,30,${mood.shadow})`;
      for (const it of drawList) { const sw = it.isActor ? it.radius * 1.5 : it.sprite.shadow * it.scale; if (sw > 0) { ctx.beginPath(); ctx.ellipse(it.x + sw * 0.25, it.y, sw, sw * 0.42, 0, 0, TAU); ctx.fill(); } }
      for (const it of drawList) {
        if (it.isActor) { it.draw(ctx, time); continue; }
        const s = it.sprite, sc = it.scale, dy = it.bob ? Math.sin(time * 2.4 + it.phase) * 0.08 - 0.12 : 0;
        if (it.sway || it.flip) { ctx.save(); ctx.translate(it.x, it.y + dy); if (it.flip) ctx.scale(-1, 1); if (it.sway) ctx.transform(1, 0, Math.sin(time * 1.3 + it.phase) * 0.035 * stage.wind, 1, 0, 0); ctx.drawImage(s.canvas, -s.w * s.ax * sc, -s.h * s.ay * sc, s.w * sc, s.h * sc); ctx.restore(); }
        else ctx.drawImage(s.canvas, it.x - s.w * s.ax * sc, it.y + dy - s.h * s.ay * sc, s.w * sc, s.h * sc);
      }
      for (const p of parts) { const k = 1 - p.t / p.life; ctx.globalAlpha = k; if (p.ring) { ctx.strokeStyle = p.color; ctx.lineWidth = 0.08 * k; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + p.t * 3, 0, TAU); ctx.stroke(); } else { ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill(); } }
      ctx.globalAlpha = 1; ctx.restore();
      // darkness and lights: the mood's ambient colour multiplies the picture; lights are added to it before it does
      const A = amb(), dark = A[0] + A[1] + A[2] < 735;
      if (dark) {
        const lw = Math.ceil(w / 4), lh = Math.ceil(h / 4); if (lightC.width !== lw || lightC.height !== lh) { lightC.width = lw; lightC.height = lh; }
        lctx.globalCompositeOperation = 'source-over'; lctx.fillStyle = `rgb(${A[0]},${A[1]},${A[2]})`; lctx.fillRect(0, 0, lw, lh); lctx.globalCompositeOperation = 'lighter';
        for (const l of lights) { if (!l.on) continue; const px = ((l.x - cam.x) * z + w / 2) / 4, py = ((l.y - cam.y) * z + h / 2) / 4, r = l.r * z / 4 * (l.flicker ? 0.94 + Math.sin(time * 9 + l.phase) * 0.04 + Math.sin(time * 23 + l.phase) * 0.02 : 1); if (px < -r || py < -r || px > lw + r || py > lh + r) continue;
          const gr = lctx.createRadialGradient(px, py, 0, px, py, r); gr.addColorStop(0, `rgba(${l.color[0]},${l.color[1]},${l.color[2]},0.95)`); gr.addColorStop(0.45, `rgba(${l.color[0]},${l.color[1]},${l.color[2]},0.4)`); gr.addColorStop(1, 'rgba(0,0,0,0)'); lctx.fillStyle = gr; lctx.fillRect(px - r, py - r, r * 2, r * 2); }
        ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(lightC, 0, 0, w, h); ctx.globalCompositeOperation = 'source-over';
      }
      if (mood.haze) { ctx.fillStyle = hex(mood.haze); ctx.globalAlpha = 0.16; ctx.fillRect(0, 0, w, h); ctx.globalAlpha = 1; }
      if (weather) { const W = weather; if (W.haze) { ctx.fillStyle = W.haze; ctx.fillRect(0, 0, w, h); } if (W.glow) ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = ctx.strokeStyle = W.color; ctx.lineWidth = W.w || 1; ctx.beginPath();
        for (const d of drops) { const sx = W.sway ? Math.sin(time * (0.6 + d.s) + d.s * 40) * W.sway : 0, x = (((d.x * w + time * W.vx * (0.7 + d.s * 0.6) + sx - cam.x * z) % w) + w) % w, y = (((d.y * h + time * W.vy * (0.7 + d.s * 0.6) - cam.y * z) % h) + h) % h;
          if (W.len) { ctx.moveTo(x, y); ctx.lineTo(x + W.vx / Math.hypot(W.vx, W.vy) * W.len, y + W.vy / Math.hypot(W.vx, W.vy) * W.len); } else { const r = W.r * (0.6 + d.s * 0.8) * (W.blink ? Math.max(0, Math.sin(time * (1 + d.s * 2) + d.s * 50)) : 1); ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); } }
        if (W.len) ctx.stroke(); else ctx.fill(); ctx.globalCompositeOperation = 'source-over'; }
      ctx.font = '700 15px system-ui, sans-serif'; ctx.textAlign = 'center';
      for (const t of texts) { const px = (t.x - cam.x) * z + w / 2, py = (t.y - cam.y) * z + h / 2 - 30 - t.t * 34; ctx.globalAlpha = 1 - Math.max(0, t.t - 0.6) * 2; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.strokeText(t.s, px, py); ctx.fillStyle = t.color; ctx.fillText(t.s, px, py); }
      ctx.globalAlpha = 1;
      if (mood.vignette > 0.01) { const key = w + 'x' + h; if (key !== vigKey) { vigKey = key; vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6); vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,1)'); } ctx.globalAlpha = mood.vignette; ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h); ctx.globalAlpha = 1; }
    },
    /** Runs the game: every frame calls your update(dt, time), then stage.update and stage.render; tells the platform the game is ready after the first frames. */
    run(update, { ready = true, maxDt = 0.05 } = {}) {
      let n = 0; const loop = createLoop({ maxDt, update: (dt, t) => { if (update) update(dt, t); stage.update(dt); stage.render(); n++; if (ready && n === 3 && window.GCP && !(window.__GCP && window.__GCP.ready)) window.GCP.ready(); } });
      stage.loop = loop; return loop.start();
    },
  };
  if (opts.zoom) cam.zoom = opts.zoom; if (opts.weather) stage.setWeather(opts.weather);
  CURRENT = stage; return stage;
}

const LANDS2D = {
  temperate: { grass: [0x78bc50, 0x4c8a38], dirt: 0x8a6a42, sand: 0xdcc890, water: [0x4aa6d8, 0x2a6aa8], stone: 0x8f8c86, flowers: [0xffffff, 0xffe066, 0xff9ac2] },
  autumn: { grass: [0xc4ac40, 0x9c6e2a], dirt: 0x7a5a38, sand: 0xd8c79a, water: [0x4a96c0, 0x2a5a8a], stone: 0x8a8278, flowers: [0xffe6a0, 0xe86a3a] },
  desert: { grass: [0xe2c080, 0xd6ac68], dirt: 0xc49458, sand: 0xecd8a4, water: [0x4ab6c8, 0x2a7a98], stone: 0xb0805a, flowers: [] },
  snow: { grass: [0xf2f6fb, 0xdde8f2], dirt: 0xb8c4d0, sand: 0xc8d6e4, water: [0x8ac0e0, 0x4a80b0], stone: 0x8a94a0, flowers: [] },
  volcanic: { grass: [0x5a4c44, 0x4a3e3a], dirt: 0x3a2e2a, sand: 0x6e4a38, water: [0xf07a2a, 0xc8401a], stone: 0x2e2826, flowers: [], glow: true },
  alien: { grass: [0x3fa894, 0x6a4aa8], dirt: 0x3a2f5a, sand: 0x6a4a8a, water: [0x8a5ae8, 0x4a2a98], stone: 0x2f2a4a, flowers: [0x6ef0ff, 0xff7ad8] },
  tropical: { grass: [0x66c454, 0x3c9444], dirt: 0x9a7a4a, sand: 0xf2e2ac, water: [0x3cc4d8, 0x1a7ab0], stone: 0x8a8678, flowers: [0xff6a8a, 0xffd060, 0xffffff] },
  city: { grass: [0x6a6f80, 0x5c6172], dirt: 0x4a4e5c, sand: 0x7a8094, water: [0x3a5a8a, 0x22365a], stone: 0x8a90a4, flowers: [], paved: true },
};
/** Every palette ground2d({ palette }) accepts. */
export const GROUND_PALETTES = Object.keys(LANDS2D);

/**
 * The painted land (set as the stage's ground for you). Returns { kindAt(x, y), walkable(x, y), randomPoint(rand, { minRadius,
 * maxRadius }), size, deep }. kindAt gives 'water' | 'sand' | 'grass' | 'dirt' | 'stone'.
 * Options: seed, size (the land's radius in units, default 60; beyond it lies water, a natural edge), palette
 * (temperate, autumn, desert, snow, volcanic, alien, tropical, city, or your own colours), water (0..1: how much of
 * the land is lakes and coves, default 0.3), paths (false for no dirt paths), clearing ({ x, y, r }: dry open
 * ground, e.g. the spawn), stage.
 */
export function ground2d(opts = {}) {
  const st = opts.stage || CURRENT, seed = sd(opts.seed), { size = 60, paths = true, clearing = { x: 0, y: 0, r: 7 } } = opts, wet = opts.water ?? 0.3, nz = new Simplex(seed), n2 = new Simplex(seed + 77);
  const pal = typeof opts.palette === 'object' ? { ...LANDS2D.temperate, ...opts.palette } : LANDS2D[opts.palette] || LANDS2D.temperate;
  const C = { g0: rgb(pal.grass[0]), g1: rgb(pal.grass[1]), dirt: rgb(pal.dirt), sand: rgb(pal.sand), w0: rgb(pal.water[0]), w1: rgb(pal.water[1]), stone: rgb(pal.stone) };
  // height: rolling noise, pulled down at the rim (so the land ends in water) and up in the clearing
  const H = (x, y) => { let h = nz.fbm2(x * 0.028, y * 0.028, 4) * 0.5 + 0.5 + (0.3 - wet) * 0.6; h -= smoothstep(size * 0.8, size * 1.05, Math.hypot(x, y)) * 1.2; if (clearing) h = lerp(Math.max(h, 0.62), h, smoothstep(clearing.r, clearing.r * 2.2, Math.hypot(x - clearing.x, y - clearing.y))); return h; };
  const pathV = (x, y) => (paths ? Math.abs(n2.n2(x * 0.03, y * 0.03)) : 1), stoneV = (x, y) => n2.n2(x * 0.05 + 50, y * 0.05 - 20);
  const WATER = 0.36, SAND = 0.42;
  const kindAt = (x, y) => { const h = H(x, y); return h < WATER ? 'water' : h < SAND ? 'sand' : pathV(x, y) < 0.045 ? 'dirt' : stoneV(x, y) > 0.72 ? 'stone' : 'grass'; };
  const mix = (a, b, t, o) => { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; }, col = [0, 0, 0], tmp = [0, 0, 0];
  const paint = (ctx, cx, cy, n) => {
    const S = 24, N = n * S, img = new ImageData(N, N), d = img.data, x0 = cx * n, y0 = cy * n;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = x0 + (i + 0.5) / S, y = y0 + (j + 0.5) / S, h = H(x, y), grain = (hash2(i + cx * 977, j + cy * 613, seed) - 0.5) * 0.05;
      if (h < WATER) { mix(C.w0, C.w1, smoothstep(WATER, WATER - 0.2, h), col); const foam = smoothstep(WATER - 0.022, WATER, h); col[0] += (255 - col[0]) * foam * 0.6; col[1] += (255 - col[1]) * foam * 0.6; col[2] += (255 - col[2]) * foam * 0.6; }
      else {
        mix(C.g0, C.g1, smoothstep(-0.45, 0.45, nz.n2(x * 0.09 + 13, y * 0.09 - 7) * 0.75 + nz.n2(x * 0.3 - 5, y * 0.3 + 9) * 0.25), col);
        const st2 = smoothstep(0.66, 0.76, stoneV(x, y)); if (st2 > 0) mix(col, C.stone, st2, col);
        const p = pathV(x, y); if (p < 0.07) { mix(col, C.dirt, smoothstep(0.07, 0.04, p), col); if (p > 0.04 && p < 0.052) { col[0] *= 0.82; col[1] *= 0.82; col[2] *= 0.82; } }   // a darker rim where grass meets the path
        if (h < SAND + 0.03) { mix(col, C.sand, smoothstep(SAND + 0.03, SAND, h), col); if (h < WATER + 0.012) { col[0] *= 0.86; col[1] *= 0.86; col[2] *= 0.84; } }   // wet sand at the waterline
        const k = 1 + grain + n2.n2(x * 0.6, y * 0.6) * 0.03; col[0] *= k; col[1] *= k; col[2] *= k;
      }
      const o = (j * N + i) * 4; d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
    }
    const c = document.createElement('canvas'); c.width = c.height = N; c.getContext('2d').putImageData(img, 0, 0); ctx.imageSmoothingEnabled = true; ctx.drawImage(c, x0, y0, n, n);
    // detail on top: grass tufts, flowers, pebbles and cracks, placed by hash so every chunk repaints the same
    ctx.lineCap = 'round';
    for (let gy = 0; gy < n * 2; gy++) for (let gx = 0; gx < n * 2; gx++) {
      const wx = x0 + gx * 0.5, wy = y0 + gy * 0.5, r1 = hash2(wx * 2, wy * 2, seed + 3), x = wx + r1 * 0.5, y = wy + hash2(wx * 2, wy * 2, seed + 4) * 0.5, k = kindAt(x, y);
      if (k === 'grass' && !pal.paved && r1 < 0.8) { mix(C.g0, C.g1, 0.5, tmp); const up = r1 < 0.36; ctx.strokeStyle = shade((tmp[0] << 16) | (tmp[1] << 8) | (tmp[2] | 0), up ? 0.3 : -0.3); ctx.lineWidth = 0.035; ctx.beginPath(); for (let q = -1; q <= 1; q++) { ctx.moveTo(x + q * 0.05, y); ctx.lineTo(x + q * 0.11, y - 0.13 - (q ? 0 : 0.05)); } ctx.stroke();
        if (pal.flowers.length && r1 < 0.03 && nz.n2(x * 0.08 - 30, y * 0.08) > 0.1) { ctx.fillStyle = hex(pal.flowers[(r1 * 1000 | 0) % pal.flowers.length]); for (let q = 0; q < 3; q++) { ctx.beginPath(); ctx.arc(x + Math.cos(q * 2.1) * 0.12, y - 0.1 + Math.sin(q * 2.1) * 0.08, 0.05, 0, TAU); ctx.fill(); } } }
      else if ((k === 'dirt' || k === 'stone' || k === 'sand' || pal.paved) && r1 < 0.12) { ctx.fillStyle = shade(k === 'sand' ? pal.sand : k === 'dirt' ? pal.dirt : pal.stone, r1 < 0.06 ? -0.22 : 0.2); ctx.beginPath(); ctx.ellipse(x, y, 0.05 + r1 * 0.3, 0.035 + r1 * 0.2, 0, 0, TAU); ctx.fill(); }
      else if (pal.paved && k !== 'water' && gx % 4 === 0 && gy % 4 === 0) { ctx.strokeStyle = 'rgba(0,0,0,0.14)'; ctx.lineWidth = 0.04; ctx.strokeRect(wx, wy, 2, 2); }
    }
  };
  const land = {
    size, deep: hex(pal.water[1]), kindAt, heightAt: H, walkable: (x, y) => H(x, y) >= WATER + 0.01, palette: pal,
    cache: new ChunkCache({ chunk: 8, scale: 48, paint, max: 80 }),
    ripples(ctx, b, t) {   // moving glints on open water; lava glows instead
      ctx.strokeStyle = pal.glow ? 'rgba(255,220,120,0.5)' : 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.05; ctx.lineCap = 'round'; ctx.beginPath();
      for (let y = Math.floor(b.y0 / 2) * 2; y < b.y1; y += 2) for (let x = Math.floor(b.x0 / 2) * 2; x < b.x1; x += 2) { const r = hash2(x, y, seed + 9); if (r > 0.5 || H(x + 1, y + 1) > WATER - 0.03) continue; const px = x + r * 3 + Math.sin(t * 0.6 + r * 40) * 0.3, py = y + r * 2.6, l = 0.25 + Math.sin(t * 1.4 + r * 30) * 0.15; ctx.moveTo(px - l, py); ctx.quadraticCurveTo(px, py - 0.08, px + l, py); }
      ctx.stroke();
    },
    randomPoint(rand, { minRadius = 0, maxRadius = size * 0.8, kind, tries = 300 } = {}) { for (let i = 0; i < tries; i++) { const a = rand() * TAU, r = minRadius + Math.sqrt(rand()) * (maxRadius - minRadius), x = Math.cos(a) * r, y = Math.sin(a) * r; if (H(x, y) > SAND && (!kind || kindAt(x, y) === kind)) return { x, y }; } return { x: 0, y: 0 }; },
  };
  if (st && opts.add !== false) st.ground = land;
  return land;
}

// ---- sprites: each kind is painted once into its own small canvas ----
const O = '#1d2420';   // the ink of every outline
const ell = (c, x, y, rx, ry, fill, line = 0.045) => { c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, TAU); c.fillStyle = fill; c.fill(); if (line) { c.lineWidth = line; c.strokeStyle = O; c.stroke(); } };
const box = (c, x, y, w, h, fill, r = 0.04, line = 0.045) => { c.beginPath(); c.roundRect(x, y, w, h, r); c.fillStyle = fill; c.fill(); if (line) { c.lineWidth = line; c.strokeStyle = O; c.stroke(); } };
const poly = (c, pts, fill, line = 0.045) => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fillStyle = fill; c.fill(); if (line) { c.lineWidth = line; c.strokeStyle = O; c.stroke(); } };
// a leafy mass: dark outline under everything, the body colour, then light from the upper left and leaf marks
function puffs(c, list, color, r) {
  for (const [x, y, s] of list) ell(c, x, y, s + 0.045, s + 0.045, O, 0);
  for (const [x, y, s] of list) ell(c, x, y, s, s, shade(color, -0.3), 0);
  for (const [x, y, s] of list) ell(c, x - s * 0.1, y - s * 0.14, s * 0.82, s * 0.8, hex(color), 0);
  for (const [x, y, s] of list) ell(c, x - s * 0.24, y - s * 0.3, s * 0.48, s * 0.42, shade(color, 0.28), 0);
  c.strokeStyle = shade(color, -0.3); c.lineWidth = 0.03; c.lineCap = 'round';
  for (const [x, y, s] of list) for (let i = 0; i < 3; i++) { const a = r() * TAU, d = r() * s * 0.6; c.beginPath(); c.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, s * 0.2, 0.3, 1.5); c.stroke(); }
}
const LEAF2D = { oak: 0x4f9e3c, birch: 0x8cc44a, pine: 0x2f7a4a, palm: 0x45a848, maple: 0xd9682a, blossom: 0xf2a6c4, willow: 0x7ab04a, dead: 0x7a6a58, cactus: 0x4f9a48, mushroom: 0xc83a2a };
const S2 = {
  tree(c, o, r) {
    const sp = o.species || 'oak', leaf = o.leaf ?? LEAF2D[sp] ?? LEAF2D.oak, bark = o.trunk ?? (sp === 'birch' ? 0xe8e4da : 0x7a5234), x = 1.3;
    if (sp === 'pine') { box(c, x - 0.13, 2.5, 0.26, 0.7, hex(bark)); for (let i = 0; i < 4; i++) { const y = 2.75 - i * 0.62, w = 1.02 - i * 0.2; poly(c, [[x, y - 1.05], [x + w, y], [x + w * 0.35, y - 0.08], [x, y + 0.06], [x - w * 0.35, y - 0.08], [x - w, y]], hex(leaf)); poly(c, [[x, y - 1.0], [x - w * 0.82, y - 0.06], [x - w * 0.3, y - 0.14]], shade(leaf, 0.2), 0); if (o.snow) poly(c, [[x, y - 1.05], [x + w * 0.5, y - 0.5], [x, y - 0.4], [x - w * 0.5, y - 0.5]], '#f4f8fb', 0.03); } return; }
    if (sp === 'palm') { c.strokeStyle = O; c.lineWidth = 0.3; c.lineCap = 'round'; c.beginPath(); c.moveTo(x - 0.3, 3.15); c.quadraticCurveTo(x - 0.1, 2, x + 0.15, 1.1); c.stroke(); c.strokeStyle = hex(bark); c.lineWidth = 0.21; c.stroke();
      for (let i = 0; i < 7; i++) { const a = -Math.PI / 2 + (i - 3) * 0.55, l = 1.05, ex = x + 0.15 + Math.cos(a) * l, ey = 1.1 + Math.sin(a) * l * 0.6 + Math.abs(i - 3) * 0.16; c.beginPath(); c.moveTo(x + 0.15, 1.1); c.quadraticCurveTo(x + 0.15 + Math.cos(a) * 0.6, 0.6 + Math.sin(a) * 0.2, ex, ey); c.lineWidth = 0.3; c.strokeStyle = O; c.stroke(); c.lineWidth = 0.21; c.strokeStyle = i % 2 ? hex(leaf) : shade(leaf, 0.16); c.stroke(); } ell(c, x + 0.1, 1.2, 0.11, 0.11, '#6a4a2a'); return; }
    if (sp === 'cactus') { box(c, x - 0.26, 1.5, 0.52, 1.65, hex(leaf), 0.26); box(c, x + 0.3, 1.9, 0.5, 0.26, hex(leaf), 0.13); box(c, x + 0.58, 1.45, 0.26, 0.7, hex(leaf), 0.13); box(c, x - 0.75, 2.2, 0.5, 0.24, hex(leaf), 0.12); box(c, x - 0.8, 1.85, 0.24, 0.58, hex(leaf), 0.12); box(c, x - 0.16, 1.6, 0.12, 1.4, shade(leaf, 0.2), 0.06, 0); ell(c, x, 1.48, 0.1, 0.1, '#e85a7a'); return; }
    if (sp === 'mushroom') { box(c, x - 0.2, 1.9, 0.4, 1.25, '#efe6d2', 0.12); c.beginPath(); c.ellipse(x, 1.95, 1.1, 0.95, 0, Math.PI, 0); c.closePath(); c.fillStyle = hex(leaf); c.fill(); c.lineWidth = 0.05; c.strokeStyle = O; c.stroke(); for (let i = 0; i < 6; i++) ell(c, x - 0.75 + r() * 1.5, 1.2 + r() * 0.6, 0.1 + r() * 0.07, 0.08, '#fff4e0', 0.02); return; }
    const slim = sp === 'birch', th = slim ? 0.17 : 0.3;
    poly(c, [[x - th * 0.6, 2.0], [x + th * 0.6, 2.0], [x + th, 3.12], [x + th * 1.5, 3.2], [x - th * 1.5, 3.2], [x - th, 3.12]], hex(bark)); box(c, x - th * 0.45, 2.1, th * 0.4, 1.0, shade(bark, 0.2), 0.05, 0);
    if (slim) { c.strokeStyle = '#3a3a3a'; c.lineWidth = 0.04; for (let i = 0; i < 4; i++) { c.beginPath(); c.moveTo(x - 0.08, 2.2 + i * 0.25); c.lineTo(x + 0.06, 2.22 + i * 0.25); c.stroke(); } }
    if (sp === 'dead') { c.strokeStyle = O; c.lineCap = 'round'; for (const pass of [0, 1]) { c.lineWidth = pass ? 0.11 : 0.2; c.strokeStyle = pass ? hex(bark) : O; for (const [dx, dy] of [[-0.7, -0.9], [0.6, -1.1], [-0.2, -1.4], [0.9, -0.5]]) { c.beginPath(); c.moveTo(x, 2.2); c.quadraticCurveTo(x + dx * 0.3, 2.2 + dy * 0.7, x + dx, 2.2 + dy); c.stroke(); } } return; }
    const list = []; const n = slim ? 4 : 6, R = slim ? 0.52 : 0.68;
    for (let i = 0; i < n; i++) { const a = i / n * TAU + r() * 0.5, d = i ? (slim ? 0.32 : 0.52) : 0; list.push([x + Math.cos(a) * d, 1.3 + Math.sin(a) * d * (slim ? 1.3 : 0.75), R * (0.8 + r() * 0.3)]); }
    list.sort((p, q) => p[1] - q[1]); puffs(c, list, leaf, r);
    if (sp === 'willow') { c.strokeStyle = shade(leaf, -0.2); c.lineWidth = 0.05; for (let i = 0; i < 9; i++) { const px = x - 0.9 + i * 0.22; c.beginPath(); c.moveTo(px, 1.5); c.quadraticCurveTo(px + 0.05, 2.1, px - 0.03, 2.5 + r() * 0.3); c.stroke(); } }
    if (o.snow) for (const [px, py, s] of list.slice(0, 3)) ell(c, px, py - s * 0.45, s * 0.7, s * 0.35, '#f4f8fb', 0.03);
    if (o.fruit != null) for (let i = 0; i < 7; i++) ell(c, x - 0.8 + r() * 1.6, 0.8 + r() * 1.0, 0.07, 0.07, hex(o.fruit), 0.025);
  },
  rock(c, o, r) { const col = o.color ?? 0x8f8c86; for (const [x, y, s] of [[0.42, 0.62, 0.34], [0.86, 0.58, 0.42], [0.62, 0.74, 0.3]]) { const p = []; for (let i = 0; i < 7; i++) { const a = i / 7 * TAU, d = s * (0.8 + r() * 0.3); p.push([x + Math.cos(a) * d, y + Math.sin(a) * d * 0.78]); } poly(c, p, hex(col)); poly(c, p.slice(3, 7).map(([px, py]) => [px * 0.96 + x * 0.04, py * 0.9 + (y - s * 0.2) * 0.1]), shade(col, 0.22), 0); } if (o.ore != null) for (let i = 0; i < 5; i++) ell(c, 0.4 + r() * 0.6, 0.45 + r() * 0.35, 0.05, 0.05, hex(o.ore), 0.02); if (o.moss) ell(c, 0.8, 0.36, 0.3, 0.1, '#5a9a3e', 0.02); if (o.snow) ell(c, 0.8, 0.34, 0.32, 0.1, '#f4f8fb', 0.02); },
  bush(c, o, r) { const col = o.color ?? 0x4a9440; puffs(c, [[0.4, 0.55, 0.3], [0.8, 0.5, 0.34], [0.6, 0.62, 0.3]], col, r); if (o.berries != null) for (let i = 0; i < 8; i++) ell(c, 0.25 + r() * 0.7, 0.35 + r() * 0.35, 0.05, 0.05, hex(o.berries), 0.02); },
  flower(c, o, r) { const col = o.color ?? [0xffffff, 0xffe066, 0xff9ac2, 0xc4a0ff][(r() * 4) | 0]; for (let i = 0; i < 3; i++) { const x = 0.15 + i * 0.15, y = 0.2 + r() * 0.12; c.strokeStyle = '#3c6c2c'; c.lineWidth = 0.03; c.beginPath(); c.moveTo(x, 0.5); c.lineTo(x, y); c.stroke(); ell(c, x, y, 0.07, 0.07, hex(col), 0.02); ell(c, x, y, 0.025, 0.025, '#f2b830', 0); } },
  reeds(c, o) { c.lineCap = 'round'; for (let i = 0; i < 6; i++) { const x = 0.12 + i * 0.1; c.strokeStyle = i % 2 ? '#5a8a3a' : '#7aa84a'; c.lineWidth = 0.04; c.beginPath(); c.moveTo(x, 0.9); c.quadraticCurveTo(x + 0.03, 0.5, x + (i - 3) * 0.03, 0.15 + (i % 3) * 0.1); c.stroke(); if (i % 2) ell(c, x + (i - 3) * 0.028, 0.24, 0.035, 0.09, hex(o.color ?? 0x7a4a2a), 0.015); } },
  mushrooms(c, o) { for (const [x, y, s] of [[0.2, 0.36, 1], [0.42, 0.42, 0.7], [0.3, 0.46, 0.5]]) { box(c, x - 0.03 * s, y - 0.12 * s, 0.06 * s, 0.14 * s, '#efe6d2', 0.02, 0.02); c.beginPath(); c.ellipse(x, y - 0.12 * s, 0.12 * s, 0.1 * s, 0, Math.PI, 0); c.closePath(); c.fillStyle = hex(o.color ?? 0xc83a2a); c.fill(); c.lineWidth = 0.02; c.strokeStyle = O; c.stroke(); } },
  log(c) { box(c, 0.08, 0.3, 1.1, 0.34, '#7a5234', 0.16); ell(c, 1.12, 0.47, 0.11, 0.17, '#c8a070'); ell(c, 1.12, 0.47, 0.05, 0.08, '#a8804c', 0.015); box(c, 0.2, 0.34, 0.7, 0.07, '#9a6a44', 0.03, 0); },
  stump(c) { box(c, 0.12, 0.3, 0.56, 0.36, '#7a5234', 0.08); ell(c, 0.4, 0.3, 0.28, 0.13, '#c8a070'); ell(c, 0.4, 0.3, 0.14, 0.06, '#a8804c', 0.015); },
  crystal(c, o) { const col = o.color ?? 0x6ef0ff; for (const [x, h, w] of [[0.3, 0.7, 0.14], [0.52, 0.95, 0.17], [0.72, 0.6, 0.13]]) { poly(c, [[x, 1 - h], [x + w, 1 - h * 0.7], [x + w * 0.8, 1], [x - w * 0.8, 1], [x - w, 1 - h * 0.7]], hex(col)); poly(c, [[x, 1 - h], [x - w, 1 - h * 0.7], [x - w * 0.8, 1], [x - w * 0.1, 1]], shade(col, 0.4), 0); } },
  house(c, o, r) { const wall = o.walls ?? 0xe8dcc0, roof = o.roof ?? [0xb8482a, 0x4a6a9a, 0x8a6a3a][sd(o.seed) % 3]; box(c, 0.3, 1.6, 2.9, 1.5, hex(wall), 0.03); box(c, 0.3, 2.85, 2.9, 0.25, shade(wall, -0.2), 0.02, 0.03); poly(c, [[0.05, 1.7], [0.7, 0.4], [2.8, 0.4], [3.45, 1.7]], hex(roof)); for (let i = 1; i < 4; i++) { c.strokeStyle = shade(roof, -0.25); c.lineWidth = 0.035; c.beginPath(); c.moveTo(0.05 + i * 0.16, 1.7 - i * 0.33); c.lineTo(3.45 - i * 0.16, 1.7 - i * 0.33); c.stroke(); } poly(c, [[0.75, 0.42], [2.75, 0.42], [2.6, 0.72], [0.9, 0.72]], shade(roof, 0.18), 0); box(c, 1.45, 2.25, 0.6, 0.85, '#6a4428', 0.04); ell(c, 1.92, 2.7, 0.04, 0.04, '#f2c230', 0.015); for (const x of [0.6, 2.4]) { box(c, x, 2.05, 0.5, 0.48, '#ffe9a8', 0.03); c.strokeStyle = O; c.lineWidth = 0.03; c.beginPath(); c.moveTo(x + 0.25, 2.05); c.lineTo(x + 0.25, 2.53); c.moveTo(x, 2.29); c.lineTo(x + 0.5, 2.29); c.stroke(); } box(c, 2.4, 0.15, 0.3, 0.55, '#8a6a5a', 0.02); },
  hut(c, o) { box(c, 0.4, 1.3, 1.6, 1.0, hex(o.walls ?? 0xc8a878), 0.04); poly(c, [[0.1, 1.4], [1.2, 0.2], [2.3, 1.4]], hex(o.roof ?? 0xc8a04a)); poly(c, [[0.45, 1.3], [1.2, 0.42], [1.25, 1.3]], shade(o.roof ?? 0xc8a04a, 0.2), 0); box(c, 0.98, 1.6, 0.45, 0.7, '#4a3020', 0.2); },
  tent(c, o) { const col = o.color ?? 0xd8a04a; poly(c, [[0.1, 1.5], [1.1, 0.2], [2.1, 1.5]], hex(col)); poly(c, [[0.1, 1.5], [1.1, 0.2], [0.8, 1.5]], shade(col, 0.22), 0); poly(c, [[0.85, 1.5], [1.1, 0.75], [1.35, 1.5]], '#3a2a20'); },
  campfire(c) { for (let i = 0; i < 6; i++) ell(c, 0.5 + Math.cos(i / 6 * TAU) * 0.32, 0.72 + Math.sin(i / 6 * TAU) * 0.14, 0.09, 0.07, '#8a867e', 0.03); box(c, 0.25, 0.62, 0.5, 0.1, '#6a4428', 0.04, 0.03); poly(c, [[0.5, 0.12], [0.68, 0.5], [0.6, 0.68], [0.4, 0.68], [0.32, 0.5]], '#ff8a2a', 0.03); poly(c, [[0.5, 0.34], [0.58, 0.56], [0.5, 0.66], [0.42, 0.56]], '#ffe27a', 0); },
  chest(c, o) { box(c, 0.1, 0.42, 0.9, 0.5, hex(o.color ?? 0x8a5a2a), 0.04); box(c, 0.1, 0.22, 0.9, 0.3, shade(o.color ?? 0x8a5a2a, 0.15), 0.14); box(c, 0.1, 0.48, 0.9, 0.07, '#f2c230', 0, 0.025); box(c, 0.49, 0.42, 0.12, 0.2, '#f2c230', 0.02, 0.025); },
  crate(c) { box(c, 0.08, 0.14, 0.74, 0.74, '#a8743c', 0.03); box(c, 0.16, 0.22, 0.58, 0.58, '#c08a4a', 0.02, 0.03); c.strokeStyle = '#7a5228'; c.lineWidth = 0.06; c.beginPath(); c.moveTo(0.18, 0.24); c.lineTo(0.72, 0.78); c.stroke(); },
  barrel(c) { box(c, 0.12, 0.12, 0.56, 0.78, '#9a6a3a', 0.14); for (const y of [0.26, 0.68]) box(c, 0.1, y, 0.6, 0.08, '#5a5e66', 0.02, 0.025); box(c, 0.2, 0.18, 0.1, 0.66, '#b8844a', 0.04, 0); },
  signpost(c) { box(c, 0.36, 0.3, 0.1, 0.9, '#7a5234', 0.02); poly(c, [[0.08, 0.18], [0.72, 0.18], [0.86, 0.34], [0.72, 0.5], [0.08, 0.5]], '#c89a5a'); c.strokeStyle = '#7a5228'; c.lineWidth = 0.035; c.beginPath(); c.moveTo(0.2, 0.29); c.lineTo(0.62, 0.29); c.moveTo(0.2, 0.4); c.lineTo(0.5, 0.4); c.stroke(); },
  fence(c) { for (const x of [0.1, 0.9, 1.7]) box(c, x, 0.2, 0.14, 0.7, '#9a6a3a', 0.03); for (const y of [0.34, 0.6]) box(c, 0.05, y, 1.84, 0.1, '#b8844a', 0.03); },
  well(c) { box(c, 0.2, 0.9, 1.0, 0.5, '#8f8c86', 0.06); ell(c, 0.7, 0.9, 0.5, 0.16, '#3a5a7a'); for (const x of [0.24, 1.06]) box(c, x, 0.3, 0.1, 0.65, '#7a5234', 0.02); poly(c, [[0.1, 0.36], [0.7, 0.06], [1.3, 0.36]], '#b8482a'); },
  lantern(c) { box(c, 0.2, 0.3, 0.07, 0.95, '#3a3e46', 0.02, 0.025); box(c, 0.12, 0.08, 0.24, 0.28, '#ffe27a', 0.04); box(c, 0.09, 0.03, 0.3, 0.08, '#3a3e46', 0.02, 0.025); },
  torch(c) { box(c, 0.16, 0.36, 0.08, 0.7, '#7a5234', 0.02, 0.025); poly(c, [[0.2, 0.04], [0.32, 0.26], [0.2, 0.4], [0.08, 0.26]], '#ff8a2a', 0.025); },
  gravestone(c) { box(c, 0.12, 0.2, 0.5, 0.7, '#9a9aa0', 0.22); box(c, 0.06, 0.8, 0.62, 0.14, '#7a7a82', 0.03); c.strokeStyle = '#5a5a62'; c.lineWidth = 0.04; c.beginPath(); c.moveTo(0.37, 0.36); c.lineTo(0.37, 0.64); c.moveTo(0.26, 0.46); c.lineTo(0.48, 0.46); c.stroke(); },
  pillar(c) { box(c, 0.16, 0.2, 0.4, 1.7, '#d8d2c4', 0.03); box(c, 0.08, 0.1, 0.56, 0.16, '#e8e2d4', 0.03); box(c, 0.08, 1.82, 0.56, 0.16, '#b8b2a4', 0.03); for (const x of [0.28, 0.42]) box(c, x, 0.3, 0.04, 1.48, '#b8b2a4', 0, 0); },
  ruin(c) { box(c, 0.1, 0.9, 0.6, 1.2, '#a8a294', 0.03); box(c, 1.7, 0.5, 0.6, 1.6, '#a8a294', 0.03); box(c, 0.7, 1.5, 1.0, 0.6, '#989284', 0.03); for (const [x, y] of [[0.2, 1.2], [1.85, 0.9], [1.0, 1.7], [1.9, 1.5]]) box(c, x, y, 0.3, 0.14, '#c0baa8', 0.02, 0.02); },
  container(c, o) { const col = o.color ?? 0xd8483a; box(c, 0.08, 0.3, 2.6, 1.3, hex(col), 0.03); for (let i = 0; i < 12; i++) box(c, 0.2 + i * 0.2, 0.4, 0.08, 1.1, shade(col, -0.18), 0, 0); box(c, 0.08, 0.3, 2.6, 0.12, shade(col, 0.2), 0, 0.03); },
  lamp(c) { box(c, 0.3, 0.4, 0.08, 1.9, '#3a3e46', 0.02, 0.025); box(c, 0.3, 0.3, 0.5, 0.08, '#3a3e46', 0.02, 0.025); box(c, 0.6, 0.36, 0.26, 0.14, '#fff0b0', 0.04, 0.025); },
  portal(c, o) { const col = o.color ?? 0x8a5aff; c.lineWidth = 0.2; c.strokeStyle = O; c.beginPath(); c.ellipse(0.8, 1.0, 0.6, 0.85, 0, 0, TAU); c.stroke(); c.lineWidth = 0.13; c.strokeStyle = '#8f8c86'; c.stroke(); ell(c, 0.8, 1.0, 0.5, 0.75, hex(col), 0); ell(c, 0.74, 0.9, 0.3, 0.48, shade(col, 0.4), 0); ell(c, 0.7, 0.84, 0.12, 0.2, '#ffffff', 0); },
  gem(c, o) { const col = o.color ?? 0xff7a3a; poly(c, [[0.3, 0.06], [0.52, 0.26], [0.3, 0.56], [0.08, 0.26]], hex(col), 0.035); poly(c, [[0.3, 0.06], [0.08, 0.26], [0.3, 0.3]], shade(col, 0.45), 0); },
  coin(c, o) { ell(c, 0.3, 0.3, 0.2, 0.22, hex(o.color ?? 0xf2c230), 0.035); ell(c, 0.27, 0.28, 0.11, 0.13, shade(o.color ?? 0xf2c230, 0.4), 0); },
  key(c, o) { const col = hex(o.color ?? 0xf2c230); c.lineWidth = 0.12; c.strokeStyle = O; c.beginPath(); c.arc(0.2, 0.25, 0.1, 0, TAU); c.moveTo(0.3, 0.25); c.lineTo(0.62, 0.25); c.moveTo(0.5, 0.25); c.lineTo(0.5, 0.38); c.moveTo(0.6, 0.25); c.lineTo(0.6, 0.36); c.stroke(); c.lineWidth = 0.06; c.strokeStyle = col; c.stroke(); },
  star(c, o) { const p = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * TAU / 10, d = i % 2 ? 0.11 : 0.25; p.push([0.3 + Math.cos(a) * d, 0.3 + Math.sin(a) * d]); } poly(c, p, hex(o.color ?? 0xffe27a), 0.035); },
  heart(c, o) { c.beginPath(); c.moveTo(0.3, 0.52); c.bezierCurveTo(-0.05, 0.3, 0.1, 0.02, 0.3, 0.2); c.bezierCurveTo(0.5, 0.02, 0.65, 0.3, 0.3, 0.52); c.fillStyle = hex(o.color ?? 0xff4a5a); c.fill(); c.lineWidth = 0.035; c.strokeStyle = O; c.stroke(); },
};
// size [w, h], shadow radius, collision radius, extras
const META = { tree: [2.6, 3.3, 1.0, 0.35, { sway: true }], rock: [1.4, 1.1, 0.6, 0.5], bush: [1.2, 1.0, 0.5, 0], flower: [0.6, 0.55, 0, 0, { sway: true }], reeds: [0.8, 0.95, 0, 0, { sway: true }], mushrooms: [0.6, 0.55, 0, 0], log: [1.3, 0.75, 0.55, 0.4], stump: [0.8, 0.75, 0.35, 0.3], crystal: [1.0, 1.05, 0.4, 0.35, { light: { r: 2.4, color: 0x6ef0ff, flicker: false } }],
  house: [3.5, 3.2, 1.7, 1.5], hut: [2.4, 2.4, 1.1, 1.0], tent: [2.2, 1.6, 1.0, 0.8], campfire: [1.0, 0.85, 0.4, 0.35, { light: { r: 5, color: 0xffa040 } }], chest: [1.1, 1.0, 0.5, 0.4], crate: [0.9, 0.95, 0.42, 0.4], barrel: [0.8, 0.95, 0.36, 0.33], signpost: [0.9, 1.25, 0.2, 0.15], fence: [2.0, 0.95, 0.9, 0.7], well: [1.4, 1.45, 0.65, 0.6],
  lantern: [0.5, 1.3, 0.14, 0.12, { light: { r: 4.2, color: 0xffd080 } }], torch: [0.4, 1.1, 0.12, 0.1, { light: { r: 3.6, color: 0xff9a40 } }], gravestone: [0.75, 1.0, 0.34, 0.3], pillar: [0.72, 2.05, 0.34, 0.3], ruin: [2.4, 2.2, 1.2, 1.0], container: [2.8, 1.7, 1.4, 1.2], lamp: [0.95, 2.4, 0.16, 0.12, { light: { r: 5, color: 0xfff0b0, flicker: false } }], portal: [1.6, 1.95, 0.6, 0, { light: { r: 3.5, color: 0xa080ff, flicker: false } }],
  gem: [0.6, 0.62, 0.18, 0], coin: [0.6, 0.6, 0.18, 0], key: [0.72, 0.5, 0.18, 0], star: [0.6, 0.6, 0.18, 0], heart: [0.6, 0.6, 0.18, 0] };
/** Every kind sprite2d() accepts. */
export const SPRITES2D = Object.keys(META);
/** Every species sprite2d('tree', { species }) accepts. */
export const TREES2D = Object.keys(LEAF2D);
const BAKED = new Map();
/**
 * A painted thing for stage.add() or scatter2d(): outlined, shaded from the upper left, anchored at its feet.
 * kind: tree, rock, bush, flower, reeds, mushrooms, log, stump, crystal, house, hut, tent, campfire, chest, crate,
 * barrel, signpost, fence, well, lantern, torch, gravestone, pillar, ruin, container, lamp, portal, gem, coin, key,
 * star, heart. Options: seed (each seed is a different individual), size (scale), color, and per kind: tree
 * { species: oak | birch | pine | palm | maple | blossom | willow | dead | cactus | mushroom, leaf, trunk, snow, fruit },
 * rock { ore, moss, snow }, bush { berries }, house { walls, roof }. Lights (campfire, lantern, torch, lamp, crystal,
 * portal) glow when the mood is dark. Returns the sprite ({ canvas, w, h, solid, shadow }).
 */
export function sprite2d(kind, opts = {}) {
  const m = META[kind]; if (!m) throw new Error(`Unknown sprite2d kind "${kind}". Known kinds: ${SPRITES2D.join(', ')}.`);
  const key = kind + JSON.stringify(opts); let s = BAKED.get(key);
  if (!s) { const k = opts.size || 1, r = mulberry32(sd(opts.seed) * 7919 + kind.length * 31); s = bake(m[0], m[1], (c) => S2[kind](c, opts, r), { scale: 56 * Math.min(1.5, Math.max(1, k)) }); s.w *= k; s.h *= k; s.shadow = m[2] * k; s.solid = m[3] * k; s.kind = kind; Object.assign(s, m[4] || {}); BAKED.set(key, s); }
  return s;
}

/**
 * Places many sprites by rule. kinds: a list of sprite2d() results. Options: count, radius (around 0, 0), ground
 * (things stand only where they can: on land, off the paths), where (x, y, kind) => true | false | chance,
 * avoid [{ x, y, r }], minDistance, seed, stage. Returns { items, solids } where solids is [{ x, y, r }] for control2d.
 */
export function scatter2d(kinds, opts = {}) {
  const st = opts.stage || CURRENT, g = opts.ground || (st && st.ground), { count = 200, radius = 50, avoid = [], minDistance = 0, where } = opts, r = mulberry32(sd(opts.seed) * 5413 + 3), items = [], solids = [], cell = new Map(), md = minDistance;
  for (let tries = 0; tries < count * 12 && items.length < count; tries++) {
    const a = r() * TAU, d = Math.sqrt(r()) * radius, x = Math.cos(a) * d, y = Math.sin(a) * d, k = g ? g.kindAt(x, y) : 'grass', s = kinds[(r() * kinds.length) | 0];
    if (k === 'water' || (k === 'dirt' && s.solid) || (k === 'sand' && s.kind === 'tree' && r() < 0.8)) continue;
    if (where) { const ok = where(x, y, k); if (!ok || (typeof ok === 'number' && r() > ok)) continue; }
    if (avoid.some((v) => Math.hypot(x - v.x, y - v.y) < v.r)) continue;
    if (md) { const cx = Math.floor(x / md), cy = Math.floor(y / md); let hit = false; for (let i = -1; i <= 1 && !hit; i++) for (let j = -1; j <= 1 && !hit; j++) for (const p of cell.get((cx + i) + ',' + (cy + j)) || []) if (Math.hypot(p[0] - x, p[1] - y) < md) { hit = true; break; } if (hit) continue; const ck = cx + ',' + cy; if (!cell.has(ck)) cell.set(ck, []); cell.get(ck).push([x, y]); }
    const it = st.add(s, x, y, { flip: r() < 0.5 && s.kind !== 'house', scale: 0.88 + r() * 0.3 }); items.push(it); if (s.solid) solids.push({ x, y: y - 0.1, r: s.solid * it.scale });
  }
  return { items, solids };
}

// ---- actors: drawn from parts every frame, so they walk, bob and turn without sprite sheets ----
const PEOPLE = {
  villager: { shirt: 0x3f7fbf, pants: 0x5a4a3a, hair: 0x4a3020 }, explorer: { shirt: 0xd8583a, pants: 0x4a5a3a, hair: 0x5a3420, pack: 0x8a5a2a }, farmer: { shirt: 0xc8482a, pants: 0x3a5a8a, hat: 0xd8b860, hair: 0x8a5a2a },
  knight: { shirt: 0x9aa4ae, pants: 0x6a727a, hat: 0xaab2bc, helmet: true, cape: 0xa82a2a }, wizard: { shirt: 0x5a3a9a, pants: 0x4a2f80, hat: 0x5a3a9a, pointy: true, robe: true, beard: 0xe8e8e8 }, ninja: { shirt: 0x24262c, pants: 0x1c1e22, hood: 0x24262c },
  pirate: { shirt: 0xf0ead8, pants: 0x3a2a4a, hat: 0x2a2a30, beard: 0x2a1c12 }, astronaut: { shirt: 0xe8ecf0, pants: 0xe8ecf0, hood: 0xe8ecf0, visor: 0x1c2a3a }, robot: { skin: 0x9aa4ae, shirt: 0x6a7a8a, pants: 0x4a5560, hair: null, eyes: 0x40e0ff },
  skeleton: { skin: 0xe8e2d0, shirt: 0xd8d2c0, pants: 0xcfc8b4, hair: null }, zombie: { skin: 0x7a9a6a, shirt: 0x5a4a3a, pants: 0x3a3a44, hair: 0x2a2a22 }, king: { shirt: 0x8a2a3a, pants: 0x3a2a4a, crown: true, cape: 0x7a1a2a, robe: true, beard: 0x8a6a4a }, child: { shirt: 0xf2b830, pants: 0x3a6a9a, hair: 0x6a4020, size: 0.75 },
};
const BEASTS = { deer: { c: 0x9a6a3c, l: 0.5, w: 0.8, antlers: 1 }, wolf: { c: 0x6a6e78, l: 0.34, w: 0.8, ears: 1, tail: 1 }, fox: { c: 0xd8702a, l: 0.24, w: 0.62, ears: 1, tail: 1, tip: 0xffffff }, sheep: { c: 0xf2f0e8, l: 0.22, w: 0.66, wool: 1, face: 0x3a3a3a }, boar: { c: 0x5a4636, l: 0.22, w: 0.72, tusk: 1 }, bear: { c: 0x5a3e2a, l: 0.3, w: 1.0, ears: 1 },
  rabbit: { c: 0xc8b8a0, l: 0.1, w: 0.32, long: 1 }, cow: { c: 0xf2f0ea, l: 0.36, w: 0.95, spots: 0x3a3a3a }, pig: { c: 0xf0a8b0, l: 0.18, w: 0.6 }, chicken: { c: 0xf8f4ec, l: 0.12, w: 0.28, comb: 1 }, horse: { c: 0x8a5a34, l: 0.56, w: 0.95, tail: 1, ears: 1 },
  slime: { c: 0x6ad86a, blob: 1 }, ghost: { c: 0xe8f0ff, blob: 2 }, bat: { c: 0x3a3048, blob: 3 }, bird: { c: 0x4a8ad8, blob: 3 } };
/** Every preset and animal actor2d() accepts. */
export const ACTORS2D = [...Object.keys(PEOPLE), ...Object.keys(BEASTS)];

/**
 * An animated person or animal. kind: a person (villager, explorer, farmer, knight, wizard, ninja, pirate, astronaut,
 * robot, skeleton, zombie, king, child) or an animal (deer, wolf, fox, sheep, boar, bear, rabbit, cow, pig, chicken,
 * horse, slime, ghost, bat, bird). Options: any colour of the preset (skin, shirt, pants, hair, hat, cape, color for
 * animals), size. The actor is added to the stage. Fields: x, y, facing ('down' | 'up' | 'left' | 'right'), moving,
 * radius, visible; actor.play('cheer' | 'hurt' | 'attack') for a short reaction; actor.dead = true lays it down.
 */
export function actor2d(kind = 'villager', opts = {}) {
  const st = opts.stage || CURRENT, B = BEASTS[kind], P = B ? null : { ...PEOPLE.villager, ...(PEOPLE[kind] || {}), ...opts }, k = (opts.size || (P && P.size) || 1), skin = P ? hex(P.skin ?? [0xf2c9a0, 0xe0ac7e, 0xc68a5a, 0xffd9b8][sd(opts.seed) % 4]) : '';
  const a = { kind, x: opts.x || 0, y: opts.y || 0, facing: 'down', moving: false, speed: 1, radius: (B ? (B.w || 0.5) * 0.5 : 0.3) * k, height: (B ? 0.9 : 1.5) * k, isActor: true, visible: true, dead: false, walkT: Math.random() * 6, shot: null, shotT: 0, flies: !!(B && B.blob === 3), isAnimal: !!B,
    play(name) { a.shot = name; a.shotT = 0; return a; },
    draw(c, t) {
      const dt = Math.min(0.05, t - (a.lastT ?? t)); a.lastT = t; if (a.moving) a.walkT += dt * 9 * a.speed; if (a.shot) { a.shotT += dt; if (a.shotT > 0.6) a.shot = null; }
      const sw = a.moving ? Math.sin(a.walkT) : 0, hop = a.shot === 'cheer' ? -Math.abs(Math.sin(a.shotT * 12)) * 0.25 : a.moving ? -Math.abs(Math.cos(a.walkT)) * 0.04 : Math.sin(t * 2 + a.walkT) * 0.012, left = a.facing === 'left';
      c.save(); c.translate(a.x, a.y + hop); c.scale(k * (left ? -1 : 1), k); if (a.dead) { c.rotate(Math.PI / 2); c.translate(-0.3, -0.2); } if (a.shot === 'hurt') c.globalAlpha = 0.55 + Math.sin(a.shotT * 40) * 0.3;
      if (B) drawBeast(c, B, opts.color ?? B.c, sw, t, a); else drawPerson(c, P, skin, sw, a, t);
      c.restore();
    } };
  if (st) st.addActor(a); return a;
}
function drawPerson(c, P, skin, sw, a, t) {
  const f = a.facing, side = f === 'left' || f === 'right', up = f === 'up', shirt = hex(P.shirt), pants = hex(P.pants), arm = a.shot === 'cheer' ? -2.4 : a.shot === 'attack' ? -1.6 + a.shotT * 4 : sw * 0.7;
  if (P.cape != null && !up) box(c, -0.2, -1.02, 0.4, 0.74 + sw * 0.03, hex(P.cape), 0.05);
  if (P.robe) poly(c, [[-0.2, -0.62], [0.2, -0.62], [0.27, -0.06], [-0.27, -0.06]], shirt); else { for (const s of [-1, 1]) { const o = side ? sw * s * 0.13 : 0, l = side ? 0 : sw * s * 0.07; box(c, s * 0.1 - 0.075 + o, -0.42, 0.15, 0.36 - l, pants, 0.05); box(c, s * 0.1 - 0.09 + o + (side ? 0.03 : 0), -0.11 - l, 0.19, 0.11, '#3a2a20', 0.04); } }
  if (P.pack != null && (up || side)) box(c, up ? -0.17 : -0.3, -0.98, up ? 0.34 : 0.16, 0.4, hex(P.pack), 0.05);
  for (const s of side ? [1] : [-1, 1]) { c.save(); c.translate(side ? 0 : s * 0.24, -0.98); c.rotate(side ? arm : s * (0.12 + Math.abs(arm) * (a.shot ? 1 : 0.25) * (a.shot === 'cheer' ? 1.2 : 0.4)) * (a.shot === 'cheer' ? -2 : 1)); if (!side || !a.shot) c.rotate(side ? 0 : s * sw * 0.15); box(c, -0.065, 0, 0.13, 0.38, shirt, 0.06); ell(c, 0, 0.4, 0.065, 0.065, skin, 0.03); c.restore(); }
  box(c, -0.21, -1.04, 0.42, 0.5, shirt, 0.11); box(c, -0.2, -0.62, 0.4, 0.07, shade(P.pants, -0.3), 0.02, 0.02);
  if (P.cape != null && up) box(c, -0.2, -1.02, 0.4, 0.74, hex(P.cape), 0.05);
  if (P.pack != null && up) box(c, -0.17, -0.98, 0.34, 0.4, hex(P.pack), 0.05);
  ell(c, 0, -1.3, 0.29, 0.3, P.hood != null ? hex(P.hood) : skin);
  if (P.hood != null && !up) ell(c, side ? 0.08 : 0, -1.28, side ? 0.17 : 0.21, 0.2, P.visor != null ? hex(P.visor) : skin, 0.03);
  if (P.hair != null && P.hood == null && !P.helmet) { c.beginPath(); if (up) c.ellipse(0, -1.3, 0.3, 0.31, 0, 0, TAU); else c.ellipse(side ? -0.05 : 0, -1.36, 0.3, 0.26, 0, Math.PI * (side ? 0.75 : 0.95), Math.PI * (side ? 2.0 : 2.05)); c.fillStyle = hex(P.hair); c.fill(); c.lineWidth = 0.04; c.strokeStyle = O; c.stroke(); }
  if (!up && P.visor == null) { const ey = P.eyes != null ? hex(P.eyes) : '#1c1c22'; for (const s of side ? [1] : [-1, 1]) ell(c, side ? 0.14 : s * 0.11, -1.27, 0.04, 0.05, ey, 0); if (P.beard != null) ell(c, side ? 0.1 : 0, -1.1, side ? 0.13 : 0.17, 0.13, hex(P.beard), 0.03); else if (a.kind !== 'robot' && a.kind !== 'skeleton') { ell(c, side ? 0.2 : -0.17, -1.2, 0.045, 0.03, 'rgba(230,110,100,0.45)', 0); if (!side) ell(c, 0.17, -1.2, 0.045, 0.03, 'rgba(230,110,100,0.45)', 0); } }
  if (P.helmet) { c.beginPath(); c.ellipse(0, -1.34, 0.31, 0.29, 0, Math.PI, 0); c.closePath(); c.fillStyle = hex(P.hat); c.fill(); c.lineWidth = 0.04; c.strokeStyle = O; c.stroke(); box(c, -0.03, -1.74, 0.06, 0.16, '#c8382a', 0.02, 0.025); }
  else if (P.crown) poly(c, [[-0.22, -1.5], [-0.22, -1.74], [-0.11, -1.62], [0, -1.78], [0.11, -1.62], [0.22, -1.74], [0.22, -1.5]], '#f2c230', 0.035);
  else if (P.pointy) { ell(c, 0, -1.5, 0.42, 0.09, hex(P.hat)); poly(c, [[-0.22, -1.52], [0.04, -2.12], [0.22, -1.52]], hex(P.hat)); }
  else if (P.hat != null) { ell(c, 0, -1.5, 0.4, 0.1, hex(P.hat)); box(c, -0.2, -1.68, 0.4, 0.2, hex(P.hat), 0.08); }
}
function drawBeast(c, B, col, sw, t, a) {
  const C = hex(col), D = shade(col, -0.25);
  if (B.blob === 1) { const s = 1 + Math.sin(t * 5 + a.walkT) * 0.08; c.beginPath(); c.ellipse(0, -0.26 / s, 0.36 * s, 0.3 / s, 0, 0, TAU); c.fillStyle = C; c.fill(); c.lineWidth = 0.045; c.strokeStyle = O; c.stroke(); ell(c, -0.1, -0.36, 0.1, 0.07, shade(col, 0.4), 0); for (const s2 of [-1, 1]) ell(c, s2 * 0.12 + 0.04, -0.26, 0.04, 0.055, '#1c1c22', 0); return; }
  if (B.blob === 2) { c.globalAlpha *= 0.82; const y = -0.9 + Math.sin(t * 2 + a.walkT) * 0.08; c.beginPath(); c.arc(0, y, 0.32, Math.PI, 0); c.lineTo(0.32, y + 0.5); for (let i = 0; i < 4; i++) c.quadraticCurveTo(0.24 - i * 0.16, y + 0.36 + Math.sin(t * 6 + i) * 0.04, 0.16 - i * 0.16, y + 0.5); c.closePath(); c.fillStyle = C; c.fill(); c.lineWidth = 0.04; c.strokeStyle = '#8a9ac0'; c.stroke(); for (const s2 of [-1, 1]) ell(c, s2 * 0.11 + 0.04, y, 0.045, 0.07, '#2a3048', 0); return; }
  if (B.blob === 3) { const y = -1.3 + Math.sin(t * 3 + a.walkT) * 0.1, fl = Math.sin(t * 16 + a.walkT) * 0.22; for (const s2 of [-1, 1]) poly(c, [[0, y], [s2 * 0.36, y - 0.14 + fl], [s2 * 0.3, y + 0.08 + fl * 0.4]], D, 0.03); ell(c, 0, y, 0.13, 0.11, C, 0.035); ell(c, 0.08, y - 0.02, 0.025, 0.025, '#1c1c22', 0); return; }
  const w = B.w, l = B.l, by = -l - w * 0.24;
  for (const [x, ph] of [[-w * 0.36, 0], [-w * 0.22, Math.PI], [w * 0.2, Math.PI], [w * 0.34, 0]]) box(c, x - 0.045 + Math.sin(a.walkT + ph) * (a.moving ? 0.06 : 0), -l - 0.02, 0.09, l + 0.02, D, 0.03, 0.03);
  if (B.tail) { c.lineCap = 'round'; c.lineWidth = 0.13; c.strokeStyle = O; c.beginPath(); c.moveTo(-w * 0.45, by); c.quadraticCurveTo(-w * 0.75, by - 0.05 + sw * 0.05, -w * 0.8, by + 0.16); c.stroke(); c.lineWidth = 0.07; c.strokeStyle = B.tip != null ? hex(B.tip) : C; c.stroke(); }
  if (B.wool) { for (const pass of [0, 1]) for (let i = 0; i < 5; i++) ell(c, -w * 0.3 + i * w * 0.15, by + (i % 2) * 0.04, w * 0.2 + (pass ? 0 : 0.04), w * 0.24 + (pass ? 0 : 0.04), pass ? C : O, 0); } else ell(c, 0, by, w * 0.5, w * 0.26, C);
  if (B.spots != null) { ell(c, -w * 0.15, by - 0.04, w * 0.14, w * 0.1, hex(B.spots), 0); ell(c, w * 0.16, by + 0.05, w * 0.1, w * 0.08, hex(B.spots), 0); }
  const hx = w * 0.5, hy = by - w * 0.2, hr = Math.max(0.1, w * 0.19), fc = B.face != null ? hex(B.face) : C;
  if (B.ears) for (const s2 of [-1, 1]) poly(c, [[hx + s2 * hr * 0.5 - 0.04, hy - hr * 0.6], [hx + s2 * hr * 0.6, hy - hr * 1.55], [hx + s2 * hr * 0.5 + 0.06, hy - hr * 0.6]], D, 0.03);
  if (B.long) for (const s2 of [-1, 1]) ell(c, hx + s2 * 0.05, hy - hr * 1.5, 0.035, 0.12, C, 0.025);
  if (B.antlers) { c.strokeStyle = '#c8b090'; c.lineWidth = 0.04; c.lineCap = 'round'; for (const s2 of [-1, 1]) { c.beginPath(); c.moveTo(hx + s2 * 0.05, hy - hr * 0.8); c.lineTo(hx + s2 * 0.16, hy - hr * 2.4); c.moveTo(hx + s2 * 0.11, hy - hr * 1.6); c.lineTo(hx + s2 * 0.24, hy - hr * 1.9); c.stroke(); } }
  ell(c, hx, hy, hr * 1.15, hr, fc); ell(c, hx + hr * 0.9, hy + hr * 0.25, hr * 0.5, hr * 0.4, B.face != null ? fc : shade(col, 0.15), 0.03); ell(c, hx + hr * 0.3, hy - hr * 0.15, 0.03, 0.035, '#1c1c22', 0);
  if (B.comb) poly(c, [[hx - 0.05, hy - hr], [hx, hy - hr * 1.7], [hx + 0.06, hy - hr]], '#d8382a', 0.02); if (B.tusk) poly(c, [[hx + hr, hy + hr * 0.3], [hx + hr * 1.3, hy - hr * 0.2], [hx + hr * 0.8, hy + hr * 0.1]], '#f4f0e0', 0.02);
}

/**
 * Player movement and the camera for an actor2d. Options: input (createInput), ground (walks only on land), solids
 * ([{ x, y, r }] from scatter2d), speed, runSpeed (Shift), bounds (radius), onStep, stage.
 * Returns the controller: update(dt) every frame, enabled, teleport(x, y), moveTo(x, y) (a promise; used by play-throughs).
 */
export function control2d(actor, opts = {}) {
  const st = opts.stage || CURRENT, g = opts.ground || (st && st.ground), { input, speed = 4.2, runSpeed = 6.8, bounds = Infinity } = opts;
  if (!input) throw new Error('control2d() needs { input }: const input = createInput(canvas) from "@gcp/craft2d.js".');
  const C = { enabled: true, solids: opts.solids || [], target: null, stepT: 0 }; if (st && !st.focus) { st.focus = actor; st.camera.x = actor.x; st.camera.y = actor.y; }
  C.teleport = (x, y) => { actor.x = x; actor.y = y; }; C.moveTo = (x, y, timeout = 20) => new Promise((res) => { C.target = { x, y, res, t: timeout }; });
  C.update = (dt) => {
    let mx = 0, my = 0, run = false;
    if (C.enabled) { if (C.target) { const dx = C.target.x - actor.x, dy = C.target.y - actor.y, d = Math.hypot(dx, dy); C.target.t -= dt; if (d < 0.35 || C.target.t <= 0) { const r = C.target.res; C.target = null; r(d < 0.35); } else { mx = dx / d; my = dy / d; } } else { const m = input.move; mx = m.x; my = -m.y; run = input.down('ShiftLeft') || input.down('ShiftRight'); } }
    const len = Math.hypot(mx, my), sp = (run ? runSpeed : speed) * Math.min(1, len); actor.moving = len > 0.08; actor.speed = run ? 1.4 : 1;
    if (actor.moving) {
      let x = actor.x + mx / len * sp * dt, y = actor.y + my / len * sp * dt;
      for (const s of C.solids) { const dx = x - s.x, dy = y - s.y, rr = s.r + actor.radius * 0.6, d2 = dx * dx + dy * dy; if (d2 < rr * rr && d2 > 1e-6) { const d = Math.sqrt(d2); x = s.x + dx / d * rr; y = s.y + dy / d * rr; } }
      const d0 = Math.hypot(x, y); if (d0 > bounds) { x *= bounds / d0; y *= bounds / d0; }
      if (!g || C.target || g.walkable(x, y)) { actor.x = x; actor.y = y; } else if (g.walkable(x, actor.y)) actor.x = x; else if (g.walkable(actor.x, y)) actor.y = y;
      actor.facing = Math.abs(mx) > Math.abs(my) ? (mx < 0 ? 'left' : 'right') : my < 0 ? 'up' : 'down';
      if (opts.onStep) { C.stepT -= dt * sp; if (C.stepT <= 0) { C.stepT = 2.2; opts.onStep(); } }
    }
  };
  return C;
}

/**
 * Makes an actor2d live on its own: it strolls around its home, runs from `flee` (an actor) or hunts `chase` (an
 * actor) when that comes within `sight`. Options: ground, radius (how far from home), speed, flee, chase, sight,
 * onReach (called when a chaser touches its prey), stage. Returns { stop(), enabled }.
 */
export function wander2d(actor, opts = {}) {
  const st = opts.stage || CURRENT, g = opts.ground || (st && st.ground), { radius = 10, speed = 1.3, flee, chase, sight = opts.range ?? 7 } = opts, home = { x: actor.x, y: actor.y }, W = { enabled: true }; let tx = actor.x, ty = actor.y, wait = Math.random() * 3;
  W.stop = st.onUpdate((dt) => {
    if (!W.enabled || actor.dead) { actor.moving = false; return; }
    let sp = speed; const other = chase || flee, od = other ? Math.hypot(other.x - actor.x, other.y - actor.y) : Infinity;
    if (chase && od < sight && !chase.dead) { tx = chase.x; ty = chase.y; sp = speed * 2.1; wait = 0; if (od < 0.8 && opts.onReach) opts.onReach(actor); }
    else if (flee && od < sight * 0.7) { tx = actor.x + (actor.x - flee.x) / od * 5; ty = actor.y + (actor.y - flee.y) / od * 5; sp = speed * 2.6; wait = 0; }
    const dx = tx - actor.x, dy = ty - actor.y, d = Math.hypot(dx, dy);
    if (d < 0.3 || wait > 0) { actor.moving = false; wait -= dt; if (wait <= 0 && d < 0.3) { const a = Math.random() * TAU, r = Math.random() * radius; tx = home.x + Math.cos(a) * r; ty = home.y + Math.sin(a) * r; if (g && !actor.flies && !g.walkable(tx, ty)) { tx = actor.x; ty = actor.y; } wait = 1 + Math.random() * 3; } return; }
    const nx = actor.x + dx / d * sp * dt, ny = actor.y + dy / d * sp * dt;
    if (!g || actor.flies || g.walkable(nx, ny)) { actor.x = nx; actor.y = ny; actor.moving = true; actor.speed = sp / speed; actor.facing = dx < 0 ? 'left' : 'right'; } else { tx = actor.x; ty = actor.y; }
  });
  return W;
}

export { createHud } from './hud.js';
export { createSound, SOUNDS, AMBIENCES, MUSIC } from './sound.js';
export { createInput } from './input.js';
export { run, createLoop, createBoot, clamp, lerp, smoothstep, TAU, store } from './core.js';
export { rng, mulberry32, noise, Simplex } from './procgen/noise.js';
export { setupCanvas, bake, Camera2D, drawSorted, ChunkCache } from './canvas2d.js';

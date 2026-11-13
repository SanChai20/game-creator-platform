// Block lab: builds any recipe live. Everything it shows comes from @gcp/craft.js and @gcp/procgen.js, the same
// modules games import.
import * as THREE from 'three';
import * as C from '@gcp/craft.js';
import { NOISE_GLSL, fbm2, vnoise2, gnoise2, ridged2, warp2, vnoise3, gnoise3, hash2i, recipeKey } from '@gcp/procgen.js';

const $ = (id) => document.getElementById(id), q = new URLSearchParams(location.search);
const kinds = C.recipeKinds(), byKind = Object.fromEntries(kinds.map((k) => [k.kind, k]));
const FLAT = new Set(['texture', 'noise']), ACTORS = new Set(['humanoid', 'animal']);
const ORDER = ['tree', 'rock', 'bush', 'cover', 'prop', 'humanoid', 'animal', 'surface', 'terrain', 'texture', 'noise'];
const USE = {
  tree: 'place(build(recipe), x, land.heightAt(x, z), z);   // or scatter([build(recipe), …], { count: 200 })',
  rock: 'place(build(recipe), x, y, z);', bush: 'place(build(recipe), x, y, z);', cover: 'scatter([build(recipe)], { count: 300, heightAt: land.heightAt });',
  prop: 'place(build(recipe), x, y, z, { rotY: 0.5 });', humanoid: "const actor = build(recipe); stage.scene.add(actor);\nactor.animate('walk', dt);   // every frame",
  animal: 'const a = build(recipe); stage.scene.add(a);\nwander(a, { heightAt: land.heightAt });', surface: 'mesh.material = build(recipe);   // or block(4, 3, 0.3, kind, options)',
  terrain: 'const land = build(recipe);   // land.heightAt(x, z), land.randomPoint(rand)', texture: 'const raster = build(recipe);   // raster.toCanvas(), raster.toRGBA(), raster.normalRGBA(2)',
  noise: 'const n = build(recipe);   // n(x, y) in JS, n.fill(array, w, h), n.glsl("p") in a shader',
};
const DEFAULTS = { tree: { species: 'oak' }, cover: { type: 'flower' }, prop: { prop: 'house' }, humanoid: { preset: 'explorer' }, animal: { animal: 'deer' }, surface: { surface: 'brick' }, terrain: { shape: 'island', palette: 'temperate' }, texture: { texture: 'planks' }, noise: { type: 'fbm', scale: 40 } };

let recipe;
try { recipe = q.get('recipe') ? JSON.parse(q.get('recipe')) : null; } catch { recipe = null; }
if (!recipe) { const kind = byKind[q.get('kind')] ? q.get('kind') : 'tree'; recipe = { kind, seed: 1, ...DEFAULTS[kind] }; for (const [k, v] of q) if (k !== 'kind' && k !== 'mood' && k !== 'weather') recipe[k] = isNaN(Number(v)) || v === '' ? v : Number(v); }

const stage = C.createStage('#view', { mood: C.MOODS[q.get('mood')] ? q.get('mood') : 'golden-hour' });
const ground = C.floor(400, 400, 'grass', { tile: 4 }); stage.scene.add(ground);
const flat = $('flat'), view = $('view');
let content = [], actor = null, orbit = { yaw: 0.6, pitch: 0.32, dist: 12, target: new THREE.Vector3(0, 1.5, 0), auto: true }, state = 'walk';

function fillSelect(el, list, value) { el.textContent = ''; for (const v of list) { const o = document.createElement('option'); o.value = o.textContent = v; el.appendChild(o); } el.value = value; }
fillSelect($('kind'), ORDER.filter((k) => byKind[k]), recipe.kind);
fillSelect($('mood'), Object.keys(C.MOODS), C.MOODS[q.get('mood')] ? q.get('mood') : 'golden-hour');
fillSelect($('weather'), ['none', ...C.WEATHERS], C.WEATHERS.includes(q.get('weather')) ? q.get('weather') : 'none');
if ($('weather').value !== 'none') stage.setWeather($('weather').value);

function paramsUI() {
  const box = $('params'); box.textContent = '';
  const add = (name, hint, value) => {
    const label = document.createElement('label'); label.textContent = name + ' ';
    const choices = hint.includes(' | ') ? hint.split(' | ').map((s) => s.trim()) : name === recipe.kind || /^one of /.test(hint) ? listFor(name) : null;
    let el;
    if (choices) { el = document.createElement('select'); fillSelect(el, name in DEFAULTS[recipe.kind] || {} ? choices : ['', ...choices], value ?? ''); }
    else { el = document.createElement('input'); el.placeholder = hint; el.value = value ?? ''; }
    el.addEventListener('change', () => { const v = el.value.trim(); if (v === '') delete recipe[name]; else recipe[name] = /^(0x[0-9a-f]+|-?\d+(\.\d+)?)$/i.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v; rebuild(); });
    label.appendChild(el); box.appendChild(label);
  };
  for (const [name, hint] of Object.entries(byKind[recipe.kind].params)) add(name, String(hint), recipe[name]);
  if (ACTORS.has(recipe.kind)) {
    const label = document.createElement('label'); label.textContent = 'animation '; const el = document.createElement('select');
    fillSelect(el, ['idle', 'walk', 'run', 'jump', 'sit', 'dead'], state); el.addEventListener('change', () => { state = el.value; }); label.appendChild(el); box.appendChild(label);
  }
}
const listFor = (name) => ({ texture: C.TEXTURES, surface: C.SURFACES, prop: C.PROPS, animal: C.ANIMALS_LIST })[name] || null;

function clear() { for (const o of content) { stage.scene.remove(o); } content = []; actor = null; }
function frame(obj, min = 3) {
  const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), r = Math.max(size.x, size.y, size.z, min);
  orbit.target.set((box.min.x + box.max.x) / 2, Math.max(0.5, (box.min.y + box.max.y) / 2), (box.min.z + box.max.z) / 2); orbit.dist = r * 1.55 + 2;
}
function rebuild() {
  $('err').textContent = ''; const t0 = performance.now(); let info = '';
  try {
    clear();
    const kind = recipe.kind, isFlat = FLAT.has(kind);
    flat.style.display = isFlat ? 'block' : 'none'; view.style.visibility = isFlat ? 'hidden' : 'visible'; ground.visible = kind !== 'terrain';
    if (kind === 'texture') {
      const r = C.build(recipe), tile = r.toCanvas(), n = document.createElement('canvas'); n.width = r.w; n.height = r.h;
      n.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.normalRGBA(2)), r.w, r.h), 0, 0);
      flat.width = r.w * 5; flat.height = r.h * 3; const g = flat.getContext('2d');
      for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) g.drawImage(tile, x * r.w, y * r.h);   // tiled 3 x 3: no seams
      g.drawImage(n, r.w * 3.5, r.h * 0.25); g.drawImage(tile, r.w * 3.5, r.h * 1.75);
      info = `${r.w} × ${r.h} pixels, shown tiled 3 × 3; right: its normal map and one tile`;
    } else if (kind === 'noise') {
      const S = 256, fn = C.build(recipe), out = new Float32Array(S * S); fn.fill(out, S, S, { x0: 0, y0: 0, step: 1 });
      flat.width = flat.height = S; const g = flat.getContext('2d'), im = g.createImageData(S, S); let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < out.length; i++) { const v = out[i]; lo = Math.min(lo, v); hi = Math.max(hi, v); const c = Math.max(0, Math.min(255, (v * 0.5 + 0.5) * 255)); im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = c; im.data[i * 4 + 3] = 255; }
      g.putImageData(im, 0, 0); info = `256 × 256 samples, one unit apart; values from ${lo.toFixed(3)} to ${hi.toFixed(3)}`;
    } else if (kind === 'terrain') {
      const land = C.build({ ...recipe, add: false }), sea = C.water({ level: land.waterLevel, add: false });
      stage.scene.add(land.mesh, sea); content.push(land.mesh, sea); orbit.target.set(0, 2, 0); orbit.dist = land.size * 0.4;
      info = `${C.countTriangles(land.mesh).toLocaleString()} triangles, ${land.size} m across`;
    } else if (kind === 'surface') {
      const mat = C.build(recipe), cube = new THREE.Mesh(C.tbox(3, 3, 3, 2), mat), ball = new THREE.Mesh(new THREE.SphereGeometry(1.4, 32, 20), mat);
      cube.position.set(-2, 1.5, 0); ball.position.set(2.2, 1.4, 0); cube.castShadow = ball.castShadow = true; const grp = new THREE.Group(); grp.add(cube, ball); stage.scene.add(grp); content.push(grp); frame(grp, 6);
      info = 'the same material on a 3 m cube (texture tiles every 2 m) and a sphere';
    } else if (ACTORS.has(kind)) {
      actor = C.build({ ...recipe, lab: Math.random() }); stage.scene.add(actor); content.push(actor); frame(actor, 2.2); // a fresh object each time: actors are never shared
      info = `${C.countTriangles(actor).toLocaleString()} triangles, jointed and animated`;
    } else {
      const grp = C.place(C.build(recipe), 0, 0, 0); content.push(grp); frame(grp);
      info = `${C.countTriangles(grp).toLocaleString()} triangles in ${grp.children.filter((c) => c.isMesh).length} draw calls`;
    }
    orbit.pitch = kind === 'terrain' ? 0.7 : 0.32;
  } catch (e) { $('err').textContent = e.message; console.error(e); }
  const shown = { ...recipe, v: recipe.v ?? byKind[recipe.kind].v };
  $('recipe').textContent = JSON.stringify(shown, null, 1).replace(/\n\s*/g, ' ');
  $('code').textContent = `import { build } from '@gcp/craft.js';\nconst recipe = ${recipeKey(shown)};\n${USE[recipe.kind] || ''}`;
  $('stats').textContent = `${info}. Built in ${(performance.now() - t0).toFixed(0)} ms. Recipe version ${shown.v}.`;
  const u = new URL(location.href); u.search = ''; u.searchParams.set('recipe', JSON.stringify(recipe)); if ($('mood').value !== 'golden-hour') u.searchParams.set('mood', $('mood').value); if ($('weather').value !== 'none') u.searchParams.set('weather', $('weather').value);
  history.replaceState(null, '', u);
}

$('kind').addEventListener('change', () => { const kind = $('kind').value; recipe = { kind, seed: 1, ...DEFAULTS[kind] }; paramsUI(); rebuild(); });
$('next').addEventListener('click', () => { recipe.seed = (Number.isInteger(recipe.seed) ? recipe.seed : C.toSeed(recipe.seed) % 1000) + 1; paramsUI(); rebuild(); });
$('copy').addEventListener('click', () => navigator.clipboard && navigator.clipboard.writeText($('recipe').textContent));
$('link').addEventListener('click', () => navigator.clipboard && navigator.clipboard.writeText(location.href));
$('mood').addEventListener('change', () => { stage.setMood($('mood').value, 1.2); rebuild(); });
$('weather').addEventListener('change', () => { stage.setWeather($('weather').value === 'none' ? null : $('weather').value); rebuild(); });

let drag = null;
view.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; orbit.auto = false; view.setPointerCapture(e.pointerId); });
view.addEventListener('pointermove', (e) => { if (!drag) return; orbit.yaw -= (e.clientX - drag.x) * 0.008; orbit.pitch = Math.max(0.03, Math.min(1.4, orbit.pitch + (e.clientY - drag.y) * 0.006)); drag = { x: e.clientX, y: e.clientY }; });
view.addEventListener('pointerup', () => { drag = null; });
view.addEventListener('wheel', (e) => { e.preventDefault(); orbit.dist = Math.max(1.5, Math.min(400, orbit.dist * (e.deltaY > 0 ? 1.1 : 0.9))); }, { passive: false });

let last = performance.now();
(function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (orbit.auto) orbit.yaw += dt * 0.25;
  const cp = Math.cos(orbit.pitch); stage.camera.position.set(orbit.target.x + Math.sin(orbit.yaw) * cp * orbit.dist, orbit.target.y + Math.sin(orbit.pitch) * orbit.dist, orbit.target.z + Math.cos(orbit.yaw) * cp * orbit.dist); stage.camera.lookAt(orbit.target);
  if (actor && actor.animate) actor.animate(state, dt);
  if (view.style.visibility !== 'hidden') { stage.update(dt); stage.render(); }
  requestAnimationFrame(loop);
})(last);

// CPU = GPU check: each noise function is evaluated in a fragment shader and in JavaScript at the same 65,536 points
// and compared as 24-bit integers (hashes as 32-bit).
function parity() {
  const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S; const gl = cv.getContext('webgl2'); if (!gl) return 'WebGL 2 is not available in this browser.';
  const vs = '#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
  const run = (expr, cpu, bits = 24) => {
    const fs = `#version 300 es\nprecision highp float; precision highp int; out vec4 o; ${NOISE_GLSL}\nvoid main(){ vec2 q = (gl_FragCoord.xy - 0.5) * 0.037 - 3.1; ${expr} }`;
    const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
    const pr = gl.createProgram(); gl.attachShader(pr, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, fs)); gl.bindAttribLocation(pr, 0, 'p'); gl.linkProgram(pr); gl.useProgram(pr);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, S, S); gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(S * S * 4); gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px); let same = 0;
    const K = Math.fround(0.037), O = Math.fround(3.1);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const i = (y * S + x) * 4, g = bits === 32 ? ((px[i] << 24) | (px[i + 1] << 16) | (px[i + 2] << 8) | px[i + 3]) >>> 0 : (px[i] << 16) | (px[i + 1] << 8) | px[i + 2]; if (g === cpu(Math.fround(Math.fround(x * K) - O), Math.fround(Math.fround(y * K) - O), x, y)) same++; }
    return same;
  };
  const enc = 'float e = clamp(v * 0.5 + 0.5, 0.0, 1.0) * 16777215.0; uint u = uint(e); o = vec4(float((u >> 16u) & 255u), float((u >> 8u) & 255u), float(u & 255u), 255.0) / 255.0;';
  const q24 = (v) => Math.floor(Math.fround(Math.min(1, Math.max(0, Math.fround(Math.fround(v * 0.5) + 0.5))) * 16777215));
  const tests = [
    ['integer hash', () => run('uint u = gcpHash2i(ivec2(gl_FragCoord.xy) - 100, 7u); o = vec4(float(u >> 24u), float((u >> 16u) & 255u), float((u >> 8u) & 255u), float(u & 255u)) / 255.0;', (a, b, x, y) => hash2i(x - 100, y - 100, 7), 32)],
    ['value noise 2D', () => run(`float v = gcpVnoise2(q, 5u); ${enc}`, (a, b) => q24(vnoise2(a, b, 5)))],
    ['gradient noise 2D', () => run(`float v = gcpGnoise2(q, 5u); ${enc}`, (a, b) => q24(gnoise2(a, b, 5)))],
    ['fractal (fbm)', () => run(`float v = gcpFbm2(q, 9u, 5, 2.0, 0.5, 0); ${enc}`, (a, b) => q24(fbm2(a, b, 9)))],
    ['fractal, odd settings', () => run(`float v = gcpFbm2(q, 9u, 6, 2.17, 0.55, 0); ${enc}`, (a, b) => q24(fbm2(a, b, 9, 6, 2.17, 0.55)))],
    ['tiling value fractal', () => run(`float v = gcpVfbm2(q, 9u, 4, 2.0, 0.5, 4); ${enc}`, (a, b) => q24(fbm2(a, b, 9, 4, 2, 0.5, 4, 'value')))],
    ['ridged fractal', () => run(`float v = gcpRidged2(q, 3u, 5, 2.0, 0.5, 0); ${enc}`, (a, b) => q24(ridged2(a, b, 3)))],
    ['domain warp', () => run(`float v = gcpWarp2(q, 3u, 4, 1.0, 2.0, 0.5); ${enc}`, (a, b) => q24(warp2(a, b, 3)))],
    ['value noise 3D', () => run(`float v = gcpVnoise3(vec3(q, 0.37), 3u); ${enc}`, (a, b) => q24(vnoise3(a, b, 0.37, 3)))],
    ['gradient noise 3D', () => run(`float v = gcpGnoise3(vec3(q, 0.37), 3u); ${enc}`, (a, b) => q24(gnoise3(a, b, 0.37, 3)))],
  ];
  const lines = []; let all = true;
  for (const [name, fn] of tests) { let same = 0; try { same = fn(); } catch (e) { lines.push(`${name}: ${e.message}`); all = false; continue; } if (same !== S * S) all = false; lines.push(`${same === S * S ? '=' : '≠'} ${name}: ${same.toLocaleString()} of ${(S * S).toLocaleString()} identical`); }
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  window.__parity = { all, lines };
  return `${all ? 'Identical on this device.' : 'Differences on this device (some GPUs fuse multiply-add; the JS result is the reference).'}\n${lines.join('\n')}\nGPU: ${ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'}`;
}
$('parity').addEventListener('click', () => { const out = $('parityOut'); out.style.display = 'block'; out.textContent = 'Running…'; setTimeout(() => { out.textContent = parity(); }, 30); });

paramsUI(); rebuild();
window.__lab = { recipe: () => recipe, ready: true };

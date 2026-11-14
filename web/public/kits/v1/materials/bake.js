// @gcp/materials.js · bake — paints a texture set on the GPU. One draw writes colour, AO/roughness/metalness and a
// 16-bit height into three targets at once; a second draw turns the height into a normal map; mipmaps follow. A set
// of 512 x 512 takes a few milliseconds on a graphics card and well under a second on a software renderer.
// Without a renderer (or to get pixels for a 2D canvas) it bakes in a private WebGL context and reads the pixels back.
import * as THREE from 'three';
import { LIB } from './lib.js';
import { LAYERS } from './weather.js';
import { BASES } from './bases.js';

const VERT = /* glsl */ `precision highp float;
in vec3 position; out vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const HEAD = /* glsl */ `precision highp float; precision highp int;
uniform float uSeed; uniform vec3 uC1; uniform vec3 uC2; uniform vec4 uP;
in vec2 vUv;
layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1; layout(location = 2) out vec4 o2;
`;
const MAIN = /* glsl */ `
void main(){
  Surf s = Surf(uC1, 0.5, 1.0, 0.8, 0.0, 1.0);
  base(vUv, s); layers(vUv, s);
  o0 = vec4(sqrt(clamp(s.col, 0.0, 1.0)), sat(s.a));
  o1 = vec4(sat(s.ao), clamp(s.r, 0.04, 1.0), sat(s.m), 1.0);
  float hh = sat(s.h) * 255.0, fl = floor(hh); o2 = vec4(fl / 255.0, hh - fl, 0.0, 1.0);
}`;
const COPY = /* glsl */ `precision highp float;
uniform sampler2D tA; uniform float uSq; in vec2 vUv; out vec4 o;
void main(){ vec4 t = texture(tA, vUv); o = uSq > 0.5 ? vec4(t.rgb * t.rgb, t.a) : t; }`;
const NORMAL = /* glsl */ `precision highp float;
uniform sampler2D tH; uniform vec2 uK; uniform float uTexel; in vec2 vUv; out vec4 o;
float H(vec2 uv){ vec4 t = texture(tH, uv); return t.r + t.g / 255.0; }
void main(){
  vec2 e = vec2(uTexel, 0.0);
  float l = H(vUv - e.xy), r = H(vUv + e.xy), d = H(vUv - e.yx), u = H(vUv + e.yx);
  float ld = H(vUv - e.xx), rd = H(vUv + vec2(e.x, -e.x)), lu = H(vUv + vec2(-e.x, e.x)), ru = H(vUv + e.xx);
  float gx = (r - l) * 0.5 + (ru + rd - lu - ld) * 0.25, gy = (u - d) * 0.5 + (ru + lu - rd - ld) * 0.25;
  o = vec4(normalize(vec3(-gx * uK.x, -gy * uK.y, 1.0)) * 0.5 + 0.5, 1.0);
}`;
const LIT = /* glsl */ `precision highp float;
uniform sampler2D tA; uniform sampler2D tN; uniform sampler2D tO; uniform vec3 uL; in vec2 vUv; out vec4 o;
void main(){
  vec4 a = texture(tA, vUv); vec3 n = texture(tN, vUv).xyz * 2.0 - 1.0; vec3 orm = texture(tO, vUv).rgb;
  float lit = 0.55 + 0.75 * max(dot(n, normalize(uL)), 0.0) - 0.25 * (1.0 - n.z);
  vec3 c = a.rgb * lit * mix(0.6, 1.0, orm.r) + pow(max(dot(reflect(-normalize(uL), n), vec3(0, 0, 1)), 0.0), 24.0) * (1.0 - orm.g) * 0.25;
  o = vec4(sqrt(clamp(c, 0.0, 1.0)), a.a);
}`;

/** Every program the baker has compiled, by base name; and the statistics a game can show in a debug overlay. */
export const BAKE_STATS = { sets: 0, ms: 0, bytes: 0, programs: 0, compileMs: 0 };

const PER = new WeakMap();   // renderer -> its private quad, camera, programs and scratch targets
function kit(renderer) {
  let k = PER.get(renderer);
  if (k) return k;
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quad = new THREE.Mesh(geo, null); quad.frustumCulled = false;
  const raw = (frag, uniforms) => new THREE.RawShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false });
  k = {
    quad, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), programs: new Map(), scratch: new Map(), raw,
    copy: raw(COPY, { tA: { value: null }, uSq: { value: 0 } }),
    normal: raw(NORMAL, { tH: { value: null }, uK: { value: new THREE.Vector2() }, uTexel: { value: 0 } }),
    lit: raw(LIT, { tA: { value: null }, tN: { value: null }, tO: { value: null }, uL: { value: new THREE.Vector3(-0.5, 0.6, 0.62) } }),
  };
  PER.set(renderer, k); return k;
}
// only the weathering layers a recipe uses are compiled in: a shader with none of them compiles several times faster
const layerDefines = (spec) => [['L_PAINT', spec.paint != null], ['L_WEAR', spec.wear > 0], ['L_RUST', spec.rust > 0], ['L_DIRT', spec.dirt > 0], ['L_LEAKS', spec.leaks > 0], ['L_MOSS', spec.moss > 0], ['L_DUST', spec.dust > 0]].filter((d) => d[1]).map((d) => d[0]);
function program(k, baseName, spec) {
  const defs = layerDefines(spec), key = baseName + '|' + defs.join(',');
  let p = k.programs.get(key);
  if (!p) {
    const b = BASES[baseName];
    p = k.raw(HEAD + defs.map((d) => `#define ${d}\n`).join('') + LIB + LAYERS + b.glsl + MAIN, {
      uSeed: { value: 0 }, uC1: { value: new THREE.Color() }, uC2: { value: new THREE.Color() }, uP: { value: new THREE.Vector4() },
      uPaint: { value: new THREE.Vector4() }, uPaintK: { value: new THREE.Vector4() }, uWear: { value: new THREE.Vector4() }, uWear2: { value: new THREE.Vector4() },
    });
    p.name = 'bake-' + key; k.programs.set(key, p); p.userData.fresh = true; BAKE_STATS.programs++;
  }
  return p;
}
function draw(renderer, k, material, target) { k.quad.material = material; renderer.setRenderTarget(target); renderer.render(k.quad, k.cam); }
function target(size, srgb, mips = true) {
  return new THREE.WebGLRenderTarget(size, size, {
    depthBuffer: false, stencilBuffer: false, generateMipmaps: mips, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
  });
}

/**
 * Bakes one resolved recipe (see resolveRecipe in material.js) into textures on this renderer.
 * Returns { albedo, orm, normal } (THREE.Texture, repeating, with mipmaps), the targets that own them and the size.
 * albedo is sRGB with opacity in alpha; orm holds ambient occlusion (r), roughness (g) and metalness (b), the layout
 * three.js reads for aoMap, roughnessMap and metalnessMap.
 */
export function bakeTextures(renderer, spec, size = 512) {
  const t0 = performance.now(), k = kit(renderer), b = BASES[spec.base];
  if (!b) throw new Error(`Unknown base "${spec.base}". Bases: ${Object.keys(BASES).join(', ')}.`);
  const p = program(k, spec.base, spec), u = p.uniforms;
  u.uSeed.value = spec.seed % 9973; u.uC1.value.set(spec.color); u.uC2.value.set(spec.color2); u.uP.value.fromArray(spec.p);
  if (spec.paint != null) { const c = new THREE.Color(spec.paint); u.uPaint.value.set(c.r, c.g, c.b, 1); } else u.uPaint.value.set(0, 0, 0, 0);
  u.uPaintK.value.set(spec.chips, spec.scratches, spec.gloss, 0);
  u.uWear.value.set(spec.wear, spec.dirt, spec.rust, spec.moss); u.uWear2.value.set(spec.leaks, spec.dust, 0, 0);
  let s = k.scratch.get(size);
  if (!s) {
    s = new THREE.WebGLRenderTarget(size, size, { count: 3, depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
    for (const tx of s.textures) { tx.wrapS = tx.wrapT = THREE.RepeatWrapping; tx.minFilter = tx.magFilter = THREE.NearestFilter; tx.generateMipmaps = false; }
    k.scratch.set(size, s);
  }
  const prev = renderer.getRenderTarget(), auto = renderer.autoClear, xr = renderer.xr.enabled, sh = renderer.shadowMap.autoUpdate;
  renderer.autoClear = true; renderer.xr.enabled = false; renderer.shadowMap.autoUpdate = false;
  try {
    const tc = performance.now(); draw(renderer, k, p, s); if (p.userData.fresh) { p.userData.fresh = false; BAKE_STATS.compileMs += performance.now() - tc; }
    const albedo = target(size, true), orm = target(size, false), normal = target(size, false);
    k.copy.uniforms.tA.value = s.textures[0]; k.copy.uniforms.uSq.value = 1; draw(renderer, k, k.copy, albedo);
    k.copy.uniforms.tA.value = s.textures[1]; k.copy.uniforms.uSq.value = 0; draw(renderer, k, k.copy, orm);
    const tile = Array.isArray(b.tile) ? b.tile : [b.tile, b.tile], depth = (spec.bump ?? b.bump) * 0.001;
    k.normal.uniforms.tH.value = s.textures[2]; k.normal.uniforms.uTexel.value = 1 / size; k.normal.uniforms.uK.value.set(depth * size / tile[0], depth * size / tile[1]);
    draw(renderer, k, k.normal, normal);
    for (const [rt, n] of [[albedo, 'albedo'], [orm, 'orm'], [normal, 'normal']]) { rt.texture.name = `mat:${spec.base}:${n}`; rt.texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy()); }
    BAKE_STATS.sets++; BAKE_STATS.ms += performance.now() - t0; BAKE_STATS.bytes += size * size * 4 * 3 * 1.34;
    return { albedo: albedo.texture, orm: orm.texture, normal: normal.texture, targets: [albedo, orm, normal], size, tile };
  } finally {
    renderer.setRenderTarget(prev); renderer.autoClear = auto; renderer.xr.enabled = xr; renderer.shadowMap.autoUpdate = sh;
  }
}

let PRIVATE = null;
/** A small WebGL2 renderer of the kit's own, for baking when the game has none (2D games) or has not made one yet. */
export function privateRenderer() {
  if (PRIVATE) return PRIVATE;
  if (typeof document === 'undefined') throw new Error('Baking textures needs a browser (WebGL2).');
  PRIVATE = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: false, alpha: true, preserveDrawingBuffer: false });
  PRIVATE.setSize(4, 4, false);
  return PRIVATE;
}

/**
 * Reads a baked set back as pixels: { albedo, normal, orm, lit } as Uint8ClampedArray RGBA rows (top row first), plus size.
 * lit is the colour already shaded by its own normal map under a light from the upper left, the look a 2D or 2.5D
 * game wants for ground and walls drawn flat.
 */
export function readTextures(renderer, set) {
  const k = kit(renderer), n = set.size, out = { size: n };
  const read = (rt) => { const px = new Uint8Array(n * n * 4); renderer.readRenderTargetPixels(rt, 0, 0, n, n, px); const flip = new Uint8ClampedArray(n * n * 4); for (let y = 0; y < n; y++) flip.set(px.subarray((n - 1 - y) * n * 4, (n - y) * n * 4), y * n * 4); return flip; };
  const lit = target(n, false, false);
  k.lit.uniforms.tA.value = set.albedo; k.lit.uniforms.tN.value = set.normal; k.lit.uniforms.tO.value = set.orm;
  const prev = renderer.getRenderTarget(); draw(renderer, k, k.lit, lit); renderer.setRenderTarget(prev);
  out.lit = read(lit); lit.dispose();
  // the albedo target is sRGB: three reads it back as stored (sRGB bytes), which is what a canvas wants
  out.albedo = read(set.targets[0]); out.orm = read(set.targets[1]); out.normal = read(set.targets[2]);
  return out;
}

// The Three.js world behind the page: a cartoon night sky that the page floats in front of. Everything is made in
// code when it starts; there are no model, texture or image files:
//
//   materials  cel shading: MeshToonMaterial with a generated 3-step ramp, extended through onBeforeCompile with a
//              rim light, plus inverted-hull outlines (the thick dark contour of cartoon art)
//   textures   DataTextures computed on the CPU from seeded noise (the planet's bands, the toy blocks' faces, the
//              ring's stripes) and CanvasTextures painted with the sprite code (coin faces)
//   meshes     built from vertices or composed from primitives: cut gems, coins, puffy clouds, a gamepad, gears
//              extruded from a generated outline, rounded toy blocks, an instanced star field
//
// Two worlds share the sky: "arcade" for the store (planet, gems, coins, clouds, a gamepad) and "workshop" for the
// creator pages (gears, toy blocks and a blueprint floor). Props pop out and in with a springy scale when the page
// switches between them, drift up as the page scrolls (deeper ones slower), and lean toward the pointer.
//
// On the full tier the world renders into a multisampled target, gets a light bloom, and the store's billboard
// and game posters are drawn on top as GPU surfaces with a glossy hover. Lite skips bloom and surfaces and runs
// at low resolution and 30 fps. Still renders one frame. Any error calls onFail, and the layer falls back to the
// Canvas 2D world.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { fxForced, fxHeld, loop, palette, rng, type FxTheme, type FxTier } from './gl';
import { paintSprite } from './sprites';
import { color } from '../tokens';

THREE.ColorManagement.enabled = false; // colours are the design tokens' sRGB values, used as they are

export type WorldStats = { fps: number; ms: number; surfaces: number; scale: number; tier: FxTier; engine: 'three'; props: number; draws: number };

const C = (hex: string) => new THREE.Color(hex);
const OUTLINE = C(color.ink);

// ---- generated textures --------------------------------------------------------------------------------------------
function noise2(seed: number) {
  const r = rng(seed), g = new Float32Array(256); for (let i = 0; i < 256; i++) g[i] = r();
  const h = (x: number, y: number) => g[(((x & 15) * 16) + (y & 15)) & 255];
  return (x: number, y: number) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}
function dataTex(w: number, h: number, px: (x: number, y: number) => [number, number, number, number], filter: THREE.MagnificationTextureFilter = THREE.LinearFilter) {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = px(x, y), i = (y * w + x) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3]; }
  const t = new THREE.DataTexture(d, w, h, THREE.RGBAFormat);
  t.magFilter = filter; t.minFilter = filter === THREE.NearestFilter ? THREE.NearestFilter : THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; return t;
}
const hexRgb = (hex: string): [number, number, number] => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
/** The cel ramp: three flat tones, so light falls in bands instead of a smooth gradient. */
const toonRamp = () => dataTex(3, 1, (x) => { const v = [90, 175, 255][x]; return [v, v, v, 255]; }, THREE.NearestFilter);
/** Gas-giant bands: warped noise quantised into a few flat colours. */
function planetTexture() {
  const n = noise2(7), cols = [color.bg3, palette.violet, color.violetHi, palette.hot, color.plate, color.bg2].map(hexRgb);
  return dataTex(256, 128, (x, y) => {
    const u = x / 256, v = y / 128;
    let w = 0, a = 1, f = 3; for (let o = 0; o < 4; o++) { w += a * n(u * f * 4, v * f); a *= 0.5; f *= 2; }
    const band = (v * 7 + w * 0.9) % 1, i = Math.floor(band * cols.length) % cols.length;
    const spot = Math.hypot((u - 0.62) * 2.2, (v - 0.58) * 1) < 0.09; // the storm
    const c = spot ? hexRgb(palette.gold) : cols[i];
    return [c[0], c[1], c[2], 255];
  });
}
/** A toy block's face: a flat colour with a lighter bevelled border and a stud in the middle. */
function blockTexture() {
  return dataTex(64, 64, (x, y) => {
    const e = Math.min(x, y, 63 - x, 63 - y), d = Math.hypot(x - 31.5, y - 31.5);
    const v = e < 3 ? 70 : e < 7 ? 255 : d < 9 ? 235 : d < 11 ? 120 : 200;
    return [v, v, v, 255];
  });
}
/** The ring: thin flat stripes with gaps. */
function ringTexture() {
  const r = rng(3), stripes: number[] = []; for (let i = 0; i < 128; i++) stripes.push(r());
  return dataTex(128, 1, (x) => { const s = stripes[x], g = x < 6 || x > 121 || (x > 70 && x < 78) ? 0 : 1; const c = hexRgb(s > 0.5 ? palette.cyan : color.violetHi); return [c[0], c[1], c[2], Math.round(g * (140 + s * 100))]; });
}
/** A coin face, painted with the same code as the overlay's coin sprite. */
function coinFace() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const x = cv.getContext('2d')!; x.fillStyle = palette.gold; x.fillRect(0, 0, 128, 128); x.translate(64, 64); paintSprite(x, 'coin', 150);
  const t = new THREE.CanvasTexture(cv); return t;
}

// ---- materials -----------------------------------------------------------------------------------------------------
/** The reading column, in drawing-buffer pixels: props fade out where they pass behind the page's text. */
export const column = { value: new THREE.Vector3(0, 1, 0.85) };
const FADE = `uniform vec3 readCol;
float colFade(){ float x = gl_FragCoord.x; return readCol.z * smoothstep(readCol.x - 30., readCol.x + 30., x) * (1. - smoothstep(readCol.y - 30., readCol.y + 30., x)); }
`;
/** How bright the props are next to the page. The world is set dressing, so it sits well below the content. */
const PROP_DIM = 0.55;
type Mats = { ramp: THREE.Texture; toon: (hex: string, o?: { map?: THREE.Texture; rim?: string; emissive?: number }) => THREE.MeshToonMaterial; outline: THREE.MeshBasicMaterial };
function materials(): Mats {
  const ramp = toonRamp();
  const cache = new Map<string, THREE.MeshToonMaterial>();
  const toon = (hex: string, o: { map?: THREE.Texture; rim?: string; emissive?: number } = {}) => {
    const key = hex + (o.map?.uuid || '') + (o.rim || '') + (o.emissive || 0);
    let m = cache.get(key); if (m) return m;
    m = new THREE.MeshToonMaterial({ color: C(hex), gradientMap: ramp, map: o.map || null, emissive: C(hex), emissiveIntensity: o.emissive || 0, transparent: true });
    const rim = C(o.rim || palette.cyan);
    // A hard-edged rim light, added to the toon shader: the bright cartoon edge that separates a prop from the sky.
    m.onBeforeCompile = (sh) => {
      sh.uniforms.rimColor = { value: rim }; sh.uniforms.readCol = column;
      sh.fragmentShader = sh.fragmentShader.replace('void main() {', FADE + 'uniform vec3 rimColor;\nvoid main() {')
        .replace('#include <opaque_fragment>', `float rimF = 1. - max(dot(normalize(vNormal), normalize(vViewPosition)), 0.);
        outgoingLight += rimColor * smoothstep(.62, .68, rimF) * .3;
        outgoingLight *= ${PROP_DIM.toFixed(2)}; // props stay in the background: dimmed toward the sky so the page reads first
        diffuseColor.a *= 1. - colFade();
        #include <opaque_fragment>`);
    };
    m.customProgramCacheKey = () => 'toon-rim';
    cache.set(key, m); return m;
  };
  const outline = new THREE.MeshBasicMaterial({ color: OUTLINE, side: THREE.BackSide, transparent: true });
  // Inverted hull: push each vertex out along its (smoothed) normal by a width that holds steady on screen.
  outline.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vec4 vp = modelViewMatrix * vec4(position, 1.);
      transformed += normalize(normal) * .045 * (-vp.z) / 14.;`);
    sh.uniforms.readCol = column;
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', FADE + 'void main() {').replace('#include <opaque_fragment>', 'diffuseColor.a *= 1. - colFade();\n#include <opaque_fragment>');
  };
  outline.customProgramCacheKey = () => 'outline';
  return { ramp, toon, outline };
}

/** A mesh with its cartoon outline. The outline uses a copy of the geometry with merged vertices, so the hull has
 *  smooth normals and does not crack along hard edges. */
function inked(geo: THREE.BufferGeometry, mat: THREE.Material, m: Mats) {
  const mesh = new THREE.Mesh(geo, mat);
  const hullGeo = mergeVertices(geo.clone().deleteAttribute('normal').deleteAttribute('uv'), 1e-3); hullGeo.computeVertexNormals();
  const hull = new THREE.Mesh(hullGeo, m.outline); hull.renderOrder = -1;
  mesh.add(hull);
  return mesh;
}

// ---- generated meshes ----------------------------------------------------------------------------------------------
/** A brilliant-cut gem built from vertices: a table, a crown ring, a girdle and a pointed pavilion. Flat-shaded. */
function gemGeometry(sides: number, seed: number) {
  const r = rng(seed), pos: number[] = [];
  const ring = (rad: number, y: number, off: number) => Array.from({ length: sides }, (_, i) => { const a = ((i + off) / sides) * Math.PI * 2; const j = 1 + (r() - 0.5) * 0.08; return new THREE.Vector3(Math.cos(a) * rad * j, y, Math.sin(a) * rad * j); });
  const table = ring(0.55, 0.55, 0), crown = ring(1, 0.18, 0.5), tip = new THREE.Vector3(0, -1.15, 0), top = new THREE.Vector3(0, 0.55, 0);
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    tri(top, table[j], table[i]);
    tri(table[i], table[j], crown[i]); tri(table[j], crown[j], crown[i]);
    tri(crown[i], crown[j], tip);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); return g;
}
/** A puffy cloud: several squashed spheres merged into one mesh. */
function cloudGeometry(seed: number) {
  const r = rng(seed), parts: THREE.BufferGeometry[] = [];
  const n = 5 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const s = 0.7 + r() * 0.6 * (1 - Math.abs(i - n / 2) / n);
    const g = new THREE.SphereGeometry(s, 18, 12); g.scale(1, 0.82, 0.8); g.translate((i - (n - 1) / 2) * 0.75, (r() - 0.3) * 0.35 + s * 0.3, (r() - 0.5) * 0.4);
    parts.push(g);
  }
  const base = new THREE.CylinderGeometry(0.5, 0.5, 1, 18); base.rotateZ(Math.PI / 2); base.scale((n * 0.75) / 1, 0.9, 0.9); base.translate(0, -0.05, 0);
  parts.push(base);
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)).map((p) => { p.deleteAttribute('uv'); return p; }))!;
}
/** A gear outline (teeth, rim and hub hole), extruded with a bevel. */
function gearGeometry(teeth: number, rad: number) {
  const s = new THREE.Shape(), inner = rad * 0.8, step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const pts: [number, number][] = [[inner, a], [rad, a + step * 0.12], [rad, a + step * 0.42], [inner, a + step * 0.54]];
    pts.forEach(([r, t], k) => { const x = Math.cos(t) * r, y = Math.sin(t) * r; if (i === 0 && k === 0) s.moveTo(x, y); else s.lineTo(x, y); });
  }
  s.closePath();
  const hole = new THREE.Path(); hole.absarc(0, 0, rad * 0.28, 0, Math.PI * 2, true); s.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(s, { depth: rad * 0.32, bevelEnabled: true, bevelThickness: rad * 0.06, bevelSize: rad * 0.05, bevelSegments: 2, curveSegments: 6 });
  g.center(); return g;
}
/** A box with rounded edges: a subdivided cube whose vertices are pulled onto a rounded box. */
function roundedBox(size: number, radius: number) {
  const g = new THREE.BoxGeometry(size, size, size, 6, 6, 6), p = g.attributes.position, v = new THREE.Vector3(), h = size / 2 - radius;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const c = new THREE.Vector3(Math.max(-h, Math.min(h, v.x)), Math.max(-h, Math.min(h, v.y)), Math.max(-h, Math.min(h, v.z)));
    v.sub(c).normalize().multiplyScalar(radius).add(c); p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals(); return g;
}
/** A gamepad from primitives: a capsule body, two grips, a d-pad and four face buttons. */
function gamepad(m: Mats) {
  const g = new THREE.Group();
  const body = new THREE.CapsuleGeometry(0.9, 2.2, 8, 20); body.rotateZ(Math.PI / 2); body.scale(1, 1, 0.55);
  g.add(inked(body, m.toon(color.plate, { rim: palette.violet }), m));
  for (const sx of [-1, 1]) { const grip = new THREE.SphereGeometry(0.75, 20, 14); grip.translate(sx * 1.45, -0.55, 0); grip.scale(1, 1, 0.55); g.add(inked(grip, m.toon(color.plate, { rim: palette.violet }), m)); }
  const dpad = mergeGeometries([new THREE.BoxGeometry(0.75, 0.24, 0.2), new THREE.BoxGeometry(0.24, 0.75, 0.2)].map((x) => x.toNonIndexed()))!; dpad.translate(-1.25, 0.12, 0.5);
  g.add(inked(dpad, m.toon(color.bg2), m));
  ([[0, 0.38, palette.accent], [0.36, 0.05, palette.hot], [-0.36, 0.05, palette.cyan], [0, -0.28, palette.gold]] as [number, number, string][]).forEach(([x, y, c]) => {
    const b = new THREE.CylinderGeometry(0.17, 0.17, 0.2, 16); b.rotateX(Math.PI / 2); b.translate(1.25 + x, 0.1 + y, 0.48);
    g.add(inked(b, m.toon(c, { emissive: 0.25 }), m));
  });
  return g;
}

// ---- props and layout ----------------------------------------------------------------------------------------------
type Prop = { obj: THREE.Object3D; rad: number; nx: number; y: number; z: number; spin: THREE.Vector3; bob: number; phase: number; scale: number; pop: number; lite: boolean };
function makeProps(theme: FxTheme, m: Mats, tex: { block: THREE.Texture; coin: THREE.Texture }): Prop[] {
  const r = rng(theme === 'arcade' ? 11 : 23), out: Prop[] = [];
  const add = (obj: THREE.Object3D, nx: number, y: number, z: number, scale: number, lite: boolean, spin = new THREE.Vector3(0, 0.3, 0), bob = 0.5) => {
    const box = new THREE.Box3().setFromObject(obj), sz = box.getSize(new THREE.Vector3()), rad = Math.max(sz.x, sz.y) / 2 || 1;
    obj.scale.setScalar(0.001); out.push({ obj, rad, nx, y, z, spin, bob, phase: r() * 6.28, scale, pop: 0, lite });
  };
  const side = (i: number) => (i % 2 ? 1 : -1) * (0.62 + r() * 0.34);
  if (theme === 'arcade') {
    const gemCols = [palette.accent, palette.cyan, palette.hot, palette.gold, palette.violet];
    for (let i = 0; i < 4; i++) {
      const c = gemCols[i % gemCols.length];
      add(inked(gemGeometry(i % 2 ? 6 : 8, i), m.toon(c, { rim: '#ffffff' }), m), side(i), 9 - i * 15, -4 - r() * 14, 0.9 + r() * 0.5, i < 2, new THREE.Vector3(0.1, 0.35, 0.05), 0.3);
    }
    const coinMats = [m.toon(palette.gold, { rim: '#fff3b0' }), m.toon(palette.gold, { map: tex.coin, rim: '#fff3b0' }), m.toon(palette.gold, { map: tex.coin, rim: '#fff3b0' })];
    for (let i = 0; i < 3; i++) {
      const geo = new THREE.CylinderGeometry(1, 1, 0.24, 32); geo.rotateX(Math.PI / 2);
      const coin = new THREE.Mesh(geo, coinMats);
      const hullGeo = mergeVertices(geo.clone().deleteAttribute('normal').deleteAttribute('uv'), 1e-3); hullGeo.computeVertexNormals(); coin.add(new THREE.Mesh(hullGeo, m.outline));
      add(coin, side(i + 1) * 0.92, 2 - i * 19, -2 - r() * 10, 0.55 + r() * 0.2, i < 1, new THREE.Vector3(0, 0.6, 0), 0.3);
    }
    for (let i = 0; i < 2; i++) add(inked(cloudGeometry(40 + i), m.toon(i % 2 ? color.tint : color.violetHi, { rim: palette.hot }), m), (i % 2 ? 1 : -1) * (0.45 + r() * 0.6), -6 - i * 9, -18 - r() * 10, 1.4 + r() * 0.9, i < 2, new THREE.Vector3(0, 0.02, 0), 0.25);
    const pad = gamepad(m); add(pad, 0.78, -2, -6, 1.1, true, new THREE.Vector3(0.05, 0.15, 0.02), 0.25);
  } else {
    const gearCols = [palette.accent, palette.cyan, color.violetHi, palette.gold];
    for (let i = 0; i < 3; i++) {
      const teeth = 8 + (i % 3) * 2, g = inked(gearGeometry(teeth, 1.4), m.toon(gearCols[i % gearCols.length], { rim: '#ffffff' }), m);
      g.rotation.x = -0.25 + r() * 0.5;
      add(g, side(i), 8 - i * 18, -4 - r() * 12, 0.8 + r() * 0.5, i < 2, new THREE.Vector3(0, 0, (i % 2 ? 1 : -1) * 0.25), 0.2);
    }
    const blockCols = [palette.hot, palette.cyan, palette.accent, palette.violet, palette.gold];
    for (let i = 0; i < 4; i++) add(inked(roundedBox(1.6, 0.28), m.toon(blockCols[i % blockCols.length], { map: tex.block, rim: '#ffffff' }), m), side(i + 1), 3 - i * 14, -3 - r() * 14, 0.7 + r() * 0.4, i < 2, new THREE.Vector3(0.15, 0.25, 0.08), 0.3);
    for (let i = 0; i < 1; i++) add(inked(cloudGeometry(60 + i), m.toon(color.violetHi, { rim: palette.cyan }), m), (i % 2 ? 1 : -1) * (0.5 + r() * 0.5), -10 - i * 14, -22, 1.6, false, new THREE.Vector3(0, 0.02, 0), 0.25);
  }
  return out;
}

// ---- sky, stars, floor, post ---------------------------------------------------------------------------------------
const SKY_VS = `varying vec2 vUv; void main(){ vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, .999, 1.); }`;
const SKY_FS = `precision highp float; varying vec2 vUv; uniform float t, work; uniform vec2 lean, res;
uniform vec3 ink, violet, hot, cyan;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  vec2 uv = vUv + lean * .02;
  // cartoon sky: a few flat bands of colour, softly stepped, from ink at the top to a warm glow at the horizon
  float y = uv.y;
  float b = floor((1. - y) * 6. + .5 * sin(uv.x * 3. + t * .05)) / 6.;
  vec3 low = mix(violet * 1.1, cyan, work); // an indigo-violet horizon for the store, a cool one for the console
  vec3 c = mix(ink, mix(violet * .45, low * .3, smoothstep(.55, 1., b)), smoothstep(.2, 1., b) * .42);
  // keep the reading area calm: darker toward the middle column
  float mid = 1. - smoothstep(.0, .55, abs(uv.x - .5));
  c *= 1. - .5 * mid * smoothstep(.1, .7, y);
  // a soft dither so the bands never show 8-bit steps
  c += (h(gl_FragCoord.xy) - .5) / 255.;
  gl_FragColor = vec4(c, 1.);
}`;
const FLOOR_FS = `precision highp float; varying vec2 vUv; uniform float t, fade; uniform vec3 lime, violet;
void main(){
  vec2 g = vUv * vec2(60., 60.); vec2 f = abs(fract(g - .5) - .5) / fwidth(g);
  float line = 1. - min(min(f.x, f.y), 1.);
  vec2 g2 = vUv * 12.; vec2 f2 = abs(fract(g2 - .5) - .5) / fwidth(g2); float major = 1. - min(min(f2.x, f2.y), 1.);
  float dist = smoothstep(.0, .6, vUv.y) * (1. - smoothstep(.75, 1., vUv.y));
  vec3 c = mix(violet, lime, major) * (line * .18 + major * .28);
  gl_FragColor = vec4(c, (line * .35 + major * .6) * dist * fade);
}`;
const STAR_VS = `attribute float phase; uniform float t; varying float vA;
void main(){ float tw = .55 + .45 * sin(t * (1.2 + fract(phase * 7.) * 2.) + phase * 6.28); vA = tw;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position * (.6 + .6 * tw), 1.); gl_Position = projectionMatrix * mv; }`;
const STAR_FS = `precision highp float; varying float vA; uniform vec3 col;\n${FADE}void main(){ gl_FragColor = vec4(col * (.6 + .6 * vA) * (1. - colFade() * .9), 1.); }`;

const POST_VS = `varying vec2 vUv; void main(){ vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, 0., 1.); }`;
const BRIGHT_FS = `precision mediump float; varying vec2 vUv; uniform sampler2D tex; uniform vec2 px;
void main(){ vec3 c = (texture2D(tex, vUv + px).rgb + texture2D(tex, vUv - px).rgb + texture2D(tex, vUv + vec2(px.x, -px.y)).rgb + texture2D(tex, vUv - vec2(px.x, -px.y)).rgb) * .25;
  float l = max(c.r, max(c.g, c.b)); gl_FragColor = vec4(c * smoothstep(.62, 1., l), 1.); }`;
const BLUR_FS = `precision mediump float; varying vec2 vUv; uniform sampler2D tex; uniform vec2 dir;
void main(){ vec3 c = texture2D(tex, vUv).rgb * .227; c += (texture2D(tex, vUv + dir * 1.385).rgb + texture2D(tex, vUv - dir * 1.385).rgb) * .316;
  c += (texture2D(tex, vUv + dir * 3.231).rgb + texture2D(tex, vUv - dir * 3.231).rgb) * .07; gl_FragColor = vec4(c, 1.); }`;
const COMP_FS = `precision highp float; varying vec2 vUv; uniform sampler2D scene, bloom; uniform float k, t;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){ vec3 c = texture2D(scene, vUv).rgb + texture2D(bloom, vUv).rgb * k; vec2 d = vUv - .5; c *= 1. - dot(d, d) * .45;
  c += (h(gl_FragCoord.xy + fract(t) * 91.) - .5) * .012; gl_FragColor = vec4(c, 1.); }`;

// GPU surfaces: the billboard and game posters, drawn where their DOM boxes are, cover-fitted, with rounded corners,
// a slow drift, a hover ripple and a glossy highlight that sweeps across like light on a new cartridge.
const SURF_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;
const SURF_FS = `precision highp float; varying vec2 vUv; uniform sampler2D tex; uniform vec2 size, img, mouse; uniform float t, hover, radius, seed, dpr; uniform vec3 accent;
void main(){
  float ca = size.x / size.y, ia = img.x / img.y; vec2 st = vUv;
  if (ca > ia) st.y = (st.y - .5) * ia / ca + .5; else st.x = (st.x - .5) * ca / ia + .5;
  float zoom = 1.05 + .02 * sin(t * .15 + seed) + .03 * hover; vec2 pm = mouse;
  vec2 par = (clamp(pm, 0., 1.) - .5) * .025; st = (st - .5) / zoom + .5 - par;
  vec2 v = vec2(vUv.x, 1. - vUv.y); vec2 d = (v - pm) * vec2(ca, 1.); float dist = length(d);
  st += normalize(d + 1e-5) * sin(dist * 30. - t * 6.) * exp(-dist * 5.) * .008 * hover / vec2(ca, 1.);
  vec3 c = texture2D(tex, st).rgb;
  c *= 1. + .18 * hover;
  // the gloss: a soft diagonal band that crosses every few seconds, brighter on hover
  float sweep = fract(t * .18 + seed * .1) * 3. - 1.;
  float band = smoothstep(.16, 0., abs(v.x + v.y * .5 - sweep));
  c += vec3(1.) * band * (.07 + .12 * hover);
  vec2 px = v * size; vec2 q = abs(px - size * .5) - (size * .5 - radius);
  float sd = length(max(q, 0.)) + min(max(q.x, q.y), 0.) - radius; float a = clamp(.5 - sd * dpr, 0., 1.);
  gl_FragColor = vec4(c * a, a);
}`;

type Surface = { el: HTMLElement; host: HTMLElement | null; src: string; mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>; hover: number; seed: number };

export class World {
  stats: WorldStats;
  private r: THREE.WebGLRenderer; private scene = new THREE.Scene(); private cam: THREE.PerspectiveCamera;
  private sky: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>; private floor: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private stars: THREE.InstancedMesh<THREE.ShapeGeometry, THREE.ShaderMaterial>; private planet: THREE.Group;
  private mats: Mats; private tex: { block: THREE.Texture; coin: THREE.Texture };
  private worlds = new Map<FxTheme, Prop[]>(); private props: Prop[] = []; private leaving: Prop[] = [];
  private theme: FxTheme; private work = 0;
  private mouse = { x: -1e4, y: -1e4, nx: 0, ny: 0, sx: 0, sy: 0 };
  private stopLoop = () => {}; private t0 = performance.now(); private last = performance.now(); private held = fxHeld();
  private rt?: THREE.WebGLRenderTarget; private b1?: THREE.WebGLRenderTarget; private b2?: THREE.WebGLRenderTarget;
  private post?: { scene: THREE.Scene; cam: THREE.Camera; quad: THREE.Mesh; bright: THREE.ShaderMaterial; blur: THREE.ShaderMaterial; comp: THREE.ShaderMaterial };
  private ortho = new THREE.OrthographicCamera(0, 1, 0, -1, -10, 10); private surfScene = new THREE.Scene();
  private surfaces: Surface[] = []; private textures = new Map<string, THREE.Texture | 'loading' | 'failed'>(); private dirty = true; private observer?: MutationObserver;
  private pr = 1; private downgrades = 0; private win = 0; private count = 0; private cpu = 0; private lastFrame = 0; private failed = false;
  private scrollY = 0; private layout = { half: 580, margin: 0 };

  constructor(private canvas: HTMLCanvasElement, private tier: FxTier, theme: FxTheme, private onFail: (why: string) => void) {
    const full = tier === 'full';
    this.r = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: true, stencil: false, powerPreference: full ? 'high-performance' : 'low-power', failIfMajorPerformanceCaveat: !fxForced() });
    this.r.outputColorSpace = THREE.LinearSRGBColorSpace; this.r.info.autoReset = false;
    this.r.debug.onShaderError = () => this.fail('shader');
    this.pr = this.basePr();
    this.r.setPixelRatio(this.pr);
    this.cam = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.5, 200); this.cam.position.set(0, 0, 40);
    this.theme = theme; this.work = theme === 'workshop' ? 1 : 0;
    this.stats = { fps: 0, ms: 0, surfaces: 0, scale: this.pr, tier, engine: 'three', props: 0, draws: 0 };

    this.mats = materials();
    this.tex = { block: blockTexture(), coin: coinFace() };

    // light: one key light from the upper left, plus a cool fill so the shadow band is violet rather than black
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(-6, 8, 10); this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0xcfc6ff, 0x3a2160, 1.1));

    const tri = new THREE.BufferGeometry(); tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.sky = new THREE.Mesh(tri, new THREE.ShaderMaterial({
      vertexShader: SKY_VS, fragmentShader: SKY_FS, depthWrite: false, depthTest: false,
      uniforms: { t: { value: 0 }, work: { value: this.work }, lean: { value: new THREE.Vector2() }, res: { value: new THREE.Vector2() }, ink: { value: C(palette.ink) }, violet: { value: C(palette.horizon) }, hot: { value: C(palette.hot) }, cyan: { value: C(palette.cyan) } },
    }));
    this.sky.frustumCulled = false; this.sky.renderOrder = -10; this.scene.add(this.sky);

    // stars: a generated 4-point star shape, instanced, twinkling in the vertex shader
    const sh = new THREE.Shape(); for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2, rr = i % 2 ? 0.09 : 0.32; i ? sh.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : sh.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); }
    const n = full ? 140 : 60, sr = rng(5), phase = new Float32Array(n);
    this.stars = new THREE.InstancedMesh(new THREE.ShapeGeometry(sh), new THREE.ShaderMaterial({ vertexShader: STAR_VS, fragmentShader: STAR_FS, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, uniforms: { t: { value: 0 }, col: { value: C(color.tint) }, readCol: column } }), n);
    const mtx = new THREE.Matrix4();
    for (let i = 0; i < n; i++) { phase[i] = sr(); const s = 0.4 + sr() * 1.1; mtx.makeScale(s, s, 1).setPosition((sr() - 0.5) * 120, (sr() - 0.2) * 60, -60); this.stars.setMatrixAt(i, mtx); }
    this.stars.geometry.setAttribute('phase', new THREE.InstancedBufferAttribute(phase, 1));
    this.stars.frustumCulled = false; this.scene.add(this.stars);

    // the planet: a sphere with the generated band texture, cel-shaded, outlined, with a striped ring
    this.planet = new THREE.Group();
    const pTex = planetTexture();
    this.planet.add(inked(new THREE.SphereGeometry(7, 48, 32), this.mats.toon('#ffffff', { map: pTex, rim: palette.cyan }), this.mats));
    const ringGeo = new THREE.RingGeometry(9, 13.5, 96, 1), uv = ringGeo.attributes.uv, p = ringGeo.attributes.position;
    for (let i = 0; i < p.count; i++) { const d = Math.hypot(p.getX(i), p.getY(i)); uv.setXY(i, (d - 9) / 4.5, 0.5); }
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ map: ringTexture(), transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -1.2; ring.rotation.y = 0.35; this.planet.add(ring);
    this.planet.rotation.z = 0.28; this.planet.position.set(0, 0, -70); this.scene.add(this.planet);

    // the workshop floor: a blueprint grid running to the horizon
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.ShaderMaterial({
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: FLOOR_FS, transparent: true, depthWrite: false,
      uniforms: { t: { value: 0 }, fade: { value: this.work }, lime: { value: C(palette.accent) }, violet: { value: C(palette.violet) } },
    }));
    this.floor.rotation.x = -Math.PI / 2; this.floor.position.set(0, -16, -120); this.scene.add(this.floor);

    this.useTheme(theme, true);
    this.resize();
    if (full) this.setupPost();

    // compile everything now, so a shader a driver cannot handle fails here and not in the middle of a frame
    this.r.compile(this.scene, this.cam);
    for (const t of ['arcade', 'workshop'] as FxTheme[]) this.ensureWorld(t);

    canvas.addEventListener('webglcontextlost', this.lost);
    addEventListener('resize', this.resize);
    addEventListener('scroll', this.scroll, { passive: true });
    if (tier !== 'still') addEventListener('pointermove', this.move, { passive: true });
    addEventListener('fx:hold', this.hold);
    if (full) {
      this.observer = new MutationObserver(() => { this.dirty = true; });
      this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-gl', 'data-gl-src', 'src'] });
    }
  }

  private basePr() { return this.tier === 'full' || this.tier === 'still' ? Math.min(devicePixelRatio || 1, 1.5) : Math.min(devicePixelRatio || 1, 2) * 0.5; }

  start() {
    if (this.held || this.failed) return;
    if (this.tier === 'still') { for (const p of this.props) p.pop = 1; this.frame(performance.now()); return; }
    this.stopLoop = loop((now) => this.frame(now), this.tier === 'lite' ? 30 : 60);
  }
  /** The page moved between the store and the creator pages. */
  setTheme(theme: FxTheme) { if (theme !== this.theme) { this.useTheme(theme); if (this.tier === 'still') this.start(); } }
  pageChange() { this.dirty = true; requestAnimationFrame(() => this.measure()); }

  dispose() {
    this.stopLoop(); this.observer?.disconnect();
    removeEventListener('resize', this.resize); removeEventListener('scroll', this.scroll); removeEventListener('pointermove', this.move); removeEventListener('fx:hold', this.hold);
    this.canvas.removeEventListener('webglcontextlost', this.lost);
    this.release();
    this.scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); const mat = m.material as THREE.Material | THREE.Material[] | undefined; (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose()); });
    for (const t of this.textures.values()) if (typeof t === 'object') t.dispose();
    this.rt?.dispose(); this.b1?.dispose(); this.b2?.dispose();
    this.r.dispose(); this.r.forceContextLoss();
  }

  private fail(why: string) {
    if (this.failed) return; this.failed = true;
    this.stopLoop(); this.release(); this.onFail(why);
  }
  private lost = (e: Event) => { e.preventDefault(); this.fail('context lost'); };
  private hold = (e: Event) => {
    const h = !!(e as CustomEvent).detail; if (h === this.held) return; this.held = h;
    if (h) { this.stopLoop(); this.stopLoop = () => {}; } else this.start();
  };
  private move = (e: PointerEvent) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.nx = e.clientX / innerWidth - 0.5; this.mouse.ny = 0.5 - e.clientY / innerHeight; };
  private scroll = () => { this.scrollY = scrollY; };

  private resize = () => {
    const w = innerWidth, h = innerHeight;
    this.r.setPixelRatio(this.pr); this.r.setSize(w, h, false);
    this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
    this.ortho.right = w; this.ortho.bottom = -h; this.ortho.updateProjectionMatrix();
    this.measure();
    if (this.post) {
      const W = Math.round(w * this.pr), H = Math.round(h * this.pr);
      this.rt?.setSize(W, H); this.b1?.setSize(Math.max(1, W >> 2), Math.max(1, H >> 2)); this.b2?.setSize(Math.max(1, W >> 2), Math.max(1, H >> 2));
    }
    this.stats.scale = this.pr;
    if (this.tier === 'still') this.frame(performance.now());
  };

  /** Where the page's content column is, so the world can keep its props beside it rather than behind the text. */
  private measure() {
    const w = innerWidth, h = innerHeight, el = document.querySelector('main .wrap') || document.querySelector('.wrap');
    const rect = el?.getBoundingClientRect(), half = rect && rect.width > 200 ? rect.width / 2 : Math.min(w, 1240) / 2;
    this.layout = { half, margin: Math.max(0, w / 2 - half) };
    const bw = this.r.domElement.width / w; // drawing-buffer pixels per CSS pixel
    column.value.set((w / 2 - half + 12) * bw, (w / 2 + half - 12) * bw, w < 700 ? 0.75 : 0.88);
    // the planet hangs in the top-right margin, or peeks in from the corner on narrow screens
    const depth = 110 + this.work * 40, halfH = Math.tan((this.cam.fov * Math.PI) / 360) * depth, ppu = h / (2 * halfH);
    const roomy = this.layout.margin > 160, rpx = roomy ? Math.min(130, this.layout.margin * 0.45) : Math.min(56, Math.max(36, this.layout.margin * 0.5));
    const cx = roomy ? w / 2 - this.layout.margin / 2 : w / 2 + rpx * 0.25, cy = roomy ? h * 0.5 - Math.max(h * 0.24, rpx * 1.1) : h * 0.5 - rpx * 0.9;
    this.planet.position.x = cx / ppu; this.planet.position.y = cy / ppu; this.planet.scale.setScalar(rpx / ppu / 7);
  }

  private setupPost() {
    const W = Math.round(innerWidth * this.pr), H = Math.round(innerHeight * this.pr);
    this.rt = new THREE.WebGLRenderTarget(W, H, { samples: 4, type: THREE.UnsignedByteType, depthBuffer: true });
    this.b1 = new THREE.WebGLRenderTarget(Math.max(1, W >> 2), Math.max(1, H >> 2), { type: THREE.UnsignedByteType, depthBuffer: false });
    this.b2 = this.b1.clone();
    const tri = new THREE.BufferGeometry(); tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const mk = (fs: string, u: Record<string, THREE.IUniform>) => new THREE.ShaderMaterial({ vertexShader: POST_VS, fragmentShader: fs, uniforms: u, depthTest: false, depthWrite: false });
    const bright = mk(BRIGHT_FS, { tex: { value: null }, px: { value: new THREE.Vector2() } });
    const blur = mk(BLUR_FS, { tex: { value: null }, dir: { value: new THREE.Vector2() } });
    const comp = mk(COMP_FS, { scene: { value: null }, bloom: { value: null }, k: { value: 0.35 }, t: { value: 0 } });
    const quad = new THREE.Mesh(tri, bright); quad.frustumCulled = false;
    const scene = new THREE.Scene(); scene.add(quad);
    this.post = { scene, cam: new THREE.Camera(), quad, bright, blur, comp };
  }

  private ensureWorld(t: FxTheme) {
    let w = this.worlds.get(t);
    if (!w) {
      w = makeProps(t, this.mats, this.tex).filter((p) => this.tier === 'full' || this.tier === 'still' || p.lite);
      this.worlds.set(t, w);
      for (const p of w) { p.obj.visible = false; this.scene.add(p.obj); }
      this.r.compile(this.scene, this.cam);
    }
    return w;
  }
  private useTheme(t: FxTheme, first = false) {
    const next = this.ensureWorld(t);
    if (!first) this.leaving = this.props.filter((p) => !next.includes(p));
    this.props = next; this.theme = t;
    for (const p of next) { p.obj.visible = true; if (first) p.pop = 0; else p.pop = Math.min(p.pop, 0); }
    this.stats.props = next.length;
  }

  // ---- surfaces ----
  private release() { for (const s of this.surfaces) this.show(s); this.surfaces = []; delete document.documentElement.dataset.fxLive; }
  private show(s: Surface) { s.el.classList.remove('gl-on'); s.host?.classList.remove('gl-host'); s.mesh.visible = false; }
  private scan() {
    this.dirty = false;
    if (this.tier !== 'full') return;
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-gl]')), keep = new Set(els);
    for (const s of this.surfaces) if (!keep.has(s.el)) { this.show(s); this.surfScene.remove(s.mesh); s.mesh.material.dispose(); }
    const prev = new Map(this.surfaces.map((s) => [s.el, s]));
    this.surfaces = [];
    for (const el of els) {
      const src = el.dataset.glSrc || el.querySelector('img')?.currentSrc || el.querySelector('img')?.src || '';
      if (!src) { el.classList.remove('gl-on'); continue; }
      const old = prev.get(el);
      if (old && old.src === src) { this.surfaces.push(old); continue; }
      if (old) { this.surfScene.remove(old.mesh); old.mesh.material.dispose(); }
      let seed = 0; for (let i = 0; i < src.length; i++) seed = (seed * 31 + src.charCodeAt(i)) % 1000;
      const mat = new THREE.ShaderMaterial({ vertexShader: SURF_VS, fragmentShader: SURF_FS, transparent: true, depthTest: false, depthWrite: false, premultipliedAlpha: true, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        uniforms: { tex: { value: null }, size: { value: new THREE.Vector2(1, 1) }, img: { value: new THREE.Vector2(1, 1) }, mouse: { value: new THREE.Vector2(-9, -9) }, t: { value: 0 }, hover: { value: 0 }, radius: { value: 0 }, seed: { value: seed }, dpr: { value: this.pr }, accent: { value: C(palette.accent) } } });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat); mesh.visible = false; mesh.frustumCulled = false; this.surfScene.add(mesh);
      this.surfaces.push({ el, host: el.closest<HTMLElement>('[data-gl-host]'), src, mesh, hover: 0, seed });
      this.load(src);
    }
    if (this.textures.size > 24) { const live = new Set(this.surfaces.map((s) => s.src)); for (const [k, v] of this.textures) if (!live.has(k) && typeof v === 'object') { v.dispose(); this.textures.delete(k); } }
    this.stats.surfaces = this.surfaces.length;
  }
  private load(src: string) {
    if (this.textures.has(src)) return;
    this.textures.set(src, 'loading');
    const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
    img.onload = () => {
      // a picture from another origin without CORS would make WebGL throw on upload: check on a tiny 2D canvas first
      try { const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d')!; x.drawImage(img, 0, 0, 1, 1); x.getImageData(0, 0, 1, 1); }
      catch { this.textures.set(src, 'failed'); return; }
      const t = new THREE.Texture(img); t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
      this.textures.set(src, t);
    };
    img.onerror = () => this.textures.set(src, 'failed');
    img.src = src;
  }
  private drawSurfaces(t: number) {
    let any = false;
    for (const s of this.surfaces) {
      const tx = this.textures.get(s.src), m = s.mesh;
      if (!tx || tx === 'loading') { m.visible = false; continue; }
      if (tx === 'failed') { this.show(s); continue; }
      const r = s.el.getBoundingClientRect();
      if (r.width < 2 || r.bottom < 0 || r.top > innerHeight) { m.visible = false; continue; }
      const hovered = (s.el.closest('a') ?? s.el).matches(':hover');
      s.hover += ((hovered ? 1 : 0) - s.hover) * 0.12;
      const u = m.material.uniforms, img = tx.image as HTMLImageElement;
      u.tex.value = tx; u.size.value.set(r.width, r.height); u.img.value.set(img.naturalWidth || 1, img.naturalHeight || 1);
      u.mouse.value.set((this.mouse.x - r.left) / r.width, (this.mouse.y - r.top) / r.height); u.t.value = t; u.hover.value = s.hover; u.dpr.value = this.pr;
      const cs = getComputedStyle(s.host || s.el); u.radius.value = Math.max(0, (parseFloat(cs.borderTopLeftRadius) || 0) - (s.host ? parseFloat(cs.borderLeftWidth) || 0 : 0)); // the picture sits inside the host's frame
      m.position.set(r.left + r.width / 2, -(r.top + r.height / 2), 0); m.scale.set(r.width, r.height, 1); m.visible = true; any = true;
      if (!s.el.classList.contains('gl-on')) requestAnimationFrame(() => { if (m.visible) { s.el.classList.add('gl-on'); s.host?.classList.add('gl-host'); } }); // hide the DOM picture only once the GPU has drawn it
    }
    return any;
  }

  // ---- the frame ----
  private frame(now: number) {
    if (this.failed) return;
    const start = performance.now();
    try { this.render(now); } catch (e) { console.warn('[fx] render failed:', (e as Error).message); this.fail('render'); return; }
    document.documentElement.dataset.fxLive = '1';
    this.budget(now, start);
  }

  private render(now: number) {
    if (this.dirty) this.scan();
    const still = this.tier === 'still', t = still ? 40 : (now - this.t0) / 1000, dt = still ? 1 : Math.min(0.05, (now - this.last) / 1000); this.last = now;
    const m = this.mouse; m.sx += (m.nx - m.sx) * 0.05; m.sy += (m.ny - m.sy) * 0.05;
    this.work += ((this.theme === 'workshop' ? 1 : 0) - this.work) * (still ? 1 : 0.06);

    const su = this.sky.material.uniforms; su.t.value = t; su.work.value = this.work; su.lean.value.set(m.sx, m.sy);
    this.stars.material.uniforms.t.value = t;
    this.floor.material.uniforms.fade.value = this.work; this.floor.visible = this.work > 0.01;
    this.planet.rotation.y = t * 0.03; this.planet.position.z = -70 - this.work * 40;
    this.cam.position.x = m.sx * 2.4; this.cam.position.y = m.sy * 1.6; this.cam.lookAt(0, 0, -20);

    // props: pop in with an elastic overshoot, bob and spin, drift up with the scroll (deeper ones slower)
    const vh = 2 * Math.tan((this.cam.fov * Math.PI) / 360);
    const place = (p: Prop, s: number) => {
      const depth = 40 - p.z, halfH = (vh * depth) / 2, halfW = halfH * this.cam.aspect, period = halfH * 2 * 1.6;
      const sy = this.scrollY * (halfH * 2 / innerHeight) * 0.55;
      let y = p.y + sy + Math.sin(t * 0.5 + p.phase) * p.bob; y = ((y + period / 2) % period + period) % period - period / 2;
      // keep props in the margins beside the content column; on narrow screens they peek in from the edges
      const ppu = innerWidth / (2 * halfW), side = Math.sign(p.nx) || 1, jit = Math.min(1, Math.max(0, (Math.abs(p.nx) - 0.6) / 0.38));
      const { half, margin } = this.layout, wide = margin >= 90;
      const sx = wide ? half + margin * (0.28 + 0.44 * jit) : innerWidth / 2 - 8 + jit * 24;
      const px = Math.min(92, Math.max(34, margin * 0.42)) * (p.scale / 1.2);
      p.obj.position.set((side * sx) / ppu, y, p.z);
      p.obj.rotation.x += p.spin.x * dt * 0.5; p.obj.rotation.y += p.spin.y * dt; p.obj.rotation.z += p.spin.z * dt * 0.5;
      p.obj.scale.setScalar(Math.max(0.001, (px / ppu / (2 * p.rad)) * s));
    };
    for (const p of this.props) { p.pop = Math.min(1, p.pop + dt * 1.6); place(p, elastic(p.pop)); }
    this.leaving = this.leaving.filter((p) => { p.pop -= dt * 3.2; if (p.pop <= 0) { p.obj.visible = false; return false; } place(p, backIn(p.pop)); return true; });

    const r = this.r; r.info.reset();
    if (this.post && this.rt && this.b1 && this.b2) {
      r.setRenderTarget(this.rt); r.render(this.scene, this.cam);
      r.autoClear = false; if (this.surfaces.length && this.drawSurfaces(t)) r.render(this.surfScene, this.ortho); r.autoClear = true;
      const P = this.post;
      P.quad.material = P.bright; P.bright.uniforms.tex.value = this.rt.texture; P.bright.uniforms.px.value.set(0.5 / this.b1.width, 0.5 / this.b1.height);
      r.setRenderTarget(this.b1); r.render(P.scene, P.cam);
      P.quad.material = P.blur;
      for (const [from, to, dx, dy] of [[this.b1, this.b2, 1, 0], [this.b2, this.b1, 0, 1], [this.b1, this.b2, 2, 0], [this.b2, this.b1, 0, 2]] as const) {
        P.blur.uniforms.tex.value = from.texture; P.blur.uniforms.dir.value.set(dx / from.width, dy / from.height); r.setRenderTarget(to); r.render(P.scene, P.cam);
      }
      P.quad.material = P.comp; P.comp.uniforms.scene.value = this.rt.texture; P.comp.uniforms.bloom.value = this.b1.texture; P.comp.uniforms.t.value = t;
      r.setRenderTarget(null); r.render(P.scene, P.cam);
    } else {
      r.setRenderTarget(null); r.render(this.scene, this.cam);
    }
    this.stats.draws = r.info.render.calls;
  }

  // Frame budget over 2-second windows. If the device cannot keep up: lower the resolution once, then drop bloom and
  // the GPU surfaces (lite), then stop animating and keep the last frame.
  private budget(now: number, start: number) {
    if (this.tier === 'still') return;
    this.cpu += performance.now() - start; this.count++;
    if (now - this.lastFrame > 500) { this.win = 0; this.count = 0; this.cpu = 0; }
    this.lastFrame = now;
    if (!this.win) { this.win = now; return; }
    if (now - this.win < 2000) return;
    const span = (now - this.win) / this.count;
    this.stats.fps = Math.round(1000 / span); this.stats.ms = Math.round((this.cpu / this.count) * 100) / 100;
    this.win = now; this.count = 0; this.cpu = 0;
    if (span > (this.tier === 'full' ? 16.7 : 33.4) * 1.6 && !fxForced()) this.downgrade();
  }
  private downgrade() {
    this.downgrades++;
    if (this.downgrades === 1) { this.pr = Math.max(0.5, this.pr * 0.66); this.resize(); }
    else if (this.downgrades === 2 && this.post) { this.tier = 'lite'; this.release(); this.post = undefined; this.rt?.dispose(); this.b1?.dispose(); this.b2?.dispose(); this.rt = this.b1 = this.b2 = undefined; this.stats.tier = 'lite'; this.stopLoop(); this.stopLoop = loop((n) => this.frame(n), 30); }
    else { this.stopLoop(); this.stopLoop = () => {}; this.stats.tier = 'still'; }
  }
}

const elastic = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : Math.pow(2, -10 * k) * Math.sin(((k * 10 - 0.75) * (2 * Math.PI)) / 3) + 1);
const backIn = (k: number) => { const c = 1.70158; return Math.max(0, k * k * ((c + 1) * k - c)); };

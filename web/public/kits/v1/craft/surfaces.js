// @gcp/craft.js · surfaces — ready materials from the procedural texture painter (procgen/texture.js): nothing
// to download, identical on every device, tintable to any palette. An untextured flat colour is the single most
// visible difference between a quick prototype and a finished game; surface(kind) removes it in one call.
import * as THREE from 'three';
import { paint, TEXTURES, textureGlow } from '../procgen/texture.js';
import { tbox, tplane, tcylinder } from '../procgen/mesh.js';
import { defineRecipe } from '../procgen/recipe.js';
import { currentStage } from './stage.js';

/** Every surface kind surface() accepts. */
export const SURFACES = TEXTURES;

const TEX = new Map(), MAT = new Map();
function dataTexture(bytes, size, srgb) {
  const t = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  const st = currentStage(), soft = !!(st && st.software);   // filtering is the main per-pixel cost on a CPU renderer
  t.magFilter = THREE.LinearFilter; t.minFilter = soft ? THREE.LinearMipmapNearestFilter : THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = soft ? 1 : 4; t.needsUpdate = true;
  return t;
}
const texKey = (kind, o) => `${kind}|${o.color ?? ''}|${o.color2 ?? ''}|${o.seed ?? 1}|${o.size ?? 128}|${o.scale ?? 1}|${o.contrast ?? 1}`;
/**
 * The painted texture alone (a THREE.Texture that repeats), for your own materials. Options as paint():
 * color, color2, seed, scale, contrast, size. Cached.
 */
export function surfaceTexture(kind, opts = {}) {
  const key = texKey(kind, opts); let t = TEX.get(key);
  if (!t) { const r = paint(kind, opts); t = dataTexture(r.toRGBA(), r.w, true); t.userData.raster = r; TEX.set(key, t); }
  return t;
}
/** The matching normal map (made from the texture's height channel). strength 1..4. */
export function surfaceNormal(kind, opts = {}, strength = 2) {
  const key = 'n|' + strength + '|' + texKey(kind, opts); let t = TEX.get(key);
  if (!t) { const r = paint(kind, opts); t = dataTexture(r.normalRGBA(strength), r.w, false); TEX.set(key, t); }
  return t;
}

/**
 * A ready material with a painted texture. kind: any of SURFACES — grass, meadow, moss, dirt, mud, sand, snow, rock,
 * cliff, gravel, bark, birch, leaves, wood, planks, logs, thatch, shingle, rooftile, brick, stonewall, cobble,
 * pavers, plaster, concrete, asphalt, metal, corrugated, rust, tiles, checker, marble, fabric, stripes, ice, lava,
 * water, crystal, scifi.
 * Options: color (repaints the surface in any base colour), color2 (mortar, grout, veins, the second stripe),
 * repeat (how many times the texture tiles across the UVs; number or [x, y]), seed (a different pattern),
 * scale (1..4, a finer pattern), relief (0..4: adds a normal map so the surface catches light; switches to a
 * 'standard' material), lit ('lambert' default, 'standard', 'phong', 'basic' for unlit), roughness, metalness,
 * emissive (lava and crystal glow by default), side, size, transparent, opacity.
 */
export function surface(kind, opts = {}) {
  const { repeat = 1, relief = 0, roughness = 0.9, metalness = kind === 'metal' || kind === 'corrugated' ? 0.5 : 0, side = THREE.FrontSide, transparent = false, opacity = 1 } = opts;
  const lit = opts.lit || (relief ? 'standard' : 'lambert'), rep = Array.isArray(repeat) ? repeat : [repeat, repeat];
  const key = `${texKey(kind, opts)}|${rep}|${lit}|${relief}|${roughness}|${metalness}|${side}|${opts.emissive ?? ''}|${opacity}`;
  let m = MAT.get(key);
  if (!m) {
    const fit = (t) => { if (rep[0] === 1 && rep[1] === 1) return t; const c = t.clone(); c.repeat.set(rep[0], rep[1]); c.needsUpdate = true; return c; };
    const map = fit(surfaceTexture(kind, opts)), p = { map, side, transparent, opacity };
    const glow = opts.emissive ?? textureGlow(kind);
    if (glow != null && lit !== 'basic') { p.emissive = new THREE.Color(glow); p.emissiveMap = map; p.emissiveIntensity = opts.emissiveIntensity ?? 1.2; }
    if (relief && (lit === 'standard' || lit === 'phong')) p.normalMap = fit(surfaceNormal(kind, opts, relief));
    m = lit === 'standard' ? new THREE.MeshStandardMaterial({ ...p, roughness, metalness }) : lit === 'phong' ? new THREE.MeshPhongMaterial({ ...p, shininess: (1 - roughness) * 80 }) : lit === 'basic' ? new THREE.MeshBasicMaterial(p) : new THREE.MeshLambertMaterial(p);
    m.userData.shared = true; m.name = 'surface:' + kind; MAT.set(key, m);
  }
  return m;
}

/** Older names for tbox, tplane, tcylinder (in @gcp/procgen.js): primitives whose texture keeps one real-world size. */
export const tiledBox = tbox, tiledPlane = tplane, tiledCylinder = tcylinder;

/** A textured block in one call: block(4, 3, 0.3, 'brick') is a wall. Returns a Mesh with shadows on, centred on its origin. */
export function block(w, h, d, kind = 'stonewall', opts = {}) {
  const m = new THREE.Mesh(tbox(w, h, d, opts.tile ?? 2), surface(kind, opts)); m.castShadow = m.receiveShadow = true; return m;
}
/** A textured floor in one call: floor(40, 40, 'cobble'). Lies at y = 0. */
export function floor(w, d, kind = 'cobble', opts = {}) {
  const m = new THREE.Mesh(tplane(w, d, opts.tile ?? 3), surface(kind, opts)); m.receiveShadow = true; return m;
}

defineRecipe('surface', { summary: 'A ready material with a painted texture.', params: { surface: 'one of SURFACES', color: 'base colour', color2: 'second colour', seed: 'pattern', repeat: 'tiles across the UVs', scale: '1..4', relief: '0..4 normal map strength', lit: 'lambert | standard | phong | basic' }, make: (p) => surface(p.surface, p) });

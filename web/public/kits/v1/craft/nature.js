// @gcp/craft.js · nature — land, water and everything that grows on it, generated from a seed.
// Every generator returns a "kind": { parts: [{ geometry, material }], radius, height }. A kind is cheap to
// place once (place) or by the hundred (scatter, which instances it). Shapes are built from many small parts
// with slight colour variation and a painted detail texture, so nothing reads as a bare primitive.
import * as THREE from 'three';
import { clamp, lerp, smoothstep, TAU } from '../core.js';
import { mulberry32, Simplex, toSeed } from '../procgen/noise.js';
import { M4, lumpy, mergeParts, joinGeometries } from '../procgen/mesh.js';
import { defineRecipe, build } from '../procgen/recipe.js';
import { surface, surfaceTexture, tiledCylinder } from './surfaces.js';
import { currentStage, windSway } from './stage.js';

/** Older name for mergeParts in @gcp/procgen.js. */
export const mergeColoured = mergeParts;
const sd = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : toSeed(v ?? 1) % 99991);
const leanM = (x, y, z, tilt, yaw) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, yaw, 0, 'YXZ')), new THREE.Vector3(1, 1, 1));

const MATS = new Map();
/** A vertex-coloured material multiplied by a pale detail texture: 'foliage' (leaf marks), 'stone' (mottle and cracks) or 'plain'. */
function tinted(detail, { sway = 0, swayBase = 0, stage, flat = true, emissive = 0 } = {}) {
  const st = stage || currentStage(), key = `${detail}|${sway}|${swayBase}|${flat}|${emissive}|${st ? st.renderer.id || 1 : 0}`;
  let m = MATS.get(key);
  if (!m) {
    const map = detail === 'foliage' ? surfaceTexture('leaves', { color: 0xf1f5ec, contrast: 0.4 }) : detail === 'stone' ? surfaceTexture('rock', { color: 0xdedbd6 }) : detail === 'bark' ? surfaceTexture('bark', { color: 0xd8d0c6 }) : null;
    m = new THREE.MeshLambertMaterial({ vertexColors: true, map, flatShading: flat });
    if (emissive) { m.emissive = new THREE.Color(emissive); m.emissiveIntensity = 0.9; }
    if (sway && st) windSway(m, st, { amount: sway, base: swayBase });
    m.userData.shared = true; MATS.set(key, m);
  }
  return m;
}
const shades = (base, n, r, spread = 0.07) => { const c = new THREE.Color(base), h = {}; c.getHSL(h); return Array.from({ length: n }, () => new THREE.Color().setHSL((h.h + (r() - 0.5) * 0.03 + 1) % 1, clamp(h.s + (r() - 0.5) * 0.1), clamp(h.l + (r() - 0.5) * spread * 2)).getHex()); };
const pick = (v, r) => (Array.isArray(v) ? v[(r() * v.length) | 0] : v);

const LEAF = { oak: 0x58ab3c, birch: 0xa6d24c, pine: 0x2f7a46, palm: 0x45a848, cypress: 0x2f7450, willow: 0x82b64c, blossom: 0xf2a6c4, maple: 0xd9682a, mushroom: 0xc83a2a, dead: 0x7a6a58, cactus: 0x4f9a48 };
/** Every species tree() accepts. */
export const TREES = Object.keys(LEAF);

/**
 * A tree. species: oak, birch, pine, palm, cypress, willow, blossom, maple, mushroom (a giant one), dead, cactus.
 * Options: seed (each seed is a different individual: make 2 or 3 per species), size (1 = about 5 m),
 * leaf (colour or list of colours), trunk (colour), snow (true caps pines and oaks with snow), stage.
 */
export function tree(opts = {}) {
  const { species = 'oak', size = 1, snow = false } = opts, seed = sd(opts.seed), r = mulberry32(seed * 9973 + species.length * 131), st = opts.stage || currentStage();
  const leaf = shades(pick(opts.leaf, r) ?? LEAF[species] ?? LEAF.oak, 4, r), crown = [], extra = [];
  const blob = (rad, det, k) => lumpy(new THREE.IcosahedronGeometry(rad, det), 0.2, seed * 31 + k, 1.4 / Math.max(rad, 0.4));
  let trunkGeo, trunkMat = surface('bark', { color: opts.trunk }), swayBase = 2, height = 5, radius = 0.35;
  if (species === 'pine' || species === 'cypress') {
    const tiers = species === 'cypress' ? [[0.85, 2.6, 2.2], [0.7, 2.4, 3.6], [0.5, 2.2, 5.0], [0.3, 1.6, 6.2]] : [[1.75, 2.3, 2.3], [1.35, 2.1, 3.7], [0.95, 1.9, 5.0], [0.55, 1.4, 6.0]];
    trunkGeo = tiledCylinder(0.14, 0.3, 2.6, 7).translate(0, 1.3, 0); height = 7; swayBase = 1.6;
    tiers.forEach(([rad, h, y], i) => { crown.push([lumpy(new THREE.ConeGeometry(rad, h, 8, 2), 0.08, seed + i, 1.2), leaf[i % 4], M4(0, y, 0, 1, 1, 1, 0, r() * TAU, 0)]); if (snow) crown.push([new THREE.ConeGeometry(rad * 0.6, h * 0.42, 8), 0xf2f6f8, M4(0, y + h * 0.3, 0)]); });
  } else if (species === 'palm') {
    const lean = 0.25 + r() * 0.3, segs = 6; trunkMat = surface('bark', { color: opts.trunk ?? 0x8a6a48 }); const tparts = [];
    let x = 0, y = 0; for (let i = 0; i < segs; i++) { const a = lean * (i / segs); const g = tiledCylinder(0.16 - i * 0.012, 0.19 - i * 0.012, 0.95, 7, 1).applyMatrix4(M4(x + Math.sin(a) * 0.45, y + 0.45, 0, 1, 1, 1, 0, 0, -a)); tparts.push(g); x += Math.sin(a) * 0.9; y += Math.cos(a) * 0.9; }
    trunkGeo = mergeGeos(tparts); height = y + 1; swayBase = y - 0.4;
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU + r() * 0.3, droop = 0.5 + r() * 0.35, frond = new THREE.ConeGeometry(0.42, 2.9, 4, 3).translate(0, 1.45, 0); const p = frond.attributes.position; for (let k = 0; k < p.count; k++) { const t = p.getY(k) / 2.9; p.setZ(k, p.getZ(k) * 0.22); p.setY(k, p.getY(k) - t * t * 1.5 * droop); } crown.push([frond, leaf[i % 4], leanM(x, y, 0, 1.25, a)]); }
    for (let i = 0; i < 3; i++) extra.push([new THREE.SphereGeometry(0.16, 7, 5), 0x6a4a2a, M4(x + Math.cos(i * 2.1) * 0.2, y - 0.2, Math.sin(i * 2.1) * 0.2)]);
  } else if (species === 'dead') {
    const parts = [tiledCylinder(0.1, 0.26, 3.2, 6).translate(0, 1.6, 0)];
    for (let i = 0; i < 4; i++) { const a = i * 1.7 + r(), l = 1 + r() * 0.8; parts.push(tiledCylinder(0.03, 0.08, l, 5, 1).applyMatrix4(M4(Math.cos(a) * 0.35, 1.9 + i * 0.35, Math.sin(a) * 0.35, 1, 1, 1, Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9))); }
    trunkGeo = mergeGeos(parts); trunkMat = surface('bark', { color: opts.trunk ?? 0x7a6a58 }); height = 3.6;
  } else if (species === 'cactus') {
    const g = leaf[0], g2 = leaf[1]; height = 2.6; radius = 0.4; swayBase = 99;
    crown.push([new THREE.CapsuleGeometry(0.32, 1.7, 4, 9), g, M4(0, 1.15, 0)], [new THREE.CapsuleGeometry(0.15, 0.6, 3, 7), g2, M4(0.52, 1.5, 0)], [new THREE.CapsuleGeometry(0.15, 0.3, 3, 7), g2, M4(0.36, 1.1, 0, 1, 1, 1, 0, 0, 1.57)], [new THREE.CapsuleGeometry(0.13, 0.5, 3, 7), g, M4(-0.5, 1.75, 0)], [new THREE.CapsuleGeometry(0.13, 0.25, 3, 7), g, M4(-0.35, 1.42, 0, 1, 1, 1, 0, 0, 1.57)], [new THREE.SphereGeometry(0.12, 6, 4), 0xe85a7a, M4(0, 2.35, 0)]);
  } else if (species === 'mushroom') {
    trunkGeo = tiledCylinder(0.22, 0.34, 2.6, 9, 3, 1).translate(0, 1.3, 0); trunkMat = surface('plaster', { color: opts.trunk ?? 0xefe6d2 }); height = 3.6; swayBase = 99;
    const cap = new THREE.SphereGeometry(1.5, 14, 7, 0, TAU, 0, 1.45); crown.push([cap, leaf[0], M4(0, 2.5, 0, 1, 0.72, 1)]);
    for (let i = 0; i < 9; i++) { const a = r() * TAU, e = 0.25 + r() * 0.9; crown.push([new THREE.SphereGeometry(0.13 + r() * 0.1, 7, 5), 0xfff4e0, M4(Math.cos(a) * Math.sin(e) * 1.46, 2.5 + Math.cos(e) * 1.07, Math.sin(a) * Math.sin(e) * 1.46, 1, 0.5, 1)]); }
    extra.push([new THREE.CylinderGeometry(1.42, 1.3, 0.12, 14), 0xf2e2c8, M4(0, 2.62, 0)]);
  } else {
    const slim = species === 'birch', h = slim ? 4.2 : 3.2 + r() * 0.6; height = h + 2.2; swayBase = h - 0.6;
    const parts = [tiledCylinder(slim ? 0.11 : 0.17, slim ? 0.19 : 0.33, h, 8).translate(0, h / 2, 0)];
    for (let i = 0; i < (slim ? 1 : 2); i++) { const a = r() * TAU, l = 1 + r() * 0.5; parts.push(tiledCylinder(0.05, 0.11, l, 5, 1).applyMatrix4(M4(Math.cos(a) * 0.32, h * 0.72 + i * 0.3, Math.sin(a) * 0.32, 1, 1, 1, Math.sin(a) * 0.8, 0, -Math.cos(a) * 0.8))); }
    trunkGeo = mergeGeos(parts); if (slim) trunkMat = surface('birch', { color: opts.trunk });
    const n = slim ? 4 : species === 'willow' ? 6 : 5;
    for (let i = 0; i < n; i++) { const a = r() * TAU, d = i ? (slim ? 0.55 : 0.95) * (0.6 + r() * 0.6) : 0, rad = (slim ? 0.8 : 1.25) * (0.8 + r() * 0.45); crown.push([blob(rad, 1, i), leaf[i % 4], M4(Math.cos(a) * d, h + 0.35 + r() * 0.9 - (i ? 0.35 : 0), Math.sin(a) * d, 1, slim ? 1.25 : species === 'willow' ? 0.8 : 0.9, 1)]); }
    if (species === 'willow') for (let i = 0; i < 12; i++) { const a = i / 12 * TAU + r() * 0.3, d = 1.2 + r() * 0.5; crown.push([new THREE.ConeGeometry(0.2, 2.4 + r(), 4), leaf[(i + 1) % 4], M4(Math.cos(a) * d, h - 0.4, Math.sin(a) * d, 1, 1, 1, Math.PI, 0, 0)]); }
    if (snow) crown.push([blob(1.1, 1, 9), 0xf2f6f8, M4(0, h + 1.35, 0, 1, 0.45, 1)]);
  }
  const parts = [];
  if (trunkGeo) parts.push({ geometry: scaleGeo(trunkGeo, size), material: trunkMat });
  if (extra.length) parts.push({ geometry: scaleGeo(mergeColoured(extra, { uvScale: 2 }), size), material: tinted('plain', { stage: st }) });
  if (crown.length) parts.push({ geometry: scaleGeo(mergeColoured(crown, { uvScale: 2 }), size), material: tinted(species === 'mushroom' || species === 'cactus' ? 'plain' : 'foliage', { sway: swayBase > 50 ? 0 : species === 'palm' || species === 'willow' ? 0.1 : 0.05, swayBase: swayBase * size, stage: st }) });
  return { name: species, parts, radius: radius * size, height: height * size, solid: true };
}
const mergeGeos = joinGeometries;
const scaleGeo = (g, s) => { if (s !== 1) g.scale(s, s, s); g.computeBoundingSphere(); return g; };

/** A boulder cluster. Options: seed, size (metres, default 1), color, moss (colour of a mossy top, or true), ore (colour of embedded crystals or ore), snow. */
export function rock(opts = {}) {
  const { size = 1 } = opts, seed = sd(opts.seed), r = mulberry32(seed * 7717), cols = shades(opts.color ?? 0x8d8984, 3, r, 0.05), P = [];
  P.push([lumpy(new THREE.DodecahedronGeometry(0.95, 1), 0.22, seed + 3, 1.3), cols[0], M4(0, 0.38, 0, 1.25, 0.8 + r() * 0.3, 1.05, 0, r() * TAU, 0)]);
  P.push([lumpy(new THREE.DodecahedronGeometry(0.5, 1), 0.22, seed + 7, 1.6), cols[1], M4(0.75, 0.18, 0.3, 1, 0.8, 1)]);
  if (r() > 0.4) P.push([lumpy(new THREE.DodecahedronGeometry(0.34, 0), 0.2, seed + 9, 2), cols[2], M4(-0.6, 0.12, -0.5, 1, 0.75, 1)]);
  if (opts.moss) P.push([lumpy(new THREE.SphereGeometry(0.8, 8, 5, 0, TAU, 0, 1.1), 0.15, seed + 11, 1.5), opts.moss === true ? 0x5a8a3a : opts.moss, M4(0, 0.52, 0, 1.2, 0.62, 1)]);
  if (opts.snow) P.push([lumpy(new THREE.SphereGeometry(0.8, 8, 5, 0, TAU, 0, 1.0), 0.12, seed + 12, 1.5), 0xf4f8fb, M4(0, 0.56, 0, 1.2, 0.6, 1)]);
  const E = [];
  if (opts.ore != null) for (let i = 0; i < 7; i++) { const a = r() * TAU, e = r() * 1.1; E.push([new THREE.OctahedronGeometry(0.16 + r() * 0.1, 0), opts.ore, M4(Math.cos(a) * 0.95 * Math.cos(e), 0.4 + Math.sin(e) * 0.55, Math.sin(a) * 0.85 * Math.cos(e), 0.7, 1.8 + r(), 0.7, (r() - 0.5) * 0.9, 0, (r() - 0.5) * 0.9)]); }
  const parts = [{ geometry: scaleGeo(mergeColoured(P, { uvScale: 1.5 }), size), material: tinted('stone') }];
  if (E.length) parts.push({ geometry: scaleGeo(mergeColoured(E), size), material: tinted('plain', { emissive: opts.ore }) });
  return { name: 'rock', parts, radius: 1.05 * size, height: 1.1 * size, solid: true };
}

/** A bush. Options: seed, size, color, berries (colour) or flowers (colour). */
export function bush(opts = {}) {
  const { size = 1 } = opts, seed = sd(opts.seed), r = mulberry32(seed * 3331), cols = shades(opts.color ?? 0x3f8a36, 3, r), P = [];
  for (let i = 0; i < 4; i++) P.push([lumpy(new THREE.IcosahedronGeometry(0.42 + r() * 0.18, 1), 0.2, seed + i, 2.2), cols[i % 3], M4((r() - 0.5) * 0.6, 0.4 + r() * 0.18, (r() - 0.5) * 0.6)]);
  const dots = opts.berries ?? opts.flowers; if (dots != null) for (let i = 0; i < 14; i++) { const a = r() * TAU, e = r() * 1.2; P.push([new THREE.OctahedronGeometry(opts.flowers != null ? 0.09 : 0.065, 0), dots, M4(Math.cos(a) * 0.6 * Math.cos(e), 0.48 + Math.sin(e) * 0.45, Math.sin(a) * 0.6 * Math.cos(e))]); }
  return { name: 'bush', parts: [{ geometry: scaleGeo(mergeColoured(P, { uvScale: 2 }), size), material: tinted('foliage', { sway: 0.03, swayBase: 0.2 * size }) }], radius: 0.55 * size, height: 0.9 * size, solid: false };
}

/** Small ground cover. type: 'flower' | 'tuft' | 'fern' | 'reeds' | 'mushrooms' | 'stones' | 'log' | 'stump' | 'crystal'. Options: seed, size, color, accent. */
export function groundCover(type = 'flower', opts = {}) {
  const { size = 1 } = opts, seed = sd(opts.seed), r = mulberry32(seed * 5519 + type.length), P = []; let detail = 'plain', sway = 0.25, solid = false, radius = 0.25, emissive = 0;
  if (type === 'flower') { const petal = opts.color ?? [0xfff3d0, 0xffd84a, 0xf7a8d0, 0xc9b8ff, 0xff7a5a][seed % 5]; for (let i = 0; i < 3; i++) { const x = (r() - 0.5) * 0.3, z = (r() - 0.5) * 0.3, h = 0.28 + r() * 0.22; P.push([new THREE.CylinderGeometry(0.012, 0.016, h, 3, 1, true), 0x4f8a3a, M4(x, h / 2, z)]); P.push([new THREE.ConeGeometry(0.1, 0.045, 6), petal, M4(x, h, z, 1, 1, 1, 0.25, r() * 6, 0)]); P.push([new THREE.OctahedronGeometry(0.034, 0), opts.accent ?? 0xffc83a, M4(x, h + 0.03, z)]); } }
  else if (type === 'tuft') { const cols = shades(opts.color ?? 0x8ab84a, 3, r, 0.08); for (let i = 0; i < 9; i++) { const a = r() * TAU, h = 0.45 + r() * 0.5; P.push([new THREE.ConeGeometry(0.045, h, 3), cols[i % 3], M4(Math.cos(a) * 0.14, h / 2, Math.sin(a) * 0.14, 1, 1, 1, Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3)]); } }
  else if (type === 'fern') { const cols = shades(opts.color ?? 0x3f8a44, 2, r); for (let i = 0; i < 7; i++) { const a = i / 7 * TAU + r() * 0.4; const f = new THREE.ConeGeometry(0.16, 0.9, 4, 2).translate(0, 0.45, 0); const p = f.attributes.position; for (let k = 0; k < p.count; k++) p.setZ(k, p.getZ(k) * 0.2); P.push([f, cols[i % 2], leanM(0, 0.05, 0, 0.95, a)]); } }
  else if (type === 'reeds') { for (let i = 0; i < 8; i++) { const x = (r() - 0.5) * 0.5, z = (r() - 0.5) * 0.5, h = 0.9 + r() * 0.7; P.push([new THREE.CylinderGeometry(0.015, 0.022, h, 3, 1, true), opts.color ?? 0x7a9a4a, M4(x, h / 2, z)]); if (i % 2) P.push([new THREE.CylinderGeometry(0.035, 0.035, 0.2, 5), opts.accent ?? 0x6a4a2a, M4(x, h, z)]); } }
  else if (type === 'mushrooms') { sway = 0; for (let i = 0; i < 4; i++) { const x = (r() - 0.5) * 0.45, z = (r() - 0.5) * 0.45, s = 0.7 + r() * 0.6; P.push([new THREE.CylinderGeometry(0.04 * s, 0.055 * s, 0.24 * s, 5, 1, true), 0xf0e8d8, M4(x, 0.12 * s, z)]); P.push([new THREE.SphereGeometry(0.15 * s, 6, 3, 0, TAU, 0, 1.5), opts.color ?? (i % 2 ? 0xc83a2a : 0xd8a058), M4(x, 0.22 * s, z)]); } }
  else if (type === 'stones') { sway = 0; detail = 'stone'; const cols = shades(opts.color ?? 0x8f8b85, 3, r, 0.05); for (let i = 0; i < 4; i++) P.push([lumpy(new THREE.DodecahedronGeometry(0.13 + r() * 0.1, 0), 0.2, seed + i, 3), cols[i % 3], M4((r() - 0.5) * 0.6, 0.06, (r() - 0.5) * 0.6, 1, 0.65, 1, 0, r() * TAU, 0)]); }
  else if (type === 'log') { sway = 0; detail = 'bark'; solid = true; radius = 0.9; P.push([new THREE.CylinderGeometry(0.26, 0.3, 2.2, 9), opts.color ?? 0x7a5634, M4(0, 0.28, 0, 1, 1, 1, 0, r() * TAU, 1.5708)]); P.push([new THREE.CylinderGeometry(0.06, 0.09, 0.5, 5), opts.color ?? 0x7a5634, M4(0.3, 0.5, 0.1, 1, 1, 1, 0.3, 0, -0.5)]); }
  else if (type === 'stump') { sway = 0; detail = 'bark'; solid = true; radius = 0.45; P.push([new THREE.CylinderGeometry(0.32, 0.42, 0.55, 9), opts.color ?? 0x7a5634, M4(0, 0.27, 0)]); P.push([new THREE.CylinderGeometry(0.3, 0.3, 0.02, 9), 0xd9b98a, M4(0, 0.555, 0)]); }
  else if (type === 'crystal') { sway = 0; solid = true; radius = 0.5; emissive = opts.color ?? 0x6ef0ff; for (let i = 0; i < 6; i++) { const a = r() * TAU, d = i ? 0.3 : 0; P.push([new THREE.OctahedronGeometry(0.2, 0), emissive, M4(Math.cos(a) * d, 0.45 + r() * 0.2, Math.sin(a) * d, 0.7, 2.2 + r() * 1.4, 0.7, (r() - 0.5) * (i ? 0.9 : 0.1), 0, (r() - 0.5) * (i ? 0.9 : 0.1))]); } }
  else throw new Error(`Unknown ground cover "${type}". Available: flower, tuft, fern, reeds, mushrooms, stones, log, stump, crystal.`);
  return { name: type, parts: [{ geometry: scaleGeo(mergeColoured(P, { uvScale: 2 }), size), material: tinted(detail, { sway: sway ? sway * 0.5 : 0, swayBase: 0, emissive }) }], radius: radius * size, height: 0.6 * size, solid };
}

/** Every ground cover type groundCover() accepts. */
export const COVERS = ['flower', 'tuft', 'fern', 'reeds', 'mushrooms', 'stones', 'log', 'stump', 'crystal'];
/** A kind from a name or a recipe: 'oak', 'rock', 'bush', 'fern', 'campfire', { kind: 'prop', prop: 'house', width: 6 } … */
export function kindOf(k, opts = {}) {
  if (k && k.parts) return k;
  if (typeof k === 'string') return TREES.includes(k) ? tree({ ...opts, species: k }) : k === 'rock' ? rock(opts) : k === 'bush' ? bush(opts) : COVERS.includes(k) ? groundCover(k, opts) : build({ kind: 'prop', prop: k, ...opts });
  if (k && k.kind) return build(k);
  throw new Error('Expected a kind (from tree(), rock(), prop() …), a name such as "oak" or "campfire", or a recipe.');
}
let LIGHTS = 0;
/**
 * Puts ONE copy of a kind in the world and returns its Group (already added to the stage's scene).
 *   place(prop('house', { roof: 'rooftile' }), 4, land.heightAt(4, -6), -6, { rotY: 0.6 })
 *   place('campfire', 0, y, 0)            names work too: any tree species, 'rock', 'bush', any cover or prop
 * Options: rotY, scale, shadow, light (false to skip the real light a lamp or fire adds), scene, add (false to
 * get the Group without adding it). Pickups spin and bob, flames flicker, flags wave and windmills turn by
 * themselves. To move a bobbing pickup later, set group.userData.baseY.
 */
export function place(kind, x = 0, y = 0, z = 0, { scale = 1, rotY = 0, shadow = true, light = true, scene, add = true, stage } = {}) {
  kind = kindOf(kind); const st = stage || currentStage(), g = new THREE.Group(), glows = [];
  for (const p of kind.parts) { const m = new THREE.Mesh(p.geometry, p.material); m.castShadow = shadow && !p.glow; m.receiveShadow = !p.glow; if (p.glow) glows.push(m); g.add(m); }
  g.position.set(x, y, z); g.scale.setScalar(scale); g.rotation.y = rotY; g.userData.kind = kind; g.userData.baseY = y; g.userData.radius = kind.radius * scale;
  if (kind.light && light && st && LIGHTS < (st.software ? 0 : st.quality === 'low' ? 4 : 10)) {
    const L = kind.light, pl = new THREE.PointLight(L.color, L.intensity, L.distance, 1.6); pl.position.set(L.x, L.y, L.z); g.add(pl); LIGHTS++; g.userData.light = pl;
    if (L.flicker) st.onUpdate((dt, t) => { pl.intensity = L.intensity * (1 + (Math.sin(t * 11 + x) * 0.5 + Math.sin(t * 23.7 + z) * 0.5) * L.flicker); });
  }
  if (st && kind.flame && glows.length) st.onUpdate((dt, t) => glows.forEach((m, i) => { const k = 1 + Math.sin(t * (9 + i * 3) + x + i) * 0.14 + Math.sin(t * 17.3 + i * 2) * 0.08; m.scale.set(1 + (1 - k) * 0.4, k, 1 + (1 - k) * 0.4); m.position.y = kind.flame.y * (1 - k); }));
  if (st && (kind.spin || kind.bob)) st.onUpdate((dt, t) => { g.rotation.y += (kind.spin || 0) * dt; g.position.y = g.userData.baseY + Math.sin(t * 2.2 + x * 1.3 + z) * (kind.bob || 0) * scale; });
  if (kind.banner) {
    const geo = new THREE.PlaneGeometry(1.3, 0.8, 10, 4).translate(0.65, 0, 0), m = new THREE.Mesh(geo, surface(kind.banner.surface, { color: kind.banner.color, side: THREE.DoubleSide })), p0 = geo.attributes.position.array.slice();
    m.position.y = kind.banner.y; m.castShadow = shadow; g.add(m);
    if (st) st.onUpdate((dt, t) => { const p = geo.attributes.position; for (let i = 0; i < p.count; i++) { const px = p0[i * 3]; p.setZ(i, Math.sin(px * 4.2 - t * 5 * (0.6 + st.wind.strength * 0.4)) * 0.13 * px * st.wind.strength); p.setY(i, p0[i * 3 + 1] - px * px * 0.05); } p.needsUpdate = true; });
  }
  if (kind.spinner) {
    const hub = new THREE.Group(), mat = surface('planks', { color: 0xd8c8a0 }); hub.position.set(0, kind.spinner.y, kind.spinner.z);
    for (let i = 0; i < 4; i++) { const blade = new THREE.Mesh(new THREE.BoxGeometry(0.9, 3.6, 0.06).translate(0.3, 2.1, 0), mat); blade.rotation.z = i * Math.PI / 2; blade.castShadow = shadow; hub.add(blade); }
    g.add(hub); if (st) st.onUpdate((dt) => { hub.rotation.z += dt * 0.5 * st.wind.strength; });
  }
  const target = scene || (st && st.scene); if (add && target) target.add(g);
  return g;
}

/**
 * Places many copies of one or more kinds as instanced meshes (hundreds cost a few draw calls).
 *   scatter(stage.scene, [tree({ species: 'oak' }), tree({ species: 'pine', seed: 2 }), rock()], { count: 200, radius: 90, heightAt: land.heightAt })
 * Options: count, radius (a disc) or area [width, depth], center [x, z], heightAt (x, z) -> y,
 *   where (x, z, y, slope) -> false to skip or a 0..1 chance (keep trees off beaches and cliffs),
 *   scale [min, max], minDistance (between items of this call), avoid [{ x, z, r }] (clearings, paths, the spawn),
 *   weights (per kind), seed, sink (metres pushed into the ground so nothing floats, default 0.08), shadow.
 * Returns { meshes, items: [{ x, y, z, r, scale, kind }], solids }: pass solids to control() for collision; use items for harvesting or anything else.
 */
export function scatter(scene, kinds, opts = {}) {
  if (!scene || !scene.isObject3D) { opts = kinds || {}; kinds = scene; scene = (opts.stage || currentStage()).scene; }   // scatter(kinds, opts) uses the stage's scene
  const list = (Array.isArray(kinds) ? kinds : [kinds]).map((k) => kindOf(k)), { count = 100, radius = 60, area, center = [0, 0], heightAt = () => 0, where, scale = [0.8, 1.3], minDistance = 0, avoid = [], sink = 0.08, shadow = true, weights } = opts, seed = sd(opts.seed);
  const r = mulberry32(seed * 104729 + 17), items = [], per = list.map(() => []), tot = (weights || list.map(() => 1)).reduce((a, b) => a + b, 0);
  const cell = Math.max(minDistance, 0.001), grid = new Map(), keyOf = (x, z) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  for (let tries = 0; tries < count * 12 && items.length < count; tries++) {
    let x, z; if (area) { x = center[0] + (r() - 0.5) * area[0]; z = center[1] + (r() - 0.5) * area[1]; } else { const a = r() * TAU, d = Math.sqrt(r()) * radius; x = center[0] + Math.cos(a) * d; z = center[1] + Math.sin(a) * d; }
    const y = heightAt(x, z);
    if (where) { const slope = Math.abs(heightAt(x + 1, z) - y) + Math.abs(heightAt(x, z + 1) - y), ok = where(x, z, y, slope); if (!ok || (typeof ok === 'number' && r() > ok)) continue; }
    if (avoid.some((a) => Math.hypot(a.x - x, a.z - z) < a.r)) continue;
    if (minDistance > 0) { let clash = false; const cx = Math.floor(x / cell), cz = Math.floor(z / cell); for (let i = -1; i <= 1 && !clash; i++) for (let j = -1; j <= 1 && !clash; j++) for (const o of grid.get(`${cx + i},${cz + j}`) || []) if (Math.hypot(o.x - x, o.z - z) < minDistance) { clash = true; break; } if (clash) continue; }
    let w = r() * tot, k = 0; if (weights) { while (k < list.length - 1 && (w -= weights[k]) > 0) k++; } else k = (r() * list.length) | 0;
    const s = scale[0] + r() * (scale[1] - scale[0]), it = { x, y: y - sink * s, z, scale: s, rotY: r() * TAU, kind: list[k], r: list[k].radius * s, solid: !!list[k].solid };
    items.push(it); per[k].push(it); if (minDistance > 0) { const key = keyOf(x, z); if (!grid.has(key)) grid.set(key, []); grid.get(key).push(it); }
  }
  // One InstancedMesh per kind and per map cell, so whole cells drop out when they are off screen or in the fog.
  const meshes = [], m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const st = opts.stage || currentStage(), span = area ? Math.max(area[0], area[1]) : radius * 2, cs = Math.max(24, span / 5), small = st && st.quality === 'low';
  list.forEach((kind, k) => { if (!per[k].length) return; const cells = new Map(); for (const it of per[k]) { const key = Math.floor(it.x / cs) + ',' + Math.floor(it.z / cs); if (!cells.has(key)) cells.set(key, []); cells.get(key).push(it); }
    for (const group of cells.values()) for (const part of kind.parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, group.length); mesh.userData.glow = !!part.glow;
      group.forEach((it, i) => { q.setFromAxisAngle(up, it.rotY); mesh.setMatrixAt(i, m4.compose(pv.set(it.x, it.y, it.z), q, sv.setScalar(it.scale))); });
      mesh.instanceMatrix.needsUpdate = true; mesh.castShadow = shadow && !part.glow && !(small && kind.radius < 0.7); mesh.receiveShadow = !part.glow && !(st && st.software); mesh.computeBoundingSphere(); scene.add(mesh); meshes.push(mesh);
    } });
  return { meshes, items, solids: items.filter((i) => i.solid) };
}

/**
 * A field of grass tufts that sway in the wind: the cheapest way to make ground look alive.
 * Options: land (the terrain: tufts stand on it and take its colour, so the grass grows out of the ground instead
 * of sitting on it), count (tufts; default about two per square metre, scaled down automatically on slow devices),
 * radius or area, center, where, color (a colour or a list, instead of the land's), height (metres), seed, stage.
 * Without land pass heightAt. Returns the instanced mesh.
 */
export function grassField(scene, opts = {}) {
  if (!scene || !scene.isObject3D) { opts = scene || {}; scene = (opts.stage || currentStage()).scene; }
  const st = opts.stage || currentStage(), land = opts.land, { radius = 50, area, center = [0, 0], heightAt = land ? land.heightAt : () => 0, where, height = 0.5 } = opts, seed = sd(opts.seed);
  const lite = !!(st && st.software), m2 = area ? area[0] * area[1] : Math.PI * radius * radius, count = Math.round((opts.count ?? Math.min(24000, m2 * 2)) * (st ? st.density : 0.8)), r = mulberry32(seed * 8191);
  const fixed = opts.color != null || !land ? (Array.isArray(opts.color) ? opts.color : shades(opts.color ?? 0x6fb04a, 4, r, 0.06)).map((c) => new THREE.Color(c)) : null;
  // one tuft: a few bent ribbons, dark at the root and light at the tip, all lit as if they faced the sky so the
  // field shades like the ground under it. Each ribbon is built with both windings, so it needs no double-sided pass.
  const nb = lite ? 3 : 6, pos = [], col = [], idx = [], tr = mulberry32(seed * 131 + 7);
  for (let i = 0; i < nb; i++) {
    const a = i / nb * TAU + tr() * 0.9, d = 0.05 + tr() * 0.2, w = 0.035 + tr() * 0.025, h = 0.65 + tr() * 0.5, bend = 0.12 + tr() * 0.28, ca = Math.cos(a), sa = Math.sin(a), o = pos.length / 3;
    for (const [side, t] of [[-1, 0], [1, 0], [-0.65, 0.55], [0.65, 0.55], [0, 1]]) {
      const out = d + t * t * bend, k = 0.6 + t * 0.62;
      pos.push(ca * out - sa * side * w, t * h, sa * out + ca * side * w); col.push(k * (1 + t * 0.1), k * (1 + t * 0.08), k * (1 - t * 0.12));
    }
    idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2, o + 2, o + 3, o + 4, o, o + 2, o + 1, o + 1, o + 2, o + 3, o + 2, o + 4, o + 3);
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill([0, 1, 0]).flat(), 3)); geo.setIndex(idx);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true }); if (st) windSway(mat, st, { amount: 0.2, base: 0, speed: 1.9, flutter: 0.5 });
  const mesh = new THREE.InstancedMesh(geo, mat, count), m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color(); let n = 0;
  for (let tries = 0; tries < count * 4 && n < count; tries++) {
    let x, z; if (area) { x = center[0] + (r() - 0.5) * area[0]; z = center[1] + (r() - 0.5) * area[1]; } else { const a = r() * TAU, d = Math.sqrt(r()) * radius; x = center[0] + Math.cos(a) * d; z = center[1] + Math.sin(a) * d; }
    const y = heightAt(x, z); if (where) { const slope = Math.abs(heightAt(x + 1, z) - y) + Math.abs(heightAt(x, z + 1) - y), ok = where(x, z, y, slope); if (!ok || (typeof ok === 'number' && r() > ok)) continue; }
    const s = 0.75 + r() * 0.6; qq.setFromAxisAngle(up, r() * TAU); mesh.setMatrixAt(n, m4.compose(pv.set(x, y - 0.03, z), qq, sv.set(s, s * height / 0.6, s)));
    if (fixed) c.copy(fixed[(r() * fixed.length) | 0]); else { land.colorAt(x, z, c, y); c.multiplyScalar(1.08 + r() * 0.14); }
    mesh.setColorAt(n, c); n++;
  }
  mesh.count = n; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; mesh.receiveShadow = true; mesh.castShadow = false; mesh.computeBoundingSphere(); scene.add(mesh);
  return mesh;
}

const LANDS = {
  temperate: { shore: 0xdcc890, low: 0x5c9a3c, high: 0x4a8a3a, steep: 0x8b8378, peak: 0x9a968c, detail: 'grass' },
  autumn:    { shore: 0xd8c79a, low: 0xa89a3c, high: 0xb8742c, steep: 0x7f776c, peak: 0x8f8a80, detail: 'grass' },
  desert:    { shore: 0xe6cf98, low: 0xdcb878, high: 0xc99a5c, steep: 0xa8754a, peak: 0xb8865a, detail: 'sand' },
  snow:      { shore: 0xb4c8dc, low: 0xf4f8fc, high: 0xcfdeec, steep: 0x7f8894, peak: 0xffffff, detail: 'snow' },
  volcanic:  { shore: 0x8a3414, low: 0x4c423c, high: 0x6e574a, steep: 0x2c2422, peak: 0xa8441c, detail: 'rock' },
  alien:     { shore: 0x5a3a7a, low: 0x3f9a8a, high: 0x7a4aa8, steep: 0x2f2a4a, peak: 0xc9a8ff, detail: 'grass' },
  tropical:  { shore: 0xf0dfa8, low: 0x4fa84a, high: 0x3a8a44, steep: 0x7f7a6c, peak: 0x8f8a7c, detail: 'grass' },
};
const SHAPES = {
  island: (n, x, z, s, amp) => { const d = Math.hypot(x, z) / (s * 0.46); return lerp(n.fbm2(x * 0.011, z * 0.011, 4) * amp + n.n2(x * 0.05, z * 0.05) * amp * 0.12 + amp * 0.7, -amp * 0.5, smoothstep(0.55, 1.05, d)); },
  hills: (n, x, z, s, amp) => n.fbm2(x * 0.009, z * 0.009, 4) * amp + n.n2(x * 0.04, z * 0.04) * amp * 0.1 + amp * 0.45,
  plains: (n, x, z, s, amp) => n.fbm2(x * 0.006, z * 0.006, 3) * amp * 0.3 + n.n2(x * 0.05, z * 0.05) * amp * 0.04 + amp * 0.2,
  valley: (n, x, z, s, amp) => n.fbm2(x * 0.01, z * 0.01, 4) * amp * 0.5 + Math.pow(Math.abs(x) / (s * 0.5), 1.7) * amp * 2.2 + amp * 0.05,
  dunes: (n, x, z, s, amp) => (Math.abs(n.n2(x * 0.012, z * 0.03)) * 0.9 + n.fbm2(x * 0.02, z * 0.02, 2) * 0.25) * amp + amp * 0.1,
  mountains: (n, x, z, s, amp) => { const v = 1 - Math.abs(n.fbm2(x * 0.008, z * 0.008, 5)); return v * v * amp * 2.2 - amp * 0.4; },
  flat: () => 0,
};
/** Every terrain shape and palette terrain() accepts. */
export const TERRAIN_SHAPES = Object.keys(SHAPES), TERRAIN_PALETTES = Object.keys(LANDS);

/**
 * The ground (added to the stage's scene for you). Returns { mesh, heightAt(x, z), slopeAt(x, z), colorAt(x, z), size, waterLevel, randomPoint(rand, { minHeight, maxSlope, minRadius, maxRadius }) }.
 * Options: shape ('island' | 'hills' | 'plains' | 'valley' | 'dunes' | 'mountains' | 'flat') or height (x, z) -> y of your own,
 *   size (metres, default 240), segments (default from quality), amplitude (metres of relief, default 12), seed,
 *   palette ('temperate' | 'autumn' | 'desert' | 'snow' | 'volcanic' | 'alien' | 'tropical', or { shore, low, high, steep, peak, detail }),
 *   waterLevel (heights near it get the shore colour), clearing { x, z, r } (a flat spot, e.g. the spawn),
 *   style ('faceted': crisp low-poly facets, each with its own colour, the default for natural land · 'smooth':
 *   rounded and multiplied by the palette's painted detail texture, the default for shape 'flat' and for palettes
 *   that name a detail).
 * Colour comes from height and slope and varies from facet to facet, so it never reads as one flat fill.
 * Also returns colorAt(x, z): the ground colour at a point, which grassField({ land }) uses to blend in.
 */
export function terrain(opts = {}) {
  const st = opts.stage || currentStage(), q = st ? st.quality : 'medium', { size = 240, amplitude = 12, waterLevel = 0, shape = 'island', clearing, flatShading = false } = opts, seed = sd(opts.seed);
  const segments = opts.segments ?? (st && st.software ? 56 : q === 'low' ? 72 : q === 'medium' ? 112 : 160), noise = new Simplex(seed), pal = typeof opts.palette === 'object' ? { ...LANDS.temperate, ...opts.palette } : LANDS[opts.palette] || LANDS.temperate;
  const base = opts.height || ((x, z) => (SHAPES[shape] || SHAPES.island)(noise, x, z, size, amplitude));
  const heightAt = clearing ? (x, z) => { const d = Math.hypot(x - clearing.x, z - clearing.z), t = smoothstep(clearing.r, clearing.r * 2.2, d); return lerp(clearing.y ?? Math.max(base(clearing.x, clearing.z), waterLevel + 1.2), base(x, z), t); } : base;
  const slopeAt = (x, z) => { const y = heightAt(x, z); return Math.abs(heightAt(x + 1, z) - y) + Math.abs(heightAt(x, z + 1) - y); };
  const C = Object.fromEntries(['shore', 'low', 'high', 'steep', 'peak'].map((k) => [k, new THREE.Color(pal[k])]));
  /** The ground colour at a point (a THREE.Color written into `out`): grass and anything else that should blend into the land reads it. */
  const colorAt = (x, z, out = new THREE.Color(), y = heightAt(x, z)) => {
    const s = slopeAt(x, z), hN = clamp((y - waterLevel) / Math.max(amplitude, 1)), patch = noise.n2(x * 0.045 + 31, z * 0.045 - 17) * 0.5 + 0.5;
    return out.copy(C.low).lerp(C.high, clamp(hN * 1.1 + (patch - 0.5) * 0.7)).lerp(C.peak, smoothstep(0.82, 1.15, hN)).lerp(C.steep, smoothstep(0.55, 1.1, s)).lerp(C.shore, 1 - smoothstep(0.35, 1.3, y - waterLevel));
  };
  const faceted = opts.style ? opts.style === 'faceted' : shape !== 'flat' && !(typeof opts.palette === 'object' && opts.palette.detail);
  let g = new THREE.PlaneGeometry(size, size, segments, segments).rotateX(-Math.PI / 2); const c = new THREE.Color();
  { const p = g.attributes.position, uv = g.attributes.uv; for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); p.setY(i, heightAt(x, z)); uv.setXY(i, x / 6, z / 6); } }
  let material;
  if (faceted) {
    // low-poly look: every triangle is one flat facet with its own colour, taken at its centre and nudged a little,
    // so the ground reads as crisp planes at any distance and any angle (a stretched texture never does)
    g = g.toNonIndexed(); const p = g.attributes.position, col = new Float32Array(p.count * 3), fr = mulberry32(seed * 7 + 5);
    for (let i = 0; i < p.count; i += 3) {
      const x = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3, z = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3, y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
      colorAt(x, z, c, y); const v = 0.95 + fr() * 0.1 + noise.n2(x * 0.11, z * 0.11) * 0.05;
      for (let k = 0; k < 3; k++) { col[(i + k) * 3] = c.r * v; col[(i + k) * 3 + 1] = c.g * v; col[(i + k) * 3 + 2] = c.b * v; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.deleteAttribute('uv'); g.computeVertexNormals();
    material = new THREE.MeshLambertMaterial({ vertexColors: true });
  } else {
    const p = g.attributes.position, col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); colorAt(x, z, c, p.getY(i)); const v = 0.93 + noise.n2(x * 0.4, z * 0.4) * 0.07; col[i * 3] = c.r * v; col[i * 3 + 1] = c.g * v; col[i * 3 + 2] = c.b * v; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeVertexNormals();
    material = new THREE.MeshLambertMaterial({ vertexColors: true, map: surfaceTexture(pal.detail || 'grass', { color: 0xd6dccf }), flatShading });
  }
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, material); mesh.receiveShadow = true;
  const randomPoint = (rand, { minHeight = waterLevel + 0.8, maxHeight = Infinity, maxSlope = 0.9, minRadius = 0, maxRadius = size * 0.42, tries = 300 } = {}) => {
    for (let i = 0; i < tries; i++) { const a = rand() * TAU, d = minRadius + Math.sqrt(rand()) * (maxRadius - minRadius), x = Math.cos(a) * d, z = Math.sin(a) * d, y = heightAt(x, z); if (y >= minHeight && y <= maxHeight && slopeAt(x, z) <= maxSlope) return new THREE.Vector3(x, y, z); }
    return new THREE.Vector3(0, heightAt(0, 0), 0);
  };
  if (st && opts.add !== false) st.scene.add(mesh);
  return { mesh, heightAt, slopeAt, colorAt, size, waterLevel, amplitude, randomPoint };
}

/**
 * Moving water with waves and sparkle, added to the stage's scene at `level` (use the terrain's waterLevel).
 * Options: level, size, color, deep (colour away from shore), opacity, waves (metres, default 0.12), stage.
 */
export function water(opts = {}) {
  const st = opts.stage || currentStage(), { level = 0, size = 900, color = 0x2f8fc4, opacity = 0.84, waves = 0.12 } = opts, low = st && st.quality === 'low';
  const tex = surfaceTexture('water', { color: 0xcfe9f5, seed: 4 }).clone(); tex.repeat.set(size / 14, size / 14); tex.needsUpdate = true;
  const soft = !!(st && st.software), mat = soft ? new THREE.MeshLambertMaterial({ color, map: tex }) : new THREE.MeshPhongMaterial({ color, map: tex, transparent: true, opacity, shininess: 90, specular: 0x8fb8d8 }), U = { uWaterTime: { value: 0 }, uWaves: { value: waves } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uWaterTime, uWaves;')
      .replace('#include <beginnormal_vertex>', 'float wA = position.x * 0.31 + uWaterTime * 1.1, wB = position.z * 0.47 - uWaterTime * 1.4, wC = (position.x + position.z) * 0.9 + uWaterTime * 2.1;\nvec3 objectNormal = normalize(vec3(-(cos(wA) * 0.31 + cos(wC) * 0.27) * uWaves, 1.0, -(cos(wB) * 0.47 * 0.7 + cos(wC) * 0.27) * uWaves));')
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position); transformed.y += (sin(wA) + sin(wB) * 0.7 + sin(wC) * 0.3) * uWaves;');
  };
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size, st && st.software ? 20 : low ? 48 : 128, st && st.software ? 20 : low ? 48 : 128).rotateX(-Math.PI / 2), mat); mesh.position.y = level; mesh.receiveShadow = true; mesh.renderOrder = 2;
  const tick = (dt, t) => { U.uWaterTime.value = t; tex.offset.set(t * 0.012, t * 0.008); };
  if (st) { st.onUpdate(tick); if (opts.add !== false) st.scene.add(mesh); } mesh.userData.update = tick;
  return mesh;
}

defineRecipe('tree', { summary: 'A tree kind (place or scatter it).', params: { species: TREES.join(' | '), seed: 'individual', size: '1 = about 5 m', leaf: 'colour or list', trunk: 'colour', snow: 'true for a snow cap' }, make: (p) => tree(p) });
defineRecipe('rock', { summary: 'A boulder cluster kind.', params: { seed: 'shape', size: 'metres', color: 'stone colour', moss: 'true or colour', ore: 'crystal colour', snow: 'true for a snow cap' }, make: (p) => rock(p) });
defineRecipe('bush', { summary: 'A bush kind.', params: { seed: 'shape', size: 'metres', color: 'leaf colour', berries: 'colour', flowers: 'colour' }, make: (p) => bush(p) });
defineRecipe('cover', { summary: 'Small ground cover kind.', params: { type: 'flower | tuft | fern | reeds | mushrooms | stones | log | stump | crystal', seed: 'shape', size: 'scale', color: 'main colour', accent: 'second colour' }, make: (p) => groundCover(p.type, p) });
defineRecipe('terrain', { summary: 'The ground: { mesh, heightAt, slopeAt, randomPoint }.', params: { shape: TERRAIN_SHAPES.join(' | '), palette: TERRAIN_PALETTES.join(' | '), seed: 'world', size: 'metres', amplitude: 'metres of relief', waterLevel: 'height of the shore', clearing: '{ x, z, r } flat spot' }, cache: false, make: (p) => terrain(p) });

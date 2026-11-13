// @gcp/procgen.js · mesh — a builder for models made in code. The output is plain BufferGeometry (positions,
// normals, vertex colours, UVs), so it works with any material and any render path.
// The recipe behind every model in the sample games is the same four steps, and they are all here:
//   1. primitives with world-scale UVs (tbox, tplane, tcylinder): a texture keeps one size on every face
//   2. displace / lumpy: push vertices with seeded noise; coincident vertices move together so nothing cracks
//   3. mergeParts: many small coloured parts become ONE geometry and one draw call
//   4. simplify + lodMesh: cheaper copies for the distance
import * as THREE from 'three';
import { M4, lumpy, instances } from '../three-kit.js';
import { gnoise3, toSeed } from './noise.js';

export { M4, lumpy, instances };
export const MESH_VERSION = 1;

/** A box whose texture repeats every `tile` units on every face, so a wall and a crate show the same brick size. */
export function tbox(w, h, d, tile = 2) {
  const g = new THREE.BoxGeometry(w, h, d), uv = g.attributes.uv, dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) { const i = f * 4 + k; uv.setXY(i, uv.getX(i) * dims[f][0] / tile, uv.getY(i) * dims[f][1] / tile); }
  return g;
}
/** A horizontal plane (floor, road, field) whose texture repeats every `tile` units. */
export function tplane(w, d, tile = 2, segments = 1) {
  const g = new THREE.PlaneGeometry(w, d, segments, segments).rotateX(-Math.PI / 2), uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / tile, uv.getY(i) * d / tile);
  return g;
}
/** A cylinder (trunk, pillar, barrel) whose texture wraps `around` times and repeats every `tile` units of height. */
export function tcylinder(rTop, rBottom, h, segments = 10, tile = 2, around = 2) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, segments), uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * around, uv.getY(i) * h / tile);
  return g;
}
/** A triangular prism: a gable roof, a ramp, a tent. Ridge runs along z; UVs repeat every `tile` units. */
export function tprism(w, h, d, tile = 2) {
  const x = w / 2, z = d / 2, s = Math.hypot(x, h), P = [], U = [];
  const quad = (a, b, c, e, uw, uh) => { P.push(...a, ...b, ...c, ...a, ...c, ...e); U.push(0, 0, uw, 0, uw, uh, 0, 0, uw, uh, 0, uh); };
  quad([-x, 0, z], [0, h, z], [0, h, -z], [-x, 0, -z], s / tile, d / tile); quad([x, 0, -z], [0, h, -z], [0, h, z], [x, 0, z], s / tile, d / tile);
  quad([-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z], w / tile, d / tile);
  P.push(-x, 0, z, x, 0, z, 0, h, z, x, 0, -z, -x, 0, -z, 0, h, -z); U.push(0, 0, w / tile, 0, w / tile / 2, h / tile, 0, 0, w / tile, 0, w / tile / 2, h / tile);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); g.computeVertexNormals(); return g;
}

/**
 * Merges parts into ONE indexed geometry with vertex colours and UVs: a whole tree, house or creature becomes a
 * single draw call under one `vertexColors: true` material (optionally with a pale detail texture as `map`).
 * parts: [geometry, colour, matrix?] (use M4(x, y, z, sx, sy, sz, rx, ry, rz) for the matrix).
 * Options: jitter (slight shade variation so surfaces do not look like plastic), uvScale,
 * flat (default true): vertices at the same place are shared, which is three to five times cheaper to draw;
 *   give the material `flatShading: true` for the faceted low-poly look (the craft materials do), or leave it
 *   off for a smooth surface. flat: false keeps each part's own normals (smooth spheres next to sharp boxes).
 */
export function mergeParts(parts, { jitter = 0.07, flat = true, uvScale = 1 } = {}) {
  const pos = [], nor = [], col = [], uv = [], idx = [], seen = new Map(), c = new THREE.Color();
  for (const [geo0, color, mtx] of parts) {
    const geo = geo0.index ? geo0.toNonIndexed() : geo0.clone();
    if (mtx) geo.applyMatrix4(mtx);
    if (!flat && !geo.attributes.normal) geo.computeVertexNormals();
    const p = geo.attributes.position, n = geo.attributes.normal, t = geo.attributes.uv, vc = geo.attributes.color; c.set(color ?? 0xffffff);
    const cr = Math.round(c.r * 255), cg = Math.round(c.g * 255), cb = Math.round(c.b * 255);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), u = t ? t.getX(i) * uvScale : (x + z) * 0.5 * uvScale, v = t ? t.getY(i) * uvScale : y * 0.5 * uvScale;
      const qx = Math.round(x * 2000), qy = Math.round(y * 2000), qz = Math.round(z * 2000);
      let key = qx + ',' + qy + ',' + qz + '|' + cr + ',' + cg + ',' + cb + '|' + Math.round(u * 500) + ',' + Math.round(v * 500);
      if (!flat) key += '|' + Math.round(n.getX(i) * 20) + ',' + Math.round(n.getY(i) * 20) + ',' + Math.round(n.getZ(i) * 20);
      if (vc) key += '|' + Math.round(vc.getX(i) * 60) + ',' + Math.round(vc.getY(i) * 60) + ',' + Math.round(vc.getZ(i) * 60);
      let j = seen.get(key);
      if (j === undefined) {
        j = pos.length / 3; seen.set(key, j); pos.push(x, y, z); uv.push(u, v); if (!flat) nor.push(n.getX(i), n.getY(i), n.getZ(i));
        const k = 1 - jitter + ((Math.imul(qx * 73856093 ^ qy * 19349663 ^ qz * 83492791, 2654435761) >>> 8) / 16777216) * jitter * 2;
        if (vc) col.push(c.r * k * vc.getX(i), c.g * k * vc.getY(i), c.b * k * vc.getZ(i)); else col.push(c.r * k, c.g * k, c.b * k);
      }
      idx.push(j);
    }
    geo.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); if (flat) g.computeVertexNormals(); else g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.computeBoundingSphere(); return g;
}

const keyOf = (x, y, z, q) => `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
/**
 * Moves every vertex with a function or seeded noise. Vertices at the same place (quantised to `weld`) get the
 * same move, so faces that share an edge stay joined.
 *   displace(geo, { amount: 0.2, frequency: 1.5, seed: 4 })            noise along the direction from the centre
 *   displace(geo, { along: 'normal', amount: 0.1 })                    noise along the normal
 *   displace(geo, { fn: (x, y, z) => [x, y + Math.max(0, y) * 0.3, z] })   your own function -> new position
 * Returns a new non-indexed geometry with fresh normals. Deterministic for a seed (ALGO.gradient).
 */
export function displace(geo, { amount = 0.15, frequency = 1.5, seed = 1, along = 'radial', fn, weld = 1000, flat = true } = {}) {
  const src = geo.index ? geo.toNonIndexed() : geo.clone(), p = src.attributes.position, s = toSeed(seed), seen = new Map();
  let nrm = null; if (along === 'normal' && !fn) { const w = weldGeometry(src, 1 / weld); w.computeVertexNormals(); nrm = new Map(); const wp = w.attributes.position, wn = w.attributes.normal; for (let i = 0; i < wp.count; i++) nrm.set(keyOf(wp.getX(i), wp.getY(i), wp.getZ(i), weld), [wn.getX(i), wn.getY(i), wn.getZ(i)]); w.dispose(); }
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = keyOf(x, y, z, weld); let v = seen.get(k);
    if (!v) {
      if (fn) v = fn(x, y, z);
      else { const n = gnoise3(x * frequency, y * frequency, z * frequency, s) * amount; if (nrm) { const d = nrm.get(k) || [0, 1, 0]; v = [x + d[0] * n, y + d[1] * n, z + d[2] * n]; } else v = [x * (1 + n), y * (1 + n), z * (1 + n)]; }
      seen.set(k, v);
    }
    p.setXYZ(i, v[0], v[1], v[2]);
  }
  if (flat) src.computeVertexNormals(); else return smoothNormals(src);
  return src;
}

/** Joins vertices closer than `tolerance` into an indexed geometry (positions, plus colours and UVs of the first vertex met). */
export function weldGeometry(geo, tolerance = 1e-3) {
  const src = geo.index ? geo.toNonIndexed() : geo, p = src.attributes.position, c = src.attributes.color, t = src.attributes.uv, q = 1 / tolerance, map = new Map(), pos = [], col = [], uv = [], idx = [];
  for (let i = 0; i < p.count; i++) { const k = keyOf(p.getX(i), p.getY(i), p.getZ(i), q); let j = map.get(k); if (j === undefined) { j = pos.length / 3; map.set(k, j); pos.push(p.getX(i), p.getY(i), p.getZ(i)); if (c) col.push(c.getX(i), c.getY(i), c.getZ(i)); if (t) uv.push(t.getX(i), t.getY(i)); } idx.push(j); }
  const out = [], g = new THREE.BufferGeometry(); for (let i = 0; i < idx.length; i += 3) if (idx[i] !== idx[i + 1] && idx[i + 1] !== idx[i + 2] && idx[i] !== idx[i + 2]) out.push(idx[i], idx[i + 1], idx[i + 2]);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); if (c) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); if (t) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(out); return g;
}
/** Recomputes normals so the surface shades smoothly (welds first). Use flatNormals for a faceted look. */
export function smoothNormals(geo, tolerance = 1e-3) { const g = weldGeometry(geo, tolerance); g.computeVertexNormals(); g.computeBoundingSphere(); return g; }
/** Recomputes normals per face (faceted, the low-poly look). */
export function flatNormals(geo) { const g = geo.index ? geo.toNonIndexed() : geo.clone(); g.computeVertexNormals(); g.computeBoundingSphere(); return g; }

/**
 * A cheaper copy of a geometry by vertex clustering: vertices are snapped to a grid of `cell` units (or pass
 * ratio 0..1 to aim at that share of the detail) and collapsed triangles are dropped. Keeps vertex colours.
 */
export function simplify(geo, { cell, ratio = 0.5, flat = true } = {}) {
  geo.computeBoundingSphere(); const r = geo.boundingSphere.radius || 1, n = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
  const size = cell || (r * 2) / Math.max(2, Math.sqrt(n * ratio / 2) * 0.9);
  const src = geo.index ? geo.toNonIndexed() : geo.clone(), p = src.attributes.position;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, Math.round(p.getX(i) / size) * size, Math.round(p.getY(i) / size) * size, Math.round(p.getZ(i) / size) * size);
  const w = weldGeometry(src, size / 4); src.dispose();
  const out = flat ? w.toNonIndexed() : w; out.computeVertexNormals(); out.computeBoundingSphere(); if (flat) w.dispose(); return out;
}

/**
 * A THREE.LOD that swaps in cheaper copies with distance. distances: where each step starts, e.g. [0, 40, 90].
 * The copies are made with simplify(); pass `levels` to give your own geometries instead.
 */
export function lodMesh(geometry, material, { distances = [0, 40, 90], levels, castShadow = true } = {}) {
  const lod = new THREE.LOD();
  distances.forEach((d, i) => { const g = levels ? levels[i] : i === 0 ? geometry : simplify(geometry, { ratio: 1 / (i * 3 + 1) }); const m = new THREE.Mesh(g, material); m.castShadow = castShadow && i === 0; m.receiveShadow = true; lod.addLevel(m, d); });
  return lod;
}

/** Paints vertex colours from a function: colourise(geo, (x, y, z, nx, ny, nz) => 0xrrggbb). Multiplies existing colours when keep is true. */
export function colourise(geo, fn, keep = false) {
  const p = geo.attributes.position, n = geo.attributes.normal, old = geo.attributes.color, col = new Float32Array(p.count * 3), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) { c.set(fn(p.getX(i), p.getY(i), p.getZ(i), n ? n.getX(i) : 0, n ? n.getY(i) : 1, n ? n.getZ(i) : 0)); const k = keep && old ? [old.getX(i), old.getY(i), old.getZ(i)] : [1, 1, 1]; col[i * 3] = c.r * k[0]; col[i * 3 + 1] = c.g * k[1]; col[i * 3 + 2] = c.b * k[2]; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); return geo;
}
/** Triangle count of a geometry, mesh or whole scene (instances counted). */
export function countTriangles(o) {
  if (o.isBufferGeometry) return (o.index ? o.index.count : o.attributes.position.count) / 3;
  let n = 0; o.traverse((m) => { if (m.geometry) n += countTriangles(m.geometry) * (m.isInstancedMesh ? m.count : 1); }); return n;
}
/** Joins geometries that will share ONE material (positions, normals, UVs; indices are kept). Apply matrices first. */
export function joinGeometries(list) {
  const pos = [], nor = [], uv = [], idx = []; let base = 0;
  for (const g of list) {
    if (!g.attributes.normal) g.computeVertexNormals(); const p = g.attributes.position, n = g.attributes.normal, t = g.attributes.uv;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); if (t) uv.push(t.getX(i), t.getY(i)); else uv.push(0, 0); }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i)); else for (let i = 0; i < p.count; i++) idx.push(base + i);
    base += p.count;
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeBoundingSphere(); return g;
}

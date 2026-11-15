// @gcp/materials.js · parts — models built in code from real-sized parts, the way the sample games make crates,
// forklifts and containers. Everything is in metres, and every part gets UVs in metres, so a material shows the same
// brick or plank size on every face of every part. Boxes have a small bevel by default: a 1 cm rounded edge catches
// the light, and that one detail is most of what separates a made object from a grey box.
// Parts that share a material are merged into one geometry, so a whole model is one draw call per material.
import * as THREE from 'three';
import { material } from './material.js';

const V = new THREE.Vector3(), Q = new THREE.Quaternion(), E = new THREE.Euler(), ONE = new THREE.Vector3(1, 1, 1), UP = new THREE.Vector3(0, 1, 0);
const mtx = (pos = [0, 0, 0], rot = null, scale = null) => new THREE.Matrix4().compose(V.set(pos[0], pos[1], pos[2]), rot ? Q.setFromEuler(E.set(rot[0] || 0, rot[1] || 0, rot[2] || 0)) : Q.identity(), scale ? new THREE.Vector3().fromArray(scale) : ONE);

/**
 * A box w x h x d (metres) centred on its origin, with edges rounded by `bevel` (metres; 0 for sharp) and UVs in
 * metres on every face. 24 vertices: cheap enough for hundreds of them.
 */
export function bevelBox(w, h, d, bevel = 0.01) {
  const r = Math.max(0, Math.min(bevel, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
  if (r <= 1e-4) { const g = new THREE.BoxGeometry(w, h, d), uv = g.attributes.uv, dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]; for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) { const i = f * 4 + k; uv.setXY(i, uv.getX(i) * dims[f][0], uv.getY(i) * dims[f][1]); } return g; }
  const x = w / 2, y = h / 2, z = d / 2, pos = new Float32Array(72), nor = new Float32Array(72), uv = new Float32Array(48);
  const vi = (sx, sy, sz, a) => (((sx > 0 ? 1 : 0) + (sy > 0 ? 2 : 0) + (sz > 0 ? 4 : 0)) * 3 + a);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const P = [[sx * x, sy * (y - r), sz * (z - r)], [sx * (x - r), sy * y, sz * (z - r)], [sx * (x - r), sy * (y - r), sz * z]], N = [[sx, 0, 0], [0, sy, 0], [0, 0, sz]];
    for (let a = 0; a < 3; a++) { const i = vi(sx, sy, sz, a); pos.set(P[a], i * 3); nor.set(N[a], i * 3); const p = P[a]; if (a === 0) uv.set([-sx * p[2] + z, p[1] + y], i * 2); else if (a === 1) uv.set([p[0] + x, -sy * p[2] + z], i * 2); else uv.set([sz * p[0] + x, p[1] + y], i * 2); }
  }
  const idx = [], tri = (a, b, c) => { // wind outward: the face normal must point away from the centre
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2], ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az, wx = pos[c * 3] - ax, wy = pos[c * 3 + 1] - ay, wz = pos[c * 3 + 2] - az;
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, cx = ax + (ux + wx) / 3, cy = ay + (uy + wy) / 3, cz = az + (uz + wz) / 3;
    if (nx * cx + ny * cy + nz * cz >= 0) idx.push(a, b, c); else idx.push(a, c, b);
  };
  const quad = (a, b, c, d2) => { tri(a, b, c); tri(a, c, d2); };
  const S = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const s of [-1, 1]) {
    quad(...S.map(([p, q]) => vi(s, p, q, 0)));          // x faces
    quad(...S.map(([p, q]) => vi(p, s, q, 1)));          // y faces
    quad(...S.map(([p, q]) => vi(p, q, s, 2)));          // z faces
  }
  for (const a of [-1, 1]) for (const b of [-1, 1]) {   // the twelve bevelled edges
    quad(vi(-1, a, b, 1), vi(1, a, b, 1), vi(1, a, b, 2), vi(-1, a, b, 2));   // along x: between y and z faces
    quad(vi(a, -1, b, 0), vi(a, 1, b, 0), vi(a, 1, b, 2), vi(a, -1, b, 2));   // along y: between x and z faces
    quad(vi(a, b, -1, 0), vi(a, b, 1, 0), vi(a, b, 1, 1), vi(a, b, -1, 1));   // along z: between x and y faces
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) tri(vi(sx, sy, sz, 0), vi(sx, sy, sz, 1), vi(sx, sy, sz, 2));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
  return g;
}

/**
 * A surface of revolution around the y axis from a profile [[radius, y], …] (bottom to top), with UVs in metres:
 * u runs round the widest circumference, v along the profile. Barrels, bottles, lamp posts, vases, columns, pots.
 */
export function lathe(profile, segments = 16) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y)), g = new THREE.LatheGeometry(pts, segments), uv = g.attributes.uv;
  let len = 0; const acc = [0]; for (let i = 1; i < pts.length; i++) { len += pts[i].distanceTo(pts[i - 1]); acc.push(len); }
  const rmax = Math.max(...pts.map((p) => p.x)), circ = Math.PI * 2 * rmax, n = pts.length;
  const nor = g.attributes.normal, pos = g.attributes.position;
  for (let i = 0; i < uv.count; i++) { const j = i % n; if (Math.abs(nor.getY(i)) > 0.92) uv.setXY(i, pos.getX(i) + rmax, pos.getZ(i) + rmax); else uv.setXY(i, uv.getX(i) * circ, acc[j]); }   // flat caps: planar
  return g;
}
/** A cylinder (bottom at y = 0) with rounded rims of `bevel` metres; r2 makes it a cone frustum. UVs in metres. */
export function roundCylinder(r, h, { r2 = r, bevel = 0.01, segments = 16, open = false } = {}) {
  const b = Math.max(0, Math.min(bevel, r * 0.45, r2 * 0.45, h * 0.45)), prof = [];
  if (!open) prof.push([0, 0]);
  if (b > 0) prof.push([r - b, 0], [r - b * 0.3, b * 0.3], [r, b], [r2, h - b], [r2 - b * 0.3, h - b * 0.3], [r2 - b, h]); else prof.push([r * 0.995, 0], [r, h * 0.002], [r2, h * 0.998], [r2 * 0.995, h]);
  if (!open) prof.push([0, h]);
  return lathe(prof, segments);
}
/** A sphere of radius r with UVs in metres. */
export function sphere(r, wSeg = 16, hSeg = 10) { const g = new THREE.SphereGeometry(r, wSeg, hSeg), uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r, uv.getY(i) * Math.PI * r); return g; }
/** A tube of radius r along a smooth path through points [[x, y, z], …]; UVs in metres (along, around). Pipes, cables, ropes, rails, handles. */
export function tube(points, r, { segments, radial = 8, closed = false, tension = 0.5 } = {}) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), closed, 'catmullrom', tension), len = curve.getLength();
  const g = new THREE.TubeGeometry(curve, segments || Math.max(2, Math.ceil(len / 0.08) + points.length * 2), r, radial, closed), uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len, uv.getY(i) * Math.PI * 2 * r);
  return g;
}
/** An extruded outline [[x, y], …] (metres) of `depth` along z, centred on z = 0, with an optional rounded bevel. Signs, gears, brackets, arches, steps, logos. */
export function extrude(outline, depth, { bevel = 0.005, holes = [], curveSegments = 8 } = {}) {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(1e-4, depth - bevel * 2), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments });
  g.translate(0, 0, -depth / 2 + bevel); return g;
}
/** A flat w x h rectangle facing +z with UVs in metres. */
export function plane(w, h) { const g = new THREE.PlaneGeometry(w, h), uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h); return g; }

/** Joins indexed or plain geometries (position, normal, uv) into one indexed geometry. */
export function mergeGeometries(list) {
  let nv = 0, ni = 0; const ready = list.map((g) => { if (!g.attributes.normal) g.computeVertexNormals(); nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; return g; });
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let ov = 0, oi = 0;
  for (const g of ready) {
    const p = g.attributes.position, n = g.attributes.normal, t = g.attributes.uv, c = p.count;
    for (let i = 0; i < c; i++) { pos[(ov + i) * 3] = p.getX(i); pos[(ov + i) * 3 + 1] = p.getY(i); pos[(ov + i) * 3 + 2] = p.getZ(i); nor[(ov + i) * 3] = n.getX(i); nor[(ov + i) * 3 + 1] = n.getY(i); nor[(ov + i) * 3 + 2] = n.getZ(i); if (t) { uv[(ov + i) * 2] = t.getX(i); uv[(ov + i) * 2 + 1] = t.getY(i); } }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[oi++] = g.index.getX(i) + ov; else for (let i = 0; i < c; i++) idx[oi++] = i + ov;
    ov += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); out.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingBox(); out.computeBoundingSphere(); return out;
}

// ---- text and signs ----
const LABELS = new Map();
/** A material showing text (or an emoji) painted on a transparent canvas: signs, numbers, stencils, posters. Cached. */
export function labelMaterial(text, { color = '#f2efe6', background = null, font = 'bold 72px system-ui, sans-serif', padding = 18, worn = 0.25 } = {}) {
  const key = [text, color, background, font, padding, worn].join('|'); let m = LABELS.get(key);
  if (m) return m;
  const c = document.createElement('canvas'), g = c.getContext('2d'); g.font = font;
  const tw = Math.ceil(g.measureText(text).width), size = parseInt(/(\d+)px/.exec(font)?.[1] || '72', 10);
  c.width = tw + padding * 2; c.height = Math.ceil(size * 1.3) + padding * 2;
  if (background) { g.fillStyle = background; g.fillRect(0, 0, c.width, c.height); }
  g.font = font; g.fillStyle = color; g.textBaseline = 'middle'; g.fillText(text, padding, c.height / 2);
  if (worn > 0) { g.globalCompositeOperation = 'destination-out'; let s = 9; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647); for (let i = 0; i < c.width * c.height * worn / 90; i++) { g.globalAlpha = 0.3 + rnd() * 0.7; g.fillRect(rnd() * c.width, rnd() * c.height, 1 + rnd() * 3, 1 + rnd() * 2); } g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  m = new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.6, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  m.userData.aspect = c.width / c.height; m.userData.shared = true; LABELS.set(key, m); return m;
}

/**
 * A model builder. Add parts in metres, then build() returns a kind (the same shape as craft's prop() and tree():
 * place(kind, x, y, z) and scatter() take it) or group() returns a ready THREE.Group.
 *   const p = parts();
 *   p.box('planks_old', [1, 0.6, 0.6], [0, 0.3, 0]);                     // size, centre
 *   p.cylinder('steel_rusty', 0.05, 0.8, [0.4, 0, 0]);                     // radius, height, base centre
 *   p.bar('iron_dark', [-0.5, 0.6, 0.3], [0.5, 0.6, 0.3], 0.015);          // a round bar between two points
 *   p.push([0, 0.6, 0], [0, 0.4, 0]); p.box('paint_red', [0.3, 0.2, 0.3], [0, 0.1, 0]); p.pop();
 *   const crateKind = p.build('crate');                                     // or p.group()
 * The material of a part: a name ('planks_old'), a recipe ({ base: 'metal', paint: '#2a5' }), or any THREE.Material.
 * Part options: rot ([x, y, z] radians), bevel (box edges, metres), segments, shadow (false: casts none).
 */
export function parts(opts = {}) {
  const buckets = new Map(), stack = []; let m = null; const colliders = []; const matOpts = opts.material || {};
  const resolve = (mat) => mat && mat.isMaterial ? mat : material(mat, matOpts);
  const self = {
    /** Adds any BufferGeometry (UVs in metres for the textures to keep their size) with a position and rotation. */
    add(mat, geo, pos, rot, o = {}) {
      const mm = resolve(mat); geo.applyMatrix4(mtx(pos, rot, o.scale)); if (m) geo.applyMatrix4(m);
      let b = buckets.get(mm); if (!b) { b = { material: mm, geos: [], shadow: o.shadow !== false }; buckets.set(mm, b); } b.geos.push(geo); return self;
    },
    /** A box: size [w, h, d], centre [x, y, z]. Rounded edges of 1 cm unless o.bevel says otherwise. */
    box(mat, size, pos, o = {}) { return self.add(mat, bevelBox(size[0], size[1], size[2], o.bevel ?? Math.min(0.012, Math.min(...size) * 0.2)), pos, o.rot, o); },
    /** A cylinder standing on pos (its base centre): radius, height; o.r2 (top radius), o.bevel, o.segments, o.open. */
    cylinder(mat, r, h, pos, o = {}) { return self.add(mat, roundCylinder(r, h, { r2: o.r2 ?? r, bevel: o.bevel ?? Math.min(0.01, r * 0.2), segments: o.segments ?? Math.max(10, Math.min(32, Math.round(r * 60))), open: o.open }), pos, o.rot, o); },
    /** A sphere of radius r centred on pos. */
    sphere(mat, r, pos, o = {}) { return self.add(mat, sphere(r, o.segments ?? 16, Math.ceil((o.segments ?? 16) * 0.6)), pos, o.rot, o); },
    /** A shape turned on a lathe: profile [[radius, y], …] bottom to top, standing on pos. */
    lathe(mat, profile, pos, o = {}) { return self.add(mat, lathe(profile, o.segments ?? 18), pos, o.rot, o); },
    /** A tube of radius r along a smooth path through points (already in model space). */
    tube(mat, points, r, o = {}) { return self.add(mat, tube(points, r, o), [0, 0, 0], null, o); },
    /** A round bar from point a to point b; o.r2 for a taper, o.caps false for an open pipe. */
    bar(mat, a, b, r, o = {}) {
      const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), len = d.length(), g = roundCylinder(r, len, { r2: o.r2 ?? r, bevel: o.bevel ?? 0, segments: o.segments ?? 8, open: o.caps === false });
      g.translate(0, -len / 2, 0); g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()), ONE));
      return self.add(mat, g, [0, 0, 0], null, o);
    },
    /** A square beam [w, d] in cross-section from point a to point b: rafters, braces, legs, frames. o.twist (radians). */
    beam(mat, a, b, section, o = {}) {
      const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), len = d.length(), g = bevelBox(section[0], len, section[1], o.bevel ?? Math.min(0.008, Math.min(...section) * 0.2));
      const q = new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()); if (o.twist) q.multiply(new THREE.Quaternion().setFromAxisAngle(UP, o.twist));
      g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, ONE));
      return self.add(mat, g, [0, 0, 0], null, o);
    },
    /** An outline [[x, y], …] extruded by depth along z, centred on pos. o.holes, o.bevel. */
    extrude(mat, outline, depth, pos, o = {}) { return self.add(mat, extrude(outline, depth, o), pos, o.rot, o); },
    /** A flat rectangle [w, h] facing +z (rotate it with o.rot). */
    plane(mat, size, pos, o = {}) { return self.add(mat, plane(size[0], size[1]), pos, o.rot, { shadow: false, ...o }); },
    /** Text on a surface: height in metres, centred on pos, facing +z (o.rot to turn it). o.color, o.background, o.font, o.worn. */
    label(text, height, pos, o = {}) { const lm = labelMaterial(String(text), o); return self.add(lm, new THREE.PlaneGeometry(height * lm.userData.aspect, height), pos, o.rot, { shadow: false }); },
    /** Everything added until pop() is moved and turned by this: pos [x, y, z], rot [x, y, z]. */
    push(pos, rot, scale) { stack.push(m); const t = mtx(pos, rot, scale); m = m ? m.clone().multiply(t) : t; return self; },
    pop() { m = stack.pop() || null; return self; },
    /** Adds a solid box for collisions: min and max corners. Without any, build() uses the model's bounding box. */
    collider(min, max) { colliders.push({ min, max }); return self; },
    /** The parts merged per material: [{ geometry, material, shadow }]. */
    parts() { return [...buckets.values()].map((b) => ({ geometry: mergeGeometries(b.geos), material: b.material, shadow: b.shadow })); },
    /**
     * The model as a kind, the shape craft's place() and scatter() take: { name, parts, radius, height, solid, size,
     * colliders }. size is the bounding box [w, h, d]; colliders default to that box.
     */
    build(name = 'model', info = {}) {
      const ps = self.parts(), box = new THREE.Box3(); for (const p of ps) box.union(p.geometry.boundingBox);
      const size = box.isEmpty() ? [0, 0, 0] : [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
      const radius = box.isEmpty() ? 0 : Math.hypot(Math.max(-box.min.x, box.max.x), Math.max(-box.min.z, box.max.z));
      return { name, parts: ps, radius, height: box.isEmpty() ? 0 : box.max.y, solid: true, size, bounds: box, colliders: colliders.length ? colliders : box.isEmpty() ? [] : [{ min: box.min.toArray(), max: box.max.toArray() }], ...info };
    },
    /** The model as a THREE.Group of meshes (shadows on), ready to add to a scene. */
    group(name) { return toGroup(self.build(name)); },
  };
  return self;
}

/** A kind (from parts().build() or model()) as a THREE.Group with shadows on, for scenes that do not use craft's place(). */
export function toGroup(kind) {
  const g = new THREE.Group(); g.name = kind.name;
  for (const p of kind.parts) { const mesh = new THREE.Mesh(p.geometry, p.material); mesh.castShadow = p.shadow !== false && !p.material.transparent; mesh.receiveShadow = true; g.add(mesh); }
  g.userData.kind = kind; g.userData.colliders = kind.colliders; g.userData.size = kind.size; return g;
}

// @gcp/materials.js · models — ready props built with parts() and the realistic materials: real sizes in metres,
// bevelled edges, weathering, and a seed that varies each copy. Every model is a kind, so craft's place() and
// scatter() take it, and toGroup() turns it into a THREE.Group for any other scene.
import * as THREE from 'three';
import { mulberry32 } from '../procgen/noise.js';
import { parts } from './parts.js';
import { defineRecipe } from '../procgen/recipe.js';

const TAU = Math.PI * 2;
const glow = new Map();
/** A bright emissive material for lamps, screens and fires (bloom picks it up). */
export function glowingMaterial(color = 0xffd9a0, intensity = 3) {
  const k = color + '|' + intensity; let m = glow.get(k);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: color, emissiveIntensity: intensity, roughness: 0.4 }); m.userData.shared = true; glow.set(k, m); }
  return m;
}
const pick = (r, list) => list[Math.floor(r() * list.length) % list.length];
const mat = (o, key, d) => o[key] ?? d;
const painted = (color, o = {}) => (color == null ? null : { base: 'metal', paint: color, chips: 0.35, scratches: 0.4, wear: 0.3, dirt: 0.25, ...o });
// end grain on a disc: the rings centred on the log
function logEnd(p, r, pos, rot, matName = 'log_end') {
  const g = new THREE.CircleGeometry(r, 14), uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.5, uv.getY(i) * 0.5);
  return p.add(matName, g, pos, rot);
}

const MD = {};
const def = (name, doc, fn) => { MD[name] = { doc, fn }; };

// ------------------------------------------------------------------ storage and clutter
def('crate', 'a slatted wooden crate (size: edge in metres, material)', (o, r) => {
  const s = o.size ?? 0.8, m = mat(o, 'material', pick(r, ['planks', 'planks_old', 'wood_light'])), p = parts(), t = 0.022, w = s * 0.12;
  const slats = 4, gap = (s - slats * w * 1.6) / (slats - 1);
  for (const side of [-1, 1]) for (const ax of [0, 1]) for (let i = 0; i < slats; i++) {
    const y = w * 0.8 + i * (w * 1.6 + gap), size = ax ? [t, w * 1.6, s - 2 * t] : [s - 2 * t, w * 1.6, t], pos = ax ? [side * (s / 2 - t / 2), y, 0] : [0, y, side * (s / 2 - t / 2)];
    p.box(m, size, pos);
  }
  for (const x of [-1, 1]) for (const z of [-1, 1]) p.box(m, [w, s, w], [x * (s / 2 - w / 2), s / 2, z * (s / 2 - w / 2)]);   // corner posts
  p.box(m, [s - t, t, s - t], [0, t / 2, 0]); p.box(m, [s - t, t, s - t], [0, s - t / 2, 0]);
  for (const z of [-1, 1]) p.beam(m, [-s / 2 + w, w, z * (s / 2 + 0.002)], [s / 2 - w, s - w, z * (s / 2 + 0.002)], [w * 0.8, t]);   // diagonal brace
  return p.build('crate');
});
def('pallet', 'a wooden shipping pallet, 1.2 x 1.0 m', (o) => {
  const m = mat(o, 'material', 'planks_old'), p = parts();
  for (let i = 0; i < 7; i++) p.box(m, [0.1, 0.022, 1.0], [-0.55 + i * (1.1 / 6), 0.133, 0]);
  for (const z of [-0.45, 0, 0.45]) { p.box(m, [1.2, 0.022, 0.1], [0, 0.111, z]); for (const x of [-0.55, 0, 0.55]) p.box(m, [0.1, 0.078, 0.1], [x, 0.061, z]); }
  for (let i = 0; i < 3; i++) p.box(m, [0.1, 0.022, 1.0], [-0.55 + i * 0.55, 0.011, 0]);
  return p.build('pallet');
});
def('barrel', 'a wooden barrel with iron hoops (height)', (o) => {
  const h = o.height ?? 0.9, p = parts(), wood = mat(o, 'material', { base: 'planks', p: [12, 0, 0, 0], color: 0x7a5232, dirt: 0.3 }), iron = mat(o, 'hoops', 'iron_dark');
  const prof = []; for (let i = 0; i <= 10; i++) { const y = (i / 10) * h, k = 1 - Math.pow((i / 10) * 2 - 1, 2); prof.push([h * 0.3 + h * 0.06 * k, y]); }
  p.lathe(wood, [[0, 0.01], [h * 0.29, 0.01], ...prof, [h * 0.29, h - 0.01], [0, h - 0.01]], [0, 0, 0], { segments: 20 });
  for (const f of [0.1, 0.3, 0.7, 0.9]) { const k = 1 - Math.pow(f * 2 - 1, 2), rr = h * 0.3 + h * 0.06 * k + 0.004; p.lathe(iron, [[rr, -0.02], [rr + 0.004, -0.015], [rr + 0.004, 0.015], [rr, 0.02]], [0, f * h, 0], { segments: 20 }); }
  return p.build('barrel');
});
def('drum', 'a steel oil drum, 200 litres (color: paint colour or null for bare, rust 0..1)', (o, r) => {
  const p = parts(), color = o.color ?? pick(r, [0x22457a, 0x9b2a22, 0x2f5a3a, 0xc9961c, 0x3a3d40]);
  const m = color == null ? { base: 'metal', rust: o.rust ?? 0.4 } : painted(color, { rust: o.rust ?? 0.25, chips: 0.5 });
  p.cylinder(m, 0.29, 0.88, [0, 0, 0], { bevel: 0.015, segments: 24 });
  for (const y of [0.29, 0.59]) p.lathe(m, [[0.29, -0.012], [0.297, 0], [0.29, 0.012]], [0, y, 0], { segments: 24 });
  p.lathe(m, [[0.282, 0.88], [0.288, 0.9], [0.27, 0.9], [0.27, 0.885]], [0, 0, 0], { segments: 24 });
  p.cylinder('steel', 0.025, 0.012, [0.17, 0.88, 0.05]);
  return p.build('drum');
});
def('gas_cylinder', 'a tall gas bottle with a valve (color)', (o, r) => {
  const p = parts(), m = painted(o.color ?? pick(r, [0x9b2a22, 0x1c1d1f, 0x2f5a3a, 0xd8d4c8]), { chips: 0.3 });
  p.lathe(m, [[0, 0], [0.11, 0], [0.115, 0.03], [0.115, 1.05], [0.1, 1.15], [0.05, 1.22], [0.025, 1.24], [0, 1.24]], [0, 0, 0], { segments: 18 });
  p.cylinder('brass', 0.018, 0.08, [0, 1.24, 0]); p.bar('brass', [0, 1.3, 0], [0.05, 1.3, 0], 0.01);
  return p.build('gas_cylinder');
});
def('sandbags', 'a low wall of sandbags (length in metres, rows)', (o, r) => {
  const p = parts(), len = o.length ?? 2, rows = o.rows ?? 3, m = mat(o, 'material', { base: 'tarp', color: 0x8a7a58, dirt: 0.5 });
  for (let row = 0; row < rows; row++) { const n = Math.max(1, Math.round(len / 0.55)), off = row % 2 ? 0.27 : 0; for (let i = 0; i < n - (row % 2); i++) {
    const g = new THREE.SphereGeometry(0.5, 12, 8); g.scale(0.56, 0.16, 0.34); const pos = g.attributes.position; for (let k = 0; k < pos.count; k++) { const y = pos.getY(k); if (y < -0.05) pos.setY(k, -0.05 - (y + 0.05) * 0.2); }
    g.computeVertexNormals(); const uv = g.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 1.3, uv.getY(k) * 0.6);
    p.add(m, g, [-len / 2 + 0.28 + off + i * 0.55, 0.07 + row * 0.15, (r() - 0.5) * 0.04], [0, (r() - 0.5) * 0.15, (r() - 0.5) * 0.05]); } }
  return p.build('sandbags');
});
def('log_pile', 'stacked logs with bark and cut ends (length, count)', (o, r) => {
  const p = parts(), len = o.length ?? 2.4, rows = o.rows ?? 3;
  for (let row = 0; row < rows; row++) { const n = rows - row + 1; for (let i = 0; i < n; i++) {
    const rr = 0.13 + r() * 0.04, x = (i - (n - 1) / 2) * 0.3, y = 0.15 + row * 0.26, z = (r() - 0.5) * 0.15;
    p.push([x, y, z], [0, 0, Math.PI / 2]); p.cylinder('bark', rr, len, [0, -len / 2, 0], { segments: 12, open: true }); logEnd(p, rr * 0.98, [0, -len / 2, 0], [Math.PI / 2, 0, 0]); logEnd(p, rr * 0.98, [0, len / 2, 0], [-Math.PI / 2, 0, 0]); p.pop();
  } }
  return p.build('log_pile');
});
def('hay_bale', 'a rectangular straw bale tied with twine', () => {
  const p = parts(); p.box('thatch', [1.0, 0.45, 0.5], [0, 0.225, 0], { bevel: 0.05 });
  for (const x of [-0.25, 0.25]) p.box({ base: 'fabric', color: 0x8a6a3a }, [0.012, 0.462, 0.512], [x, 0.225, 0], { bevel: 0.004 });
  return p.build('hay_bale');
});
def('cardboard_boxes', 'a small stack of taped cardboard boxes', (o, r) => {
  const p = parts(); let y = 0;
  for (let i = 0; i < (o.count ?? 3); i++) { const w = 0.35 + r() * 0.25, h = 0.25 + r() * 0.2, d = 0.3 + r() * 0.2; p.push([(r() - 0.5) * 0.1, y, (r() - 0.5) * 0.1], [0, (r() - 0.5) * 0.4, 0]); p.box('cardboard', [w, h, d], [0, h / 2, 0], { bevel: 0.006 }); p.box({ base: 'plastic', color: 0xb8a070 }, [0.05, 0.003, d + 0.004], [0, h + 0.001, 0], { bevel: 0 }); p.pop(); y += h; }
  return p.build('cardboard_boxes');
});

// ------------------------------------------------------------------ yard and street
def('container', 'a steel shipping container, 20 or 40 ft (length: 6 or 12, color, number)', (o, r) => {
  const L = o.length ?? 6.06, W = 2.44, H = 2.59, p = parts(), color = o.color ?? pick(r, [0x9b2a22, 0x22457a, 0x2f5a3a, 0xc0561c, 0x5a5e62]);
  const wall = { base: 'corrugated', paint: color, chips: 0.3, rust: 0.25, dirt: 0.3, leaks: 0.5, gloss: 0.55 }, frame = painted(color, { rust: 0.3, chips: 0.5 });
  for (const s of [-1, 1]) { p.add(wall, planeUV(L - 0.3, H - 0.3), [0, H / 2, s * (W / 2 - 0.02)], [0, s > 0 ? 0 : Math.PI, 0]); }
  p.add(wall, planeUV(W - 0.3, H - 0.3), [-L / 2 + 0.02, H / 2, 0], [0, -Math.PI / 2, 0]); p.box(wall, [L - 0.1, 0.05, W - 0.1], [0, H - 0.04, 0], { bevel: 0.01 });
  for (const x of [-1, 1]) for (const z of [-1, 1]) { p.box(frame, [0.16, H, 0.16], [x * (L / 2 - 0.08), H / 2, z * (W / 2 - 0.08)], { bevel: 0.01 }); p.box('steel', [0.18, 0.12, 0.18], [x * (L / 2 - 0.08), 0.06, z * (W / 2 - 0.08)]); p.box('steel', [0.18, 0.12, 0.18], [x * (L / 2 - 0.08), H - 0.06, z * (W / 2 - 0.08)]); }
  for (const y of [0.08, H - 0.08]) for (const z of [-1, 1]) p.box(frame, [L - 0.3, 0.14, 0.12], [0, y, z * (W / 2 - 0.06)]);
  for (const y of [0.08, H - 0.08]) p.box(frame, [0.12, 0.14, W - 0.3], [L / 2 - 0.06, y, 0]);
  // the doors and their locking bars
  for (const z of [-1, 1]) { p.box(wall, [0.05, H - 0.3, W / 2 - 0.12], [L / 2 - 0.03, H / 2, z * (W / 4 - 0.03)], { bevel: 0.008 }); for (const k of [0.3, 0.7]) p.bar('galvanized', [L / 2 + 0.02, 0.2, z * (W / 2 - 0.12) * k * 1.3], [L / 2 + 0.02, H - 0.2, z * (W / 2 - 0.12) * k * 1.3], 0.016); }
  p.label(o.number ?? `GCPU ${String(100000 + Math.floor(r() * 899999))} ${Math.floor(r() * 9)}`, 0.16, [L / 2 + 0.03, H - 0.42, -W / 4], { rot: [0, Math.PI / 2, 0], color: '#eeeae0', worn: 0.35 });
  return p.build('container', { colliders: [{ min: [-L / 2, 0, -W / 2], max: [L / 2, H, W / 2] }] });
});
function planeUV(w, h) { const g = new THREE.PlaneGeometry(w, h), uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h); return g; }
def('barrier', 'a concrete road barrier, 3 m (stripes: true for hazard paint)', (o) => {
  const p = parts(), L = o.length ?? 3, m = mat(o, 'material', 'concrete_dirty');
  p.extrude(m, [[-0.3, 0], [0.3, 0], [0.3, 0.08], [0.12, 0.33], [0.1, 0.81], [-0.1, 0.81], [-0.12, 0.33], [-0.3, 0.08]], L, [0, 0, 0], { rot: [0, Math.PI / 2, 0], bevel: 0.015 });
  if (o.stripes !== false) for (let i = 0; i < 5; i++) p.box({ base: 'plastic', paint: i % 2 ? 0x1c1d1f : 0xc9961c, chips: 0.6 }, [L / 5, 0.12, 0.004], [-L / 2 + L / 10 + i * L / 5, 0.68, 0.104], { bevel: 0 });
  return p.build('barrier');
});
def('traffic_cone', 'an orange traffic cone, 70 cm', () => {
  const p = parts(); p.box('rubber', [0.36, 0.035, 0.36], [0, 0.0175, 0], { bevel: 0.01 });
  p.lathe({ base: 'plastic', color: 0xd2541c, dirt: 0.3 }, [[0.15, 0.035], [0.025, 0.7], [0, 0.7]], [0, 0, 0], { segments: 18 });
  p.lathe('plastic_white', [[0.1, 0.32], [0.075, 0.45], [0.074, 0.451], [0.101, 0.321]], [0, 0, 0], { segments: 18 });
  return p.build('traffic_cone');
});
def('lamp_post', 'a street lamp that lights up when placed (height, color of the light)', (o) => {
  const p = parts(), h = o.height ?? 4.5, m = mat(o, 'material', painted(0x2a2d30, { chips: 0.2 }));
  p.cylinder('concrete', 0.18, 0.25, [0, 0, 0], { bevel: 0.02 }); p.cylinder(m, 0.07, h, [0, 0.25, 0], { r2: 0.045, segments: 14 });
  p.tube(m, [[0, h + 0.1, 0], [0, h + 0.35, 0.15], [0, h + 0.4, 0.6]], 0.035);
  p.box(m, [0.22, 0.08, 0.44], [0, h + 0.38, 0.75], { bevel: 0.02 }); p.add(glowingMaterial(o.color ?? 0xffd9a0, 4), planeUV(0.18, 0.38), [0, h + 0.338, 0.75], [Math.PI / 2, 0, 0], { shadow: false });
  return p.build('lamp_post', { light: { color: o.color ?? 0xffd9a0, intensity: 6, distance: 14, x: 0, y: h + 0.2, z: 0.75 } });
});
def('bench', 'a park bench with wooden slats and iron legs (length)', (o) => {
  const p = parts(), L = o.length ?? 1.6, wood = mat(o, 'material', 'wood_light'), iron = 'iron_dark';
  for (let i = 0; i < 4; i++) p.box(wood, [L, 0.035, 0.09], [0, 0.45, -0.18 + i * 0.105]);
  for (let i = 0; i < 3; i++) p.box(wood, [L, 0.09, 0.03], [0, 0.6 + i * 0.12, 0.25 + i * 0.02], { rot: [-0.18, 0, 0] });
  for (const x of [-L / 2 + 0.15, L / 2 - 0.15]) { p.extrude(iron, [[-0.25, 0], [-0.2, 0], [-0.05, 0.43], [0.2, 0.43], [0.25, 0], [0.3, 0], [0.26, 0.47], [0.33, 0.95], [0.28, 0.96], [0.2, 0.47], [-0.1, 0.47]], 0.04, [x, 0, 0], { rot: [0, Math.PI / 2, 0], bevel: 0.006 }); }
  return p.build('bench');
});
def('fence', 'a wooden post-and-rail fence section (length, height)', (o, r) => {
  const p = parts(), L = o.length ?? 3, h = o.height ?? 1.1, m = mat(o, 'material', 'planks_old'), n = Math.max(1, Math.round(L / 1.5));
  for (let i = 0; i <= n; i++) p.box(m, [0.11, h + 0.05, 0.11], [-L / 2 + (i * L) / n, (h + 0.05) / 2, 0], { rot: [0, (r() - 0.5) * 0.1, (r() - 0.5) * 0.03] });
  for (const y of [h * 0.35, h * 0.8]) p.box(m, [L, 0.12, 0.035], [0, y, 0.075], { rot: [0, 0, (r() - 0.5) * 0.02] });
  return p.build('fence', { colliders: [{ min: [-L / 2, 0, -0.1], max: [L / 2, h, 0.1] }] });
});
def('railing', 'a galvanised steel railing (length)', (o) => {
  const p = parts(), L = o.length ?? 3, m = mat(o, 'material', 'galvanized'), n = Math.max(1, Math.round(L / 1.5));
  for (let i = 0; i <= n; i++) p.cylinder(m, 0.024, 1.05, [-L / 2 + (i * L) / n, 0, 0]);
  for (const y of [0.5, 1.05]) p.bar(m, [-L / 2, y, 0], [L / 2, y, 0], 0.022, { caps: true });
  return p.build('railing', { colliders: [{ min: [-L / 2, 0, -0.05], max: [L / 2, 1.1, 0.05] }] });
});
def('signpost', 'a post with a sign board and text (text, color of the board)', (o) => {
  const p = parts(); p.box('wood', [0.1, 2.2, 0.1], [0, 1.1, 0]);
  p.box({ base: 'planks', paint: o.color ?? 0x2f5a3a, chips: 0.5, p: [3, 0, 0, 0] }, [1.0, 0.36, 0.04], [0, 1.85, 0.07]);
  p.label(o.text ?? 'WELCOME', 0.16, [0, 1.85, 0.092], { color: '#efe9da', worn: 0.3 });
  return p.build('signpost');
});

// ------------------------------------------------------------------ farm, village and workshop
def('well', 'a stone well with a little roof, winch and bucket', () => {
  const p = parts();
  for (let i = 0; i < 12; i++) { const a = (i / 12) * TAU; p.push([Math.cos(a) * 0.72, 0, Math.sin(a) * 0.72], [0, -a, 0]); p.box('stone_wall', [0.24, 0.8, 0.4], [0, 0.4, 0], { bevel: 0.03 }); p.pop(); }
  p.cylinder({ base: 'mud', color: 0x1c2a30 }, 0.6, 0.55, [0, 0, 0], { open: false });
  for (const x of [-0.8, 0.8]) p.box('wood_dark', [0.1, 1.9, 0.1], [x, 0.95 + 0.4, 0]);
  p.cylinder('wood', 0.06, 1.7, [-0.85, 1.55, 0], { rot: [0, 0, -Math.PI / 2] });
  for (const s of [-1, 1]) p.box('shingles', [2.0, 0.04, 0.85], [0, 2.45, s * 0.36], { rot: [s * 0.62, 0, 0] });
  p.bar({ base: 'fabric', color: 0x9a8058 }, [0.1, 1.55, 0], [0.1, 1.1, 0], 0.008);
  p.cylinder({ base: 'planks', p: [10, 0, 0, 0] }, 0.12, 0.2, [0.1, 0.9, 0], { r2: 0.14 });
  return p.build('well', { colliders: [{ min: [-0.95, 0, -0.95], max: [0.95, 0.8, 0.95] }] });
});
def('cart', 'a two-wheeled wooden hand cart', () => {
  const p = parts(), wood = 'planks_old';
  p.box(wood, [1.4, 0.05, 0.9], [0, 0.62, 0]); for (const s of [-1, 1]) p.box(wood, [1.4, 0.3, 0.04], [0, 0.78, s * 0.45]); p.box(wood, [0.04, 0.3, 0.9], [-0.7, 0.78, 0]);
  for (const s of [-1, 1]) p.beam('wood', [0.6, 0.6, s * 0.38], [1.7, 0.75, s * 0.32], [0.06, 0.06]);
  for (const s of [-1, 1]) { p.push([0.1, 0.45, s * 0.55], [Math.PI / 2, 0, 0]); p.cylinder('wood_dark', 0.45, 0.06, [0, -0.03, 0], { open: true, segments: 24 });
    p.lathe('iron_dark', [[0.45, -0.035], [0.47, -0.035], [0.47, 0.035], [0.45, 0.035]], [0, 0, 0], { segments: 24 }); p.cylinder('wood', 0.07, 0.12, [0, -0.06, 0]);
    for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU; p.bar('wood', [0, 0, 0], [Math.cos(a) * 0.44, 0, Math.sin(a) * 0.44], 0.02); } p.pop(); }
  p.bar('iron_dark', [0.1, 0.45, -0.6], [0.1, 0.45, 0.6], 0.025);
  return p.build('cart');
});
def('workbench', 'a heavy workbench with a vice and tools', () => {
  const p = parts(); p.box('wood_light', [1.8, 0.08, 0.7], [0, 0.88, 0], { bevel: 0.01 });
  for (const x of [-0.8, 0.8]) for (const z of [-0.28, 0.28]) p.box('wood', [0.08, 0.84, 0.08], [x, 0.42, z]);
  p.box('planks', [1.7, 0.03, 0.6], [0, 0.18, 0]); for (const z of [-0.28, 0.28]) p.box('wood', [1.6, 0.08, 0.05], [0, 0.18, z]);
  p.box('iron_dark', [0.18, 0.12, 0.14], [0.7, 0.98, 0.3]); p.bar('steel', [0.7, 0.98, 0.37], [0.7, 0.98, 0.48], 0.012); p.bar('steel', [0.64, 0.98, 0.48], [0.76, 0.98, 0.48], 0.01);
  p.bar('wood', [-0.3, 0.935, 0.05], [-0.05, 0.935, 0.1], 0.015); p.box('iron_dark', [0.05, 0.04, 0.12], [-0.03, 0.94, 0.1], { rot: [0, 0.2, 0] });
  p.box({ base: 'metal', rust: 0.4 }, [0.32, 0.005, 0.12], [0.2, 0.923, -0.1], { rot: [0, 0.3, 0], bevel: 0 });
  return p.build('workbench');
});
def('anvil', 'a blacksmith anvil on a stump', () => {
  const p = parts(); p.cylinder('bark', 0.25, 0.5, [0, 0, 0], { open: true }); logEnd(p, 0.25, [0, 0.5, 0], [-Math.PI / 2, 0, 0]);
  p.extrude('iron_dark', [[-0.28, 0], [0.22, 0], [0.18, 0.06], [0.12, 0.08], [0.12, 0.2], [0.26, 0.22], [0.26, 0.3], [-0.22, 0.3], [-0.42, 0.27], [-0.22, 0.22], [-0.12, 0.2], [-0.12, 0.08], [-0.2, 0.06]], 0.16, [0, 0.5, 0], { bevel: 0.01 });
  return p.build('anvil');
});
def('trough', 'a long wooden water trough', () => {
  const p = parts(); for (const s of [-1, 1]) p.box('planks_old', [1.6, 0.4, 0.04], [0, 0.3, s * 0.25]); for (const s of [-1, 1]) p.box('planks_old', [0.04, 0.4, 0.54], [s * 0.8, 0.3, 0]);
  p.box('planks_old', [1.6, 0.04, 0.5], [0, 0.12, 0]); for (const x of [-0.65, 0.65]) p.box('wood', [0.08, 0.12, 0.6], [x, 0.06, 0]);
  p.add({ base: 'ice', color: 0x3a5a62 }, planeUV(1.52, 0.46), [0, 0.42, 0], [-Math.PI / 2, 0, 0], { shadow: false });
  return p.build('trough');
});
def('table', 'a wooden table (width, depth)', (o) => {
  const p = parts(), w = o.width ?? 1.6, d = o.depth ?? 0.9, m = mat(o, 'material', 'wood');
  p.box(m, [w, 0.05, d], [0, 0.75, 0], { bevel: 0.012 }); for (const x of [-1, 1]) for (const z of [-1, 1]) p.box(m, [0.07, 0.72, 0.07], [x * (w / 2 - 0.1), 0.36, z * (d / 2 - 0.1)]);
  for (const z of [-1, 1]) p.box(m, [w - 0.2, 0.1, 0.03], [0, 0.67, z * (d / 2 - 0.1)]);
  return p.build('table');
});
def('chair', 'a wooden chair', (o) => {
  const p = parts(), m = mat(o, 'material', 'wood');
  p.box(m, [0.45, 0.04, 0.45], [0, 0.46, 0]); for (const x of [-1, 1]) for (const z of [-1, 1]) p.box(m, [0.045, z > 0 ? 1.0 : 0.46, 0.045], [x * 0.19, (z > 0 ? 1.0 : 0.46) / 2, z * 0.19]);
  for (let i = 0; i < 3; i++) p.box(m, [0.38, 0.06, 0.025], [0, 0.64 + i * 0.14, 0.19]);
  return p.build('chair');
});
def('shelf', 'steel shelving with boxes and drums on it (width)', (o, r) => {
  const p = parts(), w = o.width ?? 2, m = mat(o, 'material', painted(0x22457a, { chips: 0.4 }));
  for (const x of [-1, 1]) for (const z of [-1, 1]) p.box(m, [0.05, 2.2, 0.05], [x * (w / 2 - 0.03), 1.1, z * 0.27], { bevel: 0.004 });
  for (const y of [0.15, 0.85, 1.55, 2.15]) { p.box('galvanized', [w, 0.03, 0.6], [0, y, 0], { bevel: 0.004 }); for (const z of [-1, 1]) p.box(m, [w, 0.08, 0.04], [0, y - 0.04, z * 0.29]); }
  for (const y of [0.18, 0.88, 1.58]) { let x = -w / 2 + 0.1; while (x < w / 2 - 0.4) { const bw = 0.25 + r() * 0.3, bh = 0.2 + r() * 0.35; if (r() < 0.75) p.box(pick(r, ['cardboard', 'plastic_blue', 'cardboard', 'plastic_red']), [bw, bh, 0.45], [x + bw / 2, y + bh / 2, 0], { bevel: 0.008 }); x += bw + 0.05; } }
  return p.build('shelf');
});

// ------------------------------------------------------------------ buildings
def('shed', 'a timber shed with a corrugated roof and a door (width, depth)', (o) => {
  const p = parts(), w = o.width ?? 3, d = o.depth ?? 2.4, h = 2.3, wall = mat(o, 'material', { base: 'planks', p: [10, 0, 0, 0], color: 0x6d5a44, dirt: 0.35, leaks: 0.3 });
  p.box('concrete', [w + 0.2, 0.15, d + 0.2], [0, 0.075, 0], { bevel: 0.02 });
  p.box(wall, [w, h, 0.05], [0, 0.15 + h / 2, -d / 2]); for (const s of [-1, 1]) p.box(wall, [0.05, h, d], [s * w / 2, 0.15 + h / 2, 0]);
  const dw = 0.9; for (const s of [-1, 1]) p.box(wall, [(w - dw) / 2, h, 0.05], [s * (w / 2 - (w - dw) / 4), 0.15 + h / 2, d / 2]);
  p.box(wall, [dw, 0.25, 0.05], [0, 0.15 + h - 0.125, d / 2]);
  p.box({ base: 'planks', paint: o.door ?? 0x2f5a3a, chips: 0.6, p: [5, 0, 0, 0] }, [dw - 0.04, h - 0.3, 0.04], [0, 0.15 + (h - 0.3) / 2, d / 2 + 0.01]);
  p.cylinder('brass', 0.025, 0.03, [0.32, 1.1, d / 2 + 0.03], { rot: [Math.PI / 2, 0, 0] });
  for (const s of [-1, 1]) p.box('corrugated_rusty', [w + 0.5, 0.03, d / 2 + 0.35], [0, 0.15 + h + 0.3, s * (d / 4 + 0.08)], { rot: [s * 0.32, 0, 0], bevel: 0.004 });
  for (const s of [-1, 1]) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([-d / 2, 0, 0, d / 2, 0, 0, 0, 0.36, 0], 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, d, 0, d / 2, 0.36], 2)); g.computeVertexNormals(); p.add(wall, g, [s * w / 2, 0.15 + h, 0], [0, s > 0 ? Math.PI / 2 : -Math.PI / 2, 0]); }
  return p.build('shed', { colliders: [{ min: [-w / 2, 0, -d / 2], max: [w / 2, h + 0.5, d / 2] }] });
});
def('cabin', 'a log cabin with a shingle roof, a door and a window (width, depth)', (o, r) => {
  const p = parts(), w = o.width ?? 5, d = o.depth ?? 4, rows = 9, lr = 0.13, h = rows * lr * 2 * 0.92;
  p.box('stone_wall', [w + 0.5, 0.35, d + 0.5], [0, 0.175, 0], { bevel: 0.04 });
  for (let i = 0; i < rows; i++) { const y = 0.35 + lr + i * lr * 2 * 0.92;
    for (const s of [-1, 1]) { p.push([0, y, s * d / 2], [0, 0, Math.PI / 2]); p.cylinder('bark', lr, w + 0.5, [0, -(w + 0.5) / 2, 0], { open: true, segments: 10 }); logEnd(p, lr, [0, -(w + 0.5) / 2, 0], [Math.PI / 2, 0, 0]); logEnd(p, lr, [0, (w + 0.5) / 2, 0], [-Math.PI / 2, 0, 0]); p.pop(); }
    for (const s of [-1, 1]) { p.push([s * w / 2, y + lr * 0.92, 0], [Math.PI / 2, 0, 0]); p.cylinder('bark', lr, d + 0.5, [0, -(d + 0.5) / 2, 0], { open: true, segments: 10 }); logEnd(p, lr, [0, -(d + 0.5) / 2, 0], [Math.PI / 2, 0, 0]); logEnd(p, lr, [0, (d + 0.5) / 2, 0], [-Math.PI / 2, 0, 0]); p.pop(); }
  }
  p.box({ base: 'planks', color: 0x5a3e28, p: [5, 0, 0, 0] }, [1.0, 2.0, 0.08], [w * 0.2, 0.35 + 1.0, d / 2 + lr + 0.02]);
  p.box('wood_dark', [1.2, 0.12, 0.12], [w * 0.2, 0.35 + 2.06, d / 2 + lr + 0.04]);
  p.box({ base: 'plastic', color: 0x1c252c }, [0.9, 0.8, 0.04], [-w * 0.22, 0.35 + 1.4, d / 2 + lr + 0.02]); p.box('wood_light', [1.05, 0.08, 0.1], [-w * 0.22, 0.35 + 0.98, d / 2 + lr + 0.05]);
  const rh = d * 0.38, ang = Math.atan2(rh, d / 2), rl = Math.hypot(rh, d / 2) + 0.5;
  for (const s of [-1, 1]) p.box('shingles', [w + 1.0, 0.06, rl], [0, 0.35 + h + rh / 2 + 0.1, s * (d / 4 + 0.12)], { rot: [s * ang, 0, 0], bevel: 0.01 });
  for (const s of [-1, 1]) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([-d / 2 - 0.1, 0, 0, d / 2 + 0.1, 0, 0, 0, rh, 0], 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, d, 0, d / 2, rh], 2)); g.computeVertexNormals(); p.add({ base: 'planks', color: 0x6d5038, p: [6, 0, 0, 0] }, g, [s * (w / 2 + lr * 0.5), 0.35 + h, 0], [0, s > 0 ? Math.PI / 2 : -Math.PI / 2, 0]); }
  p.box('stone_wall', [0.7, 1.6, 0.6], [-w / 2 + 0.6, 0.35 + h + 0.5, -d * 0.15], { bevel: 0.03 });
  return p.build('cabin', { colliders: [{ min: [-w / 2 - 0.25, 0, -d / 2 - 0.25], max: [w / 2 + 0.25, h + 0.35, d / 2 + 0.25] }] });
});

/** Every ready model: crate, pallet, barrel, drum, gas_cylinder, sandbags, log_pile, hay_bale, cardboard_boxes, container, barrier, traffic_cone, lamp_post, bench, fence, railing, signpost, well, cart, workbench, anvil, trough, table, chair, shelf, shed, cabin. */
export const MODELS = Object.keys(MD);
/** What each model is and the options it takes: { name: 'one line' }. */
export const MODEL_INFO = Object.fromEntries(Object.entries(MD).map(([k, v]) => [k, v.doc]));
const KINDS = new Map();
/**
 * A ready realistic model as a kind (cached by its options): place(model('crate'), x, y, z) from @gcp/craft.js, or
 * toGroup(model('cabin')) for any scene. Options: seed (a different copy: other planks, another colour), and the
 * model's own (see MODEL_INFO): size, length, height, width, depth, color, material, text, rows, count, rust.
 *   model('container', { length: 12, color: '#22457a' })   model('fence', { length: 6 })   model('signpost', { text: 'MILL' })
 */
export function model(name, opts = {}) {
  const d = MD[name]; if (!d) throw new Error(`Unknown model "${name}". Models: ${MODELS.join(', ')}.`);
  const key = name + JSON.stringify(opts); let k = KINDS.get(key);
  if (!k) { k = d.fn(opts, mulberry32(((opts.seed ?? 1) * 2654435761) >>> 0)); k.model = name; KINDS.set(key, k); }
  return k;
}

defineRecipe('model', { summary: 'A realistic ready model built from bevelled parts and baked materials.', params: { model: Object.keys(MD).join(' | '), seed: 'variation', color: 'main colour (drums, containers, cylinders)', length: 'metres (fences, containers, barriers, sandbags)', text: 'sign text' }, make: (p) => { const o = { ...p }; delete o.kind; delete o.v; delete o.model; return model(p.model || 'crate', o); } });

// @gcp/craft.js · actors — characters and creatures with joints and procedural animation, plus the two things
// that make them playable: a movement controller with a follow camera, and simple wandering behaviour.
// Nothing is loaded: bodies are merged vertex-coloured parts, and animation is maths on the joints, so
// actor.animate('walk', dt) just works and blends smoothly between states.
import * as THREE from 'three';
import { TAU, clamp } from '../core.js';
import { mulberry32, toSeed } from '../procgen/noise.js';
import { M4, mergeParts } from '../procgen/mesh.js';
import { defineRecipe } from '../procgen/recipe.js';
import { currentStage } from './stage.js';
import { glowMaterial } from './props.js';

let BODY = null;
const bodyMat = () => BODY || (BODY = Object.assign(new THREE.MeshLambertMaterial({ vertexColors: true }), { userData: { shared: true } }));
const cap = (r, len, n = 8) => new THREE.CapsuleGeometry(r, len, 3, n), ball = (r, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h), box = (w, h, d) => new THREE.BoxGeometry(w, h, d), cyl = (a, b, h, n = 8) => new THREE.CylinderGeometry(a, b, h, n), cone = (r, h, n = 8) => new THREE.ConeGeometry(r, h, n);
const mesh = (parts) => { const m = new THREE.Mesh(mergeParts(parts, { flat: false, jitter: 0.03 }), bodyMat()); m.castShadow = true; m.receiveShadow = true; return m; };
const joint = (parent, x, y, z, parts) => { const g = new THREE.Group(); g.position.set(x, y, z); if (parts && parts.length) g.add(mesh(parts)); parent.add(g); return g; };
const sd = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : toSeed(v ?? 1) % 99991);

const PRESETS = {
  villager: { shirt: 0x3f7fbf, pants: 0x5a4a3a, hair: 0x4a3020 },
  explorer: { shirt: 0xb8864a, pants: 0x4a5a3a, hat: 'straw', backpack: 0x6a4a2a, hair: 0x2a1c12 },
  farmer: { shirt: 0xc8482a, pants: 0x3a5a8a, hat: 'straw', hair: 0x8a5a2a, tool: 'pitchfork' },
  knight: { shirt: 0x9aa4ae, pants: 0x6a727a, hat: 'helmet', shoes: 0x3a3e44, tool: 'sword', shield: 0x3a5aa8, cape: 0xa82a2a },
  wizard: { shirt: 0x5a3a9a, pants: 0x4a2f80, hat: 'wizard', hatColor: 0x5a3a9a, robe: true, tool: 'staff', beard: 0xe8e8e8 },
  ninja: { shirt: 0x24262c, pants: 0x1c1e22, hat: 'hood', hatColor: 0x24262c, shoes: 0x14161a, tool: 'sword' },
  pirate: { shirt: 0xf0ead8, pants: 0x3a2a4a, hat: 'tricorn', hatColor: 0x2a2a30, tool: 'sword', beard: 0x2a1c12 },
  astronaut: { shirt: 0xe8ecf0, pants: 0xe8ecf0, shoes: 0x8a9098, hat: 'visor', backpack: 0xc8ccd2, skin: 0xe8ecf0 },
  robot: { skin: 0x9aa4ae, shirt: 0x6a7a8a, pants: 0x4a5560, shoes: 0x2a3038, hat: 'antenna', hair: null, eyes: 0x40e0ff },
  skeleton: { skin: 0xe8e2d0, shirt: 0xd8d2c0, pants: 0xcfc8b4, shoes: 0xcfc8b4, hair: null, eyes: 0x1a1a1a, thin: 0.72 },
  zombie: { skin: 0x7a9a6a, shirt: 0x5a4a3a, pants: 0x3a3a44, hair: 0x2a2a22, eyes: 0xd8e040 },
  king: { shirt: 0x8a2a3a, pants: 0x3a2a4a, hat: 'crown', cape: 0x7a1a2a, robe: true, beard: 0x8a6a4a },
  child: { shirt: 0xf2b830, pants: 0x3a6a9a, hair: 0x6a4020, height: 1.15, headScale: 1.25 },
};
/** Every preset humanoid() accepts. */
export const HUMANOIDS = Object.keys(PRESETS);

/**
 * A jointed person. Returns a THREE.Group (the actor) standing with its feet at y = 0, facing +z.
 * Options: preset (villager, explorer, farmer, knight, wizard, ninja, pirate, astronaut, robot, skeleton, zombie,
 * king, child), then any of: height (metres, default 1.75), skin, shirt, pants, shoes, hair (colour or null),
 * hat ('cap' | 'straw' | 'wizard' | 'helmet' | 'hood' | 'crown' | 'tricorn' | 'visor' | 'antenna'), hatColor,
 * beard (colour), cape (colour), robe (true: a long tunic), backpack (colour), shield (colour),
 * tool ('sword' | 'staff' | 'axe' | 'pickaxe' | 'torch' | 'pitchfork' | 'wand'), seed (varies proportions slightly).
 *   actor.animate(state, dt, speed)  every frame. state: idle | walk | run | jump | fall | sit | dead | carry
 *   actor.play(name)                 a one-shot on top: attack | wave | cheer | hurt | pickup
 *   actor.joints                     { hips, torso, head, armL, armR, foreL, foreR, legL, legR, shinL, shinR, hand }
 *   actor.hold(object3D)             puts something in the right hand
 */
export function humanoid(opts = {}) {
  const o = { ...PRESETS.villager, ...(PRESETS[opts.preset] || {}), ...opts }, r = mulberry32(sd(o.seed) * 613 + 11), H = o.height ?? 1.75, s = H / 1.75;
  const skin = o.skin ?? [0xf2c9a0, 0xe0ac7e, 0xc68a5a, 0x8d5a3a, 0xffd9b8][sd(o.seed) % 5], shirt = o.shirt, pants = o.pants, shoes = o.shoes ?? 0x3a2a20, th = (o.thin ?? 1) * 1.2 * (0.94 + r() * 0.12), hs = (o.headScale ?? 1) * 1.17;   // sturdy, readable proportions: a figure seen from ten metres is mostly silhouette
  const actor = new THREE.Group(), body = new THREE.Group(); body.scale.setScalar(s); actor.add(body);
  const hips = joint(body, 0, 0.9, 0, [[cap(0.13 * th, 0.12), pants, M4(0, 0, 0, 1, 1, 0.8, 0, 0, Math.PI / 2)]]);
  const tp = [[cyl(0.2 * th, 0.16 * th, 0.46, 10), shirt, M4(0, 0.31, 0, 1, 1, 0.66)], [ball(0.2 * th, 10, 6), shirt, M4(0, 0.52, 0, 1, 0.45, 0.66)], [cyl(0.165 * th, 0.165 * th, 0.06, 10), o.belt ?? 0x2a1c12, M4(0, 0.09, 0, 1, 1, 0.7)], [cyl(0.07, 0.085, 0.1, 8), skin, M4(0, 0.63, 0)]];
  if (o.robe) tp.push([cyl(0.18 * th, 0.3 * th, 0.62, 10, 1), shirt, M4(0, -0.2, 0, 1, 1, 0.75)]);
  if (o.backpack != null) tp.push([box(0.3, 0.36, 0.16), o.backpack, M4(0, 0.36, -0.2)], [box(0.26, 0.1, 0.14), o.backpack, M4(0, 0.58, -0.19)]);
  const torso = joint(hips, 0, 0.06, 0, tp);
  if (o.cape != null) { const c = mesh([[box(0.44, 0.9, 0.03), o.cape, M4(0, -0.42, 0)]]); const cj = joint(torso, 0, 0.6, -0.14); cj.add(c); cj.rotation.x = 0.12; actor.userData.cape = cj; }
  const hp = [[ball(0.21, 14, 10), skin, M4(0, 0.2, 0, 1, 1.04, 0.98)], [ball(0.03, 6, 5), o.eyes ?? 0x1c1c22, M4(0.078, 0.22, 0.186)], [ball(0.03, 6, 5), o.eyes ?? 0x1c1c22, M4(-0.078, 0.22, 0.186)], [ball(0.028, 6, 5), skin, M4(0, 0.16, 0.208)]];
  const hair = o.hair === undefined ? 0x4a3020 : o.hair, hat = o.hat, hc = o.hatColor;
  if (hair != null && hat !== 'hood' && hat !== 'helmet' && hat !== 'visor') hp.push([new THREE.SphereGeometry(0.222, 12, 8, 0, TAU, 0, 1.75), hair, M4(0, 0.215, -0.012, 1, 1.04, 1, -0.32, 0, 0)]);
  if (o.beard != null) hp.push([ball(0.13, 8, 6), o.beard, M4(0, 0.07, 0.11, 1, 1.1, 0.7)]);
  if (hat === 'cap') hp.push([new THREE.SphereGeometry(0.228, 12, 6, 0, TAU, 0, 1.4), hc ?? 0xc8382a, M4(0, 0.23, 0)], [box(0.26, 0.03, 0.18), hc ?? 0xc8382a, M4(0, 0.3, 0.24)]);
  if (hat === 'straw') hp.push([cyl(0.14, 0.42, 0.1, 14), hc ?? 0xd8b860, M4(0, 0.36, 0)], [cyl(0.13, 0.16, 0.14, 12), hc ?? 0xd8b860, M4(0, 0.44, 0)]);
  if (hat === 'wizard') hp.push([cyl(0.38, 0.38, 0.03, 16), hc ?? 0x5a3a9a, M4(0, 0.36, 0)], [cone(0.2, 0.62, 12), hc ?? 0x5a3a9a, M4(0, 0.67, -0.03, 1, 1, 1, -0.14, 0, 0)], [cyl(0.205, 0.205, 0.06, 12), 0xf2c230, M4(0, 0.4, 0)]);
  if (hat === 'helmet') hp.push([new THREE.SphereGeometry(0.235, 12, 8, 0, TAU, 0, 1.9), hc ?? 0xaab2bc, M4(0, 0.215, 0)], [box(0.03, 0.2, 0.3), 0xc8382a, M4(0, 0.48, -0.02)], [box(0.26, 0.05, 0.03), hc ?? 0xaab2bc, M4(0, 0.16, 0.225)]);
  if (hat === 'hood') hp.push([ball(0.245, 12, 8), hc ?? shirt, M4(0, 0.2, -0.035)], [ball(0.19, 10, 8), skin, M4(0, 0.2, 0.04)], [ball(0.03, 6, 5), 0x1c1c22, M4(0.075, 0.22, 0.2)], [ball(0.03, 6, 5), 0x1c1c22, M4(-0.075, 0.22, 0.2)]);
  if (hat === 'crown') { hp.push([cyl(0.17, 0.16, 0.1, 12, 1, true), 0xf2c230, M4(0, 0.41, 0)]); for (let i = 0; i < 6; i++) hp.push([cone(0.035, 0.09, 4), 0xf2c230, M4(Math.cos(i / 6 * TAU) * 0.16, 0.5, Math.sin(i / 6 * TAU) * 0.16)]); }
  if (hat === 'tricorn') hp.push([cyl(0.36, 0.34, 0.04, 3), hc ?? 0x2a2a30, M4(0, 0.38, 0, 1, 1, 1, 0, Math.PI / 6, 0)], [cyl(0.15, 0.18, 0.14, 10), hc ?? 0x2a2a30, M4(0, 0.44, 0)]);
  if (hat === 'visor') hp.push([ball(0.27, 14, 10), 0xe8ecf0, M4(0, 0.2, -0.02)], [ball(0.2, 12, 8), 0x1c2a3a, M4(0, 0.21, 0.09, 1, 0.8, 1)]);
  if (hat === 'antenna') hp.push([cyl(0.012, 0.012, 0.22, 5), 0x4a5560, M4(0, 0.5, 0)], [ball(0.035, 6, 5), 0xff4040, M4(0, 0.62, 0)], [box(0.3, 0.07, 0.03), o.eyes ?? 0x40e0ff, M4(0, 0.22, 0.2)]);
  const head = joint(torso, 0, 0.66, 0, hp); head.scale.setScalar(hs);
  const arm = (side) => { const a = joint(torso, side * 0.255 * th, 0.53, 0, [[cap(0.062 * th, 0.2), shirt, M4(0, -0.14, 0)], [ball(0.075 * th, 8, 6), shirt, M4(0, 0, 0)]]); const f = joint(a, 0, -0.29, 0, [[cap(0.052 * th, 0.18), o.sleeves ? shirt : skin, M4(0, -0.12, 0)], [ball(0.062 * th, 8, 6), skin, M4(0, -0.28, 0)]]); return [a, f]; };
  const leg = (side) => { const l = joint(hips, side * 0.095 * th, -0.03, 0, [[cap(0.082 * th, 0.26), pants, M4(0, -0.2, 0)]]); const sh = joint(l, 0, -0.42, 0, [[cap(0.068 * th, 0.26), o.shorts ? skin : pants, M4(0, -0.19, 0)], [box(0.13 * th, 0.1, 0.27), shoes, M4(0, -0.405, 0.05)]]); return [l, sh]; };
  const [armL, foreL] = arm(1), [armR, foreR] = arm(-1), [legL, shinL] = leg(1), [legR, shinR] = leg(-1);
  const hand = joint(foreR, 0, -0.28, 0.02);
  const tool = o.tool, T = [];
  if (tool === 'sword') T.push([box(0.05, 0.72, 0.014), 0xd8dee6, M4(0, 0, 0.5, 1, 1, 1, Math.PI / 2, 0, 0)], [box(0.22, 0.04, 0.04), 0xf2c230, M4(0, 0, 0.12)], [cyl(0.02, 0.02, 0.14, 6), 0x4a3020, M4(0, 0, 0.03, 1, 1, 1, Math.PI / 2, 0, 0)]);
  if (tool === 'staff' || tool === 'wand') { const L = tool === 'staff' ? 1.5 : 0.4; T.push([cyl(0.022, 0.028, L, 6), 0x6a4a2a, M4(0, 0, tool === 'staff' ? 0.3 : 0.2, 1, 1, 1, Math.PI / 2, 0, 0)]); }
  if (tool === 'axe' || tool === 'pickaxe') { T.push([cyl(0.022, 0.026, 0.8, 6), 0x6a4a2a, M4(0, 0, 0.32, 1, 1, 1, Math.PI / 2, 0, 0)]); if (tool === 'axe') T.push([box(0.03, 0.26, 0.2), 0xb8bec6, M4(0, -0.1, 0.64)]); else T.push([box(0.03, 0.5, 0.05), 0xb8bec6, M4(0, 0, 0.68, 1, 1, 1, 0.15, 0, 0)]); }
  if (tool === 'pitchfork') { T.push([cyl(0.02, 0.024, 1.5, 6), 0x6a4a2a, M4(0, 0, 0.35, 1, 1, 1, Math.PI / 2, 0, 0)]); for (const x of [-0.07, 0, 0.07]) T.push([box(0.015, 0.015, 0.28), 0x9aa2aa, M4(x, 0, 1.2)]); T.push([box(0.16, 0.02, 0.02), 0x9aa2aa, M4(0, 0, 1.07)]); }
  if (tool === 'torch') T.push([cyl(0.022, 0.03, 0.5, 6), 0x6a4a2a, M4(0, 0, 0.18, 1, 1, 1, Math.PI / 2, 0, 0)]);
  if (T.length) hand.add(mesh(T));
  if (tool === 'staff' || tool === 'wand' || tool === 'torch') { const g = new THREE.Mesh(tool === 'torch' ? cone(0.06, 0.2, 6).rotateX(Math.PI / 2) : ball(0.07, 10, 8), glowMaterial(o.glow ?? (tool === 'torch' ? 0xffa030 : 0x7ad0ff), 2)); g.position.set(0, 0, tool === 'staff' ? 1.1 : tool === 'wand' ? 0.42 : 0.5); hand.add(g); }
  if (o.shield != null) { const sh = mesh([[cyl(0.26, 0.26, 0.04, 12), o.shield, M4(0, 0, 0, 1, 1, 1, 0, 0, Math.PI / 2)], [cyl(0.07, 0.07, 0.06, 8), 0xf2c230, M4(0.01, 0, 0, 1, 1, 1, 0, 0, Math.PI / 2)]]); sh.position.set(0.08, -0.14, 0.02); foreL.add(sh); }
  actor.joints = { hips, torso, head, armL, armR, foreL, foreR, legL, legR, shinL, shinR, hand };
  actor.height = H; actor.userData.radius = 0.35 * s; actor.userData.scale = s; actor.isActor = true;
  actor.hold = (obj) => { hand.add(obj); return actor; };
  rig(actor, 'biped');
  return actor;
}

// ---- animation: each state gives target joint angles; the rig eases towards them ----
const POSE = {
  idle: (t, a) => ({ torso: [Math.sin(t * 1.6) * 0.015, 0, 0], head: [Math.sin(t * 0.7) * 0.04, Math.sin(t * 0.45) * 0.18, 0], armL: [Math.sin(t * 1.6) * 0.03, 0, 0.07], armR: [-Math.sin(t * 1.6) * 0.03, 0, -0.07], foreL: [-0.12, 0, 0], foreR: [-0.12, 0, 0], y: Math.sin(t * 1.6) * 0.006 }),
  walk: (t, a, k) => { const p = a.phase, s = Math.sin(p), c = Math.cos(p), A = 0.55 * k; return { legL: [-s * A, 0, 0], legR: [s * A, 0, 0], shinL: [Math.max(0, c) * A * 1.4, 0, 0], shinR: [Math.max(0, -c) * A * 1.4, 0, 0], armL: [s * A * 0.8, 0, 0.06], armR: [-s * A * 0.8, 0, -0.06], foreL: [-0.25 - Math.max(0, s) * 0.3, 0, 0], foreR: [-0.25 - Math.max(0, -s) * 0.3, 0, 0], torso: [0.04, s * 0.07, 0], head: [0, -s * 0.05, 0], y: Math.abs(c) * 0.035 - 0.02 }; },
  run: (t, a, k) => { const p = a.phase, s = Math.sin(p), c = Math.cos(p), A = 0.95 * k; return { legL: [-s * A, 0, 0], legR: [s * A, 0, 0], shinL: [Math.max(0, c) * A * 1.5 + 0.2, 0, 0], shinR: [Math.max(0, -c) * A * 1.5 + 0.2, 0, 0], armL: [s * A, 0, 0.1], armR: [-s * A, 0, -0.1], foreL: [-1.1, 0, 0], foreR: [-1.1, 0, 0], torso: [0.2, s * 0.12, 0], head: [-0.1, -s * 0.06, 0], y: Math.abs(c) * 0.07 - 0.03 }; },
  jump: () => ({ legL: [-0.5, 0, 0], legR: [0.25, 0, 0], shinL: [0.9, 0, 0], shinR: [0.5, 0, 0], armL: [-2.2, 0, 0.3], armR: [-2.2, 0, -0.3], foreL: [-0.3, 0, 0], foreR: [-0.3, 0, 0], torso: [-0.08, 0, 0] }),
  fall: (t) => ({ legL: [0.15, 0, 0.1], legR: [-0.2, 0, -0.1], shinL: [0.3, 0, 0], shinR: [0.5, 0, 0], armL: [0, 0, 1.2 + Math.sin(t * 14) * 0.15], armR: [0, 0, -1.2 - Math.sin(t * 14 + 1) * 0.15], torso: [0.1, 0, 0] }),
  sit: () => ({ legL: [-1.5, 0, 0.08], legR: [-1.5, 0, -0.08], shinL: [1.5, 0, 0], shinR: [1.5, 0, 0], armL: [-0.4, 0, 0.1], armR: [-0.4, 0, -0.1], foreL: [-0.6, 0, 0], foreR: [-0.6, 0, 0], y: -0.42 }),
  carry: (t, a, k) => { const w = POSE.walk(t, a, k); return { ...w, armL: [-1.3, 0, -0.25], armR: [-1.3, 0, 0.25], foreL: [-0.5, 0, 0], foreR: [-0.5, 0, 0] }; },
  dead: () => ({ root: [-Math.PI / 2 + 0.05, 0, 0], legL: [0.1, 0, 0.15], legR: [-0.05, 0, -0.2], armL: [0, 0, 1.1], armR: [0, 0, -0.7], head: [0, 0.5, 0], y: -0.72 }),
};
const SHOT = {
  attack: [0.38, (u) => ({ armR: [-2.4 + u * 3.2, 0, -0.2], foreR: [-0.9 + u * 0.8, 0, 0], torso: [0.1 * u, 0.5 - u, 0] })],
  wave: [1.2, (u) => ({ armR: [0, 0, -2.6], foreR: [0, 0, Math.sin(u * 20) * 0.5 - 0.2] })],
  cheer: [1.0, (u) => ({ armL: [0, 0, 2.7], armR: [0, 0, -2.7], foreL: [0, 0, 0], foreR: [0, 0, 0], y: Math.abs(Math.sin(u * 9)) * 0.14 })],
  hurt: [0.3, (u) => ({ torso: [-0.35 * (1 - u), 0, 0], head: [-0.3 * (1 - u), 0, 0], armL: [0, 0, 0.8], armR: [0, 0, -0.8] })],
  pickup: [0.5, (u) => { const k = Math.sin(u * Math.PI); return { torso: [0.9 * k, 0, 0], armR: [-1.4 * k, 0, 0], legL: [-0.5 * k, 0, 0], legR: [-0.5 * k, 0, 0], shinL: [0.9 * k, 0, 0], shinR: [0.9 * k, 0, 0], y: -0.2 * k }; }],
};
const QUAD = {
  idle: (t, a) => ({ head: [Math.sin(t * 0.5 + a.seed) > 0.6 ? 0.7 : Math.sin(t * 0.9) * 0.05, Math.sin(t * 0.4 + a.seed) * 0.25, 0], tail: [0, Math.sin(t * 3 + a.seed) * 0.3, 0], y: Math.sin(t * 1.8) * 0.006 }),
  walk: (t, a, k) => { const s = Math.sin(a.phase), A = 0.5 * k; return { legFL: [s * A, 0, 0], legBR: [s * A, 0, 0], legFR: [-s * A, 0, 0], legBL: [-s * A, 0, 0], head: [Math.sin(a.phase * 2) * 0.05, 0, 0], tail: [0, s * 0.3, 0], y: Math.abs(Math.cos(a.phase)) * 0.02 }; },
  run: (t, a, k) => { const s = Math.sin(a.phase), c = Math.cos(a.phase), A = 0.9 * k; return { legFL: [s * A, 0, 0], legFR: [Math.sin(a.phase + 0.5) * A, 0, 0], legBL: [-c * A, 0, 0], legBR: [-Math.cos(a.phase + 0.5) * A, 0, 0], spine: [s * 0.1, 0, 0], head: [-0.15, 0, 0], tail: [0.5, 0, 0], y: Math.abs(s) * 0.09 }; },
  dead: () => ({ root: [0, 0, Math.PI / 2 - 0.1], legFL: [0.4, 0, 0], legBR: [-0.4, 0, 0], y: -0.2 }),
};
QUAD.jump = QUAD.run; QUAD.fall = QUAD.run; QUAD.sit = QUAD.idle; QUAD.carry = QUAD.walk;
const QSHOT = { attack: [0.35, (u) => ({ head: [-0.5 + u, 0, 0], spine: [-0.25 * Math.sin(u * Math.PI), 0, 0], y: Math.sin(u * Math.PI) * 0.15 })], hurt: [0.3, (u) => ({ spine: [0.2 * (1 - u), 0, 0], y: 0.1 * (1 - u) })], wave: [0.8, (u) => ({ tail: [0, Math.sin(u * 30) * 0.8, 0] })], cheer: [0.8, (u) => ({ y: Math.abs(Math.sin(u * 9)) * 0.2 })], pickup: [0.5, (u) => ({ head: [0.9 * Math.sin(u * Math.PI), 0, 0] })] };

function rig(actor, type) {
  const A = { phase: 0, t: Math.random() * 10, seed: Math.random() * 10, shot: null, shotT: 0, state: 'idle' }, J = actor.joints, body = actor.children[0], baseY = {}; for (const k in J) baseY[k] = J[k].position.y;
  const P = type === 'biped' ? POSE : QUAD, S = type === 'biped' ? SHOT : QSHOT, rootY = body.position.y;
  actor.state = 'idle';
  /** Call every frame. speed scales the stride (1 = normal for that state). */
  actor.animate = (state = 'idle', dt = 0.016, speed = 1) => {
    if (actor.customAnimate) return actor.customAnimate(state, dt, speed);
    const fn = P[state] || P.idle; A.state = actor.state = state; A.t += dt; A.phase += dt * (state === 'run' ? 11 : 7.5) * speed;
    let pose = fn(A.t, A, clamp(speed, 0.4, 1.4));
    if (A.shot) { A.shotT += dt; const [dur, sf] = S[A.shot]; if (A.shotT >= dur) { const done = A.done; A.shot = null; A.done = null; if (done) done(); } else pose = { ...pose, ...sf(A.shotT / dur) }; }
    const k = Math.min(1, dt * (state === 'dead' ? 6 : 14));
    for (const name in J) { if (name === 'hand') continue; const j = J[name], tg = pose[name] || ZERO; j.rotation.x += (tg[0] - j.rotation.x) * k; j.rotation.y += (tg[1] - j.rotation.y) * k; j.rotation.z += (tg[2] - j.rotation.z) * k; }
    const rt = pose.root || ZERO; body.rotation.x += (rt[0] - body.rotation.x) * k; body.rotation.z += (rt[2] - body.rotation.z) * k;
    body.position.y += (rootY + (pose.y || 0) * (actor.userData.scale || 1) - body.position.y) * k;
    if (actor.userData.cape) actor.userData.cape.rotation.x = 0.12 + (state === 'run' ? 0.7 : state === 'walk' ? 0.3 : 0) + Math.sin(A.t * 6) * 0.05;
    return actor;
  };
  /** Plays a one-shot (attack, wave, cheer, hurt, pickup) on top of the current state. Returns a promise that resolves when it ends. */
  actor.play = (name) => new Promise((res) => { if (!S[name]) return res(); A.shot = name; A.shotT = 0; A.done = res; });
}
const ZERO = [0, 0, 0];

const ANIMALS = {
  deer: { len: 1.15, h: 0.46, w: 0.36, leg: 0.72, neck: 0.5, head: 0.2, snout: 0.2, ears: 'point', tail: 'short', antlers: 1, coat: 0xa8743e, belly: 0xe8d8b8, hoof: 0x2a1c12 },
  wolf: { len: 1.05, h: 0.42, w: 0.34, leg: 0.5, neck: 0.22, head: 0.21, snout: 0.22, ears: 'point', tail: 'bushy', coat: 0x7a7a80, belly: 0xc8c8c8, hoof: 0x3a3a40 },
  fox: { len: 0.75, h: 0.3, w: 0.24, leg: 0.3, neck: 0.14, head: 0.17, snout: 0.18, ears: 'point', tail: 'bushy', coat: 0xd8702a, belly: 0xf2e8d8, hoof: 0x2a1c12 },
  dog: { len: 0.8, h: 0.36, w: 0.3, leg: 0.36, neck: 0.16, head: 0.2, snout: 0.17, ears: 'flop', tail: 'long', coat: 0xb88a56, belly: 0xe8d8b8, hoof: 0x4a3a2a },
  cat: { len: 0.55, h: 0.24, w: 0.2, leg: 0.22, neck: 0.08, head: 0.15, snout: 0.06, ears: 'point', tail: 'long', coat: 0x4a4a52, belly: 0x8a8a92, hoof: 0x3a3a40 },
  sheep: { len: 0.95, h: 0.6, w: 0.56, leg: 0.36, neck: 0.12, head: 0.17, snout: 0.14, ears: 'flop', tail: 'short', coat: 0xf0ece0, belly: 0xf0ece0, face: 0x2a2a2e, hoof: 0x2a2a2e, wool: 1 },
  pig: { len: 0.95, h: 0.52, w: 0.5, leg: 0.26, neck: 0.06, head: 0.24, snout: 0.12, ears: 'flop', tail: 'short', coat: 0xf0a8a8, belly: 0xf8c0c0, hoof: 0x8a5a5a, flat: 1 },
  cow: { len: 1.55, h: 0.72, w: 0.66, leg: 0.62, neck: 0.2, head: 0.27, snout: 0.22, ears: 'flop', tail: 'long', horns: 1, coat: 0xf2efe8, belly: 0xf2efe8, patch: 0x2a2a2e, hoof: 0x2a2a2e, flat: 1 },
  horse: { len: 1.6, h: 0.62, w: 0.48, leg: 0.95, neck: 0.62, head: 0.24, snout: 0.3, ears: 'point', tail: 'bushy', mane: 0x2a1c12, coat: 0x8a5a30, belly: 0x8a5a30, hoof: 0x1c1410 },
  rabbit: { len: 0.36, h: 0.22, w: 0.2, leg: 0.12, neck: 0.04, head: 0.13, snout: 0.05, ears: 'long', tail: 'puff', coat: 0xd8cfc0, belly: 0xf8f4ec, hoof: 0xd8cfc0 },
  bear: { len: 1.5, h: 0.85, w: 0.8, leg: 0.5, neck: 0.12, head: 0.33, snout: 0.2, ears: 'round', tail: 'short', coat: 0x5a3a24, belly: 0x6a4a30, hoof: 0x2a1c12 },
  boar: { len: 1.05, h: 0.55, w: 0.46, leg: 0.34, neck: 0.06, head: 0.26, snout: 0.22, ears: 'point', tail: 'short', tusks: 1, coat: 0x4a3a30, belly: 0x5a4a3a, hoof: 0x1c1410 },
  goat: { len: 0.9, h: 0.44, w: 0.36, leg: 0.46, neck: 0.22, head: 0.18, snout: 0.16, ears: 'flop', tail: 'short', horns: 1, beard: 1, coat: 0xe8e2d4, belly: 0xf2efe8, hoof: 0x3a3a3a },
};
const OTHERS = ['chicken', 'bird', 'fish', 'slime', 'ghost', 'bat'];
/** Every creature animal() accepts. */
export const ANIMALS_LIST = [...Object.keys(ANIMALS), ...OTHERS];

/**
 * A creature with joints. kind: deer, wolf, fox, dog, cat, sheep, pig, cow, horse, rabbit, bear, boar, goat (four legs),
 * chicken, bird (flies), fish, slime, ghost, bat. Options: color (coat), accent, size (1 = natural size), seed.
 * Same interface as humanoid(): actor.animate(state, dt, speed) with idle | walk | run | dead, actor.play('attack' | 'hurt').
 */
export function animal(kind = 'deer', opts = {}) {
  if (OTHERS.includes(kind)) return critter(kind, opts);
  const d = ANIMALS[kind]; if (!d) throw new Error(`Unknown animal "${kind}". Available: ${ANIMALS_LIST.join(', ')}.`);
  const size = opts.size ?? 1, coat = opts.color ?? d.coat, belly = opts.accent ?? d.belly, face = d.face ?? coat, actor = new THREE.Group(), body = new THREE.Group(); body.scale.setScalar(size); actor.add(body);
  const bp = [[cap(d.h / 2, d.len - d.h, 10), coat, M4(0, 0, 0, d.w / d.h, 1, 1, Math.PI / 2, 0, 0)], [cap(d.h * 0.42, d.len - d.h, 8), belly, M4(0, -d.h * 0.13, 0, d.w / d.h * 0.92, 1, 0.94, Math.PI / 2, 0, 0)]];
  if (d.wool) for (let i = 0; i < 12; i++) { const a = i * 2.4, z = ((i % 4) / 3 - 0.5) * d.len * 0.7; bp.push([ball(d.h * 0.3, 7, 5), coat, M4(Math.cos(a) * d.w * 0.34, Math.abs(Math.sin(a)) * d.h * 0.32, z)]); }
  if (d.patch) for (let i = 0; i < 4; i++) bp.push([ball(d.h * 0.3, 7, 5), d.patch, M4((i % 2 ? 1 : -1) * d.w * 0.33, d.h * 0.2 * (i < 2 ? 1 : -0.3), (i - 1.5) * d.len * 0.22, 0.5, 1, 1.2)]);
  if (d.mane) bp.push([box(0.06, 0.2, d.len * 0.3), d.mane, M4(0, d.h * 0.5, d.len * 0.36, 1, 1, 1, -0.6, 0, 0)]);
  const spine = joint(body, 0, d.leg + d.h / 2, 0, bp);
  const hp = [[ball(d.head, 10, 8), face, M4(0, 0, 0, 0.92, 0.95, 1.1)], [d.flat ? cyl(d.head * 0.5, d.head * 0.55, d.snout, 8) : cone(d.head * 0.62, d.snout * 2.1, 8), d.face ?? (kind === 'fox' || kind === 'wolf' ? belly : face), M4(0, -d.head * 0.22, d.head * 0.75 + d.snout * (d.flat ? 0.4 : 0.5), 1, 0.85, 1, Math.PI / 2, 0, 0)], [ball(d.head * 0.16, 6, 5), 0x1c1410, M4(0, -d.head * 0.16, d.head * 0.82 + d.snout * (d.flat ? 0.9 : 1.2))], [ball(d.head * 0.13, 6, 5), 0x14141a, M4(d.head * 0.55, d.head * 0.25, d.head * 0.6)], [ball(d.head * 0.13, 6, 5), 0x14141a, M4(-d.head * 0.55, d.head * 0.25, d.head * 0.6)]];
  for (const s of [-1, 1]) {
    if (d.ears === 'point') hp.push([cone(d.head * 0.3, d.head * 0.75, 4), coat, M4(s * d.head * 0.52, d.head * 0.95, -d.head * 0.1, 1, 1, 0.5, 0, 0, -s * 0.3)]);
    if (d.ears === 'round') hp.push([ball(d.head * 0.3, 7, 5), coat, M4(s * d.head * 0.7, d.head * 0.75, 0, 1, 1, 0.5)]);
    if (d.ears === 'flop') hp.push([ball(d.head * 0.34, 7, 5), d.face ?? coat, M4(s * d.head * 0.95, d.head * 0.25, -d.head * 0.1, 0.4, 1, 0.8, 0, 0, s * 0.5)]);
    if (d.ears === 'long') hp.push([cap(d.head * 0.2, d.head * 1.3, 6), coat, M4(s * d.head * 0.4, d.head * 1.5, -d.head * 0.15, 1, 1, 0.5, -0.15, 0, -s * 0.15)]);
    if (d.horns) hp.push([cone(d.head * 0.16, d.head * 0.9, 5), 0xe8e0c8, M4(s * d.head * 0.55, d.head * 1.05, -d.head * 0.25, 1, 1, 1, -0.5, 0, -s * 0.5)]);
    if (d.tusks) hp.push([cone(d.head * 0.1, d.head * 0.5, 5), 0xf2ecd8, M4(s * d.head * 0.4, -d.head * 0.2, d.head * 1.25, 1, 1, 1, 0.3, 0, -s * 0.3)]);
    if (d.antlers) { hp.push([cyl(0.014, 0.022, d.head * 2.2, 5), 0xd8c8a0, M4(s * d.head * 0.6, d.head * 1.8, -d.head * 0.2, 1, 1, 1, -0.25, 0, -s * 0.35)]); for (let i = 0; i < 3; i++) hp.push([cyl(0.01, 0.016, d.head * 1.0, 4), 0xd8c8a0, M4(s * d.head * (0.75 + i * 0.22), d.head * (1.7 + i * 0.5), -d.head * 0.15 + (i % 2) * 0.1, 1, 1, 1, 0.5 - i * 0.5, 0, -s * 0.9)]); }
  }
  if (d.beard) hp.push([cone(d.head * 0.2, d.head * 0.7, 5), 0xf2efe8, M4(0, -d.head * 0.85, d.head * 0.5, 1, 1, 1, Math.PI, 0, 0)]);
  const neckY = d.h * 0.25 + d.neck * 0.8, neckZ = d.len / 2 - d.h * 0.15 + d.neck * 0.45;
  if (d.neck > 0.15) spine.add(mesh([[cap(d.h * 0.24, d.neck, 8), coat, M4(0, d.h * 0.2 + d.neck * 0.38, d.len / 2 - d.h * 0.2 + d.neck * 0.2, 1, 1, 1, 0.55, 0, 0)]]));
  const head = joint(spine, 0, neckY, neckZ, hp);
  const tp = d.tail === 'bushy' ? [[cap(d.h * 0.2, d.len * 0.36, 7), coat, M4(0, -d.len * 0.05, -d.len * 0.22, 1, 1, 1, Math.PI / 2 - 0.5, 0, 0)], [ball(d.h * 0.2, 7, 5), kind === 'fox' ? 0xf8f4ec : coat, M4(0, -d.len * 0.16, -d.len * 0.42)]] : d.tail === 'long' ? [[cyl(0.02, 0.03, d.len * 0.5, 5), coat, M4(0, -d.len * 0.12, -d.len * 0.16, 1, 1, 1, 0.9, 0, 0)], [ball(0.045, 6, 5), d.patch ?? coat, M4(0, -d.len * 0.28, -d.len * 0.34)]] : d.tail === 'puff' ? [[ball(d.h * 0.3, 7, 5), 0xffffff, M4(0, 0, -d.h * 0.2)]] : [[cone(d.h * 0.12, d.h * 0.4, 5), coat, M4(0, 0, -d.h * 0.15, 1, 1, 1, -1.9, 0, 0)]];
  const tail = joint(spine, 0, d.h * 0.25, -d.len / 2 + d.h * 0.12, tp);
  const leg = (x, z) => joint(spine, x * d.w * 0.3, -d.h * 0.28, z * (d.len / 2 - d.h * 0.42), [[cyl(d.w * 0.15, d.w * 0.11, d.leg + d.h * 0.1, 7), coat, M4(0, -(d.leg + d.h * 0.1) / 2 + d.h * 0.1, 0)], [cyl(d.w * 0.125, d.w * 0.14, d.leg * 0.16, 7), d.hoof, M4(0, -d.leg + d.h * 0.2 - d.leg * 0.02 + d.h * 0.0, 0)]]);
  actor.joints = { spine, head, tail, legFL: leg(1, 1), legFR: leg(-1, 1), legBL: leg(1, -1), legBR: leg(-1, -1) };
  actor.height = (d.leg + d.h + d.neck) * size; actor.userData.radius = d.len * 0.45 * size; actor.userData.scale = size; actor.isActor = true; actor.species = kind;
  rig(actor, 'quad');
  return actor;
}
function critter(kind, o) {
  const size = o.size ?? 1, actor = new THREE.Group(), body = new THREE.Group(); body.scale.setScalar(size); actor.add(body); let t = Math.random() * 9, squash = 0;
  const A = (state, fn) => { actor.animate = (st = 'idle', dt = 0.016, speed = 1) => { t += dt * (st === 'run' ? 1.8 : 1) * speed; actor.state = st; squash = Math.max(0, squash - dt * 3); fn(st, t, dt); return actor; }; actor.play = (n) => { squash = 1; return new Promise((r) => setTimeout(r, 300)); }; };
  if (kind === 'slime') {
    const c = o.color ?? 0x5ad06a, m = mesh([[new THREE.SphereGeometry(0.45, 14, 10, 0, TAU, 0, Math.PI * 0.62), c, M4(0, 0.2, 0, 1, 1, 1)], [ball(0.07, 6, 5), 0x14141a, M4(0.15, 0.36, 0.36)], [ball(0.07, 6, 5), 0x14141a, M4(-0.15, 0.36, 0.36)], [ball(0.16, 8, 6), 0xffffff, M4(-0.12, 0.5, 0.18, 1, 0.6, 0.5)]]); body.add(m);
    A(0, (st, tt) => { const hop = st === 'idle' ? Math.sin(tt * 3) * 0.05 : Math.abs(Math.sin(tt * 6)); m.scale.set(1 + (st === 'idle' ? -hop : (0.5 - hop) * 0.3) + squash * 0.3, st === 'dead' ? 0.2 : 1 + (st === 'idle' ? hop : (hop - 0.5) * 0.5) - squash * 0.3, 1 + (st === 'idle' ? -hop : (0.5 - hop) * 0.3) + squash * 0.3); m.position.y = st === 'idle' || st === 'dead' ? 0 : hop * 0.35; });
    actor.height = 0.7 * size; actor.userData.radius = 0.45 * size;
  } else if (kind === 'ghost') {
    const c = o.color ?? 0xe8f0ff, g = new THREE.Group(); g.add(mesh([[cap(0.34, 0.4, 12), c, M4(0, 0.5, 0)], [cone(0.12, 0.3, 6), c, M4(0.2, 0.1, 0, 1, 1, 1, Math.PI, 0, 0)], [cone(0.12, 0.3, 6), c, M4(-0.2, 0.1, 0, 1, 1, 1, Math.PI, 0, 0)], [cone(0.12, 0.3, 6), c, M4(0, 0.1, 0.2, 1, 1, 1, Math.PI, 0, 0)], [cone(0.12, 0.3, 6), c, M4(0, 0.1, -0.2, 1, 1, 1, Math.PI, 0, 0)], [ball(0.06, 6, 5), 0x14141a, M4(0.12, 0.66, 0.3)], [ball(0.06, 6, 5), 0x14141a, M4(-0.12, 0.66, 0.3)], [ball(0.07, 6, 5), 0x14141a, M4(0, 0.5, 0.32, 1, 1.4, 1)]])); body.add(g); g.children[0].material = bodyMat().clone(); Object.assign(g.children[0].material, { transparent: true, opacity: 0.86, emissive: new THREE.Color(c), emissiveIntensity: 0.35 });
    A(0, (st, tt) => { g.position.y = 0.5 + Math.sin(tt * 2.2) * 0.14; g.rotation.z = Math.sin(tt * 1.4) * 0.08; g.scale.setScalar(st === 'dead' ? 0.01 : 1 + squash * 0.3); });
    actor.height = 1.6 * size; actor.userData.radius = 0.4 * size;
  } else if (kind === 'fish') {
    const c = o.color ?? 0xf28a2a, front = new THREE.Group(), back = new THREE.Group(); front.add(mesh([[ball(0.2, 10, 8), c, M4(0, 0, 0.06, 0.5, 0.8, 1.3)], [ball(0.03, 5, 4), 0x14141a, M4(0.08, 0.04, 0.24)], [ball(0.03, 5, 4), 0x14141a, M4(-0.08, 0.04, 0.24)], [cone(0.08, 0.16, 4), o.accent ?? 0xffe0a0, M4(0, 0.18, 0, 0.3, 1, 1)]])); back.add(mesh([[cone(0.14, 0.3, 4), o.accent ?? c, M4(0, 0, -0.14, 0.25, 1, 1, Math.PI / 2, 0, 0)]])); back.position.z = -0.18; body.add(front, back);
    A(0, (st, tt) => { back.rotation.y = Math.sin(tt * (st === 'idle' ? 5 : 12)) * 0.6; front.rotation.y = -back.rotation.y * 0.2; body.rotation.z = st === 'dead' ? Math.PI : 0; });
    actor.height = 0.35 * size; actor.userData.radius = 0.3 * size;
  } else if (kind === 'chicken') {
    const c = o.color ?? 0xf8f4ec, b2 = new THREE.Group(), hd = new THREE.Group(), legs = [new THREE.Group(), new THREE.Group()];
    b2.add(mesh([[ball(0.2, 10, 8), c, M4(0, 0, 0, 0.85, 0.9, 1.15)], [cone(0.12, 0.26, 5), c, M4(0, 0.1, -0.24, 0.5, 1, 1, -1.0, 0, 0)], [ball(0.14, 7, 5), o.accent ?? 0xe8e0d0, M4(0.15, 0, 0, 0.3, 0.8, 1)], [ball(0.14, 7, 5), o.accent ?? 0xe8e0d0, M4(-0.15, 0, 0, 0.3, 0.8, 1)]])); b2.position.y = 0.36;
    hd.add(mesh([[ball(0.1, 8, 6), c, M4(0, 0.06, 0)], [cone(0.035, 0.1, 4), 0xf2a020, M4(0, 0.05, 0.12, 1, 1, 1, Math.PI / 2, 0, 0)], [ball(0.05, 5, 4), 0xd8282a, M4(0, 0.17, 0, 0.4, 1, 1.2)], [ball(0.035, 5, 4), 0xd8282a, M4(0, -0.03, 0.08)], [ball(0.018, 5, 4), 0x14141a, M4(0.07, 0.08, 0.06)], [ball(0.018, 5, 4), 0x14141a, M4(-0.07, 0.08, 0.06)]])); hd.position.set(0, 0.2, 0.16); b2.add(hd);
    legs.forEach((l, i) => { l.add(mesh([[cyl(0.014, 0.014, 0.2, 4), 0xf2a020, M4(0, -0.1, 0)], [box(0.08, 0.015, 0.1), 0xf2a020, M4(0, -0.2, 0.03)]])); l.position.set(i ? 0.08 : -0.08, 0.21, 0); body.add(l); }); body.add(b2);
    A(0, (st, tt) => { const mv = st !== 'idle' && st !== 'dead', s = Math.sin(tt * 14); legs[0].rotation.x = mv ? s * 0.7 : 0; legs[1].rotation.x = mv ? -s * 0.7 : 0; hd.position.z = 0.16 + (mv ? Math.sin(tt * 14) * 0.04 : Math.sin(tt * 2) > 0.8 ? 0.05 : 0); hd.rotation.x = !mv && Math.sin(tt * 1.3) > 0.7 ? 0.9 : 0; body.rotation.z = st === 'dead' ? 1.5 : 0; });
    actor.height = 0.6 * size; actor.userData.radius = 0.25 * size;
  } else { // bird, bat: flap
    const bat = kind === 'bat', c = o.color ?? (bat ? 0x3a2a3a : 0x3a6ab8), wings = [new THREE.Group(), new THREE.Group()];
    body.add(mesh(bat ? [[ball(0.12, 8, 6), c, M4(0, 0, 0, 1, 1, 1.2)], [cone(0.04, 0.1, 4), c, M4(0.06, 0.13, 0.05)], [cone(0.04, 0.1, 4), c, M4(-0.06, 0.13, 0.05)], [ball(0.02, 5, 4), 0xff4040, M4(0.05, 0.03, 0.13)], [ball(0.02, 5, 4), 0xff4040, M4(-0.05, 0.03, 0.13)]] : [[ball(0.11, 8, 6), c, M4(0, 0, 0, 0.9, 0.9, 1.6)], [ball(0.075, 8, 6), c, M4(0, 0.07, 0.17)], [cone(0.025, 0.09, 4), 0xf2a020, M4(0, 0.06, 0.27, 1, 1, 1, Math.PI / 2, 0, 0)], [box(0.1, 0.01, 0.2), o.accent ?? c, M4(0, 0, -0.24)], [ball(0.07, 6, 5), o.accent ?? 0xf2efe8, M4(0, -0.04, 0.05, 1, 0.7, 1.4)]]));
    wings.forEach((w, i) => { const s = i ? 1 : -1, g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(bat ? [0, 0, 0.1, s * 0.5, 0, 0.12, s * 0.42, 0, -0.1, 0, 0, 0.1, s * 0.42, 0, -0.1, s * 0.2, 0, -0.04, 0, 0, 0.1, s * 0.2, 0, -0.04, 0, 0, -0.1] : [0, 0, 0.1, s * 0.46, 0, 0.02, 0, 0, -0.12, s * 0.46, 0, 0.02, s * 0.3, 0, -0.16, 0, 0, -0.12], 3)); g.computeVertexNormals(); const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: o.accent ?? c, side: THREE.DoubleSide })); m.castShadow = true; w.add(m); w.position.set(s * 0.07, 0.04, 0); body.add(w); });
    A(0, (st, tt) => { const f = Math.sin(tt * (bat ? 18 : 12)) * 0.9; wings[0].rotation.z = -f; wings[1].rotation.z = f; body.position.y = (o.altitude ?? 0) + Math.sin(tt * 2) * 0.1; body.rotation.z = st === 'dead' ? 1.6 : 0; });
    actor.height = 0.3 * size; actor.userData.radius = 0.3 * size; actor.flies = true;
  }
  actor.joints = {}; actor.isActor = true; actor.species = kind; actor.state = 'idle'; actor.userData.scale = size;
  return actor;
}

/**
 * Makes an actor wander on its own: walk to a random nearby point, stand, repeat. Registers itself on the stage.
 * Options: heightAt (x, z) -> y, center [x, z] and radius (the area it stays in), speed, pause [min, max] seconds,
 * flee (an Object3D to run away from) or chase (an Object3D to run towards), range (how close triggers it),
 * altitude (for birds and bats), onReach(actor, target) when a chase gets within 1.2 m.
 * Returns { stop(), actor }. Set actor.userData.frozen = true to pause it, or call actor.animate('dead') after stop().
 */
export function wander(actor, opts = {}) {
  const st = opts.stage || currentStage(), { heightAt = () => 0, radius = 14, speed = 1.3, pause = [1, 4], range = 9, altitude = actor.flies ? 4 : 0 } = opts, c = opts.center || [actor.position.x, actor.position.z];
  let tx = actor.position.x, tz = actor.position.z, wait = Math.random() * 2, yaw = actor.rotation.y;
  const step = (dt) => {
    if (actor.userData.frozen || actor.state === 'dead' && actor.userData.dead) return;
    const threat = opts.flee || opts.chase, near = threat && Math.hypot(threat.position.x - actor.position.x, threat.position.z - actor.position.z) < range;
    let run = false;
    if (near && opts.flee) { const dx = actor.position.x - threat.position.x, dz = actor.position.z - threat.position.z, l = Math.hypot(dx, dz) || 1; tx = actor.position.x + dx / l * 6; tz = actor.position.z + dz / l * 6; wait = 0; run = true; }
    if (near && opts.chase) { tx = threat.position.x; tz = threat.position.z; wait = 0; run = true; }
    const dx = tx - actor.position.x, dz = tz - actor.position.z, d = Math.hypot(dx, dz);
    if (wait > 0) { wait -= dt; actor.animate(actor.flies ? 'walk' : 'idle', dt); }
    else if (d < (run && opts.chase ? 1.2 : 0.4)) { if (run && opts.chase && opts.onReach) opts.onReach(actor, threat); wait = pause[0] + Math.random() * (pause[1] - pause[0]); const a = Math.random() * TAU, r = Math.sqrt(Math.random()) * radius; tx = c[0] + Math.cos(a) * r; tz = c[1] + Math.sin(a) * r; if (run) wait = 0.3; }
    else { const v = speed * (run ? 2.6 : 1) * dt; actor.position.x += dx / d * Math.min(v, d); actor.position.z += dz / d * Math.min(v, d); let da = Math.atan2(dx, dz) - yaw; da = Math.atan2(Math.sin(da), Math.cos(da)); yaw += da * Math.min(1, dt * 7); actor.rotation.y = yaw; actor.animate(run ? 'run' : 'walk', dt, run ? 1 : speed / 1.3); }
    actor.position.y = heightAt(actor.position.x, actor.position.z) + altitude;
  };
  const off = st ? st.onUpdate(step) : () => {};
  return { actor, stop: off, step };
}

/**
 * Player movement with a camera, done: reads the input, moves the actor over the ground, stops at solid things,
 * jumps, animates the actor, and keeps the camera behind it. Call controller.update(dt) once per frame.
 *   const player = control(hero, { input, heightAt: land.heightAt, solids: forest.solids });
 * Options: input (from createInput in @gcp/input.js; required), stage, mode ('third' behind the player with drag-to-look,
 * 'top' a fixed high camera, 'side' a side-scroller view), heightAt (x, z) -> y (any function: return the top of a
 * floor, a bridge or a player-built block where there is one and the land elsewhere, and the hero stands on it),
 * solids [{ x, z, r }] (circles the player cannot enter; scatter() returns them as .solids. The array is read every
 * frame, so push to it, splice it or set solid.off = true at any time: there is no need to assign it again. A step up
 * to 1.2 is climbed and a higher one stops the hero, so floors and stairs carry it and walls block it), speed (4.5), runSpeed (7.5, hold Shift), jump (7.5, Space; 0
 * to disable), gravity (22), distance (camera distance, 7), pitch (camera tilt, 0.35), bounds (radius the player
 * stays inside), minY (e.g. water level: the player cannot go below it), canRun (() => false while out of stamina),
 * onJump, onLand, onStep (footstep sounds). Movement eases in and out. Running is Shift, or the action named 'run'
 * if you bound one with input.bind; an action named 'jump' jumps as Space does.
 * Returns { position, velocity, grounded, moving, running, speedNow, yaw, enabled, update(dt), teleport(x, z),
 *   ahead(d) -> { x, z } (the point d metres in front of the hero: where to place or hit),
 *   moveTo(x, z) -> Promise (walks there by itself: useful for cut-scenes and for play-through scripts) }.
 */
export function control(actor, opts = {}) {
  const st = opts.stage || currentStage(), cam = st.camera, input = opts.input, { mode = 'third', heightAt = () => 0, speed = 4.5, runSpeed = 7.5, jump = 7.5, gravity = 22, bounds = Infinity, minY = -Infinity } = opts;
  if (!input) throw new Error('control() needs { input }: const input = createInput(canvas) from "@gcp/input.js".');
  const C = { position: actor.position, velocity: new THREE.Vector3(), grounded: true, moving: false, speedNow: 0, yaw: actor.rotation.y, camYaw: opts.camYaw ?? Math.PI, camPitch: opts.pitch ?? (mode === 'top' ? 1.0 : 0.35), distance: opts.distance ?? (mode === 'top' ? 16 : mode === 'side' ? 11 : 7), enabled: true, solids: opts.solids || [], target: null, stepT: 0 };
  const look = new THREE.Vector3(), want = new THREE.Vector3(); let camReady = false;
  if (st && !st.focus) st.focus = actor;
  actor.position.y = Math.max(heightAt(actor.position.x, actor.position.z), minY);
  C.teleport = (x, z) => { actor.position.set(x, Math.max(heightAt(x, z), minY), z); C.velocity.set(0, 0, 0); camReady = false; };
  C.ahead = (d = 1) => ({ x: actor.position.x + Math.sin(C.yaw) * d, z: actor.position.z + Math.cos(C.yaw) * d });
  C.moveTo = (x, z, timeout = 20) => new Promise((res) => { C.target = { x, z, res, t: timeout }; });
  C.update = (dt) => {
    dt = Math.min(dt, 0.05); const p = actor.position; let mx = 0, mz = 0, running = false;
    if (C.enabled) {
      if (mode === 'third') { const l = input.takeLook(); C.camYaw -= l.dx; C.camPitch = clamp(C.camPitch + l.dy, -0.2, 1.3); }
      if (C.target) { const dx = C.target.x - p.x, dz = C.target.z - p.z, d = Math.hypot(dx, dz); C.target.t -= dt; if (d < 0.5 || C.target.t <= 0) { const r = C.target.res; C.target = null; r(d < 0.5); } else { mx = dx / d; mz = dz / d; running = d > 6; } }
      else { const m = input.move; if (mode === 'side') { mx = m.x; } else { const yaw = mode === 'third' ? C.camYaw : Math.PI, fx = -Math.sin(yaw), fz = -Math.cos(yaw); mx = fx * m.y - fz * m.x; mz = fz * m.y + fx * m.x; if (mode !== 'third') { mx = m.x; mz = -m.y; } } running = (input.actions && input.actions.run ? input.held('run') : input.down('ShiftLeft') || input.down('ShiftRight')) && (!opts.canRun || opts.canRun()); }
      if (jump > 0 && C.grounded && (input.pressed('Space') || (input.action && input.action('jump')) || (mode === 'side' && (input.pressed('ArrowUp') || input.pressed('KeyW'))))) { C.velocity.y = jump; C.grounded = false; if (opts.onJump) opts.onJump(); }
    }
    const len = Math.hypot(mx, mz), go = len > 0.08, sp = (running ? runSpeed : speed) * Math.min(1, len), ease = C.target ? 1 : 1 - Math.exp(-dt * (go ? 14 : 20)), vel = C.velocity;
    vel.x += ((go ? mx / len * sp : 0) - vel.x) * ease; vel.z += ((go ? mz / len * sp : 0) - vel.z) * ease;   // eases in and out instead of snapping
    const v = Math.hypot(vel.x, vel.z); C.moving = v > 0.4; C.speedNow = v; C.running = running && go;
    if (v > 0.02) { let x = p.x + vel.x * dt, z = p.z + vel.z * dt;
      for (const s of C.solids) { if (s.off) continue; const dx = x - s.x, dz = z - s.z, rr = (s.r || 0.5) * 0.7 + 0.3, d2 = dx * dx + dz * dz; if (d2 < rr * rr && d2 > 1e-6) { const d = Math.sqrt(d2); x = s.x + dx / d * rr; z = s.z + dz / d * rr; } }
      const d0 = Math.hypot(x, z); if (d0 > bounds) { x *= bounds / d0; z *= bounds / d0; }
      const gy = heightAt(x, z); if (!C.grounded || gy - p.y < 1.2) { p.x = x; p.z = z; } else { vel.x = vel.z = 0; }
      if (go) { let da = Math.atan2(mx, mz) - C.yaw; da = Math.atan2(Math.sin(da), Math.cos(da)); C.yaw += da * Math.min(1, dt * 12); actor.rotation.y = C.yaw; }
      if (C.grounded && C.moving && opts.onStep) { C.stepT -= dt * v; if (C.stepT <= 0) { C.stepT = 2.2; opts.onStep(); } }
    }
    const ground = Math.max(heightAt(p.x, p.z), minY);
    if (C.grounded) { p.y += (ground - p.y) * Math.min(1, dt * 18); }
    else { C.velocity.y -= gravity * dt; p.y += C.velocity.y * dt; if (p.y <= ground) { p.y = ground; C.velocity.y = 0; C.grounded = true; if (opts.onLand) opts.onLand(); } }
    if (actor.animate) actor.animate(!C.grounded ? (C.velocity.y > 0 ? 'jump' : 'fall') : C.moving ? (running ? 'run' : 'walk') : 'idle', dt, C.moving ? Math.max(0.5, v / (running ? runSpeed : speed)) : 1);
    const h = (actor.height || 1.7) * 0.8; look.set(p.x, p.y + h, p.z);
    if (mode === 'side') want.set(p.x, p.y + h + 1.5, p.z + C.distance);
    else { const cy = Math.cos(C.camPitch), yaw = mode === 'third' ? C.camYaw : Math.PI; want.set(p.x + Math.sin(yaw) * cy * C.distance, p.y + h + Math.sin(C.camPitch) * C.distance, p.z + Math.cos(yaw) * cy * C.distance); if (mode === 'top') want.set(p.x, p.y + Math.sin(C.camPitch) * C.distance, p.z + Math.cos(C.camPitch) * C.distance); }
    const floor = heightAt(want.x, want.z) + 0.6; if (want.y < floor) want.y = floor;
    if (!camReady) { cam.position.copy(want); camReady = true; } else cam.position.lerp(want, Math.min(1, dt * 9));
    cam.lookAt(look);
  };
  return C;
}
defineRecipe('humanoid', { summary: 'A jointed, animated person.', cache: false, params: { preset: HUMANOIDS.join(' | '), height: 'metres', skin: 'colour', shirt: 'colour', pants: 'colour', hair: 'colour', hat: 'cap | straw | wizard | helmet | hood | crown | tricorn | visor | antenna', tool: 'sword | staff | axe | pickaxe | torch | pitchfork | wand', cape: 'colour', seed: 'variation' }, make: (p) => humanoid(p) });
defineRecipe('animal', { summary: 'A jointed, animated creature.', cache: false, params: { animal: ANIMALS_LIST.join(' | '), color: 'coat', accent: 'second colour', size: 'scale' }, make: (p) => animal(p.animal, p) });

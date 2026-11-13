// Frozen outputs of the procedural core: "same seed, same result" as a test. Every value below is produced from a
// seed and compared with tests/procgen.golden.json. A difference means an algorithm changed without a new version
// number (ALGO in procgen/noise.js, `v` in a recipe), which would silently alter worlds already built from a seed.
//   node tests/procgen.mjs            compare
//   node tests/procgen.mjs --update   rewrite the golden file (only together with a version bump)
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import * as P from '../web/public/kits/v1/procgen.js';
import * as C from '../web/public/kits/v1/craft.js';

const file = fileURLToPath(new URL('./procgen.golden.json', import.meta.url));
const fnv = (bytes) => { let h = 0x811c9dc5; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
const sum = (typed) => fnv(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength));
const pts = [[0, 0], [0.5, 0.25], [3.7, -2.2], [-17.31, 44.9], [1000.5, -999.25]];

const out = { algo: P.ALGO };
out.pcg = [0, 1, 2, 12345, 0xffffffff].map((n) => P.pcg(n));
out.hash2i = pts.map(([x, y]) => P.hash2i(Math.floor(x), Math.floor(y), 7));
out.hash3 = pts.map(([x, y]) => P.hash3(Math.floor(x), Math.floor(y), 3, 9));
out.strSeed = ['', 'ember', 'Game Creator', '种子'].map(P.strSeed);
out.mixSeed = [P.mixSeed(1, 'trees', 3), P.mixSeed('world', 2)];
{ const r = P.mulberry32(1234); out.mulberry32 = [r(), r(), r()]; }
{ const r = P.rng('level-3'); out.rng = [r(), r.range(2, 5), r.int(1, 6), r.pick(['a', 'b', 'c']), r.gauss(), r.fork('trees')(), r.shuffle([1, 2, 3, 4, 5]).join('')]; }
out.vnoise2 = pts.map(([x, y]) => P.vnoise2(x, y, 5));
out.vnoise2_tile = pts.map(([x, y]) => P.vnoise2(x, y, 5, 4));
out.gnoise2 = pts.map(([x, y]) => P.gnoise2(x, y, 5));
out.gnoise2d = pts.map(([x, y]) => [...P.gnoise2d(x, y, 5)]);
out.vnoise3 = pts.map(([x, y]) => P.vnoise3(x, y, 0.37, 3));
out.gnoise3 = pts.map(([x, y]) => P.gnoise3(x, y, 0.37, 3));
out.fbm2 = pts.map(([x, y]) => P.fbm2(x, y, 9));
out.fbm2_value = pts.map(([x, y]) => P.fbm2(x, y, 9, 4, 2, 0.5, 4, 'value'));
out.ridged2 = pts.map(([x, y]) => P.ridged2(x, y, 3));
out.warp2 = pts.map(([x, y]) => P.warp2(x, y, 3));
out.worley2 = pts.map(([x, y]) => [...P.worley2(x, y, 4)]);
{ const s = new P.Simplex(42); out.simplex = pts.map(([x, y]) => [s.n2(x, y), s.n3(x, y, 0.5)]); }
{ const n = P.noise({ seed: 'isle', type: 'fbm', scale: 60, octaves: 5 }), a = new Float32Array(64 * 64); n.fill(a, 64, 64, { x0: -32, y0: -32, step: 1 }); out.noise_field = sum(a); out.noise_point = n(3, 4); }

out.textures = Object.fromEntries(P.TEXTURES.map((k) => [k, fnv(P.paint(k, { size: 32, seed: 3 }).toRGBA())]));
out.texture_normal = fnv(P.paint('brick', { size: 32 }).normalRGBA(2));
out.texture_colour = fnv(P.paint('planks', { size: 32, color: 0x8a5a3a, scale: 2 }).toRGBA());

const geo = (g) => ({ vertices: g.attributes.position.count, triangles: P.countTriangles(g), positions: sum(g.attributes.position.array) });
out.displace = geo(P.displace(new THREE.IcosahedronGeometry(1, 1), { amount: 0.22, frequency: 1.4, seed: 7 }));
out.merge = geo(P.mergeParts([[new THREE.BoxGeometry(1, 1, 1), 0x8a5a3a, P.M4(0, 0.5, 0)], [new THREE.ConeGeometry(0.8, 1, 6), 0xb8432a, P.M4(0, 1.5, 0)]]));
out.tbox = sum(P.tbox(4, 3, 0.3, 2).attributes.uv.array);
out.simplify = geo(P.simplify(new THREE.IcosahedronGeometry(1, 3), { ratio: 0.4 }));
for (const [name, kind] of [['tree_oak', C.tree({ species: 'oak', seed: 4 })], ['tree_pine', C.tree({ species: 'pine', seed: 2 })], ['rock', C.rock({ seed: 3 })], ['bush', C.bush({ seed: 2 })], ['house', C.prop('house', { seed: 3 })], ['fern', C.groundCover('fern', { seed: 1 })]]) {
  out[name] = kind.parts.map((p) => geo(p.geometry));
}
out.recipe = [P.recipeKey(C.recipe('tree', { species: 'oak', seed: 4 })), C.variants({ kind: 'rock', seed: 1 }, 3).map((r) => r.seed)];
out.recipe_same = C.build({ kind: 'tree', species: 'oak', seed: 4 }) === C.build({ seed: 4, species: 'oak', kind: 'tree' });   // key order does not matter

const text = JSON.stringify(out, null, 1);
if (process.argv.includes('--update') || !existsSync(file)) { writeFileSync(file, text + '\n'); console.log(`wrote ${file}`); process.exit(0); }
const golden = JSON.parse(readFileSync(file, 'utf8')), now = JSON.parse(text);
let checked = 0;
for (const k of Object.keys(golden)) { assert.deepEqual(now[k], golden[k], `procedural output "${k}" changed. If that is intended, bump its version (ALGO or the recipe's v) and run with --update.`); checked++; }
assert.deepEqual(Object.keys(now).sort(), Object.keys(golden).sort(), 'the set of checked outputs changed; run with --update');
console.log(`✓ procedural core: ${checked} groups of frozen outputs match (${P.TEXTURES.length} textures, ${pts.length} sample points per noise function)`);

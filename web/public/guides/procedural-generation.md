# Procedural generation

`@gcp/procgen.js` is the layer the building blocks are made of, and it is yours to use directly: meshes and textures generated from a seed and a few parameters. The output is plain geometry and plain pixels, so it does not care which renderer, pipeline or engine draws it.

```js
import { rng, noise, mergeParts, M4, displace, tbox, lodMesh, paint, defineTexture, defineRecipe, build, variants } from '@gcp/procgen.js';
```

It has four layers and one idea on top.

| Layer | What is in it | Needs Three.js |
|---|---|---|
| 1. Random numbers, hashes, noise | `rng`, `mulberry32`, `strSeed`, `pcg`, `hash2`, `hash3`, `vnoise2/3`, `gnoise2/3`, `gnoise2d` (with derivatives), `fbm2`, `ridged2`, `warp2`, `worley2`, `noise()` | no |
| 2. The same noise in shaders | `NOISE_GLSL`, `withNoise(material, …)` | only `withNoise` |
| 3. Mesh builder | `tbox`, `tplane`, `tcylinder`, `tprism`, `mergeParts`, `displace`, `weldGeometry`, `smoothNormals`, `flatNormals`, `simplify`, `lodMesh`, `colourise` | yes |
| 4. Texture painter | `Raster`, `paint`, `defineTexture`, 39 generators, `normalRGBA`, `mips` | no |
| Recipes | `defineRecipe`, `recipe`, `build`, `variants`, `recipeKinds` | no |

`list_blocks {group: "noise"}` (or `gpu-noise`, `mesh`, `texture`, `recipe`) prints every function with its options. `{{ORIGIN}}/lab` shows any recipe live and runs the CPU = GPU check on your device.

## Same seed, same world

Everything here is deterministic: the same seed and parameters give the same result on every device and on every visit. That is what lets a world be stored as a few numbers, rebuilt instead of downloaded, and shared between players in a multiplayer room by sending only the seed.

Three rules make that hold, and they are the rules to follow when you add your own generators:

1. **Never call `Math.random()` while generating.** Take a stream from `rng(seed)`. `rng('level-3').fork('trees')` gives an independent stream, so adding a rock later does not move every tree.
2. **Integer hashes are exact everywhere.** `pcg`, `hash2i`, `hash3i` use 32-bit integer arithmetic (`Math.imul`, `>>>`) that JavaScript and GLSL define identically. Lattice values are 24-bit, so they are exact in a 32-bit float.
3. **Noise is computed in float32 steps** with only `+ − × floor` (no `sin`, no `pow`, no `fract` of large numbers), in the same order in JavaScript and in the shader. Measured on the platform's verification GPU: all ten noise functions agree with their GLSL twins on 65,536 of 65,536 sample points, compared as 24-bit integers. Some GPUs fuse a multiply and an add into one operation, which can move a value by one unit in the last place; when a decision must match exactly between CPU and GPU (collision against a shader-displaced surface, for example), take it from the JavaScript value.

Every algorithm has a version in `ALGO` (`ALGO.gradient`, `ALGO.fractal`, …) and every recipe kind has a version `v`. An output for a given version is frozen: if an algorithm is ever improved it gets a new version number and the old one keeps working, so a world saved from a seed last year still rebuilds the same.

## Noise on the CPU and in a shader

```js
const hills = noise({ seed: 'isle', type: 'fbm', scale: 60, octaves: 5 });
const y = hills(x, z) * 12;                         // about [-1, 1] before scaling

const heights = new Float32Array(256 * 256);
hills.fill(heights, 256, 256, { x0: -128, y0: -128, step: 1 });   // a whole heightmap in one call
```

The same field inside a built-in Three.js material, without leaving the material system:

```js
import { withNoise } from '@gcp/procgen.js';
withNoise(material, { fragment: `diffuseColor.rgb *= 0.8 + 0.2 * ${hills.glsl('vGcpWorld.xz')};` });
```

`type` is `fbm`, `ridged` (sharp crests), `warp` (flowing), `value`, `gradient` or `vfbm` (the cheapest). `period` makes a field tile. `gnoise2d(x, y, seed)` returns the value with its analytic derivatives `[v, dv/dx, dv/dy]`, which gives terrain normals and erosion-style shaping without sampling neighbours. `worley2` gives cells (cobbles, scales, cracked mud).

## Meshes

A model is parts merged into one geometry with vertex colours: one draw call, one shared material.

```js
import * as THREE from 'three';
import { mergeParts, M4, displace, rng } from '@gcp/procgen.js';

function crystalRock(seed = 1) {
  const r = rng(seed), parts = [];
  parts.push([displace(new THREE.IcosahedronGeometry(1, 1), { amount: 0.22, frequency: 1.4, seed }), 0x6f6a72, M4(0, 0.5, 0, 1.3, 0.8, 1.2)]);
  for (let i = 0; i < 5; i++) {     // M4(x, y, z, sx, sy, sz, rx, ry, rz)
    parts.push([new THREE.ConeGeometry(0.16, r.range(0.7, 1.5), 5), r.pick([0x6ef0ff, 0x9ad8ff, 0xc8f4ff]), M4(r.range(-0.6, 0.6), 1.1, r.range(-0.6, 0.6), 1, 1, 1, r.range(-0.4, 0.4), 0, r.range(-0.4, 0.4))]);
  }
  return mergeParts(parts);          // indexed, welded, with colours and UVs
}
const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
scene.add(new THREE.Mesh(crystalRock(7), material));
```

- `displace` moves vertices with seeded noise or your own function and keeps shared edges joined (it welds by quantised position first). This is what turns a sphere into a boulder or a canopy.
- `tbox(w, h, d, tile)`, `tplane`, `tcylinder`, `tprism` are primitives whose UVs repeat every `tile` world units on every face, so a wall, a floor and a crate made with the same material show bricks of the same size.
- `simplify(geo, { ratio })` makes a cheaper copy and `lodMesh(geo, material, { distances: [0, 40, 90] })` returns a `THREE.LOD` that swaps copies with distance.
- `smoothNormals` and `flatNormals` recompute normals after you move vertices.

To use your mesh with `place` and `scatter` from `@gcp/craft.js`, wrap it as a kind:

```js
const kind = { parts: [{ geometry: crystalRock(7), material }], radius: 1.3, height: 2, solid: true };
scatter([kind], { count: 60, radius: 80, heightAt: land.heightAt });
```

## Textures

`paint(kind, options)` returns a `Raster`: pixels plus a height channel. Every built-in generator tiles and can be repainted in any colour.

```js
const r = paint('planks', { seed: 3, color: 0x8a5a3a, scale: 2, size: 128 });
r.toRGBA();          // bytes for a THREE.DataTexture or any other engine
r.normalRGBA(2);     // a normal map made from the height channel
r.mips();            // the full mip chain when your engine wants explicit mips
r.toCanvas();        // a canvas: drawImage in a 2D game, or a CSS background
```

In Three.js, `surface(kind, options)` from `@gcp/craft.js` does all of that and returns a ready material; `surfaceTexture` returns just the texture.

Your own generator is a function called once per pixel. Use only the procgen noise functions inside and it stays deterministic and tiling:

```js
import { defineTexture, fbm2, worley2 } from '@gcp/procgen.js';

defineTexture('scales', 0x3f8a6a, (u, v, P, px) => {
  const [f1, f2] = worley2(u * 8 * P.k, v * 8 * P.k, P.seed, 8 * P.k);     // period = frequency, so it tiles
  const edge = Math.min(1, (f2 - f1) * 4), tone = 0.75 + 0.25 * fbm2(u * 6, v * 6, P.seed, 3, 2, 0.5, 6, 'value');
  px[0] *= edge * tone; px[1] *= edge * tone; px[2] *= edge * tone; px[3] = edge;    // px[3] is height
});
const dragonHide = surface('scales', { color: 0x7a3a8a, relief: 2 });
```

For drawn patterns there is a small rasteriser on `Raster`: `fill`, `rect`, `disc`, `line`, `noise`, `each`. Coordinates are in tile units (0 to 1) and everything wraps around the edges, so whatever you draw still tiles.

## Recipes

A recipe is an asset written as data: a kind, a version, a seed and parameters.

```js
import { build, recipe, variants } from '@gcp/craft.js';

const oak = recipe('tree', { species: 'oak', seed: 4 });     // { kind: 'tree', v: 1, species: 'oak', seed: 4 }
const kind = build(oak);                                     // built once, then served from a cache
const grove = variants(oak, 5).map(build);                   // five individuals of the same species
```

Recipes are plain JSON, so they can be saved with `GCP.save`, sent to other players, listed in a level file, or edited in the lab and pasted into code. The built-in kinds are `texture`, `noise`, `surface`, `tree`, `rock`, `bush`, `cover`, `terrain`, `prop`, `humanoid` and `animal`.

Register your own so your generators get the same treatment:

```js
import { defineRecipe } from '@gcp/procgen.js';

defineRecipe('crystal-rock', {
  v: 1, summary: 'A boulder with crystals growing out of it.', params: { seed: 'shape', size: 'metres' },
  make: (p) => ({ parts: [{ geometry: crystalRock(p.seed).scale(p.size ?? 1, p.size ?? 1, p.size ?? 1), material }], radius: 1.3 * (p.size ?? 1), height: 2 * (p.size ?? 1), solid: true }),
});
scatter(variants({ kind: 'crystal-rock', seed: 1 }, 4).map(build), { count: 80, radius: 90, heightAt: land.heightAt });
```

When you later change what `make` produces, register the new behaviour under `v: 2`. Recipes stored with `v: 1` keep building the old way.

## What to generate and what to load

Generate when the thing is repeated with variation (trees, rocks, houses, terrain, tiling surfaces), when it must match across players, or when download size matters. Load a file when the thing is a one-off with authored detail: a hero character from a modelling tool, a logo, recorded music. Both are welcome on the platform; `GLTFLoader` is in `three/addons/loaders/GLTFLoader.js`, and a loaded model can stand next to generated ones under the same stage.

# Realistic materials and models

`@gcp/materials.js` gives a game the realistic (PBR) look: brick that is rough in the mortar, paint that has chipped down to rusty steel, planks with grain and gaps, wet asphalt after rain. Nothing is downloaded. Every texture is painted on the GPU when the game loads, from a short shader over a library of tileable noise, and every model is built in code from real-sized parts.

It is opt-in. `@gcp/craft.js` keeps its painted low-poly look, and the two work together: `createStage`, `place`, `scatter`, `control`, `humanoid`, the HUD and sound from craft all take what this kit makes.

## The three levels

1. **A name.** `material('steel_rusty')`, `model('crate')`. Call `list_blocks` for every valid name (`valid_names.materials` and `valid_names.models`).
2. **Plain data.** A material is a base texture set plus weathering, all plain numbers. Invent as many as the game needs:
   ```js
   material({ base: 'metal', paint: '#b8322a', chips: 0.6, rust: 0.3, dirt: 0.4 })   // a red machine, chipped and rusting
   material({ base: 'planks', color: '#8a6440', moss: 0.3, dirt: 0.5 })               // an old jetty
   material({ name: 'brick', color: '#6e3a2a', leaks: 0.6 })                           // a named one, changed
   ```
3. **Your own shader.** `defineBase(name, { glsl })` adds a base texture set painted by your GLSL. All weathering then works on it too.

## A complete scene

```js
import * as THREE from 'three';
import { createStage, place, scatter, createHud } from '@gcp/craft.js';
import { material, model, parts, plane, followWeather } from '@gcp/materials.js';

const stage = createStage('#game', { mood: 'overcast' });
followWeather(stage);                         // rain wets every material, snow settles on their tops

// the ground: plane() has UVs in metres, so the texture keeps its real size; big floors hide their tiling
const ground = new THREE.Mesh(plane(200, 200).rotateX(-Math.PI / 2), material('asphalt'));
ground.receiveShadow = true; stage.scene.add(ground);

// ready models: place(kind, x, y, z, { rotY })
place(model('container', { length: 12, color: '#22457a' }), 0, 0, -8, { rotY: 0.1 });
place(model('container', { seed: 2 }), 7, 0, -6, { rotY: -0.3 });
for (let i = 0; i < 6; i++) place(model('drum', { seed: i }), -6 + i * 0.7, 0, -3);
place(model('lamp_post'), -4, 0, 2);
scatter(stage.scene, [model('pallet'), model('crate'), model('barrier')], { count: 20, radius: 30, minDistance: 3 });

// a model of your own, from parts in metres
const p = parts();
p.box('concrete', [3, 0.2, 2], [0, 0.1, 0]);                                     // size [w, h, d], centre [x, y, z]
p.box({ base: 'metal', paint: '#c9961c', chips: 0.5, dirt: 0.3 }, [1.6, 1.2, 1], [0, 0.8, 0]);
p.cylinder('steel_rusty', 0.08, 1.4, [0.6, 1.4, 0.2]);                             // radius, height, base centre
p.bar('rubber', [-0.8, 1.2, 0.5], [-1.4, 0.2, 0.9], 0.03);                          // a round bar between two points
p.label('GEN-02', 0.12, [0, 1.1, 0.51], { color: '#1c1d1f' });                       // text on the front face
place(p.build('generator'), 3, 0, 1);

stage.run((dt) => { /* your game */ });
```

## Materials

`material(nameOrRecipe, options)` returns a `MeshStandardMaterial`. The textures are baked once per recipe and cached: asking again costs nothing. On a graphics card a set takes a few milliseconds; on the verification browser (no GPU) about 60 ms plus a one-time shader compile, so a scene with 25 different materials boots in under two seconds there.

**Recipe fields** (all optional except `base` or `name`):

| field | what it does |
| --- | --- |
| `base` | the texture set: concrete, asphalt, brick, stonewall, cobble, tiles, plaster, marble, metal, brushed, galvanized, corrugated, diamondplate, panels, rust, plastic, rubber, fabric, leather, tarp, cardboard, planks, wood, bark, endgrain, thatch, shingles, rooftile, grass, dirt, mud, sand, gravel, rock, snow, ice, moss, forest, leaves, lava |
| `name` | start from a named material and change some fields |
| `color`, `color2` | the main colour, and the second one (mortar, grout, the gaps between boards, marble veins) |
| `paint` | a colour painted over the base, with `chips`, `scratches` (0..1) and `gloss` (the paint's roughness) |
| `wear` | high spots rubbed bright |
| `rust`, `dirt`, `moss`, `leaks`, `dust` | weathering, 0..1 |
| `seed` | another pattern of the same thing |
| `p` | numbers some bases read: `planks` [boards across], `tiles` [tiles across], `panels` [x, y] |

**Options** (how it is applied, not how it looks): `scale` (2 = texture twice as big), `mapping: 'box'` (projects the texture on the object's own axes: right for any geometry, such as a plain `THREE.BoxGeometry` or a sculpted rock), `variation` (large-scale patchiness in world space), `grime` (darker where things meet the ground), `snow` (0..1 snow on the upper faces), `noRepeat`, `side`, `size` (texture pixels).

**UVs are metres.** Everything from `parts()` and `plane()` has UVs in metres, so a wall and a crate show the same brick size. A geometry you made yourself with 0..1 UVs shows one texture tile per face: use `mapping: 'box'` for it instead.

**Rain and snow.** `followWeather(stage)` once, then `stage.setWeather('rain')` wets every material over a few seconds (darker, shinier, more on up-facing faces) and it dries when the rain stops; `'snow'` settles on upper faces. `SURFACE_WEATHER.wet.value` and `.snow.value` set it by hand.

**Metal needs something to reflect.** `createStage` provides reflections on devices with a GPU. Without them (your own renderer and no `scene.environment`, or the software renderer of the verification browser) metal is drawn brighter and less metallic so it does not turn black.

## Models

`model(name, options)` returns a kind: `place(kind, x, y, z, { rotY, scale })` puts one in the world, `scatter()` places many, and `toGroup(kind)` gives a plain `THREE.Group` for a scene without craft. Options: `seed` (another copy: other boards, another colour) and the model's own (`length`, `width`, `color`, `text`, …; `get_block model` lists them). `kind.size` is the bounding box and `kind.colliders` the boxes to collide with.

`parts()` builds your own. Every size and position is in metres, y is up, and a model usually stands on y = 0.

| call | makes |
| --- | --- |
| `box(mat, [w, h, d], [x, y, z], { rot, bevel })` | a box with 1 cm rounded edges (the edges catch light: keep them) |
| `cylinder(mat, r, h, [x, y, z], { r2, bevel, segments, open, rot })` | a cylinder standing on the point |
| `sphere(mat, r, [x, y, z])` | a sphere |
| `lathe(mat, [[r, y], …], [x, y, z])` | a turned shape: barrels, bottles, vases, posts |
| `tube(mat, [[x, y, z], …], r)` | a smooth tube along points: pipes, cables, rails |
| `bar(mat, a, b, r)` / `beam(mat, a, b, [w, d])` | a round bar or a square beam between two points |
| `extrude(mat, [[x, y], …], depth, [x, y, z], { rot, holes })` | an outline pushed out: signs, brackets, anvils, arches |
| `plane(mat, [w, h], [x, y, z], { rot })` | a flat panel |
| `label(text, height, [x, y, z], { rot, color, background, worn })` | painted text |
| `push([x, y, z], [rx, ry, rz])` … `pop()` | moves and turns everything added in between |
| `build(name)` / `group()` | the finished kind / a `THREE.Group` |

`mat` is a material name, a recipe object, or any `THREE.Material`. Parts that share a material are merged into one draw call, so a model with forty parts in four materials costs four draw calls.

What makes a model read as real:

- **Real sizes.** A door is 2 m tall, a crate 0.6 to 1 m, a table top 0.75 m high, a step 0.18 m.
- **Thickness.** Boards are 2 to 4 cm thick, posts 8 to 12 cm, sheet metal 2 to 5 mm. Nothing is paper-thin.
- **Several materials.** Wood with iron fittings, painted steel with rubber and a label: three materials beat one.
- **Weathering where it belongs.** Rust and leaks on outdoor metal, dirt low down, moss on north-facing stone.
- **Variation.** Pass a different `seed` to each copy and turn copies with `rotY`.

## For 2D and 2.5D games

`textureCanvas(nameOrRecipe, { size, channel })` returns a canvas that tiles seamlessly. `channel: 'lit'` (the default) is the colour already shaded by its own relief, which is what a flat game wants for ground, walls and floors:

```js
import { textureCanvas } from '@gcp/materials.js';
const cobbles = textureCanvas('cobblestone', { size: 256 });
ctx.fillStyle = ctx.createPattern(cobbles, 'repeat'); ctx.fillRect(0, 0, w, h);
```

## Writing your own base

```js
import { defineBase, material } from '@gcp/materials.js';
defineBase('hexfloor', { color: 0x6a6e72, color2: 0x202224, tile: 1.5, bump: 4, glsl: `
void base(vec2 uv, inout Surf s){
  vec4 c = cells(uv * 8.0, vec2(8.0), 1.0);                 // Voronoi cells: x = distance to the centre, z = random per cell
  float edge = smoothstep(0.02, 0.08, c.y - c.x);           // 0 in the joints
  s.col = mix(uC2, uC1 * (0.7 + 0.5 * c.z), edge);          // uC1, uC2: the recipe's color and color2
  s.h = 0.2 + 0.6 * edge; s.r = 0.5 + 0.3 * c.w; s.m = 0.0; s.ao = 0.5 + 0.5 * edge;
}` });
const floorMat = material({ base: 'hexfloor', dirt: 0.4 });
```

The function receives `uv` from 0 to 1 across one tile and fills `s`: `col` (linear colour), `h` (height 0..1, which becomes the normal map), `ao`, `r` (roughness), `m` (metalness) and `a` (opacity, cut below 0.5 when `cut: true`). The helpers: `fbm(uv, freq, octaves, salt)`, `ridged`, `cells`, `warp`, `scratches`, `chips`, `patches`, `bond(uv, rows, cols, offset)` for brick and plank layouts, `grout`, `noise`, `hash3`, `lin(r, g, b)`. Use whole-number frequencies (`vec2(12.0)`, `vec2(20.0, 11.0)`): the patterns then wrap at the tile's edge and the texture has no seams.

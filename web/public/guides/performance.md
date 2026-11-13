# Performance

Sixty frames a second means 16 ms for everything. Measure first; the slow part is rarely the one you would guess.

## Measure

```js
// Three.js: numbers for the last frame
const { calls, triangles } = renderer.info.render;
const { geometries, textures } = renderer.info.memory;
if (window.GCP) GCP.stats({ calls, triangles, fps: Math.round(loop.fps) });   // shows up in verification reports
```

Rough targets for a mid-range phone: under 150 draw calls, under 300k triangles, and geometry and texture counts that stop growing after loading. A count that climbs while playing is a leak.

The browser's Performance panel shows whether time goes to script, to rendering, or to garbage collection (saw-tooth memory with periodic long frames).

## What usually costs the most, in order

1. **Pixels.** A phone with a device pixel ratio of 3 draws nine times the pixels of ratio 1. Cap it: `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`, or 1.5 on low quality. This single line is often the difference between 25 and 60 fps.
2. **Draw calls.** Each mesh with its own material is a call. Merge static things, instance repeated things, share materials. See the meshes guide.
3. **Shadows.** A shadow map draws the scene again. Use one shadow-casting light, fit its camera tightly around the player and move it with them, use 1024 or 2048, and turn `castShadow` off for small or distant objects. Static scenes can set `renderer.shadowMap.autoUpdate = false` and refresh on demand.
4. **Overdraw.** Layers of large transparent quads (smoke, grass cards, fog planes) shade the same pixel many times. Use fewer, smaller, or `alphaTest` instead of blending.
5. **Per-pixel cost.** `MeshStandardMaterial` with several lights is several times the cost of `MeshLambertMaterial`. Post-processing adds a full-screen pass per effect.
6. **Script.** Usually an O(n²) loop (every enemy checking every bullet) or per-frame allocation.

## Quality levels

Offer low, medium and high, pick a sensible default, remember the choice, and let the player change it.

```js
import { pickQuality, store } from '@gcp/core.js';
const quality = pickQuality(store.get('quality'));          // saved choice, or a guess from the device
const Q = {
  low:    { dpr: 1,   shadows: false, view: 120, props: 0.5, post: false },
  medium: { dpr: 1.5, shadows: true,  view: 200, props: 0.8, post: false },
  high:   { dpr: 2,   shadows: true,  view: 320, props: 1,   post: true  },
}[quality];
```

## Adapt while running

When the frame rate stays low, lower the resolution before anything else; players notice a soft image far less than a slow one.

```js
let scale = 1, slow = 0, fast = 0;
function adapt(fps) {                               // call about once a second with a smoothed fps
  if (fps < 40) { slow++; fast = 0; } else if (fps > 57) { fast++; slow = 0; }
  if (slow >= 3 && scale > 0.5) { scale = Math.max(0.5, scale - 0.15); slow = 0; apply(); }
  if (fast >= 10 && scale < 1) { scale = Math.min(1, scale + 0.1); fast = 0; apply(); }
}
const apply = () => renderer.setPixelRatio(Math.min(devicePixelRatio, Q.dpr) * scale);
```

The verification browser renders on the CPU and is slow. A game that adapts like this passes comfortably; a game that insists on full quality may render too few frames to count as alive.

## The verification browser: how heavy a scene can be

The browser that runs `deploy_preview` has no GPU. It draws a 960×540 page with a software renderer, so every pixel of every pass is shaded on a CPU core. To pass, the game has to call `GCP.ready()` within 30 seconds and then draw at least 6 frames in 3 seconds (2 frames a second). The report gives the frame rate it measured.

Measured there, for scale:

| Scene | Frame rate in the verification browser |
| --- | --- |
| `blank` template (2D canvas, a few rectangles) | about 60 fps |
| `canvas2d-arcade` template (cached ground chunks, about 60 sprites) | about 60 fps |
| `three-blank` template (one textured plane, two small meshes, two lights, no shadows) | about 14 fps |
| `three-explorer` template (35k-triangle terrain, 400 instanced props in 3 draw calls, one 2048 shadow map, Lambert materials, fog) | about 4 fps |

A low number in the report is normal for 3D: 4 fps there is 60 fps on an ordinary laptop. What matters is the distance to the 2 fps floor, and the explorer template shows how close an ordinary forward-rendered scene with one shadow map already sits. Treat that template as the upper end of what to show by default, and anything heavier as something to switch on only when there is a GPU. These are rules of thumb, from most to least costly on a CPU renderer:

1. **Full-screen passes.** Each post-processing pass (bloom, SSAO, depth of field, FXAA) shades half a million pixels again, and bloom is several passes. One cheap pass is usually survivable; a chain of them at default quality is the most common way to fail `renders`. Keep post-processing off on the lowest quality level.
2. **Shadow maps.** Each shadow-casting light draws the scene again. One directional light at 1024 or 2048 is fine. Point-light shadows draw it six times each.
3. **Per-pixel shading.** `MeshStandardMaterial` and `MeshPhysicalMaterial` cost several times what `MeshLambertMaterial` does, more with each light. Fragment shaders that loop (raymarching, many octaves of noise per pixel, parallax) can take seconds per frame.
4. **Pixel count.** Canvas pixels are what is shaded. A pixel ratio above 1 is wasted in this browser.
5. **Start-up.** Every distinct material compiles a shader, which is slow without a GPU, and generation work before the first frame counts against the 30 seconds. Share materials, and build the far parts of the world after `GCP.ready()`.

Triangle count and draw calls matter less here than they do on a phone: a few hundred thousand triangles in a handful of draw calls is not the problem, the pixels are.

The dependable way to pass is the same thing that makes the game run on a weak laptop: notice there is no GPU and start on the lowest quality.

```js
function softwareRenderer(renderer) {                       // true when WebGL runs on the CPU
  const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}
let quality = softwareRenderer(renderer) ? 'low' : pickQuality(store.get('quality'));
```

Together with the adaptive resolution above, this keeps a heavy game verifiable without making it look worse for anyone with a GPU. If `renders` still fails, the report's frame count and `GCP.stats` numbers show how far off it is; remove full-screen passes first.

## Draw less

- **Frustum culling** is automatic per object in Three.js, which is a reason to split a huge world into chunks instead of one mesh.
- **Distance.** Hide or simplify things beyond a view distance and cover the edge with fog of the sky colour. Swap far trees for flat cards or drop them.
- **Level of detail.** `THREE.LOD` or simply two instanced meshes, near and far, with instances assigned by distance every half second, not every frame.
- **Do not render what did not change.** A turn-based or puzzle game can skip `render()` while nothing moves (keep a light animation running so the game still counts as alive).

## Do not feed the garbage collector

```js
const v = new THREE.Vector3();                      // one scratch object, made once
function update() { v.copy(a).sub(b); /* not: const v = a.clone().sub(b) */ }
```

Avoid `new`, array literals, `map`/`filter` and string building inside per-frame, per-object loops. Pool bullets and particles. Keep hot data in typed arrays.

## Simulation cost

- Use a grid or spatial hash for neighbour queries; bucket by cell and check only nearby cells.
- Update far-away things less often (every fourth frame, staggered by index).
- Move heavy work that does not need the DOM (pathfinding, world generation, meshing) into a Web Worker and transfer typed arrays back.

## 2D canvas specifics

- Bake sprites and static backgrounds to offscreen canvases; `drawImage` is cheap, paths and gradients are not.
- Round positions to whole pixels to avoid blurry sub-pixel sampling.
- Batch by style: changing `fillStyle`, `font` or `shadowBlur` is slower than drawing. `shadowBlur` in particular is very expensive; bake it into the sprite.
- Draw only what is inside the camera bounds.

## Context loss

Mobile browsers take the GPU context away when memory is tight or the tab is in the background for a while.

```js
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); paused = true; showMessage('Paused'); });
canvas.addEventListener('webglcontextrestored', () => { paused = false; });   // Three.js re-uploads its resources itself
```

Without `preventDefault()` the context never comes back and the player is left with a frozen picture.

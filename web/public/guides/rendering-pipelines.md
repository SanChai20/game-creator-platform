# Choosing a rendering pipeline

There is no platform pipeline. Pick the one that fits the game you are making, and change your mind freely. The table is a starting point, and `recommend_pipeline` will reason about a specific idea for you.

| Pipeline | Good for | Cost |
| --- | --- | --- |
| 2D canvas | Top-down, platformers, puzzles, card and board games, pixel art, anything under a few thousand sprites | Lowest. Runs everywhere, verifies everywhere. |
| Three.js forward (WebGL2) | Most 3D games: exploration, racing, shooters, builders, stylised worlds | Low. The default choice for 3D. |
| Three.js forward + post | The same games when you want bloom, depth of field, outlines, colour grading | A second full-screen pass or more. Give players a way to turn it off. |
| Custom deferred / G-buffer | Many dynamic lights, screen-space effects, a very specific look | High. You own the shaders and every material. |
| Raw WebGL2 | Full control, tiny bundles, shader-driven games, voxel engines | You write everything, including matrices and state handling. |
| WebGPU (raw or `three/webgpu`) | Compute-heavy worlds, huge instance counts, modern techniques | Not available in every browser. Needs a fallback or the manual verification path. |
| DOM / SVG | Text games, card games, idle games, interfaces as gameplay | Fine. Still drive something from `requestAnimationFrame` so the game counts as alive. |

Two things hold for all of them: size the drawing surface from the element's CSS size times a capped device pixel ratio, and clamp the frame time so a background tab does not teleport the player.

## 2D canvas

```js
import { setupCanvas, bake, Camera2D, drawSorted } from '@gcp/canvas2d.js';
import { createLoop } from '@gcp/core.js';

const view = setupCanvas(document.querySelector('canvas'), { maxDpr: 2 });   // view.ctx, view.w, view.h in CSS px
const tree = bake(2, 3, (g) => {               // drawn once to an offscreen canvas, in world units (2 wide, 3 tall)
  g.fillStyle = '#5b3a1e'; g.fillRect(0.85, 1.8, 0.3, 1.2);
  g.fillStyle = '#3f8f3a'; g.beginPath(); g.arc(1, 1.2, 0.95, 0, 7); g.fill();
});
const cam = new Camera2D();
createLoop({
  update(dt) { cam.follow(player.x, player.y, dt); },
  render() {
    const g = view.ctx; g.fillStyle = '#20301c'; g.fillRect(0, 0, view.w, view.h);
    cam.begin(view); drawSorted(g, things); g.restore();       // things: [{ sprite: tree, x, y }]
  },
}).start();
```

The idea that matters is baking: draw each sprite once into an offscreen canvas, then `drawImage` it every frame. Paths, gradients and text drawn fresh each frame are what make 2D canvas slow. Without the kit, the same thing is `const off = new OffscreenCanvas(w, h)` and one `drawImage` per sprite.

## Three.js forward

```js
import * as THREE from 'three';
import { createRenderer, fitRenderer, makeSun } from '@gcp/three-kit.js';

const renderer = createRenderer(document.querySelector('canvas'), { quality: 'medium' });
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
fitRenderer(renderer, camera);
scene.add(new THREE.HemisphereLight(0xdfeeff, 0x5a5a3a, 1.4));
makeSun(scene);
renderer.setAnimationLoop(() => renderer.render(scene, camera));
```

Without the kit, the settings that matter are:

```js
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));       // never the raw ratio on phones
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;          // or NoToneMapping for flat, graphic looks
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
```

Material choice sets most of the frame cost. `MeshBasicMaterial` is unlit, `MeshLambertMaterial` is cheap diffuse and suits stylised games, `MeshStandardMaterial` is physically based and several times dearer per pixel. Mixing them is normal.

## Post-processing

```js
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.6, 0.4, 0.85));
composer.addPass(new OutputPass());                           // tone mapping and colour space go last
// on resize: composer.setSize(w, h);   each frame: composer.render();
```

When a composer is in use, tone mapping happens in `OutputPass`, not on the renderer. Forgetting `OutputPass` gives a dark, washed image.

## Custom deferred

Worth it when you need dozens of moving lights or effects that read depth and normals. The shape:

1. Render the scene into a `THREE.WebGLRenderTarget` with `count: 3` (albedo, normal, material) and a `DepthTexture`. Every material must be a `ShaderMaterial` with `glslVersion: THREE.GLSL3` writing `layout(location = n) out`.
2. One full-screen triangle pass computes lighting from those textures, rebuilding position from depth with the inverse projection matrix.
3. Transparent things are drawn afterwards, forward, sharing the depth buffer.
4. Further full-screen passes: ambient occlusion, fog, bloom, tone mapping.

Budget for it: half-resolution for the expensive passes, and a quality setting that drops them. If the look you want is reachable with forward rendering plus one post pass, that is the cheaper road.

## Raw WebGL2

```js
const gl = canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });
if (!gl) throw new Error('This game needs WebGL 2.');
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); paused = true; });
canvas.addEventListener('webglcontextrestored', () => { rebuildGpuResources(); paused = false; });
```

Check every shader compile and program link and put the log in the error you throw, so the verification report shows the real reason. Use vertex array objects, instanced draws (`drawArraysInstanced`) for anything repeated, and uniform buffers once you have more than a few programs.

## WebGPU

```js
if (!navigator.gpu) return startFallback();                  // WebGL2 or 2D version, or a clear message + GCP.fatal
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) return startFallback();
const device = await adapter.requestDevice();
device.lost.then((info) => { if (info.reason !== 'destroyed') location.reload(); });
const ctx = canvas.getContext('webgpu'), format = navigator.gpu.getPreferredCanvasFormat();
ctx.configure({ device, format, alphaMode: 'opaque' });
```

With Three.js, `import * as THREE from 'three/webgpu'` gives `WebGPURenderer`, which falls back to WebGL2 by itself when WebGPU is missing; call `await renderer.init()` before the first frame and write materials with node materials or TSL (`three/tsl`) instead of GLSL strings. That route keeps automatic verification working.

A game that is WebGPU only cannot be checked by the verification browser. It will ask its creator to play the preview once instead. Say so to the user when you choose this.

## Mixing

A canvas for the world plus ordinary HTML and CSS on top for menus, HUD and text is the most productive split in every pipeline: text is sharp, layout is free, and accessibility comes along. Put `pointer-events: none` on the overlay container and turn it back on for buttons.

# Materials and textures

## Paint textures on a canvas at boot

A 128 px canvas painted in a few lines replaces an image file: nothing to download, no licence to check, and the palette is a variable.

```js
import * as THREE from 'three';
import { paintTexture } from '@gcp/three-kit.js';

const bark = paintTexture('bark', (g, s, rand) => { // g: 2D context, s: size in pixels, rand: seeded PRNG. Cached by name.
  g.fillStyle = '#6b4a2b'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 90; i++) {
    g.fillStyle = rand() < 0.5 ? 'rgba(40,24,10,.35)' : 'rgba(150,110,70,.25)';
    g.fillRect(rand() * s, 0, 1 + rand() * 3, s);   // vertical streaks tile vertically for free
  }
}, { size: 128 });
const mat = new THREE.MeshLambertMaterial({ map: bark });
```

By hand:

```js
const cv = document.createElement('canvas'); cv.width = cv.height = 128;
draw(cv.getContext('2d'), 128);
const tex = new THREE.CanvasTexture(cv);
tex.colorSpace = THREE.SRGBColorSpace;              // colour maps only. Normal, roughness and data maps stay linear.
tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
tex.anisotropy = 4;
```

Notes that save time:

- **Tiling.** A texture tiles when whatever crosses an edge is also drawn on the opposite edge. Draw each speck a second time offset by the size, or keep features away from the borders.
- **Pixel art.** `tex.magFilter = THREE.NearestFilter; tex.generateMipmaps = false;` and keep the canvas small.
- **Normal maps from height.** Paint a greyscale height canvas, read it with `getImageData`, and write `(hL - hR, hU - hD, 1)` normalised into a second canvas. Leave that texture's colour space alone.
- **Atlases.** Paint many tiles into one canvas and offset UVs. One texture means one material means fewer draw calls.
- **Data textures.** `THREE.DataTexture` from a typed array is the way to send noise, heightmaps or lookup tables to a shader. Set `needsUpdate = true` after filling it.

## Vertex colours instead of textures

For stylised games, colour stored on vertices plus a single shared material covers a whole world with no textures at all. See the meshes guide. Vertex colours and a map multiply together, so a subtle greyscale detail texture over vertex colour gives variety for one extra sampler.

## Share materials

Every distinct material is a compiled shader program and a break in batching. Create each material once and reuse it:

```js
import { cachedMaterial } from '@gcp/three-kit.js';
const stone = cachedMaterial('stone', () => new THREE.MeshLambertMaterial({ color: 0x8d8a80 }));
```

Creating `new MeshStandardMaterial()` inside a loop that spawns objects is the most common cause of a first-frame stall and of stutter when new things appear.

## Change a built-in material a little

`onBeforeCompile` lets you keep lighting, fog and shadows from Three.js and add your own lines. This sways foliage in the wind:

```js
const uniforms = { uTime: { value: 0 } };
mat.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = uniforms.uTime;
  shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>
     float sway = sin(uTime * 1.6 + position.x * 0.5 + position.z * 0.4) * 0.08 * max(position.y, 0.0);
     transformed.x += sway; transformed.z += sway * 0.6;`
  );
};
mat.customProgramCacheKey = () => 'sway-v1';        // required, or another material may reuse the wrong program
// each frame: uniforms.uTime.value = time;
```

Shader chunk names change between Three.js releases. The platform pins the version you get from the import map ({{THREE}}), so this is stable here; if you bundle your own Three.js, test the patch against that exact version.

## Write a material from scratch

```js
const water = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uDeep: { value: new THREE.Color(0x0b4f7a) }, uShallow: { value: new THREE.Color(0x4fc3d9) } },
  vertexShader: `
    uniform float uTime; varying vec3 vWorld;
    void main() {
      vec3 p = position;
      p.y += sin(p.x * 0.4 + uTime) * 0.15 + cos(p.z * 0.3 + uTime * 1.3) * 0.12;
      vec4 w = modelMatrix * vec4(p, 1.0); vWorld = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  fragmentShader: `
    uniform vec3 uDeep, uShallow; uniform float uTime; varying vec3 vWorld;
    void main() {
      float k = 0.5 + 0.5 * sin(vWorld.x * 0.8 + vWorld.z * 0.6 + uTime * 0.7);
      gl_FragColor = vec4(mix(uDeep, uShallow, k), 0.9);
      #include <colorspace_fragment>
    }`,
  transparent: true,
});
```

Without `#include <colorspace_fragment>` (and `<tonemapping_fragment>` before it if you use tone mapping) a custom shader comes out darker and more saturated than the built-in materials beside it. Fog and shadows are not automatic in a `ShaderMaterial`; add the fog chunks and `fog: true` if you need them, or use `onBeforeCompile` on a built-in material instead.

## Transparency without surprises

- Leaves, fences, grass: `alphaTest: 0.5` and `transparent: false`. Depth works properly and there is no sorting.
- Glass, water, glows: `transparent: true, depthWrite: false`. Draw order is by object, so one large transparent mesh can sort wrongly against another; split it or set `renderOrder`.
- Glows and sparks: `blending: THREE.AdditiveBlending, depthWrite: false`. Order stops mattering.
- `side: THREE.DoubleSide` costs double. Use it for cloth, leaves and planes only.

## Lighting recipes

Bright stylised day: a `HemisphereLight` for sky and ground bounce plus one `DirectionalLight` with shadows. Night or interiors: low ambient and a few `PointLight`s with `decay: 2`, each without shadows. An environment map (`scene.environment`) is what makes `MeshStandardMaterial` look good; `RoomEnvironment` from `three/addons/environments/RoomEnvironment.js` run through `PMREMGenerator` makes one with no files.

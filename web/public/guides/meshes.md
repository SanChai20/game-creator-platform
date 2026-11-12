# Procedural meshes

Models built from code cost almost nothing to ship, never fail to load, and can be reshaped by changing a number. These are the techniques that hold up in real games. Use the ones that suit your look; a game with hand-made glTF models is just as welcome (`GLTFLoader` is in `three/addons/loaders/GLTFLoader.js`).

## Build a prop from parts, merge it into one mesh

A tree made of a cylinder and three spheres as four meshes is four draw calls. Merged into one geometry with per-vertex colour it is one, with one material shared by every prop in the game.

```js
import * as THREE from 'three';
import { mergeParts, M4, lumpy, cachedMaterial } from '@gcp/three-kit.js';

const tree = mergeParts([
  // [geometry, colour, transform]            M4(x, y, z, sx, sy, sz, rx, ry, rz)
  [new THREE.CylinderGeometry(0.2, 0.34, 3, 7), 0x6b4a2b, M4(0, 1.5, 0)],
  [lumpy(new THREE.IcosahedronGeometry(1.5, 1), 0.2, 1), 0x4f9a3a, M4(0, 3.8, 0)],
  [lumpy(new THREE.IcosahedronGeometry(1.1, 1), 0.2, 2), 0x5aa844, M4(0.9, 3.3, 0.3)],
]);
const mat = cachedMaterial('props', () => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
scene.add(new THREE.Mesh(tree, mat));
```

The same thing without the kit:

```js
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
function part(geo, hex, matrix) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();    // all parts must agree on indexed or not
  if (matrix) g.applyMatrix4(matrix);
  const c = new THREE.Color(hex), n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');                                   // every part needs the same attribute set
  return g;
}
const merged = mergeGeometries([part(a, 0x6b4a2b, m1), part(b, 0x4f9a3a, m2)]);
```

`mergeGeometries` returns `null` when the parts disagree on attributes or indexing. That is the usual reason a merged prop is invisible.

## Make primitives look organic

Push vertices along their normals with noise. Use the vertex position, not its index, as the noise input so that shared vertices stay welded and the surface has no cracks.

```js
import { Simplex } from '@gcp/core.js';
function displace(geo, amount, seed, freq = 1.7) {
  const n = new Simplex(seed), p = geo.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + n.n3(v.x * freq, v.y * freq, v.z * freq) * amount;
    p.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  geo.computeVertexNormals();
  return geo;
}
```

`lumpy(geometry, amount, seed)` in the kit does this. Low detail icosahedra with flat shading read as rocks and crystals; more detail with smooth shading reads as clouds, canopies and blobs.

Other cheap generators: `LatheGeometry` for anything turned (vases, towers, mushrooms), `ExtrudeGeometry` from a `Shape` for signs, gears and letters, `TubeGeometry` along a `CatmullRomCurve3` for vines, roads and tentacles.

## Terrain from one height function

Write `height(x, z)` once and use it for the mesh, for placing things, and for keeping the player on the ground. Three uses, one source, no physics engine needed.

```js
import { terrainGeometry } from '@gcp/three-kit.js';
import { Simplex, lerp, smoothstep } from '@gcp/core.js';

const noise = new Simplex(seed);
const height = (x, z) => noise.fbm2(x * 0.012, z * 0.012, 4) * 13;
const colour = (x, z, y, slope) => (y < 0.7 ? 0xe6d49a : slope > 0.22 ? 0x8d8a80 : 0x4f9a3a);
const { geometry } = terrainGeometry({ size: 240, segments: 128, height, colour });
// later, every frame:
player.y = height(player.x, player.z);
```

By hand it is a `PlaneGeometry(size, size, n, n)` rotated flat, with each vertex's y set from the function and a colour attribute filled the same way, followed by `computeVertexNormals()`.

## Many copies: InstancedMesh

Hundreds of trees should be one `InstancedMesh`, not hundreds of meshes.

```js
const mesh = new THREE.InstancedMesh(tree, mat, spots.length), m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
spots.forEach((s, i) => {
  m.compose(new THREE.Vector3(s.x, s.y, s.z), q.setFromAxisAngle(up, s.rot), new THREE.Vector3(s.scale, s.scale, s.scale));
  mesh.setMatrixAt(i, m);
  mesh.setColorAt(i, new THREE.Color().setHSL(0, 0, 0.85 + Math.random() * 0.15));   // tint multiplies vertex colour
});
mesh.instanceMatrix.needsUpdate = true;
mesh.computeBoundingSphere();       // otherwise culling uses the single-copy bounds and instances vanish at screen edges
```

Remove one instance by scaling its matrix to zero. Change `mesh.count` to draw only the first N.

## Big worlds: chunks

Split the world into square chunks. Build the chunks near the player, a few per frame at most, and dispose of the ones that fall behind. Make every chunk a deterministic function of the world seed and its coordinates, so a chunk that is rebuilt later comes back identical and nothing needs saving except what the player changed.

```js
const rand = mulberry32(strSeed(`${worldSeed}:${cx}:${cz}`));    // from @gcp/core.js
```

For voxel worlds, mesh only the faces between solid and empty cells, and merge runs of equal faces (greedy meshing) to keep vertex counts down.

## Housekeeping

- Call `geometry.dispose()` (and `material.dispose()`, `texture.dispose()`) when you remove things for good. Removing a mesh from the scene does not free GPU memory. The kit's `disposeTree(root)` walks a subtree.
- Low-poly counts are a style choice, not a requirement. Triangle count matters far less than draw calls and pixels shaded. See the performance guide.
- Set `castShadow` only on things whose shadows a player would miss.

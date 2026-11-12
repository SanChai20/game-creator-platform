// @gcp/three-kit.js — Three.js helpers distilled from shipped procedural games.
// Nothing here fixes a look: colours, shapes, lighting and camera are all yours.
// What it encodes is the plumbing that is easy to get subtly wrong:
//  - cap the pixel ratio, size from the element, handle context loss
//  - paint textures on a canvas instead of downloading images
//  - share materials, merge static parts into one draw call, instance repeated things
//  - fit one shadow map around the player instead of the whole world
import * as THREE from 'three';
import { mulberry32, strSeed, Simplex } from './core.js';

/** Renderer with sane defaults. quality: 'low' | 'medium' | 'high'. */
export function createRenderer(canvas, { quality = 'medium', shadows = true, antialias, alpha = false, onContextLost } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: antialias ?? quality !== 'low', alpha, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, quality === 'high' ? 2 : quality === 'medium' ? 1.5 : 1));
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); if (onContextLost) onContextLost(); else if (window.GCP) window.GCP.fatal('The graphics context was lost. Reload to continue.'); });
  return renderer;
}

/** Keeps renderer and camera matched to the canvas element's CSS size. Returns a function that stops watching. */
export function fitRenderer(renderer, camera, onResize) {
  const el = renderer.domElement;
  const apply = () => {
    const w = el.clientWidth || innerWidth, h = el.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    if (camera.isPerspectiveCamera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
    if (onResize) onResize(w, h);
  };
  apply();
  const ro = new ResizeObserver(apply); ro.observe(el);
  addEventListener('orientationchange', apply);
  return () => { ro.disconnect(); removeEventListener('orientationchange', apply); };
}

const TEX = new Map();
/**
 * A texture painted with the 2D canvas API, cached by name. draw(ctx, size, rand) gets a seeded PRNG so the
 * result is identical on every device. Repeats by default; set repeat [x, y] on the returned texture's clone to tile.
 */
export function paintTexture(name, draw, { size = 128, repeat = true, anisotropy = 4, pixelated = false } = {}) {
  if (TEX.has(name)) return TEX.get(name);
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size, mulberry32(strSeed(name)));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (pixelated) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; } else t.anisotropy = anisotropy;
  TEX.set(name, t);
  return t;
}

const MATS = new Map();
/** One material per key: cachedMaterial('bark', () => new THREE.MeshLambertMaterial({ color: 0x6b4a2b })). */
export function cachedMaterial(key, make) { let m = MATS.get(key); if (!m) { m = make(); MATS.set(key, m); } return m; }

/** Transform shorthand for mergeParts: position, scale, rotation (Euler radians). */
export const M4 = (x = 0, y = 0, z = 0, sx = 1, sy = sx, sz = sx, rx = 0, ry = 0, rz = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

/**
 * Merges [geometry, colour, matrix?] parts into ONE geometry with vertex colours: a whole tree, house or
 * creature becomes a single draw call under one `vertexColors: true` material. `jitter` adds slight per-vertex
 * shade variation so flat-shaded surfaces do not look like plastic.
 */
export function mergeParts(parts, { jitter = 0.06, flat = true } = {}) {
  const pos = [], nor = [], col = [], c = new THREE.Color();
  for (const [geo0, color, mtx] of parts) {
    const geo = geo0.index ? geo0.toNonIndexed() : geo0.clone();
    if (mtx) geo.applyMatrix4(mtx);
    if (flat || !geo.attributes.normal) geo.computeVertexNormals();
    const p = geo.attributes.position, n = geo.attributes.normal;
    c.set(color);
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i));
      const v = 1 - jitter + (((i / 3 | 0) * 7919) % 13) / 13 * jitter * 2;
      col.push(c.r * v, c.g * v, c.b * v);
    }
    geo.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

/** Pushes vertices in and out with noise so spheres become rocks, canopies, clouds. Shared vertices stay welded. */
export function lumpy(geo, amount = 0.18, seed = 1, frequency = 1.7) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone(), p = g.attributes.position, n = new Simplex(seed), seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = `${(x * 100) | 0},${(y * 100) | 0},${(z * 100) | 0}`;
    let f = seen.get(k); if (f === undefined) { f = 1 + n.n3(x * frequency, y * frequency, z * frequency) * amount; seen.set(k, f); }
    p.setXYZ(i, x * f, y * f, z * f);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * One InstancedMesh for many copies. items: [{ x, y, z, scale?, rotY?, color? }].
 * Hundreds of trees or rocks cost one draw call. Per-instance colour multiplies the material/vertex colour.
 */
export function instances(geometry, material, items, { castShadow = true, receiveShadow = true } = {}) {
  const mesh = new THREE.InstancedMesh(geometry, material, items.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
  items.forEach((it, i) => {
    q.setFromAxisAngle(up, it.rotY || 0); const k = it.scale ?? 1; s.set(k, k * (it.scaleY ?? 1), k); p.set(it.x, it.y || 0, it.z);
    mesh.setMatrixAt(i, m.compose(p, q, s));
    if (it.color !== undefined) mesh.setColorAt(i, c.set(it.color));
  });
  mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
  mesh.computeBoundingSphere();
  return mesh;
}

/** A gradient sky dome with a soft sun glow. Update sky.material.uniforms to change time of day. */
export function makeSky({ top = 0x3d7fd6, bottom = 0xcfe6ff, sunDir = new THREE.Vector3(0.4, 0.8, 0.3), glow = 0xfff0c8, radius = 600 } = {}) {
  const uniforms = { top: { value: new THREE.Color(top) }, bottom: { value: new THREE.Color(bottom) }, sunDir: { value: sunDir.clone().normalize() }, glow: { value: new THREE.Color(glow) } };
  const material = new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 glow; varying vec3 vDir;
      void main(){ vec3 d = normalize(vDir); float h = pow(clamp(d.y * 0.5 + 0.5, 0.0, 1.0), 0.8); vec3 c = mix(bottom, top, smoothstep(0.45, 1.0, h));
        float s = max(dot(d, sunDir), 0.0); c += glow * (pow(s, 64.0) * 0.6 + pow(s, 6.0) * 0.18); gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 12), material);
  sky.frustumCulled = false; sky.renderOrder = -1;
  return sky;
}

/**
 * A shadow-casting sun whose shadow box follows a point (usually the player), snapped to texels so shadows
 * do not shimmer. Call sun.follow(position) each frame.
 */
export function makeSun(scene, { color = 0xfff2dc, intensity = 2.4, direction = new THREE.Vector3(0.5, 1, 0.35), area = 45, mapSize = 2048, far = 220 } = {}) {
  const sun = new THREE.DirectionalLight(color, intensity), dir = direction.clone().normalize();
  sun.castShadow = true; sun.shadow.mapSize.set(mapSize, mapSize);
  const cam = sun.shadow.camera; cam.left = cam.bottom = -area; cam.right = cam.top = area; cam.near = 1; cam.far = far;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
  scene.add(sun); scene.add(sun.target);
  const texel = (area * 2) / mapSize;
  sun.follow = (p) => {
    const x = Math.round(p.x / texel) * texel, z = Math.round(p.z / texel) * texel;
    sun.target.position.set(x, p.y, z); sun.position.set(x + dir.x * far * 0.5, p.y + dir.y * far * 0.5, z + dir.z * far * 0.5);
  };
  sun.follow(new THREE.Vector3());
  return sun;
}

/**
 * A square of terrain as one mesh. height(x, z) -> y and colour(x, z, y, slope) -> hex are yours.
 * Flat-shaded with vertex colours; returns { geometry, heightAt } where heightAt samples the same function.
 */
export function terrainGeometry({ size = 200, segments = 100, height, colour, center = [0, 0] }) {
  const g = new THREE.PlaneGeometry(size, size, segments, segments); g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i) + center[0], z = p.getZ(i) + center[1]; p.setXYZ(i, x, height(x, z), z); }
  const flat = g.toNonIndexed(); g.dispose(); flat.computeVertexNormals();
  const fp = flat.attributes.position, fn = flat.attributes.normal, col = new Float32Array(fp.count * 3), c = new THREE.Color();
  for (let i = 0; i < fp.count; i += 3) { // one colour per triangle, taken at its centre
    const x = (fp.getX(i) + fp.getX(i + 1) + fp.getX(i + 2)) / 3, y = (fp.getY(i) + fp.getY(i + 1) + fp.getY(i + 2)) / 3, z = (fp.getZ(i) + fp.getZ(i + 1) + fp.getZ(i + 2)) / 3;
    c.set(colour ? colour(x, z, y, 1 - fn.getY(i)) : 0x63a043);
    for (let k = 0; k < 3; k++) { col[(i + k) * 3] = c.r; col[(i + k) * 3 + 1] = c.g; col[(i + k) * 3 + 2] = c.b; }
  }
  flat.setAttribute('color', new THREE.BufferAttribute(col, 3));
  flat.computeBoundingSphere();
  return { geometry: flat, heightAt: height };
}

/** Frees GPU memory for an object and everything under it. Skips materials and textures you mark userData.shared. */
export function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
      if (m.userData.shared || [...MATS.values()].includes(m)) continue;
      for (const k in m) { const v = m[k]; if (v && v.isTexture && ![...TEX.values()].includes(v)) v.dispose(); }
      m.dispose();
    }
  });
  if (root.parent) root.parent.remove(root);
}

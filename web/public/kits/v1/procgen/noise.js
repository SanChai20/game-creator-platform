// @gcp/procgen.js · noise — seeded randomness, integer hashes and noise. No dependencies: use it in 2D or 3D,
// in the page or in a Worker.
//
// THE DETERMINISM CONTRACT ("same seed, same world")
//  1. Hashes and random streams use 32-bit integer maths only (Math.imul, >>>). They give the same bits in every
//     browser, on every machine, and in the GLSL twin of this file (procgen/glsl.js).
//  2. vnoise*, gnoise* and the fractals built on them are computed in float32 steps (Math.fround) using only
//     + - * and floor, in a fixed order. No sin, cos or pow, which differ between engines. The CPU result is
//     therefore identical everywhere, and the GLSL twin runs the same steps on the same lattice values.
//  3. Every algorithm has a version in ALGO. A version never changes its output. An improvement gets a new
//     version, and recipes carry the version they were made with, so a world saved from a seed stays that world.
// Gameplay (collision, placement, loot) should read the CPU functions; shaders draw with the GLSL twin.

/** Version of each algorithm. Outputs for a given version are frozen. */
export const ALGO = Object.freeze({ mulberry32: 1, pcg: 1, hash: 1, strSeed: 1, simplex: 1, value: 1, gradient: 1, fractal: 1, worley: 1 });

const f = Math.fround, imul = Math.imul, floor = Math.floor;
const GOLD = 0x9e3779b9;

/** Deterministic PRNG stream. const rand = mulberry32(1234); rand() -> [0, 1) */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = imul(a ^ (a >>> 15), 1 | a); t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Hash any string to a 32-bit seed (FNV-1a). */
export function strSeed(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = imul(h, 16777619); } return h >>> 0; }
/** PCG hash: one 32-bit integer in, one well-mixed 32-bit integer out. The same function exists in GLSL. */
export function pcg(n) { const s = (imul(n, 747796405) + 2891336453) | 0, w = imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737); return ((w >>> 22) ^ w) >>> 0; }
/** Anything to a seed: integers pass through, other numbers and strings are hashed, nothing gives 1. */
export function toSeed(s) { return s == null ? 1 : typeof s === 'number' ? (Number.isInteger(s) ? s >>> 0 : strSeed(String(s))) : strSeed(String(s)); }
/** Combines seeds or labels into one seed: mixSeed(worldSeed, 'trees', 3). Order matters. */
export function mixSeed(...parts) { let h = 0x811c9dc5; for (const p of parts) h = pcg((h ^ toSeed(p)) + GOLD | 0); return h >>> 0; }

/** Integer lattice hashes -> uint32. x, y, z are integers (any sign). */
export const hash2i = (x, y, seed = 0) => pcg((x + pcg((y + pcg(seed)) | 0)) | 0);
export const hash3i = (x, y, z, seed = 0) => pcg((x + pcg((y + pcg((z + pcg(seed)) | 0)) | 0)) | 0);
/** Lattice hashes -> [0, 1) with 24 bits, so the value is exact in float32 on the CPU and the GPU. */
export const hash2 = (x, y, seed = 0) => (hash2i(x, y, seed) >>> 8) / 16777216;
export const hash3 = (x, y, z, seed = 0) => (hash3i(x, y, z, seed) >>> 8) / 16777216;

/**
 * A friendlier random stream. const r = rng('level-3'); r() -> [0,1); r.range(2, 5); r.int(1, 6); r.pick(list);
 * r.chance(0.3); r.sign(); r.gauss(); r.shuffle(list); r.fork('trees') gives an independent stream, so adding
 * a rock later does not move every tree.
 */
export function rng(seed = 1) {
  const s = toSeed(seed), next = mulberry32(s), r = () => next();
  r.seed = s;
  r.range = (a = 0, b = 1) => a + (b - a) * next();
  r.int = (a, b) => a + floor(next() * (b - a + 1));
  r.pick = (list) => list[floor(next() * list.length)];
  r.chance = (p = 0.5) => next() < p;
  r.sign = () => (next() < 0.5 ? -1 : 1);
  r.gauss = () => (next() + next() + next() + next() - 2) * 0.8660254; // about normal, sd 0.5, no trig
  r.shuffle = (list) => { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = floor(next() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
  r.fork = (label) => rng(mixSeed(s, label));
  return r;
}
/** Counter-based stream on pcg: value i is pcgRandom(seed).at(i), so it can be sampled in any order or on the GPU. */
export function pcgRandom(seed = 1) {
  const s = pcg(toSeed(seed)); let i = 0;
  const r = () => (pcg((s + i++) | 0) >>> 8) / 16777216;
  r.at = (k) => (pcg((s + k) | 0) >>> 8) / 16777216;
  return r;
}

const wrapI = (i, p) => (p > 0 ? i - p * floor(i / p) : i);
const quintic = (t) => f(f(f(t * t) * t) * f(f(t * f(f(t * 6) - 15)) + 10));
const mixf = (a, b, t) => f(a + f(t * f(b - a)));

/**
 * Value noise, 2D, [-1, 1]. px/py > 0 make it repeat every px/py units (tileable textures, wrapping worlds).
 * Version ALGO.value. GLSL twin: gcpVnoise2.
 */
export function vnoise2(x, y, seed = 0, px = 0, py = px) {
  x = f(x); y = f(y);
  const fx = floor(x), fy = floor(y), ix = fx | 0, iy = fy | 0, ux = quintic(f(x - fx)), uy = quintic(f(y - fy));
  const x0 = wrapI(ix, px), x1 = wrapI(ix + 1, px), y0 = wrapI(iy, py), y1 = wrapI(iy + 1, py);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed), c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return f(f(mixf(mixf(a, b, ux), mixf(c, d, ux), uy) * 2) - 1);
}
/** Value noise, 3D, [-1, 1]. GLSL twin: gcpVnoise3. */
export function vnoise3(x, y, z, seed = 0) {
  x = f(x); y = f(y); z = f(z);
  const fx = floor(x), fy = floor(y), fz = floor(z), ix = fx | 0, iy = fy | 0, iz = fz | 0, ux = quintic(f(x - fx)), uy = quintic(f(y - fy)), uz = quintic(f(z - fz));
  const h = (a, b, c) => hash3(ix + a, iy + b, iz + c, seed);
  const lo = mixf(mixf(h(0, 0, 0), h(1, 0, 0), ux), mixf(h(0, 1, 0), h(1, 1, 0), ux), uy), hi = mixf(mixf(h(0, 0, 1), h(1, 0, 1), ux), mixf(h(0, 1, 1), h(1, 1, 1), ux), uy);
  return f(f(mixf(lo, hi, uz) * 2) - 1);
}

const OUT = new Float32Array(3);
/**
 * Gradient noise, 2D, with analytic derivatives: returns [value, d/dx, d/dy] (the array is reused; copy it if you
 * keep it). The slope comes for free, which is what erosion-like terrain and normal maps need.
 * Version ALGO.gradient. GLSL twin: gcpGnoise2d.
 */
export function gnoise2d(x, y, seed = 0, px = 0, py = px, out = OUT) {
  x = f(x); y = f(y);
  const fx = floor(x), fy = floor(y), ix = fx | 0, iy = fy | 0, tx = f(x - fx), ty = f(y - fy), sx = f(tx - 1), sy = f(ty - 1);
  const x0 = wrapI(ix, px), x1 = wrapI(ix + 1, px), y0 = wrapI(iy, py), y1 = wrapI(iy + 1, py);
  const ha = hash2i(x0, y0, seed), hb = hash2i(x1, y0, seed), hc = hash2i(x0, y1, seed), hd = hash2i(x1, y1, seed);
  const gax = ((ha & 65535) - 32768) / 32768, gay = ((ha >>> 16) - 32768) / 32768, gbx = ((hb & 65535) - 32768) / 32768, gby = ((hb >>> 16) - 32768) / 32768;
  const gcx = ((hc & 65535) - 32768) / 32768, gcy = ((hc >>> 16) - 32768) / 32768, gdx = ((hd & 65535) - 32768) / 32768, gdy = ((hd >>> 16) - 32768) / 32768;
  const va = f(f(gax * tx) + f(gay * ty)), vb = f(f(gbx * sx) + f(gby * ty)), vc = f(f(gcx * tx) + f(gcy * sy)), vd = f(f(gdx * sx) + f(gdy * sy));
  const ux = quintic(tx), uy = quintic(ty), k = f(f(f(va - vb) - vc) + vd), uxy = f(ux * uy);
  out[0] = f(f(f(f(va + f(ux * f(vb - va))) + f(uy * f(vc - va))) + f(uxy * k)) * 1.25);
  const dux = 30 * tx * tx * (tx * (tx - 2) + 1), duy = 30 * ty * ty * (ty * (ty - 2) + 1);
  out[1] = 1.25 * (gax + ux * (gbx - gax) + uy * (gcx - gax) + uxy * (gax - gbx - gcx + gdx) + dux * (uy * k + (vb - va)));
  out[2] = 1.25 * (gay + ux * (gby - gay) + uy * (gcy - gay) + uxy * (gay - gby - gcy + gdy) + duy * (ux * k + (vc - va)));
  return out;
}
/** Gradient noise, 2D, value only, [-1, 1] in practice (sd about 0.22). GLSL twin: gcpGnoise2. */
export const gnoise2 = (x, y, seed = 0, px = 0, py = px) => gnoise2d(x, y, seed, px, py, OUT)[0];
/** Gradient noise, 3D, value only. GLSL twin: gcpGnoise3. */
export function gnoise3(x, y, z, seed = 0) {
  x = f(x); y = f(y); z = f(z);
  const fx = floor(x), fy = floor(y), fz = floor(z), ix = fx | 0, iy = fy | 0, iz = fz | 0, tx = f(x - fx), ty = f(y - fy), tz = f(z - fz);
  const v = (a, b, c) => { const h = hash3i(ix + a, iy + b, iz + c, seed); return f(f(f((((h & 1023) - 512) / 512) * f(tx - a)) + f(((((h >>> 10) & 1023) - 512) / 512) * f(ty - b))) + f(((((h >>> 20) & 1023) - 512) / 512) * f(tz - c))); };
  const ux = quintic(tx), uy = quintic(ty), uz = quintic(tz);
  const lo = mixf(mixf(v(0, 0, 0), v(1, 0, 0), ux), mixf(v(0, 1, 0), v(1, 1, 0), ux), uy), hi = mixf(mixf(v(0, 0, 1), v(1, 0, 1), ux), mixf(v(0, 1, 1), v(1, 1, 1), ux), uy);
  return f(mixf(lo, hi, uz) * 1.25);
}

const FK = f(1.6);
const BASIS = { value: vnoise2, gradient: gnoise2 };
/**
 * Fractal sum of octaves, about [-1, 1]. basis: 'gradient' (default) or 'value'. period > 0 tiles (use an integer
 * lacunarity with it). Version ALGO.fractal. GLSL twins: gcpFbm2 (gradient), gcpVfbm2 (value).
 */
export function fbm2(x, y, seed = 0, octaves = 5, lacunarity = 2, gain = 0.5, period = 0, basis = 'gradient') {
  const n = BASIS[basis] || gnoise2, k = n === gnoise2 ? FK : 1; let sum = 0, amp = 1, norm = 0, p = period; x = f(x); y = f(y); lacunarity = f(lacunarity); gain = f(gain);
  for (let o = 0; o < octaves; o++) { sum = f(sum + f(amp * n(x, y, (seed + imul(o, GOLD)) >>> 0, p, p))); norm = f(norm + amp); amp = f(amp * gain); x = f(x * lacunarity); y = f(y * lacunarity); p = (p * lacunarity) | 0; }
  return f(f(sum / norm) * k);
}
/** Ridged fractal: sharp crests (mountain ridges, veins, cracks), [-1, 1]. GLSL twin: gcpRidged2. */
export function ridged2(x, y, seed = 0, octaves = 5, lacunarity = 2, gain = 0.5, period = 0) {
  let sum = 0, amp = 1, norm = 0, p = period; x = f(x); y = f(y); lacunarity = f(lacunarity); gain = f(gain);
  for (let o = 0; o < octaves; o++) { const r = f(1 - Math.abs(gnoise2(x, y, (seed + imul(o, GOLD)) >>> 0, p, p))); sum = f(sum + f(amp * f(r * r))); norm = f(norm + amp); amp = f(amp * gain); x = f(x * lacunarity); y = f(y * lacunarity); p = (p * lacunarity) | 0; }
  return f(f(f(sum / norm) * 2) - 1);
}
/** Domain-warped fractal: the input is bent by two more fractals, giving flowing, organic shapes. GLSL twin: gcpWarp2. */
export function warp2(x, y, seed = 0, octaves = 4, amount = 1, lacunarity = 2, gain = 0.5) {
  amount = f(amount);
  const qx = fbm2(x, y, (seed ^ 0x68bc21eb) >>> 0, octaves, lacunarity, gain), qy = fbm2(x, y, (seed ^ 0x02e5be93) >>> 0, octaves, lacunarity, gain);
  return fbm2(f(f(x) + f(amount * qx)), f(f(y) + f(amount * qy)), seed, octaves, lacunarity, gain);
}

const WOUT = new Float32Array(5);
/**
 * Cellular (Worley) noise: scattered points, one per lattice cell. Returns [F1, F2, id, dx, dy]: distance to the
 * nearest point, to the second nearest, a random [0,1) id of the nearest cell, and the offset to its point.
 * F1 draws pebbles and spots, F2 - F1 draws cracks and mortar lines, id colours each cell. Version ALGO.worley.
 */
export function worley2(x, y, seed = 0, px = 0, py = px, jitter = 1, out = WOUT) {
  const ix = floor(x), iy = floor(y); let f1 = 9, f2 = 9, id = 0, ox = 0, oy = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = ix + i, cy = iy + j, h = hash2i(wrapI(cx, px), wrapI(cy, py), seed);
    const dx = cx + 0.5 + ((h & 65535) / 65536 - 0.5) * jitter - x, dy = cy + 0.5 + ((h >>> 16) / 65536 - 0.5) * jitter - y, d = dx * dx + dy * dy;
    if (d < f1) { f2 = f1; f1 = d; id = (pcg(h) >>> 8) / 16777216; ox = dx; oy = dy; } else if (d < f2) f2 = d;
  }
  out[0] = Math.sqrt(f1); out[1] = Math.sqrt(f2); out[2] = id; out[3] = ox; out[4] = oy; return out;
}

/** Seeded simplex noise (permutation table, float64). n2/n3 return [-1, 1]. CPU only. Version ALGO.simplex. */
export class Simplex {
  constructor(seed = 1) {
    const r = mulberry32(seed), p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; }
    this.perm = new Uint8Array(512); for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  n2(x, y) {
    const F = 0.3660254037844386, G = 0.21132486540518713, P = this.perm;
    const s = (x + y) * F, i = floor(x + s), j = floor(y + s), t = (i + j) * G;
    const x0 = x - (i - t), y0 = y - (j - t), i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G, y1 = y0 - j1 + G, x2 = x0 - 1 + 2 * G, y2 = y0 - 1 + 2 * G, ii = i & 255, jj = j & 255;
    const g = (h, a, b) => { const u = h & 7, k = u < 4 ? a : b, l = u < 4 ? b : a; return ((u & 1) ? -k : k) + ((u & 2) ? -2 * l : 2 * l); };
    let n = 0, a = 0.5 - x0 * x0 - y0 * y0;
    if (a > 0) { a *= a; n += a * a * g(P[ii + P[jj]], x0, y0); }
    a = 0.5 - x1 * x1 - y1 * y1; if (a > 0) { a *= a; n += a * a * g(P[ii + i1 + P[jj + j1]], x1, y1); }
    a = 0.5 - x2 * x2 - y2 * y2; if (a > 0) { a *= a; n += a * a * g(P[ii + 1 + P[jj + 1]], x2, y2); }
    const v = n * 38; return v < -1 ? -1 : v > 1 ? 1 : v;
  }
  n3(x, y, z) { // cheap 3D: blend three 2D slices (smooth, fine for displacing shapes)
    return (this.n2(x + z * 0.7, y - z * 0.4) + this.n2(y + 31.4, z + x * 0.6) + this.n2(z - 12.7, x + y * 0.5)) / 3;
  }
  fbm2(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) { sum += amp * this.n2(x * freq, y * freq); norm += amp; amp *= gain; freq *= lacunarity; }
    return sum / norm;
  }
}

const TYPES = ['fbm', 'ridged', 'warp', 'value', 'gradient', 'vfbm'];
/**
 * One noise field described by plain options, usable on the CPU and in a shader:
 *   const hills = noise({ seed: 'isle', type: 'fbm', scale: 60, octaves: 5 });
 *   hills(x, z)                      -> about [-1, 1]
 *   hills.fill(out, w, h, { x0, y0, step })   fills a Float32Array row by row (whole heightmaps, textures)
 *   hills.glsl('vWorld.xz')          -> a GLSL expression giving the same value (needs NOISE_GLSL in the shader)
 * type: fbm | ridged | warp | value | gradient | vfbm (fbm of value noise, cheapest). scale is the size of the
 * largest feature in your units. period (in multiples of scale) makes it tile.
 */
export function noise(opts = {}) {
  const { type = 'fbm', scale = 1, octaves = 5, lacunarity = 2, gain = 0.5, period = 0, amount = 1 } = opts, seed = toSeed(opts.seed ?? 1), k = f(1 / scale);
  if (!TYPES.includes(type)) throw new Error(`Unknown noise type "${type}". Use one of: ${TYPES.join(', ')}.`);
  const fn = type === 'fbm' ? (x, y) => fbm2(f(f(x) * k), f(f(y) * k), seed, octaves, lacunarity, gain, period)
    : type === 'vfbm' ? (x, y) => fbm2(f(f(x) * k), f(f(y) * k), seed, octaves, lacunarity, gain, period, 'value')
    : type === 'ridged' ? (x, y) => ridged2(f(f(x) * k), f(f(y) * k), seed, octaves, lacunarity, gain, period)
    : type === 'warp' ? (x, y) => warp2(f(f(x) * k), f(f(y) * k), seed, octaves, amount, lacunarity, gain)
    : type === 'value' ? (x, y) => vnoise2(f(f(x) * k), f(f(y) * k), seed, period) : (x, y) => gnoise2(f(f(x) * k), f(f(y) * k), seed, period);
  fn.options = { type, seed, scale, octaves, lacunarity, gain, period, amount, v: ALGO.fractal };
  fn.fill = (out, w, h, { x0 = 0, y0 = 0, step = 1 } = {}) => { for (let j = 0, n = 0; j < h; j++) for (let i = 0; i < w; i++) out[n++] = fn(x0 + i * step, y0 + j * step); return out; };
  const fl = (n) => (Number.isInteger(n) ? n + '.0' : String(n));
  fn.glsl = (p) => {
    const q = `((${p}) * ${fl(k)})`, s = `${seed}u`, tail = `${octaves}, ${fl(lacunarity)}, ${fl(gain)}`;
    return type === 'fbm' ? `gcpFbm2(${q}, ${s}, ${tail}, ${period})` : type === 'vfbm' ? `gcpVfbm2(${q}, ${s}, ${tail}, ${period})` : type === 'ridged' ? `gcpRidged2(${q}, ${s}, ${tail}, ${period})`
      : type === 'warp' ? `gcpWarp2(${q}, ${s}, ${octaves}, ${fl(amount)}, ${fl(lacunarity)}, ${fl(gain)})` : type === 'value' ? `gcpVnoise2(${q}, ${s}, ivec2(${period}))` : `gcpGnoise2(${q}, ${s}, ivec2(${period}))`;
  };
  return fn;
}

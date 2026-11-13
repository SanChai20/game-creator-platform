// @gcp/procgen.js · texture — a deterministic texture painter. Every pixel is computed with the seeded noise
// in procgen/noise.js (no canvas drawing, no sin/cos), so a texture is the same bytes on every device, tiles
// without seams, comes with a height channel (for a normal map) and can be made at any size.
//   const r = paint('brick', { seed: 3, color: 0x8a3b2a });   // a Raster
//   r.toCanvas()  r.toRGBA()  r.normalRGBA(2)  r.mips()
// Nothing here needs Three.js; craft/surfaces.js turns a Raster into a material.
import { hash2, vnoise2, fbm2, worley2, toSeed, mixSeed, ALGO } from './noise.js';

const floor = Math.floor, abs = Math.abs, min = Math.min, max = Math.max, sqrt = Math.sqrt;
const c01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = c01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const frac = (t) => t - floor(t);
const tri = (t) => { const q = frac(t), a = q < 0.5 ? q * 2 : 2 - q * 2; return a * a * (3 - 2 * a); };
const wrapd = (d) => { d = abs(d); return d > 0.5 ? 1 - d : d; }; // distance on a wrapping unit axis

/** Any colour (0xrrggbb, '#rgb', '#rrggbb', [r, g, b] in 0..1) -> [r, g, b] in 0..1. */
export function rgb(c) {
  if (Array.isArray(c) || ArrayBuffer.isView(c)) return [c[0], c[1], c[2]];
  if (c && typeof c === 'object' && 'r' in c) return [c.r, c.g, c.b];
  if (typeof c === 'string') { let s = c.replace('#', ''); if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]; c = parseInt(s, 16) || 0; }
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}

/**
 * A w x h picture with a height channel. Coordinates for the drawing calls are in tile units (0..1 across the
 * picture) and everything wraps around the edges, so whatever you draw still tiles.
 */
export class Raster {
  constructor(w = 128, h = w) { this.w = w; this.h = h; this.rgb = new Float32Array(w * h * 3); this.hgt = new Float32Array(w * h).fill(0.5); }
  /** Fills with one colour. */
  fill(color, height) { const [r, g, b] = rgb(color), d = this.rgb; for (let i = 0; i < d.length; i += 3) { d[i] = r; d[i + 1] = g; d[i + 2] = b; } if (height != null) this.hgt.fill(height); return this; }
  /** Runs fn(u, v, px) for every pixel; px = [r, g, b, height] to read and change. */
  each(fn) { const { w, h, rgb: d, hgt } = this, o = new Float32Array(4); for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) { o[0] = d[i * 3]; o[1] = d[i * 3 + 1]; o[2] = d[i * 3 + 2]; o[3] = hgt[i]; fn((x + 0.5) / w, (y + 0.5) / h, o); d[i * 3] = o[0]; d[i * 3 + 1] = o[1]; d[i * 3 + 2] = o[2]; hgt[i] = o[3]; } return this; }
  _blend(x, y, c, a, height) { const { w, h } = this, i = ((y % h + h) % h) * w + ((x % w + w) % w), d = this.rgb; d[i * 3] += (c[0] - d[i * 3]) * a; d[i * 3 + 1] += (c[1] - d[i * 3 + 1]) * a; d[i * 3 + 2] += (c[2] - d[i * 3 + 2]) * a; if (height != null) this.hgt[i] += (height - this.hgt[i]) * a; }
  /** A rectangle. x, y, w, h in tile units. */
  rect(x, y, w, h, color, { alpha = 1, height } = {}) { const c = rgb(color), x0 = Math.round(x * this.w), y0 = Math.round(y * this.h), x1 = Math.round((x + w) * this.w), y1 = Math.round((y + h) * this.h); for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) this._blend(i, j, c, alpha, height); return this; }
  /** A disc or ellipse with a soft edge. r (and ry) in tile units; soft is the share of the radius that fades out. */
  disc(cx, cy, r, color, { ry = r, soft = 0.15, alpha = 1, height } = {}) {
    const c = rgb(color), W = this.w, H = this.h, x0 = floor((cx - r) * W), x1 = Math.ceil((cx + r) * W), y0 = floor((cy - ry) * H), y1 = Math.ceil((cy + ry) * H);
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) { const dx = ((i + 0.5) / W - cx) / r, dy = ((j + 0.5) / H - cy) / ry, d = sqrt(dx * dx + dy * dy); if (d < 1) this._blend(i, j, c, alpha * (soft > 0 ? smooth(1, 1 - soft, d) : 1), height); }
    return this;
  }
  /** A straight line of the given width (tile units). */
  line(x0, y0, x1, y1, width, color, { alpha = 1, height } = {}) {
    const c = rgb(color), W = this.w, H = this.h, hw = width / 2, ax = min(x0, x1) - hw, bx = max(x0, x1) + hw, ay = min(y0, y1) - hw, by = max(y0, y1) + hw, vx = x1 - x0, vy = y1 - y0, L = vx * vx + vy * vy || 1e-9;
    for (let j = floor(ay * H); j <= Math.ceil(by * H); j++) for (let i = floor(ax * W); i <= Math.ceil(bx * W); i++) { const px = (i + 0.5) / W - x0, py = (j + 0.5) / H - y0, t = c01((px * vx + py * vy) / L), dx = px - vx * t, dy = py - vy * t, d = sqrt(dx * dx + dy * dy); if (d < hw) this._blend(i, j, c, alpha * smooth(hw, hw * 0.6, d), height); }
    return this;
  }
  /** Multiplies brightness by tiling noise: amount 0.2 = +-20%. freq is how many blobs fit across the tile. */
  noise(amount = 0.15, freq = 6, seed = 1, octaves = 3) { const s = toSeed(seed); return this.each((u, v, o) => { const k = 1 + amount * fbm2(u * freq, v * freq, s, octaves, 2, 0.5, freq, 'value'); o[0] *= k; o[1] *= k; o[2] *= k; }); }
  /** RGBA bytes (alpha 255), row by row from the top. */
  toRGBA() { const n = this.w * this.h, out = new Uint8ClampedArray(n * 4), d = this.rgb; for (let i = 0; i < n; i++) { out[i * 4] = d[i * 3] * 255; out[i * 4 + 1] = d[i * 3 + 1] * 255; out[i * 4 + 2] = d[i * 3 + 2] * 255; out[i * 4 + 3] = 255; } return out; }
  /** A normal map (RGBA bytes) from the height channel. strength 1..4 is typical. */
  normalRGBA(strength = 2) {
    const { w, h, hgt } = this, out = new Uint8ClampedArray(w * h * 4), at = (x, y) => hgt[((y + h) % h) * w + ((x + w) % w)];
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) { const nx = (at(x - 1, y) - at(x + 1, y)) * strength, ny = (at(x, y - 1) - at(x, y + 1)) * strength, l = 1 / sqrt(nx * nx + ny * ny + 1); out[i * 4] = (nx * l * 0.5 + 0.5) * 255; out[i * 4 + 1] = (-ny * l * 0.5 + 0.5) * 255; out[i * 4 + 2] = (l * 0.5 + 0.5) * 255; out[i * 4 + 3] = 255; }
    return out;
  }
  /** The mip chain as [{ w, h, data }] from full size down to 1x1 (box filter), for engines that want explicit mips. */
  mips() { let w = this.w, h = this.h, data = this.toRGBA(); const out = [{ w, h, data }]; while (w > 1 || h > 1) { const nw = max(1, w >> 1), nh = max(1, h >> 1), nd = new Uint8ClampedArray(nw * nh * 4); for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let k = 0; k < 4; k++) { const a = (min(h - 1, y * 2) * w + min(w - 1, x * 2)) * 4 + k, b = (min(h - 1, y * 2) * w + min(w - 1, x * 2 + 1)) * 4 + k, c = (min(h - 1, y * 2 + 1) * w + min(w - 1, x * 2)) * 4 + k, d = (min(h - 1, y * 2 + 1) * w + min(w - 1, x * 2 + 1)) * 4 + k; nd[(y * nw + x) * 4 + k] = (data[a] + data[b] + data[c] + data[d]) / 4; } w = nw; h = nh; data = nd; out.push({ w, h, data }); } return out; }
  /** A canvas holding the picture (browser only): for a 2D game's drawImage, a CSS background or a CanvasTexture. */
  toCanvas() { const c = document.createElement('canvas'); c.width = this.w; c.height = this.h; c.getContext('2d').putImageData(new ImageData(this.toRGBA(), this.w, this.h), 0, 0); return c; }
}

// ---- helpers the generators share (all tile seamlessly) ----
const N = (u, v, fq, seed, oct = 3) => fbm2(u * fq, v * fq, seed, oct, 2, 0.5, fq, 'value');
const A = (u, v, fu, fv, seed) => vnoise2(u * fu, v * fv, seed, fu, fv);
const A2 = (u, v, fu, fv, seed) => 0.65 * vnoise2(u * fu, v * fv, seed, fu, fv) + 0.35 * vnoise2(u * fu * 2, v * fv * 2, seed + 77, fu * 2, fv * 2);
const W = (u, v, fu, fv, seed, jit = 1) => worley2(u * fu, v * fv, seed, fu, fv, jit);
const Gr = (u, v, seed) => hash2(floor(u * 256), floor(v * 256), seed);
const mul = (o, k) => { o[0] *= k; o[1] *= k; o[2] *= k; };
const to = (o, c, t) => { o[0] += (c[0] - o[0]) * t; o[1] += (c[1] - o[1]) * t; o[2] += (c[2] - o[2]) * t; };
const warm = (o, t) => { o[0] *= 1 + t; o[2] *= 1 - t; };
const B = { x: 0, y: 0, id: 0, row: 0, col: 0 };
/** Staggered courses (bricks, shingles, pavers). rows should be even so the stagger tiles. */
function courses(u, v, rows, cols, seed, stagger = 0.5) { const r = floor(v * rows), xx = u * cols + (r % 2) * stagger, c = floor(xx); B.row = r; B.col = ((c % cols) + cols) % cols; B.x = xx - c; B.y = v * rows - r; B.id = hash2(B.col, r, seed); return B; }

const T = {};
const def = (name, color, fn, more = {}) => { T[name] = { color, fn, ...more }; };

def('grass', 0x5c9a3c, (u, v, P, o) => { const k = P.k, blot = N(u, v, 4 * k, P.seed), blade = A2(u, v, 40 * k, 5 * k, P.seed + 1), fine = A(u, v, 96 * k, 12 * k, P.seed + 2); mul(o, 1 + blot * 0.13 + blade * 0.2 + fine * 0.1); warm(o, blade * 0.06); o[3] = 0.5 + blade * 0.3 + fine * 0.15; });
const FLOWERS = [[1, 0.96, 0.85], [1, 0.85, 0.29], [0.97, 0.66, 0.82], [0.79, 0.72, 1]];
def('meadow', 0x64a044, (u, v, P, o) => { T.grass.fn(u, v, P, o); const w = W(u, v, 9 * P.k, 9 * P.k, P.seed + 5, 0.9); if (w[2] < 0.5 && w[0] < 0.13) { to(o, P.c2 || FLOWERS[floor(w[2] * 8) % 4], smooth(0.13, 0.07, w[0])); if (w[0] < 0.035) to(o, [0.95, 0.7, 0.1], 0.8); o[3] = 0.8; } });
def('moss', 0x4c7a34, (u, v, P, o) => { const k = P.k, w = W(u, v, 14 * k, 14 * k, P.seed, 1), n = N(u, v, 5 * k, P.seed + 1, 4); mul(o, (1 + n * 0.25 + N(u, v, 30 * k, P.seed + 2, 2) * 0.12) * (1.1 - w[0] * 0.45)); warm(o, (w[2] - 0.5) * 0.12); o[3] = 1 - w[0]; });
def('dirt', 0x7a5a3a, (u, v, P, o) => { const k = P.k; mul(o, 1 + N(u, v, 4 * k, P.seed) * 0.16 + N(u, v, 24 * k, P.seed + 1, 2) * 0.1 + (Gr(u, v, P.seed) - 0.5) * 0.12); o[3] = 0.5 + N(u, v, 24 * k, P.seed + 1, 2) * 0.3; const w = W(u, v, 9 * k, 9 * k, P.seed + 3, 1), rad = 0.07 + w[2] * 0.1; if (w[2] < 0.45 && w[0] < rad) { const l = (o[0] + o[1] + o[2]) / 3; to(o, [l * 1.5, l * 1.42, l * 1.3], 0.85); mul(o, 1 + (w[3] + w[4]) * 1.6); o[3] = 0.9; } });
def('mud', 0x4a3626, (u, v, P, o) => { T.dirt.fn(u, v, P, o); const p = N(u, v, 3 * P.k, P.seed + 7); if (p > 0.1) { const t = smooth(0.1, 0.25, p); mul(o, 1 - 0.3 * t); o[3] += (0.3 - o[3]) * t; if (Gr(u, v, P.seed + 8) > 0.975) mul(o, 1.7); } });
def('sand', 0xdcc48c, (u, v, P, o) => { const k = P.k, rp = tri(v * 10 * k + N(u, v, 2 * k, P.seed + 1) * 0.9); mul(o, 1 + N(u, v, 3 * k, P.seed) * 0.05 + (rp - 0.5) * 0.12 + (Gr(u, v, P.seed) - 0.5) * 0.1); o[3] = rp; });
def('snow', 0xf1f6fb, (u, v, P, o) => { const n = N(u, v, 3 * P.k, P.seed, 4); mul(o, 1 + n * 0.035); if (n < 0) to(o, [0.8, 0.87, 0.97], -n * 0.5); if (Gr(u, v, P.seed) > 0.985) to(o, [1, 1, 1], 0.9); o[3] = 0.5 + n * 0.5; });
def('rock', 0x8b8780, (u, v, P, o) => { const k = P.k, n = N(u, v, 3 * k, P.seed, 4), w = W(u, v, 3 * k, 3 * k, P.seed + 2, 1), e = w[1] - w[0]; mul(o, 1 + n * 0.17 + N(u, v, 14 * k, P.seed + 1, 2) * 0.08 + (Gr(u, v, P.seed) - 0.5) * 0.1); warm(o, (w[2] - 0.5) * 0.05); o[3] = 0.6 + n * 0.3; if (e < 0.05) { mul(o, 0.55 + e * 9); o[3] = e * 8; } });
def('cliff', 0x8a7f70, (u, v, P, o) => { const k = P.k, n = 10 * k, t = v * n + N(u, v, 2 * k, P.seed + 1) * 1.2, band = floor(t), q = t - band, bs = hash2(((band % n) + n) % n, 0, P.seed); mul(o, 1 + (bs - 0.5) * 0.24 + (Gr(u, v, P.seed) - 0.5) * 0.1 + A(u, v, 3 * k, 40 * k, P.seed + 3) * 0.06); warm(o, (bs - 0.5) * 0.06); o[3] = 0.4 + bs * 0.4; if (q < 0.14) { mul(o, 0.72 + q * 2); o[3] = q * 3; } const w = W(u, v, 5 * k, 2 * k, P.seed + 2, 1); if (w[1] - w[0] < 0.035) mul(o, 0.68); });
def('gravel', 0x8f8a82, (u, v, P, o) => { const w = W(u, v, 12 * P.k, 12 * P.k, P.seed, 1), e = smooth(0, 0.2, w[1] - w[0]); mul(o, (0.72 + w[2] * 0.55) * (0.4 + 0.6 * e) * (1 + (w[3] + w[4]) * 0.5)); warm(o, (w[2] - 0.5) * 0.1); o[3] = e; });
def('bark', 0x6b4a2b, (u, v, P, o) => { const k = P.k, r = A2(u, v, 22 * k, 3 * k, P.seed); mul(o, 1 + r * 0.26 + A(u, v, 60 * k, 8 * k, P.seed + 1) * 0.09); if (r < -0.15) mul(o, 0.62 + (r + 0.15) * -0.2); warm(o, r * 0.04); o[3] = 0.5 + r * 0.5; });
def('birch', 0xe9e5db, (u, v, P, o) => { const k = P.k; mul(o, 1 + A(u, v, 5 * k, 36 * k, P.seed) * 0.05 + (Gr(u, v, P.seed) - 0.5) * 0.04); const w = W(u, v, 5 * k, 14 * k, P.seed + 1, 1); if (w[2] < 0.55 && abs(w[4]) < 0.13 && abs(w[3]) < 0.16 + w[2] * 0.5) { to(o, [0.15, 0.13, 0.12], 0.88); o[3] = 0.2; } });
def('leaves', 0x4f9a3a, (u, v, P, o) => { const w = W(u, v, 9 * P.k, 9 * P.k, P.seed, 1), e = w[1] - w[0], a = w[2] * 2 - 1, b = frac(w[2] * 17.31) * 2 - 1, l = 1 / sqrt(a * a + b * b + 1e-6), rib = abs(w[3] * b * l - w[4] * a * l); mul(o, (0.74 + w[2] * 0.5) * (0.5 + 0.5 * smooth(0, 0.16, e)) * (1 + (w[3] * a + w[4] * b) * l * 0.5)); if (rib < 0.03) mul(o, 0.8); warm(o, (frac(w[2] * 7.7) - 0.5) * 0.14); o[3] = smooth(0, 0.2, e); });
def('wood', 0x9a6a3c, (u, v, P, o) => { const n = 4 * P.k, b = floor(u * n), bu = u * n - b, bs = hash2(b, 0, P.seed); mul(o, 0.93 + bs * 0.14 + A2(u, v, 48 * P.k, 3 * P.k, P.seed + b * 13) * 0.11); warm(o, (bs - 0.5) * 0.05); o[3] = 0.6; if (bu < 0.03 || bu > 0.97) { mul(o, 0.5); o[3] = 0.1; } const dx = (bu - 0.5) / n; for (const ny of [0.1, 0.9]) { const dy = v - ny, d = sqrt(dx * dx + dy * dy); if (d < 0.014) { mul(o, 0.42 + (dx + dy) * -18); o[3] = 0.8; } } });
def('planks', 0x8f6238, (u, v, P, o) => { const n = 6 * P.k, p = floor(v * n), pv = v * n - p, ps = hash2(p, 1, P.seed); mul(o, 0.9 + ps * 0.2 + A2(u, v, 3 * P.k, 64 * P.k, P.seed + p * 13) * 0.12); warm(o, (ps - 0.5) * 0.06); o[3] = 0.6; if (pv < 0.05 || pv > 0.95 || wrapd(u - hash2(p, 2, P.seed)) < 0.006) { mul(o, 0.48); o[3] = 0.1; } });
def('logs', 0x8a5a2e, (u, v, P, o) => { const n = 4 * P.k, l = floor(v * n), lv = v * n - l, prof = sqrt(max(0, 1 - (2 * lv - 1) * (2 * lv - 1))); mul(o, (0.5 + 0.58 * prof) * (1 + A2(u, v, 4 * P.k, 44 * P.k, P.seed + l * 7) * 0.14)); o[3] = prof; });
def('thatch', 0xb8954c, (u, v, P, o) => { const k = P.k, f1 = A(u, v, 70 * k, 6 * k, P.seed), f2 = A(u, v, 34 * k, 3 * k, P.seed + 1), q = frac(v * 5 * k); mul(o, (1 + f1 * 0.2 + f2 * 0.14) * (0.86 + q * 0.2)); warm(o, f1 * 0.04); o[3] = 0.3 + q * 0.5 + f1 * 0.2; if (q > 0.88) { mul(o, 0.55 + (1 - q) * 3); o[3] = 0.1; } });
def('shingle', 0x6a4a34, (u, v, P, o) => { const b = courses(u, v, 6 * P.k, 8 * P.k, P.seed); mul(o, (0.82 + b.id * 0.36) * (1 + A(u, v, 60 * P.k, 4 * P.k, P.seed + 1) * 0.08) * (0.9 + b.y * 0.16)); warm(o, (b.id - 0.5) * 0.06); o[3] = 0.4 + b.y * 0.5; if (b.y < 0.16) { mul(o, 0.55 + b.y * 2); o[3] = 0.2; } if (b.x < 0.05) { mul(o, 0.6); o[3] = 0.2; } });
def('rooftile', 0xa8482c, (u, v, P, o) => { const b = courses(u, v, 6 * P.k, 6 * P.k, P.seed), dx = (b.x - 0.5) * 2, d = dx * dx + b.y * b.y; if (d < 1) { mul(o, (0.84 + b.id * 0.28) * (0.8 + b.y * 0.3) * (1 - abs(dx) * 0.25)); warm(o, (b.id - 0.5) * 0.08); o[3] = 0.5 + b.y * 0.4 - abs(dx) * 0.2; if (d > 0.86) mul(o, 1.1); } else { mul(o, 0.45); o[3] = 0.1; } });
def('brick', 0xa5522e, (u, v, P, o) => { const b = courses(u, v, 8 * P.k, 4 * P.k, P.seed), mx = 0.035, my = 0.07; if (b.x < mx || b.x > 1 - mx || b.y < my || b.y > 1 - my) { to(o, P.c2 || [0.8, 0.77, 0.69], 1); mul(o, 0.92 + Gr(u, v, P.seed) * 0.12); o[3] = 0.25; } else { mul(o, (0.84 + b.id * 0.3) * (1 + N(u, v, 24 * P.k, P.seed + 1, 2) * 0.08) * (b.y > 0.82 ? 0.86 : b.y < 0.16 ? 1.08 : 1)); warm(o, (frac(b.id * 9.3) - 0.5) * 0.12); o[3] = 0.75; } });
def('stonewall', 0x8f8a80, (u, v, P, o) => { const k = P.k, w = W(u, v, 4 * k, 6 * k, P.seed, 0.85), e = w[1] - w[0]; if (e < 0.07) { if (P.c2) to(o, P.c2, 1); else mul(o, 0.5); mul(o, 0.9 + Gr(u, v, P.seed) * 0.2); o[3] = 0.15; } else { mul(o, (0.78 + w[2] * 0.42) * (0.82 + min(e, 0.3) * 0.8) * (1 + N(u, v, 16 * k, P.seed + 1, 2) * 0.09)); warm(o, (frac(w[2] * 5.1) - 0.5) * 0.08); o[3] = 0.5 + min(e, 0.3); } });
def('cobble', 0x8a8478, (u, v, P, o) => { const w = W(u, v, 7 * P.k, 7 * P.k, P.seed, 0.7); if (w[0] < 0.42) { mul(o, (0.8 + w[2] * 0.34) * (1.08 - w[0] * w[0] * 1.6) * (1 + (w[3] + w[4]) * 0.38)); warm(o, (frac(w[2] * 3.3) - 0.5) * 0.08); o[3] = 1 - w[0] * w[0] * 3; } else { mul(o, 0.42 + Gr(u, v, P.seed) * 0.12); o[3] = 0.1; } });
def('pavers', 0xa09a8e, (u, v, P, o) => { const b = courses(u, v, 4 * P.k, 4 * P.k, P.seed), g = 0.04; if (b.x < g || b.x > 1 - g || b.y < g || b.y > 1 - g) { mul(o, 0.5); o[3] = 0.2; } else { mul(o, (0.86 + b.id * 0.26) * (1 + N(u, v, 20 * P.k, P.seed + 1, 2) * 0.08 + (Gr(u, v, P.seed) - 0.5) * 0.08)); o[3] = 0.7; } });
def('plaster', 0xe9dfca, (u, v, P, o) => { const k = P.k; mul(o, 1 + N(u, v, 3 * k, P.seed) * 0.05 + N(u, v, 40 * k, P.seed + 1, 1) * 0.03 + (Gr(u, v, P.seed) - 0.5) * 0.05); o[3] = 0.5 + N(u, v, 40 * k, P.seed + 1, 1) * 0.3; const w = W(u, v, 2 * k, 2 * k, P.seed + 2, 1); if (w[1] - w[0] < 0.012 && N(u, v, 2 * k, P.seed + 9) > 0.1) { mul(o, 0.7); o[3] = 0.1; } });
def('concrete', 0x9a9a96, (u, v, P, o) => { const k = P.k; mul(o, 1 + N(u, v, 3 * k, P.seed) * 0.08 + (Gr(u, v, P.seed) - 0.5) * 0.14 + N(u, v, 48 * k, P.seed + 1, 1) * 0.05); const st = A(u, v, 24 * k, 1, P.seed + 4); if (st > 0.45) mul(o, 1 - (st - 0.45) * 0.55 * (1 - frac(v * k))); if (frac(u * k) < 0.012 || frac(v * k) < 0.012) { mul(o, 0.68); o[3] = 0.1; } });
def('asphalt', 0x3a3b3e, (u, v, P, o) => { const k = P.k, g = Gr(u, v, P.seed); mul(o, 1 + (g - 0.4) * 0.4 + N(u, v, 40 * k, P.seed + 1, 1) * 0.12 + N(u, v, 3 * k, P.seed) * 0.1); if (Gr(u, v, P.seed + 3) > 0.965) mul(o, 1.7); o[3] = g; const w = W(u, v, 2 * k, 2 * k, P.seed + 2, 1); if (w[1] - w[0] < 0.01) { mul(o, 0.45); o[3] = 0; } });
def('metal', 0x8e969e, (u, v, P, o) => { const k = P.k, pu = frac(u * k), pv = frac(v * k), e = min(pu, 1 - pu, pv, 1 - pv); mul(o, 1 + A(u, v, 2 * k, 90 * k, P.seed) * 0.07 + N(u, v, 2 * k, P.seed + 1) * 0.05); o[3] = 0.6; if (e < 0.012) { mul(o, 0.55); o[3] = 0.1; } else if (e < 0.026) mul(o, 1.14); for (const rx of [0.07, 0.5, 0.93]) for (const ry of [0.07, 0.93]) { const dx = pu - rx, dy = pv - ry, d = sqrt(dx * dx + dy * dy); if (d < 0.022) { mul(o, 0.8 - (dx + dy) * 14); o[3] = 0.95; } } });
def('corrugated', 0x3f6d8f, (u, v, P, o) => { const k = P.k, rib = tri(u * 10 * k), rn = N(u, v, 5 * k, P.seed + 3); mul(o, 0.7 + 0.42 * rib); if (rn > 0.25) to(o, [0.5 * (0.7 + 0.4 * rib), 0.26 * (0.7 + 0.4 * rib), 0.11], smooth(0.25, 0.55, rn) * 0.85); const st = A(u, v, 30 * k, 1, P.seed + 5); if (st > 0.5) mul(o, 1 - (st - 0.5) * 0.6 * (1 - v)); o[3] = rib; });
def('rust', 0x8a4a22, (u, v, P, o) => { const k = P.k, n1 = N(u, v, 4 * k, P.seed, 4), n2 = N(u, v, 13 * k, P.seed + 1, 2), m = N(u, v, 5 * k, P.seed + 2); mul(o, 1 + n1 * 0.28 + n2 * 0.14 + (Gr(u, v, P.seed) - 0.5) * 0.12); warm(o, n1 * 0.12); o[3] = 0.5 + n2 * 0.4; if (m > 0.3) { to(o, [0.3, 0.33, 0.37], smooth(0.3, 0.5, m) * 0.85); o[3] = 0.7; } });
def('tiles', 0xd8d2c4, (u, v, P, o) => { const n = 4 * P.k, tx = floor(u * n), ty = floor(v * n), x = u * n - tx, y = v * n - ty, g = 0.035; if (x < g || x > 1 - g || y < g || y > 1 - g) { to(o, P.c2 || [0.42, 0.4, 0.38], 1); o[3] = 0.2; } else { mul(o, ((tx + ty) % 2 ? 0.9 : 1.02) + (hash2(tx, ty, P.seed) - 0.5) * 0.06 + N(u, v, 12 * P.k, P.seed + 1, 2) * 0.03); if (x < g * 2 || y < g * 2) mul(o, 1.07); o[3] = 0.7; } });
def('checker', 0x2c2c34, (u, v, P, o) => { const n = 4 * P.k, tx = floor(u * n), ty = floor(v * n); if ((tx + ty) % 2) to(o, P.c2 || [0.9, 0.89, 0.85], 1); mul(o, 1 + N(u, v, 16 * P.k, P.seed, 2) * 0.05); });
def('marble', 0xe8e4de, (u, v, P, o) => { const k = P.k, wu = u + 0.09 * N(u, v, 2 * k, P.seed + 2), wv = v + 0.09 * N(u, v, 2 * k, P.seed + 3), a = abs(N(wu, wv, 3 * k, P.seed, 4)), b = abs(N(wu, wv, 7 * k, P.seed + 5, 3)); mul(o, 1 + N(u, v, 2 * k, P.seed + 1) * 0.05); to(o, P.c2 || [0.36, 0.37, 0.42], (1 - smooth(0, 0.1, a)) * 0.7 + (1 - smooth(0, 0.06, b)) * 0.3); });
def('fabric', 0xb8443a, (u, v, P, o) => { const k = P.k, n = 64 * k, wx = floor(u * n), wy = floor(v * n), over = (wx + wy) % 2, t = over ? frac(u * n) : frac(v * n); mul(o, (over ? 1.05 : 0.9) * (0.88 + 0.24 * (1 - abs(t - 0.5) * 2)) * (1 + N(u, v, 6 * k, P.seed) * 0.05)); const su = frac(u * 4 * k), sv = frac(v * 4 * k), l = (o[0] + o[1] + o[2]) / 3; if ((su > 0.2 && su < 0.3) || (sv > 0.2 && sv < 0.3)) to(o, P.c2 || [l * 1.5 + 0.1, l * 1.45 + 0.1, l * 1.3 + 0.1], 0.5); o[3] = over ? 0.7 : 0.4; });
def('stripes', 0x2f5fa8, (u, v, P, o) => { const n = 4 * P.k; if (floor(u * n * 2) % 2) to(o, P.c2 || [0.93, 0.91, 0.86], 1); mul(o, 1 + A(u, v, 80 * P.k, 80 * P.k, P.seed) * 0.05 + N(u, v, 5 * P.k, P.seed + 1) * 0.04); });
def('ice', 0xbfe6f5, (u, v, P, o) => { const k = P.k, d = N(u, v, 2 * k, P.seed + 3); mul(o, 1 + N(u, v, 3 * k, P.seed) * 0.06); if (d < -0.15) to(o, [0.42, 0.68, 0.85], smooth(-0.15, -0.5, d) * 0.45); const w = W(u, v, 3 * k, 3 * k, P.seed + 1, 1), e = w[1] - w[0]; if (e < 0.025) { to(o, [1, 1, 1], 0.85 * (1 - e / 0.025)); o[3] = 0.2; } if (Gr(u, v, P.seed) > 0.93) mul(o, 1.05); });
def('lava', 0x2a1410, (u, v, P, o) => { const k = P.k, w = W(u, v, 4 * k, 4 * k, P.seed, 1), e = w[1] - w[0] + N(u, v, 7 * k, P.seed + 1) * 0.05; if (e > 0.14) { mul(o, (0.8 + w[2] * 0.6 + N(u, v, 20 * k, P.seed + 2, 2) * 0.2) * (0.7 + min(1, (e - 0.14) * 4) * 0.5)); o[3] = 0.85; } else { const t = max(0, e) / 0.14; to(o, t < 0.55 ? [1, 0.9 - t * 0.8, 0.4 - t * 0.55] : [1 - (t - 0.55) * 1.1, 0.46 - (t - 0.55) * 0.8, 0.08], 1); o[3] = 0.15; } }, { glow: 0xff5a1a });
def('water', 0x2f7fa8, (u, v, P, o) => { const k = P.k, a = W(u, v, 5 * k, 5 * k, P.seed, 1), ea = a[1] - a[0], b = W(u + 0.03 * N(u, v, 3 * k, P.seed + 2), v, 8 * k, 8 * k, P.seed + 1, 1), eb = b[1] - b[0]; mul(o, 1 + N(u, v, 3 * k, P.seed) * 0.1); to(o, [0.85, 0.97, 1], (1 - smooth(0, 0.1, ea)) * 0.3 + (1 - smooth(0, 0.07, eb)) * 0.16); o[3] = 0.5 + N(u, v, 6 * k, P.seed + 4) * 0.4; });
def('crystal', 0x7a5cff, (u, v, P, o) => { const w = W(u, v, 5 * P.k, 5 * P.k, P.seed, 1), e = w[1] - w[0]; mul(o, (0.6 + w[2] * 0.8) * (1 + (w[3] - w[4]) * 0.7)); if (e < 0.03) to(o, [1, 1, 1], 0.6 * (1 - e / 0.03)); o[3] = 0.4 + w[2] * 0.5; }, { glow: 0x3a2aa0 });
def('scifi', 0x4a5262, (u, v, P, o) => { const n = 4 * P.k, tx = floor(u * n), ty = floor(v * n), x = u * n - tx, y = v * n - ty, id = hash2(tx, ty, P.seed), e = min(x, 1 - x, y, 1 - y); mul(o, 0.82 + floor(id * 4) * 0.09 + A(u, v, 2 * P.k, 80 * P.k, P.seed + 1) * 0.04); o[3] = 0.6; if (e < 0.03) { mul(o, 0.45); o[3] = 0.1; } else if (e < 0.06) mul(o, 1.15); else if (id < 0.2 && y > 0.4 && y < 0.6 && x > 0.2 && x < 0.8) { to(o, P.c2 || [0.3, 0.95, 1], 1); o[3] = 0.9; } else if (id > 0.8 && x > 0.15 && x < 0.85 && y > 0.15 && y < 0.85 && frac(y * 7) < 0.45) { mul(o, 0.5); o[3] = 0.2; } }, { glow2: true });

/** Every texture kind paint() knows. */
export const TEXTURES = Object.keys(T);
/** Default base colour of a kind (0xrrggbb). */
export const textureColor = (kind) => (T[kind] ? T[kind].color : 0x888888);
/** Emissive colour a kind suggests (lava, crystal), or null. */
export const textureGlow = (kind) => (T[kind] && T[kind].glow) || null;

/**
 * Registers your own generator: fn(u, v, P, px) is called for every pixel with u, v in 0..1, P = { seed, k (the
 * integer scale), c (base colour), c2, params } and px = [r, g, b, height] preset to the base colour. Use only
 * the procgen noise functions inside and the texture stays deterministic and tiling.
 */
export function defineTexture(name, color, fn, more = {}) { def(name, color, fn, more); if (!TEXTURES.includes(name)) TEXTURES.push(name); }

const CACHE = new Map();
/**
 * Paints a texture and returns a Raster (cached). kind: one of TEXTURES.
 * Options: seed (number or string: a different pattern), color (base colour; the whole surface is repainted in it),
 * color2 (the second colour where a kind has one: mortar, grout, flowers, veins, the other checker square),
 * scale (integer 1..4: how many times the pattern repeats inside the tile), contrast (1 = as designed),
 * size (pixels, power of two; default 128).
 */
export function paint(kind, opts = {}) {
  const d = T[kind]; if (!d) throw new Error(`Unknown texture "${kind}". Available: ${TEXTURES.join(', ')}.`);
  const size = opts.size || 128, c = rgb(opts.color ?? d.color), c2 = opts.color2 != null ? rgb(opts.color2) : null, k = Math.max(1, Math.round(opts.scale || 1)), contrast = opts.contrast ?? 1;
  const seed = mixSeed(kind, toSeed(opts.seed ?? 1)), key = `${kind}|${seed}|${c}|${c2}|${k}|${contrast}|${size}`;
  let r = CACHE.get(key); if (r) return r;
  r = new Raster(size); const P = { seed, k, c, c2, params: opts }, o = new Float32Array(4), px = r.rgb, hg = r.hgt;
  for (let y = 0, i = 0; y < size; y++) for (let x = 0; x < size; x++, i++) {
    o[0] = c[0]; o[1] = c[1]; o[2] = c[2]; o[3] = 0.5; d.fn((x + 0.5) / size, (y + 0.5) / size, P, o);
    px[i * 3] = c01(c[0] + (o[0] - c[0]) * contrast); px[i * 3 + 1] = c01(c[1] + (o[1] - c[1]) * contrast); px[i * 3 + 2] = c01(c[2] + (o[2] - c[2]) * contrast); hg[i] = c01(o[3]);
  }
  r.recipe = { kind: 'texture', v: ALGO.value, texture: kind, seed: opts.seed ?? 1, color: opts.color, color2: opts.color2, scale: k, contrast, size };
  CACHE.set(key, r); return r;
}

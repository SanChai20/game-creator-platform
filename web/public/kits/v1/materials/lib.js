// @gcp/materials.js · lib — the GLSL every texture set is painted with. Everything here tiles: a lattice point is
// wrapped by the period before it is hashed, so any pattern made of whole-number frequencies repeats exactly at the
// edge of the tile. Use whole numbers for frequencies (vec2(12.0), vec2(20.0, 11.0)); a fraction breaks the seam.
//
// What a set function (see bases.js) can call:
//   hash3(cell, period, salt)       three random numbers 0..1 for a lattice cell
//   noise(p, period, salt)          gradient noise, about -0.7..0.7
//   fbm(uv, freq, octaves, salt)    fractal noise 0..1, centred on 0.5 (uv is 0..1 across the tile)
//   ridged(uv, freq, octaves, salt) sharp creases 0..1 (1 on the crease)
//   cells(p, period, salt)          Voronoi: x = distance to nearest point, y = to second nearest, z, w = that cell's randoms
//   warp(uv, freq, amount, salt)    uv pushed around by noise (organic shapes)
//   scratches(uv, freq, salt, width, angle, spread, density)   thin straight scratches 0..1
//   chips(uv, freq, salt, density, size)                      flakes of missing paint 0..1
//   patches(uv, freq, threshold, salt)                        soft grainy blotches 0..1 (rust, moss, stains)
//   bond(uv, rows, cols, offset)    a brick / plank / tile layout: xy = position inside the piece (0..1), zw = its cell
//   grout(local, size, widthX, widthY) 1 inside a piece, falling to 0 in the joint; size = piece size in any unit
//   lin(r, g, b) / lin(vec3)        an sRGB colour written by hand, made linear (colours in uniforms are linear already)
// A set writes into  Surf s:  s.col (linear colour), s.h (height 0..1), s.ao (0..1), s.r (roughness), s.m (metalness),
// s.a (opacity; below 0.5 is cut out when the material asks for it).
export const LIB = /* glsl */ `
#define TAU 6.28318530718
#define sat(x) clamp(x, 0.0, 1.0)
struct Surf { vec3 col; float h; float ao; float r; float m; float a; };
vec3 lin(float r, float g, float b){ return pow(vec3(r, g, b), vec3(2.2)); }
vec3 lin(vec3 c){ return pow(c, vec3(2.2)); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
uvec3 pcg3(uvec3 v){ v = v * 1664525u + 1013904223u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; v ^= v >> 16u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; return v; }
vec3 hash3(vec2 c, vec2 per, float salt){ c = mod(floor(c + 0.5), per); return vec3(pcg3(uvec3(uint(c.x), uint(c.y), uint(int(salt + uSeed * 131.0) + 65536)))) * (1.0 / 4294967296.0); }
float hash1(vec2 c, vec2 per, float salt){ return hash3(c, per, salt).x; }
float noise(vec2 p, vec2 per, float salt){
  vec2 i = floor(p), f = p - i, u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 ga = hash3(i, per, salt).xy * 2.0 - 1.0, gb = hash3(i + vec2(1, 0), per, salt).xy * 2.0 - 1.0;
  vec2 gc = hash3(i + vec2(0, 1), per, salt).xy * 2.0 - 1.0, gd = hash3(i + vec2(1, 1), per, salt).xy * 2.0 - 1.0;
  return mix(mix(dot(ga, f), dot(gb, f - vec2(1, 0)), u.x), mix(dot(gc, f - vec2(0, 1)), dot(gd, f - vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 uv, vec2 f, int oct, float salt){
  float a = 0.5, v = 0.0, t = 0.0;
  for (int i = 0; i < oct; i++){ v += a * noise(uv * f, f, salt + float(i) * 7.0); t += a; a *= 0.5; f *= 2.0; }
  return sat(v / t * 1.8 + 0.5);
}
float ridged(vec2 uv, vec2 f, int oct, float salt){
  float a = 0.5, v = 0.0, t = 0.0;
  for (int i = 0; i < oct; i++){ v += a * (1.0 - abs(noise(uv * f, f, salt + float(i) * 7.0)) * 1.6); t += a; a *= 0.5; f *= 2.0; }
  return sat(v / t);
}
vec4 cells(vec2 p, vec2 per, float salt){
  vec2 i = floor(p), f = p - i; float d1 = 9.0, d2 = 9.0; vec2 id = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 o = vec2(float(x), float(y)); vec3 r = hash3(i + o, per, salt); vec2 d = o + r.xy - f; float dd = dot(d, d);
    if (dd < d1){ d2 = d1; d1 = dd; id = vec2(r.z, fract(r.z * 37.0 + r.x * 11.0)); } else if (dd < d2) d2 = dd;
  }
  return vec4(sqrt(d1), sqrt(d2), id);
}
vec2 warp(vec2 uv, vec2 f, float amt, float salt){ return uv + (vec2(fbm(uv, f, 3, salt), fbm(uv, f, 3, salt + 19.0)) - 0.5) * amt; }
float scratches(vec2 uv, float f, float salt, float w, float ang, float spread, float dens){
  vec2 p = uv * f, i = floor(p), fr = p - i; float m = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 o = vec2(float(x), float(y)); vec3 r = hash3(i + o, vec2(f), salt), r2 = hash3(i + o, vec2(f), salt + 31.0);
    vec2 c = o + r.xy - fr; float a = ang + (r.z - 0.5) * spread; vec2 dir = vec2(cos(a), sin(a));
    float al = dot(c, dir), ac = dot(c, vec2(-dir.y, dir.x)), len = 0.15 + r2.x * 0.8;
    m = max(m, smoothstep(w, w * 0.3, abs(ac)) * smoothstep(len, len * 0.7, abs(al)) * step(r2.y, dens) * (0.35 + 0.65 * r2.z));
  }
  return m;
}
float chips(vec2 uv, vec2 f, float salt, float dens, float size){
  vec4 v = cells(uv * f, f, salt); float e = fbm(uv, f * 3.0, 3, salt + 3.0) - 0.5, r = size * (0.25 + 0.75 * v.w);
  return step(v.z, dens) * smoothstep(r, r * 0.55, v.x + e * 0.6);
}
float patches(vec2 uv, vec2 f, float th, float salt){
  float n = fbm(uv, f, 5, salt), g = fbm(uv, f * 12.0, 3, salt + 50.0);
  return smoothstep(th, th + 0.14, n + (g - 0.5) * 0.3) * (0.5 + 0.5 * g);
}
vec4 bond(vec2 uv, float rows, float cols, float offset){
  float y = uv.y * rows, row = floor(y), x = uv.x * cols + offset * mod(row, 2.0), col = floor(x);
  return vec4(fract(x), fract(y), mod(col, cols), row);
}
float grout(vec2 local, vec2 size, float wx, float wy){
  vec2 d = min(local, 1.0 - local) * size; return smoothstep(0.0, wx, d.x) * smoothstep(0.0, wy, d.y);
}
`;

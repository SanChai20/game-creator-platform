// @gcp/procgen.js · glsl — the GPU twin of procgen/noise.js (GLSL ES 3.00, which is what WebGL2 and Three.js
// compile). Same integer hashes, same lattice values, same steps in the same order, so a shader can draw the
// very field the CPU samples: terrain colour that matches heightAt(), water that matches the waves the boat
// rides, a texture generated on either side.
//  - gcpPcg, gcpHash2i, gcpHash3i, gcpHash2, gcpHash3: bit-identical to the CPU.
//  - gcpVnoise2/3, gcpGnoise2/2d/3, gcpFbm2, gcpVfbm2, gcpRidged2, gcpWarp2: same float32 steps as the CPU. A GPU
//    may fuse or reorder a multiply-add, so allow a difference in the last bits (measured: see the guide).
//    Draw with these; let gameplay read the CPU functions.
// Use: put ${NOISE_GLSL} at the top of a ShaderMaterial shader, or call withNoise(material) and use the
// functions in onBeforeCompile code. noise(opts).glsl('p') writes the matching call for you.

export const NOISE_GLSL = /* glsl */ `
#ifndef GCP_NOISE
#define GCP_NOISE
uint gcpPcg(uint n){ uint s = n * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
uint gcpHash2i(ivec2 p, uint seed){ return gcpPcg(uint(p.x) + gcpPcg(uint(p.y) + gcpPcg(seed))); }
uint gcpHash3i(ivec3 p, uint seed){ return gcpPcg(uint(p.x) + gcpPcg(uint(p.y) + gcpPcg(uint(p.z) + gcpPcg(seed)))); }
float gcpHash2(ivec2 p, uint seed){ return float(gcpHash2i(p, seed) >> 8u) / 16777216.0; }
float gcpHash3(ivec3 p, uint seed){ return float(gcpHash3i(p, seed) >> 8u) / 16777216.0; }
int gcpWrap(int i, int p){ return p > 0 ? i - p * int(floor(float(i) / float(p))) : i; }
ivec2 gcpWrap(ivec2 i, ivec2 p){ return ivec2(gcpWrap(i.x, p.x), gcpWrap(i.y, p.y)); }
float gcpQuintic(float t){ return ((t * t) * t) * ((t * ((t * 6.0) - 15.0)) + 10.0); }
float gcpMix(float a, float b, float t){ return a + (t * (b - a)); }

float gcpVnoise2(vec2 p, uint seed, ivec2 period){
  vec2 fl = floor(p); ivec2 i = ivec2(fl); float ux = gcpQuintic(p.x - fl.x), uy = gcpQuintic(p.y - fl.y);
  ivec2 i0 = gcpWrap(i, period), i1 = gcpWrap(i + 1, period);
  float a = gcpHash2(i0, seed), b = gcpHash2(ivec2(i1.x, i0.y), seed), c = gcpHash2(ivec2(i0.x, i1.y), seed), d = gcpHash2(i1, seed);
  return (gcpMix(gcpMix(a, b, ux), gcpMix(c, d, ux), uy) * 2.0) - 1.0;
}
float gcpVnoise2(vec2 p, uint seed){ return gcpVnoise2(p, seed, ivec2(0)); }
float gcpVnoise3(vec3 p, uint seed){
  vec3 fl = floor(p); ivec3 i = ivec3(fl); float ux = gcpQuintic(p.x - fl.x), uy = gcpQuintic(p.y - fl.y), uz = gcpQuintic(p.z - fl.z);
  float lo = gcpMix(gcpMix(gcpHash3(i, seed), gcpHash3(i + ivec3(1,0,0), seed), ux), gcpMix(gcpHash3(i + ivec3(0,1,0), seed), gcpHash3(i + ivec3(1,1,0), seed), ux), uy);
  float hi = gcpMix(gcpMix(gcpHash3(i + ivec3(0,0,1), seed), gcpHash3(i + ivec3(1,0,1), seed), ux), gcpMix(gcpHash3(i + ivec3(0,1,1), seed), gcpHash3(i + ivec3(1,1,1), seed), ux), uy);
  return (gcpMix(lo, hi, uz) * 2.0) - 1.0;
}
vec2 gcpGrad2(ivec2 p, uint seed){ uint h = gcpHash2i(p, seed); return vec2(float(int(h & 65535u)) - 32768.0, float(int(h >> 16u)) - 32768.0) / 32768.0; }
// value in x, derivatives in yz
vec3 gcpGnoise2d(vec2 p, uint seed, ivec2 period){
  vec2 fl = floor(p); ivec2 i = ivec2(fl); float tx = p.x - fl.x, ty = p.y - fl.y, sx = tx - 1.0, sy = ty - 1.0;
  ivec2 i0 = gcpWrap(i, period), i1 = gcpWrap(i + 1, period);
  vec2 ga = gcpGrad2(i0, seed), gb = gcpGrad2(ivec2(i1.x, i0.y), seed), gc = gcpGrad2(ivec2(i0.x, i1.y), seed), gd = gcpGrad2(i1, seed);
  float va = (ga.x * tx) + (ga.y * ty), vb = (gb.x * sx) + (gb.y * ty), vc = (gc.x * tx) + (gc.y * sy), vd = (gd.x * sx) + (gd.y * sy);
  float ux = gcpQuintic(tx), uy = gcpQuintic(ty), k = ((va - vb) - vc) + vd, uxy = ux * uy;
  float v = ((va + (ux * (vb - va))) + (uy * (vc - va))) + (uxy * k);
  vec2 du = 30.0 * vec2(tx * tx * (tx * (tx - 2.0) + 1.0), ty * ty * (ty * (ty - 2.0) + 1.0));
  vec2 d = ga + ux * (gb - ga) + uy * (gc - ga) + uxy * (ga - gb - gc + gd) + du * (vec2(uy, ux) * k + vec2(vb, vc) - va);
  return vec3(v, d) * 1.25;
}
float gcpGnoise2(vec2 p, uint seed, ivec2 period){ return gcpGnoise2d(p, seed, period).x; }
float gcpGnoise2(vec2 p, uint seed){ return gcpGnoise2d(p, seed, ivec2(0)).x; }
float gcpGv3(ivec3 i, vec3 t, uint seed){ uint h = gcpHash3i(i, seed); vec3 g = vec3(float(int(h & 1023u)) - 512.0, float(int((h >> 10u) & 1023u)) - 512.0, float(int((h >> 20u) & 1023u)) - 512.0) / 512.0; return ((g.x * t.x) + (g.y * t.y)) + (g.z * t.z); }
float gcpGnoise3(vec3 p, uint seed){
  vec3 fl = floor(p); ivec3 i = ivec3(fl); vec3 t = p - fl; float ux = gcpQuintic(t.x), uy = gcpQuintic(t.y), uz = gcpQuintic(t.z);
  float lo = gcpMix(gcpMix(gcpGv3(i, t, seed), gcpGv3(i + ivec3(1,0,0), t - vec3(1,0,0), seed), ux), gcpMix(gcpGv3(i + ivec3(0,1,0), t - vec3(0,1,0), seed), gcpGv3(i + ivec3(1,1,0), t - vec3(1,1,0), seed), ux), uy);
  float hi = gcpMix(gcpMix(gcpGv3(i + ivec3(0,0,1), t - vec3(0,0,1), seed), gcpGv3(i + ivec3(1,0,1), t - vec3(1,0,1), seed), ux), gcpMix(gcpGv3(i + ivec3(0,1,1), t - vec3(0,1,1), seed), gcpGv3(i + ivec3(1,1,1), t - vec3(1,1,1), seed), ux), uy);
  return gcpMix(lo, hi, uz) * 1.25;
}
float gcpFbm2(vec2 p, uint seed, int octaves, float lac, float gain, int period){
  float sum = 0.0, amp = 1.0, norm = 0.0; int q = period;
  for (int o = 0; o < octaves; o++) { sum = sum + (amp * gcpGnoise2(p, seed + uint(o) * 0x9e3779b9u, ivec2(q))); norm = norm + amp; amp = amp * gain; p = p * lac; q = int(float(q) * lac); }
  return (sum / norm) * 1.6;
}
float gcpVfbm2(vec2 p, uint seed, int octaves, float lac, float gain, int period){
  float sum = 0.0, amp = 1.0, norm = 0.0; int q = period;
  for (int o = 0; o < octaves; o++) { sum = sum + (amp * gcpVnoise2(p, seed + uint(o) * 0x9e3779b9u, ivec2(q))); norm = norm + amp; amp = amp * gain; p = p * lac; q = int(float(q) * lac); }
  return sum / norm;
}
float gcpRidged2(vec2 p, uint seed, int octaves, float lac, float gain, int period){
  float sum = 0.0, amp = 1.0, norm = 0.0; int q = period;
  for (int o = 0; o < octaves; o++) { float r = 1.0 - abs(gcpGnoise2(p, seed + uint(o) * 0x9e3779b9u, ivec2(q))); sum = sum + (amp * (r * r)); norm = norm + amp; amp = amp * gain; p = p * lac; q = int(float(q) * lac); }
  return ((sum / norm) * 2.0) - 1.0;
}
float gcpWarp2(vec2 p, uint seed, int octaves, float amount, float lac, float gain){
  float qx = gcpFbm2(p, seed ^ 0x68bc21ebu, octaves, lac, gain, 0), qy = gcpFbm2(p, seed ^ 0x02e5be93u, octaves, lac, gain, 0);
  return gcpFbm2(vec2(p.x + (amount * qx), p.y + (amount * qy)), seed, octaves, lac, gain, 0);
}
#endif
`;

/**
 * Makes the gcp* noise functions available inside a built-in Three.js material's shaders, so onBeforeCompile
 * code (or the `vertex` / `fragment` snippets given here) can call them.
 *   withNoise(material, { fragment: 'diffuseColor.rgb *= 0.85 + 0.15 * gcpVnoise2(vGcpWorld.xz * 0.5, 7u);' })
 * vGcpWorld (world position) is provided to both snippets. `vertex` runs after the position is known and may
 * change `transformed` if it is placed with stage 'displace' (before projection).
 */
export function withNoise(material, { vertex = '', fragment = '', displace = '' } = {}) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${NOISE_GLSL}\nvarying vec3 vGcpWorld;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${displace}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\nvGcpWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n${vertex}`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${NOISE_GLSL}\nvarying vec3 vGcpWorld;`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${fragment}`);
  };
  material.customProgramCacheKey = () => 'gcpnoise|' + vertex + '|' + fragment + '|' + displace;
  material.needsUpdate = true;
  return material;
}

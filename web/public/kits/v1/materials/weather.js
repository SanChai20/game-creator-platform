// @gcp/materials.js · weather — the layers a material recipe adds on top of its base, painted into the same texture
// in the same pass: paint (with chips and scratches), edge wear, dirt, rust, moss, leaks and dust. They are plain
// numbers in a recipe, so a material can be invented as data: { base: 'metal', paint: '#b8322a', chips: 0.5, rust: 0.3 }.
// Uniforms: uPaint (rgb linear, a = 1 when painted), uPaintK (chips, scratches, paint roughness, -),
// uWear (edge wear, dirt, rust, moss), uWear2 (leaks, dust, -, -).
export const LAYERS = /* glsl */ `
uniform vec4 uPaint; uniform vec4 uPaintK; uniform vec4 uWear; uniform vec4 uWear2;
// chip: 0 = intact paint .. 1 = down to the base; stain: a thin dark halo round the damage
#ifdef L_PAINT
void paintDamage(vec2 uv, float amt, out float chip, out float stain){
  float zone = smoothstep(0.55, 0.8, fbm(uv, vec2(2.0), 3, 222.0));                 // damage gathers in places
  float dn = (0.02 + 0.08 * zone) * (0.25 + 1.5 * amt);
  float c1 = chips(uv, vec2(24.0, 15.0), 223.0, dn, 0.22);
  float c2 = chips(uv, vec2(56.0, 36.0), 224.0, dn * 1.6, 0.34);
  float worn = fbm(uv, vec2(3.0), 6, 221.0), th = 0.93 - 0.14 * amt;
  float c3 = smoothstep(th, th + 0.03, worn + (fbm(uv, vec2(40.0), 3, 225.0) - 0.5) * 0.12);
  chip = sat(max(max(c1, c2), c3));
  vec4 v = cells(uv * vec2(24.0, 15.0), vec2(24.0, 15.0), 223.0);
  float halo = step(v.z, dn) * smoothstep(0.45, 0.16, v.x) * (0.3 + 0.7 * v.w);
  stain = sat(max(halo, smoothstep(th - 0.05, th, worn)) * smoothstep(0.35, 0.7, fbm(uv, vec2(30.0), 3, 229.0)));
}
#endif
void layers(vec2 uv, inout Surf s){
  float baseH = s.h;
  // ---- paint over the base ----
  #ifdef L_PAINT
  {
    float chip, stain; paintDamage(uv, uPaintK.x, chip, stain);
    float sc = max(scratches(uv, 5.0, 226.0, 0.004, 0.0, 0.5, 0.25 * uPaintK.y), scratches(uv, 14.0, 227.0, 0.008, 1.57, 0.6, 0.2 * uPaintK.y));
    float bare = sat(max(chip * step(0.001, uPaintK.x), sc * 0.85));
    float mott = fbm(uv, vec2(5.0), 4, 228.0), fine = fbm(uv, vec2(90.0), 2, 230.0);
    vec3 pc = uPaint.rgb * (0.9 + 0.2 * mott + 0.05 * (fine - 0.5));
    pc = mix(pc, pc * vec3(0.92, 0.88, 0.8), smoothstep(0.55, 0.85, mott) * 0.35);   // faded, chalky in places
    float primer = smoothstep(0.0, 0.5, bare) * (1.0 - smoothstep(0.6, 1.0, bare));
    vec3 under = mix(s.col * 1.35 + 0.02, lin(0.5, 0.47, 0.42), primer * 0.6) * (1.0 - 0.3 * stain);
    s.col = mix(pc * (1.0 - 0.25 * stain), under, bare);
    float pr = uPaintK.z + (mott - 0.5) * 0.15 + sc * 0.2;
    s.r = mix(pr, s.r, bare); s.m = mix(0.0, s.m, bare);
    float ph = 0.55 + (baseH - 0.5) * 0.6 + (fine - 0.5) * 0.02;                      // paint smooths small relief
    s.h = mix(ph, baseH - 0.05, bare); s.ao *= 1.0 - 0.25 * stain;
    baseH = s.h;
  }
  #endif
  // ---- edge wear: the high spots are rubbed bright ----
  #ifdef L_WEAR
  {
    float hi = smoothstep(0.62 - 0.22 * uWear.x, 0.95 - 0.2 * uWear.x, baseH + (fbm(uv, vec2(24.0), 3, 231.0) - 0.5) * 0.25);
    float k = hi * uWear.x;
    s.col = mix(s.col, s.col * 1.35 + 0.02, k * 0.6); s.r = mix(s.r, s.r * 0.75, k);
  }
  #endif
  // ---- rust: blooms where it is damp, and round any chip ----
  #ifdef L_RUST
  {
    float rm = patches(uv, vec2(4.0), 0.78 - 0.4 * uWear.z, 232.0);
    float grain = fbm(uv, vec2(120.0), 3, 233.0), cell = cells(uv * 40.0, vec2(40.0), 234.0).x;
    vec3 rc = mix(lin(0.32, 0.14, 0.06), lin(0.62, 0.33, 0.13), grain); rc = mix(rc, lin(0.2, 0.09, 0.05), smoothstep(0.2, 0.5, cell) * 0.5);
    float k = sat(rm * (0.6 + 0.8 * uWear.z));
    s.col = mix(s.col, rc, k); s.r = mix(s.r, 0.9, k); s.m = mix(s.m, 0.0, k); s.h = mix(s.h, s.h + (grain - 0.5) * 0.12, k); s.ao *= 1.0 - 0.15 * k;
  }
  #endif
  // ---- dirt: settles in the low parts and in blotches ----
  #ifdef L_DIRT
  {
    float low = smoothstep(0.55, 0.15, s.h) * 0.8 + (1.0 - s.ao) * 0.6;
    float blot = smoothstep(0.45, 0.8, fbm(uv, vec2(3.0), 5, 235.0));
    float k = sat((low * 0.8 + blot * 0.6) * uWear.y * (0.6 + 0.6 * fbm(uv, vec2(40.0), 3, 236.0)));
    s.col = mix(s.col, lin(0.22, 0.18, 0.13) * (0.8 + 0.4 * fbm(uv, vec2(9.0), 3, 237.0)), k * 0.85); s.r = mix(s.r, 0.95, k); s.m *= 1.0 - k;
  }
  #endif
  // ---- leaks: dark streaks running down ----
  #ifdef L_LEAKS
  {
    float st = fbm(uv, vec2(48.0, 2.0), 3, 238.0), on = smoothstep(0.55, 0.85, st) * smoothstep(0.3, 0.7, fbm(uv, vec2(5.0, 1.0), 2, 239.0));
    float k = on * uWear2.x; s.col *= 1.0 - 0.45 * k; s.r = mix(s.r, s.r * 0.85, k);
  }
  #endif
  // ---- moss: in the cracks first, then over the top ----
  #ifdef L_MOSS
  {
    float low = smoothstep(0.6, 0.2, s.h), n = fbm(uv, vec2(6.0), 5, 240.0), tuft = fbm(uv, vec2(90.0), 3, 241.0);
    float k = sat(smoothstep(0.72 - 0.5 * uWear.w, 0.95 - 0.45 * uWear.w, n + low * 0.35 * uWear.w) * (0.7 + 0.5 * tuft));
    vec3 mc = mix(lin(0.17, 0.25, 0.07), lin(0.38, 0.46, 0.12), tuft);
    s.col = mix(s.col, mc, k); s.r = mix(s.r, 0.95, k); s.m *= 1.0 - k; s.h = mix(s.h, max(s.h, 0.55 + tuft * 0.3), k); s.ao = mix(s.ao, 0.8 + 0.2 * tuft, k);
  }
  #endif
  // ---- dust: a pale film, thickest on the flats ----
  #ifdef L_DUST
  {
    float k = sat(uWear2.y * (0.5 + 0.7 * fbm(uv, vec2(4.0), 4, 242.0)) * smoothstep(0.2, 0.6, s.h));
    s.col = mix(s.col, lin(0.62, 0.57, 0.5), k * 0.55); s.r = mix(s.r, 1.0, k); s.m *= 1.0 - k * 0.7;
  }
  #endif
}
`;

// @gcp/materials.js · bases — the texture sets. Each is a short GLSL function, base(uv, s), painted with the tileable
// library in lib.js; the baker runs it once per pixel on the GPU and keeps colour, height, ambient occlusion,
// roughness and metalness. uC1 is the main colour and uC2 the second (mortar, grout, veins, the gaps between boards),
// both linear and set from the recipe; uP holds up to four extra numbers a set documents.
// Fields: color, color2 (sRGB hex), tile (metres one texture covers, or [x, y]), bump (relief depth in mm for the
// normal map), cut (true: alpha below 0.5 is cut out), use (one line: what it is for).

const B = {};
const def = (name, o) => { B[name] = { color: 0x888888, tile: 2, bump: 2, ...o, name }; };

// ----------------------------------------------------------------- built: stone, masonry, concrete
def('concrete', { color: 0x8a8781, tile: 3, bump: 2.5, use: 'cast concrete: walls, floors, kerbs, bunkers', glsl: `
void base(vec2 uv, inout Surf s){
  float big = fbm(uv, vec2(2.0), 5, 1.0), mid = fbm(uv, vec2(12.0), 5, 2.0), fine = fbm(uv, vec2(160.0), 3, 3.0), form = fbm(uv, vec2(2.0, 7.0), 4, 4.0);
  vec4 po = cells(uv * 70.0, vec2(70.0), 5.0); float pore = step(po.z, 0.35) * smoothstep(0.16 * po.w + 0.03, 0.02, po.x);
  vec2 wu = warp(uv, vec2(6.0), 0.1, 7.0); vec4 cr = cells(wu * 3.0, vec2(3.0), 9.0);
  float crack = smoothstep(0.006, 0.0015, cr.y - cr.x) * smoothstep(0.5, 0.62, fbm(uv, vec2(3.0), 2, 10.0));
  float chip = smoothstep(0.84, 0.88, fbm(uv, vec2(7.0), 4, 11.0) + (fine - 0.5) * 0.08);
  s.h = 0.6 + (mid - 0.5) * 0.25 + (fine - 0.5) * 0.12 - pore * 0.35 - crack * 0.25; s.h = mix(s.h, 0.4 + fine * 0.1, chip);
  vec3 c = uC1 * (0.74 + 0.4 * big + 0.2 * (mid - 0.5) + 0.08 * (form - 0.5));
  c *= mix(vec3(1.04, 1.0, 0.94), vec3(0.95, 1.0, 1.05), fbm(uv, vec2(3.0), 3, 13.0));
  c *= 1.0 - smoothstep(0.55, 0.8, fbm(uv, vec2(4.0), 5, 14.0)) * 0.25;
  c *= 1.0 - pore * 0.45 - crack * 0.55; c = mix(c, c * 0.8 * (0.85 + 0.3 * fine), chip);
  s.col = c; s.r = 0.86 + (mid - 0.5) * 0.15; s.ao = 1.0 - pore * 0.5 - crack * 0.5 - chip * 0.15;
}` });
def('asphalt', { color: 0x2c2c2e, color2: 0x77736e, tile: 2, bump: 1.6, use: 'roads, car parks, roofs', glsl: `
void base(vec2 uv, inout Surf s){
  vec4 a = cells(uv * 110.0, vec2(110.0), 1.0), b = cells(uv * 230.0 + 3.0, vec2(230.0), 2.0);
  float big = fbm(uv, vec2(3.0), 4, 5.0), mid = fbm(uv, vec2(24.0), 4, 6.0), fine = fbm(uv, vec2(300.0), 2, 7.0);
  float sa = smoothstep(0.46, 0.3, a.x + (1.0 - a.w) * 0.12) * step(a.z, 0.6), sb = smoothstep(0.46, 0.3, b.x) * step(b.z, 0.8);
  float wear = smoothstep(0.3, 0.7, big), stone = sat(max(sa, sb * 0.8));
  vec3 st = uC2 * (0.65 + 0.5 * a.w);
  vec3 c = uC1 * (0.8 + 0.4 * mid); c = mix(c, st, stone * (0.35 + 0.5 * wear)); c *= 0.9 + 0.2 * big;
  float cn = fbm(uv + vec2(0.13, 0.4), vec2(2.0), 3, 9.0);
  float tar = smoothstep(0.016, 0.009, abs(cn - 0.5) + (fbm(uv, vec2(70.0), 2, 13.0) - 0.5) * 0.008) * smoothstep(0.45, 0.6, fbm(uv, vec2(2.0), 2, 12.0));
  c = mix(c, uC1 * 0.55, tar * 0.9);
  s.h = max(sa * (0.45 + 0.55 * a.w), sb * 0.5) * 0.6 + fine * 0.3 + mid * 0.1; s.h = mix(s.h, 0.75, tar * 0.85);
  s.col = c; s.r = mix(mix(0.93, 0.75, stone * wear), 0.4, tar); s.ao = mix(0.6, 1.0, smoothstep(0.0, 0.6, s.h));
}` });
def('brick', { color: 0x8c4632, color2: 0xa9a297, tile: [1.0, 1.0], bump: 6, use: 'brick walls and chimneys (color: brick, color2: mortar)', glsl: `
void base(vec2 uv, inout Surf s){
  vec4 b = bond(uv, 14.0, 4.0, 0.5); vec3 id = hash3(b.zw, vec2(4.0, 14.0), 1.0);
  float ed = fbm(uv, vec2(48.0), 3, 2.0) - 0.5;
  float g = grout(b.xy + ed * 0.04, vec2(225.0, 70.0), 9.0 + id.x * 4.0, 8.0 + id.y * 3.0);
  float face = fbm(uv, vec2(64.0), 4, 3.0), spot = smoothstep(0.7, 0.9, fbm(uv, vec2(24.0), 3, 4.0));
  vec3 c = uC1 * (0.72 + 0.5 * id.x) * mix(vec3(1.0), vec3(1.1, 0.92, 0.85), id.y) * (0.85 + 0.3 * face);
  c = mix(c, c * 0.55, spot * 0.5 * id.z) * mix(1.0, 1.25, smoothstep(0.85, 1.0, id.z) * 0.6);
  vec3 m = uC2 * (0.85 + 0.3 * fbm(uv, vec2(90.0), 3, 5.0));
  s.col = mix(m, c, g); s.h = mix(0.15 + face * 0.1, 0.75 + face * 0.15 - spot * 0.05, g);
  s.r = mix(0.95, 0.82 - id.x * 0.08, g); s.ao = mix(0.55, 1.0, smoothstep(0.0, 0.8, g));
}` });
def('stonewall', { color: 0x8d877c, color2: 0x6e675c, tile: 2.4, bump: 9, use: 'dry-stone and mortared walls of rough stones, castles, ruins', glsl: `
void base(vec2 uv, inout Surf s){
  vec2 q = warp(uv, vec2(8.0), 0.045, 1.0) * vec2(5.0, 8.0);
  vec4 v = cells(q, vec2(5.0, 8.0), 2.0);
  float e = v.y - v.x, g = smoothstep(0.03, 0.16, e);
  float face = fbm(uv, vec2(30.0), 5, 3.0), dome = sat(e * 2.4);
  vec3 c = uC1 * (0.7 + 0.55 * v.z) * mix(vec3(1.0), vec3(1.08, 1.0, 0.88), v.w) * (0.8 + 0.4 * face);
  vec3 m = uC2 * (0.6 + 0.3 * fbm(uv, vec2(60.0), 3, 4.0));
  s.col = mix(m, c, g); s.h = mix(0.1, 0.45 + dome * 0.4 + face * 0.15, g);
  s.r = mix(0.97, 0.86, g); s.ao = mix(0.35, 1.0, smoothstep(0.0, 0.6, g * dome + g * 0.3));
}` });
def('cobble', { color: 0x8a8680, color2: 0x5e5446, tile: 2, bump: 10, use: 'cobbled streets, courtyards, old paths', glsl: `
void base(vec2 uv, inout Surf s){
  vec2 q = warp(uv, vec2(10.0), 0.02, 1.0) * 9.0; vec4 v = cells(q, vec2(9.0), 2.0);
  float e = v.y - v.x, dome = sat(e * 1.8), g = smoothstep(0.04, 0.2, e);
  float face = fbm(uv, vec2(40.0), 4, 3.0), polish = smoothstep(0.5, 1.0, dome);
  vec3 c = uC1 * (0.65 + 0.6 * v.z) * mix(vec3(1.0), vec3(1.06, 1.0, 0.9), v.w) * (0.85 + 0.3 * face);
  vec3 m = uC2 * (0.7 + 0.4 * fbm(uv, vec2(80.0), 3, 4.0));
  s.col = mix(m, c, g); s.h = mix(0.05, 0.3 + sqrt(dome) * 0.65 + face * 0.05, g);
  s.r = mix(0.98, 0.78 - polish * 0.2, g); s.ao = mix(0.3, 1.0, sqrt(dome) * g);
}` });
def('tiles', { color: 0xd8d2c4, color2: 0x8e877a, tile: 1.2, bump: 2.5, p: [4, 0, 0, 0], use: 'square ceramic tiles: kitchens, baths, floors (p[0]: tiles across)', glsl: `
void base(vec2 uv, inout Surf s){
  float n = max(1.0, floor(uP.x + 0.5)); vec4 b = bond(uv, n, n, 0.0); vec3 id = hash3(b.zw, vec2(n), 1.0);
  float g = grout(b.xy, vec2(300.0 / n), 3.0, 3.0), bev = grout(b.xy, vec2(300.0 / n), 9.0, 9.0);
  float face = fbm(uv, vec2(8.0), 4, 2.0);
  vec3 c = uC1 * (0.92 + 0.14 * id.x + 0.06 * (face - 0.5)); c = mix(c, c * 0.85, step(0.93, id.y));
  s.col = mix(uC2 * (0.8 + 0.3 * fbm(uv, vec2(80.0), 2, 3.0)), c, g); s.h = mix(0.2, 0.6 + bev * 0.3, g);
  s.r = mix(0.9, 0.12 + 0.12 * face, g); s.ao = mix(0.6, 1.0, g);
}` });
def('plaster', { color: 0xd9d0bd, tile: 3, bump: 2, use: 'rendered and whitewashed walls, stucco, adobe', glsl: `
void base(vec2 uv, inout Surf s){
  float big = fbm(uv, vec2(2.0), 5, 1.0), trowel = fbm(warp(uv, vec2(4.0), 0.2, 2.0), vec2(9.0, 5.0), 4, 3.0), fine = fbm(uv, vec2(200.0), 2, 4.0);
  vec2 wu = warp(uv, vec2(6.0), 0.12, 5.0); vec4 cr = cells(wu * 4.0, vec2(4.0), 6.0);
  float crack = smoothstep(0.005, 0.001, cr.y - cr.x) * smoothstep(0.58, 0.68, fbm(uv, vec2(3.0), 2, 7.0));
  float flake = smoothstep(0.86, 0.9, fbm(uv, vec2(5.0), 5, 8.0));
  vec3 c = uC1 * (0.86 + 0.18 * big + 0.06 * (trowel - 0.5)) * (1.0 - crack * 0.5);
  c = mix(c, uC1 * vec3(0.72, 0.66, 0.6), flake);
  s.col = c; s.h = 0.55 + (trowel - 0.5) * 0.3 + (fine - 0.5) * 0.08 - crack * 0.3 - flake * 0.2; s.r = 0.92; s.ao = 1.0 - crack * 0.5 - flake * 0.2;
}` });
def('marble', { color: 0xe6e2da, color2: 0x7d7a76, tile: 2, bump: 0.5, use: 'polished stone: palaces, temples, counters (color2: veins)', glsl: `
void base(vec2 uv, inout Surf s){
  vec2 q = warp(uv, vec2(3.0), 0.35, 1.0); float v = ridged(q, vec2(3.0, 2.0), 5, 2.0), v2 = ridged(q + 0.3, vec2(6.0), 4, 3.0);
  float vein = pow(v, 9.0) * 0.9 + pow(v2, 14.0) * 0.5, cloud = fbm(uv, vec2(4.0), 5, 4.0);
  s.col = mix(uC1 * (0.9 + 0.15 * cloud), uC2, sat(vein)); s.h = 0.5 - vein * 0.04; s.r = 0.12 + 0.1 * cloud + vein * 0.1; s.ao = 1.0;
}` });

// ----------------------------------------------------------------- metal
def('metal', { color: 0x6f7378, tile: 1.5, bump: 0.6, use: 'bare sheet steel and iron: machines, doors, hulls (paint over it with paint: colour)', glsl: `
void base(vec2 uv, inout Surf s){
  float big = fbm(uv, vec2(3.0), 5, 1.0), mill = fbm(uv, vec2(2.0, 24.0), 4, 2.0), fine = fbm(uv, vec2(220.0), 2, 3.0);
  float sc = scratches(uv, 7.0, 4.0, 0.003, 0.2, 0.6, 0.35), smudge = smoothstep(0.55, 0.85, fbm(uv, vec2(5.0), 4, 5.0));
  s.col = uC1 * (0.85 + 0.25 * big + 0.1 * (mill - 0.5)) * (1.0 - smudge * 0.2) + sc * 0.04;
  s.h = 0.5 + (fine - 0.5) * 0.05 - sc * 0.05; s.r = 0.42 + 0.18 * (mill - 0.5) + smudge * 0.15 - sc * 0.1; s.m = 1.0; s.ao = 1.0;
}` });
def('brushed', { color: 0xb4b8bd, tile: 0.6, bump: 0.3, use: 'brushed steel and aluminium: appliances, rails, trims', glsl: `
void base(vec2 uv, inout Surf s){
  float st = fbm(uv, vec2(2.0, 260.0), 3, 1.0), st2 = fbm(uv, vec2(1.0, 600.0), 2, 2.0), big = fbm(uv, vec2(3.0), 4, 3.0);
  s.col = uC1 * (0.9 + 0.12 * (st - 0.5) + 0.06 * (st2 - 0.5) + 0.08 * (big - 0.5));
  s.h = 0.5 + (st - 0.5) * 0.1; s.r = 0.28 + 0.1 * st + 0.08 * big; s.m = 1.0; s.ao = 1.0;
}` });
def('galvanized', { color: 0x9da3a6, tile: 1, bump: 0.6, use: 'galvanised steel: fences, ducts, pails, barriers', glsl: `
void base(vec2 uv, inout Surf s){
  vec4 sp = cells(warp(uv, vec2(10.0), 0.02, 1.0) * 14.0, vec2(14.0), 2.0); float big = fbm(uv, vec2(3.0), 4, 3.0);
  float bound = smoothstep(0.0, 0.03, sp.y - sp.x), wh = smoothstep(0.65, 0.9, fbm(uv, vec2(4.0), 4, 4.0));
  s.col = uC1 * (0.82 + 0.3 * sp.z + 0.1 * (big - 0.5)) * (0.9 + 0.1 * bound); s.col = mix(s.col, uC1 * 1.05 + 0.05, wh * 0.5);
  s.h = 0.5 + sp.z * 0.06; s.r = 0.35 + 0.25 * sp.w + wh * 0.3; s.m = 1.0 - wh * 0.4; s.ao = 1.0;
}` });
def('corrugated', { color: 0x8f9499, tile: [0.76, 2.0], bump: 22, use: 'corrugated sheet: shed and barn roofs, fences, containers', glsl: `
void base(vec2 uv, inout Surf s){
  float x = uv.x * 10.0, w = 0.5 + 0.5 * cos(x * TAU), big = fbm(uv, vec2(3.0, 2.0), 4, 1.0), fine = fbm(uv, vec2(80.0), 2, 2.0);
  float streak = smoothstep(0.5, 0.8, fbm(uv, vec2(10.0, 1.0), 3, 3.0));
  s.col = uC1 * (0.8 + 0.3 * big + 0.12 * w) * (1.0 - streak * 0.15);
  s.h = 0.15 + 0.75 * w + (fine - 0.5) * 0.02; s.r = 0.45 + 0.2 * big + streak * 0.15; s.m = 1.0; s.ao = 0.75 + 0.25 * w;
}` });
def('diamondplate', { color: 0x9aa0a6, tile: 0.5, bump: 3, use: 'tread plate: steps, ramps, truck beds, catwalks', glsl: `
void base(vec2 uv, inout Surf s){
  vec2 g = uv * 8.0, c = floor(g), f = fract(g) - 0.5; float alt = mod(c.x + c.y, 2.0), a = alt > 0.5 ? 0.785 : -0.785;
  vec2 r = vec2(cos(a) * f.x - sin(a) * f.y, sin(a) * f.x + cos(a) * f.y); float d = length(r / vec2(0.36, 0.07));
  float bump = smoothstep(1.0, 0.75, d), big = fbm(uv, vec2(3.0), 4, 1.0), sc = scratches(uv, 5.0, 2.0, 0.004, 0.0, 3.0, 0.4);
  s.col = uC1 * (0.78 + 0.25 * big + 0.12 * bump) + sc * 0.03; s.h = 0.3 + 0.6 * bump; s.r = mix(0.5, 0.3, bump) + 0.15 * (big - 0.5); s.m = 1.0; s.ao = 0.8 + 0.2 * bump;
}` });
def('panels', { color: 0x7d838a, tile: 2, bump: 6, p: [4, 2, 0, 0], use: 'riveted plates: ship hulls, sci-fi walls, vaults, armour (p[0] x p[1] plates)', glsl: `
void base(vec2 uv, inout Surf s){
  vec2 n = max(vec2(1.0), floor(uP.xy + 0.5)); vec4 b = bond(uv, n.y, n.x, 0.0); vec3 id = hash3(b.zw, n.yx, 1.0);
  float g = grout(b.xy, 400.0 / n, 2.5, 2.5), lip = grout(b.xy, 400.0 / n, 9.0, 9.0);
  vec2 rp = b.xy * (400.0 / n) / 14.0; vec2 rc = fract(rp) - 0.5; float edge = 1.0 - grout(b.xy, 400.0 / n, 14.0, 14.0);
  float rivet = smoothstep(0.3, 0.18, length(rc)) * edge * step(0.1, min(b.x, 1.0 - b.x) * 400.0 / n.x + 1.0);
  float big = fbm(uv, vec2(3.0), 4, 2.0), sc = scratches(uv, 6.0, 3.0, 0.003, 0.3, 1.0, 0.3);
  s.col = uC1 * (0.85 + 0.2 * id.x + 0.15 * (big - 0.5)) * mix(0.55, 1.0, g) + sc * 0.03;
  s.h = mix(0.1, 0.5 + lip * 0.05, g) + rivet * 0.25; s.r = 0.45 + 0.2 * id.y + 0.1 * big - rivet * 0.15; s.m = 1.0; s.ao = mix(0.5, 1.0, g);
}` });
def('rust', { color: 0x7a3e1e, tile: 1.2, bump: 3, use: 'steel eaten through with rust: wrecks, old tanks, scrap', glsl: `
void base(vec2 uv, inout Surf s){
  float big = fbm(uv, vec2(3.0), 5, 1.0), mid = fbm(uv, vec2(18.0), 4, 2.0), grain = fbm(uv, vec2(160.0), 3, 3.0);
  vec4 pit = cells(uv * 36.0, vec2(36.0), 4.0); float pits = step(pit.z, 0.4) * smoothstep(0.3, 0.1, pit.x);
  float flake = smoothstep(0.6, 0.75, fbm(uv, vec2(9.0), 5, 5.0)), steel = smoothstep(0.82, 0.9, fbm(uv, vec2(5.0), 4, 6.0));
  vec3 c = mix(uC1 * 0.55, uC1 * 1.35 + vec3(0.03, 0.01, 0.0), mid) * (0.75 + 0.5 * grain);
  c = mix(c, lin(0.18, 0.1, 0.07), flake * 0.6); c = mix(c, lin(0.36, 0.36, 0.36), steel * 0.8);
  s.col = c * (1.0 - pits * 0.4); s.h = 0.45 + (mid - 0.5) * 0.3 + (grain - 0.5) * 0.2 + flake * 0.15 - pits * 0.2;
  s.r = mix(0.88 + 0.1 * grain, 0.45, steel); s.m = steel; s.ao = 1.0 - pits * 0.4;
}` });

// ----------------------------------------------------------------- made: plastic, rubber, cloth, leather, paper
def('plastic', { color: 0x2f5fa8, tile: 1, bump: 0.6, use: 'moulded plastic: crates, toys, gadgets, furniture', glsl: `
void base(vec2 uv, inout Surf s){
  float big = fbm(uv, vec2(3.0), 4, 1.0), fine = fbm(uv, vec2(240.0), 2, 2.0), sc = scratches(uv, 6.0, 3.0, 0.003, 0.0, 3.0, 0.3);
  s.col = uC1 * (0.92 + 0.12 * big) + sc * 0.04; s.h = 0.5 + (fine - 0.5) * 0.06; s.r = 0.38 + 0.12 * big + sc * 0.2; s.m = 0.0; s.ao = 1.0;
}` });
def('rubber', { color: 0x1d1d1f, tile: 0.5, bump: 0.8, use: 'rubber: tyres, mats, seals, boots', glsl: `
void base(vec2 uv, inout Surf s){
  float big = fbm(uv, vec2(3.0), 4, 1.0), fine = fbm(uv, vec2(200.0), 3, 2.0), bloom = smoothstep(0.6, 0.85, fbm(uv, vec2(5.0), 4, 3.0));
  s.col = uC1 * (0.85 + 0.25 * big) + bloom * 0.025; s.h = 0.5 + (fine - 0.5) * 0.25; s.r = 0.82 + 0.1 * fine + bloom * 0.08; s.m = 0.0; s.ao = 1.0;
}` });
def('fabric', { color: 0x5b6b7c, tile: 0.25, bump: 1.2, use: 'woven cloth: clothes, sails, tents, upholstery, banners', glsl: `
void base(vec2 uv, inout Surf s){
  vec2 g = uv * 96.0; vec2 c = floor(g), f = fract(g); float over = mod(c.x + c.y, 2.0);
  float wx = smoothstep(0.5, 0.25, abs(f.y - 0.5)), wy = smoothstep(0.5, 0.25, abs(f.x - 0.5));
  float th = over > 0.5 ? wx * (0.6 + 0.4 * sin(f.x * 3.14)) : wy * (0.6 + 0.4 * sin(f.y * 3.14));
  float big = fbm(uv, vec2(4.0), 4, 1.0), slub = fbm(uv, vec2(8.0, 96.0), 2, 2.0);
  s.col = uC1 * (0.78 + 0.3 * th + 0.12 * (big - 0.5) + 0.08 * (slub - 0.5)); s.h = 0.3 + th * 0.6; s.r = 0.92; s.m = 0.0; s.ao = 0.7 + 0.3 * th;
}` });
def('leather', { color: 0x6b4026, tile: 0.4, bump: 1.5, use: 'leather: saddles, belts, books, armour, sofas', glsl: `
void base(vec2 uv, inout Surf s){
  vec4 v = cells(warp(uv, vec2(12.0), 0.01, 1.0) * 60.0, vec2(60.0), 2.0); float pebble = smoothstep(0.0, 0.25, v.y - v.x);
  float big = fbm(uv, vec2(3.0), 5, 3.0), crease = smoothstep(0.88, 0.97, ridged(uv, vec2(4.0), 4, 4.0)), worn = smoothstep(0.55, 0.85, fbm(uv, vec2(5.0), 4, 5.0));
  s.col = uC1 * (0.75 + 0.3 * big + 0.12 * pebble) * (1.0 - crease * 0.35); s.col = mix(s.col, s.col * 1.3, worn * 0.4);
  s.h = 0.4 + 0.3 * pebble - crease * 0.25; s.r = 0.62 - worn * 0.2 + 0.1 * (1.0 - pebble); s.m = 0.0; s.ao = 0.8 + 0.2 * pebble;
}` });
def('tarp', { color: 0x3b5b3a, tile: 1.5, bump: 14, use: 'tarpaulin and canvas covers: tents, cargo, awnings, sandbags', glsl: `
void base(vec2 uv, inout Surf s){
  vec2 g = uv * 180.0; float weave = (sin(g.x * 3.14) * sin(g.y * 3.14)) * 0.5 + 0.5;
  float fold = ridged(warp(uv, vec2(3.0), 0.2, 1.0), vec2(3.0, 2.0), 3, 2.0), big = fbm(uv, vec2(3.0), 4, 3.0);
  float crease = smoothstep(0.85, 0.98, fold), dirt = smoothstep(0.55, 0.85, fbm(uv, vec2(4.0), 5, 4.0));
  s.col = uC1 * (0.8 + 0.25 * big + 0.06 * weave) * (1.0 - crease * 0.25) * (1.0 - dirt * 0.25);
  s.h = 0.3 + fold * 0.6 + weave * 0.02; s.r = 0.75 - crease * 0.1; s.m = 0.0; s.ao = 0.65 + 0.35 * fold;
}` });
def('cardboard', { color: 0xa47c4e, tile: 1, bump: 1, use: 'cardboard boxes, paper, packaging', glsl: `
void base(vec2 uv, inout Surf s){
  float flute = 0.5 + 0.5 * cos(uv.y * 160.0 * TAU), fib = fbm(uv, vec2(6.0, 120.0), 3, 1.0), big = fbm(uv, vec2(3.0), 4, 2.0);
  float stain = smoothstep(0.62, 0.8, fbm(uv, vec2(4.0), 4, 3.0));
  s.col = uC1 * (0.86 + 0.16 * big + 0.08 * (fib - 0.5)) * (1.0 - stain * 0.2); s.h = 0.5 + flute * 0.06 + (fib - 0.5) * 0.05;
  s.r = 0.9; s.m = 0.0; s.ao = 1.0;
}` });

// ----------------------------------------------------------------- wood
def('planks', { color: 0x8a6440, color2: 0x3a2a1a, tile: 2, bump: 5, p: [8, 0, 0, 0], use: 'boards: floors, decks, walls, crates, fences (p[0]: boards across)', glsl: `
void base(vec2 uv, inout Surf s){
  float n = max(1.0, floor(uP.x + 0.5)), x = uv.x * n, col = floor(x), fx = fract(x);
  vec3 id = hash3(vec2(col, 0.0), vec2(n, 1.0), 1.0); float yy = uv.y * 2.0 + id.x * 2.0, cut = floor(yy), fy = fract(yy);
  vec3 id2 = hash3(vec2(col, cut), vec2(n, 2.0), 2.0);
  float wv = fbm(uv, vec2(n * 2.0, 3.0), 3, 3.0 + id2.z * 5.0);
  float grain = 0.5 + 0.5 * sin((fx * (2.5 + id2.y * 2.0) + wv * 1.6 + id2.z * 7.0) * TAU * 2.0);
  float streak = fbm(uv, vec2(n * 24.0, 4.0), 3, 4.0), fine = fbm(uv, vec2(n * 60.0, 10.0), 2, 6.0);
  vec4 kn = cells(uv * vec2(n, 3.0), vec2(n, 3.0), 5.0); float knot = step(kn.z, 0.2) * smoothstep(0.1, 0.03, kn.x);
  float gap = grout(vec2(fx, fy), vec2(220.0 / n, 110.0), 1.6, 1.2), bev = grout(vec2(fx, fy), vec2(220.0 / n, 110.0), 6.0, 4.0);
  vec3 c = uC1 * (0.72 + 0.4 * id2.x) * (0.84 + 0.16 * grain + 0.14 * (streak - 0.5) + 0.06 * (fine - 0.5)); c = mix(c, c * 0.5, knot);
  s.col = mix(uC2, c, gap); s.h = mix(0.1, 0.55 + bev * 0.15 + (grain - 0.5) * 0.05 + (streak - 0.5) * 0.08 - knot * 0.1, gap);
  s.r = mix(0.95, 0.7 + 0.1 * grain, gap); s.m = 0.0; s.ao = mix(0.45, 1.0, bev);
}` });
def('wood', { color: 0x7c5a3a, tile: 1, bump: 2, use: 'solid wood with grain: beams, posts, furniture, handles, logs', glsl: `
void base(vec2 uv, inout Surf s){
  float wv = fbm(uv, vec2(3.0, 2.0), 4, 1.0), wv2 = fbm(uv, vec2(12.0, 2.0), 3, 2.0);
  float grain = 0.5 + 0.5 * sin((uv.x * 9.0 + wv * 1.4 + wv2 * 0.25) * TAU * 2.0);
  float streak = fbm(uv, vec2(48.0, 3.0), 3, 3.0), pore = fbm(uv, vec2(160.0, 6.0), 2, 4.0);
  vec4 kn = cells(uv * vec2(3.0, 2.0), vec2(3.0, 2.0), 5.0); float knot = step(kn.z, 0.25) * smoothstep(0.1, 0.02, kn.x);
  vec3 c = uC1 * (0.8 + 0.18 * grain + 0.16 * (streak - 0.5) - 0.06 * pore); c = mix(c, c * 0.5, knot);
  s.col = c; s.h = 0.5 + (grain - 0.5) * 0.06 + (streak - 0.5) * 0.12 - pore * 0.05; s.r = 0.68 + 0.1 * grain; s.m = 0.0; s.ao = 1.0 - knot * 0.2;
}` });
def('bark', { color: 0x7a6048, tile: 1.2, bump: 18, use: 'tree bark: trunks, logs, rustic posts', glsl: `
void base(vec2 uv, inout Surf s){
  vec2 q = warp(uv, vec2(3.0, 2.0), 0.08, 1.0); float r = ridged(q, vec2(9.0, 2.0), 4, 2.0), plate = fbm(q, vec2(14.0, 4.0), 4, 3.0);
  float fiss = smoothstep(0.55, 0.85, r), lich = patches(uv, vec2(4.0), 0.8, 4.0);
  vec3 c = uC1 * (0.65 + 0.55 * plate) * mix(0.5, 1.0, 1.0 - fiss); c = mix(c, lin(0.5, 0.55, 0.4), lich * 0.35);
  s.col = c; s.h = 0.85 - fiss * 0.7 + (plate - 0.5) * 0.2; s.r = 0.93; s.m = 0.0; s.ao = 1.0 - fiss * 0.55;
}` });
def('endgrain', { color: 0xa47a4c, tile: 0.5, bump: 2, use: 'cut log ends and stumps (growth rings)', glsl: `
void base(vec2 uv, inout Surf s){
  vec2 p = (uv - 0.5) * 2.0; float d = length(p) + (fbm(uv, vec2(6.0), 4, 1.0) - 0.5) * 0.12;
  float ring = 0.5 + 0.5 * sin(d * 70.0), check = smoothstep(0.96, 0.995, ridged(uv, vec2(5.0), 3, 2.0)) * smoothstep(0.1, 0.5, d);
  float barkR = smoothstep(0.86, 0.92, d); vec3 c = uC1 * (0.75 + 0.3 * ring) * mix(1.12, 0.85, d);
  c = mix(c, uC1 * 0.35, barkR) * (1.0 - check * 0.6);
  s.col = c; s.h = 0.5 + (ring - 0.5) * 0.06 - check * 0.3 + barkR * 0.2; s.r = 0.88; s.m = 0.0; s.ao = 1.0 - check * 0.5;
}` });
def('thatch', { color: 0xb3934f, tile: 1.5, bump: 16, use: 'thatched roofs, straw, hay', glsl: `
void base(vec2 uv, inout Surf s){
  float rows = 6.0, y = uv.y * rows, row = floor(y), fy = fract(y);
  float st = fbm(vec2(uv.x, uv.y), vec2(120.0, 3.0), 3, 1.0 + row), st2 = fbm(uv, vec2(260.0, 6.0), 2, 2.0);
  float tip = smoothstep(0.0, 0.3, fy) * (0.6 + 0.4 * st), age = fbm(uv, vec2(3.0), 4, 3.0);
  vec3 c = uC1 * (0.6 + 0.6 * st * (0.6 + 0.4 * st2)) * mix(0.55, 1.0, tip); c = mix(c, c * vec3(0.7, 0.72, 0.7), smoothstep(0.5, 0.8, age) * 0.6);
  s.col = c; s.h = fy * 0.6 + st * 0.35; s.r = 0.95; s.m = 0.0; s.ao = mix(0.4, 1.0, tip);
}` });
def('shingles', { color: 0x6d5a48, color2: 0x231a12, tile: 1.6, bump: 8, use: 'wooden or slate shingle roofs and walls', glsl: `
void base(vec2 uv, inout Surf s){
  vec4 b = bond(uv, 8.0, 6.0, 0.5); vec3 id = hash3(b.zw, vec2(6.0, 8.0), 1.0);
  float gr = fbm(vec2(b.x / 6.0 + id.x, uv.y), vec2(36.0, 4.0), 3, 2.0);
  float lap = smoothstep(0.0, 0.12, 1.0 - b.y), gap = smoothstep(0.0, 0.04, min(b.x, 1.0 - b.x));
  vec3 c = uC1 * (0.65 + 0.55 * id.y) * (0.85 + 0.3 * gr) * mix(0.45, 1.0, b.y);
  s.col = mix(uC2, c, gap); s.h = mix(0.05, 0.15 + b.y * 0.75 + gr * 0.05, gap); s.r = 0.85; s.m = 0.0; s.ao = mix(0.3, 1.0, gap * smoothstep(0.0, 0.4, b.y));
}` });
def('rooftile', { color: 0xa0482c, tile: 1.6, bump: 18, use: 'clay roof tiles (barrel tiles), terracotta', glsl: `
void base(vec2 uv, inout Surf s){
  vec4 b = bond(uv, 6.0, 6.0, 0.0); vec3 id = hash3(b.zw, vec2(6.0), 1.0);
  float arch = sqrt(max(0.0, 1.0 - pow(abs(b.x - 0.5) * 2.0, 2.0))), lap = smoothstep(0.0, 0.18, b.y);
  float face = fbm(uv, vec2(40.0), 4, 2.0), moss = patches(uv, vec2(4.0), 0.75, 3.0);
  vec3 c = uC1 * (0.7 + 0.45 * id.x) * (0.85 + 0.25 * face) * mix(0.5, 1.0, arch * lap); c = mix(c, lin(0.3, 0.32, 0.18), moss * 0.5 * (1.0 - arch));
  s.col = c; s.h = arch * 0.7 * (0.4 + 0.6 * b.y) + face * 0.05; s.r = 0.85 - arch * 0.1; s.m = 0.0; s.ao = mix(0.35, 1.0, arch * lap);
}` });

// ----------------------------------------------------------------- ground and nature
def('grass', { color: 0x4f7a2e, color2: 0x8c8a3c, tile: 2.5, bump: 4, use: 'lawn and meadow ground (color2: dry blades)', glsl: `
void base(vec2 uv, inout Surf s){
  float big = fbm(uv, vec2(3.0), 5, 1.0), mid = fbm(uv, vec2(14.0), 4, 2.0);
  vec2 q = warp(uv, vec2(20.0), 0.01, 3.0); float bl = fbm(q, vec2(160.0, 40.0), 3, 4.0), bl2 = fbm(q, vec2(60.0, 220.0), 3, 5.0);
  float blade = max(smoothstep(0.55, 0.8, bl), smoothstep(0.55, 0.8, bl2)), dry = smoothstep(0.5, 0.8, fbm(uv, vec2(5.0), 4, 6.0));
  float soil = smoothstep(0.62, 0.4, mid + blade * 0.3) * 0.6;
  vec3 c = mix(uC1, uC2, dry * 0.7) * (0.6 + 0.45 * blade + 0.25 * (big - 0.5));
  c = mix(c, lin(0.25, 0.19, 0.12), soil * (1.0 - blade));
  s.col = c; s.h = 0.3 + blade * 0.55 + (mid - 0.5) * 0.15; s.r = 0.88 - blade * 0.1; s.m = 0.0; s.ao = 0.6 + 0.4 * blade;
}` });
def('dirt', { color: 0x6a4e35, tile: 2.5, bump: 6, use: 'bare earth: paths, fields, yards (add pebbles with p[0], 0..1)', p: [0.5, 0, 0, 0], glsl: `
void base(vec2 uv, inout Surf s){
  float big = fbm(uv, vec2(3.0), 5, 1.0), mid = fbm(uv, vec2(16.0), 4, 2.0), fine = fbm(uv, vec2(180.0), 2, 3.0);
  vec4 pb = cells(uv * 40.0, vec2(40.0), 4.0); float peb = step(pb.z, 0.35 * uP.x) * smoothstep(0.32, 0.18, pb.x);
  float clod = smoothstep(0.55, 0.75, fbm(uv, vec2(30.0), 3, 5.0));
  vec3 c = uC1 * (0.7 + 0.45 * big + 0.15 * (mid - 0.5) + 0.1 * (fine - 0.5)); c = mix(c, lin(0.5, 0.47, 0.42) * (0.7 + 0.5 * pb.w), peb);
  s.col = c * (1.0 + clod * 0.1); s.h = 0.4 + (mid - 0.5) * 0.3 + clod * 0.15 + peb * 0.3 + (fine - 0.5) * 0.1; s.r = 0.94 - peb * 0.15; s.m = 0.0; s.ao = 0.75 + 0.25 * s.h;
}` });
def('mud', { color: 0x5a4430, tile: 2.5, bump: 5, use: 'wet earth with puddles: farmyards, swamps, rainy paths', glsl: `
void base(vec2 uv, inout Surf s){
  float big = fbm(uv, vec2(3.0), 5, 1.0), mid = fbm(uv, vec2(14.0), 4, 2.0), fine = fbm(uv, vec2(120.0), 2, 3.0);
  float pud = smoothstep(0.58, 0.64, fbm(uv, vec2(3.0), 5, 4.0)), track = smoothstep(0.85, 0.95, ridged(uv, vec2(4.0, 2.0), 3, 5.0));
  s.col = uC1 * (0.7 + 0.45 * big + 0.15 * (mid - 0.5)) * (1.0 - pud * 0.35) * (1.0 - track * 0.2);
  s.h = mix(0.45 + (mid - 0.5) * 0.3 + (fine - 0.5) * 0.1 - track * 0.15, 0.3, pud); s.r = mix(0.6 + 0.2 * fine, 0.05, pud); s.m = 0.0; s.ao = 1.0 - track * 0.2;
}` });
def('sand', { color: 0xcdb486, tile: 3, bump: 4, use: 'beaches, deserts, dunes, sandpits', glsl: `
void base(vec2 uv, inout Surf s){
  vec2 q = warp(uv, vec2(3.0), 0.15, 1.0); float rip = 0.5 + 0.5 * sin((q.y * 22.0 + fbm(uv, vec2(4.0), 3, 2.0) * 3.0) * TAU);
  float big = fbm(uv, vec2(3.0), 4, 3.0), grain = fbm(uv, vec2(400.0), 2, 4.0), dark = step(0.97, hash1(floor(uv * 512.0), vec2(512.0), 5.0));
  s.col = uC1 * (0.85 + 0.2 * big + 0.08 * rip + 0.1 * (grain - 0.5)) * (1.0 - dark * 0.5); s.h = 0.4 + rip * 0.3 + grain * 0.1; s.r = 0.93; s.m = 0.0; s.ao = 0.85 + 0.15 * rip;
}` });
def('gravel', { color: 0x8b867d, color2: 0x4b4239, tile: 1.2, bump: 9, use: 'gravel drives, railway ballast, riverbeds', glsl: `
void base(vec2 uv, inout Surf s){
  vec4 a = cells(warp(uv, vec2(12.0), 0.01, 1.0) * 26.0, vec2(26.0), 2.0), b = cells(uv * 55.0, vec2(55.0), 3.0);
  float da = smoothstep(0.02, 0.22, a.y - a.x), db = smoothstep(0.02, 0.2, b.y - b.x) * step(b.z, 0.6);
  float face = fbm(uv, vec2(90.0), 3, 4.0), st = max(da, db * 0.8);
  vec3 c = uC1 * (0.6 + 0.6 * (da > db ? a.z : b.z)) * mix(vec3(1.0), vec3(1.1, 1.0, 0.88), a.w) * (0.85 + 0.3 * face);
  s.col = mix(uC2, c, st); s.h = max(sqrt(da) * 0.8, sqrt(db) * 0.55) + face * 0.05; s.r = 0.85; s.m = 0.0; s.ao = 0.35 + 0.65 * st;
}` });
def('rock', { color: 0x7f7a72, tile: 4, bump: 12, use: 'natural rock faces: cliffs, boulders, caves, mountains', glsl: `
void base(vec2 uv, inout Surf s){
  vec2 q = warp(uv, vec2(3.0), 0.12, 1.0); float big = fbm(q, vec2(3.0), 6, 2.0), mid = fbm(q, vec2(14.0), 4, 3.0), fine = fbm(uv, vec2(120.0), 3, 4.0);
  float strata = 0.5 + 0.5 * sin((q.y * 9.0 + big * 2.0) * TAU); vec4 cr = cells(q * 5.0, vec2(5.0), 5.0); float crack = smoothstep(0.05, 0.005, cr.y - cr.x);
  float lich = patches(uv, vec2(6.0), 0.74, 6.0) * smoothstep(0.4, 0.7, big);
  vec3 c = uC1 * (0.6 + 0.6 * big + 0.12 * (strata - 0.5) + 0.12 * (fine - 0.5)) * mix(vec3(1.0), vec3(1.08, 1.0, 0.9), cr.z) * (1.0 - crack * 0.5);
  c = mix(c, lin(0.62, 0.62, 0.5), lich * 0.4);
  s.col = c; s.h = 0.3 + big * 0.45 + mid * 0.2 + fine * 0.05 - crack * 0.3; s.r = 0.88 - 0.1 * fine; s.m = 0.0; s.ao = 0.6 + 0.4 * big - crack * 0.3;
}` });
def('snow', { color: 0xeef2f7, tile: 3, bump: 3, use: 'snow fields, snowy roofs, winter ground', glsl: `
void base(vec2 uv, inout Surf s){
  float big = fbm(uv, vec2(3.0), 5, 1.0), mid = fbm(uv, vec2(12.0), 4, 2.0), sp = step(0.985, hash1(floor(uv * 512.0), vec2(512.0), 3.0));
  s.col = uC1 * (0.9 + 0.1 * big) * mix(vec3(1.0), vec3(0.88, 0.92, 1.0), smoothstep(0.55, 0.3, mid) * 0.6) + sp * 0.2;
  s.h = 0.4 + big * 0.35 + mid * 0.25; s.r = 0.75 - sp * 0.5; s.m = 0.0; s.ao = 0.9 + 0.1 * mid;
}` });
def('ice', { color: 0xa9cce0, tile: 3, bump: 1.5, use: 'ice sheets, frozen lakes, glaciers, crystal caves', glsl: `
void base(vec2 uv, inout Surf s){
  vec4 cr = cells(warp(uv, vec2(5.0), 0.08, 1.0) * 5.0, vec2(5.0), 2.0); float crack = smoothstep(0.012, 0.002, cr.y - cr.x);
  float big = fbm(uv, vec2(3.0), 5, 3.0), bub = step(0.992, hash1(floor(uv * 256.0), vec2(256.0), 4.0)), frost = smoothstep(0.55, 0.8, fbm(uv, vec2(8.0), 4, 5.0));
  s.col = uC1 * (0.65 + 0.4 * big) + crack * 0.25 + bub * 0.2; s.col = mix(s.col, vec3(0.85), frost * 0.5);
  s.h = 0.5 - crack * 0.1; s.r = 0.08 + frost * 0.5 + crack * 0.2; s.m = 0.0; s.ao = 1.0;
}` });
def('moss', { color: 0x5d7f2c, tile: 1.5, bump: 6, use: 'moss carpets: forest floors, old stones, swamps', glsl: `
void base(vec2 uv, inout Surf s){
  vec4 v = cells(uv * 30.0, vec2(30.0), 1.0); float cush = sat(1.0 - v.x * 1.4), tuft = fbm(uv, vec2(160.0), 3, 2.0), big = fbm(uv, vec2(4.0), 4, 3.0);
  s.col = uC1 * (0.55 + 0.55 * cush * (0.6 + 0.4 * tuft)) * mix(vec3(1.0), vec3(1.15, 1.1, 0.7), big * 0.6);
  s.h = cush * 0.7 + tuft * 0.25; s.r = 0.95; s.m = 0.0; s.ao = 0.55 + 0.45 * cush;
}` });
def('forest', { color: 0x5a4027, tile: 2.5, bump: 6, use: 'forest floor: fallen leaves, needles, twigs over soil', glsl: `
void base(vec2 uv, inout Surf s){
  float soil = fbm(uv, vec2(8.0), 4, 1.0); vec3 c = lin(0.2, 0.14, 0.09) * (0.7 + 0.5 * soil); float h = 0.2 + soil * 0.1, ao = 0.6;
  for (int i = 0; i < 3; i++){
    float f = 18.0 + float(i) * 9.0; vec4 v = cells(uv * f, vec2(f), 10.0 + float(i) * 3.0);
    vec3 r = vec3(v.z, v.w, fract(v.z * 7.3));
    vec2 d = vec2(v.x, v.y - v.x); float leaf = smoothstep(0.42, 0.3, v.x) * step(0.3, r.y) * smoothstep(0.0, 0.08, d.y);
    vec3 lc = uC1 * mix(vec3(0.75, 0.55, 0.4), vec3(1.6, 1.0, 0.45), r.x) * (0.8 + 0.4 * r.z);
    c = mix(c, lc, leaf); h = mix(h, 0.4 + 0.15 * float(i) + v.x * 0.2, leaf); ao = mix(ao, 1.0, leaf);
  }
  float twig = scratches(uv, 6.0, 20.0, 0.01, 0.0, 6.28, 0.5); c = mix(c, lin(0.3, 0.22, 0.14), twig); h = max(h, twig * 0.8);
  s.col = c; s.h = h; s.r = 0.9; s.m = 0.0; s.ao = ao;
}` });
def('leaves', { color: 0x3f6b2a, tile: 1, bump: 3, cut: true, use: 'foliage cards with cut-out leaves: hedges, canopies, vines (alpha cut)', glsl: `
void base(vec2 uv, inout Surf s){
  float a = 0.0; vec3 c = uC1; float h = 0.0;
  for (int i = 0; i < 3; i++){
    float f = 7.0 + float(i) * 4.0; vec4 v = cells(warp(uv, vec2(8.0), 0.03, float(i)) * f, vec2(f), 30.0 + float(i));
    float leaf = smoothstep(0.5, 0.38, v.x) * step(0.15, v.w);
    vec3 lc = uC1 * (0.6 + 0.6 * v.z) * mix(vec3(1.0), vec3(1.2, 1.15, 0.6), v.w * 0.5);
    c = mix(c, lc, leaf * (1.0 - a * 0.5)); h = max(h, leaf * (0.5 + 0.5 * (1.0 - v.x))); a = max(a, leaf);
  }
  s.col = c; s.h = h; s.r = 0.7; s.m = 0.0; s.ao = 0.7 + 0.3 * h; s.a = a;
}` });
def('lava', { color: 0x1a1210, color2: 0xff6a1a, tile: 4, bump: 10, glow: true, use: 'cooling lava crust with glowing cracks (glows: color2)', glsl: `
void base(vec2 uv, inout Surf s){
  vec4 v = cells(warp(uv, vec2(4.0), 0.1, 1.0) * 6.0, vec2(6.0), 2.0); float e = v.y - v.x;
  float crack = smoothstep(0.12, 0.0, e), crust = fbm(uv, vec2(30.0), 4, 3.0);
  s.col = mix(uC1 * (0.6 + 0.8 * crust), uC2, crack); s.h = mix(0.5 + crust * 0.4, 0.05, crack); s.r = mix(0.9, 0.6, crack); s.m = 0.0; s.ao = 1.0;
}` });

/**
 * Adds a texture set of your own, painted by your GLSL: defineBase('hexfloor', { color: 0x777777, tile: 1, bump: 3,
 * glsl: `void base(vec2 uv, inout Surf s){ vec4 c = cells(uv * 8.0, vec2(8.0), 1.0); s.col = uC1 * (0.6 + 0.4 * c.z);
 * s.h = smoothstep(0.0, 0.1, c.y - c.x); s.r = 0.6; }` }). Then material({ base: 'hexfloor', rust: 0.3 }) uses it
 * with every weathering layer. The function gets uv 0..1 across one tile and fills s (see lib.js for the helpers:
 * fbm, ridged, cells, warp, scratches, chips, patches, bond, grout, lin). Whole-number frequencies keep it seamless.
 */
export function defineBase(name, { glsl, color = 0x888888, color2, tile = 2, bump = 2, cut = false, glow = false, p, use = 'your own texture set' } = {}) {
  if (!/void\s+base\s*\(/.test(glsl || '')) throw new Error('defineBase needs glsl with a function: void base(vec2 uv, inout Surf s){ … }');
  def(name, { glsl, color, color2, tile, bump, cut, glow, p, use }); if (!BASE_NAMES.includes(name)) BASE_NAMES.push(name); return B[name];
}

/** Every base texture set by name, with its default colours, tile size (metres) and what it is for. */
export const BASES = B;
/** The names of the base texture sets (concrete, brick, planks, metal, grass, …). */
export const BASE_NAMES = Object.keys(B);

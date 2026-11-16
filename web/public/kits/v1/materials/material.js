// @gcp/materials.js · material — realistic materials from a name or from plain data. The texture set is baked on the
// GPU the first time a material is asked for (bake.js), then the material is a MeshStandardMaterial with a small
// shader patch: large-scale variation in world space (so a tiling texture never shows its repeat), grime where things
// meet the ground, rain wetness and snow on whatever faces up, and box mapping for geometry without good UVs.
import * as THREE from 'three';
import { BASES } from './bases.js';
import { bakeTextures, privateRenderer, readTextures } from './bake.js';
import { currentStage } from '../craft/stage.js';
import { defineRecipe } from '../procgen/recipe.js';

const P = (base, o = {}) => ({ base, ...o });
const paint = (color, o = {}) => P('metal', { paint: color, chips: 0.35, scratches: 0.4, wear: 0.3, dirt: 0.25, ...o });
const M = {
  // masonry and ground works
  concrete: P('concrete'), concrete_dirty: P('concrete', { dirt: 0.6, leaks: 0.5 }), concrete_mossy: P('concrete', { moss: 0.45, dirt: 0.3 }),
  asphalt: P('asphalt'), brick: P('brick'), brick_old: P('brick', { color: 0x7a3e2c, dirt: 0.5, moss: 0.2, leaks: 0.4 }), brick_painted: P('brick', { paint: 0xd8d2c4, chips: 0.6, color2: 0xd8d2c4 }),
  stone_wall: P('stonewall'), stone_wall_mossy: P('stonewall', { moss: 0.55, dirt: 0.3 }), cobblestone: P('cobble'), floor_tiles: P('tiles'), wall_tiles: P('tiles', { color: 0xe8e6df, p: [6, 0, 0, 0] }),
  plaster: P('plaster'), plaster_old: P('plaster', { dirt: 0.5, leaks: 0.5 }), adobe: P('plaster', { color: 0xc49a6c }), marble: P('marble'),
  // metal
  steel: P('metal'), steel_rusty: P('metal', { rust: 0.6, dirt: 0.3 }), rust: P('rust'), galvanized: P('galvanized'), aluminium: P('brushed'), stainless: P('brushed', { color: 0xc8cbcf }),
  brass: P('brushed', { color: 0xc9a55a }), copper: P('brushed', { color: 0xc07a52 }), gold: P('brushed', { color: 0xe8c068, gloss: 0.2 }), iron_dark: P('metal', { color: 0x3c3f44 }),
  corrugated: P('corrugated'), corrugated_rusty: P('corrugated', { rust: 0.55 }), diamond_plate: P('diamondplate'), hull: P('panels'), scifi_panels: P('panels', { color: 0xb8bec6, p: [3, 3, 0, 0] }),
  paint_red: paint(0x9b2a22), paint_blue: paint(0x22457a), paint_green: paint(0x2f5a3a), paint_yellow: paint(0xc9961c), paint_orange: paint(0xc0561c), paint_white: paint(0xd8d4c8), paint_grey: paint(0x5a5e62), paint_black: paint(0x1c1d1f),
  // made things
  plastic_red: P('plastic', { color: 0xa82820 }), plastic_blue: P('plastic', { color: 0x1f4f9a }), plastic_white: P('plastic', { color: 0xdedbd2 }), plastic_black: P('plastic', { color: 0x1a1a1c }),
  rubber: P('rubber'), fabric: P('fabric'), fabric_red: P('fabric', { color: 0x8a2a22 }), canvas: P('tarp', { color: 0xb8a988 }), tarp_green: P('tarp'), tarp_blue: P('tarp', { color: 0x2a4f80 }),
  leather: P('leather'), cardboard: P('cardboard'),
  // wood
  planks: P('planks'), planks_old: P('planks', { color: 0x7d6a55, dirt: 0.4, moss: 0.15 }), planks_painted: P('planks', { paint: 0xd6d0c2, chips: 0.5, gloss: 0.6 }), floorboards: P('planks', { color: 0x9a6c40, p: [10, 0, 0, 0], wear: 0.4 }),
  wood: P('wood'), wood_dark: P('wood', { color: 0x4a3322 }), wood_light: P('wood', { color: 0xb08a5c }), bark: P('bark'), log_end: P('endgrain'),
  thatch: P('thatch'), shingles: P('shingles'), slate: P('shingles', { color: 0x4c5056, color2: 0x1c1d1f }), roof_tiles: P('rooftile'),
  // ground and nature
  grass: P('grass'), grass_dry: P('grass', { color: 0x7d7a36, color2: 0xa89a5a }), dirt: P('dirt'), mud: P('mud'), sand: P('sand'), gravel: P('gravel'), rock: P('rock'), rock_mossy: P('rock', { moss: 0.5 }),
  snow: P('snow'), ice: P('ice'), moss: P('moss'), forest_floor: P('forest'), leaves: P('leaves'), lava: P('lava'),
};
/** Every named material: material('steel_rusty'), material('planks_old'), … Each is a recipe you can also extend. */
export const MATERIALS = M;
/** The names material() knows. */
export const MATERIAL_NAMES = Object.keys(M);

const nameSeed = (n) => { let h = 2166136261; for (let i = 0; i < n.length; i++) h = Math.imul(h ^ n.charCodeAt(i), 16777619); return (h >>> 0) % 997; };
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const colorOf = (c, d) => { if (c == null) return d; try { return new THREE.Color(c).getHex(); } catch { return d; } };
/**
 * A recipe with every field filled in and checked. Accepts a name ('steel_rusty'), a name with changes
 * ({ name: 'planks', color: '#a07040' }) or a full recipe ({ base: 'metal', paint: '#b8322a', chips: 0.5, rust: 0.3 }).
 */
export function resolveRecipe(r) {
  if (typeof r === 'string') { if (!M[r] && !BASES[r]) throw new Error(`Unknown material "${r}". Names: ${MATERIAL_NAMES.join(', ')}. Bases: ${Object.keys(BASES).join(', ')}.`); r = { seed: nameSeed(r), ...(M[r] || { base: r }) }; }
  else if (r && r.name && M[r.name]) r = { seed: nameSeed(r.name), ...M[r.name], ...r };
  if (!r || !BASES[r.base]) throw new Error(`A material recipe needs base: one of ${Object.keys(BASES).join(', ')} (got ${r && r.base}).`);
  const b = BASES[r.base], p = Array.isArray(r.p) ? r.p : b.p || [0, 0, 0, 0];
  const pt = typeof r.paint === 'object' && r.paint ? r.paint : null;
  return {
    base: r.base, seed: Math.abs(Math.round(num(r.seed, 1))), color: colorOf(r.color, b.color), color2: colorOf(r.color2, b.color2 ?? b.color),
    p: [0, 1, 2, 3].map((i) => num(p[i], 0)), paint: pt ? colorOf(pt.color, null) : colorOf(r.paint, null),
    chips: clamp01(num(pt && pt.chips, num(r.chips, 0.3))), scratches: clamp01(num(pt && pt.scratches, num(r.scratches, 0.3))), gloss: Math.max(0.05, Math.min(1, num(pt && pt.roughness, num(r.gloss, 0.45)))),
    wear: clamp01(num(r.wear, 0)), dirt: clamp01(num(r.dirt, 0)), rust: clamp01(num(r.rust, 0)), moss: clamp01(num(r.moss, 0)), leaks: clamp01(num(r.leaks, 0)), dust: clamp01(num(r.dust, 0)),
    bump: r.bump != null ? num(r.bump, b.bump) : undefined,
  };
}
const bakeKey = (s, size) => JSON.stringify([s.base, s.seed, s.color, s.color2, s.p, s.paint, s.chips, s.scratches, s.gloss, s.wear, s.dirt, s.rust, s.moss, s.leaks, s.dust, s.bump, size]);

// ---- the shader patch shared by every material ----
/** Rain and snow on every material at once: set .wet.value and .snow.value (0..1), or call followWeather(stage). */
export const SURFACE_WEATHER = { wet: { value: 0 }, snow: { value: 0 } };
const VERT_HEAD = /* glsl */ `
varying vec3 vMatW; varying vec3 vMatO; varying vec3 vMatON; varying mat3 vMatToView;`;
const VERT_BODY = /* glsl */ `
{ vec4 mw = vec4(transformed, 1.0); mat3 ov = mat3(modelViewMatrix);
  #ifdef USE_INSTANCING
    mw = instanceMatrix * mw; ov = ov * mat3(instanceMatrix);
  #endif
  vMatW = (modelMatrix * mw).xyz; vMatO = position; vMatON = normal; vMatToView = ov; }`;
const FRAG_HEAD = /* glsl */ `
uniform vec2 uMatRep; uniform vec4 uMatVar; uniform vec2 uMatSnow; uniform float uMatWet; uniform float uMatSnowG; uniform float uMatNoEnv;
varying vec3 vMatW; varying vec3 vMatO; varying vec3 vMatON; varying mat3 vMatToView;
vec4 matORM; vec2 matUv; float matWet = 0.0; float matSnow = 0.0; vec3 matTw; vec2 matUx; vec2 matUy; vec2 matUz;
float matH(vec3 p){ p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float matN(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(matH(i), matH(i + vec3(1, 0, 0)), f.x), mix(matH(i + vec3(0, 1, 0)), matH(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(matH(i + vec3(0, 0, 1)), matH(i + vec3(1, 0, 1)), f.x), mix(matH(i + vec3(0, 1, 1)), matH(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
vec2 matUv2; float matB = 0.0;
const mat2 matR = mat2(0.8, 0.6, -0.6, 0.8);
vec4 matTex(sampler2D t){
  #ifdef MAT_BOX
    return texture2D(t, matUx) * matTw.x + texture2D(t, matUy) * matTw.y + texture2D(t, matUz) * matTw.z;
  #elif defined( MAT_NOREPEAT )
    return mix(texture2D(t, matUv), texture2D(t, matUv2), matB);
  #else
    return texture2D(t, matUv);
  #endif
}`;
const FRAG_MAP = /* glsl */ `
#ifdef MAT_BOX
  { vec3 on = normalize(vMatON); vec3 w3 = pow(abs(on), vec3(6.0)); matTw = w3 / (w3.x + w3.y + w3.z);
    vec3 q = vMatO * uMatRep.x; matUx = q.zy; matUy = q.xz; matUz = q.xy; }
#else
  matUv = vMapUv * uMatRep;
  #ifdef MAT_NOREPEAT
    matUv2 = matR * matUv * 0.73 + vec2(0.371, 0.113);
    matB = smoothstep(0.3, 0.7, matN(vMatW * 0.21 + 3.1) * 0.7 + matN(vMatW * 0.77) * 0.3);
  #endif
#endif
vec4 sampledDiffuseColor = matTex(map); matORM = matTex(roughnessMap);
{ vec3 wn = inverseTransformDirection(normalize(vNormal), viewMatrix);
  float n1 = matN(vMatW * uMatVar.z), n2 = matN(vMatW * uMatVar.z * 3.7 + 11.3), mv = n1 * 0.65 + n2 * 0.35 - 0.5;
  sampledDiffuseColor.rgb *= 1.0 + uMatVar.x * mv * 2.0;
  float low = smoothstep(0.6, 0.0, vMatW.y - uMatVar.w) * (1.0 - smoothstep(0.3, 0.9, wn.y)) * step(-100.0, uMatVar.w);
  sampledDiffuseColor.rgb *= 1.0 - low * 0.3;
  float up = smoothstep(0.25, 0.85, wn.y), cover = max(uMatSnow.x, uMatSnowG) * uMatSnow.y;
  matSnow = cover > 0.0 ? smoothstep(0.35, 0.6, up * (0.6 + 0.6 * cover) + (n2 - 0.5) * 0.5 + (matORM.r - 0.8) * 0.4 - (1.0 - cover) * 0.5) : 0.0;
  matWet = uMatWet * smoothstep(-0.4, 0.0, wn.y) * mix(0.55 + 0.4 * n1, 1.0, up);
}
#ifdef MAT_NOENV
  sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb, sampledDiffuseColor.rgb * 1.25 + 0.03, matORM.b * 0.8);
#endif
diffuseColor *= sampledDiffuseColor;
{ float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)); diffuseColor.rgb = mix(vec3(l), diffuseColor.rgb, 1.0 + 0.2 * matWet) * (1.0 - 0.38 * matWet); }
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.89, 0.93), matSnow);`;
const FRAG_ROUGH = /* glsl */ `
float roughnessFactor = roughness * matORM.g + uMatVar.y * (matN(vMatW * uMatVar.z * 2.3 + 4.1) - 0.5);
roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.3, matWet); roughnessFactor = mix(roughnessFactor, 0.7, matSnow);
roughnessFactor = clamp(roughnessFactor, 0.045, 1.0);`;
const FRAG_METAL = /* glsl */ `
float metalnessFactor = metalness * matORM.b * (1.0 - matSnow);
#ifdef MAT_NOENV
  metalnessFactor *= 0.35;
#endif`;
const FRAG_NORMAL = /* glsl */ `
#ifdef MAT_BOX
  { vec3 on = normalize(vMatON);
    vec3 tx = texture2D(normalMap, matUx).xyz * 2.0 - 1.0, ty = texture2D(normalMap, matUy).xyz * 2.0 - 1.0, tz = texture2D(normalMap, matUz).xyz * 2.0 - 1.0;
    tx.xy *= normalScale; ty.xy *= normalScale; tz.xy *= normalScale;
    tx = vec3(tx.xy + on.zy, abs(tx.z) * on.x); ty = vec3(ty.xy + on.xz, abs(ty.z) * on.y); tz = vec3(tz.xy + on.xy, abs(tz.z) * on.z);
    vec3 no = normalize(tx.zyx * matTw.x + ty.xzy * matTw.y + tz.xyz * matTw.z);
    no = mix(no, on, matSnow * 0.8);
    normal = normalize(vMatToView * no);
    #ifdef DOUBLE_SIDED
      normal *= faceDirection;
    #endif
  }
#else
  { vec3 mapN = texture2D(normalMap, matUv).xyz * 2.0 - 1.0;
    #ifdef MAT_NOREPEAT
      vec3 mapN2 = texture2D(normalMap, matUv2).xyz * 2.0 - 1.0; mapN2.xy = transpose(matR) * mapN2.xy; mapN = mix(mapN, mapN2, matB);
    #endif
    mapN.xy *= normalScale * (1.0 - 0.8 * matSnow) * (1.0 - 0.3 * matWet);
    normal = normalize(tbn * mapN); }
#endif`;
function patch(m, uniforms, box) {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + VERT_HEAD).replace('#include <project_vertex>', '#include <project_vertex>' + VERT_BODY);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + FRAG_HEAD).replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH).replace('#include <metalnessmap_fragment>', FRAG_METAL).replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <aomap_fragment>', AO);
  };
  m.customProgramCacheKey = () => 'gcp-mat' + (box ? '-box' : '') + (m.defines && m.defines.MAT_NOENV ? '-ne' : '') + (m.defines && m.defines.MAT_NOREPEAT ? '-nr' : '');
}
// ambient occlusion from the ORM texture's red channel (three.js would sample it again with its own UVs)
const AO = /* glsl */ `
{ float ambientOcclusion = (matORM.r - 1.0) * aoMapIntensity + 1.0;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
}`;

const SETS = new Map(), MATS = new Map();
// bases that cover large areas: these hide their repeat by blending a second, turned copy of the texture
const GROUND = new Set(['concrete', 'asphalt', 'grass', 'dirt', 'mud', 'sand', 'gravel', 'rock', 'snow', 'ice', 'moss', 'forest', 'cobble', 'plaster', 'lava']);
const sizeFor = (st, size) => size || (st && st.software ? 256 : st && st.quality === 'low' ? 256 : st && st.quality === 'high' ? 1024 : 512);
let OWN = null, warned = false;
/**
 * Without craft's createStage: name the THREE.WebGLRenderer that draws your scene, once, before the first material()
 * or model(). Textures are painted on that renderer's GPU and can only be drawn by it; with createStage nothing is needed.
 * Example: const renderer = new THREE.WebGLRenderer(); useRenderer(renderer);
 */
export function useRenderer(renderer) { OWN = renderer || null; }
function rendererFor(opts, drawn) {
  const st = opts.stage || currentStage(), r = opts.renderer || (st && st.renderer) || OWN;
  if (!r && drawn && !warned) { warned = true; console.warn('@gcp/materials.js: no renderer known, so textures are painted on a private one and draw black in your scene. Call useRenderer(renderer) first, or use createStage from @gcp/craft.js.'); }
  return r || privateRenderer();
}

/** The baked textures of a recipe (cached): { albedo, orm, normal, tile, size }. For your own materials or shaders. */
export function materialTextures(recipe, opts = {}) {
  const spec = resolveRecipe(recipe), st = opts.stage || currentStage(), renderer = rendererFor(opts, true), size = sizeFor(st, opts.size), key = bakeKey(spec, size);
  let set = SETS.get(key);
  if (!set || set.renderer !== renderer) { set = { ...bakeTextures(renderer, spec, size), renderer, spec }; SETS.set(key, set); }
  return set;
}

/**
 * A realistic material in one call: a name, or a recipe as plain data. The textures are painted on the GPU the first
 * time (a few milliseconds; cached after), then it is an ordinary MeshStandardMaterial.
 *   material('steel_rusty')     material('planks_old')     material('brick', { color: '#7a3e2c' })
 *   material({ base: 'metal', paint: '#b8322a', chips: 0.6, rust: 0.3, dirt: 0.4 })
 * Recipe fields: base (one of BASES: concrete, asphalt, brick, stonewall, cobble, tiles, plaster, marble, metal, brushed,
 * galvanized, corrugated, diamondplate, panels, rust, plastic, rubber, fabric, leather, tarp, cardboard, planks, wood,
 * bark, endgrain, thatch, shingles, rooftile, grass, dirt, mud, sand, gravel, rock, snow, ice, moss, forest, leaves, lava),
 * color, color2 (mortar, grout, gaps, veins), seed, p ([4 numbers] some bases read: planks [boards], tiles [count],
 * panels [x, y]), and weathering 0..1: paint (a colour painted over the base) with chips, scratches and gloss
 * (the paint's roughness), wear (rubbed high spots), dirt, rust, moss, leaks (dark streaks running down), dust.
 * Options (not part of the look): scale (texture size multiplier: 2 = twice as big), mapping ('uv' default: the
 * geometry's UVs are metres, as everything from parts() and the tbox/tplane primitives has; 'box': projected on
 * the object's own axes, right for any geometry, e.g. a plain THREE.BoxGeometry or a sculpted rock), variation
 * (0..1 large-scale patchiness in world space, default 0.12; 0.18 for ground), noRepeat (blend a turned second copy so
 * a big floor never shows its tile; on by default for ground bases), grime (true: darker near ground level y = 0), snow
 * (0..1 snow on its upper faces), side, size (texture pixels; default by stage quality), stage, renderer.
 */
export function material(recipe, opts = {}) {
  const set = materialTextures(recipe, opts), spec = set.spec, b = BASES[spec.base], st = opts.stage || currentStage();
  const box = opts.mapping === 'box', scale = num(opts.scale, 1), variation = num(opts.variation, GROUND.has(spec.base) ? 0.18 : 0.12), noEnv = !!(st && st.software) || opts.environment === false;
  const key = [bakeKey(spec, set.size), box, scale, variation, opts.noRepeat ?? '', opts.grime ?? null, opts.snow ?? 0, opts.side ?? 0, noEnv, opts.opacity ?? 1].join('|');
  let m = MATS.get(key);
  if (m) return m;
  const cut = !!b.cut, glow = !!b.glow;
  m = new THREE.MeshStandardMaterial({
    map: set.albedo, roughnessMap: set.orm, metalnessMap: set.orm, aoMap: set.orm, normalMap: set.normal, normalScale: new THREE.Vector2(1, 1),
    roughness: 1, metalness: 1, side: opts.side ?? (cut ? THREE.DoubleSide : THREE.FrontSide), alphaTest: cut ? 0.5 : 0,
    transparent: (opts.opacity ?? 1) < 1, opacity: opts.opacity ?? 1,
  });
  if (glow) { m.emissive = new THREE.Color(spec.color2); m.emissiveMap = set.albedo; m.emissiveIntensity = 1.6; }
  const noRepeat = !box && (opts.noRepeat ?? GROUND.has(spec.base));
  m.defines = {}; if (noEnv) m.defines.MAT_NOENV = 1; if (noRepeat) m.defines.MAT_NOREPEAT = 1;
  const tile = set.tile.map((t) => t * scale);
  const uniforms = {
    uMatRep: { value: new THREE.Vector2(1 / tile[0], 1 / tile[1]) },
    uMatVar: { value: new THREE.Vector4(variation, variation * 0.4, 0.09, opts.grime === false ? -1000 : opts.grime === true || opts.grime == null ? 0 : num(opts.grime, 0)) },
    uMatSnow: { value: new THREE.Vector2(clamp01(num(opts.snow, 0)), 1) }, uMatWet: SURFACE_WEATHER.wet, uMatSnowG: SURFACE_WEATHER.snow, uMatNoEnv: { value: noEnv ? 1 : 0 },
  };
  if (opts.grime == null) uniforms.uMatVar.value.w = -1000;   // off unless asked for
  patch(m, uniforms, box);
  m.name = 'material:' + (typeof recipe === 'string' ? recipe : spec.base); m.userData.shared = true; m.userData.recipe = spec; m.userData.uniforms = uniforms;
  MATS.set(key, m); return m;
}

/**
 * Makes rain wet and snow settle on every material of this kit as the stage's weather changes: 'rain' wets them over
 * a few seconds and they dry when it stops, 'snow' covers their upper faces. Call once after createStage.
 */
export function followWeather(stage = currentStage()) {
  if (!stage || stage._matWeather) return; stage._matWeather = true;
  let kind = null; const set = stage.setWeather.bind(stage);
  stage.setWeather = (k) => { kind = k; return set(k); };
  stage.onUpdate((dt) => {
    const w = SURFACE_WEATHER, tw = kind === 'rain' ? 1 : 0, ts = kind === 'snow' ? 0.85 : 0;
    w.wet.value += (tw - w.wet.value) * Math.min(1, dt * (tw > w.wet.value ? 0.4 : 0.08));
    w.snow.value += (ts - w.snow.value) * Math.min(1, dt * (ts > w.snow.value ? 0.05 : 0.03));
  });
}

/**
 * A material's texture as a canvas, for 2D and 2.5D games (ground tiles, walls, floors drawn with drawImage or as a
 * pattern) and for CSS. The canvas tiles seamlessly. channel: 'lit' (default: the colour shaded by its own relief,
 * light from the upper left), 'albedo', 'normal' or 'orm'. size: pixels (default 256).
 *   const grass = textureCanvas('grass');  ctx.fillStyle = ctx.createPattern(grass, 'repeat');
 */
export function textureCanvas(recipe, { channel = 'lit', size = 256, renderer } = {}) {
  const r = renderer || privateRenderer(), spec = resolveRecipe(recipe), set = bakeTextures(r, spec, size), px = readTextures(r, set);
  for (const t of set.targets) t.dispose();
  const c = document.createElement('canvas'); c.width = c.height = size;
  c.getContext('2d').putImageData(new ImageData(px[channel] || px.lit, size, size), 0, 0);
  return c;
}

/** Frees every cached texture set and material (after a level change, for example). */
export function clearMaterials() { for (const s of SETS.values()) for (const t of s.targets) t.dispose(); SETS.clear(); for (const m of MATS.values()) m.dispose(); MATS.clear(); }

defineRecipe('material', { summary: 'A realistic material baked on the GPU: a named one, or a base with weathering layers.', params: { name: 'one of MATERIAL_NAMES (or leave empty and give base)', base: 'one of BASES', color: 'main colour', color2: 'second colour', paint: 'a colour painted over the base', chips: '0..1', rust: '0..1', dirt: '0..1', moss: '0..1', wear: '0..1', leaks: '0..1', dust: '0..1' },
  make: (p) => { const r = { ...p }; delete r.kind; delete r.v; if (!r.name && !r.base) r.name = 'planks'; if (r.name && !r.base && !MATERIALS[r.name]) r.base = r.name; return material(r.name && MATERIALS[r.name] && Object.keys(r).length <= 2 ? r.name : r); } });

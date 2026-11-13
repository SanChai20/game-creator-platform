// @gcp/procgen.js · recipe — an asset as data: { kind, seed, ...parameters }. A recipe is a few bytes of JSON
// that always builds the same model or texture, so a world can be saved, shared, sent to other players or
// regenerated at another quality without storing a single mesh.
//   const oak = build({ kind: 'tree', species: 'oak', seed: 'grove-3', size: 1.2 });
//   const wall = build({ kind: 'surface', surface: 'brick', color: 0x8a3b2a });
//   variants({ kind: 'rock', seed: 1 }, 5).map(build)      five different rocks from one recipe
// Results are cached by the recipe's contents: building the same recipe twice costs nothing.
// Each kind has a version. A recipe remembers the version it was written for (v), so a later, better generator
// never silently changes a world that was made from a seed.
import { toSeed, mixSeed, noise, ALGO } from './noise.js';
import { paint } from './texture.js';

const KINDS = new Map(), CACHE = new Map();

/**
 * Registers a recipe kind. make(params, recipe) builds the asset. `params` documents the options as
 * { name: 'what it does' } and is what recipeKinds() and the tools list.
 */
export function defineRecipe(kind, { v = 1, make, params = {}, summary = '', cache = true }) {
  const k = KINDS.get(kind) || { kind, versions: {}, latest: 0 };
  k.versions[v] = make; k.latest = Math.max(k.latest, v); k.params = params; k.summary = summary; k.cache = cache; KINDS.set(kind, k);
}
/** Canonical text of a recipe (keys sorted), used as its cache key and fine to store or send. */
export function recipeKey(recipe) {
  const walk = (o) => (Array.isArray(o) ? '[' + o.map(walk).join(',') + ']' : o && typeof o === 'object' ? '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + walk(o[k])).join(',') + '}' : JSON.stringify(o));
  return walk(recipe);
}
/** Builds (or returns the cached) asset for a recipe. Throws a readable error for an unknown kind or version. */
export function build(recipe) {
  if (typeof recipe === 'string') recipe = JSON.parse(recipe);
  const k = KINDS.get(recipe.kind); if (!k) throw new Error(`Unknown recipe kind "${recipe.kind}". Known kinds: ${[...KINDS.keys()].join(', ')}.`);
  const v = recipe.v ?? k.latest, make = k.versions[v]; if (!make) throw new Error(`Recipe kind "${recipe.kind}" has no version ${v} (available: ${Object.keys(k.versions).join(', ')}).`);
  const full = { ...recipe, v }, key = recipeKey(full);
  if (k.cache && CACHE.has(key)) return CACHE.get(key);
  const out = make(full, full); if (out && typeof out === 'object') { try { out.recipe = full; } catch { /* frozen */ } }
  if (k.cache) CACHE.set(key, out); return out;
}
/** A recipe stamped with the current version of its kind: store this, and it will rebuild identically later. */
export function recipe(kind, params = {}) { const k = KINDS.get(kind); if (!k) throw new Error(`Unknown recipe kind "${kind}". Known kinds: ${[...KINDS.keys()].join(', ')}.`); return { kind, v: k.latest, seed: 1, ...params }; }
/** n recipes that differ only by seed: individuals of one species, a set of rocks, a street of houses. */
export function variants(base, n = 3) { const s = toSeed(base.seed ?? 1); return Array.from({ length: n }, (_, i) => ({ ...base, seed: i === 0 ? base.seed ?? 1 : mixSeed(s, i) })); }
/** Every registered kind with its version, summary and parameters. */
export function recipeKinds() { return [...KINDS.values()].map((k) => ({ kind: k.kind, v: k.latest, summary: k.summary, params: k.params })); }
/** Forgets cached assets (after disposing them yourself). */
export function clearRecipeCache() { CACHE.clear(); }

defineRecipe('texture', { v: ALGO.value, summary: 'A painted, tiling texture as a Raster (pixels + height).', params: { texture: 'one of TEXTURES', seed: 'pattern', color: 'base colour', color2: 'second colour', scale: '1..4 pattern repeats', contrast: '1 = as designed', size: 'pixels, power of two' }, make: (p) => paint(p.texture, p) });
defineRecipe('noise', { v: ALGO.fractal, summary: 'A noise field: fn(x, y), fn.fill(), fn.glsl().', params: { type: 'fbm | ridged | warp | value | gradient | vfbm', seed: 'seed', scale: 'size of the largest feature', octaves: 'layers of detail', lacunarity: 'frequency step per octave', gain: 'amplitude step per octave', period: 'tile after this many scales' }, make: (p) => noise(p) });

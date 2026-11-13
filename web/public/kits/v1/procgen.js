// @gcp/procgen.js — procedural generation: everything a game needs to make its own geometry and textures from
// a seed, with nothing to download. Four layers, each usable alone:
//   noise    seeded random streams, integer hashes, value / gradient / simplex / cellular noise, fractals
//   glsl     the same hashes and noise for shaders (CPU and GPU agree)
//   mesh     tiled-UV primitives, part merging with vertex colours, welded noise displacement, normals, LOD
//   texture  a deterministic per-pixel painter with 39 materials, height -> normal maps, mips
// and recipes: an asset stored as { kind, seed, ...parameters } that always rebuilds the same.
// Higher-level, ready-made things (trees, rocks, terrain, buildings, characters) are in @gcp/craft.js.
export * from './procgen/noise.js';
export * from './procgen/glsl.js';
export * from './procgen/texture.js';
export * from './procgen/mesh.js';
export * from './procgen/recipe.js';

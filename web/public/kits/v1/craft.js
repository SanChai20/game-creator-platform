// @gcp/craft.js — finished-looking games from small calls. Everything is generated in code from options and a
// seed (see @gcp/procgen.js for the layer underneath), so there is nothing to download and nothing to model.
//   stage     createStage: renderer, sky, sun, fog, tone mapping, weather, wind, day cycle, moods
//   surfaces  surface(kind): 39 painted, tiling materials; block(), floor()
//   nature    terrain, water, tree, rock, bush, groundCover, grassField, scatter, place
//   props     prop(kind): 47 buildings, furniture, stairs, lights, pickups and machines
//   actors    humanoid, animal, control (movement + camera), wander
//   fx        createFx: particles, rings, floating text, pop
//   hud       createHud: counters, bars, timer, objective, hints, start and end screens
//   sound     createSound: effects, ambience, generative music
//   play      inventory, crafting, needs, a day clock, harvest nodes, building, quests, saving, and their panels
// A complete small game is: createStage, terrain, scatter some kinds, place a few props, humanoid + control,
// createHud, createSound, and your rules.
export * from './craft/stage.js';
export * from './craft/surfaces.js';
export * from './craft/nature.js';
export * from './craft/props.js';
export * from './craft/actors.js';
export * from './craft/fx.js';
export { createHud } from './hud.js';
export { createSound, SOUNDS, AMBIENCES, MUSIC } from './sound.js';
export { createInput } from './input.js';
export { run, createLoop, createBoot, clamp, lerp, smoothstep, TAU, store } from './core.js';
export { rng, mulberry32, strSeed, toSeed, mixSeed, noise, Simplex } from './procgen/noise.js';
export { build, recipe, variants, recipeKinds, defineRecipe } from './procgen/recipe.js';
export { M4, mergeParts, lumpy, displace, tbox, tplane, tcylinder, tprism, simplify, lodMesh, countTriangles } from './procgen/mesh.js';
export { paint, Raster, TEXTURES, defineTexture } from './procgen/texture.js';
export * from './play.js';

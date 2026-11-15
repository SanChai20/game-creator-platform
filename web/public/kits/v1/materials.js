// @gcp/materials.js — realistic, procedurally generated materials and models, made in the browser with nothing to
// download. An opt-in layer beside @gcp/craft.js: craft keeps its painted low-poly look, this kit gives the PBR one.
//   material('steel_rusty')                                   a named material (MATERIAL_NAMES)
//   material({ base: 'metal', paint: '#b8322a', chips: 0.5 }) a material as data: a base set plus weathering layers
//   parts() … .build()                                        models from bevelled boxes, tubes, bars, lathes, labels
//   model('crate')                                            ready props made that way (MODELS); place() and scatter() take them
//   textureCanvas('cobblestone')                              the same textures for a 2D canvas
// Textures are painted on the GPU from short GLSL functions over a tileable noise library (lib.js); a shader of your
// own can be registered with defineBase(name, { glsl }) and then used by name like any other.
export * from './materials/bases.js';
export * from './materials/bake.js';
export * from './materials/material.js';
export * from './materials/parts.js';
export * from './materials/models.js';

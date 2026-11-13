// Builds the building-block catalog the MCP tools serve (web/public/kits/blocks.json): every exported function of the
// craft and procedural-generation modules with its signature and its doc comment, taken from the source so the
// catalog can never drift from the code, plus the valid values of every "kind" argument, read from the live modules.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const GROUPS = [
  { id: 'stage', title: 'Stage: renderer, sky, sun, fog, shadows, weather, the frame loop', files: ['craft/stage.js'], from: '@gcp/craft.js' },
  { id: 'surfaces', title: 'Surfaces: painted textures and ready materials', files: ['craft/surfaces.js'], from: '@gcp/craft.js' },
  { id: 'nature', title: 'Nature: terrain, water, trees, rocks, bushes, ground cover, grass, scattering', files: ['craft/nature.js'], from: '@gcp/craft.js' },
  { id: 'props', title: 'Props: buildings, furniture, lights, pickups', files: ['craft/props.js'], from: '@gcp/craft.js' },
  { id: 'actors', title: 'Actors: animated people and animals, player control, wandering', files: ['craft/actors.js'], from: '@gcp/craft.js' },
  { id: 'world2d', title: '2D and 2.5D worlds: painted top-down land, sprites, animated people and animals, darkness with lights, weather (plain canvas)', files: ['craft2d.js'], from: '@gcp/craft2d.js' },
  { id: 'fx', title: 'Effects: particles, bursts, floating text', files: ['craft/fx.js'], from: '@gcp/craft.js' },
  { id: 'hud', title: 'HUD: counters, bars, timer, objective, title and end screens (plain DOM, any engine)', files: ['hud.js'], from: '@gcp/craft.js' },
  { id: 'sound', title: 'Sound: synthesised effects, ambience and music with no audio files (any engine)', files: ['sound.js'], from: '@gcp/craft.js' },
  { id: 'basics', title: 'Basics: boot screen + loop in one call, input for keyboard, pointer and touch, safe storage, math', files: ['core.js', 'input.js'], from: '@gcp/craft.js' },
  { id: 'noise', title: 'Procedural core 1: seeded random numbers, hashes and noise (pure JS, any engine)', files: ['procgen/noise.js'], from: '@gcp/procgen.js' },
  { id: 'gpu-noise', title: 'Procedural core 2: the same noise in shaders, bit-identical to the JS', files: ['procgen/glsl.js'], from: '@gcp/procgen.js' },
  { id: 'mesh', title: 'Procedural core 3: mesh builder (tiled UVs, merged parts, displacement, welding, LOD)', files: ['procgen/mesh.js'], from: '@gcp/procgen.js' },
  { id: 'texture', title: 'Procedural core 4: texture painter (rasterizer, generators, normal maps, mips)', files: ['procgen/texture.js'], from: '@gcp/procgen.js' },
  { id: 'recipe', title: 'Recipes: seed + parameters as plain data, built on demand and cached', files: ['procgen/recipe.js'], from: '@gcp/procgen.js' },
];

const clean = (doc) => doc.replace(/^\s*\/\*\*+/, '').replace(/\*+\/\s*$/, '').split('\n').map((l) => l.replace(/^\s*\* ?/, '').trimEnd()).join('\n').trim();

function parse(src) {
  const out = [], re = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/[ \t]*\n[ \t]*export\s+(async\s+)?(function\*?|const|class|let)\s+([A-Za-z0-9_$]+)\s*([^\n]*)/g;
  let m;
  while ((m = re.exec(src))) {
    const [, doc, , kind, name, rest] = m;
    let signature = name;
    if (kind.startsWith('function')) { // take the balanced argument list
      let depth = 0, i = 0; for (; i < rest.length; i++) { const ch = rest[i]; if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) { depth--; if (!depth) { i++; break; } } }
      signature = name + rest.slice(0, i);
    } else if (kind === 'const') {
      const a = /^=\s*(\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/.exec(rest); signature = a ? `${name}${a[1].startsWith('(') ? a[1] : `(${a[1]})`}` : name;
    } else if (kind === 'class') signature = `class ${name}`;
    out.push({ name, kind: kind === 'class' ? 'class' : /\(/.test(signature) ? 'function' : 'value', signature, doc: clean(doc) });
  }
  return out;
}

export async function buildBlocks(pub) {
  const kits = join(pub, 'kits/v1');
  const craft = await import(pathToFileURL(join(kits, 'craft.js')).href), flat = await import(pathToFileURL(join(kits, 'craft2d.js')).href), procgen = await import(pathToFileURL(join(kits, 'procgen.js')).href);
  const groups = [], missing = [];
  for (const g of GROUPS) {
    const blocks = [];
    for (const f of g.files) for (const b of parse(readFileSync(join(kits, f), 'utf8'))) {
      const from = b.name in craft ? '@gcp/craft.js' : b.name in procgen ? '@gcp/procgen.js' : `@gcp/${f}`;
      blocks.push({ ...b, from, source: f });
    }
    groups.push({ id: g.id, title: g.title, blocks });
  }
  const list = (v) => (Array.isArray(v) ? v : Object.keys(v || {}));
  const values = {
    moods: list(craft.MOODS), weather: list(craft.WEATHERS), surfaces: list(craft.SURFACES), trees: list(craft.TREES), ground_cover: list(craft.COVERS),
    terrain_shapes: list(craft.TERRAIN_SHAPES), terrain_palettes: list(craft.TERRAIN_PALETTES), props: list(craft.PROPS), humanoids: list(craft.HUMANOIDS), animals: list(craft.ANIMALS_LIST),
    moods2d: list(flat.MOODS2D), weather2d: list(flat.WEATHERS2D), sprites2d: list(flat.SPRITES2D), trees2d: list(flat.TREES2D), actors2d: list(flat.ACTORS2D), ground_palettes: list(flat.GROUND_PALETTES),
    sounds: list(craft.SOUNDS), ambiences: list(craft.AMBIENCES), music: list(craft.MUSIC), recipe_kinds: craft.recipeKinds(), algorithms: procgen.ALGO,
  };
  for (const [k, v] of Object.entries(values)) if (Array.isArray(v) && !v.length) throw new Error(`blocks: no values for ${k}`);
  return { groups, values, missing };
}

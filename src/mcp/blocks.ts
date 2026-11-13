// The building-block tools: a catalog every agent can query (list_blocks, get_block) and a planner that turns a
// description into a plan and a complete starting game made only of blocks (design_scene). The catalog is generated
// at build time from the kit sources (scripts/blocks.mjs), so what the tools say is what the code does.
import { bad, type Env } from '../env';
import { assetJson, verKey } from '../projects';
import { getSettings } from '../settings';
import { designScene, planDistance, DESIGN_GOALS, DESIGN_SETTINGS } from '../design-scene.js';

interface Block { name: string; kind: string; signature: string; doc: string; from: string; source: string }
interface Catalog { three: string; groups: { id: string; title: string; blocks: Block[] }[]; values: Record<string, any> }

export const catalog = (env: Env) => assetJson<Catalog>(env, '/kits/blocks.json');
// the opening of a doc comment, cut at a sentence end inside 240 characters
const firstSentence = (doc: string) => { const flat = doc.replace(/\s+/g, ' ').trim(); if (flat.length <= 240) return flat; const cut = flat.slice(0, 240), end = cut.lastIndexOf('. '); return end > 60 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + ' …'; };
const CRAFT_GROUPS = ['stage', 'surfaces', 'nature', 'props', 'actors', 'play', 'fx', 'hud', 'sound', 'basics'];

// which value list each block takes, so get_block can print the valid names next to the options
const VALUES_OF: Record<string, string[]> = {
  createStage: ['moods', 'weather'], surface: ['surfaces'], surfaceTexture: ['surfaces'], surfaceNormal: ['surfaces'], block: ['surfaces'], floor: ['surfaces'], paint: ['surfaces'],
  tree: ['trees'], groundCover: ['ground_cover'], terrain: ['terrain_shapes', 'terrain_palettes'], prop: ['props'], place: ['props', 'trees', 'ground_cover'], scatter: ['trees', 'ground_cover', 'props'],
  humanoid: ['humanoids'], animal: ['animals'], sprite2d: ['sprites2d', 'trees2d'], actor2d: ['actors2d'], ground2d: ['ground_palettes'], createStage2d: ['moods2d', 'weather2d'], scatter2d: ['sprites2d'], createSound: ['sounds', 'ambiences', 'music'], createInventory: ['items'], itemIcon: ['items'], build: ['recipe_kinds'], recipe: ['recipe_kinds'], variants: ['recipe_kinds'],
};
// objects the blocks return: "hud.title" is documented under createHud, and so on
const OWNERS: Record<string, string> = { stage: 'createStage', hud: 'createHud', sound: 'createSound', fx: 'createFx', actor: 'humanoid', hero: 'humanoid', player: 'control', controller: 'control', land: 'terrain', input: 'createInput', boot: 'run' };
const LAB: Record<string, string> = { tree: 'tree', rock: 'rock', bush: 'bush', groundCover: 'cover', prop: 'prop', humanoid: 'humanoid', animal: 'animal', surface: 'surface', paint: 'texture', surfaceTexture: 'texture', terrain: 'terrain', noise: 'noise', createStage: 'stage' };

export async function listBlocks(env: Env, origin: string, a: Record<string, any>) {
  const cat = await catalog(env), want = String(a.group || '').toLowerCase().trim();
  if (want) {
    const g = cat.groups.find((x) => x.id === want) || cat.groups.find((x) => x.id.includes(want) || x.title.toLowerCase().includes(want));
    if (!g) throw bad(`No block group "${a.group}".`, `Groups: ${cat.groups.map((x) => x.id).join(', ')}`);
    return { group: g.id, title: g.title, blocks: g.blocks.map((b) => ({ name: b.name, import: `import { ${b.name} } from '${b.from}'`, signature: b.signature, doc: b.doc })), next: 'Every block here is ready to import. get_block {name} adds the valid values and a live preview link.' };
  }
  const line = (b: Block) => `${b.signature.length > 70 ? b.name + '(…)' : b.signature}: ${firstSentence(b.doc)}`;
  return {
    what: 'Building blocks hosted by the platform. Each is one call that returns something finished: generated in code from options and a seed, nothing to download, the same on every device. They are optional and they combine freely with your own Three.js code.',
    import: "import { createStage, terrain, tree, scatter, prop, place, humanoid, control, createHud, createSound } from '@gcp/craft.js'   // one import covers everything in the first list",
    depth: "For a game with more than one rule, group \"play\" has the systems ready to combine, in 2D and 3D alike: createInventory, createCrafting, createNeeds, createClock, createNodes + createInteract (harvest any scattered tree or rock), createBuilder, createQuests, createSave, and the panels hotbarUI, inventoryUI, needsUI, clockUI, questUI, minimapUI, pauseMenu, lobbyUI. input.bind names actions once for keyboard, mouse, touch buttons and gamepad. design_scene with goal \"homestead\" writes a complete game on all of them.",
    craft_blocks: cat.groups.filter((g) => CRAFT_GROUPS.includes(g.id)).map((g) => ({ group: g.id, title: g.title, blocks: g.blocks.filter((b) => b.kind !== 'value').map(line) })),
    world_2d: (() => { const g = cat.groups.find((x) => x.id === 'world2d'); return g ? { note: "Flat, painted top-down worlds with upright sprites (the 2.5D look) on a plain canvas: import from '@gcp/craft2d.js'. design_scene with camera \"2d\" writes a complete game with them.", blocks: g.blocks.filter((b) => b.kind !== 'value').map(line) } : undefined; })(),
    procedural_core: {
      note: "The layer underneath, for making your own assets: import from '@gcp/procgen.js'. Pure JS apart from the mesh builder, so 2D games and other engines can use the noise and the texture painter too. list_blocks {group} shows each in full.",
      groups: cat.groups.filter((g) => !CRAFT_GROUPS.includes(g.id) && g.id !== 'world2d').map((g) => ({ group: g.id, title: g.title, blocks: g.blocks.map((b) => b.name).join(', ') })),
    },
    valid_names: {
      moods: cat.values.moods, weather: cat.values.weather, surfaces: cat.values.surfaces, trees: cat.values.trees, ground_cover: cat.values.ground_cover, terrain_shapes: cat.values.terrain_shapes, terrain_palettes: cat.values.terrain_palettes,
      props: cat.values.props, humanoids: cat.values.humanoids, animals: cat.values.animals, sounds: cat.values.sounds, ambiences: cat.values.ambiences, music: cat.values.music,
      items: (cat.values as any).items, sprites2d: (cat.values as any).sprites2d, trees2d: (cat.values as any).trees2d, actors2d: (cat.values as any).actors2d, ground_palettes: (cat.values as any).ground_palettes,
    },
    preview: `${origin}/lab shows every block live in a browser (pick a kind, change the seed and the options, copy the recipe).`,
    next: 'For a world (3D, or flat top-down with camera "2d"), call design_scene with a description: it picks blocks for every part of the game and returns a complete starting game made of them. Call get_block {name} for the full options of one block.',
  };
}

export async function getBlock(env: Env, origin: string, a: Record<string, any>) {
  const cat = await catalog(env), all = cat.groups.flatMap((g) => g.blocks.map((b) => ({ ...b, group: g.id })));
  const raw = String(a.name || '').trim().replace(/\(.*$/, ''), [head, method] = raw.split('.');
  const lc = raw.toLowerCase();
  let b = all.find((x) => x.name === raw) || all.find((x) => x.name.toLowerCase() === lc);
  let note = '';
  if (!b && method && OWNERS[head]) { b = all.find((x) => x.name === OWNERS[head]); note = `${raw} is a method of the object ${OWNERS[head]}() returns; it is described below.`; }
  if (!b) { // a value name such as "oak" or "campfire": answer with the block that takes it
    const hit = Object.entries(cat.values).find(([, list]) => Array.isArray(list) && list.includes(lc));
    const owner = hit && Object.entries(VALUES_OF).find(([, keys]) => keys[0] === hit[0]);
    if (owner) { b = all.find((x) => x.name === owner[0]); note = `"${raw}" is one of the ${hit![0].replace('_', ' ')} that ${owner[0]}() accepts.`; }
  }
  if (!b) b = all.find((x) => x.name.toLowerCase() === 'create' + lc) || all.find((x) => x.name.toLowerCase().includes(lc) && lc.length > 2);
  if (!b) {
    const near = all.filter((x) => x.doc.toLowerCase().includes(lc) && lc.length > 2).slice(0, 8).map((x) => x.name);
    throw bad(`No block named "${a.name}".`, near.length ? `Blocks that mention it: ${near.join(', ')}. Call list_blocks for all of them.` : 'Call list_blocks for the names.');
  }
  const values: Record<string, unknown> = {};
  for (const k of VALUES_OF[b.name] || []) values[k] = k === 'recipe_kinds' ? cat.values.recipe_kinds : cat.values[k];
  const recipe = cat.values.recipe_kinds.find((r: any) => r.kind === LAB[b!.name]);
  return {
    name: b.name, group: b.group, import: `import { ${b.name} } from '${b.from}'`, signature: b.signature, doc: b.doc,
    ...(note ? { note } : {}),
    ...(Object.keys(values).length ? { valid_names: values } : {}),
    ...(recipe ? { as_recipe: { what: `The same asset as plain data: build({ kind: '${recipe.kind}', ...options }) from '@gcp/craft.js'. A recipe can be stored, sent or varied by seed and rebuilds identically.`, version: recipe.v, params: recipe.params } } : {}),
    ...(LAB[b.name] ? { preview: `${origin}/lab?kind=${LAB[b.name]}` } : {}),
    source: `get_kit_file {file: "${b.source}"}`,
  };
}

export async function designSceneTool(env: Env, origin: string, a: Record<string, any>) {
  if (!String(a.description || '').trim() && !a.setting) throw bad('Describe the game in a sentence.', 'Example: design_scene {description: "a knight collects sunstones on a volcanic island at dusk"}');
  const cat = await catalog(env), s = await getSettings(env), r = designScene(a, cat.values) as any;
  if (!r.files) return { ...r, next: 'Use list_blocks {group: "hud"}, {group: "sound"}, {group: "noise"} and {group: "texture"} for the blocks that fit a 2D game, and recommend_pipeline for the drawing approach.' };
  return {
    plan: r.plan,
    files: r.files,
    ...(r.notes.length ? { notes: r.notes } : {}),
    how_to_use: [
      r.plan.systems ? 'create_project (no template), then put_files with the two files above exactly as returned. It already runs: a start and an end screen, sound, named actions for keyboard, mouse, touch buttons and gamepad, an inventory with a hotbar, crafting, needs, day and night, harvesting, building, quests, a cloud save, and a play-through that plays the whole loop.' : 'create_project (no template), then put_files with the two files above exactly as returned. It already runs, has a start and an end screen, sound, touch input and a five-step play-through.',
      'deploy_preview. The report includes a craft score out of 100 with what was measured. Uploaded unchanged, this starting point already scores well, because the blocks do; that is the floor to build on, not the finished game.',
      r.dimension === '2d' ? 'Make it your game: section 6 of src/main.js is the rules, sections 2 to 5 are the world. Swap kinds (list_blocks {group: "world2d"} has the valid names), move landmarks, add your own mechanics (for building, crafting, needs, quests and saving use the blocks of list_blocks {group: "play"}, or ask for goal "homestead" to get them wired up), keep the play-through in step with the rules. Leave the "Plan:" comment line in place: the report uses it to tell you how much of the file is still the plan (quality.own_work).' : 'Make it your game: section 7 of src/main.js is the rules, sections 3, 4 and 6 are the world. Swap kinds (valid names are in list_blocks), move landmarks, add your own mechanics (for an inventory, crafting, needs, building, quests and saving use the blocks of list_blocks {group: "play"}, or ask for goal "homestead" to get them wired up), keep the play-through in step with the rules. Leave the "Plan:" comment line in place: the report uses it to tell you how much of the file is still the plan (quality.own_work).',
      `Deploy again after each round of changes and keep the craft score at ${s.craft_target} or above.`,
    ],
    change_the_plan: `Call design_scene again with any of: setting (${DESIGN_SETTINGS.join(', ')}), mood, weather, terrain, palette, hero, goal (${DESIGN_GOALS.join(', ')}), camera (third, top, or 2d for a flat painted top-down world), title, seed, pickups, time_limit.`,
    not_a_limit: r.dimension === '2d' ? 'This is a starting point made of ordinary calls, not a required structure. Blocks mix with your own canvas drawing (stage.ctx, bake() for your own sprites); get_block {name} shows every option.' : 'This is a starting point made of ordinary calls, not a required structure. Blocks mix with your own Three.js meshes, materials and shaders; get_block {name} shows every option.',
    preview_blocks: `${origin}/lab`,
  };
}

/**
 * For a version that began as a design_scene plan: how much of the planned code is still there unchanged. A fact
 * about the source, reported next to the craft score (which reads the running game and cannot tell a plan from a
 * design). Null when the version has no plan line.
 */
export async function ownWork(env: Env, pid: string, n: number) {
  const obj = await env.FILES.get(verKey(pid, n, 'src/main.js')).catch(() => null);
  if (!obj || obj.size > 400_000) return null;
  const d = planDistance(await obj.text(), (await catalog(env)).values) as { planned: number; kept: number; changed: number; added: number } | null;
  if (!d || !d.planned) return null;
  const share = d.kept / d.planned, as_planned = share >= 0.85 && d.added < d.planned * 0.25;
  return {
    planned_lines: d.planned, unchanged: d.kept, changed_or_removed: d.changed, added: d.added, still_the_plan: as_planned,
    summary: as_planned
      ? `src/main.js is still the starting point design_scene wrote: ${d.kept} of its ${d.planned} lines are unchanged and ${d.added} were added. The craft score above therefore measures the building blocks, not yet a game of your own design.`
      : `${d.changed} of the ${d.planned} planned lines were changed or removed and ${d.added} lines were added since design_scene wrote the starting point.`,
    ...(as_planned ? { ideas: [
      'Rules (section 7): give the player a second thing to do or to avoid. For example hunters that chase (animal() with wander(), as the "survive" goal does), something to carry back to a landmark, a gate that opens when a count is reached, or a risk that grows with time.',
      'World (sections 3, 4 and 6): swap in kinds this plan does not use (list_blocks prints every tree, prop, animal and surface), arrange landmarks into a place with a shape (a path, a ring, a walled yard built with block() and floor()), or build an asset of your own with @gcp/procgen.js.',
      'Feel: answer every event with createFx() (fx.sparkle, fx.explosion, fx.confetti), a sound.play() and a hud.toast(), and let the mood or weather change with progress (stage.setMood).',
      'Keep GCP.test.onPlaythrough in step with the new rules, so the report still proves the game can be played to its end.',
    ] } : {}),
  };
}

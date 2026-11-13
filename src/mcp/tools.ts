// The tools an external agent uses to build, check, deploy, verify, publish and manage games.
// Descriptions are written for agents of ordinary ability: each says when to call it and what comes next.
import { unzipSync } from 'fflate';
import { AppError, bad, forbidden, type Env, type User } from '../env';
import { gameUrl } from '../deploy';
import { balanceOf, splitSale } from '../earnings';
import { enqueue } from '../pipeline';
import {
  applyTemplate, assetJson, assetText, checkProject, createProject, defaultImports, deleteFile, getVersion, listFiles, logEvent, ownedProject, publicVersion,
  putFile, readFile, snapshot, updateProjectMeta, versionEligible, type Issue,
} from '../projects';
import { takeOffline } from '../routes/api';
import { designSceneTool, getBlock, listBlocks, ownWork } from './blocks';
import { DESIGN_GOALS, DESIGN_SETTINGS } from '../design-scene.js';
import { getSettings } from '../settings';
import { THREE_VERSION } from '../generated/runtime-source';
import { addDays, cleanPath, dayOf, extOf, isText, now, parseJson, sha256, token as randomToken, unb64, usd } from '../util';

export interface ToolCtx { env: Env; user: User; origin: string; client: string }
interface Tool {
  name: string; title: string; description: string; inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  run: (a: Record<string, any>, c: ToolCtx) => Promise<unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const PROJECT = { type: 'string', description: 'Project id or slug (from list_projects or create_project).' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const issueLine = (i: Issue) => `${i.level.toUpperCase()}${i.file ? ` ${i.file}${i.line ? `:${i.line}` : ''}` : ''}: ${i.message}${i.frame ? `\n${i.frame}` : ''}${i.hint ? `\n  fix: ${i.hint}` : ''}`;

async function guideIndex(env: Env) { return assetJson<{ guides: { topic: string; title: string; summary: string }[] }>(env, '/guides/index.json'); }
async function kitIndex(env: Env) { return assetJson<{ three: string; kits: { name: string; file: string; summary: string; exports: string[] }[] }>(env, '/kits/index.json'); }

async function account(c: ToolCtx) {
  const s = await getSettings(c.env), u = c.user, bal = await balanceOf(c.env, u.id);
  return {
    name: u.name, creator_license: !!u.creator,
    can_publish: !!u.creator || !s.creator_fee_required,
    license: u.creator ? 'active' : `Not purchased. Publishing needs a one-time ${usd(s.creator_fee_cents)} creator license (unlimited games). Building, previewing and verifying are free. The account owner buys it at ${c.origin}/console`,
    console_url: `${c.origin}/console`,
    earnings: { available: usd(bal.available), pending: usd(bal.pending), withdraw_minimum: usd(s.withdraw_min_cents) },
    paid_games: s.paid_games_enabled ? { platform_cut_percent: s.platform_fee_percent, min_price_cents: s.game_price_min_cents, max_price_cents: s.game_price_max_cents } : 'disabled',
    limits: { files_per_bundle: s.bundle_max_files, bundle_bytes: s.bundle_max_bytes, file_bytes: s.file_max_bytes, server_code: s.allow_server_code },
  };
}

async function waitVersion(c: ToolCtx, pid: string, n: number, ms: number) {
  const end = Date.now() + ms;
  let v = await getVersion(c.env, pid, n);
  while (v && (v.status === 'queued' || v.status === 'deploying' || v.status === 'verifying') && Date.now() < end) { await sleep(2000); v = await getVersion(c.env, pid, n); }
  return v!;
}

async function versionReport(c: ToolCtx, p: { id: string; slug: string; preview_version: number | null }, n: number, v: Awaited<ReturnType<typeof getVersion>>) {
  const s = await getSettings(c.env);
  if (!v) throw bad(`Version ${n} does not exist. Call list_versions.`);
  const pub = publicVersion(v, c.origin), el = versionEligible(v, s.verify_browser_required);
  const running = ['queued', 'deploying', 'verifying'].includes(v.status);
  const craft = (pub.report as any)?.craft as { score: number; level: string; summary: string; next: string[] } | undefined, target = s.craft_target;
  const below = !!craft && craft.score < target;
  const own = craft && !running ? await ownWork(c.env, p.id, n) : null, asPlanned = !!own?.still_the_plan;
  // the same measurements on the version before, so nobody reads an unchanged score as progress
  let since: Record<string, unknown> | null = null;
  if (craft && !running) {
    const prev = await c.env.DB.prepare("SELECT n, report FROM versions WHERE project_id = ? AND n < ? AND status = 'verified' ORDER BY n DESC LIMIT 1").bind(p.id, n).first<{ n: number; report: string | null }>();
    let was: any = null; try { was = prev?.report ? JSON.parse(prev.report).craft : null; } catch { /* an unreadable old report is no comparison */ }
    if (prev && was && Array.isArray(was.dimensions)) {
      const moved = ((craft as any).dimensions || []).flatMap((d: any) => { const o = was.dimensions.find((x: any) => x.id === d.id); return o && o.score !== d.score ? [`${d.label}: ${o.score} to ${d.score} of ${d.max}`] : []; });
      const change = craft.score - was.score;
      since = {
        version: prev.n, craft_score: was.score, change, moved,
        summary: moved.length ? `${change > 0 ? `Up ${change}` : change < 0 ? `Down ${-change}` : 'Same total'} against version ${prev.n}: ${moved.join('; ')}.`
          : `Nothing the score measures moved since version ${prev.n}. That is expected after changes to rules, numbers or text. If you added things to raise the score, they are not on screen in the portrait (the opening view, drawn at full quality): place them near the start, in front of the camera.`,
      };
    }
  }
  const publish = `publish {project, version: ${n}}`;
  return {
    ...(running ? { not_finished: `Version ${n} is deployed and the browser check is still running (${v.status}), so there is no report yet. This is normal: the check takes one to two minutes. Call get_version {project, version: ${n}}; it waits for the result. Do not call deploy_preview again for the same files.` } : {}),
    ...pub, can_publish: el.ok, eligibility: el.reason,
    ...(craft ? { quality: {
      craft_score: craft.score, look_score: (craft as any).look ?? null, level: craft.level, target, meets_target: !below, summary: craft.summary,
      improve: craft.next,
      ...(since ? { since_previous: since } : {}),
      ...(own ? { own_work: own } : {}),
      note: `The score is measured from the running game (pictures, draw calls, sound, interface, the play-through), not judged by taste, so changing rules, numbers or text does not move it. look_score is the picture alone out of 100 (surfaces, light, world, motion): finished reference games measure 80 to 95 there. The picture is the portrait: the opening view drawn once more at full quality, as a device with a graphics card draws it (the screenshot of the version); scenery that is not on screen there is not counted. Each line under improve names the measurement that is short, the value that earns full marks and the building block that moves it; get_block {name} shows its options. ${below ? 'Start with the first line.' : 'The target is met, so these are optional.'} Publishing never depends on the score.`,
    } } : {}),
    preview_page: `${c.origin}/console/projects/${p.id}`,
    next: running ? `Still ${v.status} (${v.stage}). Call get_version {project, version: ${n}} now; it waits up to 40 seconds for the report.`
      : !el.ok ? 'Fix every failed check below (each has a hint), upload the changed files, run check_project, then deploy_preview again.'
        : below ? `Verified, so it can be published, but the craft score is ${craft!.score}/100 and the target is ${target}. Apply the fixes under quality.improve (start with the first), then deploy_preview again and compare the score.`
          : asPlanned ? `Verified with a craft score of ${craft!.score}/100 (target ${target}). The source is still the design_scene starting point almost line for line (quality.own_work), so the next step is to make it your own game: pick from quality.own_work.ideas, change the files, then deploy_preview again. ${publish} is available whenever you decide it is finished.`
            : `Verified${craft ? ` with a craft score of ${craft.score}/100 (target ${target})` : ''}. This version can go live: ${publish}. The preview page lets a person play it first; keep editing and call deploy_preview again if there is more to do.`,
  };
}

export const TOOLS: Tool[] = [
  {
    name: 'get_started', title: 'Start here',
    description: 'Call this first. Returns the workflow, the three hard rules every game must follow, how quality is measured, the account status, and which building blocks, guides, kits and templates exist. Call it again whenever you are unsure what to do next.',
    inputSchema: obj({}), annotations: { readOnlyHint: true },
    run: async (_a, c) => {
      const s = await getSettings(c.env);
      return {
        platform: s.brand_name,
        account: await account(c),
        workflow: [
          '1. Plan. For a 3D world call design_scene with one sentence about the game: it picks building blocks for the stage, ground, scenery, landmarks, hero, creatures, sound and interface, and returns a complete starting game made of them. For anything else call recommend_pipeline.',
          '2. create_project, then write files: put_files for small text files, edit_file for changes, create_upload_url + curl for big or binary files or a whole folder.',
          '3. Build the game. list_blocks shows every block (one call each: a textured material, a tree, a house, an animated character, a HUD, sound); get_block {name} shows its options and valid names. Blocks are optional and mix with your own code.',
          '4. check_project: static checks (syntax, imports, missing files, the contract). Fix everything it reports.',
          '5. deploy_preview: freezes a version, deploys it as its own Cloudflare Worker, runs it in a real browser, and returns a verification report with a craft score out of 100. Register GCP.test.onPlaythrough (platform-contract guide) so the browser also plays your rules to the end.',
          `6. Repeat 3 to 5 until the version is verified, the craft score is ${s.craft_target} or more and the game is your own design. The report lists what to improve and which block does it (quality.improve) and, for a game that began as a design_scene plan, how much of it is still the plan (quality.own_work). A person can play every preview from the console.`,
          '7. publish: makes that verified version live in the marketplace. Later: list_versions, rollback, unpublish, get_stats.',
        ],
        rules: [
          'The game is a web page: index.html at the bundle root, plus any files it loads with relative paths. No build step is required.',
          'Call GCP.ready() once, right after the first playable frame is drawn. `GCP` is injected by the platform; never bundle or import it. (stage.run() from the craft blocks calls it for you.)',
          'It must run with no uncaught errors, keep rendering frames, and survive keyboard, mouse and touch input. That is what verification checks.',
        ],
        quality: {
          how_it_is_measured: 'After a version verifies, the browser loads the game once more at full quality (GCP.portrait is true: draw as on a device with a graphics card) and takes its portrait, which becomes the screenshot. Seven things are then measured: surface detail and crispness, light and colour (tonal range, brightness, lighting and effect passes), how furnished the world is (shapes, triangles, materials), ambient motion, sound, interface and input, and a passing play-through. The result is quality.craft_score out of 100, and quality.look_score for the picture alone.',
          reference: 'The measures are calibrated on finished games. A hand-made open-world survival game with a deferred renderer (ambient occlusion, bloom, cascaded shadows, 350k triangles a frame) measures look 93. A scene of bare primitives measures under 35.',
          target: `${s.craft_target} or more for a game you would call finished. Publishing never depends on the score; it tells you what a player would notice is missing.`,
          why_blocks: 'A bare primitive with a flat colour, a silent scene and no interface is what scores low. Every block exists to remove one of those in one call, with nothing to download: surface(kind) paints a material, tree(), rock(), prop(kind), humanoid() and animal() build detailed models from parts, createStage() lights the scene, createHud() and createSound() give interface and sound.',
        },
        session: `The access token lasts ${Math.round(Math.max(60, s.oauth_access_ttl_s) / 60)} minutes. When a call answers 401, do not sign in again: POST ${c.origin}/oauth/token with grant_type=refresh_token, refresh_token and client_id, keep the new access_token and refresh_token from the answer, and repeat the call. The whole authorization ends after ${Math.max(1, Math.round(s.oauth_grant_ttl_s / 86400))} days or when the user revokes it. Projects, files and versions stay as they are across all of that.`,
        freedom: 'Everything else is yours: genre, art direction, camera, rendering technique, engine or no engine. Blocks, guides and kits are help, not a house style: a game made entirely of your own code is just as welcome and is measured the same way.',
        imports_available_by_default: defaultImports(c.origin),
        building_blocks: {
          import: "import { createStage, terrain, tree, scatter, prop, place, humanoid, control, createHud, createSound } from '@gcp/craft.js'",
          tools: ['design_scene: a description in, a block plan and a complete starting game out', 'list_blocks: every block with a one-line summary, and every valid name (moods, surfaces, trees, props, characters, animals, sounds)', 'get_block {name}: full options of one block'],
          procedural_core: "@gcp/procgen.js is the layer underneath for making your own assets: seeded random numbers and noise that match between JavaScript and shaders, a mesh builder, a texture painter and recipes (seed + parameters as data). See the procedural-generation guide.",
          preview: `${c.origin}/lab shows every block live.`,
        },
        guides: (await guideIndex(c.env)).guides.map((g) => `${g.topic}: ${g.summary}`),
        kits: (await kitIndex(c.env)).kits.map((k) => `@gcp/${k.file}: ${k.summary}`),
        templates: (await assetJson<{ templates: { name: string; summary: string }[] }>(c.env, '/templates/index.json')).templates.map((t) => `${t.name}: ${t.summary}`),
        what_to_read: {
          always: ['platform-contract (10 minutes, before writing any code: the rules, the SDK, what verification checks, the play-through hook)'],
          '3d_game_with_three_js': ['building-blocks (how the blocks fit together, with a complete small game)', 'performance (read "The verification browser" before building the scene: it has no GPU)', 'rendering-pipelines when you set up your own renderer instead of createStage', 'procedural-generation, meshes and materials-textures when you make your own models and surfaces', 'animation when things move'],
          '2d_game': ['rendering-pipelines (the canvas section)', 'input', 'performance (the 2D section)', 'loading', 'building-blocks (the parts that work in 2D: HUD, sound, noise, painted textures)'],
          when_needed: ['saves: cloud saves, leaderboards, server code', 'multiplayer: rooms', 'audio: sound without files', 'troubleshooting: as soon as deploy_preview comes back not verified'],
          note: 'Guides are short and contain working code. Reading the ones on this list for your kind of game first is cheaper than a failed preview.',
        },
        start_from: 'You do not need a template. For a world, 3D or flat top-down 2D (camera "2d"), design_scene writes the starting files for your description. Templates remain for other cases: "three-blank" (your own renderer, lights, loop and input, nothing else), "canvas2d-arcade" (a complete small 2D game), "blank" (a bare 2D canvas).',
        tip: 'Not sure how to render the game? Call recommend_pipeline with a short description before writing code.',
      };
    },
  },
  {
    name: 'get_account', title: 'Account status',
    description: 'Shows whether this account can publish (creator license), earnings, paid-game rules and bundle limits. Call it when publish is refused or the user asks about money.',
    inputSchema: obj({}), annotations: { readOnlyHint: true }, run: (_a, c) => account(c),
  },
  {
    name: 'list_guides', title: 'List authoring guides',
    description: 'Lists the authoring guides: the platform contract, building blocks, procedural generation, rendering pipelines, meshes, materials and textures, animation, loading, input, performance, audio, saves, multiplayer, and troubleshooting. They distil conventions verified in shipped games. Read the relevant ones before writing that part of the game.',
    inputSchema: obj({}), annotations: { readOnlyHint: true }, run: async (_a, c) => guideIndex(c.env),
  },
  {
    name: 'get_guide', title: 'Read a guide',
    description: 'Returns one authoring guide as Markdown with working code. Topics come from list_guides (for example "platform-contract", "building-blocks", "procedural-generation", "rendering-pipelines", "meshes", "materials-textures", "loading", "performance", "troubleshooting").',
    inputSchema: obj({ topic: { type: 'string', description: 'Guide topic from list_guides.' } }, ['topic']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const idx = await guideIndex(c.env), topic = String(a.topic || '').toLowerCase().trim();
      const g = idx.guides.find((x) => x.topic === topic) || idx.guides.find((x) => x.topic.includes(topic) || topic.includes(x.topic));
      const text = g && await assetText(c.env, `/guides/${g.topic}.md`);
      if (!text) throw bad(`No guide "${a.topic}".`, `Topics: ${idx.guides.map((x) => x.topic).join(', ')}`);
      return { markdown: text.replaceAll('{{ORIGIN}}', c.origin).replaceAll('{{THREE}}', THREE_VERSION).replaceAll('{{TARGET}}', String((await getSettings(c.env)).craft_target)) };
    },
  },
  {
    name: 'design_scene', title: 'Plan a 3D game from a description',
    description: 'Describe the game in a sentence and get (1) a plan that names a building block for every part of it: stage and mood, ground, scenery, landmarks, hero, creatures, sound, interface, and (2) a complete starting game (index.html + src/main.js) made only of those blocks, with a start screen, an end screen, touch input, sound and a play-through, that you then reshape into your game. Plain rules, no AI: the same description gives the same plan, and every choice can be overridden with an argument. Call it before writing a game with a world; it is the fastest way to one that looks finished. It writes 3D worlds (third-person or from above) and flat, painted top-down worlds with upright sprites (camera "2d", also chosen when the description says 2D, 2.5D, pixel or isometric). For games that are not a world (puzzles, boards, platformers) it returns the blocks that apply instead.',
    inputSchema: obj({
      description: { type: 'string', description: 'What the player sees and does, for example "a knight collects sunstones on a volcanic island at dusk while wolves chase him". Things you name (trees, animals, props, a character) are put in the plan.' },
      setting: { type: 'string', enum: DESIGN_SETTINGS, description: 'The kind of world. Chosen from the description when omitted.' },
      goal: { type: 'string', enum: DESIGN_GOALS, description: 'The rules the starting game ships with: collect every pickup, survive hunters until the clock runs out, or find keys and reach a portal. You will change them; this decides what is already wired up.' },
      camera: { type: 'string', enum: ['third', 'top', '2d'], description: 'third: 3D, behind the hero with drag-to-look (default). top: 3D, a high camera looking down. 2d: a flat painted world seen from above with upright sprites (the 2.5D look of survival and farming games), drawn on a plain canvas.' },
      mood: { type: 'string', description: 'Light and sky, one of the moods in list_blocks (clear-day, golden-hour, misty-dawn, dusk, night, storm, …).' },
      weather: { type: 'string', description: 'rain, snow, motes, fireflies, embers, leaves, dust, or none.' },
      terrain: { type: 'string', description: 'island, hills, plains, valley, dunes, mountains or flat.' },
      palette: { type: 'string', description: 'Ground colours: temperate, autumn, desert, snow, volcanic, alien or tropical.' },
      hero: { type: 'string', description: 'The player character, one of the humanoids in list_blocks (explorer, knight, wizard, pirate, astronaut, robot, …).' },
      title: { type: 'string', description: 'The name of the game.' },
      seed: { type: 'string', description: 'Any word. The same seed always grows the same world; a different one gives a different world with the same rules.' },
      pickups: { type: 'integer', description: 'How many things to collect (goal collect). Default 10.' },
      time_limit: { type: 'integer', description: 'Seconds on the clock. Default 240, or 90 for survive.' },
    }, ['description']), annotations: { readOnlyHint: true },
    run: async (a, c) => designSceneTool(c.env, c.origin, a),
  },
  {
    name: 'list_blocks', title: 'List building blocks',
    description: 'Lists the building blocks the platform hosts: one-call functions that return something finished and are generated in code (nothing to download): a lit stage with sky and weather, 39 painted surface materials, terrain, water, trees, rocks, plants, grass, 46 props (buildings, furniture, lights, pickups), animated people and animals, player control with a camera, particle effects, a HUD and sound; plus the procedural core underneath (seeded noise that matches in JS and shaders, a mesh builder, a texture painter, recipes). Also returns every valid name: moods, surfaces, trees, props, characters, animals, sounds. Call it before building anything by hand, and pass `group` to read one group in full.',
    inputSchema: obj({ group: { type: 'string', description: 'Optional. One of: stage, surfaces, nature, props, actors, fx, hud, sound, basics, noise, gpu-noise, mesh, texture, recipe. Returns that group with full documentation.' } }), annotations: { readOnlyHint: true },
    run: async (a, c) => listBlocks(c.env, c.origin, a),
  },
  {
    name: 'get_block', title: 'Read one building block',
    description: 'Returns one building block in full: the import line, the signature, every option, the valid names it accepts, the same asset as a recipe, and a link that shows it live. Accepts a function name ("scatter", "createHud"), a method ("hud.title", "stage.setMood", "player.moveTo") or a value ("oak", "campfire", "golden-hour"). Call it right before you use a block for the first time.',
    inputSchema: obj({ name: { type: 'string', description: 'Block name from list_blocks, e.g. "terrain", "prop", "humanoid", "createSound", "mergeParts".' } }, ['name']), annotations: { readOnlyHint: true },
    run: async (a, c) => getBlock(c.env, c.origin, a),
  },
  {
    name: 'recommend_pipeline', title: 'Recommend a rendering approach',
    description: 'Describe the game you are about to build and get a concrete rendering recommendation: which pipeline fits (2D canvas, Three.js forward, forward with post-processing, deferred, WebGPU), which kit modules and template to start from, a frame budget, and the mistakes to avoid. It never dictates art style or gameplay. Call it before writing rendering code.',
    inputSchema: obj({
      description: { type: 'string', description: 'One or two sentences about the game: what the player sees and does.' },
      dimension: { type: 'string', enum: ['2d', '2.5d', '3d'], description: 'How the world is drawn.' },
      world: { type: 'string', enum: ['single-screen', 'level', 'open-world'], description: 'How much world is visible or streamed.' },
      look: { type: 'string', enum: ['flat', 'stylized-lit', 'realistic', 'pixel'], description: 'Rough visual direction, if decided.' },
      devices: { type: 'string', enum: ['desktop', 'mobile', 'both'], description: 'Where it must run well. Default both.' },
      dynamic_lights: { type: 'integer', description: 'Light sources that move or switch at once (torches, muzzle flashes). Default 0.' },
      moving_things: { type: 'integer', description: 'Roughly how many things animate at once (enemies, particles count as 1 system).' },
      multiplayer: { type: 'boolean', description: 'True if players share a session.' },
    }, ['description']), annotations: { readOnlyHint: true },
    run: async (a) => recommend(a),
  },
  {
    name: 'list_kits', title: 'List reusable kits',
    description: 'Lists the module files hosted by the platform (import them as "@gcp/<file>"): the craft building blocks, the procedural generation core, HUD, sound, loop and input, Three.js helpers, 2D canvas helpers, multiplayer. For what the functions in them do, list_blocks is the better view; this one lists files and export names.',
    inputSchema: obj({}), annotations: { readOnlyHint: true },
    run: async (_a, c) => { const k = await kitIndex(c.env); return { three_version: k.three, import_prefix: '@gcp/', kits: k.kits.map((x) => ({ import: `@gcp/${x.file}`, summary: x.summary, exports: x.exports })), note: 'Read the source with get_kit_file to see exact signatures. You may also copy a kit into your bundle and change it.' }; },
  },
  {
    name: 'get_kit_file', title: 'Read kit source',
    description: 'Returns the source of one kit module (for example "hud.js", "craft/props.js" or "procgen/texture.js") so you can see exactly how something is built, or copy it into your bundle and change it. get_block is shorter when you only need the options.',
    inputSchema: obj({ file: { type: 'string', description: 'File name from list_kits or the "source" of get_block, e.g. "core.js" or "craft/nature.js".' } }, ['file']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const file = String(a.file || '').replace(/^@gcp\//, '');
      const text = /^((craft|procgen)\/)?[a-z0-9\-]+\.js$/.test(file) ? await assetText(c.env, `/kits/v1/${file}`) : null;
      if (!text) throw bad(`No kit file "${a.file}".`, 'Call list_kits for the file names. The craft and procedural modules are split into parts: craft/stage.js, craft/surfaces.js, craft/nature.js, craft/props.js, craft/actors.js, craft/fx.js, procgen/noise.js, procgen/glsl.js, procgen/mesh.js, procgen/texture.js, procgen/recipe.js.');
      return { file, import: `@gcp/${file}`, source: text };
    },
  },
  {
    name: 'list_templates', title: 'List starter templates',
    description: 'Lists starter projects that already pass verification. They are optional: for a world (3D, or flat top-down 2D), design_scene writes starting files that fit your description, and list_blocks gives you the parts. Use a template when you want a bare renderer ("three-blank"), a 2D starting point ("canvas2d-arcade", "blank") or an example to read.',
    inputSchema: obj({}), annotations: { readOnlyHint: true }, run: async (_a, c) => assetJson(c.env, '/templates/index.json'),
  },
  {
    name: 'list_projects', title: 'List projects',
    description: "Lists this account's game projects with status (draft, live, offline), versions and marketplace numbers.",
    inputSchema: obj({}), annotations: { readOnlyHint: true },
    run: async (_a, c) => {
      const rows = await c.env.DB.prepare("SELECT id, slug, title, status, live_version, preview_version, price_cents, plays, sales, updated_at FROM projects WHERE owner_id = ? AND status != 'removed' ORDER BY updated_at DESC").bind(c.user.id).all();
      return { projects: rows.results };
    },
  },
  {
    name: 'create_project', title: 'Create a game project',
    description: 'Creates a new game project. Templates are optional: for a world (3D, or flat top-down 2D) leave `template` out and write the files design_scene returns; pass `template` for a bare starting point ("three-blank" for your own Three.js setup, "canvas2d-arcade" for 2D, "blank" for an empty page that satisfies the contract). Returns the project id used by every other tool.',
    inputSchema: obj({
      title: { type: 'string', description: 'Game title shown in the marketplace.' },
      template: { type: 'string', description: 'Optional starter template name from list_templates.' },
      tagline: { type: 'string', description: 'One line shown on the game card.' },
      description: { type: 'string', description: 'Longer description for the game page.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Up to 8 genre or mood tags.' },
    }, ['title']),
    run: async (a, c) => {
      const p = await createProject(c.env, c.user, a as any, c.client);
      const files = a.template ? await applyTemplate(c.env, p, String(a.template)) : [];
      return { project: p.id, slug: p.slug, title: p.title, files, console_page: `${c.origin}/console/projects/${p.id}`, next: files.length ? 'Template files are in the workspace. Use read_file to study them, change them with edit_file or put_files, then check_project.' : 'Upload index.html and the rest with put_files, then check_project.' };
    },
  },
  {
    name: 'update_project', title: 'Update listing details or price',
    description: 'Updates the marketplace listing: title, tagline, description, tags, controls text, and price. price_cents 0 means free; a positive value makes it a paid game (one-time purchase in US cents). The platform keeps its cut of each sale and credits the rest to the creator.',
    inputSchema: obj({
      project: PROJECT, title: { type: 'string' }, tagline: { type: 'string' }, description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
      controls: { type: 'string', description: 'How to play, shown on the game page (keys, touch).' },
      price_cents: { type: 'integer', description: '0 for free, or the price in US cents (e.g. 499 = $4.99).' },
    }, ['project']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project);
      await updateProjectMeta(c.env, p, a);
      const q = await ownedProject(c.env, c.user, p.id), s = await getSettings(c.env);
      return { ok: true, title: q.title, price: q.price_cents ? usd(q.price_cents) : 'free', creator_receives_per_sale: q.price_cents ? usd(splitSale(q.price_cents, s).net) : null };
    },
  },
  {
    name: 'get_project', title: 'Project status',
    description: 'Shows one project: status, live and preview versions, the latest verification result, workspace size and links. Call it to see where things stand.',
    inputSchema: obj({ project: PROJECT }, ['project']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project), files = await listFiles(c.env, p.id);
      const latest = await c.env.DB.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY n DESC LIMIT 1').bind(p.id).first<any>();
      return {
        project: p.id, slug: p.slug, title: p.title, status: p.status, price: p.price_cents ? usd(p.price_cents) : 'free', live_version: p.live_version, preview_version: p.preview_version,
        workspace: { files: files.length, bytes: files.reduce((x, f) => x + f.size, 0) },
        latest_version: latest ? await versionReport(c, p, latest.n, latest) : null,
        game_page: p.status === 'live' ? `${c.origin}/g/${p.slug}` : null, console_page: `${c.origin}/console/projects/${p.id}`,
      };
    },
  },
  {
    name: 'put_files', title: 'Write files',
    description: 'Creates or replaces files in the project workspace. Best for text files up to a few hundred lines. For a small change to an existing file use edit_file instead (it saves tokens). For large or binary files, or to upload a whole folder at once, use create_upload_url. Paths are relative, e.g. "index.html", "src/game.js". Binary content must be base64 with encoding "base64". Example arguments: {"project": "abc123", "files": [{"path": "index.html", "content": "<!doctype html>..."}, {"path": "src/main.js", "content": "import * as THREE from \'three\';..."}]}. `files` is an array of objects, not a map of path to content.',
    inputSchema: obj({
      project: PROJECT,
      files: { type: 'array', minItems: 1, maxItems: 40, description: 'Array of {path, content} objects, e.g. [{"path": "index.html", "content": "<!doctype html>..."}]. Up to 40 per call.', items: obj({ path: { type: 'string', description: 'Relative path inside the bundle, e.g. "src/main.js".' }, content: { type: 'string', description: 'The whole file as text (or base64 when encoding is "base64").' }, encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Default utf8.' } }, ['path', 'content']) },
    }, ['project', 'files']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project);
      if (!Array.isArray(a.files) || !a.files.length) throw bad('files must be a non-empty array of {path, content}.');
      const written = [];
      for (const f of a.files) {
        let bytes: Uint8Array;
        try { bytes = f.encoding === 'base64' ? unb64(String(f.content).replace(/\s+/g, '')) : new TextEncoder().encode(String(f.content ?? '')); } catch { throw bad(`${f.path}: content is not valid base64.`); }
        const row = await putFile(c.env, p, f.path, bytes);
        written.push({ path: row.path, bytes: row.size });
      }
      return { written, next: 'Run check_project when your changes are complete.' };
    },
  },
  {
    name: 'edit_file', title: 'Edit part of a file',
    description: 'Replaces an exact piece of text in a workspace file. old_string must match the file exactly (including spaces and newlines) and appear once, unless replace_all is true. Use read_file first if you are not sure of the exact text.',
    inputSchema: obj({ project: PROJECT, path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['project', 'path', 'old_string', 'new_string']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project), path = cleanPath(a.path) || '';
      const { bytes } = await readFile(c.env, p.id, path);
      if (!isText(path)) throw bad('edit_file only works on text files.');
      const src = new TextDecoder().decode(bytes), old = String(a.old_string);
      if (!old) throw bad('old_string must not be empty.');
      const count = src.split(old).length - 1;
      if (count === 0) throw bad('old_string was not found in the file.', 'Call read_file and copy the exact text, including indentation.');
      if (count > 1 && !a.replace_all) throw bad(`old_string appears ${count} times.`, 'Include more surrounding text to make it unique, or set replace_all to true.');
      const out = a.replace_all ? src.split(old).join(String(a.new_string)) : src.replace(old, () => String(a.new_string));
      const row = await putFile(c.env, p, path, new TextEncoder().encode(out));
      return { path: row.path, bytes: row.size, replaced: a.replace_all ? count : 1 };
    },
  },
  {
    name: 'read_file', title: 'Read a file',
    description: 'Returns a workspace file. Text files come back as text with line numbers available through offset and limit (lines). Binary files return only their size and type.',
    inputSchema: obj({ project: PROJECT, path: { type: 'string' }, offset: { type: 'integer', description: 'First line to return (1-based).' }, limit: { type: 'integer', description: 'Number of lines (default 400, max 2000).' } }, ['project', 'path']),
    annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project), path = cleanPath(a.path) || '';
      const { row, bytes } = await readFile(c.env, p.id, path);
      if (!isText(path)) return { path, bytes: row.size, type: row.ctype, note: 'Binary file; content not returned.' };
      const lines = new TextDecoder().decode(bytes).split('\n'), off = Math.max(1, Number(a.offset) || 1), lim = Math.min(2000, Math.max(1, Number(a.limit) || 400));
      const slice = lines.slice(off - 1, off - 1 + lim).map((l) => (l.length > 4000 ? l.slice(0, 4000) + ' …[line truncated]' : l));
      return { path, total_lines: lines.length, from_line: off, to_line: off + slice.length - 1, content: slice.join('\n'), more: off - 1 + lim < lines.length };
    },
  },
  {
    name: 'list_files', title: 'List workspace files',
    description: 'Lists every file in the project workspace with sizes.',
    inputSchema: obj({ project: PROJECT }, ['project']), annotations: { readOnlyHint: true },
    run: async (a, c) => { const p = await ownedProject(c.env, c.user, a.project), files = await listFiles(c.env, p.id); return { files: files.map((f) => ({ path: f.path, bytes: f.size })), total_bytes: files.reduce((x, f) => x + f.size, 0) }; },
  },
  {
    name: 'delete_files', title: 'Delete files',
    description: 'Deletes files from the project workspace. Versions that were already deployed keep their own copies.',
    inputSchema: obj({ project: PROJECT, paths: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['project', 'paths']), annotations: { destructiveHint: true },
    run: async (a, c) => { const p = await ownedProject(c.env, c.user, a.project); const deleted = []; for (const path of a.paths || []) if (await deleteFile(c.env, p.id, String(path))) deleted.push(path); return { deleted }; },
  },
  {
    name: 'apply_template', title: 'Copy a starter template into the project',
    description: 'Copies a starter template into the workspace, overwriting files with the same paths. Use it to (re)start from a known-good base.',
    inputSchema: obj({ project: PROJECT, template: { type: 'string' } }, ['project', 'template']),
    run: async (a, c) => { const p = await ownedProject(c.env, c.user, a.project); return { files: await applyTemplate(c.env, p, String(a.template)) }; },
  },
  {
    name: 'create_upload_url', title: 'Get a direct upload URL',
    description: 'Returns a short-lived URL for uploading files straight from a shell with curl, without passing their contents through this conversation. Use it when you have a terminal and the files are large, binary, or many (a zip of the whole folder works). Valid for 30 minutes.',
    inputSchema: obj({ project: PROJECT }, ['project']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project), t = randomToken(24);
      await c.env.DB.prepare('INSERT INTO uploads (token_hash, project_id, user_id, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(t), p.id, c.user.id, now() + 30 * 60000).run();
      const base = `${c.origin}/api/upload/${t}`;
      return {
        expires_in_minutes: 30,
        one_file: `curl -fsS -X PUT --data-binary @index.html "${base}?path=index.html"`,
        whole_folder: `zip -qr /tmp/game.zip . -x '.*' && curl -fsS -X POST --data-binary @/tmp/game.zip "${base}/zip"`,
        note: 'Paths inside the zip become paths in the workspace. Add ?clean=1 to the zip URL to delete workspace files that are not in the zip. Each call prints JSON listing what was written.',
      };
    },
  },
  {
    name: 'set_cover', title: 'Set the cover image',
    description: 'Uses an image file from the workspace (png, jpg or webp, ideally 16:9, under 2 MB) as the marketplace cover. Without a cover, the verification screenshot is used.',
    inputSchema: obj({ project: PROJECT, path: { type: 'string', description: 'Workspace path of the image.' } }, ['project', 'path']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project), path = cleanPath(a.path) || '', ext = extOf(path);
      if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) throw bad('The cover must be a png, jpg or webp file.');
      const { row, bytes } = await readFile(c.env, p.id, path);
      if (row.size > 2 * 1024 * 1024) throw bad('The cover must be under 2 MB.');
      const key = `covers/${p.id}-${now().toString(36)}.${ext}`;
      await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: row.ctype } });
      await c.env.DB.prepare('UPDATE projects SET cover_key = ? WHERE id = ?').bind(key, p.id).run();
      return { ok: true, cover: `${c.origin}/api/media/${key}` };
    },
  },
  {
    name: 'check_project', title: 'Static checks',
    description: 'Checks the workspace without deploying: JavaScript syntax (with the exact line), imports that do not resolve, files referenced but missing, the GCP.ready() contract, and size limits. It is fast, so run it after every round of edits and fix every error before deploy_preview.',
    inputSchema: obj({ project: PROJECT }, ['project']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project), r = await checkProject(c.env, p, c.origin);
      return { ok: r.ok, files: r.files, bytes: r.bytes, errors: r.errors.map(issueLine), warnings: r.warnings.map(issueLine), next: r.ok ? 'No errors. Call deploy_preview.' : 'Fix the errors above, then run check_project again.' };
    },
  },
  {
    name: 'deploy_preview', title: 'Deploy a preview and verify it',
    description: 'Freezes the workspace as a new numbered version, deploys it as its own Cloudflare Worker (the preview), then opens it in a real browser and checks that it boots, renders, survives input and throws no errors. If the game registered GCP.test.onPlaythrough, the browser also runs that script and the report lists each step; without one, the report says that only start-up, rendering and input were checked. Returns the verification report. The check takes one to two minutes; if it is still running after 80 seconds the answer says not_finished, and get_version returns the report (do not deploy again meanwhile). The user can play the preview from their console.',
    inputSchema: obj({ project: PROJECT, note: { type: 'string', description: 'What changed in this version (shown in the version list).' } }, ['project']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project);
      const check = await checkProject(c.env, p, c.origin);
      if (!check.ok) return { deployed: false, reason: 'Static checks failed, so nothing was deployed.', errors: check.errors.map(issueLine), next: 'Fix the errors, then call deploy_preview again.' };
      const busy = await c.env.DB.prepare("SELECT n FROM versions WHERE project_id = ? AND status IN ('queued','deploying','verifying') AND created_at > ?").bind(p.id, now() - 10 * 60000).first<{ n: number }>();
      if (busy) throw new AppError(409, `Version ${busy.n} is still being deployed.`, 'busy', `Call get_version {project, version: ${busy.n}} and wait for it to finish first.`);
      const v = await snapshot(c.env, p, check.manifest, String(a.note || ''));
      await logEvent(c.env, p.id, 'preview_requested', String(a.note || ''), v.n, c.client);
      await enqueue(c.env, { kind: 'preview', pid: p.id, n: v.n, origin: c.origin, actor: c.client });
      const done = await waitVersion(c, p.id, v.n, 80000);
      return { deployed: true, warnings: check.warnings.map(issueLine), ...(await versionReport(c, p, v.n, done)) };
    },
  },
  {
    name: 'get_version', title: 'Version status and verification report',
    description: 'Returns a version\'s deploy and verification status with the full report: each check, uncaught errors, missing files, load time, frame rate and a screenshot URL. Omit version for the newest one.',
    inputSchema: obj({ project: PROJECT, version: { type: 'integer' } }, ['project']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project);
      const n = Number(a.version) || (await c.env.DB.prepare('SELECT MAX(n) AS n FROM versions WHERE project_id = ?').bind(p.id).first<{ n: number }>())?.n || 0;
      if (!n) throw bad('This project has no versions yet.', 'Call deploy_preview first.');
      return versionReport(c, p, n, await waitVersion(c, p.id, n, 40000));
    },
  },
  {
    name: 'list_versions', title: 'List versions',
    description: 'Lists the project\'s versions, newest first, with status and which one is live and which is on preview.',
    inputSchema: obj({ project: PROJECT }, ['project']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project), s = await getSettings(c.env);
      const rows = await c.env.DB.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY n DESC LIMIT 50').bind(p.id).all<any>();
      return { live_version: p.live_version, preview_version: p.preview_version, status: p.status, versions: rows.results.map((v) => ({ version: v.n, note: v.note, status: v.status, summary: v.stage, can_publish: versionEligible(v, s.verify_browser_required).ok, created_at: new Date(v.created_at).toISOString(), live: v.n === p.live_version && p.status === 'live' })) };
    },
  },
  {
    name: 'publish', title: 'Publish a verified version',
    description: 'Makes a verified version live in the marketplace (deployed as the game\'s live Worker). Only versions that passed verification can be published, and the account needs a creator license. Omit version to publish the newest verified one. Also use this to roll back: pass an older verified version number.',
    inputSchema: obj({ project: PROJECT, version: { type: 'integer', description: 'Version to make live. Default: newest verified.' } }, ['project']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project), s = await getSettings(c.env);
      if (s.creator_fee_required && !c.user.creator) throw forbidden(`Publishing needs the one-time ${usd(s.creator_fee_cents)} creator license.`, `Ask the user to buy it at ${c.origin}/console, then call publish again. Preview stays available meanwhile.`);
      if (p.status === 'removed') throw forbidden('This game was removed by the platform and cannot be published.');
      let v = a.version ? await getVersion(c.env, p.id, Number(a.version)) : null;
      if (!a.version) {
        const rows = await c.env.DB.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY n DESC LIMIT 20').bind(p.id).all<any>();
        v = rows.results.find((x) => versionEligible(x, s.verify_browser_required).ok) || rows.results[0] || null;
      }
      if (!v) throw bad('There is no version to publish.', 'Call deploy_preview first.');
      const el = versionEligible(v, s.verify_browser_required);
      if (!el.ok) throw new AppError(409, el.reason, 'not_verified', 'Call get_version to read the failed checks, fix them, and deploy_preview again.');
      if (!p.tagline && !p.description) await updateProjectMeta(c.env, p, { tagline: p.title });
      await logEvent(c.env, p.id, 'publish_requested', '', v.n, c.client);
      await enqueue(c.env, { kind: 'publish', pid: p.id, n: v.n, origin: c.origin, actor: c.client });
      const end = Date.now() + 45000;
      let q = await ownedProject(c.env, c.user, p.id);
      while (!(q.status === 'live' && q.live_version === v.n) && Date.now() < end) { await sleep(2000); q = await ownedProject(c.env, c.user, p.id); }
      const live = q.status === 'live' && q.live_version === v.n;
      return { live, version: v.n, game_page: `${c.origin}/g/${p.slug}`, price: q.price_cents ? usd(q.price_cents) : 'free', next: live ? 'The game is live. Share the game page with the user.' : 'Going live is taking longer than usual (a first deploy needs a minute). Call get_project in a little while to confirm.' };
    },
  },
  {
    name: 'rollback', title: 'Roll back to an earlier version',
    description: 'Makes an earlier verified version live again. Same as publish with that version number.',
    inputSchema: obj({ project: PROJECT, version: { type: 'integer' } }, ['project', 'version']),
    run: async (a, c) => TOOLS.find((t) => t.name === 'publish')!.run(a, c),
  },
  {
    name: 'unpublish', title: 'Take a game offline',
    description: 'Takes the live game out of the marketplace and removes its live Worker. Versions and the preview stay; publish puts it back.',
    inputSchema: obj({ project: PROJECT }, ['project']), annotations: { destructiveHint: true },
    run: async (a, c) => { const p = await ownedProject(c.env, c.user, a.project); if (p.status !== 'live') throw bad('This game is not live.'); await takeOffline(c.env, p, c.client); return { ok: true, status: 'offline' }; },
  },
  {
    name: 'get_stats', title: 'Marketplace numbers and runtime errors',
    description: 'Returns how the published game is doing: plays, play time, ratings and recent reviews, sales, and errors reported from real players\' browsers (useful for fixing bugs that verification did not hit).',
    inputSchema: obj({ project: PROJECT }, ['project']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project), db = c.env.DB;
      const [daily, errors, reviews, sales] = await Promise.all([
        db.prepare('SELECT day, sessions, plays, seconds FROM game_daily WHERE project_id = ? AND day >= ? ORDER BY day').bind(p.id, addDays(dayOf(now()), -13)).all<any>(),
        db.prepare('SELECT version, env, message, count FROM client_errors WHERE project_id = ? ORDER BY last_at DESC LIMIT 15').bind(p.id).all(),
        db.prepare('SELECT rating, body FROM reviews WHERE project_id = ? AND hidden = 0 ORDER BY updated_at DESC LIMIT 10').bind(p.id).all(),
        db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(net_cents), 0) AS net FROM purchases WHERE project_id = ? AND status = 'paid'").bind(p.id).first<{ n: number; net: number }>(),
      ]);
      return {
        status: p.status, live_version: p.live_version, plays: p.plays, minutes_played: Math.round(p.seconds / 60), rating: p.rating_count ? +(p.rating_sum / p.rating_count).toFixed(2) : null, ratings: p.rating_count,
        price: p.price_cents ? usd(p.price_cents) : 'free', sales: sales?.n || 0, creator_earnings: usd(sales?.net || 0),
        last_14_days: daily.results.map((d) => ({ day: d.day, sessions: d.sessions, plays: d.plays, minutes: Math.round(d.seconds / 60) })),
        runtime_errors: errors.results, recent_reviews: reviews.results,
      };
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Pipeline recommendation: plain rules distilled from the reference games.
// ---------------------------------------------------------------------------------------------
function recommend(a: Record<string, any>) {
  const text = String(a.description || '').toLowerCase();
  const has = (...w: string[]) => w.some((x) => text.includes(x));
  const dim = a.dimension || (has('2d', 'top-down', 'topdown', 'platformer', 'pixel', 'card', 'puzzle', 'board', 'sprite', 'side-scroll') ? '2d' : has('isometric', '2.5d') ? '2.5d' : '3d');
  const mobile = (a.devices || 'both') !== 'desktop';
  const lights = Number(a.dynamic_lights) || 0, world = a.world || (has('open world', 'open-world', 'survival', 'explore', 'island', 'terrain') ? 'open-world' : 'level');
  const gpuSim = has('fluid', 'million', 'gpu simulation', 'compute shader', 'cellular');
  const out: Record<string, unknown> = {};
  if (dim === '2d' || dim === '2.5d' && !has('3d model', 'rotate camera')) {
    out.pipeline = 'canvas2d';
    out.why = ['A 2D canvas draws thousands of pre-baked sprites per frame on any device, starts instantly, and has no shader or GPU-driver failure modes.', 'Depth is a sort by ground position; lighting is a multiply layer. Both are a few lines.'];
    out.start_from = { world: 'For a top-down or 2.5D world, design_scene {description, camera: "2d"} writes a complete starting game on @gcp/craft2d.js: painted land, 30 kinds of sprites, animated people and animals, darkness with lights, weather. list_blocks {group: "world2d"} shows the parts.', template: 'canvas2d-arcade', kits: ['@gcp/craft2d.js', '@gcp/core.js', '@gcp/canvas2d.js', '@gcp/input.js'], blocks: "createHud from '@gcp/hud.js' (interface), createSound from '@gcp/sound.js' (effects, ambience, music), and from '@gcp/procgen.js': paint(kind).toCanvas() for tiles and patterns, noise() for maps and variation, rng(seed) for repeatable levels" };
    out.frame = ['update(dt) with dt clamped to 0.1 s', 'draw cached ground chunks', 'draw sprites sorted by y', 'draw lighting/fog overlay', 'DOM HUD on top'];
    out.avoid = ['Drawing vector paths every frame: bake each sprite once into an offscreen canvas and drawImage it.', 'Reading pixels back (getImageData) in the frame loop.', 'A canvas larger than devicePixelRatio 2: cap it.'];
    out.guides = ['platform-contract', 'rendering-pipelines', 'loading', 'input', 'performance'];
  } else if (gpuSim) {
    out.pipeline = 'webgpu (with a WebGL fallback or creator-qualified verification)';
    out.why = ['GPU compute is the only way to run that much simulation per frame.', 'The verification browser has no WebGPU, so either ship a reduced WebGL path or qualify the version by playing the preview yourself.'];
    out.start_from = { template: 'blank', kits: ['@gcp/core.js', '@gcp/input.js'] };
    out.avoid = ['Assuming navigator.gpu exists: feature-detect, and call GCP.fatal with a clear message when it does not.', 'Creating pipelines inside the frame loop.'];
    out.guides = ['platform-contract', 'rendering-pipelines', 'performance', 'troubleshooting'];
  } else {
    const deferred = lights > 8 || has('many lights', 'ssao', 'screen-space', 'deferred');
    const post = !deferred && (a.look === 'stylized-lit' || a.look === 'realistic' || has('bloom', 'glow', 'neon', 'cinematic'));
    out.pipeline = deferred ? 'three-forward first, custom deferred as a quality tier' : post ? 'three-forward + post-processing' : 'three-forward';
    out.why = deferred
      ? ['More than about 8 moving lights, or effects that need depth and normals (SSAO, screen-space water), are what a G-buffer is for.', 'Build and ship the forward path first as the "low" tier: it is the fallback for phones and the path verification will exercise. Add the deferred path behind a quality setting once the game is playable.']
      : ['One forward pass with a shadowed sun, hemisphere ambient and fog renders stylised worlds well and runs everywhere, including the software GPU used by verification.', post ? 'Add bloom and tone mapping through EffectComposer on medium quality and above; keep "low" as the plain pass.' : 'Skip post-processing until the game is playable; it is easy to add later and costly on phones.'];
    out.start_from = { plan: 'design_scene {description}: picks building blocks for the whole game and returns starting files made of them', blocks: "@gcp/craft.js: createStage sets up this exact pipeline (shadowed sun, hemisphere light, fog, tone mapping, bloom on fast devices, a lighter profile on slow ones); surface, terrain, tree, prop, humanoid and the rest fill the world. list_blocks shows them all.", or_your_own_renderer: 'template three-blank (renderer, lights, loop, input and GCP.ready() in one file) with @gcp/core.js, @gcp/three-kit.js, @gcp/input.js; the blocks that do not need a stage still work there (surface, prop, tree, humanoid, createHud, createSound)' };
    out.frame = ['update(dt) with dt clamped to 0.1 s', world === 'open-world' ? 'stream chunks: build at most a few per frame from a queue, dispose far ones' : 'update animated objects', 'move the shadow camera with the player', post ? 'composer.render()' : 'renderer.render(scene, camera)', 'DOM HUD on top'];
    out.budget = { pixel_ratio: mobile ? 'min(devicePixelRatio, 1.5); 1 on low' : 'min(devicePixelRatio, 2)', draw_calls: mobile ? 'under 150' : 'under 400', shadow_map: mobile ? 1024 : 2048, lights: 'one shadow-casting directional light; up to 4 point lights without shadows' };
    out.avoid = ['One Mesh per tree, rock or blade: use InstancedMesh, or merge static parts into one geometry with vertex colours.', 'New materials or textures per object: cache and share them.', 'Allocating vectors inside the frame loop.', 'Loading assets over the network when a painted texture (surface(kind)) or generated geometry will do.', 'Flat single-colour materials on bare primitives: they are the main thing that makes a game look unfinished. surface(kind) and the model blocks fix it in one call.', 'Shadows on every light.'];
    out.guides = ['platform-contract', 'rendering-pipelines', 'performance', 'loading', 'input', 'meshes', 'materials-textures', 'animation'];
    out.verification_browser = 'It has no GPU and draws 960x540 on the CPU. A forward pass with one shadowed light and simple materials runs at about 4 fps there, which passes (the floor is 2). Full-screen post-processing, several shadow lights or heavy fragment shaders at default quality can fail: start on the lowest quality when frames are slow. See the performance guide.';
  }
  out.multiplayer = a.multiplayer || has('multiplayer', 'co-op', 'coop', 'versus', 'pvp') ? { use: 'GCP.room(code) with one host that owns the world state; guests send inputs and render snapshots', kit: '@gcp/net.js', guide: 'multiplayer' } : undefined;
  out.quality = 'deploy_preview returns a craft score out of 100 measured from the running game, with the specific things to improve.';
  out.always = ['Show a boot screen at once and report GCP.progress; call GCP.ready() after the first playable frame.', 'Offer quality levels and pick a low one automatically on touch devices or when frames are slow.', 'Wrap startup in try/catch and call GCP.fatal(error) so failures are reported instead of a blank page.', 'Register GCP.test.onPlaythrough with a short script that plays the core loop to its end (score, win or lose, restart). The verifier runs it, so bugs in the rules are caught before the user plays.'];
  out.note = 'This is a starting point chosen for reliability. Art direction, camera, mechanics and feel are entirely up to you.';
  return out;
}

/** Unzips an uploaded archive into the workspace. */
export async function importZip(env: Env, user: User, projectId: string, zip: Uint8Array, clean: boolean) {
  const p = await ownedProject(env, user, projectId);
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(zip); } catch (e) { throw bad(`Not a readable zip file: ${(e as Error).message}`); }
  let names = Object.keys(entries).filter((n) => !n.endsWith('/') && !n.startsWith('__MACOSX/'));
  // If everything sits in one top-level folder, strip it so index.html lands at the root.
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const strip = tops.size === 1 && names.every((n) => n.includes('/')) && !names.includes('index.html') ? [...tops][0] + '/' : '';
  const written: string[] = [], skipped: string[] = [];
  for (const n of names) {
    const path = cleanPath(strip ? n.slice(strip.length) : n);
    if (!path) { skipped.push(n); continue; }
    await putFile(env, p, path, entries[n]);
    written.push(path);
  }
  let removed: string[] = [];
  if (clean) { const keep = new Set(written); for (const f of await listFiles(env, p.id)) if (!keep.has(f.path)) { await deleteFile(env, p.id, f.path); removed.push(f.path); } }
  return { written, skipped, removed, next: 'Run check_project.' };
}
void gameUrl; void parseJson;

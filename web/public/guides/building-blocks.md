# Building blocks

A game looks unfinished for a short list of reasons that have nothing to do with its idea: flat single-colour boxes, one light, an empty world, nothing moving, no sound, no interface. The platform measures exactly those things after every `deploy_preview` (the craft score, below) and hosts a building block that removes each of them in one call.

A block is a function that returns something finished: a lit stage, a painted material, a tree made of thirty shaped parts, a house, an animated character, a HUD. Everything is generated in code from options and a seed, so there is nothing to download, nothing to model, and the result is the same on every device. Blocks are ordinary Three.js objects: they mix freely with your own meshes, materials and shaders, and you can use one of them or all of them.

```js
import { createStage, terrain, tree, scatter, prop, place, humanoid, control, createHud, createSound } from '@gcp/craft.js';
```

Three tools cover them:

- `design_scene {description}`: picks blocks for every part of a 3D game and returns a complete starting game made of them.
- `list_blocks`: every block with a one-line summary, and every valid name (moods, surfaces, trees, props, characters, animals, sounds).
- `get_block {name}`: the full options of one block. It also accepts a method (`hud.title`) or a value (`campfire`).

`{{ORIGIN}}/lab` shows every block live in a browser.

## How the blocks fit together

| Part of the game | Block | What it gives you |
|---|---|---|
| Frame around everything | `createStage(canvas, { mood, weather })` | renderer, sky gradient with drifting faceted clouds, sun with a shadow that follows the action, a mirrored sky for shiny and wet surfaces, hemisphere light, matching fog, tone mapping, weather particles, wind, quality that adapts to the device; `stage.run(update)` is the frame loop and calls `GCP.ready()` |
| Ground | `terrain({ shape, palette, seed })`, `water()` | a coloured, textured height field with `land.heightAt(x, z)` and `land.randomPoint(rand)`; moving water |
| Surfaces | `surface(kind, { color, repeat, relief })`, `block()`, `floor()` | 39 painted, tiling materials (brick, planks, cobble, bark, metal, lava, ...) in any colour |
| Scenery | `tree()`, `rock()`, `bush()`, `groundCover()`, `grassField()` | "kinds": shapes built from many parts, merged into one or two draw calls each |
| Things | `prop(kind)` | 46 buildings, pieces of furniture, lights and pickups, also as kinds |
| Putting kinds in the world | `place(kind, x, y, z)`, `scatter(kinds, { count, heightAt, where })` | one copy, or hundreds as instances; `scatter` returns `solids` for collision |
| Characters | `humanoid({ preset })`, `animal(kind)` | jointed models with `actor.animate('walk', dt)` and one-shots like `actor.play('cheer')` |
| Player and camera | `control(actor, { input, heightAt, solids })` | movement, running, jumping, collision and a follow camera; `player.moveTo(x, z)` for play-throughs |
| Other creatures | `wander(actor, { flee, chase, onReach })` | walking around, running away, hunting |
| Feedback | `createFx()` | bursts, sparkles, smoke, confetti, floating text |
| Interface | `createHud()` | counters, bars, timer, objective, hints, toasts, a title screen and an end screen |
| Sound | `createSound()` | 28 effects, 10 ambiences, 8 music moods, no audio files |

A **kind** is the one idea to learn: `tree()`, `rock()`, `bush()`, `groundCover()` and `prop()` do not return a mesh, they return a description (merged geometry + materials + size) that `place` and `scatter` turn into objects. That is why two hundred trees cost a handful of draw calls.

## A complete small game

This is a whole game: a world, a hero, creatures, a goal, a clock, sound, touch controls, a start and an end screen, and a play-through. `design_scene` writes a longer version of this for your description.

```js
import { run, createStage, terrain, water, tree, rock, bush, groundCover, scatter, grassField, place, prop,
  humanoid, animal, control, wander, createFx, createHud, createSound, createInput, rng } from '@gcp/craft.js';

run(async (boot) => {
  await boot.step(0.2, 'Setting the stage');
  const stage = createStage('#view', { mood: 'golden-hour', weather: 'motes' });
  const land = terrain({ shape: 'island', seed: 'ember', clearing: { x: 0, z: 0, r: 9 } });
  water({ level: 0 });
  const dry = (x, z, y, slope) => y > 1 && slope < 0.8;

  await boot.step(0.5, 'Growing the forest');
  const forest = scatter([tree({ species: 'oak' }), tree({ species: 'pine' }), tree({ species: 'birch' }), rock(), rock({ seed: 3, moss: true })],
    { count: 170, radius: 100, heightAt: land.heightAt, where: dry, minDistance: 3.5, avoid: [{ x: 0, z: 0, r: 11 }] });
  scatter([bush(), groundCover('fern'), groundCover('flower'), groundCover('mushrooms'), groundCover('stones')],
    { count: 280, radius: 100, heightAt: land.heightAt, where: dry });
  grassField({ count: 5000, radius: 55, heightAt: land.heightAt, where: dry });
  place(prop('house', { roof: 'rooftile' }), 6, land.heightAt(6, -6), -6, { rotY: -0.5 });
  place('campfire', -1.5, land.heightAt(-1.5, 2.5), 2.5);

  await boot.step(0.8, 'Waking the wildlife');
  const hero = humanoid({ preset: 'explorer' }); stage.scene.add(hero);
  const input = createInput(stage.renderer.domElement), sound = createSound(), fx = createFx(), hud = createHud();
  const player = control(hero, { input, heightAt: land.heightAt, solids: [...forest.solids, { x: 6, z: -6, r: 4 }], minY: 0.3, bounds: 105, onStep: () => sound.play('step') });
  const rand = rng('ember-life');
  for (const kind of ['deer', 'rabbit', 'fox', 'bird']) {
    const a = animal(kind); a.position.copy(land.randomPoint(rand, { minRadius: 12, maxRadius: 70 })); stage.scene.add(a);
    wander(a, { heightAt: land.heightAt, flee: a.flies ? null : hero });
  }

  const state = { playing: false, over: false, found: 0 }, gems = [];
  for (let i = 0; i < 10; i++) { const p = land.randomPoint(rand, { minRadius: 14 + i * 3, maxRadius: 30 + i * 5 }); gems.push(place(prop('gem', { color: 0xff7a3a }), p.x, p.y + 0.3, p.z)); }
  const count = hud.counter('Embers', { value: 0 }), clock = hud.timer({ seconds: 240, onEnd: () => finish(false) }).stop();
  function finish(win) {
    if (state.over) return; state.over = true; state.playing = false; player.enabled = false; clock.stop(); sound.play(win ? 'win' : 'lose');
    hud.end({ win, title: win ? 'The isle glows again' : 'Night has fallen', stats: { Embers: state.found + ' / 10' }, onRestart: () => location.reload() });
  }

  stage.run((dt) => {
    player.update(dt);
    if (state.playing) for (const g of gems) {
      if (!g.visible || Math.hypot(g.position.x - hero.position.x, g.position.z - hero.position.z) > 1.5) continue;
      g.visible = false; state.found++; count.set(state.found); fx.sparkle(g, 0xffa040); sound.play('pickup');
      if (state.found === 10) finish(true);
    }
    input.endFrame();
  });
  boot.done();

  player.enabled = false;
  hud.title({ title: 'Ember Isle', subtitle: 'Find the ten ember gems before night falls', controls: 'WASD or arrows, drag to look, Shift runs, Space jumps',
    onStart: () => { state.playing = true; player.enabled = true; clock.start(); sound.ambience('forest'); sound.music('adventure'); stage.setMood('dusk', 240); } });

  GCP.test.onAutostart(() => hud.start());
  GCP.test.onPlaythrough(async (t) => {
    t.step('start the game'); if (hud.screenOpen) hud.start(); await t.frames(3); t.assert(state.playing, 'the game is running');
    t.step('walk to a gem'); player.teleport(gems[0].position.x + 1.8, gems[0].position.z); await player.moveTo(gems[0].position.x, gems[0].position.z, 6); await t.frames(2); t.assert(state.found === 1, 'a gem was collected');
    t.step('collect the rest'); for (const g of gems.slice(1)) { player.teleport(g.position.x, g.position.z); await t.frames(2); } t.assert(state.found === 10, 'all ten collected');
    t.step('the win screen shows'); await t.until(() => state.over && hud.screenOpen, 5000); t.assert(hud.screenOpen, 'the end screen is open');
  });
});
```

The page around it is a canvas and a module script:

```html
<canvas id="view" style="position:fixed;inset:0;width:100%;height:100%"></canvas>
<script type="module" src="src/main.js"></script>
```

## Mixing blocks with your own code

Nothing is all-or-nothing.

- **Your own models with painted surfaces.** `new THREE.Mesh(tbox(4, 3, 0.3), surface('brick'))` is a wall: `tbox`, `tplane` and `tcylinder` are primitives whose texture keeps one real-world size on every face. `surface(kind, { color: 0x8a5a3a, relief: 2 })` repaints any surface and adds a normal map.
- **Your own kinds.** Build parts with `mergeParts([[geometry, colour, matrix], ...])` and hand `{ parts: [{ geometry, material }], radius, height }` to `place` or `scatter`. The procedural-generation guide shows how.
- **Your own renderer.** `surface`, `tree`, `prop`, `humanoid`, `createHud` and `createSound` do not need a stage. `place(kind, x, y, z, { scene })` and `scatter(scene, kinds, opts)` take your scene.
- **Other engines and 2D.** `@gcp/hud.js` and `@gcp/sound.js` are plain DOM and WebAudio. From `@gcp/procgen.js`, `paint(kind).toCanvas()` gives any painted texture as a canvas for tiles and patterns, `noise()` gives maps and variation, `rng(seed)` gives repeatable levels.
- **Change a block.** `get_kit_file {file: "craft/props.js"}` returns the source. Copy it into your bundle and edit it.

## 2D and 2.5D worlds

`@gcp/craft2d.js` does for a flat world what the blocks above do for a 3D one. The view is from above with upright things (trees, houses and people stand up and overlap by their feet), the look of survival, farming and adventure games. `design_scene {description, camera: "2d"}` writes a complete game with it; a description that says 2D, 2.5D, pixel or isometric picks it by itself.

```js
import { run, createStage2d, ground2d, sprite2d, scatter2d, actor2d, control2d, wander2d, createHud, createSound, createInput } from '@gcp/craft2d.js';

const stage = createStage2d('#view', { mood: 'night', weather: 'fireflies' });   // the same mood and weather names as in 3D
const land = ground2d({ seed: 'vale', palette: 'temperate' });                   // water, shore, grass, dirt paths, stone
const { solids } = scatter2d([sprite2d('tree', { species: 'oak' }), sprite2d('tree', { species: 'pine' }), sprite2d('rock')], { count: 500, radius: 56, minDistance: 1.9 });
stage.add(sprite2d('campfire'), 2, 1);                                            // fires, lanterns and lamps light the dark
const hero = actor2d('explorer'), input = createInput(stage.canvas), player = control2d(hero, { input, solids });
const deer = actor2d('deer', { x: 6, y: 3 }); wander2d(deer, { flee: hero });
stage.run((dt) => { player.update(dt); input.endFrame(); });
```

| You need | Call | What you get |
|---|---|---|
| The frame around everything | `createStage2d(canvas, { mood, weather })` | canvas sized for the device, a camera that follows `stage.focus`, depth sorting, soft shadows, moods that really darken the picture, lights that cut through it, weather, wind in the trees, `stage.fx` (bursts, rings, floating text, confetti) |
| Land | `ground2d({ seed, palette })` | painted per pixel from noise and cached in chunks: lakes with foam at the shore, sand, grass in two tones, dirt paths, stone, tufts and flowers; `walkable(x, y)`, `kindAt(x, y)`, `randomPoint(rand)` |
| Things | `sprite2d(kind, opts)` | 30 outlined, shaded kinds painted once each: trees by species, rocks, bushes, houses, camp props, lights, pickups |
| Many things | `scatter2d(kinds, { count, radius, minDistance, avoid })` | hundreds placed by rule; returns the solid ones for collision |
| People and animals | `actor2d(kind)` | drawn from parts every frame, so they walk, turn four ways, cheer and flinch with no sprite sheets |
| Movement | `control2d(hero, { input, solids })`, `wander2d(actor, { flee, chase, onReach })` | keyboard and touch movement with collision and a following camera; creatures that stroll, flee or hunt |

Your own art mixes in: `bake(w, h, draw)` from the same module turns any canvas drawing into a sprite for `stage.add`, and `stage.ctx` is the plain 2D context.

## Games with depth: controls, interface and systems

A world that looks finished still needs things to do. The `play` group holds the systems most games with depth share,
as plain data and DOM, so the same code serves 2D and 3D. Both `@gcp/craft.js` and `@gcp/craft2d.js` export them.
`design_scene` with goal `homestead` writes a complete game on all of them; the parts also work one at a time.

**Controls.** Name the actions once and ask for them by name. Keyboard, mouse buttons, on-screen buttons on phones
and a gamepad then all trigger the same code, and prompts show the right key for the device in use.

```js
input.bind({ interact: ['KeyE'], attack: ['Space', 'Mouse0'], bag: ['Tab', 'KeyI'], run: ['ShiftLeft'] },
  { touch: { interact: 'E', attack: '⚔', bag: '▦' }, pad: { interact: 0, attack: 2, bag: 3, run: 10 }, bottom: 96 });
if (input.action('attack')) swing();          // pressed this frame, on any device
hud.prompt(input.keyOf('interact'), 'Open');  // "E", the touch label, or "A" on a gamepad
```

`control()` and `control2d()` ease in and out of movement, slide along solids, run on the action named `run`, take
`canRun: () => needs.get('stamina') > 3`, and give `player.ahead(d)`: the spot in front of the hero, where to place or hit.

**Systems.** Each is one call and they fit each other:

```js
const inv = createInventory({ slots: 24, hotbar: 8, items: { berry: { food: 12 }, axe: { tool: 'axe', stack: 1 } }, start: { berry: 3 } });
const craft = createCrafting(inv, [{ makes: 'axe', needs: { wood: 3, stone: 2 } }, { makes: 'cooked_meat', needs: { meat: 1 }, station: 'campfire' }]);
const needs = createNeeds({ health: { max: 100 }, food: { max: 100, drain: 0.5, empty: { health: -3 } }, stamina: { max: 100, regen: 16 } });
const clock = createClock({ dayLength: 300, hour: 10, stage });      // the stage's light follows the hour, in 2D and 3D
const nodes = createNodes();                                          // every scattered tree and rock becomes harvestable:
nodes.fromScatter(forest.items, (it) => it.type === 'tree' && { label: 'Chop the tree', hp: 4, drops: { wood: [2, 3] }, respawn: 120 });
const interact = createInteract({ nodes, input, hud, inventory: inv, at: () => ({ x: hero.position.x, y: hero.position.z }) });
const build = createBuilder({ grid: 2, inventory: inv, solids, pieces: { campfire: { cost: { campfire: 1 }, station: true, make: (x, z) => place('campfire', x, land.heightAt(x, z), z) } } });
const quests = createQuests([{ id: 'wood', text: 'Chop trees for 4 wood', done: () => inv.has('wood', 4) }]);
const save = createSave('world', { inv, needs, clock, build, quests });   // the player's cloud save; save.auto(20)
```

Every frame: `clock.update(dt); needs.update(dt); nodes.update(dt); quests.update(); interact.update();`. The ground
plane is `x, y` in these systems; in a 3D game pass `z` as `y`. A harvested tree disappears from the picture and from
collision by itself and grows back after `respawn` seconds, because `scatter()` and `scatter2d()` items have `visible`.
For floors and stairs give a piece a `height` and the controller `heightAt: (x, z) => land.heightAt(x, z) + build.topAt(x, z)`.

**Storeys and rooms.** Give pieces a `layer` ('floor', 'wall', 'roof') and a floor, a wall and a roof share one cell;
`build.place(kind, x, z, { level: 1 })` builds a storey up (`levelHeight`, default 3). `build.topAt(x, z, fromY)` gives
the highest top the hero can step onto from where it stands, so floors carry it; `stairsPiece({ grid, cost, make })` and `rampPiece()` are standard pieces that take it up (drawn in 3D with `prop('stairs')` and `prop('ramp')`; `build.place('stairs', x, z, { dir: 1 })` turns one).  In a
room, `createWorldSync` below keeps every player's world the same. `createSave(key, parts, { cloud: false })` keeps a world on
the host's device only, and `lobbyUI()` returns a promise with `solo()`, `host(code)` and `join(code)` for tests.

**Farming.** `createCrops` plants on a grid; a crop grows through four stages and is harvested through the same
nodes and prompt as a tree, so `createInteract` needs nothing new:

```js
const crops = createCrops({ nodes, grid: 1, water: true, make: cropSprites(),   // cropModels(land) in 3D
  types: { wheat: { seed: 'seed', grow: 90, yields: { wheat: [2, 3], seed: [1, 2] } }, berry: { seed: 'berry', grow: 60, regrow: true } } });
crops.plant('wheat', ...player.ahead(1), { inventory: inv });   // takes a seed;  crops.water(x, y);  crops.update(dt) every frame
```

**A world that grows as the player explores.** `chunks2d` (2D, with `ground2d({ size: Infinity })`) and
`terrainChunks` (3D: the land itself is cut into chunks) fill each chunk by your `fill(chunk)` the first time the
player comes near and empty it when they walk away. A chunk always fills the same way, so the world is endless and
the same on every visit and every device; `forget(item)` keeps a felled tree felled, and `toJSON()` saves that list. `stage.add(soil, x, y, { flat: true })` draws a flat thing (a tilled plot, a rug) under everything that stands; `terrainChunks` takes a `clearing` and `ch.place(kind, x, z, { key })` lists a placed thing so it can be a node.

```js
const world = chunks2d({ seed: SEED, chunk: 16, fill: (ch) => { nodes.fromScatter(ch.scatter([sprite2d('tree')], { count: 14 }).items, treeRule); } });
world.onUnload((ch) => nodes.removeWhere((n) => n.ref && ch.items.includes(n.ref)));
const land = terrainChunks({ shape: 'rolling', seed: SEED, fill: (ch) => ch.scatter(['oak', 'rock'], { count: 30 }) });
```

**A shared world.** In a room, `createWorldSync(room, { build, nodes, crops, chunks, inventory })` makes the host decide
every change and send it to everyone, so all players see the same pieces, the same felled trees and the same crops;
each keeps their own inventory, and a late joiner gets the whole world. Alone it applies at once, so one code path
serves both. Route the prompt through it with `createInteract({ ..., send: (n, tool) => sync.use(n, { tool }) })`,
and build with `await sync.place('wall', x, y, { level })`. `sync.use(node, { tool, power })` gives `{ ok, done, drops, hp, left }` on every side (`hp` hits left, `left` the drops that did not fit), and when `send` returns that promise the prompt's `onHit` and `onGet` run when the answer comes. On an endless map the host loads the land around a far guest by itself (`chunks.ensure(x, y)`; such a chunk has `far: true`, so `fill` can skip decoration). `createLoopback(2)` gives two rooms that talk inside one
page: build two worlds from the same seed, one sync on each, act on both, and check they agree in a play-through.

**Interface.** Panels for those systems, on the same `createHud()`:

```js
needsUI(hud, needs);  questUI(hud, quests, { corner: 'tl' });  const clockView = clockUI(hud, clock);
minimapUI(hud, { center: () => hero, color: land.mapColor, markers: () => enemies });
const bar = hotbarUI(hud, inv, { input });          // number keys, the wheel and shoulder buttons select
const bag = inventoryUI(hud, inv, { crafting: craft, stations: () => build.near(hero.x, hero.y), onUse: eat });
const menu = pauseMenu(hud, { title, controls: [['WASD', 'Move'], ['E', 'Use']], onRestart });
const { mode, code } = await lobbyUI(hud, { title });   // host, join by code, or play alone, for games with rooms
```

They fit a phone held upright, on-screen buttons step aside while a window is open, and item icons are painted in
code (`ITEMS` lists the 32 built-in kinds; any other id gets a tile, or give it your own `icon`).

## Templates for farming, endless maps and two players

When a brief asks for crops, a world that grows as the player walks, or friends playing together, `design_scene`
returns a hand-written template instead of the generated starter: `homestead-2d` (painted top-down) or `homestead-3d`
(third person), also available through `apply_template`. Both have all three features plus crafting, building with
stairs, needs, day and night, a trading post, quests and saving, and a play-through that checks it all with a second
player in the same page and a two-player check over a real room (`GCP.test.onTwoPlayers`). `src/theme.js` is the game
(name, look, items, crops, pieces, the regions the land passes through, foes, quests); `src/main.js` is the engine.

`design_scene` writes `src/theme.js` for the brief, so the files are already that brief's game: its title (from the
brief; a brief that gives none gets a name made from its place and what it asks for, and `plan.title_from` says which),
its own tagline, light, set and order of regions and order of almanac steps (two briefs never get the same theme), and
the features the brief names: thirst ("food and water"), smelting (ore rock, a furnace, ingots), combat (foes at night,
a sword, loot), a building system (walls or pillars, crates, signposts), corn, saving on the host's device, up to four
players. The result lists what is `already_in_the_theme`, what is `left_for_you`, and `first_edits`: three to five
changes for this game, each as the exact `edit_file` arguments (path, old_string, new_string). Make them in order, then
go on with the rest of `left_for_you`. Until enough has changed, the report counts the game as the template
(`quality.own_work`, which repeats the edits still open under `ideas` and says how many more lines must change) and
keeps the craft score below target; `next` of `get_version` says so first, even when a check failed.

## The craft score

After a version verifies, the browser loads the game once more at full quality and takes its portrait (see the platform-contract guide). Seven things are then measured and returned as `quality`: a craft score out of 100, `look_score` for the picture alone, what was measured, and what to improve. Nothing is judged by taste and publishing never depends on it. The measures are calibrated on finished games: a hand-made open-world game with ambient occlusion, bloom and soft shadows measures look 93.

| Measured | Points | What raises it |
|---|---|---|
| Surfaces have detail (fine detail, crisp edges, share of flat fills, textures in use) | 22 | `surface(kind)`, models made of parts (`tree`, `rock`, `prop`), `grassField({ land })`, faceted `terrain` |
| Light and colour (tonal range, brightness, lighting and effect passes, colour families) | 22 | `createStage({ mood })`: a strong sun against cool shade, shadows, plus the finishing passes (light shafts, ambient occlusion, bloom, colour grade, edge smoothing) |
| The world is furnished (different shapes, triangles and materials on screen) | 18 | more kinds and more of them: several species, props that fit, `scatter` with a few hundred things |
| The world moves when the player does nothing | 8 | wind in trees and grass, `water()`, weather, bobbing pickups, idle animation |
| Sound | 8 | `createSound()`: effects on actions, an ambience, music |
| Interface and input (text on screen, loading progress, touch, keyboard, resize) | 12 | `createHud()`, `createInput()`, `run()` |
| Proven playable (a passing play-through, no console warnings) | 10 | `GCP.test.onPlaythrough` with five steps |

## On slow devices and in the verification browser

The verification browser has no GPU. `createStage` detects a CPU renderer and switches to a lighter profile by itself: lower pixel ratio, a smaller shadow map refreshed every third frame, nearer fog, no point lights, a fifth of the grass, no finishing passes. That profile is only for the checks. The picture of the game is taken separately at full quality (`GCP.portrait`), so a light profile costs nothing in how the game is shown or scored. On real devices the stage starts from a quality guess and `stage.run` adapts it to the measured frame rate: it drops ambient occlusion first, then the other finishing passes, then resolution. You do not need to write a second path. A scene that stays comfortable: a few hundred large scattered things, about five hundred small ones, grass over a 50 m radius, a handful of animated creatures, and at most a few props that carry a light.

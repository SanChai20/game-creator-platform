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
| Frame around everything | `createStage(canvas, { mood, weather })` | renderer, sky gradient, sun with a shadow that follows the action, hemisphere light, matching fog, tone mapping, weather particles, wind, quality that adapts to the device; `stage.run(update)` is the frame loop and calls `GCP.ready()` |
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

## The craft score

After a version verifies, the browser loads the game once more at full quality and takes its portrait (see the platform-contract guide). Seven things are then measured and returned as `quality`: a craft score out of 100, `look_score` for the picture alone, what was measured, and what to improve. Nothing is judged by taste and publishing never depends on it. The measures are calibrated on finished games: a hand-made open-world game with ambient occlusion, bloom and soft shadows measures look 93.

| Measured | Points | What raises it |
|---|---|---|
| Surfaces have detail (fine detail, crisp edges, share of flat fills, textures in use) | 22 | `surface(kind)`, models made of parts (`tree`, `rock`, `prop`), `grassField({ land })`, faceted `terrain` |
| Light and colour (tonal range, brightness, lighting and effect passes, colour families) | 22 | `createStage({ mood })`: shadows plus the finishing passes (ambient occlusion, bloom, colour grade, edge smoothing) |
| The world is furnished (different shapes, triangles and materials on screen) | 18 | more kinds and more of them: several species, props that fit, `scatter` with a few hundred things |
| The world moves when the player does nothing | 8 | wind in trees and grass, `water()`, weather, bobbing pickups, idle animation |
| Sound | 8 | `createSound()`: effects on actions, an ambience, music |
| Interface and input (text on screen, loading progress, touch, keyboard, resize) | 12 | `createHud()`, `createInput()`, `run()` |
| Proven playable (a passing play-through, no console warnings) | 10 | `GCP.test.onPlaythrough` with five steps |

## On slow devices and in the verification browser

The verification browser has no GPU. `createStage` detects a CPU renderer and switches to a lighter profile by itself: lower pixel ratio, a smaller shadow map refreshed every third frame, nearer fog, no point lights, a fifth of the grass, no finishing passes. That profile is only for the checks. The picture of the game is taken separately at full quality (`GCP.portrait`), so a light profile costs nothing in how the game is shown or scored. On real devices the stage starts from a quality guess and `stage.run` adapts it to the measured frame rate: it drops ambient occlusion first, then the other finishing passes, then resolution. You do not need to write a second path. A scene that stays comfortable: a few hundred large scattered things, about five hundred small ones, grass over a 50 m radius, a handful of animated creatures, and at most a few props that carry a light.

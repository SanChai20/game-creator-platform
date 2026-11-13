// The 2D half of the scene planner: the same settings, moods, heroes and goals as the 3D one, written as a complete
// top-down game on @gcp/craft2d.js (upright sprites sorted by their feet: the "2.5D" look of survival and farming games).
import { PLAY_IMPORTS, playBind, homesteadRules, HOMESTEAD_HINT } from './design-scene-play.js';
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const STAND_IN = { tower: 'ruin', windmill: 'house', stall: 'tent', cart: 'crate', boat: 'log', statue: 'pillar', arch: 'pillar', gate: 'fence', bench: 'log', flag: 'signpost', spikes: 'rock', beacon: 'lantern', antenna: 'lamp', console: 'crate', drum: 'barrel', pipe: 'log', barrier: 'fence', haystack: 'bush', bridge: 'log' };
const SPOTS = [[5.5, -4.5], [1.6, 1.2], [-4.5, -2.2], [-2, 2.4], [3, -1], [3.9, 0.4], [-3.4, 3.6], [0.8, -5.5]];

/** One 3D kind of the settings table ("tree({ species: 'oak' })", "prop('fence')", "groundCover('flower')") as a sprite2d call, or null. */
function flat(code, V) {
  const m = /^(tree|rock|bush|groundCover|prop)\((.*)\)$/.exec(code.trim()); if (!m) { const k = /^'(\w+)'$/.exec(code.trim()); return k ? flat(`prop('${k[1]}')`, V) : null; }
  let [, fn, rest] = m, kind = fn;
  if (fn === 'groundCover' || fn === 'prop') { const k = /^'(\w+)'\s*,?\s*/.exec(rest); if (!k) return null; kind = k[1]; rest = rest.slice(k[0].length); }
  kind = V.sprites2d.includes(kind) ? kind : STAND_IN[kind]; if (!kind) return null;
  if (kind === 'tree') rest = rest.replace(/species: '(\w+)'/, (all, sp) => `species: '${V.trees2d.includes(sp) ? sp : 'pine'}'`);
  rest = rest.replace(/,?\s*(walls|roof): '[^']*'/g, '').replace(/\{\s*,\s*/, '{ ').replace(/^\{\s*\}$/, '');
  return `sprite2d(${q(kind)}${rest ? ', ' + rest : ''})`;
}

const HTML = (title) => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">\n<title>${title.replace(/[<&]/g, '')}</title>\n<style>html, body { height: 100%; margin: 0; background: #0b0d0f; overflow: hidden; } #view { position: fixed; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }</style>\n</head>\n<body>\n<canvas id="view"></canvas>\n<script type="module" src="src/main.js"></script>\n</body>\n</html>\n`;
export const PLAY_SYSTEMS = { inventory: 'createInventory: 24 slots, an 8-slot hotbar, painted item icons', crafting: 'createCrafting: 8 recipes, one of them at a campfire', needs: 'createNeeds: health, food, stamina', time: 'createClock: a day that passes, hunters at night', harvesting: 'createNodes + createInteract: prompts, tools that work faster, regrowth', building: 'createBuilder: campfire, torch, fence, tent on a grid', quests: 'createQuests: six steps from the first tree to dawn', saving: "createSave: the player's cloud save, every 20 seconds" };
export const PLAY_INTERFACE = 'createHud plus needsUI, questUI, clockUI, minimapUI, hotbarUI, inventoryUI (backpack with crafting), pauseMenu, interact prompts, start and end screens';

export function write2d(c) {
  const { S, V, mood, weather, hero, goal, seed, title, count, time, pk, objective, notes, planLine, drift } = c, play = goal === 'homestead';
  const uniq = (list) => [...new Set(list.filter(Boolean))];
  const big = uniq(c.big.map((x) => flat(x, V))), small = uniq(c.small.map((x) => flat(x, V)));
  if (!small.length) small.push("sprite2d('rock', { size: 0.6 })");
  if (play) {   // a homestead needs wood, stone and berries within reach
    if (!big.some((x) => x.includes("'tree'"))) big.push("sprite2d('tree', { species: 'oak' })"); if (!big.some((x) => x.startsWith("sprite2d('rock'"))) big.push("sprite2d('rock')");
    if (![...big, ...small].some((x) => x.includes("'bush'"))) big.push("sprite2d('bush')");
  }
  const camp = c.camp.map((k) => flat(k.code, V)).filter(Boolean).filter((k) => !(c.goal === 'homestead' && /'(campfire|tent)'/.test(k))).slice(0, SPOTS.length);
  const people = (list) => list.filter((a) => V.actors2d.includes(a)), animals = people(c.animals), foes = people(c.foes).length ? people(c.foes) : ['wolf', 'slime'];
  const palette = typeof S.palette === 'string' && V.ground_palettes.includes(S.palette) ? S.palette : 'city', dark = ['night', 'neon-night', 'dusk', 'storm', 'volcanic', 'alien', 'indoor'].includes(mood);
  const pickup = V.sprites2d.includes(pk[0]) ? pk[0] : 'gem', hint = 'WASD or arrows to move · Shift to run';
  const L = [];
  L.push(`// ${title}: ${objective.toLowerCase()}.`,
    '// A top-down world of upright, painted things. Every call is a building block from @gcp/craft2d.js; get_block {name} lists its options.',
    '// The numbered sections are independent: change the kinds, the counts, the seed and above all the rules in section 6.',
    planLine,
    "import { run, createStage2d, ground2d, sprite2d, scatter2d, actor2d, control2d, wander2d, createHud, createSound, createInput, rng } from '@gcp/craft2d.js';",
    ...(play ? [`import { ${PLAY_IMPORTS.join(', ')} } from '@gcp/craft2d.js';`] : []), '',
    `const SEED = ${q(seed)};   // a different seed gives a different world with the same rules`, '',
    'run(async (boot) => {',
    '  // 1. Stage: the canvas, the camera, depth sorting, shadows, the mood (darkness and lights) and the weather.',
    "  await boot.step(0.1, 'Setting the stage');",
    `  const stage = createStage2d('#view', { mood: ${q(mood)}${weather ? `, weather: ${q(weather)}` : ''} });`, '',
    '  // 2. Ground: painted from noise. Water is the edge of the world; land.walkable(x, y) says where feet can go.',
    `  const land = ground2d({ seed: SEED, palette: ${q(palette)}${palette === 'city' || palette === 'desert' ? ', water: 0.12' : ''} });`, '',
    '  // 3. Scenery. scatter2d() places hundreds of things by rule and returns the solid ones for collision.',
    "  await boot.step(0.35, 'Growing the world');", '  const scenery = scatter2d([', ...big.map((x) => `    ${x},`),
    `  ], { count: ${S.bigCount ? S.bigCount * 2 : 560}, radius: 56, minDistance: 1.9, avoid: [{ x: 0, y: 0, r: 5 }], seed: SEED });`,
    `  ${play ? 'const cover = ' : ''}scatter2d([`, ...small.map((x) => `    ${x},`),
    `  ], { count: ${S.smallCount ? S.smallCount : 320}, radius: 56, avoid: [{ x: 0, y: 0, r: 2.5 }], seed: SEED + '-cover' });`, '',
    '  // 4. Landmarks around the start, placed by hand. Fires and lanterns light the dark.',
    "  await boot.step(0.6, 'Building');", '  const solids = [...scenery.solids];',
    '  const at = (sprite, x, y) => { const it = stage.add(sprite, x, y); if (sprite.solid) solids.push({ x, y: y - 0.1, r: sprite.solid }); return it; };',
    ...camp.map((code, i) => `  at(${code}, ${SPOTS[i][0]}, ${SPOTS[i][1]});`), '',
    '  // 5. The hero, input (keyboard and an on-screen stick on phones), sound, interface, and creatures with a life of their own.',
    "  await boot.step(0.8, 'Waking the world');",
    `  const hero = actor2d(${q(hero)});`,
    `  const input = createInput(stage.canvas), sound = createSound(), hud = createHud({ accent: ${q(S.accent)} }), fx = stage.fx;`,
    ...(play ? playBind('2d') : []),
    `  const player = control2d(hero, { input, solids, bounds: 60, ${play ? "canRun: () => needs.get('stamina') > 3, " : ''}onStep: () => sound.play('step') });`,
    ...(dark || play ? ['  const glow = stage.light(0, 0, 4.5, 0xffe0a0);   // the hero carries a light in the dark'] : []),
    "  const rand = rng(SEED + '-life');",
    `  for (const kind of [${animals.map(q).join(', ')}]) {`,
    '    const p = land.randomPoint(rand, { minRadius: 6, maxRadius: 40 }), a = actor2d(kind, { x: p.x, y: p.y });',
    '    wander2d(a, { radius: 9, flee: a.flies ? null : hero });', '  }', '');
  const end = (winTitle, loseTitle, stats) => [
    '  function finish(win) {', '    if (state.over) return;',
    '    state.over = true; state.playing = false; player.enabled = false; clock.stop();', "    sound.play(win ? 'win' : 'lose');",
    "    if (win) { fx.confetti(hero.x, hero.y - 1); hero.play('cheer'); } else { hero.dead = true; stage.setMood('night', 3); }",
    `    hud.end({ win, title: win ? ${q(winTitle)} : ${q(loseTitle)}, stats: ${stats}, onRestart: () => location.reload() });`, '  }', ''];
  const near = (v, r = 1.1) => `Math.hypot(${v}.x - hero.x, ${v}.y - 0.3 - hero.y) > ${r}`;
  let proof;
  if (play) {
    L.push(...homesteadRules({ dim: '2d', n: 6, S, title, objective, day: time, foes: foes.slice(0, 3) }));
    return {
      dimension: '2d',
      plan: {
        title, setting: c.id, goal: `${goal}: ${c.goalSummary}`, camera: '2d', view: 'top-down with upright, painted sprites sorted by their feet (the 2.5D look)',
        stage: { block: 'createStage2d', mood, weather: weather || 'none', day_and_night: 'createClock drives stage.setTime: warm dawn, day, golden evening, blue night with lights' },
        ground: { block: 'ground2d', palette }, scenery: { block: 'scatter2d + sprite2d', large: big, small, harvest: 'every tree, rock and bush is a node (createNodes().fromScatter)' }, landmarks: camp,
        hero: { block: 'actor2d + control2d', preset: hero, controls: 'input.bind: named actions for keyboard, mouse, touch buttons and gamepad' },
        systems: PLAY_SYSTEMS, interface: PLAY_INTERFACE, life: { block: 'actor2d + wander2d', animals, hunters_at_night: foes.slice(0, 3) },
        sound: { block: 'createSound', ambience: S.ambience, music: S.music },
        proof: 'GCP.test.onPlaythrough with ten steps: gather, craft, build, eat, night, fight, cook, dawn, win',
        not_covered: 'One hero on one device. For several players add GCP.room from @gcp/net.js (see the multiplayer guide): the host owns inv, build and clock and sends them with room.setState.',
      },
      files: { 'index.html': HTML(title), 'src/main.js': L.join('\n') + '\n' },
      notes,
    };
  }
  if (goal === 'collect') {
    L.push(`  // 6. Rules: collect every pickup before the time runs out. This is the part to make your own.`,
      `  const GOAL = ${count}, TIME = ${time}, state = { playing: false, over: false, found: 0 }, pickups = [];`,
      '  for (let i = 0; i < GOAL; i++) {', '    const p = land.randomPoint(rand, { minRadius: 8 + i * 2.5, maxRadius: 16 + i * 4 });',
      `    pickups.push(stage.add(sprite2d(${q(pickup)}, { color: ${pk[1]} }), p.x, p.y, { bob: true, light: { r: 2.2, color: ${pk[1]}, flicker: false } }));`, '  }', '',
      '  // 7. Interface: the goal, the progress and the time are always on screen.',
      `  const counter = hud.counter(${q(pk[2])}, { icon: '◆', value: 0 });`,
      '  const clock = hud.timer({ seconds: TIME, onEnd: () => finish(false) }).stop();', "  hud.button('Sound', () => sound.mute());",
      ...end('Every one found', 'Out of time', `{ ${q(pk[2])}: state.found + ' / ' + GOAL, 'Time left': Math.ceil(clock.time) + ' s' }`),
      '  // 8. The frame loop. stage.run() updates and draws the stage and calls GCP.ready() after the first frames.',
      '  stage.run((dt) => {', '    player.update(dt);' + (dark ? ' glow.x = hero.x; glow.y = hero.y - 0.8;' : ''),
      '    if (state.playing) for (const g of pickups) {', `      if (!g.visible || ${near('g')}) continue;`,
      '      g.visible = false; if (g.light) g.light.on = false; state.found++; counter.set(state.found);',
      `      fx.burst(g.x, g.y - 0.4, ${pk[1]}).text(g.x, g.y, '+1', ${q(S.accent)}); sound.play('pickup');`,
      "      hud.toast(state.found < GOAL ? (GOAL - state.found) + ' left' : 'All found');", '      if (state.found === GOAL) finish(true);', '    }',
      '    input.endFrame();', '  });', '  boot.done();', '');
    proof = ["    t.step('walk to the first pickup'); player.teleport(pickups[0].x + 1.6, pickups[0].y); await player.moveTo(pickups[0].x, pickups[0].y - 0.2, 6); await t.frames(2);",
      "    t.assert(state.found === 1, 'walking onto a pickup collects it, found ' + state.found);",
      "    t.step('collect two more'); for (const g of pickups.slice(1, 3)) { player.teleport(g.x, g.y - 0.2); await t.frames(2); }", "    t.assert(state.found === 3, 'three collected, found ' + state.found);",
      "    t.step('collect the rest'); for (const g of pickups.slice(3)) { player.teleport(g.x, g.y - 0.2); await t.frames(2); }", "    t.assert(state.found === GOAL, 'all collected, found ' + state.found);",
      "    t.step('the win screen shows'); await t.until(() => state.over && hud.screenOpen, 5000); t.assert(state.over && hud.screenOpen, 'the end screen is open');"];
  } else if (goal === 'survive') {
    L.push('  // 6. Rules: stay alive until the clock runs out. Hunters chase the hero when it comes near; hearts heal. Make this part your own.',
      `  const TIME = ${time}, state = { playing: false, over: false, health: 100, safeUntil: 0 }, hunters = [], hearts = [];`,
      `  for (const kind of [${[...foes, ...foes].slice(0, 5).map(q).join(', ')}]) {`,
      '    const p = land.randomPoint(rand, { minRadius: 16, maxRadius: 40 }), a = actor2d(kind, { x: p.x, y: p.y }); hunters.push(a);',
      '    wander2d(a, { radius: 12, speed: 1.5, chase: hero, sight: 9, onReach: () => hurt(20) });', '  }',
      '  for (let i = 0; i < 5; i++) {', '    const p = land.randomPoint(rand, { minRadius: 7 + i * 4, maxRadius: 16 + i * 6 });',
      "    hearts.push(stage.add(sprite2d('heart'), p.x, p.y, { bob: true }));", '  }',
      '  function hurt(amount) {', '    if (!state.playing || performance.now() < state.safeUntil) return;',
      '    state.safeUntil = performance.now() + 1200; state.health = Math.max(0, state.health - amount); health.set(state.health);',
      "    hud.damage(0.7); stage.shake(0.4); sound.play('hurt'); hero.play('hurt'); fx.burst(hero.x, hero.y - 0.8, 0xe5484d, 8);", '    if (state.health <= 0) finish(false);', '  }', '',
      '  // 7. Interface: health and time are always on screen.',
      "  const health = hud.bar('Health', { value: 100, max: 100, color: '#e5484d' });",
      '  const clock = hud.timer({ seconds: TIME, onEnd: () => finish(true) }).stop();', "  hud.button('Sound', () => sound.mute());",
      ...end('You made it', 'Caught', "{ Health: state.health, 'Time left': Math.ceil(clock.time) + ' s' }"),
      '  // 8. The frame loop. stage.run() updates and draws the stage and calls GCP.ready() after the first frames.',
      '  stage.run((dt) => {', '    player.update(dt);' + (dark ? ' glow.x = hero.x; glow.y = hero.y - 0.8;' : ''),
      '    if (state.playing) for (const h of hearts) {', `      if (!h.visible || state.health >= 100 || ${near('h')}) continue;`,
      "      h.visible = false; state.health = Math.min(100, state.health + 30); health.set(state.health); fx.burst(h.x, h.y - 0.4, 0xff5a7a); sound.play('heal'); hud.toast('Healed');", '    }',
      '    input.endFrame();', '  });', '  boot.done();', '');
    proof = ["    t.step('a hunter reaches the hero'); player.teleport(hunters[0].x + 1, hunters[0].y); await t.until(() => state.health < 100, 8000);",
      "    t.assert(state.health === 80, 'one hit costs 20 health, health is ' + state.health);",
      "    t.step('a heart heals'); player.teleport(hearts[0].x, hearts[0].y - 0.2); await t.until(() => !hearts[0].visible, 4000); t.assert(state.health > 80, 'health went up to ' + state.health);",
      "    t.step('the clock runs out'); player.teleport(0, 0); clock.reset(1); await t.until(() => state.over, 6000); t.assert(state.over && state.health > 0, 'surviving until the end wins');",
      "    t.step('the end screen shows'); await t.until(() => hud.screenOpen, 3000); t.assert(hud.screenOpen, 'the end screen is open');"];
  } else {
    L.push('  // 6. Rules: find the three keys, then reach the portal before the time runs out. Make this part your own.',
      `  const KEYS = 3, TIME = ${time}, state = { playing: false, over: false, keys: 0, told: 0 }, keys = [];`,
      '  for (let i = 0; i < KEYS; i++) {', '    const p = land.randomPoint(rand, { minRadius: 12 + i * 6, maxRadius: 22 + i * 9 });',
      "    keys.push(stage.add(sprite2d('key', { size: 1.3 }), p.x, p.y, { bob: true, light: { r: 2.2, color: 0xffd060, flicker: false } }));", '  }',
      "  const gate = land.randomPoint(rand, { minRadius: 34, maxRadius: 46 }), portal = stage.add(sprite2d('portal'), gate.x, gate.y);", '',
      '  // 7. Interface: the keys and the time are always on screen.',
      "  const counter = hud.counter('Keys', { icon: '◆', value: '0 / ' + KEYS });",
      '  const clock = hud.timer({ seconds: TIME, onEnd: () => finish(false) }).stop();', "  hud.button('Sound', () => sound.mute());",
      ...end('Through the portal', 'Out of time', "{ Keys: state.keys + ' / ' + KEYS, 'Time left': Math.ceil(clock.time) + ' s' }"),
      '  // 8. The frame loop. stage.run() updates and draws the stage and calls GCP.ready() after the first frames.',
      '  stage.run((dt) => {', '    player.update(dt);' + (dark ? ' glow.x = hero.x; glow.y = hero.y - 0.8;' : ''),
      '    if (state.playing) {', '      for (const k of keys) {', `        if (!k.visible || ${near('k')}) continue;`,
      "        k.visible = false; if (k.light) k.light.on = false; state.keys++; counter.set(state.keys + ' / ' + KEYS); fx.burst(k.x, k.y - 0.4, 0xffc83a); sound.play('unlock');",
      "        hud.toast(state.keys < KEYS ? (KEYS - state.keys) + ' keys to go' : 'The portal is open'); if (state.keys === KEYS) hud.objective('Reach the portal');", '      }',
      '      if (Math.hypot(portal.x - hero.x, portal.y - hero.y) < 1.4) {', '        if (state.keys === KEYS) finish(true);',
      "        else if (performance.now() > state.told) { state.told = performance.now() + 3000; hud.toast('The portal needs ' + (KEYS - state.keys) + ' more keys'); sound.play('error'); }", '      }', '    }',
      '    input.endFrame();', '  });', '  boot.done();', '');
    proof = ["    t.step('walk to the first key'); player.teleport(keys[0].x + 1.6, keys[0].y); await player.moveTo(keys[0].x, keys[0].y - 0.2, 6); await t.frames(2);",
      "    t.assert(state.keys === 1, 'walking onto a key collects it, keys ' + state.keys);",
      "    t.step('the portal stays shut without all keys'); player.teleport(portal.x, portal.y + 0.4); await t.frames(3); t.assert(!state.over, 'the portal refused');",
      "    t.step('collect the other keys'); for (const k of keys.slice(1)) { player.teleport(k.x, k.y - 0.2); await t.frames(2); } t.assert(state.keys === KEYS, 'all keys, got ' + state.keys);",
      "    t.step('enter the portal'); player.teleport(portal.x, portal.y + 0.4); await t.until(() => state.over, 5000); t.assert(state.over && hud.screenOpen, 'the win screen is open');"];
  }
  L.push('  // 9. Start screen. Sound starts on the first press (browsers block it before that).', '  player.enabled = false;',
    `  hud.title({ title: ${q(title)}, subtitle: ${q(objective)}, controls: ${q(hint)}, onStart: () => {`,
    '    state.playing = true; player.enabled = true; clock.start();', `    sound.ambience(${q(S.ambience)}); sound.music(${q(S.music)});`,
    `    hud.objective(${q(objective)}); hud.hint(${q(hint)}, 8);`,
    ...(drift ? [`    stage.setMood(${q(drift)}, TIME);   // the light changes as the time runs out`] : []), '  } });', '',
    '  // 10. Proof. The verification browser runs this to check the rules work from start to end.',
    '  GCP.test.onAutostart(() => hud.start());', '  GCP.test.onPlaythrough(async (t) => {',
    "    t.step('start the game'); if (hud.screenOpen) hud.start(); await t.frames(3); t.assert(state.playing, 'the game is running');", ...proof, '  });', '});');
  const html = HTML(title);
  return {
    dimension: '2d',
    plan: {
      title, setting: c.id, goal: `${goal}: ${c.goalSummary}`, camera: '2d', view: 'top-down with upright, painted sprites sorted by their feet (the 2.5D look)',
      stage: { block: 'createStage2d', mood, weather: weather || 'none', drifts_to: drift || 'stays', lights: dark ? 'the hero carries a light; fires and lanterns glow' : 'lights glow when the mood turns dark' },
      ground: { block: 'ground2d', palette }, scenery: { block: 'scatter2d + sprite2d', large: big, small }, landmarks: camp,
      hero: { block: 'actor2d + control2d', preset: hero }, life: { block: 'actor2d + wander2d', animals, hunters: goal === 'survive' ? foes : [] },
      interface: 'createHud: start screen, objective, counter or health bar, timer, toasts, end screen', sound: { block: 'createSound', ambience: S.ambience, music: S.music },
      proof: 'GCP.test.onPlaythrough with five steps that play the rules to the end screen',
      not_covered: 'One hero on one device. For several players add GCP.room from @gcp/net.js (see the multiplayer guide). For gathering, crafting, building and survival ask for goal "homestead", or add those systems from the same kit (list_blocks, group play).',
    },
    files: { 'index.html': html, 'src/main.js': L.join('\n') + '\n' },
    notes,
  };
}

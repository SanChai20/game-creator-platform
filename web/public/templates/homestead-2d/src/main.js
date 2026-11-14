// Template: homestead-2d (from the platform's templates; src/theme.js is the game, this file the engine. Keep this line: the report uses it to tell how much is still the template.)
// Brackenfold — a top-down homestead for one or two players: an endless land that fills in as you walk, crops to
// till, sow, water and harvest, and one shared world when a friend joins by room code.
//
// This file is the ENGINE. It is written on the building blocks of @gcp/craft2d.js (get_block {name} lists the options
// of each) and reads everything that is particular to this game from ./theme.js: names, the look, items, recipes,
// crops, pieces, regions of the land and the quest steps. To make a different game, rewrite theme.js; to change how
// the game works, change the numbered section here that owns it. Sections:
//   1 stage and land        4 the world that grows      7 using what you hold      10 two players
//   2 art drawn here        5 systems                   8 interface                11 start: lobby, save, room
//   3 hero, input, sound    6 home                      9 the frame loop           12 proof (the play-through)
import { run, createStage2d, ground2d, sprite2d, chunks2d, actor2d, control2d, wander2d, bake, shade, rng, clamp, lerp, createHud, createSound, createInput,
  createInventory, createCrafting, createNeeds, createClock, createNodes, createInteract, createBuilder, stairsPiece, createCrops, createQuests, createSave,
  createWorldSync, createLoopback, itemIcon, hotbarUI, inventoryUI, needsUI, clockUI, questUI, minimapUI, pauseMenu, lobbyUI } from '@gcp/craft2d.js';
import * as T from './theme.js';

const GCP = window.GCP, CHUNK = 16, LEVEL = 2, RISE = 0.55;   // chunk size; height of one storey; how far one unit of height lifts a thing in the picture
const r2 = (v) => Math.round(v * 100) / 100, cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1), el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

run(async (boot) => {
  /* ===== 1. stage and land: the canvas, camera, depth sorting, light; ground without an edge, painted where the camera goes ===== */
  await boot.step(0.1, 'Unrolling the map');
  const stage = createStage2d('#view', { mood: T.LOOK.mood, weather: 'motes' }), fx = stage.fx;
  const land = ground2d({ seed: T.SEED, size: Infinity, palette: T.LOOK.palette, water: T.LOOK.water, clearing: { x: 0, y: 0, r: 9 } });

  /* ===== 2. art drawn here: the few things the kit has no sprite for. Raised things are anchored at the far edge of
     their cell, so whoever stands on that cell is drawn over them. ===== */
  const U = LEVEL * RISE + 0.06, [WOOD, WOOD2] = T.LOOK.wood, INK = '#1d2420';
  const raised = (draw) => { const s = bake(1, U + 1.04, draw, { scale: 64 }); s.ay = U / s.h; s.shadow = 0; return s; };
  const slab = (c, x, y, w, d, lift, col) => {   // a block seen from above and in front: the face below its top, then the top, lifted
    c.lineWidth = 0.03; c.strokeStyle = INK; c.fillStyle = shade(col, -0.36); c.beginPath(); c.rect(x, U + y + d - lift, w, lift); c.fill(); c.stroke();
    c.fillStyle = shade(col, 0); c.beginPath(); c.rect(x, U + y - lift, w, d); c.fill(); c.stroke();
  };
  // stairs rise one storey across a cell, towards dir: 0 +y (towards the viewer), 1 +x, 2 -y, 3 -x
  const stairsArt = [0, 1, 2, 3].map((dir) => raised((c) => { for (let i = 0; i < 5; i++) { const lift = (dir >= 2 ? 5 - i : i + 1) / 5 * LEVEL * RISE, col = i % 2 ? WOOD : WOOD2; if (dir % 2 === 0) slab(c, 0.03, i * 0.2, 0.94, 0.2, lift, col); else slab(c, 0.03 + i * 0.188, 0, 0.188, 1, lift, col); } }));
  const deckArt = raised((c) => { const L = LEVEL * RISE; c.fillStyle = 'rgba(16,22,30,.22)'; c.fillRect(0.04, U + 0.12, 0.92, 0.9);
    c.lineWidth = 0.03; c.strokeStyle = INK; for (const x of [0.05, 0.83]) { c.fillStyle = shade(WOOD, -0.45); c.beginPath(); c.rect(x, U + 1 - L, 0.12, L); c.fill(); c.stroke(); }
    c.fillStyle = shade(WOOD, 0.08); c.beginPath(); c.rect(0, U - L, 1, 1); c.fill(); c.stroke(); c.strokeStyle = shade(WOOD, -0.3); for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo(0.02, U - L + i * 0.25); c.lineTo(0.98, U - L + i * 0.25); c.stroke(); }
    c.strokeStyle = INK; c.fillStyle = shade(WOOD, -0.3); c.beginPath(); c.rect(0, U + 1 - L, 1, 0.13); c.fill(); c.stroke(); });
  const drySoil = sprite2d('soil'), wetSoil = sprite2d('soil', { wet: true }), FLAT = { flat: true };   // flat: it lies on the ground, drawn under whoever stands there
  const aimArt = bake(1, 1, (c) => { c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 0.05; c.setLineDash([0.2, 0.12]); c.beginPath(); c.roundRect(0.06, 0.06, 0.88, 0.88, 0.14); c.stroke(); c.fillStyle = 'rgba(255,255,255,.1)'; c.fill(); }, { scale: 64, ay: 0 }); aimArt.shadow = 0;
  const nameTag = (name) => { const s = bake(4, 0.46, (c) => { c.font = '700 0.26px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; const w = Math.min(3.8, c.measureText(name).width + 0.3); c.fillStyle = 'rgba(16,14,10,.62)'; c.beginPath(); c.roundRect(2 - w / 2, 0.04, w, 0.38, 0.12); c.fill(); c.fillStyle = '#fff'; c.fillText(name, 2, 0.25); }, { scale: 72 }); s.ay = 5.3; s.shadow = 0; return s; };
  const lifted = (a, lift) => { const draw = a.draw; a.draw = (c, t) => { const l = lift(); if (l > 0.01) { c.save(); c.translate(0, -l); draw(c, t); c.restore(); } else draw(c, t); }; return a; };   // an actor standing on stairs or a deck

  /* ===== 3. hero, input, sound, interface layer ===== */
  await boot.step(0.3, 'Waking the farmer');
  const state = { playing: false, busy: false, speed: 1, elev: 0, px: 0, py: 0, pail: 0, tilled: 0, planted: 0, watered: 0, harvested: 0, meals: 0, cooked: 0, sold: 0, climbed: 0, charted: 0, region: '' };
  const net = { room: null, code: '', t: 0, peers: new Map() };   // the room, if any, and the other players in it (section 10)
  const hero = lifted(actor2d(T.HERO), () => state.elev * RISE), me = (GCP.player && GCP.player.name) || 'Farmer';
  const input = createInput(stage.canvas), sound = createSound(), hud = createHud({ accent: T.LOOK.accent, ink: T.LOOK.ink, panel: T.LOOK.panel });
  // Actions are named once; the keyboard, the mouse, on-screen buttons on phones and a gamepad all trigger them.
  input.bind({ interact: ['KeyE'], use: ['Space', 'KeyF', 'Mouse0'], bag: ['Tab', 'KeyI'], take: ['KeyX'], run: ['ShiftLeft', 'ShiftRight'], mute: ['KeyM'] },
    { touch: { interact: 'E', use: '✋', bag: '▦' }, pad: { interact: 0, take: 1, use: 2, bag: 3, run: 10 }, bottom: 96 });
  const solids = [];   // everything placed by hand or built; the land's own trees and rocks are in world.solids
  const player = control2d(hero, { input, solids, canRun: () => needs.get('stamina') > 3, onStep: () => sound.play('step', { volume: 0.5 }) });
  const glow = stage.light(0, 0, 4.6, 0xffe0a0);   // the hero carries a light in the dark

  /* ===== 4. the world that grows. The land is cut into chunks; each is filled the same way every time from the seed,
     so it is endless, the same for every player, and costs nothing to save. A chunk with ch.far is one a host keeps
     unseen around a guest who walked away (createWorldSync asks for it): it gets its trees and rocks but no animals. ===== */
  await boot.step(0.5, 'Growing the land');
  const artOf = new Map(), art = (name) => { const th = T.THINGS[name], s = sprite2d(...th.sprite); artOf.set(s, th); return s; };
  const regionAt = (cx, cy) => { const far = Math.max(Math.abs(cx), Math.abs(cy)), list = T.REGIONS.filter((r) => r.far <= far); return far < 2 ? T.REGIONS[0] : list[Math.floor(rng(T.SEED + '|region|' + Math.floor(cx / 2) + ',' + Math.floor(cy / 2))() * list.length)]; };
  const nodeOf = (it) => { const th = artOf.get(it.sprite); return th && th.node ? { r: 1.25, ...th.node } : null; };
  function growLand(st, set, around, radius) {
    const w = chunks2d({ seed: T.SEED, chunk: CHUNK, radius, stage: st, around, fill: (ch) => {
      const R = regionAt(ch.cx, ch.cy), keep = [{ x: 0, y: 0, r: T.HOME.clear }];
      const found = [...ch.scatter(R.trees.map(art), { count: R.count, minDistance: 1.9, avoid: keep, seed: 'trees' }), ...ch.scatter(R.cover.map(art), { count: R.coverCount, minDistance: 1.1, avoid: keep, seed: 'cover' })];
      const x = ch.x + 2 + ch.rand() * (CHUNK - 4), y = ch.y + 2 + ch.rand() * (CHUNK - 4);   // the same draws on every device, whatever comes of them
      if (ch.rand() < R.chest && Math.hypot(x, y) > 18 && land.kindAt(x, y) === 'grass') { const chest = ch.add(art('chest'), x, y); if (chest) found.push(chest); }
      set.fromScatter(found, nodeOf);   // every tree, rock, bush and chest can be used; its id is its place in the chunk
      if (st === stage && !ch.far) { ch.region = R; for (const kind of R.animals || []) { const p = { x: ch.x + Math.random() * CHUNK, y: ch.y + Math.random() * CHUNK }; if (Math.random() < 0.45 && land.walkable(p.x, p.y) && Math.hypot(p.x, p.y) > 8) { const a = actor2d(kind, p), brain = wander2d(a, { flee: hero, radius: 6 }); ch.keep({ remove() { brain.stop(); const i = stage.actors.indexOf(a); if (i >= 0) stage.actors.splice(i, 1); } }); } } }
    } });
    w.onUnload((ch) => { const gone = new Set(ch.items); set.removeWhere((n) => gone.has(n.ref)); });
    return w;
  }
  const nodes = createNodes(), charted = new Set();
  const world = growLand(stage, nodes, () => hero, 2);
  for (const k of world.chunks.keys()) charted.add(k);
  world.onLoad((ch) => { const k = ch.cx + ',' + ch.cy; if (!ch.far && !charted.has(k)) { charted.add(k); state.charted++; } });
  player.addSolids(world.solids);

  /* ===== 5. systems: backpack, recipes, needs, the day, building, crops, quests, saving ===== */
  await boot.step(0.7, 'Stocking the shed');
  const inv = createInventory({ slots: 24, hotbar: 8, items: T.ITEMS, start: T.START });
  const craft = createCrafting(inv, T.RECIPES); craft.onCraft((r) => { sound.play('build'); if (r.station) state.cooked++; });
  const needs = createNeeds({ health: { max: 100 }, food: { max: 100, drain: 100 / (T.DAY * 1.4), empty: { health: -2.5 }, full: { health: 0.5 } }, stamina: { max: 100, regen: 16 } });
  const clock = createClock({ dayLength: T.DAY, hour: 8, stage });   // the light of the stage follows the hour

  // Building. A piece is drawn by its sprite; a tilled plot, stairs and a deck are drawn by section 2. A campfire and a
  // bedroll also add something to do beside them. pieceDefs(false) is the same set for a world nobody looks at.
  const USES = { cook: () => bag.open(), sleep: () => sleep() }, shapeKind = (shape) => Object.keys(T.PIECES).find((k) => T.PIECES[k].shape === shape);
  const drawPiece = (kind) => (x, y, p) => {
    const d = T.PIECES[kind], it = d.shape === 'plot' ? stage.add(drySoil, x, y + 0.28, FLAT) : d.shape === 'stairs' ? stage.add(stairsArt[p.dir], x, y - 0.5) : d.shape === 'deck' ? stage.add(deckArt, x, y - 0.5) : stage.add(sprite2d(d.sprite), x, y + 0.2);
    const node = d.use ? nodes.add({ x, y, r: 1.6, label: d.label, onUse: () => USES[d.use](p) }) : null;
    return { remove() { it.remove(); if (node) nodes.remove(node); } };
  };
  const pieceDefs = (live) => Object.fromEntries(Object.entries(T.PIECES).map(([k, d]) => { const make = live ? drawPiece(k) : null;
    return [k, d.shape === 'stairs' ? stairsPiece({ grid: 1, rise: LEVEL, cost: d.cost, make }) : { cost: d.cost, solid: d.solid, station: d.station, layer: d.shape === 'deck' ? 'floor' : 'ground', height: d.shape === 'deck' ? 0.05 : 0, make }]; }));
  const blocked = (x, y, r) => [solids, world.solids].some((list) => list.some((s) => !s.off && Math.hypot(s.x - x, s.y - y) < s.r + r));
  const build = createBuilder({ grid: 1, levelHeight: LEVEL, inventory: inv, solids, pieces: pieceDefs(true),
    canPlace: (x, y, kind, level) => land.walkable(x, y) && (level > 0 || (!blocked(x, y, 0.3) && (!!T.PIECES[kind].shape || Math.hypot(x - hero.x, y - hero.y) > 0.55))) });

  // Crops grow in three waterings: each new stage dries the soil again. Ripe ones are harvested through the nodes.
  const drawCrop = (x, y, c) => { const soil = c.watered ? stage.add(wetSoil, x, y + 0.28, FLAT) : null, plant = stage.add(sprite2d('crop', { type: c.type, stage: c.stage, wet: c.watered, seed: 7 }), x, y + 0.15); return { remove() { plant.remove(); if (soil) soil.remove(); } }; };
  const crops = createCrops({ nodes, types: T.CROPS, grid: 1, water: true, make: drawCrop });
  crops.onRipe((c) => { fx.ring(c.x, c.y, 0xffe27a); if (Math.hypot(c.x - hero.x, c.y - hero.y) < 14) sound.play('pop'); });

  const quests = createQuests(T.STEPS.map((s) => ({ id: s.id, text: s.text, done: () => s.when(state, inv) })));
  // What is saved: the backpack, the needs, the day, what was built and planted, which trees are gone, the quests and where you stand.
  const mine = { toJSON: () => ({ x: r2(hero.x), y: r2(hero.y), pail: state.pail, charted: [...charted], n: [state.tilled, state.planted, state.watered, state.harvested, state.meals, state.cooked, state.sold, state.climbed] }),
    load(d) { if (!d) return; player.teleport(+d.x || 0, +d.y || 0); state.pail = clamp(d.pail | 0, 0, T.PAIL); for (const k of d.charted || []) charted.add(k); state.charted = Math.max(0, charted.size - 25); [state.tilled, state.planted, state.watered, state.harvested, state.meals, state.cooked, state.sold, state.climbed] = (d.n || []).map((v) => v | 0).concat([0, 0, 0, 0, 0, 0, 0, 0]); } };
  const save = createSave(T.SAVE_KEY, { inv, needs, clock, build, crops, world, quests, mine });             // the host's or the lone player's: the whole world
  const guestSave = createSave(T.SAVE_KEY + '-guest', { inv, needs, quests });                                  // a guest keeps only what they carry

  /* ===== 6. home: the well and the trading post stand at the start for every player ===== */
  const putHome = (kind, x, y) => { const s = sprite2d(kind), it = stage.add(s, x, y); if (s.solid) solids.push({ x, y: y - 0.1, r: s.solid }); return it; };
  const [wx, wy] = T.HOME.well, [tx, ty] = T.HOME.post;
  putHome('well', wx, wy); putHome('signpost', tx, ty); for (const [kind, x, y] of T.HOME.decor) putHome(kind, x, y);
  const well = nodes.add({ x: wx, y: wy, r: 1.7, label: 'Fill the pail', onUse: () => fillPail() });
  const post = nodes.add({ x: tx, y: ty, r: 1.7, label: 'Trade at the post', onUse: () => shop.open() });

  /* ===== 7. using what you hold. One button: food is eaten, a hoe tills, seeds are sown, the pail waters, a piece is
     placed, all on the cell in front of you. Every change to the world goes through `sync`, so it is the same code
     alone and in a room (see section 10). ===== */
  let sync = null;
  const aim = () => { const a = player.ahead(1); return build.snap(a.x, a.y); }, heldTool = () => inv.held && inv.held.def.tool;
  const say = (x, y, text, color = T.LOOK.accent) => fx.text(x, y - 0.5, text, color), no = (why) => { hud.toast(cap(why)); sound.play('error'); return false; };
  const wobbles = [], wobble = (ref) => { if (ref && ref.sprite && !wobbles.some((w) => w.ref === ref)) wobbles.push({ ref, x: ref.x, t: 0.28 }); };
  function fillPail() { if (!inv.has('pail')) return no('You need a pail'); state.pail = T.PAIL; sound.play('splash'); say(hero.x, hero.y, 'Pail filled', '#8fd0ff'); drawPill(); return true; }
  function eat(id) { const d = inv.def(id); if (!inv.remove(id, 1)) return false; needs.add('food', d.food || 0); needs.add('health', d.heal || 0); state.meals++; sound.play('heal'); hero.play('cheer'); say(hero.x, hero.y, '+' + (d.food || d.heal) + (d.food ? ' food' : ' health')); return true; }
  async function useHeld(slot = inv.selected) {
    const s = inv.slots[slot]; if (!s || !state.playing || state.busy) return false;
    const d = inv.def(s.id); let [x, y] = aim();
    if (d.food || d.heal) return eat(s.id);
    if (d.tool === 'hoe') {
      if (build.at(x, y, 'ground')) return no('Something is already there');
      const r = await sync.place(shapeKind('plot'), x, y); if (r.error) return no(r.error === 'cannot build here' ? 'The ground here cannot be tilled' : r.error);
      state.tilled++; hero.play('attack'); sound.play('chop', { pitch: 0.7 }); fx.burst(x, y, 0x8a6440, 8); return true;
    }
    if (d.plant) {
      const plot = build.at(x, y, 'ground'); if (!plot || T.PIECES[plot.kind].shape !== 'plot') return no('Till the ground with a hoe first');
      const r = await sync.plant(d.plant, x, y); if (r.error) return no(r.error === 'occupied' ? 'Something already grows there' : r.error);
      state.planted++; sound.play('pop'); fx.burst(x, y, 0x8fd16a, 6); return true;
    }
    if (d.tool === 'pail') {
      const a = player.ahead(1.2); if (land.kindAt(a.x, a.y) === 'water' || Math.hypot(well.x - hero.x, well.y - hero.y) < 2) return fillPail();
      const c = crops.at(x, y); if (!c) return no('Nothing is planted there'); if (c.watered || c.stage >= 3) return no(c.stage >= 3 ? 'It is ripe: harvest it' : 'The soil is still wet');
      if (state.pail <= 0) return no('The pail is empty: fill it at the well or a shore');
      const r = await sync.water(x, y); if (r.error) return no(r.error);
      state.pail--; state.watered++; sound.play('splash'); fx.burst(x, y - 0.2, 0x8fd0ff, 10); drawPill(); return true;
    }
    if (d.place) {
      const p = T.PIECES[d.place], level = p.level || 0, under = build.at(x, y, 'floor', 0), f = hero.facing, dir = f === 'down' ? 0 : f === 'right' ? 1 : f === 'up' ? 2 : 3;
      if (level && under && build.defs[under.kind].ramp) { x += [0, 1, 0, -1][under.dir]; y += [1, 0, -1, 0][under.dir]; }   // a deck aimed at stairs goes where the stairs lead
      const r = await sync.place(d.place, x, y, { level, dir }); if (r.error) return no(r.error);
      sound.play('build'); fx.burst(x, y - level * LEVEL * RISE, 0xe8d8b0, 8); return true;
    }
    hud.toast(d.tool ? d.name + ': keep it in hand and press ' + (input.keyOf('interact') || 'E') + ' at a tree or a rock' : d.name + ' is for crafting' + (d.sell ? ' or selling' : '')); return false;
  }
  async function takeBack() { const [x, y] = aim(); if (crops.at(x, y)) return no('Something grows there'); const r = await sync.remove(x, y); if (r.error) return false; sound.play('pop'); hud.toast('Took back the ' + inv.def(r.kind).name.toLowerCase()); return true; }
  // E on a tree, a rock, a bush, a ripe crop, a chest. The right tool counts double. The host decides; this player gets the drops.
  async function useNode(n, tool = heldTool()) {
    const r = await sync.use(n, { tool, power: n.best && n.best === tool ? 2 : 1 });
    if (r.error) return r.error === 'gone' ? r : (no(r.error), r); if (n.onUse) return r;
    hero.play('attack'); wobble(n.ref); stage.shake(0.07); sound.play(n.kind === 'rock' || n.kind === 'crystal' ? 'hit' : n.hp > 1 ? 'chop' : 'pop'); fx.burst(n.x, n.y - 0.6, n.kind === 'rock' ? 0xb8b4aa : n.kind === 'tree' ? 0x8a5a34 : 0x6aa84a, 6);
    if (r.done) { sound.play('pickup'); say(n.x, n.y, Object.entries(r.drops || {}).filter(([, k]) => k).map(([id, k]) => '+' + k + ' ' + inv.def(id).name.toLowerCase()).join('  ')); if (n.kind === 'crop') state.harvested++; if (n.kind === 'tree') stage.shake(0.2); }
    return r;
  }
  function sleep() {
    if (!clock.isNight && clock.phase !== 'dusk') return no('You can sleep once the sun is down');
    if (net.room && net.room.connected && !net.room.isHost) { net.room.send({ t: 'sleep' }, 'host'); return hud.toast('You ask the host to call it a night'); }
    state.busy = true; hud.fade(true, 0.5).then(() => { passNight(); return hud.fade(false, 0.6); }).then(() => { state.busy = false; });
  }
  function passNight() {   // the night goes by at once: watered crops grow on, the sleeper wakes rested and a little hungry
    const secs = ((30 - clock.hour) % 24) / 24 * T.DAY; if (clock.hour >= 12) clock.day++; clock.set(6); for (let i = 0; i < 24; i++) crops.update(secs / 24);
    needs.add('health', 40); needs.set('stamina', 100); needs.add('food', -12); sound.play('bell'); hud.toast('Dawn of day ' + clock.day);
  }
  needs.onDeath(() => { needs.load({ health: 60, food: 45, stamina: 100 }); player.teleport(0, 1); state.elev = 0; hud.flash('#000', 1.2); hud.toast('You wake by the well, hungry but alive'); sound.play('lose'); });
  clock.onPhase((phase) => {
    if (phase === 'dusk') { hud.toast('The light is going: a bedroll lets you sleep'); sound.play('bell'); stage.setWeather('fireflies'); sound.ambience(T.SOUND.nightAmbience); }
    if (phase === 'dawn') { stage.setWeather('motes'); sound.ambience(T.SOUND.ambience); if (state.playing) hud.toast('Day ' + clock.day); }
  });

  /* ===== 8. interface: needs and the almanac top left; the clock, the map and the purse top right; the hotbar at the
     bottom; the backpack with crafting on Tab; the trading post; a pause menu on Escape ===== */
  needsUI(hud, needs);
  questUI(hud, quests, { corner: 'tl', title: 'Almanac', max: 3 });
  const clockView = clockUI(hud, clock);
  minimapUI(hud, { center: () => hero, range: 40, color: land.mapColor, markers: () => [{ x: 0, y: 0, color: '#ffffff' }, ...build.pieces.filter((p) => !T.PIECES[p.kind].shape).map((p) => ({ x: p.x, y: p.y, color: '#ffb347' })), ...crops.list.map((c) => ({ x: c.x, y: c.y, color: c.stage === 3 ? '#ffe27a' : '#8fd16a' })), ...[...net.peers.values()].map((p) => ({ x: p.actor.x, y: p.actor.y, color: '#6ab8ff' }))] });
  const pill = el('div', 'gh-p bf-pill'), roster = el('div', 'gh-p bf-roster'); hud.el.querySelector('.gh-tr').append(pill, roster); roster.style.display = 'none';
  let pillKey = '';
  function drawPill() { const key = inv.count('coin') + '|' + state.charted + '|' + state.pail; if (key === pillKey) return; pillKey = key; pill.textContent = '';
    for (const [icon, text, title] of [['●', inv.count('coin'), 'Coins'], ['⚑', state.charted, 'New land charted'], ['≈', state.pail + '/' + T.PAIL, 'Water in the pail']]) { const s = el('span', null, ' ' + text); s.title = title; s.prepend(el('i', 'gh-i', icon)); pill.appendChild(s); } }
  drawPill();
  const bar = hotbarUI(hud, inv, { input });
  const bag = inventoryUI(hud, inv, { crafting: craft, stations: () => build.near(hero.x, hero.y, 3.5), canUse: (it) => !!(it.def.food || it.def.heal), onUse: (slot, it) => eat(it.id), onOpen: () => sound.play('click') });
  // The trading post: sell what you grew and found, buy seeds you have not got. Built from the same panel styles as the backpack.
  const shop = (() => { let win = null;
    const row = (id, text, label, can, act) => { const r = el('div', 'gp-rec' + (can ? '' : ' off')), im = el('img'), tx = el('div', null, text), b = el('button', 'gp-btn', label); im.src = itemIcon(id, inv.def(id)); im.alt = ''; b.disabled = !can; b.addEventListener('click', act); r.append(im, tx, b); return r; };
    const draw = () => { if (!win) return; const box = win.firstChild; box.textContent = ''; const sell = el('div'), buy = el('div'), h = el('p', 'gp-h', 'Sell'), x = el('button', 'gp-x', '✕'); x.addEventListener('click', S.close); sell.appendChild(h);
      const goods = Object.keys(T.ITEMS).filter((id) => T.ITEMS[id].sell && inv.has(id)); for (const id of goods) sell.appendChild(row(id, inv.def(id).name + ' × ' + inv.count(id), '+' + inv.count(id) * T.ITEMS[id].sell + ' ●', true, () => S.sell(id)));
      if (!goods.length) sell.appendChild(el('div', 'gp-info', 'Nothing to sell yet. The trader buys harvests, bread and crystals.'));
      const h2 = el('p', 'gp-h', 'Buy · ' + inv.count('coin') + ' coins'); h2.appendChild(x); buy.appendChild(h2); for (const id of Object.keys(T.ITEMS).filter((k) => T.ITEMS[k].buy)) buy.appendChild(row(id, inv.def(id).name, T.ITEMS[id].buy + ' ●', inv.has('coin', T.ITEMS[id].buy), () => S.buy(id)));
      box.append(sell, buy); };
    const key = (e) => { if (e.code === 'Escape' && win) { e.stopPropagation(); S.close(); } };
    const S = { get isOpen() { return !!win; },
      open() { if (win) return S; win = el('div', 'gp-win'); win.appendChild(el('div', 'gp-box')); win.addEventListener('pointerdown', (e) => { if (e.target === win) S.close(); }); hud.el.appendChild(win); addEventListener('keydown', key, true); sound.play('door'); draw(); return S; },
      close() { if (win) { win.remove(); win = null; removeEventListener('keydown', key, true); } return S; },
      sell(id) { const n = inv.count(id), price = T.ITEMS[id].sell; if (!n || !price) return false; inv.remove(id, n); inv.add('coin', n * price); state.sold += n; sound.play('coin'); draw(); return true; },
      buy(id) { const price = T.ITEMS[id].buy; if (!price || !inv.remove('coin', price)) return false; inv.add(id, 1); sound.play('pickup'); draw(); return true; } };
    return S; })();
  const menu = pauseMenu(hud, { title: T.TITLE, controls: T.CONTROLS, buttons: [['Sound on / off', () => sound.mute()], ['Save now', () => { keep().now(); hud.toast('Saved'); }]], onRestart: () => keep().clear().then(() => location.reload()) });
  hud.button('☰ Menu', () => menu.open());
  const interact = createInteract({ nodes, input, hud, inventory: inv, at: () => hero, tool: heldTool, send: (n, tool) => { useNode(n, tool); } });
  quests.onStep((step) => { sound.play('powerup'); hud.toast('Done: ' + step.text.split(':')[0]); });
  quests.onAll(() => { fx.confetti(hero.x, hero.y - 1); hero.play('cheer'); sound.play('win'); hud.toast(T.TITLE + ' is home now. The land goes on: so can you.', { seconds: 6 }); });
  let heldId = ''; const HELP = { hoe: 'tills the ground in front of you', pail: 'waters the crop in front of you; fill it at the well' };
  inv.onChange(() => { drawPill(); const h = inv.held, id = h ? h.id : ''; if (id === heldId || !state.playing) return; heldId = id; const d = h && h.def, k = input.keyOf('use') || 'Space';
    if (d) hud.hint(d.name + ': ' + (d.plant ? k + ' sows it on a tilled plot' : d.place ? k + ' places it in front of you' : d.food ? k + ' eats it' : HELP[d.tool] ? k + ' ' + HELP[d.tool] : d.tool ? 'works twice as fast' : d.about || ''), 4); });
  const aimMark = stage.add(aimArt, 0, 0); aimMark.visible = false;

  /* ===== 9. the frame loop. stage.run() draws the stage and calls GCP.ready() after the first frames. ===== */
  stage.run((dt) => {
    const open = bag.isOpen || menu.isOpen || shop.isOpen || state.busy; player.enabled = state.playing && !open;
    state.px = hero.x; state.py = hero.y; player.update(dt); glow.x = hero.x; glow.y = hero.y - 0.8 - state.elev * RISE;
    if (state.playing && (!menu.isOpen || net.room)) {   // alone, the world stops while the menu is up; in a room it cannot
      const g = dt * state.speed; clock.update(g); crops.update(g); needs.update(dt); nodes.update(dt); quests.update(); clockView.update(); bar.update(); drawPill();
      if (player.running) needs.add('stamina', -30 * dt);
      // height: stairs carry the hero up a little at a time, a deck holds them, and stepping off drops them back down
      const top = build.topAt(hero.x, hero.y, state.elev);
      if (!top && state.elev < 0.5 && build.allAt(hero.x, hero.y).some((p) => p.layer === 'floor')) { hero.x = state.px; hero.y = state.py; }   // a deck cannot be walked into from the ground
      else state.elev = top >= state.elev ? top : Math.max(top, state.elev - dt * 9);
      if (state.elev >= LEVEL) state.climbed = 1;
      // the cell that the thing in hand will act on
      const d = inv.held && inv.held.def, [ax, ay] = aim(); aimMark.visible = !open && !!d && !!(d.tool === 'hoe' || d.tool === 'pail' || d.plant || d.place); aimMark.x = ax; aimMark.y = ay - 0.5;
      const R = world.chunks.get(Math.floor(hero.x / CHUNK) + ',' + Math.floor(hero.y / CHUNK)); if (R && R.region && R.region.name !== state.region) { if (state.region) hud.toast(R.region.name, { color: T.LOOK.accent }); state.region = R.region.name; }
      if (!open) { interact.update(); if (input.action('use')) useHeld(); if (input.action('take')) takeBack(); }
      if (input.action('bag') && !shop.isOpen) bag.toggle(); if (input.action('mute')) sound.mute();
      for (let i = wobbles.length - 1; i >= 0; i--) { const w = wobbles[i]; w.t -= dt; w.ref.x = w.t > 0 ? w.x + Math.sin(w.t * 60) * 0.07 * (w.t / 0.28) : w.x; if (w.t <= 0) wobbles.splice(i, 1); }
      tickRoom(dt);
    }
    input.endFrame();
  });
  boot.done();

  /* ===== 10. two players. createWorldSync makes the host decide every change (a piece, a felled tree, a crop) and tell
     everyone, so both worlds stay the same; each player keeps their own backpack. Here is the rest: where the other
     player is (sent a few times a second, drawn a moment in the past so it glides), their name and the shared clock. ===== */
  function openRoom(room) {
    for (const p of [...net.peers.values()]) dropPeer(p.id);
    net.room = room;
    sync = createWorldSync(room, { build, nodes, crops, chunks: world, inventory: inv, onChange: (op) => {   // someone else changed the world: let it be heard and seen
      if (!room || op.by === room.id || op.x == null || Math.hypot(op.x - hero.x, op.y - hero.y) > 16) return; sound.play(op.op === 'water' ? 'splash' : op.op === 'plant' ? 'pop' : 'build', { volume: 0.5 }); fx.burst(op.x, op.y, 0xe8d8b0, 5); } });
    if (!room) return;
    room.on('message', (m, from) => { if (!m || net.room !== room) return; if (m.t === 'pose') onPose(from, m); else if (m.t === 'sleep' && room.isHost && (clock.isNight || clock.phase === 'dusk')) { passNight(); hud.toast('A friend called it a night'); } });
    room.on('leave', (id) => dropPeer(id)); room.on('open', drawRoster); room.on('join', drawRoster); room.on('close', () => hud.toast('The room was lost: trying again'));
  }
  function onPose(id, m) {
    let p = net.peers.get(id);
    if (!p) { p = { id, name: String(m.n || 'Friend').slice(0, 16), buf: [], e: 0, f: 'down', seen: 0 }; p.actor = lifted(actor2d(T.HERO, { x: m.x, y: m.y, shirt: T.FRIENDS[net.peers.size % T.FRIENDS.length] }), () => p.e * RISE);
      p.tag = stage.add(nameTag(p.name), m.x, m.y + 0.02); net.peers.set(id, p); hud.toast(p.name + ' is here'); sound.play('door'); drawRoster(); }
    p.buf.push({ t: performance.now(), x: m.x, y: m.y }); if (p.buf.length > 8) p.buf.shift(); p.f = m.f || 'down'; p.e = m.e || 0; p.seen = performance.now();
    if (!net.room.isHost && m.h != null && (Math.abs(m.h - clock.hour) > 0.1 || m.d !== clock.day)) { clock.day = m.d; clock.set(m.h); }   // the host's clock is everyone's clock
  }
  function dropPeer(id) { const p = net.peers.get(id); if (!p) return; net.peers.delete(id); p.tag.remove(); const i = stage.actors.indexOf(p.actor); if (i >= 0) stage.actors.splice(i, 1); if (net.room) hud.toast(p.name + ' left'); drawRoster(); }
  function drawRoster() { const r = net.room; roster.style.display = r ? '' : 'none'; if (r) roster.textContent = 'Room ' + net.code + ' · ' + [me, ...[...net.peers.values()].map((p) => p.name)].join(', '); }
  function tickRoom(dt) {
    const r = net.room, now = performance.now(), at = now - 140; if (!r) return;
    net.t -= dt; if (r.connected && net.t <= 0) { net.t = 0.12; r.send({ t: 'pose', x: r2(hero.x), y: r2(hero.y), f: hero.facing, e: r2(state.elev), n: me, ...(r.isHost ? { h: r2(clock.hour), d: clock.day } : {}) }); }
    for (const p of net.peers.values()) {   // between the two reports on either side of "a moment ago"
      const b = p.buf, a = p.actor; let i = 0; while (i < b.length - 1 && b[i + 1].t <= at) i++; const A = b[i], B = b[i + 1] || A, k = B === A ? 1 : clamp((at - A.t) / (B.t - A.t), 0, 1), x = lerp(A.x, B.x, k), y = lerp(A.y, B.y, k);
      a.moving = Math.hypot(x - a.x, y - a.y) > 0.25 * dt; a.x = x; a.y = y; a.facing = p.f; p.tag.x = x; p.tag.y = y + 0.02;
      if (now - p.seen > 8000) dropPeer(p.id);
    }
  }

  /* ===== 11. start: play alone, host a room or join one by its code. A returning player carries on from their save;
     a guest brings their backpack and finds the host's world. Sound starts on the first press. ===== */
  const keep = () => (net.room && net.room.connected && !net.room.isHost ? guestSave : save);
  const lobby = lobbyUI(hud, { title: T.TITLE, subtitle: T.TAGLINE, hint: T.HINT });
  async function begin(mode, code) {
    if (state.playing) return;
    if (!GCP.test.autostart) {
      if (mode === 'join') await guestSave.load();
      else if (await save.load()) hud.toast('Welcome back: day ' + clock.day);   // trees felled before stay felled: the land remembers them
    }
    net.code = code; openRoom(mode === 'solo' ? null : GCP.room(T.SAVE_KEY + '-' + code)); drawRoster();
    if (mode === 'host') hud.toast('Room ' + code + ': share the code with a friend', { seconds: 7 });
    state.playing = true; (mode === 'join' ? guestSave : save).auto(20);
    sound.ambience(T.SOUND.ambience); sound.music(T.SOUND.music); hud.hint(T.HINT, 10); drawPill();
  }
  lobby.then(({ mode, code }) => begin(mode, code));

  /* ===== 12. proof. The verification browser plays the game through here: the map grows, a tree stays felled, a crop
     is tilled, sown, watered, grown and harvested, bread is baked, a harvest sold, a lookout climbed, and a second
     player in a second world (rooms that talk inside this page) ends up with the same world. ===== */
  const test = GCP.test; test.onAutostart(() => lobby.solo());
  window.G = { state, hero, player, inv, craft, needs, clock, nodes, build, crops, quests, world, bag, shop, menu, stage, hud, net, useHeld, openRoom };
  test.onPlaythrough(async (t) => {
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y), nearest = (kind) => nodes.list.filter((n) => n.kind === kind && !n.gone && n.ref && n.ref.key && dist(n, hero) < 14).sort((a, b) => dist(a, hero) - dist(b, hero))[0];
    const hold = (id) => { let i = inv.slots.findIndex((s) => s && s.id === id); t.assert(i >= 0, id + ' is in the backpack'); if (i >= inv.hotbar) { inv.move(i, inv.hotbar - 1); i = inv.hotbar - 1; } inv.select(i); };
    const face = (x, y, dy = 1) => { player.teleport(x, y - dy); player.dir.x = 0; player.dir.y = dy; hero.facing = dy > 0 ? 'down' : 'up'; };   // stand beside a cell, facing it
    const print = (ch) => ch.items.map((it) => it.key + '@' + it.x.toFixed(2) + ',' + it.y.toFixed(2)).join(' ');

    t.step('play alone from the lobby'); if (!state.playing) lobby.solo(); await t.until(() => state.playing, 4000, 'the game to start'); t.assert(sync.isHost && nodes.list.length > 40, 'a world with things to use is there');

    t.step('the map grows as the player walks'); const home = print(world.chunks.get('0,0')), before = charted.size;
    t.assert(await player.moveTo(2.5, 2, 4), 'the hero walks on their own feet'); for (let i = 1; i <= 4; i++) { player.teleport(i * 24, 2); await t.frames(2); }
    t.assert(world.chunks.has('6,0') && !world.chunks.has('0,0'), 'new land is loaded and home is put away'); t.assert(charted.size >= before + 15 && state.charted >= 15, 'new land was charted: ' + state.charted);
    player.teleport(1, 2); await t.frames(2); t.assert(print(world.chunks.get('0,0')) === home, 'home comes back exactly as it was');

    t.step('a felled tree stays felled'); const tree = nearest('tree'), id = tree.id; player.teleport(tree.x, tree.y + 0.6); await t.frames(2); t.assert(interact.target, 'a prompt shows beside the tree');
    for (let i = 0; i < 6 && nodes.byId(id); i++) await useNode(tree, 'axe'); t.assert(!nodes.byId(id) && inv.has('wood') && world.toJSON().includes(id), 'the tree fell and gave wood');
    player.teleport(tree.x + 200, tree.y); await t.frames(2); player.teleport(tree.x, tree.y + 0.6); await t.frames(2); t.assert(!nodes.byId(id) && !world.items().some((it) => it.key === id), 'it is still gone after its chunk came back');

    t.step('till a plot, sow wheat, water it'); inv.add('hoe', 1); hold('hoe'); face(0, 3); t.assert(await useHeld(), 'the hoe tills'); t.assert(build.at(0, 3, 'ground'), 'a plot is there');
    hold('wheat_seed'); const seeds = inv.count('wheat_seed'); t.assert(await useHeld(), 'the seed is sown'); const crop = crops.at(0, 3); t.assert(crop && inv.count('wheat_seed') === seeds - 1, 'a crop is planted and one seed is spent');
    hold('pail'); await useHeld(); t.assert(!crop.watered, 'an empty pail waters nothing'); player.teleport(well.x, well.y + 1.2); await t.frames(2); t.assert(interact.target === well, 'the well offers water'); interact.use(); t.assert(state.pail === T.PAIL, 'the pail is full');
    face(0, 3); t.assert(await useHeld() && crop.watered && state.pail === T.PAIL - 1, 'the crop is watered');

    t.step('the crop grows through its stages as time passes'); state.speed = 120;
    for (let s = 1; s <= 3; s++) { if (!crop.watered) { face(0, 3); await useHeld(); } await t.until(() => crop.stage >= s, 6000, 'growth stage ' + s); } state.speed = 1; t.assert(crop.stage === 3, 'the wheat is ripe');

    t.step('harvest it: wheat, and seeds for the next sowing'); player.teleport(0, 3.3); await t.frames(2); t.assert(interact.target && interact.target.kind === 'crop', 'the ripe crop can be harvested'); const s0 = inv.count('wheat_seed');
    await useNode(interact.target); t.assert(inv.count('wheat') >= 2 && inv.count('wheat_seed') > s0 && !crops.at(0, 3) && state.harvested === 1, 'wheat and seeds are in the backpack');

    t.step('bake bread at a campfire and eat it'); inv.add('wood', 24); inv.add('stone', 3); inv.add('wheat', 3); t.assert(craft.make('campfire'), 'a campfire can be crafted'); hold('campfire'); face(2, 4); t.assert(await useHeld(), 'the campfire is placed');
    t.assert(build.at(2, 4) && !inv.has('campfire') && !craft.can('bread', []), 'it stands, and bread needs a fire'); player.teleport(2, 5.2); t.assert(craft.make('bread', build.near(hero.x, hero.y, 3.5)), 'bread bakes beside it');
    needs.set('food', 40); hold('bread'); await useHeld(); t.assert(needs.get('food') > 75 && state.meals === 1, 'eating fills the hero up');

    t.step('sell the harvest at the trading post'); player.teleport(post.x, post.y + 1.3); await t.frames(2); t.assert(interact.target === post, 'the post offers trade'); interact.use(); t.assert(shop.isOpen, 'the trade window opens');
    const wheat = inv.count('wheat'); shop.sell('wheat'); t.assert(wheat > 0 && inv.count('coin') === wheat * T.ITEMS.wheat.sell && state.sold === wheat, 'wheat became coins'); t.assert(shop.buy('carrot_seed') && inv.has('carrot_seed'), 'coins became new seeds'); shop.close();

    t.step('build stairs and a lookout deck, and climb up'); t.assert(craft.make('stairs') && craft.make('deck'), 'both can be crafted'); hold('stairs'); face(-2, 5, -1); t.assert(await useHeld(), 'the stairs are placed');
    const steps = build.at(-2, 5, 'floor'); t.assert(steps && steps.dir === 2, 'they rise the way the hero faces'); hold('deck'); t.assert(await useHeld() && build.at(-2, 4, 'floor', 1), 'the deck goes where the stairs lead');
    player.teleport(-2, 5.45); await t.frames(2); await player.moveTo(-2, 4, 4); await t.frames(2); t.assert(state.elev >= LEVEL && state.climbed, 'the hero stands on the deck: ' + state.elev.toFixed(2));
    player.teleport(0, 2); await t.until(() => state.elev < 0.1, 3000, 'the hero to be back on the ground');

    t.step('a second player shares the world'); const [ra, rb] = createLoopback(2), there = { x: 0, y: 0 }; net.code = 'TEST'; openRoom(ra);
    const unseen = { add: (sprite, x, y, o = {}) => ({ sprite, x, y, visible: true, scale: o.scale || 1, remove() {} }), onUpdate: () => () => {}, ground: land };   // the second player's land is not drawn here
    const B = { nodes: createNodes(), inv: createInventory({ items: T.ITEMS, start: { fence: 2, wheat_seed: 2 } }) }; B.world = growLand(unseen, B.nodes, () => there, 2); B.build = createBuilder({ grid: 1, levelHeight: LEVEL, pieces: pieceDefs(false) });
    B.crops = createCrops({ nodes: B.nodes, types: T.CROPS, grid: 1, water: true }); B.sync = createWorldSync(rb, { build: B.build, nodes: B.nodes, crops: B.crops, chunks: B.world, inventory: B.inv });
    const same = () => { const pr = (b, c, w) => JSON.stringify([b.toJSON().map((p) => p.join()).sort(), c.toJSON().map((x) => x.slice(0, 3).join()).sort(), w.toJSON().sort()]); return pr(build, crops, world) === pr(B.build, B.crops, B.world); };
    await t.until(() => sync.isHost && !B.sync.isHost && same(), 4000, 'the guest to receive the world as it stands'); t.assert(B.build.pieces.length === build.pieces.length && B.build.pieces.length >= 4, 'the guest sees what was built before it came');
    let r = await B.sync.place('fence', 4, 6); await t.frames(2); t.assert(!r.error && build.at(4, 6) && build.at(4, 6).ref && B.inv.count('fence') === 1, 'the guest builds a fence: it stands in the host world and cost the guest one');
    r = await B.sync.place('fence', 4, 6); t.assert(r.error === 'occupied', 'the host refuses a second piece on the same cell');
    hold('hoe'); face(1, 6); await useHeld(); hold('wheat_seed'); await useHeld(); await t.until(() => B.crops.at(1, 6) && B.build.at(1, 6, 'ground'), 2000, 'the host\'s crop to show for the guest');
    const oak = nearest('tree'), twin = B.nodes.byId(oak.id); t.assert(twin, 'both worlds have the same tree'); for (let i = 0; i < 6 && !(r && r.done); i++) r = await B.sync.use(twin); await t.frames(2);
    t.assert(r.done && B.inv.has('wood') && !nodes.byId(oak.id) && oak.ref.visible === false, 'the guest fells a tree: it falls for the host too and the wood is the guest\'s');
    there.x = 400; B.world.update(); rb.send({ t: 'pose', x: 400, y: 0, f: 'left', n: 'Robin' }); await t.until(() => net.peers.size === 1, 2000, 'the other player to appear');
    const far = B.nodes.list.find((n) => n.kind === 'tree' && n.ref.key && Math.hypot(n.x - 400, n.y) < 12); t.assert(far && !nodes.byId(far.id), 'the guest stands where the host has nothing loaded'); r = null; for (let i = 0; i < 6 && !(r && r.done); i++) r = await B.sync.use(far);
    t.assert(r.done && world.toJSON().includes(far.id), 'the host answers for land it does not see, and remembers the tree is gone ');
    for (let i = 1; i <= 4; i++) { rb.send({ t: 'pose', x: 2 + i, y: 3, f: 'right', n: 'Robin' }); await t.wait(120); } const friend = [...net.peers.values()][0]; await t.until(() => friend.actor.x > 2.9 && friend.actor.x <= 6, 2000, 'the other player to walk into view');
    t.assert(friend.name === 'Robin' && stage.items.includes(friend.tag) && Math.abs(friend.tag.x - friend.actor.x) < 0.01, 'their name is over their head'); await t.until(same, 4000, 'both worlds to agree');

    t.step('the world is saved'); const d = save.now(); t.assert(d && d.parts.build.length === build.pieces.length && d.parts.crops.length === 1 && d.parts.world.includes(id) && d.parts.mine.charted.length === charted.size && d.parts.inv.slots.some(Boolean), 'the save holds the pieces, the crop, the felled trees, the map and the backpack');
    openRoom(null); net.code = ''; drawRoster(); player.teleport(0, 2);
  });
});

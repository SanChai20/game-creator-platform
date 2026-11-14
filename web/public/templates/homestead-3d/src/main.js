// Template: homestead-3d (from the platform's templates; src/theme.js is the game, this file the engine. Keep this line: the report uses it to tell how much is still the template.)
// Highfallow — a third-person homestead for one or two players: hills that go on for ever and fill in as you walk,
// crops to till, sow, water and harvest, and one shared world when a friend joins by room code.
//
// This file is the ENGINE. It is written on the building blocks of @gcp/craft.js (get_block {name} lists the options
// of each) and reads everything that is particular to this game from ./theme.js: names, the look, items, recipes,
// crops, pieces, regions of the land and the quest steps. To make a different game, rewrite theme.js; to change how
// the game works, change the numbered section here that owns it. The ground plane is x, z; the play systems call
// the second axis y, so `y` in a node, a piece or a crop is z in the world. Sections:
//   1 stage and hero         4 systems                   7 interface                 10 start: lobby, save, room
//   2 models built here      5 home                      8 the frame loop            11 proof (the play-through)
//   3 the world that grows   6 using what you hold       9 two players
import * as THREE from 'three';
import { run, createStage, terrainChunks, water, tree, rock, bush, groundCover, prop, place, grassField, humanoid, animal, control, wander, createFx, surface, tbox, Simplex, toSeed, rng, clamp, lerp, smoothstep, createHud, createSound, createInput,
  createInventory, createCrafting, createNeeds, createClock, createNodes, createInteract, createBuilder, stairsPiece, createCrops, createQuests, createSave,
  createWorldSync, createLoopback, itemIcon, hotbarUI, inventoryUI, needsUI, clockUI, questUI, minimapUI, pauseMenu, lobbyUI } from '@gcp/craft.js';
import * as T from './theme.js';

const GCP = window.GCP, CHUNK = 40, GRID = 2, LEVEL = 3;   // metres: one chunk of land; one cell for building and planting; one storey
const r2 = (v) => Math.round(v * 100) / 100, pickOf = (list) => list[Math.floor(Math.random() * list.length)], cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1), el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

run(async (boot) => {
  /* ===== 1. stage and hero: sky, sun, fog, shadows and weather follow one mood; on a slow device the stage draws less by itself ===== */
  await boot.step(0.1, 'Raising the hills');
  const AIR = T.LOOK.weather === undefined ? 'motes' : T.LOOK.weather;   // what drifts in the air by day
  const stage = createStage('#view', { mood: T.LOOK.mood, weather: AIR }), fx = createFx(), SEEN = stage.software ? 1 : 2;   // chunks kept around the player
  const state = { playing: false, busy: false, speed: 1, pail: 0, tilled: 0, planted: 0, watered: 0, harvested: 0, meals: 0, cooked: 0, sold: 0, climbed: 0, drinks: 0, slain: 0, charted: 0, region: '' };
  const net = { room: null, code: '', t: 0, peers: new Map() };   // the room, if any, and the other players in it (section 9)
  const hero = humanoid({ preset: T.HERO }), me = (GCP.player && GCP.player.name) || 'Farmer'; stage.scene.add(hero); hero.position.set(0, 0, 2);
  const input = createInput(stage.renderer.domElement), sound = createSound(), hud = createHud({ accent: T.LOOK.accent, ink: T.LOOK.ink, panel: T.LOOK.panel });
  // Actions are named once; the keyboard, the mouse, on-screen buttons on phones and a gamepad all trigger them.
  input.bind({ interact: ['KeyE'], use: ['KeyF', 'Mouse2'], bag: ['Tab', 'KeyI'], take: ['KeyX'], run: ['ShiftLeft', 'ShiftRight'], jump: ['Space'], mute: ['KeyM'] },
    { touch: { interact: 'E', use: '✋', bag: '▦', jump: '⤒' }, pad: { jump: 0, take: 1, use: 2, bag: 3, interact: 5, run: 10 }, bottom: 96 });

  /* ===== 2. models built here: the few things the kit has no prop for ===== */
  const soil = T.LOOK.soil.map((c) => new THREE.MeshLambertMaterial({ color: c })), ridge = T.LOOK.soil.map((c) => new THREE.MeshLambertMaterial({ color: new THREE.Color(c).multiplyScalar(0.78) }));
  const bedGeo = new THREE.BoxGeometry(1.74, 0.16, 1.74), ridgeGeo = new THREE.BoxGeometry(1.6, 0.08, 0.2), slabGeo = tbox(GRID, 0.16, GRID), postGeo = new THREE.BoxGeometry(0.14, 1, 0.14), planks = surface('planks'), dark = new THREE.MeshLambertMaterial({ color: 0x6a4a2c });
  function plotModel(x, y, z) {   // a tilled bed; group.userData.wet(true) darkens it while its crop is watered
    const g = new THREE.Group(), bed = new THREE.Mesh(bedGeo, soil[0]), rows = [-0.52, 0, 0.52].map((dz) => { const m = new THREE.Mesh(ridgeGeo, ridge[0]); m.position.set(0, 0.17, dz); m.receiveShadow = true; g.add(m); return m; });
    bed.position.y = 0.06; bed.receiveShadow = true; g.add(bed); g.position.set(x, y, z); stage.scene.add(g); g.userData.wet = (on) => { bed.material = soil[on ? 1 : 0]; for (const m of rows) m.material = ridge[on ? 1 : 0]; }; return g;
  }
  function deckModel(x, y, z, drop) {   // a plank floor on four posts that reach down `drop` metres to the ground
    const g = new THREE.Group(), top = new THREE.Mesh(slabGeo, planks); top.position.y = -0.03; top.castShadow = top.receiveShadow = true; g.add(top);
    if (drop > 0.3) for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const p = new THREE.Mesh(postGeo, dark); p.scale.y = drop + 0.6; p.position.set(dx * 0.86, -(drop + 0.6) / 2 - 0.1, dz * 0.86); p.castShadow = true; g.add(p); }
    g.position.set(x, y, z); stage.scene.add(g); return g;
  }
  const stoneMat = surface('stonewall'), sootMat = new THREE.MeshLambertMaterial({ color: 0x241812 }), glowMat = new THREE.MeshBasicMaterial({ color: 0xffa040 });
  function furnaceModel(x, y, z) {   // a stone furnace: a block, a chimney and a lit mouth
    const g = new THREE.Group(), part = (geo, mat, px, py, pz) => { const m = new THREE.Mesh(geo, mat); m.position.set(px, py, pz); m.castShadow = mat !== glowMat; g.add(m); return m; };
    part(tbox(1.5, 1.3, 1.4), stoneMat, 0, 0.65, 0); part(tbox(0.5, 1.0, 0.5), stoneMat, 0.3, 1.8, -0.3); part(new THREE.BoxGeometry(0.7, 0.6, 0.1), sootMat, 0, 0.5, 0.71); part(new THREE.BoxGeometry(0.5, 0.26, 0.1), glowMat, 0, 0.34, 0.73);
    const lamp = new THREE.PointLight(0xff9040, 6, 7); lamp.position.set(0, 0.6, 1.2); g.add(lamp); g.position.set(x, y, z); stage.scene.add(g); return g;
  }
  const aimMark = new THREE.Mesh(new THREE.PlaneGeometry(GRID - 0.14, GRID - 0.14).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false, fog: false })); aimMark.visible = false; aimMark.renderOrder = 3; stage.scene.add(aimMark);
  aimMark.add(new THREE.LineSegments(new THREE.EdgesGeometry(aimMark.geometry), new THREE.LineBasicMaterial({ color: 0xffffff, fog: false })));
  function nameTag(name) { const c = document.createElement('canvas'); c.width = 256; c.height = 64; const g = c.getContext('2d'); g.font = '700 30px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; const w = Math.min(246, g.measureText(name).width + 28);
    g.fillStyle = 'rgba(16,14,10,.62)'; g.beginPath(); g.roundRect(128 - w / 2, 8, w, 48, 14); g.fill(); g.fillStyle = '#fff'; g.fillText(name, 128, 33); const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, fog: false, toneMapped: false })); s.scale.set(2.6, 0.65, 1); s.position.y = 2.4; s.renderOrder = 4; return s; }

  /* ===== 3. the world that grows. The land is cut into chunks around the player from one height function, so chunks
     meet without seams; each is filled the same way every time from the seed, so the land is endless, the same for
     every player, and costs nothing to save. A chunk with ch.far is one a host keeps unseen around a guest who walked
     away (createWorldSync asks for it): it gets its trees and rocks but no grass and no animals. ===== */
  await boot.step(0.3, 'Growing the land');
  const nz = new Simplex(toSeed(T.SEED)), AMP = T.LOOK.relief, HOME_Y = AMP * 0.55;   // home stands this far above the water
  const hills = (x, z) => nz.fbm2(x * 0.009, z * 0.009, 4) * AMP + nz.n2(x * 0.04, z * 0.04) * AMP * 0.1 + HOME_Y;   // rolling hills; the clearing below makes them level around home
  const kinds = new Map(), thingOf = new Map(), art = (name) => { let k = kinds.get(name); if (!k) { const th = T.THINGS[name], [block, o] = th.art; k = block === 'tree' ? tree(o) : block === 'rock' ? rock(o) : block === 'bush' ? bush(o) : block === 'cover' ? groundCover(o.type, o) : prop(o.kind, o); kinds.set(name, k); thingOf.set(k, th); } return k; };
  const regionAt = (cx, cz) => { const far = Math.max(Math.abs(cx + 0.5), Math.abs(cz + 0.5)) | 0, list = T.REGIONS.filter((r) => r.far <= far); return far < 2 ? T.REGIONS[0] : list[Math.floor(rng(T.SEED + '|region|' + Math.floor(cx / 2) + ',' + Math.floor(cz / 2))() * list.length)]; };
  const nodeOf = (it) => { const th = thingOf.get(it.kind); return th && th.node ? { r: Math.min(it.r, 1.2) + 1.5, ...th.node } : null; };
  const dry = (x, z, y, slope) => y > 0.7 && slope < 0.9;   // where things may stand: out of the water, off the steep banks
  function growLand(st, set, around, radius) {
    const w = terrainChunks({ height: hills, clearing: { x: 0, z: 0, r: T.HOME.flat, y: HOME_Y }, palette: T.LOOK.palette, seed: T.SEED, amplitude: AMP, chunk: CHUNK, radius, stage: st, around, fill: (ch) => {
      const R = regionAt(ch.cx, ch.cz), keep = [{ x: 0, z: 0, r: T.HOME.clear }];
      const found = [...ch.scatter(R.trees.map(art), { count: R.count, minDistance: 4.5, scale: [1, 1.5], where: dry, avoid: keep, seed: 'trees' }).items, ...ch.scatter(R.cover.map(art), { count: R.coverCount, minDistance: 2.2, where: dry, avoid: keep, seed: 'cover' }).items];
      set.fromScatter(found, nodeOf);   // every tree, rock and bush can be used; its id is its place in the chunk
      const x = ch.x + 4 + ch.rand() * (CHUNK - 8), z = ch.z + 4 + ch.rand() * (CHUNK - 8);   // the same draws on every device, whatever comes of them
      if (ch.rand() < R.chest && Math.hypot(x, z) > 45 && hills(x, z) > 0.9) set.fromScatter([ch.place(art('chest'), x, z, { key: 'chest', type: 'chest', rotY: ch.rand() * 6 }).item], () => ({ r: 2.3, ...T.THINGS.chest.node }));   // a key lets an opened chest stay gone
    } });
    w.onUnload((ch) => { const gone = new Set(ch.items); set.removeWhere((n) => gone.has(n.ref)); });
    return w;
  }
  const nodes = createNodes(), charted = new Set();
  const land = growLand(stage, nodes, () => hero.position, SEEN), height = land.heightAt, solids = [];   // solids: what is built and what stands at home; the scenery is in land.solids
  // What only the land you see gets: grass that takes the colour of the ground, and animals that run from the hero. Put away with its chunk.
  const dress = (ch) => {
    if (ch.far) return; ch.region = regionAt(ch.cx, ch.cz); const grass = grassField({ land, area: [CHUNK, CHUNK], center: [ch.x + CHUNK / 2, ch.z + CHUNK / 2], count: 1100, height: 0.36, where: (x, z, y, slope) => dry(x, z, y, slope) && Math.hypot(x, z) > T.HOME.clear, seed: ch.cx * 31 + ch.cz });   // short, and none in the yard, so plots show
    ch.keep({ remove() { for (const m of [grass, grass.userData.flowers]) if (m) { m.removeFromParent(); m.geometry.dispose(); } } });
    for (const kind of stage.software ? [] : ch.region.animals || []) { const x = ch.x + Math.random() * CHUNK, z = ch.z + Math.random() * CHUNK; if (Math.random() < 0.5 && height(x, z) > 1 && Math.hypot(x, z) > 14) { const a = animal(kind); a.position.set(x, height(x, z), z); stage.scene.add(a); const brain = wander(a, { heightAt: height, flee: a.flies ? null : hero, radius: 12 }); ch.keep({ remove() { brain.stop(); a.removeFromParent(); } }); } }
  };
  for (const ch of land.chunks.values()) dress(ch); land.onLoad(dress);
  for (const k of land.chunks.keys()) charted.add(k); const FIRST = (SEEN * 2 + 1) ** 2;
  land.onLoad((ch) => { const k = ch.cx + ',' + ch.cz; if (!ch.far && !charted.has(k)) { charted.add(k); state.charted++; } });
  const lake = water({ level: 0, size: 720, ...(T.LOOK.sea ? { color: T.LOOK.sea } : {}) });

  /* ===== 4. systems: backpack, recipes, needs, the day, building, crops, quests, saving ===== */
  await boot.step(0.6, 'Stocking the shed');
  const inv = createInventory({ slots: 24, hotbar: 8, items: T.ITEMS, start: T.START });
  const craft = createCrafting(inv, T.RECIPES); craft.onCraft((r) => { sound.play('build'); if (r.station && inv.def(r.makes).food) state.cooked++; });
  // Needs. T.NEEDS says how many days a full bar lasts; water is there only when the theme asks for thirst.
  const NEED = T.NEEDS || {}, thirst = NEED.water > 0, slow = (days) => ({ max: 100, drain: 100 / (T.DAY * days), empty: { health: -2.5 } });
  const needs = createNeeds({ health: { max: 100 }, food: { ...slow(NEED.food || 1.4), full: { health: 0.5 } }, ...(thirst ? { water: { ...slow(NEED.water), color: '#5ab0e8' } } : {}), stamina: { max: 100, regen: 16 } });
  const clock = createClock({ dayLength: T.DAY, hour: 8, stage });   // the light of the stage follows the hour

  // Building. A piece is a prop; a tilled plot and a deck are the models of section 2, stairs are the kit's. A campfire
  // and a bedroll also add something to do beside them. pieceDefs(false) is the same set for a world nobody looks at.
  const at3 = (x, z, up = 1) => ({ x, y: land.heightAt(x, z) + up, z }), USES = { cook: () => bag.open(), sleep: () => sleep() }, shapeKind = (shape) => Object.keys(T.PIECES).find((k) => T.PIECES[k].shape === shape);
  const drawPiece = (kind) => (x, z, p) => {
    const d = T.PIECES[kind], y = land.heightAt(x, z) + p.base, turn = p.dir * Math.PI / 2;
    const g = d.shape === 'plot' ? plotModel(x, y, z) : d.shape === 'stairs' ? place(prop('stairs', { width: GRID, depth: GRID, rise: LEVEL }), x, y, z, { rotY: turn }) : d.shape === 'deck' ? deckModel(x, y, z, p.base) : d.shape === 'furnace' ? furnaceModel(x, y, z) : place(prop(d.model), x, y, z, { rotY: turn });
    const node = d.use ? nodes.add({ x, y: z, r: 2.6, label: d.label, onUse: () => USES[d.use](p) }) : null;
    return { wet: g.userData.wet, remove() { g.removeFromParent(); if (node) nodes.remove(node); } };
  };
  const pieceDefs = (live) => Object.fromEntries(Object.entries(T.PIECES).map(([k, d]) => { const make = live ? drawPiece(k) : null;
    return [k, d.shape === 'stairs' ? stairsPiece({ grid: GRID, rise: LEVEL, cost: d.cost, make }) : { cost: d.cost, solid: d.solid, station: d.station, layer: d.shape === 'deck' ? 'floor' : 'ground', height: d.shape === 'deck' ? 0.05 : 0, make }]; }));
  const blocked = (x, z, r) => [...land.solids, ...solids].some((s) => !s.off && Math.hypot(s.x - x, s.z - z) < Math.min(s.r, 1) + r);
  const build = createBuilder({ grid: GRID, levelHeight: LEVEL, inventory: inv, solids, pieces: pieceDefs(true),
    canPlace: (x, z, kind, level) => land.heightAt(x, z) > 0.5 && (level > 0 || (land.slopeAt(x, z) < 0.6 && !blocked(x, z, 0.6) && (!!T.PIECES[kind].shape || Math.hypot(x - hero.position.x, z - hero.position.z) > 1))) });
  // Where feet stand: the land, or the top of stairs and decks the hero can step onto from where it is (one step up at most).
  const floorAt = (x, z) => { const g = land.heightAt(x, z); if (!build.pieces.length) return g; const [cx, cz] = build.snap(x, z), base = land.heightAt(cx, cz), top = build.topAt(x, z, hero.position.y - base + 0.05); return top ? Math.max(g, base + top) : g; };
  const player = control(hero, { input, mode: 'third', heightAt: floorAt, solids: land.solids, minY: 0.25, distance: 7.5, pitch: 0.34, canRun: () => needs.get('stamina') > 3,
    onStep: () => sound.play('step', { volume: 0.5 }), onJump: () => sound.play('jump'), onLand: () => sound.play('land') }).addSolids(solids);

  // Crops grow in three waterings: each new stage dries the soil again. Ripe ones are harvested through the nodes.
  const drawCrop = (x, z, c) => { const g = place({ kind: 'prop', prop: 'crop', type: c.type, stage: c.stage, soil: false, seed: 7 }, x, land.heightAt(x, z) + 0.02, z), plot = build.at(x, z, 'ground'), wet = plot && plot.ref && plot.ref.wet; if (wet) wet(c.watered); return { remove() { g.removeFromParent(); if (wet) wet(false); } }; };
  const crops = createCrops({ nodes, types: T.CROPS, grid: GRID, water: true, make: drawCrop });
  crops.onRipe((c) => { fx.sparkle(at3(c.x, c.y, 0.8), 0xffe27a); if (Math.hypot(c.x - hero.position.x, c.y - hero.position.z) < 30) sound.play('pop'); });

  const quests = createQuests(T.STEPS.map((s) => ({ id: s.id, text: s.text, done: () => s.when(state, inv) })));
  // What is saved: the backpack, the needs, the day, what was built and planted, which trees are gone, the quests and where you stand.
  const mine = { toJSON: () => ({ x: r2(hero.position.x), z: r2(hero.position.z), pail: state.pail, charted: [...charted], n: [state.tilled, state.planted, state.watered, state.harvested, state.meals, state.cooked, state.sold, state.climbed, state.drinks, state.slain] }),
    load(d) { if (!d) return; player.teleport(+d.x || 0, +d.z || 0); state.pail = clamp(d.pail | 0, 0, T.PAIL); for (const k of d.charted || []) charted.add(k); state.charted = Math.max(0, charted.size - FIRST); [state.tilled, state.planted, state.watered, state.harvested, state.meals, state.cooked, state.sold, state.climbed, state.drinks, state.slain] = (d.n || []).map((v) => v | 0).concat([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); } };
  const save = createSave(T.SAVE_KEY, { inv, needs, clock, build, crops, land, quests, mine }, T.SAVE);               // the host's or the lone player's: the whole world
  const guestSave = createSave(T.SAVE_KEY + '-guest', { inv, needs, quests }, T.SAVE);                                  // a guest keeps only what they carry

  /* ===== 5. home: the well and the trading post stand at the start for every player ===== */
  const [wx, wz] = T.HOME.well, [tx, tz] = T.HOME.post;
  place(prop('well'), wx, land.heightAt(wx, wz), wz); solids.push({ x: wx, z: wz, r: 1.3 });
  for (const [kind, x, z, turn, r] of T.HOME.decor) { place(prop(kind), x, land.heightAt(x, z), z, { rotY: turn }); if (r) solids.push({ x, z, r }); }
  const well = nodes.add({ x: wx, y: wz, r: 2.6, label: thirst ? 'Drink, and fill the pail' : 'Fill the pail', onUse: () => { if (thirst) drink(); if (!thirst || inv.has('pail')) fillPail(); } });
  const post = nodes.add({ x: tx, y: tz, r: 2.6, label: 'Trade at the post', onUse: () => shop.open() });

  /* ===== 6. using what you hold. One button: food is eaten, a hoe tills, seeds are sown, the pail waters, a piece is
     placed, all on the cell in front of you. Every change to the world goes through `sync`, so it is the same code
     alone and in a room (see section 9). ===== */
  let sync = null;
  const aim = () => { const a = player.ahead(GRID); return build.snap(a.x, a.z); }, heldTool = () => inv.held && inv.held.def.tool, facing = () => ((Math.round(player.yaw / (Math.PI / 2)) % 4) + 4) % 4;   // 0 +z, 1 +x, 2 -z, 3 -x
  const say = (x, z, text, color = T.LOOK.accent) => fx.floatText(at3(x, z, 1.9), text, { color }), no = (why) => { hud.toast(cap(why)); sound.play('error'); return false; };
  function fillPail() { if (!inv.has('pail')) return no('You need a pail'); state.pail = T.PAIL; sound.play('splash'); fx.splash(at3(hero.position.x, hero.position.z, 1)); say(hero.position.x, hero.position.z, 'Pail filled', '#8fd0ff'); drawPill(); return true; }
  function drink() { needs.set('water', 100); state.drinks++; sound.play('splash'); say(hero.position.x, hero.position.z, 'Refreshed', '#8fd0ff'); return true; }
  function eat(id) { const d = inv.def(id); if (!inv.remove(id, 1)) return false; needs.add('food', d.food || 0); needs.add('health', d.heal || 0); if (thirst && d.drink) needs.add('water', d.drink); state.meals++; sound.play('heal'); hero.play('cheer'); say(hero.position.x, hero.position.z, '+' + (d.food || d.heal) + (d.food ? ' food' : ' health')); return true; }
  async function useHeld(slot = inv.selected) {
    const s = inv.slots[slot]; if (!s || !state.playing || state.busy) return false;
    const d = inv.def(s.id); let [x, z] = aim();
    if (foes.length && strike()) return true;   // a foe in reach comes first, whatever is in the hand
    if (d.weapon) return no('Nothing to strike');
    if (d.food || d.heal) return eat(s.id);
    if (d.tool === 'hoe') {
      if (build.at(x, z, 'ground')) return no('Something is already there');
      const r = await sync.place(shapeKind('plot'), x, z); if (r.error) return no(r.error === 'cannot build here' ? 'The ground here cannot be tilled' : r.error);
      state.tilled++; hero.play('attack'); sound.play('chop', { pitch: 0.7 }); fx.puff(at3(x, z, 0.3), 0x8a6440); return true;
    }
    if (d.plant) {
      const plot = build.at(x, z, 'ground'); if (!plot || T.PIECES[plot.kind].shape !== 'plot') return no('Till the ground with a hoe first');
      const r = await sync.plant(d.plant, x, z); if (r.error) return no(r.error === 'occupied' ? 'Something already grows there' : r.error);
      state.planted++; hero.play('pickup'); sound.play('pop'); fx.puff(at3(x, z, 0.3), 0x8fd16a); return true;
    }
    if (d.tool === 'pail') {
      const a = player.ahead(2); if (land.heightAt(a.x, a.z) < 0.2 || Math.hypot(well.x - hero.position.x, well.y - hero.position.z) < 3) { if (thirst) drink(); return fillPail(); }
      const c = crops.at(x, z); if (!c) return no('Nothing is planted there'); if (c.watered || c.stage >= 3) return no(c.stage >= 3 ? 'It is ripe: harvest it' : 'The soil is still wet');
      if (state.pail <= 0) return no('The pail is empty: fill it at the well or a shore');
      const r = await sync.water(x, z); if (r.error) return no(r.error);
      state.pail--; state.watered++; hero.play('pickup'); sound.play('splash'); fx.splash(at3(x, z, 0.4)); drawPill(); return true;
    }
    if (d.place) {
      const p = T.PIECES[d.place], level = p.level || 0, under = build.at(x, z, 'floor', 0);
      if (level && under && build.defs[under.kind].ramp) { x += [0, 1, 0, -1][under.dir] * GRID; z += [1, 0, -1, 0][under.dir] * GRID; }   // a deck aimed at stairs goes where the stairs lead
      const r = await sync.place(d.place, x, z, { level, dir: facing() }); if (r.error) return no(r.error);
      sound.play('build'); fx.puff(at3(x, z, 0.5 + level * LEVEL), 0xe8d8b0); return true;
    }
    hud.toast(d.tool ? d.name + ': keep it in hand and press ' + (input.keyOf('interact') || 'E') + ' at a tree or a rock' : d.name + ' is for crafting' + (d.sell ? ' or selling' : '')); return false;
  }
  async function takeBack() { const [x, z] = aim(); if (crops.at(x, z)) return no('Something grows there'); const r = await sync.remove(x, z); if (r.error) return false; sound.play('pop'); hud.toast('Took back the ' + inv.def(r.kind).name.toLowerCase()); return true; }
  // E on a tree, a rock, a bush, a ripe crop, a chest. The right tool counts double. The host decides; this player gets the drops.
  async function useNode(n, tool = heldTool()) {
    const r = await sync.use(n, { tool, power: n.best && n.best === tool ? 2 : 1 });
    if (r.error) return r.error === 'gone' ? r : (no(r.error), r); if (n.onUse) return r;
    const p = at3(n.x, n.y, 1.2); hero.play('attack'); stage.shake(0.12); sound.play(n.kind === 'rock' ? 'hit' : n.hp > 1 ? 'chop' : 'pop'); if (n.kind === 'tree') fx.leaves(at3(n.x, n.y, 3), 0x6aa84a); else fx.puff(p, n.kind === 'rock' ? 0xb8b4aa : 0x8fbf6a);
    if (r.done) { sound.play('pickup'); say(n.x, n.y, Object.entries(r.drops || {}).filter(([, k]) => k).map(([id, k]) => '+' + k + ' ' + inv.def(id).name.toLowerCase()).join('  ')); if (n.kind === 'crop') state.harvested++; if (n.kind === 'tree') { stage.shake(0.35); fx.puff(p, 0x8a5a34); } }
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
  needs.onDeath(() => { for (const f of [...foes]) dropFoe(f); needs.load({ health: 60, food: 45, stamina: 100, ...(thirst ? { water: 60 } : {}) }); player.teleport(0, 2); hud.flash('#000', 1.2); hud.toast('You wake by the well, hungry but alive'); sound.play('lose'); });
  clock.onPhase((phase) => {
    if (phase === 'dusk') { hud.toast('The light is going: a bedroll lets you sleep'); sound.play('bell'); stage.setWeather(AIR && AIR !== 'motes' ? AIR : 'fireflies'); sound.ambience(T.SOUND.nightAmbience); }
    if (phase === 'dawn' || phase === 'day') for (const f of [...foes]) { fx.puff(f.actor.position, 0x2a2a3a); dropFoe(f); }   // what came in the dark goes with it
    if (phase === 'dawn') { stage.setWeather(AIR); sound.ambience(T.SOUND.ambience); if (state.playing) hud.toast('Day ' + clock.day); }
  });

  /* ===== foes (only when the theme has T.FOES). After dark they come out of the land around the player and give chase;
     the use button strikes one in reach (a weapon counts for more), and one that falls leaves its loot. They go at dawn.
     Each player meets their own: foes are not shared in a room. ===== */
  const FOE = T.FOES, foes = []; let foeTimer = 3;
  const gap = (f) => Math.hypot(f.actor.position.x - hero.position.x, f.actor.position.z - hero.position.z);
  function spawnFoe(x, z) {
    const a = animal(pickOf(FOE.kinds)), f = { actor: a, hp: FOE.hp, cool: 0.6 }; a.position.set(x, land.heightAt(x, z), z); stage.scene.add(a);
    f.brain = wander(a, { heightAt: land.heightAt, chase: hero, range: 40, speed: FOE.speed || 2.6, radius: 10, onReach: () => { if (f.cool > 0 || !state.playing || state.busy) return; f.cool = 1.1; needs.add('health', -FOE.hit); sound.play('hurt'); stage.shake(0.3); say(hero.position.x, hero.position.z, '-' + FOE.hit, '#ff6a5a'); } });
    foes.push(f); return f;
  }
  function dropFoe(f) { f.brain.stop(); f.actor.removeFromParent(); foes.splice(foes.indexOf(f), 1); }
  function strike() {
    const f = foes.filter((q) => gap(q) < 3.2).sort((p, q) => gap(p) - gap(q))[0]; if (!f) return false;
    const a = f.actor.position, dx = a.x - hero.position.x, dz = a.z - hero.position.z, d = Math.hypot(dx, dz) || 1, hit = (inv.held && inv.held.def.weapon) || 1;
    f.hp -= hit; f.cool = 0.7; hero.play('attack'); sound.play('hit'); stage.shake(0.15); fx.puff(at3(a.x, a.z, 0.8), 0xffe0b0); a.x += dx / d * 1.8; a.z += dz / d * 1.8;
    if (f.hp > 0) return true;
    const got = []; for (const id in FOE.loot) { const [lo, hi] = [].concat(FOE.loot[id], FOE.loot[id]), n = lo + Math.floor(Math.random() * (hi - lo + 1)); if (n > 0 && !inv.add(id, n)) got.push('+' + n + ' ' + inv.def(id).name.toLowerCase()); }
    state.slain++; sound.play('pickup'); fx.puff(at3(a.x, a.z, 0.6), 0x2a2a3a); say(a.x, a.z, got.join('  ')); dropFoe(f); return true;
  }
  function tickFoes(dt) {
    if (!FOE) return; for (const f of foes) f.cool -= dt;
    for (const f of [...foes]) if (gap(f) > 70) dropFoe(f);
    foeTimer -= dt; if (foeTimer > 0 || !clock.isNight || foes.length >= FOE.count) return; foeTimer = FOE.every || 6;
    const t = Math.random() * 6.2832, x = hero.position.x + Math.cos(t) * 24, z = hero.position.z + Math.sin(t) * 24; if (land.heightAt(x, z) > 0.4 && Math.hypot(x, z) > T.HOME.clear + 8) spawnFoe(x, z);   // never in the yard itself
  }

  /* ===== 7. interface: needs and the almanac top left; the clock, the map and the purse top right; the hotbar at the
     bottom; the backpack with crafting on Tab; the trading post; a pause menu on Escape ===== */
  needsUI(hud, needs);
  questUI(hud, quests, { corner: 'tl', title: 'Almanac', max: 3 });
  const clockView = clockUI(hud, clock), tint = new THREE.Color();
  minimapUI(hud, { center: () => ({ x: hero.position.x, y: hero.position.z }), range: 70, cells: 36, color: (x, z) => (land.heightAt(x, z) < 0.15 ? '#3f7fb0' : land.colorAt(x, z, tint)),
    markers: () => [{ x: 0, y: 0, color: '#ffffff' }, ...build.pieces.filter((p) => !T.PIECES[p.kind].shape).map((p) => ({ x: p.x, y: p.y, color: '#ffb347' })), ...crops.list.map((c) => ({ x: c.x, y: c.y, color: c.stage === 3 ? '#ffe27a' : '#8fd16a' })), ...[...net.peers.values()].map((p) => ({ x: p.actor.position.x, y: p.actor.position.z, color: '#6ab8ff' }))] });
  const pill = el('div', 'gh-p hf-pill'), roster = el('div', 'gh-p hf-roster'); hud.el.querySelector('.gh-tr').append(pill, roster); roster.style.display = 'none';
  let pillKey = '';
  function drawPill() { const key = inv.count('coin') + '|' + state.charted + '|' + state.pail; if (key === pillKey) return; pillKey = key; pill.textContent = '';
    for (const [icon, text, title] of [['●', inv.count('coin'), 'Coins'], ['⚑', state.charted, 'New land charted'], ['≈', state.pail + '/' + T.PAIL, 'Water in the pail']]) { const s = el('span', null, ' ' + text); s.title = title; s.prepend(el('i', 'gh-i', icon)); pill.appendChild(s); } }
  drawPill();
  const bar = hotbarUI(hud, inv, { input });
  const bag = inventoryUI(hud, inv, { crafting: craft, stations: () => build.near(hero.position.x, hero.position.z, 5), canUse: (it) => !!(it.def.food || it.def.heal), onUse: (slot, it) => eat(it.id), onOpen: () => sound.play('click') });
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
  const interact = createInteract({ nodes, input, hud, inventory: inv, at: () => ({ x: hero.position.x, y: hero.position.z }), tool: heldTool, send: (n, tool) => { useNode(n, tool); } });
  quests.onStep((step) => { sound.play('powerup'); hud.toast('Done: ' + step.text.split(':')[0]); });
  quests.onAll(() => { fx.confetti(hero); hero.play('cheer'); sound.play('win'); hud.toast(T.TITLE + ' is home now. The hills go on: so can you.', { seconds: 6 }); });
  let heldId = ''; const HELP = { hoe: 'tills the ground in front of you', pail: 'waters the crop in front of you; fill it at the well' };
  inv.onChange(() => { drawPill(); const h = inv.held, id = h ? h.id : ''; if (id === heldId || !state.playing) return; heldId = id; const d = h && h.def, k = input.keyOf('use') || 'F';
    if (d) hud.hint(d.name + ': ' + (d.plant ? k + ' sows it on a tilled plot' : d.place ? k + ' places it in front of you' : d.food ? k + ' eats it' : HELP[d.tool] ? k + ' ' + HELP[d.tool] : d.tool ? 'works twice as fast' : d.about || ''), 4); });

  /* ===== 8. the frame loop. stage.run() draws the stage and calls GCP.ready() after the first frames. ===== */
  stage.run((dt) => {
    const open = bag.isOpen || menu.isOpen || shop.isOpen || state.busy, p = hero.position; player.enabled = state.playing && !open;
    player.update(dt); lake.position.x = Math.round(p.x / 28) * 28; lake.position.z = Math.round(p.z / 28) * 28;
    if (state.playing && (!menu.isOpen || net.room)) {   // alone, the world stops while the menu is up; in a room it cannot
      const g = dt * state.speed; clock.update(g); crops.update(g); needs.update(dt); nodes.update(dt); quests.update(); clockView.update(); bar.update(); drawPill();
      if (player.running) needs.add('stamina', -30 * dt);
      const [hx, hz] = build.snap(p.x, p.z); if (p.y - land.heightAt(hx, hz) > LEVEL - 0.3 && build.at(hx, hz, 'floor', 1)) state.climbed = 1;
      // the cell that the thing in hand will act on
      const d = inv.held && inv.held.def, [ax, az] = aim(); aimMark.visible = !open && !!d && !!(d.tool === 'hoe' || d.tool === 'pail' || d.plant || d.place); if (aimMark.visible) aimMark.position.set(ax, land.heightAt(ax, az) + 0.32 + (d.place && T.PIECES[d.place].level ? LEVEL : 0), az);
      const ch = land.chunks.get(Math.floor(p.x / CHUNK) + ',' + Math.floor(p.z / CHUNK)); if (ch && ch.region && ch.region.name !== state.region) { if (state.region) hud.toast(ch.region.name, { color: T.LOOK.accent }); state.region = ch.region.name; }
      tickFoes(dt);
      if (!open) { interact.update(); if (input.action('use')) useHeld(); if (input.action('take')) takeBack(); if (foes.length && !interact.target && input.action('interact')) strike(); }
      if (input.action('bag') && !shop.isOpen) bag.toggle(); if (input.action('mute')) sound.mute();
      tickRoom(dt);
    }
    input.endFrame();
  });
  boot.done();

  /* ===== 9. two players. createWorldSync makes the host decide every change (a piece, a felled tree, a crop) and tell
     everyone, so both worlds stay the same; each player keeps their own backpack. Here is the rest: where the other
     player is (sent a few times a second, drawn a moment in the past so it glides), their name and
     the shared clock. ===== */
  function openRoom(room) {
    for (const p of [...net.peers.values()]) dropPeer(p.id);
    net.room = room;
    sync = createWorldSync(room, { build, nodes, crops, chunks: land, inventory: inv, onChange: (op) => {   // someone else changed the world: let it be heard and seen
      if (!room || op.by === room.id || op.x == null || Math.hypot(op.x - hero.position.x, op.y - hero.position.z) > 30) return; sound.play(op.op === 'water' ? 'splash' : op.op === 'plant' ? 'pop' : 'build', { volume: 0.5 }); fx.puff(at3(op.x, op.y, 0.5), 0xe8d8b0); } });
    if (!room) return;
    room.on('message', (m, from) => { if (!m || net.room !== room) return; if (m.t === 'pose') onPose(from, m); else if (m.t === 'sleep' && room.isHost && (clock.isNight || clock.phase === 'dusk')) { passNight(); hud.toast('A friend called it a night'); } });
    room.on('leave', (id) => dropPeer(id)); room.on('open', drawRoster); room.on('join', drawRoster); room.on('close', () => hud.toast('The room was lost: trying again'));
  }
  function onPose(id, m) {
    let p = net.peers.get(id);
    if (!p) { p = { id, name: String(m.n || 'Friend').slice(0, 16), buf: [], seen: 0, actor: humanoid({ preset: T.HERO, shirt: T.FRIENDS[net.peers.size % T.FRIENDS.length] }) };
      p.actor.position.set(m.x, m.y, m.z); p.actor.add(nameTag(p.name)); stage.scene.add(p.actor); net.peers.set(id, p); hud.toast(p.name + ' is here'); sound.play('door'); drawRoster(); }
    p.buf.push({ t: performance.now(), x: m.x, y: m.y, z: m.z, r: m.r || 0 }); if (p.buf.length > 8) p.buf.shift(); p.seen = performance.now();
    if (!net.room.isHost && m.h != null && (Math.abs(m.h - clock.hour) > 0.1 || m.d !== clock.day)) { clock.day = m.d; clock.set(m.h); }   // the host's clock is everyone's clock
  }
  function dropPeer(id) { const p = net.peers.get(id); if (!p) return; net.peers.delete(id); p.actor.removeFromParent(); if (net.room) hud.toast(p.name + ' left'); drawRoster(); }
  function drawRoster() { const r = net.room; roster.style.display = r ? '' : 'none'; if (r) roster.textContent = 'Room ' + net.code + ' · ' + [me, ...[...net.peers.values()].map((p) => p.name)].join(', '); }
  function tickRoom(dt) {
    const r = net.room, now = performance.now(), at = now - 140, h = hero.position; if (!r) return;
    net.t -= dt; if (r.connected && net.t <= 0) { net.t = 0.12; r.send({ t: 'pose', x: r2(h.x), y: r2(h.y), z: r2(h.z), r: r2(player.yaw), n: me, ...(r.isHost ? { h: r2(clock.hour), d: clock.day } : {}) }); }
    for (const p of net.peers.values()) {   // between the two reports on either side of "a moment ago"
      const b = p.buf, a = p.actor; let i = 0; while (i < b.length - 1 && b[i + 1].t <= at) i++; const A = b[i], B = b[i + 1] || A, k = B === A ? 1 : clamp((at - A.t) / (B.t - A.t), 0, 1), x = lerp(A.x, B.x, k), z = lerp(A.z, B.z, k), turn = Math.atan2(Math.sin(B.r - A.r), Math.cos(B.r - A.r));
      const v = Math.hypot(x - a.position.x, z - a.position.z) / Math.max(dt, 0.001); a.position.set(x, lerp(A.y, B.y, k), z); a.rotation.y = A.r + turn * k; a.animate(v > 5.5 ? 'run' : v > 0.3 ? 'walk' : 'idle', dt, 1);
      if (now - p.seen > 8000 && !(net.room && net.room.peers.some((q) => q.id === p.id))) dropPeer(p.id);   // quiet (a hidden tab draws no frames) but still in the room: keep them
    }
  }

  /* ===== 10. start: play alone, host a room or join one by its code. A returning player carries on from their save;
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

  /* ===== 11. proof. The verification browser plays the game through here: the map grows, a tree stays felled, a crop
     is tilled, sown, watered, grown and harvested, bread is baked, a harvest sold, a lookout climbed, and a second
     player in a second world (rooms that talk inside this page) ends up with the same world. ===== */
  const test = GCP.test, two = test.twoPlayers;   // the verifier opens the game twice in one room: host or join it instead of playing alone
  test.onAutostart(() => (two ? (two.role === 'host' ? lobby.host(two.code) : lobby.join(two.code)) : lobby.solo()));
  // Two real browsers, one room. Each page waits for the other player, builds one piece, waits until both pieces stand
  // in its own world and reports what it sees; the verifier compares the two reports.
  test.onTwoPlayers(async (t, role) => {
    t.step('the room opens'); await t.until(() => state.playing && net.room && net.room.connected, 20000, 'the room to open');
    t.step('the other player appears'); await t.until(() => net.room.peers.some((q) => q.id !== net.room.id), 30000, 'the other player to join the room');   // membership, not poses: a page in the background draws no frames and sends none t.assert(net.room.isHost === (role === 'host'), 'the first one in is the host');
    t.step('each builds one piece'); const mine = role === 'host' ? ['fence', 10, 6] : ['torch', -10, 6]; inv.add(mine[0], 1); const r = await sync.place(...mine); t.assert(!r.error, 'the ' + role + ' builds a ' + mine[0] + ': ' + r.error);
    t.step('both pieces stand in both worlds'); await t.until(() => build.at(10, 6) && build.at(-10, 6), 20000, 'the other player\'s piece to arrive'); await t.wait(900);
    return { players: new Set([net.room.id, ...net.room.peers.map((q) => q.id)]).size, world: JSON.stringify([build.toJSON().map((p) => p.slice(0, 3).join()).sort(), crops.toJSON().map((c) => c.slice(0, 3).join()).sort(), land.toJSON().sort()]) };
  });
  window.G = { state, hero, player, inv, craft, needs, clock, nodes, build, crops, quests, land, bag, shop, menu, stage, hud, net, useHeld, openRoom, spawnFoe, foes };
  test.onPlaythrough(async (t) => {
    const P = hero.position, dist = (n) => Math.hypot(n.x - P.x, n.y - P.z), nearest = (kind) => nodes.list.filter((n) => n.kind === kind && !n.gone && n.ref && n.ref.key && dist(n) < 34).sort((a, b) => dist(a) - dist(b))[0];
    const hold = (id) => { let i = inv.slots.findIndex((s) => s && s.id === id); t.assert(i >= 0, id + ' is in the backpack'); if (i >= inv.hotbar) { inv.move(i, inv.hotbar - 1); i = inv.hotbar - 1; } inv.select(i); };
    const face = (x, z, dz = 1) => { player.teleport(x, z - dz * GRID); player.yaw = hero.rotation.y = dz > 0 ? 0 : Math.PI; };   // stand one cell from a cell, facing it
    const print = (ch) => ch.items.map((it) => it.key + '@' + it.x.toFixed(2) + ',' + it.z.toFixed(2)).join(' ');

    t.step('play alone from the lobby'); if (!state.playing) lobby.solo(); await t.until(() => state.playing, 4000, 'the game to start'); t.assert(sync.isHost && nodes.list.length > 20, 'a world with things to use is there');

    t.step('the map grows as the player walks'); const home = print(land.chunks.get('0,0')), before = charted.size, far = (SEEN + 3) * CHUNK;
    t.assert(await player.moveTo(3, 5, 5), 'the hero walks on their own feet'); player.teleport(far + 5, 5); await t.until(() => land.chunks.has((SEEN + 3) + ',0') && !land.chunks.has('0,0') && land.chunks.size >= FIRST, 6000, 'new land to load and home to be put away');
    t.assert(charted.size >= before + FIRST && state.charted >= FIRST, 'new land was charted: ' + state.charted); t.assert(Math.abs(P.y - land.heightAt(P.x, P.z)) < 0.6 || P.y < 0.3, 'the hero stands on the new ground');
    player.teleport(3, 5); await t.until(() => land.chunks.has('0,0'), 6000, 'home to come back'); t.assert(print(land.chunks.get('0,0')) === home, 'home comes back exactly as it was');

    t.step('a felled tree stays felled'); const oak = nearest('tree'), id = oak.id; player.teleport(oak.x, oak.y + 1.6); await t.frames(2); t.assert(interact.target, 'a prompt shows beside the tree');
    for (let i = 0; i < 6 && nodes.byId(id); i++) await useNode(oak, 'axe'); t.assert(!nodes.byId(id) && inv.has('wood') && land.toJSON().includes(id) && oak.ref.visible === false, 'the tree fell and gave wood');
    player.teleport(oak.x + far + 200, oak.y); await t.until(() => !land.chunks.has(id.split(',').slice(0, 2).join(',')), 6000, 'its chunk to be put away'); player.teleport(oak.x, oak.y + 1.6); await t.until(() => land.chunks.has(id.split(',').slice(0, 2).join(',')), 6000, 'its chunk to come back');
    t.assert(!nodes.byId(id) && !land.items().some((it) => it.key === id), 'it is still gone after its chunk came back');

    t.step('till a plot, sow wheat, water it'); inv.add('hoe', 1); hold('hoe'); face(0, 6); t.assert(await useHeld(), 'the hoe tills'); t.assert(build.at(0, 6, 'ground'), 'a plot is there');
    hold('wheat_seed'); const seeds = inv.count('wheat_seed'); t.assert(await useHeld(), 'the seed is sown'); const crop = crops.at(0, 6); t.assert(crop && inv.count('wheat_seed') === seeds - 1, 'a crop is planted and one seed is spent');
    hold('pail'); await useHeld(); t.assert(!crop.watered, 'an empty pail waters nothing'); player.teleport(well.x, well.y + 2.2); await t.frames(2); t.assert(interact.target === well, 'the well offers water'); interact.use(); t.assert(state.pail === T.PAIL, 'the pail is full');
    face(0, 6); t.assert(await useHeld() && crop.watered && state.pail === T.PAIL - 1, 'the crop is watered');

    t.step('the crop grows through its stages as time passes'); state.speed = 240;
    for (let s = 1; s <= 3; s++) { if (!crop.watered) { face(0, 6); await useHeld(); } await t.until(() => crop.stage >= s, 6000, 'growth stage ' + s); } state.speed = 1; t.assert(crop.stage === 3, 'the wheat is ripe');

    t.step('harvest it: wheat, and seeds for the next sowing'); player.teleport(0, 6.8); await t.frames(2); t.assert(interact.target && interact.target.kind === 'crop', 'the ripe crop can be harvested'); const s0 = inv.count('wheat_seed');
    await useNode(interact.target); t.assert(inv.count('wheat') >= 2 && inv.count('wheat_seed') > s0 && !crops.at(0, 6) && state.harvested === 1, 'wheat and seeds are in the backpack');

    t.step('bake bread at a campfire and eat it'); inv.add('wood', 24); inv.add('stone', 3); inv.add('wheat', 3); t.assert(craft.make('campfire'), 'a campfire can be crafted'); hold('campfire'); face(4, 8); t.assert(await useHeld(), 'the campfire is placed');
    t.assert(build.at(4, 8) && !inv.has('campfire') && !craft.can('bread', []), 'it stands, and bread needs a fire'); player.teleport(4, 10.2); t.assert(craft.make('bread', build.near(P.x, P.z, 5)), 'bread bakes beside it');
    needs.set('food', 40); hold('bread'); await useHeld(); t.assert(needs.get('food') > 75 && state.meals === 1, 'eating fills the hero up');

    t.step('sell the harvest at the trading post'); player.teleport(post.x, post.y + 2.2); await t.frames(2); t.assert(interact.target === post, 'the post offers trade'); interact.use(); t.assert(shop.isOpen, 'the trade window opens');
    const wheat = inv.count('wheat'); shop.sell('wheat'); t.assert(wheat > 0 && inv.count('coin') === wheat * T.ITEMS.wheat.sell && state.sold === wheat, 'wheat became coins'); t.assert(shop.buy('carrot_seed') && inv.has('carrot_seed'), 'coins became new seeds'); shop.close();

    // what the theme may add: thirst, a furnace, foes at night. Each is proved only when the theme has it.
    const give = (cost) => { for (const id in cost) inv.add(id, cost[id]); }, recipe = (find) => T.RECIPES.find(find);
    if (thirst) { t.step('drink at the well'); needs.set('water', 20); player.teleport(well.x, well.y + 2.2); await t.frames(2); t.assert(interact.target === well, 'the well offers a drink'); interact.use(); t.assert(needs.get('water') > 95 && state.drinks > 0, 'the water bar is full again'); }
    if (T.PIECES.furnace) { t.step('smelt at a furnace'); const smelt = recipe((r) => r.station === 'furnace'); give(recipe((r) => r.makes === 'furnace').needs); give(smelt.needs); t.assert(craft.make('furnace'), 'a furnace can be crafted'); hold('furnace'); face(6, 10); t.assert(await useHeld() && build.at(6, 10), 'the furnace is placed');
      t.assert(!craft.can(smelt.makes, []), 'smelting needs the furnace'); player.teleport(6, 12.4); t.assert(craft.make(smelt.makes, build.near(P.x, P.z, 5)) && inv.has(smelt.makes), 'ore becomes ' + smelt.makes + ' beside it'); }
    if (FOE) { t.step('a foe comes at night, is fought off and leaves loot'); const armed = Object.keys(T.ITEMS).find((id) => T.ITEMS[id].weapon); if (armed) { inv.add(armed, 1); hold(armed); } clock.set(23); player.teleport(2, 12); await t.frames(2);
      const f = spawnFoe(P.x + 6, P.z), h0 = needs.get('health'); await t.until(() => needs.get('health') < h0, 12000, 'the foe to reach the hero and hurt them'); const n0 = state.slain; for (let i = 0; i < 40 && state.slain === n0; i++) { await useHeld(); await t.frames(3); }
      t.assert(state.slain === n0 + 1 && !foes.includes(f), 'the foe falls'); t.assert(Object.keys(FOE.loot).some((id) => inv.has(id)), 'its loot is in the backpack'); spawnFoe(P.x + 8, P.z); clock.set(6); await t.until(() => !foes.length, 6000, 'the dawn to clear the foes'); clock.set(10); needs.set('health', 100); }

    t.step('build stairs and a lookout deck, and climb up'); t.assert(craft.make('stairs') && craft.make('deck'), 'both can be crafted'); hold('stairs'); face(-4, 10, -1); t.assert(await useHeld(), 'the stairs are placed');
    const steps = build.at(-4, 10, 'floor'); t.assert(steps && steps.dir === 2, 'they rise the way the hero faces'); hold('deck'); t.assert(await useHeld() && build.at(-4, 8, 'floor', 1), 'the deck goes where the stairs lead');
    player.teleport(-4, 10.9); await t.frames(2); await player.moveTo(-4, 8, 6); await t.until(() => state.climbed, 3000, 'the hero to reach the deck'); t.assert(P.y - land.heightAt(-4, 8) > LEVEL - 0.3, 'the hero stands a storey up: ' + (P.y - land.heightAt(-4, 8)).toFixed(2));
    player.teleport(0, 3); await t.until(() => P.y - land.heightAt(P.x, P.z) < 0.3, 3000, 'the hero to be back on the ground');

    t.step('a second player shares the world'); const [ra, rb] = createLoopback(2), there = { x: 0, z: 0 }; net.code = 'TEST'; openRoom(ra);
    const unseen = Object.assign(Object.create(stage), { scene: new THREE.Scene(), onUpdate: () => () => {}, focus: null });   // the second player's land is not drawn here
    const B = { nodes: createNodes(), inv: createInventory({ items: T.ITEMS, start: { fence: 2, wheat_seed: 2 } }) }; B.land = growLand(unseen, B.nodes, () => there, 1); B.build = createBuilder({ grid: GRID, levelHeight: LEVEL, pieces: pieceDefs(false) });
    B.crops = createCrops({ nodes: B.nodes, types: T.CROPS, grid: GRID, water: true }); B.sync = createWorldSync(rb, { build: B.build, nodes: B.nodes, crops: B.crops, chunks: B.land, inventory: B.inv });
    const same = () => { const pr = (b, c, w) => JSON.stringify([b.toJSON().map((p) => p.join()).sort(), c.toJSON().map((x) => x.slice(0, 3).join()).sort(), w.toJSON().sort()]); return pr(build, crops, land) === pr(B.build, B.crops, B.land); };
    await t.until(() => sync.isHost && !B.sync.isHost && same(), 4000, 'the guest to receive the world as it stands'); t.assert(B.build.pieces.length === build.pieces.length && B.build.pieces.length >= 4, 'the guest sees what was built before it came');
    let r = await B.sync.place('fence', 8, 12); await t.frames(2); t.assert(!r.error && build.at(8, 12) && build.at(8, 12).ref && B.inv.count('fence') === 1, 'the guest builds a fence: it stands in the host world and cost the guest one');
    r = await B.sync.place('fence', 8, 12); t.assert(r.error === 'occupied', 'the host refuses a second piece on the same cell');
    hold('hoe'); face(2, 12); await useHeld(); hold('wheat_seed'); await useHeld(); await t.until(() => B.crops.at(2, 12) && B.build.at(2, 12, 'ground'), 2000, 'the host\'s crop to show for the guest');
    const birch = nearest('tree'), twin = B.nodes.byId(birch.id); t.assert(twin, 'both worlds have the same tree'); for (let i = 0; i < 6 && !(r && r.done); i++) r = await B.sync.use(twin); await t.frames(2);
    t.assert(r.done && B.inv.has('wood') && !nodes.byId(birch.id) && birch.ref.visible === false, 'the guest fells a tree: it falls for the host too and the wood is the guest\'s');
    there.x = 1000; B.land.update(); B.land.update(); rb.send({ t: 'pose', x: 1000, y: 3, z: 0, r: 0, n: 'Robin' }); await t.until(() => net.peers.size === 1, 2000, 'the other player to appear');
    const away = B.nodes.list.find((n) => n.kind === 'tree' && n.ref.key && Math.hypot(n.x - 1000, n.y) < 30); t.assert(away && !nodes.byId(away.id), 'the guest stands where the host has nothing loaded'); r = null; for (let i = 0; i < 6 && !(r && r.done); i++) r = await B.sync.use(away);
    t.assert(r.done && land.toJSON().includes(away.id), 'the host answers for land it does not see, and remembers the tree is gone');
    for (let i = 1; i <= 4; i++) { rb.send({ t: 'pose', x: 2 + i, y: land.heightAt(2 + i, 6), z: 6, r: 1.57, n: 'Robin' }); await t.wait(120); } const friend = [...net.peers.values()][0]; await t.until(() => friend.actor.position.x > 2.9 && friend.actor.position.x <= 6, 3000, 'the other player to walk into view');
    t.assert(friend.name === 'Robin' && friend.actor.parent === stage.scene && friend.actor.children.some((c) => c.isSprite), 'their name is over their head'); await t.until(same, 4000, 'both worlds to agree');

    t.step('the world is saved'); const d = save.now(); t.assert(d && d.parts.build.length === build.pieces.length && d.parts.crops.length === 1 && d.parts.land.includes(id) && d.parts.mine.charted.length === charted.size && d.parts.inv.slots.some(Boolean), 'the save holds the pieces, the crop, the felled trees, the map and the backpack');
    openRoom(null); net.code = ''; drawRoster(); player.teleport(0, 3);
  });
});

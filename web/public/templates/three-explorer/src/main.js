// Shard Island — a starter 3D game. Everything visible is generated at boot from one seed.
// Reshape freely: change the height function for a different world, the part lists for different
// props, the palette for a different mood, or swap the whole update() for another kind of game.
import * as THREE from 'three';
import { run, createLoop, Simplex, mulberry32, pickQuality, clamp, lerp, smoothstep, store, TAU } from '@gcp/core.js';
import { createRenderer, fitRenderer, mergeParts, M4, lumpy, instances, makeSky, makeSun, terrainGeometry, cachedMaterial } from '@gcp/three-kit.js';
import { createInput } from '@gcp/input.js';
import { createAudio } from '@gcp/audio.js';

const G = window.GCP;                       // injected by the platform; undefined when opened from disk
const $ = (id) => document.getElementById(id);

run(async (boot) => {
  const seed = Number(G && G.test.seed) || 4207;
  const rand = mulberry32(seed), noise = new Simplex(seed);
  let quality = pickQuality(store.get('shard.quality'));

  // ---- renderer, scene, light --------------------------------------------------------------
  const canvas = $('view');
  const renderer = createRenderer(canvas, { quality });
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xbfe0f2, 70, 260);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 700);
  fitRenderer(renderer, camera);
  scene.add(makeSky({ top: 0x2f78d0, bottom: 0xcfe9f7 }));
  scene.add(new THREE.HemisphereLight(0xd6ecff, 0x5d6b3c, 1.5));
  const sun = makeSun(scene, { mapSize: quality === 'low' ? 1024 : 2048, area: 40 });

  // ---- world: one height function drives terrain, placement and collision -------------------
  await boot.step(0.15, 'Raising the island');
  const SIZE = 240, WATER = 0;
  const height = (x, z) => {
    const d = Math.hypot(x, z) / (SIZE * 0.46);                       // 0 at the centre, 1 at the shore
    const hills = noise.fbm2(x * 0.012, z * 0.012, 4) * 13 + noise.n2(x * 0.05, z * 0.05) * 1.6;
    return lerp(hills + 9, -6, smoothstep(0.55, 1.05, d));
  };
  const colour = (x, z, y, slope) => {
    if (y < WATER + 0.7) return 0xe6d49a;                             // sand
    if (slope > 0.22) return 0x8d8a80;                                // rock on steep faces
    return noise.n2(x * 0.06, z * 0.06) > 0.25 ? 0x4f9a3a : 0x63a843; // two greens
  };
  const terrain = new THREE.Mesh(terrainGeometry({ size: SIZE, segments: quality === 'low' ? 80 : 128, height, colour }).geometry,
    cachedMaterial('ground', () => new THREE.MeshLambertMaterial({ vertexColors: true })));
  terrain.receiveShadow = true; scene.add(terrain);
  const water = new THREE.Mesh(new THREE.CircleGeometry(600, 48).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x2f8fc4, transparent: true, opacity: 0.82 }));
  water.position.y = WATER; scene.add(water);

  // ---- props: merged vertex-colour geometry, one InstancedMesh per kind ---------------------
  await boot.step(0.45, 'Planting trees');
  const propMat = cachedMaterial('props', () => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  const canopy = (r, s) => lumpy(new THREE.IcosahedronGeometry(r, 1), 0.2, s);
  const oak = mergeParts([[new THREE.CylinderGeometry(0.2, 0.34, 3, 7), 0x6b4a2b, M4(0, 1.5, 0)], [canopy(1.5, 1), 0x4f9a3a, M4(0, 3.8, 0)], [canopy(1.1, 2), 0x5aa844, M4(0.9, 3.3, 0.3)], [canopy(1.0, 3), 0x468a34, M4(-0.7, 3.4, -0.5)]]);
  const pine = mergeParts([[new THREE.CylinderGeometry(0.15, 0.26, 2.2, 6), 0x5a3a20, M4(0, 1.1, 0)], [new THREE.ConeGeometry(1.5, 2.2, 7), 0x2f6b3a, M4(0, 2.6, 0)], [new THREE.ConeGeometry(1.15, 2, 7), 0x35783f, M4(0, 3.8, 0)], [new THREE.ConeGeometry(0.8, 1.8, 7), 0x3d8547, M4(0, 4.9, 0)]]);
  const rock = mergeParts([[lumpy(new THREE.IcosahedronGeometry(0.9, 1), 0.28, 7), 0x8f8b84]]);
  const spots = { oak: [], pine: [], rock: [] }, solid = [];
  for (let i = 0; i < 1400 && solid.length < (quality === 'low' ? 220 : 420); i++) {
    const x = (rand() - 0.5) * SIZE * 0.86, z = (rand() - 0.5) * SIZE * 0.86, y = height(x, z);
    if (y < WATER + 1.2 || Math.hypot(x, z) < 6) continue;
    const slope = Math.abs(height(x + 1, z) - y) + Math.abs(height(x, z + 1) - y);
    const kind = slope > 0.9 ? 'rock' : y > 12 || noise.n2(x * 0.02 + 40, z * 0.02) > 0.2 ? 'pine' : rand() < 0.12 ? 'rock' : 'oak';
    const scale = 0.8 + rand() * 0.7;
    spots[kind].push({ x, y: y - 0.1, z, scale, rotY: rand() * TAU, color: new THREE.Color().setHSL(0, 0, 0.86 + rand() * 0.14) });
    solid.push({ x, z, r: kind === 'rock' ? 0.8 * scale : 0.35 * scale });
  }
  scene.add(instances(oak, propMat, spots.oak), instances(pine, propMat, spots.pine), instances(rock, propMat, spots.rock));

  // ---- shards: the thing to collect ---------------------------------------------------------
  await boot.step(0.7, 'Hiding shards');
  const shardGeo = new THREE.OctahedronGeometry(0.55), shardMat = new THREE.MeshLambertMaterial({ color: 0x7fe3ff, emissive: 0x2aa6c8, emissiveIntensity: 1.2, flatShading: true });
  const shards = [];
  while (shards.length < 10) {
    const a = rand() * TAU, d = 18 + rand() * SIZE * 0.34, x = Math.cos(a) * d, z = Math.sin(a) * d, y = height(x, z);
    if (y < WATER + 1 || shards.some((s) => Math.hypot(s.x - x, s.z - z) < 16)) continue;
    const m = new THREE.Mesh(shardGeo, shardMat); m.position.set(x, y + 1.4, z); m.castShadow = true; scene.add(m);
    shards.push({ x, z, y, m, got: false });
  }

  // ---- player -------------------------------------------------------------------------------
  const hero = new THREE.Mesh(mergeParts([[new THREE.CapsuleGeometry(0.34, 0.7, 4, 10), 0xf2b04a, M4(0, 0.85, 0)], [new THREE.SphereGeometry(0.3, 12, 10), 0xf7e3c4, M4(0, 1.75, 0)], [new THREE.ConeGeometry(0.36, 0.5, 10), 0xc8452f, M4(0, 2.15, 0)]], { flat: false }),
    cachedMaterial('hero', () => new THREE.MeshLambertMaterial({ vertexColors: true })));
  hero.castShadow = true; scene.add(hero);
  const p = { x: 0, y: height(0, 0), z: 0, vy: 0, yaw: 0, ground: true, step: 0 };
  const cam = { yaw: 0.6, pitch: 0.35, dist: 9 };

  const input = createInput(canvas), audio = createAudio();
  const jumpBtn = input.addButton('Jump', 'Space');
  let found = 0, t0 = 0, time = 0, done = false, hintGone = false;
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const hud = () => { $('n').textContent = `${found} / ${shards.length}`; $('time').textContent = fmt(time); };
  hud();

  async function finish() {
    done = true; audio.chord([523, 659, 784, 1047]);
    $('bs').textContent = `Your time: ${fmt(time)}`;
    $('banner').classList.add('on');
    if (!G) return;
    await G.leaderboard.submit('time', Math.round(time * 10) / 10, 'asc');     // lower is better
    const rows = await G.leaderboard.top('time', 5, 'asc');
    $('board').innerHTML = ''; for (const r of rows) { const li = document.createElement('li'); li.innerHTML = '<span></span><b></b>'; li.firstChild.textContent = r.name; li.lastChild.textContent = fmt(r.score); $('board').appendChild(li); }
  }
  function restart() {            // a new run in place: the world stays, only the run's state is reset
    for (const s of shards) { s.got = false; s.m.visible = true; }
    found = 0; t0 = 0; time = 0; done = false; p.x = 0; p.z = 0; p.y = height(0, 0); p.vy = 0;
    $('banner').classList.remove('on'); hud();
  }
  $('again').onclick = restart;

  // ---- frame --------------------------------------------------------------------------------
  const fwd = new THREE.Vector3(), slow = { n: 0, acc: 0 };
  function update(dt, now) {
    // look: mouse drag or right-side touch
    const look = input.takeLook(); cam.yaw -= look.dx * 1.4; cam.pitch = clamp(cam.pitch + look.dy * 1.4, -0.2, 1.2);
    // move relative to the camera
    const mv = input.move, sp = (input.down('ShiftLeft') ? 11 : 7) * dt;
    if (mv.x || mv.y) {
      if (!hintGone) { hintGone = true; $('hint').style.opacity = 0; if (!t0) t0 = now; }
      const s = Math.sin(cam.yaw), c = Math.cos(cam.yaw), dx = (-s * mv.y + c * mv.x) * sp, dz = (-c * mv.y - s * mv.x) * sp;
      let nx = p.x + dx, nz = p.z + dz;
      for (const o of solid) { const ox = nx - o.x, oz = nz - o.z, d = Math.hypot(ox, oz), r = o.r + 0.35; if (d < r && d > 0.0001) { nx = o.x + ox / d * r; nz = o.z + oz / d * r; } }   // slide around props
      if (height(nx, nz) > WATER - 0.6) { p.x = nx; p.z = nz; }                                                                              // do not wade out to sea
      p.yaw = Math.atan2(dx, dz);
      p.step += dt * 9; if (p.ground && Math.sin(p.step) > 0.98) audio.noise({ dur: 0.05, vol: 0.05, freq: 500 });
    }
    // jump + gravity against the height function (no physics engine needed for terrain)
    if (input.pressed('Space') && p.ground) { p.vy = 7.5; p.ground = false; audio.tone({ freq: 300, slide: 0.6, dur: 0.12, vol: 0.12 }); }
    p.vy -= 20 * dt; p.y += p.vy * dt;
    const gy = height(p.x, p.z); if (p.y <= gy) { p.y = gy; p.vy = 0; p.ground = true; }
    hero.position.set(p.x, p.y + (p.ground && (mv.x || mv.y) ? Math.abs(Math.sin(p.step)) * 0.12 : 0), p.z);
    hero.rotation.y = p.yaw;

    // collect
    for (const s of shards) {
      if (s.got) continue;
      s.m.rotation.y = now * 1.5; s.m.position.y = s.y + 1.4 + Math.sin(now * 2 + s.x) * 0.25;
      if (Math.hypot(s.x - p.x, s.z - p.z) < 1.5 && Math.abs(s.y - p.y) < 3) { s.got = true; s.m.visible = false; found++; audio.chord([660, 990], { step: 0.06 }); if (found === shards.length) finish(); }
    }
    if (t0 && !done) time = now - t0;
    hud();

    // third-person camera that stays above the ground
    const cp = Math.cos(cam.pitch);
    camera.position.set(p.x + Math.sin(cam.yaw) * cp * cam.dist, p.y + 1.6 + Math.sin(cam.pitch) * cam.dist, p.z + Math.cos(cam.yaw) * cp * cam.dist);
    camera.position.y = Math.max(camera.position.y, height(camera.position.x, camera.position.z) + 0.6, WATER + 0.5);
    camera.lookAt(fwd.set(p.x, p.y + 1.5, p.z));
    sun.follow(hero.position);
    renderer.render(scene, camera);
    input.endFrame();

    // adapt: if the first seconds are slow, drop resolution, then shadows, and remember it
    slow.acc += dt; slow.n++;
    if (slow.n === 90) {
      if (slow.n / slow.acc < 28) {
        if (renderer.getPixelRatio() > 1) renderer.setPixelRatio(1); else if (renderer.shadowMap.enabled) { renderer.shadowMap.enabled = false; sun.castShadow = false; } else renderer.setPixelRatio(0.66);
        fitRenderer(renderer, camera); store.set('shard.quality', 'low');
      }
      slow.acc = 0; slow.n = 0;
    }
  }

  // Tests and the verifier can skip straight to play and collect one shard.
  if (G) G.test.onAutostart(() => { p.x = shards[0].x - 3; p.z = shards[0].z; p.y = height(p.x, p.z); });

  // The verifier runs this and reports each step, so a version is only verified if a whole run can be finished:
  // every shard collected, the end screen shown, and "Play again" starting a fresh run. Wait on game state, never on fixed times.
  if (G) G.test.onPlaythrough(async (t) => {
    t.step('start a fresh run'); restart(); await t.frames(2);
    t.step(`collect all ${shards.length} shards`);
    for (const s of shards) { const before = found; p.x = s.x; p.z = s.z; p.y = height(p.x, p.z); await t.until(() => found > before, 6000, 'a shard to be collected'); }
    t.step('the end screen appears with the time');
    await t.until(() => done && $('banner').classList.contains('on'), 3000, 'the end screen');
    t.assert($('bs').textContent.startsWith('Your time'), 'the end screen does not show the time');
    t.step('Play again starts a new run'); $('again').click(); await t.frames(2);
    t.assert(found === 0 && !done && !$('banner').classList.contains('on') && shards.every((s) => s.m.visible), 'the run did not reset');
  });

  await boot.step(0.95, 'Almost there');
  update(0, 0);                 // draw the first frame
  if (window.GCP) GCP.ready();             // the contract: the game is playable now
  boot.done();
  createLoop({ update }).start();
});

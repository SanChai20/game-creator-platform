// A whole Three.js game in one file, using nothing but Three.js itself. Replace the world and the rules with yours.
// `GCP` is injected by the platform. It is absent when you open the page straight from disk, hence the guards.
import * as THREE from 'three';

const G = window.GCP;

try {
  // ---- renderer: cap the pixel ratio (the largest single cost on phones) and size from the canvas ----
  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b2733);
  scene.fog = new THREE.Fog(0x1b2733, 30, 90);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  function resize() {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize); resize();

  // ---- light: a lit material with no light renders black, so add these before anything else ----
  scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x39402f, 1.6));
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.8); sun.position.set(8, 14, 6); scene.add(sun);

  // ---- world: everything is made from code, so there is nothing to download ----
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x3f6b46 }));
  const grid = new THREE.GridHelper(200, 100, 0x5c8a62, 0x4a7850); grid.position.y = 0.02;       // just above the ground, or the two flicker
  scene.add(ground, grid);
  const player = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xffb347 }));
  const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.7), new THREE.MeshLambertMaterial({ color: 0x7fe3ff, emissive: 0x2aa6c8 }));
  scene.add(player, beacon);

  // ---- rules ----
  let score = 0;
  const hud = document.getElementById('score');
  function placeBeacon() {                      // the first beacon is always straight ahead, later ones move around
    const a = score * 2.4, d = 6;
    beacon.position.set(player.position.x + Math.cos(a) * d, 1.2, player.position.z + Math.sin(a) * d);
  }
  function restart() { score = 0; player.position.set(0, 0.5, 0); placeBeacon(); hud.textContent = 'Beacons: 0'; }
  restart();

  // ---- input: keys by physical position (works on every layout), and a drag for touch and mouse ----
  const keys = new Set(), drag = { on: false, x: 0, y: 0, dx: 0, dy: 0 };
  addEventListener('keydown', (e) => { keys.add(e.code); if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault(); });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());                                   // no stuck keys after alt-tab
  canvas.addEventListener('pointerdown', (e) => { drag.on = true; drag.x = e.clientX; drag.y = e.clientY; drag.dx = drag.dy = 0; });
  addEventListener('pointermove', (e) => { if (drag.on) { drag.dx = e.clientX - drag.x; drag.dy = e.clientY - drag.y; } });
  addEventListener('pointerup', () => { drag.on = false; drag.dx = drag.dy = 0; });
  addEventListener('pointercancel', () => { drag.on = false; drag.dx = drag.dy = 0; });

  // ---- frame: driven by requestAnimationFrame, with the time step clamped so a slow frame cannot teleport things ----
  let last = 0;
  function frame(ms) {
    requestAnimationFrame(frame);
    const now = ms / 1000, dt = Math.min(0.1, now - last || 0); last = now;
    let mx = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    let mz = (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);
    if (drag.on) { mx = THREE.MathUtils.clamp(drag.dx / 60, -1, 1); mz = THREE.MathUtils.clamp(drag.dy / 60, -1, 1); }
    const len = Math.hypot(mx, mz); if (len > 1) { mx /= len; mz /= len; }
    player.position.x += mx * 6 * dt; player.position.z += mz * 6 * dt;
    if (len > 0.01) player.rotation.y = Math.atan2(mx, mz);
    beacon.rotation.y = now * 1.5; beacon.position.y = 1.2 + Math.sin(now * 2) * 0.2;
    if (Math.hypot(beacon.position.x - player.position.x, beacon.position.z - player.position.z) < 1.2) { score++; hud.textContent = 'Beacons: ' + score; placeBeacon(); }
    camera.position.set(player.position.x, 9, player.position.z + 11); camera.lookAt(player.position);
    renderer.render(scene, camera);
    if (G) G.stats({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles });   // shows up in verification reports
  }

  // The verifier runs this and lists each step in its report. A version with a play-through is only verified if it passes,
  // so this is how you prove the rules work and not only that the page starts. Wait on game state, never on fixed times.
  if (G) G.test.onPlaythrough(async (t) => {
    t.step('start a fresh run'); restart(); await t.frames(2);
    t.step('walk right to the first beacon');
    for (let i = 0; i < 60 && score < 1; i++) await t.key('KeyD', 200);
    t.assert(score === 1, `the beacon was not reached (player at x=${player.position.x.toFixed(1)}, beacon at x=${beacon.position.x.toFixed(1)})`);
    t.step('the score shows on screen'); t.assert(hud.textContent === 'Beacons: 1', `the HUD says "${hud.textContent}"`);
    t.step('a new beacon appears somewhere else'); t.assert(Math.hypot(beacon.position.x - player.position.x, beacon.position.z - player.position.z) > 3, 'the beacon did not move');
    restart();
  });

  frame(0);                    // draw the first frame…
  if (G) G.ready();            // …then tell the platform the game is playable. This is the one required call.
} catch (err) {
  console.error(err);
  if (G) G.fatal(err);         // the reason then appears in the verification report instead of a silent timeout
}

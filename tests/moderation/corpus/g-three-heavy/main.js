import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x8899aa); scene.fog = new THREE.Fog(0x8899aa, 20, 90);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 200);
const sun = new THREE.DirectionalLight(0xfff1d6, 2.2); sun.position.set(30, 50, 20); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60 }); scene.add(sun, new THREE.HemisphereLight(0xbbddff, 0x445522, 0.8));
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x4b7a3a })); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const COUNT = 3000;
const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.15, 0.22, 2, 6), new THREE.MeshStandardMaterial({ color: 0x6b4a2b }), COUNT);
const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 2.6, 7), new THREE.MeshStandardMaterial({ color: 0x2f6b3a }), COUNT);
trunk.castShadow = crown.castShadow = true;
const trees = [], m = new THREE.Matrix4();
for (let i = 0; i < COUNT; i++) {
  const x = (Math.random() - 0.5) * 180, z = (Math.random() - 0.5) * 180;
  if (Math.hypot(x, z) < 6) { i--; continue; }
  const s = 0.7 + Math.random() * 0.8; trees.push({ x, z, s, alive: true });
  m.makeScale(s, s, s).setPosition(x, s, z); trunk.setMatrixAt(i, m);
  m.makeScale(s, s, s).setPosition(x, s * 3, z); crown.setMatrixAt(i, m);
}
scene.add(trunk, crown);
const cart = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 2), new THREE.MeshStandardMaterial({ color: 0xc23b22 })); cart.castShadow = true; cart.position.y = 0.4; scene.add(cart);
const keys = {}; addEventListener('keydown', (e) => { keys[e.code] = true; if (e.code === 'Space') chop(); }); addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('pointerdown', () => chop());
let heading = 0, chopped = 0, timeLeft = 120;
const hud = document.getElementById('hud');
function chop() {
  let best = -1, bd = 3;
  trees.forEach((t, i) => { if (!t.alive) return; const d = Math.hypot(t.x - cart.position.x, t.z - cart.position.z); if (d < bd) { bd = d; best = i; } });
  if (best < 0) return;
  trees[best].alive = false; chopped++; m.makeScale(0, 0, 0); trunk.setMatrixAt(best, m); crown.setMatrixAt(best, m); trunk.instanceMatrix.needsUpdate = crown.instanceMatrix.needsUpdate = true;
}
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
const clock = new THREE.Clock(); let frames = 0, slowFrames = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.1, clock.getDelta());
  if (dt > 0.08 && ++slowFrames > 5 && renderer.getPixelRatio() > 0.35) { renderer.setPixelRatio(renderer.getPixelRatio() * 0.6); renderer.shadowMap.enabled = false; slowFrames = 0; }
  heading += ((keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0)) * dt * 2;
  const v = ((keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0)) * dt * 8;
  cart.position.x -= Math.sin(heading) * v; cart.position.z -= Math.cos(heading) * v; cart.rotation.y = heading;
  camera.position.set(cart.position.x + Math.sin(heading) * 8, 5, cart.position.z + Math.cos(heading) * 8); camera.lookAt(cart.position);
  timeLeft = Math.max(0, timeLeft - dt);
  hud.textContent = `Trees chopped: ${chopped}  ·  ${Math.ceil(timeLeft)} s`;
  renderer.render(scene, camera);
  if (++frames === 2) GCP.ready();
});
GCP.test.onPlaythrough(async (t) => {
  t.step('drive to a tree and chop it');
  const tr = trees.find((x) => x.alive); cart.position.set(tr.x + 1, 0.4, tr.z); chop();
  await t.frames(2); t.assert(chopped === 1, 'one tree chopped');
});

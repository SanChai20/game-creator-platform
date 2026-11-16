// The main page draws; ants.js (a Web Worker) moves a thousand ants on a pheromone grid and sends positions back.
const cv = document.getElementById('a'), g = cv.getContext('2d'), hud = document.getElementById('h');
const W = 160, H = 90; let ants = new Float32Array(0), food = [], walls = new Uint8Array(W * H), gathered = 0, ready = false;
const worker = new Worker('ants.js');
worker.onmessage = (e) => { ants = e.data.ants; gathered = e.data.gathered; if (!ready) { ready = true; GCP.ready(); } };
worker.onerror = (e) => GCP.fatal('Worker failed: ' + e.message);
function fit() { cv.width = innerWidth; cv.height = innerHeight; } fit(); addEventListener('resize', fit);
let mode = 'food';
addEventListener('keydown', (e) => { if (e.code === 'KeyF') mode = 'food'; if (e.code === 'KeyW' || e.code === 'KeyX') mode = 'wall'; });
cv.addEventListener('pointerdown', (e) => {
  const gx = Math.floor(e.clientX / cv.width * W), gy = Math.floor(e.clientY / cv.height * H);
  if (mode === 'food') { food.push([gx, gy]); worker.postMessage({ food: [gx, gy] }); }
  else { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) walls[(gy + dy) * W + gx + dx] = 1; worker.postMessage({ walls }); }
});
worker.postMessage({ start: { W, H, count: 1000 } });
function draw() {
  const sx = cv.width / W, sy = cv.height / H;
  g.fillStyle = '#d7c49e'; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#6d4c2f'; for (let i = 0; i < W * H; i++) if (walls[i]) g.fillRect((i % W) * sx, Math.floor(i / W) * sy, sx, sy);
  g.fillStyle = '#4caf50'; for (const [fx, fy] of food) { g.beginPath(); g.arc((fx + .5) * sx, (fy + .5) * sy, 6, 0, 7); g.fill(); }
  g.fillStyle = '#7b3f00'; g.beginPath(); g.arc(W / 2 * sx, H / 2 * sy, 14, 0, 7); g.fill();
  g.fillStyle = '#1b1b1b'; for (let i = 0; i < ants.length; i += 2) g.fillRect(ants[i] * sx, ants[i + 1] * sy, 2, 2);
  hud.textContent = `Food gathered: ${gathered} · placing ${mode} (F food, W wall)`;
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
GCP.test.onPlaythrough(async (t) => {
  t.step('drop food next to the nest'); food.push([W / 2 + 4, H / 2]); worker.postMessage({ food: [W / 2 + 4, H / 2] });
  await t.until(() => gathered > 0, 20000, 'the first food home'); t.assert(gathered > 0, 'ants gathered food');
});

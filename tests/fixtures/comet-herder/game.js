// Comet Herder: steer a tug, nudge drifting comets into the corral, keep clear of the debris. A test fixture for
// the duplication check, written for it, so it shares no code with the platform templates.
const sky = document.getElementById('sky'), pen = sky.getContext('2d'), hud = document.getElementById('hud');
let width = 0, height = 0, ratio = 1;
function fitSky() { ratio = Math.min(devicePixelRatio || 1, 2); width = innerWidth; height = innerHeight; sky.width = width * ratio; sky.height = height * ratio; pen.setTransform(ratio, 0, 0, ratio, 0, 0); }
addEventListener('resize', fitSky); fitSky();

let seed = 1234567;
const chance = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const held = new Set();
addEventListener('keydown', (e) => held.add(e.key.toLowerCase()));
addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
let aimX = null, aimY = null;
sky.addEventListener('pointerdown', (e) => { aimX = e.clientX; aimY = e.clientY; });
sky.addEventListener('pointermove', (e) => { if (aimX !== null) { aimX = e.clientX; aimY = e.clientY; } });
addEventListener('pointerup', () => { aimX = aimY = null; });

const tug = { x: 0, y: 0, vx: 0, vy: 0, heading: 0 };
const corral = { x: 0, y: 0, r: 70 };
let comets = [], debris = [], herded = 0, hull = 3, flash = 0, stars = [];

function newRound() {
  tug.x = width * 0.2; tug.y = height * 0.5; tug.vx = tug.vy = 0;
  corral.x = width * 0.82; corral.y = height * 0.5;
  comets = Array.from({ length: 6 }, () => ({ x: width * (0.3 + chance() * 0.4), y: height * (0.15 + chance() * 0.7), vx: (chance() - 0.5) * 30, vy: (chance() - 0.5) * 30, tail: [] }));
  debris = Array.from({ length: 5 }, () => ({ x: width * (0.35 + chance() * 0.4), y: chance() * height, spin: chance() * 6, drift: 20 + chance() * 40 }));
  stars = Array.from({ length: 90 }, () => ({ x: chance() * width, y: chance() * height, glow: 0.3 + chance() * 0.7 }));
  herded = 0; hull = 3;
}

function steer(dt) {
  let ax = (held.has('arrowright') || held.has('d') ? 1 : 0) - (held.has('arrowleft') || held.has('a') ? 1 : 0);
  let ay = (held.has('arrowdown') || held.has('s') ? 1 : 0) - (held.has('arrowup') || held.has('w') ? 1 : 0);
  if (aimX !== null) { const dx = aimX - tug.x, dy = aimY - tug.y, len = Math.hypot(dx, dy) || 1; if (len > 8) { ax = dx / len; ay = dy / len; } }
  tug.vx = (tug.vx + ax * 420 * dt) * Math.pow(0.18, dt); tug.vy = (tug.vy + ay * 420 * dt) * Math.pow(0.18, dt);
  tug.x = Math.max(12, Math.min(width - 12, tug.x + tug.vx * dt)); tug.y = Math.max(12, Math.min(height - 12, tug.y + tug.vy * dt));
  if (ax || ay) tug.heading = Math.atan2(ay, ax);
}

function advance(dt) {
  steer(dt);
  for (const c of comets) {
    const dx = c.x - tug.x, dy = c.y - tug.y, d = Math.hypot(dx, dy);
    if (d < 60 && d > 0) { c.vx += (dx / d) * 260 * dt; c.vy += (dy / d) * 260 * dt; }
    c.vx *= Math.pow(0.6, dt); c.vy *= Math.pow(0.6, dt); c.x += c.vx * dt; c.y += c.vy * dt;
    if (c.x < 10 || c.x > width - 10) c.vx *= -1; if (c.y < 10 || c.y > height - 10) c.vy *= -1;
    c.tail.unshift({ x: c.x, y: c.y }); c.tail.length = Math.min(c.tail.length, 14);
    if (Math.hypot(c.x - corral.x, c.y - corral.y) < corral.r) { c.done = true; herded++; flash = 0.4; }
  }
  comets = comets.filter((c) => !c.done);
  for (const r of debris) {
    r.y += r.drift * dt; r.spin += dt; if (r.y > height + 20) { r.y = -20; r.x = width * (0.35 + chance() * 0.4); }
    if (Math.hypot(r.x - tug.x, r.y - tug.y) < 22) { hull--; r.y = -40; flash = 0.6; }
  }
  if (hull <= 0 || !comets.length) newRound();
  flash = Math.max(0, flash - dt);
  hud.textContent = `Herded: ${herded} · Hull: ${hull}`;
}

function paint(time) {
  pen.fillStyle = '#070b14'; pen.fillRect(0, 0, width, height);
  for (const s of stars) { pen.globalAlpha = s.glow * (0.6 + 0.4 * Math.sin(time * 2 + s.x)); pen.fillStyle = '#cfe0ff'; pen.fillRect(s.x, s.y, 2, 2); }
  pen.globalAlpha = 1;
  pen.strokeStyle = '#43d9a3'; pen.lineWidth = 3; pen.setLineDash([10, 8]); pen.beginPath(); pen.arc(corral.x, corral.y, corral.r, 0, Math.PI * 2); pen.stroke(); pen.setLineDash([]);
  for (const c of comets) {
    c.tail.forEach((p, i) => { pen.globalAlpha = 1 - i / 14; pen.fillStyle = '#7fb8ff'; pen.beginPath(); pen.arc(p.x, p.y, 7 - i * 0.4, 0, Math.PI * 2); pen.fill(); });
    pen.globalAlpha = 1; pen.fillStyle = '#ffffff'; pen.beginPath(); pen.arc(c.x, c.y, 8, 0, Math.PI * 2); pen.fill();
  }
  for (const r of debris) { pen.save(); pen.translate(r.x, r.y); pen.rotate(r.spin); pen.fillStyle = '#a0522d'; pen.fillRect(-10, -7, 20, 14); pen.restore(); }
  pen.save(); pen.translate(tug.x, tug.y); pen.rotate(tug.heading); pen.fillStyle = '#ffb347'; pen.beginPath(); pen.moveTo(16, 0); pen.lineTo(-10, -10); pen.lineTo(-6, 0); pen.lineTo(-10, 10); pen.closePath(); pen.fill(); pen.restore();
  if (flash > 0) { pen.fillStyle = `rgba(255,255,255,${flash * 0.3})`; pen.fillRect(0, 0, width, height); }
}

newRound();
let before = performance.now();
function frame(now) { const dt = Math.min(0.05, (now - before) / 1000); before = now; advance(dt); paint(now / 1000); requestAnimationFrame(frame); }
paint(0);
if (window.GCP) GCP.ready();
requestAnimationFrame(frame);

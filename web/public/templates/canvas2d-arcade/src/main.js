// Glowmoth Meadow — a starter 2D game. Gather motes of light, avoid the thorn-wisps.
// Every sprite is drawn once at boot with the canvas API and then blitted; nothing is downloaded.
// Reshape freely: other sprites, a side view, tiles, a different rule set. The structure stays useful.
import { run, createLoop, mulberry32, Simplex, clamp, TAU } from '@gcp/core.js';
import { setupCanvas, bake, Camera2D, drawSorted, ChunkCache } from '@gcp/canvas2d.js';
import { createInput } from '@gcp/input.js';
import { createAudio } from '@gcp/audio.js';

const G = window.GCP, $ = (id) => document.getElementById(id);

run(async (boot) => {
  const seed = Number(G && G.test.seed) || 77, rand = mulberry32(seed), noise = new Simplex(seed);
  const view = setupCanvas($('cv')), ctx = view.ctx, cam = new Camera2D();
  const fit = () => { cam.zoom = clamp(Math.min(view.w, view.h) / 13, 28, 64); }; fit(); addEventListener('resize', fit);
  const input = createInput($('cv')), audio = createAudio();

  // ---- art: bake once -----------------------------------------------------------------------
  await boot.step(0.3, 'Painting the meadow');
  const moth = bake(1.2, 1.2, (x) => {
    x.fillStyle = 'rgba(0,0,0,.25)'; x.beginPath(); x.ellipse(0.6, 1.12, 0.3, 0.07, 0, 0, TAU); x.fill();
    x.fillStyle = '#f6e7b8'; for (const s of [-1, 1]) { x.beginPath(); x.ellipse(0.6 + s * 0.27, 0.55, 0.26, 0.36, s * 0.5, 0, TAU); x.fill(); }
    x.fillStyle = '#e9a23b'; for (const s of [-1, 1]) { x.beginPath(); x.arc(0.6 + s * 0.28, 0.5, 0.09, 0, TAU); x.fill(); }
    x.fillStyle = '#4a3622'; x.beginPath(); x.ellipse(0.6, 0.6, 0.09, 0.3, 0, 0, TAU); x.fill();
  });
  const mote = bake(0.9, 0.9, (x) => { const g = x.createRadialGradient(0.45, 0.45, 0.02, 0.45, 0.45, 0.45); g.addColorStop(0, '#fff'); g.addColorStop(0.3, 'rgba(255,214,120,.95)'); g.addColorStop(1, 'rgba(255,190,80,0)'); x.fillStyle = g; x.fillRect(0, 0, 0.9, 0.9); }, { ay: 0.5 });
  const wisp = bake(1.3, 1.3, (x) => {
    x.translate(0.65, 0.65); x.fillStyle = '#3a1f3f'; x.beginPath();
    for (let i = 0; i < 16; i++) { const a = (i / 16) * TAU, r = i % 2 ? 0.28 : 0.6; x.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    x.closePath(); x.fill(); x.fillStyle = '#e8604c'; x.beginPath(); x.arc(0, 0, 0.14, 0, TAU); x.fill();
  }, { ay: 0.5 });
  const flowers = ['#e8604c', '#f1e6cf', '#8fb7e8'].map((col) => bake(0.6, 0.8, (x) => {
    x.strokeStyle = '#3f7a35'; x.lineWidth = 0.06; x.beginPath(); x.moveTo(0.3, 0.8); x.quadraticCurveTo(0.24, 0.5, 0.3, 0.3); x.stroke();
    x.fillStyle = col; for (let i = 0; i < 5; i++) { x.beginPath(); x.arc(0.3 + Math.cos(i * 1.26) * 0.12, 0.26 + Math.sin(i * 1.26) * 0.12, 0.09, 0, TAU); x.fill(); }
    x.fillStyle = '#f0b64a'; x.beginPath(); x.arc(0.3, 0.26, 0.07, 0, TAU); x.fill();
  }));
  const reed = bake(0.9, 1.6, (x) => { x.strokeStyle = '#2f6a2c'; x.lineWidth = 0.07; for (let i = 0; i < 5; i++) { x.beginPath(); x.moveTo(0.45, 1.6); x.quadraticCurveTo(0.45 + (i - 2) * 0.12, 0.9, 0.45 + (i - 2) * 0.2, 0.2 + (i % 2) * 0.2); x.stroke(); } });

  // ---- ground: painted per chunk, cached ----------------------------------------------------
  const ground = new ChunkCache({ chunk: 8, scale: 40, paint: (x, cx, cy, n) => {
    x.fillStyle = '#35602f'; x.fillRect(cx * n, cy * n, n, n);
    // Each chunk owns a deterministic set of marks. Painting the neighbours' marks too (the canvas clips them)
    // means a blob that crosses a border is drawn on both sides, so no seams show between chunks.
    const marks = (fn) => { for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) { const ax = cx + ox, ay = cy + oy; fn(mulberry32(((ax * 73856093) ^ (ay * 19349663) ^ seed) >>> 0), ax * n, ay * n); } };
    marks((r, bx, by) => { for (let i = 0; i < 90; i++) { const px = bx + r() * n, py = by + r() * n, v = noise.n2(px * 0.08, py * 0.08); x.fillStyle = v > 0.2 ? 'rgba(98,150,70,.5)' : 'rgba(30,70,40,.45)'; x.beginPath(); x.ellipse(px, py, 0.5 + r() * 0.9, 0.3 + r() * 0.5, r() * 3, 0, TAU); x.fill(); } });
    x.strokeStyle = 'rgba(150,200,110,.35)'; x.lineWidth = 0.04;
    marks((r, bx, by) => { for (let i = 0; i < 70; i++) { const px = bx + r() * n, py = by + r() * n; x.beginPath(); x.moveTo(px, py); x.lineTo(px + (r() - 0.5) * 0.15, py - 0.2 - r() * 0.2); x.stroke(); } });
  } });
  // static scenery from the seed, generated around the player as they roam
  const scenery = new Map();
  const sceneryIn = (b) => { const out = []; for (let cy = Math.floor(b.y0 / 6); cy <= Math.floor(b.y1 / 6); cy++) for (let cx = Math.floor(b.x0 / 6); cx <= Math.floor(b.x1 / 6); cx++) { const k = cx + ',' + cy; let list = scenery.get(k); if (!list) { const r = mulberry32((cx * 9973) ^ (cy * 7919) ^ seed); list = []; for (let i = 0; i < 5; i++) list.push({ sprite: r() < 0.25 ? reed : flowers[(r() * 3) | 0], x: (cx + r()) * 6, y: (cy + r()) * 6 }); scenery.set(k, list); } out.push(...list); } return out; };

  // ---- state --------------------------------------------------------------------------------
  const p = { x: 0, y: 0, vx: 0, vy: 0, flap: 0, hurt: 0 };
  let motes = [], wisps = [], score = 0, lives = 3, over = false, best = 0, spawn = 0;
  const hud = () => { $('score').textContent = score; $('lives').textContent = '♥'.repeat(lives); $('best').textContent = best ? `Best ${best}` : ''; };
  if (G) G.save.get('best').then((v) => { best = v || 0; hud(); });
  const around = (min, max) => { const a = rand() * TAU, d = min + rand() * (max - min); return { x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d }; };
  function reset() { p.x = p.y = p.vx = p.vy = 0; motes = []; wisps = []; score = 0; lives = 3; over = false; spawn = 0; $('over').classList.remove('on'); hud(); }
  async function end() {
    over = true; audio.noise({ dur: 0.6, vol: 0.3, freq: 300 });
    if (score > best) { best = score; if (G) G.save.set('best', best); }
    $('final').textContent = `You gathered ${score} motes`; $('over').classList.add('on'); hud();
    if (G) G.leaderboard.submit('motes', score);
  }
  $('again').onclick = reset;

  // ---- frame --------------------------------------------------------------------------------
  function update(dt, time) {
    if (!over) {
      const mv = input.move, acc = 34;
      p.vx += mv.x * acc * dt; p.vy -= mv.y * acc * dt;
      const drag = Math.exp(-4 * dt); p.vx *= drag; p.vy *= drag; p.x += p.vx * dt; p.y += p.vy * dt; p.flap += dt * (8 + Math.hypot(p.vx, p.vy)); p.hurt = Math.max(0, p.hurt - dt);
      spawn -= dt;
      if (spawn <= 0) { spawn = 0.5; if (motes.length < 14) motes.push({ ...around(4, 11), t: rand() * 9 }); if (wisps.length < 3 + Math.min(9, score / 6)) { const w = around(10, 14); wisps.push({ ...w, a: rand() * TAU, sp: 2 + rand() * 1.5 + score * 0.03 }); } }
      for (let i = motes.length - 1; i >= 0; i--) { const m = motes[i]; const d = Math.hypot(m.x - p.x, m.y - p.y); if (d < 0.8) { motes.splice(i, 1); score++; audio.tone({ freq: 620 + (score % 8) * 60, slide: 0.5, dur: 0.12, vol: 0.2, type: 'triangle' }); hud(); } else if (d > 18) motes.splice(i, 1); }
      for (let i = wisps.length - 1; i >= 0; i--) {
        const w = wisps[i], want = Math.atan2(p.y - w.y, p.x - w.x); let da = want - w.a; da = Math.atan2(Math.sin(da), Math.cos(da)); w.a += clamp(da, -1.6 * dt, 1.6 * dt);   // they turn slowly, so you can out-fly them
        w.x += Math.cos(w.a) * w.sp * dt; w.y += Math.sin(w.a) * w.sp * dt;
        const d = Math.hypot(w.x - p.x, w.y - p.y);
        if (d < 0.75 && p.hurt <= 0) { lives--; p.hurt = 1.2; cam.shake = 1; wisps.splice(i, 1); audio.tone({ freq: 180, slide: -1, dur: 0.3, vol: 0.3, type: 'sawtooth' }); hud(); if (lives <= 0) end(); } else if (d > 22) wisps.splice(i, 1);
      }
    }
    cam.follow(p.x, p.y, dt);

    // draw: ground chunks, then everything tall sorted by its feet, then a dusk overlay
    ctx.fillStyle = '#12100c'; ctx.fillRect(0, 0, view.w, view.h);
    cam.begin(view);
    const b = cam.bounds(view);
    ground.draw(ctx, b);
    const items = sceneryIn(b);
    for (const m of motes) items.push({ sprite: mote, x: m.x, y: m.y + Math.sin(time * 3 + m.t) * 0.15, alpha: 0.75 + Math.sin(time * 5 + m.t) * 0.25 });
    for (const w of wisps) items.push({ sprite: wisp, x: w.x, y: w.y, rot: time * 3 });
    items.push({ sprite: moth, x: p.x, y: p.y + 0.5 + Math.sin(p.flap) * 0.08, flip: p.vx < 0, alpha: p.hurt > 0 && Math.sin(time * 30) > 0 ? 0.35 : 1 });
    drawSorted(ctx, items);
    ctx.restore();
    const g = ctx.createRadialGradient(view.w / 2, view.h / 2, Math.min(view.w, view.h) * 0.25, view.w / 2, view.h / 2, Math.max(view.w, view.h) * 0.75);
    g.addColorStop(0, 'rgba(10,14,30,0)'); g.addColorStop(1, 'rgba(10,14,30,.72)'); ctx.fillStyle = g; ctx.fillRect(0, 0, view.w, view.h);
    input.endFrame();
  }

  // The verifier runs this and reports each step, so a version is only verified if a whole round can be played:
  // score a point, lose the last life, see the end screen, start again. Wait on game state, never on fixed times.
  if (G) G.test.onPlaythrough(async (t) => {
    t.step('start a fresh round'); reset(); await t.frames(2);
    t.step('gather a mote'); motes.push({ x: p.x + 0.3, y: p.y, t: 0 }); await t.until(() => score >= 1, 5000, 'the score to go up');
    t.assert($('score').textContent === String(score), 'the score on screen is wrong');
    t.step('lose the last life to a wisp'); lives = 1; p.hurt = 0; wisps.push({ x: p.x + 0.2, y: p.y, a: 0, sp: 0 }); await t.until(() => over, 5000, 'the round to end');
    t.step('the end screen shows the result'); t.assert($('over').classList.contains('on') && $('final').textContent.includes(String(score)), 'the end screen is missing or shows the wrong score');
    t.step('Play again starts a new round'); $('again').click(); await t.frames(2); t.assert(!over && score === 0 && lives === 3, 'the round did not reset');
  });

  update(0, 0);               // first frame
  if (window.GCP) GCP.ready();           // the contract
  boot.done();
  createLoop({ update }).start();
});

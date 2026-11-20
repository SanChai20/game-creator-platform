// The whole platform contract in one file. Replace the drawing and the update with your game.
// `GCP` is injected by the platform (and is absent when you open the file straight from disk).
import { run, createLoop } from '@gcp/core.js';

run(async (boot) => {
  const canvas = document.getElementById('view'), ctx = canvas.getContext('2d');
  const view = { w: 0, h: 0 };
  const resize = () => { const d = Math.min(devicePixelRatio || 1, 2); view.w = innerWidth; view.h = innerHeight; canvas.width = view.w * d; canvas.height = view.h * d; ctx.setTransform(d, 0, 0, d, 0, 0); };
  addEventListener('resize', resize); resize();

  await boot.step(0.5, 'Getting ready');          // report progress while you build your world
  const dot = { x: view.w / 2, y: view.h / 2, tx: view.w / 2, ty: view.h / 2 };
  canvas.addEventListener('pointermove', (e) => { dot.tx = e.clientX; dot.ty = e.clientY; });

  function update(dt, time) {
    dot.x += (dot.tx - dot.x) * Math.min(1, dt * 8); dot.y += (dot.ty - dot.y) * Math.min(1, dt * 8);
    ctx.fillStyle = '#10151a'; ctx.fillRect(0, 0, view.w, view.h);
    for (let i = 0; i < 40; i++) { ctx.fillStyle = `hsl(${(i * 9 + time * 40) % 360} 70% 60% / .5)`; ctx.fillRect((i * 97 + time * 30) % view.w, (i * 53) % view.h, 6, 6); }
    ctx.fillStyle = '#ffb347'; ctx.beginPath(); ctx.arc(dot.x, dot.y, 18, 0, Math.PI * 2); ctx.fill();
    // the interface is drawn in the canvas too (the contract: everything the player sees is in your canvases)
    const safe = (window.GCP && GCP.display && GCP.display.safe) || { left: 0, top: 0 };
    ctx.font = '14px system-ui, sans-serif'; ctx.textBaseline = 'top'; ctx.fillStyle = '#e8e4da'; ctx.shadowColor = '#000'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
    ctx.fillText('Move the pointer', Math.max(12, safe.left), Math.max(12, safe.top)); ctx.shadowColor = 'transparent';
  }
  // hand the platform the exact frame for feedback screenshots, and say where the game is
  if (window.GCP) { GCP.test.onCapture(() => canvas); GCP.test.onState(() => ({ dot: { x: Math.round(dot.x), y: Math.round(dot.y) } })); }

  update(0, 0);                                    // draw the first frame…
  if (window.GCP) GCP.ready();                     // …then tell the platform the game is playable
  boot.done();
  createLoop({ update }).start();
});

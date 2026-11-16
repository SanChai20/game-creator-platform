// Moss Hopper 2: a small platformer. Tiles are 32 px; the level scrolls with the player.
(function () {
  const canvas = document.getElementById('c'), ctx = canvas.getContext('2d'), hud = document.getElementById('hud');
  const TILE = 32, GRAVITY = 1800, JUMP = 640, SPEED = 220;
  const LEVELS = [
    ['..............................................',
     '..............................................',
     '...................o..o.......................',
     '..............#########.........o.o.o.........',
     '.......o.o...................#########........',
     '.....#######.......................o......o.o.',
     '..........................^^.....#####..######',
     '##############....############################'],
    ['..............................................',
     '...........o.o.o..............................',
     '.........#########........o.o.................',
     '...o.o.................#######......o.o.o.....',
     '..#####...........^^................#######...',
     '...............########......o.o..............',
     '.......^^.................#########.......o.o.',
     '###########...######################...#######'],
  ];
  const sprites = {};
  const names = ['player', 'spore', 'spike', 'tile', 'sky'];
  let loaded = 0;
  for (const n of names) {
    const img = new Image();
    img.onload = () => { loaded++; GCP.progress(loaded / names.length, 'Loading sprites'); if (loaded === names.length) start(); };
    img.onerror = () => GCP.fatal('Could not load ' + n + '.png');
    img.src = 'art/' + n + '.png';
    sprites[n] = img;
  }
  const keys = new Set();
  addEventListener('keydown', (e) => { keys.add(e.code); if (e.code === 'Space') e.preventDefault(); });
  addEventListener('keyup', (e) => keys.delete(e.code));
  let touchX = null, touchJump = false;
  addEventListener('pointerdown', (e) => { touchX = e.clientX; touchJump = true; });
  addEventListener('pointerup', () => { touchX = null; });

  const state = { level: 0, map: null, player: null, spores: 0, total: 0, time: 90, camX: 0, won: false, dead: 0 };
  function load(n) {
    state.level = n; state.map = LEVELS[n].map((row) => row.split(''));
    state.player = { x: 2 * TILE, y: 3 * TILE, vx: 0, vy: 0, w: 22, h: 28, ground: false, face: 1 };
    state.total = state.map.flat().filter((ch) => ch === 'o').length; state.spores = 0; state.time = 90;
  }
  const solid = (tx, ty) => { const row = state.map[ty]; return !!row && row[tx] === '#'; };
  function cell(px, py) { return [Math.floor(px / TILE), Math.floor(py / TILE)]; }

  function step(dt) {
    const p = state.player;
    let dir = 0;
    if (keys.has('ArrowLeft') || keys.has('KeyA')) dir -= 1;
    if (keys.has('ArrowRight') || keys.has('KeyD')) dir += 1;
    if (touchX !== null) dir = touchX < innerWidth / 2 ? -1 : 1;
    p.vx = dir * SPEED; if (dir) p.face = dir;
    if ((keys.has('Space') || keys.has('ArrowUp') || keys.has('KeyW') || touchJump) && (p.ground || p.jumps < 2) && !p.held) { p.vy = -JUMP; p.ground = false; p.jumps = (p.jumps || 0) + 1; GCP.sound && 0; }
    touchJump = false;
    p.vy = Math.min(p.vy + GRAVITY * dt, 900);
    // horizontal then vertical, resolving against tiles
    p.x += p.vx * dt;
    for (const [ox, oy] of [[0, 0], [p.w, 0], [0, p.h - 1], [p.w, p.h - 1]]) {
      const [tx, ty] = cell(p.x + ox, p.y + oy);
      if (solid(tx, ty)) { p.x = p.vx > 0 ? tx * TILE - p.w - 0.01 : (tx + 1) * TILE + 0.01; }
    }
    p.y += p.vy * dt; p.ground = false;
    for (const [ox, oy] of [[1, 0], [p.w - 1, 0], [1, p.h], [p.w - 1, p.h]]) {
      const [tx, ty] = cell(p.x + ox, p.y + oy);
      if (solid(tx, ty)) { if (p.vy > 0) { p.y = ty * TILE - p.h - 0.01; p.ground = true; } else p.y = (ty + 1) * TILE + 0.01; p.vy = 0; }
    }
    const [cx, cy] = cell(p.x + p.w / 2, p.y + p.h / 2);
    const here = state.map[cy] && state.map[cy][cx];
    if (here === 'o') { state.map[cy][cx] = '.'; state.spores++; }
    if (here === '^' || p.y > state.map.length * TILE + 200) { state.dead++; load(state.level); }
    state.time -= dt; if (state.time <= 0) load(state.level);
    if (state.spores === state.total) { if (state.level + 1 < LEVELS.length) load(state.level + 1); else state.won = true; }
    const viewW = canvas.width;
    state.camX = Math.max(0, Math.min(p.x - viewW / 2, state.map[0].length * TILE - viewW));
  }

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.drawImage(sprites.sky, 0, 0, W, H);
    ctx.save(); ctx.translate(-Math.round(state.camX), Math.round(H - state.map.length * TILE));
    state.map.forEach((row, ty) => row.forEach((ch, tx) => {
      if (ch === '#') ctx.drawImage(sprites.tile, tx * TILE, ty * TILE, TILE, TILE);
      else if (ch === 'o') ctx.drawImage(sprites.spore, tx * TILE + 8, ty * TILE + 8 + Math.sin(performance.now() / 300 + tx) * 3, 16, 16);
      else if (ch === '^') ctx.drawImage(sprites.spike, tx * TILE, ty * TILE, TILE, TILE);
    }));
    const p = state.player;
    ctx.save(); ctx.translate(p.x + p.w / 2, p.y); ctx.scale(p.face, 1); ctx.drawImage(sprites.player, -p.w / 2 - 5, -4, 32, 32); ctx.restore();
    ctx.restore();
    hud.textContent = state.won ? 'You saved the forest! Spores: ' + state.spores : `Level ${state.level + 1}  Spores ${state.spores}/${state.total}  Time ${Math.ceil(state.time)}`;
  }

  function resize() { canvas.width = Math.min(960, innerWidth); canvas.height = Math.min(540, innerHeight); ctx.imageSmoothingEnabled = false; }
  addEventListener('resize', resize);
  let last = 0;
  function frame(t) { const dt = Math.min(0.05, (t - last) / 1000 || 0); last = t; if (!state.won) step(dt); draw(); requestAnimationFrame(frame); }
  function start() {
    resize(); load(0); draw(); GCP.ready();
    requestAnimationFrame(frame);
  }
  GCP.test.onPlaythrough(async (t) => {
    t.step('walk right'); keys.add('ArrowRight'); await t.wait(600); keys.delete('ArrowRight');
    t.step('jump'); keys.add('Space'); await t.frames(3); keys.delete('Space'); await t.until(() => state.player.ground, 4000, 'landing');
    t.step('collect every spore of level 1');
    state.map.forEach((r, y) => r.forEach((ch, x) => { if (ch === 'o') { r[x] = '.'; state.spores++; } }));
    await t.until(() => state.level === 1, 4000, 'level 2');
    t.assert(state.level === 1, 'reached level 2');
  });
})();

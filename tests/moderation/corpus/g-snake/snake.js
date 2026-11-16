// Garden Snake. A 20x20 grid; the snake moves one cell per tick, faster after each berry.
const board = document.getElementById('board');
const g = board.getContext('2d');
const N = 20, CELL = board.width / N;
let snake, heading, nextHeading, berry, rocks, score, best = 0, tickMs, acc, over;

function reset() {
  snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
  heading = { x: 1, y: 0 }; nextHeading = heading;
  rocks = [];
  for (let i = 0; i < 6; i++) rocks.push(freeCell());
  berry = freeCell(); score = 0; tickMs = 160; acc = 0; over = false;
}
function freeCell() {
  for (;;) {
    const c = { x: Math.floor(Math.random() * N), y: Math.floor(Math.random() * N) };
    if (!snake.some((s) => s.x === c.x && s.y === c.y) && !(rocks || []).some((r) => r.x === c.x && r.y === c.y)) return c;
  }
}
function turn(dx, dy) { if (dx !== -heading.x || dy !== -heading.y) nextHeading = { x: dx, y: dy }; }
document.addEventListener('keydown', (e) => {
  const map = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };
  if (map[e.code]) { turn(...map[e.code]); e.preventDefault(); }
  if (over && (e.code === 'Enter' || e.code === 'Space')) reset();
});
let swipe = null;
board.addEventListener('pointerdown', (e) => { swipe = { x: e.clientX, y: e.clientY }; if (over) reset(); });
board.addEventListener('pointerup', (e) => {
  if (!swipe) return; const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y; swipe = null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) return;
  if (Math.abs(dx) > Math.abs(dy)) turn(Math.sign(dx), 0); else turn(0, Math.sign(dy));
});

function tick() {
  heading = nextHeading;
  const head = { x: (snake[0].x + heading.x + N) % N, y: (snake[0].y + heading.y + N) % N };
  const hit = snake.some((s) => s.x === head.x && s.y === head.y) || rocks.some((r) => r.x === head.x && r.y === head.y);
  if (hit) { over = true; best = Math.max(best, score); GCP.playerStats.max('best', best); return; }
  snake.unshift(head);
  if (head.x === berry.x && head.y === berry.y) { score++; tickMs = Math.max(60, tickMs - 6); berry = freeCell(); }
  else snake.pop();
}
function paint() {
  g.fillStyle = '#2f4a26'; g.fillRect(0, 0, board.width, board.height);
  g.fillStyle = '#365530';
  for (let y = 0; y < N; y++) for (let x = (y % 2); x < N; x += 2) g.fillRect(x * CELL, y * CELL, CELL, CELL);
  g.fillStyle = '#7d7565'; rocks.forEach((r) => { g.beginPath(); g.arc(r.x * CELL + CELL / 2, r.y * CELL + CELL / 2, CELL * 0.42, 0, 7); g.fill(); });
  g.fillStyle = '#d9395b'; g.beginPath(); g.arc(berry.x * CELL + CELL / 2, berry.y * CELL + CELL / 2, CELL * 0.35, 0, 7); g.fill();
  snake.forEach((s, i) => { g.fillStyle = i ? '#9fd356' : '#c7f07a'; g.fillRect(s.x * CELL + 2, s.y * CELL + 2, CELL - 4, CELL - 4); });
  g.fillStyle = '#e6f2c8'; g.font = '18px sans-serif'; g.fillText(`Berries ${score}   Best ${best}`, 10, 22);
  if (over) { g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 0, board.width, board.height); g.fillStyle = '#fff'; g.font = '28px sans-serif'; g.fillText('Bitten! Tap or press Enter', 70, 240); }
}
let prev = performance.now();
function loop(now) {
  acc += now - prev; prev = now;
  while (!over && acc >= tickMs) { tick(); acc -= tickMs; }
  if (over) acc = 0;
  paint();
  requestAnimationFrame(loop);
}
reset(); paint(); GCP.ready(); requestAnimationFrame(loop);
GCP.test.onPlaythrough(async (t) => {
  t.step('steer towards the berry'); reset();
  berry = { x: snake[0].x + 3, y: snake[0].y }; rocks = rocks.filter((r) => r.y !== snake[0].y);
  await t.until(() => score === 1, 4000, 'eating a berry');
  t.step('bite own tail');
  snake = [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 6 }, { x: 5, y: 6 }, { x: 4, y: 6 }, { x: 4, y: 5 }]; heading = nextHeading = { x: 0, y: 1 };
  await t.until(() => over, 4000, 'game over');
  t.assert(best >= 1, 'best score kept');
});

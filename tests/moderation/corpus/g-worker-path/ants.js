// Ant simulation in a worker: each tick every ant follows pheromones, picks up food and carries it home.
let W, H, ants, carrying, scent, food = [], walls = null, gathered = 0;
onmessage = (e) => {
  const m = e.data;
  if (m.start) { ({ W, H } = m.start); ants = new Float32Array(m.start.count * 2); carrying = new Uint8Array(m.start.count); scent = new Float32Array(W * H); for (let i = 0; i < ants.length; i += 2) { ants[i] = W / 2; ants[i + 1] = H / 2; } setInterval(tick, 33); }
  if (m.food) food.push({ x: m.food[0], y: m.food[1], left: 50 });
  if (m.walls) walls = m.walls;
};
function tick() {
  for (let k = 0; k < 4; k++) {   // several substeps per message keep the colony lively
    for (let i = 0, a = 0; i < ants.length; i += 2, a++) {
      let x = ants[i], y = ants[i + 1], best = -1, bx = x, by = y;
      for (let n = 0; n < 6; n++) {
        const nx = x + (Math.random() - 0.5) * 2, ny = y + (Math.random() - 0.5) * 2;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || (walls && walls[(ny | 0) * W + (nx | 0)])) continue;
        let s = scent[(ny | 0) * W + (nx | 0)] + Math.random() * 0.2;
        if (carrying[a]) s += 1 / (1 + Math.hypot(nx - W / 2, ny - H / 2));
        else for (const f of food) if (f.left > 0) s += 2 / (1 + Math.hypot(nx - f.x, ny - f.y));
        if (s > best) { best = s; bx = nx; by = ny; }
      }
      ants[i] = bx; ants[i + 1] = by;
      if (!carrying[a]) for (const f of food) if (f.left > 0 && Math.hypot(bx - f.x, by - f.y) < 1.5) { carrying[a] = 1; f.left--; }
      if (carrying[a]) { scent[(by | 0) * W + (bx | 0)] += 0.5; if (Math.hypot(bx - W / 2, by - H / 2) < 2) { carrying[a] = 0; gathered++; } }
    }
    for (let i = 0; i < scent.length; i++) scent[i] *= 0.995;
  }
  postMessage({ ants, gathered });
}

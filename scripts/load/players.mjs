// Simulated players: node players.mjs <players> <seconds>. Each signs in (seeded session), starts a free live game, then
// loops: page check-in, game heartbeat, a save, a stat and a score, like a real session compressed in time.
import { readFileSync } from 'node:fs';
const [np, secs] = process.argv.slice(2).map(Number), BASE = process.env.BASE || 'http://127.0.0.1:8787';
const toks = JSON.parse(readFileSync(new URL('./tokens.json', import.meta.url)));
const GAMES = (process.env.GAMES || '').split(',').filter(Boolean);
const stats = {}, rec = (k, ms, code) => { const s = stats[k] ||= { n: 0, lat: [], codes: {} }; s.n++; s.lat.push(ms); s.codes[code] = (s.codes[code] || 0) + 1; };
async function call(k, method, path, body, cookie) {
  const t = performance.now();
  try { const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body) }); const j = await r.json().catch(() => null); rec(k, performance.now() - t, r.status); return { s: r.status, j }; }
  catch (e) { rec(k, performance.now() - t, 'err'); return { s: 0 }; }
}
const end = Date.now() + secs * 1000;
async function player(i) {
  const cookie = 'gcp_session=' + toks[i];
  const slug = GAMES.length ? GAMES[i % GAMES.length] : 'seed-game-' + (i % 4 === 3 ? i + 1 : i) % 200;
  const start = await call('play', 'POST', `/api/games/${slug}/play`, {}, cookie);
  if (start.s !== 200) return;
  const t = new URL(start.j.url).searchParams.get('gcp_t'), sid = start.j.session;
  let n = 0;
  while (Date.now() < end) {
    await call('seen', 'POST', `/api/plays/${sid}/seen`, { visible_ms: 3000 }, cookie);
    await call('beat', 'POST', '/api/rt/beat', { t, frames: n * 180, errors: [] });
    await call('save', 'POST', '/api/rt/save', { t, op: 'set', key: 'slot' + (n % 3), value: { level: n, pad: 'p'.repeat(2000) } });
    await call('stats', 'POST', '/api/rt/stats', { t, op: 'add', name: 'kills', value: 1 });
    await call('score', 'POST', '/api/rt/score', { t, op: 'submit', board: 'default', score: n });
    n++; await new Promise((r) => setTimeout(r, 2500));
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: np }, (_, i) => player(i)));
const el = (Date.now() - t0) / 1000;
for (const [k, s] of Object.entries(stats)) { s.lat.sort((a, b) => a - b); const q = (x) => s.lat[Math.min(s.lat.length - 1, Math.floor(s.lat.length * x))].toFixed(0); console.log(k.padEnd(6), JSON.stringify({ n: s.n, rps: (s.n / el).toFixed(1), p50: q(.5), p95: q(.95), p99: q(.99), max: q(.9999), codes: s.codes })); }

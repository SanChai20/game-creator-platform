// Players on the play clock, in real time: BASE=<staging or local> node scripts/load/clock-players.mjs <players> <seconds>
// Never point this at production. Each player (seeded by clock-seed.mjs) starts a free game and then, like the page
// and the game, checks in and sends a heartbeat every 15 seconds. Reports latencies, status codes and what was credited.
import { readFileSync } from 'node:fs';
const [np = 100, secs = 60] = process.argv.slice(2).map(Number), BASE = process.env.BASE || 'http://127.0.0.1:8790';
if (/hearthcade\.com/.test(BASE)) { console.error('not against production'); process.exit(2); }
const GAMES = Number(process.env.GAMES || 20), toks = JSON.parse(readFileSync(new URL('./clock-tokens.json', import.meta.url)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = {}, rec = (k, ms, code) => { const s = (stats[k] ||= { n: 0, lat: [], codes: {} }); s.n++; s.lat.push(ms); s.codes[code] = (s.codes[code] || 0) + 1; };
// retries a "busy" answer as the page does (web/src/lib.tsx api); RETRY=0 shows the first answers only
const RETRY = process.env.RETRY !== '0';
async function call(k, path, body, headers = {}) {
  const t = performance.now();
  try {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, ...headers }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (RETRY && r.status === 503 && j?.code === 'busy' && attempt < 4) { rec(k + '_busy', 0, 503); await wait((500 << attempt) * (0.5 + Math.random())); continue; }
      rec(k, performance.now() - t, r.status); return { s: r.status, j };
    }
  } catch { rec(k, performance.now() - t, 'err'); return { s: 0 }; }
}
const credited = [], end = Date.now() + secs * 1000;
async function player(i) {
  await wait(Math.floor((i / np) * 15000));   // players arrive over the first 15 seconds
  const cookie = (BASE.startsWith('https:') ? '__Host-' : '') + 'gcp_session=' + toks[i];
  const start = await call('play', `/api/games/load-game-${i % GAMES}/play`, {}, { cookie });
  if (start.s !== 200) { if (i < 3) console.error('play', start.s, String(JSON.stringify(start.j)).slice(0, 200)); return; }
  const tok = new URL(start.j.url).searchParams.get('gcp_t'), sid = start.j.session, clock = start.j.clock;
  let last = 0, n = 0, mark = Date.now();
  while (Date.now() < end) {
    const now = Date.now(), visible = n ? now - mark : 0; mark = now;
    const r = await call('seen', `/api/plays/${sid}/seen`, { visible_ms: visible }, { cookie, 'x-gcp-clock': clock });
    if (r.j && r.j.ok) last = r.j.seconds;
    await call('beat', '/api/rt/beat', { t: tok, frames: n * 900, errors: [] });
    n++; await wait(15000 - (Date.now() - now));
  }
  credited.push(last);
}
const t0 = Date.now();
await Promise.all(Array.from({ length: np }, (_, i) => player(i)));
const el = (Date.now() - t0) / 1000;
for (const [k, s] of Object.entries(stats)) {
  s.lat.sort((a, b) => a - b); const q = (x) => s.lat[Math.min(s.lat.length - 1, Math.floor(s.lat.length * x))].toFixed(0);
  console.log(k.padEnd(5), JSON.stringify({ n: s.n, rps: +(s.n / el).toFixed(1), p50: q(.5), p95: q(.95), p99: q(.99), max: q(.9999), codes: s.codes }));
}
credited.sort((a, b) => a - b);
console.log('credited seconds per player', JSON.stringify({ players: credited.length, min: credited[0], median: credited[credited.length >> 1], max: credited.at(-1), expected_about: Math.floor((secs - 15) / 15) * 15 }));

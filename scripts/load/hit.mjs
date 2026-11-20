// Tiny load generator: node hit.mjs <concurrency> <seconds> <path>...  (cycles through paths)
const [conc, secs, ...paths] = process.argv.slice(2); const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const lat = [], codes = {}; let i = 0; const end = Date.now() + secs * 1000;
const headers = process.env.COOKIE ? { cookie: process.env.COOKIE, origin: BASE } : { origin: BASE };
async function worker() { while (Date.now() < end) { const p = paths[i++ % paths.length].replace('$R', String(Math.floor(Math.random() * 30000))); const t = performance.now(); try { const r = await fetch(BASE + p, { headers, method: process.env.METHOD || 'GET', body: process.env.BODY }); await r.arrayBuffer(); codes[r.status] = (codes[r.status] || 0) + 1; } catch (e) { codes.err = (codes.err || 0) + 1; } lat.push(performance.now() - t); } }
await Promise.all(Array.from({ length: +conc }, worker));
lat.sort((a, b) => a - b); const q = (x) => lat[Math.min(lat.length - 1, Math.floor(lat.length * x))].toFixed(0);
console.log(JSON.stringify({ paths: paths.join(' ').slice(0, 80), n: lat.length, rps: (lat.length / secs).toFixed(1), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(0.9999), codes }));

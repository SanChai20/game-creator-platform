// What the play clock costs at scale, in simulated time: node scripts/load/clock-sim.mjs [players] [minutes] [games]
// Runs the real code of both play clocks against an in-memory copy of the database (every migration) and counts what
// each sends to the database and, for the Durable Object clock, to Durable Object storage:
//   database  every check-in is src/play-clock.ts checkIn, every heartbeat the statements src/routes/rt.ts legacyBeat runs
//   objects   every check-in and heartbeat goes to the player's PlayClock (src/clock-do.ts), which batches the database
// Players check in and send a heartbeat every 15 seconds (CHECKIN_MS), as the page and the game do. Nothing is sent
// anywhere: Durable Objects are stood in for by plain objects with a storage that counts its writes.
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

const shim = 'data:text/javascript,' + encodeURIComponent('export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}');
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { return s === 'cloudflare:workers' ? { url: ${JSON.stringify(shim)}, shortCircuit: true } : n(s, c); }`));
register('../../tests/ts-hook.mjs', import.meta.url);

const [PLAYERS = 20000, MINUTES = 30, GAMES = 500] = process.argv.slice(2).map(Number);
const STEP = 15_000, MIN_SECONDS = 30;
// EVICT=1: every request reaches a newly started object (only its storage survives), the worst a real one can see
const EVICT = process.env.EVICT === '1';
let now = Date.parse('2026-11-20T09:00:00Z');
Date.now = () => now;
const { checkIn } = await import('../../src/play-clock.ts');
const { bindingProblem } = await import('../../src/session-binding.js');
const { PlayClock, GameTally } = await import('../../src/clock-do.ts');

function database() {
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(f, dir), 'utf8'));
  const n = { statements: 0, reads: 0, writes: 0, rows_written: 0, batches: 0 };
  const cache = new Map(), prep = (q) => cache.get(q) || (cache.set(q, sql.prepare(q)), cache.get(q));
  const write = (q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q);
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    first: async () => { n.statements++; if (write(q)) { n.writes++; const r = prep(q).get(...args); n.rows_written += r ? 1 : 0; return r ?? null; } n.reads++; return prep(q).get(...args) ?? null; },
    all: async () => { n.statements++; n.reads++; return { results: prep(q).all(...args) }; },
    run: async () => { n.statements++; n.writes++; const r = prep(q).run(...args); n.rows_written += Number(r.changes); return { meta: { changes: Number(r.changes) } }; },
  });
  const batch = async (list) => { n.batches++; const out = []; for (const s of list) out.push(await s.run()); return out; };
  return { db: { prepare: (q) => stmt(q), batch }, sql, n };
}

function seed(sql) {
  sql.exec('BEGIN');
  const p = sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, live_version, preview_version, price_cents, created_at, updated_at) VALUES (?, 'u_maker', ?, ?, 'live', 1, 1, 0, 0, 0)");
  for (let g = 0; g < GAMES; g++) p.run('g' + g, 'game-' + g, 'Game ' + g);
  const u = sql.prepare("INSERT INTO users (id, email, name, pw_hash, created_at) VALUES (?, ?, 'P', 'x', 0)");
  const s = sql.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)');
  const pl = sql.prepare("INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at, login_id) VALUES (?, ?, 1, 'live', ?, 'player', ?, ?, ?)");
  const players = [];
  for (let i = 0; i < PLAYERS; i++) {
    // most players are in a few popular games, as on a real store
    const game = 'g' + Math.floor(GAMES * Math.pow(((i * 2654435761) % 2 ** 32) / 2 ** 32, 3));
    u.run('u_p' + i, `p${i}@example.com`); s.run('login' + i, 'u_p' + i, now + 30 * 86400_000);
    const at = now + (i % 15) * 1000;   // spread over the first 15 seconds
    pl.run('ps_' + String(i).padStart(10, '0'), game, 'u_p' + i, at, at, 'login' + i);
    players.push({ sid: 'ps_' + String(i).padStart(10, '0'), user: 'u_p' + i, game, at, frames: 0 });
  }
  sql.exec('COMMIT');
  return players;
}

/** Durable Object namespaces in memory: one object per name, alarms run when the simulated clock reaches them. */
function namespace(Cls, env, counts) {
  const objs = new Map(), alarms = new Map();
  const stores = new Map();
  const storage = (name) => {
    const m = new Map();
    return {
      get: async (k) => { counts.storage_reads++; return m.has(k) ? structuredClone(m.get(k)) : undefined; },
      put: async (k, v) => { counts.storage_writes++; m.set(k, structuredClone(v)); },
      getAlarm: async () => { counts.storage_reads++; return alarms.get(name) ?? null; },
      setAlarm: async (t) => { counts.storage_writes++; alarms.set(name, t); },
    };
  };
  const make = (name) => { if (!stores.has(name)) stores.set(name, storage(name)); return new Cls({ storage: stores.get(name) }, env); };
  const ns = {
    idFromName: (name) => name,
    get: (name) => {
      if (!objs.has(name)) { objs.set(name, make(name)); counts.objects++; }
      return new Proxy({}, { get: (_, m) => async (...a) => {
        counts.requests++;
        if (EVICT) { objs.set(name, make(name)); counts.restarts++; }
        return structuredClone(await objs.get(name)[m](...structuredClone(a)));
      } });
    },
    async runAlarms(t) {
      for (const [name, at] of [...alarms]) if (at <= t) {
        alarms.delete(name); counts.requests++;
        if (EVICT) { objs.set(name, make(name)); counts.restarts++; }
        await objs.get(name).alarm();
      }
    },
  };
  return ns;
}

async function run(mode) {
  const { db, sql, n } = database();
  const players = seed(sql);
  const base = { ...n };
  const objs = { requests: 0, storage_reads: 0, storage_writes: 0, objects: 0, restarts: 0 };
  const env = { DB: db };
  const clocks = namespace(PlayClock, env, objs), tallies = namespace(GameTally, env, objs);
  env.PLAY_CLOCK = clocks; env.GAME_TALLY = tallies;
  const t0 = now, end = t0 + MINUTES * 60_000;
  let checkins = 0, beats = 0, refused = 0;
  const started = performance.now();
  for (let tick = t0 + STEP; tick <= end; tick += 1000) {
    now = tick;
    for (const p of players) {
      if ((tick - p.at) % STEP !== 0 || tick <= p.at) continue;
      checkins++; beats++; p.frames += 900;
      if (mode === 'database') {
        // the sign-in lookup the middleware does, then the check-in
        await db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?').bind('login' + p.user.slice(3), tick).first();
        const r = await checkIn(env, { play_min_seconds: MIN_SECONDS }, p.sid, p.user, STEP, tick);
        if (!r.ok) refused++;
        // the heartbeat (src/routes/rt.ts): the binding check, the session, the update
        await bindingProblem(db, { s: p.sid, u: p.user, g: p.game, e: 'live', k: 'player' }, tick);
        const row = await db.prepare('SELECT * FROM plays WHERE id = ?').bind(p.sid).first();
        await db.batch([db.prepare('UPDATE plays SET last_beat_at = ?, frames = ?, ready = 1, errors = ? WHERE id = ?').bind(tick, p.frames, row.errors, p.sid)]);
      } else {
        const c = clocks.get(p.user);
        const r = await c.checkIn(p.sid, p.user, STEP, tick, MIN_SECONDS);
        if (!r.ok) refused++;
        await c.beat({ sid: p.sid, player: p.user, frames: p.frames, errors: [], fatal: false, t: tick, human_min_seconds: 60, tok: { g: p.game, e: 'live', u: p.user, k: 'player', s: p.sid } });
      }
    }
    if (mode === 'objects') { await clocks.runAlarms(tick); await tallies.runAlarms(tick); }
  }
  // everyone stops playing: let the clocks write out and the tallies count down to zero
  for (let tick = end + 1000; tick <= end + 12 * 60_000; tick += 1000) { now = tick; if (mode === 'objects') { await clocks.runAlarms(tick); await tallies.runAlarms(tick); } }
  const q = (s) => sql.prepare(s).get();
  const totals = {
    plays_counted: q("SELECT COUNT(*) AS n FROM plays WHERE counted = 1").n,
    session_seconds: q('SELECT SUM(seconds) AS n FROM plays').n,
    record_seconds: q('SELECT SUM(seconds) AS n FROM player_games').n,
    game_seconds: q('SELECT SUM(seconds) AS n FROM projects').n,
    game_plays: q('SELECT SUM(plays) AS n FROM projects').n,
    daily_seconds: q('SELECT SUM(seconds) AS n FROM game_daily').n,
    daily_plays: q('SELECT SUM(plays) AS n FROM game_daily').n,
  };
  const d = Object.fromEntries(Object.entries(n).map(([k, v]) => [k, v - base[k]]));
  return { mode, checkins, beats, refused, db: d, objects: mode === 'objects' ? objs : null, totals, wall_s: +((performance.now() - started) / 1000).toFixed(1) };
}

const fmt = (x) => x.toLocaleString('en-US');
const a = await run('database'), b = await run('objects');
const perMin = (v) => fmt(Math.round(v / MINUTES));
console.log(`${fmt(PLAYERS)} players in ${GAMES} games for ${MINUTES} simulated minutes${EVICT ? ', every object restarted before every request' : ''} (${fmt(a.checkins)} check-ins and ${fmt(a.beats)} heartbeats each run)\n`);
for (const r of [a, b]) {
  console.log(`${r.mode.padEnd(9)} database: ${fmt(r.db.statements)} statements (${perMin(r.db.statements)}/min), ${fmt(r.db.writes)} write statements, ${fmt(r.db.rows_written)} rows written (${perMin(r.db.rows_written)}/min), refused ${r.refused}, ${r.wall_s}s`);
  if (r.objects) console.log(`          objects: ${fmt(r.objects.objects)} objects, ${fmt(r.objects.requests)} requests (${perMin(r.objects.requests)}/min), ${fmt(r.objects.storage_writes)} storage writes (${perMin(r.objects.storage_writes)}/min)`);
}
console.log(`\ndatabase statements: ${(a.db.statements / Math.max(1, b.db.statements)).toFixed(0)}x fewer; rows written: ${(a.db.rows_written / Math.max(1, b.db.rows_written)).toFixed(0)}x fewer`);
console.log('\ntotals (must match)');
for (const k of Object.keys(a.totals)) console.log(`  ${k.padEnd(16)} database ${String(a.totals[k]).padStart(12)}   objects ${String(b.totals[k]).padStart(12)}${a.totals[k] === b.totals[k] ? '' : '   DIFFERENT'}`);
const same = Object.keys(a.totals).every((k) => a.totals[k] === b.totals[k]);
console.log(JSON.stringify({ players: PLAYERS, minutes: MINUTES, games: GAMES, database: a, objects: b, same }));
process.exit(same ? 0 : 1);

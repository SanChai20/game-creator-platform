// Seeds a local D1 file with a platform-sized catalogue: node seed.mjs <sqlite file> <repo>
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const [file, repo] = process.argv.slice(2);
const db = new DatabaseSync(file);
const tagsSrc = readFileSync(repo + '/web/src/tags.ts', 'utf8'), gm = readFileSync(repo + '/web/src/gamemeta.ts', 'utf8');
const TAGS = [...tagsSrc.slice(tagsSrc.indexOf('TAG_GROUPS'), tagsSrc.indexOf('} as const')).matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
const GENRES = [...gm.slice(gm.indexOf('export const GENRES'), gm.indexOf('export type Genre')).matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const zipf = (n) => Math.floor(n * Math.pow(rnd(), 3));   // most activity on few items
const N = { users: +process.env.USERS || 20000, creators: +process.env.CREATORS || 3000, projects: +process.env.PROJECTS || 40000, plays: +process.env.PLAYS || 1000000 };
const T = Date.now(), DAY = 86400000;
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; BEGIN');
const u = db.prepare('INSERT OR IGNORE INTO users (id, email, name, pw_hash, created_at, creator, creator_since, creator_plan, stripe_account, stripe_payouts_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
for (let i = 0; i < N.users; i++) { const cr = i < N.creators; u.run('u_seed' + i, `seed${i}@example.com`, 'Seed ' + i, 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', T - zipf(400) * DAY, cr ? 1 : 0, cr ? T - 300 * DAY : null, cr ? 'lifetime' : null, cr && i % 3 === 0 ? 'acct_seed' + i : null, cr && i % 3 === 0 ? 1 : 0); }
const p = db.prepare(`INSERT OR IGNORE INTO projects (id, owner_id, slug, title, tagline, tags, status, live_version, preview_version, next_version, price_cents, plays, seconds, rating_sum, rating_count, created_at, updated_at, published_at, open_implementation, trial_minutes, recent, cover_key)
  VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const v = db.prepare("INSERT OR IGNORE INTO versions (project_id, n, manifest, status, created_at, verified_at, published_at) VALUES (?, 1, '{}', 'verified', ?, ?, ?)");
const pids = [];
for (let i = 0; i < N.projects; i++) {
  const id = 'sd' + i.toString(36).padStart(6, '0'), st = i % 4 === 3 ? pick(['draft', 'offline', 'removed']) : 'live';
  const tags = [pick(GENRES), ...new Set([pick(TAGS), pick(TAGS), pick(TAGS), pick(TAGS)])];
  const plays = Math.floor(100000 * Math.pow(rnd(), 6)), rc = Math.floor(plays / 50), price = rnd() < 0.2 ? pick([99, 299, 499, 999]) : 0;
  p.run(id, 'u_seed' + (i % N.creators), 'seed-game-' + i, 'Seed Game ' + i + ' ' + pick(['Quest', 'Run', 'Tower', 'Garden', 'Rift']), 'A ' + tags[0] + ' game', JSON.stringify(tags), st, price, plays, plays * 300, rc * 4, rc, T - 300 * DAY, T - zipf(300) * DAY, st === 'live' ? T - zipf(300) * DAY : null, i % 7 === 0 ? 1 : 0, price && i % 2 ? 10 : 0, Math.floor(plays / 30), `covers/${id}-x1.png`);
  v.run(id, T - 300 * DAY, T - 300 * DAY, T - 300 * DAY);
  pids.push(id);
}
const live = pids.filter((_, i) => i % 4 !== 3);
const gd = db.prepare('INSERT OR IGNORE INTO game_daily (project_id, day, sessions, plays, seconds) VALUES (?, ?, ?, ?, ?)');
for (let d = 0; d < 60; d++) { const day = new Date(T - d * DAY).toISOString().slice(0, 10); for (let k = 0; k < 4000; k++) { const g = live[zipf(live.length)]; gd.run(g, day, 10, 8, 2400); } }
const pl = db.prepare("INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at, seconds, counted, seen_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)");
for (let i = 0; i < N.plays; i++) { const g = live[zipf(live.length)], t = T - Math.floor(rnd() * 90 * DAY), k = i % 50 === 0 ? 'verify' : 'player'; pl.run('ps_seed' + i, g, i % 10 === 0 ? 'preview' : 'live', k === 'verify' ? 'verify' : 'u_seed' + zipf(N.users), k, t, t + 600000, 600, 1, i < 3000 ? T - 20000 : t + 600000); }
const pg = db.prepare('INSERT OR IGNORE INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds) VALUES (?, ?, ?, ?, 1, 600)');
const sv = db.prepare('INSERT OR IGNORE INTO saves (project_id, user_id, k, v, updated_at) VALUES (?, ?, ?, ?, ?)');
const sc = db.prepare('INSERT OR IGNORE INTO scores (project_id, board, user_id, name, score, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
const ps = db.prepare('INSERT OR IGNORE INTO player_stats (project_id, user_id, name, value, updated_at) VALUES (?, ?, ?, ?, ?)');
const rv = db.prepare('INSERT OR IGNORE INTO reviews (project_id, user_id, rating, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
const blob = 'x'.repeat(2000);
for (let i = 0; i < 600000; i++) { const g = live[zipf(live.length)], uid = 'u_seed' + zipf(N.users); pg.run(g, uid, T - DAY, T - Math.floor(rnd() * 60 * DAY)); if (i % 2 === 0) sv.run(g, uid, 'slot' + (i % 3), blob, T); if (i % 2 === 1) sc.run(g, 'default', uid, 'Seed', Math.floor(rnd() * 1e5), T); if (i % 3 === 0) ps.run(g, uid, 'kills', i, T); if (i % 3 === 1) rv.run(g, uid, 1 + (i % 5), 'fine', T, T); }
const pu = db.prepare("INSERT OR IGNORE INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, provider_ref, payment_intent, status, created_at) VALUES (?, ?, ?, ?, 499, 100, 399, 'stripe', ?, ?, 'paid', ?)");
const le = db.prepare("INSERT INTO ledger (user_id, kind, amount_cents, ref, note, available_at, created_at) VALUES (?, 'sale', 399, ?, 'Sale', ?, ?)");
for (let i = 0; i < 150000; i++) { const g = live[zipf(live.length)], owner = 'u_seed' + (pids.indexOf(g) % N.creators); pu.run('pur_seed' + i, 'u_seed' + (i % N.users), g, owner, 'cs_seed' + i, 'pi_seed' + i, T - i * 60000); le.run(owner, 'pur_seed' + i, T - i * 60000, T - i * 60000); }
const se = db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, ua) VALUES (?, ?, ?, ?, ?)');
for (let i = 0; i < 40000; i++) se.run('sess_seed' + i, 'u_seed' + (i % N.users), T, T + (i % 2 ? 30 : -1) * DAY, 'seed');
const rl = db.prepare('INSERT OR IGNORE INTO rate_limits (k, n, reset_at) VALUES (?, 1, ?)');
for (let i = 0; i < 200000; i++) rl.run('seed:' + i, T - DAY);
db.exec('COMMIT; ANALYZE');
for (const t of ['users', 'projects', 'plays', 'game_daily', 'player_games', 'saves', 'scores', 'reviews', 'purchases', 'ledger']) console.log(t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);

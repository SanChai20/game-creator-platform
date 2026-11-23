// The platform at the size it is built for (scale review, 2026-11). Proves: the hot and the scheduled queries are read
// through indexes on a seeded catalogue (no full scan of plays, saves, scores, reviews or the ledger, the Top sort read
// from its index); the trending job writes only scores that change; the daily cleanup carries on past a statement that
// fails; the guest and verifier cleanup still removes exactly their rows; request bodies are never read past their cap,
// with or without a Content-Length; and the second step of signing in is limited per account, before the code is checked.
// Real migrations, in-memory SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { trendStmt } = await import('../src/rankings.ts');
const { readCapped } = await import('../src/util.ts');
const tf = await import('../src/two-factor.ts');
const { idleGuestCleanupStmts, verifierCleanupStmts } = await import('../src/player-data.js');

function d1() {
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(f, dir), 'utf8'));
  const stmt = (q, args = []) => ({
    q, args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (q) => stmt(q), batch: async (l) => { const out = []; for (const s of l) out.push(await s.run()); return out; }, sql };
}

const T = Date.parse('2026-11-19T12:00:00Z'), DAY = 86400000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** A catalogue big enough that SQLite's planner chooses as it would in production. */
function seed(db, games = 3000) {
  const s = db.sql;
  s.exec('BEGIN');
  const u = s.prepare("INSERT INTO users (id, email, name, pw_hash, created_at, stripe_account) VALUES (?, ?, ?, 'x', 0, ?)");
  for (let i = 0; i < 500; i++) u.run('u' + i, `u${i}@x.io`, 'U' + i, i % 5 ? null : 'acct_' + i);
  const p = s.prepare("INSERT INTO projects (id, owner_id, slug, title, status, plays, rating_sum, rating_count, created_at, updated_at, published_at, recent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0)");
  const d = s.prepare('INSERT INTO game_daily (project_id, day, sessions, plays, seconds) VALUES (?, ?, 1, ?, ?)');
  const pl = s.prepare("INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at, seen_at) VALUES (?, ?, 1, 'live', ?, ?, ?, ?, ?)");
  const rv = s.prepare('INSERT OR IGNORE INTO reviews (project_id, user_id, rating, body, created_at, updated_at) VALUES (?, ?, ?, \'\', ?, ?)');
  const sc = s.prepare("INSERT OR IGNORE INTO scores (project_id, board, user_id, name, score, updated_at) VALUES (?, 'default', ?, 'n', ?, 0)");
  const sv = s.prepare("INSERT OR IGNORE INTO saves (project_id, user_id, k, v, updated_at) VALUES (?, ?, 'slot', '1', ?)");
  const le = s.prepare("INSERT INTO ledger (user_id, kind, amount_cents, ref, available_at, created_at) VALUES (?, 'sale', 100, ?, 0, 0)");
  for (let i = 0; i < games; i++) {
    const id = 'g' + i;
    p.run(id, 'u' + (i % 500), id, 'G' + i, i % 4 === 3 ? 'offline' : 'live', i, (i % 5) * 7, i % 7, T - (i % 90) * DAY);
    if (i % 10 === 0) for (let k = 0; k < 20; k++) d.run(id, dayOf(T - k * DAY), i % 50, i * 3);
  }
  for (let i = 0; i < 20000; i++) {
    const g = 'g' + (i % games), user = 'u' + (i % 500), t = T - (i % 30) * DAY;
    pl.run('ps' + i, g, i % 25 ? user : 'verify', i % 25 ? 'player' : 'verify', t, t, t);
    rv.run(g, user, 1 + (i % 5), t, t);
    sc.run(g, user, i);
    sv.run(g, i % 9 ? user : 'verify:ps' + i, t);
    le.run(user, 'pur' + i);
  }
  s.exec('COMMIT');
}

const plan = (db, q) => db.sql.prepare('EXPLAIN QUERY PLAN ' + q).all().map((r) => r.detail);
const scans = (db, q) => plan(db, q).filter((d) => /^SCAN (plays|saves|scores|reviews|ledger|player_stats|users|sessions|game_daily)\b/.test(d) && !/COVERING INDEX/.test(d));

test('hot and scheduled queries are read through indexes', () => {
  const db = d1(); seed(db);
  const queries = {
    'Top sort': "SELECT p.*, u.name AS author FROM projects p INDEXED BY projects_top JOIN users u ON u.id = p.owner_id WHERE p.status = 'live' ORDER BY (p.rating_sum + 3.5 * 3) * 1.0 / (p.rating_count + 3) DESC, p.rating_count DESC LIMIT 24 OFFSET 0",
    'game page reviews': "SELECT r.rating, r.body, r.created_at, r.updated_at, u.name, r.user_id FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.project_id = 'g1' AND r.hidden = 0 ORDER BY r.updated_at DESC LIMIT 50",
    'rating distribution': "SELECT rating, COUNT(*) AS n FROM reviews WHERE project_id = 'g1' AND hidden = 0 GROUP BY rating",
    'refund ledger check': "SELECT 1 FROM ledger WHERE ref = 'pur1' AND kind = 'refund'",
    'verifier plays cleanup': "DELETE FROM plays WHERE kind = 'verify' AND started_at < 5",
    'account deletion, scores': "DELETE FROM scores WHERE user_id = 'u1'",
    'account deletion, reviews': "DELETE FROM reviews WHERE user_id = 'u1'",
    'account deletion, stats': "DELETE FROM player_stats WHERE user_id = 'u1'",
    'Stripe account event': "SELECT 1 FROM users WHERE stripe_account = 'acct_5'",
    'sign-ins cleanup': 'DELETE FROM sessions WHERE expires_at < 5',
    'license payments': "SELECT plan, expires_at FROM payments WHERE user_id = 'u1' AND kind = 'creator_fee' AND status = 'paid'",
  };
  for (const st of [...verifierCleanupStmts(db, T), ...idleGuestCleanupStmts(db, T)]) queries['cleanup: ' + st.q.slice(0, 40)] = st.q.replaceAll('?', '0');
  queries.trending = trendStmt(db, T).q.replaceAll('?1', `'${dayOf(T)}'`).replaceAll('?2', `'${dayOf(T - 13 * DAY)}'`);
  for (const [name, q] of Object.entries(queries)) assert.deepEqual(scans(db, q), [], `${name} scans a table: ${plan(db, q).join(' | ')}`);
  assert.ok(plan(db, queries['Top sort']).some((d) => /projects_top/.test(d)), 'the Top sort reads its index instead of sorting every game');
  assert.ok(!plan(db, queries['Top sort']).some((d) => /TEMP B-TREE/.test(d)));
  assert.ok(!plan(db, queries['game page reviews']).some((d) => /TEMP B-TREE/.test(d)), 'reviews come in order from the index');
  // the other sorts keep their own indexes (this database has no table statistics, like a D1 database never analysed)
  const L = "SELECT p.*, u.name AS author FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.status = 'live' ORDER BY ";
  for (const order of ['p.recent DESC, p.plays DESC, p.published_at DESC', 'p.published_at DESC', 'p.plays DESC', 'p.playing DESC, p.recent DESC, p.plays DESC']) {
    const pl = plan(db, L + order + ' LIMIT 24');
    assert.ok(!pl.some((d) => /projects_top|TEMP B-TREE FOR ORDER BY/.test(d)), `${order}: ${pl.join(' | ')}`);
  }
  const genres = plan(db, "SELECT tags, cover_key, mature FROM projects WHERE status = 'live' ORDER BY plays DESC LIMIT 5000");
  assert.ok(!genres.some((d) => /TEMP B-TREE FOR ORDER BY/.test(d)), genres.join(' | '));
});

test('trending: the same scores as before, and only scores that change are written', async () => {
  const db = d1(); seed(db);
  // the scores worked out the plain way: every live game (and every game with a score) rewritten each run. Plays count
  // twice plus minutes; these games have too few players for an engagement signal, so its neutral 0.8 applies (src/store-quality.ts)
  const BAYES = '((rating_sum + 10.5) * 1.0 / (rating_count + 3))';
  db.sql.exec('CREATE TABLE ref AS SELECT id, 0 AS recent FROM projects');
  db.sql.prepare(`UPDATE ref SET recent = (SELECT CASE WHEN p.status = 'live' THEN CAST(ROUND(COALESCE((SELECT SUM((d.plays * 2 + d.seconds / 60.0) * 2.0 / (2 + julianday(?1) - julianday(d.day))) FROM game_daily d WHERE d.project_id = p.id AND d.day >= ?2 AND d.day <= ?1), 0) * 0.8 * (0.6 + 0.1 * ${BAYES})) AS INTEGER) ELSE 0 END FROM projects p WHERE p.id = ref.id)`)
    .run(dayOf(T), dayOf(T - 13 * DAY));
  // an offline game that still had a score, and a live one that is no longer played, go back to 0
  db.sql.exec("UPDATE projects SET recent = 77 WHERE id IN ('g3', 'g7')");
  const first = (await trendStmt(db, T).run()).meta.changes;
  const differ = db.sql.prepare('SELECT COUNT(*) AS n FROM projects p JOIN ref r ON r.id = p.id WHERE p.recent != r.recent').get().n;
  assert.equal(differ, 0, 'every score is the one the old job worked out');
  const scored = db.sql.prepare('SELECT COUNT(*) AS n FROM projects WHERE recent != 0').get().n;
  assert.ok(scored > 0 && first <= scored + 2, `wrote ${first} rows, not every live game`);
  assert.equal(db.sql.prepare("SELECT recent FROM projects WHERE id = 'g3'").get().recent, 0, 'an offline game loses its score');
  assert.equal((await trendStmt(db, T).run()).meta.changes, 0, 'nothing changed: nothing written');
  db.sql.prepare("UPDATE game_daily SET plays = plays + 100 WHERE project_id = 'g10' AND day = ?").run(dayOf(T));
  assert.equal((await trendStmt(db, T).run()).meta.changes, 1, 'one game played: one row written');
});

test('the daily cleanup tries every statement and reports the ones that failed', async () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(src, /job\('cleanup', \(\) => eachStmt\(\[/, 'the cleanup runs statement by statement, not as one transaction');
  const { eachStmt } = await import('../src/cleanup.ts');
  const ran = [];
  const ok = (n) => ({ run: async () => { ran.push(n); return { meta: { changes: 1 } }; } });
  const boom = { run: async () => { ran.push('x'); throw new Error('D1 timeout'); } };
  await assert.rejects(eachStmt([ok(1), boom, ok(2)]), /1 of 3 cleanup statements failed: D1 timeout/);
  assert.deepEqual(ran, [1, 'x', 2], 'the statements after the failing one still ran');
  assert.equal(await eachStmt([ok(1), ok(2)]), 2);
});

test('guest and verifier cleanup removes exactly their rows', async () => {
  const db = d1();
  const s = db.sql;
  for (const [u, at] of [['guest_old', T - 200 * DAY], ['guest_new', T - DAY], ['u_real', T - 400 * DAY], ['guestbook', T - 400 * DAY], ['GUEST_x', T - 400 * DAY]]) {
    s.prepare("INSERT INTO player_games (project_id, user_id, first_at, last_at) VALUES ('g1', ?, ?, ?)").run(u, at, at);
    s.prepare("INSERT INTO saves (project_id, user_id, k, v, updated_at) VALUES ('g1', ?, 'k', '1', ?)").run(u, at);
    s.prepare("INSERT INTO scores (project_id, board, user_id, name, score, updated_at) VALUES ('g1', 'b', ?, 'n', 1, ?)").run(u, at);
  }
  for (const [u, at] of [['verify:ps1', T - 3 * DAY], ['verify:ps2', T], ['verifyer', T - 3 * DAY]]) {
    s.prepare("INSERT INTO saves (project_id, user_id, k, v, updated_at) VALUES ('g1', ?, 'k', '1', ?)").run(u, at);
    s.prepare("INSERT INTO player_stats (project_id, user_id, name, value, updated_at) VALUES ('g1', ?, 'n', 1, ?)").run(u, at);
  }
  for (const st of idleGuestCleanupStmts(db, T - 180 * DAY)) await st.run();
  for (const st of verifierCleanupStmts(db, T - DAY)) await st.run();
  const users = (tb) => s.prepare(`SELECT user_id FROM ${tb} ORDER BY user_id`).all().map((r) => r.user_id);
  assert.deepEqual(users('player_games'), ['GUEST_x', 'guest_new', 'guestbook', 'u_real']);
  assert.deepEqual(users('scores'), ['GUEST_x', 'guest_new', 'guestbook', 'u_real']);
  assert.deepEqual(users('saves'), ['GUEST_x', 'guest_new', 'guestbook', 'u_real', 'verify:ps2', 'verifyer']);
  assert.deepEqual(users('player_stats'), ['verify:ps2', 'verifyer']);
});

/** A request whose body arrives in chunks without a Content-Length, as curl sends a piped upload. */
function chunked(sizes, headers = {}) {
  let i = 0, pulled = 0;
  const body = new ReadableStream({ pull(ctl) { if (i >= sizes.length) return ctl.close(); pulled += sizes[i]; ctl.enqueue(new Uint8Array(sizes[i++]).fill(7)); } });
  const req = new Request('https://x.test/', { method: 'POST', body, headers, duplex: 'half' });
  return { req, pulled: () => pulled };
}

test('request bodies are never read past their cap', async () => {
  const small = await readCapped(new Request('https://x.test/', { method: 'POST', body: 'hello' }), 10);
  assert.equal(new TextDecoder().decode(small), 'hello');
  assert.equal((await readCapped(new Request('https://x.test/'), 10)).byteLength, 0, 'no body');
  assert.equal(await readCapped(new Request('https://x.test/', { method: 'POST', body: 'x'.repeat(11) }), 10), null);
  // declared too large: refused before reading
  const declared = chunked([1000, 1000], { 'content-length': '5000000' });
  assert.equal(await readCapped(declared.req, 1_000_000), null);
  assert.equal(declared.pulled() <= 1000, true, 'nothing beyond the first chunk was pulled');
  // no Content-Length: read until it passes the cap, then stopped
  const sneaky = chunked(Array(1000).fill(64 * 1024));
  assert.equal(await readCapped(sneaky.req, 1024 * 1024), null);
  assert.ok(sneaky.pulled() < 1.2 * 1024 * 1024, `stopped after ${sneaky.pulled()} bytes, not 64 MB`);
  const exact = await readCapped(chunked([512, 512]).req, 1024);
  assert.equal(exact.byteLength, 1024);
  assert.ok(exact.every((b) => b === 7));
});

test('the runtime, upload and feedback routes read bodies through the cap', () => {
  const rt = readFileSync(new URL('../src/routes/rt.ts', import.meta.url), 'utf8');
  const up = readFileSync(new URL('../src/routes/upload.ts', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../src/routes/api.ts', import.meta.url), 'utf8');
  assert.match(rt, /readCapped\(c\.req\.raw, RT_BODY_MAX\)/);
  assert.doesNotMatch(rt, /c\.req\.text\(\)/, 'no runtime call reads its whole body unchecked');
  assert.doesNotMatch(up, /arrayBuffer\(\)/, 'no upload reads its whole body unchecked');
  assert.match(api, /readCapped\(c\.req\.raw, FEEDBACK_BODY_MAX\)/);
});

test('sign-in codes are limited per account, before the code is checked', async () => {
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(f, dir), 'utf8'));
  const stmt = (q, args = []) => ({ bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...args).changes) } }) });
  const e = { DB: { prepare: (q) => stmt(q), batch: async (l) => { for (const s of l) await s.run(); } }, SESSION_SECRET: 'test-secret-that-is-long-enough' };
  sql.exec("INSERT INTO users (id, email, name, pw_hash, created_at) VALUES ('u1', 'a@x.io', 'Ann', 'h', 0)");
  const at = 1_800_000_000_000;
  const s = await tf.beginSetup(e, { id: 'u1', email: 'a@x.io' }, 'HearthCade', at);
  const secret = tf.unbase32(s.secret);
  assert.ok(await tf.confirmSetup(e, 'u1', await tf.totpAt(secret, tf.stepOf(at)), at));
  const later = at + 60_000, good = await tf.totpAt(secret, tf.stepOf(later));
  // the per-account check runs with the account the challenge belongs to; when it refuses, the code is not used up
  const seen = [];
  const ch = await tf.startChallenge(e, 'u1', later);
  await assert.rejects(tf.answerChallenge(e, ch, good, later, async (id) => { seen.push(id); throw new Error('limited'); }), /limited/);
  assert.deepEqual(seen, ['u1']);
  assert.deepEqual(await tf.answerChallenge(e, ch, good, later, async () => {}), { ok: true, userId: 'u1', kind: 'totp' }, 'the code still works once the limit allows it');
  const api = readFileSync(new URL('../src/routes/api.ts', import.meta.url), 'utf8');
  assert.match(api, /rateLimit\(c\.env, '2falogin:' \+ userId, TWO_FACTOR_CODES_PER_15_MIN, 900\)/);
  assert.match(api, /rateLimit\(c\.env, '2falogind:' \+ userId, TWO_FACTOR_CODES_PER_DAY, 86400\)/);
});

test('public catalogue reads are answered from the edge cache', () => {
  const api = readFileSync(new URL('../src/routes/api.ts', import.meta.url), 'utf8');
  for (const route of ["api.get('/games', (c) => edgeCached(c, 30,", "api.get('/categories/:tag', (c) => edgeCached(c, 30,", "api.get('/categories', (c) => edgeCached(c, 60,", "api.get('/home', (c) => edgeCached(c, 20,"])
    assert.ok(api.includes(route), route);
  // nothing in a catalogue answer depends on who asks
  const list = api.slice(api.indexOf('async function listGames'), api.indexOf('function genreCounts'));
  assert.doesNotMatch(list, /c\.get\('user'\)|requireUser/);
});

test('the Free shelf: the boosted order, merged from two index-ordered lists, is the same as sorting every free game', async () => {
  const { freeTrendingOrder, freeTrendingQuery, freeTrendingArgs } = await import('../src/catalog.ts');
  const db = d1(), s = db.sql;
  s.exec("INSERT INTO users (id, email, name, pw_hash, created_at) VALUES ('u1', 'a@x', 'A', 'x', 0)");
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const ins = s.prepare("INSERT INTO projects (id, owner_id, slug, title, status, price_cents, open_implementation, rating_sum, rating_count, recent, plays, created_at, updated_at, published_at) VALUES (?, 'u1', ?, 'G', ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)");
  for (let i = 0; i < 1500; i++) {
    const rc = Math.floor(rnd() * 10);
    // distinct keys, so the two orders can be compared game by game
    ins.run('f' + i, 'f' + i, i % 9 ? 'live' : 'offline', i % 5 ? 0 : 499, rnd() < 0.3 ? 1 : 0, Math.round(rc * (1 + rnd() * 4)), rc, Math.floor(rnd() * 5000) * 1500 + i, Math.floor(rnd() * 1000), i);
  }
  const w = "p.status = 'live' AND p.price_cents = 0";
  for (const boost of [1, 50, 100]) for (const [limit, offset] of [[12, 0], [60, 0], [24, 24], [24, 700], [24, 5000]]) {
    const want = s.prepare(`SELECT p.id FROM projects p JOIN users u ON u.id = p.owner_id WHERE ${w} ORDER BY ${freeTrendingOrder(boost)} LIMIT ? OFFSET ?`).all(limit, offset).map((r) => r.id);
    const got = s.prepare(freeTrendingQuery(boost, 'p.*, u.name AS author', 'projects p JOIN users u ON u.id = p.owner_id', w)).all(...freeTrendingArgs([], limit, offset)).map((r) => r.id);
    assert.deepEqual(got, want, `boost ${boost}, ${limit} from ${offset}`);
  }
  assert.equal(freeTrendingQuery(0, 'p.*', 'projects p', w), null, 'no boost: the plain indexed order is used');
  const pl = plan(db, freeTrendingQuery(50, 'p.*, u.name AS author', 'projects p JOIN users u ON u.id = p.owner_id', w).replaceAll('?', '10'));
  assert.ok(!pl.some((d) => /SCAN p\b/.test(d)), pl.join(' | '));
});

test('verification waits for a browser when the platform is at its browser limit, and only then', async () => {
  const { launchWithRetry, isBrowserLimit } = await import('../src/browser-limit.ts');
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  let n = 0;
  const busy = async () => { if (++n < 3) throw new Error('Unable to create new browser: code: 429: message: Browser time limit exceeded for today'); return 'browser'; };
  assert.equal(await launchWithRetry(busy, [10, 20, 30], sleep), 'browser');
  assert.equal(waits.length, 2, 'two refusals, two waits');
  n = 0; waits.length = 0;
  await assert.rejects(launchWithRetry(async () => { n++; throw new Error('429 Too Many Requests'); }, [10, 20], sleep), /429/);
  assert.equal(n, 3, 'gives up after the last wait');
  n = 0;
  await assert.rejects(launchWithRetry(async () => { n++; throw new Error('Bad gateway'); }, [10, 20], sleep), /Bad gateway/);
  assert.equal(n, 1, 'other errors are not retried');
  assert.ok(isBrowserLimit(new Error('Rate limit exceeded')) && !isBrowserLimit(new Error('net::ERR_NAME_NOT_RESOLVED')));
});

test('the Top sort still works before migration 0030 has run', () => {
  const api = readFileSync(new URL('../src/routes/api.ts', import.meta.url), 'utf8');
  assert.match(api, /q\(' INDEXED BY projects_top'\)/);
  assert.match(api, /no such index\|no query solution/);
  const db = d1();
  db.sql.exec('DROP INDEX projects_top');
  assert.throws(() => db.sql.prepare("SELECT p.id FROM projects p INDEXED BY projects_top WHERE p.status = 'live'").all(), /no such index/, 'the error the fallback looks for');
});

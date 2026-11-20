// Binding game sessions to the platform identity that started them, and moving guest progress into an account.
// Proves: a session stops when its sign-in ends (sign-out, switching accounts, expiry, suspension); a token never works
// for someone else's session; guest progress reaches one account at most, only when asked, and never overwrites the
// account's own; and the game Worker never opens a page from a stale cookie token. Real migrations, in-memory SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handle, signPlayToken, WORKER_HELPER } from '../src/runtime/game-worker.js';
import { saveOp, statOp, scopeOf } from '../src/player-data.js';
import { bindingProblem, claimGuest, claimedGuestCleanupStmts, guestProgress } from '../src/session-binding.js';

function d1() {
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(f, dir), 'utf8'));
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  // D1 runs a batch as one transaction
  const batch = async (list) => { sql.exec('BEGIN'); try { const out = []; for (const s of list) out.push(await s.run()); sql.exec('COMMIT'); return out; } catch (e) { sql.exec('ROLLBACK'); throw e; } };
  return { prepare: (q) => stmt(q), batch, sql };
}

const T = 1_800_000_000_000, DAY = 86400000;
const login = (db, id, user, expires = T + 30 * DAY) => db.sql.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(id, user, T, expires);
const play = (db, sid, user, { game = 'gamea1', loginId = null, kind = 'player', env = 'live' } = {}) =>
  db.sql.prepare('INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at, login_id) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)').run(sid, game, env, user, kind, T, T, loginId);
const tok = (u, s, k = 'player') => ({ g: 'gamea1', e: 'live', u, n: u, k, s, x: T / 1000 + 3600 });
const game = (db, id, slug) => db.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, created_at, updated_at) VALUES (?, 'u_owner', ?, ?, 'live', 0, 0)").run(id, slug, slug.toUpperCase());

test('an account session works while its sign-in lasts and stops when the browser signs out', async () => {
  const db = d1();
  login(db, 'login_a', 'u_alice'); play(db, 'ps_1', 'u_alice', { loginId: 'login_a' });
  assert.equal(await bindingProblem(db, tok('u_alice', 'ps_1'), T), null);
  db.sql.prepare("DELETE FROM sessions WHERE id = 'login_a'").run();   // POST /auth/logout, or signing in again here
  const p = await bindingProblem(db, tok('u_alice', 'ps_1'), T);
  assert.equal(p.code, 'session_ended'); assert.equal(p.reason, 'signed_out');
});

test('switching accounts in one browser ends the first account’s game in every tab', async () => {
  const db = d1();
  login(db, 'login_a', 'u_alice'); play(db, 'ps_tab1', 'u_alice', { loginId: 'login_a' }); play(db, 'ps_tab2', 'u_alice', { loginId: 'login_a' });
  // Bob signs in on the same computer: the browser's earlier sign-in is ended (endPreviousLogin) and Bob gets his own.
  db.sql.prepare("DELETE FROM sessions WHERE id = 'login_a'").run(); login(db, 'login_b', 'u_bob'); play(db, 'ps_bob', 'u_bob', { loginId: 'login_b' });
  assert.equal((await bindingProblem(db, tok('u_alice', 'ps_tab1'), T)).reason, 'signed_out');
  assert.equal((await bindingProblem(db, tok('u_alice', 'ps_tab2'), T)).reason, 'signed_out');
  assert.equal(await bindingProblem(db, tok('u_bob', 'ps_bob'), T), null);
});

test('an expired sign-in, or a sign-in row of another account, does not keep a session alive', async () => {
  const db = d1();
  login(db, 'login_old', 'u_alice', T - 1); play(db, 'ps_1', 'u_alice', { loginId: 'login_old' });
  assert.equal((await bindingProblem(db, tok('u_alice', 'ps_1'), T)).reason, 'signed_out');
  login(db, 'login_b', 'u_bob'); play(db, 'ps_2', 'u_alice', { loginId: 'login_b' });   // never happens, but must not pass
  assert.equal((await bindingProblem(db, tok('u_alice', 'ps_2'), T)).reason, 'signed_out');
});

test('a token only works for the session it names, and only for that session’s player', async () => {
  const db = d1();
  login(db, 'login_b', 'u_bob'); play(db, 'ps_bob', 'u_bob', { loginId: 'login_b' });
  assert.equal((await bindingProblem(db, tok('u_alice', 'ps_bob'), T)).reason, 'unknown', 'a token for alice naming bob’s session');
  assert.equal((await bindingProblem(db, tok('u_alice', 'ps_missing'), T)).reason, 'unknown');
  assert.equal((await bindingProblem(db, tok('guest_aaaaaaaaaaaaaa', 'ps_bob'), T)).reason, 'unknown');
});

test('suspending an account ends its games (its sign-ins are deleted)', async () => {
  const db = d1();
  login(db, 'login_a', 'u_alice'); login(db, 'login_a2', 'u_alice'); play(db, 'ps_1', 'u_alice', { loginId: 'login_a' }); play(db, 'ps_2', 'u_alice', { loginId: 'login_a2' });
  db.sql.prepare("DELETE FROM sessions WHERE user_id = 'u_alice'").run();   // admin: status suspended
  for (const s of ['ps_1', 'ps_2']) assert.equal((await bindingProblem(db, tok('u_alice', s), T)).reason, 'signed_out');
});

test('older sessions without a recorded sign-in and the verifier keep working until their token runs out', async () => {
  const db = d1();
  play(db, 'ps_old', 'u_alice');
  assert.equal(await bindingProblem(db, tok('u_alice', 'ps_old'), T), null);
  play(db, 'ps_v', 'u_owner', { kind: 'verify' });
  assert.equal(await bindingProblem(db, tok('verify:ps_v', 'ps_v', 'verify'), T), null);
});

test('a token cannot claim to be the verifier, or name another game\'s session, to skip the binding', async () => {
  const db = d1();
  login(db, 'login_a', 'u_alice'); play(db, 'ps_1', 'u_alice', { loginId: 'login_a' });
  db.sql.prepare("DELETE FROM sessions WHERE id = 'login_a'").run();
  // a token signed with a leaked play key that says "verify" for a player's session, or for a session that does not exist
  assert.equal((await bindingProblem(db, tok('u_alice', 'ps_1', 'verify'), T))?.code, 'session_ended');
  assert.equal((await bindingProblem(db, tok('verify:ps_1', 'ps_1', 'verify'), T))?.code, 'session_ended');
  assert.equal((await bindingProblem(db, tok('verify:nope', 'nope', 'verify'), T))?.code, 'session_ended');
  // a verifier session used with a player token
  play(db, 'ps_v', 'u_owner', { kind: 'verify' });
  assert.equal((await bindingProblem(db, tok('u_owner', 'ps_v'), T))?.code, 'session_ended');
  // another game's session
  play(db, 'ps_b', 'u_bob', { game: 'gameb2' });
  assert.equal((await bindingProblem(db, tok('u_bob', 'ps_b'), T))?.code, 'session_ended');
});

// ---- guests ---------------------------------------------------------------------------------------
const G = 'guest_abcdefghijklmnop';
const auth = (u, s, g = 'gamea1') => ({ g, e: 'live', u, n: u, k: 'player', s, x: T / 1000 + 3600 });

async function guestPlayed(db) {
  game(db, 'gamea1', 'alpha'); game(db, 'gameb2', 'beta');
  play(db, 'ps_g1', G); play(db, 'ps_g2', G, { game: 'gameb2' });
  await saveOp(db, auth(G, 'ps_g1'), { op: 'set', key: 'slot', value: { level: 9 } });
  await statOp(db, auth(G, 'ps_g1'), { op: 'add', name: 'coins', value: 40 });
  await saveOp(db, auth(G, 'ps_g2', 'gameb2'), { op: 'set', key: 'slot', value: { level: 3 } });
  db.sql.prepare("INSERT INTO scores (project_id, board, user_id, name, score, updated_at) VALUES ('gamea1', 'default', ?, 'Guest', 500, ?)").run(G, T);
  db.sql.prepare("INSERT INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds, last_version) VALUES ('gamea1', ?, ?, ?, 2, 600, 1)").run(G, T - DAY, T);
}

test('a guest session works until the guest id is claimed, then stops', async () => {
  const db = d1(); await guestPlayed(db);
  assert.equal(await bindingProblem(db, tok(G, 'ps_g1'), T), null);
  await claimGuest(db, G, 'u_alice', 'Alice', { t: T });
  const p = await bindingProblem(db, tok(G, 'ps_g1'), T);
  assert.equal(p.code, 'session_ended'); assert.equal(p.reason, 'signed_in');
});

test('moving guest progress into a new account brings saves, stats, scores, play time and plays along', async () => {
  const db = d1(); await guestPlayed(db);
  const offer = await guestProgress(db, G, 'u_alice');
  assert.deepEqual(offer.map((g) => [g.slug, g.kept]).sort(), [['alpha', false], ['beta', false]]);
  const r = await claimGuest(db, G, 'u_alice', 'Alice', { t: T });
  assert.equal(r.moved, 2); assert.equal(r.kept, 0);
  const alice = auth('u_alice', 'ps_x');
  assert.deepEqual((await saveOp(db, alice, { op: 'get', key: 'slot' })).value, { level: 9 });
  assert.deepEqual((await statOp(db, alice, { op: 'all' })).stats, { coins: 40 });
  assert.deepEqual((await saveOp(db, auth('u_alice', 'ps_y', 'gameb2'), { op: 'get', key: 'slot' })).value, { level: 3 });
  assert.deepEqual(db.sql.prepare("SELECT user_id, name, score FROM scores").all().map((x) => ({ ...x })), [{ user_id: 'u_alice', name: 'Alice', score: 500 }]);
  assert.equal(db.sql.prepare("SELECT seconds FROM player_games WHERE user_id = 'u_alice' AND project_id = 'gamea1'").get().seconds, 600);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM plays WHERE user_id = 'u_alice'").get().n, 2);
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM saves WHERE user_id = ?').get(G).n, 0, 'nothing left under the guest id');
});

test('an account’s own progress is never overwritten or mixed with a guest’s', async () => {
  const db = d1(); await guestPlayed(db);
  const alice = auth('u_alice', 'ps_a');
  await saveOp(db, alice, { op: 'set', key: 'slot', value: { level: 50 } });   // alice already plays alpha
  db.sql.prepare("INSERT INTO scores (project_id, board, user_id, name, score, updated_at) VALUES ('gamea1', 'default', 'u_alice', 'Alice', 20, ?)").run(T);
  db.sql.prepare("INSERT INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds, last_version) VALUES ('gamea1', 'u_alice', ?, ?, 5, 3000, 1)").run(T - 9 * DAY, T - DAY);
  const offer = await guestProgress(db, G, 'u_alice');
  assert.equal(offer.find((g) => g.slug === 'alpha').kept, true);
  const r = await claimGuest(db, G, 'u_alice', 'Alice', { t: T });
  assert.equal(r.moved, 1); assert.equal(r.kept, 1);
  assert.deepEqual((await saveOp(db, alice, { op: 'get', key: 'slot' })).value, { level: 50 }, 'the account’s save stays');
  assert.deepEqual((await statOp(db, alice, { op: 'all' })).stats, {}, 'the guest’s stats in that game are not mixed in');
  assert.equal(db.sql.prepare("SELECT score FROM scores WHERE user_id = 'u_alice'").get().score, 20, 'the account’s score on a board stays');
  const pg = db.sql.prepare("SELECT sessions, seconds, first_at, last_at FROM player_games WHERE user_id = 'u_alice' AND project_id = 'gamea1'").get();
  assert.deepEqual({ ...pg }, { sessions: 7, seconds: 3600, first_at: T - 9 * DAY, last_at: T }, 'play time adds up');
  assert.deepEqual((await saveOp(db, auth('u_alice', 'ps_b', 'gameb2'), { op: 'get', key: 'slot' })).value, { level: 3 }, 'a game the account never played moves');
});

test('guest progress reaches one account at most: a second claim, from any account or tab, does nothing', async () => {
  const db = d1(); await guestPlayed(db);
  const [a, b] = await Promise.all([claimGuest(db, G, 'u_alice', 'Alice', { t: T }), claimGuest(db, G, 'u_bob', 'Bob', { t: T })]);
  assert.equal([a, b].filter(Boolean).length, 1, 'exactly one claim wins');
  assert.equal(await claimGuest(db, G, 'u_carol', 'Carol', { t: T }), null);
  assert.deepEqual(await guestProgress(db, G, 'u_carol'), [], 'a claimed guest id is offered to nobody');
  const winner = a ? 'u_alice' : 'u_bob', loser = a ? 'u_bob' : 'u_alice';
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM saves WHERE user_id = ?').get(loser).n, 0);
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM saves WHERE user_id = ?').get(winner).n, 2);
});

test('“It is not mine” moves nothing and retires the guest id for good', async () => {
  const db = d1(); await guestPlayed(db);
  const r = await claimGuest(db, G, 'u_bob', 'Bob', { move: false, t: T });
  assert.equal(r.moved, 0);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM saves WHERE user_id = 'u_bob'").get().n, 0);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM plays WHERE user_id = 'u_bob'").get().n, 0);
  assert.equal(await claimGuest(db, G, 'u_alice', 'Alice', { t: T }), null);
  // what was left behind is cleaned up after 30 days
  await db.batch(claimedGuestCleanupStmts(db, T + 31 * DAY));
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM saves WHERE user_id = ?').get(G).n, 0);
});

test('only guest ids can be claimed, only by accounts; preview data is never offered', async () => {
  const db = d1(); await guestPlayed(db);
  assert.equal(await claimGuest(db, 'u_alice', 'u_bob', 'Bob', { t: T }), null);
  assert.equal(await claimGuest(db, G, 'guest_zzzzzzzzzzzzzz', 'x', { t: T }), null);
  await saveOp(db, { ...auth(G, 'ps_p'), e: 'preview' }, { op: 'set', key: 'x', value: 1 });
  assert.ok(!(await guestProgress(db, G, 'u_alice')).some((g) => g.game === scopeOf('gamea1', 'preview')));
});

// ---- the game Worker ---------------------------------------------------------------------------------
const KEY = 'k', env = { PREFIX: 'v/', GAME_ID: 'gamea1', SLUG: 'alpha', TITLE: 'Alpha', VERSION: '1', ENV: 'live', PLAY_KEY: KEY, PLATFORM: 'https://platform.example', MANIFEST: '{}', FILES: { get: async () => ({ text: async () => '<!doctype html><html><head></head><body>game</body></html>' }) } };
const now = () => Math.floor(Date.now() / 1000);
const sign = (u, s, x = now() + 3600) => signPlayToken({ g: 'gamea1', e: 'live', u, n: u, k: 'player', s, x }, KEY);
async function withPlatform(answer, fn) {
  // the runtime calls the platform with the fetch it captured at start-up, not globalThis.fetch; tests hand theirs in through env
  const calls = [];
  env.__testFetch = async (url, init) => { calls.push({ url: String(url), body: init?.body }); return answer(); };
  try { return await fn(calls); } finally { delete env.__testFetch; }
}

test('a launch token from the address bar opens the game without asking the platform', async () => {
  const t = await sign('u_alice', 'ps_1');
  await withPlatform(() => new Response('{}', { status: 500 }), async (calls) => {
    const r = await handle(new Request(`https://g.example/?gcp_t=${t}&gcp_autostart=1`), env, {});
    assert.equal(r.status, 302); assert.equal(calls.length, 0);
    assert.equal(r.headers.get('location'), `/~t/${t}/?gcp_autostart=1`, 'on to the address that carries the token, other parameters kept');
    assert.match(r.headers.get('set-cookie'), /Max-Age=3[56]\d\d;/, 'the cookie lasts as long as the token, not longer');
  });
});

// Safari (iPhone, iPad, Mac) refuses the cookie of a game framed by the platform's page on another site, so the token
// travels in the path and every relative address the page resolves carries it.
test('a game opens and loads its files from the token in the path, with no cookie at all', async () => {
  const t = await sign('u_alice', 'ps_1');
  const files = { FILES: { get: async (k) => k.endsWith('.html') ? { text: async () => '<!doctype html><html><head></head><body>game</body></html>' } : { body: 'export {}', size: 9, httpEtag: '"e"', httpMetadata: {} } } };
  await withPlatform(() => Response.json({ ok: true }), async (calls) => {
    const page = await handle(new Request(`https://g.example/~t/${t}/`), { ...env, ...files }, {});
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, new RegExp('"base":"/~t/' + t.replace(/[.]/g, '\\.') + '"'), 'the SDK reaches /__gcp/ and /api/ through the same path');
    assert.equal(calls.length, 1, 'a page opened from a kept address still asks whether the player is still signed in');
    const js = await handle(new Request(`https://g.example/~t/${t}/src/main.js`), { ...env, ...files }, {});
    assert.equal(js.status, 200); assert.equal(await js.text(), 'export {}');
  });
  assert.equal((await handle(new Request('https://g.example/src/main.js'), { ...env, ...files }, {})).status, 401, 'no token anywhere: refused');
  const other = await signPlayToken({ g: 'gameb2', e: 'live', u: 'u_alice', n: 'a', k: 'player', s: 'ps_1', x: now() + 3600 }, KEY);
  assert.equal((await handle(new Request(`https://g.example/~t/${other}/src/main.js`), { ...env, ...files }, {})).status, 401, "another game's token");
  assert.equal((await handle(new Request(`https://g.example/~t/${t.slice(0, -2)}xx/src/main.js`), { ...env, ...files }, {})).status, 401, 'a forged token');
  // the token in the path ran out, a renewed one is in the cookie: the cookie is used
  const old = await sign('u_alice', 'ps_1', now() - 10), fresh = await sign('u_alice', 'ps_1');
  assert.equal((await handle(new Request(`https://g.example/~t/${old}/src/main.js`), { ...env, ...files }, {})).status, 401);
  assert.equal((await handle(new Request(`https://g.example/~t/${old}/src/main.js`, { headers: { cookie: `__Host-gcp_t=${fresh}` } }), { ...env, ...files }, {})).status, 200);
});

// An iPad cannot share a tab, so a preview's feedback picture is drawn by the game's page, which cannot read a canvas a
// Web Worker draws: a preview's worker scripts come with a helper that copies those canvases when the SDK asks
test('a preview game’s worker scripts come with the capture helper; its page scripts and live games do not', async () => {
  const files = { FILES: { get: async (k) => k.endsWith('.html') ? { text: async () => '<html></html>' } : { body: 'self.x=1', size: 8, httpEtag: '"e"', httpMetadata: {}, text: async () => 'self.x=1' } } };
  const pv = { ...env, ...files, ENV: 'preview' };
  const pt = await signPlayToken({ g: 'gamea1', e: 'preview', u: 'u_alice', n: 'a', k: 'owner', s: 'ps_1', x: now() + 3600 }, KEY);
  await withPlatform(() => Response.json({ ok: true }), async () => {
    const asWorker = { headers: { 'sec-fetch-dest': 'worker' } };
    const w = await handle(new Request(`https://g.example/~t/${pt}/src/render.js`, asWorker), pv, {});
    assert.equal(w.status, 200); assert.equal(await w.text(), 'self.x=1' + WORKER_HELPER);
    assert.match(w.headers.get('vary'), /sec-fetch-dest/, 'a cache keeps the two versions apart');
    assert.match(w.headers.get('content-type'), /javascript/); assert.equal(w.headers.get('cache-control'), 'no-store');
    const plain = await handle(new Request(`https://g.example/~t/${pt}/src/render.js`, { headers: { 'sec-fetch-dest': 'script' } }), pv, {});
    assert.equal(await plain.text(), 'self.x=1', 'the same file loaded by the page is as written');
    const live = await handle(new Request(`https://g.example/~t/${await sign('u_alice', 'ps_1')}/src/render.js`, asWorker), { ...env, ...files }, {});
    assert.equal(await live.text(), 'self.x=1', 'a live game is served as written');
  });
  // the helper is plain old JavaScript that runs in any worker, module or classic, and only answers the SDK
  assert.doesNotThrow(() => new Function(WORKER_HELPER));
  assert.match(WORKER_HELPER, /__gcpw/);
});

test('a page reopened from a cookie token after signing out shows the gate, not the previous player', async () => {
  const t = await sign('u_alice', 'ps_1');
  await withPlatform(() => Response.json({ error: 'ended', code: 'session_ended' }, { status: 401 }), async (calls) => {
    const r = await handle(new Request('https://g.example/', { headers: { cookie: `__Host-gcp_t=${t}` } }), env, {});
    assert.equal(r.status, 401);
    const html = await r.text();
    assert.ok(!html.includes('u_alice'), 'nothing of the previous player on the page');
    assert.match(html, /session_ended/); assert.match(html, /\/g\/alpha\?play=1/);
    assert.equal(calls[0].url, 'https://platform.example/api/rt/check');
  });
  await withPlatform(() => Response.json({ ok: true }), async () => {
    assert.equal((await handle(new Request('https://g.example/', { headers: { cookie: `__Host-gcp_t=${t}` } }), env, {})).status, 200);
  });
  // the platform cannot be reached: served (every service call is still checked there)
  await withPlatform(() => { throw new Error('network'); }, async () => {
    assert.equal((await handle(new Request('https://g.example/', { headers: { cookie: `__Host-gcp_t=${t}` } }), env, {})).status, 200);
  });
});

test('a renewed token replaces the cookie only for the same player and session', async () => {
  const cur = await sign('u_alice', 'ps_1'), next = await sign('u_alice', 'ps_1', now() + 7200);
  const post = (body) => handle(new Request('https://g.example/__gcp/token', { method: 'POST', body, headers: { cookie: `__Host-gcp_t=${cur}` } }), env, {});
  const ok = await post(next);
  assert.equal(ok.status, 200); assert.match(ok.headers.get('set-cookie'), new RegExp('gcp_t=' + next.replace(/[.]/g, '\\.')));
  assert.equal((await post(await sign('u_bob', 'ps_1', now() + 7200))).status, 400, 'another player');
  assert.equal((await post(await sign('u_alice', 'ps_2', now() + 7200))).status, 400, 'another session');
  assert.equal((await post('forged.token')).status, 400);
  const noCookie = await handle(new Request('https://g.example/__gcp/token', { method: 'POST', body: next }), env, {});
  assert.equal(noCookie.status, 400, 'nothing to renew without a current token');
});

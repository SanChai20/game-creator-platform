// Player-made levels (src/levels.js): who may publish to which games, the limits and content rules, the shelf and its
// sorts, plays counted once, ratings only after playing, hiding by the creator and by reports, deleting, account
// deletion; and the SDK's GCP.levels against a fake network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { deleteStatements, get, levelsOpen, LIMITS, list, publish, rate, recordPlay, remove, report, reported, setHidden, setLevelsOff, supportsLevels, textProblem } from '../src/levels.js';

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
  return { prepare: (q) => stmt(q), batch: async (l) => { const out = []; for (const s of l) out.push(await s.run()); return out; }, sql };
}
function world() {
  const db = d1(), q = (s, ...a) => db.sql.prepare(s).run(...a);
  for (const u of ['u_a', 'u_b', 'u_c', 'u_d', 'u_e', 'u_f']) q("INSERT INTO users (id, email, name, pw_hash, status, created_at) VALUES (?, ?, ?, '', 'active', 1)", u, u + '@x', 'Name ' + u);
  q("INSERT INTO projects (id, owner_id, slug, title, status, live_version, price_cents, created_at, updated_at) VALUES ('g1', 'u_c', 'g1', 'Game', 'live', 1, 0, 1, 1)");
  return { db, q };
}
const code = (e) => (err) => err.code === e;
const G = { id: 'g1', open: true, age: null, version: 1 };
const A = { id: 'u_a', kind: 'player' };

test('what counts as a game that takes levels', () => {
  assert.equal(supportsLevels('{"levels":true}'), true);
  assert.equal(supportsLevels({}), false);
  assert.equal(supportsLevels('not json'), false);
  const p = { status: 'live', hidden_at: null, levels_off: 0 };
  assert.equal(levelsOpen(p, { levels: true }), true);
  assert.equal(levelsOpen({ ...p, levels_off: 1 }, { levels: true }), false);
  assert.equal(levelsOpen({ ...p, status: 'draft' }, { levels: true }), false);
  assert.equal(levelsOpen(p, { levels: false }), false);
});

test('only signed-in players publish, to games that take levels, within the limits and rules', async () => {
  const { db } = world();
  await assert.rejects(publish(db, { id: 'guest_x' }, G, 'live', { title: 'Hello', data: {} }), code('guest'));
  await assert.rejects(publish(db, { id: 'u_a', kind: 'verify' }, G, 'live', { title: 'Hello', data: {} }), code('verify'));
  await assert.rejects(publish(db, A, { ...G, open: false }, 'live', { title: 'Hello', data: {} }), code('levels_off'));
  await assert.rejects(publish(db, A, G, 'live', { title: 'Hi', data: {} }), code('bad_title'));
  await assert.rejects(publish(db, A, G, 'live', { title: 'Hello' }), code('no_data'));
  await assert.rejects(publish(db, A, G, 'live', { title: 'Hello', data: 'x'.repeat(LIMITS.bytes) }), code('too_big'));
  await assert.rejects(publish(db, A, G, 'live', { title: 'Visit www.spam-site.com now', data: {} }), code('not_allowed'));
  await assert.rejects(publish(db, A, G, 'live', { title: 'Free stuff', description: 'go to https://x.example', data: {} }), code('not_allowed'));
  await assert.rejects(publish(db, A, G, 'live', { title: 'Double your bitcoin', description: 'send 1 btc and get 2 back', data: {} }), code('not_allowed'));
  assert.equal(textProblem('Hentai cave', ''), 'That title or description is not allowed here.');
  assert.equal(textProblem('Hentai cave', '', true), null, 'an adults-only game may say what it declares');
  const r = await publish(db, A, G, 'live', { title: '  Lava   run ', description: 'Hard one', data: { v: 1, tiles: [1, 2, 3] } }, 1000);
  assert.match(r.id, /^lvl_[a-z0-9]{6,}$/);
  const l = await get(db, r.id, { withData: true });
  assert.equal(l.title, 'Lava run'); assert.deepEqual(l.data, { v: 1, tiles: [1, 2, 3] }); assert.equal(l.game_version, 1);
  // a new version of one's own level, never someone else's
  await assert.rejects(publish(db, { id: 'u_b' }, G, 'live', { id: r.id, title: 'Mine now', data: {} }), code('forbidden'));
  assert.deepEqual(await publish(db, A, G, 'live', { id: r.id, title: 'Lava run 2', data: { v: 2 } }, 2000), { id: r.id, updated: true });
  assert.deepEqual((await get(db, r.id, { withData: true })).data, { v: 2 });
  // daily cap
  for (let i = 0; i < LIMITS.per_day - 1; i++) await publish(db, A, G, 'live', { title: 'Level ' + i, data: {} }, 3000 + i);
  await assert.rejects(publish(db, A, G, 'live', { title: 'One more', data: {} }, 5000), code('rate_limited'));
  // per-game cap, on later days
  for (let i = 0; i < LIMITS.per_game - LIMITS.per_day; i++) await publish(db, A, G, 'live', { title: 'Later ' + i, data: {} }, 86400000 * (2 + Math.floor(i / 10)) + i);
  await assert.rejects(publish(db, A, G, 'live', { title: 'Too many', data: {} }, 86400000 * 30), code('too_many'));
});

test('the shelf: sorts, plays once, ratings after playing, preview apart', async () => {
  const { db } = world();
  const a = (await publish(db, A, G, 'live', { title: 'Alpha', data: {} }, 1)).id;
  const b = (await publish(db, { id: 'u_b' }, G, 'live', { title: 'Beta', data: {} }, 2)).id;
  await publish(db, { id: 'u_b' }, G, 'preview', { title: 'Preview one', data: {} }, 3);
  await assert.rejects(rate(db, a, 'u_d', 5), code('not_played'));
  await assert.rejects(rate(db, a, 'u_a', 5), code('own'));
  assert.equal(await recordPlay(db, a, 'u_d'), true);
  assert.equal(await recordPlay(db, a, 'u_d'), false, 'a play counts once per player');
  assert.equal(await recordPlay(db, a, 'guest_q'), false, 'guests are not counted');
  await assert.rejects(rate(db, a, 'u_d', 9), code('bad_stars'));
  assert.equal((await rate(db, a, 'u_d', 4)).rating, 4);
  assert.deepEqual(await rate(db, a, 'u_d', 2).then((r) => [r.rating, r.ratings]), [2, 1], 'a second rating replaces the first');
  for (const u of ['u_d', 'u_e', 'u_f']) { await recordPlay(db, b, u); await rate(db, b, u, 5); }
  const top = await list(db, 'g1', 'live', { sort: 'top', me: 'u_d' });
  assert.deepEqual(top.levels.map((l) => l.title), ['Beta', 'Alpha']);
  assert.equal(top.levels[1].my_stars, 2); assert.equal(top.levels[0].rating, 5);
  assert.equal(top.levels[0].data, undefined, 'the shelf carries no data');
  assert.deepEqual((await list(db, 'g1', 'live', { sort: 'new' })).levels.map((l) => l.title), ['Beta', 'Alpha']);
  assert.deepEqual((await list(db, 'g1', 'live', { sort: 'played' })).levels.map((l) => l.plays), [3, 1]);
  assert.deepEqual((await list(db, 'g1', 'live', { sort: 'mine', me: 'u_a' })).levels.map((l) => l.title), ['Alpha']);
  assert.deepEqual((await list(db, 'g1', 'live', { sort: 'mine' })).levels, []);
  assert.deepEqual((await list(db, 'g1', 'preview')).levels.map((l) => l.title), ['Preview one']);
  assert.equal(await get(db, a, { env: 'preview' }), null);
  assert.equal(await get(db, a, { projectId: 'other' }), null);
  const page = await list(db, 'g1', 'live', { limit: 1 });
  assert.equal(page.levels.length, 1); assert.equal(page.more, true);
});

test('hiding, reports, deleting and account deletion', async () => {
  const { db } = world();
  const a = (await publish(db, A, G, 'live', { title: 'Alpha', data: {} }, 1)).id;
  await assert.rejects(setHidden(db, a, 'u_b', true), code('forbidden'));
  await setHidden(db, a, 'u_c', true);
  assert.equal(await get(db, a, { me: 'u_b' }), null, 'hidden from players');
  assert.equal((await get(db, a, { me: 'u_a' })).hidden, true, 'its maker still sees it');
  assert.equal((await list(db, 'g1', 'live')).levels.length, 0);
  await setHidden(db, a, 'u_c', false);
  await assert.rejects(report(db, a, 'u_a', 'spam'), code('own'));
  for (const u of ['u_b', 'u_d']) await report(db, a, u, 'spam');
  await report(db, a, 'u_d', 'spam');
  assert.equal((await get(db, a)).hidden, false, 'one report each');
  await report(db, a, 'u_e', 'hate');
  const h = await get(db, a, { me: 'u_c' });
  assert.equal(h.hidden, true); assert.equal(h.hidden_by, 'reports');
  assert.equal((await reported(db))[0].id, a);
  await setHidden(db, a, 'admin', true, true);
  await assert.rejects(setHidden(db, a, 'u_c', false), code('forbidden'), 'an admin hid it');
  await assert.rejects(remove(db, a, 'u_c'), code('forbidden'));
  const b = (await publish(db, { id: 'u_b' }, G, 'live', { title: 'Beta', data: {} }, 2)).id;
  await recordPlay(db, b, 'u_a'); await rate(db, b, 'u_a', 5);
  await recordPlay(db, b, 'u_d'); await rate(db, b, 'u_d', 1);
  await setLevelsOff(db, 'g1', true);
  assert.equal(db.sql.prepare('SELECT levels_off FROM projects').get().levels_off, 1);
  await db.batch(deleteStatements(db, 'u_a'));
  assert.equal(await get(db, a), null, 'their levels go');
  const left = await get(db, b);
  assert.equal(left.ratings, 1); assert.equal(left.rating, 1, 'their rating comes off');
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM level_plays WHERE user_id = 'u_a'").get().n, 0);
  await remove(db, b, 'u_b');
  assert.equal(await get(db, b), null);
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM level_plays').get().n, 0);
});

// ---- the SDK ---------------------------------------------------------------------------------------------------------
function sdkWith(cfg, search = '') {
  const calls = [], noop = () => {};
  const fetch = async (url, init) => { const b = JSON.parse(init.body); calls.push({ url, body: b }); return { ok: true, status: 200, json: async () => (b.op === 'list' ? { ok: true, levels: [{ id: 'lvl_abcdef12', title: 'X' }], more: false } : b.op === 'get' ? { ok: true, level: { id: b.id, data: { v: 1 } } } : { ok: true, id: 'lvl_new12345' }) }; };
  const win = { addEventListener: noop, parent: null, requestAnimationFrame: () => 0, location: { search, pathname: '/', hash: '', origin: 'https://g.example' }, history: { replaceState: noop }, __GCP_CONFIG: cfg };
  const ctx = {
    window: win, location: win.location, history: win.history, URLSearchParams, URL, console: { ...console, error: noop, log: noop }, navigator: {},
    document: { addEventListener: noop, createElement: () => ({ getContext: () => null, style: {} }), documentElement: { style: {} }, head: { appendChild: noop }, body: null, querySelector: () => null },
    performance: { now: () => 0, timeOrigin: 1.7e12 }, setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, fetch, Promise, JSON, Math, Object, Array, Date, Number, String, isFinite, Error, Blob: class {}, Uint8Array, Float32Array, ArrayBuffer, WebSocket: class {}, encodeURIComponent,
  };
  win.window = win; Object.assign(win, ctx); vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url), 'utf8'), ctx);
  return { GCP: win.GCP, calls };
}
const CFG = { api: 'https://p.example', token: 'tok', gameId: 'g', version: 1, env: 'live', base: '/play/g', player: { id: 'u_me', name: 'Me' }, kind: 'player', session: 's' };

test('GCP.levels: publish, list and get go to the platform with the play token; GCP.launch.level', async () => {
  const { GCP, calls } = sdkWith(CFG, '?gcp_level=lvl_abcdef12');
  assert.equal(GCP.launch.level, 'lvl_abcdef12');
  assert.equal(GCP.levels.available, true);
  assert.equal((await GCP.levels.publish({ title: 'T', data: { a: 1 } })).id, 'lvl_new12345');
  assert.equal((await GCP.levels.list({ sort: 'new' })).levels[0].title, 'X');
  assert.deepEqual(JSON.parse(JSON.stringify((await GCP.levels.get('lvl_abcdef12')).data)), { v: 1 });
  assert.deepEqual(calls.map((c) => [c.url, c.body.op, c.body.t]), [['https://p.example/api/rt/levels', 'publish', 'tok'], ['https://p.example/api/rt/levels', 'list', 'tok'], ['https://p.example/api/rt/levels', 'get', 'tok']]);
  assert.equal(calls[1].body.sort, 'new');
});

test('GCP.levels for guests and outside the platform', async () => {
  const guest = sdkWith({ ...CFG, player: { id: 'guest_abc', name: 'Guest', guest: true } }, '?gcp_level=<script>');
  assert.equal(guest.GCP.launch.level, null);
  assert.equal(guest.GCP.levels.available, false);
  assert.equal((await guest.GCP.levels.publish({ title: 'T', data: {} })).code, 'guest');
  assert.equal((await guest.GCP.levels.rate('lvl_abcdef12', 5)).code, 'guest');
  assert.equal((await guest.GCP.levels.list()).levels.length, 1, 'guests still read the shelf');
  assert.equal(guest.calls.length, 1);
  const alone = sdkWith(null);
  assert.deepEqual(JSON.parse(JSON.stringify(await alone.GCP.levels.list())), { levels: [], more: false });
  assert.equal(await alone.GCP.levels.get('lvl_abcdef12'), null);
  assert.equal(alone.calls.length, 0);
});

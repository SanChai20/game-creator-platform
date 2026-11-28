// Game jams and festivals (src/jams.js): who hosts, the hidden theme, what can be entered and when, who votes, the
// ranked results, the home shelf and the phase notices to entrants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { bySlug, cancelJam, cleanSetup, eligibleGames, entriesOf, featuredNow, hostJam, listJams, phaseNotices, phaseOf, publicView, submit, vote, withdraw, LIMITS } from '../src/jams.js';

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
  return { prepare: (q) => stmt(q), batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; }, sql };
}
const T = 1_800_000_000_000, H = 3600_000, D = 86400_000;
function world() {
  const db = d1(), q = (s, ...a) => db.sql.prepare(s).run(...a);
  q("INSERT INTO users (id, email, name, pw_hash, status, role, creator, created_at) VALUES ('u_admin', 'a@x', 'Admin', '', 'active', 'admin', 0, 1)");
  for (const id of ['u_c1', 'u_c2']) q("INSERT INTO users (id, email, name, pw_hash, status, creator, created_at) VALUES (?, ?, ?, '', 'active', 1, 1)", id, id + '@x', id);
  for (const id of ['u_p1', 'u_p2', 'u_p3', 'u_p4']) q("INSERT INTO users (id, email, name, pw_hash, status, created_at) VALUES (?, ?, ?, '', 'active', 1)", id, id + '@x', id);
  const game = (id, owner, created, extra = {}) => q(`INSERT INTO projects (id, owner_id, slug, title, status, live_version, published_at, age, coming_soon_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, owner, id, 'Game ' + id, extra.status || 'live', extra.status === 'draft' ? null : 1, extra.status === 'draft' ? null : created, extra.age ?? null, extra.soon ?? null, created, created);
  game('old', 'u_c1', T - 10 * D); game('new1', 'u_c1', T + H); game('new2', 'u_c2', T + 2 * H); game('adult', 'u_c1', T + H, { age: 18 }); game('soon', 'u_c2', T + H, { status: 'draft', soon: T });
  return { db, q };
}
const jamSetup = { title: 'Winter Jam', theme: 'Frozen', starts_at: T, ends_at: T + 2 * D, voting_ends_at: T + 4 * D, criteria: ['Fun', 'Art'] };
const P = (db, id) => db.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first();

test('setup is checked', () => {
  assert.throws(() => cleanSetup({ ...jamSetup, theme: '' }, T), /theme/);
  assert.throws(() => cleanSetup({ ...jamSetup, ends_at: T + 10 }, T), /at least an hour/);
  assert.throws(() => cleanSetup({ ...jamSetup, starts_at: T - D }, T), /now or later/);
  assert.throws(() => cleanSetup({ ...jamSetup, voting_ends_at: T + 60 * D }, T), /voting_ends_at/);
  assert.deepEqual(cleanSetup({ ...jamSetup, criteria: undefined }, T).criteria, ['Fun', 'Originality', 'Presentation', 'Theme']);
  const f = cleanSetup({ kind: 'festival', title: 'Next Fest', starts_at: T, ends_at: T + 5 * D }, T);
  assert.deepEqual([f.kind, f.voting_ends_at, f.theme], ['festival', null, null]);
});

test('licensed creators and admins host; the theme stays hidden until it starts', async () => {
  const { db } = world();
  await assert.rejects(hostJam(db, 'u_p1', jamSetup, T - D), /creator license/);
  const j = await hostJam(db, 'u_c1', jamSetup, T - D);
  assert.equal(j.featured, 0);
  assert.equal((await hostJam(db, 'u_admin', { ...jamSetup, title: 'Platform jam' }, T - D)).featured, 1);
  await hostJam(db, 'u_c1', jamSetup, T - D); await hostJam(db, 'u_c1', jamSetup, T - D);
  await assert.rejects(hostJam(db, 'u_c1', jamSetup, T - D), /at most 3/);
  const row = await bySlug(db, j.slug);
  assert.equal(publicView(row, 'u_p1', T - H).theme, null); assert.equal(publicView(row, 'u_p1', T - H).theme_hidden, true);
  assert.equal(publicView(row, 'u_c1', T - H).theme, 'Frozen');
  assert.equal(publicView(row, null, T + H).theme, 'Frozen');
  assert.deepEqual(['upcoming', 'entries', 'voting', 'results'].map((x, i) => x), [T - 1, T + 1, T + 3 * D, T + 5 * D].map((t) => phaseOf(row, t)));
  const l = await listJams(db, T + H);
  assert.equal(l.current[0].featured, true);
  await assert.rejects(cancelJam(db, row, { id: 'u_p1', role: 'user' }, T), /Only the host/);
  await cancelJam(db, row, { id: 'u_c1', role: 'user' }, T);
  assert.equal(phaseOf(await bySlug(db, j.slug), T), 'cancelled');
});

test('entries: own live games, made for the jam, while entries are open', async () => {
  const { db } = world();
  const j = await bySlug(db, (await hostJam(db, 'u_admin', jamSetup, T - D)).slug);
  await assert.rejects(submit(db, j, 'u_c1', await P(db, 'new1'), T - H), /not open/);
  await assert.rejects(submit(db, j, 'u_c1', await P(db, 'old'), T + 3 * H), /created after/);
  await assert.rejects(submit(db, j, 'u_c1', await P(db, 'adult'), T + 3 * H), /Adults-only/);
  await assert.rejects(submit(db, j, 'u_c1', await P(db, 'new2'), T + 3 * H), /your own/);
  await assert.rejects(submit(db, j, 'u_c2', await P(db, 'soon'), T + 3 * H), /Publish the game/);
  assert.deepEqual((await eligibleGames(db, j, 'u_c1')).map((g) => g.id), ['new1']);
  await submit(db, j, 'u_c1', await P(db, 'new1'), T + 3 * H);
  await submit(db, j, 'u_c1', await P(db, 'new1'), T + 3 * H);   // idempotent
  await submit(db, j, 'u_c2', await P(db, 'new2'), T + 3 * H);
  await withdraw(db, j, 'u_c2', 'new2', T + 4 * H);
  await submit(db, j, 'u_c2', await P(db, 'new2'), T + 4 * H);
  await assert.rejects(withdraw(db, j, 'u_c2', 'new2', T + 3 * D), /only while/);
  assert.equal((await entriesOf(db, j, null, T + 5 * H)).length, 2);
  // a festival takes coming soon games and older ones
  const f = await bySlug(db, (await hostJam(db, 'u_admin', { kind: 'festival', title: 'Fest', starts_at: T, ends_at: T + 3 * D }, T - D)).slug);
  await submit(db, f, 'u_c2', await P(db, 'soon'), T - H);
  await submit(db, f, 'u_c1', await P(db, 'old'), T + H);
  assert.equal((await entriesOf(db, f, null, T + H)).length, 2);
});

test('voting: players of the game, never the owner, every criterion; ranked results', async () => {
  const { db, q } = world();
  const j = await bySlug(db, (await hostJam(db, 'u_admin', jamSetup, T - D)).slug);
  await submit(db, j, 'u_c1', await P(db, 'new1'), T + H); await submit(db, j, 'u_c2', await P(db, 'new2'), T + H);
  const play = (u, g) => q("INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at) VALUES (?, ?, 1, 'live', ?, 'player', ?, ?)", `${u}-${g}`, g, u, T + 2 * D + H, T + 2 * D + H);
  const V = T + 3 * D;
  await assert.rejects(vote(db, j, 'u_p1', 'new1', { Fun: 5, Art: 5 }, T + H), /not open/);
  await assert.rejects(vote(db, j, 'u_p1', 'new1', { Fun: 5, Art: 5 }, V), /Play the game/);
  play('u_c1', 'new1');
  await assert.rejects(vote(db, j, 'u_c1', 'new1', { Fun: 5, Art: 5 }, V), /own entry/);
  for (const u of ['u_p1', 'u_p2', 'u_p3']) { play(u, 'new1'); await vote(db, j, u, 'new1', { Fun: 4, Art: 5 }, V); }
  await assert.rejects(vote(db, j, 'u_p1', 'new1', { Fun: 4 }, V), /missing: Art/);
  await vote(db, j, 'u_p1', 'new1', { Fun: 2, Art: 5 }, V + 1);   // changed
  play('u_p4', 'new2'); await vote(db, j, 'u_p4', 'new2', { Fun: 5, Art: 5 }, V);
  const during = await entriesOf(db, j, 'u_p1', V);
  assert.deepEqual(during.find((e) => e.game.id === 'new1').my_scores, { Fun: 2, Art: 5 });
  assert.equal(during.find((e) => e.game.id === 'new2').played, false);
  const res = await entriesOf(db, j, null, T + 5 * D);
  assert.deepEqual(res.map((e) => [e.game.id, e.rank, e.voters, e.overall]), [['new1', 1, 3, 4.17], ['new2', null, 1, 5]]);
  assert.deepEqual(res[0].scores, { Fun: 3.33, Art: 5 });
});

test('the home shelf shows the running featured event, and entrants hear about voting and results once', async () => {
  const { db } = world();
  assert.equal(await featuredNow(db, T), null);
  const j = await bySlug(db, (await hostJam(db, 'u_admin', jamSetup, T - D)).slug);
  await submit(db, j, 'u_c1', await P(db, 'new1'), T + H);
  const f = await featuredNow(db, T + H);
  assert.equal(f.jam.slug, j.slug); assert.deepEqual(f.games.map((g) => g.id), ['new1']);
  assert.equal(await phaseNotices(db, T + H), 0);
  assert.equal(await phaseNotices(db, T + 2 * D + 1), 1);
  assert.equal(await phaseNotices(db, T + 2 * D + 2), 0);
  assert.equal(await phaseNotices(db, T + 4 * D + 1), 1);
  assert.equal(await phaseNotices(db, T + 4 * D + 2), 0);
  const n = (await db.prepare("SELECT kind, data FROM notifications WHERE user_id = 'u_c1' ORDER BY id").all()).results;
  assert.deepEqual(n.map((x) => x.kind), ['jam_voting', 'jam_results']);
  assert.equal(JSON.parse(n[0].data).jam, j.slug);
  assert.equal(LIMITS.min_votes, 3);
});

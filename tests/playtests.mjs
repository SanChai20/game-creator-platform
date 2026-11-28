// Playtests (src/playtests.js): opening one needs a verified preview and only one runs per game, testers join through
// the link up to the seats (never the owner), answers are kept per tester, and results read preview play only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { answer, byCode, canPlay, cleanSetup, closePlaytest, inviteView, join, listPlaytests, openPlaytest, results } from '../src/playtests.js';

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
const T = 1_800_000_000_000, DAY = 86400_000;
function world() {
  const db = d1(), q = (s, ...a) => db.sql.prepare(s).run(...a);
  for (const id of ['u_owner', 'u_a', 'u_b', 'u_c']) q("INSERT INTO users (id, email, name, pw_hash, status, created_at) VALUES (?, ?, ?, '', 'active', 1)", id, id + '@example.com', 'Name ' + id);
  q("INSERT INTO projects (id, owner_id, slug, title, status, preview_version, created_at, updated_at) VALUES ('g1', 'u_owner', 'test-game', 'Test Game', 'draft', 2, 1, 1)");
  q("INSERT INTO projects (id, owner_id, slug, title, status, created_at, updated_at) VALUES ('g2', 'u_owner', 'no-preview', 'No Preview', 'draft', 1, 1)");
  q("INSERT INTO projects (id, owner_id, slug, title, status, preview_version, created_at, updated_at) VALUES ('g3', 'u_owner', 'unverified', 'Unverified', 'draft', 1, 1, 1)");
  q("INSERT INTO versions (project_id, n, status, created_at) VALUES ('g1', 2, 'verified', 1)");
  q("INSERT INTO versions (project_id, n, status, created_at) VALUES ('g3', 1, 'failed', 1)");
  return db;
}
const P = async (db, id) => db.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first();

test('the setup is cleaned and checked', () => {
  const s = cleanSetup({ title: '  Level   2 ', questions: ['Was it hard?', '', '  '], seats: '10', days: 3 });
  assert.deepEqual([s.title, s.questions, s.seats, s.days, s.note], ['Level 2', ['Was it hard?'], 10, 3, null]);
  assert.throws(() => cleanSetup({}), /title/);
  assert.throws(() => cleanSetup({ title: 'x', questions: ['1', '2', '3', '4', '5', '6'] }), /at most 5/);
  assert.throws(() => cleanSetup({ title: 'x', seats: 0 }), /seats/);
  assert.throws(() => cleanSetup({ title: 'x', days: 31 }), /days/);
});

test('a playtest needs a verified preview, and one at a time', async () => {
  const db = world();
  await assert.rejects(openPlaytest(db, await P(db, 'g2'), { title: 'x' }, T), /Deploy a preview/);
  await assert.rejects(openPlaytest(db, await P(db, 'g3'), { title: 'x' }, T), /verification/);
  const pt = await openPlaytest(db, await P(db, 'g1'), { title: 'Round 1', days: 2 }, T);
  assert.equal(pt.version, 2); assert.match(pt.code, /^[a-z0-9]{10}$/);
  await assert.rejects(openPlaytest(db, await P(db, 'g1'), { title: 'Round 2' }, T), /already has an open/);
  // after its days it closes by itself, and a new one can open
  const later = T + 3 * DAY;
  assert.equal((await listPlaytests(db, 'g1', later))[0].status, 'closed');
  await openPlaytest(db, await P(db, 'g1'), { title: 'Round 2' }, later);
  assert.equal((await listPlaytests(db, 'g1', later)).length, 2);
});

test('testers join by link up to the seats, never the owner', async () => {
  const db = world();
  const row = await openPlaytest(db, await P(db, 'g1'), { title: 'R', seats: 2 }, T);
  const pt = await byCode(db, row.code);
  assert.equal(pt.slug, 'test-game');
  assert.equal(await byCode(db, 'nope!'), null);
  await assert.rejects(join(db, pt, 'u_owner', T), /your own game/);
  await assert.rejects(join(db, pt, null, T), /Sign in/);
  assert.equal(await canPlay(db, pt, 'u_a', T), false);
  await join(db, pt, 'u_a', T); await join(db, pt, 'u_a', T);   // idempotent
  await join(db, pt, 'u_b', T);
  await assert.rejects(join(db, pt, 'u_c', T), /full/);
  assert.equal(await canPlay(db, pt, 'u_a', T), true);
  const v = await inviteView(db, pt, 'u_a', T);
  assert.deepEqual([v.joined, v.full, v.open, v.owner, v.answered], [true, true, true, false, false]);
  assert.equal((await inviteView(db, pt, 'u_owner', T)).owner, true);
  // closed: no new testers, no play, no answers
  await closePlaytest(db, 'g1', row.id, T + 1);
  const closed = await byCode(db, row.code);
  assert.equal(await canPlay(db, closed, 'u_a', T + 2), false);
  await assert.rejects(answer(db, closed, 'u_a', { fun: 4 }, T + 2), /closed/);
  await assert.rejects(closePlaytest(db, 'g1', row.id, T + 3), /No open playtest/);
});

test('answers and results: per tester, preview play only, since the playtest opened', async () => {
  const db = world(), q = (s, ...a) => db.sql.prepare(s).run(...a);
  const row = await openPlaytest(db, await P(db, 'g1'), { title: 'R', questions: ['Hard?', 'Best part?'] }, T);
  const pt = await byCode(db, row.code);
  await join(db, pt, 'u_a', T); await join(db, pt, 'u_b', T);
  await assert.rejects(answer(db, pt, 'u_c', { fun: 3 }, T), /Join the playtest/);
  await assert.rejects(answer(db, pt, 'u_a', { fun: 9 }, T), /fun must be/);
  await answer(db, pt, 'u_a', { fun: 4, answers: ['A bit', 'The boss', 'ignored'] }, T + 10);
  await answer(db, pt, 'u_b', { fun: 2 }, T + 10);
  const play = (id, user, env, at, seconds) => q("INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at, seconds) VALUES (?, 'g1', 2, ?, ?, 'player', ?, ?, ?)", id, env, user, at, at, seconds);
  play('p1', 'u_a', 'preview', T + 1, 600); play('p2', 'u_a', 'preview', T + 2, 300);
  play('p3', 'u_a', 'live', T + 3, 9999);          // live play is not the playtest's
  play('p4', 'u_a', 'preview', T - 100, 9999);     // before it opened
  play('p5', 'u_c', 'preview', T + 4, 120);        // not a tester
  q("INSERT INTO event_players (project_id, name, user_id, count, first_at, last_at) VALUES ('g1:preview', 'boss', 'u_a', 1, ?, ?)", T + 5, T + 5);
  q("INSERT INTO event_players (project_id, name, user_id, count, first_at, last_at) VALUES ('g1', 'boss', 'u_b', 1, ?, ?)", T + 5, T + 5);
  const r = await results(db, pt);
  assert.deepEqual(r.totals, { testers: 2, played: 1, answered: 2, fun_average: 3, median_minutes: 15 });
  const a = r.testers.find((x) => x.name === 'Name u_a');
  assert.deepEqual([a.sessions, a.minutes, a.longest_minutes, a.answers, a.events.map((e) => e.name)], [2, 15, 10, ['A bit', 'The boss'], ['boss']]);
  assert.deepEqual(r.events, [{ name: 'boss', testers: 1 }]);
  assert.deepEqual(r.testers.find((x) => x.name === 'Name u_b').answers, ['', '']);
  assert.deepEqual((await inviteView(db, pt, 'u_a', T)).answered, true);
});

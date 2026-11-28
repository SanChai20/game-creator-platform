// For you (src/recommend.js): taste from history, co-play picks with their reason, nothing seen, owned, dismissed, own
// or adults-only, at most two per creator, and nothing for a player with no history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dismiss, forYou, rank, tasteOf } from '../src/recommend.js';

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
  return { prepare: (q) => stmt(q), sql };
}
function world() {
  const db = d1(), q = (s, ...a) => db.sql.prepare(s).run(...a);
  for (const id of ['me', 'p1', 'p2', 'p3', 'c1', 'c2', 'c3']) q("INSERT INTO users (id, email, name, pw_hash, status, created_at) VALUES (?, ?, ?, '', 'active', 1)", id, id + '@x.test', id);
  const game = (id, owner, tags, extra = {}) => q("INSERT INTO projects (id, owner_id, slug, title, tags, status, age, rating_sum, rating_count, plays, recent, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?, 1, 1, 1)",
    id, owner, id, 'Game ' + id, JSON.stringify(tags), extra.age ?? null, extra.rs ?? 0, extra.rc ?? 0, extra.plays ?? 0, extra.recent ?? 0);
  game('mine1', 'c1', ['puzzle', 'cozy']);
  game('liked', 'c2', ['puzzle', 'relaxing'], { rs: 45, rc: 10, plays: 500 });
  game('coplayed', 'c3', ['racing'], { plays: 100 });
  game('adult', 'c2', ['puzzle'], { age: 18, rs: 50, rc: 10 });
  game('own', 'me', ['puzzle']);
  game('meh', 'c3', ['shooter']);
  game('puz2', 'c2', ['puzzle']); game('puz3', 'c2', ['puzzle']);
  q("INSERT INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds) VALUES ('mine1', 'me', 1, 9, 5, 7200)");
  for (const u of ['p1', 'p2', 'p3']) q("INSERT INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds) VALUES ('mine1', ?, 1, 5, 1, 600), ('coplayed', ?, 1, 6, 1, 600)", u, u);
  return db;
}

test('taste comes from history; ratings can count against a genre', async () => {
  const db = world();
  db.sql.prepare("INSERT INTO reviews (project_id, user_id, rating, body, created_at, updated_at) VALUES ('meh', 'me', 1, '', 1, 1)").run();
  const t = await tasteOf(db, 'me');
  assert.ok(t.tags.get('puzzle') > 0 && t.tags.get('cozy') > 0);
  assert.ok(t.tags.get('shooter') < 0);
  assert.ok(t.seen.has('mine1') && t.seen.has('own'));
});

test('picks: co-played and same-genre games, with reasons, never seen, own or adults-only', async () => {
  const db = world();
  const r = await forYou(db, 'me', 12);
  const ids = r.map((x) => x.id);
  assert.ok(ids.includes('coplayed') && ids.includes('liked'), JSON.stringify(r));
  for (const bad of ['mine1', 'own', 'adult', 'meh']) assert.ok(!ids.includes(bad), bad);
  assert.deepEqual(r.find((x) => x.id === 'coplayed').reason, { kind: 'played', game: 'mine1' });
  assert.deepEqual(r.find((x) => x.id === 'liked').reason, { kind: 'tag', tag: 'puzzle' });
  assert.ok(r.filter((x) => ['liked', 'puz2', 'puz3'].includes(x.id)).length <= 2, 'two per creator');
  await dismiss(db, 'me', 'coplayed');
  assert.ok(!(await forYou(db, 'me')).some((x) => x.id === 'coplayed'));
  assert.deepEqual(await forYou(db, 'p9'), []);
});

test('rank is pure and puts shared taste first', () => {
  const taste = { games: new Map([['a', 3]]), tags: new Map([['puzzle', 3], ['racing', -2]]), seen: new Set(['a']) };
  const out = rank(taste, [
    { id: 'a', owner_id: 'x', tags: ['puzzle'] },
    { id: 'r', owner_id: 'y', tags: ['racing'], rating: 5, rating_count: 100, plays: 1e6 },
    { id: 'p', owner_id: 'z', tags: ['puzzle'], rating: 4, rating_count: 5, plays: 10 },
  ], new Map(), 0, 5);
  assert.deepEqual(out.map((x) => x.id), ['p']);
});

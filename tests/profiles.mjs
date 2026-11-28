// Player profiles (src/profiles.js): visibility (everyone, friends, nobody; blocks hide everything), what a profile
// shows (live listed games only, adults-only games only to the owner), and the showcase's limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { access, cleanBio, profileOf, publicIds, setSettings, settingsOf, showcaseChoices } from '../src/profiles.js';

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
  for (const [id, st] of [['u_me', 'active'], ['u_friend', 'active'], ['u_other', 'active'], ['u_blocked', 'active'], ['u_gone', 'suspended']]) q("INSERT INTO users (id, email, name, pw_hash, status, created_at) VALUES (?, ?, ?, '', ?, 1)", id, id + '@example.com', id, st);
  q("INSERT INTO friendships (user_id, friend_id, created_at) VALUES ('u_me', 'u_friend', 1), ('u_friend', 'u_me', 1)");
  q("INSERT INTO blocks (user_id, blocked_id, created_at) VALUES ('u_me', 'u_blocked', 1)");
  const man = JSON.stringify({ achievements: [{ id: 'win', name: { en: 'First win', zh: '首胜' } }] });
  for (const [id, age] of [['g1', null], ['g2', null], ['g18', 18]]) {
    q("INSERT INTO projects (id, owner_id, slug, title, status, live_version, age, created_at, updated_at) VALUES (?, 'u_other', ?, ?, 'live', 1, ?, 1, 1)", id, id, 'Game ' + id, age);
    q("INSERT INTO versions (project_id, n, status, manifest, created_at) VALUES (?, 1, 'verified', ?, 1)", id, man);
  }
  q("INSERT INTO projects (id, owner_id, slug, title, status, created_at, updated_at) VALUES ('gd', 'u_other', 'gd', 'Draft', 'draft', 1, 1)");
  q("INSERT INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds) VALUES ('g1', 'u_me', 1, 5, 3, 3600), ('g2', 'u_me', 1, 4, 1, 600), ('g18', 'u_me', 1, 3, 1, 9000), ('g1:preview', 'u_me', 1, 3, 1, 99999), ('gd', 'u_me', 1, 1, 1, 50)");
  q("INSERT INTO achievement_unlocks (project_id, user_id, ach_id, unlocked_at) VALUES ('g1', 'u_me', 'win', 10), ('g18', 'u_me', 'win', 11)");
  q("INSERT INTO reviews (project_id, user_id, rating, body, created_at, updated_at) VALUES ('g1', 'u_me', 5, 'Great', 1, 2)");
  return db;
}

test('visibility: friends by default, everyone, nobody; blocks hide it all', async () => {
  const db = world();
  assert.equal((await settingsOf(db, 'u_me')).visibility, 'friends');
  assert.equal((await access(db, 'u_me', 'u_me')).state, 'self');
  assert.equal((await access(db, 'u_friend', 'u_me')).state, 'visible');
  assert.equal((await access(db, 'u_other', 'u_me')).state, 'private');
  assert.equal((await access(db, null, 'u_me')).state, 'private');
  assert.equal((await access(db, 'u_blocked', 'u_me')).state, 'hidden');
  assert.equal((await access(db, 'u_me', 'u_gone')).state, 'hidden');
  assert.equal((await access(db, 'u_me', '../x')).state, 'hidden');
  await setSettings(db, 'u_me', { visibility: 'everyone' });
  assert.equal((await access(db, null, 'u_me')).state, 'visible');
  assert.equal((await access(db, 'u_blocked', 'u_me')).state, 'hidden');
  assert.deepEqual([...(await publicIds(db, ['u_me', 'u_friend']))], ['u_me']);
  await setSettings(db, 'u_me', { visibility: 'nobody' });
  assert.equal((await access(db, 'u_friend', 'u_me')).state, 'private');
  await assert.rejects(setSettings(db, 'u_me', { visibility: 'all' }), /visibility must be/);
});

test('a profile shows live listed games, and adults-only ones only to the owner', async () => {
  const db = world();
  const pub = await profileOf(db, 'u_me', { lang: 'zh' });
  assert.deepEqual(pub.stats, { games: 2, minutes: 70, achievements: 1, reviews: 1, best_streak: 0, daily_days: 0 });
  assert.deepEqual(pub.showcase.map((g) => g.id), ['g1', 'g2']);
  assert.equal(pub.showcase[0].achievements, 1);
  assert.deepEqual(pub.achievements.map((a) => [a.name, a.game.slug]), [['首胜', 'g1']]);
  assert.equal(pub.reviews[0].body, 'Great');
  const mine = await profileOf(db, 'u_me', { self: true });
  assert.deepEqual(mine.showcase.map((g) => g.id), ['g18', 'g1', 'g2']);
  assert.equal(mine.stats.achievements, 2);
});

test('the showcase: up to 6 games the owner played, kept or bought', async () => {
  const db = world();
  const s = await setSettings(db, 'u_me', { showcase: ['g2', 'g1'], bio: '  I   like puzzles \n' });
  assert.deepEqual(s.showcase, ['g2', 'g1']);
  assert.equal(s.bio, 'I like puzzles');
  assert.deepEqual((await profileOf(db, 'u_me')).showcase.map((g) => g.id), ['g2', 'g1']);
  await assert.rejects(setSettings(db, 'u_friend', { showcase: ['g1'] }), /live games you played/);
  await assert.rejects(setSettings(db, 'u_me', { showcase: ['gd'] }), /live games you played/);
  await assert.rejects(setSettings(db, 'u_me', { showcase: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }), /at most 6/);
  assert.equal(cleanBio('x'.repeat(300)).length, 160);
  assert.deepEqual((await showcaseChoices(db, 'u_me')).map((g) => g.id), ['g18', 'g1', 'g2']);
});

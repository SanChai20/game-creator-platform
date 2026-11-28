// Achievements: what gcp.json may declare, that only declared ids unlock, that unlocks belong to the token's player and
// scope, that stat goals unlock by themselves, that hidden ones stay secret, rarity, and that a progress reset, a guest
// claim and the daily cleanups take unlocks with them. Runs the real modules against SQLite with the real migrations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { declaredFor, keepsUnlocks, parseAchievements, pickText, rarityOf, reachedBy, unlock, unlockCounts, unlocksOf, viewOf } from '../src/achievements.js';
import { resetPlayer, verifierCleanupStmts } from '../src/player-data.js';
import { claimGuest } from '../src/session-binding.js';
import { libraryList } from '../src/library.js';

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

const DEFS = parseAchievements([
  { id: 'first_win', name: { en: 'First win', zh: '首胜' }, description: 'Win a match' },
  { id: 'kills_100', name: 'Centurion', stat: 'kills', goal: 100 },
  { id: 'secret', name: 'Behind the waterfall', description: 'Find the cave', hidden: true },
]).list;

test('gcp.json achievements are checked', () => {
  assert.equal(DEFS.length, 3);
  assert.deepEqual(DEFS[1], { id: 'kills_100', name: 'Centurion', stat: 'kills', goal: 100 });
  assert.deepEqual(parseAchievements(undefined), { list: [], issues: [] });
  assert.equal(parseAchievements({}).issues[0].level, 'error');
  const r = parseAchievements([{ id: 'Bad Id', name: 'x' }, { id: 'a', name: '' }, { id: 'b', name: 'B' }, { id: 'b', name: 'B again' }, { id: 'c', name: 'C', stat: 'kills' }, { id: 'd', name: { fr: 'D' } }]);
  assert.deepEqual(r.list.map((a) => a.id), ['b'], 'only the valid entry is kept');
  assert.ok(r.issues.some((i) => i.field === 'achievements[0].id'));
  assert.ok(r.issues.some((i) => i.field === 'achievements[1].name'));
  assert.ok(r.issues.some((i) => /declared twice/.test(i.message)));
  assert.ok(r.issues.some((i) => i.field === 'achievements[4].goal'));
  assert.ok(r.issues.some((i) => i.field === 'achievements[5].name.fr' && i.level === 'warning'));
  assert.equal(parseAchievements(Array.from({ length: 101 }, (_, i) => ({ id: 'a' + i, name: 'A' }))).issues[0].level, 'error');
});

test('names follow the viewer\'s language', () => {
  assert.equal(pickText(DEFS[0].name, 'zh'), '首胜');
  assert.equal(pickText(DEFS[0].name, 'zh-TW'), '首胜', 'Traditional falls back to Simplified before English');
  assert.equal(pickText(DEFS[0].name, 'ja'), 'First win');
  assert.equal(pickText('Plain', 'ko'), 'Plain');
});

test('only declared ids unlock, once, for the token\'s own player and scope', async () => {
  const db = d1();
  assert.deepEqual((await unlock(db, 'gamea1', 'u_alice', DEFS, 'first_win', 1000)).unlocked, ['first_win']);
  assert.deepEqual((await unlock(db, 'gamea1', 'u_alice', DEFS, ['first_win'], 2000)).unlocked, [], 'a second unlock changes nothing');
  assert.equal((await unlocksOf(db, 'gamea1', 'u_alice')).first_win, 1000, 'the first unlock time stays');
  await assert.rejects(unlock(db, 'gamea1', 'u_alice', DEFS, 'made_up'), (e) => e.status === 400 && e.code === 'unknown_achievement');
  assert.deepEqual(await unlocksOf(db, 'gamea1', 'u_bob'), {}, 'another player has none');
  assert.deepEqual(await unlocksOf(db, 'gamea1:preview', 'u_alice'), {}, 'preview is separate from live');
});

test('the verification browser keeps none; an agent debug session keeps them on the preview', async () => {
  assert.equal(keepsUnlocks({ k: 'verify', e: 'live' }), false);
  assert.equal(keepsUnlocks({ k: 'verify', e: 'preview' }), false);
  assert.equal(keepsUnlocks({ k: 'verify', e: 'preview', dbg: 1 }), true);
  assert.equal(keepsUnlocks({ k: 'player', e: 'live' }), true);
  const db = d1(), r = await unlock(db, 'gamea1', 'verify:s1', DEFS, 'first_win', 1, false);
  assert.equal(r.recorded, false);
  assert.deepEqual(await unlocksOf(db, 'gamea1', 'verify:s1'), {});
});

test('a stat that reaches its goal names the achievements it unlocks', () => {
  assert.deepEqual(reachedBy(DEFS, 'kills', 99), []);
  assert.deepEqual(reachedBy(DEFS, 'kills', 100), ['kills_100']);
  assert.deepEqual(reachedBy(DEFS, 'kills', 250), ['kills_100'], 'passing the goal unlocks it too');
  assert.deepEqual(reachedBy(DEFS, 'deaths', 1000), []);
});

test('rarity, hidden achievements and what a viewer sees', async () => {
  const db = d1();
  for (const u of ['u_a', 'u_b', 'u_c', 'u_d']) db.sql.prepare('INSERT INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds) VALUES (?, ?, 1, 1, 1, 60)').run('gamea1', u);
  await unlock(db, 'gamea1', 'u_a', DEFS, ['first_win', 'secret'], 5);
  await unlock(db, 'gamea1', 'u_b', DEFS, 'first_win', 6);
  const rarity = await rarityOf(db, 'gamea1');
  assert.equal(rarity.players, 4);
  const a = viewOf(DEFS, await unlocksOf(db, 'gamea1', 'u_a'), rarity, 'zh');
  assert.equal(a.unlocked, 2); assert.equal(a.total, 3);
  assert.equal(a.achievements[0].name, '首胜'); assert.equal(a.achievements[0].percent, 50);
  assert.equal(a.achievements[2].name, 'Behind the waterfall', 'a hidden one is shown to who unlocked it');
  const c = viewOf(DEFS, await unlocksOf(db, 'gamea1', 'u_c'), rarity, 'en');
  assert.equal(c.achievements[2].name, ''); assert.equal(c.achievements[2].description, '', 'and stays secret to others');
  assert.equal(c.achievements[2].percent, 25);
  assert.equal(viewOf(DEFS, {}, { counts: {}, players: 0 }).achievements[0].percent, 0, 'no players, no division by zero');
  assert.deepEqual(await unlockCounts(db, 'u_a', ['gamea1', 'gameb2']), { gamea1: 2 });
});

test('a progress reset clears unlocks; a guest claim moves them; the verifier cleanup removes its own', async () => {
  const db = d1();
  await unlock(db, 'gamea1', 'u_alice', DEFS, 'first_win', 1);
  await resetPlayer(db, 'gamea1', 'u_alice');
  assert.deepEqual(await unlocksOf(db, 'gamea1', 'u_alice'), {});
  db.sql.prepare('INSERT INTO projects (id, owner_id, slug, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)').run('gamea1', 'u_owner', 'game-a', 'Game A', 'live');
  db.sql.prepare('INSERT INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds) VALUES (?, ?, 1, 1, 1, 60)').run('gamea1', 'guest_x');
  await unlock(db, 'gamea1', 'guest_x', DEFS, ['first_win', 'secret'], 3);
  await unlock(db, 'gamea1', 'u_alice', DEFS, 'first_win', 9);
  await claimGuest(db, 'guest_x', 'u_alice', 'Alice');
  const mine = await unlocksOf(db, 'gamea1', 'u_alice');
  assert.deepEqual(Object.keys(mine).sort(), ['first_win', 'secret']);
  assert.equal(mine.first_win, 9, 'one the account already had keeps the account\'s time');
  await unlock(db, 'gamea1', 'verify:s', DEFS, 'first_win', 1);
  await db.batch(verifierCleanupStmts(db, 10));
  assert.deepEqual(await unlocksOf(db, 'gamea1', 'verify:s'), {});
});

test('the live version\'s declaration is read from its frozen manifest, and the library counts unlocks', async () => {
  const db = d1();
  db.sql.prepare('INSERT INTO projects (id, owner_id, slug, title, status, live_version, preview_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 2, 1, 1)').run('gamea1', 'u_owner', 'game-a', 'Game A', 'live');
  db.sql.prepare('INSERT INTO versions (project_id, n, manifest, created_at) VALUES (?, 1, ?, 1)').run('gamea1', JSON.stringify({ achievements: DEFS }));
  db.sql.prepare('INSERT INTO versions (project_id, n, manifest, created_at) VALUES (?, 2, ?, 1)').run('gamea1', JSON.stringify({}));
  assert.deepEqual((await declaredFor(db, 'gamea1', 'live')).map((a) => a.id), ['first_win', 'kills_100', 'secret']);
  assert.deepEqual(await declaredFor(db, 'gamea1', 'preview'), []);
  assert.deepEqual(await declaredFor(db, 'nogame', 'live'), []);
  db.sql.prepare('INSERT INTO library_games (user_id, project_id, added_at) VALUES (?, ?, 1)').run('u_alice', 'gamea1');
  await unlock(db, 'gamea1', 'u_alice', DEFS, 'first_win', 1);
  const { list } = await libraryList(db, 'u_alice');
  assert.deepEqual(list[0].achievements, { unlocked: 1, total: 3 });
});

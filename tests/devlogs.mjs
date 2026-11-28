// Devlogs and patch notes: what a post may hold, who hears about it (followers, library, buyers, recent players; never
// the author, guests or suspended accounts), the daily cap, one patch note per version, and the bell only while the game
// is live. Runs the real modules against SQLite with the real migrations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { LIMITS, cleanPatchNotes, cleanPost, deleteDevlog, editDevlog, listDevlogs, postDevlog } from '../src/devlogs.js';
import { feed, unreadCount } from '../src/follows.js';

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
  for (const [id, status] of [['u_owner', 'active'], ['u_fan', 'active'], ['u_lib', 'active'], ['u_buyer', 'active'], ['u_recent', 'active'], ['u_old', 'active'], ['u_gone', 'suspended'], ['u_other', 'active']]) q('INSERT INTO users (id, email, name, pw_hash, status, created_at) VALUES (?, ?, ?, \'\', ?, 1)', id, id + '@example.com', id, status);
  q("INSERT INTO projects (id, owner_id, slug, title, status, created_at, updated_at) VALUES ('g1', 'u_owner', 'game-one', 'Game One', 'live', 1, 1)");
  q("INSERT INTO projects (id, owner_id, slug, title, status, created_at, updated_at) VALUES ('g2', 'u_owner', 'game-two', 'Game Two', 'draft', 1, 1)");
  q("INSERT INTO follows (follower_id, creator_id, created_at) VALUES ('u_fan', 'u_owner', 1), ('u_gone', 'u_owner', 1)");
  q("INSERT INTO library_games (user_id, project_id, added_at) VALUES ('u_lib', 'g1', 1), ('u_fan', 'g1', 1)");
  q("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, status, created_at) VALUES ('pu1', 'u_buyer', 'g1', 'u_owner', 500, 50, 450, 'admin', 'paid', 1)");
  q("INSERT INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds) VALUES ('g1', 'u_recent', 1, ?, 1, 60), ('g1', 'u_old', 1, ?, 1, 60), ('g1', 'guest_x', 1, ?, 1, 60), ('g1', 'u_owner', 1, ?, 1, 60)", T - DAY, T - 200 * DAY, T - DAY, T - DAY);
  return db;
}
const G1 = { id: 'g1', owner_id: 'u_owner', status: 'live' };

test('a post is checked', () => {
  assert.deepEqual(cleanPost({ title: '  Big   update ', body: 'Line 1\r\n\n\n\nLine 2  ' }), { title: 'Big update', body: 'Line 1\n\nLine 2' });
  assert.throws(() => cleanPost({ title: '', body: 'x' }), /title is required/);
  assert.throws(() => cleanPost({ title: 'x', body: ' ' }), /body is required/);
  assert.throws(() => cleanPost({ title: 'x'.repeat(LIMITS.title + 1), body: 'x' }), /at most 120/);
  assert.throws(() => cleanPost({ title: 'x', body: 'x'.repeat(LIMITS.body + 1) }), /at most 5000/);
  assert.equal(cleanPatchNotes(undefined, 3), null);
  assert.deepEqual(cleanPatchNotes('Fixed the jump', 3), { title: 'Version 3', body: 'Fixed the jump' });
  assert.deepEqual(cleanPatchNotes({ title: 'Winter update', body: 'Snow' }, 3), { title: 'Winter update', body: 'Snow' });
});

test('the game\'s audience hears about a post once each, never the author, guests, lapsed players or suspended accounts', async () => {
  const db = world();
  const r = await postDevlog(db, G1, 'u_owner', { title: 'Patch 1.1', body: 'Faster loading.' }, { t: T });
  const told = db.sql.prepare("SELECT user_id FROM notifications WHERE kind = 'devlog' ORDER BY user_id").all().map((x) => x.user_id);
  assert.deepEqual(told, ['u_buyer', 'u_fan', 'u_lib', 'u_recent']);
  assert.equal(r.notified, 4);
  assert.deepEqual([...r.live].sort(), ['u_buyer', 'u_fan', 'u_lib', 'u_recent']);
  assert.equal(await unreadCount(db, 'u_fan'), 1);
  const f = await feed(db, 'u_fan');
  assert.equal(f.items[0].kind, 'devlog'); assert.equal(f.items[0].game.slug, 'game-one'); assert.equal(f.items[0].data.devlog, r.id);
  db.sql.prepare("UPDATE projects SET status = 'offline' WHERE id = 'g1'").run();
  assert.equal(await unreadCount(db, 'u_fan'), 0, 'a game taken offline drops out of the bell');
});

test('a game that is not live gets no announcement; at most 3 posts a day', async () => {
  const db = world();
  const r = await postDevlog(db, { id: 'g2', owner_id: 'u_owner', status: 'draft' }, 'u_owner', { title: 'Soon', body: 'Soon.' }, { t: T });
  assert.equal(r.notified, 0);
  for (let i = 0; i < 3; i++) await postDevlog(db, G1, 'u_owner', { title: 'Post ' + i, body: 'b' }, { t: T + i });
  await assert.rejects(postDevlog(db, G1, 'u_owner', { title: 'Too many', body: 'b' }, { t: T + 10 }), (e) => e.status === 429);
  await postDevlog(db, G1, 'u_owner', { title: 'Next day', body: 'b' }, { t: T + DAY + 10 });
});

test('one patch note per version, posted quietly on a first release', async () => {
  const db = world();
  const a = await postDevlog(db, G1, 'u_owner', { title: 'Version 2', body: 'x' }, { kind: 'patch', version: 2, announce: false, t: T });
  assert.equal(a.notified, 0);
  const b = await postDevlog(db, G1, 'u_owner', { title: 'Version 2 again', body: 'y' }, { kind: 'patch', version: 2, t: T });
  assert.equal(b.existing, true); assert.equal(b.id, a.id);
  for (let i = 0; i < 5; i++) await postDevlog(db, G1, 'u_owner', { title: 'v' + (3 + i), body: 'z' }, { kind: 'patch', version: 3 + i, t: T + i });
  const list = await listDevlogs(db, 'g1', { limit: 3 });
  assert.equal(list.devlogs.length, 3); assert.equal(list.devlogs[0].version, 7); assert.ok(list.more);
  const rest = await listDevlogs(db, 'g1', { limit: 10, before: list.more });
  assert.equal(rest.devlogs.length, 3); assert.equal(rest.more, null);
});

test('edits and deletes stay within the game; a delete takes its announcements with it', async () => {
  const db = world();
  const r = await postDevlog(db, G1, 'u_owner', { title: 'Hello', body: 'World' }, { t: T });
  await assert.rejects(editDevlog(db, 'g2', r.id, { title: 'x', body: 'y' }), (e) => e.status === 404);
  await editDevlog(db, 'g1', r.id, { title: 'Hello again', body: 'World' }, T + 5);
  const [d] = (await listDevlogs(db, 'g1')).devlogs;
  assert.equal(d.title, 'Hello again'); assert.equal(d.edited_at, T + 5);
  await assert.rejects(deleteDevlog(db, 'g2', r.id), (e) => e.status === 404);
  await deleteDevlog(db, 'g1', r.id);
  assert.equal((await listDevlogs(db, 'g1')).devlogs.length, 0);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'devlog'").get().n, 0);
});

// Parties (src/parties.js): starting one, inviting friends only, the size limit, blocks, accepting (which leaves the old
// party), leaving and handing leadership on, the leader's powers, voice and who may send voice messages, account deletion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { accept, canSignal, create, decline, deleteStatements, invite, kick, leave, LIMITS, memberIds, partyOf, promote, setGame, setVoice, view } from '../src/parties.js';

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
const IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'x'];
function world() {
  const db = d1(), q = (s, ...a) => db.sql.prepare(s).run(...a);
  for (const u of IDS) q("INSERT INTO users (id, email, name, pw_hash, status, created_at) VALUES (?, ?, ?, '', 'active', 1)", u, u + '@x', 'Name ' + u);
  const friends = (x, y) => { q('INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, 1)', x, y); q('INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, 1)', y, x); };
  for (const u of IDS.slice(1, 9)) friends('a', u);
  friends('x', 'b');
  q("INSERT INTO projects (id, owner_id, slug, title, status, live_version, price_cents, created_at, updated_at) VALUES ('g1', 'x', 'g1', 'Game one', 'live', 1, 0, 1, 1)");
  return { db, q, friends };
}
const code = (e) => (err) => err.code === e;

test('a leader invites friends only; members join, up to the limit', async () => {
  const { db } = world();
  await assert.rejects(invite(db, 'a', 'x'), code('not_friends'));
  const r = await invite(db, 'a', 'b', 1000);
  assert.equal(await partyOf(db, 'a'), r.party);                          // inviting started a party
  assert.equal((await view(db, 'b', 1000)).invites[0].from.name, 'Name a');
  await assert.rejects(accept(db, 'b', r.party, 1000 + LIMITS.invite_ms + 1), code('invite_gone'));
  await invite(db, 'a', 'b', 2000);
  await accept(db, 'b', r.party, 2000);
  assert.deepEqual(await memberIds(db, r.party), ['a', 'b']);
  const v = await view(db, 'b', 2000);
  assert.equal(v.party.leader, 'a'); assert.equal(v.party.me_leader, false); assert.equal(v.invites.length, 0);
  await assert.rejects(invite(db, 'a', 'b', 2000), code('already_in'));
  for (const u of ['c', 'd', 'e', 'f', 'g', 'h']) { await invite(db, 'a', u, 3000); await accept(db, u, r.party, 3000); }
  assert.equal((await memberIds(db, r.party)).length, LIMITS.members);
  await assert.rejects(invite(db, 'a', 'i', 3000), code('party_full'));
});

test('blocks keep a player out; declining clears the invite', async () => {
  const { db, q } = world();
  const r = await invite(db, 'a', 'b'); await accept(db, 'b', r.party);
  q('INSERT INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, 1)', 'b', 'c');
  await assert.rejects(invite(db, 'a', 'c'), code('blocked'));
  await invite(db, 'a', 'd'); await decline(db, 'd', r.party);
  await assert.rejects(accept(db, 'd', r.party), code('invite_gone'));
});

test('accepting another invite leaves the old party; leaders hand on; the last one out ends it', async () => {
  const { db } = world();
  const p1 = (await invite(db, 'a', 'b', 10)).party; await accept(db, 'b', p1, 11);
  const p2 = (await invite(db, 'x', 'b', 20)).party;
  const r = await accept(db, 'b', p2, 21);
  assert.equal(r.left.party, p1); assert.deepEqual(r.left.members, ['a']);
  assert.deepEqual(await memberIds(db, p2), ['x', 'b']);
  // the leader leaves: the member who has been in longest leads
  const l = await leave(db, 'x');
  assert.equal(l.leader, 'b');
  assert.equal((await view(db, 'b')).party.me_leader, true);
  const end = await leave(db, 'b');
  assert.equal(end.ended, true);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM parties WHERE id = ?').bind(p2).first()).n, 0);
});

test('only the leader kicks, promotes and brings the party into a game', async () => {
  const { db } = world();
  const p = (await invite(db, 'a', 'b')).party; await accept(db, 'b', p); await invite(db, 'a', 'c'); await accept(db, 'c', p);
  await assert.rejects(kick(db, 'b', 'c'), code('not_leader'));
  await assert.rejects(setGame(db, 'b', 'g1'), code('not_leader'));
  await assert.rejects(setGame(db, 'a', 'nope'), code('not_found'));
  assert.equal((await setGame(db, 'a', 'g1')).game.title, 'Game one');
  assert.equal((await view(db, 'c')).party.game.slug, 'g1');
  await kick(db, 'a', 'c');
  assert.equal(await partyOf(db, 'c'), null);
  await promote(db, 'a', 'b');
  assert.equal((await view(db, 'a')).party.leader, 'b');
});

test('voice: who is in, and voice messages only inside the party', async () => {
  const { db } = world();
  const p = (await invite(db, 'a', 'b')).party; await accept(db, 'b', p);
  assert.deepEqual((await setVoice(db, 'a', true)).in_voice, []);
  assert.deepEqual((await setVoice(db, 'b', true)).in_voice, ['a']);
  assert.deepEqual((await view(db, 'a')).party.members.map((m) => m.voice), [true, true]);
  assert.equal(await canSignal(db, 'a', 'b'), true);
  assert.equal(await canSignal(db, 'a', 'c'), false);
  assert.equal(await canSignal(db, 'a', 'a'), false);
  await assert.rejects(setVoice(db, 'c', true), code('no_party'));
});

test('account deletion leaves the party and passes leadership', async () => {
  const { db } = world();
  const p = (await invite(db, 'a', 'b')).party; await accept(db, 'b', p); await invite(db, 'a', 'c');
  await db.batch(deleteStatements(db, 'a'));
  assert.deepEqual(await memberIds(db, p), ['b']);
  assert.equal((await view(db, 'b')).party.leader, 'b');
  assert.equal((await view(db, 'c')).invites.length, 0);
  await db.batch(deleteStatements(db, 'b'));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM parties').first()).n, 0);
});

// Friends, requests, blocks, privacy, chat, invites, reports and presence: the rules in src/social-rules.js against SQLite
// with the real migrations, and the presence rules in src/presence.js. The SocialHub Durable Object only carries these.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as R from '../src/social-rules.js';
import { AWAY_AFTER_MS, forGame, nextChange, presenceOf } from '../src/presence.js';

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
async function user(db, id, name = id, status = 'active') {
  db.sql.prepare('INSERT INTO users (id, email, name, pw_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 0)').run(id, id + '@x.test', name, 'x', status);
  await R.ensureProfile(db, { id, name });
}
function game(db, id, status = 'live') {
  db.sql.prepare('INSERT INTO projects (id, owner_id, slug, title, status, price_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0)').run(id, 'u_creator', 'slug-' + id, 'Game ' + id, status);
}
async function world() {
  const db = d1();
  for (const [id, name] of [['u_ann', 'Ann'], ['u_ben', 'Ben'], ['u_cat', 'Cat'], ['u_dan', 'Dan']]) await user(db, id, name);
  game(db, 'g1'); game(db, 'g2', 'draft');
  return db;
}
async function friends(db, a, b) { await R.sendRequest(db, a, b); await R.acceptRequest(db, b, a); }
const code = (e) => (x) => x instanceof R.SocialError && x.code === e;

test('a friend request becomes a friendship only when the other player accepts, with a notification each way', async () => {
  const db = await world();
  assert.deepEqual(await R.sendRequest(db, 'u_ann', 'u_ben'), { state: 'requested', notify: 'u_ben' });
  assert.equal(await R.relation(db, 'u_ann', 'u_ben'), 'requested');
  assert.equal(await R.relation(db, 'u_ben', 'u_ann'), 'incoming');
  assert.equal(await R.areFriends(db, 'u_ann', 'u_ben'), false);
  const c = await R.counts(db, 'u_ben');
  assert.equal(c.requests, 1); assert.equal(c.notifications, 1);
  assert.equal((await R.notificationList(db, 'u_ben'))[0].kind, 'friend_request');
  // asking again changes nothing
  assert.equal((await R.sendRequest(db, 'u_ann', 'u_ben')).state, 'requested');
  await R.acceptRequest(db, 'u_ben', 'u_ann');
  assert.equal(await R.areFriends(db, 'u_ann', 'u_ben'), true);
  assert.equal(await R.areFriends(db, 'u_ben', 'u_ann'), true);
  assert.equal((await R.counts(db, 'u_ben')).requests, 0);
  assert.equal((await R.notificationList(db, 'u_ann'))[0].kind, 'friend_accepted');
  assert.deepEqual((await R.listFriends(db, 'u_ann')).map((f) => f.name), ['Ben']);
});

test('asking someone who already asked you makes you friends at once; declining and cancelling leave no friendship', async () => {
  const db = await world();
  await R.sendRequest(db, 'u_ann', 'u_ben');
  assert.equal((await R.sendRequest(db, 'u_ben', 'u_ann')).state, 'friends');
  assert.equal(await R.areFriends(db, 'u_ann', 'u_ben'), true);
  await R.sendRequest(db, 'u_cat', 'u_dan');
  await R.declineRequest(db, 'u_dan', 'u_cat');
  assert.equal(await R.relation(db, 'u_cat', 'u_dan'), 'none');
  await R.sendRequest(db, 'u_cat', 'u_ann');
  await R.cancelRequest(db, 'u_cat', 'u_ann');
  assert.equal((await R.counts(db, 'u_ann')).requests, 0);
  await assert.rejects(R.acceptRequest(db, 'u_ann', 'u_cat'), code('not_found'));
  await assert.rejects(R.sendRequest(db, 'u_ann', 'u_ann'), code('self'));
  await assert.rejects(R.sendRequest(db, 'u_ann', 'u_nobody'), code('not_found'));
});

test('privacy: who may send requests is the receiver\'s choice, and friend caps hold', async () => {
  const db = await world();
  await R.updateProfile(db, 'u_ben', { requests_from: 'nobody' });
  await assert.rejects(R.sendRequest(db, 'u_ann', 'u_ben'), code('not_allowed'));
  await R.updateProfile(db, 'u_ben', { requests_from: 'friends_of_friends' });
  await assert.rejects(R.sendRequest(db, 'u_ann', 'u_ben'), code('not_allowed'));
  await friends(db, 'u_ann', 'u_cat'); await friends(db, 'u_ben', 'u_cat');
  assert.equal((await R.sendRequest(db, 'u_ann', 'u_ben')).state, 'requested');
  await assert.rejects(R.sendRequest(db, 'u_dan', 'u_ann', { ...R.LIMITS, friends_max: 1 }), code('friends_full'));
  await assert.rejects(R.updateProfile(db, 'u_ann', { status: 'sleeping' }), /status/);
  await assert.rejects(R.updateProfile(db, 'u_ann', { searchable: 'yes' }), /searchable/);
});

test('search finds a friend code always and a name only when the player allows it; blocks hide both ways', async () => {
  const db = await world();
  const ben = await R.getProfile(db, 'u_ben');
  assert.match(ben.code, /^[A-Z0-9]{8}$/);
  assert.deepEqual((await R.search(db, 'u_ann', 'be')).map((r) => r.name), ['Ben']);
  assert.deepEqual((await R.search(db, 'u_ann', R.showCode(ben.code).toLowerCase())).map((r) => r.id), ['u_ben']);
  await R.updateProfile(db, 'u_ben', { searchable: false });
  assert.deepEqual(await R.search(db, 'u_ann', 'ben'), []);
  assert.equal((await R.search(db, 'u_ann', ben.code)).length, 1);
  await R.block(db, 'u_ben', 'u_ann');
  assert.deepEqual(await R.search(db, 'u_ann', ben.code), []);
  assert.deepEqual(await R.search(db, 'u_ben', 'ann'), []);
  assert.deepEqual(await R.search(db, 'u_ann', 'a'), [], 'one letter searches no names');
});

test('blocking ends the friendship, cancels invites and stops requests, messages and invites; unblocking does not refriend', async () => {
  const db = await world();
  await friends(db, 'u_ann', 'u_ben');
  const inv = await R.createInvite(db, { from: 'u_ann', to: 'u_ben', project: 'g1', online: 'online' });
  await R.block(db, 'u_ben', 'u_ann');
  assert.equal(await R.areFriends(db, 'u_ann', 'u_ben'), false);
  assert.equal(await R.relation(db, 'u_ben', 'u_ann'), 'blocked');
  assert.equal(await R.relation(db, 'u_ann', 'u_ben'), 'blocked_by');
  await assert.rejects(R.answerInvite(db, 'u_ben', inv.id, true), code('gone'));
  await assert.rejects(R.sendRequest(db, 'u_ann', 'u_ben'), code('not_allowed'));
  await assert.rejects(R.sendRequest(db, 'u_ben', 'u_ann'), code('blocked'));
  await assert.rejects(R.sendMessage(db, 'u_ann', 'u_ben', 'hi'), code('not_allowed'));
  assert.deepEqual((await R.listBlocked(db, 'u_ben')).map((b) => b.id), ['u_ann']);
  await R.unblock(db, 'u_ben', 'u_ann');
  assert.equal(await R.relation(db, 'u_ben', 'u_ann'), 'none');
  await friends(db, 'u_ann', 'u_cat');
  await R.removeFriend(db, 'u_cat', 'u_ann');
  assert.equal(await R.areFriends(db, 'u_ann', 'u_cat'), false);
});

test('chat: only friends, cleaned text, paged history, unread counts per friend and read marks', async () => {
  const db = await world();
  await assert.rejects(R.sendMessage(db, 'u_ann', 'u_ben', 'hello'), code('not_friends'));
  await friends(db, 'u_ann', 'u_ben');
  await assert.rejects(R.sendMessage(db, 'u_ann', 'u_ben', '   \n  '), /Write something/);
  const m = await R.sendMessage(db, 'u_ann', 'u_ben', ' hi‮\n\n\n\nthere ');
  assert.equal(m.body, 'hi\n\nthere');
  assert.equal(R.cleanBody('x'.repeat(900)).length, R.LIMITS.message_max);
  for (let i = 0; i < 5; i++) await R.sendMessage(db, 'u_ann', 'u_ben', 'm' + i);
  const c = await R.counts(db, 'u_ben');
  assert.equal(c.messages, 6); assert.equal(c.chats.u_ann, 6);
  const page = await R.conversation(db, 'u_ben', 'u_ann', null, 4);
  assert.deepEqual(page.messages.map((x) => x.body), ['m1', 'm2', 'm3', 'm4']); assert.equal(page.more, true);
  const older = await R.conversation(db, 'u_ben', 'u_ann', page.messages[0].id, 4);
  assert.deepEqual(older.messages.map((x) => x.body), ['hi\n\nthere', 'm0']); assert.equal(older.more, false);
  await R.markRead(db, 'u_ben', 'u_ann');
  assert.equal((await R.counts(db, 'u_ben')).messages, 0);
  await R.updateProfile(db, 'u_ben', { messages_from: 'nobody' });
  await assert.rejects(R.sendMessage(db, 'u_ann', 'u_ben', 'still there?'), code('not_allowed'));
});

test('invites go only to friends who are online, away or busy; never invisible (shown offline) or offline', async () => {
  const db = await world();
  await friends(db, 'u_ann', 'u_ben');
  for (const s of ['offline', 'invisible', undefined]) await assert.rejects(R.createInvite(db, { from: 'u_ann', to: 'u_ben', project: 'g1', online: s }), code('not_online'));
  for (const s of ['online', 'away', 'busy']) assert.match((await R.createInvite(db, { from: 'u_ann', to: 'u_ben', project: 'g1', online: s })).id, /^inv_/);
  // one waits at a time per sender, receiver and game: the newest
  assert.equal((await R.pendingInvites(db, 'u_ben')).length, 1);
  assert.equal((await R.counts(db, 'u_ben')).invites, 1);
  await assert.rejects(R.createInvite(db, { from: 'u_ann', to: 'u_cat', project: 'g1', online: 'online' }), code('not_friends'));
  await assert.rejects(R.createInvite(db, { from: 'u_ann', to: 'u_ben', project: 'g2', online: 'online' }), code('offline'));
  await R.updateProfile(db, 'u_ben', { invites_from: 'nobody' });
  await assert.rejects(R.createInvite(db, { from: 'u_ann', to: 'u_ben', project: 'g1', online: 'online' }), code('not_allowed'));
});

test('an invite shows in the chat, is answered once, expires, and leads into the inviter\'s lobby only for the invitee', async () => {
  const db = await world(), t = Date.now();
  await friends(db, 'u_ann', 'u_ben');
  const inv = await R.createInvite(db, { from: 'u_ann', to: 'u_ben', project: 'g1', kind: 'match', data: { lobby: 'tok.en-lobby_123', players: 4, label: 'Private\ncourt', data: { side: 'left' } }, online: 'online' }, t);
  assert.equal(inv.label, 'Private court');
  const chat = await R.conversation(db, 'u_ben', 'u_ann');
  assert.equal(chat.messages[0].kind, 'invite'); assert.equal(chat.messages[0].invite.status, 'sent');
  assert.equal(await R.acceptedInvite(db, 'u_ben', inv.id, 'g1', 'live', t), null, 'not before it is accepted');
  const a = await R.answerInvite(db, 'u_ben', inv.id, true, t + 1000);
  assert.deepEqual(a.join, { id: inv.id, kind: 'match', from: { id: 'u_ann', name: 'Ann' }, match: true, players: 4, label: 'Private court', data: { side: 'left' } });
  assert.equal(JSON.stringify(a.join).includes('lobby_123'), false, 'the lobby token never reaches the game');
  assert.equal((await R.acceptedInvite(db, 'u_ben', inv.id, 'g1', 'live', t + 2000)).lobby, 'tok.en-lobby_123');
  assert.equal(await R.acceptedInvite(db, 'u_cat', inv.id, 'g1', 'live', t + 2000), null, 'someone else cannot use it');
  assert.equal(await R.acceptedInvite(db, 'u_ben', inv.id, 'g1', 'preview', t + 2000), null);
  assert.equal(await R.acceptedInvite(db, 'u_ben', inv.id, 'g1', 'live', t + 1000 + R.ACCEPTED_USE_MS + 1), null, 'an old yes runs out');
  assert.equal((await R.answerInvite(db, 'u_ben', inv.id, true, t + 3000)).join.id, inv.id, 'accepting again just leads there again');
  await assert.rejects(R.answerInvite(db, 'u_ben', inv.id, false, t + 3000), code('gone'));
  const late = await R.createInvite(db, { from: 'u_ann', to: 'u_ben', project: 'g1', online: 'away' }, t);
  await assert.rejects(R.answerInvite(db, 'u_ben', late.id, true, t + R.INVITE_TTL_MS.game + 1), code('expired'));
  const gone = await R.createInvite(db, { from: 'u_ann', to: 'u_ben', project: 'g1', online: 'busy' }, t);
  assert.equal((await R.cancelInvite(db, 'u_ann', gone.id, t)).to, 'u_ben');
  await assert.rejects(R.answerInvite(db, 'u_ben', gone.id, true, t), code('gone'));
  assert.throws(() => R.cleanInviteData({ lobby: 'x' }), /cannot be joined/);
  assert.throws(() => R.cleanInviteData({ data: 'x'.repeat(2000) }), /1 KB/);
});

test('"Join" on a friend works only while they let friends join', async () => {
  const db = await world();
  await friends(db, 'u_ann', 'u_ben');
  const j = await R.createJoin(db, { me: 'u_ben', friend: 'u_ann', project: 'g1', data: { lobby: 'lobby-token-0001', players: 2 } });
  assert.equal(j.kind, 'join'); assert.equal(j.match, true); assert.equal(j.from.name, 'Ann');
  assert.equal((await R.acceptedInvite(db, 'u_ben', j.id, 'g1', 'live')).lobby, 'lobby-token-0001');
  await R.updateProfile(db, 'u_ann', { joinable: false });
  await assert.rejects(R.createJoin(db, { me: 'u_ben', friend: 'u_ann', project: 'g1', data: { lobby: 'lobby-token-0001' } }), code('not_allowed'));
  await assert.rejects(R.createJoin(db, { me: 'u_cat', friend: 'u_ann', project: 'g1', data: { lobby: 'lobby-token-0001' } }), code('not_friends'));
});

test('a report keeps a copy of the reported player\'s recent messages and is not filed twice within the hour', async () => {
  const db = await world();
  await friends(db, 'u_ann', 'u_ben');
  await R.sendMessage(db, 'u_ann', 'u_ben', 'rude thing');
  await R.sendMessage(db, 'u_ben', 'u_ann', 'please stop');
  const r = await R.report(db, 'u_ben', 'u_ann', 'harassment', 'kept going');
  assert.match(r.id, /^rep_/);
  const row = db.sql.prepare('SELECT * FROM social_reports WHERE id = ?').get(r.id);
  assert.deepEqual(JSON.parse(row.context).messages.map((m) => m.body), ['rude thing']);
  assert.equal((await R.report(db, 'u_ben', 'u_ann', 'spam')).already, true);
  await assert.rejects(R.report(db, 'u_ben', 'u_ann', 'meh'), /reason/);
  await assert.rejects(R.report(db, 'u_ben', 'u_ben', 'spam'), code('self'));
});

test('deleting an account removes its friends, requests, chat, invites and blocks; cleanup drops old chat', async () => {
  const db = await world();
  await friends(db, 'u_ann', 'u_ben'); await R.sendRequest(db, 'u_ann', 'u_cat'); await R.block(db, 'u_ann', 'u_dan');
  await R.sendMessage(db, 'u_ann', 'u_ben', 'hi');
  await R.createInvite(db, { from: 'u_ann', to: 'u_ben', project: 'g1', online: 'online' });
  for (const s of R.deleteAccountStmts(db, 'u_ann')) await s.run();
  for (const [table, col] of [['friendships', 'user_id'], ['friendships', 'friend_id'], ['friend_requests', 'from_id'], ['blocks', 'user_id'], ['dm_messages', 'from_id'], ['game_invites', 'from_id'], ['social_profiles', 'user_id']])
    assert.equal(db.sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = 'u_ann'`).get().n, 0, `${table}.${col}`);
  await friends(db, 'u_ben', 'u_cat');
  await R.sendMessage(db, 'u_ben', 'u_cat', 'old', 1000);
  await R.sendMessage(db, 'u_ben', 'u_cat', 'new');
  for (const s of R.cleanupStmts(db, Date.now(), 30)) await s.run();
  assert.deepEqual((await R.conversation(db, 'u_cat', 'u_ben')).messages.map((m) => m.body), ['new']);
});

test('presence: chosen status, automatic Away, Invisible looks offline, the game and its time, hidden games and Join', () => {
  const t = 10_000_000, g = { id: 'g1', slug: 's', title: 'Noctelle' };
  const prof = { status: 'online', show_game: 1, joinable: 1 };
  assert.deepEqual(presenceOf([], prof, t).shown, { s: 'offline' });
  const page = { vis: true, hidAt: null, at: t - 1000, act: null, actAt: 0 };
  assert.equal(presenceOf([page], prof, t).shown.s, 'online');
  assert.equal(presenceOf([page], { ...prof, status: 'busy' }, t).shown.s, 'busy');
  assert.equal(presenceOf([page], { ...prof, status: 'away' }, t).shown.s, 'away');
  const hidden = { ...page, vis: false, hidAt: t - AWAY_AFTER_MS - 1 };
  assert.equal(presenceOf([hidden], prof, t).shown.s, 'away');
  assert.equal(presenceOf([hidden, page], prof, t).shown.s, 'online', 'one page in view keeps it online');
  assert.equal(nextChange([{ ...page, vis: false, hidAt: t - 1000 }], prof, t), t - 1000 + AWAY_AFTER_MS);
  const inv = presenceOf([page], { ...prof, status: 'invisible' }, t);
  assert.deepEqual(inv.shown, { s: 'offline' }); assert.equal(inv.self.s, 'invisible');
  const playing = { ...page, act: { g, since: t - 600_000, detail: 'Private court', lobby: 'tok' }, actAt: t - 600_000 };
  assert.deepEqual(presenceOf([page, playing], prof, t).shown, { s: 'online', game: g, since: t - 600_000, detail: 'Private court', joinable: true });
  assert.deepEqual(presenceOf([playing], { ...prof, show_game: 0 }, t).shown, { s: 'online' });
  assert.equal(presenceOf([playing], { ...prof, joinable: 0 }, t).shown.joinable, undefined);
  const seen = forGame(presenceOf([playing], prof, t).shown, 'g1');
  assert.deepEqual(seen, { status: 'online', playing: { here: true, title: 'Noctelle', detail: 'Private court' }, since: t - 600_000, joinable: true });
  assert.equal(forGame(presenceOf([playing], prof, t).shown, 'g9').joinable, false, 'another game cannot join it');
  assert.deepEqual(forGame(undefined, 'g1'), { status: 'offline', playing: null, since: null, joinable: false });
});

// Following creators and the notification bell: the rules in src/follows.js against SQLite with the real migrations,
// the push text for a new game (src/push-core.ts), and the split between the Friends panel and the bell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as F from '../src/follows.js';
import * as R from '../src/social-rules.js';
import { noteFor, PUSH_KINDS } from '../src/push-core.ts';

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
function user(db, id, name = id, { status = 'active', creator = 0, created = 1000 } = {}) {
  db.sql.prepare('INSERT INTO users (id, email, name, pw_hash, status, creator, creator_since, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, id + '@x.test', name, 'x', status, creator, creator ? created + 5 : null, created);
}
function game(db, id, owner, { status = 'live', plays = 0, published = 2000, rating = [0, 0], hidden = null } = {}) {
  db.sql.prepare('INSERT INTO projects (id, owner_id, slug, title, status, plays, rating_sum, rating_count, published_at, hidden_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)')
    .run(id, owner, 'slug-' + id, 'Game ' + id, status, plays, rating[0], rating[1], status === 'draft' ? null : published, hidden);
}
function world() {
  const db = d1();
  user(db, 'u_maker', 'Maker', { created: 111 });     // a creator with games
  user(db, 'u_new', 'Newcomer', { creator: 1 });     // a licensed creator with nothing live yet
  user(db, 'u_ann', 'Ann'); user(db, 'u_ben', 'Ben'); user(db, 'u_gone', 'Gone', { status: 'suspended' });
  game(db, 'g1', 'u_maker', { plays: 120, rating: [18, 4], published: 3000 });
  game(db, 'g2', 'u_maker', { plays: 30, rating: [5, 1], published: 5000 });
  game(db, 'g3', 'u_maker', { status: 'draft' });
  game(db, 'g4', 'u_maker', { plays: 999, hidden: 1 });  // hidden by player reports: not in the totals
  return db;
}
const code = (c) => (e) => e instanceof F.FollowError && e.code === c;

test('a creator profile shows public facts only: joined, games, plays, rating and followers', async () => {
  const db = world();
  const p = await F.profile(db, 'u_maker', null);
  assert.equal(p.creator.name, 'Maker');
  assert.equal(p.creator.joined_at, 111);
  assert.equal(p.creator.games, 2);
  assert.equal(p.creator.plays, 150);
  assert.equal(p.creator.rating, 4.6);
  assert.equal(p.creator.rating_count, 5);
  assert.equal(p.creator.first_release, 3000);
  assert.equal(p.creator.latest_release, 5000);
  assert.equal(p.creator.followers, 0);
  assert.deepEqual(p.viewer, { signed_in: false, self: false, following: false });
  // nothing private leaks
  const text = JSON.stringify(p);
  assert.ok(!text.includes('@x.test') && !text.includes('pw_hash') && !text.includes('last_seen'), text);
  // a licensed creator with no game yet has a profile; a player and a suspended account do not
  assert.equal((await F.profile(db, 'u_new')).creator.games, 0);
  assert.equal(await F.profile(db, 'u_ann'), null);
  assert.equal(await F.profile(db, 'u_gone'), null);
  assert.equal(await F.profile(db, "x' OR 1=1 --"), null);
  assert.equal((await F.profile(db, 'u_maker', 'u_maker')).viewer.self, true);
});

test('follow and unfollow: idempotent, counted, never yourself, only creators', async () => {
  const db = world();
  assert.deepEqual(await F.follow(db, 'u_ann', 'u_maker'), { following: true, followers: 1 });
  assert.deepEqual(await F.follow(db, 'u_ann', 'u_maker'), { following: true, followers: 1 });   // twice changes nothing
  await F.follow(db, 'u_ben', 'u_maker');
  assert.equal((await F.profile(db, 'u_maker', 'u_ann')).creator.followers, 2);
  assert.equal((await F.profile(db, 'u_maker', 'u_ann')).viewer.following, true);
  assert.deepEqual((await F.followingList(db, 'u_ann')).map((c) => [c.name, c.games]), [['Maker', 2]]);
  assert.deepEqual(await F.unfollow(db, 'u_ann', 'u_maker'), { following: false, followers: 1 });
  assert.deepEqual(await F.unfollow(db, 'u_ann', 'u_maker'), { following: false, followers: 1 });
  assert.equal((await F.profile(db, 'u_maker', 'u_ann')).viewer.following, false);
  await assert.rejects(F.follow(db, 'u_maker', 'u_maker'), code('self_follow'));
  await assert.rejects(F.follow(db, 'u_ann', 'u_ben'), code('not_found'));     // a player, not a creator
  await assert.rejects(F.follow(db, 'u_ann', 'u_gone'), code('not_found'));
  await assert.rejects(F.follow(db, 'u_ann', ''), code('bad_request'));
  // a suspended follower does not count
  db.sql.prepare("UPDATE users SET status = 'suspended' WHERE id = 'u_ben'").run();
  assert.equal(await F.followerCount(db, 'u_maker'), 0);
});

test('following has a ceiling, and a block ends a follow and stops a new one', async () => {
  const db = world();
  await F.follow(db, 'u_ann', 'u_maker', { ...F.LIMITS, following_max: 1 });
  await assert.rejects(F.follow(db, 'u_ann', 'u_new', { ...F.LIMITS, following_max: 1 }), code('following_max'));
  await R.ensureProfile(db, { id: 'u_maker', name: 'Maker' }); await R.ensureProfile(db, { id: 'u_ann', name: 'Ann' });
  await R.block(db, 'u_maker', 'u_ann');
  assert.equal(await F.isFollowing(db, 'u_ann', 'u_maker'), false);
  await assert.rejects(F.follow(db, 'u_ann', 'u_maker'), code('not_allowed'));
  await R.unblock(db, 'u_maker', 'u_ann');
  assert.equal((await F.follow(db, 'u_ann', 'u_maker')).following, true);
});

test('a new game notifies every active follower once, and shows under the bell until read', async () => {
  const db = world();
  await F.follow(db, 'u_ann', 'u_maker'); await F.follow(db, 'u_ben', 'u_maker');
  user(db, 'u_cat', 'Cat'); await F.follow(db, 'u_cat', 'u_maker');
  db.sql.prepare("UPDATE users SET status = 'suspended' WHERE id = 'u_cat'").run();
  game(db, 'g5', 'u_maker', { published: 9000 });
  const r = await F.announceNewGame(db, 'u_maker', 'g5', F.LIMITS, 9001);
  assert.equal(r.notified, 2);
  assert.deepEqual(r.live.sort(), ['u_ann', 'u_ben']);
  // never twice for the same game
  assert.equal((await F.announceNewGame(db, 'u_maker', 'g5')).notified, 0);
  assert.deepEqual((await F.announceNewGame(db, 'u_maker', 'g5')).live, []);
  assert.equal(await F.unreadCount(db, 'u_ann'), 1);
  const page = await F.feed(db, 'u_ann');
  assert.equal(page.items.length, 1);
  const n = page.items[0];
  assert.equal(n.kind, 'new_game'); assert.equal(n.read, false); assert.equal(n.at, 9001);
  assert.deepEqual(n.actor, { id: 'u_maker', name: 'Maker' });
  assert.equal(n.game.slug, 'slug-g5'); assert.equal(n.game.title, 'Game g5');
  // read one; the other follower's stays unread
  assert.deepEqual(await F.markRead(db, 'u_ann', n.id), { ok: true, unread: 0 });
  assert.equal((await F.feed(db, 'u_ann')).items[0].read, true);
  assert.equal(await F.unreadCount(db, 'u_ben'), 1);
  // someone else's notification cannot be marked from another account
  const bens = (await F.feed(db, 'u_ben')).items[0].id;
  await F.markRead(db, 'u_ann', bens);
  assert.equal(await F.unreadCount(db, 'u_ben'), 1);
  await assert.rejects(F.markRead(db, 'u_ben', 'drop table'), code('bad_request'));
  assert.equal((await F.markRead(db, 'u_ben', null)).unread, 0);
});

test('a game taken down drops out of the bell; unfollowing keeps what already arrived', async () => {
  const db = world();
  await F.follow(db, 'u_ann', 'u_maker');
  game(db, 'g6', 'u_maker'); game(db, 'g7', 'u_maker');
  await F.announceNewGame(db, 'u_maker', 'g6'); await F.announceNewGame(db, 'u_maker', 'g7');
  assert.equal(await F.unreadCount(db, 'u_ann'), 2);
  db.sql.prepare("UPDATE projects SET status = 'removed' WHERE id = 'g6'").run();
  assert.equal(await F.unreadCount(db, 'u_ann'), 1);
  assert.deepEqual((await F.feed(db, 'u_ann')).items.map((x) => x.game.slug), ['slug-g7']);
  await F.unfollow(db, 'u_ann', 'u_maker');
  assert.equal(await F.unreadCount(db, 'u_ann'), 1);
  game(db, 'g8', 'u_maker');
  assert.equal((await F.announceNewGame(db, 'u_maker', 'g8')).notified, 0);
});

test('the feed pages newest first', async () => {
  const db = world();
  await F.follow(db, 'u_ann', 'u_maker');
  for (let i = 0; i < 5; i++) { game(db, 'p' + i, 'u_maker'); await F.announceNewGame(db, 'u_maker', 'p' + i, F.LIMITS, 100 + i); }
  const a = await F.feed(db, 'u_ann', { limit: 3 });
  assert.deepEqual(a.items.map((x) => x.game.slug), ['slug-p4', 'slug-p3', 'slug-p2']);
  assert.ok(a.more);
  const b = await F.feed(db, 'u_ann', { limit: 3, before: a.more });
  assert.deepEqual(b.items.map((x) => x.game.slug), ['slug-p1', 'slug-p0']);
  assert.equal(b.more, null);
});

test('friends notifications stay in the Friends panel, the bell has everything else', async () => {
  const db = world();
  for (const [id, name] of [['u_ann', 'Ann'], ['u_ben', 'Ben']]) await R.ensureProfile(db, { id, name });
  await R.sendRequest(db, 'u_ben', 'u_ann');
  await F.follow(db, 'u_ann', 'u_maker'); game(db, 'g9', 'u_maker'); await F.announceNewGame(db, 'u_maker', 'g9');
  assert.equal((await R.counts(db, 'u_ann')).notifications, 1);
  assert.deepEqual((await R.notificationList(db, 'u_ann')).map((n) => n.kind), ['friend_request']);
  assert.equal(await F.unreadCount(db, 'u_ann'), 1);
  assert.deepEqual((await F.feed(db, 'u_ann')).items.map((n) => n.kind), ['new_game']);
  // opening Requests leaves the bell unread, and clearing the bell leaves the request unread
  await R.markNotificationsRead(db, 'u_ann');
  assert.equal(await F.unreadCount(db, 'u_ann'), 1);
  await R.sendRequest(db, 'u_maker', 'u_ann').catch(() => {});
  await F.markRead(db, 'u_ann');
  assert.equal(await F.unreadCount(db, 'u_ann'), 0);
  assert.ok((await R.counts(db, 'u_ann')).notifications >= 1);
});

test('a deleted account follows nobody and is followed by nobody', async () => {
  const db = world();
  await F.follow(db, 'u_ann', 'u_maker'); await F.follow(db, 'u_maker', 'u_new');
  for (const s of F.deleteAccountStmts(db, 'u_maker')) await s.run();
  assert.equal(await F.followerCount(db, 'u_maker'), 0);
  assert.equal(await F.followerCount(db, 'u_new'), 0);
});

test('a new game becomes a push notification in the player\'s language, switchable as "creators"', () => {
  assert.ok(PUSH_KINDS.includes('creators'));
  const ev = { kind: 'new_game', creator: { id: 'u_maker', name: 'Maker' }, game: { slug: 'star-keeper', title: 'Star Keeper', i18n: { ja: { title: '星の番人' } } } };
  assert.deepEqual(noteFor(ev, 'en'), { kind: 'creators', title: 'Maker published a new game: Star Keeper', body: '', url: '/g/star-keeper', tag: 'new_game:star-keeper' });
  assert.match(noteFor(ev, 'ja').title, /星の番人/);
  assert.equal(noteFor({ ...ev, game: {} }, 'en'), null);
});

test('gift notifications (data.project is an object) show under the bell with their game', async () => {
  const db = world();
  db.sql.prepare("INSERT INTO notifications (user_id, kind, actor_id, data, created_at) VALUES ('u_ann', 'gift_received', 'u_ben', ?, 5)").run(JSON.stringify({ project: { id: 'g1', slug: 'slug-g1', title: 'Game g1' }, purchase: 'pu_1' }));
  const page = await F.feed(db, 'u_ann');
  assert.equal(page.items[0].kind, 'gift_received');
  assert.equal(page.items[0].game.slug, 'slug-g1');
  assert.equal(page.items[0].game.id, 'g1');
  assert.equal(await F.unreadCount(db, 'u_ann'), 1);
});

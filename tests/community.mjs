// Creator replies to reviews and the community board (src/community.js): who may reply, the bell, threads and replies,
// locks, pins, hiding, reports, switching the board off, rate limits, and account deletion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { deleteStatements, editPost, LIMITS, moderatePost, removePost, removeReviewReply, reply, replyToReview, reportPost, setBoard, startThread, thread, threads, withReplies } from '../src/community.js';

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
const T = 1_800_000_000_000;
function world() {
  const db = d1(), q = (s, ...a) => db.sql.prepare(s).run(...a);
  for (const u of ['u_c', 'u_a', 'u_b', 'u_d', 'u_e']) q("INSERT INTO users (id, email, name, pw_hash, status, created_at) VALUES (?, ?, ?, '', 'active', 1)", u, u + '@x', 'Name ' + u);
  q("INSERT INTO projects (id, owner_id, slug, title, status, live_version, price_cents, created_at, updated_at) VALUES ('g', 'u_c', 'g', 'Game', 'live', 1, 0, 1, 1)");
  const game = () => db.sql.prepare("SELECT * FROM projects WHERE id = 'g'").get();
  const who = (id, role = 'player') => ({ id, role });
  const notes = (uid, kind) => db.sql.prepare('SELECT * FROM notifications WHERE user_id = ? AND kind = ?').all(uid, kind);
  return { db, q, game, who, notes };
}
const code = (e) => (err) => err.code === e;

test('the creator replies to a review once, can change it, and the reviewer hears about it', async () => {
  const { db, q, game, who, notes } = world();
  q("INSERT INTO reviews (project_id, user_id, rating, body, created_at, updated_at) VALUES ('g', 'u_a', 2, 'Too hard.', 1, 1)");
  await assert.rejects(replyToReview(db, game(), who('u_b'), 'u_a', 'hi'), code('forbidden'));
  await assert.rejects(replyToReview(db, game(), who('u_c'), 'u_b', 'hi'), code('not_found'));
  assert.equal((await replyToReview(db, game(), who('u_c'), 'u_a', 'Thanks! Level 2 is easier since v3.', T)).created, true);
  assert.equal((await replyToReview(db, game(), who('u_c'), 'u_a', 'Thanks! Level 2 is easier since v4.', T + 1)).created, false);
  assert.equal(notes('u_a', 'review_reply').length, 1);
  const [r] = await withReplies(db, 'g', [{ user_id: 'u_a', body: 'Too hard.' }]);
  assert.equal(r.reply.body, 'Thanks! Level 2 is easier since v4.'); assert.equal(r.reply.name, 'Name u_c');
  // an admin may reply too
  await replyToReview(db, game(), who('u_e', 'admin'), 'u_a', 'From the team.');
  await removeReviewReply(db, game(), who('u_c'), 'u_a');
  assert.equal((await withReplies(db, 'g', [{ user_id: 'u_a' }]))[0].reply, null);
});

test('threads and replies: posting, locks, pins, the bell, editing', async () => {
  const { db, game, who, notes } = world();
  await assert.rejects(startThread(db, game(), null, { title: 'Hi there', body: 'x' }), code('unauthenticated'));
  await assert.rejects(startThread(db, game(), who('u_a'), { title: 'Hi', body: 'x' }), code('bad_request'));
  const a = await startThread(db, game(), who('u_a'), { title: 'Best route on level 3?', body: 'I keep falling at the bridge.' }, T);
  const b = await startThread(db, game(), who('u_b'), { title: 'Bug: sound stops', body: 'After the boss.' }, T + 10);
  await reply(db, game(), who('u_b'), a.id, { body: 'Jump early.' }, T + 20);
  await reply(db, game(), who('u_d'), a.id, { body: 'Or take the left path.' }, T + 30);
  assert.equal(notes('u_a', 'board_reply').length, 1);   // once until they read it
  await reply(db, game(), who('u_a'), a.id, { body: 'Thanks!' }, T + 40);
  assert.equal(notes('u_a', 'board_reply').length, 1);   // not for their own reply
  let list = await threads(db, game(), null);
  assert.deepEqual(list.threads.map((x) => [x.id, x.replies]), [[a.id, 3], [b.id, 0]]);
  await assert.rejects(moderatePost(db, game(), who('u_a'), b.id, { pinned: true }), code('forbidden'));
  await moderatePost(db, game(), who('u_c'), b.id, { pinned: true, locked: true });
  list = await threads(db, game(), null);
  assert.equal(list.threads[0].id, b.id); assert.equal(list.threads[0].pinned, true);
  await assert.rejects(reply(db, game(), who('u_a'), b.id, { body: 'me too' }), code('locked'));
  await reply(db, game(), who('u_c'), b.id, { body: 'Fixed in v5.' });   // the creator still can
  const v = await thread(db, game(), who('u_a'), b.id);
  assert.equal(v.posts[0].author.creator, true);
  await assert.rejects(editPost(db, game(), who('u_b'), a.id, { body: 'x' }), code('not_found'));
  await editPost(db, game(), who('u_a'), a.id, { title: 'Best route on level 3', body: 'Solved, thanks all.' });
  assert.equal((await thread(db, game(), null, a.id)).thread.title, 'Best route on level 3');
});

test('hiding, reports and removing: players see removed posts as empty, the creator sees them', async () => {
  const { db, game, who } = world();
  const th = await startThread(db, game(), who('u_a'), { title: 'Trading codes', body: 'Visit my site' });
  const r1 = await reply(db, game(), who('u_b'), th.id, { body: 'spam spam' });
  await assert.rejects(reportPost(db, game(), who('u_b'), r1.id, 'spam'), code('own'));
  await assert.rejects(reportPost(db, game(), who('u_a'), r1.id, 'nope'), code('bad_request'));
  for (const u of ['u_a', 'u_a', 'u_d']) await reportPost(db, game(), who(u), r1.id, 'spam');
  let v = await thread(db, game(), null, th.id);
  assert.equal(v.posts[0].hidden, null);
  await reportPost(db, game(), who('u_e'), r1.id, 'spam');   // the third account
  v = await thread(db, game(), null, th.id);
  assert.equal(v.posts[0].hidden, 'reports'); assert.equal(v.posts[0].body, ''); assert.equal(v.thread.replies, 0);
  const asCreator = await thread(db, game(), who('u_c'), th.id);
  assert.equal(asCreator.posts[0].body, 'spam spam'); assert.equal(asCreator.posts[0].reports, 3);
  await moderatePost(db, game(), who('u_c'), r1.id, { hidden: false });
  assert.equal((await thread(db, game(), null, th.id)).thread.replies, 1);
  // the creator hides a whole thread
  await moderatePost(db, game(), who('u_c'), th.id, { hidden: true });
  assert.deepEqual((await threads(db, game(), null)).threads, []);
  await assert.rejects(thread(db, game(), who('u_d'), th.id), code('not_found'));
  assert.equal((await threads(db, game(), who('u_c'))).threads.length, 1);
  // an author removes their own reply
  await moderatePost(db, game(), who('u_c'), th.id, { hidden: false });
  await removePost(db, game(), who('u_b'), r1.id);
  assert.equal((await thread(db, game(), null, th.id)).posts[0].hidden, 'author');
});

test('the board switched off, the hourly limit, account deletion', async () => {
  const { db, game, who } = world();
  await assert.rejects(setBoard(db, game(), who('u_a'), false), code('forbidden'));
  await setBoard(db, game(), who('u_c'), false);
  await assert.rejects(startThread(db, game(), who('u_a'), { title: 'Hello all', body: 'x' }), code('board_off'));
  await setBoard(db, game(), who('u_c'), true);
  const th = await startThread(db, game(), who('u_a'), { title: 'Hello all', body: 'x' }, T);
  for (let i = 1; i < LIMITS.per_hour; i++) await reply(db, game(), who('u_a'), th.id, { body: 'again ' + i }, T + i);
  await assert.rejects(reply(db, game(), who('u_a'), th.id, { body: 'one more' }, T + 100), code('rate_limited'));
  await reply(db, game(), who('u_a'), th.id, { body: 'later' }, T + 3600_001);
  await reply(db, game(), who('u_b'), th.id, { body: 'hi' }, T + 3600_002);
  await db.batch(deleteStatements(db, 'u_a', T + 4000_000));
  const v = await thread(db, game(), who('u_c'), th.id);
  assert.equal(v.thread.hidden, 'author'); assert.equal(v.thread.body, '');
  assert.equal(v.thread.replies, 1);   // only u_b's reply is still visible
});

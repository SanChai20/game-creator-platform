// Clips (src/clips.js): who may save one and of which games, the size and length limits, the per-account caps, who sees
// a hidden clip, hiding by the creator and by reports, deleting, and account deletion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { addClip, clipsOf, clipsOpen, deleteClip, deleteStatements, getClip, keysOf, LIMITS, myClips, prepareClip, reportClip, setClipsOff, setHidden } from '../src/clips.js';

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
function world() {
  const db = d1(), q = (s, ...a) => db.sql.prepare(s).run(...a);
  for (const u of ['u_a', 'u_b', 'u_c', 'u_d', 'u_e']) q("INSERT INTO users (id, email, name, pw_hash, status, created_at) VALUES (?, ?, ?, '', 'active', 1)", u, u + '@x', 'Name ' + u);
  const game = (id, status = 'live', age = null) => q('INSERT INTO projects (id, owner_id, slug, title, status, live_version, price_cents, age, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, 1, 1)', id, 'u_c', id, 'Game ' + id, status, age);
  game('g1'); game('draft', 'draft'); game('adult', 'live', 18);
  const row = (id) => db.sql.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return { db, q, row };
}
const code = (e) => (err) => err.code === e;
const ok = { type: 'video/webm;codecs=vp9', bytes: 1000, ms: 5000 };
const save = async (db, uid, p, raw = ok, t) => addClip(db, await prepareClip(db, uid, p, raw, t));

test('only signed-in players, of live games that take clips, within the limits', async () => {
  const { db, row } = world();
  await assert.rejects(prepareClip(db, null, row('g1'), ok), code('unauthenticated'));
  await assert.rejects(prepareClip(db, 'u_a', row('draft'), ok), code('clips_off'));
  await assert.rejects(prepareClip(db, 'u_a', row('adult'), ok), code('clips_off'));
  assert.equal(clipsOpen(row('adult')), false);
  await assert.rejects(prepareClip(db, 'u_a', row('g1'), { ...ok, type: 'text/html' }), code('bad_type'));
  await assert.rejects(prepareClip(db, 'u_a', row('g1'), { ...ok, bytes: 0 }), code('empty'));
  await assert.rejects(prepareClip(db, 'u_a', row('g1'), { ...ok, bytes: LIMITS.bytes + 1 }), code('too_big'));
  await assert.rejects(prepareClip(db, 'u_a', row('g1'), { ...ok, ms: 500 }), code('bad_length'));
  await assert.rejects(prepareClip(db, 'u_a', row('g1'), { ...ok, ms: 40000 }), code('bad_length'));
  const c = await prepareClip(db, 'u_a', row('g1'), { ...ok, type: 'video/mp4', title: '  My   best run  ' });
  assert.equal(c.type, 'video/mp4'); assert.equal(c.title, 'My best run'); assert.match(c.r2_key, /^clips\/clp_[a-z0-9]+\.mp4$/);
  await setClipsOff(db, 'g1', true);
  await assert.rejects(prepareClip(db, 'u_a', row('g1'), ok), code('clips_off'));
});

test('caps: 20 a day and 30 kept', async () => {
  const { db, row } = world(), day = 86400000;
  for (let i = 0; i < LIMITS.per_day; i++) await save(db, 'u_a', row('g1'), ok, 10 * day);
  await assert.rejects(prepareClip(db, 'u_a', row('g1'), ok, 10 * day + 1), code('rate_limited'));
  for (let i = 0; i < LIMITS.per_user - LIMITS.per_day; i++) await save(db, 'u_a', row('g1'), ok, 12 * day);
  await assert.rejects(prepareClip(db, 'u_a', row('g1'), ok, 20 * day), code('too_many'));
  assert.equal((await myClips(db, 'u_a')).length, LIMITS.per_user);
});

test('hiding, reports, deleting and who sees what', async () => {
  const { db, row } = world();
  const c = await save(db, 'u_a', row('g1'));
  assert.equal((await getClip(db, c.id, null)).by.name, 'Name u_a');
  assert.equal((await clipsOf(db, 'g1')).length, 1);
  await assert.rejects(setHidden(db, c.id, 'u_b', true), code('forbidden'));
  await setHidden(db, c.id, 'u_c', true);   // the game's creator
  assert.equal(await getClip(db, c.id, 'u_b'), null);
  assert.equal((await getClip(db, c.id, 'u_a')).hidden, true);   // its maker still sees it
  assert.equal((await clipsOf(db, 'g1')).length, 0);
  await setHidden(db, c.id, 'u_c', false);
  // three reports by different players hide it; reporting twice counts once; not your own
  await assert.rejects(reportClip(db, c.id, 'u_a', 'spam'), code('own'));
  await reportClip(db, c.id, 'u_b', 'spam'); await reportClip(db, c.id, 'u_b', 'spam'); await reportClip(db, c.id, 'u_d', 'spam');
  assert.ok(await getClip(db, c.id, null));
  await reportClip(db, c.id, 'u_e', 'spam');
  assert.equal(await getClip(db, c.id, null), null);
  assert.equal((await getClip(db, c.id, 'u_x', true)).hidden_by, 'reports');   // admins see it
  // only its maker or an admin deletes it
  await assert.rejects(deleteClip(db, c.id, 'u_c'), code('forbidden'));
  assert.equal(await deleteClip(db, c.id, 'u_a'), c.r2_key);
  assert.equal(await getClip(db, c.id, 'u_a'), null);
});

test('account deletion takes the clips and their videos', async () => {
  const { db, row } = world();
  const a = await save(db, 'u_a', row('g1')), b = await save(db, 'u_b', row('g1'));
  await reportClip(db, b.id, 'u_a', 'spam');
  assert.deepEqual(await keysOf(db, 'u_a'), [a.r2_key]);
  await db.batch(deleteStatements(db, 'u_a'));
  assert.equal(await getClip(db, a.id, 'u_a'), null);
  assert.ok(await getClip(db, b.id, null));
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM clip_reports').get().n, 0);
});

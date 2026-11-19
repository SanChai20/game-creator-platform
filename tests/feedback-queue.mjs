// The creator feedback queue as the agent reads it (src/feedback.ts takeFeedback), on the real migrations: items are taken
// once, oldest first, never twice by two readers; an answer is held to a size agents' clients accept (the rest waits for
// the next call); read items can be read again for a day (recent: true) and are then deleted with their pictures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { takeFeedback, pendingFeedback, listFeedback, purgeOldFeedback } = await import('../src/feedback.ts');

function env() {
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(f, dir), 'utf8'));
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  const files = new Map();
  const FILES = {
    put: async (k, v) => { files.set(k, v); },
    get: async (k) => (files.has(k) ? { arrayBuffer: async () => files.get(k).buffer, httpMetadata: { contentType: 'image/jpeg' } } : null),
    delete: async (k) => { for (const x of [k].flat()) files.delete(x); },
  };
  return { DB: { prepare: (q) => stmt(q), sql }, FILES, files };
}
const P = { id: 'gamea1', owner_id: 'u1' };
function add(e, id, at, bytes = 1000) {
  const key = `feedback/gamea1/${id}.jpg`; e.files.set(key, new Uint8Array(bytes));
  e.DB.sql.prepare("INSERT INTO feedback (id, project_id, owner_id, version, note, marks, context, image_key, bytes, width, height, created_at) VALUES (?, 'gamea1', 'u1', 3, ?, '[]', ?, ?, ?, 1600, 900, ?)")
    .run(id, 'note ' + id, JSON.stringify({ method: 'screen', viewport: { width: 1040, height: 585 } }), key, bytes, at);
}

test('items are taken oldest first, once, and the queue shrinks', async () => {
  const e = env(); const t = Date.now() - 60000;
  for (let i = 0; i < 5; i++) add(e, 'fb' + i, t + i);
  assert.equal(await pendingFeedback(e, 'gamea1'), 5);
  const a = await takeFeedback(e, P, 2, false, 'agent');
  assert.deepEqual(a.items.map((x) => x.id), ['fb0', 'fb1']); assert.equal(a.images.length, 2); assert.equal(a.pending, 3);
  const b = await takeFeedback(e, P, 5, false, 'agent');
  assert.deepEqual(b.items.map((x) => x.id), ['fb2', 'fb3', 'fb4']); assert.equal(b.pending, 0);
  assert.equal((await takeFeedback(e, P, 5, false, 'agent')).items.length, 0);
  // two readers at once never share an item
  const e2 = env(); for (let i = 0; i < 4; i++) add(e2, 'x' + i, t + i);
  const [r1, r2] = await Promise.all([takeFeedback(e2, P, 2, false, 'a'), takeFeedback(e2, P, 2, false, 'b')]);
  const ids = [...r1.items, ...r2.items].map((x) => x.id); assert.equal(new Set(ids).size, ids.length); assert.equal(ids.length, 4);
});

test('an answer too large for an agent\'s client leaves the rest queued', async () => {
  const e = env(); const t = Date.now() - 60000;
  add(e, 'big0', t, 1_400_000); add(e, 'big1', t + 1, 1_400_000); add(e, 'big2', t + 2, 1_400_000);
  const a = await takeFeedback(e, P, 3, false, 'agent');
  assert.deepEqual(a.items.map((x) => x.id), ['big0', 'big1']); assert.equal(a.pending, 1);
  assert.deepEqual((await takeFeedback(e, P, 3, false, 'agent')).items.map((x) => x.id), ['big2']);
  // one item alone always goes, whatever its size
  const e2 = env(); add(e2, 'huge', t, 5_000_000);
  assert.equal((await takeFeedback(e2, P, 3, false, 'agent')).items.length, 1);
});

test('read items can be read again for a day, then go with their pictures', async () => {
  const e = env(); const t = Date.now() - 60000;
  add(e, 'fb0', t); add(e, 'fb1', t + 1);
  await takeFeedback(e, P, 1, false, 'agent');
  // the console no longer shows it; the agent still can
  assert.deepEqual((await listFeedback(e, P)).items.map((x) => x.id), ['fb1']);
  const again = await takeFeedback(e, P, 3, false, 'agent', true);
  assert.deepEqual(again.items.map((x) => x.id), ['fb0']); assert.equal(again.images.length, 1); assert.equal(again.pending, 1);
  // a day later it is deleted, its picture too; the unread one stays
  e.DB.sql.prepare("UPDATE feedback SET taken_at = ? WHERE id = 'fb0'").run(Date.now() - 25 * 3600000);
  assert.equal(await purgeOldFeedback(e), 1);
  assert.equal(e.files.has('feedback/gamea1/fb0.jpg'), false); assert.equal(e.files.has('feedback/gamea1/fb1.jpg'), true);
  assert.equal((await takeFeedback(e, P, 3, false, 'agent', true)).items.length, 0);
});

test('marks come with game coordinates when the picture is the whole game', async () => {
  const e = env(); add(e, 'fb0', Date.now());
  e.DB.sql.prepare("UPDATE feedback SET marks = ? WHERE id = 'fb0'").run(JSON.stringify([{ n: 1, type: 'circle', x: 0.25, y: 0.25, w: 0.5, h: 0.5 }]));
  const [it] = (await takeFeedback(e, P, 1, false, 'agent')).items;
  assert.equal(it.marks[0], '1. circle around (800, 450), 800 × 450 px [game (520, 293)]');
});

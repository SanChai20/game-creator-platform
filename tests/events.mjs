// Custom events and retention: what a batch may hold, the cap on event names, the verifier recording nothing, ordered
// funnels, and rolling day-N retention. Runs the real module against SQLite with the real migrations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MAX_NAMES, cleanBatch, eventSummary, funnel, parseFunnel, retentionOf, trackOp } from '../src/events.js';

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

test('a batch is checked and merged by name', () => {
  assert.deepEqual(cleanBatch([{ name: 'coin', n: 2, sum: 10 }, { name: 'coin', sum: 5 }, { name: 'win' }]), [{ name: 'coin', n: 3, sum: 15 }, { name: 'win', n: 1, sum: 0 }]);
  assert.deepEqual(cleanBatch({ name: 'one' }), [{ name: 'one', n: 1, sum: 0 }]);
  assert.throws(() => cleanBatch([{ name: 'Bad Name' }]), /must be 1 to 40/);
  assert.throws(() => cleanBatch([]), /must be a list/);
  assert.throws(() => cleanBatch(Array.from({ length: 21 }, (_, i) => ({ name: 'e' + i }))), /At most 20/);
  assert.equal(cleanBatch([{ name: 'x', sum: 1e20 }])[0].sum, 0);
});

test('counts and unique players; the verifier records nothing', async () => {
  const db = d1();
  await trackOp(db, 'g1', 'u1', [{ name: 'level', n: 2, sum: 6 }], T);
  await trackOp(db, 'g1', 'u2', [{ name: 'level', sum: 3 }], T);
  const v = await trackOp(db, 'g1', 'verify:x', [{ name: 'level' }], T, false);
  assert.equal(v.recorded, 0);
  const s = await eventSummary(db, 'g1', T - DAY);
  assert.deepEqual(s, [{ name: 'level', count: 3, players: 2, total: 9, average: 3 }]);
  assert.deepEqual(await eventSummary(db, 'g1:preview', T - DAY), []);
});

test(`a game may use at most ${MAX_NAMES} event names`, async () => {
  const db = d1();
  for (let i = 0; i < MAX_NAMES; i += 10) await trackOp(db, 'g1', 'u1', Array.from({ length: 10 }, (_, k) => ({ name: 'e' + (i + k) })), T);
  const r = await trackOp(db, 'g1', 'u1', [{ name: 'e0' }, { name: 'fresh' }], T);
  assert.equal(r.recorded, 1);
  assert.deepEqual(r.refused, ['fresh']);
  assert.match(r.error, /already uses 50/);
});

test('a funnel follows players in order', async () => {
  const db = d1();
  await trackOp(db, 'g1', 'a', [{ name: 'start' }], T); await trackOp(db, 'g1', 'a', [{ name: 'mid' }], T + 1); await trackOp(db, 'g1', 'a', [{ name: 'end' }], T + 2);
  await trackOp(db, 'g1', 'b', [{ name: 'start' }], T); await trackOp(db, 'g1', 'b', [{ name: 'mid' }], T + 1);
  await trackOp(db, 'g1', 'c', [{ name: 'mid' }], T - 5); await trackOp(db, 'g1', 'c', [{ name: 'start' }], T); // mid before start: not counted
  const f = await funnel(db, 'g1', ['start', 'mid', 'end'], T - DAY);
  assert.deepEqual(f.map((s) => [s.step, s.players, s.share, s.from_previous]), [['start', 3, 100, 100], ['mid', 2, 66.7, 66.7], ['end', 1, 33.3, 50]]);
  assert.deepEqual(parseFunnel(['a', 'a', 'B']).steps, ['a']);
  assert.equal(parseFunnel('x').issues[0].level, 'error');
});

test('rolling retention counts only players old enough', () => {
  const now = T;
  const cohort = [
    { first_at: now - 10 * DAY, last_at: now - 1 * DAY }, // back after 9 days: day 1 and day 7
    { first_at: now - 10 * DAY, last_at: now - 10 * DAY }, // never came back
    { first_at: now - 3 * DAY, last_at: now - 1 * DAY },  // day 1 only, too new for day 7
  ];
  const r = retentionOf(cohort, now);
  assert.deepEqual([r.day1.eligible, r.day1.returned, r.day1.share], [3, 2, 66.7]);
  assert.deepEqual([r.day7.eligible, r.day7.returned, r.day7.share], [2, 1, 50]);
  assert.equal(r.day30.share, null);
  assert.equal(r.cohorts.reduce((a, c) => a + c.players, 0), 3);
});

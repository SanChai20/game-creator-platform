// The matchmaking rules (src/match-making.ts): who plays whom, teams, rating changes and request checks. Also the match
// setup of a game script (src/hosting.ts): the Durable Object binding and the one-time migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignTeams, eloChanges, formGroups, matchRequest, reach } from '../src/match-making.ts';
import { MATCH_CLASS, MATCH_MIGRATION_TAG, matchSetup, scriptBindings, scriptMetadata } from '../src/hosting.ts';
import { groupHint, regionDistance, regionHint } from '../src/placement.ts';

const T = 1_000_000;
const w = (u, region, rating, waitedS) => ({ u, n: u, region, rating, at: T - waitedS * 1000 });

test('the search widens with the wait: same region first, then neighbours, then anyone', () => {
  assert.deepEqual(reach(0), { dist: 0, rating: 100 });
  assert.equal(reach(6).dist, 1); assert.equal(reach(12).dist, 2); assert.equal(reach(25).dist, 3);
  assert.equal(reach(1000).rating, 1000);
  assert.equal(regionDistance('weur', 'weur'), 0); assert.equal(regionDistance('weur', 'eeur'), 1);
  assert.equal(regionDistance('wnam', 'enam'), 2); assert.equal(regionDistance('weur', 'oc'), 3);
  assert.equal(regionDistance(null, 'apac'), 1);
});

test('two fresh players far apart wait; after 20 s they are matched', () => {
  assert.deepEqual(formGroups([w('a', 'weur', 1000, 0), w('b', 'oc', 1000, 0)], T, 2, 2), []);
  assert.deepEqual(formGroups([w('a', 'weur', 1000, 21), w('b', 'oc', 1000, 0)], T, 2, 2).map((g) => g.map((x) => x.u)), [['a', 'b']]);
});

test('the oldest player gets the closest ratings in reach; everyone is used once', () => {
  const q = [w('old', 'weur', 1500, 3), w('near', 'weur', 1520, 1), w('far', 'weur', 1300, 2), w('x', 'weur', 1460, 0)];
  const g = formGroups(q, T, 2, 2).map((x) => x.map((y) => y.u));
  assert.deepEqual(g[0], ['old', 'near']);
  const used = g.flat(); assert.equal(new Set(used).size, used.length);
  assert.deepEqual(formGroups(q, T, 4, 4), [], 'the rating gap of 200 is out of reach for a short wait');
  assert.equal(formGroups(q.map((p) => ({ ...p, at: T - 30_000 })), T, 4, 4)[0].length, 4);
});

test('a short match starts after the wait with at least min players, never fewer', () => {
  const q = [w('a', 'weur', 1000, 31), w('b', 'weur', 1000, 31), w('c', 'weur', 1000, 31)];
  assert.equal(formGroups(q, T, 8, 3)[0].length, 3);
  assert.deepEqual(formGroups(q, T, 8, 4), []);
  assert.deepEqual(formGroups(q.map((p) => ({ ...p, at: T - 10_000 })), T, 8, 3), [], 'not before 30 s');
});

test('teams are even: snake draft by rating', () => {
  const r = assignTeams([{ rating: 1000 }, { rating: 1400 }, { rating: 1200 }, { rating: 1300 }], 2);
  const sum = (t) => r.filter((x) => x.team === t).reduce((a, x) => a + x.rating, 0);
  assert.ok(Math.abs(sum(0) - sum(1)) <= 100, `${sum(0)} vs ${sum(1)}`);   // strongest + weakest against the middle two
  assert.deepEqual(assignTeams([{ rating: 1 }], 1), [{ rating: 1, team: null }]);
  assert.equal(new Set(assignTeams(Array.from({ length: 9 }, (_, i) => ({ rating: i })), 3).map((x) => x.team)).size, 3);
});

test('ratings: the winner gains what the loser loses; an upset moves more; a big match moves about as much as a duel', () => {
  const d = eloChanges([['a'], ['b']], new Map());
  assert.equal(d.get('a'), 16); assert.equal(d.get('b'), -16);
  const up = eloChanges([['weak'], ['strong']], new Map([['weak', 800], ['strong', 1200]]));
  assert.ok(up.get('weak') > 16);
  const draw = eloChanges([['a', 'b']], new Map());
  assert.equal(draw.get('a'), 0);
  const big = eloChanges([['p1'], ['p2'], ['p3'], ['p4'], ['p5'], ['p6'], ['p7'], ['p8']], new Map());
  assert.ok(big.get('p1') <= 32 && big.get('p1') > 0);
  assert.ok(Math.abs([...big.values()].reduce((a, b) => a + b, 0)) < 1e-9, 'zero sum');
  assert.equal(eloChanges([['solo']], new Map()).get('solo'), 0);
});

test('match requests are checked', () => {
  assert.deepEqual(matchRequest({}, 16), { ok: true, queue: 'default', size: 2, min: 2, teams: 1, code: null, mode: '', wait: 30, settle: 0 });
  assert.equal(matchRequest({ queue: 'Bad Queue' }, 16).ok, false);
  assert.equal(matchRequest({ size: '17' }, 16).ok, false);
  assert.equal(matchRequest({ size: '65' }, 999).ok, false, 'the hard cap is 64');
  assert.equal(matchRequest({ size: '1' }, 16).ok, false);
  assert.equal(matchRequest({ min: '0' }, 16).ok, false);
  assert.equal(matchRequest({ size: '4', min: '5' }, 16).ok, false);
  assert.equal(matchRequest({ size: '4', teams: '5' }, 16).ok, false);
  assert.equal(matchRequest({ code: 'ab' }, 16).ok, false);
  assert.equal(matchRequest({ code: 'abc<1' }, 16).ok, false);
  assert.equal(matchRequest({ code: 'abc123' }, 16).code, 'ABC123');
  assert.equal(matchRequest({ mode: 'x'.repeat(33) }, 16).ok, false);
  assert.equal(matchRequest({ size: 'NaN' }, 16).ok, false);
});

test('a match is placed where most of its players are', () => {
  assert.equal(regionHint({ continent: 'EU', longitude: '2.3' }), 'weur');
  assert.equal(regionHint({ continent: 'NA', longitude: '-122' }), 'wnam');
  assert.equal(regionHint({ continent: 'AS', country: 'AE' }), 'me');
  assert.equal(regionHint(null), null);
  assert.equal(groupHint(['weur', 'enam', 'enam', null]), 'enam');
  assert.equal(groupHint([null, null]), null);
  assert.equal(groupHint(['bogus', 'apac']), 'apac');
});

test('a game script gets the match class once: the migration only when the script lacks it', () => {
  assert.deepEqual(matchSetup(null, false), { binding: false });
  assert.deepEqual(matchSetup(null, true), { binding: true, migrations: { new_tag: MATCH_MIGRATION_TAG, new_sqlite_classes: [MATCH_CLASS] } });
  assert.deepEqual(matchSetup('other', true).migrations, { old_tag: 'other', new_tag: MATCH_MIGRATION_TAG, new_sqlite_classes: [MATCH_CLASS] });
  assert.deepEqual(matchSetup(MATCH_MIGRATION_TAG, true), { binding: true });
  assert.deepEqual(matchSetup(MATCH_MIGRATION_TAG, false), { binding: true }, 'a script that has the class keeps its binding');
  const b = scriptBindings({ PLAY_KEY: 'k' }, true);
  assert.ok(b.some((x) => x.type === 'durable_object_namespace' && x.name === 'MATCH' && x.class_name === MATCH_CLASS));
  assert.ok(!scriptBindings({}).some((x) => x.name === 'MATCH'));
  const m = scriptMetadata('workers', { bindings: b, tags: [], limits: { cpuMs: 1000, subRequests: 10 }, migrations: { new_tag: 't' } });
  assert.deepEqual(m.migrations, { new_tag: 't' });
  assert.equal('migrations' in scriptMetadata('workers', { bindings: b, tags: [], limits: { cpuMs: 1000, subRequests: 10 } }), false);
});

test('min 1: a lone player starts alone after the short-start wait; others still group first', () => {
  assert.deepEqual(matchRequest({ size: '4', min: '1' }, 16), { ok: true, queue: 'default', size: 4, min: 1, teams: 1, code: null, mode: '', wait: 30, settle: 0 });
  assert.equal(matchRequest({ size: '4', min: '0' }, 16).ok, false);
  assert.deepEqual(formGroups([w('solo', 'weur', 1000, 10)], T, 4, 1), [], 'not before 30 s');
  assert.deepEqual(formGroups([w('solo', 'weur', 1000, 31)], T, 4, 1).map((g) => g.map((x) => x.u)), [['solo']]);
  assert.deepEqual(formGroups([w('a', 'weur', 1000, 31), w('b', 'weur', 1000, 2)], T, 4, 1).map((g) => g.map((x) => x.u)), [['a', 'b']], 'whoever is waiting joins the short match');
  assert.equal(formGroups([w('a', 'weur', 1000, 1), w('b', 'weur', 1000, 1)], T, 2, 1)[0].length, 2, 'a full match still starts at once');
  assert.deepEqual(formGroups([w('solo', 'weur', 1000, 31)], T, 4, 2), [], 'min 2 never starts alone');
});

test('wait and settle: each player brings their own short-start wait and settling time', () => {
  const r = matchRequest({ size: '8', min: '2', wait: '17.5', settle: '4' }, 16);
  assert.equal(r.ok && r.wait, 17.5); assert.equal(r.ok && r.settle, 4);
  for (const bad of [{ wait: '4' }, { wait: '121' }, { wait: 'soon' }, { settle: '-1' }, { settle: '21' }, { settle: 'x' }]) assert.equal(matchRequest(bad, 16).ok, false, JSON.stringify(bad));
  const p = (u, waitedS, wait, settle) => ({ ...w(u, 'weur', 1000, waitedS), wait, settle });
  const ids = (gs) => gs.map((g) => g.map((x) => x.u));
  // the oldest player's own wait decides when a short match may start
  assert.deepEqual(formGroups([p('a', 15, 18), p('b', 10, 18)], T, 8, 2), [], 'not before the oldest player has waited their 18 s');
  assert.deepEqual(ids(formGroups([p('a', 19, 18), p('b', 10, 18)], T, 8, 2)), [['a', 'b']]);
  assert.deepEqual(ids(formGroups([p('a', 19, 18), p('b', 10, 60)], T, 8, 2)), [['a', 'b']], 'the wait of the one who waited longest counts, not the newcomer\'s');
  assert.deepEqual(formGroups([p('a', 19, 60), p('b', 10, 12)], T, 8, 2), [], 'and the other way round');
  assert.deepEqual(ids(formGroups([w('a', 'weur', 1000, 31), p('b', 10, 60)], T, 8, 2)), [['a', 'b']], 'a player who gave no wait has the usual 30 s');
  // a short match holds for a player who has only just arrived
  assert.deepEqual(formGroups([p('a', 90, 18, 4), p('b', 1, 18, 4)], T, 8, 2), [], 'b has been here for 1 s of their 4');
  assert.deepEqual(ids(formGroups([p('a', 90, 18, 4), p('b', 4, 18, 4)], T, 8, 2)), [['a', 'b']]);
  assert.deepEqual(formGroups([p('a', 90, 18, 4), p('b', 6, 18, 4), p('c', 2, 18, 4)], T, 8, 2), [], 'held for c as well: the three start together');
  assert.deepEqual(ids(formGroups([p('a', 90, 18, 4), p('b', 8, 18, 4), p('c', 4, 18, 4)], T, 8, 2)), [['a', 'b', 'c']]);
  // a full match never waits for either
  assert.equal(formGroups([p('a', 0, 18, 4), p('b', 0, 18, 4)], T, 2, 2)[0].length, 2);
  // alone, nothing starts however long the wait has been over
  assert.deepEqual(formGroups([p('a', 600, 18, 4)], T, 8, 2), []);
});

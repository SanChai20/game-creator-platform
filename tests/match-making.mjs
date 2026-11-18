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
  assert.deepEqual(matchRequest({}, 16), { ok: true, queue: 'default', size: 2, min: 2, teams: 1, code: null, mode: '' });
  assert.equal(matchRequest({ queue: 'Bad Queue' }, 16).ok, false);
  assert.equal(matchRequest({ size: '17' }, 16).ok, false);
  assert.equal(matchRequest({ size: '65' }, 999).ok, false, 'the hard cap is 64');
  assert.equal(matchRequest({ size: '1' }, 16).ok, false);
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
  const b = scriptBindings({ PLAY_KEY: 'k' }, 'bucket', true);
  assert.ok(b.some((x) => x.type === 'durable_object_namespace' && x.name === 'MATCH' && x.class_name === MATCH_CLASS));
  assert.ok(!scriptBindings({}, 'bucket').some((x) => x.name === 'MATCH'));
  const m = scriptMetadata('workers', { bindings: b, tags: [], limits: { cpuMs: 1000, subRequests: 10 }, migrations: { new_tag: 't' } });
  assert.deepEqual(m.migrations, { new_tag: 't' });
  assert.equal('migrations' in scriptMetadata('workers', { bindings: b, tags: [], limits: { cpuMs: 1000, subRequests: 10 } }), false);
});

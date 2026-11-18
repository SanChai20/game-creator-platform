// The verifier's two-player check (src/verify-core.js) with stand-in pages: which address each page opens, and what a
// failure says about a relay room (GCP.room) or a server-run match (GCP.match.find).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twoPlayerCheck, twoPlayerSide } from '../src/verify-core.js';

/** A page that is ready at once and answers the check's calls: info is { roomInfo, matchInfo }, run what runTwoPlayers returns. */
function fakePage(log, run, info = {}) {
  return {
    on() {}, async close() {}, async bringToFront() {},
    async goto(u) { log.push(u); },
    async evaluate(fn, arg) {
      if (arg === undefined) return { ready: true, fatal: null };
      if (typeof arg === 'number') return run;
      return info[arg] || [];
    },
  };
}

test('the guest page opens the game with its own play token, so the two pages are two players', async () => {
  const log = [], ok = { ran: true, ok: true, steps: ['met'], result: { players: 2, world: 'w1' } };
  const r = await twoPlayerCheck(async () => fakePage(log, ok), 'https://g.example/?gcp_t=HOST&gcp_autostart=1', { limitS: 2, readyTimeoutS: 2, guestUrl: 'https://g.example/?gcp_t=GUEST&gcp_autostart=1' });
  assert.equal(r.ok, true, r.detail);
  assert.equal(log.length, 2);
  assert.match(log[0], /gcp_t=HOST&gcp_autostart=1&gcp_two=host&gcp_room=V[A-Z]{5}$/);
  assert.match(log[1], /gcp_t=GUEST&gcp_autostart=1&gcp_two=guest&gcp_room=V[A-Z]{5}$/);
  assert.equal(log[0].slice(-6), log[1].slice(-6), 'both pages meet on the same code');
});

test('without a guest address both pages use the game address (older callers)', async () => {
  const log = [], ok = { ran: true, ok: true, steps: [], result: { players: 2, world: 'w' } };
  await twoPlayerCheck(async () => fakePage(log, ok), 'https://g.example/?gcp_t=ONE', { limitS: 2, readyTimeoutS: 2 });
  assert.ok(log.every((u) => u.startsWith('https://g.example/?gcp_t=ONE&gcp_autostart=1&gcp_two=')), log.join(' '));
});

test('a failed check describes the match each page found, not a missing room', async () => {
  const log = [], fail = { ran: true, ok: false, error: 'Timed out waiting for the other player to appear', steps: ['wait'], result: null };
  const match = { code: 'VABCDE', phase: 'searching', you: 'verify:vf_a', match: null, lobby: ['verify:vf_a'], players: [], snapshots: 0, closes: 0, error: '' };
  const r = await twoPlayerCheck(async () => fakePage(log, fail, { matchInfo: [match] }), 'https://g.example/?gcp_t=A', { limitS: 2, readyTimeoutS: 2, guestUrl: 'https://g.example/?gcp_t=B' });
  assert.equal(r.ok, false);
  assert.match(r.detail, /Host: match \(none found\) from lobby VABCDE, phase searching, player id verify:vf_a, the lobby listed verify:vf_a/);
  assert.doesNotMatch(r.detail, /opened no room/);
  assert.deepEqual(r.host.match, match);
});

test('twoPlayerSide covers a room, a match, and neither', () => {
  assert.match(twoPlayerSide('Host', { id: 'p1', isHost: true, peers: ['p1', 'p2'], world_ops: 3, states: 1, messages: 4, closes: 0 }, null), /^Host: room id p1 \(host\), saw peer p2 in the room, received 3 world change/);
  const m = twoPlayerSide('Guest', null, { code: 'VQ', phase: 'running', you: 'verify:vf_b', match: 'abc123', lobby: ['verify:vf_a', 'verify:vf_b'], players: ['verify:vf_a', 'verify:vf_b'], snapshots: 40, closes: 1, error: '' });
  assert.equal(m, 'Guest: match abc123 from lobby VQ, phase running, player id verify:vf_b, the lobby listed verify:vf_a, verify:vf_b, the match has verify:vf_a, verify:vf_b, received 40 snapshot(s), lost the connection 1 time(s)');
  assert.equal(twoPlayerSide('Host', null, null), 'Host: opened no room and found no match (neither GCP.room nor GCP.match.find was called)');
});

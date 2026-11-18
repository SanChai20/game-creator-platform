// Room wire format, flood budget, region placement, and the input numbering of @gcp/net.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateBudget, decodeClientFrame, decodeRelayFrame, encodeClientFrame, encodeRelayFrame } from '../src/room-wire.ts';
import { groupHint, regionDistance, regionHint } from '../src/placement.ts';

test('binary frames round-trip for everyone, the host and one peer, and junk is refused', () => {
  const p = new Uint8Array([1, 2, 3, 250]);
  for (const to of [null, 'host', 'u_abc#2']) {
    const f = decodeClientFrame(encodeClientFrame(to, 1712.25, p));
    assert.equal(f.to, to); assert.equal(f.at, 1712.25); assert.deepEqual([...f.payload], [...p]);
  }
  assert.equal(decodeClientFrame(encodeClientFrame(null, undefined, p)).at, undefined);
  for (const junk of [new Uint8Array(0), new Uint8Array([1]), new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0]), new Uint8Array([1, 5, 0, 0, 0, 0, 0, 0, 0, 0]), new Uint8Array([1, 2, 200, 1, 2, 3])])
    assert.equal(decodeClientFrame(junk.buffer), null, String([...junk]));
  // a peer id that is not valid UTF-8 is refused rather than turned into a lookalike id
  assert.equal(decodeClientFrame(new Uint8Array([1, 2, 1, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 9]).buffer), null);
  const r = decodeRelayFrame(encodeRelayFrame('peer-1', 5, p));
  assert.equal(r.from, 'peer-1'); assert.equal(r.at, 5); assert.deepEqual([...r.payload], [...p]);
});

test('the budget allows a burst of twice the rate, refills at the rate, warns once a second and closes a sustained flood', () => {
  const b = new RateBudget(10, 1e9);
  let ok = 0;
  for (let i = 0; i < 50; i++) if (b.take(10, 1000) === 'ok') ok++;
  assert.equal(ok, 20);
  assert.equal(b.take(10, 1500), 'ok');                 // half a second refills 5
  // flooding: some get through as it refills, a warning at most once a second, and a close after 10 s
  const seen = { ok: 0, warn: 0, drop: 0, close: 0 };
  for (let t = 1500; t < 12_000; t += 10) for (let i = 0; i < 5; i++) { const v = b.take(10, t); seen[v]++; if (v === 'close') break; }
  assert.ok(seen.close >= 1, JSON.stringify(seen));
  assert.ok(seen.warn >= 8 && seen.warn <= 12, JSON.stringify(seen));
  assert.ok(seen.ok > 50 && seen.ok < 140, JSON.stringify(seen));
  // a player who stops flooding is forgiven
  const c = new RateBudget(10, 1e9);
  for (let i = 0; i < 40; i++) c.take(1, 0);
  for (let t = 5000; t < 20_000; t += 200) assert.equal(c.take(1, t), 'ok');
  // the byte budget counts too
  const d = new RateBudget(1000, 1000);
  assert.equal(d.take(1500, 0), 'ok'); assert.notEqual(d.take(1500, 1), 'ok');
});

test('rooms and matches are placed in the region their players connect from', () => {
  assert.equal(regionHint({ continent: 'NA', longitude: '-122.4' }), 'wnam');
  assert.equal(regionHint({ continent: 'NA', longitude: '-74' }), 'enam');
  assert.equal(regionHint({ continent: 'EU', longitude: '2.3' }), 'weur');
  assert.equal(regionHint({ continent: 'EU', longitude: '30.5' }), 'eeur');
  assert.equal(regionHint({ continent: 'AS', country: 'JP' }), 'apac');
  assert.equal(regionHint({ continent: 'AS', country: 'AE' }), 'me');
  assert.equal(regionHint({ continent: 'OC' }), 'oc');
  assert.equal(regionHint({ continent: 'SA' }), 'sam');
  assert.equal(regionHint({}), null);
  assert.equal(regionHint(undefined), null);
  assert.equal(groupHint(['weur', 'enam', 'weur', null]), 'weur');
  assert.equal(groupHint(['apac', 'oc']), 'apac');
  assert.equal(groupHint([null, undefined]), null);
  assert.equal(regionDistance('weur', 'weur'), 0);
  assert.equal(regionDistance('weur', 'eeur'), 1);
  assert.equal(regionDistance('wnam', 'enam'), 2);
  assert.equal(regionDistance('weur', 'oc'), 3);
});

test('@gcp/net.js numbers guest inputs, the host acknowledges them in snapshots, and pending keeps only unapplied ones', async () => {
  // two fake rooms joined back to back
  const mk = (id, host) => {
    const h = {}; const r = { id, isHost: host, peers: [], on: (t, f) => { (h[t] ||= []).push(f); return r; }, emit: (t, ...a) => (h[t] || []).forEach((f) => f(...a)), sent: [] };
    r.send = (d, to) => r.sent.push({ d, to }); r.setState = () => {}; r.leave = () => {};
    return r;
  };
  const rooms = { host: mk('H', true), guest: mk('G', false) };
  let next = 'host';
  globalThis.window = { GCP: { room: () => rooms[next], player: { name: 'p' }, smooth: () => null } };
  const intervals = [];
  globalThis.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
  globalThis.clearInterval = () => {};
  const { joinSession } = await import('../web/public/kits/v1/net.js');
  const inputs = [];
  const host = joinSession('x', { input: (from, d, n) => inputs.push({ from, d, n }), snapshot: () => ({ ok: 1 }) });
  next = 'guest';
  const applied = [];
  const guest = joinSession('x', { apply: (s, first, meta) => applied.push(meta.ack) });
  rooms.host.emit('open', { id: 'H', host: 'H' }); rooms.guest.emit('open', { id: 'G', host: 'H' });
  for (let i = 0; i < 3; i++) guest.sendInput({ i });
  assert.deepEqual(guest.pending.map((p) => p.n), [1, 2, 3]);
  // deliver the first two to the host, out of order, plus a replay of an old number
  for (const k of [1, 0, 1]) { const m = rooms.guest.sent[k].d; rooms.host.emit('message', m, 'G', {}); }
  assert.deepEqual(inputs.map((x) => x.n), [2, 1, 2]);
  intervals[0]();                                         // the host's snapshot tick
  const snap = rooms.host.sent.at(-1).d;
  assert.deepEqual(snap.a, { G: 2 });
  rooms.guest.emit('message', snap, 'H', { at: 1 });
  assert.deepEqual(applied, [2]);
  assert.deepEqual(guest.pending.map((p) => p.n), [3]);
  assert.equal(guest.acked, 2);
  // an older snapshot never moves the ack backwards
  rooms.guest.emit('message', { k: 's', d: {}, a: { G: 1 } }, 'H', {});
  assert.equal(guest.acked, 2);
  // the host's own input is delivered locally with its number
  host.sendInput({ me: 1 });
  assert.equal(inputs.at(-1).from, 'H'); assert.equal(inputs.at(-1).n, 1);
  assert.deepEqual(host.pending, []);
});

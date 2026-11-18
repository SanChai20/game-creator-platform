// The realtime room Durable Object, run in the real Workers runtime (wrangler dev / workerd) with real WebSockets:
// relay, binary frames, ping, the flood budget and a single leave per departure.
//   node tests/room-live.mjs        (starts and stops its own wrangler dev on port 8790)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { encodeClientFrame, decodeRelayFrame } from '../src/room-wire.ts';

const PORT = Number(process.env.ROOM_PORT || 8790), BASE = `ws://127.0.0.1:${PORT}`;
let dev;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  dev = spawn('npx', ['wrangler', 'dev', '-c', 'tests/rt/wrangler.room.jsonc', '--port', String(PORT), '--ip', '127.0.0.1', '--log-level', 'error'], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'ignore', process.env.DEBUG ? 'inherit' : 'ignore'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, detached: true });
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.status === 426) return; } catch { /* starting */ }
    await sleep(500);
  }
  throw new Error('wrangler dev did not start');
});
after(() => { try { process.kill(-dev.pid, 'SIGTERM'); } catch { /* gone */ } });   // the whole group: npx, wrangler and workerd

function join(room, uid, extra = '') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}/?r=${room}&uid=${uid}&name=${uid}&cap=8${extra}`);
    ws.binaryType = 'arraybuffer';
    const c = { ws, got: [], bin: [], welcome: null };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { c.bin.push(decodeRelayFrame(ev.data)); return; }
      const m = JSON.parse(ev.data); c.got.push(m);
      if (m.t === 'welcome') { c.welcome = m; resolve(c); }
    };
    ws.onerror = reject;
    c.closed = new Promise((r) => { ws.onclose = (ev) => r(ev.code); });
  });
}
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(20); } return false; };

test('text and binary messages are relayed with the sender and its clock; ping answers with the same number', async () => {
  const room = 'relay-' + Date.now();
  const a = await join(room, 'alice'), b = await join(room, 'bob');
  assert.equal(b.welcome.host, 'alice');
  a.ws.send(JSON.stringify({ t: 'msg', d: { x: 1 }, at: 1234 }));
  assert.ok(await until(() => b.got.some((m) => m.t === 'msg')));
  assert.deepEqual(b.got.find((m) => m.t === 'msg'), { t: 'msg', from: 'alice', d: { x: 1 }, at: 1234 });
  // binary: to the host, from a guest
  b.ws.send(encodeClientFrame('host', 99.5, new Uint8Array([7, 8, 9])));
  assert.ok(await until(() => a.bin.length === 1));
  assert.equal(a.bin[0].from, 'bob'); assert.equal(a.bin[0].at, 99.5); assert.deepEqual([...a.bin[0].payload], [7, 8, 9]);
  // binary to one peer by id, and a malformed frame is refused with an error rather than relayed
  a.ws.send(encodeClientFrame('bob', undefined, new Uint8Array([1])));
  assert.ok(await until(() => b.bin.length === 1));
  assert.equal(b.bin[0].at, undefined);
  b.ws.send(new Uint8Array([9, 9, 9]).buffer);
  assert.ok(await until(() => b.got.some((m) => m.t === 'error' && /Malformed/.test(m.message))));
  assert.equal(a.bin.length, 1);
  a.ws.send(JSON.stringify({ t: 'ping', n: 7 }));
  assert.ok(await until(() => a.got.some((m) => m.t === 'pong' && m.n === 7 && typeof m.now === 'number')));
  a.ws.close(); b.ws.close();
});

test('a flooding player is throttled, warned, and finally disconnected; the others keep playing', async () => {
  const room = 'flood-' + Date.now();
  const a = await join(room, 'host1'), f = await join(room, 'flood', '&mr=20');
  const msg = JSON.stringify({ t: 'msg', d: 'x' });
  for (let i = 0; i < 200; i++) f.ws.send(msg);
  await sleep(500);
  const got = a.got.filter((m) => m.t === 'msg').length;
  assert.ok(got >= 30 && got <= 60, `the burst allowance (2 x 20) and a little refill get through, not all 200: ${got}`);
  assert.ok(f.got.some((m) => m.t === 'error' && m.code === 'rate_limited'));
  // keep flooding past the close threshold (10 s)
  const t0 = Date.now();
  while (Date.now() - t0 < 11_500 && f.ws.readyState === 1) { for (let i = 0; i < 20; i++) f.ws.send(msg); await sleep(50); }
  assert.equal(await Promise.race([f.closed, sleep(3000).then(() => 'open')]), 4008);
  assert.ok(await until(() => a.got.filter((m) => m.t === 'leave' && m.id === 'flood').length === 1));
  await sleep(300);
  assert.equal(a.got.filter((m) => m.t === 'leave' && m.id === 'flood').length, 1, 'one leave, not two');
  // a well-behaved player in the same room is unaffected
  const c = await join(room, 'calm');
  c.ws.send(JSON.stringify({ t: 'msg', d: 'hi' }));
  assert.ok(await until(() => a.got.some((m) => m.t === 'msg' && m.from === 'calm')));
  a.ws.close(); c.ws.close();
});

test('the host leaving promotes the next player once', async () => {
  const room = 'host-' + Date.now();
  const a = await join(room, 'h'), b = await join(room, 'g1'), c = await join(room, 'g2');
  a.ws.close(1000);
  assert.ok(await until(() => b.got.some((m) => m.t === 'leave')));
  await sleep(200);
  const leaves = b.got.filter((m) => m.t === 'leave');
  assert.equal(leaves.length, 1); assert.equal(leaves[0].host, 'g1');
  b.ws.close(); c.ws.close();
});

// Checks that run the game's own test code (GCP.test.onPlaythrough, GCP.test.onTwoPlayers) classify every failure by
// where it came from: the game's script (a t.until timeout, a t.assert, a throw, the time limit), the game (no frames, a
// wrong outcome), the page (reloaded) or the verifier (no answer). The SDK classifies inside the page
// (web/public/sdk/gcp.js runScript), src/verify-core.js words it and files it in the report.
// Regression: an outside agent's co-op game failed the two-player check 8 times on timeouts in its own script, and the
// report read like a platform or networking failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { failureOf, describeFailure, failureHint, twoPlayerCheck } from '../src/verify-core.js';

/** The SDK in a bare page, with real timers, so a test function can be run through window.__GCP. */
function loadSdk() {
  const noop = () => {};
  const win = { addEventListener: noop, parent: null, requestAnimationFrame: () => 0, location: { search: '', pathname: '/', hash: '', origin: 'https://g.example' }, history: { replaceState: noop },
    __GCP_CONFIG: { api: 'https://p.example', token: 'tok', gameId: 'g', version: 1, env: 'preview', base: '/play/g', player: { id: 'me', name: 'Me' }, kind: 'player', session: 's' } };
  const ctx = {
    window: win, location: win.location, history: win.history, URLSearchParams, console: { ...console, error: noop, log: noop, warn: noop }, navigator: {},
    document: { addEventListener: noop, createElement: () => ({ getContext: () => null, style: {} }), documentElement: { style: { setProperty: noop, removeProperty: noop }, classList: { toggle: noop, add: noop, remove: noop } }, head: { appendChild: noop }, body: null, querySelector: () => null, querySelectorAll: () => [] },
    performance, setTimeout, clearTimeout, clearInterval, setInterval: (fn, ms) => { const id = setInterval(fn, ms); id.unref(); return id; },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, fetch: () => Promise.reject(new Error('offline')), Promise, JSON, Math, Object, Array, Date, Number, String, isFinite, Error, TypeError, Blob: class {}, Uint8Array, Float32Array, ArrayBuffer,
    WebSocket: class {}, encodeURIComponent,
  };
  win.window = win; Object.assign(win, ctx);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url), 'utf8'), ctx);
  return win;
}
const run = (fn, limitMs = 2000) => { const w = loadSdk(); w.GCP.test.onPlaythrough(fn); return w.__GCP.runPlaythrough(limitMs); };

test('a t.until that runs out is the script\'s timeout, with its label, its wait, the step and the elapsed time', async () => {
  const r = await run(async (t) => { t.step('open the door'); t.step('walk to the chest'); await t.until(() => false, 120, 'player at the chest'); });
  assert.equal(r.ok, false);
  assert.match(r.error, /^Timed out waiting for player at the chest/);
  const f = r.failure;
  assert.equal(f.source, 'script'); assert.equal(f.kind, 'timeout');
  assert.equal(f.label, 'player at the chest'); assert.equal(f.waitMs, 120);
  assert.equal(f.step, 'walk to the chest'); assert.equal(f.stepN, 2);
  assert.ok(f.elapsedMs >= 100, String(f.elapsedMs));
  const words = describeFailure(f, "The game's", 'GCP.test.onPlaythrough');
  assert.match(words, /^The game's own test script \(GCP\.test\.onPlaythrough\) timed out: its t\.until\(\.\.\., 120, "player at the chest"\) waited 0\.1 s .* during step 2, "walk to the chest"/);
  assert.match(words, /the platform did not time out/);
  assert.match(failureHint(f, 'GCP.test.onPlaythrough', 'FALLBACK'), /^The failure is in the function given to GCP\.test\.onPlaythrough/);
});

test('a false t.assert, a throw and the time limit are told apart', async () => {
  const a = await run(async (t) => { t.step('count coins'); t.assert(false, 'expected 3 coins'); });
  assert.deepEqual([a.failure.source, a.failure.kind, a.failure.message, a.failure.step], ['script', 'assert', 'expected 3 coins', 'count coins']);
  const e = await run(async (t) => { t.step('jump'); null.x; });
  assert.deepEqual([e.failure.source, e.failure.kind, e.failure.name], ['script', 'error', 'TypeError']);
  assert.match(describeFailure(e.failure, "The game's", 'GCP.test.onPlaythrough'), /threw TypeError: .*during step 1, "jump"/);
  const l = await run(async (t) => { t.step('wait forever'); await t.until(() => false, 60000, 'the boss'); }, 150);
  assert.deepEqual([l.failure.source, l.failure.kind, l.failure.limitMs, l.failure.label, l.failure.step], ['script', 'limit', 150, 'the boss', 'wait forever']);
  assert.match(describeFailure(l.failure, "The game's", 'GCP.test.onPlaythrough'), /still in t\.until\(\.\.\., "the boss"\)/);
});

test('t.frames with no frames drawn is the game\'s failure, not the script\'s', async () => {
  // (in this bare page nothing draws; t.frames waits its 8 s, so the limit is set past it)
  const r = await run(async (t) => { t.step('play'); await t.frames(2); }, 9000);
  assert.deepEqual([r.failure.source, r.failure.kind], ['game', 'no_frames']);
  assert.equal(failureHint(r.failure, 'GCP.test.onPlaythrough', 'FALLBACK'), 'FALLBACK');
});

test('a page on an older SDK copy (no failure object) is still classified from its message', () => {
  assert.deepEqual(failureOf({ ran: true, ok: false, error: 'Timed out waiting for x (5 s).', steps: ['a'], ms: 5100 }), { source: 'script', kind: 'timeout', label: 'x', waitMs: 5000, step: 'a', stepN: 1, elapsedMs: 5100 });
  assert.equal(failureOf({ ran: true, ok: false, error: 'The play-through did not finish within 30 s.', steps: [] }).kind, 'limit');
  assert.equal(failureOf({ ran: true, ok: false, error: 'boom', steps: [] }).kind, 'error');
  assert.equal(failureOf({ ran: true, ok: true }), null);
});

/** A two-player page: ready at once; run is what runTwoPlayers returns, info what roomInfo/matchInfo return. */
function fakePage(run, info = {}) {
  return { on() {}, async close() {}, async bringToFront() {}, async goto() {},
    async evaluate(fn, arg) { if (arg === undefined) return { ready: true, fatal: null }; if (typeof arg === 'number') return typeof run === 'function' ? run() : run; return info[arg] || []; } };
}
const room = (id, other, isHost) => [{ id, isHost, peers: [id, other], world_ops: 0, states: 3, messages: 50, closes: 0 }];
async function pair(host, guest, hostInfo = { roomInfo: room('a', 'b', true) }, guestInfo = { roomInfo: room('b', 'a', false) }) {
  let n = 0;
  return twoPlayerCheck(async () => (n++ ? fakePage(guest, guestInfo) : fakePage(host, hostInfo)), 'https://g.example/?gcp_t=A', { limitS: 1, readyTimeoutS: 1, guestUrl: 'https://g.example/?gcp_t=B' });
}

test('two players: each side\'s own script failure is reported and filed, and the report says the pages had met', async () => {
  const fail = (label, step) => ({ ran: true, ok: false, error: `Timed out waiting for ${label} (22 s).`, steps: ['meet', step], ms: 23000, result: null,
    failure: { source: 'script', kind: 'timeout', label, waitMs: 22000, step, stepN: 2, elapsedMs: 23000 } });
  const r = await pair(fail('both synced', 'pick up'), fail('host confirms', 'pick up'));
  assert.equal(r.ok, false); assert.equal(r.met, true);
  assert.deepEqual([r.failure.source, r.failure.kind, r.failure.side, r.failure.label], ['script', 'timeout', 'host', 'both synced']);
  assert.equal(r.guest.failure.label, 'host confirms');
  assert.match(r.detail, /^The host's own test script \(GCP\.test\.onTwoPlayers\) timed out: .*"both synced".* The guest's own test script .*"host confirms".* Both pages had met/);
});

test('two players: a wrong outcome is the game\'s, and a page that never answers is the verifier\'s', async () => {
  const done = (world) => ({ ran: true, ok: true, steps: [], result: { players: 2, world } });
  const differ = await pair(done('w1'), done('w2'));
  assert.deepEqual([differ.failure.source, differ.failure.kind], ['game', 'worlds_differ']);
  const silent = await pair(() => new Promise(() => {}), done('w'));
  assert.deepEqual([silent.failure.source, silent.failure.kind, silent.failure.side], ['harness', 'no_answer', 'host']);
  assert.match(silent.detail, /This is not a timeout in the game's script/);
});

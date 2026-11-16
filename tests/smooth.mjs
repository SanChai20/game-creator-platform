// GCP.smooth: remote movement played back from a jittery stream must come out even, in order and close behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadSdk() {
  let now = 0;
  const noop = () => {};
  const win = { addEventListener: noop, requestAnimationFrame: (cb) => 0, location: { search: '', pathname: '/', hash: '' }, history: { replaceState: noop } };
  const ctx = {
    window: win, location: win.location, history: win.history, URLSearchParams, console: { ...console, error: noop }, navigator: {},
    document: { addEventListener: noop, createElement: () => ({ getContext: () => null, style: {} }), documentElement: { style: {} }, head: { appendChild: noop }, body: null, querySelector: () => null },
    performance: { now: () => now, timeOrigin: 1.7e12 }, setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, fetch: () => Promise.reject(new Error('offline')), Promise, JSON, Math, Object, Array, Date, Number, String, isFinite, Error, Blob: class {}, Uint8Array, Float32Array,
  };
  win.window = win; Object.assign(win, ctx);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url), 'utf8'), ctx);
  return { GCP: win.GCP, setNow: (t) => { now = t; } };
}

// a sender moving at 5 units/s, sending at hz with random delay; returns what the receiver draws each 16 ms frame
function run({ hz = 15, lat = 60, jit = 60, spike = 0.03, secs = 20, seed = 7, opts, arrival = false } = {}) {
  const { GCP, setNow } = loadSdk();
  let r = seed; const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
  const buf = GCP.smooth(opts);
  const senderOffset = 123456;                         // the two clocks disagree; the buffer must not care
  const arrivals = []; let lane = 0;
  for (let t = 0; t < secs * 1000; t += 1000 / hz) {
    let d = lat + rnd() * jit; if (rnd() < spike) d += 150 + rnd() * 150;
    lane = Math.max(lane, t + d);                      // ordered, like TCP
    arrivals.push({ at: lane, sent: t + senderOffset, x: t / 1000 * 5 });
  }
  const out = []; let i = 0;
  for (let f = 0; f < secs * 1000; f += 16) {
    while (i < arrivals.length && arrivals[i].at <= f) { setNow(arrivals[i].at); buf.push({ x: arrivals[i].x }, arrival ? undefined : arrivals[i].sent); i++; }
    setNow(f);
    const v = buf.value(f); if (v) out.push({ f, x: v.x });
  }
  return { out: out.filter((o) => o.f > 3000), buf };
}
function stats(out) {
  const sp = []; for (let i = 1; i < out.length; i++) sp.push((out[i].x - out[i - 1].x) / ((out[i].f - out[i - 1].f) / 1000));
  const mean = sp.reduce((a, b) => a + b, 0) / sp.length, sd = Math.sqrt(sp.reduce((a, b) => a + (b - mean) ** 2, 0) / sp.length);
  return { mean, cv: sd / mean, back: sp.filter((v) => v < -1e-9).length, frozen: sp.filter((v) => Math.abs(v) < 0.5).length };
}

test('a clean connection plays back evenly and close behind', () => {
  const { out, buf } = run({ lat: 30, jit: 5, spike: 0 });
  const s = stats(out);
  assert.ok(Math.abs(s.mean - 5) < 0.3, `speed ${s.mean}`);
  assert.ok(s.cv < 0.05, `speed varies by ${s.cv}`);
  assert.equal(s.back, 0);
  assert.ok(buf.delay < 120, `delay ${buf.delay}`);
});


test('a jittery mobile connection with stalls still plays back smoothly and never backwards', () => {
  for (const net of [{ lat: 60, jit: 60, spike: 0.01 }, { lat: 80, jit: 120, spike: 0.04 }]) for (const seed of [1, 2, 3, 4, 5]) {
    const s = stats(run({ ...net, seed }).out);                      // about 1000 frames each
    assert.equal(s.back, 0, `seed ${seed}: went backwards`);
    assert.ok(s.cv < 0.2, `seed ${seed}: speed varies by ${s.cv}`);
    assert.ok(s.frozen < 20, `seed ${seed}: froze for ${s.frozen} frames`);
  }
});

test('stamping by arrival time with a short fixed delay (the usual first attempt) stutters far more', () => {
  const net = { lat: 60, jit: 60, spike: 0.01, seed: 1 };
  const naive = stats(run({ ...net, opts: { delay: 130 }, arrival: true }).out);
  const smooth = stats(run(net).out);
  assert.ok(smooth.cv * 2 < naive.cv, `smooth ${smooth.cv} vs naive ${naive.cv}`);
});

test('value() blends number fields and keeps the rest from the newer sample', () => {
  const { GCP, setNow } = loadSdk();
  const b = GCP.smooth({ delay: 0 });
  setNow(0); b.push({ x: 0, hp: 10, name: 'a' }, 0);
  setNow(100); b.push({ x: 10, hp: 5, name: 'b' }, 100);
  const v = b.value(150);
  assert.ok(v.x > 0 && v.x <= 20, String(v.x));
  assert.equal(v.name, 'b');
  assert.equal(GCP.smooth().value(), null);
});

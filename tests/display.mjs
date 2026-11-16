// GCP.display: edge-to-edge fullscreen passes the screen's safe-area insets into the game frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadSdk() {
  const noop = () => {}, listeners = {}, posted = [], props = {};
  const parent = { postMessage: (m) => posted.push(m) };
  const win = { addEventListener: (k, f) => { (listeners[k] ||= []).push(f); }, requestAnimationFrame: () => 0, location: { search: '', pathname: '/', hash: '' }, history: { replaceState: noop }, parent };
  const html = { style: { setProperty: (k, v) => { props[k] = v; } }, classList: { toggle: noop } };
  const ctx = {
    window: win, location: win.location, history: win.history, URLSearchParams, console: { ...console, error: noop }, navigator: {}, parent,
    addEventListener: win.addEventListener, matchMedia: () => ({ matches: false }),
    document: { addEventListener: noop, createElement: () => ({ getContext: () => null, style: {} }), documentElement: html, head: { appendChild: noop }, body: null, querySelector: () => null },
    performance: { now: () => 0, timeOrigin: 1.7e12 }, setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, fetch: () => Promise.reject(new Error('offline')), Promise, JSON, Math, Object, Array, Date, Number, String, isFinite, Error, Blob: class {}, Uint8Array, Float32Array,
  };
  win.window = win; Object.assign(win, ctx);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url), 'utf8'), ctx);
  const send = (d) => (listeners.message || []).forEach((f) => f({ source: parent, data: d }));
  const key = (k) => { const e = { key: k, repeat: false, prevented: false, preventDefault() { this.prevented = true; } }; (listeners.keydown || []).forEach((f) => f(e)); return e; };
  return { GCP: win.GCP, posted, props, send, key };
}

test('setDisplay passes edgeToEdge to the platform page', () => {
  const { GCP, posted } = loadSdk();
  GCP.setDisplay({ orientation: 'any', exitButton: 'none', edgeToEdge: true });
  const m = posted.find((x) => x.gcp === 'display_prefs');
  assert.equal(m.edgeToEdge, true);
  assert.equal(m.exitButton, 'none');
});

test('display carries the safe-area insets and sets the --gcp-safe-* variables', () => {
  const { GCP, props, send } = loadSdk();
  assert.deepEqual({ ...GCP.display.safe }, { top: 0, right: 0, bottom: 0, left: 0 });
  assert.equal(props['--gcp-safe-left'], '0px');
  let seen = null; GCP.onDisplay((d) => { seen = { ...d.safe }; });
  send({ gcp: 'display', fullscreen: true, mode: 'immersive', orientation: 'any', touch: true, edgeToEdge: true, safe: { top: 0, right: 59, bottom: 21, left: 59 } });
  assert.equal(GCP.display.edgeToEdge, true);
  assert.deepEqual(seen, { top: 0, right: 59, bottom: 21, left: 59 });
  assert.equal(props['--gcp-safe-left'], '59px');
  assert.equal(props['--gcp-safe-bottom'], '21px');
});

test('bad inset values are ignored', () => {
  const { GCP, send } = loadSdk();
  send({ gcp: 'display', fullscreen: true, edgeToEdge: true, safe: { top: 'x', right: -4, bottom: 1e9, left: null } });
  assert.deepEqual({ ...GCP.display.safe }, { top: 0, right: 0, bottom: 200, left: 0 });
});

test('the Escape rule: the game closes its menu first, and only then does Esc leave fullscreen', () => {
  const { GCP, posted, send, key } = loadSdk();
  let open = true; GCP.onEscape(() => { if (open) { open = false; return true; } return false; });
  assert.deepEqual({ ...posted.find((x) => x.gcp === 'escape') }, { gcp: 'escape', on: true });
  send({ gcp: 'display', fullscreen: true, mode: 'fullscreen', orientation: 'any', touch: false });
  const first = key('Escape');
  assert.equal(first.prevented, true); assert.equal(open, false);
  assert.equal(posted.some((x) => x.gcp === 'fullscreen'), false, 'the first Esc only closed the menu');
  key('Escape');
  assert.deepEqual({ ...posted.find((x) => x.gcp === 'fullscreen') }, { gcp: 'fullscreen', on: false });
});

test('Esc forwarded by the platform page follows the same rule, and does nothing outside fullscreen', () => {
  const { GCP, posted, send } = loadSdk();
  GCP.onEscape(() => false);
  send({ gcp: 'escape_key' });
  assert.equal(posted.some((x) => x.gcp === 'fullscreen'), false);
  send({ gcp: 'display', fullscreen: true, mode: 'fullscreen', orientation: 'any', touch: false });
  send({ gcp: 'escape_key' });
  assert.equal(posted.filter((x) => x.gcp === 'fullscreen').length, 1);
});

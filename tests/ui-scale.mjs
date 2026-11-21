// GCP.ui: the interface scale (reference size, player size, minView) and the anchor layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadSdk(extra = {}, store = {}) {
  const noop = () => {}, listeners = {}, docListeners = {}, posted = [], props = {}, classes = new Set(), styles = [], timers = [];
  const parent = { postMessage: (m) => posted.push(m) };
  const win = { addEventListener: (k, f) => { (listeners[k] ||= []).push(f); }, requestAnimationFrame: () => 0, location: { search: '', pathname: '/', hash: '' }, history: { replaceState: noop }, parent };
  const html = { style: { setProperty: (k, v) => { props[k] = v; } }, classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } } };
  const ctx = {
    window: win, location: win.location, history: win.history, URLSearchParams, console: { ...console, error: noop }, navigator: {}, parent,
    addEventListener: win.addEventListener, matchMedia: () => ({ matches: false }),
    document: { addEventListener: (k, f) => { (docListeners[k] ||= []).push(f); }, getElementById: () => null, createElement: () => ({ getContext: () => null, style: {} }), documentElement: html, head: { appendChild: (el) => styles.push(el) }, body: null, querySelector: () => null },
    getComputedStyle: (el) => el.style || {},
    performance: { now: () => 0, timeOrigin: 1.7e12 }, setTimeout: (f) => { timers.push(f); return 0; }, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }, innerWidth: 1280, innerHeight: 720, fetch: () => Promise.reject(new Error('offline')), Promise, JSON, Math, Object, Array, Date, Number, String, isFinite, Error, Blob: class {}, Uint8Array, Float32Array,
  };
  Object.assign(ctx, extra);
  win.window = win; Object.assign(win, ctx);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url), 'utf8'), ctx);
  const send = (d) => (listeners.message || []).forEach((f) => f({ source: parent, data: d }));
  const key = (k, game, mods = {}) => { const e = { key: k, repeat: false, ...mods, prevented: false, get defaultPrevented() { return this.prevented; }, preventDefault() { this.prevented = true; } }; (listeners.keydown || []).forEach((f) => f(e)); if (game) game(e); timers.splice(0).forEach((f) => f()); return e; };
  const gesture = () => { const e = { cancelable: true, prevented: false, preventDefault() { this.prevented = true; } }; (docListeners.gesturestart || []).forEach((f) => f(e)); return e; };
  // A one-finger move that starts on target (two fingers with pinch), as the browser sends it.
  const swipe = (target, { pinch = false, game } = {}) => {
    const touches = pinch ? [{}, {}] : [{}];
    const ev = () => ({ target, touches, cancelable: true, prevented: false, get defaultPrevented() { return this.prevented; }, preventDefault() { this.prevented = true; } });
    (docListeners.touchstart || []).forEach((f) => f(ev()));
    const e = ev(); if (game) game(e); (docListeners.touchmove || []).forEach((f) => f(e)); return e;
  };
  const fire = (type) => (listeners[type] || []).forEach((f) => f({ type }));
  const resize = (w, h) => { win.innerWidth = w; win.innerHeight = h; ctx.innerWidth = w; ctx.innerHeight = h; fire('resize'); };
  return { resize, store, GCP: win.GCP, win, posted, props, send, key, classes, styles, gesture, swipe, fire };
}


const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} ${a} != ${b}`);

test('the automatic scale fits the reference size (expand) and is bounded', () => {
  const { GCP, resize } = loadSdk();
  GCP.ui.configure({ reference: [1280, 720] });
  near(GCP.ui.scale, 1);
  resize(1920, 1080); near(GCP.ui.scale, 1.5);
  resize(3440, 1440); near(GCP.ui.scale, 2, 'ultrawide: the height decides');
  near(GCP.ui.view.h, 720); near(GCP.ui.view.w, 1720);
  resize(390, 844); near(GCP.ui.scale, 0.5, 'phone portrait: held at min');
  GCP.ui.configure({ min: 1 }); near(GCP.ui.scale, 1);
});

test('match width, height and a blend', () => {
  const { GCP, resize } = loadSdk();
  resize(2560, 720);
  GCP.ui.configure({ reference: [1280, 720], match: 'width' }); near(GCP.ui.scale, 2);
  GCP.ui.configure({ match: 'height' }); near(GCP.ui.scale, 1);
  GCP.ui.configure({ match: 0.5 }); near(GCP.ui.scale, Math.SQRT2);
});

test('the player size multiplies the scale, is saved, told to the platform and limited by minView', () => {
  const { GCP, resize, posted, store } = loadSdk();
  GCP.ui.configure({ reference: [1280, 720], minView: [640, 360] });
  assert.ok(posted.some((m) => m.gcp === 'ui_info' && m.scalable === true));
  let seen = 0; GCP.ui.onChange(() => { seen++; });
  GCP.ui.setSize(1.5); near(GCP.ui.scale, 1.5); assert.equal(seen, 1);
  assert.ok(posted.some((m) => m.gcp === 'ui_size' && m.size === 1.5));
  assert.equal(Object.values(store)[0], '1.5');
  GCP.ui.configure({ min: 1 }); resize(844, 390);   // a phone on its side: 1.5 would leave fewer than 360 units of height
  near(GCP.ui.auto, 1); near(GCP.ui.scale, 390 / 360); assert.equal(GCP.ui.state.limited, true);
  GCP.ui.setSize(0.8); near(GCP.ui.scale, GCP.ui.auto * 0.8, 'smaller is never limited');
  GCP.ui.setSize(9); assert.equal(GCP.ui.size, 2); GCP.ui.setSize('x'); assert.equal(GCP.ui.size, 2);
});

test('step walks the offered sizes', () => {
  const { GCP } = loadSdk();
  assert.deepEqual([...GCP.ui.sizes], [0.8, 0.9, 1, 1.15, 1.3, 1.5]);
  assert.equal(GCP.ui.step(1), 1.15); assert.equal(GCP.ui.step(1), 1.3); assert.equal(GCP.ui.step(-1), 1.15);
  GCP.ui.setSize(0.8); assert.equal(GCP.ui.step(-1), 0.8);
});

test('the size the platform page sends wins, and a saved size comes back', () => {
  const store = {};
  const a = loadSdk({}, store); a.GCP.ui.setSize(1.3);
  const b = loadSdk({}, store); assert.equal(b.GCP.ui.size, 1.3);
  let got = null; b.GCP.ui.onChange((s) => { got = s.size; });
  b.send({ gcp: 'display', fullscreen: true, uiSize: 0.9 });
  assert.equal(b.GCP.ui.size, 0.9); assert.equal(got, 0.9);
  assert.ok(!b.posted.some((m) => m.gcp === 'ui_size'), 'a size from the page is not echoed back');
});

test('rect places boxes by anchors, margins and pivots like Godot', () => {
  const { GCP } = loadSdk();
  GCP.ui.configure({ reference: [1280, 720] });
  const r = (o, p) => { const x = GCP.ui.rect(o, p); return [x.x, x.y, x.w, x.h]; };
  assert.deepEqual(r({ anchor: 'top-left', w: 100, h: 40, margin: 10 }), [10, 10, 100, 40]);
  assert.deepEqual(r({ anchor: 'top-right', w: 100, h: 40, margin: 10 }), [1170, 10, 100, 40]);
  assert.deepEqual(r({ anchor: 'bottom-right', w: 100, h: 40, margin: [0, 20, 30, 0] }), [1160, 650, 100, 40]);
  assert.deepEqual(r({ anchor: 'center', w: 200, h: 100 }), [540, 310, 200, 100]);
  assert.deepEqual(r({ anchor: 'bottom-wide', h: 60, margin: [0, 16, 8, 16] }), [16, 652, 1248, 60]);
  assert.deepEqual(r({ anchor: 'full', margin: 20 }), [20, 20, 1240, 680]);
  assert.deepEqual(r({ anchor: 'full', margin: 0, maxW: 800 }), [240, 0, 800, 720], 'a capped stretch stays centred');
  assert.deepEqual(r({ anchor: 'full', aspect: 2 }), [0, 0, 1280, 640].map((v, i) => (i === 1 ? 40 : v)));
  assert.deepEqual(r({ anchor: [0.25, 0, 0.75, 1] }), [320, 0, 640, 720]);
  assert.deepEqual(r({ anchor: 'top', w: 100, h: 20 }, { x: 100, y: 100, w: 400, h: 300 }), [250, 100, 100, 20]);
  assert.deepEqual(r({ anchor: 'top-left', w: 100, h: 40, offset: [-50, 0] }), [0, 0, 100, 40], 'kept inside the view');
});

test('rect keeps clear of the safe area, in interface units', () => {
  const { GCP, send, resize } = loadSdk();
  resize(2560, 1440); GCP.ui.configure({ reference: [1280, 720] });
  send({ gcp: 'display', fullscreen: true, edgeToEdge: true, safe: { top: 0, right: 0, bottom: 40, left: 120 } });
  assert.deepEqual({ ...GCP.ui.safe }, { top: 0, right: 0, bottom: 20, left: 60 });
  const b = GCP.ui.rect({ anchor: 'bottom-left', w: 50, h: 50 });
  assert.equal(b.x, 60); assert.equal(b.y, 720 - 20 - 50);
  const n = GCP.ui.rect({ anchor: 'bottom-left', w: 50, h: 50, safe: false }); assert.equal(n.x, 0);
});

test('split shares a box like HBox and VBox', () => {
  const { GCP } = loadSdk();
  const parts = GCP.ui.split({ x: 0, y: 0, w: 500, h: 50 }, 'row', [100, { fill: 1 }, { fill: 3 }], 10);
  assert.deepEqual(parts.map((p) => [p.x, p.w]), [[0, 100], [110, 95], [215, 285]]);
  const col = GCP.ui.split({ x: 0, y: 0, w: 50, h: 300 }, 'column', [{ fill: 1 }, { fill: 1 }]);
  assert.deepEqual(col.map((p) => [p.y, p.h]), [[0, 150], [150, 150]]);
});

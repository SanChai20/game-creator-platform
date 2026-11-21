// The game runtime (web/public/sdk/gcp.js): the fixes that make every game behave the same in every browser, registered
// by name and reported through GCP.runtime. Each one only fills in what is missing, so a modern browser is left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SDK = fs.readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url), 'utf8');

/** Runs the SDK in a small fake page. before(ctx) runs in the page first (to take features away, as an old browser would). */
function load({ framed = true, before = '', storageThrows = false, navigator = {}, styles = [] } = {}) {
  const noop = () => {}, listeners = {}, posted = [], timers = [];
  class Element extends EventTarget { constructor(id) { super(); this.id = id; this.attrs = {}; this.isConnected = true; } setAttribute(k, v) { this.attrs[k] = v; } removeAttribute(k) { delete this.attrs[k]; } }
  class Document extends EventTarget {}
  class Navigator {}
  const html = new Element('html'); html.style = { setProperty: noop }; html.classList = { toggle: noop };
  const doc = new Document();
  Object.assign(doc, { documentElement: html, head: { appendChild: noop }, body: null, getElementById: () => null, createElement: () => ({ getContext: () => null, style: {}, setAttribute: noop }), querySelector: () => null });
  const parent = { postMessage: (m) => posted.push(m) };
  const win = { addEventListener: (k, f) => { (listeners[k] ||= []).push(f); }, requestAnimationFrame: () => 0, location: { search: '', pathname: '/', hash: '' }, history: { replaceState: noop } };
  win.parent = framed ? parent : win;
  const nav = Object.assign(new Navigator(), navigator);
  const store = { getItem: () => null, setItem: noop, removeItem: noop };
  const ctx = {
    window: win, location: win.location, history: win.history, URLSearchParams, console: { ...console, error: noop }, navigator: nav, Navigator, parent: win.parent,
    addEventListener: win.addEventListener, matchMedia: () => ({ matches: false, addEventListener: noop }), screen: { width: 1920, height: 1080 },
    document: doc, Element, Document, EventTarget, Event, DOMException, getComputedStyle: () => ({}),
    performance: { now: () => 0, timeOrigin: 1.7e12 }, setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    __styles: styles, fetch: () => Promise.reject(new Error('offline')), Blob: class {}, Int8Array, Uint8Array, Float32Array, ArrayBuffer, DataView, Map, Set, WeakMap, WeakSet, Reflect, Symbol, Promise,
  };
  if (framed) ctx.__GCP_CONFIG = { api: 'https://p.example', token: '', gameId: 'g', version: 1, env: 'live', base: '', player: { id: 'u', name: 'U' }, kind: 'player', session: 's' };
  win.window = win; Object.assign(win, ctx);
  Object.defineProperty(win, 'localStorage', { configurable: true, get: () => { if (storageThrows) throw new DOMException('The operation is insecure.', 'SecurityError'); return store; } });
  Object.defineProperty(win, 'sessionStorage', { configurable: true, get: () => { if (storageThrows) throw new DOMException('The operation is insecure.', 'SecurityError'); return store; } });
  vm.createContext(win);
  if (before) vm.runInContext(before, win);
  vm.runInContext(SDK, win);
  const send = (d) => (listeners.message || []).forEach((f) => f({ source: parent, data: d }));
  const flush = () => { while (timers.length) timers.shift()(); };
  return { win, GCP: win.GCP, posted, send, flush, html, doc, Element };
}

test('GCP.runtime names the runtime version and the fixes that are on', () => {
  const { GCP, win } = load();
  assert.match(GCP.runtime.version, /^\d+\.\d+\.\d+$/);
  assert.ok(Array.isArray(GCP.runtime.fixes));
  assert.ok(GCP.runtime.fixes.includes('fullscreen-api'));
  assert.deepEqual(win.__GCP.runtime, GCP.runtime);   // the verifier reads the same
});

test('built-ins an older Safari lacks are filled in and behave like the standard ones', () => {
  const { win, GCP } = load({ before: 'delete Array.prototype.at; delete String.prototype.at; delete Array.prototype.findLast; delete Array.prototype.toSorted; delete Object.hasOwn; delete Object.groupBy; delete Promise.withResolvers;' });
  const r = vm.runInContext(`({
    at: [1, 2, 3].at(-1), at2: 'abc'.at(0), out: [1].at(5),
    last: [1, 2, 3, 4].findLast((x) => x % 2), sorted: [3, 1, 2].toSorted().join(), hasOwn: Object.hasOwn({ a: 1 }, 'a'),
    groups: JSON.stringify(Object.groupBy([1, 2, 3], (x) => (x % 2 ? 'odd' : 'even'))), wr: typeof Promise.withResolvers().resolve,
  })`, win);
  assert.deepEqual({ ...r }, { at: 3, at2: 'a', out: undefined, last: 3, sorted: '1,2,3', hasOwn: true, groups: '{"odd":[1,3],"even":[2]}', wr: 'function' });
  assert.ok(GCP.runtime.fixes.includes('js-builtins'));
});

test('a modern browser keeps its own built-ins (nothing is replaced)', () => {
  const { win, GCP } = load();
  assert.equal(vm.runInContext('Array.prototype.at === [].at && !Object.getOwnPropertyDescriptor(Array.prototype, "at").value.toString().includes("rel(")', win), true);
  assert.ok(!GCP.runtime.fixes.includes('js-builtins'));
});

test('structuredClone is filled in with Map, Set, Date, typed arrays and cycles kept', () => {
  const { win } = load();
  const r = vm.runInContext(`(() => { const o = { d: new Date(5), m: new Map([[1, 'a']]), s: new Set([2]), t: new Uint8Array([7, 8]) }; o.self = o;
    const c = structuredClone(o); return [c !== o, c.self === c, c.d.getTime(), c.m.get(1), c.s.has(2), c.t[1], c.t !== o.t]; })()`, win);
  assert.deepEqual([...r], [true, true, 5, 'a', true, 8, true]);
  assert.throws(() => vm.runInContext('structuredClone({ f() {} })', win), /could not be cloned/);
});

test('requestIdleCallback and navigator.vibrate exist where the browser has none', () => {
  const { win, flush, GCP } = load();
  let got = null; vm.runInContext('requestIdleCallback', win)((d) => { got = d; }); flush();
  assert.equal(typeof got.timeRemaining(), 'number');
  assert.equal(win.navigator.vibrate(100), false);
  for (const f of ['idle-callback', 'vibrate']) assert.ok(GCP.runtime.fixes.includes(f), f);
});

test('storage the browser refuses to the frame keeps working in memory', () => {
  const { win, GCP } = load({ storageThrows: true });
  win.localStorage.setItem('k', 1);
  assert.equal(win.localStorage.getItem('k'), '1');
  assert.equal(win.localStorage.length, 1);
  win.localStorage.clear(); assert.equal(win.localStorage.getItem('k'), null);
  assert.ok(GCP.runtime.fixes.includes('storage'));
});

test('element.requestFullscreen() in the player asks the player and follows it', async () => {
  const { win, posted, send, Element, doc } = load();
  const canvas = new Element('c'); const events = [];
  canvas.addEventListener('fullscreenchange', () => events.push(!!doc.fullscreenElement));   // it bubbles up to the document in a real page
  assert.equal(doc.fullscreenElement, null); assert.equal(doc.fullscreenEnabled, true);
  const p = canvas.requestFullscreen();
  assert.deepEqual({ ...posted.at(-1) }, { gcp: 'fullscreen', on: true });
  send({ gcp: 'display', fullscreen: true, mode: 'immersive', touch: true });
  await p;
  assert.equal(doc.fullscreenElement, canvas);
  assert.equal(canvas.attrs['data-gcp-fullscreen'], '');   // it fills the frame, as the browser's own fullscreen would show it
  const q = doc.exitFullscreen();
  assert.deepEqual({ ...posted.at(-1) }, { gcp: 'fullscreen', on: false });
  send({ gcp: 'display', fullscreen: false, mode: 'inline', touch: true });
  await q;
  assert.equal(doc.fullscreenElement, null);
  assert.equal(canvas.attrs['data-gcp-fullscreen'], undefined);
  assert.deepEqual(events, [true, false]);
  assert.equal(typeof win.Element.prototype.webkitRequestFullscreen, 'function');
});

test('outside the player the browser keeps its own fullscreen', () => {
  const { win } = load({ framed: false, before: 'Element.prototype.requestFullscreen = function () { return "native"; };' });
  assert.ok(!win.GCP.runtime.fixes.includes('fullscreen-api'));
  assert.equal(new win.Element('x').requestFullscreen(), 'native');
});

test('screen.orientation.lock() asks the player; a stand-in exists where the browser has none', async () => {
  const { win, posted, GCP } = load();
  assert.equal(win.screen.orientation.type, 'landscape-primary');
  await win.screen.orientation.lock('portrait-primary');
  assert.deepEqual({ ...posted.at(-1) }, { gcp: 'display_prefs', orientation: 'portrait' });
  assert.ok(GCP.runtime.fixes.includes('orientation-lock'));
});

test('font-ready: the page stays out of sight until the fonts the platform started are in, and never longer than the cap', async () => {
  const styles = [];
  const before = `document.head.appendChild = (el) => { el.remove = () => { el.removed = true; }; __styles.push(el); };
    document.createElement = () => ({ style: {}, setAttribute() {}, getContext: () => null });
    document.readyState = 'complete'; document.fonts = { ready: Promise.resolve() };`;
  // no fonts listed: nothing is held
  const plain = load();
  assert.equal(plain.GCP.runtime.fixes.includes('font-ready'), false);
  // fonts listed: held, then shown once they are ready
  const { win } = (() => { const l = loadWithFonts(before, styles); return l; })();
  const hold = styles.filter((s) => s.id === 'gcp-font-hold');
  assert.equal(hold.length, 1);
  assert.match(hold[0].textContent, /visibility:hidden/);
  assert.ok(win.GCP.runtime.fixes.includes('font-ready'));
  await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  win.__frames.splice(0).forEach((f) => f()); win.__frames.splice(0).forEach((f) => f());
  assert.equal(hold[0].removed, true);
});

test('font-ready: the cap shows the page even if a font never arrives, and ready() shows it at once', () => {
  const styles = [];
  const before = `document.head.appendChild = (el) => { el.remove = () => { el.removed = true; }; __styles.push(el); };
    document.createElement = () => ({ style: {}, setAttribute() {}, getContext: () => null });
    document.readyState = 'loading'; document.fonts = { ready: new Promise(() => {}) };`;
  const holds = () => styles.filter((s) => s.id === 'gcp-font-hold');
  const a = loadWithFonts(before, styles);
  assert.equal(holds()[0].removed, undefined);
  a.flush();   // the timers run: the cap among them
  assert.equal(holds()[0].removed, true);
  const b = loadWithFonts(before, styles);
  assert.equal(holds()[1].removed, undefined);
  b.GCP.ready();
  assert.equal(holds()[1].removed, true);
});

function loadWithFonts(before, styles) {
  return load({ before: `__GCP_CONFIG.fonts = ['/fonts/a.woff2']; window.__styles = __styles; window.__frames = []; window.requestAnimationFrame = (f) => { window.__frames.push(f); return 1; }; requestAnimationFrame = window.requestAnimationFrame; ${before}`, styles });
}

// GCP.display: edge-to-edge fullscreen passes the screen's safe-area insets into the game frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadSdk(extra = {}) {
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
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, fetch: () => Promise.reject(new Error('offline')), Promise, JSON, Math, Object, Array, Date, Number, String, isFinite, Error, Blob: class {}, Uint8Array, Float32Array,
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
  return { GCP: win.GCP, win, posted, props, send, key, classes, styles, gesture, swipe, fire };
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

test('the Escape rule: the game closes its menu first, and only then does Esc open the platform menu', () => {
  const { GCP, posted, send, key } = loadSdk();
  let open = true; GCP.onEscape(() => { if (open) { open = false; return true; } return false; });
  assert.deepEqual({ ...posted.find((x) => x.gcp === 'escape') }, { gcp: 'escape', on: true });
  send({ gcp: 'display', fullscreen: true, mode: 'fullscreen', orientation: 'any', touch: false });
  const first = key('Escape');
  assert.equal(first.prevented, true); assert.equal(open, false);
  assert.equal(posted.some((x) => x.gcp === 'menu'), false, 'the first Esc only closed the game menu');
  key('Escape');
  assert.deepEqual({ ...posted.find((x) => x.gcp === 'menu') }, { gcp: 'menu', on: true });
  assert.equal(posted.some((x) => x.gcp === 'fullscreen'), false, 'Esc never leaves fullscreen');
});

test('Esc forwarded by the platform page follows the same rule, and does nothing outside the player', () => {
  const { GCP, posted, send } = loadSdk();
  GCP.onEscape(() => false);
  send({ gcp: 'escape_key' });
  assert.equal(posted.some((x) => x.gcp === 'menu'), false);
  send({ gcp: 'display', fullscreen: true, mode: 'fullscreen', orientation: 'any', touch: false });
  send({ gcp: 'escape_key' });
  assert.equal(posted.filter((x) => x.gcp === 'menu').length, 1);
});

test('a game without onEscape: Esc opens the platform menu unless the game took the key itself', () => {
  const { posted, send, key } = loadSdk();
  key('Escape');
  assert.equal(posted.some((x) => x.gcp === 'menu'), false, 'outside the player Esc is the game\'s');
  send({ gcp: 'display', fullscreen: true, mode: 'fullscreen', orientation: 'any', touch: false });
  key('Escape', (e) => e.preventDefault());
  assert.equal(posted.some((x) => x.gcp === 'menu'), false, 'the game used Esc');
  key('Escape');
  assert.equal(posted.filter((x) => x.gcp === 'menu').length, 1);
});

test('menu, quit and fullscreen(false) go to the platform page', () => {
  const { GCP, posted } = loadSdk();
  GCP.menu(); GCP.menu(false); GCP.quit(); GCP.fullscreen(false);
  assert.deepEqual(posted.filter((x) => x.gcp !== 'display_query').map((x) => ({ ...x })), [{ gcp: 'menu' }, { gcp: 'menu', on: false }, { gcp: 'quit' }, { gcp: 'fullscreen', on: false }]);
});

test('display carries paused and menu', () => {
  const { GCP, send } = loadSdk();
  assert.equal(GCP.display.paused, false);
  send({ gcp: 'display', fullscreen: true, mode: 'fullscreen', paused: true, menu: true });
  assert.equal(GCP.display.paused, true); assert.equal(GCP.display.menu, true);
});

test('on a touch screen in the player, the game cannot be pinched or overscrolled', () => {
  const { send, classes, styles, gesture } = loadSdk();
  assert.equal(gesture().prevented, false);
  send({ gcp: 'display', fullscreen: true, mode: 'fullscreen', touch: true });
  assert.ok(classes.has('gcp-guard'));
  assert.match(styles[0].textContent, /overscroll-behavior:none/);
  assert.equal(gesture().prevented, true);
  send({ gcp: 'display', fullscreen: false, mode: 'inline', touch: true });
  assert.ok(!classes.has('gcp-guard'));
  assert.equal(gesture().prevented, false);
});

test('the guard never loosens the game\'s own touch-action', () => {
  const { send, styles } = loadSdk();
  send({ gcp: 'display', fullscreen: true, mode: 'fullscreen', touch: true });
  const css = styles[0].textContent;
  // pan-only sits on <html> alone, with no specificity, so a game's touch-action:none on html or body wins
  assert.match(css, /:where\(html\.gcp-guard\)\{touch-action:pan-x pan-y\}/);
  assert.doesNotMatch(css.replace(/:where\(html\.gcp-guard\)\{[^}]*\}/, ''), /touch-action/);
});

test('in fullscreen on a computer, overscroll (a trackpad swipe) stays in the game too', () => {
  const { send, classes } = loadSdk();
  send({ gcp: 'display', fullscreen: true, mode: 'fullscreen', touch: false });
  assert.ok(classes.has('gcp-guard'));
});

test('a swipe over the game is cancelled for the browser; a swipe in a scrolling list is not', () => {
  const { send, swipe } = loadSdk();
  const html = { nodeType: 1, tagName: 'HTML' };
  const canvas = { nodeType: 1, tagName: 'CANVAS', style: { overflowX: 'visible', overflowY: 'visible' }, parentNode: html };
  const list = { nodeType: 1, tagName: 'DIV', style: { overflowX: 'hidden', overflowY: 'auto' }, scrollHeight: 900, clientHeight: 300, scrollWidth: 200, clientWidth: 200, parentNode: html };
  const row = { nodeType: 1, tagName: 'DIV', style: { overflowX: 'visible', overflowY: 'visible' }, parentNode: list };
  const slider = { nodeType: 1, tagName: 'INPUT', style: {}, parentNode: html };
  assert.equal(swipe(canvas).prevented, false, 'outside fullscreen the page is the game\'s own');
  send({ gcp: 'display', fullscreen: true, mode: 'fullscreen', touch: true });
  assert.equal(swipe(canvas).prevented, true);
  assert.equal(swipe(row).prevented, false, 'the game\'s scrolling list still scrolls');
  assert.equal(swipe(slider).prevented, false);
  assert.equal(swipe(row, { pinch: true }).prevented, true, 'never a pinch');
  send({ gcp: 'display', fullscreen: true, mode: 'fullscreen', touch: false });
  assert.equal(swipe(canvas).prevented, true, 'a computer\'s touch screen too');
  send({ gcp: 'display', fullscreen: false, mode: 'inline', touch: false });
  assert.equal(swipe(canvas).prevented, false);
});

test('the watchdog: the SDK answers the player\'s ping with its frame count', () => {
  const { posted, send } = loadSdk();
  send({ gcp: 'ping', n: 7 });
  const m = posted.find((x) => x.gcp === 'pong');
  assert.equal(m.n, 7); assert.equal(typeof m.frames, 'number');
});

test('Alt+Enter pressed in the game asks the player to toggle fullscreen', () => {
  const { posted, key } = loadSdk();
  const e = key('Enter', null, { altKey: true });
  assert.equal(e.prevented, true);
  assert.deepEqual({ ...posted.find((x) => x.gcp === 'fullscreen') }, { gcp: 'fullscreen' });
  key('Enter');
  assert.equal(posted.filter((x) => x.gcp === 'fullscreen').length, 1, 'plain Enter is the game\'s');
});

test('a platform language switch updates GCP.lang and calls onLang, without reloading the game', () => {
  const { GCP, send } = loadSdk();
  const before = GCP.lang, heard = [];
  const off = GCP.onLang((l, was) => heard.push([l, was]));
  send({ gcp: 'lang', lang: 'ja' });
  assert.equal(GCP.lang, 'ja');
  assert.deepEqual(heard, [['ja', before]]);
  send({ gcp: 'lang', lang: 'ja' });             // the same language again (the frame is told on load too): no call
  send({ gcp: 'lang', lang: '<script>' });       // not a language tag: ignored
  assert.equal(heard.length, 1);
  send({ gcp: 'lang', lang: 'zh-TW' });
  assert.deepEqual(heard[1], ['zh-TW', 'ja']);
  off(); send({ gcp: 'lang', lang: 'es' });
  assert.equal(GCP.lang, 'es');
  assert.equal(heard.length, 2);
});

// A stand-in for the browser's AudioContext: resume() only works inside a gesture the browser counts.
function fakeAudio() {
  const gate = { open: false };
  class AudioContext {
    constructor() { this.state = gate.open ? 'running' : 'suspended'; this.fns = []; }
    addEventListener(k, f) { if (k === 'statechange') this.fns.push(f); }
    set(st) { this.state = st; this.fns.forEach((f) => f()); }
    resume() { if (gate.open && this.state !== 'closed') this.set('running'); return Promise.resolve(); }
    suspend() { this.set('suspended'); return Promise.resolve(); }
    close() { this.set('closed'); return Promise.resolve(); }
  }
  return { AudioContext, gate };
}
const gestureEnd = (sdk, gate, type = 'touchend') => { gate.open = true; sdk.fire(type); gate.open = false; };

test('sound made on pointerdown starts on the same tap (iPhone and iPad only unlock audio on touchend)', () => {
  const { AudioContext, gate } = fakeAudio();
  const sdk = loadSdk({ AudioContext });
  const ctx = new sdk.win.AudioContext();     // the game, in its pointerdown handler: not a gesture on iOS
  ctx.resume();
  assert.equal(ctx.state, 'suspended');
  gestureEnd(sdk, gate);
  assert.equal(ctx.state, 'running');
});

test('a context the game suspended itself stays suspended until the game resumes it', () => {
  const { AudioContext, gate } = fakeAudio();
  const sdk = loadSdk({ AudioContext });
  gate.open = true; const ctx = new sdk.win.AudioContext(); gate.open = false;
  ctx.suspend();
  gestureEnd(sdk, gate, 'click');
  assert.equal(ctx.state, 'suspended', 'the game paused its sound');
  ctx.resume();                                // the game resumes outside a gesture (tab shown again): refused
  assert.equal(ctx.state, 'suspended');
  gestureEnd(sdk, gate, 'pointerup');
  assert.equal(ctx.state, 'running', 'the next tap finishes the game\'s resume');
  ctx.set('interrupted');                      // iOS: a call or the lock screen
  gestureEnd(sdk, gate, 'keydown');
  assert.equal(ctx.state, 'running');
});

test('subclasses of AudioContext keep their own class', () => {
  const { AudioContext } = fakeAudio();
  const sdk = loadSdk({ AudioContext });
  const Sub = class extends sdk.win.AudioContext { hi() { return 'hi'; } };
  const c = new Sub();
  assert.equal(c.hi(), 'hi');
  assert.ok(c instanceof Sub); assert.ok(c instanceof AudioContext); assert.ok(new sdk.win.AudioContext() instanceof AudioContext);
});

// Canvas roundRect() for browsers without it (iOS and Safari before 16, Firefox before 112): Void Echoes stopped there.
function recorder() {
  return class { constructor() { this.ops = []; } moveTo(x, y) { this.ops.push(['M', x, y]); } lineTo(x, y) { this.ops.push(['L', x, y]); } arcTo(...a) { this.ops.push(['A', ...a]); } closePath() { this.ops.push(['Z']); } };
}
test('roundRect is filled in only where the browser has none', () => {
  const Ctx = recorder(), Path = recorder(), native = function () {};
  class Has { roundRect() { return native; } }
  const { win } = loadSdk({ CanvasRenderingContext2D: Ctx, Path2D: Path, OffscreenCanvasRenderingContext2D: Has, RangeError });
  assert.equal(typeof win.CanvasRenderingContext2D.prototype.roundRect, 'function');
  assert.equal(typeof win.Path2D.prototype.roundRect, 'function');
  assert.equal(new Has().roundRect(), native, 'a browser that has it keeps its own');
});
test('roundRect draws the standard path: corners, radius lists, oversize radii and negative sizes', () => {
  const Ctx = recorder();
  loadSdk({ CanvasRenderingContext2D: Ctx, RangeError });
  const draw = (...a) => { const g = new Ctx(); g.roundRect(...a); return g.ops; };
  assert.deepEqual(draw(0, 0, 100, 50, 10), [['M', 10, 0], ['L', 90, 0], ['A', 100, 0, 100, 10, 10], ['L', 100, 40], ['A', 100, 50, 90, 50, 10], ['L', 10, 50], ['A', 0, 50, 0, 40, 10], ['L', 0, 10], ['A', 0, 0, 10, 0, 10], ['Z'], ['M', 0, 0]]);
  assert.deepEqual(draw(0, 0, 10, 10).filter((o) => o[0] === 'A'), [], 'no radius: a plain box');
  const arcs = (ops) => ops.filter((o) => o[0] === 'A').map((o) => o[5]);
  assert.deepEqual(arcs(draw(0, 0, 100, 50, [1, 2])), [2, 1, 2, 1], 'two radii: top-left/bottom-right, then top-right/bottom-left');
  assert.deepEqual(arcs(draw(0, 0, 100, 50, [1, 2, 3])), [2, 3, 2, 1]);
  assert.deepEqual(arcs(draw(0, 0, 100, 50, [{ x: 4, y: 4 }, 2, 3, 1])), [2, 3, 1, 4], 'DOMPoint radii use x');
  assert.deepEqual(arcs(draw(0, 0, 40, 40, 100)), [20, 20, 20, 20], 'radii too big for the box shrink together');
  assert.deepEqual(draw(100, 50, -100, -50, 10)[0], ['M', 10, 0], 'a negative size draws the same box');
  assert.throws(() => draw(0, 0, 10, 10, -1), RangeError);
  assert.throws(() => draw(0, 0, 10, 10, [1, 2, 3, 4, 5]), RangeError);
  assert.deepEqual(draw(NaN, 0, 10, 10, 2), [], 'non-finite sizes draw nothing');
});

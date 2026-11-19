// GCP.display: edge-to-edge fullscreen passes the screen's safe-area insets into the game frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadSdk() {
  const noop = () => {}, listeners = {}, docListeners = {}, posted = [], props = {}, classes = new Set(), styles = [], timers = [];
  const parent = { postMessage: (m) => posted.push(m) };
  const win = { addEventListener: (k, f) => { (listeners[k] ||= []).push(f); }, requestAnimationFrame: () => 0, location: { search: '', pathname: '/', hash: '' }, history: { replaceState: noop }, parent };
  const html = { style: { setProperty: (k, v) => { props[k] = v; } }, classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } } };
  const ctx = {
    window: win, location: win.location, history: win.history, URLSearchParams, console: { ...console, error: noop }, navigator: {}, parent,
    addEventListener: win.addEventListener, matchMedia: () => ({ matches: false }),
    document: { addEventListener: (k, f) => { (docListeners[k] ||= []).push(f); }, getElementById: () => null, createElement: () => ({ getContext: () => null, style: {} }), documentElement: html, head: { appendChild: (el) => styles.push(el) }, body: null, querySelector: () => null },
    performance: { now: () => 0, timeOrigin: 1.7e12 }, setTimeout: (f) => { timers.push(f); return 0; }, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, fetch: () => Promise.reject(new Error('offline')), Promise, JSON, Math, Object, Array, Date, Number, String, isFinite, Error, Blob: class {}, Uint8Array, Float32Array,
  };
  win.window = win; Object.assign(win, ctx);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url), 'utf8'), ctx);
  const send = (d) => (listeners.message || []).forEach((f) => f({ source: parent, data: d }));
  const key = (k, game, mods = {}) => { const e = { key: k, repeat: false, ...mods, prevented: false, get defaultPrevented() { return this.prevented; }, preventDefault() { this.prevented = true; } }; (listeners.keydown || []).forEach((f) => f(e)); if (game) game(e); timers.splice(0).forEach((f) => f()); return e; };
  const gesture = () => { const e = { cancelable: true, prevented: false, preventDefault() { this.prevented = true; } }; (docListeners.gesturestart || []).forEach((f) => f(e)); return e; };
  return { GCP: win.GCP, posted, props, send, key, classes, styles, gesture };
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
  assert.match(styles[0].textContent, /touch-action:pan-x pan-y/);
  assert.equal(gesture().prevented, true);
  send({ gcp: 'display', fullscreen: false, mode: 'inline', touch: true });
  assert.ok(!classes.has('gcp-guard'));
  assert.equal(gesture().prevented, false);
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

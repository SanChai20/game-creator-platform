// Big-screen mode: the controller's spatial navigation on the platform's pages (web/src/gamepad.ts) and the SDK handing the
// platform its menu on the Home button or Start + Select (web/public/sdk/gcp.js, 2.17.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { nearest } from '../web/src/gamepad.ts';

const R = (x, y, w = 100, h = 60) => ({ x, y, w, h });

test('the focus moves to the nearest control in that direction, in line first', () => {
  // two rows of tiles; the second row is scrolled so its tiles sit half a tile to the right
  const row1 = [R(0, 0), R(120, 0), R(240, 0)], row2 = [R(60, 100), R(180, 100), R(300, 100)];
  const all = [...row1, ...row2];
  assert.equal(nearest(row1[0], 'right', all), 1);
  assert.equal(nearest(row1[2], 'right', all), -1, 'nothing further right on that row');
  assert.equal(nearest(row1[1], 'left', all), 0);
  assert.equal(all[nearest(row1[1], 'down', all)], row2[0], 'the tile below that overlaps it, nearest the centre first');
  assert.equal(all[nearest(row2[2], 'up', all)], row1[2]);
  assert.equal(nearest(row1[0], 'up', all), -1);
  // a control off to the side counts as farther than one in line
  const header = [R(500, -200, 80, 30), R(10, -200, 80, 30)];
  assert.equal(nearest(row1[0], 'up', [...all, ...header]), 7);
});

function sdk(pads) {
  const posted = [], frames = [], noop = () => {};
  const win = { addEventListener: (t, fn) => { (win._l ||= {})[t] = fn; }, parent: { postMessage: (m) => posted.push(m) }, requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; }, location: { search: '', pathname: '/', hash: '', origin: 'https://g.example' }, history: { replaceState: noop },
    __GCP_CONFIG: { api: 'https://p.example', token: 'tok', gameId: 'g', version: 1, env: 'live', base: '/play/g', player: { id: 'u', name: 'U' }, kind: 'player', session: 's' } };
  let now = 0;
  const ctx = {
    window: win, parent: win.parent, location: win.location, history: win.history, URLSearchParams, URL, console: { ...console, error: noop, log: noop, warn: noop }, navigator: { getGamepads: () => pads.list },
    document: { addEventListener: noop, createElement: () => ({ getContext: () => null, style: {} }), documentElement: { style: {} }, head: { appendChild: noop }, body: null, querySelector: () => null },
    performance: { now: () => now, timeOrigin: 1.7e12 }, setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop, requestAnimationFrame: win.requestAnimationFrame,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, fetch: () => Promise.reject(new Error('offline')), Promise, JSON, Math, Object, Array, Date, Number, String, isFinite, Error, Blob: class {}, Uint8Array, Float32Array, ArrayBuffer, WebSocket: class {}, encodeURIComponent,
  };
  win.window = win; Object.assign(win, ctx); vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url), 'utf8'), ctx);
  const step = (ms = 16) => { now += ms; for (const fn of frames.splice(0)) fn(now); };
  return { posted, step };
}
const pad = (pressed = []) => ({ id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })) });
const menus = (posted) => posted.filter((m) => m && m.gcp === 'menu').length;

test('the Home button, or Start + Select held, opens the platform menu; Start alone stays the game\'s', () => {
  const pads = { list: [pad()] }, s = sdk(pads);
  s.step(); assert.equal(menus(s.posted), 0);
  pads.list = [pad([9])]; for (let i = 0; i < 60; i++) s.step();
  assert.equal(menus(s.posted), 0, 'Start alone is the game\'s pause');
  pads.list = [pad([8, 9])]; s.step(); s.step(100);
  assert.equal(menus(s.posted), 0, 'not before half a second');
  s.step(500); assert.equal(menus(s.posted), 1);
  pads.list = [pad()]; s.step(1200);
  pads.list = [pad([16])]; s.step(); assert.equal(menus(s.posted), 2);
  s.step(); s.step(2000); assert.equal(menus(s.posted), 2, 'once per press');
  // the touch layer's stand-in controller never counts
  const t = { list: [{ ...pad([16]), id: 'HearthCade touch controls (STANDARD GAMEPAD Vendor: 0000 Product: 0000)' }] }, s2 = sdk(t);
  s2.step(); s2.step(); assert.equal(menus(s2.posted), 0);
});

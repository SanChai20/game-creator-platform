// Exact feedback screenshots (web/src/capture.ts): the arithmetic that cuts the game out of the browser's tab capture.
// It must hold at any device pixel ratio, browser zoom, frame size cap, letterboxing and pinch zoom, and must catch a
// frame the browser drew into only its top-left part (the shrunken-picture bug) without mistaking a dark game for one.
// tests/capture-browser.mjs runs the same module in real browsers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { fitView, rectInFrame, drawnPart } = await import('../web/src/capture.ts');

const near = (a, b, d = 0.01) => assert.ok(Math.abs(a - b) <= d, `${a} ≠ ${b}`);
const game = { left: 112.5, top: 126.4, width: 1040, height: 585 };

test('the game is found in the frame at any pixel ratio or zoom', () => {
  // the frame is the viewport in device pixels: a ratio of 1, 1.25, 1.5, 1.75, 2, 3, and zoom levels (90 %, 110 %, 133 %)
  for (const k of [1, 1.25, 1.5, 1.75, 2, 3, 0.9 * 1.25, 1.1, 1.333]) {
    const view = { width: 1280, height: 863 }, fw = Math.round(1280 * k), fh = Math.round(863 * k);
    const m = fitView(fw, fh, view); assert.ok(m.fits, `fits at ${k}`);
    const c = rectInFrame(game, fw, fh, m, view);
    near(c.x, 112.5 * k, 1); near(c.y, 126.4 * k, 1); near(c.w, 1040 * k, 1.5); near(c.h, 585 * k, 1.5);
  }
});

test('a frame the browser capped or letterboxed still maps right', () => {
  // a 4K tab sent at most 1920 wide: same shape, smaller
  const view = { width: 3840, height: 2160 }, m = fitView(1920, 1080, view);
  assert.ok(m.fits); near(m.k, 0.5);
  // a frame of another shape (sent before a resize finished, or a fixed-size capture): bars, flagged as not fitting
  const v2 = { width: 1000, height: 1000 }, m2 = fitView(1600, 900, v2);
  assert.equal(m2.fits, false); near(m2.k, 0.9); near(m2.ox, 350); near(m2.oy, 0);
  const c = rectInFrame({ left: 0, top: 0, width: 1000, height: 1000 }, 1600, 900, m2, v2);
  near(c.x, 350); near(c.w, 900); near(c.h, 900);
});

test('pinch zoom shows only the visual viewport, magnified', () => {
  const view = { width: 1000, height: 600, vvLeft: 200, vvTop: 100, vvScale: 2 };
  const m = fitView(1000, 600, view);
  const c = rectInFrame({ left: 250, top: 150, width: 100, height: 50 }, 1000, 600, m, view);
  near(c.x, 100); near(c.y, 100); near(c.w, 200); near(c.h, 100);
});

test('a game partly off screen is cut at the frame edges', () => {
  const view = { width: 800, height: 600 }, m = fitView(1600, 1200, view);
  const c = rectInFrame({ left: -100, top: 500, width: 400, height: 300 }, 1600, 1200, m, view);
  assert.deepEqual([c.x, c.y, c.w, c.h], [0, 1000, 600, 200]);
});

// a frame as the check reads it: sw × sh cells, each lit (a page) or exact black
const frame = (sw, sh, lit) => (x, y) => (lit(x, y) ? 120 : 0);
test('a tab drawn into the top-left part of its frame is caught', () => {
  // the bug as reported: the page in the top-left 57 %, black around it
  const p = drawnPart(frame(96, 54, (x, y) => x < 55 && y < 31), 96, 54);
  assert.ok(p); near(p.w, 55 / 96); near(p.h, 31 / 54);
  // half and half (a 2× mismatch)
  assert.ok(drawnPart(frame(96, 54, (x, y) => x < 48 && y < 27), 96, 54));
});

test('a normal or dark page is never taken for a shrunken one', () => {
  assert.equal(drawnPart(frame(96, 54, () => true), 96, 54), null);                       // filled
  assert.equal(drawnPart(frame(96, 54, () => false), 96, 54), null);                      // all black: nothing to go by
  assert.equal(drawnPart(frame(96, 54, (x) => x < 60), 96, 54), null);                    // dark right side only
  assert.equal(drawnPart(frame(96, 54, (x, y) => y < 30), 96, 54), null);                 // dark bottom only
  assert.equal(drawnPart(frame(96, 54, (x, y) => x < 70 && y < 20), 96, 54), null);       // dark corner of another shape
  // a dark scene with a few lit things in its top-left: not lit along its own left and top edges
  assert.equal(drawnPart(frame(96, 54, (x, y) => x > 20 && x < 50 && y > 10 && y < 27), 96, 54), null);
  // dark grey is a page, not the browser's black
  const grey = (x, y) => (x < 55 && y < 31 ? 120 : 14);
  assert.equal(drawnPart(grey, 96, 54), null);
});

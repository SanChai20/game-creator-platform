// iPhone Safari's bars over a game (web/src/tuck.ts): when the player asks for the swipe that tucks them away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barsShowing, tuckLook, tuckStart, TUCK_WAIT } from '../web/src/tuck.ts';

test('bars count as showing when the page is shorter than it can be', () => {
  // iPhone on its side, as in the report: 375 high with the bars away, about 292 with the address and tab bars up
  assert.equal(barsShowing({ inner: 292, large: 375, screenShort: 375, landscape: true }), true);
  assert.equal(barsShowing({ inner: 375, large: 375, screenShort: 375, landscape: true }), false);
  // upright: the address bar at its full size, then shrunk
  assert.equal(barsShowing({ inner: 664, large: 745, screenShort: 390, landscape: false }), true);
  assert.equal(barsShowing({ inner: 745, large: 745, screenShort: 390, landscape: false }), false);
  // a pixel or two of rounding is not a bar
  assert.equal(barsShowing({ inner: 370, large: 375, screenShort: 375, landscape: true }), false);
});

test('without lvh only a phone on its side can be judged, by the screen', () => {
  assert.equal(barsShowing({ inner: 292, large: null, screenShort: 375, landscape: true }), true);
  assert.equal(barsShowing({ inner: 375, large: null, screenShort: 375, landscape: true }), false);
  assert.equal(barsShowing({ inner: 664, large: null, screenShort: 390, landscape: false }), false);
  assert.equal(barsShowing({ inner: 0, large: 375, screenShort: 375, landscape: true }), false);
});

test('a swipe that tucks the bars away ends the ask', () => {
  let s = tuckStart(120);
  s = tuckLook(s, true, 120, 0); assert.equal(s.bars, true);
  s = tuckLook(s, true, 190, 200); assert.equal(s.gaveUp, false);
  s = tuckLook(s, false, 200, 400);
  assert.deepEqual([s.bars, s.gaveUp, s.keepLoose, s.tuckedAt], [false, false, false, 400]);
});

test('a real swipe that leaves the bars up stops the asking', () => {
  let s = tuckLook(tuckStart(0), true, 0, 0);
  s = tuckLook(s, true, 20, 100); assert.equal(s.swipedAt, 0, 'a small move is not a swipe');
  s = tuckLook(s, true, 90, 300); assert.equal(s.gaveUp, false);
  s = tuckLook(s, true, 140, 300 + TUCK_WAIT - 1); assert.equal(s.gaveUp, false);
  s = tuckLook(s, true, 140, 300 + TUCK_WAIT); assert.equal(s.gaveUp, true);
});

test('bars that come straight back after the page is pinned keep the page loose; later ones are the player', () => {
  let s = tuckLook(tuckStart(0), true, 0, 0);
  s = tuckLook(s, false, 80, 500);
  const bounced = tuckLook(s, true, 80, 900); assert.equal(bounced.keepLoose, true);
  const later = tuckLook(s, true, 80, 9000); assert.equal(later.keepLoose, false);
  assert.equal(later.from, 80, 'the next swipe is measured from where the page is now');
});

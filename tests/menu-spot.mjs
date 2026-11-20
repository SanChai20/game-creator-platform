// Where the platform's menu button sits while a game fills the screen (web/src/menu-spot.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARGIN_SIZE, SCORE, SIZE, candidates, choose, parseSpot, place, probeRect, spotAt } from '../web/src/menu-spot.ts';

// An iPhone 15 Pro on its side in Safari: bars at both ends for the notch and the rounded corners, the home indicator below.
const IPHONE_LAND = { w: 852, h: 393, top: 0, right: 59, bottom: 21, left: 59 };
// The same phone upright, an iPad, an Android phone: no side bars.
const IPHONE_PORT = { w: 393, h: 659, top: 0, right: 0, bottom: 0, left: 0 };
const IPAD = { w: 1180, h: 820, top: 24, right: 0, bottom: 20, left: 0 };
const ANDROID_LAND = { w: 915, h: 412, top: 0, right: 0, bottom: 0, left: 0 };

const inside = (p, a) => p.x >= a.left && p.y >= a.top && p.x + p.size <= a.w - a.right && p.y + p.size <= a.h - a.bottom;
const overlapsFrame = (p, a) => p.x < a.w - a.right && p.x + p.size > a.left && p.y < a.h - a.bottom && p.y + p.size > a.top;

test('a phone on its side: the button sits in the black bar beside the game, covering none of it', () => {
  const c = candidates(IPHONE_LAND);
  assert.equal(c[0].margin, true);
  assert.equal(c[0].side, 'left');
  assert.equal(c[0].size, MARGIN_SIZE);
  assert.equal(overlapsFrame(c[0], IPHONE_LAND), false);
  // whatever the game says about the spots over it
  assert.equal(choose(c, c.map(() => SCORE.control)).margin, true);
  // clear of the rounded corner and of the notch in the middle of the bar
  assert.ok(c[0].y >= 20);
  assert.ok(c[0].y + c[0].size <= IPHONE_LAND.h / 2 - 60);
});

test('the side the game asked for (GCP.setDisplay exitButton) gets the margin there', () => {
  const c = candidates(IPHONE_LAND, 'bottom-right');
  assert.equal(c[0].side, 'right'); assert.equal(c[0].margin, true);
  assert.ok(c[0].x >= IPHONE_LAND.w - IPHONE_LAND.right);
  assert.ok(c[0].y + c[0].size <= IPHONE_LAND.h - 20 && c[0].y > IPHONE_LAND.h / 2);
});

test('a bar too narrow for the button is not used', () => {
  const a = { ...IPHONE_LAND, left: 30, right: 30 };
  assert.ok(candidates(a).every((p) => !p.margin));
  assert.ok(candidates(a).every((p) => inside(p, a)));
});

test('with no margin, the spot the game says is free wins; top-left is kept when nothing says otherwise', () => {
  for (const a of [IPHONE_PORT, IPAD, ANDROID_LAND]) {
    const c = candidates(a);
    assert.ok(c.every((p) => !p.margin && inside(p, a)), 'every spot is over the game');
    assert.deepEqual([c[0].side, c[0].t], ['left', 0]);
    assert.deepEqual(choose(c, []), c[0]);
    // The game's back button is under top-left: the button moves to top-right.
    const s = c.map(() => SCORE.canvas); s[0] = SCORE.control;
    assert.deepEqual([choose(c, s).side, choose(c, s).t], ['right', 0]);
    // Buttons everywhere but one empty spot: that one.
    const t = c.map(() => SCORE.control); t[5] = SCORE.empty;
    assert.equal(choose(c, t), c[5]);
  }
});

test('the current spot is kept while it is as free as the best, so the button does not hop about', () => {
  const c = candidates(ANDROID_LAND), s = c.map(() => SCORE.canvas);
  assert.equal(choose(c, s, { side: 'right', t: 1 }).side, 'right');
  s[3] = SCORE.content;   // right, t 1 now covers text
  assert.deepEqual([choose(c, s, { side: 'right', t: 1 }).side, choose(c, s, { side: 'right', t: 1 }).t], ['left', 0]);
});

test('the frame coordinates the game is asked about', () => {
  const a = { ...IPAD }, p = place({ side: 'left', t: 0 }, a);
  const [x, y, w, h] = probeRect(p, a);
  assert.equal(x, p.x - a.left - 6); assert.equal(y, p.y - a.top - 6); assert.equal(w, SIZE + 12); assert.equal(h, SIZE + 12);
});

test('a dropped button snaps to the nearest edge and lands where it was dropped', () => {
  for (const a of [IPHONE_LAND, IPHONE_PORT, ANDROID_LAND]) {
    for (const [x, y] of [[4, 200], [a.w - 50, 120], [a.w / 2, a.h - 44], [a.w / 2, 3], [a.w - 44, a.h - 44]]) {
      const s = spotAt(x, y, a), p = place(s, a);
      assert.ok(Math.abs(p.x - x) < a.w / 2 && Math.abs(p.y - y) < a.h / 2);
      assert.ok(p.margin || inside(p, a));
    }
    const s = spotAt(2, 140, a);
    assert.equal(s.side, 'left');
  }
  // dropped near the left on the phone on its side: back into the bar
  assert.equal(place(spotAt(10, 60, IPHONE_LAND), IPHONE_LAND).margin, true);
  // a drop in the middle of the bottom edge stays there
  const b = spotAt(ANDROID_LAND.w / 2, ANDROID_LAND.h - 46, ANDROID_LAND);
  assert.equal(b.side, 'bottom'); assert.ok(Math.abs(b.t - 0.5) < 0.05);
});

test('a margin spot keeps out of the notch, even when dragged onto it', () => {
  const p = place({ side: 'left', t: 0.5 }, IPHONE_LAND), mid = IPHONE_LAND.h / 2;
  assert.ok(p.y + p.size <= mid - 60 || p.y >= mid + 60);
});

test('stored spots are checked', () => {
  assert.deepEqual(parseSpot('{"side":"right","t":0.4}'), { side: 'right', t: 0.4 });
  assert.deepEqual(parseSpot('{"side":"right","t":7}'), { side: 'right', t: 1 });
  for (const bad of [null, '', 'x', '{"side":"middle","t":0}', '{"side":"top"}', '{"side":"top","t":"1"}']) assert.equal(parseSpot(bad), null);
});

test('while the game plays, the button only moves off something to tap', () => {
  const c = candidates(ANDROID_LAND), s = c.map(() => SCORE.empty);
  s[0] = SCORE.content;   // a damage number passing under top-left
  assert.deepEqual([choose(c, s, { side: 'left', t: 0 }, true).side, choose(c, s, { side: 'left', t: 0 }, true).t], ['left', 0]);
  s[0] = SCORE.control;   // a button appeared there
  assert.notDeepEqual([choose(c, s, { side: 'left', t: 0 }, true).side, choose(c, s, { side: 'left', t: 0 }, true).t], ['left', 0]);
});

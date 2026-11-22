// The play window (web/src/play-window.ts): one frame size for a game in its window, whatever page it plays on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playWindow, PLAY_MAX_W, PLAY_MIN_W } from '../web/src/play-window.ts';

test('the window depends on the browser window only, and matches the preview dialog on desktop', () => {
  // the sizes the preview dialog gave before (and the store page now plays in, scaled to its column)
  assert.deepEqual(playWindow(1920, 1080), { w: 1056, h: 594 });
  assert.deepEqual(playWindow(1440, 900), { w: 1056, h: 594 });
  assert.deepEqual(playWindow(1366, 768), { w: 944, h: 531 });
  assert.deepEqual(playWindow(1280, 720), { w: 864, h: 486 });
});

test('16:9, whole pixels, a multiple of 16, within its bounds', () => {
  for (const vw of [320, 390, 768, 900, 1024, 1180, 1600, 2560, 3840]) for (const vh of [360, 600, 844, 1000, 1440, 2160]) {
    const { w, h } = playWindow(vw, vh);
    assert.ok(w >= PLAY_MIN_W && w <= PLAY_MAX_W, `${vw}x${vh}: ${w}`);
    assert.equal(w % 16, 0); assert.equal(h, (w * 9) / 16); assert.ok(Number.isInteger(h));
    if (w > PLAY_MIN_W) assert.ok(w <= vw - 32, `${vw}x${vh}: never wider than the page's content`);
  }
});

test('a short window keeps the frame on screen, down to the minimum', () => {
  assert.equal(playWindow(1920, 700).w, 832);   // (700 - 230) * 16 / 9 = 835
  assert.equal(playWindow(844, 390).w, PLAY_MIN_W);
});

// Console preview viewport presets and scaling (web/src/preview-viewport.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPreviewOrientation, PREVIEW_PRESETS, resolvePreviewFrame } from '../web/src/preview-viewport.ts';
import { playWindow } from '../web/src/play-window.ts';

test('current screen mode matches playWindow exactly and scales only when container is narrower', () => {
  const win = playWindow(1440, 900);
  const f = resolvePreviewFrame({ device: 'current', orientation: 'landscape', containerW: 1060, viewportW: 1440, viewportH: 900 });
  assert.equal(f.w, win.w);
  assert.equal(f.h, win.h);
  assert.equal(f.scale, 1);
  assert.equal(f.displayW, win.w);
  assert.equal(f.displayH, win.h);
  assert.equal(f.touch, false);

  const narrow = resolvePreviewFrame({ device: 'current', orientation: 'landscape', containerW: 528, viewportW: 1440, viewportH: 900 });
  assert.equal(narrow.w, win.w);
  assert.equal(narrow.scale, 0.5);
  assert.equal(narrow.displayW, 528);
  assert.equal(narrow.displayH, Math.round(win.h * 0.5));
});

test('phone and tablet modes preserve true device logical dimensions and fit within viewport height and bezel chrome', () => {
  const phoneP = resolvePreviewFrame({ device: 'phone', orientation: 'portrait', containerW: 1056, viewportW: 1440, viewportH: 900 });
  assert.deepEqual({ w: phoneP.w, h: phoneP.h }, PREVIEW_PRESETS.phone.portrait);
  assert.equal(phoneP.touch, true);
  assert.ok(phoneP.scale > 0 && phoneP.scale <= 1);
  assert.ok(phoneP.displayH <= 900 - 310 + 1, `phone portrait height ${phoneP.displayH} fits without clipping`);
  assert.equal(phoneP.displayW, Math.round(phoneP.w * phoneP.scale));

  const phoneL = resolvePreviewFrame({ device: 'phone', orientation: 'landscape', containerW: 1056, viewportW: 1440, viewportH: 900 });
  assert.deepEqual({ w: phoneL.w, h: phoneL.h }, PREVIEW_PRESETS.phone.landscape);
  assert.equal(phoneL.scale, 1);
  assert.equal(phoneL.displayW, 844);
  assert.equal(phoneL.displayH, 390);

  const tabletL = resolvePreviewFrame({ device: 'tablet', orientation: 'landscape', containerW: 1056, viewportW: 1440, viewportH: 1200 });
  assert.deepEqual({ w: tabletL.w, h: tabletL.h }, PREVIEW_PRESETS.tablet.landscape);
  assert.equal(tabletL.touch, true);
  assert.ok(tabletL.displayH <= 1200 - 310 + 1);
  assert.ok(tabletL.displayW + 84 <= 1056, `tablet landscape width ${tabletL.displayW} + 84px bezel/mat chrome fits inside 1056`);

  const tabletP = resolvePreviewFrame({ device: 'tablet', orientation: 'portrait', containerW: 1056, viewportW: 1440, viewportH: 900 });
  assert.deepEqual({ w: tabletP.w, h: tabletP.h }, PREVIEW_PRESETS.tablet.portrait);
  assert.ok(tabletP.displayH <= 900 - 310 + 1);

  const narrowPhoneL = resolvePreviewFrame({ device: 'phone', orientation: 'landscape', containerW: 360, viewportW: 390, viewportH: 844 });
  assert.ok(narrowPhoneL.displayW + 44 <= 360, `narrow phone landscape width ${narrowPhoneL.displayW} + 44px chrome fits inside 360`);
});

test('defaultPreviewOrientation respects declared game orientation and picks natural defaults', () => {
  assert.equal(defaultPreviewOrientation('phone', 'any'), 'portrait');
  assert.equal(defaultPreviewOrientation('phone', 'landscape'), 'landscape');
  assert.equal(defaultPreviewOrientation('phone', 'portrait'), 'portrait');
  assert.equal(defaultPreviewOrientation('tablet', 'any'), 'landscape');
  assert.equal(defaultPreviewOrientation('tablet', 'portrait'), 'portrait');
  assert.equal(defaultPreviewOrientation('tablet', 'landscape'), 'landscape');
  assert.equal(defaultPreviewOrientation('current', 'portrait'), 'landscape');
});

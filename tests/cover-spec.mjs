// Store covers: reading an image's size from its bytes, the size check, and the rules agents are given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COVER, checkCover, coverRules, imageSize, safeRect } from '../src/cover-spec.js';

const png = (w, h) => { const b = new Uint8Array(33); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]); const dv = new DataView(b.buffer); dv.setUint32(16, w); dv.setUint32(20, h); return b; };
const jpeg = (w, h) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xdb, 0, 3, 0, 0xff, 0xc2, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0, 0, 0]);
const webpX = (w, h) => { const b = new Uint8Array(40); b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0); b.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8); const W = w - 1, H = h - 1; b.set([W & 255, (W >> 8) & 255, W >> 16, H & 255, (H >> 8) & 255, H >> 16], 24); return b; };

test('image size from png, jpeg and webp headers', () => {
  assert.deepEqual(imageSize(png(1920, 1080)), { width: 1920, height: 1080, type: 'png' });
  assert.deepEqual(imageSize(jpeg(1280, 720)), { width: 1280, height: 720, type: 'jpeg' });
  assert.deepEqual(imageSize(webpX(1920, 1080)), { width: 1920, height: 1080, type: 'webp' });
  assert.equal(imageSize(new Uint8Array([1, 2, 3])), null);
});

test('the size check flags covers the store would crop or blur', () => {
  assert.deepEqual(checkCover(png(1920, 1080)).notes, []);
  assert.equal(checkCover(jpeg(1280, 720)).ok, true);
  assert.match(checkCover(png(1600, 1200)).notes.join(' '), /not 16:9/);
  assert.match(checkCover(png(960, 540)).notes.join(' '), /smaller than 1280x720/);
  assert.equal(checkCover(new Uint8Array(10)).ok, false);
});

test('the rules name the safe area, the hidden left side and the template', () => {
  const r = coverRules('https://x');
  assert.match(r, /x 30% to 80%, y 12% to 86%/);
  assert.match(r, /576 to 1536 px across and 130 to 930 px down/);
  assert.match(r, /left 30% is hidden/);
  assert.ok(r.includes('https://x' + COVER.template));
  assert.deepEqual(safeRect(), { left: 576, right: 1536, top: 130, bottom: 930 });
});

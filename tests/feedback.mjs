// The creator feedback queue's rules (src/feedback-rules.js): what one item may hold, checked by its bytes and cut to size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEEDBACK_LIMITS, FeedbackError, cleanContext, cleanMarks, cleanNote, describeMarks, imageInfo, parseImage } from '../src/feedback-rules.js';

// a 1x1 PNG and a tiny baseline JPEG header (SOI, APP0, SOF0 with 640x360)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x01, 0x68, 0x02, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);

test('pictures are known by their bytes', () => {
  assert.deepEqual(imageInfo(new Uint8Array(PNG)), { type: 'image/png', width: 1, height: 1 });
  assert.deepEqual(imageInfo(new Uint8Array(JPEG)), { type: 'image/jpeg', width: 640, height: 360 });
  assert.equal(imageInfo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>  padding padding')), null);
  const p = parseImage('data:image/png;base64,' + PNG.toString('base64'));
  assert.equal(p.type, 'image/png'); assert.equal(p.bytes.length, PNG.length);
  assert.equal(parseImage(JPEG.toString('base64')).width, 640);
  // a declared type means nothing: an HTML page labelled as a JPEG is refused
  assert.throws(() => parseImage('data:image/jpeg;base64,' + Buffer.from('<html><script>alert(1)</script></html>').toString('base64')), FeedbackError);
  assert.throws(() => parseImage(''), FeedbackError);
  assert.throws(() => parseImage('data:image/png;base64,' + 'A'.repeat(FEEDBACK_LIMITS.image_bytes * 2)), /larger than/);
  const huge = Buffer.from(PNG); huge.writeUInt32BE(10000, 16);
  assert.throws(() => parseImage(huge.toString('base64')), /pixels/);
});

test('marks are kept to their shapes, in picture fractions', () => {
  const m = cleanMarks([
    { type: 'circle', x: 0.1, y: 0.2, w: 0.3, h: 0.2, label: ' the score  ' },
    { type: 'arrow', x1: -1, y1: 0.5, x2: 2, y2: 0.5 },
    { type: 'pen', points: Array.from({ length: 1000 }, (_, i) => [i / 1000, 0.5]) },
    { type: 'box', x: 0, y: 0, w: 1, h: 1, extra: 'dropped', label: 'x'.repeat(500) },
  ]);
  assert.deepEqual(m[0], { n: 1, type: 'circle', x: 0.1, y: 0.2, w: 0.3, h: 0.2, label: 'the score' });
  assert.deepEqual(m[1], { n: 2, type: 'arrow', x1: 0, y1: 0.5, x2: 1, y2: 0.5 });
  assert.ok(m[2].points.length <= FEEDBACK_LIMITS.pen_points && m[2].points.length > 100);
  assert.equal(m[3].extra, undefined); assert.equal(m[3].label.length, FEEDBACK_LIMITS.mark_label_chars);
  assert.deepEqual(cleanMarks(undefined), []);
  assert.throws(() => cleanMarks([{ type: 'script' }]), FeedbackError);
  assert.throws(() => cleanMarks([{ type: 'circle', x: 'a', y: 0, w: 0, h: 0 }]), /needs x/);
  assert.throws(() => cleanMarks(Array.from({ length: 31 }, () => ({ type: 'box', x: 0, y: 0, w: 1, h: 1 }))), /At most/);
  assert.deepEqual(describeMarks(m.slice(0, 2), 1000, 500), ['1. circle around (250, 150), 300 × 100 px: "the score"', '2. arrow from (0, 250) pointing at (1000, 250)']);
});

test('notes and context are cut to size and never keep the page address', () => {
  assert.equal(cleanNote('  hi\u0000 there '), 'hi there');
  assert.equal(cleanNote('x'.repeat(5000)).length, FEEDBACK_LIMITS.note_chars);
  const c = cleanContext({ method: 'screen', url: 'https://g.example/?gcp_t=SECRET', token: 'SECRET', viewport: { width: 960, height: 540 }, frames: 120, fps: 59.6, ready: true,
    errors: Array.from({ length: 30 }, (_, i) => 'e' + i), state: { level: 3, player: { x: 1 } }, browser: 'Mozilla/5.0' });
  assert.equal(JSON.stringify(c).includes('SECRET'), false);
  assert.deepEqual(Object.keys(c).sort(), ['browser', 'errors', 'fps', 'frames', 'method', 'ready', 'state', 'viewport']);
  assert.equal(c.errors.length, FEEDBACK_LIMITS.errors); assert.equal(c.fps, 60); assert.equal(c.state, '{"level":3,"player":{"x":1}}');
  assert.equal(cleanContext({ method: 'anything' }).method, 'game');
  assert.equal(cleanContext({ state: 'y'.repeat(9000) }).state.length, FEEDBACK_LIMITS.state_chars);
});

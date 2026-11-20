// Reading a game's files for its game Worker: conditions and ranges are parsed for R2, never handed over as raw headers
// (R2 failed with an internal error on a browser's revalidation, and fonts a game fetched came back 500).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-hook.mjs', import.meta.url);
const { readOptions } = await import('../src/file-read.ts');

const h = (o) => new Headers(o);

test('a plain read has no conditions or range', () => {
  assert.deepEqual(readOptions(h({})), {});
});

test('a revalidation becomes an ETag condition, weak or strong, quoted or not', () => {
  assert.deepEqual(readOptions(h({ 'if-none-match': '"9591efe1be62434d2d107e2b19702029"' })), { onlyIf: { etagDoesNotMatch: '9591efe1be62434d2d107e2b19702029' } });
  assert.deepEqual(readOptions(h({ 'if-none-match': 'W/"abc", "def"' })), { onlyIf: { etagDoesNotMatch: 'abc' } });
  assert.deepEqual(readOptions(h({ 'if-match': '"abc"' })), { onlyIf: { etagMatches: 'abc' } });
  assert.deepEqual(readOptions(h({ 'if-none-match': '*' })), {});
});

test('one byte range is parsed; anything else reads the whole file', () => {
  assert.deepEqual(readOptions(h({ range: 'bytes=0-99' })), { range: { offset: 0, length: 100 } });
  assert.deepEqual(readOptions(h({ range: 'bytes=500-' })), { range: { offset: 500 } });
  assert.deepEqual(readOptions(h({ range: 'bytes=-200' })), { range: { suffix: 200 } });
  assert.deepEqual(readOptions(h({ range: 'bytes=0-1,5-9' })), {});
  assert.deepEqual(readOptions(h({ range: 'items=1-2' })), {});
});

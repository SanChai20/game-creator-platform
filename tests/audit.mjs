// The bucket audit flags what a game's server code could have written while game Workers still had the bucket bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { auditObject } = await import('../src/audit.ts');

const T = Date.UTC(2026, 10, 1);
test('version files must match their frozen version', () => {
  const v = { created_at: T, files: [{ path: 'index.html', size: 10 }] };
  assert.equal(auditObject({ key: 'v/abc123/1/index.html', size: 10, uploaded: T - 1000 }, v, null), null);
  assert.match(auditObject({ key: 'v/abc123/1/index.html', size: 10, uploaded: T + 3600e3 }, v, null), /after its version was frozen/);
  assert.match(auditObject({ key: 'v/abc123/1/index.html', size: 11, uploaded: T }, v, null), /size differs/);
  assert.match(auditObject({ key: 'v/abc123/1/evil.js', size: 1, uploaded: T }, v, null), /not part of its version/);
  assert.match(auditObject({ key: 'v/abc123/9/index.html', size: 1, uploaded: T }, null, null), /no version record/);
});
test('workspace files must match their record', () => {
  assert.equal(auditObject({ key: 'ws/abc123/a.js', size: 5, uploaded: T }, null, { size: 5, updated_at: T }), null);
  assert.match(auditObject({ key: 'ws/abc123/a.js', size: 5, uploaded: T + 3600e3 }, null, { size: 5, updated_at: T }), /after its file record/);
  assert.match(auditObject({ key: 'ws/abc123/a.js', size: 5, uploaded: T }, null, null), /no file record/);
});
test('pictures must be pictures, and nothing lives outside the platform\'s prefixes', () => {
  assert.equal(auditObject({ key: 'covers/abc123-k1.png', size: 5, uploaded: T, type: 'image/png' }), null);
  assert.match(auditObject({ key: 'covers/abc123-k1.png', size: 5, uploaded: T, type: 'text/html' }), /stored as text\/html/);
  assert.match(auditObject({ key: 'shots/abc123/1.svg', size: 5, uploaded: T, type: 'image/svg+xml' }), /not png/);
  assert.match(auditObject({ key: 'evil/x.html', size: 5, uploaded: T }), /prefix/);
});

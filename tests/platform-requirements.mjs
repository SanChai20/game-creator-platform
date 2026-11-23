// The line between platform requirements (mandatory) and design recommendations (advice): src/platform-requirements.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_DEVICES, SPLIT, deviceProblems } from '../src/platform-requirements.js';
import { STANDARDS, renderStandards } from '../src/standards.js';

const m = (r, controls = { mode: 'auto' }) => ({ compat: { requirements: { input: ['keyboard', 'mouse', 'touch'], devices: [...REQUIRED_DEVICES], orientation: 'any', ...r } }, controls });

test('a game for every device with a way to play on each meets the device requirement', () => {
  assert.deepEqual(deviceProblems(m({})), []);
  assert.deepEqual(deviceProblems(m({ input: ['keyboard'] })), [], 'the platform controls press its keys on a touch screen');
  assert.deepEqual(deviceProblems(m({ input: ['mouse'] })), [], 'the finger drives a mouse game');
});

test('each problem says what is wrong and the exact call that fixes it', () => {
  const [d] = deviceProblems(m({ devices: ['desktop', 'tablet'] }));
  assert.equal(d.id, 'devices'); assert.match(d.message, /phones \(mobile\)/); assert.match(d.fix, /"declare", requirements: \{devices: \["desktop", "tablet", "mobile"\]\}/);
  assert.deepEqual(deviceProblems(m({ input: ['gamepad'] }, { mode: 'none' })).map((x) => x.id), ['computer-input', 'touch-input']);
  assert.equal(deviceProblems({})[0].id, 'requirements', 'a version with nothing on record is told to deploy again');
});

test('orientation never decides the device requirement', () => {
  for (const orientation of ['landscape', 'portrait', 'any']) assert.deepEqual(deviceProblems(m({ orientation })), []);
});

test('the standards guide states the two kinds of rule, and only named parts are required', () => {
  const md = renderStandards('');
  assert.ok(md.includes(SPLIT.requirements) && md.includes(SPLIT.recommendations));
  assert.match(md, /\*\*Platform requirements \(mandatory\)\.\*\*/);
  assert.match(md, /\*\*Design recommendations \(advice\)\.\*\*/);
  const orientation = STANDARDS.find((s) => s.id === 'orientation');
  assert.equal(orientation.required, undefined, 'which way up a game is played is design');
  assert.match(orientation.spec[0], /design decision/);
  assert.match(STANDARDS.find((s) => s.id === 'touch-controls').required, /every_device/);
  for (const s of STANDARDS) assert.doesNotMatch(s.title, /\bmust\b/, `${s.id}: a recommendation's title does not say must`);
});

// Device checks at deploy (src/device-checks.js) and how the phone and tablet pass of the verifier counts (src/verify-core.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { deviceIssues, syntaxFindings, apiFindings } from '../src/device-checks.js';
import { applyDeviceResults, deviceViewport, DEVICE_PROFILES } from '../src/verify-core.js';

const ast = (src) => parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
const ids = (src) => syntaxFindings(ast(src)).map((f) => f.id).sort();

test('newer syntax an older Safari cannot parse is found, with its line', () => {
  assert.deepEqual(ids('const a = /(?<=\\$)\\d+/;'), ['regex-lookbehind']);
  assert.deepEqual(ids('class A { static { this.x = 1; } }'), ['class-static-block']);
  assert.deepEqual(ids('const r = /[\\p{L}--[a-z]]/v;'), ['regex-v-flag']);
  assert.deepEqual(ids('import data from "./d.json" with { type: "json" };'), ['import-attributes']);
  assert.deepEqual(ids('{ using x = open(); }'), ['using-declaration']);
  assert.deepEqual(syntaxFindings(ast('let a = 1;\nlet b = /(?<!x)y/;')), [{ id: 'regex-lookbehind', line: 2 }]);
});

test('ordinary modern code (and look-alikes) is not reported', () => {
  assert.deepEqual(ids('const g = /(?<year>\\d{4})/; const s = "(?<=not a regex)"; class B { #p = 1; static q = 2; has(o) { return #p in o; } } const v = a?.b ?? c; x ||= 1; await import("./m.js");'), []);
  assert.deepEqual(ids('const esc = /\\(\\?<=/;'), []);   // an escaped paren is not a lookbehind
});

test('features Safari never has are reported once, as warnings with a hint', () => {
  assert.deepEqual(apiFindings('navigator.requestMIDIAccess().then(f);\nnavigator.usb.requestDevice()').map((f) => f.id), ['web-midi', 'web-usb']);
  const { issues } = deviceIssues([{ file: 'a.js', src: 'if (navigator.requestMIDIAccess) navigator.requestMIDIAccess()', ast: null }, { file: 'b.js', src: 'navigator.requestMIDIAccess()', ast: null }], []);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /Web MIDI/);
  assert.match(issues[0].hint, /check for it first/);
});

test('what the game runtime fills in is not reported (vibrate, fullscreen, orientation lock, idle callbacks, structuredClone)', () => {
  const src = 'navigator.vibrate(30); canvas.requestFullscreen(); screen.orientation.lock("landscape"); requestIdleCallback(f); structuredClone(o); [1].at(-1); ctx.roundRect(0,0,1,1,4);';
  assert.deepEqual(deviceIssues([{ file: 'g.js', src, ast: ast(src) }], ['g.js']).issues, []);
});

test('the oldest Safari that loads the code is the newest syntax it uses', () => {
  const files = [{ file: 'a.js', src: '', ast: ast('/(?<=a)b/') }, { file: 'b.js', src: '', ast: ast('/x/v') }];
  const r = deviceIssues(files, []);
  assert.equal(r.minSafari, 17);
  assert.equal(r.issues.length, 2);
  assert.match(r.issues[0].hint, /requirements\.browsers\.safari 17|requirements\.browsers\.safari 16/);
});

test('sound shipped only as Ogg is reported; Ogg next to mp3 or m4a is fine', () => {
  assert.equal(deviceIssues([], ['index.html', 'sfx/hit.ogg', 'music/theme.ogg']).issues.length, 1);
  assert.equal(deviceIssues([], ['sfx/hit.ogg', 'sfx/hit.mp3']).issues.length, 0);
  assert.equal(deviceIssues([], ['index.html', 'main.js']).issues.length, 0);
});

test('device viewports follow the game\'s orientation', () => {
  assert.deepEqual(deviceViewport(DEVICE_PROFILES.iphone, 'any'), { width: 844, height: 390 });
  assert.deepEqual(deviceViewport(DEVICE_PROFILES.iphone, 'portrait'), { width: 390, height: 844 });
  assert.deepEqual(deviceViewport(DEVICE_PROFILES.ipad, 'landscape'), { width: 1180, height: 820 });
});

const result = (id, problems = [], notes = []) => ({ id, label: DEVICE_PROFILES[id].label, kind: DEVICE_PROFILES[id].kind, viewport: '1×1', ok: !problems.length, problems, notes, loadMs: 100, fps: 30, runtime: { version: '2.0.0', fixes: [] } });

test('a device problem fails the version only for devices the game says it is made for', () => {
  const made = applyDeviceResults({ ok: true, checks: [], notes: [], summary: 'Playable' }, [result('iphone', ['It threw an error: x']), result('ipad')], ['desktop', 'tablet', 'mobile']);
  assert.equal(made.ok, false);
  assert.match(made.summary, /Not playable on iPhone/);
  assert.deepEqual(made.checks.map((c) => [c.id, c.ok]), [['device_iphone', false], ['device_ipad', true]]);

  const desktopOnly = applyDeviceResults({ ok: true, checks: [], notes: [], summary: 'Playable' }, [result('iphone', ['It threw an error: x'])], ['desktop']);
  assert.equal(desktopOnly.ok, true);
  assert.equal(desktopOnly.checks.length, 0);
  assert.match(desktopOnly.notes[0], /not listed for phones/);
});

test('layout findings are notes, never failures', () => {
  const r = applyDeviceResults({ ok: true, checks: [], notes: [], summary: 'Playable' }, [result('iphone', [], ['Only 60% of the game\'s canvas is on the screen.'])]);
  assert.equal(r.ok, true);
  assert.match(r.notes[0], /^On iPhone: Only 60%/);
});

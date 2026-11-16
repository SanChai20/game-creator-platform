// Compatibility requirements: declaring, detecting, merging, and the verdict a player's browser gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompat, detectRequirements, emptyRequirements, evaluate, mergeRequirements, parseRequirements, parseUA } from '../web/src/compat.ts';

const detect = (files, extra = {}) => detectRequirements({ texts: new Map(Object.entries(files)), paths: Object.keys(files), ...extra }).requirements;

test('a declaration is validated field by field', () => {
  const ok = parseRequirements({ graphics: 'WebGL 2', features: ['wasm', 'web-audio'], optional: ['webgpu'], input: ['keyboard', 'touch'], devices: ['desktop', 'phone'], known_issues: [{ browser: 'safari', os: 'ios', severity: 'broken', note: 'Audio does not start.' }] });
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.value.graphics, 'webgl2');
  assert.deepEqual(ok.value.features, ['webassembly', 'web-audio']);
  assert.deepEqual(ok.value.devices, ['desktop', 'mobile']);
  const bad = parseRequirements({ graphics: 'opengl', features: ['teleport'], input: [], devices: ['fridge'], colour: 'red' });
  assert.deepEqual(bad.issues.map((i) => i.field).sort(), ['colour', 'devices', 'features', 'graphics', 'input']);
  assert.ok(bad.issues.every((i) => i.level === 'error'));
});

test('threads are refused: games are not cross-origin isolated', () => {
  const r = parseRequirements({ features: ['wasm-threads'] });
  assert.equal(r.issues.length, 1);
  assert.match(r.issues[0].message, /SharedArrayBuffer/);
  assert.deepEqual(parseRequirements({ optional: ['wasm-threads'] }).issues, []);
});

test('detection finds the graphics floor', () => {
  assert.equal(detect({ 'index.html': '<canvas></canvas><script>const c = document.querySelector("canvas").getContext("2d"); GCP.ready()</script>' }).graphics, 'canvas');
  assert.equal(detect({ 'main.js': 'import * as THREE from "three"; new THREE.WebGLRenderer()' }).graphics, 'webgl2');
  assert.equal(detect({ 'main.js': 'const gl = c.getContext("webgl2") || c.getContext("webgl")' }).graphics, 'webgl');
  const gpuOnly = detect({ 'main.js': 'const a = await navigator.gpu.requestAdapter()' });
  assert.equal(gpuOnly.graphics, 'webgpu');
  const withFallback = detect({ 'main.js': 'import { WebGPURenderer } from "three/webgpu"' });
  assert.equal(withFallback.graphics, 'webgl2');
  assert.deepEqual(withFallback.optional, ['webgpu']);
  assert.equal(detect({ 'index.html': '<p>hello</p><script>GCP.ready()</script>' }).graphics, 'none');
});

test('detection finds features and input', () => {
  const r = detect({ 'game.wasm': '', 'main.js': 'new AudioContext(); addEventListener("keydown", f); addEventListener("pointerdown", g); el.requestPointerLock()' }, { bareImports: true });
  assert.ok(r.features.includes('webassembly'));
  assert.ok(r.features.includes('web-audio'));
  assert.ok(r.features.includes('import-maps'));
  assert.ok(r.optional.includes('pointer-lock'));
  assert.deepEqual(r.input.sort(), ['keyboard', 'mouse', 'touch']);
  assert.deepEqual(r.devices, ['desktop', 'tablet', 'mobile']);
  assert.deepEqual(detect({ 'main.js': 'addEventListener("keydown", f)' }).devices, ['desktop']);
  const sab = detectRequirements({ texts: new Map([['main.js', 'if (typeof SharedArrayBuffer !== "undefined") {}']]), paths: ['main.js'] });
  assert.equal(sab.warnings.length, 1);
  assert.ok(!sab.requirements.features.includes('wasm-threads'));
});

test('the declaration wins, detected required features are added, and mismatches are warned about', () => {
  const det = detect({ 'main.js': 'import * as THREE from "three"; new AudioContext(); addEventListener("keydown", f)' });
  const { requirements, issues } = mergeRequirements({ graphics: 'webgl', input: ['keyboard', 'gamepad'], devices: ['desktop', 'mobile'] }, det);
  assert.equal(requirements.graphics, 'webgl');
  assert.ok(requirements.features.includes('web-audio'));
  assert.deepEqual(issues.map((i) => i.field).sort(), ['devices', 'features', 'graphics', 'input']);
  // listing a detected feature as optional keeps it optional
  const opt = mergeRequirements({ optional: ['web-audio'] }, det).requirements;
  assert.ok(!opt.features.includes('web-audio') && opt.optional.includes('web-audio'));
  // nothing declared: everything detected, with one warning that says so
  const none = mergeRequirements(null, det);
  assert.equal(none.requirements.graphics, 'webgl2');
  assert.equal(none.issues.length, 1);
});

test('buildCompat records declared, detected and the download size', () => {
  const { compat } = buildCompat({ graphics: 'webgl2', input: ['mouse'] }, { texts: { 'a.js': 'c.getContext("webgl2"); addEventListener("click", f)' }, paths: ['a.js'] }, 12345);
  assert.equal(compat.declared, true);
  assert.equal(compat.download_bytes, 12345);
  assert.equal(compat.detected.graphics, 'webgl2');
  assert.equal(buildCompat(undefined, { texts: {}, paths: [] }, 0).compat.declared, false);
});

const desktop = () => ({
  graphics: { canvas: true, webgl: true, webgl2: true, webgpu: false }, gpu: 'hardware', renderer: 'ANGLE (NVIDIA)', features: { 'webassembly': true, 'web-audio': true, 'pointer-lock': true, 'import-maps': true, 'es-modules': true },
  input: { keyboard: true, mouse: true, touch: false, gamepad: null }, device: 'desktop', browser: { id: 'chrome', name: 'Chrome', version: 130 }, os: 'windows', memory_gb: 8, orientation: 'landscape',
});

test('the verdict: works, may not, does not', () => {
  const req = { ...emptyRequirements(), graphics: 'webgl2', features: ['webassembly'], input: ['keyboard', 'mouse'] };
  assert.equal(evaluate(req, desktop()).verdict, 'ok');
  const old = desktop(); old.graphics.webgl2 = false;
  const v = evaluate(req, old);
  assert.equal(v.verdict, 'no');
  assert.equal(v.blockers[0].kind, 'graphics');
  assert.equal(v.blockers[0].have, 'webgl');
  const sw = desktop(); sw.gpu = 'software';
  assert.equal(evaluate({ ...req, gpu: 'hardware' }, sw).verdict, 'no');
  const unknownGpu = desktop(); unknownGpu.gpu = null;
  assert.equal(evaluate({ ...req, gpu: 'hardware' }, unknownGpu).verdict, 'maybe');
  // WebGPU as optional never blocks
  assert.equal(evaluate({ ...req, optional: ['webgpu'] }, desktop()).verdict, 'ok');
  // a phone without a keyboard, for a keyboard-only desktop game
  const phone = { ...desktop(), device: 'mobile', input: { keyboard: null, mouse: false, touch: true, gamepad: null } };
  const pv = evaluate({ ...req, input: ['keyboard'] }, phone);
  assert.equal(pv.verdict, 'no');
  assert.deepEqual(pv.blockers.map((r) => r.kind), ['device']);
  // minimum browser versions and known issues
  assert.equal(evaluate({ ...req, browsers: { chrome: 140 } }, desktop()).verdict, 'no');
  assert.equal(evaluate({ ...req, known_issues: [{ os: 'windows', severity: 'broken', note: 'x' }] }, desktop()).verdict, 'no');
  assert.equal(evaluate({ ...req, known_issues: [{ os: 'ios', severity: 'broken', note: 'x' }] }, desktop()).verdict, 'ok');
  assert.equal(evaluate({ ...req, known_issues: [{ browser: 'chrome', severity: 'degraded', note: 'x' }] }, desktop()).verdict, 'maybe');
  assert.equal(evaluate({ ...req, memory_gb: 16 }, desktop()).verdict, 'ok'); // browsers cap deviceMemory at 8
  assert.equal(evaluate({ ...req, memory_gb: 4 }, { ...desktop(), memory_gb: 2 }).verdict, 'no');
});

test('user agents', () => {
  assert.deepEqual(parseUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'), { browser: { id: 'edge', name: 'Edge', version: 130 }, os: 'windows' });
  assert.deepEqual(parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), { browser: { id: 'safari', name: 'Safari', version: 17 }, os: 'ios' });
  assert.equal(parseUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 5).os, 'ios'); // iPadOS asks for the desktop site
  assert.equal(parseUA('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36').browser.id, 'samsung');
  assert.equal(parseUA('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0').browser.version, 132);
});

test('platform-hosted modules count: @gcp/input.js brings every input, @gcp/craft.js needs WebGL 2', () => {
  const r = detect({ 'main.js': 'import { createStage } from "@gcp/craft.js"; import { sfx } from "@gcp/sound.js"' });
  assert.equal(r.graphics, 'webgl2');
  assert.deepEqual(r.input, ['keyboard', 'mouse', 'touch', 'gamepad']);
  assert.ok(r.features.includes('web-audio'));
  assert.equal(detect({ 'main.js': 'import { setupCanvas } from "@gcp/canvas2d.js"' }).graphics, 'canvas');
});

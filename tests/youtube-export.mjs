// Exporting a version as a YouTube Playables package: the check and the package's index.html (src/youtube-check.js), and
// the SDK speaking to YouTube when it runs inside one (web/public/sdk/gcp.js, 2.18.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { check, localImports, mapSpecifier, packageHtml, platformPath, specifiers } from '../src/youtube-check.js';

const ORIGIN = 'https://hearthcade.com';
const IMPORTS = { three: `${ORIGIN}/vendor/three-0.170.0/build/three.module.js`, 'three/addons/': `${ORIGIN}/vendor/three-0.170.0/examples/jsm/`, '@gcp/': `${ORIGIN}/kits/v1/`, lib: 'https://cdn.example/lib.js' };

test('the check blocks an unverified version or one without index.html, and warns about what needs HearthCade', () => {
  const ok = check({ verified: true, files: [{ path: 'index.html', size: 100 }, { path: 'main.js', size: 200 }], texts: { 'main.js': 'GCP.ready(); GCP.save.set("a", 1);' } });
  assert.deepEqual(ok.blockers, []); assert.deepEqual(ok.warnings, []); assert.equal(ok.bytes, 300);
  const no = check({ verified: false, files: [{ path: 'main.js', size: 1 }, { path: 'server/index.html', size: 1 }] });
  assert.deepEqual(no.blockers.map((b) => b.code), ['not_verified', 'no_index']);
  const w = check({ verified: true, age: 18, manifest: { hasServer: true }, extraBytes: 40 * 1048576,
    files: [{ path: 'index.html', size: 1 }, { path: 'server/main.js', size: 5 }],
    texts: { 'index.html': '<script src="https://fonts.example/x.js"></script>', 'game.js': 'const r = GCP.room("x"); GCP.friends.list(); fetch("https://api.example/v1"); GCP.leaderboard.top("b")', 'server/main.js': 'GCP.match' } });
  const codes = w.warnings.map((x) => x.code);
  for (const c of ['server_code', 'needs_platform:GCP.room', 'needs_platform:GCP.friends', 'needs_platform:GCP.leaderboard.top', 'outside_requests', 'adults_only', 'large']) assert.ok(codes.includes(c), c);
  assert.ok(!codes.includes('needs_platform:GCP.match'), 'server code is left out, so it is not read');
  assert.match(w.warnings.find((x) => x.code === 'outside_requests').message, /fonts\.example, api\.example|api\.example, fonts\.example/);
  assert.equal(w.bytes, 1 + 40 * 1048576, 'server files do not count');
});

test('imports are found and mapped to the platform files the package carries', () => {
  const src = `import * as THREE from 'three';\nimport { OrbitControls } from "three/addons/controls/OrbitControls.js";\nimport './local.js';\nexport { x } from '@gcp/input.js';\nconst m = await import('./level2.js');\nconst notAnImport = obj.import('x');`;
  assert.deepEqual(specifiers(src).sort(), ['./level2.js', './local.js', '@gcp/input.js', 'three', 'three/addons/controls/OrbitControls.js']);
  assert.equal(mapSpecifier('three/addons/controls/OrbitControls.js', IMPORTS), `${ORIGIN}/vendor/three-0.170.0/examples/jsm/controls/OrbitControls.js`);
  assert.equal(mapSpecifier('three', IMPORTS), IMPORTS.three);
  assert.equal(mapSpecifier('react', IMPORTS), null);
  assert.equal(platformPath(IMPORTS.three, ORIGIN), '/vendor/three-0.170.0/build/three.module.js');
  assert.equal(platformPath('https://game-creator-platform.someone.workers.dev/kits/v1/a.js', ORIGIN), '/kits/v1/a.js', 'an old origin still counts');
  assert.equal(platformPath('https://cdn.example/vendor/x.js', ORIGIN), null);
  assert.equal(platformPath('./vendor/x.js', ORIGIN), null, 'the game\'s own files are its own');
  assert.deepEqual(localImports(IMPORTS, ORIGIN), { three: './gcp/vendor/three-0.170.0/build/three.module.js', 'three/addons/': './gcp/vendor/three-0.170.0/examples/jsm/', '@gcp/': './gcp/kits/v1/', lib: 'https://cdn.example/lib.js' });
});

test('the package\'s index.html loads YouTube\'s SDK, then ours from the package, then an import map, before the game', () => {
  const html = packageHtml('<!doctype html><html><head><title>G</title></head><body><script type="module" src="main.js"></script></body></html>', IMPORTS, ORIGIN);
  const head = html.slice(html.indexOf('<head>') + 6);
  assert.ok(head.startsWith('<script src="https://www.youtube.com/game_api/v1"></script><script>window.__GCP_HOST=\'youtube\'</script><script src="./gcp/gcp.js"></script><script type="importmap">'));
  assert.match(html, /"three":"\.\/gcp\/vendor\/three-0\.170\.0\/build\/three\.module\.js"/);
  assert.ok(html.indexOf('importmap') < html.indexOf('main.js'));
  // a game's own import map is rewritten in place (a browser honours only the first), and a copy of the SDK is dropped
  const own = packageHtml(`<html><head><script src="https://hearthcade.com/sdk/gcp.js"></script><script type="importmap">{"imports":{"three":"${IMPORTS.three}"}}</script></head></html>`, IMPORTS, ORIGIN);
  assert.equal((own.match(/importmap/g) || []).length, 1);
  assert.match(own, /"three":"\.\/gcp\/vendor/);
  assert.ok(!own.includes('hearthcade.com/sdk/gcp.js'));
  assert.ok(packageHtml('<canvas></canvas>', {}, ORIGIN).startsWith('<script src="https://www.youtube.com/game_api/v1">'));
});

// The SDK opened standalone with YouTube's SDK on the page.
function sdk({ saved = null } = {}) {
  const calls = [], frames = [], timers = [], noop = () => {};
  const handlers = {};
  const ytgame = {
    game: { firstFrameReady: () => calls.push('firstFrameReady'), gameReady: () => calls.push('gameReady'), loadData: () => { calls.push('loadData'); return Promise.resolve(saved); }, saveData: (s) => { calls.push('saveData'); ytgame.stored = s; return Promise.resolve(); } },
    system: { onPause: (fn) => { handlers.pause = fn; }, onResume: (fn) => { handlers.resume = fn; }, isAudioEnabled: () => true, onAudioEnabledChange: (fn) => { handlers.audio = fn; }, getLanguage: () => Promise.resolve('ja') },
    engagement: { sendScore: (s) => { calls.push('score:' + s.value); return Promise.resolve(); } },
  };
  const win = { addEventListener: noop, removeEventListener: noop, requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; }, location: { search: '', pathname: '/', hash: '', origin: 'https://g.example', href: 'https://g.example/' }, history: { replaceState: noop }, __GCP_HOST: 'youtube', ytgame };
  win.parent = win;
  let now = 0;
  const ctx = {
    window: win, parent: win, location: win.location, history: win.history, URLSearchParams, URL, console: { ...console, error: noop, log: noop, warn: noop }, navigator: { language: 'en' },
    document: { addEventListener: noop, removeEventListener: noop, createElement: () => ({ getContext: () => null, style: {}, setAttribute: noop }), documentElement: { style: {}, setAttribute: noop }, head: { appendChild: noop }, body: null, querySelector: () => null, visibilityState: 'visible' },
    performance: { now: () => now, timeOrigin: 1.7e12 }, setTimeout: (fn, ms) => { timers.push({ fn, at: now + (ms || 0) }); return timers.length; }, clearTimeout: (i) => { if (timers[i - 1]) timers[i - 1].fn = null; }, setInterval: () => 0, clearInterval: noop, requestAnimationFrame: win.requestAnimationFrame,
    localStorage: { getItem: () => null, setItem: () => { throw new Error('the package must not use localStorage'); }, removeItem: noop }, fetch: () => { calls.push('fetch'); return Promise.reject(new Error('offline')); }, Promise, JSON, Math, Object, Array, Date, Number, String, isFinite, Error, Blob: class {}, Uint8Array, Float32Array, ArrayBuffer, WebSocket: class {}, encodeURIComponent,
  };
  Object.assign(win, ctx, { window: win }); vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url), 'utf8'), ctx);
  const step = (ms = 16) => { now += ms; for (const fn of frames.splice(0)) fn(now); for (const t of timers) if (t.fn && t.at <= now) { const f = t.fn; t.fn = null; f(); } };
  return { GCP: win.GCP, calls, handlers, step, ytgame, tick: () => new Promise((ok) => setImmediate(ok)) };
}

test('inside YouTube the SDK reports readiness, keeps saves in YouTube\'s cloud save, pauses and sends scores', async () => {
  const s = sdk({ saved: JSON.stringify({ best: 7 }) });
  assert.equal(s.GCP.host, 'youtube'); assert.equal(s.GCP.standalone, true);
  await s.tick();
  assert.equal(await s.GCP.save.get('best'), 7, 'the cloud save is loaded first');
  assert.equal(await s.GCP.save.set('best', 9), true);
  assert.equal(s.calls.filter((c) => c === 'saveData').length, 0, 'written a second after the last change');
  s.step(1100); await s.tick();
  assert.deepEqual(JSON.parse(s.ytgame.stored), { best: 9 });
  assert.ok(s.calls.indexOf('loadData') < s.calls.indexOf('saveData'));
  s.GCP.ready(); assert.ok(s.calls.indexOf('firstFrameReady') >= 0 && s.calls.indexOf('firstFrameReady') < s.calls.indexOf('gameReady'), 'the first frame is reported before readiness');
  s.GCP.ready(); assert.equal(s.calls.filter((c) => c === 'firstFrameReady').length, 1);
  s.GCP.leaderboard.submit('main', 12.6); s.GCP.leaderboard.submit('time', 30, 'asc'); s.GCP.gameOver({ score: 40 });
  assert.deepEqual(s.calls.filter((c) => c.startsWith('score:')), ['score:13', 'score:40'], 'lower-is-better boards stay out');
  let paused = null; s.GCP.onPause((p) => { paused = p; });
  s.handlers.pause(); assert.equal(s.GCP.paused, true); assert.equal(paused, true);
  s.handlers.resume(); assert.equal(s.GCP.paused, false);
  assert.ok(!s.calls.includes('fetch'), 'nothing goes to HearthCade');
});

test('without YouTube\'s SDK on the page, a standalone game is not in YouTube mode', () => {
  const win = {}, noop = () => {};
  const ctx = { window: win, location: { search: '', pathname: '/', hash: '' }, history: { replaceState: noop }, URLSearchParams, URL, console: { ...console, log: noop, warn: noop, error: noop }, navigator: {}, document: { addEventListener: noop, createElement: () => ({ getContext: () => null, style: {} }), documentElement: { style: {} }, head: { appendChild: noop }, body: null, querySelector: () => null }, performance: { now: () => 0 }, setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop, requestAnimationFrame: () => 0, localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, fetch: () => Promise.reject(new Error('x')), Promise, JSON, Math, Object, Array, Date, Number, String, isFinite, Error, Blob: class {}, Uint8Array, Float32Array, ArrayBuffer, WebSocket: class {}, encodeURIComponent };
  win.parent = win; win.__GCP_HOST = 'youtube'; Object.assign(win, ctx, { window: win, addEventListener: noop }); vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url), 'utf8'), ctx);
  assert.equal(win.GCP.host, null);
});

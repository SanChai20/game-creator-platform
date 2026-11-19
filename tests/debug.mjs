// debug_preview's steps (src/debug-core.js): checked against their limits before a browser is touched, then run in a real
// browser (Playwright's Chromium, the local stand-in for Browser Rendering) on a small canvas game with the platform SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEBUG_LIMITS, StepError, checkSteps, gameState, openGame, runSteps, shoot, viewportOf } from '../src/debug-core.js';

const vp = viewportOf('desktop');
test('viewports', () => {
  assert.deepEqual(viewportOf(undefined), { width: 960, height: 540, touch: false, name: 'desktop' });
  assert.equal(viewportOf('phone-portrait').touch, true);
  assert.equal(viewportOf({ width: 800, height: 600 }).name, 'custom');
  assert.throws(() => viewportOf('watch'), StepError);
  assert.throws(() => viewportOf({ width: 5000, height: 600 }), StepError);
});

test('steps are held to their limits', () => {
  assert.deepEqual(checkSteps([{ do: 'click', x: 10.04, y: 20 }], vp), [{ do: 'click', x: 10, y: 20, button: 'left', count: 1 }]);
  assert.equal(checkSteps([{ do: 'key', key: ' ' }], vp)[0].key, 'Space');
  assert.throws(() => checkSteps([{ do: 'click', x: 2000, y: 10 }], vp), /outside/);
  assert.throws(() => checkSteps([{ do: 'navigate', url: 'https://example.com' }], vp), /needs "do"/);
  assert.throws(() => checkSteps([{ do: 'key', key: 'Enter; rm -rf' }], vp), /key name/);
  assert.throws(() => checkSteps(Array.from({ length: DEBUG_LIMITS.steps + 1 }, () => ({ do: 'wait', ms: 1 })), vp), /At most/);
  assert.throws(() => checkSteps([{ do: 'wait', ms: 10000 }, { do: 'wait', ms: 10000 }, { do: 'wait', ms: 10 }], vp), /add up/);
  assert.throws(() => checkSteps(Array.from({ length: DEBUG_LIMITS.shots }, () => ({ do: 'screenshot' })), vp), /screenshots/);
  assert.throws(() => checkSteps([{ do: 'screenshot', clip: { x: 900, y: 0, width: 100, height: 100 } }], vp), /clip/);
  assert.throws(() => checkSteps([{ do: 'type', text: 'x'.repeat(DEBUG_LIMITS.text_chars + 1) }], vp), /characters/);
  assert.throws(() => checkSteps('click', vp), /list/);
});

let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch { /* not installed */ }
const SDK = readFileSync(new URL('../web/public/sdk/gcp.js', import.meta.url), 'utf8');
const GAME = `<!doctype html><html><body style="margin:0;background:#123"><canvas id="c" width="960" height="540"></canvas><div id="hud">Score 0</div>
<script>${SDK}</script><script>
const c = document.getElementById('c'), g = c.getContext('2d'); let x = 100, score = 0, keys = {};
addEventListener('keydown', (e) => { keys[e.code] = true; if (e.key === 'Enter') { score += 10; hud.textContent = 'Score ' + score; } });
addEventListener('keyup', (e) => { keys[e.code] = false; });
c.addEventListener('click', (e) => { score += 1; hud.textContent = 'Score ' + score; if (score >= 3) hud.textContent += ' Level 2'; });
GCP.test.onState(() => ({ x: Math.round(x), score }));
(function loop() { if (keys.ArrowRight) x += 4; g.fillStyle = '#123'; g.fillRect(0, 0, 960, 540); g.fillStyle = '#fc0'; g.fillRect(x, 250, 40, 40); requestAnimationFrame(loop); })();
requestAnimationFrame(() => GCP.ready());
</script></body></html>`;

test('steps play a real page and report its state', { skip: !chromium && 'Playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
    await page.route('http://game.test/', (r) => r.fulfill({ contentType: 'text/html', body: GAME }));
    const opened = await openGame(page, 'http://game.test/', vp);
    assert.equal(opened.started, true);
    const steps = checkSteps([
      { do: 'click', x: 300, y: 300 }, { do: 'click', x: 300, y: 300 }, { do: 'click', x: 300, y: 300 },
      { do: 'wait_for', until: 'text', text: 'level 2', timeout_ms: 2000 },
      { do: 'key', key: 'ArrowRight', hold_ms: 400 },
      { do: 'key', key: 'Enter' },
      { do: 'screenshot', label: 'hud', clip: { x: 0, y: 0, width: 200, height: 100 } },
      { do: 'eval', js: 'document.getElementById("hud").textContent' },
      { do: 'eval', js: 'const a = 2; return { a };' },
      { do: 'wait_for', until: 'frames', frames: 5 },
    ], vp);
    const r = await runSteps(page, steps);
    assert.ok(r.log.every((l) => l.ok), JSON.stringify(r.log));
    assert.equal(r.log[7].detail, 'Score 13');
    assert.equal(r.log[8].detail, '{"a":2}');
    assert.equal(r.shots.length, 1); assert.equal(r.shots[0].bytes[0], 0xff);   // a JPEG
    const s = await gameState(page);
    assert.equal(s.ready, true); assert.ok(s.frames > 10);
    const st = JSON.parse(s.game_state); assert.equal(st.score, 13); assert.ok(st.x > 100, 'holding ArrowRight moved the square');
    // a wait that is not met stops the call there
    const stop = await runSteps(page, checkSteps([{ do: 'wait_for', until: 'text', text: 'never there', timeout_ms: 300 }, { do: 'click', x: 1, y: 1 }], vp));
    assert.equal(stop.stopped, 1); assert.equal(stop.log.length, 1);
    // an error in eval is reported on its step, and the call goes on
    const bad = await runSteps(page, checkSteps([{ do: 'eval', js: 'nope.nothing' }, { do: 'wait', ms: 1 }], vp));
    assert.equal(bad.log[0].ok, false); assert.equal(bad.log[1].ok, true);
    assert.ok((await shoot(page)).length > 1000);
  } finally { await browser.close(); }
});

// The game standards registry (src/standards.js): its numbers match the code that draws each surface, the guide is what
// the registry renders, and the validator finds what each standard says it finds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NUMBERS, STANDARDS, checkStandards, findingLine, renderStandards, safeAreaSvg, standardById, standardsIndex } from '../src/standards.js';
import { LISTING_LIMITS } from '../web/src/languages.ts';
import { PLAY_MAX_W } from '../web/src/play-window.ts';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const has = (file, text, why) => assert.ok(read(file).includes(text), `${file} no longer has ${JSON.stringify(text)}: ${why}. Update NUMBERS in src/standards.js and run node scripts/standards-guide.mjs --image.`);

test('the numbers match the code that draws each surface', () => {
  const N = NUMBERS;
  assert.deepEqual(N.listing, LISTING_LIMITS, 'listing limits');
  // the home banner and the game page
  has('web/src/store.css', `.hero-body h2 { font: 800 clamp(${N.hero.title_px[0]}px, 5.2vw, ${N.hero.title_px[1]}px)`, 'banner title size');
  has('web/src/store.css', 'text-transform: uppercase; overflow-wrap: anywhere; }', 'banner title in capitals, broken anywhere');
  has('web/src/store.css', `max-width: ${N.hero.tagline_ch}ch; display: -webkit-box; -webkit-line-clamp: ${N.hero.tagline_lines};`, 'banner tagline clamp');
  has('web/src/store.css', `.gp-head h1 { font: 800 clamp(${N.page.title_px[0]}px, 6.2vw, ${N.page.title_px[1]}px)`, 'game page title size');
  has('web/src/ui/ui.css', `.prose { white-space: pre-line; line-height: 1.75; color: var(--text-2); max-width: ${N.page.description_ch}ch;`, 'description is plain text, line breaks kept');
  has('web/src/store.css', `.game .art { position: relative; aspect-ratio: ${N.card.aspect.replace(':', ' / ')};`, 'card crop');
  has('web/src/store.css', `.game-b h3 { font: 700 ${N.card.title_px}px/`, 'card title');
  has('web/src/lib.tsx', 'return s && norm(s) !== norm(g.title) ? s : \'\';', 'a tagline that repeats the title is hidden');
  // the menu button and the tip
  has('web/src/player.tsx', `const corner = prefs.exit ?? '${N.menu_button.corner}';`, 'default corner');
  has('web/src/player.tsx', `const BTN = ${N.menu_button.size},`, 'button size used for dragging');
  has('web/src/player.css', `width: ${N.menu_button.size}px; height: ${N.menu_button.size}px; padding: 0; border: 1px solid rgb(255 255 255 / .28); border-radius: 50%;`, 'button size');
  has('web/src/player.css', `.stage-exit.top-left { top: calc(${N.menu_button.inset}px + env(safe-area-inset-top, 0px)); left: calc(${N.menu_button.inset}px + env(safe-area-inset-left, 0px)); }`, 'button inset');
  has('web/src/player.css', `.stage-exit button { animation: stage-exit-dim ${N.menu_button.fade_after_s}s ease forwards; }`, 'fade time');
  has('web/src/player.css', `100% { opacity: ${String(N.menu_button.fade_to).replace(/^0/, '')}; }`, 'fade level');
  has('web/src/player.tsx', `TIP_TIMES = ${N.menu_button.tip_plays};`, 'tip plays');
  has('web/src/player.css', `max-width: min(${N.menu_button.tip_width}px,`, 'tip width');
  has('web/src/player.tsx', 'const edge = active && prefs.edge !== false;', 'edge to edge by default');
  // on-screen controls
  has('web/public/sdk/gcp.js', `padL = ${N.touch.edge} + (sf.left || 0), padR = ${N.touch.edge} + (sf.right || 0), padB = ${N.touch.edge} + (sf.bottom || 0)`, 'controls distance from the edges');
  has('web/public/sdk/gcp.js', `var R = Math.round(${N.touch.stick_radius} * s)`, 'stick radius');
  has('web/public/sdk/gcp.js', `sq = ${N.menu_button.size + 2 * N.menu_button.inset}, sf = display.safe`, 'display.menuButton square');
  has('web/public/sdk/gcp.js', `Math.min(vw * ${N.touch.stick_zone_w}, R * 3.4)), zh = Math.round(Math.min(vh * ${N.touch.stick_zone_h}, R * 3.4))`, 'stick zone');
  // the window and friend pop-ups
  assert.equal(PLAY_MAX_W, N.window.max_w); assert.equal(N.window.max_h, N.window.max_w * 9 / 16);
  has('web/src/social.css', `.fr-toasts { position: fixed; top: calc(${N.friends_popup.top}px + env(safe-area-inset-top, 0px)); right: ${N.friends_popup.right}px;`, 'pop-up position');
  has('web/src/social.css', `width: min(${N.friends_popup.width}px,`, 'pop-up width');
  has('web/src/social.tsx', `ttl: ${N.friends_popup.seconds * 1000},`, 'pop-up time');
});

test('the guide on disk is what the registry renders', () => {
  assert.equal(read('web/public/guides/standards.md'), renderStandards(''), 'run node scripts/standards-guide.mjs');
  const md = renderStandards('https://x.test');
  for (const s of STANDARDS) assert.ok(md.includes(`<a id="${s.id}"></a>`), s.id);
  assert.match(md, /https:\/\/x\.test\/guides\/safe-area-template\.png/);
  assert.match(safeAreaSvg(), /^<svg[\s\S]*<\/svg>$/);
});

test('every standard is complete, and every check it names is one the validator raises', () => {
  const ids = new Set();
  for (const s of STANDARDS) {
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`); ids.add(s.id);
    for (const k of ['id', 'area', 'title', 'where', 'enforced', 'guide']) assert.ok(typeof s[k] === 'string' && s[k], `${s.id}.${k}`);
    assert.ok(s.spec.length && Array.isArray(s.do) && Array.isArray(s.dont) && Array.isArray(s.checks), s.id);
    assert.ok(['store', 'game', 'not-offered'].includes(s.area), s.id);
    assert.ok(s.guide.startsWith('/guides/'), s.id);
  }
  assert.equal(standardsIndex().length, STANDARDS.length);
  assert.equal(standardById('nope'), null);
  // run the validator on everything it can find and collect the check ids it raises
  const raised = new Set(checkStandards({
    listing: { title: 'A Very Long Game Title That Keeps On Going', tagline: '', description: '**bold**', controls: '`W`', translations: { zh: { title: 'x', tagline: 'x' }, ja: { title: 'y', tagline: 'y'.repeat(200) } } },
    texts: { 'index.html': 'addEventListener("keydown", f); const a = "achievement"; const b = "HearthCade";' },
    paths: ['index.html', 'trailer.mp4'], gcp: { requirements: { devices: ['mobile'] } },
  }).map((f) => f.check));
  for (const f of checkStandards({ listing: { title: 'Ok', tagline: 'Fine.', description: '', has_cover: false }, texts: { 'a.js': 'onkeydown = keydown;' } })) raised.add(f.check);
  for (const f of checkStandards({ report: { metrics: { progressBeforeReady: 0 }, zones: { checked: true, corner: 'top-left', zones: [{ zone: 'menu-button', coverage: 0.5, box: [47, 0, 56, 56] }, { zone: 'home-bar', coverage: 0.3, box: [0, 369, 844, 21] }] } } })) raised.add(f.check);
  for (const f of checkStandards({ report: { zones: { checked: false, reason: 'one-layer', zones: [] } } })) raised.add(f.check);
  for (const f of checkStandards({ texts: { 'a.js': 'const c = new AudioContext(); addEventListener("pointerdown", unlock);' } })) raised.add(f.check);
  for (const s of STANDARDS) for (const c of s.checks) assert.ok(raised.has(c), `${s.id} names check ${c}, which the validator never raised`);
});

test('the listing checks', () => {
  const f = (listing) => checkStandards({ listing }).map((x) => x.check);
  assert.deepEqual(f({ title: 'Noctelle', tagline: 'A tactics duel under the blood moon.', description: 'Plain text.\n\nTwo paragraphs.', controls: 'WASD · move' }), []);
  assert.ok(f({ title: 'Noctelle', tagline: 'NOCTELLE!', description: 'x' }).includes('tagline-repeats-title'));
  assert.ok(f({ title: 'Noctelle', tagline: 'x'.repeat(NUMBERS.hero.tagline_shown + 1), description: 'x' }).includes('tagline-long'));
  assert.ok(f({ title: '永夜', tagline: '培'.repeat(NUMBERS.hero.tagline_shown_cjk + 1), description: 'x' }).includes('tagline-long'));
  assert.ok(!f({ title: '永夜', tagline: '培'.repeat(NUMBERS.hero.tagline_shown_cjk), description: 'x' }).includes('tagline-long'));
  assert.ok(f({ title: 'Noctelle', tagline: 'Fine.', description: '## Features\n- a' }).includes('description-markdown'));
  assert.ok(f({ title: 'Noctelle', tagline: 'Fine.', description: 'See [the site](https://x.test)' }).includes('description-markdown'));
  assert.ok(!f({ title: 'Noctelle', tagline: 'Fine.', description: '· a list\n- another\nC# and 3 * 4 are fine' }).includes('description-markdown'));
  assert.ok(f({ title: 'x'.repeat(NUMBERS.hero.title_2_lines + 1), tagline: 'Fine.', description: 'x' }).includes('title-long'));
  // translations are checked in their own language and named
  const zh = checkStandards({ listing: { title: 'Star Garden', tagline: 'Grow little stars.', description: 'x', translations: { zh: { title: '星之庭', tagline: '星之庭' } } } });
  assert.equal(zh.length, 1); assert.equal(zh[0].lang, 'zh'); assert.match(findingLine(zh[0]), /^WARNING \[tagline\] The tagline \(zh\) repeats the title/);
});

test('the code checks', () => {
  const run = (code, gcp = {}, paths) => checkStandards({ texts: { 'index.html': code }, gcp, paths }).map((x) => x.check);
  // intended sound: an unlock in the bubble phase never hears a tap on a canvas menu button (Bloomguard and Noctelle before the fix)
  assert.ok(run('const A = window.AudioContext; addEventListener(\'pointerdown\', unlock); addEventListener(\'keydown\', unlock);').includes('sound-unlock-bubble'));
  assert.ok(run('ctx = new AudioContext(); addEventListener(\'pointerdown\', wake, { passive: true });').includes('sound-unlock-bubble'));
  assert.ok(!run('ctx = new AudioContext(); addEventListener(\'pointerdown\', wake, { capture: true, passive: true });').includes('sound-unlock-bubble'));
  assert.ok(!run('ctx = new AudioContext(); addEventListener(\'pointerdown\', unlock, true);').includes('sound-unlock-bubble'));
  assert.ok(!run('ctx = new AudioContext(); for (const ev of EVENTS) addEventListener(ev, wake, true); addEventListener(\'pointerdown\', onDown);').includes('sound-unlock-bubble'));
  const phone = { requirements: { devices: ['desktop', 'mobile'], orientation: 'landscape' } };
  assert.ok(run('GCP.progress(0.5)', phone).includes('safe-area'));
  assert.ok(!run('GCP.progress(0.5); const s = GCP.display.safe;', phone).includes('safe-area'));
  assert.ok(!run('GCP.progress(0.5); GCP.setDisplay({ edgeToEdge: false })', phone).includes('safe-area'));
  assert.ok(!run('GCP.progress(0.5)', { requirements: { devices: ['desktop'] } }).includes('safe-area'));
  assert.ok(run('GCP.progress(1)', { requirements: { devices: ['mobile'] } }).includes('orientation'));
  assert.ok(!run('GCP.progress(1); GCP.setDisplay({ orientation: "portrait" })', { requirements: { devices: ['mobile'] } }).includes('orientation'));
  assert.ok(run('GCP.ready()').includes('menu-corner'));
  assert.ok(!run("GCP.setDisplay({ exitButton: 'top-right' })").includes('menu-corner'));
  assert.ok(!run('const m = GCP.display.menuButton; const x = m ? m.x + m.w : 0;').includes('menu-corner'));
  assert.ok(run('GCP.ready()').includes('no-progress'));
  assert.ok(run('ctx.fillText("Powered by HearthCade", 0, 0)').includes('platform-logo'));
  assert.ok(!run('// works on HearthCade\nGCP.ready()').includes('platform-logo'));
  // a comment with an apostrophe before the name (Noctelle's bot), and server-side code, are not drawn
  assert.ok(!run("// the platform's preview bots (HearthCade: preview_bots)\nGCP.ready()").includes('platform-logo'));
  assert.ok(!run("/* the player's HearthCade page */ GCP.ready()").includes('platform-logo'));
  assert.ok(checkStandards({ texts: { 'index.html': 'GCP.progress(1)', 'server/bot.js': 'const n = "HearthCade";' } }).every((x) => x.check !== 'platform-logo'));
  assert.ok(run('const url = "https://example.com"; ctx.fillText("HearthCade", 0, 0)').includes('platform-logo'));
  assert.ok(run('GCP.ready()', {}, ['index.html', 'icons/icon-512.png', 'promo/shot1.png']).includes('unused-store-files'));
  assert.ok(!run('GCP.ready()', {}, ['index.html', 'sprites/hero.png', 'music/theme.ogg']).includes('unused-store-files'));
  // libraries are not the game's own code
  assert.ok(checkStandards({ texts: { 'index.html': 'GCP.progress(1)', 'vendor/lib.js': 'const n = "HearthCade";' } }).every((x) => x.check !== 'platform-logo'));
  // warnings reach deploy_preview; notes stay in game_standards check
  for (const x of checkStandards({ texts: { 'index.html': 'GCP.ready()' } })) assert.equal(x.level, 'note');
});

test('what verification measured', () => {
  const run = (report) => checkStandards({ report }).map((x) => `${x.level}:${x.check}`);
  assert.deepEqual(run({ metrics: { progressBeforeReady: 3 }, zones: { checked: true, corner: 'top-right', zones: [] } }), []);
  assert.deepEqual(run({ metrics: { progressBeforeReady: 1 } }), ['warning:progress-hand-off']);
  assert.deepEqual(run({ metrics: {} }), [], 'an older report without the count says nothing');
  assert.deepEqual(run({ zones: { checked: true, corner: 'top-left', zones: [{ zone: 'notch-left', coverage: 0.2, box: [0, 0, 47, 300] }] } }), ['warning:zone-safe-area']);
  assert.deepEqual(run({ zones: { checked: false, reason: 'one-layer', zones: [] } }), ['note:zones-one-layer']);
  assert.deepEqual(checkStandards({ listing: { title: 'A', tagline: 'Fine.', description: 'x', has_cover: false } }).map((x) => x.check), ['cover-missing']);
});

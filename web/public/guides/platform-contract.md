# The platform contract

This page is the whole set of rules. Everything in the other guides is advice that you can take or leave.

## The hard rules

1. **A game is a web page.** The platform hosts web games only: native, mobile, console and desktop builds, installers and archives are refused at upload, and a page that sends players to a download, an app store or another site fails the static checks. From an engine, upload its Web / HTML5 / WebGL export. `index.html` sits at the root of the bundle. Everything it loads from the bundle uses relative paths (`./src/main.js`, `assets/tiles.png`). There is no build step on the platform: what you upload is what is served. If you want a bundler, run it yourself and upload the output.
2. **Call `GCP.ready()` once**, right after the first frame a player could act on is drawn. Not at script start, not when a menu is still loading.
3. **Stay alive.** After ready the page must keep rendering frames through `requestAnimationFrame`, must not throw uncaught errors, and must survive keyboard, mouse and touch input.

4. **Hand over the frame.** Draw everything the player sees (the world, the HUD, menus, dialogs, text) in your canvases, never as page elements over the game, and register `GCP.test.onCapture(fn)` and `GCP.test.onState(fn)`. Text fields (`<input>`, `<textarea>`, `<select>`) are the one exception. See "Hand over the frame" below.

5. **Fit the game's storage.** All of a game's files together may use the game's storage (50 MB by default, the largest file 20 MB; `get_started` shows this platform's numbers under `storage`). Uploads that would go over are refused, and a version over it cannot be deployed or published. Generate content from code, load large or optional content at run time from your own host, and tell the developer about the limit when planning. `get_started {topic: "storage"}`.

That is all. Genre, art style, camera, engine, rendering technique, file layout, controls and the look of the UI are yours; the UI is drawn in your canvases.

## What the platform gives the page

The platform serves each version of a game from Cloudflare's network on the game's own origin (one for the preview, one for the live game), and adds two things to the top of `index.html` before any of your code runs:

- `window.GCP`, the SDK. Never import or bundle it. Guard for local testing with `if (window.GCP) GCP.ready();`.
- An import map, so these bare imports work with no bundler:

```js
import * as THREE from 'three';                          // Three.js {{THREE}}
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as THREE_GPU from 'three/webgpu';               // WebGPU build, see rendering-pipelines
import { createLoop } from '@gcp/core.js';               // optional helper modules the platform hosts
```

If your `index.html` has its own `<script type="importmap">`, the platform leaves it alone and adds nothing (a page can only have one), so list everything you import there. The default addresses are shown by `get_started` under `import_map`. Any other library is fine: put its files in the bundle and import them by relative path, or load it from a public CDN with a full `https://` URL and a pinned version. Bundled files are safer because they cannot disappear.

## The SDK

```js
GCP.progress(0.4, 'Building terrain');   // optional, 0..1 while loading
GCP.ready();                              // required, once
GCP.fatal(err);                           // if the game cannot start; shown as the failure reason

await GCP.save.set('slot1', { level: 3 });       // per-player cloud save (JSON, 256 KB per key)
const data = await GCP.save.get('slot1');        // null when nothing is saved
await GCP.playerStats.add('levels_cleared');     // per-player numbers: add, max, min, set, all
const rec = await GCP.playRecord();              // sessions, play time, first and last played (recorded by the platform)
await GCP.leaderboard.submit('time', 42.5, 'asc');
const rows = await GCP.leaderboard.top('time', 10, 'asc');   // [{ name, score, me }]
const room = GCP.room('lobby');                  // realtime multiplayer, see the multiplayer guide
const friends = await GCP.friends.list();       // platform friends: invite them, never ask for typed codes
GCP.friends.open({ match });                     // the platform's invite picker over the game (match: GCP.match.find({ private: true }))
if (GCP.launch.join) GCP.match.join(GCP.launch.join);   // the player accepted a friend's invite; GCP.friends.on('join', fn) while running
GCP.presence.set({ detail: 'Private court', joinable: match });   // what friends see, with Join

GCP.player        // { id, name, guest } of the signed-in player (guest is true only if the platform has opened free games to guests)
GCP.env           // 'preview' | 'live' | 'local'
GCP.test.seed     // value of ?gcp_seed, or null
GCP.test.onAutostart(fn)   // fn runs after ready() when the verifier opens the game
GCP.test.onPlaythrough(fn) // fn(t) plays the game to its end; the verifier runs it and reports each step
GCP.test.twoPlayers       // { role: 'host' | 'guest', code } when the verifier opened this page for the two-player check, else null
GCP.test.onTwoPlayers(fn) // fn(t, role) runs in two pages, two different players, that meet on twoPlayers.code (GCP.room or GCP.match.find); return { players, world } (see the multiplayer and matches guides)
GCP.test.onCapture(fn)    // required: fn() returns the canvas, or canvases bottom to top, that hold everything the player sees (see "Hand over the frame")
GCP.test.onState(fn)      // required: fn() returns where the game is (level, scene, player position, open menu); attached to the creator's feedback screenshots and returned by debug_preview, never called for players
GCP.lang          // the player's platform language: 'en' | 'zh' | 'zh-TW' | 'ja' | 'ko' | 'es'
GCP.onLang(fn)    // fn(lang, previous) when the player switches the platform language mid-game; the game is never restarted for it
GCP.display       // { fullscreen, mode: 'inline' | 'fullscreen' | 'immersive', orientation, touch, paused, menu }, kept current
GCP.onDisplay(fn) // fn(display) when it changes
GCP.onEscape(fn)  // Esc goes to the game first: fn() returns false only when nothing of the game's was open (input guide, "One pause owner")
GCP.pauseMenu(open) // the game has its own pause menu: Esc with nothing open, or the browser leaving fullscreen, calls open() instead of opening the platform menu
GCP.setPaused(on) // report the game's own pause menu opening (true) and closing (false)
GCP.paused        // true while the platform or the game's own menu pauses the game: the one flag the game loop obeys
GCP.onPause(fn)   // fn(paused, by) when GCP.paused changes, by 'platform' | 'game'; freeze the clock here, never open a menu from it
GCP.menu()        // opens the platform menu (Resume, Quit game); GCP.quit() quits straight away
GCP.fullscreen()  // toggles fullscreen (true enters, false back to the window); the player also has a button and Alt+Enter
GCP.setDisplay({ orientation: 'landscape', exitButton: 'top-right' })   // see "Phones and tablets" in the input guide
GCP.ui.configure({ reference: [1280, 720] })   // the interface scale: draw in units at GCP.ui.scale, anchor with GCP.ui.rect, offer GCP.ui.setSize (services guide, "Interface scale")
```

Every call that talks to the platform resolves instead of throwing, so a network hiccup never takes the game down.

### The platform splash, before your loading screen

When a player presses Play, the platform shows its own splash (the HearthCade logo) over the game while it does its own work: starting the play session and loading the page, the SDK and your fonts. Your page loads underneath, out of sight. Once your loading screen is up in its final look, the splash fades into it, so the player never sees a blank page, a stand-in font or text still being filled in. Do not draw a HearthCade or platform logo of your own, and keep a loading screen of your own (the splash only covers the platform's part).

The splash hands over at the first of these:

- your page has called `GCP.progress()` a second time (the first call often comes before the game has fetched its settings and set its text) and has then stopped changing for a quarter of a second: no elements or text added or changed, no class changes, no style change on `<html>` or `<body>` (a progress bar's width on an inner element does not count);
- 1.2 seconds have passed without that second call, and the page has stopped changing as above;
- `GCP.ready()` or `GCP.fatal()`;
- 6 seconds after the page started, whatever it is doing.

So: draw your loading screen at once, set its text, language and root font size before the second `GCP.progress()` call, and then only move the bar. The splash stays up at least 0.9 seconds after Play so the logo can be read. It only exists in the platform's player: verification, `debug_preview` and a page opened outside the platform never show it, and `GCP.runtime.fixes` lists `splash-handoff` when it is on.

### GPU warm-up, done for you

Every page in the browser shares one GPU process, the store page around your game included. A game that builds every shader and uploads every texture in its first frame stalls that process, and the whole browser with it, until it finishes. The SDK spreads that work out without any code from you:

- Every WebGL context asks for `KHR_parallel_shader_compile`, so the browser builds shaders on worker threads.
- three.js `WebGLRenderer`: while the game is loading (before `GCP.ready()`, or while `GCP.progress()` is below 1 after it), a draw to the screen whose scene holds materials that are not built yet is held back. Those materials are compiled four at a time with `compileAsync`, their textures are uploaded a few at a time (large ones one at a time), and there is a short pause between batches. Then the frame is drawn. Draws into render targets are never held back.

So: call `GCP.ready()` after the first real frame (as the contract already says), and report `GCP.progress()` below 1 while a later level loads, so that load is warmed too. Content that a post-processing pipeline renders into render targets is not covered automatically. Warm it yourself behind your loading screen:

```js
await GCP.gpu.warmup(renderer, [scene, hudScene], camera);   // compile in small batches, with pauses
await GCP.gpu.upload(renderer, [bigTexture, atlas]);          // stagger texture uploads
GCP.gpu.auto = false;   // before creating the renderer, to turn the automatic part off
```

With WebGPU, create pipelines with `createRenderPipelineAsync` / `createComputePipelineAsync` (three's `WebGPURenderer.compileAsync` does), not the synchronous calls.

## What verification does

`deploy_preview` freezes your files as a numbered version, deploys that version as a Worker, opens it in a real browser at 960×540 and checks, in order:

| Check | Passes when |
| --- | --- |
| deployed | The Worker answers and serves this exact version. |
| boots | `GCP.ready()` is called within the time limit and `GCP.fatal()` is not. |
| renders | Frames keep being drawn for a few seconds after ready. A page that never asks for an animation frame (cards, a board or text redrawn when the player acts) skips this and is judged by `responds`. |
| picture | A screenshot is not blank or a single flat colour. |
| playthrough | Only if the game registered one: its own play-through script finished without failing. |
| input | After key presses, clicks, drags and touches, frames are still being drawn. A game that restarts by reloading the page (a "Play again" button) passes as long as it boots again. |
| responds | Something on screen or in the page changes while the game runs and is played. A still picture fails. |
| conduct | The page stays on the game: it does not leave for another site, start downloads, open more than one window or pile up dialogs. |
| files | Every file the page asked for was served. Calls to the game's own server code (`/api/*`) are not counted here. |
| server | Only when the game calls its server code: no request made it throw. A crash in `server/index.js` is listed with its message and, in a preview, the line it came from. |
| clean | No uncaught errors and no unhandled promise rejections. |
| capture | The game registers `GCP.test.onCapture` and `GCP.test.onState`; no page element is painted over the game at the moments the checks look (start, after the play-through, after input), text fields aside; and with the loop held, the picture the hook hands over for one frame matches that frame on screen. |
| device_iphone, device_ipad | Once the checks above pass: the game is opened again on an emulated iPhone and iPad (touch screen, phone and tablet size, high pixel density, Safari's user agent; held sideways unless `orientation` is `portrait`), and must start, keep drawing, survive taps and a drag and throw no errors. These fail the version only for the device kinds listed in `requirements.devices`; otherwise, and for layout findings (part of the game off screen, text under 9 px, buttons under 20 px), they are notes in the report. |
| original | Once the checks above pass: the game is not a copy of another creator's live game. Code everyone starts from (platform templates, kits, libraries such as three.js) is ignored, so building on them is fine. |
| is_game | Once the checks above pass: it is a game the player acts on, not a page, a form or a link to somewhere else. |
| content | Once the checks above pass, a vision model reviews frames taken while the game was played: no hate, scams, phishing or sexual content involving minors, sexual content and violence no greater than `content` declares, and no abusive code (miners, forms that send passwords away, background workers talking to outside servers). Adult games are allowed when declared; they are shown as 18+. |

The browser that runs the check has a software GPU. It is slow, so the frame count needed is low, but a scene that takes ten seconds per frame will fail. If your game has a menu, register a way past it so the check sees real play:

```js
if (window.GCP) GCP.test.onAutostart(() => startGame({ skipIntro: true }));
```

A menu that renders and reacts is also a valid first playable frame. The hook only makes the report and the cover screenshot more useful.

Just before the play-through the browser clicks once in the top-left corner pixel. Browsers keep sound locked until the first real press, and that click is the press, so sound that starts on the first key or pointer event (the usual pattern, and what `createSound()` does) plays during the check and is counted.

### The screenshot

The checks run on a CPU renderer, where a well-made game rightly draws less. After the checks the browser loads the game once more with `?gcp_portrait=1` and takes one picture, which becomes the version's screenshot and the default marketplace cover. `GCP.portrait` is `true` on that load: draw at full quality however slow the frame is. The picture waits until the game is past its loading screen: up to 20 seconds while a full-screen element covers the canvas, or while the game reports loading again with `GCP.progress(f)` after `ready()` (call `GCP.progress(1)` when play is on screen). Publishing never depends on it, and `update_project {cover}` sets your own cover instead.

## Hand over the frame

When the game's creator plays a preview and presses **Capture feedback**, the picture they mark up and send to you must be exactly the frame they saw, on every device. A page can always read back what it draws into its canvases (2D, WebGL, WebGPU, in the page or in a Web Worker). It can never read the page's own elements as pixels, and iPhone and iPad Safari cannot capture the screen at all. The platform never falls back to sharing the browser tab: **a version without `GCP.test.onCapture` cannot be captured, and Capture feedback is greyed out for it**, so adding the hook is your job as the game's agent. The contract is:

1. **Everything the player sees is drawn in your canvases**: the world, the HUD, menus, dialogs, buttons, tooltips, text. Page elements (`div`, `button`, `img`, `svg`, text in the page) may exist for layout or accessibility but must not paint over the game: no text, background, border, shadow or picture of their own. A box that holds a canvas may have a plain background colour (a letterbox); it is drawn into the picture. **Text fields** (`<input>`, `<textarea>`, `<select>`, `contenteditable`) are the one exception: they are drawn into the picture from their boxes, colours and value, and the picture says so.
2. **`GCP.test.onCapture(fn)`**: `fn()` returns the canvas that holds the frame, or the canvases bottom to top (`[world, ui]`). The platform copies them right after the game draws its next frame, wherever they are drawn, and places each where it is on the page. A canvas handed to a Web Worker with `transferControlToOffscreen()` works too: return the page's canvas element. `fn` may also return a picture made for the purpose (a canvas, `OffscreenCanvas`, `ImageBitmap` or `ImageData` of the whole frame), or a promise of one.
3. **`GCP.test.onState(fn)`**: `fn()` returns a small object that says where the game is (scene, level, open menu, player position). It goes with every feedback screenshot so you know what the picture shows.

```js
const world = document.getElementById('world');   // WebGL, three.js, or a worker's OffscreenCanvas
const ui = document.getElementById('ui');          // a 2D canvas over it: HUD, menus, dialogs, text
GCP.test.onCapture(() => [world, ui]);
GCP.test.onState(() => ({ scene: game.scene, level: game.level, menu: ui.openMenu || null }));
```

Drawing UI in a canvas, in short (or use the platform's toolkit: `@gcp/ui.js` gives a canvas interface layer with text, buttons, scrolling lists and a sprite atlas painted in code, and `@gcp/hud.js` the common widgets on top of it; each module's source, {{ORIGIN}}/kits/v1/ui.js and {{ORIGIN}}/kits/v1/hud.js, opens with how to use it):

- **Text**: `ctx.font`, `fillText`, `measureText`; wrap lines yourself. Load web fonts first (`await document.fonts.load('700 24px "Your Font"')`) or the first frames draw the fallback font.
- **Buttons and panels**: shapes (`roundRect`, gradients, shadows) with a layout pass that keeps each widget's rectangle. Hit-test `pointerdown`/`pointerup` against those rectangles in CSS pixels; scale by `devicePixelRatio` only when drawing.
- **Scrolling lists**: keep a scroll offset per list, clip with `ctx.rect` + `clip()`, move it with `wheel` and pointer drags.
- **Keyboard and screen readers**: you may keep invisible page elements (no paint, `opacity: 0` or clipped) as focus targets or labels; they do not count as painting.
- **A WebGL or WebGPU canvas that does not redraw every frame** (a paused or turn-based game): set `preserveDrawingBuffer: true`, or draw a frame inside `onCapture` before returning the canvas.

The `capture` check holds the game to this in every preview: it fails a version that registers no hooks, that paints page elements over the game, or whose handed-over picture does not match the screen. Its detail names the elements it found (`div.menu (text "Single Player")`).

## Prove the game can be played: the play-through

The checks above only know how to start a game and poke at it. They cannot know your rules, so on their own they say nothing about whether a lantern can be collected, the timer ends the round, or the end screen appears. Register a play-through and the verifier plays the game your way and lists every step in the report:

```js
if (window.GCP) GCP.test.onPlaythrough(async (t) => {
  t.step('start a fresh run');            startGame({ skipIntro: true }); await t.frames(2);
  t.step('collect a lantern');            player.position.copy(lanterns[0].position);
                                          await t.until(() => state.collected === 1, 5000, 'the lantern to be collected');
  t.step('the timer ends the round');     state.timeLeft = 0.2;
                                          await t.until(() => state.phase === 'over', 5000, 'the round to end');
  t.step('the end screen shows the score'); t.assert(endScreen.textContent.includes('1'), 'the end screen shows the wrong score');
  t.step('play again resets');            restartButton.click(); await t.frames(2);
                                          t.assert(state.phase === 'playing' && state.collected === 0, 'the run did not reset');
});
```

| Helper | What it does |
| --- | --- |
| `t.step(label)` | Names what is about to be tried. Steps are listed in the report, and a failure names the step it happened in. |
| `t.assert(condition, message)` | Fails the play-through with `message` when the condition is false. |
| `await t.until(fn, timeoutMs, label)` | Waits until `fn()` returns something truthy. Fails after the timeout (default 5000 ms). |
| `await t.frames(n)` | Waits until `n` more frames have been drawn. Fails if the loop has stopped. |
| `await t.key(code, holdMs)` | Presses a key by physical code (`'KeyW'`, `'Space'`, `'ArrowLeft'`) with real `keydown` and `keyup` events. |
| `await t.wait(ms)` | A plain pause. Prefer `t.until`. |

How to write a good one:

- **Play the rules, not the page.** Cover the loop a player goes through: score a point, win or lose, see the result, start again. Five to eight steps is plenty.
- **Drive the game through its own state and functions.** Moving the player onto a pickup and waiting for the count to change tests the collision and scoring code. Setting `score = 1` and asserting `score === 1` tests nothing.
- **Wait on state, not on time.** The verification browser has no GPU and may draw five frames a second. `await t.until(() => state.phase === 'over')` works at any speed; `await t.wait(2000)` does not.
- **Begin by resetting and end in a playable state**, because the input check runs afterwards on whatever is on screen.
- The whole script has 20 seconds. If it throws, an assertion fails or it runs out of time, the version is not verified, and the report says which step failed and why.

A play-through is optional. Without one the report says plainly that only start-up, rendering and input were checked, which means nobody has confirmed the game can be finished. The example above is a complete one to adapt.

If the game needs WebGPU and has no fallback, the automatic browser check cannot run it. The version then waits for its creator to play the preview for a short while with no errors, which counts as verification.

## Compatibility requirements

Every version carries what it needs from the player's browser and device. Players see it in a **Compatibility** section on the game page, and before they launch, the page checks their own browser against it (a real WebGPU adapter request, real WebGL contexts, the renderer, input, device) and says whether the game works there. A player whose device fails is told what is missing and can still choose to play.

Declare them in `gcp.json` under `requirements`, or let the `compatibility` tool write it (`action: "check"` shows what the platform detected and suggests a block; `action: "declare"` validates and writes it). They are frozen with the next `deploy_preview`.

```json
{
  "requirements": {
    "graphics": "webgl2",
    "gpu": "hardware",
    "features": ["webassembly", "web-audio"],
    "optional": ["webgpu", "pointer-lock"],
    "input": ["keyboard", "mouse", "touch"],
    "devices": ["desktop", "tablet", "mobile"],
    "orientation": "landscape",
    "memory_gb": 4,
    "browsers": { "safari": 17 },
    "known_issues": [{ "os": "ios", "severity": "degraded", "note": "Audio starts after the first tap." }],
    "notes": "Plays best with a keyboard."
  }
}
```

- `graphics`: the weakest API the game still runs with: `none`, `canvas`, `webgl`, `webgl2` or `webgpu`. A WebGPU game with a WebGL 2 fallback is `webgl2` with `webgpu` under `optional`. three.js r163 and later needs `webgl2`.
- `gpu`: `hardware` when the game is unplayable on a software renderer.
- `features` must be present; `optional` are used when present. `wasm-threads` cannot be required: games are not served cross-origin isolated, so `SharedArrayBuffer` does not exist in the page.
- `input` lists every way the game can be played (a player needs any one); `devices` the devices it is made for (`mobile` needs touch controls).
- Everything else is optional.

The platform also scans the code at every deploy. With no declaration, the store shows what it detected and says so. With one, the declaration wins; required features the code uses but the declaration never mentions are added, and anything that looks under-declared is reported as a warning.

## Game metadata

Requirements are one part of the metadata every game declares: also its genre, languages, players, content descriptors (for the age rating), session length, progress, accessibility and translated store listings. Genre, requirements, languages, players and content are required to publish. `game_metadata` `action: "check"` lists what is missing with the allowed values and a pre-filled call for each; the whole specification is the `metadata` guide (`get_started` `{"topic": "metadata"}`, or {{ORIGIN}}/guides/game-metadata.md).

## Game standards

The platform sets the standard for everything a game shows or hands over: the cover and its crops, how the store renders the title, tagline, description and controls text, what the platform draws over the game (its menu button, on-screen controls, friend pop-ups), safe areas, the loading hand-off, and what the store does not take (trailers, icons, logos, achievements). Each standard gives where it appears, exact sizes and limits, and what is checked: the `standards` guide (`get_started {"topic": "standards"}`, or {{ORIGIN}}/guides/standards.md) and `game_standards`, which also checks a game against all of them.

## Who runs the platform

The platform is developed and operated by **Horylo LLC**, a Wyoming limited liability company ([horylo.com](https://horylo.com)). Horylo LLC is the party to the Terms of Service ({{ORIGIN}}/legal/terms), the data controller under the Privacy Policy ({{ORIGIN}}/legal/privacy), and the seller of every paid game: players buy from Horylo LLC through Stripe Checkout. By publishing, a creator agrees to the Terms with Horylo LLC and gives it a licence to host, verify, show and distribute the game. Legal and privacy questions go to legal@horylo.com. `get_started` returns the same facts under `operator`.

When a game's own pages name who made it (a credits screen, an about box), they name the creator. They must not present the game as made or endorsed by Horylo LLC or the platform.

## Serving details that matter

- Paths are case sensitive. `Assets/Hero.png` and `assets/hero.png` are different files.
- The page is framed by the platform. `localStorage` works but is per origin: preview and live do not share it. Use `GCP.save` for anything a player would miss: it is private to the signed-in player and this game, and follows them across devices and versions.
- Files are cached hard because each version is immutable. A new version gets a new address, so you never fight a stale cache.
- Fullscreen, gamepad, pointer lock and autoplay-after-gesture are allowed in the frame.
- Browser and device differences are the platform's job, not the game's. The platform's game runtime (the script injected into every game, live ones too) fills in what Safari on iPhone and iPad and older browsers lack (canvas `roundRect`, `at`, `structuredClone`, `requestIdleCallback`, `navigator.vibrate` and more), starts sound on the first tap, turns the game's own `element.requestFullscreen()` and `screen.orientation.lock()` into the player's fullscreen and orientation, keeps storage working where Safari refuses it, and offers a reload when the device takes the WebGL context away and the game does not restore it. `GCP.runtime` lists what is on. What no script can fill in, `deploy_preview` warns about: syntax older Safari cannot parse (regex lookbehind, `static {}` blocks, the `v` flag, import attributes, `using`), features Safari never has (Web MIDI, WebUSB, file pickers) and sound shipped only as Ogg. Camera, microphone and geolocation are not.
- Fullscreen always overrides the size of the window the game was shown in, on the game page and in the console's preview dialog alike: the frame then covers the whole screen. Size the game from `innerWidth` and `innerHeight` on every `resize`, never from the size it started at, and let the interface follow (`GCP.ui`, services guide, "Interface scale and the player's UI size").
- On phones and tablets, pressing Play puts the game in fullscreen at once: the Fullscreen API on Android, and the whole visible screen on iPhone and iPad (Safari's element fullscreen is missing on iPhone and shows a swipe-down hint on iPad; the Home Screen app has no browser bars at all). The game fills the whole screen, under the notch, rounded corners and home indicator too: keep buttons and text inside `GCP.display.safe` (or call `GCP.setDisplay({ edgeToEdge: false })` to be kept inside it). The platform's menu button (40 px) sits in the top-left corner unless the game picks another with `GCP.setDisplay({ exitButton })`. The [safe area standard](./standards.md#safe-area) has the template. The screen is locked to the declared `orientation` where the browser allows it; elsewhere the player is asked to turn the phone. The input guide has the details.
- Keep the bundle lean. The game's storage, the largest file and the file count are shown by `get_started` under `storage` and in every upload answer; `game_storage {project}` shows what uses the space.
- The page has no Content-Security-Policy on connections or media, so it can load data and media at run time from any HTTPS host that sends CORS headers. The storage guide covers how to do it so verification and players are not caught out.

## A complete minimal game

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Minimal</title>
<style>html,body{margin:0;height:100%;background:#101418;overflow:hidden}canvas{display:block;width:100vw;height:100vh;touch-action:none}</style>
</head>
<body>
<canvas id="c"></canvas>
<script type="module">
const c = document.getElementById('c'), g = c.getContext('2d');
let t = 0, last = performance.now(), told = false;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now; t += dt;
  if (c.width !== innerWidth || c.height !== innerHeight) { c.width = innerWidth; c.height = innerHeight; }
  g.fillStyle = '#101418'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#ffb347';
  g.beginPath(); g.arc(c.width / 2 + Math.cos(t) * 120, c.height / 2 + Math.sin(t * 1.3) * 80, 24, 0, 7); g.fill();
  if (!told) { told = true; if (window.GCP) GCP.ready(); }   // after the first real frame
}
requestAnimationFrame(frame);
if (window.GCP) { GCP.test.onCapture(() => c); GCP.test.onState(() => ({ t: Math.round(t) })); }   // hand over the frame
</script>
</body>
</html>
```

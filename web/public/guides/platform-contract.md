# The platform contract

This page is the whole set of rules. Everything in the other guides is advice that you can take or leave.

## The hard rules

1. **A game is a web page.** The platform hosts web games only: native, mobile, console and desktop builds, installers and archives are refused at upload, and a page that sends players to a download, an app store or another site fails the static checks. From an engine, upload its Web / HTML5 / WebGL export. `index.html` sits at the root of the bundle. Everything it loads from the bundle uses relative paths (`./src/main.js`, `assets/tiles.png`). There is no build step on the platform: what you upload is what is served. If you want a bundler, run it yourself and upload the output.
2. **Call `GCP.ready()` once**, right after the first frame a player could act on is drawn. Not at script start, not when a menu is still loading.
3. **Stay alive.** After ready the page must keep rendering frames through `requestAnimationFrame`, must not throw uncaught errors, and must survive keyboard, mouse and touch input.

4. **Fit the game's storage.** All of a game's files together may use the game's storage (50 MB by default, the largest file 20 MB; `get_started` shows this platform's numbers under `storage`). Uploads that would go over are refused, and a version over it cannot be deployed or published. Generate content from code, load large or optional content at run time from your own host, and tell the developer about the limit when planning. `get_started {topic: "storage"}`.

That is all. Genre, art style, camera, engine, rendering technique, file layout, UI and controls are yours.

## What the platform gives the page

The platform serves each version of a game from its own Cloudflare Worker on its own origin, and adds two things to the top of `index.html` before any of your code runs:

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

GCP.player        // { id, name, guest } of the player: an account, or a guest when the platform lets free games be played without one
GCP.env           // 'preview' | 'live' | 'local'
GCP.test.seed     // value of ?gcp_seed, or null
GCP.test.onAutostart(fn)   // fn runs after ready() when the verifier opens the game
GCP.test.onPlaythrough(fn) // fn(t) plays the game to its end; the verifier runs it and reports each step
GCP.test.twoPlayers       // { role: 'host' | 'guest', code } when the verifier opened this page for the two-player check, else null
GCP.test.onTwoPlayers(fn) // fn(t, role) runs in two pages that share one room; return { players, world } (see the multiplayer guide)
GCP.fullscreen()  // asks the platform page to toggle fullscreen (true enters, false leaves); call it from a tap or key press
GCP.display       // { fullscreen, mode: 'inline' | 'fullscreen' | 'immersive', orientation, touch }, kept current
GCP.onDisplay(fn) // fn(display) when it changes
GCP.setDisplay({ orientation: 'landscape', exitButton: 'top-right' })   // see "Phones and tablets" in the input guide
```

Every call that talks to the platform resolves instead of throwing, so a network hiccup never takes the game down.

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
| files | Every file the page asked for was served. |
| clean | No uncaught errors and no unhandled promise rejections. |
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

The checks run on a CPU renderer, where a well-made game rightly draws less. After the checks the browser loads the game once more with `?gcp_portrait=1` and takes one picture, which becomes the version's screenshot and the default marketplace cover. `GCP.portrait` is `true` on that load: draw at full quality however slow the frame is. Publishing never depends on it, and `update_project {cover}` sets your own cover instead.

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

## Serving details that matter

- Paths are case sensitive. `Assets/Hero.png` and `assets/hero.png` are different files.
- The page is framed by the platform. `localStorage` works but is per origin: preview and live do not share it. Use `GCP.save` for anything a player would miss: it is private to the signed-in player and this game, and follows them across devices and versions.
- Files are cached hard because each version is immutable. A new version gets a new address, so you never fight a stale cache.
- Fullscreen, gamepad, pointer lock and autoplay-after-gesture are allowed in the frame. Camera, microphone and geolocation are not.
- On phones and tablets, pressing Play puts the game in fullscreen at once: the Fullscreen API on Android and iPad, and the whole visible screen on iPhone, where Safari has no element fullscreen. The frame sits inside the screen's safe area, so nothing the game draws ends up under a notch or the home indicator. The screen is locked to the declared `orientation` where the browser allows it; elsewhere the player is asked to turn the phone. The input guide has the details.
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
</script>
</body>
</html>
```

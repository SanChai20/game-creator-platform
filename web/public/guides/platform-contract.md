# The platform contract

This page is the whole set of rules. Everything in the other guides is advice that you can take or leave.

## The hard rules

1. **A game is a web page.** `index.html` sits at the root of the bundle. Everything it loads from the bundle uses relative paths (`./src/main.js`, `assets/tiles.png`). There is no build step on the platform: what you upload is what is served. If you want a bundler, run it yourself and upload the output.
2. **Call `GCP.ready()` once**, right after the first frame a player could act on is drawn. Not at script start, not when a menu is still loading.
3. **Stay alive.** After ready the page must keep rendering frames through `requestAnimationFrame`, must not throw uncaught errors, and must survive keyboard, mouse and touch input.

That is all. Genre, art style, camera, engine, rendering technique, file layout, UI and controls are yours.

## What the platform gives the page

The platform serves each version of a game from its own Cloudflare Worker on its own origin, and adds two things to the top of `index.html` before any of your code runs:

- `window.GCP`, the SDK. Never import or bundle it. Guard for local testing with `if (window.GCP) GCP.ready();`.
- An import map, so these bare imports work with no bundler:

```js
import * as THREE from 'three';                          // Three.js {{THREE}}
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as THREE_GPU from 'three/webgpu';               // WebGPU build, see rendering-pipelines
import { createLoop } from '@gcp/core.js';               // optional kits, see list_kits
```

If your `index.html` has its own `<script type="importmap">`, the platform leaves it alone and adds nothing (a page can only have one), so list everything you import there. The default addresses are shown by `get_started` under `imports_available_by_default`. Any other library is fine: put its files in the bundle and import them by relative path, or load it from a public CDN with a full `https://` URL and a pinned version. Bundled files are safer because they cannot disappear.

## The SDK

```js
GCP.progress(0.4, 'Building terrain');   // optional, 0..1 while loading
GCP.ready();                              // required, once
GCP.fatal(err);                           // if the game cannot start; shown as the failure reason

await GCP.save.set('slot1', { level: 3 });       // per-player cloud save (JSON, 256 KB per key)
const data = await GCP.save.get('slot1');        // null when nothing is saved
await GCP.leaderboard.submit('time', 42.5, 'asc');
const rows = await GCP.leaderboard.top('time', 10, 'asc');   // [{ name, score, me }]
const room = GCP.room('lobby');                  // realtime multiplayer, see the multiplayer guide

GCP.player        // { id, name } of the signed-in player
GCP.env           // 'preview' | 'live' | 'local'
GCP.test.seed     // value of ?gcp_seed, or null
GCP.test.onAutostart(fn)   // fn runs after ready() when the verifier opens the game
GCP.fullscreen()  // asks the platform page to toggle fullscreen
```

Every call that talks to the platform resolves instead of throwing, so a network hiccup never takes the game down.

## What verification does

`deploy_preview` freezes your files as a numbered version, deploys that version as a Worker, opens it in a real browser at 1280×720 and checks, in order:

| Check | Passes when |
| --- | --- |
| deployed | The Worker answers and serves this exact version. |
| boots | `GCP.ready()` is called within the time limit and `GCP.fatal()` is not. |
| renders | Frames keep being drawn for a few seconds after ready. |
| picture | A screenshot is not blank or a single flat colour. |
| input | After key presses, clicks, drags and touches, frames are still being drawn. |
| files | Every file the page asked for was served. |
| clean | No uncaught errors and no unhandled promise rejections. |

The browser that runs the check has a software GPU. It is slow, so the frame count needed is low, but a scene that takes ten seconds per frame will fail. If your game has a menu, register a way past it so the check sees real play:

```js
if (window.GCP) GCP.test.onAutostart(() => startGame({ skipIntro: true }));
```

A menu that renders and reacts is also a valid first playable frame. The hook only makes the report and the cover screenshot more useful.

If the game needs WebGPU and has no fallback, the automatic browser check cannot run it. The version then waits for its creator to play the preview for a short while with no errors, which counts as verification.

## Serving details that matter

- Paths are case sensitive. `Assets/Hero.png` and `assets/hero.png` are different files.
- The page is framed by the platform. `localStorage` works but is per origin: preview and live do not share it. Use `GCP.save` for anything a player would miss.
- Files are cached hard because each version is immutable. A new version gets a new address, so you never fight a stale cache.
- Fullscreen, gamepad, pointer lock and autoplay-after-gesture are allowed in the frame. Camera, microphone and geolocation are not.
- Keep the bundle lean. Limits on file count and size are returned by `get_account`. Generating art in code at boot is the cheapest way to stay small, see the meshes and materials guides.

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

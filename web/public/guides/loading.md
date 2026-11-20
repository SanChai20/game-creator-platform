# Boot and loading

A player decides whether a game is broken in the first two seconds. The goals are: something on screen at once, visible progress, a readable message if anything goes wrong, and `GCP.ready()` at the honest moment.

## The shape that works

```js
import { run, createLoop } from '@gcp/core.js';

run(async (boot) => {                               // shows a boot screen at once; any throw is shown and reported
  await boot.step(0.1, 'Preparing');
  const world = buildWorld();                       // your heavy work, split into stages
  await boot.step(0.6, 'Placing things');
  populate(world);
  await boot.step(0.9, 'Warming up');
  renderer.compile(scene, camera);                  // compile shaders before the first visible frame (Three.js)

  const loop = createLoop({ update, render }).start();
  requestAnimationFrame(() => requestAnimationFrame(() => {   // wait until a real frame has been presented
    boot.done();
    if (window.GCP) GCP.ready();
  }));
}, { title: 'My Game' });
```

`boot.step` updates the bar and then yields to the browser for a frame. That yield is the point: without it the page is frozen for the whole build and the bar never moves.

## The same thing with no kit

The boot screen is drawn in a canvas like everything else the player sees (the platform contract, "Hand over the frame"), so a feedback screenshot taken while it is up shows it.

```html
<canvas id="boot" style="position:fixed;inset:0;width:100vw;height:100vh;z-index:10"></canvas>
<script type="module">
const cv = document.getElementById('boot'), c = cv.getContext('2d');
function paint(label, color = '#e8e4da') {
  const d = Math.min(devicePixelRatio || 1, 2); cv.width = innerWidth * d; cv.height = innerHeight * d; c.scale(d, d);
  c.fillStyle = '#0b0d0f'; c.fillRect(0, 0, innerWidth, innerHeight); c.textAlign = 'center'; c.fillStyle = color;
  c.font = '700 22px system-ui'; c.fillText('My Game', innerWidth / 2, innerHeight / 2 - 10);
  c.font = '14px system-ui'; c.fillText(label, innerWidth / 2, innerHeight / 2 + 18);
}
const tick = (f, label) => { paint(label); if (window.GCP) GCP.progress(f, label); return new Promise((r) => setTimeout(r, 16)); };
paint('Loading…');
try {
  await tick(0.2, 'Building the world');
  // ...
  startLoop();
  requestAnimationFrame(() => requestAnimationFrame(() => { cv.remove(); if (window.GCP) GCP.ready(); }));
} catch (err) {
  paint('Could not start: ' + err.message, '#ff8a70');
  if (window.GCP) GCP.fatal(err);
}
</script>
```

Putting the boot canvas and its script directly in `index.html` means it is painted before the rest of the game has been fetched.

## Rules of thumb

- **Ready means playable.** Call `GCP.ready()` after the first frame of the thing the player interacts with (the game or its menu) has been drawn. Calling it too early makes verification photograph a blank canvas.
- **Never hang silently.** Every path either reaches `GCP.ready()` or `GCP.fatal(err)`. A missing WebGL context, a shader that will not compile and a failed fetch should all end in a message a person can read.
- **Check what you need, early.** `if (!canvas.getContext('webgl2')) throw new Error('This game needs WebGL 2, which this browser does not provide.');`
- **Load in parallel.** `await Promise.all([...])` for files, with a counter driving the progress bar. Loading one after another multiplies the wait.
- **Generate instead of downloading** where the style allows. A procedurally built world has no network to wait for.
- **Stage long builds.** Split generation into steps of a few tens of milliseconds and yield between them. For very large worlds, build what is near the player first and continue after `ready()`.
- **Warm up shaders.** The first time a material is drawn its shader is compiled, which shows as a hitch. `renderer.compile(scene, camera)` (or `await renderer.compileAsync(scene, camera)`) moves that cost under the boot screen.
- **Start time budget.** Aim to be playable within five seconds on an ordinary laptop. Verification allows longer, but players do not.

## Loading real files

```js
async function loadAll(list, onProgress) {         // list: [{ key, url, type: 'image' | 'json' | 'audio' | 'text' }]
  const out = {}; let done = 0;
  await Promise.all(list.map(async (a) => {
    const r = await fetch(a.url);
    if (!r.ok) throw new Error(`Could not load ${a.url} (${r.status})`);
    out[a.key] = a.type === 'image' ? await createImageBitmap(await r.blob()) : a.type === 'json' ? await r.json() : a.type === 'audio' ? await r.arrayBuffer() : await r.text();
    onProgress(++done / list.length);
  }));
  return out;
}
```

Use relative URLs (`./assets/hero.png`). The static check in `check_project` reports files that the code refers to but the bundle does not contain, and verification fails on any request that returns an error.

## Loading content from your own host

Each game has a storage limit (`get_started {topic: "storage"}`), so large or optional content (extra levels, music, high-resolution textures, big models) can live on a host the developer controls and be fetched while the game runs. The page may load from any HTTPS host that sends `Access-Control-Allow-Origin`.

```js
const CDN = 'https://assets.example.com/my-game/v3/';     // versioned, immutable file names
async function remote(name) {
  const cache = await caches.open('my-game-v3');
  let r = await cache.match(CDN + name);
  if (!r) { r = await fetch(CDN + name, { mode: 'cors' }); if (!r.ok) throw new Error(`${name}: ${r.status}`); await cache.put(CDN + name, r.clone()); }
  return r;
}
// boot with what ships in the bundle (or is generated), call GCP.ready(), then stream the rest
GCP.ready();
remote('music/level2.ogg').then((r) => r.arrayBuffer()).then(startMusic).catch(() => { /* play the generated theme instead */ });
```

- Set `crossOrigin = 'anonymous'` on images and loaders (`new THREE.TextureLoader().setCrossOrigin('anonymous')`), or WebGL refuses the texture.
- The verification browser requests what the game requests, and a URL that answers with an error fails the "files" check. Keep the host reliable and every URL working when the version is verified.
- Load data and media, not scripts, with plain GET requests; never send the player's play token or identity to another host.

## Returning players

Read the save during boot and drop the player back where they were. `GCP.save.get` resolves to `null` for a new player and never throws, so the boot path is the same for both.

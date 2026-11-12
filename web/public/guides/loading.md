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

```html
<div id="boot" style="position:fixed;inset:0;display:grid;place-items:center;background:#0b0d0f;color:#e8e4da;font:14px system-ui">
  <div><b>My Game</b><div id="msg">Loading…</div></div>
</div>
<script type="module">
const msg = document.getElementById('msg');
const tick = (f, label) => { msg.textContent = label; if (window.GCP) GCP.progress(f, label); return new Promise((r) => setTimeout(r, 16)); };
try {
  await tick(0.2, 'Building the world');
  // ...
  startLoop();
  requestAnimationFrame(() => requestAnimationFrame(() => { document.getElementById('boot').remove(); if (window.GCP) GCP.ready(); }));
} catch (err) {
  msg.textContent = 'Could not start: ' + err.message;
  if (window.GCP) GCP.fatal(err);
}
</script>
```

Putting the boot markup directly in `index.html` means it is painted before any script has been fetched.

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

## Returning players

Read the save during boot and drop the player back where they were. `GCP.save.get` resolves to `null` for a new player and never throws, so the boot path is the same for both.

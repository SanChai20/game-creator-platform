# Troubleshooting a failed verification

`deploy_preview` returns a report with one entry per check, the errors the browser saw, any files that failed to load, timings, and a screenshot. Read `summary` first, then the first check that failed: later checks often fail only because an earlier one did. Fix, then run `check_project` and `deploy_preview` again. Each preview is a new version number; nothing is overwritten.

## check_project refuses the deploy

| Message | Cause and fix |
| --- | --- |
| JavaScript syntax error at file:line | The file does not parse. The report includes the line and a code frame. Most often an unclosed bracket or template string after an edit; re-read the file with `read_file` before editing again. |
| Import not found | A relative import points at a file that is not in the bundle. Paths are case sensitive and need the extension (`./world.js`, not `./world`). |
| Bare import with no mapping | `import x from 'some-lib'` only works for names in the import map (`three`, `three/addons/…`, `three/webgpu`, `three/tsl`, `@gcp/…`). Bundle the library and import it by relative path, or add your own import map to `index.html`. |
| Missing file | HTML or CSS refers to a file that was not uploaded. |
| GCP.ready() is never called | Add `if (window.GCP) GCP.ready();` after the first playable frame. |
| index.html missing | It must be at the bundle root, not inside a folder. When uploading a zip, the platform strips a single top-level folder for you. |

## boots: GCP.ready() was not called in time

- An exception during startup stopped the code before it reached `ready()`. The `errors` list has it. Wrap startup in `try/catch` and call `GCP.fatal(err)` so the reason is reported clearly (the `run()` helper in `@gcp/core.js` does this).
- `ready()` is waiting on something that never happens in an automated browser: a click on a "Start" button, an audio file that needs a gesture, pointer lock, a font. Call `ready()` when the menu itself is on screen, and register `GCP.test.onAutostart(fn)` to skip into play.
- A top-level `await` on a network request that never resolves. Give fetches a timeout and a fallback.
- Startup is too slow on a CPU-only renderer. Generate less before the first frame and continue after it; lower the default quality when `navigator.hardwareConcurrency` is small.
- `GCP` is `undefined`: the code runs inside a nested iframe or a worker. The SDK lives in the top document of the game only.

## renders: too few frames after ready

- The loop is not driven by `requestAnimationFrame` (for example `setInterval`), or it stops when there is no input. The platform counts frames by watching `requestAnimationFrame`.
- An error inside the loop on the second frame. Check `errors`.
- The scene is too heavy for the verification browser, which renders on the CPU. Cap the pixel ratio, pick a lower quality when frames are slow (see the performance guide), and avoid full-screen post-processing by default.
- The game pauses itself because the page is not focused or pointer lock was not granted. Do not pause on those in the first seconds.

## picture: the screenshot is blank

- `ready()` fired before anything was drawn. Move it after the first rendered frame.
- The camera looks at nothing: it sits inside a mesh, looks away from the scene, or `near`/`far` exclude everything. Place the camera, call `lookAt`, and check `renderer.info.render.triangles` is not zero.
- No light with a lit material gives black. Add a `HemisphereLight`, or use `MeshBasicMaterial` to confirm.
- The canvas has zero size because its CSS size was never set, or the renderer was never resized. Give the canvas `width:100vw;height:100vh` and size the renderer from `clientWidth`/`clientHeight`.
- A full-screen overlay (the boot screen, a menu background) was never removed.
- A custom shader failed to compile. The error is in `warnings`; Three.js logs the GLSL line.

## playthrough: the game's own play-through failed

This check exists only when the game registered `GCP.test.onPlaythrough`. The report names the step that failed and the message.

- **An assertion failed.** That is usually a real bug on that path: the pickup was not counted, the end screen did not open, the restart left old state behind. Fix the game, not the assertion.
- **"Timed out waiting for …".** Either the thing never happens (a bug), or the script depends on speed. The verification browser may draw five frames a second, so a move that takes one second on a laptop can take several there. Wait with `t.until(() => state…)` and give slow steps a longer timeout; do not count on `t.wait(ms)`.
- **"did not finish within 30 s".** The script is too long or waits on something that never resolves. Shorten the route: place the player next to the goal instead of walking across the map, shorten a timer by setting the remaining time.
- **"The page reloaded or closed".** Something reloaded the page while the play-through was still running, which ends the script. Do not press a reloading "Play again" button inside the play-through; end the script on the end screen.
- **`t.key` does nothing.** The game listens on an element that does not have focus, or reads `event.keyCode`. Listen on `window` and use `event.code`.

No play-through registered? The report says only start-up, rendering and input were checked. Add one (see the platform-contract guide); it is the only way the platform can tell that the game can actually be played to the end.

## input: the game stopped after input

An event handler threw. The verifier presses common keys (WASD, arrows, space, enter, escape), clicks, drags and sends touch events. Typical causes: reading a property of something that does not exist until the game has started, `requestPointerLock()` or `requestFullscreen()` rejecting without a `catch`, `audio.play()` rejecting, or Escape closing the game with no way back. Handle rejections: `canvas.requestPointerLock()?.catch?.(() => {})`.

A game may restart itself by reloading the page (a "Play again" button that calls `location.reload()`): the check waits for it to boot again and passes. It fails when the page leaves for another address, or reloads and does not come back within 20 seconds. If that happens without your intending it, the usual culprit is a control that is invisible (`opacity: 0`) but still clickable, or a link around the canvas: hide inactive UI with `display: none` or `visibility: hidden`.

## files: some requests failed

The report lists each address. Fix the path or upload the file. Remember that paths are case sensitive, that a game is not guaranteed to sit at the root of its address (so use `./assets/x.png`, never `/assets/x.png`), and that third-party URLs can fail; bundle what you depend on.

## clean: uncaught errors

Any uncaught exception or unhandled promise rejection after load fails this check, with the message and location in `errors`. Fix the cause; do not hide it with an empty global handler. Messages you log with `console.error` are listed as warnings and do not fail the check.

## WebGPU games

If the game requires WebGPU and has no fallback, the report says the browser check could not run it. Add a WebGL2 or 2D fallback (with `three/webgpu` this is automatic), or ask the user to open the preview from their console and play for a little while; a clean play session by the creator verifies the version.

## Works in preview, breaks for players

`get_stats` returns the errors real players hit, grouped by message, with counts and the version. Fix, preview, publish the new version. If a release goes badly, `rollback` puts an earlier verified version back at once.

## Cannot reach the MCP server at all

- **401 after the tools had been working.** The access token ran out (it lasts about an hour). Do not sign in again: POST `{{ORIGIN}}/oauth/token` with `grant_type=refresh_token`, `refresh_token` and `client_id`, keep the new `access_token` and `refresh_token` from the answer, and repeat the call. Projects and files are untouched.
- **401 with a JSON body on the first call.** No token yet. The body lists the steps: a client with MCP OAuth support signs in through a browser; an agent with no browser posts to `{{ORIGIN}}/oauth/device`, shows the user the link, and polls `{{ORIGIN}}/oauth/token`.
- **403 with the text "error code: 1010".** The request was refused by the network in front of the platform because of its `User-Agent`, before it reached the server. Python's built-in `urllib` is refused with its default one. Send any descriptive `User-Agent` header, for example `my-agent/1.0`, or use `requests`, `httpx`, `curl` or `fetch`, which are accepted as they are.
- **Tools return "What to do" text.** A tool error is returned as a normal result with a hint; read it instead of retrying the same call.

## Local testing

The game is a static page. Serve the folder with any static server and open it: `GCP` is not defined there, which is why calls are guarded with `if (window.GCP)`. The SDK source is at `{{ORIGIN}}/sdk/gcp.js`; including it with a plain script tag gives an offline stand-in whose saves use `localStorage`.

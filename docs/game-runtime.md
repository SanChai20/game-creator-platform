# The game runtime

Every game on the platform runs with one script the platform injects before any of the game's code: `web/public/sdk/gcp.js`,
served from the platform at `/sdk/gcp.js`. Besides the SDK (`GCP.ready`, saves, rooms and the rest), it is the game
runtime: the single place where the platform makes games behave the same in every browser and on every device.

Why here: a game runs in the player's own browser, inside a frame on the platform's page, so no container or sandbox can
hide the device from it. iPhone Safari's rules apply inside any frame. What the platform can do is be in the page with
the game, first, and smooth over the differences there. Because the script is served by the platform, a fix reaches every
game at once, live ones included, with nothing for the creator to do and nothing to publish again.

## Rules every fix keeps

- It never changes what a game sees in a browser that already behaves: fill-ins are added only where something is
  missing, and touch behaviour only on touch screens.
- It never throws. A fix that cannot be applied is skipped and the game runs as it would without it.
- A game that handles something itself wins: its own CSS, its own touch controls, its own context-loss handling,
  `GCP.setDisplay({ touchControls: 'none', pixelRatio: 'native' })`.
- Each fix is registered by name (`fix(id, active)` in the script). `GCP.runtime` returns `{ version, fixes }`, the fixes
  active on this device right now; the verifier stores the same list with each device result in the version's report.

## The fixes

| id | Where it acts | What it does |
| --- | --- | --- |
| `canvas-roundrect` | Safari and iOS before 16, Firefox before 112, Chrome before 99 | Canvas and Path2D `roundRect()`, drawing the same path as the standard method |
| `js-builtins` | Safari and iOS before 15.4 / 16 / 17.4 | `at`, `findLast`, `findLastIndex`, `Object.hasOwn`, `toSorted`, `toReversed`, `with`, `Promise.withResolvers`, `Object.groupBy`, `Map.groupBy`, `AbortSignal.timeout` |
| `structured-clone` | Safari and iOS before 15.4 | `structuredClone()` for plain data, arrays, Date, RegExp, Map, Set, typed arrays and ArrayBuffer, cycles kept |
| `idle-callback` | Safari and iOS (all versions) | `requestIdleCallback` and `cancelIdleCallback` |
| `webkit-audio` | Safari and iOS before 14.1 | `AudioContext` where only `webkitAudioContext` exists |
| `vibrate` | iPhone and iPad | `navigator.vibrate()` that does nothing and returns false, instead of a missing function |
| `storage` | Safari with cookies blocked, and other browsers that refuse storage to a frame | `localStorage` and `sessionStorage` kept in memory for the visit instead of throwing |
| `audio-unlock` | iPhone and iPad most of all | Every audio context the game makes is resumed on the next tap, key or click that counts as a gesture there |
| `fullscreen-api` | In the platform's player | `element.requestFullscreen()`, `document.exitFullscreen()`, `fullscreenElement`, `fullscreenEnabled`, `fullscreenchange` and the `webkit` names go through the player: real fullscreen where the browser has it, the whole visible screen on iPhone. The element fills the frame while it lasts |
| `orientation-lock` | In the player; a stand-in where `screen.orientation` is missing (iOS before 16.4) | `screen.orientation.lock()` asks the player to lock or to ask the player to turn the phone, and resolves |
| `graphics-lost` | Phones and tablets that take the WebGL context away | A game that does not restore a lost context gets a card that reloads it on a tap (saves carry over) |
| `pixel-ratio-cap` | Phones and tablets | `devicePixelRatio` reads at most 2 (1.5 with 2 GB of memory or less), lower while a game keeps dropping frames |
| `pointer-lock-touch` | Phones and tablets | A pointer-lock stand-in: a finger dragging turns the view |
| `touch-cleanup` | Touch screens | No long-press selection, callout or magnifier, no tap flash, no double-tap zoom |
| `pause-audio` | Everywhere | While the platform pauses the game (its menu, a card) or the tab is hidden, every running audio context is suspended and every playing `<audio>`/`<video>` paused; exactly those start again afterwards. A context the game suspends or resumes itself meanwhile is the game's. `GCP.setDisplay({ pauseAudio: false })` turns it off |
| `held-keys` | Everywhere | Keys held down when the game loses the keyboard (the platform menu opens, focus leaves the frame) get their `keyup`, so a character does not walk on after the menu closes. The mouse is released from pointer lock when the platform pauses, so it can reach the menu |
| `near-miss-taps` | Touch screens | A tap just beside a button of the game's page counts as a tap on it |
| `mouse-from-finger` | Touch screens, mouse-only games | Mouse events from the finger: drag, two-finger right click, pinch to wheel |
| `touch-controls` | Touch screens, games played with keys and no touch controls of their own | The platform's stick and buttons press the game's keys (layout from `gcp.json` or the code) |
| `gesture-guard` | In fullscreen | Swipes and pinches reach the game, never the browser (no zoom, no back, no leaving fullscreen) |
| `safe-area` | Edge-to-edge fullscreen on phones with a notch | The screen's insets as `GCP.display.safe` and `--gcp-safe-*` CSS variables |
| `gpu-warmup` | Every WebGL game | Parallel shader compiling, and three.js scenes warmed up a few materials at a time while loading |
| `splash-handoff` | Every game in the platform's player | The player shows the platform's splash (the HearthCade logo) from the Start click and fades it into the game's own loading screen once that screen is up in its final look. The SDK tells the player (`{ gcp: 'shown' }`) when the font hold is over, the game has called `GCP.progress()` a second time (or 1.2 s has passed without it) and the page has not changed for 250 ms (elements, text, classes, the style of `<html>` and `<body>`; not a progress bar's width), at once on `GCP.ready()` or `GCP.fatal()`, and at most 6 s after the page started. The player keeps the splash at least 0.9 s and drops it 8 s after the page loaded if nothing is said. Not in verification or outside the player |
| `font-ready` | Every game with font files in its bundle | The game Worker preloads the version's fonts with the page (woff2 when there are any, up to 8 and 1.5 MB, none over 600 KB). The page stays out of sight until they and the fonts it has asked for are in, at most 2.5 s and never past `GCP.ready()` or `GCP.fatal()`, so a loading screen is never drawn first in a stand-in font and then again in the game's own |

## Checks before a version goes live

What no script can fix is caught before publishing:

- `deploy_preview` warns (`src/device-checks.js`) about syntax Safari before a given version cannot parse (the whole file
  fails to load there: regex lookbehind and `static {}` blocks before 16.4, the `v` flag before 17, import attributes
  before 17.2, `using` in no version), features Safari never has (Web MIDI, WebUSB, WebHID, Web Serial, Web Bluetooth, the
  File System Access pickers) and sound shipped only as Ogg (silent before iOS 18.4). Warnings never block: the creator
  decides whether older iPhones matter for the game.
- Verification plays every version that passes on the computer again on an emulated iPhone and iPad (`verify_devices`,
  `src/verify-core.js`): it must start, keep drawing, survive taps and a drag, and throw no errors. That fails the version
  only for the kinds of device the game lists in `requirements.devices`. Layout findings (part of the game off screen,
  text under 9 px, buttons under 20 px) are notes in the report.

## Changing the runtime

- Add a fix inside `gcp.js` with `fix('name', active)`, keep it to the rules above, and add it to the table.
- Raise the version below (minor for a new fix, patch for a change to one, major for a change a game could notice in a
  browser that already behaved) and say what changed.
- Test it in `tests/runtime.mjs`, and play Bloomguard and Void Echoes in it on phone, tablet and WebKit before it ships:
  every live game gets it the moment it is deployed.

## Versions

- **2.4.0** — New: `splash-handoff`. The platform's splash covers the stage while the platform starts the game and fades
  into the game's own loading screen only once that screen is drawn and settled, so the first, half-built frames of a
  loading screen (blank, a different size, text not yet filled in) are never seen.

- **2.3.0** — New: `GCP.ui`, the interface scale. A game sets a reference size once (`GCP.ui.configure`) and draws its
  interface in units at `GCP.ui.scale`: the screen against the reference, times the player's Interface size (`GCP.ui.size`,
  80% to 150%, kept per game by the platform page and offered in the platform menu once the game uses it). `GCP.ui.rect`
  and `GCP.ui.split` lay boxes out by anchors, like Godot's Controls. Nothing changes for a game that does not call it.

- **2.2.0** — New: `font-ready`. Loading screens drawn before the game's fonts had arrived came out in a stand-in
  font and changed look (sizes, spacing, weight) part way through loading, once the real font came in.

- **2.1.0** — One pause owner (`GCP.pauseMenu`, `GCP.setPaused`, `GCP.paused`, `GCP.onPause`; see the input guide). An
  `onEscape` handler that returns nothing now counts as having used Esc (only `false` hands it to the platform), and a
  game whose own menu comes up on Esc is never given the platform menu as well. When the browser leaves fullscreen by
  itself the game is asked to pause. New: `pause-audio`, `held-keys`. On-screen controls hide while the game's own menu
  is up.

- **2.0.0** — The runtime is named and versioned, with `GCP.runtime`. New: `js-builtins`, `structured-clone`,
  `idle-callback`, `webkit-audio`, `vibrate`, `storage`, `fullscreen-api`, `orientation-lock`, `graphics-lost`. Already
  there and now registered: `canvas-roundrect`, `audio-unlock`, `pixel-ratio-cap`, `pointer-lock-touch`, `touch-cleanup`,
  `near-miss-taps`, `mouse-from-finger`, `touch-controls`, `gesture-guard`, `safe-area`, `gpu-warmup`.

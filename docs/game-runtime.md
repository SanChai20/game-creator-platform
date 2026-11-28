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
| `scroll-keys` | In the platform's player, every browser (Firefox and Safari most of all) | Space, Shift+Space, the arrows, Page Up/Down, Home and End never scroll the page around the game. Firefox and Safari hand such a key to the store page under the frame when nothing in the game's page scrolls with it, and a game that cancels its keys only when they reach `<body>` misses them once its canvas (with a `tabindex`) has the focus. After every listener of the game has seen the key, the runtime cancels its scroll unless the game's page takes it itself: a text field, a list or page that can still scroll that way, Space on a button or link. A key the game cancelled stays the game's, and the game's listeners see each key as it came |
| `held-keys` | Everywhere | Keys held down when the game loses the keyboard (the platform menu opens, focus leaves the frame) get their `keyup`, so a character does not walk on after the menu closes. The mouse is released from pointer lock when the platform pauses, so it can reach the menu |
| `near-miss-taps` | Touch screens | A tap just beside a button of the game's page counts as a tap on it |
| `mouse-from-finger` | Touch screens, mouse-only games | Mouse events from the finger: drag, two-finger right click, pinch to wheel |
| `touch-controls` | Touch screens, games played with keys and no touch controls of their own | The platform's stick and buttons press the game's keys (layout from `gcp.json` or the code) |
| `gesture-guard` | In fullscreen | Swipes and pinches reach the game, never the browser (no zoom, no back, no leaving fullscreen) |
| `safe-area` | Edge-to-edge fullscreen on phones with a notch | The screen's insets as `GCP.display.safe` and `--gcp-safe-*` CSS variables |
| `gpu-warmup` | Every WebGL game | Parallel shader compiling, and three.js scenes warmed up a few materials at a time while loading |
| `splash-handoff` | Every game in the platform's player | The player shows the platform's splash (the HearthCade logo) from the Start click and fades it into the game's own loading screen once that screen is up in its final look. The SDK tells the player (`{ gcp: 'shown' }`) when the font hold is over, the game has called `GCP.progress()` a second time and the page has not changed for 250 ms (elements, text, classes, the style of `<html>` and `<body>`; not a progress bar's width), at once on `GCP.ready()` or `GCP.fatal()`, and at most 6 s after the page started. A game without that second call waits for `GCP.ready()`, at most 12 s, so a stand-in it draws first (a code-drawn title while the title picture downloads) is never seen. The player keeps the splash at least 0.9 s and drops it 13 s after the page loaded if nothing is said. Not in verification or outside the player |
| `font-ready` | Every game with font files in its bundle | The game Worker preloads the version's fonts with the page (woff2 when there are any, up to 8 and 1.5 MB, none over 600 KB). The page stays out of sight until they and the fonts it has asked for are in, at most 2.5 s and never past `GCP.ready()` or `GCP.fatal()`, so a loading screen is never drawn first in a stand-in font and then again in the game's own |

## Checks before a version goes live

What no script can fix is caught before publishing:

- `deploy_preview` warns (`src/device-checks.js`) about syntax Safari before a given version cannot parse (the whole file
  fails to load there: regex lookbehind and `static {}` blocks before 16.4, the `v` flag before 17, import attributes
  before 17.2, `using` in no version), features Safari never has (Web MIDI, WebUSB, WebHID, Web Serial, Web Bluetooth, the
  File System Access pickers) and sound shipped only as Ogg (silent before iOS 18.4). Warnings never block: the creator
  decides whether older iPhones matter for the game.
- Verification plays every version that passes on the computer again on an emulated iPhone and iPad (`verify_devices`,
  `src/verify-core.js`): it must start, keep drawing, survive taps and a drag, and throw no errors. Being playable on
  computers, tablets and phones is a platform requirement, so that fails the version whatever `requirements.devices`
  lists, and `publish` refuses a version whose `requirements.devices` leaves a kind out (rule `every_device`,
  `src/platform-requirements.js`). Layout findings (part of the game off screen, text under 9 px, buttons under 20 px)
  are design advice: notes in the report.

## Changing the runtime

- Add a fix inside `gcp.js` with `fix('name', active)`, keep it to the rules above, and add it to the table.
- Raise the version below (minor for a new fix, patch for a change to one, major for a change a game could notice in a
  browser that already behaved) and say what changed.
- Test it in `tests/runtime.mjs` (and in a real browser where it is about browser behaviour, as `tests/scroll-keys-browser.mjs` is), and play Bloomguard and Void Echoes in it on phone, tablet and WebKit before it ships:
  every live game gets it the moment it is deployed.

## Versions

- **2.16.0** — Spectating and clips. `GCP.room(code, { watch: true })` joins a room as a spectator (receives broadcasts and the room state, sends nothing; `room.spectator`, and `room.watchers` with a `'watchers'` event for the players); `GCP.launch.watch` is the room a friend's Watch opened the game for; `GCP.presence.set({ watch: code })` offers the match to friends. The platform page can ask for a clip (`clip_start` / `clip_stop`): the SDK records the frame the game hands over (`GCP.test.onCapture`, else its canvases) with MediaRecorder for at most 30 seconds, video only, and hands the recording back. Nothing changes for a game that uses none of it.
- **2.15.0** — `GCP.daily()`: the seed of the day, the same for every player of a game that UTC day, and whether the game is today's daily challenge (its scores on the challenge board that day make the day's board on the store). Offline it resolves with the same seed made in the page. Nothing changes for a game that does not call it.
- **2.14.0** — `GCP.track(name, value)`: custom analytics events, counted per name and batched (at most every 10 seconds, and when the tab is hidden). The creator sees them in `get_stats` and the console's Analytics tab, with an ordered funnel from `gcp.json` `funnel`.
- **2.13.0** — `GCP.achievements`: `unlock(id)`, `list()`, `on(fn)` and `toast`, for the achievements a version declares in `gcp.json` `achievements`. `GCP.playerStats` writes now report the achievements their stat goal unlocked, and the SDK shows a short corner notice for each unlock unless the game sets `GCP.achievements.toast = false`. Nothing changes for a game that declares none.
- **2.12.0** — `splash-handoff`: a game that has not called `GCP.progress()` twice no longer gets its splash lifted after 1.2 s. It stays under the splash until `GCP.ready()` (at most 12 s), because what such a game draws first is often a stand-in: Ashen Signal drew its old code-drawn title while the new title picture downloaded, so every launch showed the old cover, then the new one. Games that show a loading screen with `GCP.progress()` are unchanged.
- **2.11.0** — The platform menu button is always there: in the game's window on the page and in fullscreen, in the browser and the installed app, above everything the game draws, and inside the safe area when dragged. `exitButton: 'none'` no longer hides it (it is taken as top-left), and the play frame no longer allows the game to take the browser's fullscreen for itself (the SDK's fullscreen API already goes through the player). `GCP.display.menuButton` is therefore set whenever the game is in the player, in its window too, where it is scaled to the frame when a narrow page shows the frame smaller; it is `null` only outside the player.
- **2.10.0** — `GCP.ui.rect` returns `bleed`: the same box carried on through the safe inset to the screen edge on each side where it sits on the safe edge, so an edge bar draws its background flush to the screen and keeps its content inside the safe area. `rect({ id, layer })` records the box, and `GCP.ui.layout()` returns the boxes placed in the last frames (`{ view, safe, scale, boxes }`); the verifier reads them at every screen size it plays for the layout checks of the `ui-layout` standard. Nothing changes for a game that does not pass an id.
- **2.9.0** — New `GCP.display.menuButton`: while the platform's menu button shows (fullscreen and phones), the square it sits in, in the game's CSS pixels and inside `display.safe` (`{ corner, x, y, w, h }`, 56 px); `null` when it does not show or the game hid it with `exitButton: 'none'`. A HUD that shares that corner moves aside by it instead of guessing. It follows `GCP.setDisplay({ exitButton })` and resizes.
- **2.8.1** — For the verifier only, nothing changes for players: it can read the layers `GCP.test.onCapture` hands over, the display preferences the game set (`exitButton`, `edgeToEdge`, `orientation`) and how many `GCP.progress()` calls came before `GCP.ready()`, so verification can check the game standards' reserved zones and the loading hand-off.
- **2.8.0** — New fix `scroll-keys`: in the player, keys that scroll (Space, the arrows, Page Up/Down, Home, End) no longer
  move the page around the game in Firefox and Safari (and the arrows, Page Down and End in Chrome), whatever element of the
  game has the focus. A game's own scrolling lists, text fields and buttons keep their keys. Checked in Chromium, Firefox
  and WebKit (`npm run test:scroll-keys`).
- **2.7.0** — New: platform friends from inside the game. `GCP.friends` (`available`, `list()`, `invite(id, { match,
  label, data })`, `open({ match, label, data })`, `on('change' | 'join' | 'answer')`), `GCP.presence.set({ detail,
  joinable })` / `clear()`, `GCP.launch.join` and `GCP.match.join(join, opts)`. `GCP.match.find({ private: true })` opens
  an invite-only lobby (`match.private`, `match.lobby`) that friends enter only through an invite; `lobby_gone` and
  `lobby_full` close a join to a lobby that started or filled. Typed codes (`find({ code })`, `GCP.room(code)`) keep
  working unchanged. Nothing changes for a game that calls none of it.

- **2.6.1** — Fixed: after `GCP.match.rejoin()` the page's inputs were ignored for as long as the player had been in
  the match before the reload (the reloaded page numbered its inputs from zero, and a match takes only numbers above
  the last it saw). The page now carries on from the match's own count. Works for matches already running.

- **2.6.0** — New: `GCP.match.find({ wait, settle })`. A search can bring its own short-start wait (5 to 120 s instead of
  the fixed 30 s) and a settling time (a short match does not take a player who joined the queue less than `settle`
  seconds ago). Nothing changes for a game that passes neither.

- **2.5.0** — New: `GCP.match.rejoin()`. A player who reloads the page or closes the browser during a server-run match
  can be put back into it: the game calls `rejoin()` when it opens and gets the running match, or `none`. It works for
  games whose `server/match.js` sets `rejoinMs`. `match.cancel()` now tells the match that the player left on purpose, so
  their place is given up at once instead of after the grace time. Nothing changes for a game that does not call it.

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

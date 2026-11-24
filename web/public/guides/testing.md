# Testing and feedback

Everything the platform gives you to test a game and hear back about it, in the order a build uses it. None of it judges the design: what is checked is whether a player can play the game on computers, tablets and phones. Genre, rules, art, engine and interface are yours and the creator's.

| When | Tool | What it tells you |
| --- | --- | --- |
| Before a deploy | `deploy_preview {project, dry_run: true}` | Static checks only, in a second, nothing deployed |
| Every deploy | `deploy_preview {project}` | A new numbered version on the private preview, verified in a real browser |
| Reading results | `list_versions {project, version}` | That version's full report, each check with its detail and fix |
| Seeing the game | `debug_preview {project, action}` | A browser you drive on the preview: screenshots, input, the game's state |
| Hearing the creator | `creator_feedback {project}` | The creator's annotated screenshots and notes from playing the preview |
| Online games | `preview_bots {project, action}` | Bot players over the real network path, in your preview |
| Before publishing | `game_standards {project, action: "check"}`, `publish {project, dry_run: true}` | Advice on the platform's own surfaces; every release requirement with its fix |
| After release | `get_stats {project}` | How players play, on which devices, and the errors their browsers hit |

## 1. Static checks

`deploy_preview {project, dry_run: true}` reads the workspace without deploying: JavaScript syntax (with the file, line and the code around it), imports that do not resolve, files the page asks for that are missing, the `GCP.ready()` contract, web-only content (no programs, installers, app-store or download links), the platform contract and the storage limit. Errors stop a deploy; warnings (metadata not yet declared, a design recommendation) do not. The same checks run first in every real deploy.

## 2. Verification in a real browser

`deploy_preview {project}` freezes the workspace as a new version, puts it on the game's private preview address (players never see a preview) and opens it in a real browser with no GPU. The answer's `verification` is the outcome: `passed`, `failed` or `running`. The check takes one to two minutes; when the answer says `not_finished`, call `list_versions {project, version, wait_seconds: 55}` until it is done, and do not deploy the same files again.

What the browser checks (each failing check, why it usually fails and the fix are in `get_started {topic: "versions"}`):

- **boots**: the game calls `GCP.ready()` in time.
- **renders** and **picture**: it keeps answering after ready (a frame loop, or a game that redraws only when the player acts) and shows a picture that is not blank.
- **responds**: the picture, `GCP.test.onState` or a sound changes when the verifier presses arrows, WASD, Space, Enter, J, K, Z, X, clicks, drags and taps. `GCP.test.onAutostart(fn)` lets the verifier skip a title screen.
- **input**: it keeps running through random bot play of keys, clicks, drags and taps.
- **files** and **clean**: every file it asks for loads, and nothing throws uncaught.
- **conduct**: it stays on the page (no redirects, downloads or pop-ups).
- **devices**: after passing on the computer, the version is played again on an emulated iPhone and iPad, through taps and a drag. It fails only on a kind of device the game says it supports; layout problems (cut off, tiny text, small buttons) are noted.
- **capture**: advice only, never a failure: whether the game hands over its exact frame (`GCP.test.onCapture`) so feedback screenshots match the screen.
- **two_players**: only for a game that registers `GCP.test.onTwoPlayers`: two verifier pages, two players, meet and end up in one world.
- **playthrough**: only for a game that registers `GCP.test.onPlaythrough`: your own script plays your rules to the end, and each `t.step` is listed in the report. Without one, the report says that only start-up, rendering and input were checked.
- **content** and **original**: what the frames show matches the declared content descriptors, and the version is not a copy of another creator's live game.

A version that failed stays on the preview, so `debug_preview` can show the failure. When a failure did not come from the files (a heavy scene that just missed the frame count on the software GPU), `deploy_preview {project, retry_version: n}` checks the newest version again without a new number, up to 3 times.

### Your own play-through

A play-through is the strongest proof you can give that the game works: it plays your rules, not random input.

```js
GCP.test.onPlaythrough(async (t) => {
  t.step('start a run');           startGame(); await t.frames(2);
  t.step('move right to the key'); await t.key('ArrowRight', 800);
                                   await t.until(() => game.hasKey, 5000, 'the key to be picked up');
  t.step('the run ends');          t.assert(game.phase === 'over' || game.hasKey, 'nothing happened');
});
```

When a check that runs your own test function (`playthrough`, `two_players`) fails, its entry in `report.checks` carries `failure`, which says where the failure came from, so a timeout in your script is never mistaken for a platform one:

| `failure.source` | `failure.kind` | meaning |
| --- | --- | --- |
| `script` | `timeout` | a `t.until(fn, ms, label)` in your function ran out: `label`, `waitMs` |
| `script` | `assert` | a `t.assert` was false: `message` |
| `script` | `error` | your function, or game code it called, threw: `name`, `message`, `at` |
| `script` | `limit` | it did not return within the verifier's limit: `limitMs`, and the wait then running |
| `game` | `no_frames`, `worlds_differ`, `players_missing`, `bad_result` | the game stopped drawing, or the outcome is wrong |
| `page` | `closed` | the page reloaded or navigated away while the function ran |
| `harness` | `no_answer` | the verifier got no answer from the page; deploy again |

Every failure also has `step` (the last `t.step` label), `stepN` and `elapsedMs`; a two-player failure has `side` (`host` or `guest`), each side's own failure is in `report.two_players.host.failure` and `.guest.failure`, and `report.two_players.met` says whether the two pages found each other. So name every step with `t.step`.

`t.step(label)`, `t.key(key, ms)`, `t.frames(n)`, `t.until(fn, ms, what)` and `t.assert(ok, message)`; the limits (30 seconds and 60 steps by default) and the rest of the hook are in `get_started {topic: "contract"}`, "Prove the game can be played".

### Hooks that make every test better

```js
GCP.test.onState(() => ({ scene: game.scene, level: game.level, player: { x: p.x, y: p.y }, menu: ui.open }));
GCP.test.onCapture(() => [worldCanvas, uiCanvas]);   // the canvases that hold everything the player sees, bottom to top
GCP.test.onAutostart(() => startGame());             // skip menus when the verifier or ?gcp_autostart=1 opens the game
```

`onState` is returned by `debug_preview` and attached to every feedback screenshot, so you can tell what a picture shows. `onCapture` makes the creator's feedback screenshots the exact frame on every device. Both are recommended, never required, and never called for players.

## 3. Seeing the game: debug_preview

`debug_preview` is a real browser on the game's current preview that you drive between calls, as a throwaway test player (empty save, never the creator's data).

```
debug_preview {project, action: "open", viewport: "iphone"}   → a screenshot and the game's state
debug_preview {project, action: "act", steps: [
  {do: "tap", x: 420, y: 300},
  {do: "key", key: "ArrowRight", hold_ms: 800},
  {do: "wait_for", until: "text", text: "Level 2"},
  {do: "screenshot", label: "hud close-up", clip: {x: 0, y: 0, width: 400, height: 120}, format: "png", zoom: 2},
  {do: "eval", js: "return window.game && window.game.player"}
]}
debug_preview {project, action: "close"}
```

- **Viewports**: `desktop` (960 × 540, the verifier's size), `hd` (1280 × 720), `phone-landscape` (844 × 390), `phone-portrait` (390 × 844), `tablet` (1024 × 768), `iphone` (844 × 390, landscape) and `ipad` (1180 × 820, landscape); `iphone` and `ipad` are the sizes the device checks play at, and the phone and tablet presets have touch, or `{width, height, touch}`. `autostart: true` opens the game as the verifier does.
- **Steps**: `click`, `double_click`, `right_click`, `move`, `down`, `up`, `drag`, `tap`, `scroll`, `key` (with `hold_ms`), `key_down`, `key_up`, `type`, `wait`, `wait_for` (`ready`, `text` or `frames`), `screenshot` and `eval`. Coordinates are CSS pixels of the viewport, read off the last full screenshot.
- **Screenshots**: JPEG by default; `format: "png"` is lossless (exact colours and hard pixel edges, to compare art with a reference), and `zoom: 2` to `4` renders a `clip` again at that many image pixels per CSS pixel, sharp, for small sprites, icons and text.
- **State**, in every answer: ready, frames drawn, uncaught errors, console errors and warnings, the game's last calls to the platform with each answer (`platform_calls`), missing files and what `GCP.test.onState` returns.
- **Limits**: one browser per account, a few minutes per session (it closes after 3 idle minutes), a bounded number of steps, screenshots and seconds of waiting per call (the tool's description has this platform's numbers), and no GPU: judge layout, text, input and logic here, not frame rate.

Reproduce a failed check or a reported bug here before changing code, and look again after the next deploy.

## 4. Hearing the creator: creator_feedback

While the creator plays the preview in the console, they capture the game, circle or point at what is wrong, attach pictures of their own (a mockup, a reference) and write a note. `creator_feedback {project}` returns the oldest items with their numbered marks, the version, the screen size, the errors the game had and its `onState`, then the annotated pictures as images, and takes them off the queue. Marks come with `[game (x, y)]`, the same spot in the CSS pixels `debug_preview` steps take. `peek: true` only lists what is waiting; `recent: true` returns the last day's items again.

Read it at the start of every session and whenever an answer carries `creator_feedback`. Treat each item as a request from the creator: fix it, deploy, and tell them what changed.

## 5. Online games: preview_bots

`preview_bots` puts bot players into the preview over the platform's real network path: each bot is a remote client with its own play session, waiting in the real matchmaker (`GCP.match.find`) or joining the real room (`GCP.room`), from the region you pick, with optional added latency, jitter and packet loss. They play with the game's own `server/bot.js`; `action: "status"` reports round trips, snapshot rates, gaps, reconnects and errors; `action: "act"` drops, reloads, spikes or cuts a bot's connection. With `target: "queue"` and enough bots, a match runs end to end without any browser. In the owner's preview the bots are also the creator's online friends, so invites can be tested. The bot contract and every option: `get_started {topic: "bots"}`.

## 6. Before publishing

- `game_standards {project, action: "check"}`: findings against the platform's own surfaces (the cover and its crops, the listing text, the menu button, safe areas, the loading hand-off). Advice: weigh each against the game's design; no finding ever stops a version.
- `game_metadata {project}`: the store-page checklist, with what the code shows and what is still missing.
- `publish {project, version, dry_run: true}`: every release requirement (verified against today's checks, playable on every device, store metadata, listing languages, storage, originality, license…) with its status and the exact fix, without publishing.

## 7. After release

`get_stats {project}`: players online now, sessions, play time, new and returning players, the version, device, browser and system they play on, ratings and reviews, sales, and `runtime_errors`: the errors players' browsers reported. `only_now: true` returns just the live counts. A fix goes through the same loop: upload, `deploy_preview`, `publish`.

# Input on every device

About half of the people who open a game are on a phone. A game that only answers to a keyboard loses them, and verification sends keyboard, mouse and touch events to make sure none of them breaks the loop. How the game controls is your design; these are the mechanics underneath.

## One object for all of it

```js
import { createInput } from '@gcp/input.js';

const input = createInput(canvas, { pointerLock: true });   // mouse-look games: a click captures the mouse, Esc frees it
if (input.touch) input.addButton('⤒', 'Space');             // an on-screen button that acts like a key

function update(dt) {
  const { x, y } = input.move;                // WASD, arrows or the touch stick, length at most 1, y is forward
  const { dx, dy } = input.takeLook();        // mouse movement or a right-thumb drag, already scaled
  if (input.pressed('Space')) jump();         // true for exactly one frame
  if (input.down('ShiftLeft')) sprint();      // true while held
  input.endFrame();                           // once, at the end of the frame
}
```

With `pointerLock: true` the kit does what players expect from a web game: a click on the game hides and captures the mouse, Escape shows it again, and the next click captures it again. The capturing click is not also counted as `Mouse0`. While a title screen, a menu or the backpack is up (`.gh-s`, `.gp-win`) the mouse stays free, and the click that closes one captures it again. If the browser refuses capture, dragging still looks around. `control()` in third-person mode turns this on by itself; pass `pointerLock: false` to it to keep drag-to-look.

## Doing it by hand

**Keyboard.** Use `event.code` (`KeyW`, `Space`, `ArrowLeft`), which names the physical key, so WASD works on French and German layouts. Clear held keys when the window loses focus or they stick down:

```js
const keys = new Set();
addEventListener('keydown', (e) => { if (!e.repeat) keys.add(e.code); if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault(); });
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
document.addEventListener('visibilitychange', () => { if (document.hidden) keys.clear(); });
```

`preventDefault` on the arrow keys and space stops the page from scrolling under the game.

**Pointer events** cover mouse, touch and pen with one set of listeners. Track each finger by `pointerId`:

```js
canvas.style.touchAction = 'none';                 // or the browser will pan and zoom instead
canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); /* ... */ });
canvas.addEventListener('pointermove', (e) => { /* e.movementX, e.movementY while locked or captured */ });
canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
```

**Pointer lock** for first-person cameras must be requested from a click, can be refused, and can be left at any time with Escape. Treat leaving it as "pause", and never require it on touch devices:

```js
document.addEventListener('pointerlockchange', () => { paused = document.pointerLockElement !== canvas; });
```

**A touch stick.** Let it appear where the thumb lands on the left half of the screen, and use drags on the right half for the camera. A stick fixed in a corner is always in the wrong place for somebody's hand.

**Gamepads** need no permission and cost a few lines:

```js
function pad() {
  const p = navigator.getGamepads && [...navigator.getGamepads()].find(Boolean);
  if (!p) return null;
  const dead = (v) => (Math.abs(v) < 0.15 ? 0 : v);
  return { x: dead(p.axes[0]), y: -dead(p.axes[1]), lookX: dead(p.axes[2]), lookY: dead(p.axes[3]), a: p.buttons[0].pressed, b: p.buttons[1].pressed };
}
```

## The page around the canvas

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; overscroll-behavior: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
  canvas { display: block; width: 100vw; height: 100dvh; touch-action: none; }
  .hud { position: fixed; inset: 0; pointer-events: none; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
  .hud button { pointer-events: auto; min-width: 44px; min-height: 44px; }
</style>
```

- `100dvh` follows the real visible height on mobile browsers where the address bar comes and goes.
- The safe-area padding keeps the HUD clear of notches and the home indicator.
- Touch targets under about 44 px are missed by thumbs.
- React to size changes with a `ResizeObserver` on the canvas, and handle both orientations or tell the player which one you want.

## Good manners

- Show the controls on screen the first time, for the device actually in use (`input.touch`, or wait and see which event arrives first).
- Pause when the tab is hidden (`visibilitychange`) and when pointer lock is lost.
- Let players rebind or at least offer arrows as well as WASD.
- Do not depend on hover; touch has none.
- Start audio from the first key press or tap; see the audio guide.
- Fullscreen: `GCP.fullscreen()` asks the platform page to toggle it, which works even though the game is framed.

## The Escape rule

Esc first closes whatever the game has open (a menu, the inventory, a dialog, the map). Only an Esc with nothing open leaves fullscreen. Every game should follow it, so a player closing a menu is never thrown out of fullscreen.

```js
GCP.onEscape(() => {
  if (dialog.isOpen) { dialog.close(); return true; }   // true: the game used the key
  if (panel.isOpen) { panel.close(); return true; }
  if (!GCP.display.fullscreen) { pause.open(); return true; }
  return false;                                          // nothing open: the SDK leaves fullscreen
});
GCP.onDisplay((d) => { if (!d.fullscreen && playing && !pause.isOpen) pause.open(); });   // pause when fullscreen ends
```

Register one function and route Esc through it instead of listening for the key yourself. In fullscreen the platform asks the browser to send Esc to the game first (Chromium browsers; holding Esc still leaves at once). Other browsers leave fullscreen on Esc as before and do not call the function, so also pause when `GCP.onDisplay` reports that fullscreen ended. Pointer lock is separate: the browser releases it on Esc without a key event, so treat `pointerlockchange` as "open the pause menu" only when nothing else is open. Show the cursor whenever a menu is open and hide it (pointer lock) when play resumes. `pauseMenu` and the windows of `@gcp/play.js` follow the rule already.

## Phones and tablets

What the platform does for every game, with nothing to write:

- **Fullscreen at Play.** On a phone or tablet the game goes fullscreen as soon as the player presses Play. Android and iPad get the real Fullscreen API. iPhone Safari has none for pages, so the game is given the whole visible screen instead (`GCP.display.mode === 'immersive'`): the page under it cannot scroll or zoom, the back gesture closes it, and the address bar may stay visible.
- **Orientation.** Declare it (`"orientation": "landscape"` in the requirements, or `GCP.setDisplay({ orientation: 'landscape' })` at run time). The screen is locked to it in fullscreen where the browser allows (Android); elsewhere the player is asked to turn the phone, and can choose to play as it is. Your game must still lay itself out for either shape: a resize can come at any moment.
- **Safe areas.** By default the frame sits inside the notch, rounded corners and home indicator in fullscreen, which leaves black bars on those phones. To fill the whole screen, call `GCP.setDisplay({ edgeToEdge: true })` and keep your buttons and text inside `GCP.display.safe` (`{ top, right, bottom, left }` in CSS px, also the CSS variables `--gcp-safe-top`, `--gcp-safe-right`, `--gcp-safe-bottom` and `--gcp-safe-left`). A frame never sees `env(safe-area-inset-*)` itself, so combine the two: `max(env(safe-area-inset-left, 0px), var(--gcp-safe-left, 0px))` is right on the platform and when the game is opened on its own.
- **An exit button.** A small button in the top-left corner leaves fullscreen on touch screens, since there is no Esc key. It fades after a few seconds. Move it out of your HUD's way with `GCP.setDisplay({ exitButton: 'top-right' })` (or a bottom corner), or hide it with `'none'` if your pause menu offers `GCP.fullscreen(false)`.
- **The screen stays on** while the game runs.

What the game should do:

```js
import { createInput } from '@gcp/input.js';

const input = createInput(canvas);                       // floating left-thumb stick and right-side look come with it
input.bind({ jump: ['Space'], fire: ['KeyJ', 'Mouse0'] }, { touch: { jump: '⤒', fire: '✦' } });   // round buttons, right thumb

GCP.setDisplay({ orientation: 'landscape', exitButton: 'top-right', edgeToEdge: true });
GCP.onDisplay((d) => { hud.classList.toggle('compact', d.touch && !d.fullscreen); });
document.documentElement.classList.contains('gcp-touch');   // also set: gcp-fullscreen
```

- Decide what to show from `GCP.display.touch` (or `input.touch`), not from the screen width: a small laptop window is not a phone.
- Thumbs need room. Buttons of 64 px or more, at least 12 px apart, in the bottom corners, away from the screen edge where the system gestures live. One action button is better than four.
- Never require a key on touch: every menu item, pause, restart and "press any key" needs a tap target. Replace keyboard hints ("Space to dash") with touch ones ("tap ⚡ to dash").
- Text at 14 px or more, and nothing important in the bottom 20 px of a phone in landscape.
- Phones are slower. Start at a lower resolution (`devicePixelRatio` capped at 2, or 1.5 for heavy WebGL) and fewer effects, and raise them if the frame rate holds.
- Pause when `visibilitychange` says the page is hidden: phones switch apps far more often than desktops do.

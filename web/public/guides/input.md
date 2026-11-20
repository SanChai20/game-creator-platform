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
- Fullscreen: the player has a Fullscreen button and Alt+Enter, and phones start in fullscreen. `GCP.fullscreen()` toggles it from your own button (call it from a tap or key press).

## The Escape rule

Esc never throws the player out of the game. It first closes whatever the game has open (a menu, the inventory, a dialog, the map). An Esc with nothing open opens the platform menu (Resume, Quit game), unless the game keeps Esc for its own pause menu.

```js
GCP.onEscape(() => {
  if (dialog.isOpen) { dialog.close(); return true; }   // true: the game used the key
  if (panel.isOpen) { panel.close(); return true; }
  return false;                                          // nothing open: the platform menu opens
});
GCP.onDisplay((d) => { if (d.paused && playing && !pause.isOpen) pause.open(); });   // the platform menu or the not-responding card is up
```

Register one function and route Esc through it instead of listening for the key yourself. A game with its own pause menu on Esc returns `true` every time and puts a Quit button in that menu (`GCP.quit()`); a game that registers nothing and calls `preventDefault()` on its Esc keydown keeps the key too. In fullscreen the platform locks Esc to the game (Chromium browsers; holding Esc still leaves). Firefox and Safari leave fullscreen on Esc whatever the page does and do not call the function: the game then carries on in its window, so pause when `GCP.onDisplay` reports that fullscreen ended if your game should. Pointer lock is separate: the browser releases it on Esc without a key event, so treat `pointerlockchange` as "open the pause menu" only when nothing else is open. Show the cursor whenever a menu is open and hide it (pointer lock) when play resumes. `pauseMenu` and the windows of `@gcp/play.js` follow the rule already.

## Phones and tablets

What the platform does for every game, with nothing to write:

- **Fullscreen at Play on phones.** On a phone or tablet the game goes fullscreen as soon as the player presses Play; on a computer it starts in a window on the page, with a Fullscreen button and Alt+Enter. Android and iPad get the real Fullscreen API. iPhone Safari has none for pages, and the installed app (Add to Home Screen) has no browser bar to begin with, so there the game is given the whole visible screen instead (`GCP.display.mode === 'immersive'`): the page under it cannot scroll or zoom.
- **Swipes stay in the game.** In fullscreen the SDK keeps every swipe, drag and pinch in your page: overscroll is off (`overscroll-behavior: none`, which also stops a trackpad swipe from navigating back on a computer), pinch and double-tap zoom are off (`touch-action: pan-x pan-y` on `<html>`, set so that your own `touch-action`, such as `none`, still wins), and a finger moving over anything that does not scroll has its `touchmove` cancelled for the browser, so the browser never turns a drag into a gesture of its own (a pan that fires `pointercancel` mid-drag, iPad's swipe down that closes fullscreen). Your pointer and touch events arrive as before, and your own scrolling lists, text fields and sliders still work. While the game fills the screen the platform also keeps an entry on top of the page's history, so a stray back gesture does not leave the page. A system gesture that still leaves (iPad's swipe from the top edge, Android's back) puts the game back in its window, where the Fullscreen button returns it; the platform menu tells iPhone and iPad players how to add the site to the Home Screen for full screen no swipe can close.
- **Orientation.** Declare it (`"orientation": "landscape"` in the requirements, or `GCP.setDisplay({ orientation: 'landscape' })` at run time). The screen is locked to it in fullscreen where the browser allows (Android); elsewhere the player is asked to turn the phone, and can choose to play as it is. Your game must still lay itself out for either shape: a resize can come at any moment.
- **Safe areas.** By default the frame sits inside the notch, rounded corners and home indicator in fullscreen, which leaves black bars on those phones. To fill the whole screen, call `GCP.setDisplay({ edgeToEdge: true })` and keep your buttons and text inside `GCP.display.safe` (`{ top, right, bottom, left }` in CSS px, also the CSS variables `--gcp-safe-top`, `--gcp-safe-right`, `--gcp-safe-bottom` and `--gcp-safe-left`). A frame never sees `env(safe-area-inset-*)` itself, so combine the two: `max(env(safe-area-inset-left, 0px), var(--gcp-safe-left, 0px))` is right on the platform and when the game is opened on its own.
- **The platform menu.** Nothing of the platform sits over your game in fullscreen. The platform menu (Resume, Quit game) opens from the device's Back (the swipe in from the edge on iPhone, Back on Android), a three-finger tap anywhere, Esc on a keyboard, or your own pause screen through `GCP.menu()` (and `GCP.quit()` quits). When the browser itself leaves fullscreen on a phone or tablet (iPad's swipe down, Android's Back), the game pauses behind a card with Resume. The first few plays on a device start with a short note on how to open the menu; taps go through it. A game that uses three-finger taps turns the gesture off with `GCP.setDisplay({ menuGesture: false })`. A game that wants a visible menu button can ask for one in a corner it keeps free: `GCP.setDisplay({ exitButton: 'top-right' })` (or another corner).
- **The screen stays on** while the game runs.
- **On-screen controls for keyboard games.** At deploy the platform reads your own code (never libraries) for the keys it checks: WASD or the arrow keys become a stick under the left thumb, other keys (Space, Enter, Shift, E…) become up to six round buttons under the right thumb, most important first. They press real keys: `keydown` and `keyup` with `code`, `key` and `keyCode` set, so any input code works unchanged. A game that reads gamepads and no keys gets a virtual gamepad instead (`navigator.getGamepads()`, standard mapping). They show by themselves on phones and tablets only when the game has keys to press and no touch controls of its own (touch events, a `pointerType === 'touch'` check, `GCP.display.touch`, `@gcp/input.js`, or `touch` listed under `requirements.input`). The player can hide or show them from the game menu, and they hide while the game is paused. To choose them yourself, add `"controls"` to `gcp.json`:

  ```json
  "controls": { "touch": "overlay", "stick": "wasd", "buttons": [{ "key": "Space", "label": "Jump" }, { "key": "KeyE", "label": "Use" }] }
  ```

  `"touch"`: `"auto"` (the default above), `"overlay"` (always offer them on touch screens) or `"none"` (the game has its own). At run time, `GCP.controls.set({ stick, buttons })` swaps the layout (a vehicle, a menu), `GCP.controls.hide()` and `show()` take them down and bring them back, and `GCP.setDisplay({ touchControls: 'none' })` turns them off.
- **A mouse from the finger.** A game that follows the mouse (`mousedown`, `mousemove`) and no finger or pointer as it moves gets mouse events from touch: a drag moves the mouse with the button held, a two-finger tap is a right click (`contextmenu`), a pinch turns the wheel. A game that asks for pointer lock gets a stand-in on touch screens (`document.pointerLockElement` is set), and a drag over the game then turns the view through `movementX`/`movementY`, while a tap clicks.
- **Taps that feel native.** On phones and tablets a long press does not select text or open the callout, a tap does not flash grey, a double tap does not zoom, and the page around the game does not zoom into a small text field. A tap that lands within 20 px of a button of your page counts as a tap on that button. All of it is set with no specificity, so your own CSS wins.
- **Pixel density.** On phones and tablets `devicePixelRatio` reads at most 2 (1.5 on devices with 2 GB of memory or less), so a canvas sized to it does not draw nine pixels per point on a 3x screen. A game that keeps drawing below about 26 frames a second is stepped down to 1.5 and then 1.25, with a `resize` event each time: read `devicePixelRatio` again in your resize handler. `GCP.device` says what the player holds (`touch`, `phone`, `tablet`, `ios`, `android`, `pixelRatio`, `screenPixelRatio`), and `GCP.setDisplay({ pixelRatio: 'native' })`, called before you read it, gives the screen's own value back.

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
- Never require a key on touch: every menu item, pause, restart and "press any key" needs a tap target. The platform's buttons are a safety net, not a design: controls made for the game are always better. Replace keyboard hints ("Space to dash") with touch ones ("tap ⚡ to dash").
- Text at 14 px or more, and nothing important in the bottom 20 px of a phone in landscape.
- Phones are slower. The platform already caps `devicePixelRatio` (above); start with fewer effects too, and raise them if the frame rate holds.
- Pause when `visibilitychange` says the page is hidden: phones switch apps far more often than desktops do.

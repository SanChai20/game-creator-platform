# Input on every device

About half of the people who open a game are on a phone. A game that only answers to a keyboard loses them, and verification sends keyboard, mouse and touch events to make sure none of them breaks the loop. How the game controls is your design; these are the mechanics underneath.

## One object for all of it

```js
import { createInput } from '@gcp/input.js';

const input = createInput(canvas, { pointerLock: true });   // pointerLock only for mouse-look games
if (input.touch) input.addButton('⤒', 'Space');             // an on-screen button that acts like a key

function update(dt) {
  const { x, y } = input.move;                // WASD, arrows or the touch stick, length at most 1, y is forward
  const { dx, dy } = input.takeLook();        // mouse movement or a right-thumb drag, already scaled
  if (input.pressed('Space')) jump();         // true for exactly one frame
  if (input.down('ShiftLeft')) sprint();      // true while held
  input.endFrame();                           // once, at the end of the frame
}
canvas.addEventListener('click', () => input.requestLock());
```

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

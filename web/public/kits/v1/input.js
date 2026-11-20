// @gcp/input.js — one object for keyboard, mouse and touch.
// Conventions: read keys by physical code (KeyW, Space), clear state on blur so keys never stick,
// touch-action none on the play surface, and a virtual stick that appears where the thumb lands. The stick and the
// touch buttons are drawn in the page's interface canvas (@gcp/ui.js), so they are part of the frame the platform captures.
import { sharedUi, panelUp } from './ui.js';

/**
 * Keyboard, mouse and touch behind one object. target: the element that receives pointer input (usually the canvas).
 *   input.move                 { x, y } in [-1, 1] from WASD, the arrow keys or the on-screen stick (appears under the left thumb on touch)
 *   input.down('ShiftLeft')    true while a key is held (physical codes: KeyW, Space, ArrowUp, …)
 *   input.pressed('Space')     true only on the frame it went down
 *   input.takeLook()           { dx, dy } of dragging (or of the locked mouse) since the last call, for cameras
 *   input.pointer              { x, y, down, clicked }
 *   input.addButton(label, code, { right, bottom, size })   an on-screen button for touch that acts as that key
 *   input.bind({ interact: ['KeyE'], attack: ['Space', 'Mouse0'] }, { touch: { interact: 'E' }, pad: { interact: 0 } })
 *                              names actions once; then input.action('interact') (pressed this frame),
 *                              input.held('attack'), input.keyOf('interact') (the label for a prompt: 'E', 'A' on a gamepad)
 *   input.wheel                wheel steps this frame (-1, 0, 1), e.g. to scroll a hotbar
 *   a gamepad works by itself: left stick moves, right stick looks, buttons are 'Pad0'…'Pad15'
 *   input.endFrame()           call once at the end of every frame
 *   input.setPointerLock(on)   turn mouse capture on or off later (control() in third-person mode turns it on)
 * Options: pointerLock (capture the mouse for mouse-look, as web games do: a click on the game hides and captures the
 * mouse, Esc frees it, the next click captures it again; it is freed by itself while a menu, the backpack or a title
 * screen is up, and the click that dismisses one captures it again), sensitivity.
 */
export function createInput(target = document.body, { pointerLock = false, sensitivity = 0.0022 } = {}) {
  // A panel over the game (a title or end screen, a menu, the backpack) wants the cursor, so capture waits until it is gone.
  let lockFailed = false, panelAtPress = false;
  const keys = new Set(), fresh = new Set(), stick = { id: -1, x: 0, y: 0, ox: 0, oy: 0 }, ac = new AbortController(), on = { signal: ac.signal };
  const inp = {
    keys, touch: matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window, locked: false, sensitivity,
    pointer: { x: 0, y: 0, down: false, clicked: false }, look: { dx: 0, dy: 0 }, stick, wheel: 0, pad: false, actions: {},
    /** True while the key is held. */
    down: (code) => keys.has(code),
    /** True only on the frame the key went down (call endFrame() once per frame). */
    pressed: (code) => fresh.has(code),
    /** Movement axis in [-1, 1]: WASD, arrow keys or the touch stick. y is forward (+1). */
    get move() {
      let x = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
      let y = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
      if (stick.id !== -1) { x = stick.x; y = -stick.y; }
      if (padAxes[0] || padAxes[1]) { x = padAxes[0]; y = -padAxes[1]; }
      const l = Math.hypot(x, y); return l > 1 ? { x: x / l, y: y / l } : { x, y };
    },
    /** Look deltas accumulated since the last call, already scaled by sensitivity. */
    takeLook() { const d = { dx: inp.look.dx, dy: inp.look.dy }; inp.look.dx = inp.look.dy = 0; return d; },
    // Chrome refuses capture for about a second after Esc freed the mouse, so a quick click back into the game is tried
    // once more when that second is over (the click still counts as the player's gesture for a few seconds).
    requestLock(again = true) {
      if (!pointerLock || inp.touch || inp.locked || !target.requestPointerLock) return;
      const failed = () => { lockFailed = true; if (again && (!navigator.userActivation || navigator.userActivation.isActive)) setTimeout(() => { if (!panelUp()) inp.requestLock(false); }, 1300); };
      try { const p = target.requestPointerLock(); if (p && p.catch) p.catch(failed); } catch { failed(); }
    },
    setPointerLock(on) { pointerLock = !!on; if (!pointerLock && inp.locked && document.exitPointerLock) document.exitPointerLock(); return inp; },
    get pointerLock() { return pointerLock; },
    endFrame() { if (inp.locked && panelUp()) document.exitPointerLock();   // a menu or the backpack needs the cursor
      fresh.clear(); inp.pointer.clicked = false; inp.wheel = 0; pollPad(); },
    /**
     * Names the things the player can do, so game code asks input.action('interact') instead of testing keys, and
     * touch and gamepad players get the same actions. bind({ interact: ['KeyE'], attack: ['Space', 'Mouse0'],
     * inventory: ['KeyI', 'Tab'] }, { touch: { interact: 'E', attack: '⚔' }, pad: { interact: 0, attack: 2 } }).
     * Codes: any KeyboardEvent.code, 'Mouse0' | 'Mouse1' | 'Mouse2', 'Pad0'…'Pad15'. touch adds an on-screen button
     * per listed action on touch devices (bottom: how far up the first one sits, e.g. 96 to clear a hotbar); pad maps
     * standard gamepad buttons (0 = A, 1 = B, 2 = X, 3 = Y).
     * A gamepad's left stick always moves and its right stick looks.
     */
    bind(map, { touch = {}, pad = {}, bottom = 24 } = {}) {
      let slot = 0;
      for (const name in map) { const a = inp.actions[name] = { codes: [...map[name]] }; if (pad[name] != null) a.codes.push('Pad' + pad[name]);
        if (touch[name] && inp.touch && !a.button) { a.codes.push('Touch:' + name); a.button = addButton(touch[name], 'Touch:' + name, { right: 24 + (slot % 2) * 84, bottom: bottom + Math.floor(slot / 2) * 84 + (slot % 2) * 30 }); slot++; } }
      return inp;
    },
    /** True on the frame the action was pressed (a key, mouse button, touch button or gamepad button bound to it). */
    action: (name) => { const a = inp.actions[name]; return !!a && a.codes.some((c) => fresh.has(c)); },
    /** True while the action is held. */
    held: (name) => { const a = inp.actions[name]; return !!a && a.codes.some((c) => keys.has(c)); },
    /** A short label for the action's main key, for prompts: 'E', 'Space', 'Click', or the gamepad button when a pad is in use. */
    keyOf(name) { const a = inp.actions[name]; if (!a) return ''; if (inp.pad) { const p = a.codes.find((c) => c.startsWith('Pad')); if (p) return ['A', 'B', 'X', 'Y'][+p.slice(3)] || p; } if (inp.touch && a.button) return a.button.label; const c = a.codes[0] || ''; return c.startsWith('Key') ? c.slice(3) : c.startsWith('Digit') ? c.slice(5) : c === 'Mouse0' ? 'Click' : c === 'Mouse2' ? 'Right click' : c.replace('Left', '').replace('Arrow', ''); },
    /** Simulates a press of an action for one frame (play-throughs use it). */
    trigger(name) { const a = inp.actions[name]; if (a && a.codes[0]) { fresh.add(a.codes[0]); } return inp; },
    dispose() { ac.abort(); if (offLayer) offLayer(); buttons.length = 0; },
    addButton,
  };

  addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (!keys.has(e.code)) fresh.add(e.code);
    keys.add(e.code);
    if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab') e.preventDefault();
  }, on);
  addEventListener('keyup', (e) => keys.delete(e.code), on);
  target.addEventListener('wheel', (e) => { inp.wheel += Math.sign(e.deltaY); }, { signal: ac.signal, passive: true });
  target.addEventListener('mousedown', (e) => {
    if (pointerLock && !inp.locked && !inp.touch && !lockFailed && e.button === 0) return;   // the click that captures the mouse is not also a strike
    const c = 'Mouse' + e.button; if (!keys.has(c)) fresh.add(c); keys.add(c);
  }, on);
  addEventListener('mouseup', (e) => keys.delete('Mouse' + e.button), on);
  // gamepad: read once a frame; the left stick moves, the right stick looks, buttons become 'Pad<n>' codes
  const padAxes = [0, 0], dead = (v) => (Math.abs(v) < 0.22 ? 0 : v);
  function pollPad() {
    const g = navigator.getGamepads ? [...navigator.getGamepads()].find((p) => p && p.connected) : null; if (!g) { padAxes[0] = padAxes[1] = 0; return; }
    padAxes[0] = dead(g.axes[0] || 0); padAxes[1] = dead(g.axes[1] || 0); inp.look.dx += dead(g.axes[2] || 0) * 0.045; inp.look.dy += dead(g.axes[3] || 0) * 0.035;
    g.buttons.forEach((b, i) => { const c = 'Pad' + i; if (b.pressed) { if (!keys.has(c)) { fresh.add(c); inp.pad = true; } keys.add(c); } else keys.delete(c); });
    if (padAxes[0] || padAxes[1]) inp.pad = true;
  }
  addEventListener('keydown', () => { inp.pad = false; }, on);
  addEventListener('blur', () => { keys.clear(); inp.pointer.down = false; stick.id = -1; stick.x = stick.y = 0; }, on);
  document.addEventListener('pointerlockchange', () => { inp.locked = document.pointerLockElement === target; if (inp.locked) lockFailed = false; }, on);
  // A click that closed a panel (Play on a title screen, Resume in a pause menu, a click beside the backpack) goes back
  // to the game, so it captures the mouse again. Listening after the game's own handlers sees the panel already gone.
  addEventListener('pointerdown', (e) => { panelAtPress = panelUp(); }, { signal: ac.signal, capture: true });
  addEventListener('click', (e) => { if (pointerLock && panelAtPress && !panelUp() && e.pointerType !== 'touch') inp.requestLock(); }, on);
  target.addEventListener('contextmenu', (e) => e.preventDefault(), on);
  target.style.touchAction = 'none';

  // Virtual stick: left half of the screen moves, right half looks. It and the touch buttons are drawn in the shared
  // interface canvas, only on touch devices and only while they are in use.
  const looks = new Map(); let offLayer = null;
  function drawTouch(u) {
    if (stick.id !== -1) {
      u.panel(stick.ox - 55, stick.oy - 55, 110, 110, { fill: 'rgba(255,255,255,.08)', stroke: 'rgba(255,255,255,.35)', line: 2, radius: 55 });
      u.panel(stick.ox + stick.x * 40 - 23, stick.oy + stick.y * 40 - 23, 46, 46, { fill: 'rgba(255,255,255,.5)', radius: 23 });
    }
    if (!inp.touch || panelUp()) return;
    const sf = u.safe;
    for (const b of buttons) {
      if (b.hidden) continue;
      const x = u.w - b.right - sf.right - b.size, y = u.h - b.bottom - sf.bottom - b.size; b.box = { x, y, s: b.size };
      u.panel(x, y, b.size, b.size, { fill: b.held.size ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.1)', stroke: 'rgba(255,255,255,.35)', line: 2, radius: b.size / 2 });
      u.text(b.label, x + b.size / 2, y + b.size / 2, { size: 13, weight: 700, color: '#fff', align: 'center', base: 'middle', width: b.size - 8, lines: 2 });
    }
  }
  const touchUi = () => { if (!offLayer) offLayer = sharedUi().layer(drawTouch, { z: 50 }); };
  // a press on a touch button is the button's (before the game, or the stick, sees it)
  const btnAt = (x, y) => { if (!inp.touch || panelUp()) return null; for (const b of buttons) if (!b.hidden && b.box && Math.hypot(x - b.box.x - b.box.s / 2, y - b.box.y - b.box.s / 2) <= b.box.s / 2) return b; return null; };
  addEventListener('pointerdown', (e) => {
    const b = btnAt(e.clientX, e.clientY); if (!b) return;
    e.stopImmediatePropagation(); if (e.cancelable) e.preventDefault();
    b.held.add(e.pointerId); if (!keys.has(b.code)) fresh.add(b.code); keys.add(b.code);
  }, { signal: ac.signal, capture: true, passive: false });
  const release = (e) => { for (const b of buttons) if (b.held.delete(e.pointerId)) { e.stopImmediatePropagation(); if (!b.held.size) keys.delete(b.code); } };
  addEventListener('pointerup', release, { signal: ac.signal, capture: true }); addEventListener('pointercancel', release, { signal: ac.signal, capture: true });
  addEventListener('touchstart', (e) => { const t = e.touches && e.touches[e.touches.length - 1]; if (t && btnAt(t.clientX, t.clientY) && e.cancelable) e.preventDefault(); }, { signal: ac.signal, capture: true, passive: false });

  target.addEventListener('pointerdown', (e) => {
    inp.pointer.x = e.clientX; inp.pointer.y = e.clientY; inp.pointer.down = true; inp.pointer.clicked = true;
    if (e.pointerType === 'touch') {
      inp.touch = true;
      if (e.clientX < innerWidth / 2 && stick.id === -1) { stick.id = e.pointerId; stick.ox = e.clientX; stick.oy = e.clientY; stick.x = stick.y = 0; touchUi(); }
      else looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { target.setPointerCapture(e.pointerId); } catch { /* gone */ }
    } else if (pointerLock && !inp.locked && !panelUp()) inp.requestLock();
  }, on);
  target.addEventListener('pointermove', (e) => {
    inp.pointer.x = e.clientX; inp.pointer.y = e.clientY;
    if (e.pointerId === stick.id) {
      const dx = e.clientX - stick.ox, dy = e.clientY - stick.oy, l = Math.hypot(dx, dy), m = Math.min(1, l / 50), a = Math.atan2(dy, dx);
      stick.x = Math.cos(a) * m; stick.y = Math.sin(a) * m;
    } else if (looks.has(e.pointerId)) {
      const p = looks.get(e.pointerId); inp.look.dx += (e.clientX - p.x) * inp.sensitivity * 2.2; inp.look.dy += (e.clientY - p.y) * inp.sensitivity * 2.2; p.x = e.clientX; p.y = e.clientY;
    } else if (inp.locked || (e.pointerType === 'mouse' && e.buttons)) { inp.look.dx += e.movementX * inp.sensitivity; inp.look.dy += e.movementY * inp.sensitivity; }   // dragging still looks where capture is refused
  }, on);
  const up = (e) => {
    inp.pointer.down = false; looks.delete(e.pointerId);
    if (e.pointerId === stick.id) { stick.id = -1; stick.x = stick.y = 0; }
  };
  target.addEventListener('pointerup', up, on); target.addEventListener('pointercancel', up, on);

  /**
   * An on-screen button for touch players that behaves like a key, drawn in the interface canvas (touch devices only;
   * it steps aside while a menu, the backpack or a title screen is up). Returns { label, code, right, bottom, size,
   * hidden, remove() }: change label or hidden to restyle it.
   */
  const buttons = [];
  function addButton(label, code, { right = 24, bottom = 24, size = 68 } = {}) {
    const b = { label: String(label), code, right, bottom, size, hidden: false, held: new Set(), box: null,
      get textContent() { return b.label; }, set textContent(v) { b.label = String(v); },
      remove() { const i = buttons.indexOf(b); if (i >= 0) buttons.splice(i, 1); keys.delete(code); } };
    buttons.push(b); if (inp.touch) touchUi();
    return b;
  }
  return inp;
}

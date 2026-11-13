// @gcp/input.js — one object for keyboard, mouse and touch.
// Conventions: read keys by physical code (KeyW, Space), clear state on blur so keys never stick,
// touch-action none on the play surface, and a virtual stick that appears where the thumb lands.

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
 * Options: pointerLock (capture the mouse for first-person looking), sensitivity.
 */
export function createInput(target = document.body, { pointerLock = false, sensitivity = 0.0022 } = {}) {
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
    requestLock() { if (pointerLock && !inp.touch && target.requestPointerLock) { try { const p = target.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* not allowed yet */ } } },
    endFrame() { fresh.clear(); inp.pointer.clicked = false; inp.wheel = 0; pollPad(); if (buttons.length && ++tick % 3 === 0) { const hide = !!document.querySelector('.gh-s,.gp-win'); if (hide !== hidden) { hidden = hide; for (const b of buttons) b.style.display = hide ? 'none' : ''; } } },
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
    keyOf(name) { const a = inp.actions[name]; if (!a) return ''; if (inp.pad) { const p = a.codes.find((c) => c.startsWith('Pad')); if (p) return ['A', 'B', 'X', 'Y'][+p.slice(3)] || p; } if (inp.touch && a.button) return a.button.textContent; const c = a.codes[0] || ''; return c.startsWith('Key') ? c.slice(3) : c.startsWith('Digit') ? c.slice(5) : c === 'Mouse0' ? 'Click' : c === 'Mouse2' ? 'Right click' : c.replace('Left', '').replace('Arrow', ''); },
    /** Simulates a press of an action for one frame (play-throughs use it). */
    trigger(name) { const a = inp.actions[name]; if (a && a.codes[0]) { fresh.add(a.codes[0]); } return inp; },
    dispose() { ac.abort(); stickEl.remove(); buttons.forEach((b) => b.remove()); },
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
  target.addEventListener('mousedown', (e) => { const c = 'Mouse' + e.button; if (!keys.has(c)) fresh.add(c); keys.add(c); }, on);
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
  document.addEventListener('pointerlockchange', () => { inp.locked = document.pointerLockElement === target; }, on);
  target.addEventListener('contextmenu', (e) => e.preventDefault(), on);
  target.style.touchAction = 'none';

  // Virtual stick: left half of the screen moves, right half looks.
  const stickEl = document.createElement('div');
  stickEl.style.cssText = 'position:fixed;width:110px;height:110px;margin:-55px 0 0 -55px;border-radius:50%;border:2px solid rgba(255,255,255,.35);background:rgba(255,255,255,.08);display:none;pointer-events:none;z-index:50';
  stickEl.innerHTML = '<i style="position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px;border-radius:50%;background:rgba(255,255,255,.5)"></i>';
  document.body.appendChild(stickEl);
  const knob = stickEl.firstChild, looks = new Map();

  target.addEventListener('pointerdown', (e) => {
    inp.pointer.x = e.clientX; inp.pointer.y = e.clientY; inp.pointer.down = true; inp.pointer.clicked = true;
    if (e.pointerType === 'touch') {
      inp.touch = true;
      if (e.clientX < innerWidth / 2 && stick.id === -1) { stick.id = e.pointerId; stick.ox = e.clientX; stick.oy = e.clientY; stick.x = stick.y = 0; stickEl.style.display = 'block'; stickEl.style.left = e.clientX + 'px'; stickEl.style.top = e.clientY + 'px'; knob.style.transform = ''; }
      else looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { target.setPointerCapture(e.pointerId); } catch { /* gone */ }
    } else if (pointerLock && !inp.locked) inp.requestLock();
  }, on);
  target.addEventListener('pointermove', (e) => {
    inp.pointer.x = e.clientX; inp.pointer.y = e.clientY;
    if (e.pointerId === stick.id) {
      const dx = e.clientX - stick.ox, dy = e.clientY - stick.oy, l = Math.hypot(dx, dy), m = Math.min(1, l / 50), a = Math.atan2(dy, dx);
      stick.x = Math.cos(a) * m; stick.y = Math.sin(a) * m; knob.style.transform = `translate(${stick.x * 40}px,${stick.y * 40}px)`;
    } else if (looks.has(e.pointerId)) {
      const p = looks.get(e.pointerId); inp.look.dx += (e.clientX - p.x) * inp.sensitivity * 2.2; inp.look.dy += (e.clientY - p.y) * inp.sensitivity * 2.2; p.x = e.clientX; p.y = e.clientY;
    } else if (inp.locked || (e.pointerType === 'mouse' && !pointerLock && e.buttons)) { inp.look.dx += e.movementX * inp.sensitivity; inp.look.dy += e.movementY * inp.sensitivity; }
  }, on);
  const up = (e) => {
    inp.pointer.down = false; looks.delete(e.pointerId);
    if (e.pointerId === stick.id) { stick.id = -1; stick.x = stick.y = 0; stickEl.style.display = 'none'; }
  };
  target.addEventListener('pointerup', up, on); target.addEventListener('pointercancel', up, on);

  /** An on-screen button for touch players that behaves like a key. Returns the element so you can restyle it. */
  const buttons = []; let tick = 0, hidden = false;   // on-screen buttons step aside while a menu, the backpack or a title screen is up
  function addButton(label, code, { right = 24, bottom = 24, size = 68 } = {}) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `position:fixed;right:calc(${right}px + env(safe-area-inset-right,0px));bottom:calc(${bottom}px + env(safe-area-inset-bottom,0px));width:${size}px;height:${size}px;border-radius:50%;border:2px solid rgba(255,255,255,.35);background:rgba(255,255,255,.1);color:#fff;font:700 13px system-ui;z-index:50;touch-action:none;-webkit-user-select:none;user-select:none;display:${inp.touch ? 'block' : 'none'}`;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); if (!keys.has(code)) fresh.add(code); keys.add(code); }, on);
    const off = () => keys.delete(code);
    b.addEventListener('pointerup', off, on); b.addEventListener('pointercancel', off, on); b.addEventListener('pointerleave', off, on);
    document.body.appendChild(b); buttons.push(b);
    return b;
  }
  return inp;
}

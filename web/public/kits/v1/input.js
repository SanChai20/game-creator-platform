// @gcp/input.js — one object for keyboard, mouse and touch.
// Conventions: read keys by physical code (KeyW, Space), clear state on blur so keys never stick,
// touch-action none on the play surface, and a virtual stick that appears where the thumb lands.

export function createInput(target = document.body, { pointerLock = false, sensitivity = 0.0022 } = {}) {
  const keys = new Set(), fresh = new Set(), stick = { id: -1, x: 0, y: 0, ox: 0, oy: 0 }, ac = new AbortController(), on = { signal: ac.signal };
  const inp = {
    keys, touch: matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window, locked: false, sensitivity,
    pointer: { x: 0, y: 0, down: false, clicked: false }, look: { dx: 0, dy: 0 }, stick,
    /** True while the key is held. */
    down: (code) => keys.has(code),
    /** True only on the frame the key went down (call endFrame() once per frame). */
    pressed: (code) => fresh.has(code),
    /** Movement axis in [-1, 1]: WASD, arrow keys or the touch stick. y is forward (+1). */
    get move() {
      let x = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
      let y = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
      if (stick.id !== -1) { x = stick.x; y = -stick.y; }
      const l = Math.hypot(x, y); return l > 1 ? { x: x / l, y: y / l } : { x, y };
    },
    /** Look deltas accumulated since the last call, already scaled by sensitivity. */
    takeLook() { const d = { dx: inp.look.dx, dy: inp.look.dy }; inp.look.dx = inp.look.dy = 0; return d; },
    requestLock() { if (pointerLock && !inp.touch && target.requestPointerLock) { try { const p = target.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* not allowed yet */ } } },
    endFrame() { fresh.clear(); inp.pointer.clicked = false; },
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
  const buttons = [];
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

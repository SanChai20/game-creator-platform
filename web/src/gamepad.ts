// Controllers on the platform's own pages: a gamepad moves the focus like arrow keys do on a TV (spatial navigation to the
// nearest control in that direction), A presses the focused control, B goes back (an Escape a menu or dialog closes on,
// else the page's own back). It runs only while a controller is connected and the page itself has the focus: inside a
// running game the controller belongs to the game, and the game's SDK opens the platform menu on Home or Start + Select.
// Pages listen to the 'gcp-pad' window event ({ detail: { button } }) and call preventDefault() to handle a button themselves.

export type PadButton = 'up' | 'down' | 'left' | 'right' | 'ok' | 'back' | 'menu' | 'prev' | 'next';
type Dir = 'up' | 'down' | 'left' | 'right';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const REPEAT_AFTER = 380, REPEAT_EVERY = 110;

function visible(el: HTMLElement): boolean {
  if (el.closest('[inert], [aria-hidden="true"]')) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
}
/** Where focus may go: inside an open dialog when there is one, else the whole page. */
function scope(): ParentNode {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role=dialog][aria-modal=true], dialog[open], .modal [role=dialog]')].filter(visible);
  return dialogs[dialogs.length - 1] || document;
}
export function candidates(root: ParentNode = scope()): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
}

/** The nearest candidate from rect `from` in direction `dir` (the same rules as TV remotes): ahead of it, closest first,
 * and a control in line counts as nearer than one off to the side. Exported for tests. */
export function nearest(from: { x: number; y: number; w: number; h: number }, dir: Dir, list: { x: number; y: number; w: number; h: number }[]): number {
  const cx = from.x + from.w / 2, cy = from.y + from.h / 2;
  let best = -1, bestScore = Infinity;
  list.forEach((r, i) => {
    const x = r.x + r.w / 2, y = r.y + r.h / 2;
    let main: number, side: number;
    if (dir === 'left' || dir === 'right') {
      main = dir === 'right' ? r.x - (from.x + from.w) : from.x - (r.x + r.w);
      if ((dir === 'right' ? x - cx : cx - x) <= 1) return;
      // left and right stay on the same line (a row of tiles, a toolbar): only controls that overlap it vertically
      if (Math.min(r.y + r.h, from.y + from.h) - Math.max(r.y, from.y) <= 0) return;
      side = 0;
    } else {
      main = dir === 'down' ? r.y - (from.y + from.h) : from.y - (r.y + r.h);
      if ((dir === 'down' ? y - cy : cy - y) <= 1) return;
      side = Math.min(r.x + r.w, from.x + from.w) - Math.max(r.x, from.x) > 0 ? 0 : Math.abs(x - cx);
    }
    const tie = dir === 'left' || dir === 'right' ? Math.abs(y - cy) : Math.abs(x - cx);
    const score = Math.max(0, main) + side * 2.5 + (side > 0 ? 400 : 0) + tie * 0.05;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}
const rectOf = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };

function focusEl(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}
/** Moves the focus one step in a direction; returns whether it moved. */
export function moveFocus(dir: Dir): boolean {
  const list = candidates(), cur = document.activeElement as HTMLElement | null;
  if (!list.length) return false;
  if (!cur || cur === document.body || !list.includes(cur)) {
    focusEl(list.find((e) => e.matches('[data-pad-start]')) || list[0]);
    return true;
  }
  const i = nearest(rectOf(cur), dir, list.map(rectOf));
  if (i < 0) return false;
  focusEl(list[i]);
  return true;
}

function fire(button: PadButton): void {
  const ev = new CustomEvent('gcp-pad', { detail: { button }, cancelable: true });
  window.dispatchEvent(ev);
  if (ev.defaultPrevented) return;
  const cur = document.activeElement as HTMLElement | null;
  if (button === 'up' || button === 'down' || button === 'left' || button === 'right') {
    // a slider or a select takes left and right itself
    if (cur && (button === 'left' || button === 'right') && cur.matches('input[type=range]')) { cur.dispatchEvent(new KeyboardEvent('keydown', { key: button === 'left' ? 'ArrowLeft' : 'ArrowRight', bubbles: true })); return; }
    moveFocus(button);
  } else if (button === 'ok') {
    if (cur && cur !== document.body) { if (cur.matches('input:not([type=checkbox]):not([type=radio]), textarea')) cur.focus(); else cur.click(); }
    else moveFocus('down');
  } else if (button === 'back') {
    (cur || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  }
}

let running = false, raf = 0;
const held = new Map<PadButton, { since: number; last: number }>();
/** A standard-mapped controller's state as platform buttons (the first connected one with input wins). */
function read(): Set<PadButton> {
  const out = new Set<PadButton>();
  let pads: (Gamepad | null)[] = [];
  try { pads = [...(navigator.getGamepads?.() || [])]; } catch { return out; }
  for (const p of pads) {
    if (!p || !p.connected || /HearthCade/.test(p.id)) continue;
    const b = (i: number) => !!p.buttons[i]?.pressed, ax = (i: number) => p.axes[i] || 0;
    if (b(12) || ax(1) < -0.6) out.add('up');
    if (b(13) || ax(1) > 0.6) out.add('down');
    if (b(14) || ax(0) < -0.6) out.add('left');
    if (b(15) || ax(0) > 0.6) out.add('right');
    if (b(0)) out.add('ok');
    if (b(1)) out.add('back');
    if (b(9) || b(16)) out.add('menu');
    if (b(4)) out.add('prev');
    if (b(5)) out.add('next');
    if (out.size) break;
  }
  return out;
}
function loop() {
  raf = 0;
  if (!running) return;
  const now = performance.now();
  // the page has the focus (not a game frame, not another window)
  const ours = !document.hidden && document.hasFocus() && !(document.activeElement instanceof HTMLIFrameElement);
  const down = ours ? read() : new Set<PadButton>();
  for (const k of [...held.keys()]) if (!down.has(k)) held.delete(k);
  for (const k of down) {
    const h = held.get(k);
    if (!h) { held.set(k, { since: now, last: now }); markPad(true); fire(k); continue; }
    const moves = k === 'up' || k === 'down' || k === 'left' || k === 'right';
    if (moves && now - h.since > REPEAT_AFTER && now - h.last > REPEAT_EVERY) { h.last = now; fire(k); }
  }
  raf = requestAnimationFrame(loop);
}
/** While the controller is in use, the focus ring shows (html.pad-nav); the mouse or a touch hides it again. */
function markPad(on: boolean) { document.documentElement.classList.toggle('pad-nav', on); }

let listeners: ((connected: boolean) => void)[] = [];
/** Calls fn(true) when a controller connects (and at once when one is already connected), fn(false) when the last one goes. */
export function onPad(fn: (connected: boolean) => void): () => void {
  listeners.push(fn);
  if (padConnected()) fn(true);
  return () => { listeners = listeners.filter((f) => f !== fn); };
}
export function padConnected(): boolean {
  try { return [...(navigator.getGamepads?.() || [])].some((p) => !!p && p.connected && !/HearthCade/.test(p.id)); } catch { return false; }
}

/** Starts listening for controllers (once, from main.tsx). */
export function startPadNav(): void {
  if (typeof window === 'undefined' || !('getGamepads' in navigator)) return;
  const sync = () => {
    const on = padConnected();
    for (const fn of listeners) fn(on);
    if (on && !running) { running = true; raf = requestAnimationFrame(loop); }
    if (!on && running) { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; held.clear(); markPad(false); }
  };
  window.addEventListener('gamepadconnected', sync);
  window.addEventListener('gamepaddisconnected', sync);
  for (const ev of ['pointerdown', 'mousemove'] as const) window.addEventListener(ev, () => markPad(false), { passive: true });
  sync();
}

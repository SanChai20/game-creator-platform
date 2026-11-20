// Where the platform's menu button sits while a game fills the screen, so that it never covers the game's own buttons.
//
//   1. In a margin when there is one. With the notch, rounded corners and home indicator kept clear, a phone on its side has a
//      black bar at each end of the game (iPhone: 47 to 62 px). The button sits there, outside the game, covering nothing.
//   2. Otherwise over the game, in the spot the game's own page says is free. The SDK in the game looks under each candidate
//      spot (elementFromPoint) and scores it: 0 nothing there, 1 a canvas (we cannot tell what is drawn), 2 text or a picture,
//      3 something to tap (a button, a link, the on-screen controls). The player gets the free-est spot; a spot the game
//      says nothing about keeps its order: the corner the game asked for (GCP.setDisplay({ exitButton })), then top-left,
//      top-right, the bottom corners and the middles of the edges.
//   3. The player can drag the button to any edge. Their spot wins over all of the above and is kept per game and per
//      orientation on this device.
// Pure functions only: player.tsx measures, asks the game and draws; tests/menu-spot.mjs checks the rules.

export type Side = 'left' | 'right' | 'top' | 'bottom';
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
/** A place on an edge of the screen: the side, and how far along it (0 the top or left end, 1 the bottom or right end). */
export interface Spot { side: Side; t: number }
/** The stage (the whole screen while the game fills it) and where the game's frame sits inside it. */
export interface Area { w: number; h: number; top: number; right: number; bottom: number; left: number }
/** A spot placed on the stage: the button's top-left corner and size in CSS px, and whether it is in a margin (off the game). */
export interface Placed extends Spot { x: number; y: number; size: number; margin: boolean }

/** The button's size: over the game, and in a margin (made to fit a 44 px bar, the narrowest on notched iPhones). */
export const SIZE = 40, MARGIN_SIZE = 36;
/** How far the button keeps from the edges of the game, and from the rounded corners of the screen in a margin. */
const GAP = 8, CORNER = 22;
/** The narrowest margin the button goes into. */
export const MIN_MARGIN = MARGIN_SIZE + 6;
/** Below this score a spot is free enough; see the scores at the top. */
export const SCORE = { empty: 0, canvas: 1, content: 2, control: 3 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const sideMargin = (a: Area, s: Side) => (s === 'left' ? a.left : s === 'right' ? a.right : 0);   // only the side bars: the top one is the status bar

export function place(spot: Spot, a: Area): Placed {
  const side = spot.side, t = clamp(Number.isFinite(spot.t) ? spot.t : 0, 0, 1), m = sideMargin(a, side);
  if (m >= MIN_MARGIN) {
    // In the bar at the side: clear of the rounded corners, and clear of the notch (the middle of the bar on a phone on its side).
    const size = MARGIN_SIZE, x = side === 'left' ? Math.round((m - size) / 2) : a.w - m + Math.round((m - size) / 2);
    const lo = Math.max(CORNER, a.top), hi = Math.max(lo, a.h - Math.max(CORNER, a.bottom) - size);
    let y = lo + t * (hi - lo);
    const mid = a.h / 2, notch = Math.min(80, a.h / 5);
    if (Math.abs(y + size / 2 - mid) < notch + size / 2) y = y + size / 2 < mid ? mid - notch - size : mid + notch;
    return { side, t, x, y: Math.round(clamp(y, lo, hi)), size, margin: true };
  }
  const size = SIZE, fx = a.left, fy = a.top, fw = Math.max(size + 2 * GAP, a.w - a.left - a.right), fh = Math.max(size + 2 * GAP, a.h - a.top - a.bottom);
  const along = (lo: number, len: number) => Math.round(lo + GAP + t * (len - size - 2 * GAP));
  if (side === 'left' || side === 'right') return { side, t, x: side === 'left' ? fx + GAP : fx + fw - size - GAP, y: along(fy, fh), size, margin: false };
  return { side, t, x: along(fx, fw), y: side === 'top' ? fy + GAP : fy + fh - size - GAP, size, margin: false };
}

/** The opposite of place: the spot on the nearest edge for a button dropped with its top-left corner at (x, y). */
export function spotAt(x: number, y: number, a: Area): Spot {
  const cx = x + SIZE / 2, cy = y + SIZE / 2;
  // Left and right first: a phone on its side has its margins there, and the middles of the top and bottom edges are where
  // games keep their titles and hands of cards. Top or bottom only when the drop is clearly nearer to them.
  const d: [Side, number][] = [['left', cx], ['right', a.w - cx], ['top', cy * 1.4], ['bottom', (a.h - cy) * 1.4]];
  d.sort((p, q) => p[1] - q[1]);
  const side = d[0][0];
  // t such that place() puts the button back where it was dropped (as near as the edge allows).
  const probe0 = place({ side, t: 0 }, a), probe1 = place({ side, t: 1 }, a);
  const vertical = side === 'left' || side === 'right';
  const lo = vertical ? probe0.y : probe0.x, hi = vertical ? probe1.y : probe1.x, at = vertical ? y : x;
  return { side, t: hi > lo ? clamp((at - lo) / (hi - lo), 0, 1) : 0 };
}

const cornerSpot = (c: Corner): Spot => ({ side: c.endsWith('left') ? 'left' : 'right', t: c.startsWith('top') ? 0 : 1 });
const sameSpot = (p: Spot, q: Spot) => p.side === q.side && Math.abs(p.t - q.t) < 0.02;

/** The spots worth trying, best first: margins (on the side the game asked for first), then over the game. */
export function candidates(a: Area, declared?: Corner | null): Placed[] {
  const want = declared ? cornerSpot(declared) : null, out: Placed[] = [];
  const add = (s: Spot) => { if (!out.some((p) => sameSpot(p, s))) out.push(place(s, a)); };
  const margins = (['left', 'right'] as Side[]).filter((s) => sideMargin(a, s) >= MIN_MARGIN);
  if (want && margins.includes(want.side)) add(want);
  for (const s of margins) add({ side: s, t: want?.side === s ? want.t : 0 });
  const over: Spot[] = [{ side: 'left', t: 0 }, { side: 'right', t: 0 }, { side: 'left', t: 1 }, { side: 'right', t: 1 }, { side: 'left', t: 0.5 }, { side: 'right', t: 0.5 }, { side: 'top', t: 0.5 }, { side: 'bottom', t: 0.5 }];
  if (want) over.unshift(want);
  // A spot in a margin already covers that side's corners; over the game they are still worth trying on the other side.
  for (const s of over) { const p = place(s, a); if (!p.margin && !out.some((q) => q.x === p.x && q.y === p.y)) out.push(p); }
  return out;
}

/** The rectangle the game is asked about for a spot over it, in the game frame's own coordinates (a little larger than the button). */
export function probeRect(p: Placed, a: Area): [number, number, number, number] {
  const pad = 6;
  return [p.x - a.left - pad, p.y - a.top - pad, p.size + 2 * pad, p.size + 2 * pad];
}

/**
 * The spot to use. scores[i] is the game's answer for candidates[i] (undefined: it did not say; margins need no answer).
 * The current spot is kept while it is as free as the best, so the button does not hop about between equally good places.
 * While the game plays (settled), it is kept unless it covers something to tap: text and pictures come and go in a game
 * (damage numbers, markers at the edge of the screen), and a button that chased them would be harder to find than to see past.
 */
export function choose(cands: Placed[], scores: (number | undefined)[], current?: Spot | null, settled = false): Placed | null {
  if (!cands.length) return null;
  const score = (i: number) => (cands[i].margin ? -1 : scores[i] ?? SCORE.canvas);
  let best = 0;
  for (let i = 1; i < cands.length; i++) if (score(i) < score(best)) best = i;
  if (current) {
    const i = cands.findIndex((p) => sameSpot(p, current));
    if (i >= 0 && (score(i) <= score(best) || (settled && score(i) < SCORE.control))) return cands[i];
  }
  return cands[best];
}

/** A spot the player dropped the button on, as kept in storage. */
export function parseSpot(raw: string | null): Spot | null {
  try {
    const o = raw ? JSON.parse(raw) : null;
    if (!o || !['left', 'right', 'top', 'bottom'].includes(o.side) || typeof o.t !== 'number' || !Number.isFinite(o.t)) return null;
    return { side: o.side, t: clamp(o.t, 0, 1) };
  } catch { return null; }
}

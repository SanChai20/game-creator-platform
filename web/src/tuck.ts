// iPhone Safari has no fullscreen for a web page: its address and tab bars only slide away when the page under the finger
// scrolls. In the player the page is pinned so that swipes belong to the game, which also means the bars can never leave.
// So while they show, the player asks for one swipe up over the game: the page is allowed to scroll for that swipe, Safari
// tucks its bars away, and the page is pinned again. This file is the part that decides; player.tsx does the rest.

/** The viewport may differ from the largest it can be by this much before the bars count as showing (CSS px). */
export const TUCK_SLACK = 8;

export interface ViewportSizes {
  /** window.innerHeight: what the page has right now. */
  inner: number;
  /** 100lvh in px, the height with the browser's bars away; null where the browser has no lvh unit (before iOS 15.4). */
  large: number | null;
  /** The screen's shorter side in CSS px (screen.width and height do not turn with an iPhone). */
  screenShort: number;
  landscape: boolean;
}

/** Whether the browser's bars are taking room that a scroll would give back. */
export function barsShowing(v: ViewportSizes): boolean {
  if (!(v.inner > 0)) return false;
  if (v.large != null && v.large > 0) return v.large - v.inner > TUCK_SLACK;
  // No lvh: on its side an iPhone gives the page the whole short side once the bars are away. Upright there is no telling.
  return v.landscape && v.screenShort > 0 && v.screenShort - v.inner > TUCK_SLACK;
}

/** How the ask is going: what the page looked like at the last look. */
export interface TuckState {
  /** The bars were showing at the last look. */
  bars: boolean;
  /** Where the page was scrolled to when the bars last came up (the swipe is measured from here). */
  from: number;
  /** When the page was first seen scrolled well past `from` with the bars still up (0: not yet). */
  swipedAt: number;
  /** When the bars last went away (0: never). */
  tuckedAt: number;
  /** The bars came straight back after the page was pinned: this browser needs the page left scrollable. */
  keepLoose: boolean;
  /** A real swipe did not move the bars: this browser does not tuck them (an in-app browser, say). Stop asking. */
  gaveUp: boolean;
}
export const tuckStart = (scrollY: number): TuckState => ({ bars: false, from: scrollY, swipedAt: 0, tuckedAt: 0, keepLoose: false, gaveUp: false });

/** A swipe counts once the page has moved this far (CSS px), and has this long (ms) to take the bars with it. */
export const TUCK_SWIPE = 48, TUCK_WAIT = 1500, TUCK_BOUNCE = 1200;

/** One look at the page: the new state. `now` in ms. */
export function tuckLook(s: TuckState, showing: boolean, scrollY: number, now: number): TuckState {
  const n = { ...s, bars: showing };
  if (!showing) {
    if (s.bars) n.tuckedAt = now;
    n.swipedAt = 0; n.from = scrollY;
    return n;
  }
  if (!s.bars) {
    // back within a moment of going away: pinning the page brought them back, so it stays loose from now on
    if (s.tuckedAt && now - s.tuckedAt < TUCK_BOUNCE) n.keepLoose = true;
    n.from = scrollY; n.swipedAt = 0;
    return n;
  }
  if (Math.abs(scrollY - s.from) >= TUCK_SWIPE) {
    if (!s.swipedAt) n.swipedAt = now;
    else if (now - s.swipedAt >= TUCK_WAIT) n.gaveUp = true;
  }
  return n;
}

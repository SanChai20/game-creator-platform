// The play window. A game in its window on a page is laid out in a frame of one size, decided by the browser window alone
// and never by the page around it, so the store page and the console's preview show the same layout: the same view size,
// the same interface scale (GCP.ui), the same breakpoints. A page with less room shows that frame scaled down to its width
// (a CSS transform; the browser maps clicks and touches through it), never a smaller frame. The size is the preview
// dialog's: 16:9, at most PLAY_MAX_W wide, short enough to leave room for a title row above and the bar below on screen,
// a whole multiple of 16 pixels (so the height is a whole number too), at least 320. Fullscreen is not affected: there
// the frame is the screen.
export const PLAY_MAX_W = 1056, PLAY_MIN_W = 320;
export function playWindow(vw: number, vh: number): { w: number; h: number } {
  const byHeight = (vh - 230) * 16 / 9, byWidth = vw - 32;
  const w = Math.max(PLAY_MIN_W, Math.floor(Math.min(PLAY_MAX_W, byHeight, byWidth) / 16) * 16);
  return { w, h: (w * 9) / 16 };
}

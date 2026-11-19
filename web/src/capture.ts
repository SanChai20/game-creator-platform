// Exact feedback screenshots: the tab's real pixels, from the browser's own tab capture (getDisplayMedia), cropped to
// the game by this page. No React here, so the browser tests can load it on its own (tests/capture-browser.mjs).
//
// Why the whole tab, cropped by hand, and not Region Capture (track.cropTo(CropTarget of the game's frame)): minting a
// CropTarget makes Chrome draw that element through a surface of its own for as long as the element lives. With a
// cross-site game frame on some GPUs and display scales (seen on Ubuntu Chrome), that surface came out at the wrong scale:
// the game drew into the top-left part of the picture with black around it, and kept drawing torn and smeared after the
// share. Whole-tab capture is the path every video call uses; the crop is plain arithmetic, done here at every capture.
//
// Nothing is assumed about how the browser sizes its frames. Every capture:
//   - waits for a frame whose shape matches the tab as it is now (a frame from before a resize, a fullscreen change or
//     the browser's "sharing this tab" bar is skipped);
//   - maps the page into the frame by fitting the viewport into it (any device pixel ratio, browser zoom, frame size cap
//     or letterboxing), following pinch zoom;
//   - checks the frame for the failure above (the tab drawn into its top-left part, pure black around it) and crops from
//     the part actually drawn when it finds it;
//   - reports what it measured, kept with the feedback item, so a picture that still looks wrong can be explained.

export interface CaptureDiag {
  /** devicePixelRatio, the viewport in CSS pixels and the frame the browser sent, in its pixels */
  dpr: number; view: [number, number]; frame: [number, number];
  /** the game's box in the frame's pixels, and the frame pixels per CSS pixel */
  crop: [number, number, number, number]; k: number;
  /** the browser drew the tab into only part of its frame (see above) and the picture was taken from that part */
  trimmed?: boolean;
  /** pinch zoom when not 1 */
  zoom?: number;
  /** how long the capture waited for a fitting frame, and whether it had to settle for one that does not fit */
  waited_ms: number; mismatch?: boolean;
}

// ---- the arithmetic, kept pure for the unit tests (tests/capture.mjs) ----------------------------------------------------

export interface View { width: number; height: number; vvLeft?: number; vvTop?: number; vvScale?: number }
export interface Mapping { k: number; ox: number; oy: number; fits: boolean }

/** How a viewport of `view` CSS pixels sits in a frame of fw × fh: scaled to fit, centred (letterboxed if shapes differ). */
export function fitView(fw: number, fh: number, view: View): Mapping {
  const k = Math.min(fw / view.width, fh / view.height);
  const ox = (fw - view.width * k) / 2, oy = (fh - view.height * k) / 2;
  // a frame of the viewport's own shape: no bars wider than a pixel and a half of rounding
  return { k, ox, oy, fits: ox <= 1.5 && oy <= 1.5 };
}

/**
 * A CSS rectangle of the page (getBoundingClientRect) in frame pixels, clipped to the frame. Pinch zoom shows only the
 * visual viewport, magnified, in the frame.
 */
export function rectInFrame(r: { left: number; top: number; width: number; height: number }, fw: number, fh: number, m: Mapping, view: View) {
  const s = view.vvScale && view.vvScale > 0 ? view.vvScale : 1, vx = view.vvLeft || 0, vy = view.vvTop || 0;
  let x = m.ox + (r.left - vx) * s * m.k, y = m.oy + (r.top - vy) * s * m.k, w = r.width * s * m.k, h = r.height * s * m.k;
  const x2 = Math.min(fw, x + w), y2 = Math.min(fh, y + h); x = Math.max(0, x); y = Math.max(0, y);
  w = x2 - x; h = y2 - y;
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

/**
 * Whether the browser drew the tab into only the top-left part of its frame, pure black around it, with the drawn part
 * of the frame's own shape. `lum(x, y)` reads a small copy (sw × sh) of the frame: the brightest channel, 0 to 255.
 * Returns the drawn part as fractions of the frame, or null. A page that is dark on its right and bottom does not count:
 * only exact black (what the browser fills with) does, and only when the black covers a whole band on both sides and the
 * rest has the frame's shape.
 */
export function drawnPart(lum: (x: number, y: number) => number, sw: number, sh: number): { w: number; h: number } | null {
  const BLACK = 6;
  let right = 0, bottom = 0;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (lum(x, y) > BLACK) { if (x + 1 > right) right = x + 1; if (y + 1 > bottom) bottom = y + 1; }
  if (!right || !bottom) return null;                          // an all-black frame: nothing to go by
  const fw = right / sw, fh = bottom / sh;
  if (fw > 0.93 && fh > 0.93) return null;                     // filled (the usual case)
  if (fw < 0.25 || fh < 0.25) return null;                     // too little to be a whole tab
  if (Math.abs(fw / fh - 1) > 0.06) return null;               // not the frame's shape: a dark page, not a shrunken one
  // the drawn part must reach its own edges: content all along the left and the top
  let left = 0, top = 0; const n = 12;
  for (let i = 0; i < n; i++) {
    const yy = Math.floor(((i + 0.5) / n) * bottom), xx = Math.floor(((i + 0.5) / n) * right);
    for (let x = 0; x < Math.max(2, sw * 0.05); x++) if (lum(x, yy) > BLACK) { left++; break; }
    for (let y = 0; y < Math.max(2, sh * 0.05); y++) if (lum(xx, y) > BLACK) { top++; break; }
  }
  if (left < n * 0.5 || top < n * 0.5) return null;
  return { w: fw, h: fh };
}

// ---- the share --------------------------------------------------------------------------------------------------------

type Live = { stream: MediaStream; track: MediaStreamTrack; video: HTMLVideoElement };
let live: Live | null = null, declined = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());
const W = () => window as unknown as Record<string, unknown>;

/**
 * Whether this browser can share the tab it runs in. Only Chromium browsers can (Chrome, Edge, Opera, Brave…, on the
 * desktop): Firefox and Safari share windows and screens, which cannot be cropped to the game reliably, so they are not
 * asked at all. Phones and tablets cannot share a tab either.
 */
export const canCaptureTab = () => typeof navigator !== 'undefined' && typeof window !== 'undefined'
  && !!(navigator.mediaDevices as { getDisplayMedia?: unknown } | undefined)?.getDisplayMedia
  && ('CropTarget' in W() || 'CaptureController' in W() && 'RestrictionTarget' in W())
  && !matchMedia('(pointer: coarse)').matches;
export const tabShareOn = () => !!live && live.track.readyState === 'live';
export const tabShareDeclined = () => declined;
export function onTabShare(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; }
export function stopTabShare() { if (!live) return; live.stream.getTracks().forEach((tr) => tr.stop()); live.video.srcObject = null; live = null; changed(); }

/** Starts sharing this tab (the browser asks). Needs a click. Resolves false when declined, unavailable or not a tab. */
export async function startTabShare(): Promise<boolean> {
  if (tabShareOn()) return true;
  const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (o: unknown) => Promise<MediaStream> };
  if (!md?.getDisplayMedia) return false;
  let stream: MediaStream;
  try {
    // A few frames a second is plenty for a still picture, and keeps the share's cost off the game while it runs.
    stream = await md.getDisplayMedia({ video: { displaySurface: 'browser', frameRate: { ideal: 10, max: 15 } }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude' } as unknown);
  } catch { declined = true; changed(); return false; }
  const track = stream.getVideoTracks()[0];
  // only this tab will do: a window or a screen cannot be cropped to the game
  if (!track || (track.getSettings() as { displaySurface?: string }).displaySurface !== 'browser') { stream.getTracks().forEach((tr) => tr.stop()); declined = true; changed(); return false; }
  const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.srcObject = stream;
  await video.play().catch(() => {});
  live = { stream, track, video }; declined = false;
  track.addEventListener('ended', () => { if (live?.track === track) { live = null; changed(); } });
  changed();
  return true;
}

const viewNow = (): View => {
  const vv = window.visualViewport;
  return { width: Math.max(1, innerWidth), height: Math.max(1, innerHeight), vvLeft: vv?.offsetLeft ?? 0, vvTop: vv?.offsetTop ?? 0, vvScale: vv?.scale ?? 1 };
};
type RVFC = HTMLVideoElement & { requestVideoFrameCallback?: (f: () => void) => number; cancelVideoFrameCallback?: (n: number) => void };
/** The next frame the video shows, or `ms` milliseconds, whichever comes first (a page that is not changing sends none). */
const nextFrame = (v: RVFC, ms: number) => new Promise<void>((ok) => {
  let id = 0; const t = setTimeout(() => { if (id) v.cancelVideoFrameCallback?.(id); ok(); }, ms);
  if (v.requestVideoFrameCallback) id = v.requestVideoFrameCallback(() => { clearTimeout(t); ok(); });
});

const MAX_SIDE = 1600;

/** The next frame of the shared tab, cropped to `el`, as a data URL, with what was measured. */
export async function grabTab(el: Element | null): Promise<{ image: string; diag: CaptureDiag }> {
  const l = live; if (!l || l.track.readyState !== 'live') throw new Error('not sharing');
  if (!el) throw new Error('no game');
  const v = l.video as RVFC, t0 = performance.now();
  // a frame drawn after the press, then more until one has the shape of the tab as it is now (at most about a second)
  await nextFrame(v, 250);
  let m: Mapping | null = null, view = viewNow();
  for (let tries = 0; tries < 8; tries++) {
    view = viewNow();
    if (v.videoWidth && v.videoHeight) { m = fitView(v.videoWidth, v.videoHeight, view); if (m.fits) break; }
    await nextFrame(v, 150);
  }
  const fw = v.videoWidth, fh = v.videoHeight;
  if (!fw || !fh || !m) throw new Error('no frame');
  // the whole frame, once, so the crop and the check read the same pixels
  const full = document.createElement('canvas'); full.width = fw; full.height = fh;
  const fg = full.getContext('2d', { willReadFrequently: false })!; fg.drawImage(v, 0, 0, fw, fh);
  const rect = el.getBoundingClientRect();
  // the check for a tab drawn into part of its frame, on a small copy
  let trimmed = false;
  try {
    const sw = 96, sh = Math.max(8, Math.round((96 * fh) / fw)), small = document.createElement('canvas'); small.width = sw; small.height = sh;
    const sg = small.getContext('2d', { willReadFrequently: true })!; sg.imageSmoothingEnabled = false; sg.drawImage(full, 0, 0, sw, sh);
    const px = sg.getImageData(0, 0, sw, sh).data, lum = (x: number, y: number) => { const i = (y * sw + x) * 4; return Math.max(px[i], px[i + 1], px[i + 2]); };
    const part = drawnPart(lum, sw, sh);
    if (part && m.fits) { m = fitView(fw * part.w, fh * part.h, view); trimmed = true; }
  } catch { /* a frame that cannot be read back: use it as it is */ }
  const c = rectInFrame(rect, fw, fh, m, view);
  if (c.w < 8 || c.h < 8) throw new Error('game not on screen');
  const k = Math.min(1, MAX_SIDE / Math.max(c.w, c.h)), out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(c.w * k)); out.height = Math.max(1, Math.round(c.h * k));
  const og = out.getContext('2d')!; og.imageSmoothingQuality = 'high'; og.drawImage(full, c.x, c.y, c.w, c.h, 0, 0, out.width, out.height);
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const diag: CaptureDiag = { dpr: Math.round((devicePixelRatio || 1) * 100) / 100, view: [Math.round(view.width), Math.round(view.height)], frame: [fw, fh],
    crop: [Math.round(c.x), Math.round(c.y), Math.round(c.w), Math.round(c.h)], k: Math.round(m.k * 1000) / 1000, waited_ms: Math.round(performance.now() - t0),
    ...(trimmed ? { trimmed } : {}), ...(view.vvScale && Math.abs(view.vvScale - 1) > 0.01 ? { zoom: r1(view.vvScale) } : {}), ...(m.fits ? {} : { mismatch: true }) };
  return { image: out.toDataURL('image/jpeg', 0.92), diag };
}

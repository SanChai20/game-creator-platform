// Console preview viewport presets and scaling math (pages/Project.tsx, player.tsx).
// Lets creators compare a running preview at the current browser play window, a Phone size, or a Tablet size
// (in portrait or landscape) while keeping the iframe's logical pixel dimensions faithful to the target device.
import { playWindow } from './play-window.ts';

export type PreviewDevice = 'current' | 'phone' | 'tablet';
export type PreviewOrientation = 'portrait' | 'landscape';
export type GameOrientation = 'any' | 'landscape' | 'portrait';

export const PREVIEW_PRESETS: Record<Exclude<PreviewDevice, 'current'>, Record<PreviewOrientation, { w: number; h: number }>> = {
  phone: {
    portrait: { w: 390, h: 844 },
    landscape: { w: 844, h: 390 },
  },
  tablet: {
    portrait: { w: 768, h: 1024 },
    landscape: { w: 1024, h: 768 },
  },
};

export interface PreviewFrame {
  device: PreviewDevice;
  orientation: PreviewOrientation;
  /** Logical CSS pixel width given to the game iframe. */
  w: number;
  /** Logical CSS pixel height given to the game iframe. */
  h: number;
  /** Rendered outer stage width after scaling down to fit the modal. */
  displayW: number;
  /** Rendered outer stage height after scaling down to fit the modal. */
  displayH: number;
  /** CSS transform scale applied to the iframe (<= 1). */
  scale: number;
  /** Whether the simulated viewport reports touch input to the game SDK. */
  touch: boolean;
}

/** Sensible initial orientation for a device preview based on the game's declared orientation. */
export function defaultPreviewOrientation(device: PreviewDevice, gameOrient: GameOrientation = 'any'): PreviewOrientation {
  if (device === 'current') return 'landscape';
  if (gameOrient === 'landscape') return 'landscape';
  if (gameOrient === 'portrait') return 'portrait';
  return device === 'phone' ? 'portrait' : 'landscape';
}

/** Resolve logical and displayed dimensions for the preview stage so it fits inside the dialog without clipping. */
export function resolvePreviewFrame(opts: {
  device: PreviewDevice;
  orientation: PreviewOrientation;
  containerW: number;
  viewportW: number;
  viewportH: number;
}): PreviewFrame {
  const { device, orientation, containerW, viewportW, viewportH } = opts;
  if (device === 'current') {
    const { w, h } = playWindow(viewportW, viewportH);
    const scale = containerW > 0 ? Math.min(1, containerW / w) : 1;
    return {
      device,
      orientation: 'landscape',
      w,
      h,
      displayW: Math.round(w * scale),
      displayH: Math.round(h * scale),
      scale,
      touch: false,
    };
  }
  const { w, h } = PREVIEW_PRESETS[device][orientation];
  // Account for .pv-mat (up to 24px*2 + 2px border) + .pv-bezel (up to 16px*2 + 2px border) = 84px desktop, 40px mobile.
  const chromeX = containerW > 640 ? 84 : 44;
  const maxW = containerW > 0 ? Math.max(160, containerW - chromeX) : w;
  const maxH = Math.max(320, viewportH - 310);
  const scale = Math.min(1, maxW / w, maxH / h);
  return {
    device,
    orientation,
    w,
    h,
    displayW: Math.round(w * scale),
    displayH: Math.round(h * scale),
    scale,
    touch: true,
  };
}

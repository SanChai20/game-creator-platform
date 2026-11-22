// HearthCade as a Home Screen web app on iPhone and iPad. Safari has no fullscreen that games can live with: on iPhone a
// web page has none at all (its bars only slide away when the page scrolls, see tuck.ts), and on iPad element fullscreen
// shows Safari's own "swipe down to exit" hint every time and closes on any swipe from the top. A page opened from the
// Home Screen has neither: no bars, no hint, the whole screen. So on iPhone and iPad the player never asks Safari for
// fullscreen (it fills the viewport instead, player.tsx), and players in Safari are told once how to add the app.
// This file is the part that decides; index.html, app.css, player.tsx and install-tip.tsx do the rest.

/** What the decisions look at, so tests can pass it in. */
export interface DeviceInfo {
  userAgent: string;
  /** navigator.maxTouchPoints: an iPad reports itself as a Mac, and only its touch screen tells them apart. */
  maxTouchPoints: number;
  /** Opened from the Home Screen: display-mode standalone or fullscreen, or navigator.standalone. */
  installed: boolean;
}

/** iPhone, iPad (which reports itself as a Mac with a touch screen) and iPod. */
export const isIOSDevice = (d: Pick<DeviceInfo, 'userAgent' | 'maxTouchPoints'>) =>
  /iP(hone|ad|od)/.test(d.userAgent) || (/Macintosh/.test(d.userAgent) && d.maxTouchPoints > 1);

/** An iPad: the old iPad user agent, or the desktop one with a touch screen (iPadOS 13 and later). */
export const isIPad = (d: Pick<DeviceInfo, 'userAgent' | 'maxTouchPoints'>) =>
  /iPad/.test(d.userAgent) || (/Macintosh/.test(d.userAgent) && d.maxTouchPoints > 1);

// Every browser on iOS is WebKit and says Safari; these are the ones that are not Safari itself. In-app browsers
// (Facebook, Instagram, WeChat, LINE, Google's app) cannot add to the Home Screen at all, and the others put it elsewhere.
const NOT_SAFARI = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|GSA\/|FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Twitter|Snapchat|TikTok|musical_ly|Pinterest|LinkedInApp/;

/** Safari itself on an iPhone or iPad, where Share, Add to Home Screen is offered. */
export const isIOSSafari = (d: Pick<DeviceInfo, 'userAgent' | 'maxTouchPoints'>) =>
  isIOSDevice(d) && /Safari\//.test(d.userAgent) && /Version\//.test(d.userAgent) && !NOT_SAFARI.test(d.userAgent);

/**
 * Whether the player asks the browser for element fullscreen (the Fullscreen API). Never on iPhone and iPad: iPhone has
 * none for a page, iPad's shows Safari's swipe-down hint and drops out on a swipe, and an installed app already has the
 * whole screen. There the stage fills the viewport instead ("immersive").
 */
export const elementFullscreen = (d: Pick<DeviceInfo, 'userAgent' | 'maxTouchPoints'>, available: boolean) =>
  available && !isIOSDevice(d);

/** The Add to Home Screen tip: once, for Safari on iPhone and iPad, never inside the installed app. */
export const INSTALL_TIP_KEY = 'gcp.install.tip';
export function showInstallTip(d: DeviceInfo, dismissed: boolean): boolean {
  return !dismissed && !d.installed && isIOSSafari(d);
}

/** This device, as the browser reports it. */
export function thisDevice(): DeviceInfo {
  const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    installed: mq('(display-mode: fullscreen)') || mq('(display-mode: standalone)') || (navigator as Navigator & { standalone?: boolean }).standalone === true,
  };
}

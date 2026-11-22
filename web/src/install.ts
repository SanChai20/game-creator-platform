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

/** Android phones and tablets. */
export const isAndroid = (d: Pick<DeviceInfo, 'userAgent'>) => /Android/.test(d.userAgent);

// In-app browsers (WeChat, Facebook, Instagram, LINE, TikTok and the like, plus Android web views) cannot add a page to the
// Home Screen at all: the player first has to open the page in their real browser.
const IN_APP = /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|WeChat|QQ\/|Weibo|DingTalk|AlipayClient|Twitter|Snapchat|TikTok|musical_ly|BytedanceWebview|Pinterest|LinkedInApp|GSA\/|; wv\)/;

/**
 * How this device adds HearthCade to its Home Screen, or null when it does not apply (a computer, or already installed):
 * - ios-safari: Share (in the ··· menu on newer iOS), then Add to Home Screen.
 * - ios-browser: Chrome, Edge or Firefox on iOS 16.4 and later, through their own Share button.
 * - android: Chrome, Edge, Samsung Internet and others offer an install prompt (beforeinstallprompt); Firefox has it in
 *   its menu. A Chromium browser that never offers the prompt is either installed already or cannot install, so the
 *   popup waits for the prompt there (androidPromptNeeded).
 * - in-app: an app's built-in browser, which has to hand the page to the real browser first.
 */
export type InstallKind = 'ios-safari' | 'ios-browser' | 'android' | 'in-app';
export function installKind(d: DeviceInfo): InstallKind | null {
  if (d.installed) return null;
  const ios = isIOSDevice(d), android = isAndroid(d);
  if (!ios && !android) return null;
  if (IN_APP.test(d.userAgent)) return 'in-app';
  if (ios) return isIOSSafari(d) ? 'ios-safari' : /CriOS|FxiOS|EdgiOS/.test(d.userAgent) ? 'ios-browser' : null;
  return 'android';
}
/** On Android, whether the browser's own install prompt is needed before the popup shows (every browser but Firefox). */
export const androidPromptNeeded = (d: Pick<DeviceInfo, 'userAgent'>) => !/Firefox\//.test(d.userAgent);

/**
 * When the install popup opens by itself. Each "Not now" puts it away for a week; after the third it stays away for good,
 * and installing (or Got it on a device that installs through its menu) puts it away for a month. The footer's Install
 * app link opens it at any time.
 */
export const INSTALL_PROMPT_KEY = 'gcp.install.prompt';
export interface PromptState { /** times put away */ n: number; /** not before this time (ms) */ until: number; /** installed from the prompt */ done?: boolean }
export const SNOOZE_MS = 7 * 86400e3, GOT_IT_MS = 30 * 86400e3, MAX_DISMISSALS = 3;
export function promptDue(st: PromptState, now: number): boolean {
  return !st.done && st.n < MAX_DISMISSALS && now >= st.until;
}
export function putAway(st: PromptState, now: number, how: 'later' | 'got-it' | 'installed'): PromptState {
  if (how === 'installed') return { ...st, done: true };
  return { n: st.n + 1, until: now + (how === 'got-it' ? GOT_IT_MS : SNOOZE_MS) };
}
export function readPromptState(raw: string | null): PromptState {
  try { const v = JSON.parse(raw || 'null'); if (v && typeof v.n === 'number' && typeof v.until === 'number') return { n: v.n, until: v.until, done: !!v.done }; } catch { /* old or broken value */ }
  return { n: 0, until: 0 };
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

/**
 * Android's install prompt (Chrome, Edge, Samsung Internet), kept from the moment the browser offers it so the popup can
 * show it when the player taps Install. The browser's own mini bar is held back: the popup asks instead.
 */
export interface InstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
let deferred: InstallPromptEvent | null = null, installedNow = false;
const subs = new Set<() => void>();
const ping = () => subs.forEach((f) => f());
if (typeof window !== 'undefined') {
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallPromptEvent; ping(); });
  addEventListener('appinstalled', () => { deferred = null; installedNow = true; ping(); });
}
export const installPrompt = () => deferred;
export const justInstalled = () => installedNow;
export const onInstallChange = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
/** Shows Android's install prompt. True when the player accepted. */
export async function runInstallPrompt(): Promise<boolean> {
  const e = deferred; if (!e) return false;
  deferred = null; ping();   // a prompt can be shown once
  await e.prompt();
  return (await e.userChoice).outcome === 'accepted';
}

/** While a game runs on the page the popup never opens over it. */
let holds = 0;
export const holdInstallPrompt = () => { holds++; ping(); return () => { holds = Math.max(0, holds - 1); ping(); }; };
export const installPromptHeld = () => holds > 0;

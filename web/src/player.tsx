// The play surface on a game's page. Start plays the game in a window on the page (on a phone or tablet it goes
// straight to fullscreen). The Fullscreen button, Alt+Enter (pressed in the game too) or the game itself (GCP.fullscreen)
// put it in fullscreen, where the platform keeps the player in the game:
//   - Desktop Chrome and Edge: the Escape key is locked to the game (Keyboard Lock API), so a tap of Esc goes to the game
//     and opens the platform menu (Resume, Exit fullscreen, Quit game) when the game does not use it. Holding Esc leaves,
//     which the browser enforces. Firefox and Safari always leave fullscreen on Esc.
//   - Android and iPad Safari: real fullscreen on the stage element, orientation locked to the game's. Swipes inside the
//     game cannot pinch, zoom or scroll the page (the SDK guards the game's document too).
//   - iPhone Safari has no element fullscreen, and a home-screen install is already full screen: there the stage fills
//     the visible viewport ("immersive"), page scroll and pinch zoom off; the back gesture leaves it.
// Leaving fullscreen, however it happens, puts the game back in its window on the page; it keeps running.
// The game is told what is going on through the SDK (GCP.display, GCP.onDisplay), can toggle fullscreen (GCP.fullscreen),
// open the platform menu (GCP.menu) or quit (GCP.quit), and can keep Esc for itself (GCP.onEscape). Switching the
// platform language on the page does not restart the game: it is told the new language (GCP.lang, GCP.onLang). A watchdog pings it
// every second and offers Wait or Quit game when it stops answering.
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode, type Ref } from 'react';
import { artStyle, getLang, t, useApp, useLang } from './lib';
import { Button } from './ui';
import { sanitizeControls, type TouchControls } from './touch-controls';
import './player.css';

// What a game may do inside the player. Never allow-top-navigation: a game must not be able to replace the platform's page
// (with a lookalike sign-in, say). Games run on their own site (GAME_HOST), so allow-same-origin only gives a game its own
// storage and cookies, never the platform's. Links a game opens go to a new tab, where the address bar shows where they lead.
const GAME_SANDBOX = 'allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-modals allow-downloads allow-orientation-lock allow-popups allow-popups-to-escape-sandbox allow-storage-access-by-user-activation';

export type Orientation = 'any' | 'landscape' | 'portrait';
type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'none';
export interface StageCtl {
  /** Fill the screen: real fullscreen where the browser allows it, otherwise the immersive viewport. */
  enter(): void;
  exit(): void;
  toggle(): void;
  /** Close the game and give the page back (what the menu's Quit does). */
  quit(): void;
  /** enter(), but only on a phone or tablet. Call it from the click that starts the game. */
  enterOnPhone(): void;
  /** A picture of the game as it is now, taken by the SDK inside the game page (preview only, for the game's owner). */
  /** picture false: only the game's state, no picture (the console takes it from the tab). */
  capture(picture?: boolean): Promise<GameCapture>;
  /** Whether the stage fills the screen right now. */
  isActive(): boolean;
}
/** What the SDK answers a capture with: the picture (a JPEG data URL, '' on error) and what it knew about the game. */
export interface GameCapture {
  image: string; error: string; canvases: number; method?: 'game' | 'page'; state: string | null; frames: number; fps: number; ready: boolean; label: string;
  errors: string[]; warnings: string[]; viewport: { width: number; height: number };
  /** The version registers GCP.test.onCapture: the picture is the frame the game handed over (the capture contract). */
  contract?: boolean;
  /** The picture is the game's frame alone, nothing redrawn. redrawn: what was drawn from the page instead (text fields, or 'page'). */
  exact?: boolean; redrawn?: string[]; hookError?: string;
}

const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;
/** A phone or tablet: the main pointer is a finger and nothing hovers. */
export const isHandheld = () => mq('(pointer: coarse)') && mq('(hover: none)');
/** Opened from the home screen (an installed web app): the page already has the whole screen and no browser bar. */
const isInstalled = () => mq('(display-mode: fullscreen)') || mq('(display-mode: standalone)') || (navigator as Navigator & { standalone?: boolean }).standalone === true;
/** iPhone, iPad (which reports itself as a Mac with a touch screen) and iPod. */
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);


type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };
const doc = () => document as FsDoc;
const fsElement = () => doc().fullscreenElement ?? doc().webkitFullscreenElement ?? null;
const fsAvailable = (el: FsEl) => !!(el.requestFullscreen || el.webkitRequestFullscreen) && !!(doc().fullscreenEnabled ?? doc().webkitFullscreenEnabled);
function requestFs(el: FsEl): Promise<void> {
  if (el.requestFullscreen) return el.requestFullscreen({ navigationUI: 'hide' });
  el.webkitRequestFullscreen?.();   // returns nothing: wait a moment and look
  return new Promise((ok, no) => setTimeout(() => (fsElement() === el ? ok() : no(new Error('refused'))), 350));
}
// The Escape rule. In fullscreen, Esc never leaves by itself: the Keyboard Lock API makes the browser deliver it to the page
// instead (holding Esc still leaves, which the browser enforces). A game that registered GCP.onEscape gets it first and
// closes its own menu; an Esc the game did not use opens the platform menu. Browsers without the API leave fullscreen on
// Esc, and the game carries on in its window.
type KbNav = Navigator & { keyboard?: { lock?: (keys: string[]) => Promise<void>; unlock?: () => void } };
function escLock(on: boolean) {
  const kb = (navigator as KbNav).keyboard; if (!kb) return;
  try { if (on) void kb.lock?.(['Escape'])?.catch(() => {}); else kb.unlock?.(); } catch { /* not allowed here */ }
}
function exitFs() { if (!fsElement()) return; if (document.exitFullscreen) void document.exitFullscreen().catch(() => {}); else doc().webkitExitFullscreen?.(); }
type Orient = ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void };
const lockOrientation = (o: Orientation) => { if (o === 'any') return; try { void (screen.orientation as Orient | undefined)?.lock?.(o)?.catch(() => {}); } catch { /* not supported */ } };
const unlockOrientation = () => { try { (screen.orientation as Orient | undefined)?.unlock?.(); } catch { /* not supported */ } };

// While immersive, the page under the game must not scroll or zoom: the viewport is pinned at scale 1. While a game runs
// on a phone or tablet at all, the page is kept from zooming too (maximum-scale): a double tap on the game, or a tap in one
// of its text fields (iOS zooms into fields with small text), would otherwise zoom the whole page around it.
const LOCKED_VIEWPORT = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
const vp = { orig: null as string | null, immersive: 0, pinned: 0 };
function applyViewport() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]'); if (!meta) return;
  if (vp.orig == null) vp.orig = meta.content;
  const base = vp.orig;
  meta.content = vp.immersive ? LOCKED_VIEWPORT : vp.pinned ? base.replace(/,?\s*maximum-scale=[^,]*/i, '') + ', maximum-scale=1' : base;
  if (!vp.immersive && !vp.pinned) vp.orig = null;
}
function lockPage(): () => void {
  const y = scrollY;
  vp.immersive++; applyViewport();
  document.documentElement.classList.add('gcp-play');
  return () => {
    document.documentElement.classList.remove('gcp-play');
    vp.immersive = Math.max(0, vp.immersive - 1); applyViewport();
    scrollTo(0, y);
  };
}
/** The player's own choice about the on-screen controls for one game (null: the platform's default for it). */
const controlsKey = (seed: string) => 'gcp.controls.' + seed;
function readControlsPref(seed: string): boolean | null { try { const v = localStorage.getItem(controlsKey(seed)); return v === '1' ? true : v === '0' ? false : null; } catch { return null; } }
function saveControlsPref(seed: string, on: boolean) { try { localStorage.setItem(controlsKey(seed), on ? '1' : '0'); } catch { /* private mode */ } }
/** The player's interface size for one game (GCP.ui.size): a factor on the game's automatic scale, 1 by default. */
const uiSizeKey = (seed: string) => 'gcp.ui.size.' + seed;
const UI_SIZES = [0.8, 0.9, 1, 1.15, 1.3, 1.5];
const okUiSize = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0.5 && n <= 2 ? Math.round(n * 100) / 100 : null; };
function readUiSize(seed: string): number | null { try { return okUiSize(localStorage.getItem(uiSizeKey(seed))); } catch { return null; } }
function saveUiSize(seed: string, v: number) { try { localStorage.setItem(uiSizeKey(seed), String(v)); } catch { /* private mode */ } }

type Insets = { top: number; right: number; bottom: number; left: number };
/** The note on how to open the menu: shown at the start of the first few plays on a device. */
const TIP_KEY = 'gcp.menu.tip', TIP_TIMES = 3;
/** Where the player dragged the menu button for one game, per orientation: the share of the free width and height (0 to 1). */
type BtnPos = { x: number; y: number };
const posKey = (seed: string, portrait: boolean) => 'gcp.menu.' + seed + (portrait ? '.p' : '.l');
function readPos(seed: string, portrait: boolean): BtnPos | null {
  try { const o = JSON.parse(localStorage.getItem(posKey(seed, portrait)) || 'null'); return o && Number.isFinite(o.x) && Number.isFinite(o.y) ? { x: Math.min(1, Math.max(0, o.x)), y: Math.min(1, Math.max(0, o.y)) } : null; } catch { return null; }
}
function savePos(seed: string, portrait: boolean, p: BtnPos) { try { localStorage.setItem(posKey(seed, portrait), JSON.stringify({ x: +p.x.toFixed(4), y: +p.y.toFixed(4) })); } catch { /* private mode */ } }
/** The menu button's size and the room kept around it at the screen's edges. */
const BTN = 40, BTN_EDGE = 4;
/** The watchdog: how long a game may go without answering before the player offers Wait or Quit game (ms). */
const HUNG_MS = 4000, HUNG_BOOT_MS = 20000, HUNG_WAIT_MS = 15000;
const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
/** The screen's safe-area insets (notch, rounded corners, home indicator) in CSS px. A frame cannot see them itself. */
function safeInsets(): Insets {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
  document.body.appendChild(el);
  const cs = getComputedStyle(el), px = (v: string) => Math.max(0, Math.round(parseFloat(v) || 0));
  const out = { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
  el.remove(); return out;
}
const sameInsets = (a: Insets, b: Insets) => a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;

/** Keeps the screen on while a game is running on a phone (players often watch without touching). */
// The platform's splash: HearthCade's logo over the game frame from the Start click until the game's own loading screen
// is up in its final look (the SDK says so with { gcp: 'shown' }: its fonts are in, it has drawn and its page has stopped
// changing; see splash-handoff in docs/game-runtime.md), then it fades into that screen. It stays up at least
// SPLASH_MIN_MS so the logo reads instead of flickering, and never past SPLASH_LOAD_CAP_MS after the game page has loaded
// (or SPLASH_URL_CAP_MS in all) in case the game's page never says anything.
const SPLASH_MIN_MS = 900, SPLASH_FADE_MS = 360, SPLASH_LOAD_CAP_MS = 8000, SPLASH_URL_CAP_MS = 20000;
type SplashPhase = 'off' | 'on' | 'out';
function useSplash(starting: boolean, url: string | null, frame: { current: HTMLIFrameElement | null }) {
  // The play URL whose page has said its loading screen is up.
  const [shown, setShown] = useState<string | null>(null);
  const covering = url ? shown !== url : starting;
  const [phase, setPhase] = useState<SplashPhase>(covering ? 'on' : 'off');
  const since = useRef(covering ? performance.now() : 0);
  useEffect(() => {
    if (covering) { if (!since.current) since.current = performance.now(); setPhase('on'); return; }
    if (!since.current) return;
    // The game is on screen underneath: let the logo be seen for a moment, then fade. A start that failed, or a game that
    // was closed, takes the splash away at once.
    const wait = url ? Math.max(0, since.current + SPLASH_MIN_MS - performance.now()) : 0;
    const t1 = setTimeout(() => setPhase(url ? 'out' : 'off'), wait);
    const t2 = setTimeout(() => { setPhase('off'); since.current = 0; }, wait + (url ? SPLASH_FADE_MS : 0));
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [covering, url]);
  // Never held by a page that does not answer (it failed to load, or runs without the SDK).
  useEffect(() => {
    if (!url) return;
    const el = frame.current; let t2 = 0;
    const onLoad = () => { clearTimeout(t2); t2 = window.setTimeout(() => setShown(url), SPLASH_LOAD_CAP_MS); };
    el?.addEventListener('load', onLoad);
    const t1 = setTimeout(() => setShown(url), SPLASH_URL_CAP_MS);
    return () => { clearTimeout(t1); clearTimeout(t2); el?.removeEventListener('load', onLoad); };
  }, [url, frame]);
  return { phase, onShown: setShown };
}
function Splash({ out }: { out: boolean }) {
  const app = useApp();
  const brand = String(app?.config?.settings?.brand_name || 'HearthCade');
  return (
    <div className={'stage-splash' + (out ? ' out' : '')} role="status" aria-label={t('Loading', '加载中')}>
      <div className="splash-mark"><i className="logo" aria-hidden="true" /><b>{brand}</b></div>
      <span className="splash-bar" aria-hidden="true"><i /></span>
    </div>
  );
}

function useWakeLock(on: boolean) {
  useEffect(() => {
    const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (!on || !wl) return;
    let lock: { release(): Promise<void> } | null = null, live = true;
    const take = () => { if (document.visibilityState === 'visible' && live) wl.request('screen').then((l) => { if (live) lock = l; else void l.release(); }, () => {}); };
    take(); document.addEventListener('visibilitychange', take);
    return () => { live = false; document.removeEventListener('visibilitychange', take); void lock?.release().catch(() => {}); };
  }, [on]);
}

export function Stage({ poster, seed, url, children, onTrialOver, onSessionEnded, onQuit, orientation = 'any', badge, ctl, blur, tools, controls, starting = false }: {
  /** The version's on-screen controls for touch screens (from the API); the SDK in the game draws them. */
  controls?: TouchControls | null;
  /** Extra buttons in the bar under the game (the console's preview puts its feedback capture there). */
  tools?: ReactNode;
  poster: string | null; seed: string; url: string | null; children?: ReactNode; onTrialOver?: () => void;
  /** The platform refused the game's session (signed out, switched accounts, signed in after guest play, token ran out). */
  onSessionEnded?: (reason: string) => void;
  /** The player quit the game (the platform menu's Quit, or GCP.quit() from the game): stop it, usually by clearing url. */
  onQuit?: () => void;
  /** Blur the poster: an adults-only game before the player has confirmed its warning. */
  blur?: boolean;
  /** The orientation the game declared (requirements.orientation). */
  orientation?: Orientation;
  /** Shown beside the menu button while the game plays (the free-trial clock). */
  badge?: ReactNode;
  ctl?: Ref<StageCtl>;
  /** The game is being started (the play or preview request is on its way): the splash already covers the stage. */
  starting?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null), frame = useRef<HTMLIFrameElement>(null), menuBtn = useRef<HTMLButtonElement>(null);
  const [fs, setFs] = useState(false), [immersive, setImmersive] = useState(false), [menu, setMenu] = useState(false);
  const gameEsc = useRef(false), menuOpen = useRef(false), hungRef = useRef(false);
  const [prefs, setPrefs] = useState<{ orientation?: Orientation; exit?: Corner; edge?: boolean }>({});
  // The browser left fullscreen by itself on a phone or tablet (Back, iPad's swipe down): the game waits behind a card.
  const [held, setHeld] = useState(false), heldRef = useRef(false), ourExit = useRef(false);
  heldRef.current = held;
  const [tip, setTip] = useState<string | null>(null);
  const [insets, setInsets] = useState<Insets>(NO_INSETS);
  const [turned, setTurned] = useState(false), [portrait, setPortrait] = useState(() => innerHeight > innerWidth);
  // On-screen controls: whether the game has any to offer here (the SDK says), and the player's choice for this game.
  const [padState, setPadState] = useState<{ available: boolean; shown: boolean }>({ available: false, shown: false });
  const [padPref, setPadPref] = useState<boolean | null>(() => readControlsPref(seed));
  const padCfg = sanitizeControls(controls);
  // Interface size: offered in the menu once the game says it scales its interface with GCP.ui.
  const [uiSize, setUiSize] = useState<number | null>(() => readUiSize(seed)), [uiScalable, setUiScalable] = useState(false);
  // The watchdog: the game is asked every second whether it is alive (the SDK answers from the game's main thread).
  const splash = useSplash(starting, url, frame);
  const [hung, setHung] = useState(false), waitBtn = useRef<HTMLButtonElement>(null), waitRef = useRef<() => void>(() => {});
  const handheld = isHandheld(), active = fs || immersive, want = prefs.orientation ?? orientation;
  // In fullscreen every game gets the whole screen, notch, camera hole and rounded corners included, and is told the insets
  // (GCP.display.safe, --gcp-safe-*); the on-screen controls keep inside them. Black bars around the game read as a broken
  // fullscreen. A game can still ask to be kept inside them with setDisplay({ edgeToEdge: false }).
  const edge = active && prefs.edge !== false;
  const unlock = useRef<(() => void) | null>(null);
  menuOpen.current = menu; hungRef.current = hung;
  const urlRef = useRef(url), toggleRef = useRef<() => void>(() => {}); urlRef.current = url;

  const leaveImmersive = useCallback(() => { unlock.current?.(); unlock.current = null; setImmersive(false); }, []);
  // While the game fills the screen, an entry of its own sits on top of the page's history, so a stray back gesture (a
  // trackpad swipe, Android's overscroll) takes that entry instead of leaving the page and closing the game.
  const pushPlay = useCallback(() => { try { if (!history.state?.gcpPlay) history.pushState({ ...(history.state || {}), gcpPlay: 1 }, ''); } catch { /* sandboxed */ } }, []);
  const goImmersive = useCallback(() => {
    if (unlock.current) return;
    unlock.current = lockPage(); setImmersive(true); pushPlay();
  }, [pushPlay]);
  // Call it from a click or key press: browsers refuse fullscreen otherwise. On iPhone, and in an installed web app on
  // iOS (already full screen, where a swipe would only drop an element fullscreen), the stage fills the viewport instead.
  const enter = useCallback(() => {
    const el = box.current as FsEl | null; if (!el || fsElement() === el || unlock.current) return;
    setTurned(false); setMenu(false); setHeld(false);
    if (fsAvailable(el) && !(isIOS() && isInstalled())) requestFs(el).then(() => { lockOrientation(want); pushPlay(); }, goImmersive);
    else goImmersive();
  }, [want, goImmersive, pushPlay]);
  const exit = useCallback(() => {
    setMenu(false); setHeld(false); ourExit.current = true; setTimeout(() => { ourExit.current = false; }, 800); exitFs();
    // Leave at once, then drop the play entry. Leaving first matters: Quit calls exit() twice (here and when the url
    // clears), and a second back while the first is still in flight would take the player off the page.
    if (unlock.current) { const entry = !!history.state?.gcpPlay; leaveImmersive(); if (entry) history.back(); }
  }, [leaveImmersive]);
  const toggle = useCallback(() => (fsElement() === box.current || unlock.current ? exit() : enter()), [enter, exit]);
  toggleRef.current = toggle;
  const quit = useCallback(() => { setMenu(false); onQuit?.(); exit(); }, [onQuit, exit]);
  const resume = useCallback(() => { setMenu(false); frame.current?.focus(); }, []);
  const activeRef = useRef(false); activeRef.current = active;
  // A capture asks the game page and waits for its answer (only that frame's answers count).
  const capture = useCallback((picture = true) => new Promise<GameCapture>((resolve, reject) => {
    const win = frame.current?.contentWindow, src = urlRef.current;
    if (!win || !src) { reject(new Error(t('The game is not running.', '游戏未在运行。'))); return; }
    const id = Math.random().toString(36).slice(2, 12);
    const done = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.data?.gcp !== 'capture_result' || e.data.id !== id) return;
      clearTimeout(timer); removeEventListener('message', done); resolve(e.data as GameCapture);
    };
    const timer = setTimeout(() => { removeEventListener('message', done); reject(new Error(t('The game did not answer. It may be busy; try again.', '游戏没有响应，可能正忙，请重试。'))); }, 12000);
    addEventListener('message', done);
    win.postMessage({ gcp: 'capture', id, picture }, new URL(src, location.href).origin);
  }), []);
  useImperativeHandle(ctl, () => ({ enter, exit, toggle, quit, enterOnPhone: () => { if (isHandheld()) enter(); }, capture, isActive: () => activeRef.current }), [enter, exit, toggle, quit, capture]);
  // Alt+Enter toggles fullscreen, the shortcut PC games use. Pressed in the game, the SDK passes it on (the key press
  // counts as the player's gesture for this page too).
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Enter' && e.altKey && !e.repeat && urlRef.current) { e.preventDefault(); toggleRef.current(); } };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, []);

  const fsRef = useRef(false);
  // Ask the game to pause itself; with no answer within half a second (an older page, a busy one), the platform holds it.
  const askTimer = useRef(0);
  const askPause = useCallback(() => {
    const win = frame.current?.contentWindow; if (!win) { setHeld(true); return; }
    clearTimeout(askTimer.current); askTimer.current = window.setTimeout(() => setHeld(true), 500);
    win.postMessage({ gcp: 'pause_request' }, '*');
  }, []);
  // Real fullscreen ends by itself too (holding Esc, the back or swipe gesture): follow it. Esc stays locked while it lasts.
  useEffect(() => {
    const f = () => {
      const on = !!box.current && fsElement() === box.current, was = fsRef.current; fsRef.current = on; setFs(on); escLock(on);
      // Fullscreen ended by the browser, not by the menu: the player's Esc (Firefox and Safari leave on it, Chrome on a held
      // Esc), Back or a swipe. That is a request to stop, never a reason to keep playing unseen in a window: the game is
      // asked to pause. A game with a pause menu of its own opens it; any other is held behind the Paused card (Resume goes
      // back to fullscreen, which needs that tap). One pause owner at a time, as with Esc.
      if (was && !on && !ourExit.current && urlRef.current && !hungRef.current) { setMenu(false); askPause(); }
      // Drop the play entry, once any back that ended fullscreen has landed (it may already have taken the entry).
      if (!on) { unlockOrientation(); setTimeout(() => { if (!fsElement() && !unlock.current && history.state?.gcpPlay) history.back(); }, 250); }
    };
    document.addEventListener('fullscreenchange', f); document.addEventListener('webkitfullscreenchange', f);
    return () => { document.removeEventListener('fullscreenchange', f); document.removeEventListener('webkitfullscreenchange', f); };
  }, [askPause]);
  // The back gesture or button pauses immersive play instead of leaving the page. In real fullscreen it only takes the play
  // entry: the game stays in fullscreen (a back that the browser itself turns into leaving fullscreen is handled above).
  useEffect(() => {
    // Back opens the platform menu instead (iPhone's swipe from the edge, Android's Back): the play entry is put back, so the
    // next Back is caught too. A Back while the menu is open leaves fullscreen; the game keeps running in its window.
    const f = () => {
      if (history.state?.gcpPlay) return;
      const playing = !!unlock.current || (!!box.current && fsElement() === box.current);
      if (!playing || hungRef.current) { if (unlock.current) leaveImmersive(); return; }
      if (menuOpen.current) { exit(); return; }
      pushPlay(); setMenu(true);
    };
    addEventListener('popstate', f); return () => removeEventListener('popstate', f);
  }, [leaveImmersive, pushPlay, exit]);
  useEffect(() => () => { unlock.current?.(); unlock.current = null; exitFs(); escLock(false); }, []);
  useEffect(() => {
    const f = () => setPortrait(innerHeight > innerWidth);
    addEventListener('resize', f); addEventListener('orientationchange', f);
    return () => { removeEventListener('resize', f); removeEventListener('orientationchange', f); };
  }, []);
  // The insets change with rotation, and only show at all once the page is fullscreen or pinned with viewport-fit=cover.
  useEffect(() => {
    if (!active) { setInsets(NO_INSETS); return; }
    const f = () => { const v = safeInsets(); setInsets((o) => (sameInsets(o, v) ? o : v)); };
    f(); const t1 = setTimeout(f, 150), t2 = setTimeout(f, 600);
    addEventListener('resize', f); addEventListener('orientationchange', f);
    return () => { clearTimeout(t1); clearTimeout(t2); removeEventListener('resize', f); removeEventListener('orientationchange', f); };
  }, [active]);
  // The game stopped (trial over, preview closed): give the page back.
  const hadUrl = useRef(false);
  useEffect(() => { if (hadUrl.current && !url) { setMenu(false); exit(); } hadUrl.current = !!url; }, [url, exit]);
  useEffect(() => { if (menu) menuBtn.current?.focus({ preventScroll: true }); else if (active && url) frame.current?.focus(); }, [menu, active, url]);

  // Messages from the game (through the SDK) and what it is told back.
  const post = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ gcp: 'display', fullscreen: active, mode: fs ? 'fullscreen' : immersive ? 'immersive' : 'inline', orientation: want, touch: handheld, edgeToEdge: edge, safe: edge ? insets : NO_INSETS, paused: menu || hung || held, menu: menu || held, controls: padCfg, controlsOn: padPref, uiSize }, '*');
  }, [active, fs, immersive, want, handheld, edge, insets, menu, hung, held, JSON.stringify(padCfg), padPref, uiSize]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPadPref(readControlsPref(seed)); }, [seed]);
  useEffect(() => { if (!url) { setPadState({ available: false, shown: false }); setHeld(false); } }, [url]);
  const uiSizeRef = useRef(uiSize), seedRef = useRef(seed); uiSizeRef.current = uiSize; seedRef.current = seed;
  useEffect(() => { setUiScalable(false); }, [url]);
  const stepUi = useCallback((dir: number) => {
    const cur = uiSize ?? 1; let i = 0; UI_SIZES.forEach((v, j) => { if (Math.abs(v - cur) < Math.abs(UI_SIZES[i] - cur)) i = j; });
    const next = UI_SIZES[Math.max(0, Math.min(UI_SIZES.length - 1, i + dir))]; saveUiSize(seed, next); setUiSize(next);
  }, [uiSize, seed]);
  const togglePad = useCallback(() => { const next = !padState.shown; saveControlsPref(seed, next); setPadPref(next); setMenu(false); frame.current?.focus(); }, [padState.shown, seed]);
  // No page zoom while a game runs on a phone or tablet (see applyViewport).
  useEffect(() => {
    if (!url || !handheld) return;
    vp.pinned++; applyViewport();
    return () => { vp.pinned = Math.max(0, vp.pinned - 1); applyViewport(); };
  }, [url, handheld]);
  useEffect(() => { post(); }, [post]);
  // The platform language, switched on the page while the game runs: the game keeps running and is told (GCP.lang, GCP.onLang).
  const lang = useLang();
  const postLang = useCallback(() => { frame.current?.contentWindow?.postMessage({ gcp: 'lang', lang: getLang() }, '*'); }, []);
  useEffect(() => { postLang(); }, [lang, postLang]);
  useEffect(() => {
    const f = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data) return;
      const d = e.data;
      // Leaving fullscreen from the game pauses it behind the card; the player can come straight back or quit there.
      if (d.gcp === 'fullscreen') { if (d.on === true) enter(); else if (d.on === false) exit(); else toggle(); }
      if (d.gcp === 'menu') setMenu((m) => (d.on === true ? true : d.on === false ? false : !m) && active);
      if (d.gcp === 'quit') quit();
      if (d.gcp === 'display_prefs') setPrefs((p) => ({
        orientation: ['any', 'landscape', 'portrait'].includes(d.orientation) ? d.orientation : p.orientation,
        exit: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'none'].includes(d.exitButton) ? d.exitButton : p.exit,
        edge: typeof d.edgeToEdge === 'boolean' ? d.edgeToEdge : p.edge,
      }));
      if (d.gcp === 'display_query') { post(); postLang(); }
      if (d.gcp === 'escape') gameEsc.current = d.on === true;
      if (d.gcp === 'pause_answer') { clearTimeout(askTimer.current); if (d.took !== true) setHeld(true); }
      if (d.gcp === 'ui_info') { setUiScalable(d.scalable === true); if (uiSizeRef.current == null) { const v = okUiSize(d.size); if (v != null && v !== 1) { setUiSize(v); saveUiSize(seedRef.current, v); } } }
      if (d.gcp === 'ui_size') { const v = okUiSize(d.size); if (v != null) { setUiSize(v); saveUiSize(seedRef.current, v); } }
      if (d.gcp === 'controls_state') setPadState({ available: d.available === true, shown: d.shown === true });
      if (d.gcp === 'trial_over') { exit(); onTrialOver?.(); }
      if (d.gcp === 'session_ended') onSessionEnded?.(String(d.reason || 'unknown'));
      if (d.gcp === 'shown') splash.onShown(urlRef.current);
    };
    addEventListener('message', f); return () => removeEventListener('message', f);
  }, [enter, exit, toggle, quit, post, postLang, active, onTrialOver, onSessionEnded]);
  useEffect(() => { if (active && want !== 'any') lockOrientation(want); }, [active, want]);
  useEffect(() => { gameEsc.current = false; }, [url]);
  // Esc pressed while the page, not the game frame, has the keyboard: close the menu if it is open, otherwise hand the key
  // to a game that takes Esc, or open the menu.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat || !box.current || hungRef.current) return;
      const inPlayer = fsElement() === box.current || !!unlock.current; if (!inPlayer) return;
      e.preventDefault();
      if (menuOpen.current) { setMenu(false); return; }
      if (gameEsc.current) { frame.current?.contentWindow?.postMessage({ gcp: 'escape_key' }, '*'); frame.current?.focus(); }
      else setMenu(true);
    };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, []);
  useEffect(() => {
    if (!url) { setHung(false); return; }
    let n = 0, lastPong = 0, loadedAt = 0, quietUntil = 0, dead = false;
    const onMsg = (e: MessageEvent) => { if (e.source === frame.current?.contentWindow && e.data?.gcp === 'pong') { lastPong = performance.now(); if (dead) { dead = false; setHung(false); } } };
    const onLoad = () => { loadedAt = performance.now(); };
    const el = frame.current; el?.addEventListener('load', onLoad); addEventListener('message', onMsg);
    const tick = () => {
      frame.current?.contentWindow?.postMessage({ gcp: 'ping', n: ++n }, '*');
      const now = performance.now();
      if (document.visibilityState !== 'visible') { lastPong = Math.max(lastPong, now - 1000); return; }   // hidden tabs are throttled
      // Before its first answer a game may still be loading: give it longer.
      const late = lastPong ? now - lastPong > HUNG_MS : loadedAt > 0 && now - loadedAt > HUNG_BOOT_MS;
      if (late && !dead && now > quietUntil) { dead = true; setHung(true); }
    };
    const i = setInterval(tick, 1000);
    waitRef.current = () => { quietUntil = performance.now() + HUNG_WAIT_MS; dead = false; setHung(false); };
    return () => { clearInterval(i); removeEventListener('message', onMsg); el?.removeEventListener('load', onLoad); };
  }, [url]);
  // While the game does not answer, Esc and the keyboard come back to the platform: the browser may leave fullscreen on Esc
  // again, and the card's buttons take the focus away from the stuck frame.
  useEffect(() => {
    if (!hung) { if (fsElement() === box.current) escLock(true); return; }
    escLock(false); setMenu(false);
    const t1 = setTimeout(() => waitBtn.current?.focus({ preventScroll: true }), 30);
    return () => clearTimeout(t1);
  }, [hung]);
  useWakeLock(!!url && handheld);

  const sideways = active && handheld && !turned && want !== 'any' && (want === 'landscape' ? portrait : !portrait);
  // The menu button starts in the corner the game asks for (top-left unless GCP.setDisplay({ exitButton }) says otherwise)
  // and the player can drag it anywhere; the spot is kept per game and orientation. Back, a three-finger tap, Esc and the
  // game itself (GCP.menu) open the menu too.
  const corner = prefs.exit ?? 'top-left';
  const [pressing, setPressing] = useState(false), [pos, setPos] = useState<BtnPos | null>(null), [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const grab = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null), dragAt = useRef<{ x: number; y: number } | null>(null), noClick = useRef(0);
  useEffect(() => { setPos(active ? readPos(seed, portrait) : null); }, [active, seed, portrait]);
  const room = () => ({ w: Math.max(0, (box.current?.clientWidth ?? 0) - BTN - 2 * BTN_EDGE), h: Math.max(0, (box.current?.clientHeight ?? 0) - BTN - 2 * BTN_EDGE) });
  const onBtnDown = (e: RPointerEvent<HTMLButtonElement>) => {
    if (e.button > 0) return;
    setPressing(true);
    const r = e.currentTarget.getBoundingClientRect(), b = box.current?.getBoundingClientRect();
    grab.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left - (b?.left ?? 0), oy: r.top - (b?.top ?? 0), moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* old browser */ }
  };
  const onBtnMove = (e: RPointerEvent<HTMLButtonElement>) => {
    const g = grab.current; if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < 10) return;
    g.moved = true; setTip(null);
    const { w, h } = room(), at = { x: Math.min(w, Math.max(0, g.ox - BTN_EDGE + dx)), y: Math.min(h, Math.max(0, g.oy - BTN_EDGE + dy)) };
    dragAt.current = at; setDrag(at);
  };
  const onBtnUp = (e: RPointerEvent<HTMLButtonElement>) => {
    const g = grab.current; if (!g || g.id !== e.pointerId) return;
    grab.current = null; setPressing(false);
    if (!g.moved) return;   // a tap: the click that follows opens the menu
    noClick.current = performance.now() + 400;
    const { w, h } = room(), at = dragAt.current;
    if (at && e.type === 'pointerup') { const p = { x: w ? at.x / w : 0, y: h ? at.y / h : 0 }; savePos(seed, portrait, p); setPos(p); }
    dragAt.current = null; setDrag(null); frame.current?.focus();
  };
  const btnStyle = (): CSSProperties | undefined => {
    if (drag) return { left: BTN_EDGE + drag.x, top: BTN_EDGE + drag.y, right: 'auto', bottom: 'auto' };
    if (!pos) return undefined;
    const { w, h } = room();
    return { left: BTN_EDGE + Math.round(pos.x * w), top: BTN_EDGE + Math.round(pos.y * h), right: 'auto', bottom: 'auto' };
  };
  const iosTip = active && handheld && isIOS() && !isInstalled();
  // How to open the menu here, said once at the start of the first few plays on this device (taps go through the note).
  const howTo = corner !== 'none' ? (handheld ? t('Menu button in the way? Drag it anywhere.', '菜单按钮挡住了画面？可以把它拖到任意位置。') : t('Menu button in the way? Drag it anywhere. Esc opens the menu too.', '菜单按钮挡住了画面？可以把它拖到任意位置。按 Esc 也能打开菜单。'))
    : !handheld ? t('Press Esc for the game menu.', '按 Esc 打开游戏菜单。')
    : isIOS() && isInstalled() ? t('Tap with three fingers for the game menu.', '三指轻点打开游戏菜单。')
    : isIOS() && immersive ? t('Swipe in from the left edge, or tap with three fingers, for the game menu.', '从屏幕左边缘向内滑，或三指轻点，打开游戏菜单。')
    : t('Go back, or tap with three fingers, for the game menu.', '使用返回手势或返回键，或三指轻点，打开游戏菜单。');
  useEffect(() => {
    if (!active || !url) return;
    let n = 0; try { n = +(localStorage.getItem(TIP_KEY) || 0) || 0; } catch { /* private mode */ }
    if (n >= TIP_TIMES) return;
    try { localStorage.setItem(TIP_KEY, String(n + 1)); } catch { /* private mode */ }
    const t0 = setTimeout(() => setTip(howTo), 1200), t1 = setTimeout(() => setTip(null), 6200);
    return () => { clearTimeout(t0); clearTimeout(t1); setTip(null); };
  }, [active, !!url]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <div className={'stage ink' + (immersive ? ' immersive' : '') + (active ? ' filled' : '') + (edge ? ' edge' : '')} ref={box}>
        {url ? <iframe ref={frame} src={url} title="Game" onLoad={() => { post(); postLang(); }} inert={menu || hung || held} sandbox={GAME_SANDBOX} allow="fullscreen; gamepad; autoplay; clipboard-write; accelerometer; gyroscope; screen-wake-lock; xr-spatial-tracking" /> : (
          <><div className={'poster' + (blur && poster ? ' mature-blur' : '')} style={poster ? { backgroundImage: `url(${poster})` } : artStyle(seed)} /><div className="over">{children}</div></>
        )}
        {splash.phase !== 'off' && <Splash out={splash.phase === 'out'} />}
        {active && url && !menu && !hung && (corner !== 'none' || badge) && (
          <div className={'stage-exit ' + (corner === 'none' ? 'top-left' : corner) + (pos || drag ? ' moved' : '') + (drag ? ' dragging' : '') + (pressing ? ' pressing' : '')} style={corner === 'none' ? undefined : btnStyle()}>
            {corner !== 'none' && <button type="button" onClick={() => { if (performance.now() >= noClick.current) setMenu(true); }} onPointerDown={onBtnDown} onPointerMove={onBtnMove} onPointerUp={onBtnUp} onPointerCancel={onBtnUp}
              aria-label={t('Game menu', '游戏菜单')} title={t('Game menu (drag to move)', '游戏菜单（可拖动）')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" /></svg></button>}
            {badge && <span className="stage-badge">{badge}</span>}
          </div>
        )}
        {tip && active && url && !menu && !hung && <div className="stage-tip" role="status">{tip}</div>}
        {!active && url && held && !hung && (
          <div className="stage-menu" role="dialog" aria-modal="true" aria-label={t('Paused', '已暂停')}>
            <div className="stage-card">
              <b>{t('Paused', '已暂停')}</b>
              <button type="button" className="stage-btn primary" onClick={enter}>{t('Resume', '继续游戏')}</button>
              <button type="button" className="stage-btn" onClick={() => { setHeld(false); frame.current?.focus(); }}>{t('Keep playing here', '在此继续玩')}</button>
              <button type="button" className="stage-btn" onClick={quit}>{t('Quit game', '退出游戏')}</button>
            </div>
          </div>
        )}
        {active && url && menu && (
          <div className="stage-menu" role="dialog" aria-modal="true" aria-label={t('Game menu', '游戏菜单')} onClick={(e) => { if (e.target === e.currentTarget) setMenu(false); }}>
            <div className="stage-card">
              <b>{t('Paused', '已暂停')}</b>
              {badge && <span className="stage-badge">{badge}</span>}
              <button ref={menuBtn} type="button" className="stage-btn primary" onClick={resume}>{t('Resume', '继续游戏')}</button>
              {padState.available && <button type="button" className="stage-btn" onClick={togglePad}>{padState.shown ? t('Hide on-screen controls', '隐藏屏幕按键') : t('Show on-screen controls', '显示屏幕按键')}</button>}
              {uiScalable && (
                <div className="stage-size" role="group" aria-label={t('Interface size', '界面大小')}>
                  <span>{t('Interface size', '界面大小')}</span>
                  <button type="button" className="stage-btn" aria-label={t('Smaller', '缩小')} disabled={(uiSize ?? 1) <= UI_SIZES[0]} onClick={() => stepUi(-1)}>−</button>
                  <output aria-live="polite">{Math.round((uiSize ?? 1) * 100)}%</output>
                  <button type="button" className="stage-btn" aria-label={t('Larger', '放大')} disabled={(uiSize ?? 1) >= UI_SIZES[UI_SIZES.length - 1]} onClick={() => stepUi(1)}>+</button>
                </div>
              )}
              <button type="button" className="stage-btn" onClick={exit}>{t('Exit fullscreen', '退出全屏')}</button>
              <button type="button" className="stage-btn" onClick={quit}>{t('Quit game', '退出游戏')}</button>
              {iosTip && <span className="stage-hint">{t('For full screen that swipes cannot close, tap Share, then Add to Home Screen, and play from there.', '想要不会被滑动打断的全屏，请点“分享”，再点“添加到主屏幕”，然后从主屏幕打开游玩。')}</span>}
              {corner !== 'none' && <span className="stage-hint">{t('Menu button in the way? Drag it anywhere.', '菜单按钮挡住了画面？可以把它拖到任意位置。')}</span>}
              {handheld && <span className="stage-hint">{t('Back, or a three-finger tap, also opens this menu.', '返回手势或三指轻点也能打开此菜单。')}</span>}
              <span className="stage-hint">{handheld ? t('Tap outside this card to go back to the game.', '点击卡片外即可返回游戏。') : t('Press Esc to go back to the game.', '按 Esc 返回游戏。')}</span>
            </div>
          </div>
        )}
        {url && hung && (
          <div className="stage-menu" role="alertdialog" aria-modal="true" aria-label={t('The game is not responding', '游戏没有响应')}>
            <div className="stage-card">
              <b>{t('The game is not responding', '游戏没有响应')}</b>
              <span className="stage-sub">{t('It may be busy and come back by itself. Quitting closes it; progress it has not saved may be lost.', '它可能只是太忙，过一会儿会自己恢复。退出会关闭游戏，未保存的进度可能丢失。')}</span>
              <button ref={waitBtn} type="button" className="stage-btn primary" onClick={() => waitRef.current()}>{t('Wait', '等待')}</button>
              <button type="button" className="stage-btn" onClick={quit}>{t('Quit game', '退出游戏')}</button>
            </div>
          </div>
        )}
        {sideways && (
          <div className="stage-turn" role="dialog" aria-label={t('Turn your device', '旋转设备')}>
            <div className={'turn-ico ' + want} aria-hidden="true"><i /></div>
            <b>{want === 'landscape' ? t('Turn your phone sideways', '请横屏游玩') : t('Turn your phone upright', '请竖屏游玩')}</b>
            <span>{want === 'landscape' ? t('This game is made for landscape.', '这款游戏为横屏设计。') : t('This game is made for portrait.', '这款游戏为竖屏设计。')}</span>
            <Button size="sm" variant="ghost" onClick={() => setTurned(true)}>{t('Play this way', '就这样玩')}</Button>
          </div>
        )}
      </div>
      {url && (
        <div className="row stage-bar">
          <span className="mute fs-sm">{handheld ? t('Fullscreen gives the game the whole screen.', '全屏可让游戏占满整个屏幕。') : t('Click the game to give it keyboard focus. Alt+Enter toggles fullscreen.', '点击游戏画面以获取键盘焦点。Alt+Enter 切换全屏。')}</span>
          <span className="row right" style={{ gap: 8 }}>
            {tools}
            {onQuit && <Button size="sm" variant="ghost" onClick={quit}>{t('Quit game', '退出游戏')}</Button>}
            <Button size="sm" variant="primary" onClick={toggle}>{t('Fullscreen', '全屏')}</Button>
          </span>
        </div>
      )}
    </div>
  );
}

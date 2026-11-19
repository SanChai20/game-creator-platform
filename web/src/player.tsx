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
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { artStyle, getLang, t, useLang } from './lib';
import { Button } from './ui';
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
  capture(): Promise<GameCapture>;
  /** Whether the stage fills the screen right now. */
  isActive(): boolean;
}
/** What the SDK answers a capture with: the picture (a JPEG data URL, '' on error) and what it knew about the game. */
export interface GameCapture {
  image: string; error: string; canvases: number; method?: 'game' | 'page'; state: string | null; frames: number; fps: number; ready: boolean; label: string;
  errors: string[]; warnings: string[]; viewport: { width: number; height: number };
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

// While immersive, the page under the game must not scroll or zoom: the viewport is pinned at scale 1.
const LOCKED_VIEWPORT = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
function lockPage(): () => void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]'), was = meta?.content, y = scrollY;
  if (meta) meta.content = LOCKED_VIEWPORT;
  document.documentElement.classList.add('gcp-play');
  return () => {
    document.documentElement.classList.remove('gcp-play');
    if (meta && was != null) meta.content = was;
    scrollTo(0, y);
  };
}

type Insets = { top: number; right: number; bottom: number; left: number };
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

export function Stage({ poster, seed, url, children, onTrialOver, onSessionEnded, onQuit, orientation = 'any', badge, ctl, blur, tools }: {
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
}) {
  const box = useRef<HTMLDivElement>(null), frame = useRef<HTMLIFrameElement>(null), menuBtn = useRef<HTMLButtonElement>(null);
  const [fs, setFs] = useState(false), [immersive, setImmersive] = useState(false), [menu, setMenu] = useState(false);
  const gameEsc = useRef(false), menuOpen = useRef(false), hungRef = useRef(false);
  const [prefs, setPrefs] = useState<{ orientation?: Orientation; exit?: Corner; edge?: boolean }>({});
  const [insets, setInsets] = useState<Insets>(NO_INSETS);
  const [turned, setTurned] = useState(false), [portrait, setPortrait] = useState(() => innerHeight > innerWidth);
  // The watchdog: the game is asked every second whether it is alive (the SDK answers from the game's main thread).
  const [hung, setHung] = useState(false), waitBtn = useRef<HTMLButtonElement>(null), waitRef = useRef<() => void>(() => {});
  const handheld = isHandheld(), active = fs || immersive, want = prefs.orientation ?? orientation;
  // A game that keeps its own buttons clear of the notch (setDisplay({ edgeToEdge: true })) gets the whole screen in
  // fullscreen and is told the insets; any other game's frame is kept inside them.
  const edge = active && !!prefs.edge;
  const unlock = useRef<(() => void) | null>(null);
  menuOpen.current = menu; hungRef.current = hung;
  const urlRef = useRef(url), toggleRef = useRef<() => void>(() => {}); urlRef.current = url;

  const leaveImmersive = useCallback(() => { unlock.current?.(); unlock.current = null; setImmersive(false); }, []);
  const goImmersive = useCallback(() => {
    if (unlock.current) return;
    unlock.current = lockPage(); setImmersive(true);
    try { history.pushState({ ...(history.state || {}), gcpPlay: 1 }, ''); } catch { /* sandboxed */ }
  }, []);
  // Call it from a click or key press: browsers refuse fullscreen otherwise. On iPhone, and in an installed web app on
  // iOS (already full screen, where a swipe would only drop an element fullscreen), the stage fills the viewport instead.
  const enter = useCallback(() => {
    const el = box.current as FsEl | null; if (!el || fsElement() === el || unlock.current) return;
    setTurned(false); setMenu(false);
    if (fsAvailable(el) && !(isIOS() && isInstalled())) requestFs(el).then(() => lockOrientation(want), goImmersive);
    else goImmersive();
  }, [want, goImmersive]);
  const exit = useCallback(() => {
    setMenu(false); exitFs();
    if (unlock.current) { if (history.state?.gcpPlay) history.back(); else leaveImmersive(); }   // back: the popstate below cleans up
  }, [leaveImmersive]);
  const toggle = useCallback(() => (fsElement() === box.current || unlock.current ? exit() : enter()), [enter, exit]);
  toggleRef.current = toggle;
  const quit = useCallback(() => { setMenu(false); onQuit?.(); exit(); }, [onQuit, exit]);
  const resume = useCallback(() => { setMenu(false); frame.current?.focus(); }, []);
  const activeRef = useRef(false); activeRef.current = active;
  // A capture asks the game page and waits for its answer (only that frame's answers count).
  const capture = useCallback(() => new Promise<GameCapture>((resolve, reject) => {
    const win = frame.current?.contentWindow, src = urlRef.current;
    if (!win || !src) { reject(new Error(t('The game is not running.', '游戏未在运行。'))); return; }
    const id = Math.random().toString(36).slice(2, 12);
    const done = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.data?.gcp !== 'capture_result' || e.data.id !== id) return;
      clearTimeout(timer); removeEventListener('message', done); resolve(e.data as GameCapture);
    };
    const timer = setTimeout(() => { removeEventListener('message', done); reject(new Error(t('The game did not answer. It may be busy; try again.', '游戏没有响应，可能正忙，请重试。'))); }, 4000);
    addEventListener('message', done);
    win.postMessage({ gcp: 'capture', id }, new URL(src, location.href).origin);
  }), []);
  useImperativeHandle(ctl, () => ({ enter, exit, toggle, quit, enterOnPhone: () => { if (isHandheld()) enter(); }, capture, isActive: () => activeRef.current }), [enter, exit, toggle, quit, capture]);
  // Alt+Enter toggles fullscreen, the shortcut PC games use. Pressed in the game, the SDK passes it on (the key press
  // counts as the player's gesture for this page too).
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Enter' && e.altKey && !e.repeat && urlRef.current) { e.preventDefault(); toggleRef.current(); } };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, []);

  // Real fullscreen ends by itself too (holding Esc, the back or swipe gesture): follow it. Esc stays locked while it lasts.
  useEffect(() => {
    const f = () => { const on = !!box.current && fsElement() === box.current; setFs(on); if (!on) unlockOrientation(); escLock(on); };
    document.addEventListener('fullscreenchange', f); document.addEventListener('webkitfullscreenchange', f);
    return () => { document.removeEventListener('fullscreenchange', f); document.removeEventListener('webkitfullscreenchange', f); };
  }, []);
  // The back gesture or button pauses immersive play instead of leaving the page.
  useEffect(() => {
    const f = () => { if (unlock.current && !history.state?.gcpPlay) leaveImmersive(); };
    addEventListener('popstate', f); return () => removeEventListener('popstate', f);
  }, [leaveImmersive]);
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
    frame.current?.contentWindow?.postMessage({ gcp: 'display', fullscreen: active, mode: fs ? 'fullscreen' : immersive ? 'immersive' : 'inline', orientation: want, touch: handheld, edgeToEdge: edge, safe: edge ? insets : NO_INSETS, paused: menu || hung, menu }, '*');
  }, [active, fs, immersive, want, handheld, edge, insets, menu, hung]);
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
      if (d.gcp === 'trial_over') { exit(); onTrialOver?.(); }
      if (d.gcp === 'session_ended') onSessionEnded?.(String(d.reason || 'unknown'));
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
  const corner = prefs.exit ?? 'top-left';
  const iosTip = active && handheld && isIOS() && !isInstalled();
  return (
    <div>
      <div className={'stage ink' + (immersive ? ' immersive' : '') + (active ? ' filled' : '') + (edge ? ' edge' : '')} ref={box}>
        {url ? <iframe ref={frame} src={url} title="Game" onLoad={() => { post(); postLang(); }} inert={menu || hung} sandbox={GAME_SANDBOX} allow="fullscreen; gamepad; autoplay; clipboard-write; accelerometer; gyroscope; screen-wake-lock; xr-spatial-tracking" /> : (
          <><div className={'poster' + (blur && poster ? ' mature-blur' : '')} style={poster ? { backgroundImage: `url(${poster})` } : artStyle(seed)} /><div className="over">{children}</div></>
        )}
        {active && url && !menu && !hung && (corner !== 'none' || badge) && (
          <div className={'stage-exit ' + (corner === 'none' ? 'top-left' : corner)}>
            {corner !== 'none' && <button type="button" onClick={() => setMenu(true)} aria-label={t('Game menu', '游戏菜单')} title={t('Game menu', '游戏菜单')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" /></svg></button>}
            {badge && <span className="stage-badge">{badge}</span>}
          </div>
        )}
        {active && url && menu && (
          <div className="stage-menu" role="dialog" aria-modal="true" aria-label={t('Game menu', '游戏菜单')} onClick={(e) => { if (e.target === e.currentTarget) setMenu(false); }}>
            <div className="stage-card">
              <b>{t('Paused', '已暂停')}</b>
              {badge && <span className="stage-badge">{badge}</span>}
              <button ref={menuBtn} type="button" className="stage-btn primary" onClick={resume}>{t('Resume', '继续游戏')}</button>
              <button type="button" className="stage-btn" onClick={exit}>{t('Exit fullscreen', '退出全屏')}</button>
              <button type="button" className="stage-btn" onClick={quit}>{t('Quit game', '退出游戏')}</button>
              {iosTip && <span className="stage-hint">{t('For full screen that swipes cannot close, tap Share, then Add to Home Screen, and play from there.', '想要不会被滑动打断的全屏，请点“分享”，再点“添加到主屏幕”，然后从主屏幕打开游玩。')}</span>}
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

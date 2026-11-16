// The play surface on a game's page: a poster until the player starts, then the game in a frame on its own origin.
//
// Fullscreen has to work on phones, where the browsers disagree:
//   - Android (Chrome, Samsung Internet, Firefox) and iPad Safari: the Fullscreen API on the stage element, with
//     the screen orientation locked to the one the game declared (requirements.orientation).
//   - iPhone Safari has no element fullscreen. There the stage fills the visible viewport instead ("immersive"):
//     fixed over the page, page scroll and pinch zoom off, the back gesture closes it, and a hint asks the player
//     to turn the phone when the game wants the other orientation.
// On a phone or tablet, starting a game goes straight to fullscreen (enterOnPhone, called from the Play click so
// the browser still counts it as the player's gesture). The game is told what is going on through the SDK
// (GCP.display, GCP.onDisplay) and can ask for fullscreen (GCP.fullscreen) or set its preferences (GCP.setDisplay).
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { artStyle, t } from './lib';
import { Button } from './ui';
import './player.css';

export type Orientation = 'any' | 'landscape' | 'portrait';
type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'none';
export interface StageCtl {
  /** Fill the screen: real fullscreen where the browser allows it, otherwise the immersive viewport. */
  enter(): void;
  exit(): void;
  toggle(): void;
  /** enter(), but only on a phone or tablet. Call it from the click that starts the game. */
  enterOnPhone(): void;
}

const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;
/** A phone or tablet: the main pointer is a finger and nothing hovers. */
export const isHandheld = () => mq('(pointer: coarse)') && mq('(hover: none)');

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
// The Escape rule. A game that registered GCP.onEscape gets Esc first while it is in real fullscreen: it closes its own
// menu, and only an Esc with nothing open leaves fullscreen (the SDK then asks for that). The Keyboard Lock API makes the
// browser deliver Esc to the page instead of leaving fullscreen at once; holding Esc still leaves. Browsers without it
// keep the old behaviour.
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

export function Stage({ poster, seed, url, children, onTrialOver, orientation = 'any', badge, ctl, blur }: {
  poster: string | null; seed: string; url: string | null; children?: ReactNode; onTrialOver?: () => void;
  /** Blur the poster: an adults-only game before the player has confirmed its warning. */
  blur?: boolean;
  /** The orientation the game declared (requirements.orientation). */
  orientation?: Orientation;
  /** Shown beside the exit button while the stage fills the screen (the free-trial clock). */
  badge?: ReactNode;
  ctl?: Ref<StageCtl>;
}) {
  const box = useRef<HTMLDivElement>(null), frame = useRef<HTMLIFrameElement>(null);
  const [fs, setFs] = useState(false), [immersive, setImmersive] = useState(false);
  const gameEsc = useRef(false);
  const [prefs, setPrefs] = useState<{ orientation?: Orientation; exit?: Corner; edge?: boolean }>({});
  const [insets, setInsets] = useState<Insets>(NO_INSETS);
  const [turned, setTurned] = useState(false), [portrait, setPortrait] = useState(() => innerHeight > innerWidth);
  const handheld = isHandheld(), active = fs || immersive, want = prefs.orientation ?? orientation;
  // A game that keeps its own buttons clear of the notch (setDisplay({ edgeToEdge: true })) gets the whole screen in
  // fullscreen and is told the insets; any other game's frame is kept inside them.
  const edge = active && !!prefs.edge;
  const unlock = useRef<(() => void) | null>(null);

  const leaveImmersive = useCallback(() => { unlock.current?.(); unlock.current = null; setImmersive(false); }, []);
  const goImmersive = useCallback(() => {
    if (unlock.current) return;
    unlock.current = lockPage(); setImmersive(true);
    try { history.pushState({ ...(history.state || {}), gcpPlay: 1 }, ''); } catch { /* sandboxed */ }
  }, []);
  const enter = useCallback(() => {
    const el = box.current as FsEl | null; if (!el || fsElement() === el || unlock.current) return;
    setTurned(false);
    if (fsAvailable(el)) requestFs(el).then(() => lockOrientation(want), goImmersive);
    else goImmersive();
  }, [want, goImmersive]);
  const exit = useCallback(() => {
    exitFs();
    if (unlock.current) { if (history.state?.gcpPlay) history.back(); else leaveImmersive(); }   // back: the popstate below cleans up
  }, [leaveImmersive]);
  const toggle = useCallback(() => (fsElement() === box.current || unlock.current ? exit() : enter()), [enter, exit]);
  useImperativeHandle(ctl, () => ({ enter, exit, toggle, enterOnPhone: () => { if (isHandheld()) enter(); } }), [enter, exit, toggle]);

  // Real fullscreen ends by itself too (Esc, the back gesture): follow it.
  useEffect(() => {
    const f = () => { const on = !!box.current && fsElement() === box.current; setFs(on); if (!on) unlockOrientation(); escLock(on && gameEsc.current); };
    document.addEventListener('fullscreenchange', f); document.addEventListener('webkitfullscreenchange', f);
    return () => { document.removeEventListener('fullscreenchange', f); document.removeEventListener('webkitfullscreenchange', f); };
  }, []);
  // The back gesture or button closes immersive play instead of leaving the page.
  useEffect(() => {
    const f = () => { if (unlock.current && !history.state?.gcpPlay) leaveImmersive(); };
    addEventListener('popstate', f); return () => removeEventListener('popstate', f);
  }, [leaveImmersive]);
  useEffect(() => () => { unlock.current?.(); unlock.current = null; exitFs(); }, []);
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
  useEffect(() => { if (hadUrl.current && !url) exit(); hadUrl.current = !!url; }, [url, exit]);

  // Messages from the game (through the SDK) and what it is told back.
  const post = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ gcp: 'display', fullscreen: active, mode: fs ? 'fullscreen' : immersive ? 'immersive' : 'inline', orientation: want, touch: handheld, edgeToEdge: edge, safe: edge ? insets : NO_INSETS }, '*');
  }, [active, fs, immersive, want, handheld, edge, insets]);
  useEffect(() => { post(); }, [post]);
  useEffect(() => {
    const f = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data) return;
      const d = e.data;
      if (d.gcp === 'fullscreen') { if (d.on === true) enter(); else if (d.on === false) exit(); else toggle(); }
      if (d.gcp === 'display_prefs') setPrefs((p) => ({
        orientation: ['any', 'landscape', 'portrait'].includes(d.orientation) ? d.orientation : p.orientation,
        exit: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'none'].includes(d.exitButton) ? d.exitButton : p.exit,
        edge: typeof d.edgeToEdge === 'boolean' ? d.edgeToEdge : p.edge,
      }));
      if (d.gcp === 'display_query') post();
      if (d.gcp === 'escape') { gameEsc.current = d.on === true; escLock(gameEsc.current && fsElement() === box.current); }
      if (d.gcp === 'trial_over') { exit(); onTrialOver?.(); }
    };
    addEventListener('message', f); return () => removeEventListener('message', f);
  }, [enter, exit, toggle, post, onTrialOver]);
  useEffect(() => { if (active && want !== 'any') lockOrientation(want); }, [active, want]);
  useEffect(() => { if (url) frame.current?.focus(); }, [url, active]);
  useEffect(() => { gameEsc.current = false; escLock(false); }, [url]);
  // Esc pressed while the page, not the game frame, has the keyboard: hand it to the game, which decides.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat || !gameEsc.current || fsElement() !== box.current) return;
      e.preventDefault(); frame.current?.contentWindow?.postMessage({ gcp: 'escape_key' }, '*'); frame.current?.focus();
    };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, []);
  useWakeLock(!!url && handheld);

  const sideways = active && handheld && !turned && want !== 'any' && (want === 'landscape' ? portrait : !portrait);
  const corner = prefs.exit ?? 'top-left';
  return (
    <div>
      <div className={'stage ink' + (immersive ? ' immersive' : '') + (active ? ' filled' : '') + (edge ? ' edge' : '')} ref={box}>
        {url ? <iframe ref={frame} src={url} title="Game" onLoad={post} allow="fullscreen; gamepad; autoplay; clipboard-write; accelerometer; gyroscope; screen-wake-lock; xr-spatial-tracking" allowFullScreen /> : (
          <><div className={'poster' + (blur && poster ? ' mature-blur' : '')} style={poster ? { backgroundImage: `url(${poster})` } : artStyle(seed)} /><div className="over">{children}</div></>
        )}
        {active && (corner !== 'none' || badge) && (
          <div className={'stage-exit ' + (corner === 'none' ? 'top-left' : corner)}>
            {corner !== 'none' && <button type="button" onClick={exit} aria-label={t('Exit fullscreen', '退出全屏')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg></button>}
            {badge && <span className="stage-badge">{badge}</span>}
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
          <span className="mute fs-sm">{handheld ? t('Fullscreen gives the game the whole screen.', '全屏可让游戏占满整个屏幕。') : t('Click the game to give it keyboard focus.', '点击游戏画面以获取键盘焦点。')}</span>
          <Button size="sm" variant={handheld ? 'primary' : undefined} className="right" onClick={toggle}>{t('Fullscreen', '全屏')}</Button>
        </div>
      )}
    </div>
  );
}

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
  const [prefs, setPrefs] = useState<{ orientation?: Orientation; exit?: Corner }>({});
  const [turned, setTurned] = useState(false), [portrait, setPortrait] = useState(() => innerHeight > innerWidth);
  const handheld = isHandheld(), active = fs || immersive, want = prefs.orientation ?? orientation;
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
    const f = () => { const on = !!box.current && fsElement() === box.current; setFs(on); if (!on) unlockOrientation(); };
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
  // The game stopped (trial over, preview closed): give the page back.
  const hadUrl = useRef(false);
  useEffect(() => { if (hadUrl.current && !url) exit(); hadUrl.current = !!url; }, [url, exit]);

  // Messages from the game (through the SDK) and what it is told back.
  const post = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ gcp: 'display', fullscreen: active, mode: fs ? 'fullscreen' : immersive ? 'immersive' : 'inline', orientation: want, touch: handheld }, '*');
  }, [active, fs, immersive, want, handheld]);
  useEffect(() => { post(); }, [post]);
  useEffect(() => {
    const f = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data) return;
      const d = e.data;
      if (d.gcp === 'fullscreen') { if (d.on === true) enter(); else if (d.on === false) exit(); else toggle(); }
      if (d.gcp === 'display_prefs') setPrefs((p) => ({
        orientation: ['any', 'landscape', 'portrait'].includes(d.orientation) ? d.orientation : p.orientation,
        exit: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'none'].includes(d.exitButton) ? d.exitButton : p.exit,
      }));
      if (d.gcp === 'display_query') post();
      if (d.gcp === 'trial_over') { exit(); onTrialOver?.(); }
    };
    addEventListener('message', f); return () => removeEventListener('message', f);
  }, [enter, exit, toggle, post, onTrialOver]);
  useEffect(() => { if (active && want !== 'any') lockOrientation(want); }, [active, want]);
  useEffect(() => { if (url) frame.current?.focus(); }, [url, active]);
  useWakeLock(!!url && handheld);

  const sideways = active && handheld && !turned && want !== 'any' && (want === 'landscape' ? portrait : !portrait);
  const corner = prefs.exit ?? 'top-left';
  return (
    <div>
      <div className={'stage ink' + (immersive ? ' immersive' : '') + (active ? ' filled' : '')} ref={box}>
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

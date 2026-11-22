// The install popup: a dialog in the middle of the screen that asks players on phones and tablets to add HearthCade to
// their Home Screen, where games get the whole screen (install.ts says who and when). It opens by itself a moment after
// the page loads, never over a running game or another dialog, and never in the installed app. Not now puts it away for
// a week (for good after the third time); the footer's Install app link (InstallAppLink) opens it again at any time.
// On Android the Install button shows the browser's own install prompt; elsewhere the popup shows the steps.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { t } from './lib';
import { Button, Modal } from './ui';
import {
  androidPromptNeeded, holdInstallPrompt, INSTALL_PROMPT_KEY, installKind, installPrompt, installPromptHeld, isIPad, justInstalled,
  onInstallChange, promptDue, putAway, readPromptState, runInstallPrompt, thisDevice, type InstallKind,
} from './install';

const readState = () => { try { return readPromptState(localStorage.getItem(INSTALL_PROMPT_KEY)); } catch { return { n: 0, until: 0 }; } };
const save = (how: 'later' | 'got-it' | 'installed') => {
  try { localStorage.setItem(INSTALL_PROMPT_KEY, JSON.stringify(putAway(readState(), Date.now(), how))); } catch { /* private mode: it stays away for this page */ }
};

// the footer link opens the popup through this
let opener: (() => void) | null = null;
const useInstallTick = () => useSyncExternalStore(onInstallChange, () => `${!!installPrompt()}|${justInstalled()}|${installPromptHeld()}`);

/** What the popup can offer on this device right now, or null. */
function offer(): InstallKind | null {
  if (justInstalled()) return null;
  const d = thisDevice(), kind = installKind(d);
  if (kind === 'android' && androidPromptNeeded(d) && !installPrompt()) return null;
  return kind;
}

/** Keeps the popup closed while `on` (a game is running or starting on the page). */
export function useInstallHold(on: boolean) {
  useEffect(() => (on ? holdInstallPrompt() : undefined), [on]);
}

// another dialog is open, or a game fills the screen (the console's preview, the player's own menus)
const busyScreen = () => !!document.querySelector('.modal, [aria-modal="true"], .stage.filled') || document.documentElement.classList.contains('game-open');

export function InstallPrompt() {
  useInstallTick();
  const [open, setOpen] = useState(false);
  useEffect(() => { opener = () => setOpen(true); return () => { opener = null; }; }, []);
  // Opens by itself once per page load, a couple of seconds in, at the first moment nothing else is on screen.
  useEffect(() => {
    if (!promptDue(readState(), Date.now())) return;
    let tries = 0;
    const id = window.setInterval(() => {
      if (++tries > 90) { clearInterval(id); return; }   // three minutes without a free moment (or a prompt): not this time
      if (tries < 2 || !offer() || installPromptHeld() || busyScreen()) return;
      clearInterval(id); setOpen(true);
    }, 2000);
    return () => clearInterval(id);
  }, []);
  const kind = offer();
  if (!open || !kind || installPromptHeld()) return null;
  const close = (how: 'later' | 'got-it' | 'installed') => { save(how); setOpen(false); };
  const install = async () => { close((await runInstallPrompt()) ? 'installed' : 'later'); };
  return <InstallDialog kind={kind} canPrompt={!!installPrompt()} onInstall={install} onClose={close} />;
}

/** "Install app" in the footer, on phones and tablets that can add the site. */
export function InstallAppLink() {
  useInstallTick();
  if (!offer()) return null;
  return <Button size="sm" variant="ghost" onClick={() => opener?.()} icon={<PlusSquare />}>{t('Install app', '安装应用')}</Button>;
}

function InstallDialog({ kind, canPrompt, onInstall, onClose }: { kind: InstallKind; canPrompt: boolean; onInstall: () => void; onClose: (how: 'later' | 'got-it') => void }) {
  const d = thisDevice(), ipad = isIPad(d), ios = kind === 'ios-safari' || kind === 'ios-browser' || (kind === 'in-app' && !/Android/.test(d.userAgent));
  const steps: ReactNode[] = kind === 'ios-safari' ? [
    <>{t('Tap Share in Safari', '在 Safari 中点“分享”')} <Glyph><ShareIcon /></Glyph> <span className="ip-aside">{ipad ? t('On newer iPadOS it is in the ··· menu.', '较新的 iPadOS 在“···”菜单里。') : t('On newer iOS it is in the ··· menu.', '较新的 iOS 在“···”菜单里。')}</span></>,
    <>{t('Choose Add to Home Screen', '选择“添加到主屏幕”')} <Glyph><PlusSquare /></Glyph></>,
    t('Open HearthCade from your Home Screen', '从主屏幕打开 HearthCade'),
  ] : kind === 'ios-browser' ? [
    <>{t('Tap Share next to the address bar', '点地址栏旁的“分享”')} <Glyph><ShareIcon /></Glyph> <span className="ip-aside">{t('Or find Share in the browser menu.', '也可以在浏览器菜单里找到“分享”。')}</span></>,
    <>{t('Choose Add to Home Screen', '选择“添加到主屏幕”')} <Glyph><PlusSquare /></Glyph></>,
    t('Open HearthCade from your Home Screen', '从主屏幕打开 HearthCade'),
  ] : kind === 'in-app' ? [
    <>{t('Tap the menu in the top corner', '点右上角的菜单')} <Glyph><MoreIcon /></Glyph></>,
    ios ? t('Choose Open in Safari', '选择“在 Safari 中打开”') : t('Choose Open in browser', '选择“在浏览器中打开”'),
    t('Add HearthCade to your Home Screen from there', '然后在浏览器里把 HearthCade 添加到主屏幕'),
  ] : canPrompt ? [] : [
    <>{t('Open the browser menu', '打开浏览器菜单')} <Glyph><MoreIcon vertical /></Glyph></>,
    <>{t('Tap Install or Add to Home screen', '点“安装”或“添加到主屏幕”')} <Glyph><PlusSquare /></Glyph></>,
    t('Open HearthCade from your Home Screen', '从主屏幕打开 HearthCade'),
  ];
  const perks = [
    t('Every game gets the whole screen, with no browser bars', '每款游戏都能占满整个屏幕，没有浏览器地址栏'),
    ipad ? t('No “swipe down to exit” hint, and swipes stay in the game', '没有“下滑退出”提示，滑动操作不会打断游戏')
      : ios ? t('No bars sliding over the game while you play', '游玩时不会再有工具栏盖住游戏')
        : t('Opens straight into full screen, like an app', '像应用一样，一打开就是全屏'),
    t('One tap from your Home Screen. Nothing to download.', '从主屏幕一点即开，无需下载。'),
  ];
  return (
    <Modal onClose={() => onClose('later')}>
      <div className="ip">
        <div className="ip-head">
          <img className="ip-ico" src="/icons/icon-192.png" alt="" width="64" height="64" />
          <div>
            <h2 id="ip-h">{t('Play HearthCade like an app', '像应用一样玩 HearthCade')}</h2>
            <p className="mute">{kind === 'in-app' ? t('This page is open inside another app, which cannot add it to your Home Screen. Open it in your browser first.', '当前页面是在其他应用内打开的，无法添加到主屏幕。请先在浏览器中打开。') : t('Add it to your Home Screen for the best way to play on this device.', '把它添加到主屏幕，在这台设备上获得最佳游戏体验。')}</p>
          </div>
        </div>
        <ul className="ip-perks">{perks.map((p, i) => <li key={i}><Check />{p}</li>)}</ul>
        {steps.length > 0 && <ol className="ip-steps">{steps.map((s, i) => <li key={i}><b>{i + 1}</b><span>{s}</span></li>)}</ol>}
        {ios && kind !== 'in-app' && <p className="ip-note mute">{t('The Home Screen app keeps its own sign-in, so you may be asked to sign in once more there.', '主屏幕应用有独立的登录状态，首次打开时可能需要再登录一次。')}</p>}
        <div className="ip-act">
          {canPrompt && kind === 'android'
            ? <Button variant="primary" onClick={onInstall} icon={<PlusSquare />}>{t('Install', '安装')}</Button>
            : <Button variant="primary" onClick={() => onClose('got-it')}>{t('Got it', '知道了')}</Button>}
          <Button variant="ghost" onClick={() => onClose('later')}>{t('Not now', '以后再说')}</Button>
        </div>
      </div>
    </Modal>
  );
}

const Glyph = ({ children }: { children: ReactNode }) => <span className="ip-glyph" aria-hidden="true">{children}</span>;
const svg = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const ShareIcon = () => <svg {...svg}><path d="M12 3v12M8 7l4-4 4 4" /><path d="M7 10H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1" /></svg>;
const PlusSquare = () => <svg {...svg}><rect x="3.5" y="3.5" width="17" height="17" rx="4" /><path d="M12 8v8M8 12h8" /></svg>;
const MoreIcon = ({ vertical }: { vertical?: boolean }) => <svg {...svg} fill="currentColor" stroke="none">{(vertical ? [[12, 5], [12, 12], [12, 19]] : [[5, 12], [12, 12], [19, 12]]).map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="2" />)}</svg>;
const Check = () => <svg {...svg} width={16} height={16} strokeWidth={2.6} className="ip-check"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;

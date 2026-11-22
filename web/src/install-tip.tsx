// The one-time Add to Home Screen tip (install.ts says when). Shown on a game's page in Safari on iPhone and iPad while no
// game is running, never in the installed app. Got it or the close button puts it away for good on this device.
import { useState } from 'react';
import { t } from './lib';
import { INSTALL_TIP_KEY, isIPad, showInstallTip, thisDevice } from './install';

function dismissed(): boolean { try { return localStorage.getItem(INSTALL_TIP_KEY) === 'done'; } catch { return false; } }
function dismiss() { try { localStorage.setItem(INSTALL_TIP_KEY, 'done'); } catch { /* private mode: it stays away for this page */ } }

export function InstallTip({ hidden }: { hidden?: boolean }) {
  const [open, setOpen] = useState(() => showInstallTip(thisDevice(), dismissed()));
  if (!open || hidden) return null;
  const close = () => { dismiss(); setOpen(false); };
  const ipad = isIPad(thisDevice());
  return (
    <aside className="install-tip" role="dialog" aria-label={t('Add HearthCade to your Home Screen', '将 HearthCade 添加到主屏幕')}>
      <img className="install-tip-ico" src="/icons/icon-192.png" alt="" width="44" height="44" />
      <div className="install-tip-body">
        <b>{t('Play full screen, with no Safari bars', '全屏游玩，没有 Safari 地址栏')}</b>
        <span>{ipad
          ? t('Tap Share in Safari (in the ··· menu on newer iPadOS), then Add to Home Screen, and open HearthCade from there. Games then get the whole screen, with no swipe-down hint.', '在 Safari 中点“分享”（较新的 iPadOS 在“···”菜单里），再点“添加到主屏幕”，然后从主屏幕打开 HearthCade。游戏就能占满整个屏幕，也不会再出现下滑提示。')
          : t('Tap Share in Safari (in the ··· menu on newer iOS), then Add to Home Screen, and open HearthCade from there. Games then get the whole screen.', '在 Safari 中点“分享”（较新的 iOS 在“···”菜单里），再点“添加到主屏幕”，然后从主屏幕打开 HearthCade。游戏就能占满整个屏幕。')}</span>
        <button type="button" className="btn btn-primary btn-sm install-tip-ok" onClick={close}>{t('Got it', '知道了')}</button>
      </div>
      <button type="button" className="install-tip-x" onClick={close} aria-label={t('Close', '关闭')}>×</button>
    </aside>
  );
}

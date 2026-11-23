// Get the app (/download): HearthCade for Windows, macOS and Linux, and on the Home Screen of phones and tablets.
// Every one of them opens this site, so none needs a new download when the site changes (docs/apps.md). The desktop
// installers are not signed with a paid certificate, so the page says plainly how to get past the warning Windows and
// macOS show the first time. The installers' addresses are on this site (src/desktop.ts); the current version comes
// from /download/desktop/info.json, which says { available: false } until the first build is published.
import { useEffect, useState, type ReactNode } from 'react';
import { t } from '../lib';
import { Badge, Button, Card, Code, Notice, PageHeader, Section, Steps, Ticks } from '../ui';
import { desktopOs, desktopShell, DOWNLOAD, type DesktopOs } from '../desktop-app';
import { installKind, thisDevice } from '../install';
import { openInstallPrompt } from '../install-tip';

interface Info { available: boolean; version?: string; pub_date?: string }

const REPO = 'https://github.com/SanChai20/game-creator-platform';
const NAMES: Record<DesktopOs, string> = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };

export function Download() {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/download/desktop/info.json').then((r) => r.json()).then((j: Info) => { if (live) setInfo(j); }).catch(() => { if (live) setInfo({ available: false }); });
    return () => { live = false; };
  }, []);
  const d = thisDevice(), mine = desktopOs(d), shell = desktopShell(), ready = !!info?.available;
  const phone = !mine && !shell;
  const order: DesktopOs[] = mine ? [mine, ...(['windows', 'mac', 'linux'] as DesktopOs[]).filter((o) => o !== mine)] : ['windows', 'mac', 'linux'];
  const version = info?.version ? t('Version {v}', '版本 {v}', { v: info.version }) : null;

  return (
    <div className="wrap page get-app">
      <PageHeader eyebrow={t('Get the app', '下载应用')} title={t('HearthCade on every device', '在每台设备上玩 HearthCade')}
        sub={t('Every version opens the live HearthCade, so it is always up to date. When we change something, you get it the next time a page loads: nothing to download again.', '每个版本打开的都是线上的 HearthCade，因此始终是最新的。我们更新内容后，下次加载页面时就会生效，无需重新下载。')} />

      {shell && <Notice tone="good" title={t('You are using the desktop app', '你正在使用桌面应用')}>
        {t('It shows the live site and installs its own updates in the background, when you quit. There is nothing else to do.', '它显示的是线上站点，并会在你退出时于后台安装自身更新。你无需做任何事。')}
      </Notice>}

      {!shell && mine && (
        <Card pad className="get-app-hero">
          <div>
            <h2>{t('HearthCade for {os}', '适用于 {os} 的 HearthCade', { os: NAMES[mine] })}</h2>
            <p className="mute">{t('Its own window and icon, opens straight into the store, and games can fill the whole screen.', '独立的窗口和图标，打开即进入商店，游戏可以全屏运行。')}</p>
            {info && !ready && <p className="mute fs-sm">{t('The first build is on its way. Check back soon.', '首个版本即将发布，请稍后再来。')}</p>}
          </div>
          <div className="get-app-cta">
            <Button variant="primary" size="lg" href={ready ? DOWNLOAD[mine] : undefined} disabled={!ready}>{t('Download for {os}', '下载 {os} 版', { os: NAMES[mine] })}</Button>
            {version && <span className="dim fs-sm">{version} · {t('Free', '免费')}</span>}
          </div>
        </Card>
      )}

      {phone && <PhoneCard />}

      <Section title={t('Computers', '电脑')} sub={t('Windows 10 and 11, macOS 11 and later (Apple silicon and Intel), and 64-bit Linux.', '支持 Windows 10 和 11、macOS 11 及更高版本（Apple 芯片与 Intel），以及 64 位 Linux。')}>
        <div className="get-app-grid">
          {order.map((os) => <OsCard key={os} os={os} ready={ready} here={os === mine} />)}
        </div>
      </Section>

      <Section title={t('Why your computer asks before opening it', '为什么电脑会在打开前询问你')}>
        <Card pad>
          <p>{t('Windows and macOS warn about any app that is not signed with a paid developer certificate. HearthCade’s desktop app is not signed yet, so the first time you open it your computer asks you to confirm. The steps above show where. After that it opens like any other app.', 'Windows 和 macOS 会对未使用付费开发者证书签名的应用发出警告。HearthCade 桌面应用目前尚未签名，所以第一次打开时电脑会要求你确认，具体位置见上方步骤。之后它会像其他应用一样直接打开。')}</p>
          <Ticks items={[
            t('The app is only a window onto hearthcade.com. Games, your account and your library all live on the site.', '这个应用只是 hearthcade.com 的一个窗口。游戏、账户和游戏库都在网站上。'),
            t('Links to other sites open in your usual browser, not in the app.', '指向其他网站的链接会在你平常使用的浏览器中打开，而不是在应用里。'),
            <>{t('It is built in public from our repository, and every release lists its files.', '它由我们的公开代码仓库构建，每个版本都会列出其文件。')} <a href={`${REPO}/releases`} target="_blank" rel="noreferrer">{t('See the releases', '查看版本')}</a></>,
          ]} />
        </Card>
      </Section>

      <Section title={t('How updates work', '更新方式')}>
        <Card pad>
          <Ticks items={[
            t('Everything you see in the app comes from the site, so a change to the site reaches the app at once.', '应用中的一切都来自网站，所以网站的改动会立即出现在应用里。'),
            t('On rare occasions the app’s window itself gets an update. It downloads in the background and installs when you quit, so the next launch is up to date.', '极少数情况下，应用窗口本身会有更新。它会在后台下载，并在你退出时安装，下次启动即为最新。'),
            t('Phones and tablets: the Home Screen app is the site itself and is always current.', '手机和平板：主屏幕应用就是网站本身，始终是最新的。'),
          ]} />
        </Card>
      </Section>

      {!phone && <PhoneCard />}
    </div>
  );
}

function OsCard({ os, ready, here }: { os: DesktopOs; ready: boolean; here: boolean }) {
  const steps: ReactNode[] = os === 'windows' ? [
    t('Open HearthCade-Windows-x64-setup.exe from your downloads.', '在下载文件夹中打开 HearthCade-Windows-x64-setup.exe。'),
    <>{t('If Windows says “Windows protected your PC”, choose More info, then Run anyway.', '如果 Windows 提示“Windows 已保护你的电脑”，点“更多信息”，再点“仍要运行”。')}</>,
    t('HearthCade opens when it is installed, and stays in your Start menu.', '安装完成后 HearthCade 会自动打开，并保留在“开始”菜单中。'),
  ] : os === 'mac' ? [
    t('Open HearthCade-macOS.dmg and drag HearthCade into Applications.', '打开 HearthCade-macOS.dmg，把 HearthCade 拖进“应用程序”。'),
    t('Open HearthCade. When macOS says it cannot verify the app, choose Done.', '打开 HearthCade。macOS 提示无法验证该应用时，点“完成”。'),
    t('Open System Settings, then Privacy & Security. Scroll down and choose Open Anyway next to HearthCade, then confirm.', '打开“系统设置”中的“隐私与安全性”，向下滚动，在 HearthCade 旁点“仍要打开”，然后确认。'),
    t('On macOS 14 and earlier you can instead Control-click HearthCade in Applications and choose Open.', '在 macOS 14 及更早版本上，也可以在“应用程序”中按住 Control 点按 HearthCade，然后选择“打开”。'),
  ] : [
    <>{t('AppImage: allow it to run (in its Properties, or with the command below), then open it.', 'AppImage：允许其运行（在“属性”中设置，或使用下方命令），然后打开它。')}<Code text="chmod +x HearthCade-Linux-x86_64.AppImage" /></>,
    <>{t('Debian or Ubuntu: install the .deb package instead.', 'Debian 或 Ubuntu：也可以安装 .deb 软件包。')}<Code text="sudo apt install ./HearthCade-Linux-amd64.deb" /></>,
  ];
  return (
    <Card pad className={'get-app-os' + (here ? ' here' : '')}>
      <div className="get-app-os-head">
        <h3>{NAMES[os]}</h3>
        {here && <Badge tone="accent" dot={false}>{t('This computer', '这台电脑')}</Badge>}
      </div>
      <div className="get-app-os-act">
        <Button variant={here ? 'primary' : 'secondary'} href={ready ? DOWNLOAD[os] : undefined} disabled={!ready}>
          {os === 'windows' ? t('Download installer (.exe)', '下载安装程序（.exe）') : os === 'mac' ? t('Download disk image (.dmg)', '下载磁盘映像（.dmg）') : t('Download AppImage', '下载 AppImage')}
        </Button>
        {os === 'linux' && <Button variant="ghost" href={ready ? DOWNLOAD['linux-deb'] : undefined} disabled={!ready}>{t('Download .deb', '下载 .deb')}</Button>}
      </div>
      <p className="dim fs-sm">{t('The first time you open it', '第一次打开时')}</p>
      <Steps items={steps} />
    </Card>
  );
}

function PhoneCard() {
  const d = thisDevice(), kind = installKind(d);
  return (
    <Section title={t('Phones and tablets', '手机和平板')} sub={t('Add HearthCade to your Home Screen. It opens full screen with no browser bars, and there is nothing to download.', '把 HearthCade 添加到主屏幕。它会全屏打开，没有浏览器地址栏，也无需下载。')}>
      <Card pad>
        <div className="get-app-phone">
          <div>
            <h3>{t('iPhone and iPad', 'iPhone 和 iPad')}</h3>
            <Steps items={[t('Open hearthcade.com in Safari', '在 Safari 中打开 hearthcade.com'), t('Tap Share (in the ··· menu on newer iOS)', '点“分享”（较新的 iOS 在“···”菜单里）'), t('Choose Add to Home Screen', '选择“添加到主屏幕”')]} />
          </div>
          <div>
            <h3>Android</h3>
            <Steps items={[t('Open hearthcade.com in Chrome', '在 Chrome 中打开 hearthcade.com'), t('Open the browser menu', '打开浏览器菜单'), t('Tap Install app or Add to Home screen', '点“安装应用”或“添加到主屏幕”')]} />
          </div>
        </div>
        {kind && !desktopOs(d) && <Button variant="primary" onClick={() => openInstallPrompt()}>{t('Add to Home Screen', '添加到主屏幕')}</Button>}
      </Card>
    </Section>
  );
}

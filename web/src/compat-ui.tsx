// The store page's Compatibility section and the verdict shown before launch: the game's requirements, row by row,
// each checked against this browser (web/src/compat-probe.ts) with the shared rules in web/src/compat.ts.
import { useEffect, useState, type ReactNode } from 'react';
import { evaluate, type Compat, type Device, type Feature, type Graphics, type Input, type Requirements, type Row, type Verdict } from './compat';
import { probe } from './compat-probe';
import { t } from './lib';
import { Button } from './ui';

export type GameCompat = Pick<Compat, 'requirements' | 'declared' | 'download_bytes'>;

/** The verdict for this browser, or null while it is being measured (or when the game has no requirements on record). */
export function useCompat(c: GameCompat | null | undefined): Verdict | null {
  const [v, setV] = useState<Verdict | null>(null);
  const key = c ? JSON.stringify(c.requirements) : '';
  useEffect(() => {
    if (!c) { setV(null); return; }
    let live = true;
    probe().then((p) => { if (live) setV(evaluate(c.requirements, p, c.download_bytes)); }, () => {});
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return v;
}

const graphicsName = (g: Graphics | string) => ({ none: t('No graphics API', '无需图形接口'), canvas: 'Canvas 2D', webgl: 'WebGL', webgl2: 'WebGL 2', webgpu: 'WebGPU' } as Record<string, string>)[g] ?? g;
const featureName = (f: Feature | string): string => ({
  'webassembly': 'WebAssembly', 'wasm-simd': 'WebAssembly SIMD', 'wasm-threads': t('WebAssembly threads', 'WebAssembly 多线程'), 'webgpu': 'WebGPU',
  'web-audio': 'Web Audio', 'audio-worklet': t('Audio worklets', '音频工作线程（AudioWorklet）'), 'pointer-lock': t('Pointer lock (mouse look)', '指针锁定（鼠标视角）'),
  'fullscreen': t('Fullscreen', '全屏'), 'web-workers': t('Background workers', '后台线程（Web Worker）'), 'offscreen-canvas': 'OffscreenCanvas', 'indexeddb': t('Local storage (IndexedDB)', '本地存储（IndexedDB）'),
  'webxr': t('VR and AR (WebXR)', 'VR 与 AR（WebXR）'), 'webrtc': t('Peer-to-peer connections (WebRTC)', '点对点连接（WebRTC）'), 'es-modules': t('JavaScript modules', 'JavaScript 模块'),
  'import-maps': t('Import maps', '导入映射（Import maps）'), 'device-motion': t('Motion sensors', '运动传感器'),
} as Record<string, string>)[f] ?? f;
const inputName = (i: Input | string) => ({ keyboard: t('Keyboard', '键盘'), mouse: t('Mouse', '鼠标'), touch: t('Touch', '触屏'), gamepad: t('Controller', '手柄') } as Record<string, string>)[i] ?? i;
const deviceName = (d: Device | string) => ({ desktop: t('Computer', '电脑'), tablet: t('Tablet', '平板'), mobile: t('Phone', '手机') } as Record<string, string>)[d] ?? d;
const osName = (o: string) => ({ windows: 'Windows', macos: 'macOS', linux: 'Linux', chromeos: 'ChromeOS', android: 'Android', ios: 'iOS / iPadOS' } as Record<string, string>)[o] ?? o;
const browserName = (b: string) => ({ chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', safari: 'Safari', samsung: 'Samsung Internet', opera: 'Opera' } as Record<string, string>)[b] ?? b;
const join = (xs: string[]) => xs.join(' · ');

/** What a row asks for and what this browser said, in the player's words. */
function rowText(r: Row): { label: ReactNode; detail: ReactNode } {
  const s = r.state;
  switch (r.kind) {
    case 'graphics': return { label: t('{api} graphics', '{api} 图形', { api: graphicsName(r.need) }), detail: s === 'ok' ? t('Your browser has it', '你的浏览器支持') : s === 'no' ? (r.have && r.have !== 'none' && r.have !== 'canvas' ? t('Your browser has only {api}. Update it, or turn on hardware acceleration in its settings and restart it.', '你的浏览器仅支持 {api}。请更新浏览器，或在设置中开启硬件加速后重新启动浏览器。', { api: graphicsName(r.have) }) : t('Turned off or blocked in this browser. Turn on hardware acceleration in its settings and restart it, or try another browser.', '此浏览器已关闭或屏蔽该功能。请在设置中开启硬件加速后重新启动浏览器，或换用其他浏览器。')) : t('Could not be checked', '无法检测') };
    case 'gpu': return { label: t('Hardware graphics acceleration', '硬件图形加速'), detail: s === 'ok' ? t('Your graphics card is in use', '正在使用你的显卡') : s === 'no' ? t('Your browser is drawing in software. Turn on hardware acceleration in its settings.', '你的浏览器正在使用软件渲染，请在设置中开启硬件加速。') : t('Your browser does not say which renderer it uses', '你的浏览器未提供渲染器信息') };
    case 'feature': return { label: featureName(r.need), detail: s === 'ok' ? t('Your browser supports it', '你的浏览器支持') : s === 'no' ? t('Not available in this browser', '此浏览器不支持') : t('Checked when the game starts', '将在游戏启动时检测') };
    case 'optional': return { label: <>{featureName(r.need)} <span className="dim">· {t('optional', '可选')}</span></>, detail: s === 'ok' ? t('Available: the game uses it', '可用：游戏会使用它') : t('Not available. The game works without it.', '不可用，但游戏无需它也能运行。') };
    case 'input': return { label: t('Play with {inputs}', '操作方式：{inputs}', { inputs: join(r.need.split(',').map(inputName)) }), detail: s === 'ok' ? t('This device has one of these', '此设备支持其中一种') : s === 'no' ? t('This device has none of these', '此设备不支持其中任何一种') : r.need.includes('gamepad') ? t('Connect a controller or keyboard if you have one', '如有手柄或键盘，请连接') : t('A keyboard may be needed', '可能需要键盘') };
    case 'device': return { label: t('Made for {devices}', '适用设备：{devices}', { devices: join(r.need.split(',').map(deviceName)) }), detail: s === 'ok' ? t('Includes your {device}', '包括你的{device}', { device: deviceName(r.have || '') }) : t('Not made for your {device}', '不适用于你的{device}', { device: deviceName(r.have || '') }) };
    case 'orientation': return { label: r.need === 'landscape' ? t('Best played in landscape', '建议横屏游玩') : t('Best played in portrait', '建议竖屏游玩'), detail: s === 'ok' ? t('Your screen fits', '你的屏幕方向合适') : t('Rotate your device', '请旋转你的设备') };
    case 'memory': return { label: t('{gb} GB of memory or more', '{gb} GB 或以上内存', { gb: r.need }), detail: s === 'ok' ? t('This device has enough', '此设备内存充足') : s === 'no' ? t('This device reports {gb} GB', '此设备报告 {gb} GB', { gb: r.have || '?' }) : t('Your browser does not report memory', '你的浏览器不提供内存信息') };
    case 'browser': { const [b, v] = r.need.split(' '); return { label: t('{browser} {version} or newer', '{browser} {version} 或更新版本', { browser: browserName(b), version: v }), detail: s === 'ok' ? t('You have {have}', '你使用的是 {have}', { have: r.have || '' }) : s === 'no' ? t('You have {have}. Update your browser.', '你使用的是 {have}，请更新浏览器。', { have: r.have || '' }) : t('Your browser version could not be read', '无法读取浏览器版本') }; }
    case 'issue': { const where = [r.issue?.browser && browserName(r.issue.browser), r.issue?.os && osName(r.issue.os)].filter(Boolean).join(' · '); return { label: r.issue?.severity === 'broken' ? t('Known not to work on {where}', '已知在 {where} 上无法运行', { where }) : t('Known issue on {where}', '{where} 上的已知问题', { where }), detail: r.need }; }
    case 'download': return { label: t('Download size', '下载大小'), detail: r.need };
  }
}

const mark = (s: Row['state']) => s === 'ok' ? '✓' : s === 'no' ? '✕' : s === 'unknown' ? '?' : 'i';

/** The one-line verdict: works here, may not, or does not. */
export function CompatPill({ v, big }: { v: Verdict | null; big?: boolean }) {
  if (!v) return <span className={'cpill wait' + (big ? ' big' : '')}><i aria-hidden="true">…</i>{t('Checking your browser', '正在检测你的浏览器')}</span>;
  const first = v.blockers[0] && rowText(v.blockers[0]).label;
  return (
    <span className={`cpill c-${v.verdict}` + (big ? ' big' : '')} role="status">
      <i aria-hidden="true">{v.verdict === 'ok' ? '✓' : v.verdict === 'no' ? '✕' : '!'}</i>
      {/* one text box, so the reason wraps under the verdict instead of standing beside it as a second column */}
      <span>{v.verdict === 'ok' ? t('Works on this device', '可在此设备上运行') : v.verdict === 'maybe' ? t('Should work: some things are checked at launch', '应该可以运行：部分项目将在启动时检测') : <>{t('Not supported on this device', '此设备不受支持')}{first && <span className="cpill-why"> · {first}</span>}</>}</span>
    </span>
  );
}

/** The Compatibility section on the store page. */
export function CompatSection({ c, v }: { c: GameCompat; v: Verdict | null }) {
  const r: Requirements = c.requirements;
  const rows = v ? v.rows : [];
  return (
    <section className="stack l compat" id="compatibility">
      <div className="compat-head">
        <h2 className="compat-title">{t('Compatibility', '兼容性')}</h2>
        <CompatPill v={v} />
      </div>
      <div className="compat-grid">
        {rows.map((row) => { const x = rowText(row); return (
          <div key={row.id} className={`crow s-${row.state}`}>
            <i className="cmark" aria-label={row.state}>{mark(row.state)}</i>
            <div><b>{x.label}</b><span>{x.detail}</span></div>
          </div>
        ); })}
        {!v && <div className="crow s-info"><i className="cmark">…</i><div><b>{t('Checking your browser', '正在检测你的浏览器')}</b><span>{t('This takes a moment.', '请稍候。')}</span></div></div>}
      </div>
      {r.notes && <p className="compat-notes"><span className="eyebrow">{t('From the creator', '来自作者')}</span> {r.notes}</p>}
      <p className="dim fs-sm">{c.declared
        ? t('Requirements listed by the creator and checked by the platform against the game\'s code. Your browser was checked on this device just now; nothing was sent anywhere.', '要求由作者列出，并由平台对照游戏代码核对。刚才已在此设备上检测了你的浏览器，没有发送任何数据。')
        : t('Requirements detected by the platform from the game\'s code; the creator has not listed them yet. Your browser was checked on this device just now; nothing was sent anywhere.', '要求由平台根据游戏代码检测得出，作者尚未列出。刚才已在此设备上检测了你的浏览器，没有发送任何数据。')}</p>
    </section>
  );
}

/** Before launch on a device that fails the check: what is missing, and the choice to play anyway. */
export function CompatGate({ v, onPlay, onCancel }: { v: Verdict; onPlay: () => void; onCancel: () => void }) {
  return (
    <div className="cgate" role="alertdialog" aria-label={t('Not supported on this device', '此设备不受支持')}>
      <b>✕ {t('This game may not run here', '这款游戏可能无法在此运行')}</b>
      <ul>{v.blockers.slice(0, 3).map((r) => { const x = rowText(r); return <li key={r.id}><b>{x.label}</b> · {x.detail}</li>; })}</ul>
      <div className="row"><Button size="sm" variant="ghost" onClick={onCancel}>{t('Cancel', '取消')}</Button><Button size="sm" onClick={onPlay}>{t('Play anyway', '仍然游玩')}</Button></div>
      <a className="dim fs-sm" href="#compatibility">{t('See all requirements', '查看全部要求')}</a>
    </div>
  );
}

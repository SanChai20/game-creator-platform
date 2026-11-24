// "Notifications on this device" on the Account page: turn push on or off for this browser, choose the kinds, send a
// test. iPhone and iPad only allow it in the Home Screen app, so there it says how to get one. web/src/pwa.ts does the work.
import { useEffect, useState, type ReactNode } from 'react';
import { t } from './lib';
import { Button, Notice, Switch } from './ui';
import { pushState, setPushKinds, testPush, turnPushOff, turnPushOn, type PushState } from './pwa';

export function PushSettings() {
  const [st, setSt] = useState<PushState | null>(null), [off, setOff] = useState<string[]>([]), [busy, setBusy] = useState(false), [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { void pushState().then((r) => { setSt(r.state); setOff(r.off); }, () => setSt('unsupported')); }, []);
  if (!st) return <div className="mute">{t('Loading…', '加载中…')}</div>;
  const run = async (fn: () => Promise<void>) => { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } setBusy(false); };
  const on = () => run(async () => {
    const s = await turnPushOn(); setSt(s);
    if (s === 'on') setMsg({ ok: true, text: (await testPush()) ? t('Notifications are on. A test notification is on its way.', '通知已开启，测试通知马上就到。') : t('Notifications are on.', '通知已开启。') });
  });
  const kind = (k: string, yes: boolean) => run(async () => { setOff(await setPushKinds(yes ? off.filter((x) => x !== k) : [...off, k])); });
  const row = (label: ReactNode, el: ReactNode) => <label className="fr-set"><span>{label}</span>{el}</label>;
  const note = msg && <Notice tone={msg.ok ? 'good' : 'bad'} role="status">{msg.text}</Notice>;
  if (st === 'needs-install') return <p className="mute">{t('On iPhone and iPad, notifications work in the HearthCade app on your Home Screen. Add it from Safari (Share, then Add to Home Screen), open it from there and turn them on here.', '在 iPhone 和 iPad 上，需要从主屏幕上的 HearthCade 应用接收通知。请先在 Safari 中添加（分享，然后“添加到主屏幕”），再从主屏幕打开并在这里开启。')}</p>;
  if (st === 'unsupported') return <p className="mute">{t('This browser cannot show notifications from websites. Try Chrome, Edge, Firefox or Safari.', '此浏览器无法显示网站通知。请使用 Chrome、Edge、Firefox 或 Safari。')}</p>;
  if (st === 'blocked') return <p className="mute">{t('Notifications are blocked for HearthCade in this browser. Allow them in the browser’s site settings, then come back here.', '此浏览器已屏蔽 HearthCade 的通知。请在浏览器的网站设置中允许通知，然后回到这里。')}</p>;
  if (st === 'off') return <div className="stack">
    <p className="mute">{t('Get a notification when a friend sends you a request, a message or an invite, or a creator you follow publishes a new game, while HearthCade is closed.', 'HearthCade 未打开时，好友向你发送请求、消息或邀请，或你关注的创作者发布新游戏，你也会收到通知。')}</p>
    <div><Button variant="primary" onClick={on} disabled={busy}>{t('Turn on notifications', '开启通知')}</Button></div>
    {note}
  </div>;
  return <div className="fr-settings">
    {row(t('Friend requests', '好友请求'), <Switch checked={!off.includes('requests')} disabled={busy} onChange={(e) => void kind('requests', e.target.checked)} />)}
    {row(t('Game invites', '游戏邀请'), <Switch checked={!off.includes('invites')} disabled={busy} onChange={(e) => void kind('invites', e.target.checked)} />)}
    {row(t('Messages', '消息'), <Switch checked={!off.includes('messages')} disabled={busy} onChange={(e) => void kind('messages', e.target.checked)} />)}
    {row(t('Gifts', '礼物'), <Switch checked={!off.includes('gifts')} disabled={busy} onChange={(e) => void kind('gifts', e.target.checked)} />)}
    {row(t('New games from creators you follow', '关注的创作者发布新游戏'), <Switch checked={!off.includes('creators')} disabled={busy} onChange={(e) => void kind('creators', e.target.checked)} />)}
    <div className="row">
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => { setMsg((await testPush()) ? { ok: true, text: t('A test notification is on its way.', '测试通知马上就到。') } : { ok: false, text: t('The test could not be sent. Turn notifications off and on again.', '测试通知发送失败。请关闭后重新开启通知。') }); })}>{t('Send a test', '发送测试通知')}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => { setSt(await turnPushOff()); })}>{t('Turn off on this device', '在此设备上关闭')}</Button>
    </div>
    {note}
  </div>;
}

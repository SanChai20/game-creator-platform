import { useMemo, useState, type FormEvent } from 'react';
import qrcode from 'qrcode-generator';
import { announceAuth } from '../account-sync';
import { ago, api, navigate, t, useApp, useData } from '../lib';
import { Badge, Button, Card, Field, Input, Notice, PageHeader } from '../ui';
import { PageSkeleton } from '../skeletons';
import { FriendsSettings } from '../social';
import { PushSettings } from '../push-ui';

interface TwoFactor { enabled: boolean; enabled_at: number | null; recovery_left: number }
interface AccountData { created_at: number; sessions: { created_at: number; ua: string; current: boolean }[]; delete_blocker: string | null; two_factor: TwoFactor }

/** A rough name for the browser a sign-in came from, from its user agent. */
function deviceOf(ua: string) {
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [b, os].filter(Boolean).join(' · ') || t('Unknown device', '未知设备');
}

/** The signed-in person's own account: password, where they are signed in, and deleting the account. */
export function Account() {
  const { user, refresh } = useApp(), { data, reload } = useData<AccountData>('/account');
  const [cur, setCur] = useState(''), [pw, setPw] = useState(''), [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null), [busy, setBusy] = useState('');
  const [endMsg, setEndMsg] = useState(''), [delPw, setDelPw] = useState(''), [sure, setSure] = useState(false), [delErr, setDelErr] = useState('');
  if (!user || !data) return <PageSkeleton />;
  const changePassword = async (e: FormEvent) => {
    e.preventDefault(); setPwMsg(null); setBusy('pw');
    try {
      await api('/auth/password', { body: { current: cur, password: pw } });
      setCur(''); setPw(''); setPwMsg({ ok: true, text: t('Password changed. Every other sign-in was ended.', '密码已修改，其他所有登录已退出。') }); void reload();
    } catch (x) { setPwMsg({ ok: false, text: (x as Error).message }); }
    setBusy('');
  };
  const endOthers = async () => {
    setBusy('end');
    try { const r = await api<{ ended: number }>('/auth/sessions/end-others', { body: {} }); setEndMsg(r.ended === 1 ? t('1 other sign-in was ended.', '已退出 1 个其他登录。') : t('{n} other sign-ins were ended.', '已退出 {n} 个其他登录。', { n: r.ended })); void reload(); }
    catch (x) { setEndMsg((x as Error).message); }
    setBusy('');
  };
  const deleteIt = async (e: FormEvent) => {
    e.preventDefault(); setDelErr(''); setBusy('del');
    try { await api('/account/delete', { body: { password: delPw } }); announceAuth(); await refresh(); navigate('/', true); }
    catch (x) { setDelErr((x as Error).message); setBusy(''); }
  };
  const others = data.sessions.filter((s) => !s.current).length;
  return (
    <div className="wrap page account">
      <PageHeader eyebrow={t('Account', '账户')} title={user.name} sub={<>{user.email} · {t('Joined {when}', '{when}加入', { when: ago(data.created_at) })}</>} />
      <div className="stack l">
        <Card title={t('Password', '密码')} pad>
          <form onSubmit={changePassword} className="stack">
            <Field label={t('Current password', '当前密码')}><Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} required autoComplete="current-password" /></Field>
            <Field label={t('New password', '新密码')} hint={t('At least 8 characters.', '至少 8 个字符。')}><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={8} autoComplete="new-password" /></Field>
            {pwMsg && <Notice tone={pwMsg.ok ? 'good' : 'bad'} role="alert">{pwMsg.text}</Notice>}
            <div><Button type="submit" variant="primary" disabled={busy === 'pw'}>{t('Change password', '修改密码')}</Button></div>
          </form>
        </Card>
        <Card title={t('Friends and privacy', '好友与隐私')} pad><FriendsSettings /></Card>
        <Card title={t('Notifications on this device', '此设备上的通知')} pad><PushSettings /></Card>
        <TwoFactorCard state={data.two_factor} creator={user.creator} reload={reload} />
        <Card title={t('Where you are signed in', '登录设备')} pad>
          <div className="stack">
            <ul className="acct-list stack s">
              {data.sessions.map((s, i) => <li key={i} className="row"><b>{deviceOf(s.ua)}</b><span className="mute fs-sm">{t('signed in {when}', '{when}登录', { when: ago(s.created_at) })}</span>{s.current && <span className="sig fs-sm">{t('this browser', '当前浏览器')}</span>}</li>)}
            </ul>
            {endMsg && <Notice tone="good" role="status">{endMsg}</Notice>}
            <div><Button onClick={endOthers} disabled={busy === 'end' || others === 0}>{t('Sign out everywhere else', '退出其他所有设备')}</Button></div>
          </div>
        </Card>
        <Card title={t('Delete your account', '删除账户')} pad>
          <form onSubmit={deleteIt} className="stack">
            <p className="mute">{t('This removes your email, name, password, saves, stats, scores and reviews, and signs you out everywhere. Your purchase records are kept, because the law requires us to keep them, but no longer show who you are. It cannot be undone.', '这会删除你的邮箱、名称、密码、存档、统计、分数和评价，并在所有设备上退出登录。购买记录依法保留，但不再显示你是谁。此操作无法撤销。')}</p>
            {data.delete_blocker ? <Notice tone="info">{data.delete_blocker}</Notice> : <>
              <Field label={t('Your password', '你的密码')}><Input type="password" value={delPw} onChange={(e) => setDelPw(e.target.value)} required autoComplete="current-password" /></Field>
              <label className="row fs-sm"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> {t('I understand that my account and progress are gone for good.', '我了解我的账户和进度将被永久删除。')}</label>
              {delErr && <Notice tone="bad" role="alert">{delErr}</Notice>}
              <div><Button type="submit" variant="danger" disabled={!sure || busy === 'del'}>{t('Delete my account', '删除我的账户')}</Button></div>
            </>}
          </form>
        </Card>
      </div>
    </div>
  );
}

/** The otpauth link as a QR code, drawn as one SVG path (black on white, as authenticator apps expect, in either theme). */
function Qr({ text }: { text: string }) {
  const { d, n } = useMemo(() => {
    const q = qrcode(0, 'M'); q.addData(text); q.make();
    const n = q.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
    return { d, n };
  }, [text]);
  return <svg className="qr" viewBox={`0 0 ${n + 4} ${n + 4}`} role="img" aria-label={t('QR code for your authenticator app', '用于身份验证器应用的二维码')} shapeRendering="crispEdges"><rect width={n + 4} height={n + 4} fill="#fff" /><path d={d} fill="#000" /></svg>;
}

/** Recovery codes, shown once: copy them or save them as a text file. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { config } = useApp(), [saved, setSaved] = useState(false), [copied, setCopied] = useState(false);
  const text = `${config.settings.brand_name} ${t('recovery codes', '恢复码')}\n${codes.join('\n')}\n`;
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* the codes stay on screen to copy by hand */ } };
  const download = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = 'recovery-codes.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
  return (
    <div className="stack">
      <Notice tone="info" title={t('Save your recovery codes', '保存你的恢复码')}>{t('If you lose your phone, each of these codes signs you in once instead of the authenticator. Keep them somewhere safe, like a password manager. This is the only time they are shown.', '如果手机丢失，每个恢复码都可以代替身份验证器登录一次。请把它们保存在安全的地方，例如密码管理器。恢复码只会显示这一次。')}</Notice>
      <ol className="rc-list mono">{codes.map((c) => <li key={c}>{c}</li>)}</ol>
      <div className="row wrapx"><Button onClick={copy}>{copied ? t('Copied', '已复制') : t('Copy', '复制')}</Button><Button onClick={download}>{t('Download', '下载')}</Button></div>
      <label className="row fs-sm"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> {t('I saved my recovery codes.', '我已保存恢复码。')}</label>
      <div><Button variant="primary" disabled={!saved} onClick={onDone}>{t('Done', '完成')}</Button></div>
    </div>
  );
}

/**
 * Two-factor sign-in, the same for every account (players and creators sign in through the same login). Turning it on:
 * the password, then the QR code (or the key typed in), then a code from the app, then the recovery codes, shown once.
 */
function TwoFactorCard({ state, creator, reload }: { state: TwoFactor; creator: boolean; reload: () => Promise<void> }) {
  type Step = 'idle' | 'password' | 'scan' | 'codes' | 'disable' | 'regen';
  const [step, setStep] = useState<Step>('idle'), [pw, setPw] = useState(''), [code, setCode] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null), [codes, setCodes] = useState<string[]>([]), [msg, setMsg] = useState('');
  const reset = (s: Step = 'idle') => { setStep(s); setPw(''); setCode(''); setErr(''); setBusy(false); };
  const run = async (fn: () => Promise<void>) => { setErr(''); setBusy(true); try { await fn(); } catch (x) { setErr((x as Error).message); } setBusy(false); };
  const start = (e: FormEvent) => { e.preventDefault(); void run(async () => { setSetup(await api('/account/2fa/setup', { body: { password: pw } })); setPw(''); setStep('scan'); }); };
  const enable = (e: FormEvent) => { e.preventDefault(); void run(async () => { const r = await api<{ recovery_codes: string[] }>('/account/2fa/enable', { body: { code } }); setCodes(r.recovery_codes); setSetup(null); setCode(''); setStep('codes'); }); };
  const disable = (e: FormEvent) => { e.preventDefault(); void run(async () => { await api('/account/2fa/disable', { body: { password: pw, code } }); reset(); setMsg(t('Two-factor sign-in is off.', '两步验证登录已关闭。')); await reload(); }); };
  const regen = (e: FormEvent) => { e.preventDefault(); void run(async () => { const r = await api<{ recovery_codes: string[] }>('/account/2fa/recovery-codes', { body: { password: pw, code } }); setCodes(r.recovery_codes); setPw(''); setCode(''); setStep('codes'); }); };
  const done = () => { setCodes([]); reset(); setMsg(t('Two-factor sign-in is on. Every other sign-in was ended.', '两步验证登录已开启，其他所有登录已退出。')); void reload(); };
  const codeField = <Field label={t('Code from your authenticator app, or a recovery code', '身份验证器应用中的验证码，或一个恢复码')}><Input value={code} onChange={(e) => setCode(e.target.value)} required mono autoComplete="one-time-code" maxLength={20} /></Field>;
  const errLine = err && <Notice tone="bad" role="alert">{err}</Notice>;
  return (
    <Card title={t('Two-factor sign-in', '两步验证登录')} aside={state.enabled ? <Badge tone="good">{t('On', '已开启')}</Badge> : <Badge>{t('Off', '未开启')}</Badge>} pad>
      <div className="stack">
        {step === 'codes' ? <RecoveryCodes codes={codes} onDone={done} /> : step === 'scan' && setup ? (
          <form onSubmit={enable} className="stack">
            <div className="tfa-setup">
              <Qr text={setup.uri} />
              <div className="stack s">
                <b>{t('1. Scan this QR code with your authenticator app', '1. 用身份验证器应用扫描此二维码')}</b>
                <span className="mute fs-sm">{t('Google Authenticator, Microsoft Authenticator, 1Password, Authy or any app that supports authenticator codes. On this phone? Tap the link instead.', '可使用 Google Authenticator、Microsoft Authenticator、1Password、Authy 或任何支持验证码的应用。在这台手机上？直接点击链接即可。')}</span>
                <a className="sig fs-sm" href={setup.uri}>{t('Open in authenticator app', '在身份验证器应用中打开')}</a>
                <span className="mute fs-sm">{t('Or enter this key by hand:', '或手动输入此密钥：')}</span>
                <code className="tfa-key">{setup.secret.match(/.{1,4}/g)!.join(' ')}</code>
              </div>
            </div>
            <Field label={t('2. Enter the 6-digit code the app shows', '2. 输入应用显示的 6 位验证码')}><Input value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} required mono autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" placeholder="123456" className="otp" /></Field>
            {errLine}
            <div className="row wrapx"><Button type="submit" variant="primary" disabled={busy || code.length !== 6}>{t('Turn on', '开启')}</Button><Button variant="ghost" onClick={() => { setSetup(null); reset(); }}>{t('Cancel', '取消')}</Button></div>
          </form>
        ) : step === 'password' ? (
          <form onSubmit={start} className="stack">
            <Field label={t('Your password', '你的密码')}><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required autoFocus autoComplete="current-password" /></Field>
            {errLine}
            <div className="row wrapx"><Button type="submit" variant="primary" disabled={busy}>{t('Continue', '继续')}</Button><Button variant="ghost" onClick={() => reset()}>{t('Cancel', '取消')}</Button></div>
          </form>
        ) : step === 'disable' || step === 'regen' ? (
          <form onSubmit={step === 'disable' ? disable : regen} className="stack">
            <p className="mute">{step === 'disable'
              ? t('Your account will be protected by your password alone. Your recovery codes stop working.', '你的账户将只受密码保护，恢复码也将失效。')
              : t('You get ten new recovery codes. The ones you have now stop working.', '你将获得十个新的恢复码，现有的恢复码将失效。')}</p>
            <Field label={t('Your password', '你的密码')}><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required autoFocus autoComplete="current-password" /></Field>
            {codeField}
            {errLine}
            <div className="row wrapx"><Button type="submit" variant={step === 'disable' ? 'danger' : 'primary'} disabled={busy}>{step === 'disable' ? t('Turn off two-factor sign-in', '关闭两步验证登录') : t('Get new recovery codes', '获取新的恢复码')}</Button><Button variant="ghost" onClick={() => reset()}>{t('Cancel', '取消')}</Button></div>
          </form>
        ) : state.enabled ? <>
          <p className="mute">{t('Signing in asks for a code from your authenticator app after your password. On since {when}.', '登录时，输入密码后还需要输入身份验证器应用中的验证码。开启于{when}。', { when: ago(state.enabled_at!) })}</p>
          {state.recovery_left <= 3
            ? <Notice tone="bad">{state.recovery_left === 0 ? t('You have no recovery codes left. Get new ones so you can still sign in if you lose your phone.', '你已没有可用的恢复码。请获取新的恢复码，以免手机丢失后无法登录。') : t('Only {n} recovery codes left. Get new ones so you can still sign in if you lose your phone.', '仅剩 {n} 个恢复码。请获取新的恢复码，以免手机丢失后无法登录。', { n: state.recovery_left })}</Notice>
            : <p className="mute fs-sm">{t('{n} recovery codes left.', '剩余 {n} 个恢复码。', { n: state.recovery_left })}</p>}
          {msg && <Notice tone="good" role="status">{msg}</Notice>}
          <div className="row wrapx"><Button onClick={() => { setMsg(''); reset('regen'); }}>{t('New recovery codes', '新的恢复码')}</Button><Button variant="danger" onClick={() => { setMsg(''); reset('disable'); }}>{t('Turn off', '关闭')}</Button></div>
        </> : <>
          <p className="mute">{t('Add a second step to signing in: after your password, a 6-digit code from an authenticator app on your phone. Someone who learns your password still cannot get in.', '为登录增加第二步：输入密码后，还需输入手机上身份验证器应用生成的 6 位验证码。即使有人知道你的密码，也无法登录。')}</p>
          {creator && <p className="mute fs-sm">{t('Recommended for creators: it also protects your games, your earnings and the agents you connected.', '推荐创作者开启：它还能保护你的游戏、收益和已连接的智能体。')}</p>}
          {msg && <Notice tone="good" role="status">{msg}</Notice>}
          <div><Button variant="primary" onClick={() => { setMsg(''); reset('password'); }}>{t('Turn on two-factor sign-in', '开启两步验证登录')}</Button></div>
        </>}
      </div>
    </Card>
  );
}

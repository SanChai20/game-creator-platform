import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import qrcode from 'qrcode-generator';
import { announceAuth } from '../account-sync';
import { ago, api, ApiError, navigate, t, useApp, useData } from '../lib';
import { Badge, Button, Card, Field, Input, Modal, Notice } from '../ui';
import { PageSkeleton } from '../skeletons';
import { FriendsSettings } from '../social';
import { PushSettings } from '../push-ui';
import { authError } from './Auth';
import { createPasskey, getPasskey, passkeyCancelled, passkeysSupported } from '../passkey';

interface TwoFactor { enabled: boolean; enabled_at: number | null; recovery_left: number }
interface Passkey { id: string; name: string; created_at: number; last_used_at: number | null }
interface Session { created_at: number; ua: string; method: string | null; current: boolean }
interface AccountData { created_at: number; email_verified_at: number | null; sessions: Session[]; passkeys: Passkey[]; confirmed_until: number; delete_blocker: string | null; two_factor: TwoFactor }

/** A rough name for the browser a sign-in came from, from its user agent. */
function deviceOf(ua: string) {
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [b, os].filter(Boolean).join(' · ') || t('Unknown device', '未知设备');
}
const methodOf = (m: string | null) => m === 'passkey' ? t('with a passkey', '使用通行密钥') : m === 'link' ? t('with the sign-up link', '通过注册链接') : m === 'email' ? t('with an email code', '使用邮箱验证码') : '';

// ---- confirming it is you ------------------------------------------------------------------------------------------
/**
 * Sensitive changes (two-factor, passkeys, deleting the account) need a fresh proof that the person at this sign-in is
 * its owner: signing in counts for ten minutes, after that a passkey or a code we email. `run` tries the change and,
 * when the server asks for that proof, opens the dialog and tries again once it is given.
 */
function useConfirmGate(hasPasskey: boolean, reload: () => Promise<void>) {
  const [pending, setPending] = useState<null | { fn: () => Promise<void>; fail: (e: unknown) => void }>(null);
  const run = (fn: () => Promise<void>) => new Promise<void>((resolve, reject) => {
    fn().then(resolve, (e) => {
      if (e instanceof ApiError && e.code === 'confirm_required') setPending({ fn: () => fn().then(resolve, reject), fail: reject });
      else reject(e);
    });
  });
  const dialog = pending && <ConfirmDialog hasPasskey={hasPasskey} onClose={() => { pending.fail(new Error(t('Not confirmed. Nothing was changed.', '未确认，未做任何更改。'))); setPending(null); }}
    onConfirmed={async () => { const p = pending; setPending(null); void reload(); await p.fn(); }} />;
  return { run, dialog };
}

function ConfirmDialog({ hasPasskey, onClose, onConfirmed }: { hasPasskey: boolean; onClose: () => void; onConfirmed: () => Promise<void> }) {
  const { user } = useApp(), [handle, setHandle] = useState(''), [code, setCode] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState('');
  const passkey = async () => {
    setErr(''); setBusy('passkey');
    try { const o = await api<Parameters<typeof getPasskey>[0]>('/auth/passkey/options', { body: { purpose: 'confirm' } }); await api('/account/confirm/passkey', { body: { credential: await getPasskey(o) } }); await onConfirmed(); }
    catch (x) { if (!passkeyCancelled(x)) setErr(authError(x)); setBusy(''); }
  };
  const send = async () => { setErr(''); setBusy('send'); try { setHandle((await api<{ challenge: string }>('/account/confirm/send', { body: {} })).challenge); setCode(''); } catch (x) { setErr(authError(x)); } setBusy(''); };
  const check = async (e: FormEvent) => { e.preventDefault(); setErr(''); setBusy('check'); try { await api('/account/confirm', { body: { challenge: handle, code } }); await onConfirmed(); } catch (x) { setErr(authError(x)); setBusy(''); } };
  return (
    <Modal onClose={onClose}>
      <div className="stack">
        <h2>{t('Confirm it is you', '确认是你本人')}</h2>
        <p className="mute">{t('This change protects your account, so we check it is really you first. After that you can make changes for 10 minutes.', '此更改关系到账户安全，所以我们需要先确认是你本人。确认后 10 分钟内可以继续更改。')}</p>
        {handle ? <form onSubmit={check} className="stack">
          <Field label={t('Code we emailed to {email}', '我们发送到 {email} 的验证码', { email: user?.email || '' })}><Input value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} required mono autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" placeholder="123456" className="otp" /></Field>
          {err && <Notice tone="bad" role="alert">{err}</Notice>}
          <div className="row wrapx"><Button type="submit" variant="primary" disabled={!!busy || code.length !== 6}>{t('Confirm', '确认')}</Button><Button variant="ghost" onClick={() => void send()} disabled={!!busy}>{t('Send a new code', '重新发送验证码')}</Button></div>
        </form> : <>
          {err && <Notice tone="bad" role="alert">{err}</Notice>}
          <div className="stack s">
            {hasPasskey && passkeysSupported() && <Button variant="primary" block onClick={() => void passkey()} disabled={!!busy}>{t('Use a passkey', '使用通行密钥')}</Button>}
            <Button variant={hasPasskey && passkeysSupported() ? undefined : 'primary'} block onClick={() => void send()} disabled={!!busy}>{busy === 'send' ? t('One moment…', '请稍候…') : t('Email me a code', '通过邮件发送验证码')}</Button>
            <Button variant="ghost" block onClick={onClose}>{t('Cancel', '取消')}</Button>
          </div>
        </>}
      </div>
    </Modal>
  );
}

// ---- the page ------------------------------------------------------------------------------------------------------
const SECTIONS = [
  ['security', () => t('Sign-in and security', '登录与安全')],
  ['devices', () => t('Where you are signed in', '登录设备')],
  ['notifications', () => t('Notifications', '通知')],
  ['privacy', () => t('Friends and privacy', '好友与隐私')],
  ['delete', () => t('Delete account', '删除账户')],
] as const;

/** Follows which section is on screen, for the side menu. */
function useSpy(ids: readonly string[]) {
  const [on, setOn] = useState(ids[0]);
  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver((es) => { const v = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (v) setOn(v.target.id.replace('acct-', '')); }, { rootMargin: '-15% 0px -70% 0px' });
    ids.forEach((id) => { const el = document.getElementById('acct-' + id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, [ids]);
  return on;
}

function Section({ id, title, sub, children }: { id: string; title: ReactNode; sub?: ReactNode; children: ReactNode }) {
  return <section id={'acct-' + id} className="acct-sec"><header><h2>{title}</h2>{sub && <p className="mute">{sub}</p>}</header>{children}</section>;
}

/** The signed-in person's own account: how they sign in, where they are signed in, notifications, privacy, deleting it. */
export function Account() {
  const { user } = useApp(), { data, reload } = useData<AccountData>('/account');
  const gate = useConfirmGate(!!data?.passkeys.length, reload);
  const on = useSpy(useMemo(() => SECTIONS.map(([id]) => id), []));
  if (!user || !data) return <PageSkeleton />;
  const tfa = data.two_factor.enabled, keys = data.passkeys.length;
  const level = tfa && keys ? 3 : tfa || keys ? 2 : 1;
  return (
    <div className="wrap page account">
      <header className="acct-hero">
        <span className="acct-avatar" aria-hidden="true">{(user.name || '?').trim().charAt(0).toUpperCase()}</span>
        <div className="stack s grow">
          <h1>{user.name}</h1>
          <p className="mute">{user.email} · {t('Joined {when}', '{when}加入', { when: ago(data.created_at) })}</p>
          <div className="row wrapx acct-badges">
            {data.email_verified_at ? <Badge tone="good">{t('Email confirmed', '邮箱已确认')}</Badge> : <Badge>{t('Email not confirmed yet', '邮箱尚未确认')}</Badge>}
            <Badge tone={keys ? 'good' : undefined}>{keys === 1 ? t('1 passkey', '1 个通行密钥') : t('{n} passkeys', '{n} 个通行密钥', { n: keys })}</Badge>
            <Badge tone={tfa ? 'good' : undefined}>{tfa ? t('Two-factor on', '两步验证已开启') : t('Two-factor off', '两步验证未开启')}</Badge>
            {user.role === 'admin' && <Badge tone="accent">{t('Admin', '管理员')}</Badge>}
          </div>
        </div>
      </header>
      <div className="acct-grid">
        <nav className="acct-nav" aria-label={t('Account sections', '账户版块')}>
          {SECTIONS.map(([id, label]) => <a key={id} href={'#acct-' + id} className={on === id ? 'on' : ''} onClick={(e) => { e.preventDefault(); document.getElementById('acct-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{label()}</a>)}
        </nav>
        <div className="acct-main">
          <Section id="security" title={t('Sign-in and security', '登录与安全')} sub={t('There are no passwords. You sign in with a code we email you, or with a passkey.', '账户没有密码。你可以使用我们通过邮件发送的验证码登录，或使用通行密钥登录。')}>
            <div className={'acct-strength l' + level}>
              <div className="acct-meter" aria-hidden="true"><i /><i /><i /></div>
              <div className="stack s">
                <b>{level === 3 ? t('Your account is well protected', '你的账户保护得很好') : level === 2 ? t('Your account is protected', '你的账户已受到保护') : t('Add a passkey or two-factor sign-in', '添加通行密钥或两步验证')}</b>
                <span className="mute fs-sm">{level === 3 ? t('Passkeys and two-factor sign-in are both set up.', '通行密钥和两步验证均已设置。') : level === 2 ? (keys ? t('Signing in with a passkey needs your device and its fingerprint, face or PIN. Two-factor sign-in also protects email code sign-ins.', '使用通行密钥登录需要你的设备以及指纹、面容或 PIN。两步验证还能保护邮箱验证码登录。') : t('A passkey makes signing in faster: no code to wait for.', '通行密钥能让登录更快：无需等待验证码。')) : t('Right now, anyone who can read your email can sign in. A passkey or two-factor sign-in stops that.', '目前，任何能读取你邮件的人都可以登录。通行密钥或两步验证可以阻止这种情况。')}</span>
              </div>
            </div>
            <div className="acct-methods">
              <div className="acct-method"><span className="acct-mi" aria-hidden="true">@</span><div className="stack s grow"><b>{t('Email code', '邮箱验证码')}</b><span className="mute fs-sm">{t('A 6-digit code sent to {email} each time you sign in.', '每次登录时发送到 {email} 的 6 位验证码。', { email: user.email })}</span></div><Badge tone="good">{t('Always on', '始终开启')}</Badge></div>
            </div>
            <PasskeysCard keys={data.passkeys} reload={reload} run={gate.run} />
            <TwoFactorCard state={data.two_factor} creator={user.creator} reload={reload} run={gate.run} />
          </Section>
          <Section id="devices" title={t('Where you are signed in', '登录设备')}>
            <Devices sessions={data.sessions} reload={reload} />
          </Section>
          <Section id="notifications" title={t('Notifications', '通知')}>
            <Card title={t('Notifications on this device', '此设备上的通知')} pad><PushSettings /></Card>
          </Section>
          <Section id="privacy" title={t('Friends and privacy', '好友与隐私')}>
            <Card pad><FriendsSettings /></Card>
          </Section>
          <Section id="delete" title={t('Delete account', '删除账户')}>
            <DeleteCard blocker={data.delete_blocker} run={gate.run} />
          </Section>
        </div>
      </div>
      {gate.dialog}
    </div>
  );
}

type Run = (fn: () => Promise<void>) => Promise<void>;

function PasskeysCard({ keys, reload, run }: { keys: Passkey[]; reload: () => Promise<void>; run: Run }) {
  const [err, setErr] = useState(''), [msg, setMsg] = useState(''), [busy, setBusy] = useState(''), [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
  const supported = passkeysSupported();
  const act = async (key: string, fn: () => Promise<void>, ok: string) => {
    setErr(''); setMsg(''); setBusy(key);
    try { await run(fn); setMsg(ok); await reload(); } catch (x) { if (!passkeyCancelled(x)) setErr(authError(x)); }
    setBusy('');
  };
  const add = () => act('add', async () => { const o = await api<Parameters<typeof createPasskey>[0]>('/account/passkeys/options', { body: {} }); await api('/account/passkeys', { body: { credential: await createPasskey(o) } }); }, t('Passkey added. Next time, choose Sign in with a passkey.', '通行密钥已添加。下次登录时，选择“使用通行密钥登录”即可。'));
  const remove = (p: Passkey) => { if (confirm(t('Remove the passkey {name}? You can still sign in with an email code.', '要移除通行密钥 {name} 吗？你仍可使用邮箱验证码登录。', { name: p.name }))) void act('del' + p.id, () => api(`/account/passkeys/${encodeURIComponent(p.id)}/delete`, { body: {} }).then(() => {}), t('Passkey removed. Also delete it from your device or password manager.', '通行密钥已移除。也请从你的设备或密码管理器中删除它。')); };
  const rename = (e: FormEvent) => { e.preventDefault(); if (!edit) return; const p = edit; setEdit(null); void act('ren', () => api(`/account/passkeys/${encodeURIComponent(p.id)}/rename`, { body: { name: p.name } }).then(() => {}), t('Passkey renamed.', '通行密钥已重命名。')); };
  return (
    <Card title={t('Passkeys', '通行密钥')} aside={keys.length ? <Badge tone="good">{keys.length}</Badge> : <Badge>{t('None yet', '尚未添加')}</Badge>} pad>
      <p className="mute">{t('Sign in with your fingerprint, face or device PIN instead of a code. Passkeys are kept by your phone, computer or password manager, and work only on this site, so they cannot be phished.', '使用指纹、面容或设备 PIN 代替验证码登录。通行密钥保存在你的手机、电脑或密码管理器中，只能在本站使用，因此无法被钓鱼窃取。')}</p>
      {keys.length > 0 && <ul className="acct-list acct-rows">
        {keys.map((p) => <li key={p.id}>
          <span className="acct-mi" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="7" cy="7.5" r="3.5" /><path d="M9.6 10l6.4 6.4M13.5 13.9l1.6-1.6" /></svg></span>
          {edit?.id === p.id ? <form onSubmit={rename} className="row grow"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={40} autoFocus aria-label={t('Passkey name', '通行密钥名称')} /><Button type="submit" size="sm" variant="primary">{t('Save', '保存')}</Button><Button size="sm" variant="ghost" onClick={() => setEdit(null)}>{t('Cancel', '取消')}</Button></form> : <>
            <div className="stack s grow"><b>{p.name}</b><span className="mute fs-sm">{t('Added {when}', '{when}添加', { when: ago(p.created_at) })}{p.last_used_at ? ' · ' + t('last used {when}', '上次使用于{when}', { when: ago(p.last_used_at) }) : ' · ' + t('not used yet', '尚未使用')}</span></div>
            <div className="row"><Button size="sm" variant="ghost" onClick={() => setEdit({ id: p.id, name: p.name })}>{t('Rename', '重命名')}</Button><Button size="sm" variant="ghost" disabled={busy === 'del' + p.id} onClick={() => remove(p)}>{t('Remove', '移除')}</Button></div>
          </>}
        </li>)}
      </ul>}
      {msg && <Notice tone="good" role="status">{msg}</Notice>}
      {err && <Notice tone="bad" role="alert">{err}</Notice>}
      {supported ? <div><Button variant={keys.length ? undefined : 'primary'} onClick={() => void add()} disabled={busy === 'add'}>{busy === 'add' ? t('One moment…', '请稍候…') : t('Add a passkey', '添加通行密钥')}</Button></div>
        : <p className="dim fs-sm">{t('This browser cannot make passkeys. Try a recent Chrome, Safari, Edge or Firefox.', '此浏览器无法创建通行密钥。请使用较新版本的 Chrome、Safari、Edge 或 Firefox。')}</p>}
    </Card>
  );
}

function Devices({ sessions, reload }: { sessions: Session[]; reload: () => Promise<void> }) {
  const [msg, setMsg] = useState(''), [busy, setBusy] = useState(false), others = sessions.filter((s) => !s.current).length;
  const endOthers = async () => {
    setBusy(true);
    try { const r = await api<{ ended: number }>('/auth/sessions/end-others', { body: {} }); setMsg(r.ended === 1 ? t('1 other sign-in was ended.', '已退出 1 个其他登录。') : t('{n} other sign-ins were ended.', '已退出 {n} 个其他登录。', { n: r.ended })); void reload(); }
    catch (x) { setMsg((x as Error).message); }
    setBusy(false);
  };
  return (
    <Card pad>
      <ul className="acct-list acct-rows">
        {sessions.map((s, i) => <li key={i}>
          <span className="acct-mi" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="3" y="4" width="14" height="9.5" rx="1.5" /><path d="M7 16.5h6" /></svg></span>
          <div className="stack s grow"><b>{deviceOf(s.ua)}</b><span className="mute fs-sm">{t('signed in {when}', '{when}登录', { when: ago(s.created_at) })}{s.method ? ' ' + methodOf(s.method) : ''}</span></div>
          {s.current && <Badge tone="accent">{t('this browser', '当前浏览器')}</Badge>}
        </li>)}
      </ul>
      {msg && <Notice tone="good" role="status">{msg}</Notice>}
      <div><Button onClick={endOthers} disabled={busy || others === 0}>{t('Sign out everywhere else', '退出其他所有设备')}</Button></div>
    </Card>
  );
}

function DeleteCard({ blocker, run }: { blocker: string | null; run: Run }) {
  const { refresh } = useApp(), [sure, setSure] = useState(false), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const deleteIt = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await run(() => api('/account/delete', { body: {} }).then(() => {})); announceAuth(); await refresh(); navigate('/', true); }
    catch (x) { setErr(authError(x)); setBusy(false); }
  };
  return (
    <Card pad className="acct-danger">
      <form onSubmit={deleteIt} className="stack">
        <p className="mute">{t('This removes your email, name, passkeys, saves, stats, scores and reviews, and signs you out everywhere. Your purchase records are kept, because the law requires us to keep them, but no longer show who you are. It cannot be undone.', '这会删除你的邮箱、名称、通行密钥、存档、统计、分数和评价，并在所有设备上退出登录。购买记录依法保留，但不再显示你是谁。此操作无法撤销。')}</p>
        {blocker ? <Notice tone="info">{blocker}</Notice> : <>
          <label className="row fs-sm"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> {t('I understand that my account and progress are gone for good.', '我了解我的账户和进度将被永久删除。')}</label>
          {err && <Notice tone="bad" role="alert">{err}</Notice>}
          <div><Button type="submit" variant="danger" disabled={!sure || busy}>{t('Delete my account', '删除我的账户')}</Button></div>
        </>}
      </form>
    </Card>
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
 * a fresh confirmation, then the QR code (or the key typed in), then a code from the app, then the recovery codes, shown
 * once. Turning it off or making new recovery codes asks for a code from the app as well.
 */
function TwoFactorCard({ state, creator, reload, run }: { state: TwoFactor; creator: boolean; reload: () => Promise<void>; run: Run }) {
  type Step = 'idle' | 'scan' | 'codes' | 'disable' | 'regen';
  const [step, setStep] = useState<Step>('idle'), [code, setCode] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null), [codes, setCodes] = useState<string[]>([]), [msg, setMsg] = useState('');
  const reset = (s: Step = 'idle') => { setStep(s); setCode(''); setErr(''); setBusy(false); };
  const go = async (fn: () => Promise<void>) => { setErr(''); setBusy(true); try { await run(fn); } catch (x) { setErr(authError(x)); } setBusy(false); };
  const start = () => { setMsg(''); void go(async () => { setSetup(await api('/account/2fa/setup', { body: {} })); setStep('scan'); }); };
  const enable = (e: FormEvent) => { e.preventDefault(); void go(async () => { const r = await api<{ recovery_codes: string[] }>('/account/2fa/enable', { body: { code } }); setCodes(r.recovery_codes); setSetup(null); setCode(''); setStep('codes'); }); };
  const disable = (e: FormEvent) => { e.preventDefault(); void go(async () => { await api('/account/2fa/disable', { body: { code } }); reset(); setMsg(t('Two-factor sign-in is off.', '两步验证登录已关闭。')); await reload(); }); };
  const regen = (e: FormEvent) => { e.preventDefault(); void go(async () => { const r = await api<{ recovery_codes: string[] }>('/account/2fa/recovery-codes', { body: { code } }); setCodes(r.recovery_codes); setCode(''); setStep('codes'); }); };
  const done = () => { setCodes([]); reset(); setMsg(t('Two-factor sign-in is on. Every other sign-in was ended.', '两步验证登录已开启，其他所有登录已退出。')); void reload(); };
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
        ) : step === 'disable' || step === 'regen' ? (
          <form onSubmit={step === 'disable' ? disable : regen} className="stack">
            <p className="mute">{step === 'disable'
              ? t('Signing in will need only the code we email you (or a passkey). Your recovery codes stop working.', '登录将只需要我们通过邮件发送的验证码（或通行密钥），你的恢复码也将失效。')
              : t('You get ten new recovery codes. The ones you have now stop working.', '你将获得十个新的恢复码，现有的恢复码将失效。')}</p>
            <Field label={t('Code from your authenticator app, or a recovery code', '身份验证器应用中的验证码，或一个恢复码')}><Input value={code} onChange={(e) => setCode(e.target.value)} required mono autoFocus autoComplete="one-time-code" maxLength={20} /></Field>
            {errLine}
            <div className="row wrapx"><Button type="submit" variant={step === 'disable' ? 'danger' : 'primary'} disabled={busy}>{step === 'disable' ? t('Turn off two-factor sign-in', '关闭两步验证登录') : t('Get new recovery codes', '获取新的恢复码')}</Button><Button variant="ghost" onClick={() => reset()}>{t('Cancel', '取消')}</Button></div>
          </form>
        ) : state.enabled ? <>
          <p className="mute">{t('After the code we email you, signing in also asks for a code from your authenticator app. On since {when}.', '登录时，在输入我们通过邮件发送的验证码之后，还需要输入身份验证器应用中的验证码。开启于{when}。', { when: ago(state.enabled_at!) })}</p>
          {state.recovery_left <= 3
            ? <Notice tone="bad">{state.recovery_left === 0 ? t('You have no recovery codes left. Get new ones so you can still sign in if you lose your phone.', '你已没有可用的恢复码。请获取新的恢复码，以免手机丢失后无法登录。') : t('Only {n} recovery codes left. Get new ones so you can still sign in if you lose your phone.', '仅剩 {n} 个恢复码。请获取新的恢复码，以免手机丢失后无法登录。', { n: state.recovery_left })}</Notice>
            : <p className="mute fs-sm">{t('{n} recovery codes left.', '剩余 {n} 个恢复码。', { n: state.recovery_left })}</p>}
          {msg && <Notice tone="good" role="status">{msg}</Notice>}
          <div className="row wrapx"><Button onClick={() => { setMsg(''); reset('regen'); }}>{t('New recovery codes', '新的恢复码')}</Button><Button variant="danger" onClick={() => { setMsg(''); reset('disable'); }}>{t('Turn off', '关闭')}</Button></div>
        </> : <>
          <p className="mute">{t('Add a second step to signing in: after the code we email you, a 6-digit code from an authenticator app on your phone. Someone who gets into your email still cannot get in.', '为登录增加第二步：在输入我们通过邮件发送的验证码之后，还需输入手机上身份验证器应用生成的 6 位验证码。即使有人进入了你的邮箱，也无法登录。')}</p>
          {creator && <p className="mute fs-sm">{t('Recommended for creators: it also protects your games, your earnings and the agents you connected.', '推荐创作者开启：它还能保护你的游戏、收益和已连接的智能体。')}</p>}
          {msg && <Notice tone="good" role="status">{msg}</Notice>}
          {errLine}
          <div><Button variant="primary" onClick={start} disabled={busy}>{t('Turn on two-factor sign-in', '开启两步验证登录')}</Button></div>
        </>}
      </div>
    </Card>
  );
}

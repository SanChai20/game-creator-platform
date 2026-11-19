import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { announceAuth } from '../account-sync';
import { api, ApiError, artStyle, Link, navigate, num, query, t, useApp, useData, type GameCard } from '../lib';
import { Button, CelScene, Eyebrow, Field, Input, Notice } from '../ui';
import { PageSkeleton } from '../skeletons';
import { legalTitle } from './Legal';

/** Only same-site paths are allowed as a return target. */
const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/');
/** Server routes (the agent consent screen) need a full page load; app routes do not. */
const go = (to: string) => { if (to.startsWith('/authorize') || to.startsWith('/oauth')) location.href = to; else navigate(to, true); };

export function Auth({ mode, tools }: { mode: 'login' | 'signup'; tools?: ReactNode }) {
  const { user, refresh, config } = useApp(), next = safeNext(query().get('next'));
  const [email, setEmail] = useState(''), [name, setName] = useState(''), [password, setPassword] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState('');
  useEffect(() => { if (user) go(next); }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
  const forAgent = next.startsWith('/authorize') || next.startsWith('/device');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const r = await api<{ two_factor?: boolean; challenge?: string }>(mode === 'login' ? '/auth/login' : '/auth/signup', { body: mode === 'login' ? { email, password } : { email, name, password } });
      if (r.two_factor && r.challenge) { setChallenge(r.challenge); setPassword(''); setBusy(false); return; }
      announceAuth(); await refresh();
    }
    catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  const other = `${mode === 'login' ? '/signup' : '/login'}?next=${encodeURIComponent(next)}`;
  return (
    <div className={'auth split' + (forAgent ? ' solo' : '')}>
      {!forAgent && <Showcase />}
      <div className="auth-side">
      <div className="auth-top">
        <Link to="/" className="brand" aria-label={config.settings.brand_name}><i className="logo" aria-hidden="true" /><span>{config.settings.brand_name}</span></Link>
        <span className="auth-tools">{tools}</span>
      </div>
      {challenge ? <div className="auth-card"><CodeStep challenge={challenge} onRestart={(msg) => { setChallenge(''); setErr(msg); }} /></div> : <form onSubmit={submit} className="auth-card">
        <div className="stack">
          <Eyebrow tone="accent">{config.settings.brand_name}</Eyebrow>
          <h1>{mode === 'login' ? t('Welcome back', '欢迎回来') : t('Create your account', '创建账户')}</h1>
          <p className="mute">{forAgent ? t('Sign in to connect your agent. You will confirm what it may do on the next screen.', '登录以连接你的智能体，下一步你将确认它可以执行的操作。') : mode === 'login' ? t('Sign in to play, review and manage your games.', '登录后即可游玩、评价并管理你的游戏。') : t('One account for playing and for making games.', '一个账户，既能玩游戏，也能做游戏。')}</p>
        </div>
        {mode === 'signup' && !config.settings.signups_open && <Notice>{t('Sign-ups are closed right now.', '目前暂未开放注册。')}</Notice>}
        {mode === 'signup' && <Field label={t('Display name', '显示名称')}><Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={40} autoComplete="nickname" /></Field>}
        <Field label={t('Email', '邮箱')}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus /></Field>
        <Field label={t('Password', '密码')} hint={mode === 'signup' ? t('At least 8 characters.', '至少 8 个字符。') : <Link to="/forgot" className="sig">{t('Forgot your password?', '忘记密码？')}</Link>}><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'signup' ? 8 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></Field>
        {err && <Notice tone="bad" role="alert">{err}</Notice>}
        <Button type="submit" variant="primary" size="lg" block disabled={busy}>{busy ? t('One moment…', '请稍候…') : mode === 'login' ? t('Sign in', '登录') : t('Create account', '创建账户')}</Button>
        {mode === 'signup' && <p className="auth-terms">{t('By creating an account you agree to the {terms} and the {privacy}.', '创建账户即表示你同意{terms}和{privacy}。').split(/(\{terms\}|\{privacy\})/).map((part, i) => part === '{terms}' ? <a key={i} href="/legal/terms" target="_blank" rel="noopener">{legalTitle('terms')}</a> : part === '{privacy}' ? <a key={i} href="/legal/privacy" target="_blank" rel="noopener">{legalTitle('privacy')}</a> : part)}</p>}
        <p className="mute switch-line">{mode === 'login' ? t('New here?', '还没有账户？') : t('Already have an account?', '已有账户？')} <Link to={other} className="sig">{mode === 'login' ? t('Create an account', '立即注册') : t('Sign in', '登录')}</Link></p>
      </form>}
      <Link to="/" className="auth-home"><span aria-hidden="true">←</span> {t('Back to the store', '返回商店')}</Link>
      </div>
    </div>
  );
}

/** The other half of the sign-in page: the rendered scene, a few of the store's covers and what the account is for. */
function Showcase() {
  const { data } = useData<{ stats: { games: number; creators: number }; shelves: { trending: GameCard[]; new: GameCard[] } }>('/home');
  const covers = data ? [...data.shelves.trending, ...data.shelves.new].filter((g, i, a) => !g.mature?.length && a.findIndex((x) => x.id === g.id) === i).slice(0, 4) : [];
  return (
    <aside className="auth-show ink" aria-hidden="true">
      <CelScene seed={4} />
      <div className="auth-pitch">
        <b>{data ? t('{games} web games. One account.', '{games} 款网页游戏，一个账户。', { games: num(data.stats.games) }) : t('Web games. One account.', '网页游戏，一个账户。')}</b>
        <span>{t('Play in your browser, keep your library, rate what you love, and publish your own with your agent.', '在浏览器里畅玩，收藏游戏库，为喜欢的作品评分，还能用智能体发布你自己的游戏。')}</span>
        {covers.length > 0 && <div className="auth-wall">{covers.map((g, k) => <span key={g.id} className={'aw' + k} style={g.cover ? undefined : artStyle(g.slug)}>{g.cover && <img src={g.cover} alt="" loading="lazy" />}</span>)}</div>}
      </div>
    </aside>
  );
}

/**
 * The second step of a sign-in when the account has two-factor on: a 6-digit code from the authenticator app, or one of
 * the recovery codes. Signs the browser in when it is right; a timed-out sign-in goes back to the password.
 */
export function CodeStep({ challenge, onRestart, onDone }: { challenge: string; onRestart: (message: string) => void; onDone?: () => void }) {
  const { refresh } = useApp(), [code, setCode] = useState(''), [recovery, setRecovery] = useState(false), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await api('/auth/login/code', { body: { challenge, code } }); announceAuth(); await refresh(); onDone?.(); }
    catch (x) {
      if (x instanceof ApiError && x.code === 'challenge_expired') { onRestart(x.message); return; }
      setErr((x as Error).message); setCode(''); setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="stack">
      <div className="stack">
        <Eyebrow tone="accent">{t('Two-factor sign-in', '两步验证登录')}</Eyebrow>
        <h1>{recovery ? t('Enter a recovery code', '输入恢复码') : t('Enter your code', '输入验证码')}</h1>
        <p className="mute">{recovery
          ? t('Use one of the recovery codes you saved when you turned on two-factor sign-in. Each code works once.', '使用你开启两步验证时保存的恢复码之一。每个恢复码只能使用一次。')
          : t('Open your authenticator app and enter the 6-digit code it shows for this account.', '打开你的身份验证器应用，输入它为此账户显示的 6 位数字验证码。')}</p>
      </div>
      <Field label={recovery ? t('Recovery code', '恢复码') : t('6-digit code', '6 位验证码')}>
        {recovery
          ? <Input key="rc" value={code} onChange={(e) => setCode(e.target.value)} required mono autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="xxxxx-xxxxx" maxLength={20} />
          : <Input key="otp" value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} required mono autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" placeholder="123456" className="otp" />}
      </Field>
      {err && <Notice tone="bad" role="alert">{err}</Notice>}
      <Button type="submit" variant="primary" size="lg" block disabled={busy || (!recovery && code.length !== 6)}>{busy ? t('One moment…', '请稍候…') : t('Verify and sign in', '验证并登录')}</Button>
      <p className="mute switch-line">
        <button type="button" className="linkish sig" onClick={() => { setRecovery(!recovery); setCode(''); setErr(''); }}>{recovery ? t('Use the authenticator app instead', '改用身份验证器应用') : t('Lost your phone? Use a recovery code', '手机丢了？使用恢复码')}</button>
      </p>
      {recovery && <p className="dim fs-sm">{t('No recovery codes either? Contact us from the email on your account and we will help you get back in.', '恢复码也没有了？请用账户邮箱联系我们，我们会帮你恢复访问。')}</p>}
    </form>
  );
}

/** Asks for a password reset link by email. The answer is the same whether or not the email has an account. */
export function Forgot() {
  const { config } = useApp(), [email, setEmail] = useState(''), [sent, setSent] = useState(false), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await api('/auth/forgot', { body: { email } }); setSent(true); } catch (x) { setErr((x as Error).message); }
    setBusy(false);
  };
  return (
    <div className="auth"><form onSubmit={submit} className="auth-card">
      <Eyebrow tone="accent">{config.settings.brand_name}</Eyebrow>
      <h1>{t('Reset your password', '重置密码')}</h1>
      {sent ? <p className="mute">{t('If an account uses {email}, we sent it a link to choose a new password. The link works once, for an hour. Check your spam folder if it does not arrive.', '如果有账户使用 {email}，我们已向其发送设置新密码的链接。链接仅可使用一次，有效期一小时。如果没有收到，请检查垃圾邮件。', { email })}</p> : <>
        <p className="mute">{t('Enter the email you signed up with. We will send you a link to choose a new password.', '输入你注册时使用的邮箱，我们会发送一个设置新密码的链接。')}</p>
        <Field label={t('Email', '邮箱')}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus /></Field>
        {err && <Notice tone="bad" role="alert">{err}</Notice>}
        <Button type="submit" variant="primary" size="lg" block disabled={busy}>{busy ? t('One moment…', '请稍候…') : t('Send the link', '发送链接')}</Button>
      </>}
      <p className="mute switch-line"><Link to="/login" className="sig">{t('Back to sign in', '返回登录')}</Link></p>
    </form></div>
  );
}

/** Opened from the emailed link: chooses a new password, which ends every earlier sign-in and signs this browser in. */
export function Reset() {
  const { config, refresh } = useApp(), tk = query().get('token') || '';
  const [pw, setPw] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false), [challenge, setChallenge] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const r = await api<{ two_factor?: boolean; challenge?: string }>('/auth/reset', { body: { token: tk, password: pw } });
      // the new password is saved; with two-factor on, the code is still needed to sign in
      if (r.two_factor && r.challenge) { setChallenge(r.challenge); setBusy(false); return; }
      announceAuth(); await refresh(); navigate('/', true);
    }
    catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  if (challenge) return (
    <div className="auth"><div className="auth-card">
      <Notice tone="good" role="status">{t('Your new password is saved.', '新密码已保存。')}</Notice>
      <CodeStep challenge={challenge} onDone={() => navigate('/', true)} onRestart={() => navigate('/login', true)} />
    </div></div>
  );
  return (
    <div className="auth"><form onSubmit={submit} className="auth-card">
      <Eyebrow tone="accent">{config.settings.brand_name}</Eyebrow>
      <h1>{t('Choose a new password', '设置新密码')}</h1>
      {!tk && <Notice tone="bad">{t('The link is missing its token.', '链接缺少令牌参数。')}</Notice>}
      <Field label={t('New password', '新密码')} hint={t('At least 8 characters.', '至少 8 个字符。')}><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={8} autoComplete="new-password" autoFocus /></Field>
      {err && <Notice tone="bad" role="alert">{err}</Notice>}
      <Button type="submit" variant="primary" size="lg" block disabled={busy || !tk}>{busy ? t('One moment…', '请稍候…') : t('Save and sign in', '保存并登录')}</Button>
      <p className="mute switch-line"><Link to="/forgot" className="sig">{t('Ask for a new link', '重新获取链接')}</Link></p>
    </form></div>
  );
}

/** The first administrator claims the platform with the one-time link printed at deploy time. */
export function ClaimAdmin() {
  const { refresh, user } = useApp(), [state, setState] = useState<'idle' | 'busy' | 'done' | 'fail'>('idle'), [msg, setMsg] = useState('');
  const token = query().get('token') || '';
  const claim = async () => {
    setState('busy');
    try { await api('/claim-admin', { body: { token } }); await refresh(); setState('done'); }
    catch (e) { setMsg((e as Error).message); setState('fail'); }
  };
  if (!user) return <PageSkeleton />;
  return (
    <div className="auth"><div className="auth-card wide">
      <Eyebrow tone="accent">{t('Platform setup', '平台初始化')}</Eyebrow>
      <h1>{state === 'done' ? t('You are the administrator', '你已成为管理员') : t('Claim the admin console', '认领管理后台')}</h1>
      {state === 'done' ? <><p className="mute">{t('This link no longer works for anyone else. Open the admin console to set prices, limits and payouts.', '该链接已对其他人失效。打开管理后台即可设置价格、限制与提现规则。')}</p><Button to="/admin" variant="primary" size="lg" block>{t('Open admin console', '打开管理后台')}</Button></> : (
        <>
          <p className="mute">{t('This makes the account you are signed in with', '此操作会将当前登录的账户')} <b style={{ color: 'var(--text)' }}>{user.email}</b> {t('the first administrator. It works once.', '设为首位管理员，且只能使用一次。')}</p>
          {state === 'fail' && <Notice tone="bad" role="alert">{msg}</Notice>}
          {!token && <Notice tone="bad">{t('The link is missing its token.', '链接缺少令牌参数。')}</Notice>}
          <Button variant="primary" size="lg" block onClick={claim} disabled={!token || state === 'busy'}>{t('Make me the administrator', '设为管理员')}</Button>
        </>
      )}
    </div></div>
  );
}

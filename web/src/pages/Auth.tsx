import { useEffect, useState, type FormEvent } from 'react';
import { api, Link, navigate, query, Spinner, t, useApp } from '../lib';

/** Only same-site paths are allowed as a return target. */
const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/');
/** Server routes (the agent consent screen) need a full page load; app routes do not. */
const go = (to: string) => { if (to.startsWith('/authorize') || to.startsWith('/oauth')) location.href = to; else navigate(to, true); };

export function Auth({ mode }: { mode: 'login' | 'signup' }) {
  const { user, refresh, config } = useApp(), next = safeNext(query().get('next'));
  const [email, setEmail] = useState(''), [name, setName] = useState(''), [password, setPassword] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { if (user) go(next); }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
  const forAgent = next.startsWith('/authorize');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await api(mode === 'login' ? '/auth/login' : '/auth/signup', { body: mode === 'login' ? { email, password } : { email, name, password } }); await refresh(); }
    catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  const other = `${mode === 'login' ? '/signup' : '/login'}?next=${encodeURIComponent(next)}`;
  return (
    <div className="auth">
      <form onSubmit={submit}>
        <div className="stack">
          <span className="eyebrow sig">{config.settings.brand_name}</span>
          <h1>{mode === 'login' ? t('Welcome back', '欢迎回来') : t('Create your account', '创建账户')}</h1>
          <p className="mute">{forAgent ? t('Sign in to connect your agent. You will confirm what it may do on the next screen.', '登录以连接你的智能体，下一步你将确认它可以执行的操作。') : mode === 'login' ? t('Sign in to play, review and manage your games.', '登录后即可游玩、评价并管理你的游戏。') : t('One account for playing and for making games.', '一个账户，既能玩游戏，也能做游戏。')}</p>
        </div>
        {mode === 'signup' && !config.settings.signups_open && <div className="notice">{t('Sign-ups are closed right now.', '目前暂未开放注册。')}</div>}
        {mode === 'signup' && <label className="field"><span>{t('Display name', '显示名称')}</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={40} autoComplete="nickname" /></label>}
        <label className="field"><span>{t('Email', '邮箱')}</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus /></label>
        <label className="field"><span>{t('Password', '密码')}</span><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'signup' ? 8 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
        {mode === 'signup' && <span className="dim" style={{ fontSize: 13, marginTop: -8 }}>{t('At least 8 characters.', '至少 8 个字符。')}</span>}
        {err && <div className="notice bad" role="alert">{err}</div>}
        <button className="btn pri big" disabled={busy}>{busy ? t('One moment…', '请稍候…') : mode === 'login' ? t('Sign in', '登录') : t('Create account', '创建账户')}</button>
        <p className="mute" style={{ textAlign: 'center' }}>{mode === 'login' ? t('New here?', '还没有账户？') : t('Already have an account?', '已有账户？')} <Link to={other} className="sig">{mode === 'login' ? t('Create an account', '立即注册') : t('Sign in', '登录')}</Link></p>
      </form>
    </div>
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
  if (!user) return <Spinner />;
  return (
    <div className="auth"><div className="stack l" style={{ width: 'min(480px, 100%)' }}>
      <span className="eyebrow sig">{t('Platform setup', '平台初始化')}</span>
      <h1 style={{ fontSize: 34 }}>{state === 'done' ? t('You are the administrator', '你已成为管理员') : t('Claim the admin console', '认领管理后台')}</h1>
      {state === 'done' ? <><p className="mute">{t('This link no longer works for anyone else. Open the admin console to set prices, limits and payouts.', '该链接已对其他人失效。打开管理后台即可设置价格、限制与提现规则。')}</p><Link to="/admin" className="btn pri big">{t('Open admin console', '打开管理后台')}</Link></> : (
        <>
          <p className="mute">{t('This makes the account you are signed in with', '此操作会将当前登录的账户')} <b style={{ color: 'var(--bone)' }}>{user.email}</b> {t('the first administrator. It works once.', '设为首位管理员，且只能使用一次。')}</p>
          {state === 'fail' && <div className="notice bad" role="alert">{msg}</div>}
          {!token && <div className="notice bad">{t('The link is missing its token.', '链接缺少令牌参数。')}</div>}
          <button className="btn pri big" onClick={claim} disabled={!token || state === 'busy'}>{t('Make me the administrator', '设为管理员')}</button>
        </>
      )}
    </div></div>
  );
}

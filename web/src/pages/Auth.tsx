import { useEffect, useState, type FormEvent } from 'react';
import { announceAuth } from '../account-sync';
import { api, artStyle, Link, navigate, num, query, t, useApp, useData, type GameCard } from '../lib';
import { Button, CelScene, Eyebrow, Field, Input, Notice } from '../ui';
import { PageSkeleton } from '../skeletons';

/** Only same-site paths are allowed as a return target. */
const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/');
/** Server routes (the agent consent screen) need a full page load; app routes do not. */
const go = (to: string) => { if (to.startsWith('/authorize') || to.startsWith('/oauth')) location.href = to; else navigate(to, true); };

export function Auth({ mode }: { mode: 'login' | 'signup' }) {
  const { user, refresh, config } = useApp(), next = safeNext(query().get('next'));
  const [email, setEmail] = useState(''), [name, setName] = useState(''), [password, setPassword] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { if (user) go(next); }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
  const forAgent = next.startsWith('/authorize') || next.startsWith('/device');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await api(mode === 'login' ? '/auth/login' : '/auth/signup', { body: mode === 'login' ? { email, password } : { email, name, password } }); announceAuth(); await refresh(); }
    catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  const other = `${mode === 'login' ? '/signup' : '/login'}?next=${encodeURIComponent(next)}`;
  return (
    <div className="auth split">
      {!forAgent && <Showcase />}
      <form onSubmit={submit} className="auth-card">
        <div className="stack">
          <Eyebrow tone="accent">{config.settings.brand_name}</Eyebrow>
          <h1>{mode === 'login' ? t('Welcome back', '欢迎回来') : t('Create your account', '创建账户')}</h1>
          <p className="mute">{forAgent ? t('Sign in to connect your agent. You will confirm what it may do on the next screen.', '登录以连接你的智能体，下一步你将确认它可以执行的操作。') : mode === 'login' ? t('Sign in to play, review and manage your games.', '登录后即可游玩、评价并管理你的游戏。') : t('One account for playing and for making games.', '一个账户，既能玩游戏，也能做游戏。')}</p>
        </div>
        {mode === 'signup' && !config.settings.signups_open && <Notice>{t('Sign-ups are closed right now.', '目前暂未开放注册。')}</Notice>}
        {mode === 'signup' && <Field label={t('Display name', '显示名称')}><Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={40} autoComplete="nickname" /></Field>}
        <Field label={t('Email', '邮箱')}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus /></Field>
        <Field label={t('Password', '密码')} hint={mode === 'signup' ? t('At least 8 characters.', '至少 8 个字符。') : undefined}><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'signup' ? 8 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></Field>
        {err && <Notice tone="bad" role="alert">{err}</Notice>}
        <Button type="submit" variant="primary" size="lg" block disabled={busy}>{busy ? t('One moment…', '请稍候…') : mode === 'login' ? t('Sign in', '登录') : t('Create account', '创建账户')}</Button>
        <p className="mute switch-line">{mode === 'login' ? t('New here?', '还没有账户？') : t('Already have an account?', '已有账户？')} <Link to={other} className="sig">{mode === 'login' ? t('Create an account', '立即注册') : t('Sign in', '登录')}</Link></p>
      </form>
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

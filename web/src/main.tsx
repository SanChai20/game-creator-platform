import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { api, AppCtx, Link, loginUrl, navigate, setLang, Spinner, t, useLang, useLocation, type Config, type Me } from './lib';
import { Home } from './pages/Home';
import { Game } from './pages/Game';
import { Auth, ClaimAdmin } from './pages/Auth';
import { Creators } from './pages/Creators';
import { Console } from './pages/Console';
import { Project } from './pages/Project';
import { Earnings } from './pages/Earnings';
import { Admin } from './pages/Admin';
import { Device } from './pages/Device';

function Nav({ user, brand, onLogout }: { user: Me | null; brand: string; onLogout: () => void }) {
  const loc = useLocation(), lang = useLang(), [open, setOpen] = useState(false), ref = useRef<HTMLDivElement>(null);
  useEffect(() => { setOpen(false); }, [loc]);
  useEffect(() => { const f = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; addEventListener('mousedown', f); return () => removeEventListener('mousedown', f); }, []);
  const path = loc.split('?')[0], onAuth = path === '/login' || path === '/signup', keep = onAuth && loc.includes('?') ? loc.slice(loc.indexOf('?')) : '';   // someone sent here to approve an agent keeps their place
  const on = (p: string) => 'nl' + ((p === '/' ? path === '/' || path.startsWith('/g/') : path.startsWith(p)) ? ' on' : '');
  return (
    <nav className="nav">
      <div className="wrap">
        <Link to="/" className="brand"><i /><span>{brand}</span></Link>
        <Link to="/" className={on('/')}>{t('Games', '游戏')}</Link>
        <Link to="/create" className={on('/create')}>{t('For creators', '创作者')}</Link>
        {user && <Link to="/console" className={on('/console') + ' hide-s'}>{t('Console', '控制台')}</Link>}
        {user?.role === 'admin' && <Link to="/admin" className={on('/admin') + ' hide-s'}>{t('Admin', '管理')}</Link>}
        <span className="grow" />
        <button className="lang" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')} aria-label="Language">{lang === 'zh' ? 'EN' : '中文'}</button>
        {user ? (
          <div className="menu" ref={ref}>
            <button className="avatar" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={t('Account menu', '账户菜单')}>{user.name.slice(0, 1).toUpperCase()}</button>
            {open && (
              <div className="pop" role="menu">
                <div className="who"><b>{user.name}</b><div className="mute clip" style={{ fontSize: 13 }}>{user.email}</div></div>
                <Link to="/console">{t('Console', '控制台')}</Link>
                <Link to="/console/earnings">{t('Earnings', '收益')}</Link>
                {user.role === 'admin' && <Link to="/admin">{t('Admin', '管理后台')}</Link>}
                <button onClick={onLogout}>{t('Sign out', '退出登录')}</button>
              </div>
            )}
          </div>
        ) : (
          <>
            <Link to={onAuth ? '/login' + keep : loginUrl()} className="nl">{t('Sign in', '登录')}</Link>
            <Link to={'/signup' + keep} className="btn pri sm">{t('Join', '注册')}</Link>
          </>
        )}
      </div>
    </nav>
  );
}

function NotFound() {
  return <div className="wrap page"><div className="empty"><h3>{t('Nothing here', '页面不存在')}</h3><p>{t('That page does not exist, or it was moved.', '该页面不存在或已被移动。')}</p><p style={{ marginTop: 18 }}><Link to="/" className="btn">{t('Back to the games', '返回游戏列表')}</Link></p></div></div>;
}

function Routes({ user }: { user: Me | null }) {
  const loc = useLocation(), path = loc.split('?')[0].replace(/\/+$/, '') || '/';
  const needUser = path.startsWith('/console') || path.startsWith('/admin') || path === '/claim-admin' || path === '/device';
  useEffect(() => { if (needUser && !user) navigate(loginUrl(), true); }, [needUser, user, loc]);
  if (needUser && !user) return <Spinner />;
  let m: RegExpMatchArray | null;
  if (path === '/') return <Home />;
  if ((m = path.match(/^\/g\/([^/]+)$/))) return <Game key={m[1]} slug={decodeURIComponent(m[1])} />;
  if (path === '/login' || path === '/signup') return <Auth mode={path === '/login' ? 'login' : 'signup'} />;
  if (path === '/create') return <Creators />;
  if (path === '/console') return <Console />;
  if (path === '/console/earnings') return <Earnings />;
  if ((m = path.match(/^\/console\/p\/([^/]+)$/))) return <Project key={m[1]} id={m[1]} />;
  if (path === '/claim-admin') return <ClaimAdmin />;
  if (path === '/device') return <Device />;
  if ((m = path.match(/^\/admin(?:\/([a-z]+))?$/))) return user?.role === 'admin' ? <Admin tab={m[1] || 'overview'} /> : <NotFound />;
  return <NotFound />;
}

function App() {
  const lang = useLang();
  const [state, setState] = useState<{ user: Me | null; config: Config } | null>(null), [failed, setFailed] = useState(false);
  const [toastMsg, setToast] = useState<{ msg: string; bad: boolean } | null>(null), timer = useRef(0);
  const refresh = useCallback(async () => {
    const [cfg, me] = await Promise.all([api<Config>('/config'), api<{ user: Me | null }>('/me')]);
    setState({ user: me.user, config: cfg });
  }, []);
  useEffect(() => { refresh().catch(() => setFailed(true)); }, [refresh]);
  const toast = useCallback((msg: string, bad = false) => { setToast({ msg, bad }); clearTimeout(timer.current); timer.current = window.setTimeout(() => setToast(null), bad ? 5200 : 2600); }, []);
  useEffect(() => { if (state) document.title = `${state.config.settings.brand_name} — ${state.config.settings.tagline}`; }, [state]);
  if (failed) return <div className="wrap page"><div className="empty"><h3>{t('The site did not respond', '站点暂时无法响应')}</h3><p><button className="btn" onClick={() => location.reload()}>{t('Reload', '刷新')}</button></p></div></div>;
  if (!state) return <Spinner />;
  const logout = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); await refresh(); navigate('/'); };
  const brand = state.config.settings.brand_name as string;
  return (
    <AppCtx.Provider value={{ ...state, refresh, toast }} key={lang}>
      <Nav user={state.user} brand={brand} onLogout={logout} />
      <main><Routes user={state.user} /></main>
      <footer className="foot"><div className="wrap">
        <span>© {new Date().getFullYear()} {brand}</span><span>{state.config.settings.tagline}</span><span className="grow" />
        <Link to="/create">{t('Make a game', '创作游戏')}</Link><a href="/guides/platform-contract.md" target="_blank" rel="noreferrer">{t('Platform contract', '平台约定')}</a>
      </div></footer>
      {toastMsg && <div className={'toast' + (toastMsg.bad ? ' bad' : '')} role="status">{toastMsg.msg}</div>}
    </AppCtx.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

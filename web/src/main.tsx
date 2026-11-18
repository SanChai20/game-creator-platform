import { StrictMode, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { TOKENS_CSS } from './ui/tokens';
import './ui/ui.css';
import './app.css';
import './store.css';
import { api, AppCtx, LANGS, langReady, Link, loginUrl, navigate, setLang, setTrialRules, t, useLang, useLocation, type Config, type Lang, type Me } from './lib';
import { Button, CelScene, EmptyState } from './ui';
import { AppSkeleton, RouteSkeleton } from './skeletons';

// Pictures show a skeleton sheen until they arrive (ui.css): mark each one as it loads or fails. Load events do not
// bubble, so listen in the capture phase.
const seen = (e: Event) => { const el = e.target; if (el instanceof HTMLImageElement) el.dataset.ok = ''; };
document.addEventListener('load', seen, true); document.addEventListener('error', seen, true);
import { fxPref, setFxPref } from './ui/fx';
import { Icon } from './ui/icons';
import { onTheme, setTheme, theme } from './ui/theme';

// The design tokens are defined once in ui/tokens.ts and shared with the Worker's server-rendered pages.
document.head.insertAdjacentHTML('afterbegin', `<style id="tokens">${TOKENS_CSS}</style>`);
import { Home } from './pages/Home';
import { Game } from './pages/Game';
import { Auth, ClaimAdmin } from './pages/Auth';
import { Creators } from './pages/Creators';
import { Console } from './pages/Console';
import { Project } from './pages/Project';
import { Analytics } from './pages/Analytics';
import { Earnings } from './pages/Earnings';
import { Admin } from './pages/Admin';
import { Device } from './pages/Device';
import { Docs } from './pages/Docs';
import { Browse } from './pages/Browse';
import { Categories, Category } from './pages/Categories';
import { Queue } from './pages/Queue';
import { Legal, LEGAL_DOCS, legalTitle, type LegalDoc } from './pages/Legal';
import { SearchBox, StoreBar } from './store';
import { announceAuth, GuestProgressPrompt, useAuthSync } from './account-sync';

/** Store pages get the store bar (categories menu, lists, queue, search) under the top bar. */
const isStore = (path: string) => path === '/' || path === '/browse' || path === '/categories' || path === '/queue' || path.startsWith('/c/') || path.startsWith('/g/');

/** The language menu: a native select (keyboard, screen readers and phones get their own picker), showing a short code in the top bar. */
function LangPicker({ short }: { short?: boolean }) {
  const lang = useLang(), cur = LANGS.find((l) => l.code === lang)!;
  return (
    <label className={'lang' + (short ? '' : ' foot-lang')} title={t('Language', '语言')}>
      <span aria-hidden="true">{short ? cur.short : cur.name}</span><i aria-hidden="true" />
      <select value={lang} onChange={(e) => void setLang(e.target.value as Lang)} aria-label={t('Language', '语言')}>
        {LANGS.map((l) => <option key={l.code} value={l.code} lang={l.tag}>{l.name}</option>)}
      </select>
    </label>
  );
}

/** Day or night. It follows the device until someone picks one here. */
function ThemeSwitch({ label }: { label?: boolean }) {
  const cur = useSyncExternalStore(onTheme, theme), next = cur === 'night' ? 'day' : 'night';
  const name = cur === 'night' ? t('Dark', '深色') : t('Light', '浅色');
  return <button type="button" className={label ? 'tool-btn' : 'icon-btn'} onClick={() => setTheme(next)} aria-label={t('Switch theme', '切换主题')} title={t('Switch theme', '切换主题')}><Icon kind={cur === 'night' ? 'moon' : 'sun'} />{label && <span>{t('Theme', '主题')}: {name}</span>}</button>;
}

function Nav({ user, brand, onLogout }: { user: Me | null; brand: string; onLogout: () => void }) {
  const loc = useLocation(), [open, setOpen] = useState(false), ref = useRef<HTMLDivElement>(null);
  useEffect(() => { setOpen(false); }, [loc]);
  useEffect(() => { const f = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; addEventListener('mousedown', f); return () => removeEventListener('mousedown', f); }, []);
  const path = loc.split('?')[0], onAuth = path === '/login' || path === '/signup', keep = onAuth && loc.includes('?') ? loc.slice(loc.indexOf('?')) : '';   // someone sent here to approve an agent keeps their place
  const on = (p: string) => 'nl' + (path.startsWith(p) ? ' on' : '');
  return (
    <>
      <header className="nav">
        <div className="wrap nav-in">
          <Link to="/" className="brand" aria-label={brand}><i className="logo" aria-hidden="true" /><span>{brand}</span></Link>
          <nav className="nav-links" aria-label={t('Main', '主导航')}>
            <Link to="/" className={'nl' + (isStore(path) ? ' on' : '')}>{t('Store', '商店')}</Link>
            <Link to="/create" className={on('/create')}>{t('For creators', '创作者')}</Link>
            <Link to="/docs" className={on('/docs')}>{t('Docs', '文档')}</Link>
            {user && <Link to="/console" className={on('/console')}>{t('Console', '控制台')}</Link>}
            {user?.role === 'admin' && <Link to="/admin" className={on('/admin')}>{t('Admin', '管理')}</Link>}
          </nav>
          <div className="nav-search"><SearchBox hotkey /></div>
          <div className="nav-tools">
            <ThemeSwitch />
            <LangPicker short />
            {user ? (
              <div className="menu" ref={ref}>
                <button className="avatar" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={t('Account menu', '账户菜单')}>{user.name.slice(0, 1).toUpperCase()}</button>
                {open && (
                  <div className="pop" role="menu">
                    <div className="who"><b className="clip">{user.name}</b><div className="mute clip fs-sm">{user.email}</div></div>
                    <Link to="/console">{t('Console', '控制台')}</Link>
                    <Link to="/console/earnings">{t('Earnings', '收益')}</Link>
                    <Link to="/docs">{t('Docs', '文档')}</Link>
                    {user.role === 'admin' && <Link to="/admin">{t('Admin', '管理后台')}</Link>}
                    <button onClick={onLogout}>{t('Sign out', '退出登录')}</button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <Link to={onAuth ? '/login' + keep : loginUrl()} className="nl nav-signin">{t('Sign in', '登录')}</Link>
                <Button to={'/signup' + keep} variant="primary" size="sm" className="nav-join">{t('Join', '注册')}</Button>
              </>
            )}
          </div>
        </div>
      </header>
      {/* phones: the main places sit in a bar under the thumb */}
      <nav className="tabbar" aria-label={t('Main', '主导航')}>
        <Link to="/" className={path === '/' || path.startsWith('/g/') ? 'on' : ''}><Icon kind="store" /><span>{t('Store', '商店')}</span></Link>
        <Link to="/categories" className={path === '/categories' || path === '/browse' || path.startsWith('/c/') ? 'on' : ''}><Icon kind="grid" /><span>{t('Categories', '分类')}</span></Link>
        <Link to="/create" className={path.startsWith('/create') || path.startsWith('/docs') ? 'on' : ''}><Icon kind="spark" /><span>{t('Creators', '创作者')}</span></Link>
        {user ? <Link to="/console" className={path.startsWith('/console') || path.startsWith('/admin') ? 'on' : ''}><Icon kind="desk" /><span>{t('Console', '控制台')}</span></Link>
          : <Link to={onAuth ? '/login' + keep : loginUrl()} className={onAuth ? 'on' : ''}><Icon kind="user" /><span>{t('Sign in', '登录')}</span></Link>}
      </nav>
    </>
  );
}

function StoreBarSlot() {
  const path = useLocation().split('?')[0];
  return isStore(path) ? <StoreBar /> : null;
}

/** Each page enters like a new level: the wrapper is keyed on the path, so its entrance animation replays. */
function RouteFrame({ children }: { children: ReactNode }) {
  const path = useLocation().split('?')[0];
  return <div className="route" key={path}>{children}</div>;
}

/** Turns the effects on or off for this browser (on by default). Off leaves the plain CSS look. */
function FxToggle() {
  const [on, setOn] = useState(fxPref() === 'on');
  return <button className="tool-btn" aria-pressed={on} onClick={() => { const v = on ? 'off' : 'on'; setFxPref(v); setOn(v === 'on'); }}>{t('Effects', '特效')}: {on ? t('on', '开') : t('off', '关')}</button>;
}

function NotFound() {
  return (
    <div className="wrap nf">
      <div className="nf-art ink"><CelScene seed={5} /><span className="nf-big" aria-hidden="true">404</span></div>
      <h1>{t('Game over for this page', '这个页面不存在')}</h1>
      <p className="mute">{t('It does not exist, or it moved. The games are still here.', '它不存在或已被移动，但游戏都还在。')}</p>
      <SearchBox />
      <div className="row wrapx" style={{ justifyContent: 'center' }}><Button to="/" variant="primary">{t('Back to the store', '返回商店')}</Button><Button to="/categories">{t('Browse categories', '浏览分类')}</Button></div>
    </div>
  );
}

function Routes({ user }: { user: Me | null }) {
  const loc = useLocation(), path = loc.split('?')[0].replace(/\/+$/, '') || '/';
  const needUser = path.startsWith('/console') || path.startsWith('/admin') || path === '/claim-admin' || path === '/device';
  useEffect(() => { if (needUser && !user) navigate(loginUrl(), true); }, [needUser, user, loc]);
  if (needUser && !user) return <RouteSkeleton path={path} />;
  let m: RegExpMatchArray | null;
  if (path === '/') return <Home />;
  if (path === '/browse') return <Browse />;
  if (path === '/categories') return <Categories />;
  if (path === '/queue') return <Queue />;
  if ((m = path.match(/^\/c\/([^/]+)$/))) return <Category key={m[1]} tag={decodeURIComponent(m[1]).toLowerCase()} />;
  if ((m = path.match(/^\/g\/([^/]+)$/))) return <Game key={m[1]} slug={decodeURIComponent(m[1])} />;
  if (path === '/login' || path === '/signup') return <Auth mode={path === '/login' ? 'login' : 'signup'} />;
  if (path === '/create') return <Creators />;
  if (path === '/docs') return <Docs />;
  if (path === '/console') return <Console />;
  if (path === '/console/earnings') return <Earnings />;
  if ((m = path.match(/^\/console\/(?:p|projects)\/([^/]+)$/))) return <Project key={m[1]} id={m[1]} />;
  if ((m = path.match(/^\/console\/p\/([^/]+)\/analytics$/))) return <Analytics key={m[1]} id={m[1]} />;
  if (path === '/claim-admin') return <ClaimAdmin />;
  if (path === '/device') return <Device />;
  if (path === '/legal') return <Legal doc="terms" />;
  if ((m = path.match(/^\/legal\/([a-z]+)$/)) && (LEGAL_DOCS as string[]).includes(m[1])) return <Legal doc={m[1] as LegalDoc} />;
  if ((m = path.match(/^\/admin(?:\/([a-z]+))?$/))) return user?.role === 'admin' ? <Admin tab={m[1] || 'overview'} /> : <NotFound />;
  return <NotFound />;
}

function App() {
  const lang = useLang();
  const [state, setState] = useState<{ user: Me | null; config: Config } | null>(null), [failed, setFailed] = useState(false);
  const [toastMsg, setToast] = useState<{ msg: string; bad: boolean } | null>(null), timer = useRef(0);
  const refresh = useCallback(async () => {
    const [cfg, me] = await Promise.all([api<Config>('/config'), api<{ user: Me | null }>('/me')]);
    setTrialRules(cfg.settings); setState({ user: me.user, config: cfg });
  }, []);
  useEffect(() => { refresh().catch(() => setFailed(true)); }, [refresh]);
  useAuthSync(state ? state.user?.id || null : null, refresh);   // another tab signed in or out: this one follows at once
  const toast = useCallback((msg: string, bad = false) => { setToast({ msg, bad }); clearTimeout(timer.current); timer.current = window.setTimeout(() => setToast(null), bad ? 5200 : 2600); }, []);
  useEffect(() => { if (state) document.title = `${state.config.settings.brand_name} — ${state.config.settings.tagline}`; }, [state]);
  if (failed) return <div className="wrap page"><EmptyState title={t('The site did not respond', '站点暂时无法响应')} action={<Button onClick={() => location.reload()}>{t('Reload', '刷新')}</Button>} /></div>;
  if (!state) return <AppSkeleton path={location.pathname.replace(/\/+$/, '') || '/'} />;
  const logout = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); announceAuth(); await refresh(); navigate('/'); };
  const brand = state.config.settings.brand_name as string;
  return (
    <AppCtx.Provider value={{ ...state, refresh, toast }} key={lang}>
      <Nav user={state.user} brand={brand} onLogout={logout} />
      <StoreBarSlot />
      <main><RouteFrame><Routes user={state.user} /></RouteFrame></main>
      <footer className="foot ink"><div className="wrap">
        <div className="foot-top">
          <div className="foot-brand">
            <Link to="/" className="brand"><i className="logo" aria-hidden="true" /><span>{brand}</span></Link>
            <p className="foot-tag">{state.config.settings.tagline}</p>
            <p className="foot-web">{t('Web games only: every game here runs in a browser page.', '仅支持网页游戏：这里的每款游戏都在浏览器页面中运行。')}</p>
          </div>
          <nav className="foot-col" aria-label={t('Store', '商店')}><b>{t('Store', '商店')}</b><Link to="/">{t('Front page', '首页')}</Link><Link to="/browse">{t('All games', '全部游戏')}</Link><Link to="/categories">{t('Categories', '分类')}</Link><Link to="/browse?sort=new">{t('New releases', '新品')}</Link><Link to="/browse?sort=top">{t('Top rated', '好评榜')}</Link><Link to="/browse?price=free">{t('Free to play', '免费游戏')}</Link><Link to="/queue">{t('Discovery queue', '探索队列')}</Link></nav>
          <nav className="foot-col" aria-label={t('Creators', '创作者')}><b>{t('Creators', '创作者')}</b><Link to="/create">{t('Make a game', '创作游戏')}</Link><Link to="/docs">{t('Docs', '文档')}</Link><Link to="/console">{t('Console', '控制台')}</Link><a href="/guides/platform-contract.md" target="_blank" rel="noreferrer">{t('Platform contract', '平台约定')}</a></nav>
          <nav className="foot-col" aria-label={t('Legal', '法律信息')}><b>{t('Legal', '法律信息')}</b>{LEGAL_DOCS.map((d) => <Link key={d} to={`/legal/${d}`}>{legalTitle(d)}</Link>)}</nav>
        </div>
        <div className="foot-note"><span>© {new Date().getFullYear()} {brand}</span><span className="foot-tools"><ThemeSwitch label /><FxToggle /><LangPicker /></span></div>
      </div></footer>
      <GuestProgressPrompt user={state.user} toast={toast} />
      {toastMsg && <div className={'toast' + (toastMsg.bad ? ' bad' : '')} role="status">{toastMsg.msg}</div>}
    </AppCtx.Provider>
  );
}

void langReady.then(() => createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>));

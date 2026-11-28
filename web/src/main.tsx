import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
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
import { Auth, ClaimAdmin, Verify } from './pages/Auth';
import { Account } from './pages/Account';
import { Creators } from './pages/Creators';
import { Console } from './pages/Console';
import { License, LicenseGate } from './pages/License';
import { Project } from './pages/Project';
import { Analytics } from './pages/Analytics';
import { Team, TeamProject } from './pages/Team';
import { Earnings } from './pages/Earnings';
import { Workbench } from './pages/Workbench';
import { Admin } from './pages/Admin';
import { Device } from './pages/Device';
import { Docs } from './pages/Docs';
import { Download } from './pages/Download';
import { Browse } from './pages/Browse';
import { Categories, Category } from './pages/Categories';
import { Queue } from './pages/Queue';
import { Library } from './pages/Library';
import { Purchases } from './pages/Purchases';
import { Gifts } from './pages/Gifts';
import { CreatorStore, SkillPage } from './pages/CreatorStore';
import { Legal, LEGAL_DOCS, legalTitle, type LegalDoc } from './pages/Legal';
import { OPERATOR } from './operator';
import { SearchBox, StoreBar } from './store';
import { announceAuth, GuestProgressPrompt, useAuthSync } from './account-sync';
import { FriendsButton, SocialRoot } from './social';
import { NotificationsButton } from './follow';
import { Creator } from './pages/Creator';
import { Profile } from './pages/Profile';
import { PlaytestPage } from './playtest-ui';
import { RedeemPage } from './coupon-ui';
import { BundlePage } from './bundle-ui';
import { CollectionPage, CollectionsPage } from './collection-ui';
import { ClipPage, MyClipsPage } from './clip-ui';
import { TournamentPage, TournamentsPage } from './tournament-ui';
import { JamPage, JamsPage } from './jam-ui';
import { InstallAppLink, InstallPrompt } from './install-tip';
import { desktopShell } from './desktop-app';
import { pushLanguage, startPwa } from './pwa';

/** Store pages get the store bar (categories menu, lists, queue, search) under the top bar. */
/** Sign in and Create account stand alone: no top bar, store bar or footer, only the panel and a way home. */
const isBare = (path: string) => /^\/(login|signup)\/?$/.test(path);
const isStore = (path: string) => path === '/' || path === '/browse' || path === '/categories' || path === '/queue' || path.startsWith('/c/') || path.startsWith('/g/') || path.startsWith('/creator/');

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

/** How the top bar fits its width: how many places stay in the row (the rest go under More), and whether the search
 *  box folds to a button that opens it across the bar. It folds the search first, then moves places from the end.
 *  Measured from a hidden copy of the row, so a language with longer words folds sooner and nothing ever runs off. */
const SEARCH_MIN = 180, SEARCH_MIN_PHONE = 150;
function useNavFit(count: number, deps: unknown[]) {
  const row = useRef<HTMLDivElement>(null), measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ shown: count, compact: false });
  useLayoutEffect(() => {
    const el = row.current, m = measure.current; if (!el || !m) return;
    const calc = () => {
      const cs = getComputedStyle(el), gap = parseFloat(cs.columnGap) || 0;
      const width = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const brandW = (el.querySelector('.brand') as HTMLElement | null)?.offsetWidth || 0, toolsW = (el.querySelector('.nav-tools') as HTMLElement | null)?.offsetWidth || 0;
      let next: { shown: number; compact: boolean };
      if (matchMedia('(max-width: 900px)').matches) {   // phones: the places are in the tab bar, only the search has to fit
        next = { shown: count, compact: width - brandW - toolsW - 2 * gap - 4 < SEARCH_MIN_PHONE };
      } else {
        const items = [...m.children] as HTMLElement[], more = items.pop()!, inner = parseFloat(getComputedStyle(m).columnGap) || 0;
        const ws = items.map((x) => x.getBoundingClientRect().width), lead = parseFloat(getComputedStyle(m).marginLeft) || 0;
        const links = (n: number) => ws.slice(0, n).reduce((a, b) => a + b, 0) + inner * Math.max(0, n - 1) + (n < count ? (n ? inner : 0) + more.getBoundingClientRect().width : 0);
        const base = brandW + toolsW + 3 * gap + lead;
        if (base + links(count) + SEARCH_MIN <= width) next = { shown: count, compact: false };
        else { let n = count; while (n > 0 && base + links(n) + 40 > width) n--; next = { shown: n, compact: true }; }
      }
      setFit((f) => (f.shown === next.shown && f.compact === next.compact ? f : next));
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el); ro.observe(m); el.querySelectorAll('.brand, .nav-tools').forEach((x) => ro.observe(x));
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, ...deps]);
  return { row, measure, ...fit };
}

function Nav({ user, brand, onLogout }: { user: Me | null; brand: string; onLogout: () => void }) {
  const loc = useLocation(), lang = useLang(), [open, setOpen] = useState(false), ref = useRef<HTMLDivElement>(null);
  const [moreOpen, setMoreOpen] = useState(false), moreRef = useRef<HTMLDivElement>(null);
  const [searchOpen, setSearchOpen] = useState(false), searchRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setOpen(false); setMoreOpen(false); setSearchOpen(false); }, [loc]);
  useEffect(() => {
    const f = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!ref.current?.contains(n)) setOpen(false);
      if (!moreRef.current?.contains(n)) setMoreOpen(false);
      if (!searchRef.current?.contains(n)) setSearchOpen(false);
    };
    addEventListener('mousedown', f); return () => removeEventListener('mousedown', f);
  }, []);
  const path = loc.split('?')[0], onAuth = path === '/login' || path === '/signup', keep = onAuth && loc.includes('?') ? loc.slice(loc.indexOf('?')) : '';   // someone sent here to approve an agent keeps their place
  const places: { to: string; label: string; on: boolean }[] = [
    { to: '/', label: t('Store', '商店'), on: isStore(path) },
    ...(user ? [{ to: '/library', label: t('Library', '游戏库'), on: path.startsWith('/library') }] : []),
    { to: '/create', label: t('For creators', '创作者'), on: path === '/create' },
    { to: '/creator-store', label: t('Creator Store', '创作者商店'), on: path.startsWith('/creator-store') },
    { to: '/docs', label: t('Docs', '文档'), on: path.startsWith('/docs') },
    ...(desktopShell() ? [] : [{ to: '/download', label: t('Get the app', '下载应用'), on: path === '/download' }]),
    ...(user?.makes_games ? [{ to: '/console', label: t('Console', '控制台'), on: path.startsWith('/console') }] : []),
    ...(user?.role === 'admin' ? [{ to: '/admin', label: t('Admin', '管理'), on: path.startsWith('/admin') }] : []),
  ];
  const fit = useNavFit(places.length, [lang, user?.id]);
  const inRow = places.slice(0, fit.shown), folded = places.slice(fit.shown);
  const compact = fit.compact, showSearch = !compact || searchOpen;
  // the "/" key still finds the search when it is folded to a button
  useEffect(() => {
    if (!compact || searchOpen) return;
    const f = (e: globalThis.KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))) return;
      e.preventDefault(); setSearchOpen(true);
    };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, [compact, searchOpen]);
  useEffect(() => { if (!compact) setSearchOpen(false); }, [compact]);
  return (
    <>
      <header className="nav">
        <div className="wrap nav-in" ref={fit.row}>
          <Link to="/" className="brand" aria-label={brand}><i className="logo" aria-hidden="true" /><span>{brand}</span></Link>
          <nav className="nav-links" aria-label={t('Main', '主导航')}>
            {inRow.map((p) => <Link key={p.to} to={p.to} className={'nl' + (p.on ? ' on' : '')}>{p.label}</Link>)}
            {folded.length > 0 && (
              <div className="menu nav-more" ref={moreRef}>
                <button type="button" className={'nl' + (folded.some((p) => p.on) ? ' on' : '')} onClick={() => setMoreOpen(!moreOpen)} aria-haspopup="menu" aria-expanded={moreOpen}>{t('More', '更多')}<i className="caret" aria-hidden="true" /></button>
                {moreOpen && <div className="pop" role="menu">{folded.map((p) => <Link key={p.to} to={p.to} className={p.on ? 'on' : ''}>{p.label}</Link>)}</div>}
              </div>
            )}
          </nav>
          {/* a hidden copy of the places at full size: what the row is fitted from */}
          <div className="nav-measure" ref={fit.measure} aria-hidden="true">
            {places.map((p) => <span key={p.to} className="nl">{p.label}</span>)}
            <span className="nl">{t('More', '更多')}<i className="caret" /></span>
          </div>
          <div className={'nav-search' + (compact ? ' tight' : '') + (searchOpen ? ' open' : '')} ref={searchRef}
            onKeyDown={(e) => { if (e.key === 'Escape' && searchOpen) setSearchOpen(false); }}>
            {showSearch ? <SearchBox hotkey autoFocus={searchOpen} /> : (
              <button type="button" className="icon-btn" onClick={() => setSearchOpen(true)} aria-label={t('Search games', '搜索游戏')} title={t('Search games', '搜索游戏')}>
                <svg className="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="M13 13l4.5 4.5" /></svg>
              </button>
            )}
            {searchOpen && <button type="button" className="icon-btn nav-search-x" onClick={() => setSearchOpen(false)} aria-label={t('Close', '关闭')}>×</button>}
          </div>
          <div className="nav-tools">
            {user && <NotificationsButton />}
            {user && <FriendsButton />}
            <ThemeSwitch />
            <LangPicker short />
            {user ? (
              <div className="menu" ref={ref}>
                <button className="avatar" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={t('Account menu', '账户菜单')}>{user.name.slice(0, 1).toUpperCase()}</button>
                {open && (
                  <div className="pop" role="menu">
                    <div className="who"><b className="clip">{user.name}</b><div className="mute clip fs-sm">{user.email}</div></div>
                    <Link to={`/u/${encodeURIComponent(user.id)}`}>{t('Your profile', '我的资料')}</Link>
                    <Link to="/library">{t('Library', '游戏库')}</Link>
                    <Link to="/purchases">{t('Purchases and refunds', '购买记录与退款')}</Link>
                    <Link to="/gifts">{t('Gifts', '礼物')}</Link>
                    <Link to="/clips">{t('Your clips', '我的片段')}</Link>
                    {/* the creator's side, only for creators: a player-only account has no console or earnings to look at */}
                    {user.makes_games && <><Link to="/console">{t('Console', '控制台')}</Link><Link to="/console/earnings">{t('Earnings', '收益')}</Link></>}
                    <Link to="/team">{t('Team projects', '团队项目')}</Link>
                    <Link to="/creator-store">{t('Creator Store', '创作者商店')}</Link>
                    <Link to="/docs">{t('Docs', '文档')}</Link>
                    <Link to="/account">{t('Account', '账户')}</Link>
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
        {user && <Link to="/library" className={path === '/library' ? 'on' : ''}><Icon kind="shelf" /><span>{t('Library', '游戏库')}</span></Link>}
        <Link to="/create" className={path === '/create' || path.startsWith('/creator-store') || path.startsWith('/docs') ? 'on' : ''}><Icon kind="spark" /><span>{t('Creators', '创作者')}</span></Link>
        {user?.makes_games ? <Link to="/console" className={path.startsWith('/console') || path.startsWith('/admin') ? 'on' : ''}><Icon kind="desk" /><span>{t('Console', '控制台')}</span></Link>
          : user ? <Link to="/account" className={path === '/account' ? 'on' : ''}><Icon kind="user" /><span>{t('Account', '账户')}</span></Link>
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

/** Sends an old password-reset link or bookmark to the sign-in page. */
function ToLogin() { useEffect(() => navigate('/login', true), []); return null; }

function Routes({ user }: { user: Me | null }) {
  const loc = useLocation(), path = loc.split('?')[0].replace(/\/+$/, '') || '/';
  const needUser = path === '/library' || path === '/purchases' || path === '/gifts' || path === '/clips' || path === '/license' || path.startsWith('/console') || path.startsWith('/admin') || path === '/claim-admin' || path === '/device' || path === '/account' || path === '/team' || path.startsWith('/team/');
  useEffect(() => { if (needUser && !user) navigate(loginUrl(), true); }, [needUser, user, loc]);
  if (needUser && !user) return <RouteSkeleton path={path} />;
  let m: RegExpMatchArray | null;
  if (path === '/') return <Home />;
  if (path === '/browse') return <Browse />;
  if (path === '/categories') return <Categories />;
  if (path === '/queue') return <Queue />;
  if ((m = path.match(/^\/c\/([^/]+)$/))) return <Category key={m[1]} tag={decodeURIComponent(m[1]).toLowerCase()} />;
  if ((m = path.match(/^\/g\/([^/]+)$/))) return <Game key={m[1]} slug={decodeURIComponent(m[1])} />;
  if ((m = path.match(/^\/creator\/([^/]+)$/))) return <Creator key={m[1]} id={decodeURIComponent(m[1])} />;
  if ((m = path.match(/^\/u\/([^/]+)$/))) return <Profile key={m[1]} id={decodeURIComponent(m[1])} />;
  if ((m = path.match(/^\/playtest\/([a-z0-9]{6,20})$/))) return <PlaytestPage key={m[1]} code={m[1]} />;
  if (path === '/redeem') return <RedeemPage />;
  if (path === '/collections') return <CollectionsPage />;
  if (path === '/clips') return <MyClipsPage />;
  if (path === '/tournaments') return <TournamentsPage />;
  if ((m = path.match(/^\/tournaments\/([a-z0-9-]{1,60})$/))) return <TournamentPage key={m[1]} slug={m[1]} />;
  if ((m = path.match(/^\/clip\/(clp_[a-z0-9]{6,20})$/))) return <ClipPage key={m[1]} id={m[1]} />;
  if ((m = path.match(/^\/collections\/([a-z0-9-]{1,60})$/))) return <CollectionPage key={m[1]} slug={m[1]} />;
  if ((m = path.match(/^\/bundles\/([a-z0-9-]{1,60})$/))) return <BundlePage key={m[1]} slug={m[1]} />;
  if (path === '/jams') return <JamsPage />;
  if ((m = path.match(/^\/jams\/([a-z0-9-]{3,60})$/))) return <JamPage key={m[1]} slug={m[1]} />;
  if (path === '/login' || path === '/signup') return <Auth mode={path === '/login' ? 'login' : 'signup'} tools={<><ThemeSwitch /><LangPicker short /></>} />;
  if (path === '/verify') return <Verify />;
  // passwords are gone: old reset links and bookmarks land on the sign-in page
  if (path === '/forgot' || path === '/reset') return <ToLogin />;
  if (path === '/account') return <Account />;
  if (path === '/library') return <Library />;
  if (path === '/purchases') return <Purchases />;
  if (path === '/gifts') return <Gifts />;
  if (path === '/create') return <Creators />;
  if (path === '/creator-store') return <CreatorStore />;
  if ((m = path.match(/^\/creator-store\/([^/]+)$/))) return <SkillPage key={m[1]} slug={decodeURIComponent(m[1])} />;
  if (path === '/docs') return <Docs />;
  if (path === '/download') return <Download />;
  if (path === '/license') return <License />;
  // Collaborators need no creator license: a project shared with you is worked on from /team.
  if (path === '/team') return <Team />;
  if ((m = path.match(/^\/team\/([^/]+)$/))) return <TeamProject key={m[1]} id={decodeURIComponent(m[1])} />;
  // The console is for creators only: without a valid license every console page is the Get License page.
  if (path.startsWith('/console') && !user!.creator) return <LicenseGate />;
  if (path === '/console') return <Console />;
  if (path === '/console/earnings') return <Earnings />;
  if (path === '/console/workbench') return <Workbench />;
  if ((m = path.match(/^\/console\/(?:p|projects)\/([^/]+)$/))) return <Project key={m[1]} id={m[1]} />;
  if ((m = path.match(/^\/console\/p\/([^/]+)\/analytics$/))) return <Analytics key={m[1]} id={m[1]} />;
  if ((m = path.match(/^\/console\/p\/([^/]+)\/team$/))) return <TeamProject key={m[1]} id={m[1]} inConsole />;
  if (path === '/claim-admin') return <ClaimAdmin />;
  if (path === '/device') return <Device />;
  if (path === '/legal') return <Legal doc="terms" />;
  if ((m = path.match(/^\/legal\/([a-z]+)$/)) && (LEGAL_DOCS as string[]).includes(m[1])) return <Legal doc={m[1] as LegalDoc} />;
  if ((m = path.match(/^\/admin(?:\/([a-z]+))?$/))) return user?.role === 'admin' ? <Admin tab={m[1] || 'overview'} /> : <NotFound />;
  return <NotFound />;
}

/** Links the operator's name inside a translated footer line to its site, so the platform and the company point at each other. */
function linkOperator(text: string) {
  const [before, ...rest] = text.split(OPERATOR.name);
  return rest.length ? <>{before}<a href={OPERATOR.url} target="_blank" rel="noreferrer">{OPERATOR.name}</a>{rest.join(OPERATOR.name)}</> : text;
}

function App() {
  // A new platform language re-renders the whole app in place. Nothing is remounted, so a running game keeps running
  // (its frame is told the new language through the SDK: GCP.lang, GCP.onLang), and forms and scroll positions stay as they were.
  const lang = useLang();
  const bare = isBare(useLocation().split('?')[0]);
  const [state, setState] = useState<{ user: Me | null; config: Config } | null>(null), [failed, setFailed] = useState(false);
  const [toastMsg, setToast] = useState<{ msg: string; bad: boolean } | null>(null), timer = useRef(0);
  const refresh = useCallback(async () => {
    const [cfg, me] = await Promise.all([api<Config>('/config'), api<{ user: Me | null }>('/me')]);
    setTrialRules(cfg.settings); setState({ user: me.user, config: cfg });
  }, []);
  // notifications on this device follow the platform language (web/src/pwa.ts)
  const signedIn = !!state?.user;
  useEffect(() => { if (signedIn) void pushLanguage(); }, [lang, signedIn]);
  useEffect(() => { refresh().catch(() => setFailed(true)); }, [refresh]);
  useAuthSync(state ? state.user?.id || null : null, refresh);   // another tab signed in or out: this one follows at once
  const toast = useCallback((msg: string, bad = false) => { setToast({ msg, bad }); clearTimeout(timer.current); timer.current = window.setTimeout(() => setToast(null), bad ? 5200 : 2600); }, []);
  useEffect(() => { if (state) document.title = `${state.config.settings.brand_name} — ${state.config.settings.tagline}`; }, [state]);
  if (failed) return <div className="wrap page"><EmptyState title={t('The site did not respond', '站点暂时无法响应')} action={<Button onClick={() => location.reload()}>{t('Reload', '刷新')}</Button>} /></div>;
  if (!state) return bare ? <main><RouteSkeleton path={location.pathname.replace(/\/+$/, '')} /></main> : <AppSkeleton path={location.pathname.replace(/\/+$/, '') || '/'} />;
  const logout = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); announceAuth(); await refresh(); navigate('/'); };
  const brand = state.config.settings.brand_name as string;
  return (
    <AppCtx.Provider value={{ ...state, refresh, toast }}>
      {!bare && <><Nav user={state.user} brand={brand} onLogout={logout} />
      <StoreBarSlot /></>}
      <main><RouteFrame><Routes user={state.user} /></RouteFrame></main>
      {!bare && <footer className="foot ink"><div className="wrap">
        <div className="foot-top">
          <div className="foot-brand">
            <Link to="/" className="brand"><i className="logo" aria-hidden="true" /><span>{brand}</span></Link>
            <p className="foot-tag">{state.config.settings.tagline}</p>
            <p className="foot-web">{t('Web games only: every game here runs in a browser page.', '仅支持网页游戏：这里的每款游戏都在浏览器页面中运行。')}</p>
          </div>
          <nav className="foot-col" aria-label={t('Store', '商店')}><b>{t('Store', '商店')}</b><Link to="/">{t('Front page', '首页')}</Link><Link to="/browse">{t('All games', '全部游戏')}</Link><Link to="/categories">{t('Categories', '分类')}</Link><Link to="/browse?sort=new">{t('New releases', '新品')}</Link><Link to="/browse?sort=top">{t('Top rated', '好评榜')}</Link><Link to="/browse?price=free">{t('Free to play', '免费游戏')}</Link><Link to="/queue">{t('Discovery queue', '探索队列')}</Link><Link to="/collections">{t('Lists', '清单')}</Link><Link to="/jams">{t('Jams and festivals', '游戏创作节与游戏节')}</Link><Link to="/tournaments">{t('Tournaments', '锦标赛')}</Link><Link to="/redeem">{t('Redeem a key', '兑换激活码')}</Link><Link to="/download">{t('Get the app', '下载应用')}</Link></nav>
          <nav className="foot-col" aria-label={t('Creators', '创作者')}><b>{t('Creators', '创作者')}</b><Link to="/create">{t('Make a game', '创作游戏')}</Link><Link to="/creator-store">{t('Creator Store', '创作者商店')}</Link><Link to="/jams">{t('Host a jam', '主办游戏创作节')}</Link><Link to="/docs">{t('Docs', '文档')}</Link><Link to="/console">{t('Console', '控制台')}</Link><a href="/guides/platform-contract.md" target="_blank" rel="noreferrer">{t('Platform contract', '平台约定')}</a></nav>
          <nav className="foot-col" aria-label={t('Legal', '法律信息')}><b>{t('Legal', '法律信息')}</b>{LEGAL_DOCS.map((d) => <Link key={d} to={`/legal/${d}`}>{legalTitle(d)}</Link>)}</nav>
        </div>
        <div className="foot-note">
          <div className="foot-legal">
            <span>{linkOperator(t('© {year} {op}. All rights reserved.', '© {year} {op}。保留所有权利。', { year: new Date().getFullYear(), op: OPERATOR.name }))}</span>
            <span>{linkOperator(t('{brand} is developed and operated by {op}.', '{brand} 由 {op} 开发和运营。', { brand, op: OPERATOR.name }))}</span>
            <span className="foot-links"><Link to="/legal/terms">{legalTitle('terms')}</Link><Link to="/legal/privacy">{legalTitle('privacy')}</Link><a href={`mailto:${OPERATOR.contactEmail}`}>{t('Contact ({email})', '联系我们（{email}）', { email: OPERATOR.contactEmail })}</a></span>
          </div>
          <span className="foot-tools"><InstallAppLink /><ThemeSwitch label /><FxToggle /><LangPicker /></span></div>
      </div></footer>}
      <GuestProgressPrompt user={state.user} toast={toast} />
      {!bare && <SocialRoot />}
      {!bare && <InstallPrompt />}
      {toastMsg && <div className={'toast' + (toastMsg.bad ? ' bad' : '')} role="status">{toastMsg.msg}</div>}
    </AppCtx.Provider>
  );
}

startPwa();
void langReady.then(() => createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>));

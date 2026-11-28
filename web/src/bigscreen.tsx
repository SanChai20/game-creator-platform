// Big-screen mode (/tv): the store laid out for a TV or a desktop across the room, driven by a controller (web/src/gamepad.ts),
// the arrow keys or a remote. Rows of large covers (Continue, your games, then the store's shelves) under a panel that shows
// the focused game. A plays (the game page opens it filling the screen, ?tv=1) and Quit in the game menu comes back here.
// The game's own controls stay the game's: the Home button, or Start + Select, opens the platform menu over it.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, artStyle, CoverImg, genreName, loginUrl, MatureTag, navigate, num, price, shown, t, useApp, type GameCard } from './lib';
import { moveFocus, onPad } from './gamepad';
import { Button } from './ui';
import './bigscreen.css';

type Row = { key: string; title: string; games: GameCard[] };
type Home = { shelves: Record<string, GameCard[]> };

const ARROWS: Record<string, 'up' | 'down' | 'left' | 'right'> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/** Opens a game from big-screen mode: its page starts it filling the screen and Quit comes back to /tv. */
export const playOnTv = (slug: string) => navigate(`/g/${encodeURIComponent(slug)}?play=1&tv=1`);

function Tile({ g: raw, first, onFocus }: { g: GameCard; first: boolean; onFocus: () => void }) {
  const g = shown(raw);
  return (
    <button type="button" className="tv-tile" data-pad-start={first || undefined} onFocus={onFocus} onMouseEnter={onFocus} onClick={() => playOnTv(g.slug)} aria-label={g.title}>
      <span className="tv-art" style={g.cover ? undefined : artStyle(g.slug)}>
        {g.cover ? <CoverImg g={g} src={g.cover} /> : <span className="tv-mono">{g.title}</span>}
        <MatureTag g={g} />
      </span>
      <span className="tv-name">{g.title}</span>
    </button>
  );
}

function Hero({ g: raw }: { g: GameCard | null }) {
  if (!raw) return <section className="tv-hero" aria-hidden="true" />;
  const g = shown(raw), genre = g.tags[0];
  return (
    <section className="tv-hero" aria-live="polite">
      <div className="tv-back" style={g.cover ? ({ backgroundImage: `url("${g.cover}")` } as CSSProperties) : artStyle(g.slug)} aria-hidden="true" />
      <div className="tv-hero-b">
        <h1 className="tv-title">{g.title}</h1>
        {g.tagline && <p className="tv-tag">{g.tagline}</p>}
        <p className="tv-meta">
          {genre && <span>{genreName(genre)}</span>}
          <span>{g.rating != null ? `★ ${g.rating.toFixed(1)}` : t('New', '新上架')}</span>
          <span>{price(g.price_cents)}</span>
          {!!g.playing && <span>{t('{n} playing now', '{n} 人正在玩', { n: num(g.playing) })}</span>}
          <span>{t('By {name}', '作者：{name}', { name: g.author })}</span>
        </p>
      </div>
    </section>
  );
}

export function BigScreenPage() {
  const { user, config } = useApp();
  const [rows, setRows] = useState<Row[] | null>(null), [sel, setSel] = useState<GameCard | null>(null), [pad, setPad] = useState(false);
  const focused = useRef(false);
  useEffect(() => {
    let live = true;
    (async () => {
      const [home, cont, lib] = await Promise.all([
        api<Home>('/home'),
        user ? api<{ games: GameCard[] }>('/me/continue?per_page=24').catch(() => ({ games: [] })) : Promise.resolve({ games: [] as GameCard[] }),
        user ? api<{ owned: { games: GameCard[] } | null }>('/me/library').catch(() => ({ owned: null })) : Promise.resolve({ owned: null }),
      ]);
      const s = home.shelves, seen = new Set<string>();
      const row = (key: string, title: string, games: GameCard[] | undefined, dedupe = false): Row => ({ key, title, games: (games || []).filter((g) => { if (dedupe && seen.has(g.slug)) return false; seen.add(g.slug); return true; }) });
      const out = [
        row('continue', t('Continue playing', '继续游玩'), cont.games),
        row('owned', t('Your games', '我的游戏'), lib.owned?.games, true),
        row('picks', t("Today's picks", '今日精选'), s.picks),
        row('trending', t('Trending', '热门'), s.trending),
        row('playing', t('Playing now', '正在玩'), s.playing),
        row('new', t('New', '新上架'), s.new),
        row('top', t('Top rated', '好评榜'), s.top),
        row('free', t('Free to play', '免费游戏'), s.free),
      ].filter((r) => r.games.length);
      if (live) { setRows(out); setSel(out[0]?.games[0] || null); }
    })().catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // start on the first game, and keep the arrow keys (keyboards, TV remotes) moving between controls
  useEffect(() => { if (rows?.length && !focused.current) { focused.current = true; setTimeout(() => (document.querySelector<HTMLElement>('.tv [data-pad-start]'))?.focus({ preventScroll: true }), 30); } }, [rows]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { const d = ARROWS[e.key]; if (d && !(e.target as HTMLElement)?.matches?.('input, textarea, select')) { e.preventDefault(); document.documentElement.classList.add('pad-nav'); moveFocus(d); } };
    // B on the home rows does nothing (Exit is a button); the platform keeps Escape for menus
    const back = (e: Event) => { if ((e as CustomEvent).detail?.button === 'back') e.preventDefault(); };
    window.addEventListener('keydown', key); window.addEventListener('gcp-pad', back);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('gcp-pad', back); };
  }, []);
  useEffect(() => onPad(setPad), []);
  useEffect(() => { const prev = document.title; document.title = `${config.settings.brand_name} · ${t('Big screen', '大屏模式')}`; return () => { document.title = prev; }; }, [config.settings.brand_name]);
  const full = () => { const d = document as Document & { webkitFullscreenElement?: Element }; if (d.fullscreenElement || d.webkitFullscreenElement) void document.exitFullscreen?.().catch(() => {}); else void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {}); };
  return (
    <div className="tv">
      <header className="tv-top">
        <span className="tv-brand"><i className="logo" aria-hidden="true" />{config.settings.brand_name as string}<small>{t('Big screen', '大屏模式')}</small></span>
        <span className="tv-top-r">
          {user ? <span className="tv-user">{user.name}</span> : <button type="button" className="tv-btn" onClick={() => navigate(loginUrl('/tv'))}>{t('Sign in', '登录')}</button>}
          <button type="button" className="tv-btn" onClick={full}>{t('Full screen', '全屏')}</button>
          <button type="button" className="tv-btn" onClick={() => navigate('/')}>{t('Exit big screen', '退出大屏模式')}</button>
        </span>
      </header>
      <Hero g={sel} />
      <div className="tv-rows">
        {rows === null ? <p className="tv-note">{t('Loading games…', '正在加载游戏…')}</p>
          : !rows.length ? <p className="tv-note">{t('No games to show yet.', '暂时没有可显示的游戏。')}</p>
            : rows.map((r, ri) => (
              <section key={r.key} className="tv-sec" aria-label={r.title}>
                <h2>{r.title}</h2>
                <div className="tv-row">{r.games.map((g, i) => <Tile key={g.slug} g={g} first={ri === 0 && i === 0} onFocus={() => setSel(g)} />)}</div>
              </section>
            ))}
      </div>
      <footer className="tv-hints" aria-hidden="true">
        {pad ? <><span><kbd>A</kbd>{t('Play', '开始玩')}</span><span><kbd>B</kbd>{t('Back', '返回')}</span><span><kbd>⌂</kbd>{t('Game menu (or Start + Select)', '游戏菜单（或 Start + Select）')}</span></>
          : <><span><kbd>←↑↓→</kbd>{t('Move', '移动')}</span><span><kbd>Enter</kbd>{t('Play', '开始玩')}</span><span>{t('Connect a controller to play from the couch.', '连接手柄即可坐在沙发上玩。')}</span></>}
      </footer>
    </div>
  );
}

/** When a controller connects on an ordinary page: offer big-screen mode once per visit (not on /tv, not mid-game). */
export function PadPrompt() {
  const [show, setShow] = useState(false), asked = useRef(false);
  useEffect(() => onPad((on) => {
    if (!on) { setShow(false); return; }
    if (asked.current || location.pathname === '/tv' || new URLSearchParams(location.search).get('tv') === '1') return;
    try { if (sessionStorage.getItem('gcp_pad_prompt')) return; sessionStorage.setItem('gcp_pad_prompt', '1'); } catch { /* storage blocked */ }
    asked.current = true; setShow(true);
  }), []);
  if (!show) return null;
  return (
    <div className="tv-prompt" role="dialog" aria-modal="true" aria-label={t('Controller connected', '已连接手柄')}>
      <b>{t('Controller connected', '已连接手柄')}</b>
      <span>{t('Browse and play with it in big-screen mode.', '在大屏模式下用手柄浏览和游玩。')}</span>
      <span className="row">
        <Button size="sm" variant="primary" onClick={() => { setShow(false); navigate('/tv'); }}>{t('Open big screen', '打开大屏模式')}</Button>
        <Button size="sm" variant="ghost" onClick={() => setShow(false)}>{t('Not now', '暂不')}</Button>
      </span>
    </div>
  );
}

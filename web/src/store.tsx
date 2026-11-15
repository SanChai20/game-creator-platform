// The store's building blocks, shared by the home page and the browse page: instant search, the spotlight, shelves,
// genres and the key numbers. Everything here is sized for a catalogue of tens of thousands of games: lists are
// paged, rows scroll sideways, and nothing assumes a fixed number of games.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { ago, api, artStyle, count, GameTile, lastVisit, Link, navigate, num, price, RARITY, rarity, rarityHint, recentPlays, Stars, t, type GameCard } from './lib';

/** A colour pair for a genre, stable for its name, so every genre tile has its own look without artwork. */
export function genreHue(tag: string) {
  let h = 2166136261; for (let i = 0; i < tag.length; i++) { h ^= tag.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 360;
}
export const genreName = (tag: string) => tag.charAt(0).toUpperCase() + tag.slice(1);

// ---- search -------------------------------------------------------------------------------------
/**
 * Search with instant results: up to six matching games appear under the box as you type; Enter opens the
 * highlighted game, or the full results on the browse page. "/" focuses it from anywhere.
 */
export function SearchBox({ initial = '', autoFocus, big, onSubmit }: { initial?: string; autoFocus?: boolean; big?: boolean; onSubmit?: (q: string) => void }) {
  const [q, setQ] = useState(initial), [hits, setHits] = useState<GameCard[]>([]), [total, setTotal] = useState(0), [open, setOpen] = useState(false), [sel, setSel] = useState(-1);
  const box = useRef<HTMLInputElement>(null), wrap = useRef<HTMLDivElement>(null), id = useId(), seq = useRef(0);
  useEffect(() => { setQ(initial); }, [initial]);
  useEffect(() => {
    const s = q.trim(); if (s.length < 2) { setHits([]); setTotal(0); return; }
    const n = ++seq.current;
    const tm = setTimeout(() => {
      api<{ games: GameCard[]; total: number }>(`/games?q=${encodeURIComponent(s)}&limit=6&facets=0&sort=played`).then((r) => { if (n === seq.current) { setHits(r.games); setTotal(r.total); setSel(-1); } }, () => {});
    }, 160);
    return () => clearTimeout(tm);
  }, [q]);
  useEffect(() => {
    if (!big) return;
    const f = (e: globalThis.KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))) return;
      e.preventDefault(); box.current?.focus();
    };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, [big]);
  useEffect(() => { const f = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); }; addEventListener('mousedown', f); return () => removeEventListener('mousedown', f); }, []);
  const go = (s: string) => { setOpen(false); box.current?.blur(); if (onSubmit) onSubmit(s); else navigate('/browse' + (s ? '?q=' + encodeURIComponent(s) : '')); };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setSel((v) => Math.min(hits.length - 1, v + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((v) => Math.max(-1, v - 1)); }
    else if (e.key === 'Escape') { setOpen(false); setSel(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (sel >= 0 && hits[sel]) { setOpen(false); navigate(`/g/${hits[sel].slug}`); } else go(q.trim()); }
  };
  const show = open && q.trim().length >= 2;
  return (
    <div className={'sbox' + (big ? ' big' : '')} ref={wrap}>
      <svg className="sbox-i" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="M13 13l4.5 4.5" /></svg>
      <input ref={box} type="search" value={q} autoFocus={autoFocus} placeholder={t('Search games, genres, creators', '搜索游戏、类型、创作者')}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={key}
        role="combobox" aria-expanded={show} aria-controls={id} aria-autocomplete="list" aria-activedescendant={sel >= 0 ? `${id}-${sel}` : undefined} aria-label={t('Search games', '搜索游戏')} />
      {big && !q && <kbd className="sbox-k" aria-hidden="true">/</kbd>}
      {show && (
        <div className="sbox-pop" id={id} role="listbox">
          {hits.map((g, i) => (
            <Link key={g.id} to={`/g/${g.slug}`} className={'sbox-row' + (i === sel ? ' on' : '')} onClick={() => setOpen(false)}>
              <span className="thumb" id={`${id}-${i}`} role="option" aria-selected={i === sel} style={g.cover ? undefined : artStyle(g.slug)}>{g.cover && <img src={g.cover} alt="" loading="lazy" />}</span>
              <span className="grow"><b className="clip">{g.title}</b><small className="clip">{g.author} · {g.tags.slice(0, 2).join(' · ')}</small></span>
              <span className="sbox-p">{price(g.price_cents)}</span>
            </Link>
          ))}
          {!hits.length && <div className="sbox-none">{t('No games match yet.', '暂无匹配的游戏。')}</div>}
          <button type="button" className="sbox-all" onClick={() => go(q.trim())}>{total ? t(`See all ${num(total)} results`, `查看全部 ${num(total)} 个结果`) : t('Search the whole catalogue', '在全部游戏中搜索')} <em aria-hidden="true">↵</em></button>
        </div>
      )}
    </div>
  );
}

// ---- spotlight ----------------------------------------------------------------------------------
/**
 * The home page's lead: a few picks (featured first, then what is hot) in turns. It advances by itself every
 * eight seconds, stops while you hover or focus it, and never moves on its own under reduced motion. The banner
 * picture is drawn by the GPU layer (data-gl="hero") where that runs.
 */
export function Spotlight({ games }: { games: GameCard[] }) {
  const picks = games.slice(0, 5), [i, setI] = useState(0), [paused, setPaused] = useState(false);
  const still = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  useEffect(() => {
    if (still || paused || picks.length < 2) return;
    const tm = setTimeout(() => setI((v) => (v + 1) % picks.length), 8000);
    return () => clearTimeout(tm);
  }, [i, paused, still, picks.length]);
  if (!picks.length) return null;
  const g = picks[Math.min(i, picks.length - 1)], R = RARITY[rarity(g)];
  return (
    <section className="spot" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)} aria-roledescription={t('carousel', '轮播')} aria-label={t('Spotlight', '焦点推荐')}>
      <Link to={`/g/${g.slug}`} className="spot-main" title={g.title} key={g.id} data-gl-host="">
        {g.cover && <span className="gl-slot" data-gl="hero" data-gl-src={g.cover} aria-hidden="true" />}
        <div className="art" style={g.cover ? undefined : artStyle(g.slug)}>{g.cover && <img src={g.cover} alt="" />}</div>
        <div className="spot-body" aria-live={paused ? 'polite' : 'off'}>
          <div className="spot-tags" style={{ '--rc': R.color } as CSSProperties}>
            <span className="spot-kind">{g.featured ? t('Featured', '精选') : i === 0 ? t('#1 this week', '本周第一') : t('Trending', '热门')}</span>
            <span className="rar" title={rarityHint()}>{R.name()}</span>
            {g.tags.slice(0, 2).map((x) => <span key={x} className="tag">{x}</span>)}
          </div>
          <h2>{g.title}</h2>
          {g.tagline && <p className="lede">{g.tagline}</p>}
          <div className="spot-meta"><span>{t('by', '作者')} <b>{g.author}</b></span><Stars rating={g.rating} count={g.rating_count} /><span className="num">{count(g.plays, 'play', 'plays', '次游玩')}</span>{!!g.playing && <span className="live">{num(g.playing)} {t('playing now', '人在玩')}</span>}</div>
          <div><span className="btn btn-primary btn-lg">{g.price_cents > 0 ? `${t('Get it', '购买')} · ${price(g.price_cents)}` : `▶ ${t('Play free', '免费游玩')}`}</span></div>
        </div>
      </Link>
      <div className="spot-list" role="tablist" aria-label={t('Spotlight picks', '焦点推荐列表')}>
        {picks.map((x, k) => (
          <button key={x.id} role="tab" aria-selected={k === i} className={'spot-tab' + (k === i ? ' on' : '') + (paused || still ? ' held' : '')} onClick={() => setI(k)}>
            <span className="thumb" style={x.cover ? undefined : artStyle(x.slug)}>{x.cover && <img src={x.cover} alt="" loading="lazy" />}</span>
            <span className="grow"><b className="clip">{x.title}</b><small className="clip">{x.price_cents > 0 ? price(x.price_cents) : t('Free', '免费')} · {x.playing ? `${num(x.playing)} ${t('playing', '人在玩')}` : count(x.plays, 'play', 'plays', '次游玩')}</small></span>
            {k === i && <i className="spot-bar" key={i + (paused ? 'p' : '')} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </section>
  );
}

// ---- key numbers --------------------------------------------------------------------------------
export interface StoreStats { games: number; new_week: number; playing: number; creators: number }
export function Stats({ s }: { s: StoreStats }) {
  const items: [ReactNode, string, string?][] = [
    [num(s.games), t('web games', '款网页游戏'), '/browse'],
    [num(s.playing), t('playing right now', '人正在玩'), '/browse?sort=playing'],
    [num(s.new_week), t('new this week', '本周新上架'), '/browse?sort=new'],
    [num(s.creators), t(s.creators === 1 ? 'creator' : 'creators', '位创作者'), '/create'],
  ];
  return (
    <div className="kpis">{items.map(([v, l, to], k) => (
      <Link key={k} to={to || '/'} className={'kpi' + (k === 1 && s.playing > 0 ? ' is-live' : '')}><b className="num">{v}</b><span>{l}</span></Link>
    ))}</div>
  );
}

// ---- shelves ------------------------------------------------------------------------------------
/** A row of games that scrolls sideways, with a heading, a short note and a way to see the whole list. */
export function Shelf({ title, note, to, games, live, rank, freshSince }: { title: ReactNode; note?: ReactNode; to?: string; games: GameCard[]; live?: boolean; rank?: boolean; freshSince?: number | null }) {
  const row = useRef<HTMLDivElement>(null), [edge, setEdge] = useState({ l: false, r: true });
  const check = useCallback(() => { const el = row.current; if (!el) return; setEdge({ l: el.scrollLeft > 8, r: el.scrollLeft + el.clientWidth < el.scrollWidth - 8 }); }, []);
  useEffect(() => { check(); }, [games, check]);
  if (!games.length) return null;
  const page = (d: number) => { const el = row.current; if (el) el.scrollBy({ left: d * el.clientWidth * 0.85, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); };
  return (
    <section className={'shelf' + (live ? ' is-live' : '')}>
      <header className="shelf-h">
        <div className="grow"><h2>{live && <i className="live-dot" aria-hidden="true" />}{title}</h2>{note && <p>{note}</p>}</div>
        <div className="shelf-nav">
          <button type="button" onClick={() => page(-1)} disabled={!edge.l} aria-label={t('Scroll back', '向左滚动')}>←</button>
          <button type="button" onClick={() => page(1)} disabled={!edge.r} aria-label={t('Scroll on', '向右滚动')}>→</button>
        </div>
        {to && <Link to={to} className="shelf-all">{t('See all', '查看全部')} →</Link>}
      </header>
      <div className="shelf-row" ref={row} onScroll={check}>
        {games.map((g, k) => <div className="shelf-cell" key={g.id}>{rank && <span className="rank" aria-hidden="true">{k + 1}</span>}<GameTile g={g} fresh={!!freshSince && !!g.published_at && g.published_at > freshSince} /></div>)}
      </div>
    </section>
  );
}

// ---- genres -------------------------------------------------------------------------------------
export function Genres({ list }: { list: { tag: string; n: number }[] }) {
  if (!list.length) return null;
  return (
    <section className="genres">
      <header className="shelf-h"><div className="grow"><h2>{t('Browse by genre', '按类型浏览')}</h2></div><Link to="/browse" className="shelf-all">{t('All games', '全部游戏')} →</Link></header>
      <div className="genre-row">
        {list.map(({ tag, n }) => (
          <Link key={tag} to={`/browse?tag=${encodeURIComponent(tag)}`} className="genre" >
            <span className="genre-in" style={{ '--h': genreHue(tag) } as CSSProperties}><b>{genreName(tag)}</b><small className="num">{num(n)} {t(n === 1 ? 'game' : 'games', '款')}</small></span>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ---- reasons to come back -----------------------------------------------------------------------
/** "Jump back in" (games this browser played) and "new since your last visit". Shows nothing on a first visit. */
export function Since({ newCount, since }: { newCount: number; since: number | null }) {
  const [recent] = useState(() => recentPlays().slice(0, 4));
  if (!recent.length && !newCount) return null;
  return (
    <div className="since">
      {recent.length > 0 && (
        <div className="since-recent">
          <span className="since-h">{t('Jump back in', '继续玩')}</span>
          <div className="since-list">{recent.map((r) => (
            <Link key={r.slug} to={`/g/${r.slug}`} className="since-item">
              <span className="thumb" style={artStyle(r.slug)}>{r.cover && <img src={r.cover} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}</span>
              <span className="grow"><b className="clip">{r.title}</b><small>{ago(r.at)}</small></span>
            </Link>))}</div>
        </div>
      )}
      {newCount > 0 && since && <Link to={`/browse?sort=new&since=${since}`} className="since-new"><b className="num">{num(newCount)}</b><span>{t(newCount === 1 ? 'new game since your last visit' : 'new games since your last visit', '款新游戏，自你上次来访后上架')}</span><em aria-hidden="true">→</em></Link>}
    </div>
  );
}
export { lastVisit };

/** "More like this" for a game page: the same genre, most played first, without the game itself. */
export function MoreLike({ tag, slug }: { tag?: string; slug: string }) {
  const [games, setGames] = useState<GameCard[]>([]);
  useEffect(() => {
    if (!tag) return;
    api<{ games: GameCard[] }>(`/games?tag=${encodeURIComponent(tag)}&limit=13&facets=0&sort=played`).then((r) => setGames(r.games.filter((g) => g.slug !== slug).slice(0, 12)), () => {});
  }, [tag, slug]);
  return <Shelf title={t(`More ${genreName(tag || '')} games`, `更多${genreName(tag || '')}游戏`)} to={`/browse?tag=${encodeURIComponent(tag || '')}`} games={games} />;
}

// The store's building blocks, shared by the home page, the browse and category pages and the game page: the store
// bar with its categories menu, instant search, the featured carousel, tabbed lists with a preview, shelves,
// category cartridges, the discovery queue and the pager. Everything here is sized for a catalogue of tens of
// thousands of games: lists are paged, rows scroll sideways, and nothing assumes a fixed number of games.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { CountUp } from './ui/count';
import { SkHits, SkShelf } from './skeletons';
import { ago, api, artStyle, blurb, count, CoverImg, GameTile, genreHue, genreName, lastVisit, Link, navigate, num, price, RARITY, rarity, rarityHint, recentPlays, seenGames, t, trialLabel, trialOf, MatureTag, useLocation, Verdict, type GameCard } from './lib';

export { genreHue, genreName, lastVisit };
export interface Genre { tag: string; n: number; covers?: string[]; group?: string | null }
const still = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const hue = (tag?: string) => ({ '--h': tag ? genreHue(tag) : 350 } as CSSProperties);

// ---- the categories, fetched once per visit -----------------------------------------------------
let genresCache: Promise<Genre[]> | null = null;
export function useGenres() {
  const [list, setList] = useState<Genre[]>([]);
  useEffect(() => {
    genresCache ||= api<{ genres: Genre[] }>('/categories').then((r) => r.genres, () => { genresCache = null; return []; });
    let on = true; void genresCache.then((g) => { if (on) setList(g); }); return () => { on = false; };
  }, []);
  return list;
}

// ---- section heads ------------------------------------------------------------------------------
/** A section head: the title, a quiet note, and the way to see more. (`n` is accepted and not shown: sections are no longer numbered.) */
export function SectionHead({ title, note, to, more, children, live }: { n?: string; title: ReactNode; note?: ReactNode; to?: string; more?: ReactNode; children?: ReactNode; live?: boolean }) {
  return (
    <header className="sh">
      <div className="grow"><h2>{live && <i className="live-dot" aria-hidden="true" />}{title}</h2>{note && <p>{note}</p>}</div>
      {children}
      {to && <Link to={to} className="sh-all">{more || t('See all', '查看全部')} <em aria-hidden="true">→</em></Link>}
    </header>
  );
}

// ---- search -------------------------------------------------------------------------------------
/**
 * Search with instant results: up to six matching games appear under the box as you type; Enter opens the
 * highlighted game, or the full results on the browse page. "/" focuses it from anywhere.
 */
export function SearchBox({ initial = '', autoFocus, big, hotkey, onSubmit }: { initial?: string; autoFocus?: boolean; big?: boolean; hotkey?: boolean; onSubmit?: (q: string) => void }) {
  const [q, setQ] = useState(initial), [hits, setHits] = useState<GameCard[]>([]), [total, setTotal] = useState(0), [open, setOpen] = useState(false), [sel, setSel] = useState(-1), [wait, setWait] = useState(false);
  const box = useRef<HTMLInputElement>(null), wrap = useRef<HTMLDivElement>(null), id = useId(), seq = useRef(0);
  useEffect(() => { setQ(initial); }, [initial]);
  useEffect(() => {
    const s = q.trim(); if (s.length < 2) { setHits([]); setTotal(0); setWait(false); return; }
    const n = ++seq.current; setWait(true);
    const tm = setTimeout(() => {
      api<{ games: GameCard[]; total: number }>(`/games?q=${encodeURIComponent(s)}&limit=6&facets=0&sort=played`).then((r) => { if (n === seq.current) { setHits(r.games); setTotal(r.total); setSel(-1); setWait(false); } }, () => { if (n === seq.current) setWait(false); });
    }, 160);
    return () => clearTimeout(tm);
  }, [q]);
  useEffect(() => {
    if (!hotkey && !big) return;
    const f = (e: globalThis.KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))) return;
      e.preventDefault(); box.current?.focus();
    };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, [big, hotkey]);
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
      {(big || hotkey) && !q && <kbd className="sbox-k" aria-hidden="true">/</kbd>}
      {show && (
        <div className="sbox-pop" id={id} role="listbox">
          {hits.map((g, i) => (
            <Link key={g.id} to={`/g/${g.slug}`} className={'sbox-row' + (i === sel ? ' on' : '')} onClick={() => setOpen(false)}>
              <span className="thumb" id={`${id}-${i}`} role="option" aria-selected={i === sel} style={g.cover ? undefined : artStyle(g.slug)}>{g.cover && <CoverImg g={g} src={g.cover} />}</span>
              <span className="grow"><b className="clip">{g.title}</b><small className="clip">{g.author} · {g.tags.slice(0, 2).map(genreName).join(' · ')}</small></span>
              <span className="sbox-p">{price(g.price_cents)}</span>
            </Link>
          ))}
          {!hits.length && wait && <SkHits />}
          {!hits.length && !wait && <div className="sbox-none">{t('No games match yet.', '暂无匹配的游戏。')}</div>}
          <button type="button" className="sbox-all" onClick={() => go(q.trim())}>{total ? t('See all {total} results', '查看全部 {total} 个结果', { total: num(total) }) : t('Search the whole catalogue', '在全部游戏中搜索')} <em aria-hidden="true">↵</em></button>
        </div>
      )}
    </div>
  );
}

// ---- the store bar ------------------------------------------------------------------------------
/** The row of places under the top bar on every store page: the categories menu, the main lists and the queue. */
export function StoreBar() {
  const loc = useLocation(), path = loc.split('?')[0], qs = loc.includes('?') ? loc.slice(loc.indexOf('?')) : '';
  const [open, setOpen] = useState(false), ref = useRef<HTMLDivElement>(null), genres = useGenres();
  useEffect(() => { setOpen(false); }, [loc]);
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('mousedown', f); addEventListener('keydown', k); return () => { removeEventListener('mousedown', f); removeEventListener('keydown', k); };
  }, [open]);
  const on = (p: string, q = '') => (path === p && (q ? qs.includes(q) : !/sort=|price=/.test(qs)) ? ' on' : '');
  const links: [string, string, string][] = [
    ['/browse', '', t('All games', '全部游戏')], ['/browse?sort=new', 'sort=new', t('New', '新上架')], ['/browse?sort=top', 'sort=top', t('Top rated', '好评')],
    ['/browse?sort=playing', 'sort=playing', t('Playing now', '在玩')], ['/browse?price=free', 'price=free', t('Free', '免费')],
  ];
  return (
    <div className="sbar">
      <div className="wrap">
        <div className="sbar-cats" ref={ref}>
          <button type="button" className={'sbar-btn' + (open ? ' open' : '') + (path.startsWith('/c/') || path === '/categories' ? ' on' : '')} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}>
            <i className="sbar-grid" aria-hidden="true" />{t('Categories', '分类')}<em className="caret" aria-hidden="true" />
          </button>
          {open && (
            <div className="mega" role="menu">
              <div className="mega-h"><b>{t('Browse by category', '按分类浏览')}</b><Link to="/categories" className="sh-all">{t('All categories', '全部分类')} <em>→</em></Link></div>
              <div className="mega-grid">
                {genres.slice(0, 30).map((g) => <Link key={g.tag} to={`/c/${encodeURIComponent(g.tag)}`} className="mega-i" style={hue(g.tag)}><i aria-hidden="true" /><span className="clip">{genreName(g.tag)}</span><small className="num">{num(g.n)}</small></Link>)}
                {!genres.length && <span className="dim fs-sm">{t('Loading…', '加载中…')}</span>}
              </div>
              <div className="mega-f">
                <Link to="/browse?sort=new">{t('New releases', '新品')}</Link><Link to="/browse?sort=top">{t('Top rated', '好评榜')}</Link><Link to="/browse?price=free">{t('Free to play', '免费游戏')}</Link><Link to="/browse?price=under5">{t('Under $5', '5 美元以下')}</Link><Link to="/queue">{t('Discovery queue', '探索队列')}</Link>
              </div>
            </div>
          )}
        </div>
        <nav className="sbar-links" aria-label={t('Store', '商店')}>
          {links.map(([to, q, l]) => <Link key={to} to={to} className={'sbar-a' + on('/browse', q)}>{l}</Link>)}
          <Link to="/queue" className={'sbar-a' + (path === '/queue' ? ' on' : '')}>{t('Your queue', '探索队列')}</Link>
        </nav>
      </div>
    </div>
  );
}

// ---- the lead ------------------------------------------------------------------------------------
/**
 * The home page's lead: one game, large. The block is the shade side of the page; the game's picture is the lit side,
 * cut in along a slanted edge. The other picks sit underneath as small covers. It advances by itself every eight
 * seconds, stops while you hover or focus it, and never moves on its own under reduced motion.
 */
export function Spotlight({ games }: { games: GameCard[] }) {
  const picks = games.slice(0, 6), [i, setI] = useState(0), [paused, setPaused] = useState(false);
  const calm = useMemo(still, []);
  useEffect(() => {
    if (calm || paused || picks.length < 2) return;
    const tm = setTimeout(() => setI((v) => (v + 1) % picks.length), 8000);
    return () => clearTimeout(tm);
  }, [i, paused, calm, picks.length]);
  if (!picks.length) return null;
  const g = picks[Math.min(i, picks.length - 1)], rar = rarity(g), R = RARITY[rar], step = (d: number) => setI((v) => (v + d + picks.length) % picks.length);
  const to = `/g/${g.slug}`, trial = trialOf(g);
  return (
    <section className="hero ink" style={hue(g.tags[0])} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)} aria-roledescription={t('carousel', '轮播')} aria-label={t('Featured', '精选推荐')}>
      <Link to={to} className="hero-art" key={'a' + g.id} tabIndex={-1} aria-hidden="true">
        <span className="art" style={g.cover ? undefined : artStyle(g.slug)}>{g.cover && <CoverImg g={g} src={g.cover} />}<MatureTag g={g} /></span>
      </Link>
      <div className="hero-body" key={'b' + g.id} aria-live={paused ? 'polite' : 'off'}>
        <span className="stick">{g.featured ? t('Featured', '精选') : i === 0 ? t('#1 this week', '本周第一') : t('Trending', '热门')}</span>
        <h2><Link to={to}>{g.title}</Link></h2>
        {blurb(g) && <p className="lede">{blurb(g)}</p>}
        <div className="hero-tags" style={{ '--rc': R.color } as CSSProperties}>{rar !== 'common' && <span className="rar" title={rarityHint()}>{R.name()}</span>}{g.tags.slice(0, 3).map((x) => <span key={x} className="gtag" style={hue(x)}>{genreName(x)}</span>)}</div>
        <dl className="hero-facts">
          <div><dt>{t('Players say', '玩家评价')}</dt><dd><Verdict g={g} full /></dd></div>
          <div><dt>{t('By', '作者')}</dt><dd>{g.author}</dd></div>
          <div><dt>{t('Played', '游玩')}</dt><dd className="num">{count(g.plays, 'time', 'times', '次')}{!!g.playing && <span className="live"> · {num(g.playing)} {t('now', '人在线')}</span>}</dd></div>
        </dl>
        <div className="hero-buy">
          <Link to={to} className="btn btn-primary btn-lg">{g.price_cents > 0 ? t('View game', '查看游戏') : <><i className="play-tri" aria-hidden="true" />{t('Play free', '免费游玩')}</>}</Link>
          <span className="hero-price">{price(g.price_cents)}</span>
          {!!trial && <span className="trial-tag">{trialLabel(trial)}</span>}
        </div>
      </div>
      {picks.length > 1 && (
        <div className="hero-picks">
          <div className="hero-strip" role="tablist" aria-label={t('Featured picks', '精选列表')}>
            {picks.map((x, k) => (
              <button key={x.id} role="tab" aria-selected={k === i} aria-label={x.title} className={'hero-pick' + (k === i ? ' on' : '') + (paused || calm ? ' held' : '')} onClick={() => setI(k)}>
                <span className="thumb" style={x.cover ? undefined : artStyle(x.slug)}>{x.cover && <CoverImg g={x} src={x.cover} />}</span>
                {k === i && <i className="hero-bar" key={i + (paused ? 'p' : '')} aria-hidden="true" />}
              </button>
            ))}
          </div>
          <div className="hero-step">
            <button type="button" onClick={() => step(-1)} aria-label={t('Previous', '上一个')}>‹</button>
            <span className="num" aria-hidden="true">{String(i + 1).padStart(2, '0')}<em>/{String(picks.length).padStart(2, '0')}</em></span>
            <button type="button" onClick={() => step(1)} aria-label={t('Next', '下一个')}>›</button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---- key numbers --------------------------------------------------------------------------------
export interface StoreStats { games: number; new_week: number; playing: number; creators: number }
export function Stats({ s }: { s: StoreStats }) {
  const items: [ReactNode, string, string][] = [
    [num(s.games), t('web games', '款网页游戏'), '/browse'],
    [num(s.playing), t('playing now', '人正在玩'), '/browse?sort=playing'],
    [num(s.new_week), t('new this week', '本周新上架'), '/browse?sort=new'],
    [num(s.creators), t(s.creators === 1 ? 'creator' : 'creators', '位创作者'), '/create'],
  ];
  return (
    <div className="kpis">{items.map(([v, l, to], k) => (
      <Link key={k} to={to} className={'kpi' + (k === 1 && s.playing > 0 ? ' is-live' : '') + (k === 1 && !s.playing ? ' is-zero' : '')}><b className="num"><CountUp value={v} /></b><span>{l}</span></Link>
    ))}</div>
  );
}

// ---- a game as a row ----------------------------------------------------------------------------
/** A game as one line: art, title, genres, the verdict and the price. For long lists and tabbed lists. */
export function GameRow({ g, onFocus, active, rank }: { g: GameCard; onFocus?: () => void; active?: boolean; rank?: number }) {
  return (
    <Link to={`/g/${g.slug}`} className={'grow-row' + (active ? ' on' : '') + (rank != null ? ' has-rank' : '')} onMouseEnter={onFocus} onFocus={onFocus}>
      {rank != null && <span className="gr-rank num">{rank}</span>}
      <span className="thumb" style={g.cover ? undefined : artStyle(g.slug)}>{g.cover && <CoverImg g={g} src={g.cover} />}</span>
      <span className="gr-main">
        <b className="clip">{g.title}</b>
        <span className="gr-tags">{g.tags.slice(0, 3).map((x) => <i key={x} style={hue(x)}>{genreName(x)}</i>)}</span>
      </span>
      <span className="gr-meta"><Verdict g={g} />{!!g.playing && <small className="live">{num(g.playing)} {t('playing', '人在玩')}</small>}{!g.playing && g.published_at && <small>{ago(g.published_at)}</small>}</span>
      <span className="gr-buy">{!!trialOf(g) && <small className="gr-trial">{trialLabel(trialOf(g), true)}</small>}<span className={'gr-price' + (g.price_cents > 0 ? ' paid' : '')}>{price(g.price_cents)}</span></span>
    </Link>
  );
}

/** The preview beside a tabbed list: the game under the pointer, large. */
function Preview({ g }: { g: GameCard }) {
  const R = RARITY[rarity(g)];
  return (
    <Link to={`/g/${g.slug}`} className="tl-prev" key={g.id} style={hue(g.tags[0])}>
      <span className="art" style={g.cover ? undefined : artStyle(g.slug)}>{g.cover && <CoverImg g={g} src={g.cover} />}<MatureTag g={g} /></span>
      <span className="tl-prev-b">
        <b>{g.title}</b>
        {blurb(g) && <span className="mute fs-sm">{blurb(g)}</span>}
        <span className="row s wrapx" style={{ '--rc': R.color } as CSSProperties}>{rarity(g) !== 'common' && <span className="rar">{R.name()}</span>}{g.tags.slice(0, 4).map((x) => <i key={x} className="gtag" style={hue(x)}>{genreName(x)}</i>)}</span>
        <span className="tl-prev-v"><Verdict g={g} full /></span>
        <span className="mute fs-sm">{t('by', '作者')} {g.author} · {count(g.plays, 'play', 'plays', '次游玩')}</span>
      </span>
    </Link>
  );
}

/** Steam-style tabbed lists: several lists under one head, a row per game, and a large preview of the one in focus. */
export function TabbedLists({ n, title, tabs }: { n?: string; title: ReactNode; tabs: { key: string; label: string; to: string; games: GameCard[] }[] }) {
  const usable = tabs.filter((x) => x.games.length), [k, setK] = useState(usable[0]?.key || ''), [focus, setFocus] = useState(0);
  const tab = usable.find((x) => x.key === k) || usable[0];
  useEffect(() => { setFocus(0); }, [k]);
  if (!tab) return null;
  const list = tab.games.slice(0, 10), cur = list[Math.min(focus, list.length - 1)];
  return (
    <section className="tl">
      <SectionHead n={n} title={title} />
      <div className="tl-tabs" role="tablist">
        {usable.map((x) => <button key={x.key} type="button" role="tab" aria-selected={x.key === tab.key} className={x.key === tab.key ? 'on' : ''} onClick={() => setK(x.key)}>{x.label}</button>)}
        <Link to={tab.to} className="sh-all tl-more">{t('See more', '查看更多')} <em aria-hidden="true">→</em></Link>
      </div>
      <div className="tl-body" role="tabpanel">
        <div className="tl-list">{list.map((g, i) => <GameRow key={g.id} g={g} active={i === focus} onFocus={() => setFocus(i)} />)}</div>
        {cur && <Preview g={cur} />}
      </div>
    </section>
  );
}

// ---- shelves ------------------------------------------------------------------------------------
/** A row of games that scrolls sideways, with a numbered head, a short note and a way to see the whole list. */
export function Shelf({ n, title, note, to, games, live, rank, freshSince }: { n?: string; title: ReactNode; note?: ReactNode; to?: string; games: GameCard[]; live?: boolean; rank?: boolean; freshSince?: number | null }) {
  const row = useRef<HTMLDivElement>(null), [edge, setEdge] = useState({ l: false, r: true });
  const check = useCallback(() => { const el = row.current; if (!el) return; setEdge({ l: el.scrollLeft > 8, r: el.scrollLeft + el.clientWidth < el.scrollWidth - 8 }); }, []);
  useEffect(() => { check(); }, [games, check]);
  if (!games.length) return null;
  const page = (d: number) => { const el = row.current; if (el) el.scrollBy({ left: d * el.clientWidth * 0.85, behavior: still() ? 'auto' : 'smooth' }); };
  return (
    <section className={'shelf' + (live ? ' is-live' : '') + (rank ? ' ranked' : '')}>
      <SectionHead n={n} title={title} note={note} to={to} live={live}>
        <div className="shelf-nav" hidden={!edge.l && !edge.r}>
          <button type="button" onClick={() => page(-1)} disabled={!edge.l} aria-label={t('Scroll back', '向左滚动')}>‹</button>
          <button type="button" onClick={() => page(1)} disabled={!edge.r} aria-label={t('Scroll on', '向右滚动')}>›</button>
        </div>
      </SectionHead>
      <div className={'shelf-row' + (edge.l ? ' more-l' : '') + (edge.r ? ' more-r' : '')} ref={row} onScroll={check}>
        {games.map((g, k) => <div className="shelf-cell" key={g.id}>{rank && <span className="rank" aria-hidden="true">{k + 1}</span>}<GameTile g={g} fresh={!!freshSince && !!g.published_at && g.published_at > freshSince} /></div>)}
      </div>
    </section>
  );
}

// ---- categories as cartridges -------------------------------------------------------------------
/** A category as a game cartridge: ridged top, the three most played covers fanned out, and a label in its colour. */
export function Cartridge({ g }: { g: Genre }) {
  const covers = g.covers || [];
  return (
    <Link to={`/c/${encodeURIComponent(g.tag)}`} className="cart" style={hue(g.tag)}>
      <span className="cart-art" aria-hidden="true">
        {covers.length ? covers.slice(0, 3).map((c, k) => <img key={k} src={c} alt="" loading="lazy" decoding="async" className={'c' + k} />) : <span className="cart-blank" />}
      </span>
      <span className="cart-label"><b className="clip">{genreName(g.tag)}</b><small className="num">{num(g.n)} {g.n === 1 ? t('game', '款') : t('games', '款')}</small></span>
    </Link>
  );
}
export function Cartridges({ n, list, title, to, max = 12 }: { n?: string; list: Genre[]; title?: ReactNode; to?: string; max?: number }) {
  if (!list.length) return null;
  return (
    <section className="carts">
      <SectionHead n={n} title={title || t('Browse by category', '按分类浏览')} to={to ?? '/categories'} more={t('All categories', '全部分类')} />
      <div className="cart-grid">{list.slice(0, max).map((g) => <Cartridge key={g.tag} g={g} />)}</div>
    </section>
  );
}

// ---- reasons to come back -----------------------------------------------------------------------
/** "Jump back in" (games this browser played) and "new since your last visit". Shows nothing on a first visit. */
export function Since({ newCount, since, recent: showRecent = true }: { newCount: number; since: number | null; recent?: boolean }) {
  const [all] = useState(() => recentPlays().slice(0, 4)), recent = showRecent ? all : [];
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
      {newCount > 0 && since && <Link to={`/browse?sort=new&since=${since}`} className="since-new"><b className="num">{num(newCount)}</b><span>{newCount === 1 ? t('new game since your last visit', '款新游戏，自你上次来访后上架') : t('new games since your last visit', '款新游戏，自你上次来访后上架')}</span><em aria-hidden="true">→</em></Link>}
    </div>
  );
}

/** The discovery queue's invitation: how many picks are waiting, with the next three covers fanned out. */
export function QueueBand({ pool }: { pool: GameCard[] }) {
  const [seen] = useState(() => new Set(seenGames()));
  const left = pool.filter((g) => !seen.has(g.slug));
  if (pool.length < 3) return null;
  const fan = (left.length ? left : pool).slice(0, 3);
  return (
    <Link to="/queue" className="qband ink">
      <span className="qband-fan" aria-hidden="true">{fan.map((g, k) => <span key={g.id} className={'q' + k} style={g.cover ? undefined : artStyle(g.slug)}>{g.cover && <CoverImg g={g} src={g.cover} />}</span>)}</span>
      <span className="grow">
        <span className="eyebrow sig">{t('Your discovery queue', '你的探索队列')}</span>
        <b>{left.length ? (left.length === 1 ? t('1 game you haven\'t opened yet', '1 款你还没打开过的游戏') : t('{n} games you haven\'t opened yet', '{n} 款你还没打开过的游戏', { n: left.length })) : t('You have seen every pick. New ones arrive daily.', '推荐已全部看完，每天都有新游戏。')}</b>
        <small>{t('One at a time, with the facts that matter. Skip what you do not fancy.', '一次一款，只看重点，不喜欢就跳过。')}</small>
      </span>
      <span className="btn btn-primary">{t('Start the queue', '开始探索')} <em aria-hidden="true">→</em></span>
    </Link>
  );
}

/** "More like this" for a game page: the same genre, most played first, without the game itself. */
export function MoreLike({ tag, slug, n }: { tag?: string; slug: string; n?: string }) {
  const [games, setGames] = useState<GameCard[] | null>(null);
  useEffect(() => {
    if (!tag) { setGames([]); return; }
    api<{ games: GameCard[] }>(`/games?tag=${encodeURIComponent(tag)}&limit=13&facets=0&sort=played`).then((r) => setGames(r.games.filter((g) => g.slug !== slug).slice(0, 12)), () => setGames([]));
  }, [tag, slug]);
  if (!games) return <SkShelf />;
  return <Shelf n={n} title={t('More {tag} games', '更多{tag}游戏', { tag: genreName(tag || '') })} to={`/c/${encodeURIComponent(tag || '')}`} games={games} />;
}
/** "More from this creator" for a game page. */
export function MoreFrom({ owner, author, slug, n }: { owner?: string; author: string; slug: string; n?: string }) {
  const [games, setGames] = useState<GameCard[] | null>(null);
  useEffect(() => {
    if (!owner) { setGames([]); return; }
    api<{ games: GameCard[] }>(`/games?by=${encodeURIComponent(owner)}&limit=13&facets=0&sort=played`).then((r) => setGames(r.games.filter((g) => g.slug !== slug).slice(0, 12)), () => setGames([]));
  }, [owner, slug]);
  if (!games) return <SkShelf />;
  return <Shelf n={n} title={t('More from {author}', '{author} 的更多作品', { author })} to={`/browse?by=${encodeURIComponent(owner || '')}&who=${encodeURIComponent(author)}`} games={games} />;
}

// ---- paging -------------------------------------------------------------------------------------
/** Numbered pages: first, last, the pages around this one, and gaps between. Pages are links, so they can be opened and shared. */
export function Pager({ page, pages, href, onPage }: { page: number; pages: number; href?: (p: number) => string; onPage?: (p: number) => void }) {
  if (pages <= 1) return null;
  const around = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter((p) => p >= 1 && p <= pages));
  const list = [...around].sort((a, b) => a - b), out: (number | string)[] = [];
  list.forEach((p, k) => { if (k && p - list[k - 1] > 1) out.push('gap' + p); out.push(p); });
  const go = (p: number, cls: string, label: ReactNode) => href ? <Link key={'p' + p + cls} to={href(p)} className={cls}>{label}</Link> : <button key={'p' + p + cls} type="button" className={cls} onClick={() => onPage?.(p)}>{label}</button>;
  return (
    <nav className="pager" aria-label={t('Pages', '分页')}>
      {page > 1 ? go(page - 1, 'pg pg-step', <>‹ {t('Prev', '上一页')}</>) : <span className="pg pg-step off">‹ {t('Prev', '上一页')}</span>}
      <span className="pg-nums">{out.map((p) => typeof p === 'string' ? <span key={p} className="pg-gap">…</span> : p === page ? <span key={p} className="pg on" aria-current="page">{p}</span> : go(p, 'pg', p))}</span>
      <span className="pg-of">{t('Page {page} of {pages}', '第 {page} / {pages} 页', { page, pages: num(pages) })}</span>
      {page < pages ? go(page + 1, 'pg pg-step', <>{t('Next', '下一页')} ›</>) : <span className="pg pg-step off">{t('Next', '下一页')} ›</span>}
    </nav>
  );
}

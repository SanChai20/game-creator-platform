// The whole catalogue: search, sort, genres (several at once), price and rating, with every filter and the page
// number in the address so any view can be shared or bookmarked. Results come 30 to a page with numbered pages,
// as a grid of cards or as a dense list. The same engine (Catalogue) runs the browse page and each category page.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, ApiError, Fail, GameTile, genreHue, genreName, tagGroupName, lastVisit, Link, navigate, num, query, t, useLocation, type GameCard } from '../lib';
import { Button, EmptyState } from '../ui';
import { SkGrid } from '../skeletons';
import { Sk } from '../ui/skeleton';
import { Icon } from '../ui/icons';
import { GameRow, Pager, SearchBox, useGenres, type Genre } from '../store';

const PAGE = 30;
const FACET_GROUPS = ['genre', 'theme', 'mood', 'gameplay', 'players', 'style'] as const;
interface Page { games: GameCard[]; total: number; next_offset: number | null }

const radio = <T extends string>(name: string, value: T, options: [T, ReactNode][], set: (v: T) => void) => (
  <div className="fl-opts" role="radiogroup" aria-label={name}>
    {options.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={value === k} className={'fl-opt' + (value === k ? ' on' : '')} onClick={() => set(k)}><i aria-hidden="true" />{l}</button>)}
  </div>
);

/**
 * The catalogue engine. `pinned` is a genre fixed by the page (a category page); `base` is the page's own path;
 * `genres` replaces the genre list in the sidebar (a category page offers its related genres).
 */
export function Catalogue({ pinned, base = '/browse', genres: own, head }: { pinned?: string; base?: string; genres?: Genre[]; head?: ReactNode }) {
  const loc = useLocation(), q = query(), all = useGenres(), genres = own || all;
  const sort = q.get('sort') || 'trending', priceF = q.get('price') || '', search = q.get('q') || '', since = q.get('since') || '', rating = q.get('rating') || '';
  const by = q.get('by') || '', who = q.get('who') || '', view = q.get('view') === 'list' ? 'list' : 'grid', page = Math.max(1, Number(q.get('page')) || 1);
  const tags = (q.get('tag') || '').split(',').map((x) => x.trim()).filter(Boolean);
  const href = (patch: Record<string, string | null>, keepPage = false) => {
    const n = query(); for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
    if (!keepPage && !('page' in patch)) n.delete('page');
    const s = n.toString(); return base + (s ? '?' + s : '');
  };
  const set = (patch: Record<string, string | null>) => navigate(href(patch), true);
  const toggleTag = (tag: string) => { const has = tags.includes(tag); set({ tag: (has ? tags.filter((x) => x !== tag) : [...tags, tag]).join(',') || null }); };

  const api_q = new URLSearchParams({ sort, limit: String(PAGE), offset: String((page - 1) * PAGE), facets: '0' });
  const tagParam = [pinned, ...tags].filter(Boolean).join(',');
  if (tagParam) api_q.set('tag', tagParam); if (priceF) api_q.set('price', priceF); if (search) api_q.set('q', search);
  if (since) api_q.set('since', since); if (rating) api_q.set('rating', rating); if (by) api_q.set('by', by);
  const key = api_q.toString();

  const [res, setRes] = useState<Page | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState<ApiError | null>(null), [drawer, setDrawer] = useState(false);
  const seq = useRef(0), top = useRef<HTMLDivElement>(null), [fresh] = useState(() => lastVisit()), first = useRef(true);
  const load = () => {
    const n = ++seq.current; setBusy(true); setError(null);
    api<Page>(`/games?${key}`).then((r) => { if (n === seq.current) { setRes(r); setBusy(false); } }, (e) => { if (n === seq.current) { setError(e); setBusy(false); } });
  };
  useEffect(load, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // a new page of results starts at the top of the results, not wherever the pager was
  useEffect(() => { if (first.current) { first.current = false; return; } const el = top.current; if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start' }); }, [page]);
  useEffect(() => { setDrawer(false); }, [loc]);

  const total = res?.total ?? 0, pages = Math.max(1, Math.ceil(total / PAGE)), from = total ? (page - 1) * PAGE + 1 : 0, to = Math.min(total, page * PAGE);
  const sorts: [string, string][] = [['trending', t('Trending', '热门')], ['new', t('Newest', '最新')], ['top', t('Top rated', '好评')], ['playing', t('Playing now', '在玩')], ['played', t('Most played', '最多游玩')]];
  const prices: [string, string][] = [['', t('Any price', '任意价格')], ['free', t('Free', '免费')], ['under5', t('Under $5', '5 美元以下')], ['paid', t('Paid', '付费')], ['trial', t('Free trial', '可免费试玩')]];
  const ratings: [string, string][] = [['', t('Any rating', '任意评分')], ['3', '★ 3+'], ['4', '★ 4+'], ['4.5', '★ 4.5+']];
  const [gq, setGq] = useState(''), [moreG, setMoreG] = useState<Record<string, boolean>>({});
  const glist = useMemo(() => { const f = gq.trim().toLowerCase(); return genres.filter((g) => g.tag !== pinned && (!f || g.tag.includes(f) || genreName(g.tag).toLowerCase().includes(f))); }, [genres, gq, pinned]);
  // genres first, then the platform's tag groups: each shows its most used tags, with the rest a click away
  const groups = useMemo(() => FACET_GROUPS.map((k) => [k, glist.filter((g) => (g.group || 'genre') === k)] as const).filter(([, l]) => l.length), [glist]);

  const active: [string, () => void][] = [
    ...tags.map((x) => [genreName(x), () => toggleTag(x)] as [string, () => void]),
    ...(priceF ? [[prices.find((p) => p[0] === priceF)?.[1] || priceF, () => set({ price: null })] as [string, () => void]] : []),
    ...(rating ? [[`★ ${rating}+`, () => set({ rating: null })] as [string, () => void]] : []),
    ...(search ? [[`“${search}”`, () => set({ q: null })] as [string, () => void]] : []),
    ...(since ? [[t('Since your last visit', '自上次来访'), () => set({ since: null })] as [string, () => void]] : []),
    ...(by ? [[(who ? t('By {who}', '作者：{who}', { who }) : t('By this creator', '作者：该创作者')), () => set({ by: null, who: null })] as [string, () => void]] : []),
  ];

  return (
    <div className="catalog">
      {head}
      <div className="cat-layout">
        <aside className={'filters-side' + (drawer ? ' open' : '')} aria-label={t('Filters', '筛选')}>
          <div className="fl-head"><b>{t('Filters', '筛选')}</b><button type="button" className="btn btn-ghost btn-sm fl-close" onClick={() => setDrawer(false)}>✕ {t('Close', '关闭')}</button></div>
          <div className="fl-sec"><SearchBox initial={search} onSubmit={(s) => set({ q: s || null })} /></div>
          <div className="fl-sec"><h4>{t('Price', '价格')}</h4>{radio(t('Price', '价格'), priceF, prices, (v) => set({ price: v || null }))}</div>
          <div className="fl-sec"><h4>{t('Players say', '玩家评分')}</h4>{radio(t('Rating', '评分'), rating, ratings, (v) => set({ rating: v || null }))}</div>
          {genres.length > 12 && <div className="fl-sec"><input className="input fl-find" type="search" placeholder={t('Find a genre or tag', '查找类型或标签')} value={gq} onChange={(e) => setGq(e.target.value)} aria-label={t('Find a genre or tag', '查找类型或标签')} /></div>}
          {groups.map(([k, list]) => {
            const open = moreG[k] || !!gq, shown = open ? list : list.slice(0, k === 'genre' ? 10 : 6), on = list.filter((g) => tags.includes(g.tag)).length;
            return (
              <div className="fl-sec" key={k}>
                <h4>{k === 'genre' && pinned ? t('Narrow by genre', '再按类型筛选') : tagGroupName(k)} {on > 0 && <span className="fl-n">{on}</span>}</h4>
                <div className="fl-genres">
                  {shown.map((g) => (
                    <label key={g.tag} className={'fl-g' + (tags.includes(g.tag) ? ' on' : '')} style={{ '--h': genreHue(g.tag) } as CSSProperties}>
                      <input type="checkbox" checked={tags.includes(g.tag)} onChange={() => toggleTag(g.tag)} /><i aria-hidden="true" /><span className="clip">{genreName(g.tag)}</span><small className="num">{num(g.n)}</small>
                    </label>
                  ))}
                </div>
                {!gq && list.length > shown.length && <button type="button" className="fl-more" onClick={() => setMoreG({ ...moreG, [k]: true })}>{t('Show all {n}', '显示全部 {n} 个', { n: list.length })}</button>}
                {!gq && open && list.length > (k === 'genre' ? 10 : 6) && <button type="button" className="fl-more" onClick={() => setMoreG({ ...moreG, [k]: false })}>{t('Show fewer', '收起')}</button>}
              </div>
            );
          })}
          {!genres.length && !res && <div className="fl-sec"><div className="fl-genres">{[0, 1, 2, 3, 4, 5].map((k) => <span key={k} className="fl-g" aria-hidden="true"><Sk kind="dot" w={14} h={14} /><Sk w={`${40 + (k * 17) % 36}%`} /></span>)}</div></div>}
          {!groups.length && !!gq && <div className="fl-sec"><span className="dim fs-sm">{t('No genre or tag by that name.', '没有这个类型或标签。')}</span><button type="button" className="fl-more" onClick={() => setGq('')}>{t('Clear', '清除')}</button></div>}
          {!pinned && <div className="fl-sec"><Link to="/categories" className="fl-more">{t('All categories', '全部分类')} →</Link></div>}
        </aside>

        <div className="cat-main" ref={top}>
          <div className="cat-bar">
            <button type="button" className="btn btn-sm fl-open" onClick={() => setDrawer(true)}>⚙ {t('Filters', '筛选')}{active.length > 0 && <span className="fl-n">{active.length}</span>}</button>
            <p className="cat-count" aria-live="polite">{busy && !res ? t('Searching…', '搜索中…') : total ? t('{from}–{to} of {total} games', '第 {from}–{to} 款，共 {total} 款', { from: num(from), to: num(to), total: num(total) }) : t('No games', '没有游戏')}</p>
            <label className="cat-sort"><span>{t('Sort by', '排序')}</span>
              <select className="input" value={sort} onChange={(e) => set({ sort: e.target.value === 'trending' ? null : e.target.value })}>{sorts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </label>
            <div className="seg cat-view" role="group" aria-label={t('View', '视图')}>
              <button type="button" className={view === 'grid' ? 'on' : ''} aria-pressed={view === 'grid'} onClick={() => set({ view: null })} title={t('Cards', '卡片')} aria-label={t('Cards', '卡片')}><Icon kind="grid" /></button>
              <button type="button" className={view === 'list' ? 'on' : ''} aria-pressed={view === 'list'} onClick={() => set({ view: 'list' })} title={t('List', '列表')} aria-label={t('List', '列表')}><Icon kind="list" /></button>
            </div>
          </div>
          {active.length > 0 && (
            <div className="cat-active">
              {active.map(([l, off], k) => <button key={k} type="button" className="act-chip" onClick={off}>{l} <em aria-hidden="true">✕</em></button>)}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(base + (sort !== 'trending' ? '?sort=' + sort : ''), true)}>{t('Clear all', '全部清除')}</button>
            </div>
          )}

          {error && !res ? <div className="home-empty"><Fail error={error} retry={load} /></div> : !res ? <SkGrid /> : res.games.length ? (
            <div className={busy ? 'cat-res busy' : 'cat-res'}>
              {view === 'list'
                ? <div className="glist">{res.games.map((g, i) => <GameRow key={g.id} g={g} rank={sort === 'trending' || sort === 'top' || sort === 'played' ? from + i : undefined} />)}</div>
                : <div className="grid browse-grid">{res.games.map((g) => <GameTile key={g.id} g={g} fresh={!!fresh && !!g.published_at && g.published_at > fresh} />)}</div>}
              <Pager page={Math.min(page, pages)} pages={pages} href={(p) => href({ page: p > 1 ? String(p) : null }, true)} />
            </div>
          ) : (
            <div className="home-empty">
              <EmptyState title={page > 1 ? t('There is no page that far', '没有这么多页') : t('No games match that', '没有符合条件的游戏')} action={<Button onClick={() => navigate(page > 1 ? href({ page: null }) : base, true)}>{page > 1 ? t('Back to page 1', '回到第 1 页') : t('Clear filters', '清除筛选')}</Button>}>
                {t('Try a different search, another genre or fewer filters.', '换个关键词、换个类型，或者少选几个筛选条件。')}
              </EmptyState>
            </div>
          )}
        </div>
      </div>
      {drawer && <div className="fl-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />}
    </div>
  );
}

export function Browse() {
  const q = query(), sort = q.get('sort') || '', tag = q.get('tag') || '', search = q.get('q') || '', since = q.get('since') || '', priceF = q.get('price') || '', who = q.get('who') || '';
  const tags = tag.split(',').filter(Boolean);
  const title = search ? t('Results for “{search}”', '“{search}”的搜索结果', { search })
    : who ? t('Games by {who}', '{who} 的游戏', { who })
    : since ? t('New since your last visit', '你上次来访后的新游戏')
    : tags.length === 1 ? t('{genre} games', '{genre}游戏', { genre: genreName(tags[0]) })
    : priceF === 'free' ? t('Free to play', '免费畅玩') : priceF === 'under5' ? t('Under $5', '5 美元以下') : priceF === 'trial' ? t('Try before you buy', '先试玩再购买')
    : sort === 'new' ? t('New releases', '新品上架') : sort === 'top' ? t('Top rated', '好评榜') : sort === 'playing' ? t('Playing now', '正在热玩') : sort === 'played' ? t('Most played', '最多游玩')
    : t('All games', '全部游戏');
  return (
    <div className="wrap page browse">
      <Catalogue head={
        <header className="browse-h">
          <nav className="crumbs" aria-label={t('Breadcrumb', '导航路径')}><Link to="/">{t('Store', '商店')}</Link><i>/</i><span>{t('Browse', '浏览')}</span></nav>
          <h1>{title}</h1>
        </header>
      } />
    </div>
  );
}

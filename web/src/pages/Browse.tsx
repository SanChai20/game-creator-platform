// The whole catalogue: search, sort, price and genre, with the filters in the address so any view can be shared.
// Results come 36 at a time and the next page loads as you near the end (a button does the same for keyboards
// and for browsers without IntersectionObserver). Cards off screen skip layout and paint (content-visibility).
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, Fail, GameTile, navigate, num, query, t, useLocation, type GameCard } from '../lib';
import { Button, Chip, EmptyState, Segmented, Spinner } from '../ui';
import { genreName, lastVisit, SearchBox } from '../store';

const PAGE = 36;
interface Page { games: GameCard[]; total: number; next_offset: number | null; genres?: { tag: string; n: number }[] }

export function Browse() {
  const loc = useLocation(), q = query();
  const sort = q.get('sort') || 'trending', tag = q.get('tag') || '', priceF = q.get('price') || '', search = q.get('q') || '', since = q.get('since') || '';
  const set = (k: string, v: string) => { const n = query(); if (v) n.set(k, v); else n.delete(k); const s = n.toString(); navigate('/browse' + (s ? '?' + s : ''), true); };
  const base = new URLSearchParams({ sort, limit: String(PAGE), ...(tag && { tag }), ...(priceF && { price: priceF }), ...(search && { q: search }), ...(since && { since }) }).toString();

  const [list, setList] = useState<GameCard[]>([]), [total, setTotal] = useState(0), [next, setNext] = useState<number | null>(0);
  const [genres, setGenres] = useState<{ tag: string; n: number }[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState<ApiError | null>(null);
  const seq = useRef(0), sentinel = useRef<HTMLDivElement>(null), [fresh] = useState(() => lastVisit());

  const load = (offset: number) => {
    const n = ++seq.current; setBusy(true); setError(null);
    api<Page>(`/games?${base}&offset=${offset}`).then((r) => {
      if (n !== seq.current) return;
      setList((l) => (offset ? [...l, ...r.games] : r.games)); setTotal(r.total); setNext(r.next_offset);
      if (r.genres) setGenres(r.genres);
      setBusy(false);
    }, (e) => { if (n === seq.current) { setError(e); setBusy(false); } });
  };
  useEffect(() => { setList([]); setNext(0); load(0); }, [base]); // eslint-disable-line react-hooks/exhaustive-deps

  // the next page, as the end of the list comes into view
  useEffect(() => {
    const el = sentinel.current; if (!el || next == null || busy || !list.length || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) load(next); }, { rootMargin: '900px 0px' });
    io.observe(el); return () => io.disconnect();
  }, [next, busy, list.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const sorts: [string, string][] = [['trending', t('Trending', '热门')], ['playing', t('Playing now', '在玩')], ['new', t('New', '最新')], ['top', t('Top rated', '好评')], ['played', t('Most played', '最多游玩')]];
  const prices: [string, string][] = [['', t('Any price', '全部')], ['free', t('Free', '免费')], ['paid', t('Paid', '付费')]];
  const filtered = !!(tag || priceF || search || since);
  const title = search ? t(`Results for “${search}”`, `“${search}”的搜索结果`) : tag ? genreName(tag) : since ? t('New since your last visit', '你上次来访后的新游戏') : t('All games', '全部游戏');

  return (
    <div className="wrap page browse" key={loc.split('?')[0]}>
      <header className="browse-h">
        <div className="grow">
          <h1>{title}</h1>
          <p className="mute" aria-live="polite">{busy && !list.length ? t('Searching…', '搜索中…') : t(`${num(total)} ${total === 1 ? 'game' : 'games'}`, `共 ${num(total)} 款游戏`)}</p>
        </div>
        <SearchBox initial={search} onSubmit={(s) => set('q', s)} />
      </header>

      <div className="browse-bar">
        <Segmented label={t('Sort', '排序')} options={sorts} value={sort} onChange={(k) => set('sort', k === 'trending' ? '' : k)} />
        <Segmented label={t('Price', '价格')} options={prices} value={priceF} onChange={(k) => set('price', k)} />
        {filtered && <Button size="sm" variant="ghost" onClick={() => navigate('/browse' + (sort !== 'trending' ? '?sort=' + sort : ''), true)}>✕ {t('Clear filters', '清除筛选')}</Button>}
      </div>
      {!!genres.length && (
        <div className="tags genre-chips" role="group" aria-label={t('Genres', '类型')}>
          {genres.map((g) => <Chip key={g.tag} active={tag === g.tag} onClick={() => set('tag', tag === g.tag ? '' : g.tag)}>{genreName(g.tag)} <span className="n">{num(g.n)}</span></Chip>)}
        </div>
      )}

      {error && !list.length ? <div className="home-empty"><Fail error={error} retry={() => load(0)} /></div> : busy && !list.length ? <Spinner /> : list.length ? (
        <>
          <div className="grid browse-grid">{list.map((g) => <GameTile key={g.id} g={g} fresh={!!fresh && !!g.published_at && g.published_at > fresh} />)}</div>
          <div ref={sentinel} className="browse-more">
            {next != null ? <Button onClick={() => load(next)} disabled={busy}>{busy ? t('Loading…', '加载中…') : t(`Show more · ${num(total - list.length)} left`, `加载更多 · 还有 ${num(total - list.length)} 款`)}</Button>
              : <span className="mute fs-sm">{t(`That's all ${num(total)}.`, `已显示全部 ${num(total)} 款。`)}</span>}
            {error && <Fail error={error} retry={() => next != null && load(next)} />}
          </div>
        </>
      ) : (
        <div className="home-empty">
          <EmptyState title={t('No games match that', '没有符合条件的游戏')} action={<Button onClick={() => navigate('/browse', true)}>{t('Clear filters', '清除筛选')}</Button>}>
            {t('Try a different search or another genre.', '换个关键词或其他类型试试。')}
          </EmptyState>
        </div>
      )}
    </div>
  );
}

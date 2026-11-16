// Categories: the index of every genre (as cartridges, then A to Z), and one page per genre with its own colour,
// its numbers, the genres it is often paired with, its top and newest games, and its whole catalogue in pages.
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api, genreHue, genreName, Link, num, t, useData, type GameCard } from '../lib';
import { SkShelf, SkTiles } from '../skeletons';
import { Sk } from '../ui/skeleton';
import { Cartridge, Shelf, useGenres } from '../store';
import { Catalogue } from './Browse';

export function Categories() {
  const genres = useGenres(), [q, setQ] = useState('');
  const list = useMemo(() => genres.filter((g) => !q || g.tag.includes(q.trim().toLowerCase())), [genres, q]);
  const az = useMemo(() => {
    const m = new Map<string, typeof list>();
    [...list].sort((a, b) => a.tag.localeCompare(b.tag)).forEach((g) => { const k = /[a-z]/.test(g.tag[0]) ? g.tag[0].toUpperCase() : '#'; m.set(k, [...(m.get(k) || []), g]); });
    return [...m.entries()];
  }, [list]);
  return (
    <div className="wrap page">
      <header className="browse-h">
        <nav className="crumbs" aria-label={t('Breadcrumb', '导航路径')}><Link to="/">{t('Store', '商店')}</Link><i>/</i><span>{t('Categories', '分类')}</span></nav>
        <div className="row wrapx" style={{ alignItems: 'flex-end' }}>
          <div className="grow wide"><h1>{t('All categories', '全部分类')}</h1><p className="mute">{genres.length ? t('{n} genres, biggest first. Each one has its own page.', '共 {n} 个类型，按游戏数量排序，每个都有独立页面。', { n: genres.length }) : ' '}</p></div>
          <input className="input cats-find" type="search" placeholder={t('Find a category', '查找分类')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Find a category', '查找分类')} />
        </div>
      </header>
      {!genres.length ? <SkTiles n={12} big /> : (
        <>
          <div className="cart-grid big">{list.slice(0, 24).map((g) => <Cartridge key={g.tag} g={g} />)}</div>
          {list.length > 0 && (
            <section className="az">
              <h2 className="az-h">{t('A to Z', '按字母')}</h2>
              <div className="az-cols">{az.map(([k, gs]) => (
                <div key={k} className="az-g"><b className="az-k">{k}</b>{gs.map((g) => <Link key={g.tag} to={`/c/${encodeURIComponent(g.tag)}`} className="az-i" style={{ '--h': genreHue(g.tag) } as CSSProperties}><span className="clip">{genreName(g.tag)}</span><small className="num">{num(g.n)}</small></Link>)}</div>
              ))}</div>
            </section>
          )}
          {!list.length && <p className="mute">{t('No category by that name.', '没有这个分类。')}</p>}
        </>
      )}
    </div>
  );
}

interface CatInfo { tag: string; games: number; free: number; new_week: number; playing: number; related: { tag: string; n: number; covers?: string[] }[] }

export function Category({ tag }: { tag: string }) {
  const { data } = useData<CatInfo>(`/categories/${encodeURIComponent(tag)}`);
  const [top, setTop] = useState<GameCard[] | null>(null), [fresh, setFresh] = useState<GameCard[] | null>(null), genres = useGenres();
  useEffect(() => {
    const e = encodeURIComponent(tag);
    api<{ games: GameCard[] }>(`/games?tag=${e}&sort=top&rating=3&limit=12&facets=0`).then((r) => setTop(r.games), () => setTop([]));
    api<{ games: GameCard[] }>(`/games?tag=${e}&sort=new&limit=12&facets=0`).then((r) => setFresh(r.games), () => setFresh([]));
  }, [tag]);
  const covers = genres.find((g) => g.tag === tag)?.covers || [], name = genreName(tag);
  const facts: [string, number, string?][] = data ? [[t('games', '款游戏'), data.games], [t('free', '款免费'), data.free, '?price=free'], [t('new this week', '本周新上架'), data.new_week, '?sort=new'], [t('playing now', '人在玩'), data.playing, '?sort=playing']] : [];
  return (
    <div className="catpage" style={{ '--h': genreHue(tag) } as CSSProperties}>
      <section className="cat-hero">
        <div className="wrap cat-hero-in">
          <div className="grow">
            <nav className="crumbs" aria-label={t('Breadcrumb', '导航路径')}><Link to="/">{t('Store', '商店')}</Link><i>/</i><Link to="/categories">{t('Categories', '分类')}</Link><i>/</i><span>{name}</span></nav>
            <h1>{name}</h1>
            <div className="cat-facts">{!data && [0, 1, 2, 3].map((k) => <span key={k} className="cat-fact"><Sk kind="title" w={44} h={30} /><Sk kind="tag" w={70} /></span>)}{facts.map(([l, v, q], k) => <Link key={k} to={`/c/${encodeURIComponent(tag)}${q || ''}`} className={'cat-fact' + (k === 3 && v > 0 ? ' is-live' : '')}><b className="num">{num(v)}</b><span>{l}</span></Link>)}</div>
            {!!data?.related.length && (
              <div className="cat-rel"><span className="eyebrow">{t('Often paired with', '常见搭配')}</span>
                {data.related.slice(0, 10).map((r) => <Link key={r.tag} to={`/c/${encodeURIComponent(tag)}?tag=${encodeURIComponent(r.tag)}`} className="gtag" style={{ '--h': genreHue(r.tag) } as CSSProperties}>{genreName(r.tag)} <small className="num">{num(r.n)}</small></Link>)}
              </div>
            )}
          </div>
          <div className="cat-hero-art" aria-hidden="true">{covers.slice(0, 3).map((c, k) => <img key={k} src={c} alt="" className={'c' + k} />)}</div>
        </div>
      </section>
      <div className="wrap">
        {top ? <Shelf title={t('Top rated in {name}', '{name} 好评榜', { name })} to={`/c/${encodeURIComponent(tag)}?sort=top`} games={top} rank /> : <SkShelf />}
        {fresh ? <Shelf title={t('New in {name}', '{name} 新上架', { name })} to={`/c/${encodeURIComponent(tag)}?sort=new`} games={fresh} /> : <SkShelf />}
        <section className="cat-all" id="all">
          <header className="sh"><div className="grow"><h2>{t('Every {name} game', '全部{name}游戏', { name })}</h2><p>{t('Filter, sort and page through all of them.', '筛选、排序，逐页浏览全部游戏。')}</p></div></header>
          <Catalogue pinned={tag} base={`/c/${encodeURIComponent(tag)}`} genres={data?.related} />
        </section>
      </div>
    </div>
  );
}

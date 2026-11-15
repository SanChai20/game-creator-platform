import { useEffect, useState } from 'react';
import { artStyle, count, Fail, GameTile, Link, navigate, price, query, Stars, t, useApp, useData, useLocation, type GameCard } from '../lib';
import { Badge, Button, Chip, EmptyState, Eyebrow, SearchInput, Segmented, Spinner } from '../ui';

export function Home() {
  useLocation();
  const { config } = useApp(), q = query();
  const sort = q.get('sort') || 'trending', tag = q.get('tag') || '', priceF = q.get('price') || '', search = q.get('q') || '';
  const [typed, setTyped] = useState(search);
  const set = (k: string, v: string) => { const n = query(); if (v) n.set(k, v); else n.delete(k); const s = n.toString(); navigate('/' + (s ? '?' + s : ''), true); };
  useEffect(() => { const id = setTimeout(() => { if (typed !== search) set('q', typed); }, 300); return () => clearTimeout(id); }, [typed]); // eslint-disable-line react-hooks/exhaustive-deps
  const qs = new URLSearchParams({ sort, ...(tag && { tag }), ...(priceF && { price: priceF }), ...(search && { q: search }) }).toString();
  const { data, error, loading, reload } = useData<{ games: GameCard[]; tags: string[] }>('/games?' + qs);
  const filtered = !!(tag || priceF || search) || sort !== 'trending';
  const games = data?.games || [], hero = !filtered ? games[0] : null;
  const sorts: [string, string][] = [['trending', t('Trending', '热门')], ['new', t('New', '最新')], ['top', t('Top rated', '好评')], ['played', t('Most played', '最多游玩')]];
  const prices: [string, string][] = [['', t('All', '全部')], ['free', t('Free', '免费')], ['paid', t('Paid', '付费')]];

  const next = hero ? games.slice(1, 5) : [];
  const pitch = (
    <div className="pitch">
      <div className="grow stack s">
        <Eyebrow tone="accent">{t('For creators', '面向创作者')}</Eyebrow>
        <h3>{t('Your agent builds it.', '智能体负责创作，')} <mark>{t('We ship it.', '我们负责上线。')}</mark></h3>
      </div>
      <Button to="/create" variant="primary">{t('Make a game', '创作游戏')} →</Button>
    </div>
  );

  return (
    <>
      {hero ? (
        <div className="wrap bb">
          <Link to={`/g/${hero.slug}`} className="bb-main" title={hero.title} data-gl-host="">
            {hero.cover && <span className="gl-slot" data-gl="hero" data-gl-src={hero.cover} aria-hidden="true" />}
            <div className="art" style={hero.cover ? undefined : artStyle(hero.slug)}>{hero.cover && <img src={hero.cover} alt="" />}</div>
            <div className="bb-top"><Badge tone="accent">{hero.featured ? t('Featured', '精选推荐') : t('Trending now', '正在流行')}</Badge>{hero.tags.slice(0, 2).map((x) => <Badge key={x} dot={false}>{x}</Badge>)}</div>
            <div className="bb-body">
              <h1>{hero.title}</h1>
              {hero.tagline && <p className="lede">{hero.tagline}</p>}
              <div className="row wrapx hero-meta"><span>{t('by', '作者')} <b>{hero.author}</b></span><Stars rating={hero.rating} count={hero.rating_count} /><span className="num">{count(hero.plays, 'play', 'plays', '次游玩')}</span></div>
              <div><span className="btn btn-primary btn-lg">{hero.price_cents > 0 ? `${t('Get it', '购买')} · ${price(hero.price_cents)}` : `▶ ${t('Play now', '立即游玩')}`}</span></div>
            </div>
          </Link>
          <div className="bb-side">
            <div className="rule"><em>{'>>'}</em> {t('Up next', '接下来玩')}</div>
            <div className="bb-list">{next.map((g, i) => (
              <Link key={g.id} to={`/g/${g.slug}`} className="bb-item">
                <span className="n">{String(i + 2).padStart(2, '0')}</span>
                <div className="thumb" style={g.cover ? undefined : artStyle(g.slug)}>{g.cover && <img src={g.cover} alt="" loading="lazy" />}</div>
                <div className="grow"><b className="clip">{g.title}</b><small className="clip">{g.price_cents > 0 ? price(g.price_cents) : t('Free', '免费')} · {count(g.plays, 'play', 'plays', '次游玩')}</small></div>
              </Link>))}</div>
            {pitch}
          </div>
        </div>
      ) : !filtered && !loading && !error && (
        <section className="lead"><div className="wrap solo"><div>
          <Eyebrow tone="accent">{config.settings.brand_name}</Eyebrow>
          <h1>{config.settings.tagline}</h1>
          <p>{t('Web games built by people with their own AI agents. The shelves are empty for now. Yours could be the first.', '由创作者与自己的 AI 智能体共同打造的网页游戏。货架暂时还空着，第一款可以是你的。')}</p>
          <div className="row wrapx lead-actions"><Button to="/create" variant="primary" size="lg">{t('Make the first game', '创作第一款游戏')}</Button></div>
        </div></div></section>
      )}

      <div className="wrap">
        <div className="filters">
          <h2>{t('All games', '全部游戏')}</h2>
          <Segmented label={t('Sort', '排序')} options={sorts} value={sort} onChange={(k) => set('sort', k === 'trending' ? '' : k)} />
          <Segmented label={t('Price', '价格')} options={prices} value={priceF} onChange={(k) => set('price', k)} />
          <SearchInput value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t('Search games', '搜索游戏')} aria-label={t('Search games', '搜索游戏')} />
        </div>
        {!!data?.tags.length && <div className="tags">{data.tags.map((x) => <Chip key={x} active={tag === x} onClick={() => set('tag', tag === x ? '' : x)}>{x}</Chip>)}</div>}

        {error ? <div className="home-empty"><Fail error={error} retry={reload} /></div> : loading && !data ? <Spinner /> : games.length ? (
          <div className="grid">{games.map((g) => <GameTile key={g.id} g={g} />)}</div>
        ) : (
          <div className="home-empty">
            <EmptyState title={filtered ? t('No games match that', '没有符合条件的游戏') : t('No games yet', '还没有游戏')}
              action={filtered && <Button onClick={() => { setTyped(''); navigate('/', true); }}>{t('Clear filters', '清除筛选')}</Button>}>
              {filtered ? t('Try a different search or clear the filters.', '换个关键词，或清除筛选条件。') : t('Published games appear here as soon as they pass verification.', '游戏通过验证并发布后会立即出现在这里。')}
            </EmptyState>
          </div>
        )}
      </div>
    </>
  );
}

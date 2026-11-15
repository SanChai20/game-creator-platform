import { useEffect, useState } from 'react';
import { artStyle, count, Fail, GameTile, Link, navigate, price, query, Stars, t, useApp, useData, useLocation, type GameCard } from '../lib';
import { Badge, Button, Card, Chip, EmptyState, Eyebrow, SearchInput, Segmented, Spinner } from '../ui';

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

  return (
    <>
      {hero ? (
        <section className="hero">
          <div className="bg" style={hero.cover ? { backgroundImage: `url(${hero.cover})` } : artStyle(hero.slug)} />
          <div className="wrap">
            <div className="stack l">
              <Eyebrow tone="accent">{hero.featured ? t('Featured', '精选推荐') : t('Trending now', '正在流行')}</Eyebrow>
              <h1>{hero.title}</h1>
              {hero.tagline && <p className="lede">{hero.tagline}</p>}
              <div className="row wrapx hero-meta"><span>{t('by', '作者')} <b>{hero.author}</b></span><Stars rating={hero.rating} count={hero.rating_count} /><span className="num">{count(hero.plays, 'play', 'plays', '次游玩')}</span></div>
              <div className="row wrapx">
                <Button to={`/g/${hero.slug}`} variant="primary" size="lg">{hero.price_cents > 0 ? `${t('Get it', '购买')} · ${price(hero.price_cents)}` : t('Play now', '立即游玩')}</Button>
                {hero.tags.slice(0, 3).map((x) => <Badge key={x} dot={false}>{x}</Badge>)}
              </div>
            </div>
            <Link to={`/g/${hero.slug}`} className="shot" title={hero.title}>
              {hero.cover ? <img src={hero.cover} alt={hero.title} /> : <div style={{ ...artStyle(hero.slug), position: 'absolute', inset: 0 }} />}
            </Link>
          </div>
        </section>
      ) : !filtered && !loading && !error && (
        <section className="lead"><div className="wrap">
          <Eyebrow tone="accent">{config.settings.brand_name}</Eyebrow>
          <h1 style={{ marginTop: 20 }}>{config.settings.tagline}</h1>
          <p>{t('A marketplace of web games built by people working with their own AI agents. The shelves are empty for now. Yours could be the first game here.', '由创作者与自己的 AI 智能体共同打造的网页游戏市场。货架暂时还空着，第一款游戏可以是你的。')}</p>
          <div className="row wrapx lead-actions"><Button to="/create" variant="primary" size="lg">{t('Make the first game', '创作第一款游戏')}</Button></div>
        </div></section>
      )}

      <div className="wrap">
        <div className="cta-band">
          <Card tone="accent">
            <div className="grow stack s">
              <Eyebrow tone="accent">{t('For creators', '面向创作者')}</Eyebrow>
              <h3>{config.settings.tagline}</h3>
              <span className="mute">{t('Connect your agent, describe a game, publish it here.', '连接你的智能体，描述一款游戏，然后发布到这里。')}</span>
            </div>
            <Button to="/create">{t('How it works', '了解流程')} →</Button>
          </Card>
        </div>

        <div className="filters">
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

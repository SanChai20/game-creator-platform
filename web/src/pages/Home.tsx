import { useEffect, useState } from 'react';
import { artStyle, Fail, GameTile, Link, navigate, num, price, query, Spinner, Stars, t, useApp, useData, useLocation, type GameCard, count } from '../lib';

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
              <span className="eyebrow sig">{hero.featured ? t('Featured', '精选推荐') : t('Trending now', '正在流行')}</span>
              <h1>{hero.title}</h1>
              {hero.tagline && <p className="lede">{hero.tagline}</p>}
              <div className="row wrapx mute"><span>{t('by', '作者')} <b style={{ color: 'var(--bone)' }}>{hero.author}</b></span><Stars rating={hero.rating} count={hero.rating_count} /><span className="num">{count(hero.plays, 'play', 'plays', '次游玩')}</span></div>
              <div className="row wrapx"><Link to={`/g/${hero.slug}`} className="btn pri big">{hero.price_cents > 0 ? `${t('Get it', '购买')} · ${price(hero.price_cents)}` : t('Play now', '立即游玩')}</Link>{hero.tags.slice(0, 3).map((x) => <span key={x} className="badge plain">{x}</span>)}</div>
            </div>
            <Link to={`/g/${hero.slug}`} className="shot" title={hero.title}>
              {hero.cover ? <img src={hero.cover} alt={hero.title} /> : <div style={{ ...artStyle(hero.slug), position: 'absolute', inset: 0 }} />}
            </Link>
          </div>
        </section>
      ) : !filtered && !loading && !error && (
        <section className="lead"><div className="wrap">
          <span className="eyebrow sig">{config.settings.brand_name}</span>
          <h1 style={{ marginTop: 18 }}>{config.settings.tagline}</h1>
          <p>{t('A marketplace of web games built by people working with their own AI agents. The shelves are empty for now. Yours could be the first game here.', '由创作者与自己的 AI 智能体共同打造的网页游戏市场。货架暂时还空着，第一款游戏可以是你的。')}</p>
          <p><Link to="/create" className="btn pri big">{t('Make the first game', '创作第一款游戏')}</Link></p>
        </div></section>
      )}

      <div className="band"><div className="wrap">
        <span className="eyebrow sig">{t('For creators', '面向创作者')}</span>
        <b>{config.settings.tagline}</b>
        <span className="mute">{t('Connect your agent, describe a game, publish it here.', '连接你的智能体，描述一款游戏，然后发布到这里。')}</span>
        <Link to="/create" className="btn sm right">{t('How it works', '了解流程')} →</Link>
      </div></div>

      <div className="wrap">
        <div className="filters">
          <div className="seg" role="tablist">{sorts.map(([k, label]) => <button key={k} role="tab" aria-selected={sort === k} className={sort === k ? 'on' : ''} onClick={() => set('sort', k === 'trending' ? '' : k)}>{label}</button>)}</div>
          <div className="seg">{prices.map(([k, label]) => <button key={k} className={priceF === k ? 'on' : ''} onClick={() => set('price', k)}>{label}</button>)}</div>
          <label className="search"><input className="input" type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t('Search games', '搜索游戏')} aria-label={t('Search games', '搜索游戏')} /></label>
        </div>
        {!!data?.tags.length && <div className="tags">{data.tags.map((x) => <button key={x} className={'chip' + (tag === x ? ' on' : '')} onClick={() => set('tag', tag === x ? '' : x)}>{x}</button>)}</div>}

        {error ? <div style={{ padding: '30px 0' }}><Fail error={error} retry={reload} /></div> : loading && !data ? <Spinner /> : games.length ? (
          <div className="grid">{games.map((g) => <GameTile key={g.id} g={g} />)}</div>
        ) : (
          <div style={{ padding: '30px 0 90px' }}><div className="empty">
            <h3>{filtered ? t('No games match that', '没有符合条件的游戏') : t('No games yet', '还没有游戏')}</h3>
            <p>{filtered ? t('Try a different search or clear the filters.', '换个关键词，或清除筛选条件。') : t('Published games appear here as soon as they pass verification.', '游戏通过验证并发布后会立即出现在这里。')}</p>
            {filtered && <p style={{ marginTop: 16 }}><button className="btn" onClick={() => { setTyped(''); navigate('/', true); }}>{t('Clear filters', '清除筛选')}</button></p>}
          </div></div>
        )}
      </div>
    </>
  );
}

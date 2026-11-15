import { useEffect, useRef, useState } from 'react';
import { ago, artStyle, Fail, GameTile, lastVisit, Link, navigate, query, recentPlays, t, useApp, useData, useLocation, type GameCard } from '../lib';
import { Button, Chip, EmptyState, Eyebrow, SearchInput, Segmented, Spinner } from '../ui';
import { Vault } from '../vault/Vault';

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
  const games = data?.games || [];
  const sorts: [string, string][] = [['trending', t('Trending', '热门')], ['new', t('New', '最新')], ['top', t('Top rated', '好评')], ['played', t('Most played', '最多游玩')]];
  const prices: [string, string][] = [['', t('All', '全部')], ['free', t('Free', '免费')], ['paid', t('Paid', '付费')]];

  // The Vault always shows what is trending; the filters below only change the catalogue.
  const vaultData = useData<{ games: GameCard[] }>(filtered ? '/games?sort=trending' : null);
  const last = useRef<GameCard[]>([]);
  const got = filtered ? vaultData.data?.games : data?.games;
  if (got) last.current = got;           // keep the hall standing while the other list loads
  const shown = got || last.current;
  // Reasons to come back: what is new since this browser was last here, and the games it played lately.
  const [since] = useState(() => lastVisit()), [recent] = useState(() => recentPlays().slice(0, 4));
  const fresh = (g: GameCard) => !!since && !!g.published_at && g.published_at > since;
  const newCount = shown.filter(fresh).length;
  const back = (recent.length > 0 || newCount > 0) && (
    <div className="since">
      {recent.length > 0 && (
        <div className="since-recent">
          <span className="since-h">{t('Jump back in', '继续玩')}</span>
          <div className="since-list">{recent.map((r) => (
            <Link key={r.slug} to={`/g/${r.slug}`} className="since-item">
              <span className="thumb" style={r.cover ? undefined : artStyle(r.slug)}>{r.cover && <img src={r.cover} alt="" loading="lazy" />}</span>
              <span className="grow"><b className="clip">{r.title}</b><small>{ago(r.at)}</small></span>
            </Link>))}</div>
        </div>
      )}
      {newCount > 0 && <Link to="/?sort=new" className="since-new"><b>{newCount}</b><span>{t(newCount === 1 ? 'new game since your last visit' : 'new games since your last visit', '款新游戏，自你上次来访后上架')}</span><em aria-hidden="true">→</em></Link>}
    </div>
  );
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
      {shown.length ? (
        <><Vault games={shown} /><div className="wrap">{back}{pitch}</div></>
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
          <h2>{t('The collection', '全部藏品')}</h2>
          <Segmented label={t('Sort', '排序')} options={sorts} value={sort} onChange={(k) => set('sort', k === 'trending' ? '' : k)} />
          <Segmented label={t('Price', '价格')} options={prices} value={priceF} onChange={(k) => set('price', k)} />
          <SearchInput value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t('Search games', '搜索游戏')} aria-label={t('Search games', '搜索游戏')} />
        </div>
        {!!data?.tags.length && <div className="tags">{data.tags.map((x) => <Chip key={x} active={tag === x} onClick={() => set('tag', tag === x ? '' : x)}>{x}</Chip>)}</div>}

        {error ? <div className="home-empty"><Fail error={error} retry={reload} /></div> : loading && !data ? <Spinner /> : games.length ? (
          <div className="grid">{games.map((g) => <GameTile key={g.id} g={g} fresh={fresh(g)} />)}</div>
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

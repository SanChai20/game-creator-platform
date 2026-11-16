// The discovery queue: games this browser has not opened yet, one at a time, with the facts that matter and two
// choices: open it, or move on. What was seen is remembered in this browser only.
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api, artStyle, blurb, count, genreHue, genreName, Link, markSeen, navigate, num, price, RARITY, rarity, rarityHint, resetSeen, seenGames, t, Verdict, type GameCard } from '../lib';
import { Button, EmptyState } from '../ui';
import { RouteSkeleton } from '../skeletons';

export function Queue() {
  const [pool, setPool] = useState<GameCard[] | null>(null), [i, setI] = useState(0), [round, setRound] = useState(0);
  useEffect(() => {
    Promise.all([
      api<{ games: GameCard[] }>('/games?sort=trending&limit=60&facets=0'),
      api<{ games: GameCard[] }>('/games?sort=new&limit=30&facets=0'),
      api<{ games: GameCard[] }>('/games?sort=top&limit=30&facets=0'),
    ]).then((rs) => {
      const seen = new Set(seenGames()), all = rs.flatMap((r) => r.games).filter((g, k, a) => a.findIndex((x) => x.id === g.id) === k);
      setPool(all.filter((g) => !seen.has(g.slug)).slice(0, 12)); setI(0);
    }, () => setPool([]));
  }, [round]);
  const g = pool?.[i];
  const next = () => { if (g) markSeen(g.slug); setI((v) => v + 1); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.target as HTMLElement)?.tagName === 'INPUT') return; if (e.key === 'ArrowRight') next(); else if (e.key === 'Enter' && g) { markSeen(g.slug); navigate(`/g/${g.slug}`); } };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  });
  const R = useMemo(() => (g ? RARITY[rarity(g)] : null), [g]);
  if (!pool) return <RouteSkeleton path="/queue" />;
  return (
    <div className="wrap page queue">
      <header className="browse-h">
        <nav className="crumbs" aria-label={t('Breadcrumb', '导航路径')}><Link to="/">{t('Store', '商店')}</Link><i>/</i><span>{t('Discovery queue', '探索队列')}</span></nav>
        <h1>{t('Your discovery queue', '你的探索队列')}</h1>
        <p className="mute">{matchMedia('(hover: none) and (pointer: coarse)').matches ? t('Games you have not opened yet, one at a time.', '一次一款你还没打开过的游戏。') : t('Games you have not opened yet, one at a time. Press → to move on and Enter to open.', '一次一款你还没打开过的游戏。按 → 跳过，按 Enter 打开。')}</p>
      </header>
      {g && R ? (
        <>
          <div className="q-progress" aria-label={t('{i} of {total}', '第 {i} / {total} 款', { i: i + 1, total: pool.length })}>{pool.map((_, k) => <i key={k} className={k < i ? 'done' : k === i ? 'on' : ''} />)}<span className="num">{i + 1} / {pool.length}</span></div>
          <article className="q-card" key={g.id} style={{ '--h': genreHue(g.tags[0] || ''), '--rc': R.color } as CSSProperties}>
            <Link to={`/g/${g.slug}`} className="q-art" onClick={() => markSeen(g.slug)}><span className="art" style={g.cover ? undefined : artStyle(g.slug)}>{g.cover && <img src={g.cover} alt="" />}</span></Link>
            <div className="q-info">
              <div className="hero-tags"><span className="rar" title={rarityHint()}>{R.name()}</span>{g.tags.slice(0, 3).map((x) => <Link key={x} to={`/c/${encodeURIComponent(x)}`} className="gtag" style={{ '--h': genreHue(x) } as CSSProperties}>{genreName(x)}</Link>)}</div>
              <h2>{g.title}</h2>
              {blurb(g) && <p className="lede">{blurb(g)}</p>}
              <dl className="hero-facts">
                <div><dt>{t('Players say', '玩家评价')}</dt><dd><Verdict g={g} full /></dd></div>
                <div><dt>{t('By', '作者')}</dt><dd>{g.author}</dd></div>
                <div><dt>{t('Played', '游玩')}</dt><dd className="num">{count(g.plays, 'time', 'times', '次')}{!!g.playing && <span className="live"> · {num(g.playing)} {t('now', '人在线')}</span>}</dd></div>
                <div><dt>{t('Price', '价格')}</dt><dd>{price(g.price_cents)}</dd></div>
              </dl>
              <div className="row wrapx q-act">
                <Button variant="primary" size="lg" to={`/g/${g.slug}`} onClick={() => markSeen(g.slug)}>{g.price_cents > 0 ? t('Open the game page', '打开游戏页') : `▶ ${t('Play it', '去玩')}`}</Button>
                <Button size="lg" onClick={next}>{i + 1 < pool.length ? t('Next in queue', '下一款') : t('Finish the queue', '完成')} →</Button>
              </div>
            </div>
          </article>
        </>
      ) : (
        <EmptyState title={pool.length ? t('That is the queue done', '这一轮看完了') : t('You have seen every pick', '推荐已全部看完')}
          action={<div className="row wrapx" style={{ justifyContent: 'center' }}><Button variant="primary" to="/browse?sort=new">{t('Browse new releases', '浏览新品')}</Button><Button onClick={() => { if (!pool.length) resetSeen(); setRound((r) => r + 1); }}>{pool.length ? t('Get another queue', '再来一轮') : t('Start over', '重新开始')}</Button></div>}>
          {t('New games arrive every day. Come back tomorrow for a fresh queue.', '每天都有新游戏上架，明天再来看看新的队列。')}
        </EmptyState>
      )}
    </div>
  );
}

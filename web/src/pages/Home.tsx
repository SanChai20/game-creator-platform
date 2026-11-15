// The store front. One request (/api/home) brings the spotlight, the shelves, the genres and the key numbers, so
// the page is the same size whether the catalogue holds ten games or fifty thousand. The full catalogue, with
// search and filters, is the browse page.
import { useEffect, useState } from 'react';
import { api, Fail, t, useApp, useData, type GameCard } from '../lib';
import { Button, Eyebrow, Spinner } from '../ui';
import { Genres, lastVisit, SearchBox, Shelf, Since, Spotlight, Stats, type StoreStats } from '../store';

interface HomeData { stats: StoreStats; shelves: { trending: GameCard[]; playing: GameCard[]; new: GameCard[]; top: GameCard[]; free: GameCard[] }; genres: { tag: string; n: number }[] }

export function Home() {
  const { config } = useApp();
  const { data, error, loading, reload } = useData<HomeData>('/home');
  const [since] = useState(() => lastVisit()), [newCount, setNewCount] = useState(0);
  useEffect(() => { if (since) api<{ total: number }>(`/games?since=${since}&limit=1&facets=0`).then((r) => setNewCount(r.total), () => {}); }, [since]);

  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <Spinner />;
  const d = data!, sh = d.shelves;

  if (!d.stats.games) return (
    <section className="lead"><div className="wrap solo"><div>
      <Eyebrow tone="accent">{config.settings.brand_name}</Eyebrow>
      <h1>{config.settings.tagline}</h1>
      <p>{t('Web games built by people with their own AI agents. The shelves are empty for now. Yours could be the first.', '由创作者与自己的 AI 智能体共同打造的网页游戏。货架暂时还空着，第一款可以是你的。')}</p>
      <div className="row wrapx lead-actions"><Button to="/create" variant="primary" size="lg">{t('Make the first game', '创作第一款游戏')}</Button></div>
    </div></div></section>
  );

  // the spotlight takes the top picks; the trending shelf carries on from there
  const spot = sh.trending.slice(0, 5), more = sh.trending.slice(5);
  return (
    <div className="store">
      <div className="wrap store-top">
        <div className="store-intro">
          <h1>{t('Play web games made by creators', '畅玩创作者与')} <span className="hl-a">{t('and their AI agents', 'AI 智能体打造的网页游戏')}</span></h1>
          <SearchBox big />
        </div>
        <Stats s={d.stats} />
      </div>

      <div className="wrap">
        <Spotlight games={spot} />
        <Since newCount={newCount} since={since} />
        <Shelf live title={t('Playing right now', '正在热玩')} note={t('Games with players in them this minute.', '此刻有玩家在线的游戏。')} to="/browse?sort=playing" games={sh.playing} />
        <Genres list={d.genres} />
        <Shelf rank title={t('Trending this week', '本周热门')} note={t('Most played and talked about in the last seven days.', '过去七天游玩与讨论最多。')} to="/browse" games={more.length >= 4 ? more : sh.trending} />
        <Shelf title={t('New arrivals', '新上架')} note={t('Fresh from creators and their agents.', '创作者与智能体的最新作品。')} to="/browse?sort=new" games={sh.new} freshSince={since} />
        <Shelf title={t('Top rated', '好评榜')} note={t('What players rate highest.', '玩家评分最高。')} to="/browse?sort=top" games={sh.top} />
        <Shelf title={t('Free to play', '免费畅玩')} to="/browse?price=free" games={sh.free} />

        <div className="pitch store-pitch">
          <div className="grow stack s">
            <Eyebrow tone="accent">{t('For creators', '面向创作者')}</Eyebrow>
            <h3>{t('Your agent builds it.', '智能体负责创作，')} <mark>{t('We ship it.', '我们负责上线。')}</mark></h3>
            <p className="mute">{t('Web games only: games that run in a browser page.', '仅支持网页游戏：在浏览器页面中运行的游戏。')}</p>
          </div>
          <Button to="/create" variant="primary">{t('Make a game', '创作游戏')} →</Button>
        </div>
      </div>
    </div>
  );
}

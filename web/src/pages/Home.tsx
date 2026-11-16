// The store front. One request (/api/home) brings the featured picks, the lists, the categories and the key numbers,
// so the page is the same size whether the catalogue holds ten games or fifty thousand. The full catalogue, with
// filters and numbered pages, is the browse page; every category has its own page under /c/.
import { useEffect, useState } from 'react';
import { api, Fail, t, useApp, useData, type GameCard } from '../lib';
import { Button, CelScene, Eyebrow } from '../ui';
import { HomeSkeleton } from '../skeletons';
import { Cartridges, lastVisit, QueueBand, Shelf, Since, Spotlight, Stats, TabbedLists, type Genre, type StoreStats } from '../store';

interface HomeData { stats: StoreStats; shelves: { trending: GameCard[]; playing: GameCard[]; new: GameCard[]; top: GameCard[]; free: GameCard[] }; genres: Genre[] }

export function Home() {
  const { config } = useApp();
  const { data, error, loading, reload } = useData<HomeData>('/home');
  const [since] = useState(() => lastVisit()), [newCount, setNewCount] = useState(0);
  useEffect(() => { if (since) api<{ total: number }>(`/games?since=${since}&limit=1&facets=0`).then((r) => setNewCount(r.total), () => {}); }, [since]);

  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <HomeSkeleton />;
  const d = data!, sh = d.shelves;

  if (!d.stats.games) return (
    <div className="wrap"><section className="lead ink solo">
      <CelScene seed={1} />
      <div className="lead-in">
        <Eyebrow tone="accent">{config.settings.brand_name}</Eyebrow>
        <h1>{config.settings.tagline}</h1>
        <p>{t('Web games built by people with their own AI agents. The shelves are empty for now. Yours could be the first.', '由创作者与自己的 AI 智能体共同打造的网页游戏。货架暂时还空着，第一款可以是你的。')}</p>
        <div className="row wrapx lead-actions"><Button to="/create" variant="primary" size="lg">{t('Make the first game', '创作第一款游戏')}</Button></div>
      </div>
    </section></div>
  );

  // the carousel takes the top picks; the trending lists carry on from there
  const spot = sh.trending.slice(0, 6), more = sh.trending.slice(6);
  const pool = [...sh.trending, ...sh.new, ...sh.top].filter((g, i, a) => a.findIndex((x) => x.id === g.id) === i);
  return (
    <div className="store">
      <div className="wrap">
        <header className="store-top">
          <div className="store-intro">
            <h1>{t('Web games made by creators', '创作者与')} <span className="hl">{t('and their AI agents', 'AI 智能体打造的网页游戏')}</span></h1>
            <p>{t('Every one runs in your browser. Nothing to install, nothing to wait for.', '每一款都在浏览器里运行，无需安装，即点即玩。')}</p>
          </div>
          <Stats s={d.stats} />
        </header>
        <Spotlight games={spot} />
        <Since newCount={newCount} since={since} />
        <Cartridges list={d.genres} />
        <TabbedLists title={t('New and noteworthy', '新鲜热门')} tabs={[
          { key: 'trending', label: t('Trending', '热门'), to: '/browse', games: more.length >= 5 ? more : sh.trending },
          { key: 'new', label: t('New releases', '新品'), to: '/browse?sort=new', games: sh.new },
          { key: 'top', label: t('Top rated', '好评'), to: '/browse?sort=top', games: sh.top },
          { key: 'free', label: t('Free', '免费'), to: '/browse?price=free', games: sh.free },
        ]} />
        <Shelf live title={t('Playing right now', '正在热玩')} note={t('Games with players in them this minute.', '此刻有玩家在线的游戏。')} to="/browse?sort=playing" games={sh.playing} />
        <Shelf rank title={t('Trending this week', '本周热门')} note={t('Most played and talked about in the last seven days.', '过去七天游玩与讨论最多。')} to="/browse" games={sh.trending} />
        <QueueBand pool={pool} />
        <Shelf title={t('New arrivals', '新上架')} note={t('Fresh from creators and their agents.', '创作者与智能体的最新作品。')} to="/browse?sort=new" games={sh.new} freshSince={since} />

        <section className="pitch ink">
          <CelScene seed={2} />
          <div className="pitch-in">
            <Eyebrow tone="accent">{t('For creators', '面向创作者')}</Eyebrow>
            <h2>{t('Your agent builds it.', '智能体负责创作，')} <mark>{t('We ship it.', '我们负责上线。')}</mark></h2>
            <p>{t('Web games only: games that run in a browser page.', '仅支持网页游戏：在浏览器页面中运行的游戏。')}</p>
            <Button to="/create" variant="primary" size="lg">{t('Make a game', '创作游戏')} <em aria-hidden="true">→</em></Button>
          </div>
        </section>
      </div>
    </div>
  );
}

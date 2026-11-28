// For you (src/recommend.js): the home page's personal shelf. Each game says why it is there, and "Not for me" takes it
// out of the list. Shown only to signed-in players with some history; everyone else sees the store's own shelves.
import { useEffect, useState } from 'react';
import { api, GameTile, genreName, local, t, useApp, type GameCard } from './lib';
import { SectionHead } from './store';

type Pick = GameCard & { reason: { kind: 'played' | 'tag' | 'popular'; tag?: string; game?: { slug: string; title: string } } };

const why = (g: Pick) => g.reason.kind === 'played' && g.reason.game ? t('Players of {game} play this', '{game} 的玩家也在玩', { game: local(g.reason.game as never, 'title') || g.reason.game.title })
  : g.reason.kind === 'tag' && g.reason.tag ? t('Because you like {tag}', '因为你喜欢{tag}', { tag: genreName(g.reason.tag) })
  : t('Popular with players like you', '和你相似的玩家喜欢');

export function ForYouShelf() {
  const { user } = useApp(), [games, setGames] = useState<Pick[] | null>(null);
  useEffect(() => { if (!user) { setGames(null); return; } api<{ games: Pick[] }>('/me/for-you?limit=12').then((r) => setGames(r.games), () => setGames([])); }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!games?.length) return null;
  const drop = (g: Pick) => { setGames((x) => (x || []).filter((y) => y.id !== g.id)); void api(`/me/for-you/${encodeURIComponent(g.slug)}/dismiss`, { method: 'POST' }).catch(() => {}); };
  return (
    <section className="shelf foryou">
      <SectionHead title={t('For you', '为你推荐')} note={t('Picked from the games you play, keep and rate.', '根据你玩过、收藏和评分的游戏挑选。')} />
      <div className="shelf-row">
        {games.map((g) => (
          <div className="shelf-cell" key={g.id}>
            <GameTile g={g} />
            <div className="fy-why"><span className="dim fs-sm clip">{why(g)}</span><button type="button" className="linkish fs-sm" onClick={() => drop(g)} aria-label={t('Not for me: {game}', '不感兴趣：{game}', { game: g.title })}>{t('Not for me', '不感兴趣')}</button></div>
          </div>
        ))}
      </div>
    </section>
  );
}

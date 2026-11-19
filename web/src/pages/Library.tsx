// The player's library, the players' side of the platform (the creator console never lists these): the games they
// played, most recently played first (the full Continue row, paged), and the games they keep: every paid game they
// bought (in the library from the moment the payment succeeds) and every free game they added from its page. Only
// their own, from their account.
import { useEffect, useState } from 'react';
import { api, Fail, GameTile, t, useAct, useData } from '../lib';
import { Badge, Button, EmptyState, PageHeader, Segmented } from '../ui';
import { Skeleton, SkCard } from '../ui/skeleton';
import { ContinueCard, useHide, type ContinueGame } from '../continue';
import { SectionHead } from '../store';
import type { GameCard } from '../lib';

type Filter = 'all' | 'bought' | 'added';
interface LibraryInfo { source: 'bought' | 'added'; added_at: number; owned: boolean; last_played: number | null }
type OwnedGame = GameCard & { library: LibraryInfo };
interface Page<T> { games: T[]; more: boolean }
interface LibraryData extends Page<ContinueGame> { owned: Page<OwnedGame> | null; counts: Record<Filter, number> | null }

export function Library() {
  const { data, error, loading, reload } = useData<LibraryData>('/me/library');
  const { act } = useAct();
  const [extra, setExtra] = useState<ContinueGame[]>([]), [more, setMore] = useState<boolean | null>(null), [busy, setBusy] = useState(false);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const hideOnServer = useHide(() => {}), hide = (slug: string) => { setGone((s) => new Set(s).add(slug)); hideOnServer(slug); };

  // the games kept in the library: one filter at a time, paged
  const [filter, setFilter] = useState<Filter>('all'), [owned, setOwned] = useState<Page<OwnedGame> | null>(null), [ownBusy, setOwnBusy] = useState(false);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  useEffect(() => { if (data?.owned && filter === 'all') setOwned(data.owned); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = async (f: Filter) => {
    setFilter(f); setOwnBusy(true);
    try { setOwned(await api<Page<OwnedGame>>(`/me/library/games?filter=${f}`)); } finally { setOwnBusy(false); }
  };
  const moreOwned = async () => {
    if (!owned) return;
    setOwnBusy(true);
    try { const r = await api<Page<OwnedGame>>(`/me/library/games?filter=${filter}&offset=${owned.games.length}`); setOwned({ games: [...owned.games, ...r.games], more: r.more }); } finally { setOwnBusy(false); }
  };
  const remove = (g: OwnedGame) => act('rm' + g.slug, async () => { await api(`/me/library/${encodeURIComponent(g.slug)}`, { method: 'DELETE' }); setRemoved((s) => new Set(s).add(g.slug)); },
    t('Removed from your library. Your progress is kept.', '已从游戏库移除，进度会保留。'));

  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <div className="wrap page"><Skeleton><div className="cont-grid">{[0, 1, 2, 3].map((k) => <SkCard key={k} lines={3} />)}</div></Skeleton></div>;
  const d = data!, played = [...d.games, ...extra].filter((g) => !gone.has(g.slug)), hasMore = more ?? d.more;
  const counts = d.counts || { all: 0, bought: 0, added: 0 }, kept = (owned?.games || []).filter((g) => !removed.has(g.slug));
  const loadMore = async () => {
    setBusy(true);
    try { const r = await api<LibraryData>(`/me/library?offset=${d.games.length + extra.length}`); setExtra((l) => [...l, ...r.games]); setMore(r.more); } finally { setBusy(false); }
  };
  return (
    <div className="wrap page">
      <PageHeader eyebrow={t('Library', '游戏库')} title={t('Your games', '我的游戏')} sub={t('The games you bought, the free games you added, and everything you played. Continue opens a game where you left off, on any device.', '你购买的游戏、你加入的免费游戏，以及你玩过的所有游戏。点“继续游戏”即可在任何设备上从上次离开的地方继续。')} />
      {!played.length && !counts.all ? (
        <EmptyState title={t('Nothing here yet', '这里还是空的')} action={<Button to="/" variant="primary">{t('Find a game', '去找游戏')}</Button>}>{t('Games you buy are added here automatically. Add free games from their page, and games you play show up here with where you left off.', '你购买的游戏会自动出现在这里。免费游戏可以在游戏页面加入游戏库，玩过的游戏也会出现在这里，并记录你上次玩到哪里。')}</EmptyState>
      ) : (
        <div className="stack xl library">
          {played.length > 0 && (
            <section>
              <SectionHead title={t('Continue playing', '继续游玩')} />
              <div className="cont-grid">{played.map((g) => <ContinueCard key={g.id} g={g} onHide={hide} />)}</div>
              {hasMore && <div className="row" style={{ justifyContent: 'center', marginTop: 20 }}><Button onClick={loadMore} disabled={busy}>{busy ? t('Loading…', '加载中…') : t('Show more', '显示更多')}</Button></div>}
            </section>
          )}
          {counts.all > 0 && (
            <section>
              <SectionHead title={t('Collection', '收藏')} note={t('Bought games are added automatically. Free games stay until you remove them.', '购买的游戏会自动加入。免费游戏会一直保留，直到你移除。')} />
              {counts.bought > 0 && counts.added > 0 && (
                <div className="lib-filter"><Segmented label={t('Show', '显示')} value={filter} onChange={(f) => void pick(f)} options={[
                  ['all', `${t('All', '全部')} · ${counts.all}`], ['bought', `${t('Bought', '已购买')} · ${counts.bought}`], ['added', `${t('Free', '免费')} · ${counts.added}`]]} /></div>
              )}
              <div className="grid browse-grid" aria-busy={ownBusy}>{kept.map((g) => (
                <div key={g.id} className="lib-tile">
                  <GameTile g={g} to={g.library.owned ? `/g/${g.slug}?play=1` : `/g/${g.slug}`} />
                  <div className="lib-tile-f">
                    {g.library.source === 'bought' ? <Badge tone="good">{t('Bought', '已购买')}</Badge> : <Badge>{t('Free', '免费')}</Badge>}
                    {g.library.source === 'added' && <button type="button" className="linkish fs-sm" onClick={() => remove(g)}>{t('Remove', '移除')}</button>}
                  </div>
                </div>
              ))}</div>
              {owned?.more && <div className="row" style={{ justifyContent: 'center', marginTop: 20 }}><Button onClick={moreOwned} disabled={ownBusy}>{ownBusy ? t('Loading…', '加载中…') : t('Show more', '显示更多')}</Button></div>}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

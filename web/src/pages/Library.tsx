// The player's library, the players' side of the platform (the creator console never lists these): the games they
// played, most recently played first (the full Continue row, paged), and the games they keep: every paid game they
// bought (in the library from the moment the payment succeeds) and every free game they added from its page. Only
// their own, from their account.
import { useEffect, useRef, useState } from 'react';
import { api, Fail, GameTile, Link, t, useAct, useData } from '../lib';
import { Badge, Button, EmptyState, ListPager, PageHeader, Segmented } from '../ui';
import { Skeleton, SkCard } from '../ui/skeleton';
import { ContinueCard, useHide, type ContinueGame } from '../continue';
import { SectionHead } from '../store';
import { FollowingList } from '../follow';
import type { GameCard } from '../lib';

const CONT_PER = 12;
const OWN_PER = 24;

type Filter = 'all' | 'bought' | 'added';
interface LibraryInfo { source: 'bought' | 'added'; added_at: number; owned: boolean; last_played: number | null; achievements?: { unlocked: number; total: number } | null }
type OwnedGame = GameCard & { library: LibraryInfo };
interface Page<T> { games: T[]; more: boolean; total?: number; pages?: number }
interface LibraryData extends Page<ContinueGame> { owned: Page<OwnedGame> | null; counts: Record<Filter, number> | null }

export function Library() {
  const { data, error, loading, reload } = useData<LibraryData>(`/me/library?limit=${CONT_PER}`);
  const { act } = useAct();
  const contRef = useRef<HTMLElement>(null), ownRef = useRef<HTMLElement>(null);

  const [contPage, setContPage] = useState(1);
  const [playedList, setPlayedList] = useState<ContinueGame[] | null>(null);
  const [contTotal, setContTotal] = useState(0);
  const [busy, setBusy] = useState(false);

  const [filter, setFilter] = useState<Filter>('all');
  const [ownPage, setOwnPage] = useState(1);
  const [owned, setOwned] = useState<OwnedGame[] | null>(null);
  const [ownTotal, setOwnTotal] = useState(0);
  const [counts, setCounts] = useState<Record<Filter, number>>({ all: 0, bought: 0, added: 0 });
  const [ownBusy, setOwnBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    setPlayedList(data.games);
    setContTotal(data.total ?? data.games.length);
    setContPage(1);
    if (data.counts) setCounts(data.counts);
    if (data.owned && filter === 'all' && ownPage === 1) {
      setOwned(data.owned.games);
      setOwnTotal(data.owned.total ?? data.counts?.all ?? data.owned.games.length);
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadContinue = async (p: number, scroll = false) => {
    setBusy(true);
    try {
      const r = await api<Page<ContinueGame>>(`/me/continue?page=${p}&per_page=${CONT_PER}`);
      const maxP = Math.max(1, r.pages || 1);
      if (p > maxP) { await loadContinue(maxP, false); return; }
      setContPage(p);
      setPlayedList(r.games);
      setContTotal(r.total ?? r.games.length);
      if (scroll) contRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } finally { setBusy(false); }
  };

  const hideOnServer = useHide(() => { void loadContinue(contPage); });
  const hide = (slug: string) => {
    setPlayedList((l) => (l ? l.filter((g) => g.slug !== slug) : l));
    setContTotal((n) => Math.max(0, n - 1));
    hideOnServer(slug);
  };

  const loadOwned = async (f: Filter, p: number, scroll = false) => {
    setOwnBusy(true);
    try {
      const r = await api<Page<OwnedGame> & { counts?: Record<Filter, number> }>(`/me/library/games?filter=${f}&page=${p}&per_page=${OWN_PER}`);
      const maxP = Math.max(1, r.pages || 1);
      if (p > maxP) { await loadOwned(f, maxP, false); return; }
      setFilter(f);
      setOwnPage(p);
      setOwned(r.games);
      if (r.counts) setCounts(r.counts);
      setOwnTotal(r.total ?? r.games.length);
      if (scroll) ownRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } finally { setOwnBusy(false); }
  };

  const remove = (g: OwnedGame) => act('rm' + g.slug, async () => {
    await api(`/me/library/${encodeURIComponent(g.slug)}`, { method: 'DELETE' });
    await loadOwned(filter, ownPage);
  }, t('Removed from your library. Your progress is kept.', '已从游戏库移除，进度会保留。'));

  // the bell's "Creators you follow" link lands on its section
  useEffect(() => { if (data && location.hash === '#following') document.getElementById('following')?.scrollIntoView({ block: 'start' }); }, [!!data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <div className="wrap page"><Skeleton><div className="cont-grid">{[0, 1, 2, 3].map((k) => <SkCard key={k} lines={3} />)}</div></Skeleton></div>;

  const played = playedList ?? data!.games;
  const kept = owned ?? data!.owned?.games ?? [];

  return (
    <div className="wrap page">
      <PageHeader eyebrow={t('Library', '游戏库')} title={t('Your games', '我的游戏')} actions={<Button to="/purchases" size="sm">{t('Purchases and refunds', '购买记录与退款')}</Button>} sub={t('The games you bought, the free games you added, and everything you played. Continue opens a game where you left off, on any device.', '你购买的游戏、你加入的免费游戏，以及你玩过的所有游戏。点“继续游戏”即可在任何设备上从上次离开的地方继续。')} />
      {!contTotal && !played.length && !counts.all ? (
        <EmptyState title={t('Nothing here yet', '这里还是空的')} action={<Button to="/" variant="primary">{t('Find a game', '去找游戏')}</Button>}>{t('Games you buy are added here automatically. Add free games from their page, and games you play show up here with where you left off.', '你购买的游戏会自动出现在这里。免费游戏可以在游戏页面加入游戏库，玩过的游戏也会出现在这里，并记录你上次玩到哪里。')}</EmptyState>
      ) : (
        <div className="stack xl library">
          {(contTotal > 0 || played.length > 0) && (
            <section ref={contRef}>
              <SectionHead title={t('Continue playing', '继续游玩')} />
              <div className="cont-grid" aria-busy={busy}>{played.map((g) => <ContinueCard key={g.id} g={g} onHide={hide} />)}</div>
              <ListPager page={contPage} total={contTotal} perPage={CONT_PER} onPage={(p) => void loadContinue(p, true)} />
            </section>
          )}
          {counts.all > 0 && (
            <section ref={ownRef}>
              <SectionHead title={t('Collection', '收藏')} note={t('Bought games are added automatically. Free games stay until you remove them.', '购买的游戏会自动加入。免费游戏会一直保留，直到你移除。')} />
              {counts.bought > 0 && counts.added > 0 && (
                <div className="lib-filter"><Segmented label={t('Show', '显示')} value={filter} onChange={(f) => void loadOwned(f, 1)} options={[
                  ['all', `${t('All', '全部')} · ${counts.all}`], ['bought', `${t('Bought', '已购买')} · ${counts.bought}`], ['added', `${t('Free', '免费')} · ${counts.added}`]]} /></div>
              )}
              <div className="grid browse-grid" aria-busy={ownBusy}>{kept.map((g) => (
                <div key={g.id} className="lib-tile">
                  <GameTile g={g} to={g.library.owned ? `/g/${g.slug}?play=1` : `/g/${g.slug}`} />
                  <div className="lib-tile-f">
                    {g.library.source === 'bought' ? <Badge tone="good">{t('Bought', '已购买')}</Badge> : <Badge>{t('Free', '免费')}</Badge>}
                    {g.library.source === 'bought' && <Link to="/purchases" className="fs-sm">{t('Refund', '退款')}</Link>}
                    {g.library.achievements && <span className="dim fs-sm lib-ach" title={t('Achievements', '成就')}>★ {g.library.achievements.unlocked}/{g.library.achievements.total}</span>}
                    {g.library.source === 'added' && <button type="button" className="linkish fs-sm" onClick={() => remove(g)}>{t('Remove', '移除')}</button>}
                  </div>
                </div>
              ))}</div>
              <ListPager page={ownPage} total={ownTotal} perPage={OWN_PER} onPage={(p) => void loadOwned(filter, p, true)} />
            </section>
          )}
        </div>
      )}
      {/* the creators this player follows: their new games show up under the bell (web/src/follow.tsx) */}
      <section id="following" className="lib-following">
        <SectionHead title={t('Creators you follow', '你关注的创作者')} note={t('When one of them publishes a new game, it shows up under the bell.', '他们发布新游戏时，会出现在通知中。')} />
        <FollowingList />
      </section>
    </div>
  );
}

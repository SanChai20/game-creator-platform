// The player's library: every game they played, most recently played first (the full Continue row, paged), and the
// games they bought but have not opened yet. Only their own, from their account.
import { useState } from 'react';
import { api, Fail, GameTile, t, useData } from '../lib';
import { Button, EmptyState, PageHeader } from '../ui';
import { Skeleton, SkCard } from '../ui/skeleton';
import { ContinueCard, useHide, type ContinueGame } from '../continue';
import { SectionHead } from '../store';
import type { GameCard } from '../lib';

interface LibraryData { games: ContinueGame[]; more: boolean; unplayed: (GameCard & { bought_at: number })[] | null }

export function Library() {
  const { data, error, loading, reload } = useData<LibraryData>('/me/library');
  const [extra, setExtra] = useState<ContinueGame[]>([]), [more, setMore] = useState<boolean | null>(null), [busy, setBusy] = useState(false);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const hideOnServer = useHide(() => {}), hide = (slug: string) => { setGone((s) => new Set(s).add(slug)); hideOnServer(slug); };
  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <div className="wrap page"><Skeleton><div className="cont-grid">{[0, 1, 2, 3].map((k) => <SkCard key={k} lines={3} />)}</div></Skeleton></div>;
  const d = data!, played = [...d.games, ...extra].filter((g) => !gone.has(g.slug)), hasMore = more ?? d.more, unplayed = d.unplayed || [];
  const loadMore = async () => {
    setBusy(true);
    try { const r = await api<LibraryData>(`/me/library?offset=${d.games.length + extra.length}`); setExtra((l) => [...l, ...r.games]); setMore(r.more); } finally { setBusy(false); }
  };
  return (
    <div className="wrap page">
      <PageHeader eyebrow={t('Library', '游戏库')} title={t('Your games', '我的游戏')} sub={t('Everything you played, most recent first. Continue opens a game where you left off, on any device.', '你玩过的所有游戏，最近的在前。点“继续游戏”即可在任何设备上从上次离开的地方继续。')} />
      {!played.length && !unplayed.length ? (
        <EmptyState title={t('Nothing here yet', '这里还是空的')} action={<Button to="/" variant="primary">{t('Find a game', '去找游戏')}</Button>}>{t('Games you play show up here, with where you left off.', '你玩过的游戏会出现在这里，并记录你上次玩到哪里。')}</EmptyState>
      ) : (
        <div className="stack xl library">
          {played.length > 0 && (
            <section>
              <SectionHead title={t('Continue playing', '继续游玩')} />
              <div className="cont-grid">{played.map((g) => <ContinueCard key={g.id} g={g} onHide={hide} />)}</div>
              {hasMore && <div className="row" style={{ justifyContent: 'center', marginTop: 20 }}><Button onClick={loadMore} disabled={busy}>{busy ? t('Loading…', '加载中…') : t('Show more', '显示更多')}</Button></div>}
            </section>
          )}
          {unplayed.length > 0 && (
            <section>
              <SectionHead title={t('Bought, not played yet', '已购买，尚未游玩')} />
              <div className="grid browse-grid">{unplayed.map((g) => <GameTile key={g.id} g={g} to={`/g/${g.slug}?play=1`} />)}</div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

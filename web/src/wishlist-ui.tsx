// Coming soon pages and wishlists (src/wishlist.js): the wishlist button, the coming soon panel on a game page, the
// store's Coming soon shelf, the library's wishlist, and the console card where a creator announces a game.
import { useState } from 'react';
import { api, date, GameTile, Link, loginUrl, num, t, useAct, useApp, useData, type GameCard } from './lib';
import { Badge, Button, Card, Input } from './ui';
import { SectionHead, Shelf } from './store';

/** Add to or take off the wishlist. Signed-out visitors are sent to sign in first. */
export function WishButton({ slug, wished, onChange, block, size = 'sm' }: { slug: string; wished: boolean; onChange: (w: boolean) => void; block?: boolean; size?: 'sm' | 'lg' }) {
  const { user } = useApp(), { busy, act } = useAct();
  if (!user) return <Button size={size} block={block} to={loginUrl(`/g/${slug}`)}>♡ {t('Add to wishlist', '加入愿望单')}</Button>;
  const flip = () => act('wish', async () => {
    await api(`/games/${encodeURIComponent(slug)}/wishlist`, { method: wished ? 'DELETE' : 'POST' });
    onChange(!wished);
  }, wished ? t('Taken off your wishlist.', '已从愿望单移除。') : t('On your wishlist. You will hear when it is out or on sale.', '已加入愿望单。游戏推出或促销时会通知你。'));
  return <Button size={size} block={block} variant={wished ? 'ghost' : size === 'lg' ? 'primary' : undefined} onClick={() => void flip()} disabled={busy === 'wish'} aria-pressed={wished}>{wished ? <>♥ {t('On your wishlist', '已在愿望单中')}</> : <>♡ {t('Add to wishlist', '加入愿望单')}</>}</Button>;
}

/** The stage and the buy panel of a game that is not out yet. */
export function ComingSoonPanel({ slug, note, wished, onChange, owner }: { slug: string; note: string | null; wished: boolean; onChange: (w: boolean) => void; owner: boolean }) {
  return (
    <div className="stack" style={{ justifyItems: 'center', textAlign: 'center' }}>
      <Badge tone="accent">{t('Coming soon', '即将推出')}</Badge>
      {note && <b className="soon-note">{note}</b>}
      <p className="mute fs-sm">{owner ? t('This is your coming soon page. Players wishlist the game here; they hear when it is released.', '这是你的即将推出页面。玩家在这里把游戏加入愿望单，发布时会收到通知。') : t('Wishlist it to hear the moment it is out.', '加入愿望单，游戏推出时第一时间通知你。')}</p>
      {!owner && <WishButton slug={slug} wished={wished} onChange={onChange} size="lg" />}
    </div>
  );
}

/** The store's Coming soon shelf: the most wished for first. Hidden when there are none. */
export function ComingSoonShelf() {
  const { data } = useData<{ games: GameCard[] }>('/coming-soon?limit=12');
  if (!data?.games.length) return null;
  return <Shelf title={t('Coming soon', '即将推出')} note={t('Wishlist a game to hear the moment it is out.', '把游戏加入愿望单，推出时第一时间收到通知。')} games={data.games} />;
}

/** The library's wishlist: games coming soon, and paid games to buy later. */
export function WishlistSection() {
  const { data, reload } = useData<{ games: (GameCard & { wished_at: number })[] }>('/me/wishlist');
  const { act } = useAct();
  if (!data?.games.length) return null;
  const drop = (g: GameCard) => act('unwish:' + g.slug, async () => { await api(`/games/${encodeURIComponent(g.slug)}/wishlist`, { method: 'DELETE' }); await reload(); });
  return (
    <section id="wishlist">
      <SectionHead title={t('Wishlist', '愿望单')} note={t('You hear when one comes out or goes on sale.', '有游戏推出或促销时会通知你。')} />
      <div className="grid browse-grid">
        {data.games.map((g) => (
          <div key={g.id} className="stack s">
            <GameTile g={g} />
            <div className="row"><span className="dim fs-sm grow">{t('Added {date}', '{date} 加入', { date: date(g.wished_at) })}</span><button type="button" className="linkish fs-sm" onClick={() => void drop(g)}>{t('Remove', '移除')}</button></div>
          </div>
        ))}
      </div>
    </section>
  );
}

interface SoonState { coming_soon: boolean; release_note: string | null; coming_soon_at: number | null; released: boolean; issues: { field: string; message: string }[]; wishlists: number; recent: number; page: string }

/** The console card: put up the coming soon page before the first release, and see how many wished for the game. */
export function ComingSoonCard({ id, onChange }: { id: string; onChange?: () => void }) {
  const { data, reload } = useData<SoonState>(`/console/projects/${id}/coming-soon`);
  const { busy, act } = useAct(), [note, setNote] = useState<string | null>(null);
  if (!data) return null;
  const save = (body: Record<string, unknown>, ok: string) => act('soon', async () => {
    await api(`/console/projects/${id}/coming-soon`, { method: 'PUT', body });
    setNote(null); await reload(); onChange?.();
  }, ok);
  const wishes = <span className="dim fs-sm">{data.wishlists === 1 ? t('1 player wishlisted it', '1 位玩家加入了愿望单') : t('{n} players wishlisted it', '{n} 位玩家加入了愿望单', { n: num(data.wishlists) })}{data.recent ? ` · ${t('{n} this week', '本周 {n} 位', { n: num(data.recent) })}` : ''}</span>;
  if (data.released) return data.wishlists ? <Card title={t('Wishlists', '愿望单')} pad><div className="stack s">{wishes}<p className="mute fs-sm">{t('Players who wishlisted the game hear when it goes on sale.', '把游戏加入愿望单的玩家会在促销时收到通知。')}</p></div></Card> : null;
  const value = note ?? data.release_note ?? '';
  return (
    <Card title={t('Coming soon page', '即将推出页面')} aside={data.coming_soon ? <Badge tone="good">{t('Up', '已上线')}</Badge> : undefined} pad>
      <div className="stack s">
        <p className="mute fs-sm">{t('Announce the game before it is out. Its page goes public with no Play button, players wishlist it and read your devlogs, and everyone who wishlisted it is told when you publish.', '在游戏推出前先公布。游戏页面会公开但没有开始按钮，玩家可以加入愿望单、阅读你的开发日志；发布时会通知所有加入愿望单的玩家。')}</p>
        <div className="row">
          <Input value={value} maxLength={40} onChange={(e) => setNote(e.target.value)} placeholder={t('When, in your words: Spring 2027, Soon…', '何时推出，用你自己的话：2027 年春、即将……')} aria-label={t('Release note', '推出时间说明')} />
          {note !== null && note !== (data.release_note ?? '') && <Button size="sm" onClick={() => void save({ release_note: note }, t('Saved.', '已保存。'))} disabled={busy === 'soon'}>{t('Save', '保存')}</Button>}
        </div>
        {data.coming_soon ? (
          <div className="row wrap-row">{wishes}<span className="grow" /><Link className="sig fs-sm" to={new URL(data.page).pathname}>{t('View page', '查看页面')}</Link><Button size="sm" variant="ghost" onClick={() => void save({ on: false }, t('The coming soon page is down.', '即将推出页面已下线。'))} disabled={busy === 'soon'}>{t('Take down', '下线')}</Button></div>
        ) : (
          <>
            {data.issues.length > 0 && <ul className="mute fs-sm">{data.issues.map((i) => <li key={i.field}>{i.message}</li>)}</ul>}
            <div><Button size="sm" variant="primary" onClick={() => void save({ on: true, ...(note !== null ? { release_note: note } : {}) }, t('Your coming soon page is up.', '即将推出页面已上线。'))} disabled={busy === 'soon' || data.issues.length > 0}>{t('Put up the coming soon page', '上线即将推出页面')}</Button></div>
          </>
        )}
      </div>
    </Card>
  );
}
